// Tests for the build-time transforms (comptime, drop-calls) and module
// resolution. Run with `node test/run.js` from the filter directory.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");

const { comptimePlugin } = require("../comptime.js");
const { createCallDropper, dropCallsPlugin } = require("../dropcalls.js");
const { json5Plugin } = require("../json5-plugin.js");
const { resolveModules, manifestVersionFromNpm } = require("../modules.js");

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error("  " + String(err.stack || err).split("\n").join("\n  "));
  }
}

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gametests-test-"));
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return dir;
}

// Builds an entry point the same way build.js wires the plugins.
async function build(dir, entry, { dropLabels = [], comptime = true, minify = false } = {}) {
  const plugins = [json5Plugin()];
  const dropper = dropLabels.length ? createCallDropper(dropLabels) : null;
  if (dropper) plugins.unshift(dropCallsPlugin(dropper));
  if (comptime) plugins.unshift(comptimePlugin({ dropper }));
  const result = await esbuild.build({
    entryPoints: [path.join(dir, entry)],
    bundle: true,
    format: "esm",
    write: false,
    minify,
    dropLabels,
    logLevel: "silent",
    plugins,
  });
  return result.outputFiles[0].text;
}

const LOG_TS = `
export function debug(...args: unknown[]) {
  LOGGING: {
    console.warn("[debug]", ...args);
  }
}
export const trace = (...args: unknown[]) => {
  LOGGING: {
    console.warn("[trace]", ...args);
  }
};
export function info(...args: unknown[]) {
  console.warn("[info]", ...args);
}
export default function defaultDebug(...args: unknown[]) {
  LOGGING: {
    console.warn("[default]", ...args);
  }
}
`;

(async () => {
  await test("comptime: inlines results and removes helpers", async () => {
    const dir = makeFixture({
      "main.ts": `
        import { comptime } from "comptime";
        const dead = 40;
        export const VALUE = comptime(async () => dead + 2);
        console.log(VALUE);
      `,
    });
    const out = await build(dir, "main.ts");
    assert.match(out, /VALUE = 42/);
    assert.doesNotMatch(out, /dead/);
  });

  await test("dropcalls: drops calls to imported marked functions", async () => {
    const dir = makeFixture({
      "log.ts": LOG_TS,
      "main.ts": `
        import { debug, trace as t, info } from "./log";
        function expensive() { return "EXPENSIVE_MARKER"; }
        debug("a", expensive());
        t("b");
        info("KEEP_MARKER");
        export const result = debug("as expression") ?? "fallback";
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /EXPENSIVE_MARKER/); // call argument dropped, helper tree-shaken
    assert.doesNotMatch(out, /\[debug\]/); // marked function body dropped and unreferenced
    assert.match(out, /KEEP_MARKER/); // unmarked function untouched
    assert.match(out, /\[info\]/);
    // esbuild folds the inert `(void 0) ?? "fallback"` away even without minify
    assert.match(out, /result = "fallback"/);
  });

  await test("dropcalls: namespace and default imports", async () => {
    const dir = makeFixture({
      "log.ts": LOG_TS,
      "main.ts": `
        import defaultDebug from "./log";
        import * as log from "./log";
        defaultDebug("DROP_DEFAULT");
        log.debug("DROP_NS");
        log.info("KEEP_NS");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_DEFAULT/);
    assert.doesNotMatch(out, /DROP_NS/);
    assert.match(out, /KEEP_NS/);
  });

  await test("dropcalls: anonymous default imports", async () => {
    const dir = makeFixture({
      "log.ts": `
        export default function(...args: unknown[]) {
          LOGGING: {
            console.warn("[default]", ...args);
          }
        }
      `,
      "main.ts": `
        import debug from "./log";
        debug("DROP_ANON_DEFAULT");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_ANON_DEFAULT/);
  });

  await test("dropcalls: local marked functions and nested calls", async () => {
    const dir = makeFixture({
      "main.ts": `
        function debug(msg: string) {
          LOGGING: {
            console.warn(msg);
          }
        }
        debug("outer " + debug("inner"));
        if (Math.random() > 2) debug("no braces");
        console.log("KEEP");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /outer|inner|no braces/);
    assert.match(out, /KEEP/);
  });

  await test("dropcalls: calls survive when the label is not dropped", async () => {
    const dir = makeFixture({
      "log.ts": LOG_TS,
      "main.ts": `
        import { debug } from "./log";
        debug("KEEP_CALL");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["OTHER_LABEL"] });
    assert.match(out, /KEEP_CALL/);
  });

  await test("dropcalls: functions with unlabeled statements are not marked", async () => {
    const dir = makeFixture({
      "main.ts": `
        function partial(msg: string) {
          LOGGING: {
            console.warn(msg);
          }
          return msg.length;
        }
        console.log(partial("KEEP_PARTIAL"));
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.match(out, /KEEP_PARTIAL/);
  });

  await test("dropcalls: works in files that also use comptime", async () => {
    const dir = makeFixture({
      "log.ts": LOG_TS,
      "main.ts": `
        import { comptime } from "comptime";
        import { debug } from "./log";
        export const VALUE = comptime(() => 7);
        debug("DROP_ME", VALUE);
        console.log("KEEP", VALUE);
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.match(out, /VALUE = 7/);
    assert.doesNotMatch(out, /DROP_ME/);
    assert.match(out, /KEEP/);
  });

  await test("dropcalls: marked function passed as a value is kept", async () => {
    const dir = makeFixture({
      "log.ts": LOG_TS,
      "main.ts": `
        import { debug } from "./log";
        debug("dropped");
        export const handler = debug;
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.match(out, /handler = debug/);
  });

  // Modeled on @bedrock-oss/bedrock-boost's Logger: a class with label-marked
  // methods and a static factory whose body is only partially labeled.
  const LOGGER_TS = `
export class Logger {
  private name: string;
  private constructor(name: string) {
    this.name = name;
  }
  static getLogger(name: string): Logger {
    LOGGING: {
      console.warn("init logging");
    }
    return new Logger(name);
  }
  static staticDebug(...args: unknown[]) {
    LOGGING: {
      console.warn("[static]", ...args);
    }
  }
  log(level: number, ...args: unknown[]) {
    LOGGING: {
      console.warn(this.name, level, ...args);
    }
  }
  info(...args: unknown[]) {
    LOGGING:
      this.log(2, ...args);
  }
  keep(...args: unknown[]) {
    console.warn("kept", ...args);
  }
}
`;

  await test("dropcalls: marked class methods via instance variables", async () => {
    const dir = makeFixture({
      "logger.ts": LOGGER_TS,
      "main.ts": `
        import { Logger } from "./logger";
        const log = Logger.getLogger("main");
        log.info("DROP_INSTANCE", JSON.stringify({ payload: "EXPENSIVE_MARKER" }));
        Logger.staticDebug("DROP_STATIC");
        Logger.getLogger("chained").info("DROP_CHAINED");
        log.keep("KEEP_UNMARKED");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_INSTANCE|EXPENSIVE_MARKER|DROP_STATIC|DROP_CHAINED/);
    assert.match(out, /KEEP_UNMARKED/);
    assert.match(out, /getLogger\("main"\)/); // factory itself is not marked and survives
  });

  await test("dropcalls: marked class methods via properties and this", async () => {
    const dir = makeFixture({
      "logger.ts": LOGGER_TS,
      "main.ts": `
        import { Logger } from "./logger";
        class Renderer {
          private log = Logger.getLogger("renderer");
          render() {
            this.log.info("DROP_PROP");
            console.log("KEEP_RENDER");
          }
        }
        new Renderer().render();
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_PROP/);
    assert.match(out, /KEEP_RENDER/);
  });

  await test("dropcalls: shared logger instance exported from another module", async () => {
    const dir = makeFixture({
      "logger.ts": LOGGER_TS,
      "shared.ts": `
        import { Logger } from "./logger";
        export const log = Logger.getLogger("shared");
      `,
      "main.ts": `
        import { log } from "./shared";
        log.info("DROP_SHARED");
        log.keep("KEEP_SHARED");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_SHARED/);
    assert.match(out, /KEEP_SHARED/);
  });

  await test("dropcalls: marked class in a node_modules package (esbuild dist shape)", async () => {
    const dir = makeFixture({
      "node_modules/@test/boost/package.json": JSON.stringify({
        name: "@test/boost",
        main: "./dist/index.js",
      }),
      // Mimics an esbuild-bundled dist: class expression in a var + export list.
      "node_modules/@test/boost/dist/index.js": `
        var Logger = class _Logger {
          constructor(name) { this.name = name; }
          static getLogger(name) {
            LOGGING: {
              console.warn("init");
            }
            return new _Logger(name);
          }
          info(...args) {
            LOGGING:
              console.warn("[info]", this.name, ...args);
          }
        };
        export { Logger };
      `,
      "main.ts": `
        import { Logger } from "@test/boost";
        const log = Logger.getLogger("main");
        log.info("DROP_PKG");
        console.log("KEEP_PKG");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_PKG/);
    assert.match(out, /KEEP_PKG/);
  });

  await test("dropcalls: same method name on an unrelated object is kept", async () => {
    const dir = makeFixture({
      "logger.ts": LOGGER_TS,
      "main.ts": `
        import { Logger } from "./logger";
        const log = Logger.getLogger("main");
        log.info("DROP_THIS");
        const reporter = { info: (msg: string) => console.log(msg) };
        reporter.info("KEEP_REPORTER");
      `,
    });
    const out = await build(dir, "main.ts", { dropLabels: ["LOGGING"] });
    assert.doesNotMatch(out, /DROP_THIS/);
    assert.match(out, /KEEP_REPORTER/);
  });

  await test("modules: manifest version mapping", () => {
    assert.strictEqual(manifestVersionFromNpm("1.10.0"), "1.10.0");
    assert.strictEqual(manifestVersionFromNpm("^1.10.0"), "1.10.0");
    assert.strictEqual(manifestVersionFromNpm("2.0.0-beta.1.21.90-stable"), "2.0.0-beta");
    assert.strictEqual(manifestVersionFromNpm("~1.0.0-beta.1.20.80-stable"), "1.0.0-beta");
    assert.strictEqual(manifestVersionFromNpm("latest"), null);
    assert.strictEqual(manifestVersionFromNpm("*"), null);
  });

  await test("modules: explicit list keeps existing behavior", () => {
    const resolved = resolveModules(["@minecraft/server@1.16.0", "@minecraft/server-ui@1.3.0"], ".");
    assert.deepStrictEqual(resolved.modules, [
      { name: "@minecraft/server", version: "1.16.0" },
      { name: "@minecraft/server-ui", version: "1.3.0" },
    ]);
    assert.deepStrictEqual(resolved.externals, ["@minecraft/server", "@minecraft/server-ui"]);
    assert.deepStrictEqual(resolved.devOnly, []);
    assert.throws(() => resolveModules(["mojang-gametest"], "."));
    assert.throws(() => resolveModules("nonsense", "."), TypeError);
  });

  await test("modules: auto and auto-dev derive from package.json", () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({
        dependencies: {
          "@minecraft/server": "^1.16.0",
          "@minecraft/math": "^1.3.0",
          "@minecraft/common": "^1.2.0",
          "some-bundled-lib": "^2.0.0",
        },
        devDependencies: {
          "@minecraft/server-gametest": "1.0.0-beta.1.21.90-stable",
        },
      }),
      // Engine module package: typings only, no runtime entry.
      "node_modules/@minecraft/server/package.json": JSON.stringify({ name: "@minecraft/server" }),
      "node_modules/@minecraft/server/index.d.ts": "",
      // Library package: ships runtime JS, must be bundled.
      "node_modules/@minecraft/math/package.json": JSON.stringify({
        name: "@minecraft/math",
        main: "dist/minecraft-math.js",
      }),
      "node_modules/@minecraft/math/dist/minecraft-math.js": "module.exports = {};",
    });

    const auto = resolveModules("auto", dir);
    assert.deepStrictEqual(auto.modules, [{ name: "@minecraft/server", version: "1.16.0" }]);
    assert.deepStrictEqual(auto.externals, ["@minecraft/server", "@minecraft/server-gametest"]);
    assert.deepStrictEqual(auto.devOnly, ["@minecraft/server-gametest"]);

    const autoDev = resolveModules("auto-dev", dir);
    assert.deepStrictEqual(autoDev.modules, [
      { name: "@minecraft/server", version: "1.16.0" },
      { name: "@minecraft/server-gametest", version: "1.0.0-beta" },
    ]);
    assert.deepStrictEqual(autoDev.devOnly, []);
  });

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
})();
