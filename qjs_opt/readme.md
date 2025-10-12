# qjs_opt

Static optimizer for QuickJS-bridged expensive API calls using TS type info + JSON whitelist.

::: warning
This is an experimental filter. It may not work as expected and may break your scripts. Test thoroughly.
:::

## Getting the Filter

Install with: `regolith install qjs_opt`. After that, you can place the filter into one of your profiles.

This filter takes a few seconds to run, so it is recommended to only run it in production builds.

```json
{
  "settings": {
    "target": "./BP/scripts/main.js",
    "dependencies": [
      "@minecraft/server@2.2.0"
    ]
  }
}
```
