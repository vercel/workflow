import require$$0 from 'path';
import require$$0$1 from 'fs';
import { at as requireTokenError } from './index_ePTMDSOu.mjs';
import require$$2 from 'os';

var tokenIo;
var hasRequiredTokenIo;

function requireTokenIo () {
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
	var import_path = __toESM(require$$0);
	var import_fs = __toESM(require$$0$1);
	var import_os = __toESM(require$$2);
	var import_token_error = requireTokenError();
	function findRootDir() {
	  try {
	    let dir = process.cwd();
	    while (dir !== import_path.default.dirname(dir)) {
	      const pkgPath = import_path.default.join(dir, ".vercel");
	      if (import_fs.default.existsSync(pkgPath)) {
	        return dir;
	      }
	      dir = import_path.default.dirname(dir);
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
	  switch (import_os.default.platform()) {
	    case "darwin":
	      return import_path.default.join(import_os.default.homedir(), "Library/Application Support");
	    case "linux":
	      return import_path.default.join(import_os.default.homedir(), ".local/share");
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

var tokenUtil;
var hasRequiredTokenUtil;

function requireTokenUtil () {
	if (hasRequiredTokenUtil) return tokenUtil;
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
	tokenUtil = __toCommonJS(token_util_exports);
	var path = __toESM(require$$0);
	var fs = __toESM(require$$0$1);
	var import_token_error = requireTokenError();
	var import_token_io = requireTokenIo();
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
	  if (!fs.existsSync(tokenPath)) {
	    return null;
	  }
	  const token = fs.readFileSync(tokenPath, "utf8");
	  if (!token) {
	    return null;
	  }
	  return JSON.parse(token).token;
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
	    if (!fs.existsSync(prjPath)) {
	      throw new import_token_error.VercelOidcTokenError("project.json not found");
	    }
	    const prj = JSON.parse(fs.readFileSync(prjPath, "utf8"));
	    if (typeof prj.projectId !== "string" && typeof prj.orgId !== "string") {
	      throw new TypeError("Expected a string-valued projectId property");
	    }
	    return { projectId: prj.projectId, teamId: prj.orgId };
	  } catch (e) {
	    throw new import_token_error.VercelOidcTokenError(`Unable to find project ID`, e);
	  }
	}
	function saveToken(token, projectId) {
	  try {
	    const dir = (0, import_token_io.getUserDataDir)();
	    if (!dir) {
	      throw new import_token_error.VercelOidcTokenError("Unable to find user data directory");
	    }
	    const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
	    const tokenJson = JSON.stringify(token);
	    fs.mkdirSync(path.dirname(tokenPath), { mode: 432, recursive: true });
	    fs.writeFileSync(tokenPath, tokenJson);
	    fs.chmodSync(tokenPath, 432);
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
	    if (!fs.existsSync(tokenPath)) {
	      return null;
	    }
	    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
	    assertVercelOidcTokenResponse(token);
	    return token;
	  } catch (e) {
	    throw new import_token_error.VercelOidcTokenError(`Failed to load token`, e);
	  }
	}
	function getTokenPayload(token) {
	  const tokenParts = token.split(".");
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
	const TIME_15_MINUTES_IN_MS = 15 * 60 * 1e3;
	function isExpired(token) {
	  return token.exp * 1e3 < Date.now() + TIME_15_MINUTES_IN_MS;
	}
	return tokenUtil;
}

export { requireTokenUtil as r };
