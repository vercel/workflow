import { _ as __name } from "../index.mjs";
function showHelp(info) {
  let output = `${info.name} - ${info.summary}

`;
  output += `Usage: ${info.usage}
`;
  if (info.description) {
    output += "\nDescription:\n";
    if (typeof info.description === "string") {
      for (const line of info.description.split("\n")) {
        output += line ? `  ${line}
` : "\n";
      }
    } else if (info.description.length > 0) {
      for (const line of info.description) {
        output += line ? `  ${line}
` : "\n";
      }
    }
  }
  if (info.options && info.options.length > 0) {
    output += "\nOptions:\n";
    for (const opt of info.options) {
      output += `  ${opt}
`;
    }
  }
  if (info.examples && info.examples.length > 0) {
    output += "\nExamples:\n";
    for (const example of info.examples) {
      output += `  ${example}
`;
    }
  }
  if (info.notes && info.notes.length > 0) {
    output += "\nNotes:\n";
    for (const note of info.notes) {
      output += `  ${note}
`;
    }
  }
  return { stdout: output, stderr: "", exitCode: 0 };
}
__name(showHelp, "showHelp");
function hasHelpFlag(args) {
  return args.includes("--help");
}
__name(hasHelpFlag, "hasHelpFlag");
function unknownOption(cmdName, option) {
  const msg = option.startsWith("--") ? `${cmdName}: unrecognized option '${option}'
` : `${cmdName}: invalid option -- '${option.replace(/^-/, "")}'
`;
  return { stdout: "", stderr: msg, exitCode: 1 };
}
__name(unknownOption, "unknownOption");
export {
  hasHelpFlag as h,
  showHelp as s,
  unknownOption as u
};
