const { optimize } = require("@bedrock-oss/qjs-opt");

const settings = {
};

function applyRegolithPayload(rawJson) {
  let regolithData;
  try {
    regolithData = JSON.parse(rawJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to parse Regolith payload JSON: ${message}`);
  }

  if (
    !regolithData ||
    typeof regolithData !== "object" ||
    Array.isArray(regolithData)
  ) {
    throw new CliError("Regolith payload must be a JSON object.");
  }

  const data = regolithData;

  const targetValue =
    data.target ?? data.source ?? data.file ?? data.path ?? parsed.target;
  if (targetValue !== undefined) {
    if (typeof targetValue !== "string" || targetValue.trim() === "") {
      throw new CliError(
        "Regolith payload field 'target' must be a non-empty string."
      );
    }
    settings.targetPath = targetValue;
  }

  const depsValue = data.deps ?? data.dependencies;
  if (depsValue !== undefined) {
    if (
      !Array.isArray(depsValue) ||
      depsValue.some((d) => typeof d !== "string")
    ) {
      throw new CliError(
        "Regolith payload field 'deps' must be an array of strings."
      );
    }
    settings.dependencies = [...depsValue];
  }

  const configModeValue = data.configMode ?? parsed.configMode;
  if (configModeValue !== undefined) {
    if (
      configModeValue === "default" ||
      configModeValue === "merge" ||
      configModeValue === "override"
    ) {
      settings.configMode = configModeValue;
    } else {
      throw new CliError(
        "Regolith payload field 'configMode' must be one of default, merge, or override."
      );
    }
  }

  const checkJsValue = data.checkJs ?? data.checkJS;
  if (checkJsValue !== undefined) {
    if (typeof checkJsValue !== "boolean") {
      throw new CliError("Regolith payload field 'checkJs' must be a boolean.");
    }
    settings.checkJs = checkJsValue;
  }

  const tsconfigValue =
    data.tsconfig ?? data.tsconfigPath ?? parsed.tsconfigPath;
  if (tsconfigValue !== undefined) {
    if (typeof tsconfigValue !== "string" || tsconfigValue.trim() === "") {
      throw new CliError(
        "Regolith payload field 'tsconfig' must be a non-empty string."
      );
    }
    settings.tsconfigPath = tsconfigValue;
  }

  const workspaceValue =
    data.workspace ?? data.workspaceDir ?? parsed.workspaceDir;
  if (workspaceValue !== undefined) {
    if (typeof workspaceValue !== "string" || workspaceValue.trim() === "") {
      throw new CliError(
        "Regolith payload field 'workspace' must be a non-empty string."
      );
    }
    settings.workspaceDir = workspaceValue;
  }

  const configPathValue =
    data.configPath ?? data.configFile ?? data.configPathname;
  if (configPathValue !== undefined) {
    if (typeof configPathValue !== "string" || configPathValue.trim() === "") {
      throw new CliError(
        "Regolith payload field 'configPath' must be a non-empty string."
      );
    }
    settings.config = configPathValue;
  }

  if (data.config !== undefined) {
    if (typeof data.config === "string") {
      if (data.config.trim() === "") {
        throw new CliError(
          "Regolith payload field 'config' must not be an empty string."
        );
      }
      settings.config = data.config;
    } else if (
      typeof data.config === "object" &&
      data.config !== null &&
      !Array.isArray(data.config)
    ) {
      settings.config = data.config;
    } else {
      throw new CliError(
        "Regolith payload field 'config' must be a string path or JSON object."
      );
    }
  }
}

applyRegolithPayload(process.argv[2] || "{}");

const result = optimize(settings);

if (result.changed === 0) {
  console.log("No changes made.");
  return;
}

console.log(`Optimized ${result.changed} files.`);