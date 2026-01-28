import { Bash } from "../Bash.js";
import { OverlayFs } from "../fs/overlay-fs/index.js";
import { Command } from "./Command.js";
export class Sandbox {
    bashEnv;
    constructor(bashEnv) {
        this.bashEnv = bashEnv;
    }
    static async create(opts) {
        // Determine filesystem: overlayRoot creates an OverlayFs, otherwise use provided fs
        let fs = opts?.fs;
        if (opts?.overlayRoot) {
            if (opts?.fs) {
                throw new Error("Cannot specify both 'fs' and 'overlayRoot' options");
            }
            fs = new OverlayFs({ root: opts.overlayRoot });
        }
        const bashEnv = new Bash({
            env: opts?.env,
            cwd: opts?.cwd,
            // Bash-specific extensions
            fs,
            maxCallDepth: opts?.maxCallDepth,
            maxCommandCount: opts?.maxCommandCount,
            maxLoopIterations: opts?.maxLoopIterations,
            network: opts?.network,
        });
        return new Sandbox(bashEnv);
    }
    async runCommand(cmd, opts) {
        // Use per-exec options for cwd and env (they don't persist after the command)
        const cwd = opts?.cwd ?? this.bashEnv.getCwd();
        const explicitCwd = opts?.cwd !== undefined;
        return new Command(this.bashEnv, cmd, cwd, opts?.env, explicitCwd);
    }
    async writeFiles(files) {
        for (const [path, content] of Object.entries(files)) {
            let data;
            if (typeof content === "string") {
                data = content;
            }
            else {
                if (content.encoding === "base64") {
                    data = Buffer.from(content.content, "base64").toString("utf-8");
                }
                else {
                    data = content.content;
                }
            }
            // Ensure parent directory exists
            const parentDir = path.substring(0, path.lastIndexOf("/")) || "/";
            if (parentDir !== "/") {
                await this.bashEnv.exec(`mkdir -p ${parentDir}`);
            }
            await this.bashEnv.writeFile(path, data);
        }
    }
    async readFile(path, encoding) {
        const content = await this.bashEnv.readFile(path);
        if (encoding === "base64") {
            return Buffer.from(content).toString("base64");
        }
        return content;
    }
    async mkDir(path, opts) {
        const flags = opts?.recursive ? "-p" : "";
        await this.bashEnv.exec(`mkdir ${flags} ${path}`);
    }
    async stop() {
        // No-op for local simulation
    }
    async extendTimeout(_ms) {
        // No-op for local simulation
    }
    get domain() {
        return undefined; // Not applicable for local simulation
    }
    /**
     * Bash-specific: Get the underlying Bash instance for advanced operations.
     * Not available in Vercel Sandbox API.
     */
    get bashEnvInstance() {
        return this.bashEnv;
    }
}
export { Command };
