# qjs_opt

Static optimizer for QuickJS-bridged expensive API calls using TS type info + JSON whitelist.

## Getting the Filter

Install with: `regolith install qjs_opt`. After that, you can place the filter into one of your profiles.

```json
{
    "filter": "qjs_opt"
}
```

## Usage

```json
{
  "filter": "qjs_opt",
  "settings": {
    "target": "./BP/scripts/main.js",
    "dependencies": [
      "@minecraft/server@2.2.0"
    ]
  }
}
```
