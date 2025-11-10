import { g as getDefaultExportFromCjs } from './_commonjsHelpers_BFTU3MAI.mjs';
import { at as requireTokenError } from './index_ePTMDSOu.mjs';
import { r as requireTokenUtil } from './token-util_8GTOk-OQ.mjs';

function _mergeNamespaces(n, m) {
  for (var i = 0; i < m.length; i++) {
    const e = m[i];
    if (typeof e !== 'string' && !Array.isArray(e)) { for (const k in e) {
      if (k !== 'default' && !(k in n)) {
        const d = Object.getOwnPropertyDescriptor(e, k);
        if (d) {
          Object.defineProperty(n, k, d.get ? d : {
            enumerable: true,
            get: () => e[k]
          });
        }
      }
    } }
  }
  return Object.freeze(Object.defineProperty(n, Symbol.toStringTag, { value: 'Module' }));
}

var token$2;
var hasRequiredToken;

function requireToken () {
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
	var import_token_error = requireTokenError();
	var import_token_util = requireTokenUtil();
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

var tokenExports = requireToken();
const token = /*@__PURE__*/getDefaultExportFromCjs(tokenExports);

const token$1 = /*#__PURE__*/_mergeNamespaces({
  __proto__: null,
  default: token
}, [tokenExports]);

export { token$1 as t };
