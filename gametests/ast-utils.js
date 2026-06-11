// Shared AST helpers used by the comptime and drop-calls transforms.
const acorn = require("acorn");

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

// Iteratively removes top-level declarations and imports that are no longer
// referenced, limited to bindings listed in candidateNames.
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

module.exports = {
  LOADERS,
  parse,
  countLines,
  spliceLinePreserving,
  forEachChild,
  visitRefs,
  collectPatternNames,
  analyzeTopLevel,
  isPureExpr,
  isPureDecl,
  hasRefs,
  removeDeadCode,
};
