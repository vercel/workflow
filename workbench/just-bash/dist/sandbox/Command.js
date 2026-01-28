export class Command {
    cmdId;
    cwd;
    startedAt;
    exitCode;
    bashEnv;
    cmdLine;
    env;
    explicitCwd;
    resultPromise;
    constructor(bashEnv, cmdLine, cwd, env, explicitCwd = false) {
        this.cmdId = crypto.randomUUID();
        this.cwd = cwd;
        this.startedAt = new Date();
        this.bashEnv = bashEnv;
        this.cmdLine = cmdLine;
        this.env = env;
        this.explicitCwd = explicitCwd;
        // Start execution immediately
        this.resultPromise = this.execute();
    }
    async execute() {
        // Only pass options if they were explicitly provided (to avoid creating isolated state unnecessarily)
        const options = this.env || this.explicitCwd
            ? { cwd: this.explicitCwd ? this.cwd : undefined, env: this.env }
            : undefined;
        const result = await this.bashEnv.exec(this.cmdLine, options);
        this.exitCode = result.exitCode;
        return result;
    }
    async *logs() {
        const result = await this.resultPromise;
        // For Bash, we don't have true streaming, so emit all at once
        if (result.stdout) {
            yield { type: "stdout", data: result.stdout, timestamp: new Date() };
        }
        if (result.stderr) {
            yield { type: "stderr", data: result.stderr, timestamp: new Date() };
        }
    }
    async wait() {
        await this.resultPromise;
        return this;
    }
    async output() {
        const result = await this.resultPromise;
        return result.stdout + result.stderr;
    }
    async stdout() {
        const result = await this.resultPromise;
        return result.stdout;
    }
    async stderr() {
        const result = await this.resultPromise;
        return result.stderr;
    }
    async kill() {
        // For Bash synchronous execution, this is a no-op
        // Commands complete immediately in the simulation
    }
}
