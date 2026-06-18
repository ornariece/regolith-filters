import esbuild from "esbuild";
import { json5Plugin } from "./json5-plugin.js";
import { comptimePlugin } from "./comptime.js";
import { createCallDropper, dropCallsPlugin } from "./dropcalls.js";

export function run(settings) {
  const plugins = [json5Plugin()];
  const dropLabels = (settings.buildOptions && settings.buildOptions.dropLabels) || [];
  const dropper =
    settings.dropLabeledCalls !== false && dropLabels.length > 0 ? createCallDropper(dropLabels) : null;
  if (dropper) {
    plugins.unshift(dropCallsPlugin(dropper));
  }
  if (settings.comptime !== false) {
    // First in the list, so it sees files before the drop-calls plugin and can
    // apply the dropper itself after comptime evaluation.
    plugins.unshift(comptimePlugin({ dropper }));
  }
  // Return the promise so that callers can await the build's completion.
  return esbuild
    .build({ ...settings.buildOptions, metafile: true, plugins })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
