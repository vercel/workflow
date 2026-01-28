import { hasHelpFlag, showHelp } from "../help.js";
const clearHelp = {
    name: "clear",
    summary: "clear the terminal screen",
    usage: "clear [OPTIONS]",
    options: ["    --help display this help and exit"],
};
export const clearCommand = {
    name: "clear",
    async execute(args, _ctx) {
        if (hasHelpFlag(args)) {
            return showHelp(clearHelp);
        }
        // ANSI escape sequence to clear screen and move cursor to top-left
        const clearSequence = "\x1B[2J\x1B[H";
        return { stdout: clearSequence, stderr: "", exitCode: 0 };
    },
};
