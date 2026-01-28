// src/commands/python3/worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { loadPyodide } from "pyodide";

// src/commands/python3/protocol.ts
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
  CONTROL_REGION: 32,
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
var ProtocolBuffer = class {
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
    const bytes = this.uint8View.slice(
      Offset.PATH_BUFFER,
      Offset.PATH_BUFFER + length
    );
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
    return this.uint8View.slice(
      Offset.DATA_BUFFER,
      Offset.DATA_BUFFER + length
    );
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
    return this.uint8View.slice(
      Offset.DATA_BUFFER,
      Offset.DATA_BUFFER + length
    );
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
    this.dataView.setInt32(
      Offset.DATA_BUFFER + StatLayout.MODE,
      stat.mode,
      true
    );
    const size = Math.min(stat.size, Number.MAX_SAFE_INTEGER);
    this.dataView.setFloat64(Offset.DATA_BUFFER + StatLayout.SIZE, size, true);
    this.dataView.setFloat64(
      Offset.DATA_BUFFER + StatLayout.MTIME,
      stat.mtime.getTime(),
      true
    );
    this.setResultLength(StatLayout.TOTAL);
  }
  decodeStat() {
    return {
      isFile: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] === 1,
      isDirectory: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] === 1,
      isSymbolicLink: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] === 1,
      mode: this.dataView.getInt32(Offset.DATA_BUFFER + StatLayout.MODE, true),
      size: this.dataView.getFloat64(
        Offset.DATA_BUFFER + StatLayout.SIZE,
        true
      ),
      mtime: new Date(
        this.dataView.getFloat64(Offset.DATA_BUFFER + StatLayout.MTIME, true)
      )
    };
  }
  waitForReady(timeout) {
    return Atomics.wait(
      this.int32View,
      Offset.STATUS / 4,
      Status.PENDING,
      timeout
    );
  }
  waitForReadyAsync(timeout) {
    return Atomics.waitAsync(
      this.int32View,
      Offset.STATUS / 4,
      Status.PENDING,
      timeout
    );
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
      const result = Atomics.waitAsync(
        this.int32View,
        Offset.STATUS / 4,
        status,
        remainingMs
      );
      if (result.async) {
        const waitResult = await result.value;
        if (waitResult === "timed-out") {
          return false;
        }
      }
    }
  }
  waitForResult(timeout) {
    return Atomics.wait(
      this.int32View,
      Offset.STATUS / 4,
      Status.READY,
      timeout
    );
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
};

// src/commands/python3/sync-fs-backend.ts
var SyncFsBackend = class {
  protocol;
  constructor(sharedBuffer) {
    this.protocol = new ProtocolBuffer(sharedBuffer);
  }
  execSync(opCode, path, data, flags = 0, mode = 0) {
    this.protocol.reset();
    this.protocol.setOpCode(opCode);
    this.protocol.setPath(path);
    this.protocol.setFlags(flags);
    this.protocol.setMode(mode);
    if (data) {
      this.protocol.setData(data);
    }
    this.protocol.setStatus(Status.READY);
    this.protocol.notify();
    const waitResult = this.protocol.waitForResult(5e3);
    if (waitResult === "timed-out") {
      return { success: false, error: "Operation timed out" };
    }
    const status = this.protocol.getStatus();
    if (status === Status.SUCCESS) {
      return { success: true, result: this.protocol.getResult() };
    }
    return {
      success: false,
      error: this.protocol.getResultAsString() || `Error code: ${this.protocol.getErrorCode()}`
    };
  }
  readFile(path) {
    const result = this.execSync(OpCode.READ_FILE, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to read file");
    }
    return result.result ?? new Uint8Array(0);
  }
  writeFile(path, data) {
    const result = this.execSync(OpCode.WRITE_FILE, path, data);
    if (!result.success) {
      throw new Error(result.error || "Failed to write file");
    }
  }
  stat(path) {
    const result = this.execSync(OpCode.STAT, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to stat");
    }
    return this.protocol.decodeStat();
  }
  lstat(path) {
    const result = this.execSync(OpCode.LSTAT, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to lstat");
    }
    return this.protocol.decodeStat();
  }
  readdir(path) {
    const result = this.execSync(OpCode.READDIR, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to readdir");
    }
    return JSON.parse(this.protocol.getResultAsString());
  }
  mkdir(path, recursive = false) {
    const flags = recursive ? Flags.MKDIR_RECURSIVE : 0;
    const result = this.execSync(OpCode.MKDIR, path, void 0, flags);
    if (!result.success) {
      throw new Error(result.error || "Failed to mkdir");
    }
  }
  rm(path, recursive = false, force = false) {
    let flags = 0;
    if (recursive) flags |= Flags.RECURSIVE;
    if (force) flags |= Flags.FORCE;
    const result = this.execSync(OpCode.RM, path, void 0, flags);
    if (!result.success) {
      throw new Error(result.error || "Failed to rm");
    }
  }
  exists(path) {
    const result = this.execSync(OpCode.EXISTS, path);
    if (!result.success) {
      return false;
    }
    return result.result?.[0] === 1;
  }
  appendFile(path, data) {
    const result = this.execSync(OpCode.APPEND_FILE, path, data);
    if (!result.success) {
      throw new Error(result.error || "Failed to append file");
    }
  }
  symlink(target, linkPath) {
    const targetData = new TextEncoder().encode(target);
    const result = this.execSync(OpCode.SYMLINK, linkPath, targetData);
    if (!result.success) {
      throw new Error(result.error || "Failed to symlink");
    }
  }
  readlink(path) {
    const result = this.execSync(OpCode.READLINK, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to readlink");
    }
    return this.protocol.getResultAsString();
  }
  chmod(path, mode) {
    const result = this.execSync(OpCode.CHMOD, path, void 0, 0, mode);
    if (!result.success) {
      throw new Error(result.error || "Failed to chmod");
    }
  }
  realpath(path) {
    const result = this.execSync(OpCode.REALPATH, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to realpath");
    }
    return this.protocol.getResultAsString();
  }
  writeStdout(data) {
    const encoded = new TextEncoder().encode(data);
    this.execSync(OpCode.WRITE_STDOUT, "", encoded);
  }
  writeStderr(data) {
    const encoded = new TextEncoder().encode(data);
    this.execSync(OpCode.WRITE_STDERR, "", encoded);
  }
  exit(code) {
    this.execSync(OpCode.EXIT, "", void 0, code);
  }
  /**
   * Make an HTTP request through the main thread's secureFetch.
   * Returns the response as a parsed object.
   */
  httpRequest(url, options) {
    const requestData = options ? new TextEncoder().encode(JSON.stringify(options)) : void 0;
    const result = this.execSync(OpCode.HTTP_REQUEST, url, requestData);
    if (!result.success) {
      throw new Error(result.error || "HTTP request failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }
};

// src/commands/python3/worker.ts
var pyodideInstance = null;
var pyodideLoading = null;
async function getPyodide() {
  if (pyodideInstance) {
    return pyodideInstance;
  }
  if (pyodideLoading) {
    return pyodideLoading;
  }
  pyodideLoading = loadPyodide();
  pyodideInstance = await pyodideLoading;
  return pyodideInstance;
}
function createHOSTFS(backend, FS, PATH) {
  const ERRNO_CODES = {
    EPERM: 63,
    ENOENT: 44,
    EIO: 29,
    EBADF: 8,
    EAGAIN: 6,
    EACCES: 2,
    EBUSY: 10,
    EEXIST: 20,
    ENOTDIR: 54,
    EISDIR: 31,
    EINVAL: 28,
    EMFILE: 33,
    ENOSPC: 51,
    ESPIPE: 70,
    EROFS: 69,
    ENOTEMPTY: 55,
    ENOSYS: 52,
    ENOTSUP: 138,
    ENODATA: 42
  };
  function realPath(node) {
    const parts = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    parts.push(node.mount.opts.root);
    parts.reverse();
    return PATH.join(...parts);
  }
  function tryFSOperation(f) {
    try {
      return f();
    } catch (e) {
      const msg = e?.message?.toLowerCase() || (typeof e === "string" ? e.toLowerCase() : "");
      let code = ERRNO_CODES.EIO;
      if (msg.includes("no such file") || msg.includes("not found")) {
        code = ERRNO_CODES.ENOENT;
      } else if (msg.includes("is a directory")) {
        code = ERRNO_CODES.EISDIR;
      } else if (msg.includes("not a directory")) {
        code = ERRNO_CODES.ENOTDIR;
      } else if (msg.includes("already exists")) {
        code = ERRNO_CODES.EEXIST;
      } else if (msg.includes("permission")) {
        code = ERRNO_CODES.EACCES;
      } else if (msg.includes("not empty")) {
        code = ERRNO_CODES.ENOTEMPTY;
      }
      throw new FS.ErrnoError(code);
    }
  }
  function getMode(path) {
    return tryFSOperation(() => {
      const stat = backend.stat(path);
      let mode = stat.mode & 511;
      if (stat.isDirectory) {
        mode |= 16384;
      } else if (stat.isSymbolicLink) {
        mode |= 40960;
      } else {
        mode |= 32768;
      }
      return mode;
    });
  }
  const HOSTFS = {
    mount(_mount) {
      return HOSTFS.createNode(null, "/", 16877, 0);
    },
    createNode(parent, name, mode, dev) {
      if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
        throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
      }
      const node = FS.createNode(parent, name, mode, dev);
      node.node_ops = HOSTFS.node_ops;
      node.stream_ops = HOSTFS.stream_ops;
      return node;
    },
    node_ops: {
      getattr(node) {
        const path = realPath(node);
        return tryFSOperation(() => {
          const stat = backend.stat(path);
          let mode = stat.mode & 511;
          if (stat.isDirectory) {
            mode |= 16384;
          } else if (stat.isSymbolicLink) {
            mode |= 40960;
          } else {
            mode |= 32768;
          }
          return {
            dev: 1,
            ino: node.id,
            mode,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: stat.size,
            atime: stat.mtime,
            mtime: stat.mtime,
            ctime: stat.mtime,
            blksize: 4096,
            blocks: Math.ceil(stat.size / 512)
          };
        });
      },
      setattr(node, attr) {
        const path = realPath(node);
        const mode = attr.mode;
        if (mode !== void 0) {
          tryFSOperation(() => backend.chmod(path, mode));
          node.mode = mode;
        }
        if (attr.size !== void 0) {
          tryFSOperation(() => {
            const content = backend.readFile(path);
            const newContent = content.slice(0, attr.size);
            backend.writeFile(path, newContent);
          });
        }
      },
      lookup(parent, name) {
        const path = PATH.join2(realPath(parent), name);
        const mode = getMode(path);
        return HOSTFS.createNode(parent, name, mode);
      },
      mknod(parent, name, mode, _dev) {
        const node = HOSTFS.createNode(parent, name, mode, _dev);
        const path = realPath(node);
        tryFSOperation(() => {
          if (FS.isDir(node.mode)) {
            backend.mkdir(path, false);
          } else {
            backend.writeFile(path, new Uint8Array(0));
          }
        });
        return node;
      },
      rename(oldNode, newDir, newName) {
        const oldPath = realPath(oldNode);
        const newPath = PATH.join2(realPath(newDir), newName);
        tryFSOperation(() => {
          const content = backend.readFile(oldPath);
          backend.writeFile(newPath, content);
          backend.rm(oldPath, false, false);
        });
        oldNode.name = newName;
      },
      unlink(parent, name) {
        const path = PATH.join2(realPath(parent), name);
        tryFSOperation(() => backend.rm(path, false, false));
      },
      rmdir(parent, name) {
        const path = PATH.join2(realPath(parent), name);
        tryFSOperation(() => backend.rm(path, false, false));
      },
      readdir(node) {
        const path = realPath(node);
        return tryFSOperation(() => backend.readdir(path));
      },
      symlink(parent, newName, oldPath) {
        const newPath = PATH.join2(realPath(parent), newName);
        tryFSOperation(() => backend.symlink(oldPath, newPath));
      },
      readlink(node) {
        const path = realPath(node);
        return tryFSOperation(() => backend.readlink(path));
      }
    },
    stream_ops: {
      open(stream) {
        const path = realPath(stream.node);
        const flags = stream.flags;
        const O_WRONLY = 1;
        const O_RDWR = 2;
        const O_CREAT = 64;
        const O_TRUNC = 512;
        const O_APPEND = 1024;
        const accessMode = flags & 3;
        const isWrite = accessMode === O_WRONLY || accessMode === O_RDWR;
        const isCreate = (flags & O_CREAT) !== 0;
        const isTruncate = (flags & O_TRUNC) !== 0;
        const isAppend = (flags & O_APPEND) !== 0;
        if (FS.isDir(stream.node.mode)) {
          return;
        }
        let content;
        try {
          if (isTruncate && isWrite) {
            content = new Uint8Array(0);
          } else {
            content = backend.readFile(path);
          }
        } catch (_e) {
          if (isCreate && isWrite) {
            content = new Uint8Array(0);
          } else {
            throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
          }
        }
        stream.hostContent = content;
        stream.hostModified = isTruncate && isWrite;
        stream.hostPath = path;
        if (isAppend) {
          stream.position = content.length;
        }
      },
      close(stream) {
        const hostPath = stream.hostPath;
        const hostContent = stream.hostContent;
        if (stream.hostModified && hostContent && hostPath) {
          tryFSOperation(() => backend.writeFile(hostPath, hostContent));
        }
        delete stream.hostContent;
        delete stream.hostModified;
        delete stream.hostPath;
      },
      read(stream, buffer, offset, length, position) {
        const content = stream.hostContent;
        if (!content) return 0;
        const size = content.length;
        if (position >= size) return 0;
        const bytesToRead = Math.min(length, size - position);
        buffer.set(content.subarray(position, position + bytesToRead), offset);
        return bytesToRead;
      },
      write(stream, buffer, offset, length, position) {
        let content = stream.hostContent || new Uint8Array(0);
        const newSize = Math.max(content.length, position + length);
        if (newSize > content.length) {
          const newContent = new Uint8Array(newSize);
          newContent.set(content);
          content = newContent;
          stream.hostContent = content;
        }
        content.set(buffer.subarray(offset, offset + length), position);
        stream.hostModified = true;
        return length;
      },
      llseek(stream, offset, whence) {
        const SEEK_CUR = 1;
        const SEEK_END = 2;
        let position = offset;
        if (whence === SEEK_CUR) {
          position += stream.position;
        } else if (whence === SEEK_END) {
          if (FS.isFile(stream.node.mode)) {
            const content = stream.hostContent;
            position += content ? content.length : 0;
          }
        }
        if (position < 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        return position;
      }
    }
  };
  return HOSTFS;
}
async function runPython(input) {
  const backend = new SyncFsBackend(input.sharedBuffer);
  let pyodide;
  try {
    pyodide = await getPyodide();
  } catch (e) {
    return {
      success: false,
      error: `Failed to load Pyodide: ${e.message}`
    };
  }
  pyodide.setStdout({ batched: () => {
  } });
  pyodide.setStderr({ batched: () => {
  } });
  try {
    pyodide.runPython(`
import sys
if hasattr(sys.stdout, 'flush'):
    sys.stdout.flush()
if hasattr(sys.stderr, 'flush'):
    sys.stderr.flush()
`);
  } catch (_e) {
  }
  pyodide.setStdout({
    batched: (text) => {
      backend.writeStdout(`${text}
`);
    }
  });
  pyodide.setStderr({
    batched: (text) => {
      backend.writeStderr(`${text}
`);
    }
  });
  const FS = pyodide.FS;
  const PATH = pyodide.PATH;
  const HOSTFS = createHOSTFS(backend, FS, PATH);
  try {
    try {
      pyodide.runPython(`import os; os.chdir('/')`);
    } catch (_e) {
    }
    try {
      FS.mkdir("/host");
    } catch (_e) {
    }
    try {
      FS.unmount("/host");
    } catch (_e) {
    }
    FS.mount(HOSTFS, { root: "/" }, "/host");
  } catch (e) {
    return {
      success: false,
      error: `Failed to mount HOSTFS: ${e.message}`
    };
  }
  try {
    pyodide.runPython(`
import sys
if '_jb_http_bridge' in sys.modules:
    del sys.modules['_jb_http_bridge']
if 'jb_http' in sys.modules:
    del sys.modules['jb_http']
`);
  } catch (_e) {
  }
  pyodide.registerJsModule("_jb_http_bridge", {
    request: (url, method, headersJson, body) => {
      try {
        const headers = headersJson ? JSON.parse(headersJson) : void 0;
        const result = backend.httpRequest(url, {
          method: method || "GET",
          headers,
          body: body || void 0
        });
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }
  });
  const envSetup = Object.entries(input.env).map(([key, value]) => {
    return `os.environ[${JSON.stringify(key)}] = ${JSON.stringify(value)}`;
  }).join("\n");
  const argv0 = input.scriptPath || "python3";
  const argvList = [argv0, ...input.args].map((arg) => JSON.stringify(arg)).join(", ");
  try {
    await pyodide.runPythonAsync(`
import os
import sys
import builtins
import json

${envSetup}

sys.argv = [${argvList}]

# Create jb_http module for HTTP requests
class _JbHttpResponse:
    """HTTP response object similar to requests.Response"""
    def __init__(self, data):
        self.status_code = data.get('status', 0)
        self.reason = data.get('statusText', '')
        self.headers = data.get('headers', {})
        self.text = data.get('body', '')
        self.url = data.get('url', '')
        self._error = data.get('error')

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        return json.loads(self.text)

    def raise_for_status(self):
        if self._error:
            raise Exception(self._error)
        if not self.ok:
            raise Exception(f"HTTP {self.status_code}: {self.reason}")

class _JbHttp:
    """HTTP client that bridges to just-bash's secureFetch"""
    def request(self, method, url, headers=None, data=None, json_data=None):
        # Import fresh each time to ensure we use the current bridge
        # (important when worker is reused with different SharedArrayBuffer)
        import _jb_http_bridge
        if json_data is not None:
            data = json.dumps(json_data)
            headers = headers or {}
            headers['Content-Type'] = 'application/json'
        # Serialize headers to JSON to avoid PyProxy issues when passing to JS
        headers_json = json.dumps(headers) if headers else None
        result_json = _jb_http_bridge.request(url, method, headers_json, data)
        result = json.loads(result_json)
        # Check for errors from the bridge (network not configured, URL not allowed, etc.)
        if 'error' in result and result.get('status') is None:
            raise Exception(result['error'])
        return _JbHttpResponse(result)

    def get(self, url, headers=None, **kwargs):
        return self.request('GET', url, headers=headers, **kwargs)

    def post(self, url, headers=None, data=None, json=None, **kwargs):
        return self.request('POST', url, headers=headers, data=data, json_data=json, **kwargs)

    def put(self, url, headers=None, data=None, json=None, **kwargs):
        return self.request('PUT', url, headers=headers, data=data, json_data=json, **kwargs)

    def delete(self, url, headers=None, **kwargs):
        return self.request('DELETE', url, headers=headers, **kwargs)

    def head(self, url, headers=None, **kwargs):
        return self.request('HEAD', url, headers=headers, **kwargs)

    def patch(self, url, headers=None, data=None, json=None, **kwargs):
        return self.request('PATCH', url, headers=headers, data=data, json_data=json, **kwargs)

# Register jb_http as an importable module
import types
jb_http = types.ModuleType('jb_http')
jb_http._client = _JbHttp()
jb_http.get = jb_http._client.get
jb_http.post = jb_http._client.post
jb_http.put = jb_http._client.put
jb_http.delete = jb_http._client.delete
jb_http.head = jb_http._client.head
jb_http.patch = jb_http._client.patch
jb_http.request = jb_http._client.request
jb_http.Response = _JbHttpResponse
sys.modules['jb_http'] = jb_http

# Redirect root paths to /host for file operations
# Only patch once - check if already patched
if not hasattr(builtins, '_jb_original_open'):
    builtins._jb_original_open = builtins.open

    def _redirected_open(path, mode='r', *args, **kwargs):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return builtins._jb_original_open(path, mode, *args, **kwargs)
    builtins.open = _redirected_open

    os._jb_original_listdir = os.listdir
    def _redirected_listdir(path='.'):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_listdir(path)
    os.listdir = _redirected_listdir

    os.path._jb_original_exists = os.path.exists
    def _redirected_exists(path):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os.path._jb_original_exists(path)
    os.path.exists = _redirected_exists

    os.path._jb_original_isfile = os.path.isfile
    def _redirected_isfile(path):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os.path._jb_original_isfile(path)
    os.path.isfile = _redirected_isfile

    os.path._jb_original_isdir = os.path.isdir
    def _redirected_isdir(path):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os.path._jb_original_isdir(path)
    os.path.isdir = _redirected_isdir

    os._jb_original_stat = os.stat
    def _redirected_stat(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_stat(path, *args, **kwargs)
    os.stat = _redirected_stat

    os._jb_original_mkdir = os.mkdir
    def _redirected_mkdir(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_mkdir(path, *args, **kwargs)
    os.mkdir = _redirected_mkdir

    os._jb_original_makedirs = os.makedirs
    def _redirected_makedirs(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_makedirs(path, *args, **kwargs)
    os.makedirs = _redirected_makedirs

    os._jb_original_remove = os.remove
    def _redirected_remove(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_remove(path, *args, **kwargs)
    os.remove = _redirected_remove

    os._jb_original_rmdir = os.rmdir
    def _redirected_rmdir(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_rmdir(path, *args, **kwargs)
    os.rmdir = _redirected_rmdir

    # Patch os.getcwd to strip /host prefix
    os._jb_original_getcwd = os.getcwd
    def _redirected_getcwd():
        cwd = os._jb_original_getcwd()
        if cwd.startswith('/host'):
            return cwd[5:]  # Strip '/host' prefix
        return cwd
    os.getcwd = _redirected_getcwd

    # Patch os.chdir to add /host prefix
    os._jb_original_chdir = os.chdir
    def _redirected_chdir(path):
        if isinstance(path, str) and path.startswith('/') and not path.startswith('/lib') and not path.startswith('/proc') and not path.startswith('/host'):
            path = '/host' + path
        return os._jb_original_chdir(path)
    os.chdir = _redirected_chdir

# Set cwd to host mount
os.chdir('/host' + ${JSON.stringify(input.cwd)})
`);
  } catch (e) {
    return {
      success: false,
      error: `Failed to set up environment: ${e.message}`
    };
  }
  try {
    const wrappedCode = `
import sys
_jb_exit_code = 0
try:
${input.pythonCode.split("\n").map((line) => `    ${line}`).join("\n")}
except SystemExit as e:
    _jb_exit_code = e.code if isinstance(e.code, int) else (1 if e.code else 0)
`;
    await pyodide.runPythonAsync(wrappedCode);
    const exitCode = pyodide.globals.get("_jb_exit_code");
    backend.exit(exitCode);
    return { success: true };
  } catch (e) {
    const error = e;
    backend.writeStderr(`${error.message}
`);
    backend.exit(1);
    return { success: true };
  }
}
if (parentPort) {
  if (workerData) {
    runPython(workerData).then((result) => {
      parentPort?.postMessage(result);
    });
  }
  parentPort.on("message", async (input) => {
    try {
      const result = await runPython(input);
      parentPort?.postMessage(result);
    } catch (e) {
      parentPort?.postMessage({ success: false, error: e.message });
    }
  });
}
