import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/comm/comm.js
var commHelp = {
  name: "comm",
  summary: "compare two sorted files line by line",
  usage: "comm [OPTION]... FILE1 FILE2",
  options: [
    "-1             suppress column 1 (lines unique to FILE1)",
    "-2             suppress column 2 (lines unique to FILE2)",
    "-3             suppress column 3 (lines that appear in both files)",
    "    --help     display this help and exit"
  ]
};
var commCommand = {
  name: "comm",
  async execute(args, ctx) {
    if (hasHelpFlag(args))
      return showHelp(commHelp);
    let suppress1 = false;
    let suppress2 = false;
    let suppress3 = false;
    const files = [];
    for (const arg of args) {
      if (arg === "-1")
        suppress1 = true;
      else if (arg === "-2")
        suppress2 = true;
      else if (arg === "-3")
        suppress3 = true;
      else if (arg === "-12" || arg === "-21") {
        suppress1 = true;
        suppress2 = true;
      } else if (arg === "-13" || arg === "-31") {
        suppress1 = true;
        suppress3 = true;
      } else if (arg === "-23" || arg === "-32") {
        suppress2 = true;
        suppress3 = true;
      } else if (arg === "-123" || arg === "-132" || arg === "-213" || arg === "-231" || arg === "-312" || arg === "-321") {
        suppress1 = true;
        suppress2 = true;
        suppress3 = true;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("comm", arg);
      } else {
        files.push(arg);
      }
    }
    if (files.length !== 2) {
      return {
        stdout: "",
        stderr: "comm: missing operand\nTry 'comm --help' for more information.\n",
        exitCode: 1
      };
    }
    const readFile = /* @__PURE__ */ __name(async (file) => {
      if (file === "-") {
        return ctx.stdin;
      }
      try {
        const path = ctx.fs.resolvePath(ctx.cwd, file);
        return await ctx.fs.readFile(path);
      } catch {
        return null;
      }
    }, "readFile");
    const content1 = await readFile(files[0]);
    if (content1 === null) {
      return {
        stdout: "",
        stderr: `comm: ${files[0]}: No such file or directory
`,
        exitCode: 1
      };
    }
    const content2 = await readFile(files[1]);
    if (content2 === null) {
      return {
        stdout: "",
        stderr: `comm: ${files[1]}: No such file or directory
`,
        exitCode: 1
      };
    }
    const lines1 = content1.split("\n");
    const lines2 = content2.split("\n");
    if (lines1.length > 0 && lines1[lines1.length - 1] === "")
      lines1.pop();
    if (lines2.length > 0 && lines2[lines2.length - 1] === "")
      lines2.pop();
    let i = 0;
    let j = 0;
    let output = "";
    const col2Prefix = suppress1 ? "" : "	";
    const col3Prefix = (suppress1 ? "" : "	") + (suppress2 ? "" : "	");
    while (i < lines1.length || j < lines2.length) {
      if (i >= lines1.length) {
        if (!suppress2) {
          output += `${col2Prefix}${lines2[j]}
`;
        }
        j++;
      } else if (j >= lines2.length) {
        if (!suppress1) {
          output += `${lines1[i]}
`;
        }
        i++;
      } else if (lines1[i] < lines2[j]) {
        if (!suppress1) {
          output += `${lines1[i]}
`;
        }
        i++;
      } else if (lines1[i] > lines2[j]) {
        if (!suppress2) {
          output += `${col2Prefix}${lines2[j]}
`;
        }
        j++;
      } else {
        if (!suppress3) {
          output += `${col3Prefix}${lines1[i]}
`;
        }
        i++;
        j++;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  commCommand
};
