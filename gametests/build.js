const { json5Plugin } = require("./json5-plugin.js");
const { comptimePlugin } = require("./comptime.js");

module.exports.run = function (settings) {
  const plugins = [json5Plugin()];
  if (settings.comptime !== false) {
    plugins.unshift(comptimePlugin());
  }
  // Return the promise so that callers can await the build's completion.
  return require("esbuild")
    .build({ ...settings.buildOptions, plugins })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
};
