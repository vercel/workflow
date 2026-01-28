var pwdCommand = {
  name: "pwd",
  async execute(args, ctx) {
    let usePhysical = false;
    for (const arg of args) {
      if (arg === "-P") {
        usePhysical = true;
      } else if (arg === "-L") {
        usePhysical = false;
      } else if (arg === "--") {
        break;
      } else if (arg.startsWith("-")) ;
    }
    let pwd = ctx.cwd;
    if (usePhysical) {
      try {
        pwd = await ctx.fs.realpath(ctx.cwd);
      } catch {
      }
    }
    return {
      stdout: `${pwd}
`,
      stderr: "",
      exitCode: 0
    };
  }
};
export {
  pwdCommand
};
