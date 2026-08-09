const path = require("node:path");

const OPTION_DEFINITIONS = [
  { name: "dev", alias: "d", type: "boolean" },
  { name: "foreground", alias: "f", type: "boolean" },
  { name: "help", alias: "h", type: "boolean" },
  { name: "log-file", alias: "l", type: "string" },
  { name: "new-window", alias: "n", type: "boolean" },
  { name: "profile-startup", type: "boolean" },
  { name: "crashdump", type: "boolean" },
  { name: "resource-path", alias: "r", type: "string" },
  { name: "safe", type: "boolean" },
  { name: "test", alias: "t", type: "boolean" },
  { name: "main-process", alias: "m", type: "boolean" },
  { name: "timeout", type: "string" },
  { name: "wait", alias: "w", type: "boolean" },
  { name: "add", alias: "a", type: "boolean" },
  { name: "user-data-dir", type: "string" },
  { name: "clear-window-state", type: "boolean" },
  { name: "enable-electron-logging", type: "boolean" },
  { name: "package", alias: "p", type: "boolean" },
  { name: "install", type: "string" },
  { name: "uninstall", type: "string" },
  { name: "list", type: "boolean" },
  { name: "link", type: "string" },
  { name: "unlink", type: "string" },
  { name: "uri-handler", type: "boolean" },
  { name: "version", alias: "v", type: "boolean" },
  // Private options passed by the platform launchers.
  { name: "executed-from", type: "string" },
  { name: "pid", type: "number" },
  { name: "path-environment", type: "string" },
];

const definitionsByName = new Map();
const definitionsByAlias = new Map();
for (const definition of OPTION_DEFINITIONS) {
  definitionsByName.set(definition.name, definition);
  if (definition.alias) definitionsByAlias.set(definition.alias, definition);
}

function optionValue(definition, value) {
  switch (definition.type) {
    case "boolean":
      return value == null ? true : value !== "false";
    case "number": {
      const number = Number(value);
      return Number.isFinite(number) ? number : value;
    }
    default:
      return value;
  }
}

function positionalValue(value) {
  // Match yargs' default numeric coercion. parse-command-line deliberately
  // ignores numeric positionals rather than treating them as file names.
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  return value;
}

function assignOption(result, definition, value) {
  result[definition.name] = optionValue(definition, value);
}

function consumeLongOption(args, index, result) {
  const argument = args[index];
  const equalsIndex = argument.indexOf("=");
  const rawName = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
  const negated = rawName.startsWith("no-");
  const name = negated ? rawName.slice(3) : rawName;
  const definition = definitionsByName.get(name);
  if (!definition) return index;

  if (negated) {
    if (definition.type === "boolean") assignOption(result, definition, "false");
    return index;
  }

  if (equalsIndex !== -1) {
    assignOption(result, definition, argument.slice(equalsIndex + 1));
  } else if (definition.type === "boolean") {
    assignOption(result, definition);
  } else if (index + 1 < args.length && !args[index + 1].startsWith("-")) {
    assignOption(result, definition, args[index + 1]);
    return index + 1;
  } else {
    assignOption(result, definition, null);
  }
  return index;
}

function consumeShortOptions(args, index, result) {
  const argument = args[index];
  if (argument === "-_") return index;

  const characters = argument.slice(1);
  for (let offset = 0; offset < characters.length; offset++) {
    const definition = definitionsByAlias.get(characters[offset]);
    if (!definition) continue;

    if (definition.type === "boolean") {
      assignOption(result, definition);
      continue;
    }

    let value = characters.slice(offset + 1);
    if (value.startsWith("=")) value = value.slice(1);
    if (value.length === 0 && index + 1 < args.length) {
      value = args[index + 1];
      index++;
    }
    assignOption(result, definition, value);
    break;
  }
  return index;
}

function parseCommandLineOptions(processArgs) {
  const args = processArgs.filter((argument) => !argument.startsWith("-psn_"));
  const result = { _: [] };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      result._.push(...args.slice(index + 1).map(positionalValue));
      break;
    } else if (argument.startsWith("--")) {
      index = consumeLongOption(args, index, result);
    } else if (argument.startsWith("-") && argument.length > 1) {
      index = consumeShortOptions(args, index, result);
    } else {
      result._.push(positionalValue(argument));
    }
  }

  return result;
}

function getAppArguments(argv, { defaultApp, appPath }) {
  const args = argv.slice(1);
  if (!defaultApp) return args;

  const resolvedAppPath = path.resolve(appPath);
  const appArgumentIndex = args.findIndex((argument) => {
    if (argument.startsWith("-")) return false;
    return path.resolve(argument) === resolvedAppPath;
  });
  if (appArgumentIndex !== -1) args.splice(appArgumentIndex, 1);
  return args;
}

module.exports = parseCommandLineOptions;
module.exports.getAppArguments = getAppArguments;
