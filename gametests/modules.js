// Resolution of the `modules` filter setting into manifest dependencies and
// esbuild externals, including the "auto" / "auto-dev" modes that derive them
// from data/gametests/package.json.
import fs from "fs";
import path from "path";

// Script modules provided by the engine. Their npm packages contain only
// typings; the real implementation is loaded by the game through a manifest
// dependency.
const ENGINE_MODULES = new Set([
  "@minecraft/server",
  "@minecraft/server-ui",
  "@minecraft/server-gametest",
  "@minecraft/server-net",
  "@minecraft/server-admin",
  "@minecraft/server-editor",
  "@minecraft/debug-utilities",
  "@minecraft/diagnostics",
]);

// Typings-only helper packages that are neither engine modules nor runtime
// libraries, and must never be added to the manifest.
const TYPES_ONLY_HELPERS = new Set(["@minecraft/common"]);

// Maps an npm version (e.g. "^2.0.0-beta.1.21.90-stable") to the version used
// in manifest dependencies (e.g. "2.0.0-beta").
function manifestVersionFromNpm(npmVersion) {
  const cleaned = String(npmVersion).trim().replace(/^[~^>=<\s]+/, "");
  const match = cleaned.match(/^\d+\.\d+\.\d+(?:-beta)?/);
  return match ? match[0] : null;
}

// Whether the installed package ships runtime JavaScript (a bundleable
// library such as @minecraft/math) as opposed to typings only (an engine
// module). Used for @minecraft packages not in the known lists, so new engine
// modules keep working without a filter update.
function shipsRuntimeCode(packageDir) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return false;
  }
  if (pkg.exports) return true; // engine module typings don't use "exports"
  return fs.existsSync(path.join(packageDir, pkg.main || "index.js"));
}

function parseModuleList(modules) {
  const parsed = [];
  for (const module of modules) {
    const match = module.match(/(@[^@]+)@(.+)/);
    if (!match) {
      throw "Invalid module provided in settings, please follow the format '<module>@<version>' or '<module>'";
    }
    const name = match[1];
    const version = match[2];

    if (!version) throw `No version provided for module '${name}'`;
    const versionMatch = version.match(/\d+\.\d+\.\d+(?:-beta)?/);
    if (!versionMatch || versionMatch[0] !== version) {
      throw `Version '${version}' is not a valid module version`;
    }
    parsed.push({ name, version });
  }
  return parsed;
}

/**
 * Resolves the `modules` setting.
 * @param {string[] | "auto" | "auto-dev"} setting An explicit module list, or
 *   "auto" to derive modules from the dependencies of packageDir/package.json
 *   ("auto-dev" also includes devDependencies).
 * @param {string} packageDir The directory containing package.json and
 *   node_modules (data/gametests).
 * @returns {{
 *   modules: { name: string, version: string }[],
 *   externals: string[],
 *   devOnly: string[],
 * }} `modules` go into the manifest, `externals` are passed to esbuild, and
 *   `devOnly` are engine modules excluded from the manifest because they are
 *   devDependencies (used to warn when the compiled script still needs them).
 */
function resolveModules(setting, packageDir) {
  if (Array.isArray(setting)) {
    const modules = parseModuleList(setting);
    return { modules, externals: modules.map((m) => m.name), devOnly: [] };
  }
  if (setting !== "auto" && setting !== "auto-dev") {
    throw new TypeError(`modules: ${JSON.stringify(setting)} is not an array, "auto" or "auto-dev"`);
  }
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw `modules: "${setting}" requires ${packageJsonPath} to exist`;
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  const modules = [];
  const externals = [];
  const devOnly = [];
  const collect = (dependencies, dev) => {
    for (const [name, npmVersion] of Object.entries(dependencies || {})) {
      if (!name.startsWith("@minecraft/")) continue; // regular npm dependency, bundled
      if (TYPES_ONLY_HELPERS.has(name)) continue;
      if (!ENGINE_MODULES.has(name)) {
        const packagePath = path.join(packageDir, "node_modules", name);
        if (shipsRuntimeCode(packagePath)) continue; // library like @minecraft/math, bundled
        console.warn(
          `Unknown engine module '${name}' — adding it to the manifest. ` +
            "If this is wrong, list your modules explicitly in the 'modules' setting."
        );
      }
      if (externals.includes(name)) continue;
      externals.push(name);
      if (dev && setting !== "auto-dev") {
        devOnly.push(name);
        continue;
      }
      const version = manifestVersionFromNpm(npmVersion);
      if (!version) {
        throw (
          `modules: cannot derive a manifest version for '${name}@${npmVersion}'. ` +
          "Pin it to a version like '1.16.0' or '1.0.0-beta.1.21.90-stable'."
        );
      }
      modules.push({ name, version });
    }
  };
  collect(pkg.dependencies, false);
  collect(pkg.devDependencies, true);
  return { modules, externals, devOnly };
}

export { resolveModules, manifestVersionFromNpm, parseModuleList };
