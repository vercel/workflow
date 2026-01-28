var _a, _b;
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import "./_libs/@vercel/functions.mjs";
import "../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../_libs/h3.mjs";
import "../_libs/rou3.mjs";
import "../_libs/ms.mjs";
import "./_libs/@mongodb-js/zstd.mjs";
import "util";
import "util/types";
import "../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:timers/promises";
import "./_libs/@vercel/queue.mjs";
import "../_libs/mixpart.mjs";
import "./_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "./_libs/async-sema.mjs";
import "events";
import "./_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:zlib";
import "node:perf_hooks";
import "node:util/types";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../_libs/cbor-x.mjs";
import "../_libs/devalue.mjs";
import "./_libs/debug.mjs";
import "tty";
import "../_libs/supports-color.mjs";
import "../_libs/has-flag.mjs";
import "./_libs/@jridgewell/trace-mapping.mjs";
import "./_libs/@jridgewell/sourcemap-codec.mjs";
import "./_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../_libs/nanoid.mjs";
import "../_libs/seedrandom.mjs";
import "../_libs/ufo.mjs";
var OpCode = {
  NOOP: 0,
  READ_FILE: 1,
  WRITE_FILE: 2,
  STAT: 3,
  READDIR: 4,
  MKDIR: 5,
  RM: 6,
  EXISTS: 7,
  APPEND_FILE: 8,
  SYMLINK: 9,
  READLINK: 10,
  LSTAT: 11,
  CHMOD: 12,
  REALPATH: 13,
  // Special operations for Python I/O
  WRITE_STDOUT: 100,
  WRITE_STDERR: 101,
  EXIT: 102,
  // HTTP operations
  HTTP_REQUEST: 200
};
var Status = {
  PENDING: 0,
  READY: 1,
  SUCCESS: 2,
  ERROR: 3
};
var ErrorCode = {
  NONE: 0,
  NOT_FOUND: 1,
  IS_DIRECTORY: 2,
  NOT_DIRECTORY: 3,
  EXISTS: 4,
  PERMISSION_DENIED: 5,
  INVALID_PATH: 6,
  IO_ERROR: 7,
  TIMEOUT: 8,
  NETWORK_ERROR: 9,
  NETWORK_NOT_CONFIGURED: 10
};
var Offset = {
  OP_CODE: 0,
  STATUS: 4,
  PATH_LENGTH: 8,
  DATA_LENGTH: 12,
  RESULT_LENGTH: 16,
  ERROR_CODE: 20,
  FLAGS: 24,
  MODE: 28,
  PATH_BUFFER: 32,
  DATA_BUFFER: 4128
  // 32 + 4096
};
var Size = {
  PATH_BUFFER: 4096,
  DATA_BUFFER: 1048576,
  // 1MB (reduced from 16MB for faster tests)
  TOTAL: 1052704
  // 32 + 4096 + 1MB
};
var Flags = {
  NONE: 0,
  RECURSIVE: 1,
  FORCE: 2,
  MKDIR_RECURSIVE: 1
};
var StatLayout = {
  IS_FILE: 0,
  IS_DIRECTORY: 1,
  IS_SYMLINK: 2,
  MODE: 4,
  SIZE: 8,
  MTIME: 16,
  TOTAL: 24
};
function createSharedBuffer() {
  return new SharedArrayBuffer(Size.TOTAL);
}
__name(createSharedBuffer, "createSharedBuffer");
var ProtocolBuffer = (_a = class {
  int32View;
  uint8View;
  dataView;
  constructor(buffer) {
    this.int32View = new Int32Array(buffer);
    this.uint8View = new Uint8Array(buffer);
    this.dataView = new DataView(buffer);
  }
  getOpCode() {
    return Atomics.load(this.int32View, Offset.OP_CODE / 4);
  }
  setOpCode(code) {
    Atomics.store(this.int32View, Offset.OP_CODE / 4, code);
  }
  getStatus() {
    return Atomics.load(this.int32View, Offset.STATUS / 4);
  }
  setStatus(status) {
    Atomics.store(this.int32View, Offset.STATUS / 4, status);
  }
  getPathLength() {
    return Atomics.load(this.int32View, Offset.PATH_LENGTH / 4);
  }
  setPathLength(length) {
    Atomics.store(this.int32View, Offset.PATH_LENGTH / 4, length);
  }
  getDataLength() {
    return Atomics.load(this.int32View, Offset.DATA_LENGTH / 4);
  }
  setDataLength(length) {
    Atomics.store(this.int32View, Offset.DATA_LENGTH / 4, length);
  }
  getResultLength() {
    return Atomics.load(this.int32View, Offset.RESULT_LENGTH / 4);
  }
  setResultLength(length) {
    Atomics.store(this.int32View, Offset.RESULT_LENGTH / 4, length);
  }
  getErrorCode() {
    return Atomics.load(this.int32View, Offset.ERROR_CODE / 4);
  }
  setErrorCode(code) {
    Atomics.store(this.int32View, Offset.ERROR_CODE / 4, code);
  }
  getFlags() {
    return Atomics.load(this.int32View, Offset.FLAGS / 4);
  }
  setFlags(flags) {
    Atomics.store(this.int32View, Offset.FLAGS / 4, flags);
  }
  getMode() {
    return Atomics.load(this.int32View, Offset.MODE / 4);
  }
  setMode(mode) {
    Atomics.store(this.int32View, Offset.MODE / 4, mode);
  }
  getPath() {
    const length = this.getPathLength();
    const bytes = this.uint8View.slice(Offset.PATH_BUFFER, Offset.PATH_BUFFER + length);
    return new TextDecoder().decode(bytes);
  }
  setPath(path) {
    const encoded = new TextEncoder().encode(path);
    if (encoded.length > Size.PATH_BUFFER) {
      throw new Error(`Path too long: ${encoded.length} > ${Size.PATH_BUFFER}`);
    }
    this.uint8View.set(encoded, Offset.PATH_BUFFER);
    this.setPathLength(encoded.length);
  }
  getData() {
    const length = this.getDataLength();
    return this.uint8View.slice(Offset.DATA_BUFFER, Offset.DATA_BUFFER + length);
  }
  setData(data) {
    if (data.length > Size.DATA_BUFFER) {
      throw new Error(`Data too large: ${data.length} > ${Size.DATA_BUFFER}`);
    }
    this.uint8View.set(data, Offset.DATA_BUFFER);
    this.setDataLength(data.length);
  }
  getDataAsString() {
    const data = this.getData();
    return new TextDecoder().decode(data);
  }
  setDataFromString(str) {
    const encoded = new TextEncoder().encode(str);
    this.setData(encoded);
  }
  getResult() {
    const length = this.getResultLength();
    return this.uint8View.slice(Offset.DATA_BUFFER, Offset.DATA_BUFFER + length);
  }
  setResult(data) {
    if (data.length > Size.DATA_BUFFER) {
      throw new Error(`Result too large: ${data.length} > ${Size.DATA_BUFFER}`);
    }
    this.uint8View.set(data, Offset.DATA_BUFFER);
    this.setResultLength(data.length);
  }
  getResultAsString() {
    const result = this.getResult();
    return new TextDecoder().decode(result);
  }
  setResultFromString(str) {
    const encoded = new TextEncoder().encode(str);
    this.setResult(encoded);
  }
  encodeStat(stat) {
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] = stat.isFile ? 1 : 0;
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] = stat.isDirectory ? 1 : 0;
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] = stat.isSymbolicLink ? 1 : 0;
    this.dataView.setInt32(Offset.DATA_BUFFER + StatLayout.MODE, stat.mode, true);
    const size = Math.min(stat.size, Number.MAX_SAFE_INTEGER);
    this.dataView.setFloat64(Offset.DATA_BUFFER + StatLayout.SIZE, size, true);
    this.dataView.setFloat64(Offset.DATA_BUFFER + StatLayout.MTIME, stat.mtime.getTime(), true);
    this.setResultLength(StatLayout.TOTAL);
  }
  decodeStat() {
    return {
      isFile: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] === 1,
      isDirectory: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] === 1,
      isSymbolicLink: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] === 1,
      mode: this.dataView.getInt32(Offset.DATA_BUFFER + StatLayout.MODE, true),
      size: this.dataView.getFloat64(Offset.DATA_BUFFER + StatLayout.SIZE, true),
      mtime: new Date(this.dataView.getFloat64(Offset.DATA_BUFFER + StatLayout.MTIME, true))
    };
  }
  waitForReady(timeout) {
    return Atomics.wait(this.int32View, Offset.STATUS / 4, Status.PENDING, timeout);
  }
  waitForReadyAsync(timeout) {
    return Atomics.waitAsync(this.int32View, Offset.STATUS / 4, Status.PENDING, timeout);
  }
  /**
   * Wait for status to become READY.
   * Returns immediately if status is already READY, or waits until it changes.
   */
  async waitUntilReady(timeout) {
    const startTime = Date.now();
    while (true) {
      const status = this.getStatus();
      if (status === Status.READY) {
        return true;
      }
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        return false;
      }
      const remainingMs = timeout - elapsed;
      const result = Atomics.waitAsync(this.int32View, Offset.STATUS / 4, status, remainingMs);
      if (result.async) {
        const waitResult = await result.value;
        if (waitResult === "timed-out") {
          return false;
        }
      }
    }
  }
  waitForResult(timeout) {
    return Atomics.wait(this.int32View, Offset.STATUS / 4, Status.READY, timeout);
  }
  notify() {
    return Atomics.notify(this.int32View, Offset.STATUS / 4);
  }
  reset() {
    this.setOpCode(OpCode.NOOP);
    this.setStatus(Status.PENDING);
    this.setPathLength(0);
    this.setDataLength(0);
    this.setResultLength(0);
    this.setErrorCode(ErrorCode.NONE);
    this.setFlags(Flags.NONE);
    this.setMode(0);
  }
}, __name(_a, "ProtocolBuffer"), _a);
var FsBridgeHandler = (_b = class {
  fs;
  cwd;
  secureFetch;
  protocol;
  running = false;
  output = { stdout: "", stderr: "", exitCode: 0 };
  constructor(sharedBuffer, fs, cwd, secureFetch = void 0) {
    this.fs = fs;
    this.cwd = cwd;
    this.secureFetch = secureFetch;
    this.protocol = new ProtocolBuffer(sharedBuffer);
  }
  /**
   * Run the handler loop until EXIT operation or timeout.
   */
  async run(timeoutMs) {
    this.running = true;
    const startTime = Date.now();
    while (this.running) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        this.output.stderr += "\npython3: execution timeout exceeded\n";
        this.output.exitCode = 124;
        break;
      }
      const remainingMs = timeoutMs - elapsed;
      const ready = await this.protocol.waitUntilReady(remainingMs);
      if (!ready) {
        this.output.stderr += "\npython3: execution timeout exceeded\n";
        this.output.exitCode = 124;
        break;
      }
      const opCode = this.protocol.getOpCode();
      await this.handleOperation(opCode);
      this.protocol.notify();
    }
    return this.output;
  }
  stop() {
    this.running = false;
  }
  async handleOperation(opCode) {
    try {
      switch (opCode) {
        case OpCode.READ_FILE:
          await this.handleReadFile();
          break;
        case OpCode.WRITE_FILE:
          await this.handleWriteFile();
          break;
        case OpCode.STAT:
          await this.handleStat();
          break;
        case OpCode.LSTAT:
          await this.handleLstat();
          break;
        case OpCode.READDIR:
          await this.handleReaddir();
          break;
        case OpCode.MKDIR:
          await this.handleMkdir();
          break;
        case OpCode.RM:
          await this.handleRm();
          break;
        case OpCode.EXISTS:
          await this.handleExists();
          break;
        case OpCode.APPEND_FILE:
          await this.handleAppendFile();
          break;
        case OpCode.SYMLINK:
          await this.handleSymlink();
          break;
        case OpCode.READLINK:
          await this.handleReadlink();
          break;
        case OpCode.CHMOD:
          await this.handleChmod();
          break;
        case OpCode.REALPATH:
          await this.handleRealpath();
          break;
        case OpCode.WRITE_STDOUT:
          this.handleWriteStdout();
          break;
        case OpCode.WRITE_STDERR:
          this.handleWriteStderr();
          break;
        case OpCode.EXIT:
          this.handleExit();
          break;
        case OpCode.HTTP_REQUEST:
          await this.handleHttpRequest();
          break;
        default:
          this.protocol.setErrorCode(ErrorCode.IO_ERROR);
          this.protocol.setStatus(Status.ERROR);
      }
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  resolvePath(path) {
    if (path.startsWith("/mnt/host/")) {
      return path.slice("/mnt/host".length);
    }
    if (path.startsWith("/mnt/host")) {
      return path.slice("/mnt/host".length) || "/";
    }
    return this.fs.resolvePath(this.cwd, path);
  }
  async handleReadFile() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const content = await this.fs.readFileBuffer(path);
      this.protocol.setResult(content);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleWriteFile() {
    const path = this.resolvePath(this.protocol.getPath());
    const data = this.protocol.getData();
    try {
      await this.fs.writeFile(path, data);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleStat() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.stat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleLstat() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.lstat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleReaddir() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const entries = await this.fs.readdir(path);
      this.protocol.setResultFromString(JSON.stringify(entries));
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleMkdir() {
    const path = this.resolvePath(this.protocol.getPath());
    const flags = this.protocol.getFlags();
    const recursive = (flags & Flags.MKDIR_RECURSIVE) !== 0;
    try {
      await this.fs.mkdir(path, { recursive });
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleRm() {
    const path = this.resolvePath(this.protocol.getPath());
    const flags = this.protocol.getFlags();
    const recursive = (flags & Flags.RECURSIVE) !== 0;
    const force = (flags & Flags.FORCE) !== 0;
    try {
      await this.fs.rm(path, { recursive, force });
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleExists() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const exists = await this.fs.exists(path);
      this.protocol.setResult(new Uint8Array([exists ? 1 : 0]));
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleAppendFile() {
    const path = this.resolvePath(this.protocol.getPath());
    const data = this.protocol.getData();
    try {
      await this.fs.appendFile(path, data);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleSymlink() {
    const path = this.protocol.getPath();
    const data = this.protocol.getDataAsString();
    const linkPath = this.resolvePath(path);
    try {
      await this.fs.symlink(data, linkPath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleReadlink() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const target = await this.fs.readlink(path);
      this.protocol.setResultFromString(target);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleChmod() {
    const path = this.resolvePath(this.protocol.getPath());
    const mode = this.protocol.getMode();
    try {
      await this.fs.chmod(path, mode);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleRealpath() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const realpath = await this.fs.realpath(path);
      this.protocol.setResultFromString(realpath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  handleWriteStdout() {
    const data = this.protocol.getDataAsString();
    this.output.stdout += data;
    this.protocol.setStatus(Status.SUCCESS);
  }
  handleWriteStderr() {
    const data = this.protocol.getDataAsString();
    this.output.stderr += data;
    this.protocol.setStatus(Status.SUCCESS);
  }
  handleExit() {
    const exitCode = this.protocol.getFlags();
    this.output.exitCode = exitCode;
    this.protocol.setStatus(Status.SUCCESS);
    this.running = false;
  }
  async handleHttpRequest() {
    if (!this.secureFetch) {
      this.protocol.setErrorCode(ErrorCode.NETWORK_NOT_CONFIGURED);
      this.protocol.setResultFromString("Network access not configured. Enable network in Bash options.");
      this.protocol.setStatus(Status.ERROR);
      return;
    }
    const url = this.protocol.getPath();
    const requestJson = this.protocol.getDataAsString();
    try {
      const request = requestJson ? JSON.parse(requestJson) : {};
      const result = await this.secureFetch(url, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      const response = JSON.stringify({
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
        url: result.url
      });
      this.protocol.setResultFromString(response);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.protocol.setErrorCode(ErrorCode.NETWORK_ERROR);
      this.protocol.setResultFromString(message);
      this.protocol.setStatus(Status.ERROR);
    }
  }
  setErrorFromException(e) {
    const message = e instanceof Error ? e.message : String(e);
    let errorCode = ErrorCode.IO_ERROR;
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes("no such file") || lowerMsg.includes("not found") || lowerMsg.includes("enoent")) {
      errorCode = ErrorCode.NOT_FOUND;
    } else if (lowerMsg.includes("is a directory") || lowerMsg.includes("eisdir")) {
      errorCode = ErrorCode.IS_DIRECTORY;
    } else if (lowerMsg.includes("not a directory") || lowerMsg.includes("enotdir")) {
      errorCode = ErrorCode.NOT_DIRECTORY;
    } else if (lowerMsg.includes("already exists") || lowerMsg.includes("eexist")) {
      errorCode = ErrorCode.EXISTS;
    } else if (lowerMsg.includes("permission") || lowerMsg.includes("eperm") || lowerMsg.includes("eacces")) {
      errorCode = ErrorCode.PERMISSION_DENIED;
    }
    this.protocol.setErrorCode(errorCode);
    this.protocol.setResultFromString(message);
    this.protocol.setStatus(Status.ERROR);
  }
}, __name(_b, "FsBridgeHandler"), _b);
var DEFAULT_PYTHON_TIMEOUT_MS = 3e4;
var python3Help = {
  name: "python3",
  summary: "Execute Python code via Pyodide",
  usage: "python3 [OPTIONS] [-c CODE | -m MODULE | FILE] [ARGS...]",
  description: [
    "Execute Python code using Pyodide (Python compiled to WebAssembly).",
    "",
    "This command runs Python in a sandboxed environment with access to",
    "the virtual filesystem. Only Pyodide-bundled packages are available."
  ],
  options: [
    "-c CODE     Execute CODE as Python script",
    "-m MODULE   Run library module as a script",
    "--version   Show Python version",
    "--help      Show this help"
  ],
  examples: [
    'python3 -c "print(1 + 2)"',
    'python3 -c "import sys; print(sys.version)"',
    "python3 script.py",
    "python3 script.py arg1 arg2",
    `echo 'print("hello")' | python3`
  ],
  notes: [
    "Pyodide runs in WebAssembly, so execution may be slower than native Python.",
    "Only packages bundled with Pyodide are available (no pip install).",
    "First execution loads Pyodide (~30MB), subsequent calls are faster.",
    "Maximum execution time is 30 seconds by default."
  ]
};
function parseArgs(args) {
  const result = {
    code: null,
    module: null,
    scriptFile: null,
    showVersion: false,
    scriptArgs: []
  };
  if (args.length === 0) {
    return result;
  }
  const firstArgIndex = args.findIndex((arg) => {
    return !arg.startsWith("-") || arg === "-" || arg === "--";
  });
  for (let i = 0; i < (firstArgIndex === -1 ? args.length : firstArgIndex); i++) {
    const arg = args[i];
    if (arg === "-c") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'c'\n",
          exitCode: 2
        };
      }
      result.code = args[i + 1];
      result.scriptArgs = args.slice(i + 2);
      return result;
    }
    if (arg === "-m") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'm'\n",
          exitCode: 2
        };
      }
      result.module = args[i + 1];
      result.scriptArgs = args.slice(i + 2);
      return result;
    }
    if (arg === "--version" || arg === "-V") {
      result.showVersion = true;
      return result;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return {
        stdout: "",
        stderr: `python3: unrecognized option '${arg}'
`,
        exitCode: 2
      };
    }
  }
  if (firstArgIndex !== -1) {
    const arg = args[firstArgIndex];
    if (arg === "--") {
      if (firstArgIndex + 1 < args.length) {
        result.scriptFile = args[firstArgIndex + 1];
        result.scriptArgs = args.slice(firstArgIndex + 2);
      }
    } else {
      result.scriptFile = arg;
      result.scriptArgs = args.slice(firstArgIndex + 1);
    }
  }
  return result;
}
__name(parseArgs, "parseArgs");
var sharedWorker = null;
var workerIdleTimeout = null;
var executionQueue = [];
var currentExecution = null;
var workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
function processNextExecution() {
  if (currentExecution || executionQueue.length === 0) {
    return;
  }
  const next = executionQueue.shift();
  if (!next) {
    return;
  }
  currentExecution = next;
  const worker = getOrCreateWorker();
  worker.postMessage(currentExecution.input);
}
__name(processNextExecution, "processNextExecution");
function getOrCreateWorker() {
  if (workerIdleTimeout) {
    clearTimeout(workerIdleTimeout);
    workerIdleTimeout = null;
  }
  if (sharedWorker) {
    return sharedWorker;
  }
  sharedWorker = new Worker(workerPath);
  sharedWorker.on("message", (result) => {
    if (currentExecution) {
      currentExecution.resolve(result);
      currentExecution = null;
    }
    if (executionQueue.length > 0) {
      processNextExecution();
    } else {
      scheduleWorkerTermination();
    }
  });
  sharedWorker.on("error", (err) => {
    if (currentExecution) {
      currentExecution.resolve({ success: false, error: err.message });
      currentExecution = null;
    }
    for (const queued of executionQueue) {
      queued.resolve({ success: false, error: "Worker crashed" });
    }
    executionQueue.length = 0;
    sharedWorker = null;
  });
  sharedWorker.on("exit", () => {
    sharedWorker = null;
  });
  return sharedWorker;
}
__name(getOrCreateWorker, "getOrCreateWorker");
function scheduleWorkerTermination() {
  workerIdleTimeout = setTimeout(() => {
    if (sharedWorker && !currentExecution && executionQueue.length === 0) {
      sharedWorker.terminate();
      sharedWorker = null;
    }
  }, 5e3);
}
__name(scheduleWorkerTermination, "scheduleWorkerTermination");
async function executePython(pythonCode, ctx, scriptPath, scriptArgs = []) {
  const sharedBuffer = createSharedBuffer();
  const bridgeHandler = new FsBridgeHandler(sharedBuffer, ctx.fs, ctx.cwd, ctx.fetch);
  const timeoutMs = ctx.limits?.maxPythonTimeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS;
  const workerInput = {
    sharedBuffer,
    pythonCode,
    cwd: ctx.cwd,
    env: ctx.env,
    args: scriptArgs,
    scriptPath
  };
  const workerPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        success: false,
        error: `Execution timeout: exceeded ${timeoutMs}ms limit`
      });
    }, timeoutMs);
    const wrappedResolve = /* @__PURE__ */ __name((result) => {
      clearTimeout(timeout);
      resolve(result);
    }, "wrappedResolve");
    executionQueue.push({ input: workerInput, resolve: wrappedResolve });
    processNextExecution();
  });
  const [bridgeOutput, workerResult] = await Promise.all([
    bridgeHandler.run(timeoutMs),
    workerPromise.catch((e) => ({
      success: false,
      error: e.message
    }))
  ]);
  if (!workerResult.success && workerResult.error) {
    return {
      stdout: bridgeOutput.stdout,
      stderr: `${bridgeOutput.stderr}python3: ${workerResult.error}
`,
      exitCode: bridgeOutput.exitCode || 1
    };
  }
  return bridgeOutput;
}
__name(executePython, "executePython");
var python3Command = {
  name: "python3",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(python3Help);
    }
    const parsed = parseArgs(args);
    if ("exitCode" in parsed)
      return parsed;
    if (parsed.showVersion) {
      return {
        stdout: "Python 3.12.1 (Pyodide)\n",
        stderr: "",
        exitCode: 0
      };
    }
    let pythonCode;
    let scriptPath;
    if (parsed.code !== null) {
      pythonCode = parsed.code;
      scriptPath = "-c";
    } else if (parsed.module !== null) {
      pythonCode = `import runpy; runpy.run_module('${parsed.module}', run_name='__main__')`;
      scriptPath = parsed.module;
    } else if (parsed.scriptFile !== null) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, parsed.scriptFile);
      if (!await ctx.fs.exists(filePath)) {
        return {
          stdout: "",
          stderr: `python3: can't open file '${parsed.scriptFile}': [Errno 2] No such file or directory
`,
          exitCode: 2
        };
      }
      try {
        pythonCode = await ctx.fs.readFile(filePath);
        scriptPath = parsed.scriptFile;
      } catch (e) {
        return {
          stdout: "",
          stderr: `python3: can't open file '${parsed.scriptFile}': ${e.message}
`,
          exitCode: 2
        };
      }
    } else if (ctx.stdin.trim()) {
      pythonCode = ctx.stdin;
      scriptPath = "<stdin>";
    } else {
      return {
        stdout: "",
        stderr: "python3: no input provided (use -c CODE, -m MODULE, or provide a script file)\n",
        exitCode: 2
      };
    }
    return executePython(pythonCode, ctx, scriptPath, parsed.scriptArgs);
  }
};
var pythonCommand = {
  name: "python",
  async execute(args, ctx) {
    return python3Command.execute(args, ctx);
  }
};
export {
  python3Command,
  pythonCommand
};
