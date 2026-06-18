// Build-time evaluation ("comptime") esbuild plugin.
//
// Code like:
//
//   import { comptime } from "comptime";
//   export const GIT_META = comptime(() => ({ commit: runGit("rev-parse HEAD") }));
//   function runGit(args) { ... }
//
// is evaluated while the pack is being built. The `comptime(...)` call is
// replaced with the serialized result, and helpers/imports that were only
// used inside comptime callbacks are removed from the emitted module.
import path from "path";
import fs from "fs";
import { createRequire } from "module";
import esbuild from "esbuild";
import { json5Plugin } from "./json5-plugin.js";
import {
  LOADERS,
  TS_TRANSFORM_OPTIONS,
  parse,
  spliceLinePreserving,
  forEachChild,
  visitRefs,
  analyzeTopLevel,
  removeDeadCode,
} from "./ast-utils.js";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Serializes a comptime result to a JavaScript expression.
function serialize(value, seen = new Set()) {
  switch (typeof value) {
    case "undefined":
      return "void 0";
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "0 / 0";
      if (value === Infinity) return "1 / 0";
      if (value === -Infinity) return "-1 / 0";
      if (Object.is(value, -0)) return "-0";
      return String(value);
    case "bigint":
      return `${value}n`;
    case "string":
      return JSON.stringify(value);
    case "function":
      throw new Error("comptime() results may not contain functions");
    case "symbol":
      throw new Error("comptime() results may not contain symbols");
  }
  if (value === null) return "null";
  if (seen.has(value)) throw new Error("comptime() results may not contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((item) => serialize(item, seen)).join(", ") + "]";
    }
    if (value instanceof Date) return `new Date(${value.getTime()})`;
    if (value instanceof RegExp) return String(value);
    if (value instanceof Map) {
      const entries = [...value].map(([k, v]) => `[${serialize(k, seen)}, ${serialize(v, seen)}]`);
      return `new Map([${entries.join(", ")}])`;
    }
    if (value instanceof Set) {
      return `new Set([${[...value].map((item) => serialize(item, seen)).join(", ")}])`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      if (Object.getOwnPropertySymbols(value).length) {
        throw new Error("comptime() results may not contain symbol keys");
      }
      const entries = Object.entries(value).map(
        ([key, item]) => `${IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)}: ${serialize(item, seen)}`
      );
      return entries.length ? `{ ${entries.join(", ")} }` : "{}";
    }
    const name = (value.constructor && value.constructor.name) || "unknown class";
    throw new Error(`comptime() results may not contain class instances (got ${name})`);
  } finally {
    seen.delete(value);
  }
}

// Callbacks of different modules are executed one at a time so their output
// can be attributed to the right file.
let evalQueue = Promise.resolve();
function runExclusive(task) {
  const result = evalQueue.then(task);
  evalQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// Prefixes every line written to stdout/stderr until the returned function is
// called. Covers console.*, direct stream writes and stderr forwarded from
// child processes (e.g. execSync), but not file descriptors inherited with
// stdio: "inherit".
function tagOutput(prefix) {
  const restores = [process.stdout, process.stderr].map((stream) => {
    const originalWrite = stream.write;
    let atLineStart = true;
    stream.write = function (chunk, encoding, callback) {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      let tagged = "";
      for (const char of text) {
        if (atLineStart && char !== "\n") {
          tagged += prefix;
          atLineStart = false;
        }
        tagged += char;
        if (char === "\n") atLineStart = true;
      }
      return originalWrite.call(stream, tagged, callback);
    };
    return () => {
      stream.write = originalWrite;
    };
  });
  return () => restores.forEach((restore) => restore());
}

/**
 * Creates the comptime esbuild plugin.
 * @param {{ active?: Set<string>, dropper?: object }} [state] Internal state
 *   shared with nested evaluation builds, used to detect circular comptime
 *   dependencies. `dropper` is the call dropper from dropcalls.js, applied to
 *   the transformed output so that the drop-calls onLoad (which never runs for
 *   files this plugin claims) is not bypassed. Nested evaluation builds get no
 *   dropper, so logging inside comptime callbacks still works at build time.
 */
const comptimePlugin = (state) => {
  const active = (state && state.active) || new Set();
  const dropper = state && state.dropper;
  return {
    name: "comptime",
    setup(build) {
      const wantSourcemap = !!build.initialOptions.sourcemap;

      // Safety net: if an import of "comptime" survives the transform (e.g. a
      // re-export), resolve it to a stub that fails loudly at runtime.
      build.onResolve({ filter: /^comptime$/ }, () => ({
        path: "comptime",
        namespace: "comptime-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "comptime-stub" }, () => ({
        contents:
          'export function comptime(fn) {\n' +
          '  throw new Error("comptime() was not evaluated at build time. ' +
          'Call it directly as comptime(fn) in the module that imports it.");\n' +
          "}\n",
        loader: "js",
      }));

      build.onLoad({ filter: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/ }, async (args) => {
        if (args.namespace && args.namespace !== "file") return undefined;
        if (args.path.split(/[\\/]/).includes("node_modules")) return undefined;
        const source = await fs.promises.readFile(args.path, "utf8");
        if (!/\bcomptime\b/.test(source)) return undefined;

        // Strip types first so a single JS parser handles both TS and JS.
        const transformed = await esbuild.transform(source, {
          ...TS_TRANSFORM_OPTIONS,
          loader: LOADERS[path.extname(args.path).toLowerCase()] || "ts",
          // The inline map is resolved relative to the file's own directory, so
          // the basename makes sources named the same way as untransformed files.
          sourcefile: path.basename(args.path),
          sourcemap: wantSourcemap ? "inline" : false,
        });
        let code = transformed.code;
        const ast = parse(code);

        // Find the local bindings of `import ... from "comptime"`.
        const fnNames = new Set();
        const nsNames = new Set();
        const comptimeImportStmts = [];
        for (const stmt of ast.body) {
          if (stmt.type !== "ImportDeclaration" || stmt.source.value !== "comptime") continue;
          comptimeImportStmts.push(stmt);
          for (const spec of stmt.specifiers) {
            if (spec.type === "ImportNamespaceSpecifier") nsNames.add(spec.local.name);
            else fnNames.add(spec.local.name);
          }
        }
        if (fnNames.size === 0 && nsNames.size === 0) return undefined;

        if (active.has(args.path)) {
          throw new Error(`Circular comptime dependency detected in ${args.path}`);
        }
        active.add(args.path);
        try {
          // Find top-level comptime(...) calls. Calls nested inside another
          // comptime callback are executed during evaluation instead.
          const calls = [];
          (function findCalls(node) {
            if (node.type === "CallExpression") {
              const callee = node.callee;
              const isComptime =
                (callee.type === "Identifier" && fnNames.has(callee.name)) ||
                (callee.type === "MemberExpression" &&
                  !callee.computed &&
                  callee.object.type === "Identifier" &&
                  nsNames.has(callee.object.name) &&
                  callee.property.type === "Identifier" &&
                  callee.property.name === "comptime");
              if (isComptime) {
                if (node.arguments.length !== 1 || node.arguments[0].type === "SpreadElement") {
                  throw new Error("comptime() expects exactly one function argument");
                }
                calls.push(node);
                return;
              }
            }
            forEachChild(node, findCalls);
          })(ast);

          const { decls, imports } = analyzeTopLevel(ast);
          const declByName = new Map();
          for (const decl of decls) {
            for (const name of decl.names) declByName.set(name, decl);
          }
          const importByName = new Map();
          for (const imp of imports) {
            for (const name of imp.locals) importByName.set(name, imp);
          }

          // Transitive closure of top-level bindings used by the callbacks.
          const closure = new Set();
          const queue = [];
          const collect = (node) =>
            visitRefs(node, (name) => {
              if (closure.has(name)) return;
              if (!declByName.has(name) && !importByName.has(name)) return;
              closure.add(name);
              queue.push(name);
            });
          for (const call of calls) collect(call.arguments[0]);
          while (queue.length) {
            const decl = declByName.get(queue.pop());
            if (decl) collect(decl.stmt);
          }

          // Evaluate all callbacks of this module in one bundled script.
          let results = [];
          if (calls.length > 0) {
            const parts = [];
            for (const imp of imports) {
              if (imp.source === "comptime") continue;
              if (!imp.locals.some((name) => closure.has(name))) continue;
              parts.push(code.slice(imp.stmt.start, imp.stmt.end));
            }
            // Shims so nested comptime() calls inside callbacks just run inline.
            for (const name of fnNames) parts.push(`const ${name} = (fn) => fn();`);
            for (const name of nsNames) parts.push(`const ${name} = { comptime: (fn) => fn() };`);
            const emitted = new Set();
            for (const decl of decls) {
              if (emitted.has(decl.stmt)) continue;
              if (!decl.names.some((name) => closure.has(name))) continue;
              emitted.add(decl.stmt);
              parts.push(code.slice(decl.node.start, decl.node.end));
            }
            parts.push("export const __comptimeResults = Promise.all([");
            parts.push(calls.map((call) => `(${code.slice(call.arguments[0].start, call.arguments[0].end)})`).join(",\n"));
            parts.push("].map((fn) => fn()));");

            const evalBuild = await esbuild.build({
              stdin: {
                contents: parts.join("\n"),
                resolveDir: path.dirname(args.path),
                sourcefile: args.path,
                loader: "js",
              },
              bundle: true,
              platform: "node",
              format: "cjs",
              target: "node" + process.versions.node.split(".")[0],
              external: ["@minecraft/*"],
              write: false,
              logLevel: "silent",
              plugins: [comptimePlugin({ active }), json5Plugin()],
            });
            try {
              const relPath = path.relative(process.cwd(), args.path).split(path.sep).join("/");
              results = await runExclusive(async () => {
                const untag = tagOutput(`[comptime ${relPath}] `);
                try {
                  const evaluate = new Function(
                    "exports",
                    "require",
                    "module",
                    "__filename",
                    "__dirname",
                    evalBuild.outputFiles[0].text
                  );
                  const mod = { exports: {} };
                  evaluate(mod.exports, createRequire(args.path), mod, args.path, path.dirname(args.path));
                  return await mod.exports.__comptimeResults;
                } finally {
                  untag();
                }
              });
            } catch (err) {
              throw new Error(
                `comptime evaluation failed: ${err && err.message ? err.message : err}\n` +
                  "Note: comptime callbacks run in Node.js at build time and may only use " +
                  "imports and top-level declarations of their module."
              );
            }
          }

          // Replace each call with its serialized result and drop the import.
          // All edits keep the line count intact so source maps stay aligned.
          const edits = [];
          for (const stmt of comptimeImportStmts) {
            edits.push({ start: stmt.start, end: stmt.end, text: "" });
          }
          calls.forEach((call, i) => {
            edits.push({
              start: call.start,
              end: call.end,
              text: "(" + serialize(results[i]) + ")",
            });
          });
          edits.sort((a, b) => b.start - a.start);
          for (const edit of edits) {
            code = spliceLinePreserving(code, edit.start, edit.end, edit.text);
          }

          code = removeDeadCode(code, closure);
          if (dropper) {
            code = (await dropper.transform(code, args.path, build)).code;
          }
          return { contents: code, loader: "js" };
        } finally {
          active.delete(args.path);
        }
      });
    },
  };
};

export { comptimePlugin };
