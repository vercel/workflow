export const trueCommand = {
    name: "true",
    async execute() {
        return { stdout: "", stderr: "", exitCode: 0 };
    },
};
export const falseCommand = {
    name: "false",
    async execute() {
        return { stdout: "", stderr: "", exitCode: 1 };
    },
};
