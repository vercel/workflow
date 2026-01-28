var trueCommand = {
  name: "true",
  async execute() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
};
var falseCommand = {
  name: "false",
  async execute() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
};
export {
  falseCommand,
  trueCommand
};
