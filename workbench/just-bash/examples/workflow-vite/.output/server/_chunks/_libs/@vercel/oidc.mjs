import { g as getDefaultExportFromCjs } from "../@mongodb-js/zstd.mjs";
import require$$0 from "path";
import fs from "fs";
import require$$0$1 from "os";
function _mergeNamespaces(n, m) {
  for (var i = 0; i < m.length; i++) {
    const e = m[i];
    if (typeof e !== "string" && !Array.isArray(e)) {
      for (const k in e) {
        if (k !== "default" && !(k in n)) {
          const d = Object.getOwnPropertyDescriptor(e, k);
          if (d) {
            Object.defineProperty(n, k, d.get ? d : {
              enumerable: true,
              get: function() {
                return e[k];
              }
            });
          }
        }
      }
    }
  }
  return Object.freeze(n);
}
var getContext_1;
var hasRequiredGetContext;
function requireGetContext() {
  if (hasRequiredGetContext) return getContext_1;
  hasRequiredGetContext = 1;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var get_context_exports = {};
  __export(get_context_exports, {
    SYMBOL_FOR_REQ_CONTEXT: () => SYMBOL_FOR_REQ_CONTEXT,
    getContext: () => getContext
  });
  getContext_1 = __toCommonJS(get_context_exports);
  const SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");
  function getContext() {
    const fromSymbol = globalThis;
    return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
  }
  return getContext_1;
}
var tokenError;
var hasRequiredTokenError;
function requireTokenError() {
  if (hasRequiredTokenError) return tokenError;
  hasRequiredTokenError = 1;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var token_error_exports = {};
  __export(token_error_exports, {
    VercelOidcTokenError: () => VercelOidcTokenError
  });
  tokenError = __toCommonJS(token_error_exports);
  class VercelOidcTokenError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = "VercelOidcTokenError";
      this.cause = cause;
    }
    toString() {
      if (this.cause) {
        return `${this.name}: ${this.message}: ${this.cause}`;
      }
      return `${this.name}: ${this.message}`;
    }
  }
  return tokenError;
}
var getVercelOidcToken_1;
var hasRequiredGetVercelOidcToken;
function requireGetVercelOidcToken() {
  if (hasRequiredGetVercelOidcToken) return getVercelOidcToken_1;
  hasRequiredGetVercelOidcToken = 1;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var get_vercel_oidc_token_exports = {};
  __export(get_vercel_oidc_token_exports, {
    getVercelOidcToken: () => getVercelOidcToken,
    getVercelOidcTokenSync: () => getVercelOidcTokenSync
  });
  getVercelOidcToken_1 = __toCommonJS(get_vercel_oidc_token_exports);
  var import_get_context = /* @__PURE__ */ requireGetContext();
  var import_token_error = /* @__PURE__ */ requireTokenError();
  async function getVercelOidcToken() {
    let token2 = "";
    let err;
    try {
      token2 = getVercelOidcTokenSync();
    } catch (error) {
      err = error;
    }
    try {
      const [{ getTokenPayload, isExpired }, { refreshToken }] = await Promise.all([
        await Promise.resolve().then(function() {
          return tokenUtil$1;
        }),
        await Promise.resolve().then(function() {
          return token$1;
        })
      ]);
      if (!token2 || isExpired(getTokenPayload(token2))) {
        await refreshToken();
        token2 = getVercelOidcTokenSync();
      }
    } catch (error) {
      if (err?.message && error instanceof Error) {
        error.message = `${err.message}
${error.message}`;
      }
      throw new import_token_error.VercelOidcTokenError(`Failed to refresh OIDC token`, error);
    }
    return token2;
  }
  function getVercelOidcTokenSync() {
    const token2 = (0, import_get_context.getContext)().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
    if (!token2) {
      throw new Error(
        `The 'x-vercel-oidc-token' header is missing from the request. Do you have the OIDC option enabled in the Vercel project settings?`
      );
    }
    return token2;
  }
  return getVercelOidcToken_1;
}
var dist;
var hasRequiredDist;
function requireDist() {
  if (hasRequiredDist) return dist;
  hasRequiredDist = 1;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var src_exports = {};
  __export(src_exports, {
    getContext: () => import_get_context.getContext,
    getVercelOidcToken: () => import_get_vercel_oidc_token.getVercelOidcToken,
    getVercelOidcTokenSync: () => import_get_vercel_oidc_token.getVercelOidcTokenSync
  });
  dist = __toCommonJS(src_exports);
  var import_get_vercel_oidc_token = /* @__PURE__ */ requireGetVercelOidcToken();
  var import_get_context = /* @__PURE__ */ requireGetContext();
  return dist;
}
var distExports = /* @__PURE__ */ requireDist();
var tokenIo;
var hasRequiredTokenIo;
function requireTokenIo() {
  if (hasRequiredTokenIo) return tokenIo;
  hasRequiredTokenIo = 1;
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var token_io_exports = {};
  __export(token_io_exports, {
    findRootDir: () => findRootDir,
    getUserDataDir: () => getUserDataDir
  });
  tokenIo = __toCommonJS(token_io_exports);
  var import_path2 = __toESM(require$$0);
  var import_fs2 = __toESM(fs);
  var import_os2 = __toESM(require$$0$1);
  var import_token_error = /* @__PURE__ */ requireTokenError();
  function findRootDir() {
    try {
      let dir = process.cwd();
      while (dir !== import_path2.default.dirname(dir)) {
        const pkgPath = import_path2.default.join(dir, ".vercel");
        if (import_fs2.default.existsSync(pkgPath)) {
          return dir;
        }
        dir = import_path2.default.dirname(dir);
      }
    } catch (e) {
      throw new import_token_error.VercelOidcTokenError(
        "Token refresh only supported in node server environments"
      );
    }
    throw new import_token_error.VercelOidcTokenError("Unable to find root directory");
  }
  function getUserDataDir() {
    if (process.env.XDG_DATA_HOME) {
      return process.env.XDG_DATA_HOME;
    }
    switch (import_os2.default.platform()) {
      case "darwin":
        return import_path2.default.join(import_os2.default.homedir(), "Library/Application Support");
      case "linux":
        return import_path2.default.join(import_os2.default.homedir(), ".local/share");
      case "win32":
        if (process.env.LOCALAPPDATA) {
          return process.env.LOCALAPPDATA;
        }
        return null;
      default:
        return null;
    }
  }
  return tokenIo;
}
var tokenUtil$2;
var hasRequiredTokenUtil;
function requireTokenUtil() {
  if (hasRequiredTokenUtil) return tokenUtil$2;
  hasRequiredTokenUtil = 1;
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var token_util_exports = {};
  __export(token_util_exports, {
    assertVercelOidcTokenResponse: () => assertVercelOidcTokenResponse,
    findProjectInfo: () => findProjectInfo,
    getTokenPayload: () => getTokenPayload,
    getVercelCliToken: () => getVercelCliToken,
    getVercelDataDir: () => getVercelDataDir,
    getVercelOidcToken: () => getVercelOidcToken,
    isExpired: () => isExpired,
    loadToken: () => loadToken,
    saveToken: () => saveToken
  });
  tokenUtil$2 = __toCommonJS(token_util_exports);
  var path = __toESM(require$$0);
  var fs$1 = __toESM(fs);
  var import_token_error = /* @__PURE__ */ requireTokenError();
  var import_token_io = /* @__PURE__ */ requireTokenIo();
  function getVercelDataDir() {
    const vercelFolder = "com.vercel.cli";
    const dataDir = (0, import_token_io.getUserDataDir)();
    if (!dataDir) {
      return null;
    }
    return path.join(dataDir, vercelFolder);
  }
  function getVercelCliToken() {
    const dataDir = getVercelDataDir();
    if (!dataDir) {
      return null;
    }
    const tokenPath = path.join(dataDir, "auth.json");
    if (!fs$1.existsSync(tokenPath)) {
      return null;
    }
    const token2 = fs$1.readFileSync(tokenPath, "utf8");
    if (!token2) {
      return null;
    }
    return JSON.parse(token2).token;
  }
  async function getVercelOidcToken(authToken, projectId, teamId) {
    try {
      const url = `https://api.vercel.com/v1/projects/${projectId}/token?source=vercel-oidc-refresh${teamId ? `&teamId=${teamId}` : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!res.ok) {
        throw new import_token_error.VercelOidcTokenError(
          `Failed to refresh OIDC token: ${res.statusText}`
        );
      }
      const tokenRes = await res.json();
      assertVercelOidcTokenResponse(tokenRes);
      return tokenRes;
    } catch (e) {
      throw new import_token_error.VercelOidcTokenError(`Failed to refresh OIDC token`, e);
    }
  }
  function assertVercelOidcTokenResponse(res) {
    if (!res || typeof res !== "object") {
      throw new TypeError("Expected an object");
    }
    if (!("token" in res) || typeof res.token !== "string") {
      throw new TypeError("Expected a string-valued token property");
    }
  }
  function findProjectInfo() {
    const dir = (0, import_token_io.findRootDir)();
    if (!dir) {
      throw new import_token_error.VercelOidcTokenError("Unable to find root directory");
    }
    try {
      const prjPath = path.join(dir, ".vercel", "project.json");
      if (!fs$1.existsSync(prjPath)) {
        throw new import_token_error.VercelOidcTokenError("project.json not found");
      }
      const prj = JSON.parse(fs$1.readFileSync(prjPath, "utf8"));
      if (typeof prj.projectId !== "string" && typeof prj.orgId !== "string") {
        throw new TypeError("Expected a string-valued projectId property");
      }
      return { projectId: prj.projectId, teamId: prj.orgId };
    } catch (e) {
      throw new import_token_error.VercelOidcTokenError(`Unable to find project ID`, e);
    }
  }
  function saveToken(token2, projectId) {
    try {
      const dir = (0, import_token_io.getUserDataDir)();
      if (!dir) {
        throw new import_token_error.VercelOidcTokenError("Unable to find user data directory");
      }
      const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
      const tokenJson = JSON.stringify(token2);
      fs$1.mkdirSync(path.dirname(tokenPath), { mode: 504, recursive: true });
      fs$1.writeFileSync(tokenPath, tokenJson);
      fs$1.chmodSync(tokenPath, 432);
      return;
    } catch (e) {
      throw new import_token_error.VercelOidcTokenError(`Failed to save token`, e);
    }
  }
  function loadToken(projectId) {
    try {
      const dir = (0, import_token_io.getUserDataDir)();
      if (!dir) {
        return null;
      }
      const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
      if (!fs$1.existsSync(tokenPath)) {
        return null;
      }
      const token2 = JSON.parse(fs$1.readFileSync(tokenPath, "utf8"));
      assertVercelOidcTokenResponse(token2);
      return token2;
    } catch (e) {
      throw new import_token_error.VercelOidcTokenError(`Failed to load token`, e);
    }
  }
  function getTokenPayload(token2) {
    const tokenParts = token2.split(".");
    if (tokenParts.length !== 3) {
      throw new import_token_error.VercelOidcTokenError("Invalid token");
    }
    const base64 = tokenParts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + (4 - base64.length % 4) % 4,
      "="
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  }
  function isExpired(token2) {
    return token2.exp * 1e3 < Date.now();
  }
  return tokenUtil$2;
}
var tokenUtilExports = /* @__PURE__ */ requireTokenUtil();
const tokenUtil = /* @__PURE__ */ getDefaultExportFromCjs(tokenUtilExports);
const tokenUtil$1 = /* @__PURE__ */ _mergeNamespaces({
  __proto__: null,
  default: tokenUtil
}, [tokenUtilExports]);
var token$2;
var hasRequiredToken;
function requireToken() {
  if (hasRequiredToken) return token$2;
  hasRequiredToken = 1;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var token_exports = {};
  __export(token_exports, {
    refreshToken: () => refreshToken
  });
  token$2 = __toCommonJS(token_exports);
  var import_token_error = /* @__PURE__ */ requireTokenError();
  var import_token_util = /* @__PURE__ */ requireTokenUtil();
  async function refreshToken() {
    const { projectId, teamId } = (0, import_token_util.findProjectInfo)();
    let maybeToken = (0, import_token_util.loadToken)(projectId);
    if (!maybeToken || (0, import_token_util.isExpired)((0, import_token_util.getTokenPayload)(maybeToken.token))) {
      const authToken = (0, import_token_util.getVercelCliToken)();
      if (!authToken) {
        throw new import_token_error.VercelOidcTokenError(
          "Failed to refresh OIDC token: login to vercel cli"
        );
      }
      if (!projectId) {
        throw new import_token_error.VercelOidcTokenError(
          "Failed to refresh OIDC token: project id not found"
        );
      }
      maybeToken = await (0, import_token_util.getVercelOidcToken)(authToken, projectId, teamId);
      if (!maybeToken) {
        throw new import_token_error.VercelOidcTokenError("Failed to refresh OIDC token");
      }
      (0, import_token_util.saveToken)(maybeToken, projectId);
    }
    process.env.VERCEL_OIDC_TOKEN = maybeToken.token;
    return;
  }
  return token$2;
}
var tokenExports = /* @__PURE__ */ requireToken();
const token = /* @__PURE__ */ getDefaultExportFromCjs(tokenExports);
const token$1 = /* @__PURE__ */ _mergeNamespaces({
  __proto__: null,
  default: token
}, [tokenExports]);
export {
  distExports as d
};
