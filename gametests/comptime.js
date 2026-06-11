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
const path = require("path");
const fs = require("fs");
const { createRequire } = require("module");
const acorn = require("acorn");
const { json5Plugin } = require("./json5-plugin.js");

const LOADERS = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function parse(code) {
  return acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
}

function countLines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

// Removes the [start, end) range while keeping the total line count intact,
// so that source maps produced before the edit stay (mostly) correct.
function spliceLinePreserving(code, start, end, text = "") {
  return code.slice(0, start) + text + "\n".repeat(countLines(code.slice(start, end)) - countLines(text)) + code.slice(end);
}

function forEachChild(node, callback) {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") callback(child);
      }
    } else if (value && typeof value.type === "string") {
      callback(value);
    }
  }
}

// Reports identifier names that may be references to an outer binding.
// Over-approximates (local declarations are reported too), which is safe for
// both dependency collection (extra code included) and dead code detection
// (extra declarations kept).
function visitRefs(node, onRef, skip) {
  if (!node || typeof node.type !== "string") return;
  if (skip && skip(node)) return;
  switch (node.type) {
    case "Identifier":
      onRef(node.name);
      return;
    case "PrivateIdentifier":
    case "MetaProperty":
    case "BreakStatement":
    case "ContinueStatement":
    case "ImportDeclaration":
    case "ExportAllDeclaration":
      return;
    case "LabeledStatement":
      visitRefs(node.body, onRef, skip);
      return;
    case "MemberExpression":
      visitRefs(node.object, onRef, skip);
      if (node.computed) visitRefs(node.property, onRef, skip);
      return;
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      if (node.computed) visitRefs(node.key, onRef, skip);
      if (node.value) visitRefs(node.value, onRef, skip);
      return;
    default:
      forEachChild(node, (child) => visitRefs(child, onRef, skip));
  }
}

function collectPatternNames(pattern, out) {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        collectPatternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) collectPatternNames(element, out);
      }
      break;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, out);
      break;
    case "RestElement":
      collectPatternNames(pattern.argument, out);
      break;
  }
}

// Collects top-level declarations and imports of a module.
function analyzeTopLevel(ast) {
  const decls = [];
  const imports = [];
  for (const stmt of ast.body) {
    let node = stmt;
    let exported = false;
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
      node = stmt.declaration;
      exported = true;
    }
    if (node.type === "ImportDeclaration") {
      imports.push({
        stmt,
        source: node.source.value,
        locals: node.specifiers.map((spec) => spec.local.name),
      });
    } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      if (node.id) decls.push({ stmt, node, names: [node.id.name], exported });
    } else if (node.type === "VariableDeclaration") {
      const names = [];
      for (const declarator of node.declarations) {
        collectPatternNames(declarator.id, names);
      }
      if (names.length) decls.push({ stmt, node, names, exported });
    }
  }
  return { decls, imports };
}

// Whether evaluating the expression cannot have observable side effects.
function isPureExpr(node) {
  switch (node.type) {
    case "Literal":
    case "Identifier":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return true;
    case "TemplateLiteral":
      return node.expressions.every(isPureExpr);
    case "UnaryExpression":
      return node.operator !== "delete" && isPureExpr(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isPureExpr(node.left) && isPureExpr(node.right);
    case "ArrayExpression":
      return node.elements.every((el) => el === null || (el.type !== "SpreadElement" && isPureExpr(el)));
    case "ObjectExpression":
      return node.properties.every(
        (prop) => prop.type === "Property" && !prop.computed && isPureExpr(prop.value)
      );
    default:
      return false;
  }
}

// Whether removing the declaration cannot change runtime behavior
// (other than making its bindings unavailable).
function isPureDecl(node) {
  if (node.type === "FunctionDeclaration") return true;
  if (node.type === "ClassDeclaration") {
    return (
      (!node.superClass || node.superClass.type === "Identifier") &&
      node.body.body.every(
        (member) =>
          member.type !== "StaticBlock" &&
          !member.computed &&
          !(member.type === "PropertyDefinition" && member.static && member.value && !isPureExpr(member.value))
      )
    );
  }
  if (node.type === "VariableDeclaration") {
    return node.declarations.every((declarator) => !declarator.init || isPureExpr(declarator.init));
  }
  return false;
}

function hasRefs(ast, names, excludedStmt) {
  let found = false;
  visitRefs(
    ast,
    (name) => {
      if (names.includes(name)) found = true;
    },
    (node) => found || node === excludedStmt
  );
  return found;
}

// Iteratively removes top-level declarations and imports that were only used
// by comptime callbacks and are no longer referenced after inlining.
function removeDeadCode(code, candidateNames) {
  if (candidateNames.size === 0) return code;
  for (let guard = 0; guard < 10000; guard++) {
    const ast = parse(code);
    const { decls, imports } = analyzeTopLevel(ast);
    let removed = null;
    for (const decl of decls) {
      if (decl.exported) continue;
      if (!decl.names.every((name) => candidateNames.has(name))) continue;
      if (!isPureDecl(decl.node)) continue;
      if (hasRefs(ast, decl.names, decl.stmt)) continue;
      removed = decl.stmt;
      break;
    }
    if (!removed) {
      for (const imp of imports) {
        if (imp.locals.length === 0) continue; // `import "module"` is kept for its side effects
        if (!imp.locals.every((name) => candidateNames.has(name))) continue;
        if (hasRefs(ast, imp.locals, imp.stmt)) continue;
        removed = imp.stmt;
        break;
      }
    }
    if (!removed) return code;
    code = spliceLinePreserving(code, removed.start, removed.end);
  }
  return code;
}

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
 * @param {{ active?: Set<string> }} [state] Internal state shared with nested
 *   evaluation builds, used to detect circular comptime dependencies.
 */
const comptimePlugin = (state) => {
  const active = (state && state.active) || new Set();
  return {
    name: "comptime",
    setup(build) {
      const esbuild = require("esbuild");
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
          return { contents: code, loader: "js" };
        } finally {
          active.delete(args.path);
        }
      });
    },
  };
};

module.exports.comptimePlugin = comptimePlugin;
