// Call-site elimination linked to esbuild's `dropLabels` option.
//
// esbuild's `dropLabels` removes labeled statements, so a logging function
// written as
//
//   export function debug(...args: unknown[]) {
//     LOGGING: {
//       console.warn("[debug]", ...args);
//     }
//   }
//
// becomes an empty function when "LOGGING" is dropped — but every call site,
// including the (possibly expensive) evaluation of its arguments, survives.
//
// This transform treats a function (or class method) whose body consists
// entirely of dropped labels as a marker: calls to it are replaced with
// `(void 0)` (which matches what the emptied function would have returned),
// and imports or declarations that only existed for those calls are removed.
// Argument expressions are dropped with the call, which is the point — but it
// also means release builds must not rely on their side effects.
//
// Recognized call shapes (Logger being a class with marked methods):
//   debug(...)                            marked function, local or imported
//   ns.debug(...)                         namespace import of a marked function
//   Logger.staticDebug(...)               marked static method
//   const log = Logger.getLogger(...);    instance in a variable
//   log.info(...)                         — local, imported or exported
//   class A { log = Logger.getLogger() }  instance in a property
//   this.log.info(...)
//   Logger.getLogger("x").info(...)       chained factory call
const path = require("path");
const fs = require("fs");
const {
  LOADERS,
  parse,
  spliceLinePreserving,
  forEachChild,
  removeDeadCode,
} = require("./ast-utils.js");

const EMPTY_ANALYSIS = { fns: new Set(), classes: new Map(), instances: new Map() };

/**
 * Creates a call dropper for the given dropLabels. The instance caches the
 * per-file analysis of marked exports, so it must be shared between the
 * standalone plugin and the comptime plugin of one build.
 */
function createCallDropper(dropLabels) {
  const labels = new Set(dropLabels);
  const exportCache = new Map();

  // A function is "marked" when its body consists solely of statements
  // labeled with dropped labels — i.e. it provably compiles to a no-op.
  function isMarkedFunction(node) {
    if (!node) return false;
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    ) {
      return false;
    }
    if (node.generator) return false; // callers may rely on the returned iterator
    const body = node.body;
    if (!body || body.type !== "BlockStatement" || body.body.length === 0) return false;
    return body.body.every((stmt) => stmt.type === "LabeledStatement" && labels.has(stmt.label.name));
  }

  // Marked methods of a class node, or null when it has none.
  function markedMethodsOfClass(node) {
    if (!node || (node.type !== "ClassDeclaration" && node.type !== "ClassExpression")) return null;
    const methods = { instance: new Set(), static: new Set() };
    for (const member of node.body.body) {
      if (member.type !== "MethodDefinition" || member.kind !== "method") continue;
      if (member.computed || member.key.type !== "Identifier") continue;
      if (!isMarkedFunction(member.value)) continue;
      (member.static ? methods.static : methods.instance).add(member.key.name);
    }
    return methods.instance.size || methods.static.size ? methods : null;
  }

  // Root identifier of a call/new target, e.g. `a` for `a.b.c(...)`. Used to
  // skip resolving imports whose bindings are never part of a call.
  function callRootsOf(ast) {
    const roots = new Set();
    (function scan(node) {
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        let target = node.callee;
        while (target.type === "MemberExpression") target = target.object;
        if (target.type === "Identifier") roots.add(target.name);
      }
      forEachChild(node, scan);
    })(ast);
    return roots;
  }

  /**
   * Computes the marked bindings of a module.
   * @param ast The parsed (type-stripped) module.
   * @param getImportAnalysis async (source) => exports analysis of the
   *   imported module, or null when it cannot be analyzed.
   * @returns locals usable for call matching and the analysis of what the
   *   module exports.
   */
  async function analyzeModule(ast, getImportAnalysis) {
    const fns = new Set(); // binding names of marked functions
    const classBindings = new Map(); // binding name -> { instance, static }
    const nsMarked = new Map(); // namespace import name -> exports analysis
    const instanceVars = new Map(); // binding name -> Set of marked instance methods
    const instanceProps = new Map(); // property name -> Set of marked instance methods
    const exportedFns = new Set();
    const exportedClasses = new Map();
    const exportedInstances = new Map();

    // Local marked functions and classes.
    const exportedDecls = []; // [node, exportName]
    for (const stmt of ast.body) {
      let node = stmt;
      let exportName = null;
      if (stmt.type === "ExportDefaultDeclaration") {
        node = stmt.declaration;
        exportName = "default";
      } else if (stmt.type === "ExportNamedDeclaration") {
        if (!stmt.declaration) continue; // export lists are handled at the end
        node = stmt.declaration;
      }
      const isExportedDecl = stmt !== node;
      // Also matches `export default function (...) {}` / `export default (...) => {}`,
      // which have no id (arrows can only appear here through export default).
      if (isMarkedFunction(node)) {
        if (node.id) fns.add(node.id.name);
        if (isExportedDecl && (exportName || node.id)) exportedFns.add(exportName ?? node.id.name);
      } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        const methods = markedMethodsOfClass(node);
        if (!methods) continue;
        if (node.id) classBindings.set(node.id.name, methods);
        if (isExportedDecl) exportedClasses.set(exportName ?? (node.id && node.id.name), methods);
      } else if (node.type === "VariableDeclaration") {
        for (const declarator of node.declarations) {
          if (declarator.id.type !== "Identifier" || !declarator.init) continue;
          if (node.kind === "const" && isMarkedFunction(declarator.init)) {
            fns.add(declarator.id.name);
            if (isExportedDecl) exportedFns.add(declarator.id.name);
          } else {
            const methods = markedMethodsOfClass(declarator.init);
            if (methods) {
              classBindings.set(declarator.id.name, methods);
              if (isExportedDecl) exportedClasses.set(declarator.id.name, methods);
            }
          }
        }
      }
    }

    // Marked bindings coming in through imports.
    const callRoots = callRootsOf(ast);
    for (const stmt of ast.body) {
      if (stmt.type !== "ImportDeclaration") continue;
      const wanted = stmt.specifiers.filter((spec) => callRoots.has(spec.local.name));
      if (wanted.length === 0) continue;
      const imported = await getImportAnalysis(stmt.source.value);
      if (!imported || (imported.fns.size === 0 && imported.classes.size === 0 && imported.instances.size === 0)) {
        continue;
      }
      for (const spec of wanted) {
        if (spec.type === "ImportNamespaceSpecifier") {
          nsMarked.set(spec.local.name, imported);
          continue;
        }
        const name =
          spec.type === "ImportDefaultSpecifier"
            ? "default"
            : spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
        if (imported.fns.has(name)) fns.add(spec.local.name);
        if (imported.classes.has(name)) classBindings.set(spec.local.name, imported.classes.get(name));
        if (imported.instances.has(name)) instanceVars.set(spec.local.name, imported.instances.get(name));
      }
    }

    // Marked methods of the class an expression refers to, or null.
    function classRefOf(node) {
      if (node.type === "Identifier") return classBindings.get(node.name) ?? null;
      if (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.object.type === "Identifier" &&
        node.property.type === "Identifier"
      ) {
        const ns = nsMarked.get(node.object.name);
        return (ns && ns.classes.get(node.property.name)) ?? null;
      }
      return null;
    }

    // Marked instance methods of the value an expression evaluates to, when it
    // creates an instance of a marked class (`new Logger(...)` or a static
    // factory like `Logger.getLogger(...)`); null otherwise.
    function instanceFactoryOf(node) {
      if (!node) return null;
      if (node.type === "NewExpression") {
        const methods = classRefOf(node.callee);
        return methods ? methods.instance : null;
      }
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed) {
        const methods = classRefOf(node.callee.object);
        return methods ? methods.instance : null;
      }
      return null;
    }

    const addMethods = (map, key, methods) => {
      if (methods.size === 0) return;
      const existing = map.get(key);
      if (existing) for (const m of methods) existing.add(m);
      else map.set(key, new Set(methods));
    };

    // Instances of marked classes stored in variables and properties.
    (function scanInstances(node) {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        const methods = instanceFactoryOf(node.init);
        if (methods) addMethods(instanceVars, node.id.name, methods);
      } else if (node.type === "PropertyDefinition" && !node.computed && node.key.type === "Identifier") {
        const methods = instanceFactoryOf(node.value);
        if (methods) addMethods(instanceProps, node.key.name, methods);
      } else if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left.type === "MemberExpression" &&
        !node.left.computed &&
        node.left.property.type === "Identifier"
      ) {
        const methods = instanceFactoryOf(node.right);
        if (methods) addMethods(instanceProps, node.left.property.name, methods);
      }
      forEachChild(node, scanInstances);
    })(ast);

    // Exported top-level instances (`export const log = Logger.getLogger()`).
    for (const stmt of ast.body) {
      if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
      if (stmt.declaration.type !== "VariableDeclaration") continue;
      for (const declarator of stmt.declaration.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const methods = instanceVars.get(declarator.id.name);
        if (methods) exportedInstances.set(declarator.id.name, methods);
      }
    }

    // Export lists: `export { debug, Logger, log as logger }`.
    for (const stmt of ast.body) {
      if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration || stmt.source) continue;
      for (const spec of stmt.specifiers) {
        if (spec.local.type !== "Identifier") continue;
        const local = spec.local.name;
        const exported = spec.exported.type === "Identifier" ? spec.exported.name : spec.exported.value;
        if (fns.has(local)) exportedFns.add(exported);
        if (classBindings.has(local)) exportedClasses.set(exported, classBindings.get(local));
        if (instanceVars.has(local)) exportedInstances.set(exported, instanceVars.get(local));
      }
    }
    // `export default log;`
    for (const stmt of ast.body) {
      if (stmt.type !== "ExportDefaultDeclaration" || stmt.declaration.type !== "Identifier") continue;
      const local = stmt.declaration.name;
      if (fns.has(local)) exportedFns.add("default");
      if (classBindings.has(local)) exportedClasses.set("default", classBindings.get(local));
      if (instanceVars.has(local)) exportedInstances.set("default", instanceVars.get(local));
    }

    return {
      fns,
      classBindings,
      nsMarked,
      instanceVars,
      instanceProps,
      classRefOf,
      instanceFactoryOf,
      exports: { fns: exportedFns, classes: exportedClasses, instances: exportedInstances },
    };
  }

  async function resolveImport(build, importer, source) {
    try {
      const resolved = await build.resolve(source, {
        kind: "import-statement",
        importer,
        resolveDir: path.dirname(importer),
      });
      if (resolved.errors.length || resolved.external || !resolved.path) return null;
      if (resolved.namespace && resolved.namespace !== "file") return null;
      return resolved.path;
    } catch {
      return null;
    }
  }

  // Exports analysis of the module at filePath. Cached; failures (binary
  // files, CJS with top-level return, ...) are treated as "nothing marked".
  async function analyzeExports(filePath, build) {
    if (exportCache.has(filePath)) return exportCache.get(filePath);
    exportCache.set(filePath, EMPTY_ANALYSIS); // breaks import cycles
    let result = EMPTY_ANALYSIS;
    try {
      const source = await fs.promises.readFile(filePath, "utf8");
      const esbuild = require("esbuild");
      const transformed = await esbuild.transform(source, {
        loader: LOADERS[path.extname(filePath).toLowerCase()] || "ts",
      });
      const analysis = await analyzeModule(parse(transformed.code), (importSource) =>
        resolveImport(build, filePath, importSource).then((resolved) =>
          resolved ? analyzeExports(resolved, build) : null
        )
      );
      result = analysis.exports;
    } catch {
      // Not analyzable — assume nothing is marked.
    }
    exportCache.set(filePath, result);
    return result;
  }

  /**
   * Replaces calls to marked functions in `code` (a type-stripped module) and
   * removes bindings that only existed for them. Returns { code, changed }.
   */
  async function transform(code, filePath, build) {
    const ast = parse(code);
    const analysis = await analyzeModule(ast, (importSource) =>
      resolveImport(build, filePath, importSource).then((resolved) =>
        resolved ? analyzeExports(resolved, build) : null
      )
    );
    const { fns, classBindings, nsMarked, instanceVars, instanceProps, classRefOf, instanceFactoryOf } = analysis;
    if (
      fns.size === 0 &&
      classBindings.size === 0 &&
      nsMarked.size === 0 &&
      instanceVars.size === 0 &&
      instanceProps.size === 0
    ) {
      return { code, changed: false };
    }

    function isDroppedCall(node) {
      if (node.type !== "CallExpression") return false;
      const callee = node.callee;
      if (callee.type === "Identifier") return fns.has(callee.name);
      if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") {
        return false;
      }
      const method = callee.property.name;
      const object = callee.object;
      if (object.type === "Identifier") {
        const ns = nsMarked.get(object.name);
        if (ns && ns.fns.has(method)) return true;
        const instance = instanceVars.get(object.name);
        if (instance && instance.has(method)) return true;
        const cls = classBindings.get(object.name);
        if (cls && cls.static.has(method)) return true;
      } else if (object.type === "MemberExpression") {
        const cls = classRefOf(object);
        if (cls && cls.static.has(method)) return true;
        if (!object.computed && object.property.type === "Identifier") {
          const instance = instanceProps.get(object.property.name);
          if (instance && instance.has(method)) return true;
        }
      }
      const chained = instanceFactoryOf(object);
      return !!(chained && chained.has(method));
    }

    // Calls inside a dropped call are removed with it, so don't descend.
    const edits = [];
    (function visit(node) {
      if (isDroppedCall(node)) {
        edits.push({ start: node.start, end: node.end });
        return;
      }
      forEachChild(node, visit);
    })(ast);
    if (edits.length === 0) return { code, changed: false };

    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      // `(void 0)` is valid in any expression position and equals what the
      // emptied function would return; minification removes the leftovers.
      code = spliceLinePreserving(code, edit.start, edit.end, "(void 0)");
    }
    code = removeDeadCode(code, new Set([...fns, ...nsMarked.keys()]));
    return { code, changed: true };
  }

  return { transform };
}

/**
 * The standalone esbuild plugin. It must be registered after the comptime
 * plugin: files containing comptime() never reach this onLoad (esbuild stops
 * at the first plugin that returns contents), so the comptime plugin applies
 * the dropper to its own output instead.
 */
function dropCallsPlugin(dropper) {
  return {
    name: "drop-labeled-calls",
    setup(build) {
      const esbuild = require("esbuild");
      const wantSourcemap = !!build.initialOptions.sourcemap;
      build.onLoad({ filter: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/ }, async (args) => {
        if (args.namespace && args.namespace !== "file") return undefined;
        try {
          const source = await fs.promises.readFile(args.path, "utf8");
          const transformed = await esbuild.transform(source, {
            loader: LOADERS[path.extname(args.path).toLowerCase()] || "ts",
            // The inline map is resolved relative to the file's own directory, so
            // the basename makes sources named the same way as untransformed files.
            sourcefile: path.basename(args.path),
            sourcemap: wantSourcemap ? "inline" : false,
          });
          const result = await dropper.transform(transformed.code, args.path, build);
          if (!result.changed) return undefined;
          return { contents: result.code, loader: "js" };
        } catch (err) {
          // Files acorn cannot parse (e.g. CJS with top-level return) are left
          // to esbuild's regular loader; their calls are simply not dropped.
          if (!args.path.split(/[\\/]/).includes("node_modules")) {
            console.warn(`drop-labeled-calls: skipping ${args.path}: ${err && err.message ? err.message : err}`);
          }
          return undefined;
        }
      });
    },
  };
}

module.exports = { createCallDropper, dropCallsPlugin };
