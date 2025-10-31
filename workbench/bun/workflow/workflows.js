// biome-ignore-all lint: generated file
/* eslint-disable */
import { workflowEntrypoint } from 'workflow/runtime';

const workflowCode = `var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name17 in all)
    __defProp(target, name17, { get: all[name17], enumerable: true });
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
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/@vercel+oidc@3.0.3/node_modules/@vercel/oidc/dist/get-context.js
var require_get_context = __commonJS({
  "../../node_modules/.pnpm/@vercel+oidc@3.0.3/node_modules/@vercel/oidc/dist/get-context.js"(exports, module2) {
    "use strict";
    var __defProp3 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export3 = /* @__PURE__ */ __name((target, all) => {
      for (var name17 in all) __defProp3(target, name17, {
        get: all[name17],
        enumerable: true
      });
    }, "__export");
    var __copyProps2 = /* @__PURE__ */ __name((to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from)) if (!__hasOwnProp2.call(to, key) && key !== except) __defProp3(to, key, {
          get: /* @__PURE__ */ __name(() => from[key], "get"),
          enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable
        });
      }
      return to;
    }, "__copyProps");
    var __toCommonJS = /* @__PURE__ */ __name((mod) => __copyProps2(__defProp3({}, "__esModule", {
      value: true
    }), mod), "__toCommonJS");
    var get_context_exports = {};
    __export3(get_context_exports, {
      SYMBOL_FOR_REQ_CONTEXT: /* @__PURE__ */ __name(() => SYMBOL_FOR_REQ_CONTEXT, "SYMBOL_FOR_REQ_CONTEXT"),
      getContext: /* @__PURE__ */ __name(() => getContext3, "getContext")
    });
    module2.exports = __toCommonJS(get_context_exports);
    var SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");
    function getContext3() {
      const fromSymbol = globalThis;
      return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
    }
    __name(getContext3, "getContext");
  }
});

// ../../node_modules/.pnpm/@vercel+oidc@3.0.3/node_modules/@vercel/oidc/dist/index-browser.js
var require_index_browser = __commonJS({
  "../../node_modules/.pnpm/@vercel+oidc@3.0.3/node_modules/@vercel/oidc/dist/index-browser.js"(exports, module2) {
    "use strict";
    var __defProp3 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export3 = /* @__PURE__ */ __name((target, all) => {
      for (var name17 in all) __defProp3(target, name17, {
        get: all[name17],
        enumerable: true
      });
    }, "__export");
    var __copyProps2 = /* @__PURE__ */ __name((to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from)) if (!__hasOwnProp2.call(to, key) && key !== except) __defProp3(to, key, {
          get: /* @__PURE__ */ __name(() => from[key], "get"),
          enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable
        });
      }
      return to;
    }, "__copyProps");
    var __toCommonJS = /* @__PURE__ */ __name((mod) => __copyProps2(__defProp3({}, "__esModule", {
      value: true
    }), mod), "__toCommonJS");
    var index_browser_exports = {};
    __export3(index_browser_exports, {
      getContext: /* @__PURE__ */ __name(() => import_get_context.getContext, "getContext"),
      getVercelOidcToken: /* @__PURE__ */ __name(() => getVercelOidcToken2, "getVercelOidcToken"),
      getVercelOidcTokenSync: /* @__PURE__ */ __name(() => getVercelOidcTokenSync, "getVercelOidcTokenSync")
    });
    module2.exports = __toCommonJS(index_browser_exports);
    var import_get_context = require_get_context();
    async function getVercelOidcToken2() {
      return "";
    }
    __name(getVercelOidcToken2, "getVercelOidcToken");
    function getVercelOidcTokenSync() {
      return "";
    }
    __name(getVercelOidcTokenSync, "getVercelOidcTokenSync");
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/platform/node/globalThis.js
var require_globalThis = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/platform/node/globalThis.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports._globalThis = void 0;
    exports._globalThis = typeof globalThis === "object" ? globalThis : global;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/platform/node/index.js
var require_node = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/platform/node/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      Object.defineProperty(o, k2, {
        enumerable: true,
        get: /* @__PURE__ */ __name(function() {
          return m[k];
        }, "get")
      });
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = exports && exports.__exportStar || function(m, exports1) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports1, p)) __createBinding(exports1, m, p);
    };
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    __exportStar(require_globalThis(), exports);
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/platform/index.js
var require_platform = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/platform/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      Object.defineProperty(o, k2, {
        enumerable: true,
        get: /* @__PURE__ */ __name(function() {
          return m[k];
        }, "get")
      });
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = exports && exports.__exportStar || function(m, exports1) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports1, p)) __createBinding(exports1, m, p);
    };
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    __exportStar(require_node(), exports);
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/version.js
var require_version = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/version.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.VERSION = void 0;
    exports.VERSION = "1.9.0";
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/internal/semver.js
var require_semver = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/internal/semver.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.isCompatible = exports._makeCompatibilityCheck = void 0;
    var version_1 = require_version();
    var re = /^(\\d+)\\.(\\d+)\\.(\\d+)(-(.+))?\$/;
    function _makeCompatibilityCheck(ownVersion) {
      const acceptedVersions = /* @__PURE__ */ new Set([
        ownVersion
      ]);
      const rejectedVersions = /* @__PURE__ */ new Set();
      const myVersionMatch = ownVersion.match(re);
      if (!myVersionMatch) {
        return () => false;
      }
      const ownVersionParsed = {
        major: +myVersionMatch[1],
        minor: +myVersionMatch[2],
        patch: +myVersionMatch[3],
        prerelease: myVersionMatch[4]
      };
      if (ownVersionParsed.prerelease != null) {
        return /* @__PURE__ */ __name(function isExactmatch(globalVersion) {
          return globalVersion === ownVersion;
        }, "isExactmatch");
      }
      function _reject(v) {
        rejectedVersions.add(v);
        return false;
      }
      __name(_reject, "_reject");
      function _accept(v) {
        acceptedVersions.add(v);
        return true;
      }
      __name(_accept, "_accept");
      return /* @__PURE__ */ __name(function isCompatible(globalVersion) {
        if (acceptedVersions.has(globalVersion)) {
          return true;
        }
        if (rejectedVersions.has(globalVersion)) {
          return false;
        }
        const globalVersionMatch = globalVersion.match(re);
        if (!globalVersionMatch) {
          return _reject(globalVersion);
        }
        const globalVersionParsed = {
          major: +globalVersionMatch[1],
          minor: +globalVersionMatch[2],
          patch: +globalVersionMatch[3],
          prerelease: globalVersionMatch[4]
        };
        if (globalVersionParsed.prerelease != null) {
          return _reject(globalVersion);
        }
        if (ownVersionParsed.major !== globalVersionParsed.major) {
          return _reject(globalVersion);
        }
        if (ownVersionParsed.major === 0) {
          if (ownVersionParsed.minor === globalVersionParsed.minor && ownVersionParsed.patch <= globalVersionParsed.patch) {
            return _accept(globalVersion);
          }
          return _reject(globalVersion);
        }
        if (ownVersionParsed.minor <= globalVersionParsed.minor) {
          return _accept(globalVersion);
        }
        return _reject(globalVersion);
      }, "isCompatible");
    }
    __name(_makeCompatibilityCheck, "_makeCompatibilityCheck");
    exports._makeCompatibilityCheck = _makeCompatibilityCheck;
    exports.isCompatible = _makeCompatibilityCheck(version_1.VERSION);
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/internal/global-utils.js
var require_global_utils = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/internal/global-utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.unregisterGlobal = exports.getGlobal = exports.registerGlobal = void 0;
    var platform_1 = require_platform();
    var version_1 = require_version();
    var semver_1 = require_semver();
    var major = version_1.VERSION.split(".")[0];
    var GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for(\`opentelemetry.js.api.\${major}\`);
    var _global = platform_1._globalThis;
    function registerGlobal(type, instance, diag, allowOverride = false) {
      var _a17;
      const api = _global[GLOBAL_OPENTELEMETRY_API_KEY] = (_a17 = _global[GLOBAL_OPENTELEMETRY_API_KEY]) !== null && _a17 !== void 0 ? _a17 : {
        version: version_1.VERSION
      };
      if (!allowOverride && api[type]) {
        const err = new Error(\`@opentelemetry/api: Attempted duplicate registration of API: \${type}\`);
        diag.error(err.stack || err.message);
        return false;
      }
      if (api.version !== version_1.VERSION) {
        const err = new Error(\`@opentelemetry/api: Registration of version v\${api.version} for \${type} does not match previously registered API v\${version_1.VERSION}\`);
        diag.error(err.stack || err.message);
        return false;
      }
      api[type] = instance;
      diag.debug(\`@opentelemetry/api: Registered a global for \${type} v\${version_1.VERSION}.\`);
      return true;
    }
    __name(registerGlobal, "registerGlobal");
    exports.registerGlobal = registerGlobal;
    function getGlobal(type) {
      var _a17, _b8;
      const globalVersion = (_a17 = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _a17 === void 0 ? void 0 : _a17.version;
      if (!globalVersion || !(0, semver_1.isCompatible)(globalVersion)) {
        return;
      }
      return (_b8 = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _b8 === void 0 ? void 0 : _b8[type];
    }
    __name(getGlobal, "getGlobal");
    exports.getGlobal = getGlobal;
    function unregisterGlobal(type, diag) {
      diag.debug(\`@opentelemetry/api: Unregistering a global for \${type} v\${version_1.VERSION}.\`);
      const api = _global[GLOBAL_OPENTELEMETRY_API_KEY];
      if (api) {
        delete api[type];
      }
    }
    __name(unregisterGlobal, "unregisterGlobal");
    exports.unregisterGlobal = unregisterGlobal;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/ComponentLogger.js
var require_ComponentLogger = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/ComponentLogger.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.DiagComponentLogger = void 0;
    var global_utils_1 = require_global_utils();
    var DiagComponentLogger = class {
      static {
        __name(this, "DiagComponentLogger");
      }
      constructor(props) {
        this._namespace = props.namespace || "DiagComponentLogger";
      }
      debug(...args) {
        return logProxy("debug", this._namespace, args);
      }
      error(...args) {
        return logProxy("error", this._namespace, args);
      }
      info(...args) {
        return logProxy("info", this._namespace, args);
      }
      warn(...args) {
        return logProxy("warn", this._namespace, args);
      }
      verbose(...args) {
        return logProxy("verbose", this._namespace, args);
      }
    };
    exports.DiagComponentLogger = DiagComponentLogger;
    function logProxy(funcName, namespace, args) {
      const logger = (0, global_utils_1.getGlobal)("diag");
      if (!logger) {
        return;
      }
      args.unshift(namespace);
      return logger[funcName](...args);
    }
    __name(logProxy, "logProxy");
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/types.js
var require_types = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.DiagLogLevel = void 0;
    var DiagLogLevel;
    (function(DiagLogLevel2) {
      DiagLogLevel2[DiagLogLevel2["NONE"] = 0] = "NONE";
      DiagLogLevel2[DiagLogLevel2["ERROR"] = 30] = "ERROR";
      DiagLogLevel2[DiagLogLevel2["WARN"] = 50] = "WARN";
      DiagLogLevel2[DiagLogLevel2["INFO"] = 60] = "INFO";
      DiagLogLevel2[DiagLogLevel2["DEBUG"] = 70] = "DEBUG";
      DiagLogLevel2[DiagLogLevel2["VERBOSE"] = 80] = "VERBOSE";
      DiagLogLevel2[DiagLogLevel2["ALL"] = 9999] = "ALL";
    })(DiagLogLevel = exports.DiagLogLevel || (exports.DiagLogLevel = {}));
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/internal/logLevelLogger.js
var require_logLevelLogger = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/internal/logLevelLogger.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.createLogLevelDiagLogger = void 0;
    var types_1 = require_types();
    function createLogLevelDiagLogger(maxLevel, logger) {
      if (maxLevel < types_1.DiagLogLevel.NONE) {
        maxLevel = types_1.DiagLogLevel.NONE;
      } else if (maxLevel > types_1.DiagLogLevel.ALL) {
        maxLevel = types_1.DiagLogLevel.ALL;
      }
      logger = logger || {};
      function _filterFunc(funcName, theLevel) {
        const theFunc = logger[funcName];
        if (typeof theFunc === "function" && maxLevel >= theLevel) {
          return theFunc.bind(logger);
        }
        return function() {
        };
      }
      __name(_filterFunc, "_filterFunc");
      return {
        error: _filterFunc("error", types_1.DiagLogLevel.ERROR),
        warn: _filterFunc("warn", types_1.DiagLogLevel.WARN),
        info: _filterFunc("info", types_1.DiagLogLevel.INFO),
        debug: _filterFunc("debug", types_1.DiagLogLevel.DEBUG),
        verbose: _filterFunc("verbose", types_1.DiagLogLevel.VERBOSE)
      };
    }
    __name(createLogLevelDiagLogger, "createLogLevelDiagLogger");
    exports.createLogLevelDiagLogger = createLogLevelDiagLogger;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/diag.js
var require_diag = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/diag.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.DiagAPI = void 0;
    var ComponentLogger_1 = require_ComponentLogger();
    var logLevelLogger_1 = require_logLevelLogger();
    var types_1 = require_types();
    var global_utils_1 = require_global_utils();
    var API_NAME = "diag";
    var DiagAPI = class _DiagAPI {
      static {
        __name(this, "DiagAPI");
      }
      /**
       * Private internal constructor
       * @private
       */
      constructor() {
        function _logProxy(funcName) {
          return function(...args) {
            const logger = (0, global_utils_1.getGlobal)("diag");
            if (!logger) return;
            return logger[funcName](...args);
          };
        }
        __name(_logProxy, "_logProxy");
        const self = this;
        const setLogger = /* @__PURE__ */ __name((logger, optionsOrLogLevel = {
          logLevel: types_1.DiagLogLevel.INFO
        }) => {
          var _a17, _b8, _c;
          if (logger === self) {
            const err = new Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
            self.error((_a17 = err.stack) !== null && _a17 !== void 0 ? _a17 : err.message);
            return false;
          }
          if (typeof optionsOrLogLevel === "number") {
            optionsOrLogLevel = {
              logLevel: optionsOrLogLevel
            };
          }
          const oldLogger = (0, global_utils_1.getGlobal)("diag");
          const newLogger = (0, logLevelLogger_1.createLogLevelDiagLogger)((_b8 = optionsOrLogLevel.logLevel) !== null && _b8 !== void 0 ? _b8 : types_1.DiagLogLevel.INFO, logger);
          if (oldLogger && !optionsOrLogLevel.suppressOverrideMessage) {
            const stack = (_c = new Error().stack) !== null && _c !== void 0 ? _c : "<failed to generate stacktrace>";
            oldLogger.warn(\`Current logger will be overwritten from \${stack}\`);
            newLogger.warn(\`Current logger will overwrite one already registered from \${stack}\`);
          }
          return (0, global_utils_1.registerGlobal)("diag", newLogger, self, true);
        }, "setLogger");
        self.setLogger = setLogger;
        self.disable = () => {
          (0, global_utils_1.unregisterGlobal)(API_NAME, self);
        };
        self.createComponentLogger = (options) => {
          return new ComponentLogger_1.DiagComponentLogger(options);
        };
        self.verbose = _logProxy("verbose");
        self.debug = _logProxy("debug");
        self.info = _logProxy("info");
        self.warn = _logProxy("warn");
        self.error = _logProxy("error");
      }
      /** Get the singleton instance of the DiagAPI API */
      static instance() {
        if (!this._instance) {
          this._instance = new _DiagAPI();
        }
        return this._instance;
      }
    };
    exports.DiagAPI = DiagAPI;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/internal/baggage-impl.js
var require_baggage_impl = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/internal/baggage-impl.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.BaggageImpl = void 0;
    var BaggageImpl = class _BaggageImpl {
      static {
        __name(this, "BaggageImpl");
      }
      constructor(entries) {
        this._entries = entries ? new Map(entries) : /* @__PURE__ */ new Map();
      }
      getEntry(key) {
        const entry = this._entries.get(key);
        if (!entry) {
          return void 0;
        }
        return Object.assign({}, entry);
      }
      getAllEntries() {
        return Array.from(this._entries.entries()).map(([k, v]) => [
          k,
          v
        ]);
      }
      setEntry(key, entry) {
        const newBaggage = new _BaggageImpl(this._entries);
        newBaggage._entries.set(key, entry);
        return newBaggage;
      }
      removeEntry(key) {
        const newBaggage = new _BaggageImpl(this._entries);
        newBaggage._entries.delete(key);
        return newBaggage;
      }
      removeEntries(...keys) {
        const newBaggage = new _BaggageImpl(this._entries);
        for (const key of keys) {
          newBaggage._entries.delete(key);
        }
        return newBaggage;
      }
      clear() {
        return new _BaggageImpl();
      }
    };
    exports.BaggageImpl = BaggageImpl;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/internal/symbol.js
var require_symbol = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/internal/symbol.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.baggageEntryMetadataSymbol = void 0;
    exports.baggageEntryMetadataSymbol = Symbol("BaggageEntryMetadata");
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/utils.js
var require_utils = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.baggageEntryMetadataFromString = exports.createBaggage = void 0;
    var diag_1 = require_diag();
    var baggage_impl_1 = require_baggage_impl();
    var symbol_1 = require_symbol();
    var diag = diag_1.DiagAPI.instance();
    function createBaggage(entries = {}) {
      return new baggage_impl_1.BaggageImpl(new Map(Object.entries(entries)));
    }
    __name(createBaggage, "createBaggage");
    exports.createBaggage = createBaggage;
    function baggageEntryMetadataFromString(str) {
      if (typeof str !== "string") {
        diag.error(\`Cannot create baggage metadata from unknown type: \${typeof str}\`);
        str = "";
      }
      return {
        __TYPE__: symbol_1.baggageEntryMetadataSymbol,
        toString() {
          return str;
        }
      };
    }
    __name(baggageEntryMetadataFromString, "baggageEntryMetadataFromString");
    exports.baggageEntryMetadataFromString = baggageEntryMetadataFromString;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/context/context.js
var require_context = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/context/context.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.ROOT_CONTEXT = exports.createContextKey = void 0;
    function createContextKey(description) {
      return Symbol.for(description);
    }
    __name(createContextKey, "createContextKey");
    exports.createContextKey = createContextKey;
    var BaseContext = class _BaseContext {
      static {
        __name(this, "BaseContext");
      }
      /**
       * Construct a new context which inherits values from an optional parent context.
       *
       * @param parentContext a context from which to inherit values
       */
      constructor(parentContext) {
        const self = this;
        self._currentContext = parentContext ? new Map(parentContext) : /* @__PURE__ */ new Map();
        self.getValue = (key) => self._currentContext.get(key);
        self.setValue = (key, value) => {
          const context = new _BaseContext(self._currentContext);
          context._currentContext.set(key, value);
          return context;
        };
        self.deleteValue = (key) => {
          const context = new _BaseContext(self._currentContext);
          context._currentContext.delete(key);
          return context;
        };
      }
    };
    exports.ROOT_CONTEXT = new BaseContext();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/consoleLogger.js
var require_consoleLogger = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag/consoleLogger.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.DiagConsoleLogger = void 0;
    var consoleMap = [
      {
        n: "error",
        c: "error"
      },
      {
        n: "warn",
        c: "warn"
      },
      {
        n: "info",
        c: "info"
      },
      {
        n: "debug",
        c: "debug"
      },
      {
        n: "verbose",
        c: "trace"
      }
    ];
    var DiagConsoleLogger = class {
      static {
        __name(this, "DiagConsoleLogger");
      }
      constructor() {
        function _consoleFunc(funcName) {
          return function(...args) {
            if (console) {
              let theFunc = console[funcName];
              if (typeof theFunc !== "function") {
                theFunc = console.log;
              }
              if (typeof theFunc === "function") {
                return theFunc.apply(console, args);
              }
            }
          };
        }
        __name(_consoleFunc, "_consoleFunc");
        for (let i = 0; i < consoleMap.length; i++) {
          this[consoleMap[i].n] = _consoleFunc(consoleMap[i].c);
        }
      }
    };
    exports.DiagConsoleLogger = DiagConsoleLogger;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics/NoopMeter.js
var require_NoopMeter = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics/NoopMeter.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.createNoopMeter = exports.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = exports.NOOP_OBSERVABLE_GAUGE_METRIC = exports.NOOP_OBSERVABLE_COUNTER_METRIC = exports.NOOP_UP_DOWN_COUNTER_METRIC = exports.NOOP_HISTOGRAM_METRIC = exports.NOOP_GAUGE_METRIC = exports.NOOP_COUNTER_METRIC = exports.NOOP_METER = exports.NoopObservableUpDownCounterMetric = exports.NoopObservableGaugeMetric = exports.NoopObservableCounterMetric = exports.NoopObservableMetric = exports.NoopHistogramMetric = exports.NoopGaugeMetric = exports.NoopUpDownCounterMetric = exports.NoopCounterMetric = exports.NoopMetric = exports.NoopMeter = void 0;
    var NoopMeter = class {
      static {
        __name(this, "NoopMeter");
      }
      constructor() {
      }
      /**
       * @see {@link Meter.createGauge}
       */
      createGauge(_name, _options) {
        return exports.NOOP_GAUGE_METRIC;
      }
      /**
       * @see {@link Meter.createHistogram}
       */
      createHistogram(_name, _options) {
        return exports.NOOP_HISTOGRAM_METRIC;
      }
      /**
       * @see {@link Meter.createCounter}
       */
      createCounter(_name, _options) {
        return exports.NOOP_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.createUpDownCounter}
       */
      createUpDownCounter(_name, _options) {
        return exports.NOOP_UP_DOWN_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.createObservableGauge}
       */
      createObservableGauge(_name, _options) {
        return exports.NOOP_OBSERVABLE_GAUGE_METRIC;
      }
      /**
       * @see {@link Meter.createObservableCounter}
       */
      createObservableCounter(_name, _options) {
        return exports.NOOP_OBSERVABLE_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.createObservableUpDownCounter}
       */
      createObservableUpDownCounter(_name, _options) {
        return exports.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.addBatchObservableCallback}
       */
      addBatchObservableCallback(_callback, _observables) {
      }
      /**
       * @see {@link Meter.removeBatchObservableCallback}
       */
      removeBatchObservableCallback(_callback) {
      }
    };
    exports.NoopMeter = NoopMeter;
    var NoopMetric = class {
      static {
        __name(this, "NoopMetric");
      }
    };
    exports.NoopMetric = NoopMetric;
    var NoopCounterMetric = class extends NoopMetric {
      static {
        __name(this, "NoopCounterMetric");
      }
      add(_value, _attributes) {
      }
    };
    exports.NoopCounterMetric = NoopCounterMetric;
    var NoopUpDownCounterMetric = class extends NoopMetric {
      static {
        __name(this, "NoopUpDownCounterMetric");
      }
      add(_value, _attributes) {
      }
    };
    exports.NoopUpDownCounterMetric = NoopUpDownCounterMetric;
    var NoopGaugeMetric = class extends NoopMetric {
      static {
        __name(this, "NoopGaugeMetric");
      }
      record(_value, _attributes) {
      }
    };
    exports.NoopGaugeMetric = NoopGaugeMetric;
    var NoopHistogramMetric = class extends NoopMetric {
      static {
        __name(this, "NoopHistogramMetric");
      }
      record(_value, _attributes) {
      }
    };
    exports.NoopHistogramMetric = NoopHistogramMetric;
    var NoopObservableMetric = class {
      static {
        __name(this, "NoopObservableMetric");
      }
      addCallback(_callback) {
      }
      removeCallback(_callback) {
      }
    };
    exports.NoopObservableMetric = NoopObservableMetric;
    var NoopObservableCounterMetric = class extends NoopObservableMetric {
      static {
        __name(this, "NoopObservableCounterMetric");
      }
    };
    exports.NoopObservableCounterMetric = NoopObservableCounterMetric;
    var NoopObservableGaugeMetric = class extends NoopObservableMetric {
      static {
        __name(this, "NoopObservableGaugeMetric");
      }
    };
    exports.NoopObservableGaugeMetric = NoopObservableGaugeMetric;
    var NoopObservableUpDownCounterMetric = class extends NoopObservableMetric {
      static {
        __name(this, "NoopObservableUpDownCounterMetric");
      }
    };
    exports.NoopObservableUpDownCounterMetric = NoopObservableUpDownCounterMetric;
    exports.NOOP_METER = new NoopMeter();
    exports.NOOP_COUNTER_METRIC = new NoopCounterMetric();
    exports.NOOP_GAUGE_METRIC = new NoopGaugeMetric();
    exports.NOOP_HISTOGRAM_METRIC = new NoopHistogramMetric();
    exports.NOOP_UP_DOWN_COUNTER_METRIC = new NoopUpDownCounterMetric();
    exports.NOOP_OBSERVABLE_COUNTER_METRIC = new NoopObservableCounterMetric();
    exports.NOOP_OBSERVABLE_GAUGE_METRIC = new NoopObservableGaugeMetric();
    exports.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = new NoopObservableUpDownCounterMetric();
    function createNoopMeter() {
      return exports.NOOP_METER;
    }
    __name(createNoopMeter, "createNoopMeter");
    exports.createNoopMeter = createNoopMeter;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics/Metric.js
var require_Metric = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics/Metric.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.ValueType = void 0;
    var ValueType;
    (function(ValueType2) {
      ValueType2[ValueType2["INT"] = 0] = "INT";
      ValueType2[ValueType2["DOUBLE"] = 1] = "DOUBLE";
    })(ValueType = exports.ValueType || (exports.ValueType = {}));
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/propagation/TextMapPropagator.js
var require_TextMapPropagator = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/propagation/TextMapPropagator.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.defaultTextMapSetter = exports.defaultTextMapGetter = void 0;
    exports.defaultTextMapGetter = {
      get(carrier, key) {
        if (carrier == null) {
          return void 0;
        }
        return carrier[key];
      },
      keys(carrier) {
        if (carrier == null) {
          return [];
        }
        return Object.keys(carrier);
      }
    };
    exports.defaultTextMapSetter = {
      set(carrier, key, value) {
        if (carrier == null) {
          return;
        }
        carrier[key] = value;
      }
    };
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/context/NoopContextManager.js
var require_NoopContextManager = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/context/NoopContextManager.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.NoopContextManager = void 0;
    var context_1 = require_context();
    var NoopContextManager = class {
      static {
        __name(this, "NoopContextManager");
      }
      active() {
        return context_1.ROOT_CONTEXT;
      }
      with(_context, fn, thisArg, ...args) {
        return fn.call(thisArg, ...args);
      }
      bind(_context, target) {
        return target;
      }
      enable() {
        return this;
      }
      disable() {
        return this;
      }
    };
    exports.NoopContextManager = NoopContextManager;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/context.js
var require_context2 = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/context.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.ContextAPI = void 0;
    var NoopContextManager_1 = require_NoopContextManager();
    var global_utils_1 = require_global_utils();
    var diag_1 = require_diag();
    var API_NAME = "context";
    var NOOP_CONTEXT_MANAGER = new NoopContextManager_1.NoopContextManager();
    var ContextAPI = class _ContextAPI {
      static {
        __name(this, "ContextAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
      }
      /** Get the singleton instance of the Context API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _ContextAPI();
        }
        return this._instance;
      }
      /**
       * Set the current context manager.
       *
       * @returns true if the context manager was successfully registered, else false
       */
      setGlobalContextManager(contextManager) {
        return (0, global_utils_1.registerGlobal)(API_NAME, contextManager, diag_1.DiagAPI.instance());
      }
      /**
       * Get the currently active context
       */
      active() {
        return this._getContextManager().active();
      }
      /**
       * Execute a function with an active context
       *
       * @param context context to be active during function execution
       * @param fn function to execute in a context
       * @param thisArg optional receiver to be used for calling fn
       * @param args optional arguments forwarded to fn
       */
      with(context, fn, thisArg, ...args) {
        return this._getContextManager().with(context, fn, thisArg, ...args);
      }
      /**
       * Bind a context to a target function or event emitter
       *
       * @param context context to bind to the event emitter or function. Defaults to the currently active context
       * @param target function or event emitter to bind
       */
      bind(context, target) {
        return this._getContextManager().bind(context, target);
      }
      _getContextManager() {
        return (0, global_utils_1.getGlobal)(API_NAME) || NOOP_CONTEXT_MANAGER;
      }
      /** Disable and remove the global context manager */
      disable() {
        this._getContextManager().disable();
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
      }
    };
    exports.ContextAPI = ContextAPI;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/trace_flags.js
var require_trace_flags = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/trace_flags.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.TraceFlags = void 0;
    var TraceFlags;
    (function(TraceFlags2) {
      TraceFlags2[TraceFlags2["NONE"] = 0] = "NONE";
      TraceFlags2[TraceFlags2["SAMPLED"] = 1] = "SAMPLED";
    })(TraceFlags = exports.TraceFlags || (exports.TraceFlags = {}));
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/invalid-span-constants.js
var require_invalid_span_constants = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/invalid-span-constants.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.INVALID_SPAN_CONTEXT = exports.INVALID_TRACEID = exports.INVALID_SPANID = void 0;
    var trace_flags_1 = require_trace_flags();
    exports.INVALID_SPANID = "0000000000000000";
    exports.INVALID_TRACEID = "00000000000000000000000000000000";
    exports.INVALID_SPAN_CONTEXT = {
      traceId: exports.INVALID_TRACEID,
      spanId: exports.INVALID_SPANID,
      traceFlags: trace_flags_1.TraceFlags.NONE
    };
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/NonRecordingSpan.js
var require_NonRecordingSpan = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/NonRecordingSpan.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.NonRecordingSpan = void 0;
    var invalid_span_constants_1 = require_invalid_span_constants();
    var NonRecordingSpan = class {
      static {
        __name(this, "NonRecordingSpan");
      }
      constructor(_spanContext = invalid_span_constants_1.INVALID_SPAN_CONTEXT) {
        this._spanContext = _spanContext;
      }
      // Returns a SpanContext.
      spanContext() {
        return this._spanContext;
      }
      // By default does nothing
      setAttribute(_key, _value) {
        return this;
      }
      // By default does nothing
      setAttributes(_attributes) {
        return this;
      }
      // By default does nothing
      addEvent(_name, _attributes) {
        return this;
      }
      addLink(_link) {
        return this;
      }
      addLinks(_links) {
        return this;
      }
      // By default does nothing
      setStatus(_status) {
        return this;
      }
      // By default does nothing
      updateName(_name) {
        return this;
      }
      // By default does nothing
      end(_endTime) {
      }
      // isRecording always returns false for NonRecordingSpan.
      isRecording() {
        return false;
      }
      // By default does nothing
      recordException(_exception, _time) {
      }
    };
    exports.NonRecordingSpan = NonRecordingSpan;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/context-utils.js
var require_context_utils = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/context-utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.getSpanContext = exports.setSpanContext = exports.deleteSpan = exports.setSpan = exports.getActiveSpan = exports.getSpan = void 0;
    var context_1 = require_context();
    var NonRecordingSpan_1 = require_NonRecordingSpan();
    var context_2 = require_context2();
    var SPAN_KEY = (0, context_1.createContextKey)("OpenTelemetry Context Key SPAN");
    function getSpan(context) {
      return context.getValue(SPAN_KEY) || void 0;
    }
    __name(getSpan, "getSpan");
    exports.getSpan = getSpan;
    function getActiveSpan() {
      return getSpan(context_2.ContextAPI.getInstance().active());
    }
    __name(getActiveSpan, "getActiveSpan");
    exports.getActiveSpan = getActiveSpan;
    function setSpan(context, span) {
      return context.setValue(SPAN_KEY, span);
    }
    __name(setSpan, "setSpan");
    exports.setSpan = setSpan;
    function deleteSpan(context) {
      return context.deleteValue(SPAN_KEY);
    }
    __name(deleteSpan, "deleteSpan");
    exports.deleteSpan = deleteSpan;
    function setSpanContext(context, spanContext) {
      return setSpan(context, new NonRecordingSpan_1.NonRecordingSpan(spanContext));
    }
    __name(setSpanContext, "setSpanContext");
    exports.setSpanContext = setSpanContext;
    function getSpanContext(context) {
      var _a17;
      return (_a17 = getSpan(context)) === null || _a17 === void 0 ? void 0 : _a17.spanContext();
    }
    __name(getSpanContext, "getSpanContext");
    exports.getSpanContext = getSpanContext;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/spancontext-utils.js
var require_spancontext_utils = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/spancontext-utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.wrapSpanContext = exports.isSpanContextValid = exports.isValidSpanId = exports.isValidTraceId = void 0;
    var invalid_span_constants_1 = require_invalid_span_constants();
    var NonRecordingSpan_1 = require_NonRecordingSpan();
    var VALID_TRACEID_REGEX = /^([0-9a-f]{32})\$/i;
    var VALID_SPANID_REGEX = /^[0-9a-f]{16}\$/i;
    function isValidTraceId(traceId) {
      return VALID_TRACEID_REGEX.test(traceId) && traceId !== invalid_span_constants_1.INVALID_TRACEID;
    }
    __name(isValidTraceId, "isValidTraceId");
    exports.isValidTraceId = isValidTraceId;
    function isValidSpanId(spanId) {
      return VALID_SPANID_REGEX.test(spanId) && spanId !== invalid_span_constants_1.INVALID_SPANID;
    }
    __name(isValidSpanId, "isValidSpanId");
    exports.isValidSpanId = isValidSpanId;
    function isSpanContextValid(spanContext) {
      return isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);
    }
    __name(isSpanContextValid, "isSpanContextValid");
    exports.isSpanContextValid = isSpanContextValid;
    function wrapSpanContext(spanContext) {
      return new NonRecordingSpan_1.NonRecordingSpan(spanContext);
    }
    __name(wrapSpanContext, "wrapSpanContext");
    exports.wrapSpanContext = wrapSpanContext;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/NoopTracer.js
var require_NoopTracer = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/NoopTracer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.NoopTracer = void 0;
    var context_1 = require_context2();
    var context_utils_1 = require_context_utils();
    var NonRecordingSpan_1 = require_NonRecordingSpan();
    var spancontext_utils_1 = require_spancontext_utils();
    var contextApi = context_1.ContextAPI.getInstance();
    var NoopTracer = class {
      static {
        __name(this, "NoopTracer");
      }
      // startSpan starts a noop span.
      startSpan(name17, options, context = contextApi.active()) {
        const root = Boolean(options === null || options === void 0 ? void 0 : options.root);
        if (root) {
          return new NonRecordingSpan_1.NonRecordingSpan();
        }
        const parentFromContext = context && (0, context_utils_1.getSpanContext)(context);
        if (isSpanContext(parentFromContext) && (0, spancontext_utils_1.isSpanContextValid)(parentFromContext)) {
          return new NonRecordingSpan_1.NonRecordingSpan(parentFromContext);
        } else {
          return new NonRecordingSpan_1.NonRecordingSpan();
        }
      }
      startActiveSpan(name17, arg2, arg3, arg4) {
        let opts;
        let ctx;
        let fn;
        if (arguments.length < 2) {
          return;
        } else if (arguments.length === 2) {
          fn = arg2;
        } else if (arguments.length === 3) {
          opts = arg2;
          fn = arg3;
        } else {
          opts = arg2;
          ctx = arg3;
          fn = arg4;
        }
        const parentContext = ctx !== null && ctx !== void 0 ? ctx : contextApi.active();
        const span = this.startSpan(name17, opts, parentContext);
        const contextWithSpanSet = (0, context_utils_1.setSpan)(parentContext, span);
        return contextApi.with(contextWithSpanSet, fn, void 0, span);
      }
    };
    exports.NoopTracer = NoopTracer;
    function isSpanContext(spanContext) {
      return typeof spanContext === "object" && typeof spanContext["spanId"] === "string" && typeof spanContext["traceId"] === "string" && typeof spanContext["traceFlags"] === "number";
    }
    __name(isSpanContext, "isSpanContext");
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/ProxyTracer.js
var require_ProxyTracer = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/ProxyTracer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.ProxyTracer = void 0;
    var NoopTracer_1 = require_NoopTracer();
    var NOOP_TRACER = new NoopTracer_1.NoopTracer();
    var ProxyTracer = class {
      static {
        __name(this, "ProxyTracer");
      }
      constructor(_provider, name17, version2, options) {
        this._provider = _provider;
        this.name = name17;
        this.version = version2;
        this.options = options;
      }
      startSpan(name17, options, context) {
        return this._getTracer().startSpan(name17, options, context);
      }
      startActiveSpan(_name, _options, _context, _fn) {
        const tracer = this._getTracer();
        return Reflect.apply(tracer.startActiveSpan, tracer, arguments);
      }
      /**
       * Try to get a tracer from the proxy tracer provider.
       * If the proxy tracer provider has no delegate, return a noop tracer.
       */
      _getTracer() {
        if (this._delegate) {
          return this._delegate;
        }
        const tracer = this._provider.getDelegateTracer(this.name, this.version, this.options);
        if (!tracer) {
          return NOOP_TRACER;
        }
        this._delegate = tracer;
        return this._delegate;
      }
    };
    exports.ProxyTracer = ProxyTracer;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/NoopTracerProvider.js
var require_NoopTracerProvider = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/NoopTracerProvider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.NoopTracerProvider = void 0;
    var NoopTracer_1 = require_NoopTracer();
    var NoopTracerProvider = class {
      static {
        __name(this, "NoopTracerProvider");
      }
      getTracer(_name, _version, _options) {
        return new NoopTracer_1.NoopTracer();
      }
    };
    exports.NoopTracerProvider = NoopTracerProvider;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/ProxyTracerProvider.js
var require_ProxyTracerProvider = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/ProxyTracerProvider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.ProxyTracerProvider = void 0;
    var ProxyTracer_1 = require_ProxyTracer();
    var NoopTracerProvider_1 = require_NoopTracerProvider();
    var NOOP_TRACER_PROVIDER = new NoopTracerProvider_1.NoopTracerProvider();
    var ProxyTracerProvider = class {
      static {
        __name(this, "ProxyTracerProvider");
      }
      /**
       * Get a {@link ProxyTracer}
       */
      getTracer(name17, version2, options) {
        var _a17;
        return (_a17 = this.getDelegateTracer(name17, version2, options)) !== null && _a17 !== void 0 ? _a17 : new ProxyTracer_1.ProxyTracer(this, name17, version2, options);
      }
      getDelegate() {
        var _a17;
        return (_a17 = this._delegate) !== null && _a17 !== void 0 ? _a17 : NOOP_TRACER_PROVIDER;
      }
      /**
       * Set the delegate tracer provider
       */
      setDelegate(delegate) {
        this._delegate = delegate;
      }
      getDelegateTracer(name17, version2, options) {
        var _a17;
        return (_a17 = this._delegate) === null || _a17 === void 0 ? void 0 : _a17.getTracer(name17, version2, options);
      }
    };
    exports.ProxyTracerProvider = ProxyTracerProvider;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/SamplingResult.js
var require_SamplingResult = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/SamplingResult.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.SamplingDecision = void 0;
    var SamplingDecision;
    (function(SamplingDecision2) {
      SamplingDecision2[SamplingDecision2["NOT_RECORD"] = 0] = "NOT_RECORD";
      SamplingDecision2[SamplingDecision2["RECORD"] = 1] = "RECORD";
      SamplingDecision2[SamplingDecision2["RECORD_AND_SAMPLED"] = 2] = "RECORD_AND_SAMPLED";
    })(SamplingDecision = exports.SamplingDecision || (exports.SamplingDecision = {}));
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/span_kind.js
var require_span_kind = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/span_kind.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.SpanKind = void 0;
    var SpanKind;
    (function(SpanKind2) {
      SpanKind2[SpanKind2["INTERNAL"] = 0] = "INTERNAL";
      SpanKind2[SpanKind2["SERVER"] = 1] = "SERVER";
      SpanKind2[SpanKind2["CLIENT"] = 2] = "CLIENT";
      SpanKind2[SpanKind2["PRODUCER"] = 3] = "PRODUCER";
      SpanKind2[SpanKind2["CONSUMER"] = 4] = "CONSUMER";
    })(SpanKind = exports.SpanKind || (exports.SpanKind = {}));
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/status.js
var require_status = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/status.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.SpanStatusCode = void 0;
    var SpanStatusCode2;
    (function(SpanStatusCode3) {
      SpanStatusCode3[SpanStatusCode3["UNSET"] = 0] = "UNSET";
      SpanStatusCode3[SpanStatusCode3["OK"] = 1] = "OK";
      SpanStatusCode3[SpanStatusCode3["ERROR"] = 2] = "ERROR";
    })(SpanStatusCode2 = exports.SpanStatusCode || (exports.SpanStatusCode = {}));
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-validators.js
var require_tracestate_validators = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-validators.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.validateValue = exports.validateKey = void 0;
    var VALID_KEY_CHAR_RANGE = "[_0-9a-z-*/]";
    var VALID_KEY = \`[a-z]\${VALID_KEY_CHAR_RANGE}{0,255}\`;
    var VALID_VENDOR_KEY = \`[a-z0-9]\${VALID_KEY_CHAR_RANGE}{0,240}@[a-z]\${VALID_KEY_CHAR_RANGE}{0,13}\`;
    var VALID_KEY_REGEX = new RegExp(\`^(?:\${VALID_KEY}|\${VALID_VENDOR_KEY})\$\`);
    var VALID_VALUE_BASE_REGEX = /^[ -~]{0,255}[!-~]\$/;
    var INVALID_VALUE_COMMA_EQUAL_REGEX = /,|=/;
    function validateKey(key) {
      return VALID_KEY_REGEX.test(key);
    }
    __name(validateKey, "validateKey");
    exports.validateKey = validateKey;
    function validateValue(value) {
      return VALID_VALUE_BASE_REGEX.test(value) && !INVALID_VALUE_COMMA_EQUAL_REGEX.test(value);
    }
    __name(validateValue, "validateValue");
    exports.validateValue = validateValue;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-impl.js
var require_tracestate_impl = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-impl.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.TraceStateImpl = void 0;
    var tracestate_validators_1 = require_tracestate_validators();
    var MAX_TRACE_STATE_ITEMS = 32;
    var MAX_TRACE_STATE_LEN = 512;
    var LIST_MEMBERS_SEPARATOR = ",";
    var LIST_MEMBER_KEY_VALUE_SPLITTER = "=";
    var TraceStateImpl = class _TraceStateImpl {
      static {
        __name(this, "TraceStateImpl");
      }
      constructor(rawTraceState) {
        this._internalState = /* @__PURE__ */ new Map();
        if (rawTraceState) this._parse(rawTraceState);
      }
      set(key, value) {
        const traceState = this._clone();
        if (traceState._internalState.has(key)) {
          traceState._internalState.delete(key);
        }
        traceState._internalState.set(key, value);
        return traceState;
      }
      unset(key) {
        const traceState = this._clone();
        traceState._internalState.delete(key);
        return traceState;
      }
      get(key) {
        return this._internalState.get(key);
      }
      serialize() {
        return this._keys().reduce((agg, key) => {
          agg.push(key + LIST_MEMBER_KEY_VALUE_SPLITTER + this.get(key));
          return agg;
        }, []).join(LIST_MEMBERS_SEPARATOR);
      }
      _parse(rawTraceState) {
        if (rawTraceState.length > MAX_TRACE_STATE_LEN) return;
        this._internalState = rawTraceState.split(LIST_MEMBERS_SEPARATOR).reverse().reduce((agg, part) => {
          const listMember = part.trim();
          const i = listMember.indexOf(LIST_MEMBER_KEY_VALUE_SPLITTER);
          if (i !== -1) {
            const key = listMember.slice(0, i);
            const value = listMember.slice(i + 1, part.length);
            if ((0, tracestate_validators_1.validateKey)(key) && (0, tracestate_validators_1.validateValue)(value)) {
              agg.set(key, value);
            } else {
            }
          }
          return agg;
        }, /* @__PURE__ */ new Map());
        if (this._internalState.size > MAX_TRACE_STATE_ITEMS) {
          this._internalState = new Map(Array.from(this._internalState.entries()).reverse().slice(0, MAX_TRACE_STATE_ITEMS));
        }
      }
      _keys() {
        return Array.from(this._internalState.keys()).reverse();
      }
      _clone() {
        const traceState = new _TraceStateImpl();
        traceState._internalState = new Map(this._internalState);
        return traceState;
      }
    };
    exports.TraceStateImpl = TraceStateImpl;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/internal/utils.js
var require_utils2 = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace/internal/utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.createTraceState = void 0;
    var tracestate_impl_1 = require_tracestate_impl();
    function createTraceState(rawTraceState) {
      return new tracestate_impl_1.TraceStateImpl(rawTraceState);
    }
    __name(createTraceState, "createTraceState");
    exports.createTraceState = createTraceState;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/context-api.js
var require_context_api = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/context-api.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.context = void 0;
    var context_1 = require_context2();
    exports.context = context_1.ContextAPI.getInstance();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag-api.js
var require_diag_api = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/diag-api.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.diag = void 0;
    var diag_1 = require_diag();
    exports.diag = diag_1.DiagAPI.instance();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics/NoopMeterProvider.js
var require_NoopMeterProvider = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics/NoopMeterProvider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.NOOP_METER_PROVIDER = exports.NoopMeterProvider = void 0;
    var NoopMeter_1 = require_NoopMeter();
    var NoopMeterProvider = class {
      static {
        __name(this, "NoopMeterProvider");
      }
      getMeter(_name, _version, _options) {
        return NoopMeter_1.NOOP_METER;
      }
    };
    exports.NoopMeterProvider = NoopMeterProvider;
    exports.NOOP_METER_PROVIDER = new NoopMeterProvider();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/metrics.js
var require_metrics = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/metrics.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.MetricsAPI = void 0;
    var NoopMeterProvider_1 = require_NoopMeterProvider();
    var global_utils_1 = require_global_utils();
    var diag_1 = require_diag();
    var API_NAME = "metrics";
    var MetricsAPI = class _MetricsAPI {
      static {
        __name(this, "MetricsAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
      }
      /** Get the singleton instance of the Metrics API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _MetricsAPI();
        }
        return this._instance;
      }
      /**
       * Set the current global meter provider.
       * Returns true if the meter provider was successfully registered, else false.
       */
      setGlobalMeterProvider(provider) {
        return (0, global_utils_1.registerGlobal)(API_NAME, provider, diag_1.DiagAPI.instance());
      }
      /**
       * Returns the global meter provider.
       */
      getMeterProvider() {
        return (0, global_utils_1.getGlobal)(API_NAME) || NoopMeterProvider_1.NOOP_METER_PROVIDER;
      }
      /**
       * Returns a meter from the global meter provider.
       */
      getMeter(name17, version2, options) {
        return this.getMeterProvider().getMeter(name17, version2, options);
      }
      /** Remove the global meter provider */
      disable() {
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
      }
    };
    exports.MetricsAPI = MetricsAPI;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics-api.js
var require_metrics_api = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/metrics-api.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.metrics = void 0;
    var metrics_1 = require_metrics();
    exports.metrics = metrics_1.MetricsAPI.getInstance();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/propagation/NoopTextMapPropagator.js
var require_NoopTextMapPropagator = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/propagation/NoopTextMapPropagator.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.NoopTextMapPropagator = void 0;
    var NoopTextMapPropagator = class {
      static {
        __name(this, "NoopTextMapPropagator");
      }
      /** Noop inject function does nothing */
      inject(_context, _carrier) {
      }
      /** Noop extract function does nothing and returns the input context */
      extract(context, _carrier) {
        return context;
      }
      fields() {
        return [];
      }
    };
    exports.NoopTextMapPropagator = NoopTextMapPropagator;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/context-helpers.js
var require_context_helpers = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/baggage/context-helpers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.deleteBaggage = exports.setBaggage = exports.getActiveBaggage = exports.getBaggage = void 0;
    var context_1 = require_context2();
    var context_2 = require_context();
    var BAGGAGE_KEY = (0, context_2.createContextKey)("OpenTelemetry Baggage Key");
    function getBaggage(context) {
      return context.getValue(BAGGAGE_KEY) || void 0;
    }
    __name(getBaggage, "getBaggage");
    exports.getBaggage = getBaggage;
    function getActiveBaggage() {
      return getBaggage(context_1.ContextAPI.getInstance().active());
    }
    __name(getActiveBaggage, "getActiveBaggage");
    exports.getActiveBaggage = getActiveBaggage;
    function setBaggage(context, baggage) {
      return context.setValue(BAGGAGE_KEY, baggage);
    }
    __name(setBaggage, "setBaggage");
    exports.setBaggage = setBaggage;
    function deleteBaggage(context) {
      return context.deleteValue(BAGGAGE_KEY);
    }
    __name(deleteBaggage, "deleteBaggage");
    exports.deleteBaggage = deleteBaggage;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/propagation.js
var require_propagation = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/propagation.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.PropagationAPI = void 0;
    var global_utils_1 = require_global_utils();
    var NoopTextMapPropagator_1 = require_NoopTextMapPropagator();
    var TextMapPropagator_1 = require_TextMapPropagator();
    var context_helpers_1 = require_context_helpers();
    var utils_1 = require_utils();
    var diag_1 = require_diag();
    var API_NAME = "propagation";
    var NOOP_TEXT_MAP_PROPAGATOR = new NoopTextMapPropagator_1.NoopTextMapPropagator();
    var PropagationAPI = class _PropagationAPI {
      static {
        __name(this, "PropagationAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
        this.createBaggage = utils_1.createBaggage;
        this.getBaggage = context_helpers_1.getBaggage;
        this.getActiveBaggage = context_helpers_1.getActiveBaggage;
        this.setBaggage = context_helpers_1.setBaggage;
        this.deleteBaggage = context_helpers_1.deleteBaggage;
      }
      /** Get the singleton instance of the Propagator API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _PropagationAPI();
        }
        return this._instance;
      }
      /**
       * Set the current propagator.
       *
       * @returns true if the propagator was successfully registered, else false
       */
      setGlobalPropagator(propagator) {
        return (0, global_utils_1.registerGlobal)(API_NAME, propagator, diag_1.DiagAPI.instance());
      }
      /**
       * Inject context into a carrier to be propagated inter-process
       *
       * @param context Context carrying tracing data to inject
       * @param carrier carrier to inject context into
       * @param setter Function used to set values on the carrier
       */
      inject(context, carrier, setter = TextMapPropagator_1.defaultTextMapSetter) {
        return this._getGlobalPropagator().inject(context, carrier, setter);
      }
      /**
       * Extract context from a carrier
       *
       * @param context Context which the newly created context will inherit from
       * @param carrier Carrier to extract context from
       * @param getter Function used to extract keys from a carrier
       */
      extract(context, carrier, getter = TextMapPropagator_1.defaultTextMapGetter) {
        return this._getGlobalPropagator().extract(context, carrier, getter);
      }
      /**
       * Return a list of all fields which may be used by the propagator.
       */
      fields() {
        return this._getGlobalPropagator().fields();
      }
      /** Remove the global propagator */
      disable() {
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
      }
      _getGlobalPropagator() {
        return (0, global_utils_1.getGlobal)(API_NAME) || NOOP_TEXT_MAP_PROPAGATOR;
      }
    };
    exports.PropagationAPI = PropagationAPI;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/propagation-api.js
var require_propagation_api = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/propagation-api.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.propagation = void 0;
    var propagation_1 = require_propagation();
    exports.propagation = propagation_1.PropagationAPI.getInstance();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/trace.js
var require_trace = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/api/trace.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.TraceAPI = void 0;
    var global_utils_1 = require_global_utils();
    var ProxyTracerProvider_1 = require_ProxyTracerProvider();
    var spancontext_utils_1 = require_spancontext_utils();
    var context_utils_1 = require_context_utils();
    var diag_1 = require_diag();
    var API_NAME = "trace";
    var TraceAPI = class _TraceAPI {
      static {
        __name(this, "TraceAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
        this._proxyTracerProvider = new ProxyTracerProvider_1.ProxyTracerProvider();
        this.wrapSpanContext = spancontext_utils_1.wrapSpanContext;
        this.isSpanContextValid = spancontext_utils_1.isSpanContextValid;
        this.deleteSpan = context_utils_1.deleteSpan;
        this.getSpan = context_utils_1.getSpan;
        this.getActiveSpan = context_utils_1.getActiveSpan;
        this.getSpanContext = context_utils_1.getSpanContext;
        this.setSpan = context_utils_1.setSpan;
        this.setSpanContext = context_utils_1.setSpanContext;
      }
      /** Get the singleton instance of the Trace API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _TraceAPI();
        }
        return this._instance;
      }
      /**
       * Set the current global tracer.
       *
       * @returns true if the tracer provider was successfully registered, else false
       */
      setGlobalTracerProvider(provider) {
        const success2 = (0, global_utils_1.registerGlobal)(API_NAME, this._proxyTracerProvider, diag_1.DiagAPI.instance());
        if (success2) {
          this._proxyTracerProvider.setDelegate(provider);
        }
        return success2;
      }
      /**
       * Returns the global tracer provider.
       */
      getTracerProvider() {
        return (0, global_utils_1.getGlobal)(API_NAME) || this._proxyTracerProvider;
      }
      /**
       * Returns a tracer from the global tracer provider.
       */
      getTracer(name17, version2) {
        return this.getTracerProvider().getTracer(name17, version2);
      }
      /** Remove the global tracer provider */
      disable() {
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
        this._proxyTracerProvider = new ProxyTracerProvider_1.ProxyTracerProvider();
      }
    };
    exports.TraceAPI = TraceAPI;
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace-api.js
var require_trace_api = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/trace-api.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.trace = void 0;
    var trace_1 = require_trace();
    exports.trace = trace_1.TraceAPI.getInstance();
  }
});

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/index.js
var require_src = __commonJS({
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    exports.trace = exports.propagation = exports.metrics = exports.diag = exports.context = exports.INVALID_SPAN_CONTEXT = exports.INVALID_TRACEID = exports.INVALID_SPANID = exports.isValidSpanId = exports.isValidTraceId = exports.isSpanContextValid = exports.createTraceState = exports.TraceFlags = exports.SpanStatusCode = exports.SpanKind = exports.SamplingDecision = exports.ProxyTracerProvider = exports.ProxyTracer = exports.defaultTextMapSetter = exports.defaultTextMapGetter = exports.ValueType = exports.createNoopMeter = exports.DiagLogLevel = exports.DiagConsoleLogger = exports.ROOT_CONTEXT = exports.createContextKey = exports.baggageEntryMetadataFromString = void 0;
    var utils_1 = require_utils();
    Object.defineProperty(exports, "baggageEntryMetadataFromString", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return utils_1.baggageEntryMetadataFromString;
      }, "get")
    });
    var context_1 = require_context();
    Object.defineProperty(exports, "createContextKey", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return context_1.createContextKey;
      }, "get")
    });
    Object.defineProperty(exports, "ROOT_CONTEXT", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return context_1.ROOT_CONTEXT;
      }, "get")
    });
    var consoleLogger_1 = require_consoleLogger();
    Object.defineProperty(exports, "DiagConsoleLogger", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return consoleLogger_1.DiagConsoleLogger;
      }, "get")
    });
    var types_1 = require_types();
    Object.defineProperty(exports, "DiagLogLevel", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return types_1.DiagLogLevel;
      }, "get")
    });
    var NoopMeter_1 = require_NoopMeter();
    Object.defineProperty(exports, "createNoopMeter", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return NoopMeter_1.createNoopMeter;
      }, "get")
    });
    var Metric_1 = require_Metric();
    Object.defineProperty(exports, "ValueType", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return Metric_1.ValueType;
      }, "get")
    });
    var TextMapPropagator_1 = require_TextMapPropagator();
    Object.defineProperty(exports, "defaultTextMapGetter", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return TextMapPropagator_1.defaultTextMapGetter;
      }, "get")
    });
    Object.defineProperty(exports, "defaultTextMapSetter", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return TextMapPropagator_1.defaultTextMapSetter;
      }, "get")
    });
    var ProxyTracer_1 = require_ProxyTracer();
    Object.defineProperty(exports, "ProxyTracer", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return ProxyTracer_1.ProxyTracer;
      }, "get")
    });
    var ProxyTracerProvider_1 = require_ProxyTracerProvider();
    Object.defineProperty(exports, "ProxyTracerProvider", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return ProxyTracerProvider_1.ProxyTracerProvider;
      }, "get")
    });
    var SamplingResult_1 = require_SamplingResult();
    Object.defineProperty(exports, "SamplingDecision", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return SamplingResult_1.SamplingDecision;
      }, "get")
    });
    var span_kind_1 = require_span_kind();
    Object.defineProperty(exports, "SpanKind", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return span_kind_1.SpanKind;
      }, "get")
    });
    var status_1 = require_status();
    Object.defineProperty(exports, "SpanStatusCode", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return status_1.SpanStatusCode;
      }, "get")
    });
    var trace_flags_1 = require_trace_flags();
    Object.defineProperty(exports, "TraceFlags", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return trace_flags_1.TraceFlags;
      }, "get")
    });
    var utils_2 = require_utils2();
    Object.defineProperty(exports, "createTraceState", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return utils_2.createTraceState;
      }, "get")
    });
    var spancontext_utils_1 = require_spancontext_utils();
    Object.defineProperty(exports, "isSpanContextValid", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return spancontext_utils_1.isSpanContextValid;
      }, "get")
    });
    Object.defineProperty(exports, "isValidTraceId", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return spancontext_utils_1.isValidTraceId;
      }, "get")
    });
    Object.defineProperty(exports, "isValidSpanId", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return spancontext_utils_1.isValidSpanId;
      }, "get")
    });
    var invalid_span_constants_1 = require_invalid_span_constants();
    Object.defineProperty(exports, "INVALID_SPANID", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return invalid_span_constants_1.INVALID_SPANID;
      }, "get")
    });
    Object.defineProperty(exports, "INVALID_TRACEID", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return invalid_span_constants_1.INVALID_TRACEID;
      }, "get")
    });
    Object.defineProperty(exports, "INVALID_SPAN_CONTEXT", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return invalid_span_constants_1.INVALID_SPAN_CONTEXT;
      }, "get")
    });
    var context_api_1 = require_context_api();
    Object.defineProperty(exports, "context", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return context_api_1.context;
      }, "get")
    });
    var diag_api_1 = require_diag_api();
    Object.defineProperty(exports, "diag", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return diag_api_1.diag;
      }, "get")
    });
    var metrics_api_1 = require_metrics_api();
    Object.defineProperty(exports, "metrics", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return metrics_api_1.metrics;
      }, "get")
    });
    var propagation_api_1 = require_propagation_api();
    Object.defineProperty(exports, "propagation", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return propagation_api_1.propagation;
      }, "get")
    });
    var trace_api_1 = require_trace_api();
    Object.defineProperty(exports, "trace", {
      enumerable: true,
      get: /* @__PURE__ */ __name(function() {
        return trace_api_1.trace;
      }, "get")
    });
    exports.default = {
      context: context_api_1.context,
      diag: diag_api_1.diag,
      metrics: metrics_api_1.metrics,
      propagation: propagation_api_1.propagation,
      trace: trace_api_1.trace
    };
  }
});

// ../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse3(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error("val is not a non-empty string or a valid number. val=" + JSON.stringify(val));
    };
    function parse3(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?\$/i.exec(str);
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    __name(parse3, "parse");
    function fmtShort(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return Math.round(ms2 / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms2 / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms2 / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms2 / s) + "s";
      }
      return ms2 + "ms";
    }
    __name(fmtShort, "fmtShort");
    function fmtLong(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return plural(ms2, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms2, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms2, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms2, msAbs, s, "second");
      }
      return ms2 + " ms";
    }
    __name(fmtLong, "fmtLong");
    function plural(ms2, msAbs, n, name17) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms2 / n) + " " + name17 + (isPlural ? "s" : "");
    }
    __name(plural, "plural");
  }
});

// ../../node_modules/.pnpm/lodash.chunk@4.2.0/node_modules/lodash.chunk/index.js
var require_lodash = __commonJS({
  "../../node_modules/.pnpm/lodash.chunk@4.2.0/node_modules/lodash.chunk/index.js"(exports, module2) {
    var INFINITY = 1 / 0;
    var MAX_SAFE_INTEGER = 9007199254740991;
    var MAX_INTEGER = 17976931348623157e292;
    var NAN = 0 / 0;
    var funcTag = "[object Function]";
    var genTag = "[object GeneratorFunction]";
    var symbolTag = "[object Symbol]";
    var reTrim = /^\\s+|\\s+\$/g;
    var reIsBadHex = /^[-+]0x[0-9a-f]+\$/i;
    var reIsBinary = /^0b[01]+\$/i;
    var reIsOctal = /^0o[0-7]+\$/i;
    var reIsUint = /^(?:0|[1-9]\\d*)\$/;
    var freeParseInt = parseInt;
    var objectProto = Object.prototype;
    var objectToString = objectProto.toString;
    var nativeCeil = Math.ceil;
    var nativeMax = Math.max;
    function baseSlice(array2, start, end) {
      var index = -1, length = array2.length;
      if (start < 0) {
        start = -start > length ? 0 : length + start;
      }
      end = end > length ? length : end;
      if (end < 0) {
        end += length;
      }
      length = start > end ? 0 : end - start >>> 0;
      start >>>= 0;
      var result = Array(length);
      while (++index < length) {
        result[index] = array2[index + start];
      }
      return result;
    }
    __name(baseSlice, "baseSlice");
    function isIndex(value, length) {
      length = length == null ? MAX_SAFE_INTEGER : length;
      return !!length && (typeof value == "number" || reIsUint.test(value)) && value > -1 && value % 1 == 0 && value < length;
    }
    __name(isIndex, "isIndex");
    function isIterateeCall(value, index, object3) {
      if (!isObject2(object3)) {
        return false;
      }
      var type = typeof index;
      if (type == "number" ? isArrayLike(object3) && isIndex(index, object3.length) : type == "string" && index in object3) {
        return eq(object3[index], value);
      }
      return false;
    }
    __name(isIterateeCall, "isIterateeCall");
    function chunk2(array2, size, guard) {
      if (guard ? isIterateeCall(array2, size, guard) : size === void 0) {
        size = 1;
      } else {
        size = nativeMax(toInteger(size), 0);
      }
      var length = array2 ? array2.length : 0;
      if (!length || size < 1) {
        return [];
      }
      var index = 0, resIndex = 0, result = Array(nativeCeil(length / size));
      while (index < length) {
        result[resIndex++] = baseSlice(array2, index, index += size);
      }
      return result;
    }
    __name(chunk2, "chunk");
    function eq(value, other) {
      return value === other || value !== value && other !== other;
    }
    __name(eq, "eq");
    function isArrayLike(value) {
      return value != null && isLength(value.length) && !isFunction(value);
    }
    __name(isArrayLike, "isArrayLike");
    function isFunction(value) {
      var tag = isObject2(value) ? objectToString.call(value) : "";
      return tag == funcTag || tag == genTag;
    }
    __name(isFunction, "isFunction");
    function isLength(value) {
      return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
    }
    __name(isLength, "isLength");
    function isObject2(value) {
      var type = typeof value;
      return !!value && (type == "object" || type == "function");
    }
    __name(isObject2, "isObject");
    function isObjectLike(value) {
      return !!value && typeof value == "object";
    }
    __name(isObjectLike, "isObjectLike");
    function isSymbol(value) {
      return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
    }
    __name(isSymbol, "isSymbol");
    function toFinite(value) {
      if (!value) {
        return value === 0 ? value : 0;
      }
      value = toNumber(value);
      if (value === INFINITY || value === -INFINITY) {
        var sign = value < 0 ? -1 : 1;
        return sign * MAX_INTEGER;
      }
      return value === value ? value : 0;
    }
    __name(toFinite, "toFinite");
    function toInteger(value) {
      var result = toFinite(value), remainder = result % 1;
      return result === result ? remainder ? result - remainder : result : 0;
    }
    __name(toInteger, "toInteger");
    function toNumber(value) {
      if (typeof value == "number") {
        return value;
      }
      if (isSymbol(value)) {
        return NAN;
      }
      if (isObject2(value)) {
        var other = typeof value.valueOf == "function" ? value.valueOf() : value;
        value = isObject2(other) ? other + "" : other;
      }
      if (typeof value != "string") {
        return value === 0 ? value : +value;
      }
      value = value.replace(reTrim, "");
      var isBinary = reIsBinary.test(value);
      return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
    }
    __name(toNumber, "toNumber");
    module2.exports = chunk2;
  }
});

// ../example/workflows/3_streams.ts
var streams_exports = {};
__export(streams_exports, {
  consumeStreams: () => consumeStreams,
  genStream: () => genStream,
  streams: () => streams
});
async function genStream() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/3_streams.ts//genStream")();
}
__name(genStream, "genStream");
async function consumeStreams(...streams2) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/3_streams.ts//consumeStreams")(...streams2);
}
__name(consumeStreams, "consumeStreams");
async function streams() {
  console.log("Streams workflow started");
  const [s1, s2] = await Promise.all([
    genStream(),
    genStream()
  ]);
  const result = await consumeStreams(s1, s2);
  console.log(\`Streams workflow completed. Result: \${result.slice(0, 100)}\`);
  return {
    message: "Streams processed successfully",
    dataLength: result.length,
    preview: result.slice(0, 100)
  };
}
__name(streams, "streams");
streams.workflowId = "workflow//example/workflows/3_streams.ts//streams";

// ../example/workflows/2_control_flow.ts
var control_flow_exports = {};
__export(control_flow_exports, {
  control_flow: () => control_flow
});
async function delayedMessage(ms2, message) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/2_control_flow.ts//delayedMessage")(ms2, message);
}
__name(delayedMessage, "delayedMessage");
async function add(a, b) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/2_control_flow.ts//add")(a, b);
}
__name(add, "add");
async function failingStep() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/2_control_flow.ts//failingStep")();
}
__name(failingStep, "failingStep");
async function retryableStep() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/2_control_flow.ts//retryableStep")();
}
__name(retryableStep, "retryableStep");
async function control_flow() {
  console.log("Control flow workflow started");
  const raceResult = await Promise.race([
    delayedMessage(2e3, "I won the race!"),
    delayedMessage(1e4, "I lost the race")
  ]);
  console.log("Race result:", raceResult);
  const allResults = await Promise.all([
    delayedMessage(1e3, "First task"),
    delayedMessage(2e3, "Second task"),
    add(10, 20)
  ]);
  console.log("All results:", allResults);
  const backgroundPromise = delayedMessage(5e3, "Background task completed");
  const foregroundResults = await Promise.all([
    delayedMessage(1e3, "First task"),
    delayedMessage(2e3, "Second task")
  ]);
  console.log("Foreground response:", foregroundResults);
  const backgroundResult = await backgroundPromise;
  console.log("Background response:", backgroundResult);
  try {
    await failingStep();
  } catch (error45) {
    console.log("Caught error:", String(error45));
  }
  await retryableStep();
  console.log("Control flow workflow completed. See logs for results.");
  return {
    raceResult,
    allResults,
    foregroundResults,
    backgroundResult
  };
}
__name(control_flow, "control_flow");
control_flow.workflowId = "workflow//example/workflows/2_control_flow.ts//control_flow";

// ../example/workflows/4_ai.ts
var ai_exports = {};
__export(ai_exports, {
  agent: () => agent,
  ai: () => ai
});

// ../../node_modules/.pnpm/@ai-sdk+provider@2.0.0/node_modules/@ai-sdk/provider/dist/index.mjs
var marker = "vercel.ai.error";
var symbol = Symbol.for(marker);
var _a;
var _AISDKError = class _AISDKError2 extends Error {
  static {
    __name(this, "_AISDKError");
  }
  /**
  * Creates an AI SDK Error.
  *
  * @param {Object} params - The parameters for creating the error.
  * @param {string} params.name - The name of the error.
  * @param {string} params.message - The error message.
  * @param {unknown} [params.cause] - The underlying cause of the error.
  */
  constructor({ name: name143, message, cause }) {
    super(message);
    this[_a] = true;
    this.name = name143;
    this.cause = cause;
  }
  /**
  * Checks if the given error is an AI SDK Error.
  * @param {unknown} error - The error to check.
  * @returns {boolean} True if the error is an AI SDK Error, false otherwise.
  */
  static isInstance(error45) {
    return _AISDKError2.hasMarker(error45, marker);
  }
  static hasMarker(error45, marker153) {
    const markerSymbol = Symbol.for(marker153);
    return error45 != null && typeof error45 === "object" && markerSymbol in error45 && typeof error45[markerSymbol] === "boolean" && error45[markerSymbol] === true;
  }
};
_a = symbol;
var AISDKError = _AISDKError;
var name = "AI_APICallError";
var marker2 = \`vercel.ai.error.\${name}\`;
var symbol2 = Symbol.for(marker2);
var _a2;
var APICallError = class extends AISDKError {
  static {
    __name(this, "APICallError");
  }
  constructor({
    message,
    url: url2,
    requestBodyValues,
    statusCode,
    responseHeaders,
    responseBody,
    cause,
    isRetryable = statusCode != null && (statusCode === 408 || // request timeout
    statusCode === 409 || // conflict
    statusCode === 429 || // too many requests
    statusCode >= 500),
    // server error
    data
  }) {
    super({
      name,
      message,
      cause
    });
    this[_a2] = true;
    this.url = url2;
    this.requestBodyValues = requestBodyValues;
    this.statusCode = statusCode;
    this.responseHeaders = responseHeaders;
    this.responseBody = responseBody;
    this.isRetryable = isRetryable;
    this.data = data;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker2);
  }
};
_a2 = symbol2;
var name2 = "AI_EmptyResponseBodyError";
var marker3 = \`vercel.ai.error.\${name2}\`;
var symbol3 = Symbol.for(marker3);
var _a3;
var EmptyResponseBodyError = class extends AISDKError {
  static {
    __name(this, "EmptyResponseBodyError");
  }
  // used in isInstance
  constructor({ message = "Empty response body" } = {}) {
    super({
      name: name2,
      message
    });
    this[_a3] = true;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker3);
  }
};
_a3 = symbol3;
function getErrorMessage(error45) {
  if (error45 == null) {
    return "unknown error";
  }
  if (typeof error45 === "string") {
    return error45;
  }
  if (error45 instanceof Error) {
    return error45.message;
  }
  return JSON.stringify(error45);
}
__name(getErrorMessage, "getErrorMessage");
var name3 = "AI_InvalidArgumentError";
var marker4 = \`vercel.ai.error.\${name3}\`;
var symbol4 = Symbol.for(marker4);
var _a4;
var InvalidArgumentError = class extends AISDKError {
  static {
    __name(this, "InvalidArgumentError");
  }
  constructor({ message, cause, argument }) {
    super({
      name: name3,
      message,
      cause
    });
    this[_a4] = true;
    this.argument = argument;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker4);
  }
};
_a4 = symbol4;
var name4 = "AI_InvalidPromptError";
var marker5 = \`vercel.ai.error.\${name4}\`;
var symbol5 = Symbol.for(marker5);
var _a5;
var InvalidPromptError = class extends AISDKError {
  static {
    __name(this, "InvalidPromptError");
  }
  constructor({ prompt, message, cause }) {
    super({
      name: name4,
      message: \`Invalid prompt: \${message}\`,
      cause
    });
    this[_a5] = true;
    this.prompt = prompt;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker5);
  }
};
_a5 = symbol5;
var name5 = "AI_InvalidResponseDataError";
var marker6 = \`vercel.ai.error.\${name5}\`;
var symbol6 = Symbol.for(marker6);
var _a6;
_a6 = symbol6;
var name6 = "AI_JSONParseError";
var marker7 = \`vercel.ai.error.\${name6}\`;
var symbol7 = Symbol.for(marker7);
var _a7;
var JSONParseError = class extends AISDKError {
  static {
    __name(this, "JSONParseError");
  }
  constructor({ text: text2, cause }) {
    super({
      name: name6,
      message: \`JSON parsing failed: Text: \${text2}.
Error message: \${getErrorMessage(cause)}\`,
      cause
    });
    this[_a7] = true;
    this.text = text2;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker7);
  }
};
_a7 = symbol7;
var name7 = "AI_LoadAPIKeyError";
var marker8 = \`vercel.ai.error.\${name7}\`;
var symbol8 = Symbol.for(marker8);
var _a8;
_a8 = symbol8;
var name8 = "AI_LoadSettingError";
var marker9 = \`vercel.ai.error.\${name8}\`;
var symbol9 = Symbol.for(marker9);
var _a9;
_a9 = symbol9;
var name9 = "AI_NoContentGeneratedError";
var marker10 = \`vercel.ai.error.\${name9}\`;
var symbol10 = Symbol.for(marker10);
var _a10;
_a10 = symbol10;
var name10 = "AI_NoSuchModelError";
var marker11 = \`vercel.ai.error.\${name10}\`;
var symbol11 = Symbol.for(marker11);
var _a11;
var NoSuchModelError = class extends AISDKError {
  static {
    __name(this, "NoSuchModelError");
  }
  constructor({ errorName = name10, modelId, modelType, message = \`No such \${modelType}: \${modelId}\` }) {
    super({
      name: errorName,
      message
    });
    this[_a11] = true;
    this.modelId = modelId;
    this.modelType = modelType;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker11);
  }
};
_a11 = symbol11;
var name11 = "AI_TooManyEmbeddingValuesForCallError";
var marker12 = \`vercel.ai.error.\${name11}\`;
var symbol12 = Symbol.for(marker12);
var _a12;
_a12 = symbol12;
var name12 = "AI_TypeValidationError";
var marker13 = \`vercel.ai.error.\${name12}\`;
var symbol13 = Symbol.for(marker13);
var _a13;
var _TypeValidationError = class _TypeValidationError2 extends AISDKError {
  static {
    __name(this, "_TypeValidationError");
  }
  constructor({ value, cause }) {
    super({
      name: name12,
      message: \`Type validation failed: Value: \${JSON.stringify(value)}.
Error message: \${getErrorMessage(cause)}\`,
      cause
    });
    this[_a13] = true;
    this.value = value;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker13);
  }
  /**
  * Wraps an error into a TypeValidationError.
  * If the cause is already a TypeValidationError with the same value, it returns the cause.
  * Otherwise, it creates a new TypeValidationError.
  *
  * @param {Object} params - The parameters for wrapping the error.
  * @param {unknown} params.value - The value that failed validation.
  * @param {unknown} params.cause - The original error or cause of the validation failure.
  * @returns {TypeValidationError} A TypeValidationError instance.
  */
  static wrap({ value, cause }) {
    return _TypeValidationError2.isInstance(cause) && cause.value === value ? cause : new _TypeValidationError2({
      value,
      cause
    });
  }
};
_a13 = symbol13;
var TypeValidationError = _TypeValidationError;
var name13 = "AI_UnsupportedFunctionalityError";
var marker14 = \`vercel.ai.error.\${name13}\`;
var symbol14 = Symbol.for(marker14);
var _a14;
_a14 = symbol14;

// ../../node_modules/.pnpm/eventsource-parser@3.0.6/node_modules/eventsource-parser/dist/index.js
var ParseError = class extends Error {
  static {
    __name(this, "ParseError");
  }
  constructor(message, options) {
    super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
  }
};
function createParser(callbacks) {
  if (typeof callbacks == "function") throw new TypeError("\`callbacks\` must be an object, got a function instead. Did you mean \`{onEvent: fn}\`?");
  const { onEvent = noop, onError = noop, onRetry = noop, onComment } = callbacks;
  let incompleteLine = "", isFirstChunk = true, id, data = "", eventType = "";
  function feed(newChunk) {
    const chunk2 = isFirstChunk ? newChunk.replace(/^\\xEF\\xBB\\xBF/, "") : newChunk, [complete, incomplete] = splitLines(\`\${incompleteLine}\${chunk2}\`);
    for (const line of complete) parseLine(line);
    incompleteLine = incomplete, isFirstChunk = false;
  }
  __name(feed, "feed");
  function parseLine(line) {
    if (line === "") {
      dispatchEvent();
      return;
    }
    if (line.startsWith(":")) {
      onComment && onComment(line.slice(line.startsWith(": ") ? 2 : 1));
      return;
    }
    const fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex !== -1) {
      const field = line.slice(0, fieldSeparatorIndex), offset = line[fieldSeparatorIndex + 1] === " " ? 2 : 1, value = line.slice(fieldSeparatorIndex + offset);
      processField(field, value, line);
      return;
    }
    processField(line, "", line);
  }
  __name(parseLine, "parseLine");
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data = \`\${data}\${value}
\`;
        break;
      case "id":
        id = value.includes("\\0") ? void 0 : value;
        break;
      case "retry":
        /^\\d+\$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(\`Invalid \\\`retry\\\` value: "\${value}"\`, {
          type: "invalid-retry",
          value,
          line
        }));
        break;
      default:
        onError(new ParseError(\`Unknown field "\${field.length > 20 ? \`\${field.slice(0, 20)}\\u2026\` : field}"\`, {
          type: "unknown-field",
          field,
          value,
          line
        }));
        break;
    }
  }
  __name(processField, "processField");
  function dispatchEvent() {
    data.length > 0 && onEvent({
      id,
      event: eventType || void 0,
      // If the data buffer's last character is a U+000A LINE FEED (LF) character,
      // then remove the last character from the data buffer.
      data: data.endsWith(\`
\`) ? data.slice(0, -1) : data
    }), id = void 0, data = "", eventType = "";
  }
  __name(dispatchEvent, "dispatchEvent");
  function reset(options = {}) {
    incompleteLine && options.consume && parseLine(incompleteLine), isFirstChunk = true, id = void 0, data = "", eventType = "", incompleteLine = "";
  }
  __name(reset, "reset");
  return {
    feed,
    reset
  };
}
__name(createParser, "createParser");
function splitLines(chunk2) {
  const lines = [];
  let incompleteLine = "", searchIndex = 0;
  for (; searchIndex < chunk2.length; ) {
    const crIndex = chunk2.indexOf("\\r", searchIndex), lfIndex = chunk2.indexOf(\`
\`, searchIndex);
    let lineEnd = -1;
    if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = Math.min(crIndex, lfIndex) : crIndex !== -1 ? crIndex === chunk2.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) {
      incompleteLine = chunk2.slice(searchIndex);
      break;
    } else {
      const line = chunk2.slice(searchIndex, lineEnd);
      lines.push(line), searchIndex = lineEnd + 1, chunk2[searchIndex - 1] === "\\r" && chunk2[searchIndex] === \`
\` && searchIndex++;
    }
  }
  return [
    lines,
    incompleteLine
  ];
}
__name(splitLines, "splitLines");

// ../../node_modules/.pnpm/eventsource-parser@3.0.6/node_modules/eventsource-parser/dist/stream.js
var EventSourceParserStream = class extends TransformStream {
  static {
    __name(this, "EventSourceParserStream");
  }
  constructor({ onError, onRetry, onComment } = {}) {
    let parser;
    super({
      start(controller) {
        parser = createParser({
          onEvent: /* @__PURE__ */ __name((event) => {
            controller.enqueue(event);
          }, "onEvent"),
          onError(error45) {
            onError === "terminate" ? controller.error(error45) : typeof onError == "function" && onError(error45);
          },
          onRetry,
          onComment
        });
      },
      transform(chunk2) {
        parser.feed(chunk2);
      }
    });
  }
};

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/external.js
var external_exports = {};
__export(external_exports, {
  \$brand: () => \$brand,
  \$input: () => \$input,
  \$output: () => \$output,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBase64: () => ZodBase64,
  ZodBase64URL: () => ZodBase64URL,
  ZodBigInt: () => ZodBigInt,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBoolean: () => ZodBoolean,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCUID: () => ZodCUID,
  ZodCUID2: () => ZodCUID2,
  ZodCatch: () => ZodCatch,
  ZodCodec: () => ZodCodec,
  ZodCustom: () => ZodCustom,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodE164: () => ZodE164,
  ZodEmail: () => ZodEmail,
  ZodEmoji: () => ZodEmoji,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFile: () => ZodFile,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodGUID: () => ZodGUID,
  ZodIPv4: () => ZodIPv4,
  ZodIPv6: () => ZodIPv6,
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodJWT: () => ZodJWT,
  ZodKSUID: () => ZodKSUID,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNanoID: () => ZodNanoID,
  ZodNever: () => ZodNever,
  ZodNonOptional: () => ZodNonOptional,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodPipe: () => ZodPipe,
  ZodPrefault: () => ZodPrefault,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRealError: () => ZodRealError,
  ZodRecord: () => ZodRecord,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodStringFormat: () => ZodStringFormat,
  ZodSuccess: () => ZodSuccess,
  ZodSymbol: () => ZodSymbol,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodTransform: () => ZodTransform,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodULID: () => ZodULID,
  ZodURL: () => ZodURL,
  ZodUUID: () => ZodUUID,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  ZodXID: () => ZodXID,
  _ZodString: () => _ZodString,
  _default: () => _default2,
  _function: () => _function,
  any: () => any,
  array: () => array,
  base64: () => base642,
  base64url: () => base64url2,
  bigint: () => bigint2,
  boolean: () => boolean2,
  catch: () => _catch2,
  check: () => check,
  cidrv4: () => cidrv42,
  cidrv6: () => cidrv62,
  clone: () => clone,
  codec: () => codec,
  coerce: () => coerce_exports,
  config: () => config,
  core: () => core_exports2,
  cuid: () => cuid3,
  cuid2: () => cuid22,
  custom: () => custom,
  date: () => date3,
  decode: () => decode2,
  decodeAsync: () => decodeAsync2,
  discriminatedUnion: () => discriminatedUnion,
  e164: () => e1642,
  email: () => email2,
  emoji: () => emoji2,
  encode: () => encode2,
  encodeAsync: () => encodeAsync2,
  endsWith: () => _endsWith,
  enum: () => _enum2,
  file: () => file,
  flattenError: () => flattenError,
  float32: () => float32,
  float64: () => float64,
  formatError: () => formatError,
  function: () => _function,
  getErrorMap: () => getErrorMap,
  globalRegistry: () => globalRegistry,
  gt: () => _gt,
  gte: () => _gte,
  guid: () => guid2,
  hash: () => hash,
  hex: () => hex2,
  hostname: () => hostname2,
  httpUrl: () => httpUrl,
  includes: () => _includes,
  instanceof: () => _instanceof,
  int: () => int,
  int32: () => int32,
  int64: () => int64,
  intersection: () => intersection,
  ipv4: () => ipv42,
  ipv6: () => ipv62,
  iso: () => iso_exports,
  json: () => json,
  jwt: () => jwt,
  keyof: () => keyof,
  ksuid: () => ksuid2,
  lazy: () => lazy,
  length: () => _length,
  literal: () => literal,
  locales: () => locales_exports,
  looseObject: () => looseObject,
  lowercase: () => _lowercase,
  lt: () => _lt,
  lte: () => _lte,
  map: () => map,
  maxLength: () => _maxLength,
  maxSize: () => _maxSize,
  mime: () => _mime,
  minLength: () => _minLength,
  minSize: () => _minSize,
  multipleOf: () => _multipleOf,
  nan: () => nan,
  nanoid: () => nanoid2,
  nativeEnum: () => nativeEnum,
  negative: () => _negative,
  never: () => never,
  nonnegative: () => _nonnegative,
  nonoptional: () => nonoptional,
  nonpositive: () => _nonpositive,
  normalize: () => _normalize,
  null: () => _null3,
  nullable: () => nullable,
  nullish: () => nullish2,
  number: () => number2,
  object: () => object,
  optional: () => optional,
  overwrite: () => _overwrite,
  parse: () => parse2,
  parseAsync: () => parseAsync2,
  partialRecord: () => partialRecord,
  pipe: () => pipe,
  positive: () => _positive,
  prefault: () => prefault,
  preprocess: () => preprocess,
  prettifyError: () => prettifyError,
  promise: () => promise,
  property: () => _property,
  readonly: () => readonly,
  record: () => record,
  refine: () => refine,
  regex: () => _regex,
  regexes: () => regexes_exports,
  registry: () => registry,
  safeDecode: () => safeDecode2,
  safeDecodeAsync: () => safeDecodeAsync2,
  safeEncode: () => safeEncode2,
  safeEncodeAsync: () => safeEncodeAsync2,
  safeParse: () => safeParse2,
  safeParseAsync: () => safeParseAsync2,
  set: () => set,
  setErrorMap: () => setErrorMap,
  size: () => _size,
  startsWith: () => _startsWith,
  strictObject: () => strictObject,
  string: () => string2,
  stringFormat: () => stringFormat,
  stringbool: () => stringbool,
  success: () => success,
  superRefine: () => superRefine,
  symbol: () => symbol15,
  templateLiteral: () => templateLiteral,
  toJSONSchema: () => toJSONSchema,
  toLowerCase: () => _toLowerCase,
  toUpperCase: () => _toUpperCase,
  transform: () => transform,
  treeifyError: () => treeifyError,
  trim: () => _trim,
  tuple: () => tuple,
  uint32: () => uint32,
  uint64: () => uint64,
  ulid: () => ulid2,
  undefined: () => _undefined3,
  union: () => union,
  unknown: () => unknown,
  uppercase: () => _uppercase,
  url: () => url,
  util: () => util_exports,
  uuid: () => uuid2,
  uuidv4: () => uuidv4,
  uuidv6: () => uuidv6,
  uuidv7: () => uuidv7,
  void: () => _void2,
  xid: () => xid2
});

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/index.js
var core_exports2 = {};
__export(core_exports2, {
  \$ZodAny: () => \$ZodAny,
  \$ZodArray: () => \$ZodArray,
  \$ZodAsyncError: () => \$ZodAsyncError,
  \$ZodBase64: () => \$ZodBase64,
  \$ZodBase64URL: () => \$ZodBase64URL,
  \$ZodBigInt: () => \$ZodBigInt,
  \$ZodBigIntFormat: () => \$ZodBigIntFormat,
  \$ZodBoolean: () => \$ZodBoolean,
  \$ZodCIDRv4: () => \$ZodCIDRv4,
  \$ZodCIDRv6: () => \$ZodCIDRv6,
  \$ZodCUID: () => \$ZodCUID,
  \$ZodCUID2: () => \$ZodCUID2,
  \$ZodCatch: () => \$ZodCatch,
  \$ZodCheck: () => \$ZodCheck,
  \$ZodCheckBigIntFormat: () => \$ZodCheckBigIntFormat,
  \$ZodCheckEndsWith: () => \$ZodCheckEndsWith,
  \$ZodCheckGreaterThan: () => \$ZodCheckGreaterThan,
  \$ZodCheckIncludes: () => \$ZodCheckIncludes,
  \$ZodCheckLengthEquals: () => \$ZodCheckLengthEquals,
  \$ZodCheckLessThan: () => \$ZodCheckLessThan,
  \$ZodCheckLowerCase: () => \$ZodCheckLowerCase,
  \$ZodCheckMaxLength: () => \$ZodCheckMaxLength,
  \$ZodCheckMaxSize: () => \$ZodCheckMaxSize,
  \$ZodCheckMimeType: () => \$ZodCheckMimeType,
  \$ZodCheckMinLength: () => \$ZodCheckMinLength,
  \$ZodCheckMinSize: () => \$ZodCheckMinSize,
  \$ZodCheckMultipleOf: () => \$ZodCheckMultipleOf,
  \$ZodCheckNumberFormat: () => \$ZodCheckNumberFormat,
  \$ZodCheckOverwrite: () => \$ZodCheckOverwrite,
  \$ZodCheckProperty: () => \$ZodCheckProperty,
  \$ZodCheckRegex: () => \$ZodCheckRegex,
  \$ZodCheckSizeEquals: () => \$ZodCheckSizeEquals,
  \$ZodCheckStartsWith: () => \$ZodCheckStartsWith,
  \$ZodCheckStringFormat: () => \$ZodCheckStringFormat,
  \$ZodCheckUpperCase: () => \$ZodCheckUpperCase,
  \$ZodCodec: () => \$ZodCodec,
  \$ZodCustom: () => \$ZodCustom,
  \$ZodCustomStringFormat: () => \$ZodCustomStringFormat,
  \$ZodDate: () => \$ZodDate,
  \$ZodDefault: () => \$ZodDefault,
  \$ZodDiscriminatedUnion: () => \$ZodDiscriminatedUnion,
  \$ZodE164: () => \$ZodE164,
  \$ZodEmail: () => \$ZodEmail,
  \$ZodEmoji: () => \$ZodEmoji,
  \$ZodEncodeError: () => \$ZodEncodeError,
  \$ZodEnum: () => \$ZodEnum,
  \$ZodError: () => \$ZodError,
  \$ZodFile: () => \$ZodFile,
  \$ZodFunction: () => \$ZodFunction,
  \$ZodGUID: () => \$ZodGUID,
  \$ZodIPv4: () => \$ZodIPv4,
  \$ZodIPv6: () => \$ZodIPv6,
  \$ZodISODate: () => \$ZodISODate,
  \$ZodISODateTime: () => \$ZodISODateTime,
  \$ZodISODuration: () => \$ZodISODuration,
  \$ZodISOTime: () => \$ZodISOTime,
  \$ZodIntersection: () => \$ZodIntersection,
  \$ZodJWT: () => \$ZodJWT,
  \$ZodKSUID: () => \$ZodKSUID,
  \$ZodLazy: () => \$ZodLazy,
  \$ZodLiteral: () => \$ZodLiteral,
  \$ZodMap: () => \$ZodMap,
  \$ZodNaN: () => \$ZodNaN,
  \$ZodNanoID: () => \$ZodNanoID,
  \$ZodNever: () => \$ZodNever,
  \$ZodNonOptional: () => \$ZodNonOptional,
  \$ZodNull: () => \$ZodNull,
  \$ZodNullable: () => \$ZodNullable,
  \$ZodNumber: () => \$ZodNumber,
  \$ZodNumberFormat: () => \$ZodNumberFormat,
  \$ZodObject: () => \$ZodObject,
  \$ZodObjectJIT: () => \$ZodObjectJIT,
  \$ZodOptional: () => \$ZodOptional,
  \$ZodPipe: () => \$ZodPipe,
  \$ZodPrefault: () => \$ZodPrefault,
  \$ZodPromise: () => \$ZodPromise,
  \$ZodReadonly: () => \$ZodReadonly,
  \$ZodRealError: () => \$ZodRealError,
  \$ZodRecord: () => \$ZodRecord,
  \$ZodRegistry: () => \$ZodRegistry,
  \$ZodSet: () => \$ZodSet,
  \$ZodString: () => \$ZodString,
  \$ZodStringFormat: () => \$ZodStringFormat,
  \$ZodSuccess: () => \$ZodSuccess,
  \$ZodSymbol: () => \$ZodSymbol,
  \$ZodTemplateLiteral: () => \$ZodTemplateLiteral,
  \$ZodTransform: () => \$ZodTransform,
  \$ZodTuple: () => \$ZodTuple,
  \$ZodType: () => \$ZodType,
  \$ZodULID: () => \$ZodULID,
  \$ZodURL: () => \$ZodURL,
  \$ZodUUID: () => \$ZodUUID,
  \$ZodUndefined: () => \$ZodUndefined,
  \$ZodUnion: () => \$ZodUnion,
  \$ZodUnknown: () => \$ZodUnknown,
  \$ZodVoid: () => \$ZodVoid,
  \$ZodXID: () => \$ZodXID,
  \$brand: () => \$brand,
  \$constructor: () => \$constructor,
  \$input: () => \$input,
  \$output: () => \$output,
  Doc: () => Doc,
  JSONSchema: () => json_schema_exports,
  JSONSchemaGenerator: () => JSONSchemaGenerator,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  _any: () => _any,
  _array: () => _array,
  _base64: () => _base64,
  _base64url: () => _base64url,
  _bigint: () => _bigint,
  _boolean: () => _boolean,
  _catch: () => _catch,
  _check: () => _check,
  _cidrv4: () => _cidrv4,
  _cidrv6: () => _cidrv6,
  _coercedBigint: () => _coercedBigint,
  _coercedBoolean: () => _coercedBoolean,
  _coercedDate: () => _coercedDate,
  _coercedNumber: () => _coercedNumber,
  _coercedString: () => _coercedString,
  _cuid: () => _cuid,
  _cuid2: () => _cuid2,
  _custom: () => _custom,
  _date: () => _date,
  _decode: () => _decode,
  _decodeAsync: () => _decodeAsync,
  _default: () => _default,
  _discriminatedUnion: () => _discriminatedUnion,
  _e164: () => _e164,
  _email: () => _email,
  _emoji: () => _emoji2,
  _encode: () => _encode,
  _encodeAsync: () => _encodeAsync,
  _endsWith: () => _endsWith,
  _enum: () => _enum,
  _file: () => _file,
  _float32: () => _float32,
  _float64: () => _float64,
  _gt: () => _gt,
  _gte: () => _gte,
  _guid: () => _guid,
  _includes: () => _includes,
  _int: () => _int,
  _int32: () => _int32,
  _int64: () => _int64,
  _intersection: () => _intersection,
  _ipv4: () => _ipv4,
  _ipv6: () => _ipv6,
  _isoDate: () => _isoDate,
  _isoDateTime: () => _isoDateTime,
  _isoDuration: () => _isoDuration,
  _isoTime: () => _isoTime,
  _jwt: () => _jwt,
  _ksuid: () => _ksuid,
  _lazy: () => _lazy,
  _length: () => _length,
  _literal: () => _literal,
  _lowercase: () => _lowercase,
  _lt: () => _lt,
  _lte: () => _lte,
  _map: () => _map,
  _max: () => _lte,
  _maxLength: () => _maxLength,
  _maxSize: () => _maxSize,
  _mime: () => _mime,
  _min: () => _gte,
  _minLength: () => _minLength,
  _minSize: () => _minSize,
  _multipleOf: () => _multipleOf,
  _nan: () => _nan,
  _nanoid: () => _nanoid,
  _nativeEnum: () => _nativeEnum,
  _negative: () => _negative,
  _never: () => _never,
  _nonnegative: () => _nonnegative,
  _nonoptional: () => _nonoptional,
  _nonpositive: () => _nonpositive,
  _normalize: () => _normalize,
  _null: () => _null2,
  _nullable: () => _nullable,
  _number: () => _number,
  _optional: () => _optional,
  _overwrite: () => _overwrite,
  _parse: () => _parse,
  _parseAsync: () => _parseAsync,
  _pipe: () => _pipe,
  _positive: () => _positive,
  _promise: () => _promise,
  _property: () => _property,
  _readonly: () => _readonly,
  _record: () => _record,
  _refine: () => _refine,
  _regex: () => _regex,
  _safeDecode: () => _safeDecode,
  _safeDecodeAsync: () => _safeDecodeAsync,
  _safeEncode: () => _safeEncode,
  _safeEncodeAsync: () => _safeEncodeAsync,
  _safeParse: () => _safeParse,
  _safeParseAsync: () => _safeParseAsync,
  _set: () => _set,
  _size: () => _size,
  _startsWith: () => _startsWith,
  _string: () => _string,
  _stringFormat: () => _stringFormat,
  _stringbool: () => _stringbool,
  _success: () => _success,
  _superRefine: () => _superRefine,
  _symbol: () => _symbol,
  _templateLiteral: () => _templateLiteral,
  _toLowerCase: () => _toLowerCase,
  _toUpperCase: () => _toUpperCase,
  _transform: () => _transform,
  _trim: () => _trim,
  _tuple: () => _tuple,
  _uint32: () => _uint32,
  _uint64: () => _uint64,
  _ulid: () => _ulid,
  _undefined: () => _undefined2,
  _union: () => _union,
  _unknown: () => _unknown,
  _uppercase: () => _uppercase,
  _url: () => _url,
  _uuid: () => _uuid,
  _uuidv4: () => _uuidv4,
  _uuidv6: () => _uuidv6,
  _uuidv7: () => _uuidv7,
  _void: () => _void,
  _xid: () => _xid,
  clone: () => clone,
  config: () => config,
  decode: () => decode,
  decodeAsync: () => decodeAsync,
  encode: () => encode,
  encodeAsync: () => encodeAsync,
  flattenError: () => flattenError,
  formatError: () => formatError,
  globalConfig: () => globalConfig,
  globalRegistry: () => globalRegistry,
  isValidBase64: () => isValidBase64,
  isValidBase64URL: () => isValidBase64URL,
  isValidJWT: () => isValidJWT,
  locales: () => locales_exports,
  parse: () => parse,
  parseAsync: () => parseAsync,
  prettifyError: () => prettifyError,
  regexes: () => regexes_exports,
  registry: () => registry,
  safeDecode: () => safeDecode,
  safeDecodeAsync: () => safeDecodeAsync,
  safeEncode: () => safeEncode,
  safeEncodeAsync: () => safeEncodeAsync,
  safeParse: () => safeParse,
  safeParseAsync: () => safeParseAsync,
  toDotPath: () => toDotPath,
  toJSONSchema: () => toJSONSchema,
  treeifyError: () => treeifyError,
  util: () => util_exports,
  version: () => version
});

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/core.js
var NEVER = Object.freeze({
  status: "aborted"
});
// @__NO_SIDE_EFFECTS__
function \$constructor(name17, initializer3, params) {
  function init(inst, def) {
    var _a17;
    Object.defineProperty(inst, "_zod", {
      value: inst._zod ?? {},
      enumerable: false
    });
    (_a17 = inst._zod).traits ?? (_a17.traits = /* @__PURE__ */ new Set());
    inst._zod.traits.add(name17);
    initializer3(inst, def);
    for (const k in _.prototype) {
      if (!(k in inst)) Object.defineProperty(inst, k, {
        value: _.prototype[k].bind(inst)
      });
    }
    inst._zod.constr = _;
    inst._zod.def = def;
  }
  __name(init, "init");
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
    static {
      __name(this, "Definition");
    }
  }
  Object.defineProperty(Definition, "name", {
    value: name17
  });
  function _(def) {
    var _a17;
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    (_a17 = inst._zod).deferred ?? (_a17.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  __name(_, "_");
  Object.defineProperty(_, "init", {
    value: init
  });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: /* @__PURE__ */ __name((inst) => {
      if (params?.Parent && inst instanceof params.Parent) return true;
      return inst?._zod?.traits?.has(name17);
    }, "value")
  });
  Object.defineProperty(_, "name", {
    value: name17
  });
  return _;
}
__name(\$constructor, "\$constructor");
var \$brand = Symbol("zod_brand");
var \$ZodAsyncError = class extends Error {
  static {
    __name(this, "\$ZodAsyncError");
  }
  constructor() {
    super(\`Encountered Promise during synchronous parse. Use .parseAsync() instead.\`);
  }
};
var \$ZodEncodeError = class extends Error {
  static {
    __name(this, "\$ZodEncodeError");
  }
  constructor(name17) {
    super(\`Encountered unidirectional transform during encode: \${name17}\`);
    this.name = "ZodEncodeError";
  }
};
var globalConfig = {};
function config(newConfig) {
  if (newConfig) Object.assign(globalConfig, newConfig);
  return globalConfig;
}
__name(config, "config");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/util.js
var util_exports = {};
__export(util_exports, {
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES,
  Class: () => Class,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  aborted: () => aborted,
  allowsEval: () => allowsEval,
  assert: () => assert,
  assertEqual: () => assertEqual,
  assertIs: () => assertIs,
  assertNever: () => assertNever,
  assertNotEqual: () => assertNotEqual,
  assignProp: () => assignProp,
  base64ToUint8Array: () => base64ToUint8Array,
  base64urlToUint8Array: () => base64urlToUint8Array,
  cached: () => cached,
  captureStackTrace: () => captureStackTrace,
  cleanEnum: () => cleanEnum,
  cleanRegex: () => cleanRegex,
  clone: () => clone,
  cloneDef: () => cloneDef,
  createTransparentProxy: () => createTransparentProxy,
  defineLazy: () => defineLazy,
  esc: () => esc,
  escapeRegex: () => escapeRegex,
  extend: () => extend,
  finalizeIssue: () => finalizeIssue,
  floatSafeRemainder: () => floatSafeRemainder,
  getElementAtPath: () => getElementAtPath,
  getEnumValues: () => getEnumValues,
  getLengthableOrigin: () => getLengthableOrigin,
  getParsedType: () => getParsedType,
  getSizableOrigin: () => getSizableOrigin,
  hexToUint8Array: () => hexToUint8Array,
  isObject: () => isObject,
  isPlainObject: () => isPlainObject,
  issue: () => issue,
  joinValues: () => joinValues,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  merge: () => merge,
  mergeDefs: () => mergeDefs,
  normalizeParams: () => normalizeParams,
  nullish: () => nullish,
  numKeys: () => numKeys,
  objectClone: () => objectClone,
  omit: () => omit,
  optionalKeys: () => optionalKeys,
  partial: () => partial,
  pick: () => pick,
  prefixIssues: () => prefixIssues,
  primitiveTypes: () => primitiveTypes,
  promiseAllObject: () => promiseAllObject,
  propertyKeyTypes: () => propertyKeyTypes,
  randomString: () => randomString,
  required: () => required,
  safeExtend: () => safeExtend,
  shallowClone: () => shallowClone,
  stringifyPrimitive: () => stringifyPrimitive,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToHex: () => uint8ArrayToHex,
  unwrapMessage: () => unwrapMessage
});
function assertEqual(val) {
  return val;
}
__name(assertEqual, "assertEqual");
function assertNotEqual(val) {
  return val;
}
__name(assertNotEqual, "assertNotEqual");
function assertIs(_arg) {
}
__name(assertIs, "assertIs");
function assertNever(_x) {
  throw new Error();
}
__name(assertNever, "assertNever");
function assert(_) {
}
__name(assert, "assert");
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
__name(getEnumValues, "getEnumValues");
function joinValues(array2, separator = "|") {
  return array2.map((val) => stringifyPrimitive(val)).join(separator);
}
__name(joinValues, "joinValues");
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint") return value.toString();
  return value;
}
__name(jsonStringifyReplacer, "jsonStringifyReplacer");
function cached(getter) {
  const set2 = false;
  return {
    get value() {
      if (!set2) {
        const value = getter();
        Object.defineProperty(this, "value", {
          value
        });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
__name(cached, "cached");
function nullish(input) {
  return input === null || input === void 0;
}
__name(nullish, "nullish");
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("\$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
__name(cleanRegex, "cleanRegex");
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\\d?e-\\d?/.test(stepString)) {
    const match = stepString.match(/\\d?e-(\\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
__name(floatSafeRemainder, "floatSafeRemainder");
var EVALUATING = Symbol("evaluating");
function defineLazy(object3, key, getter) {
  let value = void 0;
  Object.defineProperty(object3, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object3, key, {
        value: v
      });
    },
    configurable: true
  });
}
__name(defineLazy, "defineLazy");
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
__name(objectClone, "objectClone");
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
__name(assignProp, "assignProp");
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
__name(mergeDefs, "mergeDefs");
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
__name(cloneDef, "cloneDef");
function getElementAtPath(obj, path) {
  if (!path) return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
__name(getElementAtPath, "getElementAtPath");
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0; i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
__name(promiseAllObject, "promiseAllObject");
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0; i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
__name(randomString, "randomString");
function esc(str) {
  return JSON.stringify(str);
}
__name(esc, "esc");
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
__name(isObject, "isObject");
var allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false) return false;
  const ctor = o.constructor;
  if (ctor === void 0) return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false) return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
__name(isPlainObject, "isPlainObject");
function shallowClone(o) {
  if (isPlainObject(o)) return {
    ...o
  };
  if (Array.isArray(o)) return [
    ...o
  ];
  return o;
}
__name(shallowClone, "shallowClone");
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
__name(numKeys, "numKeys");
var getParsedType = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(\`Unknown data type: \${t}\`);
  }
}, "getParsedType");
var propertyKeyTypes = /* @__PURE__ */ new Set([
  "string",
  "number",
  "symbol"
]);
var primitiveTypes = /* @__PURE__ */ new Set([
  "string",
  "number",
  "bigint",
  "boolean",
  "symbol",
  "undefined"
]);
function escapeRegex(str) {
  return str.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\\$&");
}
__name(escapeRegex, "escapeRegex");
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent) cl._zod.parent = inst;
  return cl;
}
__name(clone, "clone");
function normalizeParams(_params) {
  const params = _params;
  if (!params) return {};
  if (typeof params === "string") return {
    error: /* @__PURE__ */ __name(() => params, "error")
  };
  if (params?.message !== void 0) {
    if (params?.error !== void 0) throw new Error("Cannot specify both \`message\` and \`error\` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string") return {
    ...params,
    error: /* @__PURE__ */ __name(() => params.error, "error")
  };
  return params;
}
__name(normalizeParams, "normalizeParams");
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
__name(createTransparentProxy, "createTransparentProxy");
function stringifyPrimitive(value) {
  if (typeof value === "bigint") return value.toString() + "n";
  if (typeof value === "string") return \`"\${value}"\`;
  return \`\${value}\`;
}
__name(stringifyPrimitive, "stringifyPrimitive");
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
__name(optionalKeys, "optionalKeys");
var NUMBER_FORMAT_RANGES = {
  safeint: [
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  ],
  int32: [
    -2147483648,
    2147483647
  ],
  uint32: [
    0,
    4294967295
  ],
  float32: [
    -34028234663852886e22,
    34028234663852886e22
  ],
  float64: [
    -Number.MAX_VALUE,
    Number.MAX_VALUE
  ]
};
var BIGINT_FORMAT_RANGES = {
  int64: [
    /* @__PURE__ */ BigInt("-9223372036854775808"),
    /* @__PURE__ */ BigInt("9223372036854775807")
  ],
  uint64: [
    /* @__PURE__ */ BigInt(0),
    /* @__PURE__ */ BigInt("18446744073709551615")
  ]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(\`Unrecognized key: "\${key}"\`);
        }
        if (!mask[key]) continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
__name(pick, "pick");
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {
        ...schema._zod.def.shape
      };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(\`Unrecognized key: "\${key}"\`);
        }
        if (!mask[key]) continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
__name(omit, "omit");
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error("Object schemas containing refinements cannot be extended. Use \`.safeExtend()\` instead.");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = {
        ...schema._zod.def.shape,
        ...shape
      };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: []
  });
  return clone(schema, def);
}
__name(extend, "extend");
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = {
    ...schema._zod.def,
    get shape() {
      const _shape = {
        ...schema._zod.def.shape,
        ...shape
      };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: schema._zod.def.checks
  };
  return clone(schema, def);
}
__name(safeExtend, "safeExtend");
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = {
        ...a._zod.def.shape,
        ...b._zod.def.shape
      };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
  });
  return clone(a, def);
}
__name(merge, "merge");
function partial(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = {
        ...oldShape
      };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(\`Unrecognized key: "\${key}"\`);
          }
          if (!mask[key]) continue;
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
__name(partial, "partial");
function required(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = {
        ...oldShape
      };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(\`Unrecognized key: "\${key}"\`);
          }
          if (!mask[key]) continue;
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
__name(required, "required");
function aborted(x, startIndex = 0) {
  if (x.aborted === true) return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
__name(aborted, "aborted");
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a17;
    (_a17 = iss).path ?? (_a17.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
__name(prefixIssues, "prefixIssues");
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
__name(unwrapMessage, "unwrapMessage");
function finalizeIssue(iss, ctx, config2) {
  const full = {
    ...iss,
    path: iss.path ?? []
  };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
__name(finalizeIssue, "finalizeIssue");
function getSizableOrigin(input) {
  if (input instanceof Set) return "set";
  if (input instanceof Map) return "map";
  if (input instanceof File) return "file";
  return "unknown";
}
__name(getSizableOrigin, "getSizableOrigin");
function getLengthableOrigin(input) {
  if (Array.isArray(input)) return "array";
  if (typeof input === "string") return "string";
  return "unknown";
}
__name(getLengthableOrigin, "getLengthableOrigin");
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return {
    ...iss
  };
}
__name(issue, "issue");
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
__name(cleanEnum, "cleanEnum");
function base64ToUint8Array(base643) {
  const binaryString = atob(base643);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
__name(base64ToUint8Array, "base64ToUint8Array");
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
__name(uint8ArrayToBase64, "uint8ArrayToBase64");
function base64urlToUint8Array(base64url3) {
  const base643 = base64url3.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base643.length % 4) % 4);
  return base64ToUint8Array(base643 + padding);
}
__name(base64urlToUint8Array, "base64urlToUint8Array");
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=/g, "");
}
__name(uint8ArrayToBase64url, "uint8ArrayToBase64url");
function hexToUint8Array(hex3) {
  const cleanHex = hex3.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
__name(hexToUint8Array, "hexToUint8Array");
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(uint8ArrayToHex, "uint8ArrayToHex");
var Class = class {
  static {
    __name(this, "Class");
  }
  constructor(..._args) {
  }
};

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/errors.js
var initializer = /* @__PURE__ */ __name((inst, def) => {
  inst.name = "\$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: /* @__PURE__ */ __name(() => inst.message, "value"),
    enumerable: false
  });
}, "initializer");
var \$ZodError = \$constructor("\$ZodError", initializer);
var \$ZodRealError = \$constructor("\$ZodError", initializer, {
  Parent: Error
});
function flattenError(error45, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error45.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return {
    formErrors,
    fieldErrors
  };
}
__name(flattenError, "flattenError");
function formatError(error45, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const fieldErrors = {
    _errors: []
  };
  const processError = /* @__PURE__ */ __name((error46) => {
    for (const issue2 of error46.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({
          issues
        }));
      } else if (issue2.code === "invalid_key") {
        processError({
          issues: issue2.issues
        });
      } else if (issue2.code === "invalid_element") {
        processError({
          issues: issue2.issues
        });
      } else if (issue2.path.length === 0) {
        fieldErrors._errors.push(mapper(issue2));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue2.path.length) {
          const el = issue2.path[i];
          const terminal = i === issue2.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || {
              _errors: []
            };
          } else {
            curr[el] = curr[el] || {
              _errors: []
            };
            curr[el]._errors.push(mapper(issue2));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  }, "processError");
  processError(error45);
  return fieldErrors;
}
__name(formatError, "formatError");
function treeifyError(error45, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const result = {
    errors: []
  };
  const processError = /* @__PURE__ */ __name((error46, path = []) => {
    var _a17, _b8;
    for (const issue2 of error46.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({
          issues
        }, issue2.path));
      } else if (issue2.code === "invalid_key") {
        processError({
          issues: issue2.issues
        }, issue2.path);
      } else if (issue2.code === "invalid_element") {
        processError({
          issues: issue2.issues
        }, issue2.path);
      } else {
        const fullpath = [
          ...path,
          ...issue2.path
        ];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue2));
          continue;
        }
        let curr = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i];
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ?? (curr.properties = {});
            (_a17 = curr.properties)[el] ?? (_a17[el] = {
              errors: []
            });
            curr = curr.properties[el];
          } else {
            curr.items ?? (curr.items = []);
            (_b8 = curr.items)[el] ?? (_b8[el] = {
              errors: []
            });
            curr = curr.items[el];
          }
          if (terminal) {
            curr.errors.push(mapper(issue2));
          }
          i++;
        }
      }
    }
  }, "processError");
  processError(error45);
  return result;
}
__name(treeifyError, "treeifyError");
function toDotPath(_path) {
  const segs = [];
  const path = _path.map((seg) => typeof seg === "object" ? seg.key : seg);
  for (const seg of path) {
    if (typeof seg === "number") segs.push(\`[\${seg}]\`);
    else if (typeof seg === "symbol") segs.push(\`[\${JSON.stringify(String(seg))}]\`);
    else if (/[^\\w\$]/.test(seg)) segs.push(\`[\${JSON.stringify(seg)}]\`);
    else {
      if (segs.length) segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}
__name(toDotPath, "toDotPath");
function prettifyError(error45) {
  const lines = [];
  const issues = [
    ...error45.issues
  ].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue2 of issues) {
    lines.push(\`\\u2716 \${issue2.message}\`);
    if (issue2.path?.length) lines.push(\`  \\u2192 at \${toDotPath(issue2.path)}\`);
  }
  return lines.join("\\n");
}
__name(prettifyError, "prettifyError");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/parse.js
var _parse = /* @__PURE__ */ __name((_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    async: false
  }) : {
    async: false
  };
  const result = schema._zod.run({
    value,
    issues: []
  }, ctx);
  if (result instanceof Promise) {
    throw new \$ZodAsyncError();
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
}, "_parse");
var parse = /* @__PURE__ */ _parse(\$ZodRealError);
var _parseAsync = /* @__PURE__ */ __name((_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    async: true
  }) : {
    async: true
  };
  let result = schema._zod.run({
    value,
    issues: []
  }, ctx);
  if (result instanceof Promise) result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
}, "_parseAsync");
var parseAsync = /* @__PURE__ */ _parseAsync(\$ZodRealError);
var _safeParse = /* @__PURE__ */ __name((_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? {
    ..._ctx,
    async: false
  } : {
    async: false
  };
  const result = schema._zod.run({
    value,
    issues: []
  }, ctx);
  if (result instanceof Promise) {
    throw new \$ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? \$ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : {
    success: true,
    data: result.value
  };
}, "_safeParse");
var safeParse = /* @__PURE__ */ _safeParse(\$ZodRealError);
var _safeParseAsync = /* @__PURE__ */ __name((_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    async: true
  }) : {
    async: true
  };
  let result = schema._zod.run({
    value,
    issues: []
  }, ctx);
  if (result instanceof Promise) result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : {
    success: true,
    data: result.value
  };
}, "_safeParseAsync");
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(\$ZodRealError);
var _encode = /* @__PURE__ */ __name((_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    direction: "backward"
  }) : {
    direction: "backward"
  };
  return _parse(_Err)(schema, value, ctx);
}, "_encode");
var encode = /* @__PURE__ */ _encode(\$ZodRealError);
var _decode = /* @__PURE__ */ __name((_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
}, "_decode");
var decode = /* @__PURE__ */ _decode(\$ZodRealError);
var _encodeAsync = /* @__PURE__ */ __name((_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    direction: "backward"
  }) : {
    direction: "backward"
  };
  return _parseAsync(_Err)(schema, value, ctx);
}, "_encodeAsync");
var encodeAsync = /* @__PURE__ */ _encodeAsync(\$ZodRealError);
var _decodeAsync = /* @__PURE__ */ __name((_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
}, "_decodeAsync");
var decodeAsync = /* @__PURE__ */ _decodeAsync(\$ZodRealError);
var _safeEncode = /* @__PURE__ */ __name((_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    direction: "backward"
  }) : {
    direction: "backward"
  };
  return _safeParse(_Err)(schema, value, ctx);
}, "_safeEncode");
var safeEncode = /* @__PURE__ */ _safeEncode(\$ZodRealError);
var _safeDecode = /* @__PURE__ */ __name((_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
}, "_safeDecode");
var safeDecode = /* @__PURE__ */ _safeDecode(\$ZodRealError);
var _safeEncodeAsync = /* @__PURE__ */ __name((_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, {
    direction: "backward"
  }) : {
    direction: "backward"
  };
  return _safeParseAsync(_Err)(schema, value, ctx);
}, "_safeEncodeAsync");
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(\$ZodRealError);
var _safeDecodeAsync = /* @__PURE__ */ __name((_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
}, "_safeDecodeAsync");
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(\$ZodRealError);

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/regexes.js
var regexes_exports = {};
__export(regexes_exports, {
  base64: () => base64,
  base64url: () => base64url,
  bigint: () => bigint,
  boolean: () => boolean,
  browserEmail: () => browserEmail,
  cidrv4: () => cidrv4,
  cidrv6: () => cidrv6,
  cuid: () => cuid,
  cuid2: () => cuid2,
  date: () => date,
  datetime: () => datetime,
  domain: () => domain,
  duration: () => duration,
  e164: () => e164,
  email: () => email,
  emoji: () => emoji,
  extendedDuration: () => extendedDuration,
  guid: () => guid,
  hex: () => hex,
  hostname: () => hostname,
  html5Email: () => html5Email,
  idnEmail: () => idnEmail,
  integer: () => integer,
  ipv4: () => ipv4,
  ipv6: () => ipv6,
  ksuid: () => ksuid,
  lowercase: () => lowercase,
  md5_base64: () => md5_base64,
  md5_base64url: () => md5_base64url,
  md5_hex: () => md5_hex,
  nanoid: () => nanoid,
  null: () => _null,
  number: () => number,
  rfc5322Email: () => rfc5322Email,
  sha1_base64: () => sha1_base64,
  sha1_base64url: () => sha1_base64url,
  sha1_hex: () => sha1_hex,
  sha256_base64: () => sha256_base64,
  sha256_base64url: () => sha256_base64url,
  sha256_hex: () => sha256_hex,
  sha384_base64: () => sha384_base64,
  sha384_base64url: () => sha384_base64url,
  sha384_hex: () => sha384_hex,
  sha512_base64: () => sha512_base64,
  sha512_base64url: () => sha512_base64url,
  sha512_hex: () => sha512_hex,
  string: () => string,
  time: () => time,
  ulid: () => ulid,
  undefined: () => _undefined,
  unicodeEmail: () => unicodeEmail,
  uppercase: () => uppercase,
  uuid: () => uuid,
  uuid4: () => uuid4,
  uuid6: () => uuid6,
  uuid7: () => uuid7,
  xid: () => xid
});
var cuid = /^[cC][^\\s-]{8,}\$/;
var cuid2 = /^[0-9a-z]+\$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}\$/;
var xid = /^[0-9a-vA-V]{20}\$/;
var ksuid = /^[A-Za-z0-9]{27}\$/;
var nanoid = /^[a-zA-Z0-9_-]{21}\$/;
var duration = /^P(?:(\\d+W)|(?!.*W)(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+([.,]\\d+)?S)?)?)\$/;
var extendedDuration = /^[-+]?P(?!\$)(?:(?:[-+]?\\d+Y)|(?:[-+]?\\d+[.,]\\d+Y\$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M\$))?(?:(?:[-+]?\\d+W)|(?:[-+]?\\d+[.,]\\d+W\$))?(?:(?:[-+]?\\d+D)|(?:[-+]?\\d+[.,]\\d+D\$))?(?:T(?=[\\d+-])(?:(?:[-+]?\\d+H)|(?:[-+]?\\d+[.,]\\d+H\$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M\$))?(?:[-+]?\\d+(?:[.,]\\d+)?S)?)??\$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\$/;
var uuid = /* @__PURE__ */ __name((version2) => {
  if (!version2) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$/;
  return new RegExp(\`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-\${version2}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\$\`);
}, "uuid");
var uuid4 = /* @__PURE__ */ uuid(4);
var uuid6 = /* @__PURE__ */ uuid(6);
var uuid7 = /* @__PURE__ */ uuid(7);
var email = /^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}\$/;
var html5Email = /^[a-zA-Z0-9.!#\$%&'*+/=?^_\`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\$/;
var rfc5322Email = /^(([^<>()\\[\\]\\\\.,;:\\s@"]+(\\.[^<>()\\[\\]\\\\.,;:\\s@"]+)*)|(".+"))@((\\[[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}])|(([a-zA-Z\\-0-9]+\\.)+[a-zA-Z]{2,}))\$/;
var unicodeEmail = /^[^\\s@"]{1,64}@[^\\s@]{1,255}\$/u;
var idnEmail = unicodeEmail;
var browserEmail = /^[a-zA-Z0-9.!#\$%&'*+/=?^_\`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\$/;
var _emoji = \`^(\\\\p{Extended_Pictographic}|\\\\p{Emoji_Component})+\$\`;
function emoji() {
  return new RegExp(_emoji, "u");
}
__name(emoji, "emoji");
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/([0-9]|[1-2][0-9]|3[0-2])\$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])\$/;
var base64 = /^\$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?\$/;
var base64url = /^[A-Za-z0-9_-]*\$/;
var hostname = /^(?=.{1,253}\\.?\$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?\$/;
var domain = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}\$/;
var e164 = /^\\+(?:[0-9]){6,14}[0-9]\$/;
var dateSource = \`(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))\`;
var date = /* @__PURE__ */ new RegExp(\`^\${dateSource}\$\`);
function timeSource(args) {
  const hhmm = \`(?:[01]\\\\d|2[0-3]):[0-5]\\\\d\`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? \`\${hhmm}\` : args.precision === 0 ? \`\${hhmm}:[0-5]\\\\d\` : \`\${hhmm}:[0-5]\\\\d\\\\.\\\\d{\${args.precision}}\` : \`\${hhmm}(?::[0-5]\\\\d(?:\\\\.\\\\d+)?)?\`;
  return regex;
}
__name(timeSource, "timeSource");
function time(args) {
  return new RegExp(\`^\${timeSource(args)}\$\`);
}
__name(time, "time");
function datetime(args) {
  const time3 = timeSource({
    precision: args.precision
  });
  const opts = [
    "Z"
  ];
  if (args.local) opts.push("");
  if (args.offset) opts.push(\`([+-](?:[01]\\\\d|2[0-3]):[0-5]\\\\d)\`);
  const timeRegex2 = \`\${time3}(?:\${opts.join("|")})\`;
  return new RegExp(\`^\${dateSource}T(?:\${timeRegex2})\$\`);
}
__name(datetime, "datetime");
var string = /* @__PURE__ */ __name((params) => {
  const regex = params ? \`[\\\\s\\\\S]{\${params?.minimum ?? 0},\${params?.maximum ?? ""}}\` : \`[\\\\s\\\\S]*\`;
  return new RegExp(\`^\${regex}\$\`);
}, "string");
var bigint = /^-?\\d+n?\$/;
var integer = /^-?\\d+\$/;
var number = /^-?\\d+(?:\\.\\d+)?/;
var boolean = /^(?:true|false)\$/i;
var _null = /^null\$/i;
var _undefined = /^undefined\$/i;
var lowercase = /^[^A-Z]*\$/;
var uppercase = /^[^a-z]*\$/;
var hex = /^[0-9a-fA-F]*\$/;
function fixedBase64(bodyLength, padding) {
  return new RegExp(\`^[A-Za-z0-9+/]{\${bodyLength}}\${padding}\$\`);
}
__name(fixedBase64, "fixedBase64");
function fixedBase64url(length) {
  return new RegExp(\`^[A-Za-z0-9_-]{\${length}}\$\`);
}
__name(fixedBase64url, "fixedBase64url");
var md5_hex = /^[0-9a-fA-F]{32}\$/;
var md5_base64 = /* @__PURE__ */ fixedBase64(22, "==");
var md5_base64url = /* @__PURE__ */ fixedBase64url(22);
var sha1_hex = /^[0-9a-fA-F]{40}\$/;
var sha1_base64 = /* @__PURE__ */ fixedBase64(27, "=");
var sha1_base64url = /* @__PURE__ */ fixedBase64url(27);
var sha256_hex = /^[0-9a-fA-F]{64}\$/;
var sha256_base64 = /* @__PURE__ */ fixedBase64(43, "=");
var sha256_base64url = /* @__PURE__ */ fixedBase64url(43);
var sha384_hex = /^[0-9a-fA-F]{96}\$/;
var sha384_base64 = /* @__PURE__ */ fixedBase64(64, "");
var sha384_base64url = /* @__PURE__ */ fixedBase64url(64);
var sha512_hex = /^[0-9a-fA-F]{128}\$/;
var sha512_base64 = /* @__PURE__ */ fixedBase64(86, "==");
var sha512_base64url = /* @__PURE__ */ fixedBase64url(86);

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/checks.js
var \$ZodCheck = /* @__PURE__ */ \$constructor("\$ZodCheck", (inst, def) => {
  var _a17;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a17 = inst._zod).onattach ?? (_a17.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var \$ZodCheckLessThan = /* @__PURE__ */ \$constructor("\$ZodCheckLessThan", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive) bag.maximum = def.value;
      else bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckGreaterThan = /* @__PURE__ */ \$constructor("\$ZodCheckGreaterThan", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive) bag.minimum = def.value;
      else bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckMultipleOf = /* @__PURE__ */ \$constructor("\$ZodCheckMultipleOf", (inst, def) => {
  \$ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a17;
    (_a17 = inst2._zod.bag).multipleOf ?? (_a17.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple) return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckNumberFormat = /* @__PURE__ */ \$constructor("\$ZodCheckNumberFormat", (inst, def) => {
  \$ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt) bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var \$ZodCheckBigIntFormat = /* @__PURE__ */ \$constructor("\$ZodCheckBigIntFormat", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const [minimum, maximum] = BIGINT_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (input < minimum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var \$ZodCheckMaxSize = /* @__PURE__ */ \$constructor("\$ZodCheckMaxSize", (inst, def) => {
  var _a17;
  \$ZodCheck.init(inst, def);
  (_a17 = inst._zod.def).when ?? (_a17.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr) inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size <= def.maximum) return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckMinSize = /* @__PURE__ */ \$constructor("\$ZodCheckMinSize", (inst, def) => {
  var _a17;
  \$ZodCheck.init(inst, def);
  (_a17 = inst._zod.def).when ?? (_a17.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr) inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size >= def.minimum) return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckSizeEquals = /* @__PURE__ */ \$constructor("\$ZodCheckSizeEquals", (inst, def) => {
  var _a17;
  \$ZodCheck.init(inst, def);
  (_a17 = inst._zod.def).when ?? (_a17.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.size;
    bag.maximum = def.size;
    bag.size = def.size;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size === def.size) return;
    const tooBig = size > def.size;
    payload.issues.push({
      origin: getSizableOrigin(input),
      ...tooBig ? {
        code: "too_big",
        maximum: def.size
      } : {
        code: "too_small",
        minimum: def.size
      },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckMaxLength = /* @__PURE__ */ \$constructor("\$ZodCheckMaxLength", (inst, def) => {
  var _a17;
  \$ZodCheck.init(inst, def);
  (_a17 = inst._zod.def).when ?? (_a17.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr) inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum) return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckMinLength = /* @__PURE__ */ \$constructor("\$ZodCheckMinLength", (inst, def) => {
  var _a17;
  \$ZodCheck.init(inst, def);
  (_a17 = inst._zod.def).when ?? (_a17.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr) inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum) return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckLengthEquals = /* @__PURE__ */ \$constructor("\$ZodCheckLengthEquals", (inst, def) => {
  var _a17;
  \$ZodCheck.init(inst, def);
  (_a17 = inst._zod.def).when ?? (_a17.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length) return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? {
        code: "too_big",
        maximum: def.length
      } : {
        code: "too_small",
        minimum: def.length
      },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckStringFormat = /* @__PURE__ */ \$constructor("\$ZodCheckStringFormat", (inst, def) => {
  var _a17, _b8;
  \$ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern) (_a17 = inst._zod).check ?? (_a17.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      ...def.pattern ? {
        pattern: def.pattern.toString()
      } : {},
      inst,
      continue: !def.abort
    });
  });
  else (_b8 = inst._zod).check ?? (_b8.check = () => {
  });
});
var \$ZodCheckRegex = /* @__PURE__ */ \$constructor("\$ZodCheckRegex", (inst, def) => {
  \$ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckLowerCase = /* @__PURE__ */ \$constructor("\$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  \$ZodCheckStringFormat.init(inst, def);
});
var \$ZodCheckUpperCase = /* @__PURE__ */ \$constructor("\$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  \$ZodCheckStringFormat.init(inst, def);
});
var \$ZodCheckIncludes = /* @__PURE__ */ \$constructor("\$ZodCheckIncludes", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? \`^.{\${def.position}}\${escapedRegex}\` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckStartsWith = /* @__PURE__ */ \$constructor("\$ZodCheckStartsWith", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const pattern = new RegExp(\`^\${escapeRegex(def.prefix)}.*\`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckEndsWith = /* @__PURE__ */ \$constructor("\$ZodCheckEndsWith", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const pattern = new RegExp(\`.*\${escapeRegex(def.suffix)}\$\`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function handleCheckPropertyResult(result, payload, property) {
  if (result.issues.length) {
    payload.issues.push(...prefixIssues(property, result.issues));
  }
}
__name(handleCheckPropertyResult, "handleCheckPropertyResult");
var \$ZodCheckProperty = /* @__PURE__ */ \$constructor("\$ZodCheckProperty", (inst, def) => {
  \$ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    const result = def.schema._zod.run({
      value: payload.value[def.property],
      issues: []
    }, {});
    if (result instanceof Promise) {
      return result.then((result2) => handleCheckPropertyResult(result2, payload, def.property));
    }
    handleCheckPropertyResult(result, payload, def.property);
    return;
  };
});
var \$ZodCheckMimeType = /* @__PURE__ */ \$constructor("\$ZodCheckMimeType", (inst, def) => {
  \$ZodCheck.init(inst, def);
  const mimeSet = new Set(def.mime);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.mime = def.mime;
  });
  inst._zod.check = (payload) => {
    if (mimeSet.has(payload.value.type)) return;
    payload.issues.push({
      code: "invalid_value",
      values: def.mime,
      input: payload.value.type,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCheckOverwrite = /* @__PURE__ */ \$constructor("\$ZodCheckOverwrite", (inst, def) => {
  \$ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/doc.js
var Doc = class {
  static {
    __name(this, "Doc");
  }
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this) this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, {
        execution: "sync"
      });
      arg(this, {
        execution: "async"
      });
      return;
    }
    const content = arg;
    const lines = content.split("\\n").filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [
      \`\`
    ];
    const lines = [
      ...content.map((x) => \`  \${x}\`)
    ];
    return new F(...args, lines.join("\\n"));
  }
};

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 1,
  patch: 11
};

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/schemas.js
var \$ZodType = /* @__PURE__ */ \$constructor("\$ZodType", (inst, def) => {
  var _a17;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [
    ...inst._zod.def.checks ?? []
  ];
  if (inst._zod.traits.has("\$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a17 = inst._zod).deferred ?? (_a17.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = /* @__PURE__ */ __name((payload, checks2, ctx) => {
      let isAborted2 = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun) continue;
        } else if (isAborted2) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new \$ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen) return;
            if (!isAborted2) isAborted2 = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen) continue;
          if (!isAborted2) isAborted2 = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    }, "runChecks");
    const handleCanaryResult = /* @__PURE__ */ __name((canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false) throw new \$ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    }, "handleCanaryResult");
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({
          value: payload.value,
          issues: []
        }, {
          ...ctx,
          skipChecks: true
        });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false) throw new \$ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  inst["~standard"] = {
    validate: /* @__PURE__ */ __name((value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? {
          value: r.data
        } : {
          issues: r.error?.issues
        };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? {
          value: r.data
        } : {
          issues: r.error?.issues
        });
      }
    }, "validate"),
    vendor: "zod",
    version: 1
  };
});
var \$ZodString = /* @__PURE__ */ \$constructor("\$ZodString", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.pattern = [
    ...inst?._zod.bag?.patterns ?? []
  ].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce) try {
      payload.value = String(payload.value);
    } catch (_2) {
    }
    if (typeof payload.value === "string") return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var \$ZodStringFormat = /* @__PURE__ */ \$constructor("\$ZodStringFormat", (inst, def) => {
  \$ZodCheckStringFormat.init(inst, def);
  \$ZodString.init(inst, def);
});
var \$ZodGUID = /* @__PURE__ */ \$constructor("\$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodUUID = /* @__PURE__ */ \$constructor("\$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === void 0) throw new Error(\`Invalid UUID version: "\${def.version}"\`);
    def.pattern ?? (def.pattern = uuid(v));
  } else def.pattern ?? (def.pattern = uuid());
  \$ZodStringFormat.init(inst, def);
});
var \$ZodEmail = /* @__PURE__ */ \$constructor("\$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodURL = /* @__PURE__ */ \$constructor("\$ZodURL", (inst, def) => {
  \$ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url2 = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url2.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url2.protocol.endsWith(":") ? url2.protocol.slice(0, -1) : url2.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url2.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var \$ZodEmoji = /* @__PURE__ */ \$constructor("\$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  \$ZodStringFormat.init(inst, def);
});
var \$ZodNanoID = /* @__PURE__ */ \$constructor("\$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodCUID = /* @__PURE__ */ \$constructor("\$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodCUID2 = /* @__PURE__ */ \$constructor("\$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodULID = /* @__PURE__ */ \$constructor("\$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodXID = /* @__PURE__ */ \$constructor("\$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodKSUID = /* @__PURE__ */ \$constructor("\$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodISODateTime = /* @__PURE__ */ \$constructor("\$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  \$ZodStringFormat.init(inst, def);
});
var \$ZodISODate = /* @__PURE__ */ \$constructor("\$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodISOTime = /* @__PURE__ */ \$constructor("\$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  \$ZodStringFormat.init(inst, def);
});
var \$ZodISODuration = /* @__PURE__ */ \$constructor("\$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodIPv4 = /* @__PURE__ */ \$constructor("\$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  \$ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = \`ipv4\`;
  });
});
var \$ZodIPv6 = /* @__PURE__ */ \$constructor("\$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  \$ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = \`ipv6\`;
  });
  inst._zod.check = (payload) => {
    try {
      new URL(\`http://[\${payload.value}]\`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var \$ZodCIDRv4 = /* @__PURE__ */ \$constructor("\$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  \$ZodStringFormat.init(inst, def);
});
var \$ZodCIDRv6 = /* @__PURE__ */ \$constructor("\$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  \$ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2) throw new Error();
      const [address, prefix] = parts;
      if (!prefix) throw new Error();
      const prefixNum = Number(prefix);
      if (\`\${prefixNum}\` !== prefix) throw new Error();
      if (prefixNum < 0 || prefixNum > 128) throw new Error();
      new URL(\`http://[\${address}]\`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "") return true;
  if (data.length % 4 !== 0) return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
__name(isValidBase64, "isValidBase64");
var \$ZodBase64 = /* @__PURE__ */ \$constructor("\$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  \$ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value)) return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data)) return false;
  const base643 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base643.padEnd(Math.ceil(base643.length / 4) * 4, "=");
  return isValidBase64(padded);
}
__name(isValidBase64URL, "isValidBase64URL");
var \$ZodBase64URL = /* @__PURE__ */ \$constructor("\$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  \$ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64url";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value)) return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodE164 = /* @__PURE__ */ \$constructor("\$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  \$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3) return false;
    const [header] = tokensParts;
    if (!header) return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
    if (!parsedHeader.alg) return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
    return true;
  } catch {
    return false;
  }
}
__name(isValidJWT, "isValidJWT");
var \$ZodJWT = /* @__PURE__ */ \$constructor("\$ZodJWT", (inst, def) => {
  \$ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg)) return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodCustomStringFormat = /* @__PURE__ */ \$constructor("\$ZodCustomStringFormat", (inst, def) => {
  \$ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (def.fn(payload.value)) return;
    payload.issues.push({
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var \$ZodNumber = /* @__PURE__ */ \$constructor("\$ZodNumber", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) try {
      payload.value = Number(payload.value);
    } catch (_) {
    }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? {
        received
      } : {}
    });
    return payload;
  };
});
var \$ZodNumberFormat = /* @__PURE__ */ \$constructor("\$ZodNumber", (inst, def) => {
  \$ZodCheckNumberFormat.init(inst, def);
  \$ZodNumber.init(inst, def);
});
var \$ZodBoolean = /* @__PURE__ */ \$constructor("\$ZodBoolean", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) try {
      payload.value = Boolean(payload.value);
    } catch (_) {
    }
    const input = payload.value;
    if (typeof input === "boolean") return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var \$ZodBigInt = /* @__PURE__ */ \$constructor("\$ZodBigInt", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) try {
      payload.value = BigInt(payload.value);
    } catch (_) {
    }
    if (typeof payload.value === "bigint") return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var \$ZodBigIntFormat = /* @__PURE__ */ \$constructor("\$ZodBigInt", (inst, def) => {
  \$ZodCheckBigIntFormat.init(inst, def);
  \$ZodBigInt.init(inst, def);
});
var \$ZodSymbol = /* @__PURE__ */ \$constructor("\$ZodSymbol", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "symbol") return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var \$ZodUndefined = /* @__PURE__ */ \$constructor("\$ZodUndefined", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.pattern = _undefined;
  inst._zod.values = /* @__PURE__ */ new Set([
    void 0
  ]);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined") return payload;
    payload.issues.push({
      expected: "undefined",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var \$ZodNull = /* @__PURE__ */ \$constructor("\$ZodNull", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = /* @__PURE__ */ new Set([
    null
  ]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null) return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var \$ZodAny = /* @__PURE__ */ \$constructor("\$ZodAny", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var \$ZodUnknown = /* @__PURE__ */ \$constructor("\$ZodUnknown", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var \$ZodNever = /* @__PURE__ */ \$constructor("\$ZodNever", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var \$ZodVoid = /* @__PURE__ */ \$constructor("\$ZodVoid", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined") return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var \$ZodDate = /* @__PURE__ */ \$constructor("\$ZodDate", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {
      }
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate) return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? {
        received: "Invalid Date"
      } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
__name(handleArrayResult, "handleArrayResult");
var \$ZodArray = /* @__PURE__ */ \$constructor("\$ZodArray", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === void 0) {
    if (key in input) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
__name(handlePropertyResult, "handlePropertyResult");
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("\$ZodType")) {
      throw new Error(\`Invalid element at key "\${k}": expected a Zod schema\`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
__name(normalizeDef, "normalizeDef");
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  for (const key of Object.keys(input)) {
    if (keySet.has(key)) continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({
      value: input[key],
      issues: []
    }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
    } else {
      handlePropertyResult(r, payload, key, input);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length) return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
__name(handleCatchall, "handleCatchall");
var \$ZodObject = /* @__PURE__ */ \$constructor("\$ZodObject", (inst, def) => {
  \$ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: /* @__PURE__ */ __name(() => {
        const newSh = {
          ...sh
        };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }, "get")
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
        for (const v of field.values) propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const r = el._zod.run({
        value: input[key],
        issues: []
      }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
      } else {
        handlePropertyResult(r, payload, key, input);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var \$ZodObjectJIT = /* @__PURE__ */ \$constructor("\$ZodObjectJIT", (inst, def) => {
  \$ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = /* @__PURE__ */ __name((shape) => {
    const doc = new Doc([
      "shape",
      "payload",
      "ctx"
    ]);
    const normalized = _normalized.value;
    const parseStr = /* @__PURE__ */ __name((key) => {
      const k = esc(key);
      return \`shape[\${k}]._zod.run({ value: input[\${k}], issues: [] }, ctx)\`;
    }, "parseStr");
    doc.write(\`const input = payload.value;\`);
    const ids = /* @__PURE__ */ Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = \`key_\${counter++}\`;
    }
    doc.write(\`const newResult = {};\`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      doc.write(\`const \${id} = \${parseStr(key)};\`);
      doc.write(\`
        if (\${id}.issues.length) {
          payload.issues = payload.issues.concat(\${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [\${k}, ...iss.path] : [\${k}]
          })));
        }
        
        
        if (\${id}.value === undefined) {
          if (\${k} in input) {
            newResult[\${k}] = undefined;
          }
        } else {
          newResult[\${k}] = \${id}.value;
        }
        
      \`);
    }
    doc.write(\`payload.value = newResult;\`);
    doc.write(\`return payload;\`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  }, "generateFastpass");
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass) fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall) return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
__name(handleUnionResults, "handleUnionResults");
var \$ZodUnion = /* @__PURE__ */ \$constructor("\$ZodUnion", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(\`^(\${patterns.map((p) => cleanRegex(p.source)).join("|")})\$\`);
    }
    return void 0;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0) return result;
        results.push(result);
      }
    }
    if (!async) return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var \$ZodDiscriminatedUnion = /* @__PURE__ */ \$constructor("\$ZodDiscriminatedUnion", (inst, def) => {
  \$ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0) throw new Error(\`Invalid discriminated union option at index "\${def.options.indexOf(option)}"\`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k]) propValues[k] = /* @__PURE__ */ new Set();
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map2 = /* @__PURE__ */ new Map();
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0) throw new Error(\`Invalid discriminated union option at index "\${def.options.indexOf(o)}"\`);
      for (const v of values) {
        if (map2.has(v)) {
          throw new Error(\`Duplicate discriminator value "\${String(v)}"\`);
        }
        map2.set(v, o);
      }
    }
    return map2;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback) {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      input,
      path: [
        def.discriminator
      ],
      inst
    });
    return payload;
  };
});
var \$ZodIntersection = /* @__PURE__ */ \$constructor("\$ZodIntersection", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({
      value: input,
      issues: []
    }, ctx);
    const right = def.right._zod.run({
      value: input,
      issues: []
    }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([
        left,
        right
      ]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return {
      valid: true,
      data: a
    };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return {
      valid: true,
      data: a
    };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = {
      ...a,
      ...b
    };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [
            key,
            ...sharedValue.mergeErrorPath
          ]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return {
      valid: true,
      data: newObj
    };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return {
        valid: false,
        mergeErrorPath: []
      };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [
            index,
            ...sharedValue.mergeErrorPath
          ]
        };
      }
      newArray.push(sharedValue.data);
    }
    return {
      valid: true,
      data: newArray
    };
  }
  return {
    valid: false,
    mergeErrorPath: []
  };
}
__name(mergeValues, "mergeValues");
function handleIntersectionResults(result, left, right) {
  if (left.issues.length) {
    result.issues.push(...left.issues);
  }
  if (right.issues.length) {
    result.issues.push(...right.issues);
  }
  if (aborted(result)) return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(\`Unmergable intersection. Error path: \${JSON.stringify(merged.mergeErrorPath)}\`);
  }
  result.value = merged.data;
  return result;
}
__name(handleIntersectionResults, "handleIntersectionResults");
var \$ZodTuple = /* @__PURE__ */ \$constructor("\$ZodTuple", (inst, def) => {
  \$ZodType.init(inst, def);
  const items = def.items;
  const optStart = items.length - [
    ...items
  ].reverse().findIndex((item) => item._zod.optin !== "optional");
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = [];
    const proms = [];
    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          ...tooBig ? {
            code: "too_big",
            maximum: items.length
          } : {
            code: "too_small",
            minimum: items.length
          },
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
    }
    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) {
        if (i >= optStart) continue;
      }
      const result = item._zod.run({
        value: input[i],
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }
    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run({
          value: el,
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length) return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
__name(handleTupleResult, "handleTupleResult");
var \$ZodRecord = /* @__PURE__ */ \$constructor("\$ZodRecord", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    if (def.keyType._zod.values) {
      const values = def.keyType._zod.values;
      payload.value = {};
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          const result = def.valueType._zod.run({
            value: input[key],
            issues: []
          }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[key] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!values.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__") continue;
        const keyResult = def.keyType._zod.run({
          value: key,
          issues: []
        }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        if (keyResult.issues.length) {
          payload.issues.push({
            code: "invalid_key",
            origin: "record",
            issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
            input: key,
            path: [
              key
            ],
            inst
          });
          payload.value[keyResult.value] = keyResult.value;
          continue;
        }
        const result = def.valueType._zod.run({
          value: input[key],
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var \$ZodMap = /* @__PURE__ */ \$constructor("\$ZodMap", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    payload.value = /* @__PURE__ */ new Map();
    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({
        value: key,
        issues: []
      }, ctx);
      const valueResult = def.valueType._zod.run({
        value,
        issues: []
      }, ctx);
      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(Promise.all([
          keyResult,
          valueResult
        ]).then(([keyResult2, valueResult2]) => {
          handleMapResult(keyResult2, valueResult2, payload, key, input, inst, ctx);
        }));
      } else {
        handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
      }
    }
    if (proms.length) return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
  if (keyResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, keyResult.issues));
    } else {
      final.issues.push({
        code: "invalid_key",
        origin: "map",
        input,
        inst,
        issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  if (valueResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key,
        issues: valueResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  final.value.set(keyResult.value, valueResult.value);
}
__name(handleMapResult, "handleMapResult");
var \$ZodSet = /* @__PURE__ */ \$constructor("\$ZodSet", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type"
      });
      return payload;
    }
    const proms = [];
    payload.value = /* @__PURE__ */ new Set();
    for (const item of input) {
      const result = def.valueType._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleSetResult(result2, payload)));
      } else handleSetResult(result, payload);
    }
    if (proms.length) return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleSetResult(result, final) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }
  final.value.add(result.value);
}
__name(handleSetResult, "handleSetResult");
var \$ZodEnum = /* @__PURE__ */ \$constructor("\$ZodEnum", (inst, def) => {
  \$ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(\`^(\${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})\$\`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var \$ZodLiteral = /* @__PURE__ */ \$constructor("\$ZodLiteral", (inst, def) => {
  \$ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  inst._zod.values = new Set(def.values);
  inst._zod.pattern = new RegExp(\`^(\${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})\$\`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (inst._zod.values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var \$ZodFile = /* @__PURE__ */ \$constructor("\$ZodFile", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File) return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var \$ZodTransform = /* @__PURE__ */ \$constructor("\$ZodTransform", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new \$ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new \$ZodAsyncError();
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === void 0) {
    return {
      issues: [],
      value: void 0
    };
  }
  return result;
}
__name(handleOptionalResult, "handleOptionalResult");
var \$ZodOptional = /* @__PURE__ */ \$constructor("\$ZodOptional", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([
      ...def.innerType._zod.values,
      void 0
    ]) : void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(\`^(\${cleanRegex(pattern.source)})?\$\`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === void 0) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var \$ZodNullable = /* @__PURE__ */ \$constructor("\$ZodNullable", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(\`^(\${cleanRegex(pattern.source)}|null)\$\`) : void 0;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([
      ...def.innerType._zod.values,
      null
    ]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null) return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var \$ZodDefault = /* @__PURE__ */ \$constructor("\$ZodDefault", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === void 0) {
    payload.value = def.defaultValue;
  }
  return payload;
}
__name(handleDefaultResult, "handleDefaultResult");
var \$ZodPrefault = /* @__PURE__ */ \$constructor("\$ZodPrefault", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var \$ZodNonOptional = /* @__PURE__ */ \$constructor("\$ZodNonOptional", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([
      ...v
    ].filter((x) => x !== void 0)) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === void 0) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
__name(handleNonOptionalResult, "handleNonOptionalResult");
var \$ZodSuccess = /* @__PURE__ */ \$constructor("\$ZodSuccess", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new \$ZodEncodeError("ZodSuccess");
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.issues.length === 0;
        return payload;
      });
    }
    payload.value = result.issues.length === 0;
    return payload;
  };
});
var \$ZodCatch = /* @__PURE__ */ \$constructor("\$ZodCatch", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
var \$ZodNaN = /* @__PURE__ */ \$constructor("\$ZodNaN", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type"
      });
      return payload;
    }
    return payload;
  };
});
var \$ZodPipe = /* @__PURE__ */ \$constructor("\$ZodPipe", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({
    value: left.value,
    issues: left.issues
  }, ctx);
}
__name(handlePipeResult, "handlePipeResult");
var \$ZodCodec = /* @__PURE__ */ \$constructor("\$ZodCodec", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left2) => handleCodecAResult(left2, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handleCodecAResult(right2, def, ctx));
      }
      return handleCodecAResult(right, def, ctx);
    }
  };
});
function handleCodecAResult(result, def, ctx) {
  if (result.issues.length) {
    result.aborted = true;
    return result;
  }
  const direction = ctx.direction || "forward";
  if (direction === "forward") {
    const transformed = def.transform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.out, ctx));
    }
    return handleCodecTxResult(result, transformed, def.out, ctx);
  } else {
    const transformed = def.reverseTransform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.in, ctx));
    }
    return handleCodecTxResult(result, transformed, def.in, ctx);
  }
}
__name(handleCodecAResult, "handleCodecAResult");
function handleCodecTxResult(left, value, nextSchema, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return nextSchema._zod.run({
    value,
    issues: left.issues
  }, ctx);
}
__name(handleCodecTxResult, "handleCodecTxResult");
var \$ZodReadonly = /* @__PURE__ */ \$constructor("\$ZodReadonly", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
__name(handleReadonlyResult, "handleReadonlyResult");
var \$ZodTemplateLiteral = /* @__PURE__ */ \$constructor("\$ZodTemplateLiteral", (inst, def) => {
  \$ZodType.init(inst, def);
  const regexParts = [];
  for (const part of def.parts) {
    if (typeof part === "object" && part !== null) {
      if (!part._zod.pattern) {
        throw new Error(\`Invalid template literal part, no pattern found: \${[
          ...part._zod.traits
        ].shift()}\`);
      }
      const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;
      if (!source) throw new Error(\`Invalid template literal part: \${part._zod.traits}\`);
      const start = source.startsWith("^") ? 1 : 0;
      const end = source.endsWith("\$") ? source.length - 1 : source.length;
      regexParts.push(source.slice(start, end));
    } else if (part === null || primitiveTypes.has(typeof part)) {
      regexParts.push(escapeRegex(\`\${part}\`));
    } else {
      throw new Error(\`Invalid template literal part: \${part}\`);
    }
  }
  inst._zod.pattern = new RegExp(\`^\${regexParts.join("")}\$\`);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "string") {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "template_literal",
        code: "invalid_type"
      });
      return payload;
    }
    inst._zod.pattern.lastIndex = 0;
    if (!inst._zod.pattern.test(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        code: "invalid_format",
        format: def.format ?? "template_literal",
        pattern: inst._zod.pattern.source
      });
      return payload;
    }
    return payload;
  };
});
var \$ZodFunction = /* @__PURE__ */ \$constructor("\$ZodFunction", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._def = def;
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return function(...args) {
      const parsedArgs = inst._def.input ? parse(inst._def.input, args) : args;
      const result = Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return parse(inst._def.output, result);
      }
      return result;
    };
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return async function(...args) {
      const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
      const result = await Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return await parseAsync(inst._def.output, result);
      }
      return result;
    };
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new \$ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1]
        }),
        output: inst._def.output
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output
    });
  };
  return inst;
});
var \$ZodPromise = /* @__PURE__ */ \$constructor("\$ZodPromise", (inst, def) => {
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({
      value: inner,
      issues: []
    }, ctx));
  };
});
var \$ZodLazy = /* @__PURE__ */ \$constructor("\$ZodLazy", (inst, def) => {
  \$ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType._zod.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType._zod.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType._zod.optin ?? void 0);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType._zod.optout ?? void 0);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var \$ZodCustom = /* @__PURE__ */ \$constructor("\$ZodCustom", (inst, def) => {
  \$ZodCheck.init(inst, def);
  \$ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [
        ...inst._zod.def.path ?? []
      ],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params) _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
__name(handleRefineResult, "handleRefineResult");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/index.js
var locales_exports = {};
__export(locales_exports, {
  ar: () => ar_default,
  az: () => az_default,
  be: () => be_default,
  ca: () => ca_default,
  cs: () => cs_default,
  da: () => da_default,
  de: () => de_default,
  en: () => en_default,
  eo: () => eo_default,
  es: () => es_default,
  fa: () => fa_default,
  fi: () => fi_default,
  fr: () => fr_default,
  frCA: () => fr_CA_default,
  he: () => he_default,
  hu: () => hu_default,
  id: () => id_default,
  is: () => is_default,
  it: () => it_default,
  ja: () => ja_default,
  ka: () => ka_default,
  kh: () => kh_default,
  km: () => km_default,
  ko: () => ko_default,
  lt: () => lt_default,
  mk: () => mk_default,
  ms: () => ms_default,
  nl: () => nl_default,
  no: () => no_default,
  ota: () => ota_default,
  pl: () => pl_default,
  ps: () => ps_default,
  pt: () => pt_default,
  ru: () => ru_default,
  sl: () => sl_default,
  sv: () => sv_default,
  ta: () => ta_default,
  th: () => th_default,
  tr: () => tr_default,
  ua: () => ua_default,
  uk: () => uk_default,
  ur: () => ur_default,
  vi: () => vi_default,
  yo: () => yo_default,
  zhCN: () => zh_CN_default,
  zhTW: () => zh_TW_default
});

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ar.js
var error = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u062D\\u0631\\u0641",
      verb: "\\u0623\\u0646 \\u064A\\u062D\\u0648\\u064A"
    },
    file: {
      unit: "\\u0628\\u0627\\u064A\\u062A",
      verb: "\\u0623\\u0646 \\u064A\\u062D\\u0648\\u064A"
    },
    array: {
      unit: "\\u0639\\u0646\\u0635\\u0631",
      verb: "\\u0623\\u0646 \\u064A\\u062D\\u0648\\u064A"
    },
    set: {
      unit: "\\u0639\\u0646\\u0635\\u0631",
      verb: "\\u0623\\u0646 \\u064A\\u062D\\u0648\\u064A"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0645\\u062F\\u062E\\u0644",
    email: "\\u0628\\u0631\\u064A\\u062F \\u0625\\u0644\\u0643\\u062A\\u0631\\u0648\\u0646\\u064A",
    url: "\\u0631\\u0627\\u0628\\u0637",
    emoji: "\\u0625\\u064A\\u0645\\u0648\\u062C\\u064A",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u062A\\u0627\\u0631\\u064A\\u062E \\u0648\\u0648\\u0642\\u062A \\u0628\\u0645\\u0639\\u064A\\u0627\\u0631 ISO",
    date: "\\u062A\\u0627\\u0631\\u064A\\u062E \\u0628\\u0645\\u0639\\u064A\\u0627\\u0631 ISO",
    time: "\\u0648\\u0642\\u062A \\u0628\\u0645\\u0639\\u064A\\u0627\\u0631 ISO",
    duration: "\\u0645\\u062F\\u0629 \\u0628\\u0645\\u0639\\u064A\\u0627\\u0631 ISO",
    ipv4: "\\u0639\\u0646\\u0648\\u0627\\u0646 IPv4",
    ipv6: "\\u0639\\u0646\\u0648\\u0627\\u0646 IPv6",
    cidrv4: "\\u0645\\u062F\\u0649 \\u0639\\u0646\\u0627\\u0648\\u064A\\u0646 \\u0628\\u0635\\u064A\\u063A\\u0629 IPv4",
    cidrv6: "\\u0645\\u062F\\u0649 \\u0639\\u0646\\u0627\\u0648\\u064A\\u0646 \\u0628\\u0635\\u064A\\u063A\\u0629 IPv6",
    base64: "\\u0646\\u064E\\u0635 \\u0628\\u062A\\u0631\\u0645\\u064A\\u0632 base64-encoded",
    base64url: "\\u0646\\u064E\\u0635 \\u0628\\u062A\\u0631\\u0645\\u064A\\u0632 base64url-encoded",
    json_string: "\\u0646\\u064E\\u0635 \\u0639\\u0644\\u0649 \\u0647\\u064A\\u0626\\u0629 JSON",
    e164: "\\u0631\\u0642\\u0645 \\u0647\\u0627\\u062A\\u0641 \\u0628\\u0645\\u0639\\u064A\\u0627\\u0631 E.164",
    jwt: "JWT",
    template_literal: "\\u0645\\u062F\\u062E\\u0644"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0645\\u062F\\u062E\\u0644\\u0627\\u062A \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644\\u0629: \\u064A\\u0641\\u062A\\u0631\\u0636 \\u0625\\u062F\\u062E\\u0627\\u0644 \${issue2.expected}\\u060C \\u0648\\u0644\\u0643\\u0646 \\u062A\\u0645 \\u0625\\u062F\\u062E\\u0627\\u0644 \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u0645\\u062F\\u062E\\u0644\\u0627\\u062A \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644\\u0629: \\u064A\\u0641\\u062A\\u0631\\u0636 \\u0625\\u062F\\u062E\\u0627\\u0644 \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u0627\\u062E\\u062A\\u064A\\u0627\\u0631 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644: \\u064A\\u062A\\u0648\\u0642\\u0639 \\u0627\\u0646\\u062A\\u0642\\u0627\\u0621 \\u0623\\u062D\\u062F \\u0647\\u0630\\u0647 \\u0627\\u0644\\u062E\\u064A\\u0627\\u0631\\u0627\\u062A: \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \` \\u0623\\u0643\\u0628\\u0631 \\u0645\\u0646 \\u0627\\u0644\\u0644\\u0627\\u0632\\u0645: \\u064A\\u0641\\u062A\\u0631\\u0636 \\u0623\\u0646 \\u062A\\u0643\\u0648\\u0646 \${issue2.origin ?? "\\u0627\\u0644\\u0642\\u064A\\u0645\\u0629"} \${adj} \${issue2.maximum.toString()} \${sizing.unit ?? "\\u0639\\u0646\\u0635\\u0631"}\`;
        return \`\\u0623\\u0643\\u0628\\u0631 \\u0645\\u0646 \\u0627\\u0644\\u0644\\u0627\\u0632\\u0645: \\u064A\\u0641\\u062A\\u0631\\u0636 \\u0623\\u0646 \\u062A\\u0643\\u0648\\u0646 \${issue2.origin ?? "\\u0627\\u0644\\u0642\\u064A\\u0645\\u0629"} \${adj} \${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0623\\u0635\\u063A\\u0631 \\u0645\\u0646 \\u0627\\u0644\\u0644\\u0627\\u0632\\u0645: \\u064A\\u0641\\u062A\\u0631\\u0636 \\u0644\\u0640 \${issue2.origin} \\u0623\\u0646 \\u064A\\u0643\\u0648\\u0646 \${adj} \${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u0623\\u0635\\u063A\\u0631 \\u0645\\u0646 \\u0627\\u0644\\u0644\\u0627\\u0632\\u0645: \\u064A\\u0641\\u062A\\u0631\\u0636 \\u0644\\u0640 \${issue2.origin} \\u0623\\u0646 \\u064A\\u0643\\u0648\\u0646 \${adj} \${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u0646\\u064E\\u0635 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644: \\u064A\\u062C\\u0628 \\u0623\\u0646 \\u064A\\u0628\\u062F\\u0623 \\u0628\\u0640 "\${issue2.prefix}"\`;
        if (_issue.format === "ends_with") return \`\\u0646\\u064E\\u0635 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644: \\u064A\\u062C\\u0628 \\u0623\\u0646 \\u064A\\u0646\\u062A\\u0647\\u064A \\u0628\\u0640 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u0646\\u064E\\u0635 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644: \\u064A\\u062C\\u0628 \\u0623\\u0646 \\u064A\\u062A\\u0636\\u0645\\u0651\\u064E\\u0646 "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u0646\\u064E\\u0635 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644: \\u064A\\u062C\\u0628 \\u0623\\u0646 \\u064A\\u0637\\u0627\\u0628\\u0642 \\u0627\\u0644\\u0646\\u0645\\u0637 \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644\`;
      }
      case "not_multiple_of":
        return \`\\u0631\\u0642\\u0645 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644: \\u064A\\u062C\\u0628 \\u0623\\u0646 \\u064A\\u0643\\u0648\\u0646 \\u0645\\u0646 \\u0645\\u0636\\u0627\\u0639\\u0641\\u0627\\u062A \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\u0645\\u0639\\u0631\\u0641\${issue2.keys.length > 1 ? "\\u0627\\u062A" : ""} \\u063A\\u0631\\u064A\\u0628\${issue2.keys.length > 1 ? "\\u0629" : ""}: \${joinValues(issue2.keys, "\\u060C ")}\`;
      case "invalid_key":
        return \`\\u0645\\u0639\\u0631\\u0641 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644 \\u0641\\u064A \${issue2.origin}\`;
      case "invalid_union":
        return "\\u0645\\u062F\\u062E\\u0644 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644";
      case "invalid_element":
        return \`\\u0645\\u062F\\u062E\\u0644 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644 \\u0641\\u064A \${issue2.origin}\`;
      default:
        return "\\u0645\\u062F\\u062E\\u0644 \\u063A\\u064A\\u0631 \\u0645\\u0642\\u0628\\u0648\\u0644";
    }
  };
}, "error");
function ar_default() {
  return {
    localeError: error()
  };
}
__name(ar_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/az.js
var error2 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "simvol",
      verb: "olmal\\u0131d\\u0131r"
    },
    file: {
      unit: "bayt",
      verb: "olmal\\u0131d\\u0131r"
    },
    array: {
      unit: "element",
      verb: "olmal\\u0131d\\u0131r"
    },
    set: {
      unit: "element",
      verb: "olmal\\u0131d\\u0131r"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Yanl\\u0131\\u015F d\\u0259y\\u0259r: g\\xF6zl\\u0259nil\\u0259n \${issue2.expected}, daxil olan \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Yanl\\u0131\\u015F d\\u0259y\\u0259r: g\\xF6zl\\u0259nil\\u0259n \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Yanl\\u0131\\u015F se\\xE7im: a\\u015Fa\\u011F\\u0131dak\\u0131lardan biri olmal\\u0131d\\u0131r: \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\xC7ox b\\xF6y\\xFCk: g\\xF6zl\\u0259nil\\u0259n \${issue2.origin ?? "d\\u0259y\\u0259r"} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "element"}\`;
        return \`\\xC7ox b\\xF6y\\xFCk: g\\xF6zl\\u0259nil\\u0259n \${issue2.origin ?? "d\\u0259y\\u0259r"} \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\xC7ox ki\\xE7ik: g\\xF6zl\\u0259nil\\u0259n \${issue2.origin} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        return \`\\xC7ox ki\\xE7ik: g\\xF6zl\\u0259nil\\u0259n \${issue2.origin} \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Yanl\\u0131\\u015F m\\u0259tn: "\${_issue.prefix}" il\\u0259 ba\\u015Flamal\\u0131d\\u0131r\`;
        if (_issue.format === "ends_with") return \`Yanl\\u0131\\u015F m\\u0259tn: "\${_issue.suffix}" il\\u0259 bitm\\u0259lidir\`;
        if (_issue.format === "includes") return \`Yanl\\u0131\\u015F m\\u0259tn: "\${_issue.includes}" daxil olmal\\u0131d\\u0131r\`;
        if (_issue.format === "regex") return \`Yanl\\u0131\\u015F m\\u0259tn: \${_issue.pattern} \\u015Fablonuna uy\\u011Fun olmal\\u0131d\\u0131r\`;
        return \`Yanl\\u0131\\u015F \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Yanl\\u0131\\u015F \\u0259d\\u0259d: \${issue2.divisor} il\\u0259 b\\xF6l\\xFCn\\u0259 bil\\u0259n olmal\\u0131d\\u0131r\`;
      case "unrecognized_keys":
        return \`Tan\\u0131nmayan a\\xE7ar\${issue2.keys.length > 1 ? "lar" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\${issue2.origin} daxilind\\u0259 yanl\\u0131\\u015F a\\xE7ar\`;
      case "invalid_union":
        return "Yanl\\u0131\\u015F d\\u0259y\\u0259r";
      case "invalid_element":
        return \`\${issue2.origin} daxilind\\u0259 yanl\\u0131\\u015F d\\u0259y\\u0259r\`;
      default:
        return \`Yanl\\u0131\\u015F d\\u0259y\\u0259r\`;
    }
  };
}, "error");
function az_default() {
  return {
    localeError: error2()
  };
}
__name(az_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/be.js
function getBelarusianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
__name(getBelarusianPlural, "getBelarusianPlural");
var error3 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: {
        one: "\\u0441\\u0456\\u043C\\u0432\\u0430\\u043B",
        few: "\\u0441\\u0456\\u043C\\u0432\\u0430\\u043B\\u044B",
        many: "\\u0441\\u0456\\u043C\\u0432\\u0430\\u043B\\u0430\\u045E"
      },
      verb: "\\u043C\\u0435\\u0446\\u044C"
    },
    array: {
      unit: {
        one: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442",
        few: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u044B",
        many: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0430\\u045E"
      },
      verb: "\\u043C\\u0435\\u0446\\u044C"
    },
    set: {
      unit: {
        one: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442",
        few: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u044B",
        many: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0430\\u045E"
      },
      verb: "\\u043C\\u0435\\u0446\\u044C"
    },
    file: {
      unit: {
        one: "\\u0431\\u0430\\u0439\\u0442",
        few: "\\u0431\\u0430\\u0439\\u0442\\u044B",
        many: "\\u0431\\u0430\\u0439\\u0442\\u0430\\u045E"
      },
      verb: "\\u043C\\u0435\\u0446\\u044C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u043B\\u0456\\u043A";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u043C\\u0430\\u0441\\u0456\\u045E";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0443\\u0432\\u043E\\u0434",
    email: "email \\u0430\\u0434\\u0440\\u0430\\u0441",
    url: "URL",
    emoji: "\\u044D\\u043C\\u043E\\u0434\\u0437\\u0456",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \\u0434\\u0430\\u0442\\u0430 \\u0456 \\u0447\\u0430\\u0441",
    date: "ISO \\u0434\\u0430\\u0442\\u0430",
    time: "ISO \\u0447\\u0430\\u0441",
    duration: "ISO \\u043F\\u0440\\u0430\\u0446\\u044F\\u0433\\u043B\\u0430\\u0441\\u0446\\u044C",
    ipv4: "IPv4 \\u0430\\u0434\\u0440\\u0430\\u0441",
    ipv6: "IPv6 \\u0430\\u0434\\u0440\\u0430\\u0441",
    cidrv4: "IPv4 \\u0434\\u044B\\u044F\\u043F\\u0430\\u0437\\u043E\\u043D",
    cidrv6: "IPv6 \\u0434\\u044B\\u044F\\u043F\\u0430\\u0437\\u043E\\u043D",
    base64: "\\u0440\\u0430\\u0434\\u043E\\u043A \\u0443 \\u0444\\u0430\\u0440\\u043C\\u0430\\u0446\\u0435 base64",
    base64url: "\\u0440\\u0430\\u0434\\u043E\\u043A \\u0443 \\u0444\\u0430\\u0440\\u043C\\u0430\\u0446\\u0435 base64url",
    json_string: "JSON \\u0440\\u0430\\u0434\\u043E\\u043A",
    e164: "\\u043D\\u0443\\u043C\\u0430\\u0440 E.164",
    jwt: "JWT",
    template_literal: "\\u0443\\u0432\\u043E\\u0434"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u045E\\u0432\\u043E\\u0434: \\u0447\\u0430\\u043A\\u0430\\u045E\\u0441\\u044F \${issue2.expected}, \\u0430\\u0442\\u0440\\u044B\\u043C\\u0430\\u043D\\u0430 \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u045E\\u0432\\u043E\\u0434: \\u0447\\u0430\\u043A\\u0430\\u043B\\u0430\\u0441\\u044F \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u0432\\u0430\\u0440\\u044B\\u044F\\u043D\\u0442: \\u0447\\u0430\\u043A\\u0430\\u045E\\u0441\\u044F \\u0430\\u0434\\u0437\\u0456\\u043D \\u0437 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getBelarusianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u0430 \\u0432\\u044F\\u043B\\u0456\\u043A\\u0456: \\u0447\\u0430\\u043A\\u0430\\u043B\\u0430\\u0441\\u044F, \\u0448\\u0442\\u043E \${issue2.origin ?? "\\u0437\\u043D\\u0430\\u0447\\u044D\\u043D\\u043D\\u0435"} \\u043F\\u0430\\u0432\\u0456\\u043D\\u043D\\u0430 \${sizing.verb} \${adj}\${issue2.maximum.toString()} \${unit}\`;
        }
        return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u0430 \\u0432\\u044F\\u043B\\u0456\\u043A\\u0456: \\u0447\\u0430\\u043A\\u0430\\u043B\\u0430\\u0441\\u044F, \\u0448\\u0442\\u043E \${issue2.origin ?? "\\u0437\\u043D\\u0430\\u0447\\u044D\\u043D\\u043D\\u0435"} \\u043F\\u0430\\u0432\\u0456\\u043D\\u043D\\u0430 \\u0431\\u044B\\u0446\\u044C \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getBelarusianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u0430 \\u043C\\u0430\\u043B\\u044B: \\u0447\\u0430\\u043A\\u0430\\u043B\\u0430\\u0441\\u044F, \\u0448\\u0442\\u043E \${issue2.origin} \\u043F\\u0430\\u0432\\u0456\\u043D\\u043D\\u0430 \${sizing.verb} \${adj}\${issue2.minimum.toString()} \${unit}\`;
        }
        return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u0430 \\u043C\\u0430\\u043B\\u044B: \\u0447\\u0430\\u043A\\u0430\\u043B\\u0430\\u0441\\u044F, \\u0448\\u0442\\u043E \${issue2.origin} \\u043F\\u0430\\u0432\\u0456\\u043D\\u043D\\u0430 \\u0431\\u044B\\u0446\\u044C \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u0440\\u0430\\u0434\\u043E\\u043A: \\u043F\\u0430\\u0432\\u0456\\u043D\\u0435\\u043D \\u043F\\u0430\\u0447\\u044B\\u043D\\u0430\\u0446\\u0446\\u0430 \\u0437 "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u0440\\u0430\\u0434\\u043E\\u043A: \\u043F\\u0430\\u0432\\u0456\\u043D\\u0435\\u043D \\u0437\\u0430\\u043A\\u0430\\u043D\\u0447\\u0432\\u0430\\u0446\\u0446\\u0430 \\u043D\\u0430 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u0440\\u0430\\u0434\\u043E\\u043A: \\u043F\\u0430\\u0432\\u0456\\u043D\\u0435\\u043D \\u0437\\u043C\\u044F\\u0448\\u0447\\u0430\\u0446\\u044C "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u0440\\u0430\\u0434\\u043E\\u043A: \\u043F\\u0430\\u0432\\u0456\\u043D\\u0435\\u043D \\u0430\\u0434\\u043F\\u0430\\u0432\\u044F\\u0434\\u0430\\u0446\\u044C \\u0448\\u0430\\u0431\\u043B\\u043E\\u043D\\u0443 \${_issue.pattern}\`;
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u043B\\u0456\\u043A: \\u043F\\u0430\\u0432\\u0456\\u043D\\u0435\\u043D \\u0431\\u044B\\u0446\\u044C \\u043A\\u0440\\u0430\\u0442\\u043D\\u044B\\u043C \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\u041D\\u0435\\u0440\\u0430\\u0441\\u043F\\u0430\\u0437\\u043D\\u0430\\u043D\\u044B \${issue2.keys.length > 1 ? "\\u043A\\u043B\\u044E\\u0447\\u044B" : "\\u043A\\u043B\\u044E\\u0447"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u043A\\u043B\\u044E\\u0447 \\u0443 \${issue2.origin}\`;
      case "invalid_union":
        return "\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u045E\\u0432\\u043E\\u0434";
      case "invalid_element":
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u0430\\u0435 \\u0437\\u043D\\u0430\\u0447\\u044D\\u043D\\u043D\\u0435 \\u045E \${issue2.origin}\`;
      default:
        return \`\\u041D\\u044F\\u043F\\u0440\\u0430\\u0432\\u0456\\u043B\\u044C\\u043D\\u044B \\u045E\\u0432\\u043E\\u0434\`;
    }
  };
}, "error");
function be_default() {
  return {
    localeError: error3()
  };
}
__name(be_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ca.js
var error4 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "car\\xE0cters",
      verb: "contenir"
    },
    file: {
      unit: "bytes",
      verb: "contenir"
    },
    array: {
      unit: "elements",
      verb: "contenir"
    },
    set: {
      unit: "elements",
      verb: "contenir"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "entrada",
    email: "adre\\xE7a electr\\xF2nica",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "durada ISO",
    ipv4: "adre\\xE7a IPv4",
    ipv6: "adre\\xE7a IPv6",
    cidrv4: "rang IPv4",
    cidrv6: "rang IPv6",
    base64: "cadena codificada en base64",
    base64url: "cadena codificada en base64url",
    json_string: "cadena JSON",
    e164: "n\\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Tipus inv\\xE0lid: s'esperava \${issue2.expected}, s'ha rebut \${parsedType7(issue2.input)}\`;
      // return \`Tipus invàlid: s'esperava \${issue.expected}, s'ha rebut \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Valor inv\\xE0lid: s'esperava \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Opci\\xF3 inv\\xE0lida: s'esperava una de \${joinValues(issue2.values, " o ")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "com a m\\xE0xim" : "menys de";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Massa gran: s'esperava que \${issue2.origin ?? "el valor"} contingu\\xE9s \${adj} \${issue2.maximum.toString()} \${sizing.unit ?? "elements"}\`;
        return \`Massa gran: s'esperava que \${issue2.origin ?? "el valor"} fos \${adj} \${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "com a m\\xEDnim" : "m\\xE9s de";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Massa petit: s'esperava que \${issue2.origin} contingu\\xE9s \${adj} \${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Massa petit: s'esperava que \${issue2.origin} fos \${adj} \${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Format inv\\xE0lid: ha de comen\\xE7ar amb "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`Format inv\\xE0lid: ha d'acabar amb "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Format inv\\xE0lid: ha d'incloure "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Format inv\\xE0lid: ha de coincidir amb el patr\\xF3 \${_issue.pattern}\`;
        return \`Format inv\\xE0lid per a \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`N\\xFAmero inv\\xE0lid: ha de ser m\\xFAltiple de \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Clau\${issue2.keys.length > 1 ? "s" : ""} no reconeguda\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Clau inv\\xE0lida a \${issue2.origin}\`;
      case "invalid_union":
        return "Entrada inv\\xE0lida";
      // Could also be "Tipus d'unió invàlid" but "Entrada invàlida" is more general
      case "invalid_element":
        return \`Element inv\\xE0lid a \${issue2.origin}\`;
      default:
        return \`Entrada inv\\xE0lida\`;
    }
  };
}, "error");
function ca_default() {
  return {
    localeError: error4()
  };
}
__name(ca_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/cs.js
var error5 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "znak\\u016F",
      verb: "m\\xEDt"
    },
    file: {
      unit: "bajt\\u016F",
      verb: "m\\xEDt"
    },
    array: {
      unit: "prvk\\u016F",
      verb: "m\\xEDt"
    },
    set: {
      unit: "prvk\\u016F",
      verb: "m\\xEDt"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u010D\\xEDslo";
      }
      case "string": {
        return "\\u0159et\\u011Bzec";
      }
      case "boolean": {
        return "boolean";
      }
      case "bigint": {
        return "bigint";
      }
      case "function": {
        return "funkce";
      }
      case "symbol": {
        return "symbol";
      }
      case "undefined": {
        return "undefined";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "pole";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "regul\\xE1rn\\xED v\\xFDraz",
    email: "e-mailov\\xE1 adresa",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "datum a \\u010Das ve form\\xE1tu ISO",
    date: "datum ve form\\xE1tu ISO",
    time: "\\u010Das ve form\\xE1tu ISO",
    duration: "doba trv\\xE1n\\xED ISO",
    ipv4: "IPv4 adresa",
    ipv6: "IPv6 adresa",
    cidrv4: "rozsah IPv4",
    cidrv6: "rozsah IPv6",
    base64: "\\u0159et\\u011Bzec zak\\xF3dovan\\xFD ve form\\xE1tu base64",
    base64url: "\\u0159et\\u011Bzec zak\\xF3dovan\\xFD ve form\\xE1tu base64url",
    json_string: "\\u0159et\\u011Bzec ve form\\xE1tu JSON",
    e164: "\\u010D\\xEDslo E.164",
    jwt: "JWT",
    template_literal: "vstup"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Neplatn\\xFD vstup: o\\u010Dek\\xE1v\\xE1no \${issue2.expected}, obdr\\u017Eeno \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Neplatn\\xFD vstup: o\\u010Dek\\xE1v\\xE1no \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Neplatn\\xE1 mo\\u017Enost: o\\u010Dek\\xE1v\\xE1na jedna z hodnot \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Hodnota je p\\u0159\\xEDli\\u0161 velk\\xE1: \${issue2.origin ?? "hodnota"} mus\\xED m\\xEDt \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "prvk\\u016F"}\`;
        }
        return \`Hodnota je p\\u0159\\xEDli\\u0161 velk\\xE1: \${issue2.origin ?? "hodnota"} mus\\xED b\\xFDt \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Hodnota je p\\u0159\\xEDli\\u0161 mal\\xE1: \${issue2.origin ?? "hodnota"} mus\\xED m\\xEDt \${adj}\${issue2.minimum.toString()} \${sizing.unit ?? "prvk\\u016F"}\`;
        }
        return \`Hodnota je p\\u0159\\xEDli\\u0161 mal\\xE1: \${issue2.origin ?? "hodnota"} mus\\xED b\\xFDt \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Neplatn\\xFD \\u0159et\\u011Bzec: mus\\xED za\\u010D\\xEDnat na "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Neplatn\\xFD \\u0159et\\u011Bzec: mus\\xED kon\\u010Dit na "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Neplatn\\xFD \\u0159et\\u011Bzec: mus\\xED obsahovat "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Neplatn\\xFD \\u0159et\\u011Bzec: mus\\xED odpov\\xEDdat vzoru \${_issue.pattern}\`;
        return \`Neplatn\\xFD form\\xE1t \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Neplatn\\xE9 \\u010D\\xEDslo: mus\\xED b\\xFDt n\\xE1sobkem \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Nezn\\xE1m\\xE9 kl\\xED\\u010De: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Neplatn\\xFD kl\\xED\\u010D v \${issue2.origin}\`;
      case "invalid_union":
        return "Neplatn\\xFD vstup";
      case "invalid_element":
        return \`Neplatn\\xE1 hodnota v \${issue2.origin}\`;
      default:
        return \`Neplatn\\xFD vstup\`;
    }
  };
}, "error");
function cs_default() {
  return {
    localeError: error5()
  };
}
__name(cs_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/da.js
var error6 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "tegn",
      verb: "havde"
    },
    file: {
      unit: "bytes",
      verb: "havde"
    },
    array: {
      unit: "elementer",
      verb: "indeholdt"
    },
    set: {
      unit: "elementer",
      verb: "indeholdt"
    }
  };
  const TypeNames = {
    string: "streng",
    number: "tal",
    boolean: "boolean",
    array: "liste",
    object: "objekt",
    set: "s\\xE6t",
    file: "fil"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  __name(getTypeName, "getTypeName");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
        return "objekt";
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "input",
    email: "e-mailadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkesl\\xE6t",
    date: "ISO-dato",
    time: "ISO-klokkesl\\xE6t",
    duration: "ISO-varighed",
    ipv4: "IPv4-omr\\xE5de",
    ipv6: "IPv6-omr\\xE5de",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodet streng",
    base64url: "base64url-kodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Ugyldigt input: forventede \${getTypeName(issue2.expected)}, fik \${getTypeName(parsedType7(issue2.input))}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Ugyldig v\\xE6rdi: forventede \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Ugyldigt valg: forventede en af f\\xF8lgende \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) return \`For stor: forventede \${origin ?? "value"} \${sizing.verb} \${adj} \${issue2.maximum.toString()} \${sizing.unit ?? "elementer"}\`;
        return \`For stor: forventede \${origin ?? "value"} havde \${adj} \${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return \`For lille: forventede \${origin} \${sizing.verb} \${adj} \${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`For lille: forventede \${origin} havde \${adj} \${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Ugyldig streng: skal starte med "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Ugyldig streng: skal ende med "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Ugyldig streng: skal indeholde "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Ugyldig streng: skal matche m\\xF8nsteret \${_issue.pattern}\`;
        return \`Ugyldig \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Ugyldigt tal: skal v\\xE6re deleligt med \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\${issue2.keys.length > 1 ? "Ukendte n\\xF8gler" : "Ukendt n\\xF8gle"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Ugyldig n\\xF8gle i \${issue2.origin}\`;
      case "invalid_union":
        return "Ugyldigt input: matcher ingen af de tilladte typer";
      case "invalid_element":
        return \`Ugyldig v\\xE6rdi i \${issue2.origin}\`;
      default:
        return \`Ugyldigt input\`;
    }
  };
}, "error");
function da_default() {
  return {
    localeError: error6()
  };
}
__name(da_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/de.js
var error7 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "Zeichen",
      verb: "zu haben"
    },
    file: {
      unit: "Bytes",
      verb: "zu haben"
    },
    array: {
      unit: "Elemente",
      verb: "zu haben"
    },
    set: {
      unit: "Elemente",
      verb: "zu haben"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "Zahl";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "Array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "Eingabe",
    email: "E-Mail-Adresse",
    url: "URL",
    emoji: "Emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-Datum und -Uhrzeit",
    date: "ISO-Datum",
    time: "ISO-Uhrzeit",
    duration: "ISO-Dauer",
    ipv4: "IPv4-Adresse",
    ipv6: "IPv6-Adresse",
    cidrv4: "IPv4-Bereich",
    cidrv6: "IPv6-Bereich",
    base64: "Base64-codierter String",
    base64url: "Base64-URL-codierter String",
    json_string: "JSON-String",
    e164: "E.164-Nummer",
    jwt: "JWT",
    template_literal: "Eingabe"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Ung\\xFCltige Eingabe: erwartet \${issue2.expected}, erhalten \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Ung\\xFCltige Eingabe: erwartet \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Ung\\xFCltige Option: erwartet eine von \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Zu gro\\xDF: erwartet, dass \${issue2.origin ?? "Wert"} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "Elemente"} hat\`;
        return \`Zu gro\\xDF: erwartet, dass \${issue2.origin ?? "Wert"} \${adj}\${issue2.maximum.toString()} ist\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Zu klein: erwartet, dass \${issue2.origin} \${adj}\${issue2.minimum.toString()} \${sizing.unit} hat\`;
        }
        return \`Zu klein: erwartet, dass \${issue2.origin} \${adj}\${issue2.minimum.toString()} ist\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Ung\\xFCltiger String: muss mit "\${_issue.prefix}" beginnen\`;
        if (_issue.format === "ends_with") return \`Ung\\xFCltiger String: muss mit "\${_issue.suffix}" enden\`;
        if (_issue.format === "includes") return \`Ung\\xFCltiger String: muss "\${_issue.includes}" enthalten\`;
        if (_issue.format === "regex") return \`Ung\\xFCltiger String: muss dem Muster \${_issue.pattern} entsprechen\`;
        return \`Ung\\xFCltig: \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Ung\\xFCltige Zahl: muss ein Vielfaches von \${issue2.divisor} sein\`;
      case "unrecognized_keys":
        return \`\${issue2.keys.length > 1 ? "Unbekannte Schl\\xFCssel" : "Unbekannter Schl\\xFCssel"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Ung\\xFCltiger Schl\\xFCssel in \${issue2.origin}\`;
      case "invalid_union":
        return "Ung\\xFCltige Eingabe";
      case "invalid_element":
        return \`Ung\\xFCltiger Wert in \${issue2.origin}\`;
      default:
        return \`Ung\\xFCltige Eingabe\`;
    }
  };
}, "error");
function de_default() {
  return {
    localeError: error7()
  };
}
__name(de_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/en.js
var parsedType = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
}, "parsedType");
var error8 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "characters",
      verb: "to have"
    },
    file: {
      unit: "bytes",
      verb: "to have"
    },
    array: {
      unit: "items",
      verb: "to have"
    },
    set: {
      unit: "items",
      verb: "to have"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Invalid input: expected \${issue2.expected}, received \${parsedType(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Invalid input: expected \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Invalid option: expected one of \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Too big: expected \${issue2.origin ?? "value"} to have \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elements"}\`;
        return \`Too big: expected \${issue2.origin ?? "value"} to be \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Too small: expected \${issue2.origin} to have \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Too small: expected \${issue2.origin} to be \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Invalid string: must start with "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`Invalid string: must end with "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Invalid string: must include "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Invalid string: must match pattern \${_issue.pattern}\`;
        return \`Invalid \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Invalid number: must be a multiple of \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Unrecognized key\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Invalid key in \${issue2.origin}\`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return \`Invalid value in \${issue2.origin}\`;
      default:
        return \`Invalid input\`;
    }
  };
}, "error");
function en_default() {
  return {
    localeError: error8()
  };
}
__name(en_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/eo.js
var parsedType2 = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "nombro";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "tabelo";
      }
      if (data === null) {
        return "senvalora";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
}, "parsedType");
var error9 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "karaktrojn",
      verb: "havi"
    },
    file: {
      unit: "bajtojn",
      verb: "havi"
    },
    array: {
      unit: "elementojn",
      verb: "havi"
    },
    set: {
      unit: "elementojn",
      verb: "havi"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const Nouns = {
    regex: "enigo",
    email: "retadreso",
    url: "URL",
    emoji: "emo\\u011Dio",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datotempo",
    date: "ISO-dato",
    time: "ISO-tempo",
    duration: "ISO-da\\u016Dro",
    ipv4: "IPv4-adreso",
    ipv6: "IPv6-adreso",
    cidrv4: "IPv4-rango",
    cidrv6: "IPv6-rango",
    base64: "64-ume kodita karaktraro",
    base64url: "URL-64-ume kodita karaktraro",
    json_string: "JSON-karaktraro",
    e164: "E.164-nombro",
    jwt: "JWT",
    template_literal: "enigo"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Nevalida enigo: atendi\\u011Dis \${issue2.expected}, ricevi\\u011Dis \${parsedType2(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Nevalida enigo: atendi\\u011Dis \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Nevalida opcio: atendi\\u011Dis unu el \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Tro granda: atendi\\u011Dis ke \${issue2.origin ?? "valoro"} havu \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementojn"}\`;
        return \`Tro granda: atendi\\u011Dis ke \${issue2.origin ?? "valoro"} havu \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Tro malgranda: atendi\\u011Dis ke \${issue2.origin} havu \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Tro malgranda: atendi\\u011Dis ke \${issue2.origin} estu \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Nevalida karaktraro: devas komenci\\u011Di per "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Nevalida karaktraro: devas fini\\u011Di per "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Nevalida karaktraro: devas inkluzivi "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Nevalida karaktraro: devas kongrui kun la modelo \${_issue.pattern}\`;
        return \`Nevalida \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Nevalida nombro: devas esti oblo de \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Nekonata\${issue2.keys.length > 1 ? "j" : ""} \\u015Dlosilo\${issue2.keys.length > 1 ? "j" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Nevalida \\u015Dlosilo en \${issue2.origin}\`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return \`Nevalida valoro en \${issue2.origin}\`;
      default:
        return \`Nevalida enigo\`;
    }
  };
}, "error");
function eo_default() {
  return {
    localeError: error9()
  };
}
__name(eo_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/es.js
var error10 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "caracteres",
      verb: "tener"
    },
    file: {
      unit: "bytes",
      verb: "tener"
    },
    array: {
      unit: "elementos",
      verb: "tener"
    },
    set: {
      unit: "elementos",
      verb: "tener"
    }
  };
  const TypeNames = {
    string: "texto",
    number: "n\\xFAmero",
    boolean: "booleano",
    array: "arreglo",
    object: "objeto",
    set: "conjunto",
    file: "archivo",
    date: "fecha",
    bigint: "n\\xFAmero grande",
    symbol: "s\\xEDmbolo",
    undefined: "indefinido",
    null: "nulo",
    function: "funci\\xF3n",
    map: "mapa",
    record: "registro",
    tuple: "tupla",
    enum: "enumeraci\\xF3n",
    union: "uni\\xF3n",
    literal: "literal",
    promise: "promesa",
    void: "vac\\xEDo",
    never: "nunca",
    unknown: "desconocido",
    any: "cualquiera"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  __name(getTypeName, "getTypeName");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype) {
          return data.constructor.name;
        }
        return "object";
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "entrada",
    email: "direcci\\xF3n de correo electr\\xF3nico",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "fecha y hora ISO",
    date: "fecha ISO",
    time: "hora ISO",
    duration: "duraci\\xF3n ISO",
    ipv4: "direcci\\xF3n IPv4",
    ipv6: "direcci\\xF3n IPv6",
    cidrv4: "rango IPv4",
    cidrv6: "rango IPv6",
    base64: "cadena codificada en base64",
    base64url: "URL codificada en base64",
    json_string: "cadena JSON",
    e164: "n\\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Entrada inv\\xE1lida: se esperaba \${getTypeName(issue2.expected)}, recibido \${getTypeName(parsedType7(issue2.input))}\`;
      // return \`Entrada inválida: se esperaba \${issue.expected}, recibido \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Entrada inv\\xE1lida: se esperaba \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Opci\\xF3n inv\\xE1lida: se esperaba una de \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) return \`Demasiado grande: se esperaba que \${origin ?? "valor"} tuviera \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementos"}\`;
        return \`Demasiado grande: se esperaba que \${origin ?? "valor"} fuera \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return \`Demasiado peque\\xF1o: se esperaba que \${origin} tuviera \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Demasiado peque\\xF1o: se esperaba que \${origin} fuera \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Cadena inv\\xE1lida: debe comenzar con "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Cadena inv\\xE1lida: debe terminar en "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Cadena inv\\xE1lida: debe incluir "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Cadena inv\\xE1lida: debe coincidir con el patr\\xF3n \${_issue.pattern}\`;
        return \`Inv\\xE1lido \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`N\\xFAmero inv\\xE1lido: debe ser m\\xFAltiplo de \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Llave\${issue2.keys.length > 1 ? "s" : ""} desconocida\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Llave inv\\xE1lida en \${getTypeName(issue2.origin)}\`;
      case "invalid_union":
        return "Entrada inv\\xE1lida";
      case "invalid_element":
        return \`Valor inv\\xE1lido en \${getTypeName(issue2.origin)}\`;
      default:
        return \`Entrada inv\\xE1lida\`;
    }
  };
}, "error");
function es_default() {
  return {
    localeError: error10()
  };
}
__name(es_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/fa.js
var error11 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u06A9\\u0627\\u0631\\u0627\\u06A9\\u062A\\u0631",
      verb: "\\u062F\\u0627\\u0634\\u062A\\u0647 \\u0628\\u0627\\u0634\\u062F"
    },
    file: {
      unit: "\\u0628\\u0627\\u06CC\\u062A",
      verb: "\\u062F\\u0627\\u0634\\u062A\\u0647 \\u0628\\u0627\\u0634\\u062F"
    },
    array: {
      unit: "\\u0622\\u06CC\\u062A\\u0645",
      verb: "\\u062F\\u0627\\u0634\\u062A\\u0647 \\u0628\\u0627\\u0634\\u062F"
    },
    set: {
      unit: "\\u0622\\u06CC\\u062A\\u0645",
      verb: "\\u062F\\u0627\\u0634\\u062A\\u0647 \\u0628\\u0627\\u0634\\u062F"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0639\\u062F\\u062F";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u0622\\u0631\\u0627\\u06CC\\u0647";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0648\\u0631\\u0648\\u062F\\u06CC",
    email: "\\u0622\\u062F\\u0631\\u0633 \\u0627\\u06CC\\u0645\\u06CC\\u0644",
    url: "URL",
    emoji: "\\u0627\\u06CC\\u0645\\u0648\\u062C\\u06CC",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u062A\\u0627\\u0631\\u06CC\\u062E \\u0648 \\u0632\\u0645\\u0627\\u0646 \\u0627\\u06CC\\u0632\\u0648",
    date: "\\u062A\\u0627\\u0631\\u06CC\\u062E \\u0627\\u06CC\\u0632\\u0648",
    time: "\\u0632\\u0645\\u0627\\u0646 \\u0627\\u06CC\\u0632\\u0648",
    duration: "\\u0645\\u062F\\u062A \\u0632\\u0645\\u0627\\u0646 \\u0627\\u06CC\\u0632\\u0648",
    ipv4: "IPv4 \\u0622\\u062F\\u0631\\u0633",
    ipv6: "IPv6 \\u0622\\u062F\\u0631\\u0633",
    cidrv4: "IPv4 \\u062F\\u0627\\u0645\\u0646\\u0647",
    cidrv6: "IPv6 \\u062F\\u0627\\u0645\\u0646\\u0647",
    base64: "base64-encoded \\u0631\\u0634\\u062A\\u0647",
    base64url: "base64url-encoded \\u0631\\u0634\\u062A\\u0647",
    json_string: "JSON \\u0631\\u0634\\u062A\\u0647",
    e164: "E.164 \\u0639\\u062F\\u062F",
    jwt: "JWT",
    template_literal: "\\u0648\\u0631\\u0648\\u062F\\u06CC"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0648\\u0631\\u0648\\u062F\\u06CC \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0645\\u06CC\\u200C\\u0628\\u0627\\u06CC\\u0633\\u062A \${issue2.expected} \\u0645\\u06CC\\u200C\\u0628\\u0648\\u062F\\u060C \${parsedType7(issue2.input)} \\u062F\\u0631\\u06CC\\u0627\\u0641\\u062A \\u0634\\u062F\`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return \`\\u0648\\u0631\\u0648\\u062F\\u06CC \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0645\\u06CC\\u200C\\u0628\\u0627\\u06CC\\u0633\\u062A \${stringifyPrimitive(issue2.values[0])} \\u0645\\u06CC\\u200C\\u0628\\u0648\\u062F\`;
        }
        return \`\\u06AF\\u0632\\u06CC\\u0646\\u0647 \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0645\\u06CC\\u200C\\u0628\\u0627\\u06CC\\u0633\\u062A \\u06CC\\u06A9\\u06CC \\u0627\\u0632 \${joinValues(issue2.values, "|")} \\u0645\\u06CC\\u200C\\u0628\\u0648\\u062F\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u062E\\u06CC\\u0644\\u06CC \\u0628\\u0632\\u0631\\u06AF: \${issue2.origin ?? "\\u0645\\u0642\\u062F\\u0627\\u0631"} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u0639\\u0646\\u0635\\u0631"} \\u0628\\u0627\\u0634\\u062F\`;
        }
        return \`\\u062E\\u06CC\\u0644\\u06CC \\u0628\\u0632\\u0631\\u06AF: \${issue2.origin ?? "\\u0645\\u0642\\u062F\\u0627\\u0631"} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.maximum.toString()} \\u0628\\u0627\\u0634\\u062F\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u062E\\u06CC\\u0644\\u06CC \\u06A9\\u0648\\u0686\\u06A9: \${issue2.origin} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.minimum.toString()} \${sizing.unit} \\u0628\\u0627\\u0634\\u062F\`;
        }
        return \`\\u062E\\u06CC\\u0644\\u06CC \\u06A9\\u0648\\u0686\\u06A9: \${issue2.origin} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.minimum.toString()} \\u0628\\u0627\\u0634\\u062F\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u0631\\u0634\\u062A\\u0647 \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0628\\u0627\\u06CC\\u062F \\u0628\\u0627 "\${_issue.prefix}" \\u0634\\u0631\\u0648\\u0639 \\u0634\\u0648\\u062F\`;
        }
        if (_issue.format === "ends_with") {
          return \`\\u0631\\u0634\\u062A\\u0647 \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0628\\u0627\\u06CC\\u062F \\u0628\\u0627 "\${_issue.suffix}" \\u062A\\u0645\\u0627\\u0645 \\u0634\\u0648\\u062F\`;
        }
        if (_issue.format === "includes") {
          return \`\\u0631\\u0634\\u062A\\u0647 \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0628\\u0627\\u06CC\\u062F \\u0634\\u0627\\u0645\\u0644 "\${_issue.includes}" \\u0628\\u0627\\u0634\\u062F\`;
        }
        if (_issue.format === "regex") {
          return \`\\u0631\\u0634\\u062A\\u0647 \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0628\\u0627\\u06CC\\u062F \\u0628\\u0627 \\u0627\\u0644\\u06AF\\u0648\\u06CC \${_issue.pattern} \\u0645\\u0637\\u0627\\u0628\\u0642\\u062A \\u062F\\u0627\\u0634\\u062A\\u0647 \\u0628\\u0627\\u0634\\u062F\`;
        }
        return \`\${Nouns[_issue.format] ?? issue2.format} \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631\`;
      }
      case "not_multiple_of":
        return \`\\u0639\\u062F\\u062F \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631: \\u0628\\u0627\\u06CC\\u062F \\u0645\\u0636\\u0631\\u0628 \${issue2.divisor} \\u0628\\u0627\\u0634\\u062F\`;
      case "unrecognized_keys":
        return \`\\u06A9\\u0644\\u06CC\\u062F\${issue2.keys.length > 1 ? "\\u0647\\u0627\\u06CC" : ""} \\u0646\\u0627\\u0634\\u0646\\u0627\\u0633: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u06A9\\u0644\\u06CC\\u062F \\u0646\\u0627\\u0634\\u0646\\u0627\\u0633 \\u062F\\u0631 \${issue2.origin}\`;
      case "invalid_union":
        return \`\\u0648\\u0631\\u0648\\u062F\\u06CC \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631\`;
      case "invalid_element":
        return \`\\u0645\\u0642\\u062F\\u0627\\u0631 \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631 \\u062F\\u0631 \${issue2.origin}\`;
      default:
        return \`\\u0648\\u0631\\u0648\\u062F\\u06CC \\u0646\\u0627\\u0645\\u0639\\u062A\\u0628\\u0631\`;
    }
  };
}, "error");
function fa_default() {
  return {
    localeError: error11()
  };
}
__name(fa_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/fi.js
var error12 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "merkki\\xE4",
      subject: "merkkijonon"
    },
    file: {
      unit: "tavua",
      subject: "tiedoston"
    },
    array: {
      unit: "alkiota",
      subject: "listan"
    },
    set: {
      unit: "alkiota",
      subject: "joukon"
    },
    number: {
      unit: "",
      subject: "luvun"
    },
    bigint: {
      unit: "",
      subject: "suuren kokonaisluvun"
    },
    int: {
      unit: "",
      subject: "kokonaisluvun"
    },
    date: {
      unit: "",
      subject: "p\\xE4iv\\xE4m\\xE4\\xE4r\\xE4n"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "s\\xE4\\xE4nn\\xF6llinen lauseke",
    email: "s\\xE4hk\\xF6postiosoite",
    url: "URL-osoite",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-aikaleima",
    date: "ISO-p\\xE4iv\\xE4m\\xE4\\xE4r\\xE4",
    time: "ISO-aika",
    duration: "ISO-kesto",
    ipv4: "IPv4-osoite",
    ipv6: "IPv6-osoite",
    cidrv4: "IPv4-alue",
    cidrv6: "IPv6-alue",
    base64: "base64-koodattu merkkijono",
    base64url: "base64url-koodattu merkkijono",
    json_string: "JSON-merkkijono",
    e164: "E.164-luku",
    jwt: "JWT",
    template_literal: "templaattimerkkijono"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Virheellinen tyyppi: odotettiin \${issue2.expected}, oli \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Virheellinen sy\\xF6te: t\\xE4ytyy olla \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Virheellinen valinta: t\\xE4ytyy olla yksi seuraavista: \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Liian suuri: \${sizing.subject} t\\xE4ytyy olla \${adj}\${issue2.maximum.toString()} \${sizing.unit}\`.trim();
        }
        return \`Liian suuri: arvon t\\xE4ytyy olla \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Liian pieni: \${sizing.subject} t\\xE4ytyy olla \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`.trim();
        }
        return \`Liian pieni: arvon t\\xE4ytyy olla \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Virheellinen sy\\xF6te: t\\xE4ytyy alkaa "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Virheellinen sy\\xF6te: t\\xE4ytyy loppua "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Virheellinen sy\\xF6te: t\\xE4ytyy sis\\xE4lt\\xE4\\xE4 "\${_issue.includes}"\`;
        if (_issue.format === "regex") {
          return \`Virheellinen sy\\xF6te: t\\xE4ytyy vastata s\\xE4\\xE4nn\\xF6llist\\xE4 lauseketta \${_issue.pattern}\`;
        }
        return \`Virheellinen \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Virheellinen luku: t\\xE4ytyy olla luvun \${issue2.divisor} monikerta\`;
      case "unrecognized_keys":
        return \`\${issue2.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return \`Virheellinen sy\\xF6te\`;
    }
  };
}, "error");
function fi_default() {
  return {
    localeError: error12()
  };
}
__name(fi_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/fr.js
var error13 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "caract\\xE8res",
      verb: "avoir"
    },
    file: {
      unit: "octets",
      verb: "avoir"
    },
    array: {
      unit: "\\xE9l\\xE9ments",
      verb: "avoir"
    },
    set: {
      unit: "\\xE9l\\xE9ments",
      verb: "avoir"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombre";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tableau";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "entr\\xE9e",
    email: "adresse e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date et heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "dur\\xE9e ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "cha\\xEEne encod\\xE9e en base64",
    base64url: "cha\\xEEne encod\\xE9e en base64url",
    json_string: "cha\\xEEne JSON",
    e164: "num\\xE9ro E.164",
    jwt: "JWT",
    template_literal: "entr\\xE9e"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Entr\\xE9e invalide : \${issue2.expected} attendu, \${parsedType7(issue2.input)} re\\xE7u\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Entr\\xE9e invalide : \${stringifyPrimitive(issue2.values[0])} attendu\`;
        return \`Option invalide : une valeur parmi \${joinValues(issue2.values, "|")} attendue\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Trop grand : \${issue2.origin ?? "valeur"} doit \${sizing.verb} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\xE9l\\xE9ment(s)"}\`;
        return \`Trop grand : \${issue2.origin ?? "valeur"} doit \\xEAtre \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Trop petit : \${issue2.origin} doit \${sizing.verb} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Trop petit : \${issue2.origin} doit \\xEAtre \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Cha\\xEEne invalide : doit commencer par "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Cha\\xEEne invalide : doit se terminer par "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Cha\\xEEne invalide : doit inclure "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Cha\\xEEne invalide : doit correspondre au mod\\xE8le \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} invalide\`;
      }
      case "not_multiple_of":
        return \`Nombre invalide : doit \\xEAtre un multiple de \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Cl\\xE9\${issue2.keys.length > 1 ? "s" : ""} non reconnue\${issue2.keys.length > 1 ? "s" : ""} : \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Cl\\xE9 invalide dans \${issue2.origin}\`;
      case "invalid_union":
        return "Entr\\xE9e invalide";
      case "invalid_element":
        return \`Valeur invalide dans \${issue2.origin}\`;
      default:
        return \`Entr\\xE9e invalide\`;
    }
  };
}, "error");
function fr_default() {
  return {
    localeError: error13()
  };
}
__name(fr_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/fr-CA.js
var error14 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "caract\\xE8res",
      verb: "avoir"
    },
    file: {
      unit: "octets",
      verb: "avoir"
    },
    array: {
      unit: "\\xE9l\\xE9ments",
      verb: "avoir"
    },
    set: {
      unit: "\\xE9l\\xE9ments",
      verb: "avoir"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "entr\\xE9e",
    email: "adresse courriel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date-heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "dur\\xE9e ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "cha\\xEEne encod\\xE9e en base64",
    base64url: "cha\\xEEne encod\\xE9e en base64url",
    json_string: "cha\\xEEne JSON",
    e164: "num\\xE9ro E.164",
    jwt: "JWT",
    template_literal: "entr\\xE9e"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Entr\\xE9e invalide : attendu \${issue2.expected}, re\\xE7u \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Entr\\xE9e invalide : attendu \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Option invalide : attendu l'une des valeurs suivantes \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "\\u2264" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Trop grand : attendu que \${issue2.origin ?? "la valeur"} ait \${adj}\${issue2.maximum.toString()} \${sizing.unit}\`;
        return \`Trop grand : attendu que \${issue2.origin ?? "la valeur"} soit \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\\u2265" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Trop petit : attendu que \${issue2.origin} ait \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Trop petit : attendu que \${issue2.origin} soit \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Cha\\xEEne invalide : doit commencer par "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`Cha\\xEEne invalide : doit se terminer par "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Cha\\xEEne invalide : doit inclure "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Cha\\xEEne invalide : doit correspondre au motif \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} invalide\`;
      }
      case "not_multiple_of":
        return \`Nombre invalide : doit \\xEAtre un multiple de \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Cl\\xE9\${issue2.keys.length > 1 ? "s" : ""} non reconnue\${issue2.keys.length > 1 ? "s" : ""} : \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Cl\\xE9 invalide dans \${issue2.origin}\`;
      case "invalid_union":
        return "Entr\\xE9e invalide";
      case "invalid_element":
        return \`Valeur invalide dans \${issue2.origin}\`;
      default:
        return \`Entr\\xE9e invalide\`;
    }
  };
}, "error");
function fr_CA_default() {
  return {
    localeError: error14()
  };
}
__name(fr_CA_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/he.js
var error15 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u05D0\\u05D5\\u05EA\\u05D9\\u05D5\\u05EA",
      verb: "\\u05DC\\u05DB\\u05DC\\u05D5\\u05DC"
    },
    file: {
      unit: "\\u05D1\\u05D9\\u05D9\\u05D8\\u05D9\\u05DD",
      verb: "\\u05DC\\u05DB\\u05DC\\u05D5\\u05DC"
    },
    array: {
      unit: "\\u05E4\\u05E8\\u05D9\\u05D8\\u05D9\\u05DD",
      verb: "\\u05DC\\u05DB\\u05DC\\u05D5\\u05DC"
    },
    set: {
      unit: "\\u05E4\\u05E8\\u05D9\\u05D8\\u05D9\\u05DD",
      verb: "\\u05DC\\u05DB\\u05DC\\u05D5\\u05DC"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u05E7\\u05DC\\u05D8",
    email: "\\u05DB\\u05EA\\u05D5\\u05D1\\u05EA \\u05D0\\u05D9\\u05DE\\u05D9\\u05D9\\u05DC",
    url: "\\u05DB\\u05EA\\u05D5\\u05D1\\u05EA \\u05E8\\u05E9\\u05EA",
    emoji: "\\u05D0\\u05D9\\u05DE\\u05D5\\u05D2'\\u05D9",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u05EA\\u05D0\\u05E8\\u05D9\\u05DA \\u05D5\\u05D6\\u05DE\\u05DF ISO",
    date: "\\u05EA\\u05D0\\u05E8\\u05D9\\u05DA ISO",
    time: "\\u05D6\\u05DE\\u05DF ISO",
    duration: "\\u05DE\\u05E9\\u05DA \\u05D6\\u05DE\\u05DF ISO",
    ipv4: "\\u05DB\\u05EA\\u05D5\\u05D1\\u05EA IPv4",
    ipv6: "\\u05DB\\u05EA\\u05D5\\u05D1\\u05EA IPv6",
    cidrv4: "\\u05D8\\u05D5\\u05D5\\u05D7 IPv4",
    cidrv6: "\\u05D8\\u05D5\\u05D5\\u05D7 IPv6",
    base64: "\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA \\u05D1\\u05D1\\u05E1\\u05D9\\u05E1 64",
    base64url: "\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA \\u05D1\\u05D1\\u05E1\\u05D9\\u05E1 64 \\u05DC\\u05DB\\u05EA\\u05D5\\u05D1\\u05D5\\u05EA \\u05E8\\u05E9\\u05EA",
    json_string: "\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA JSON",
    e164: "\\u05DE\\u05E1\\u05E4\\u05E8 E.164",
    jwt: "JWT",
    template_literal: "\\u05E7\\u05DC\\u05D8"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u05E7\\u05DC\\u05D8 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF: \\u05E6\\u05E8\\u05D9\\u05DA \${issue2.expected}, \\u05D4\\u05EA\\u05E7\\u05D1\\u05DC \${parsedType7(issue2.input)}\`;
      // return \`Invalid input: expected \${issue.expected}, received \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u05E7\\u05DC\\u05D8 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF: \\u05E6\\u05E8\\u05D9\\u05DA \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u05E7\\u05DC\\u05D8 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF: \\u05E6\\u05E8\\u05D9\\u05DA \\u05D0\\u05D7\\u05EA \\u05DE\\u05D4\\u05D0\\u05E4\\u05E9\\u05E8\\u05D5\\u05D9\\u05D5\\u05EA  \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u05D2\\u05D3\\u05D5\\u05DC \\u05DE\\u05D3\\u05D9: \${issue2.origin ?? "value"} \\u05E6\\u05E8\\u05D9\\u05DA \\u05DC\\u05D4\\u05D9\\u05D5\\u05EA \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elements"}\`;
        return \`\\u05D2\\u05D3\\u05D5\\u05DC \\u05DE\\u05D3\\u05D9: \${issue2.origin ?? "value"} \\u05E6\\u05E8\\u05D9\\u05DA \\u05DC\\u05D4\\u05D9\\u05D5\\u05EA \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u05E7\\u05D8\\u05DF \\u05DE\\u05D3\\u05D9: \${issue2.origin} \\u05E6\\u05E8\\u05D9\\u05DA \\u05DC\\u05D4\\u05D9\\u05D5\\u05EA \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u05E7\\u05D8\\u05DF \\u05DE\\u05D3\\u05D9: \${issue2.origin} \\u05E6\\u05E8\\u05D9\\u05DA \\u05DC\\u05D4\\u05D9\\u05D5\\u05EA \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05E0\\u05D4: \\u05D7\\u05D9\\u05D9\\u05D1\\u05EA \\u05DC\\u05D4\\u05EA\\u05D7\\u05D9\\u05DC \\u05D1"\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05E0\\u05D4: \\u05D7\\u05D9\\u05D9\\u05D1\\u05EA \\u05DC\\u05D4\\u05E1\\u05EA\\u05D9\\u05D9\\u05DD \\u05D1 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05E0\\u05D4: \\u05D7\\u05D9\\u05D9\\u05D1\\u05EA \\u05DC\\u05DB\\u05DC\\u05D5\\u05DC "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u05DE\\u05D7\\u05E8\\u05D5\\u05D6\\u05EA \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05E0\\u05D4: \\u05D7\\u05D9\\u05D9\\u05D1\\u05EA \\u05DC\\u05D4\\u05EA\\u05D0\\u05D9\\u05DD \\u05DC\\u05EA\\u05D1\\u05E0\\u05D9\\u05EA \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF\`;
      }
      case "not_multiple_of":
        return \`\\u05DE\\u05E1\\u05E4\\u05E8 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF: \\u05D7\\u05D9\\u05D9\\u05D1 \\u05DC\\u05D4\\u05D9\\u05D5\\u05EA \\u05DE\\u05DB\\u05E4\\u05DC\\u05D4 \\u05E9\\u05DC \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\u05DE\\u05E4\\u05EA\\u05D7\${issue2.keys.length > 1 ? "\\u05D5\\u05EA" : ""} \\u05DC\\u05D0 \\u05DE\\u05D6\\u05D5\\u05D4\${issue2.keys.length > 1 ? "\\u05D9\\u05DD" : "\\u05D4"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u05DE\\u05E4\\u05EA\\u05D7 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF \\u05D1\${issue2.origin}\`;
      case "invalid_union":
        return "\\u05E7\\u05DC\\u05D8 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF";
      case "invalid_element":
        return \`\\u05E2\\u05E8\\u05DA \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF \\u05D1\${issue2.origin}\`;
      default:
        return \`\\u05E7\\u05DC\\u05D8 \\u05DC\\u05D0 \\u05EA\\u05E7\\u05D9\\u05DF\`;
    }
  };
}, "error");
function he_default() {
  return {
    localeError: error15()
  };
}
__name(he_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/hu.js
var error16 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "karakter",
      verb: "legyen"
    },
    file: {
      unit: "byte",
      verb: "legyen"
    },
    array: {
      unit: "elem",
      verb: "legyen"
    },
    set: {
      unit: "elem",
      verb: "legyen"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "sz\\xE1m";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "t\\xF6mb";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "bemenet",
    email: "email c\\xEDm",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO id\\u0151b\\xE9lyeg",
    date: "ISO d\\xE1tum",
    time: "ISO id\\u0151",
    duration: "ISO id\\u0151intervallum",
    ipv4: "IPv4 c\\xEDm",
    ipv6: "IPv6 c\\xEDm",
    cidrv4: "IPv4 tartom\\xE1ny",
    cidrv6: "IPv6 tartom\\xE1ny",
    base64: "base64-k\\xF3dolt string",
    base64url: "base64url-k\\xF3dolt string",
    json_string: "JSON string",
    e164: "E.164 sz\\xE1m",
    jwt: "JWT",
    template_literal: "bemenet"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\xC9rv\\xE9nytelen bemenet: a v\\xE1rt \\xE9rt\\xE9k \${issue2.expected}, a kapott \\xE9rt\\xE9k \${parsedType7(issue2.input)}\`;
      // return \`Invalid input: expected \${issue.expected}, received \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\xC9rv\\xE9nytelen bemenet: a v\\xE1rt \\xE9rt\\xE9k \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\xC9rv\\xE9nytelen opci\\xF3: valamelyik \\xE9rt\\xE9k v\\xE1rt \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`T\\xFAl nagy: \${issue2.origin ?? "\\xE9rt\\xE9k"} m\\xE9rete t\\xFAl nagy \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elem"}\`;
        return \`T\\xFAl nagy: a bemeneti \\xE9rt\\xE9k \${issue2.origin ?? "\\xE9rt\\xE9k"} t\\xFAl nagy: \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`T\\xFAl kicsi: a bemeneti \\xE9rt\\xE9k \${issue2.origin} m\\xE9rete t\\xFAl kicsi \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`T\\xFAl kicsi: a bemeneti \\xE9rt\\xE9k \${issue2.origin} t\\xFAl kicsi \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\xC9rv\\xE9nytelen string: "\${_issue.prefix}" \\xE9rt\\xE9kkel kell kezd\\u0151dnie\`;
        if (_issue.format === "ends_with") return \`\\xC9rv\\xE9nytelen string: "\${_issue.suffix}" \\xE9rt\\xE9kkel kell v\\xE9gz\\u0151dnie\`;
        if (_issue.format === "includes") return \`\\xC9rv\\xE9nytelen string: "\${_issue.includes}" \\xE9rt\\xE9ket kell tartalmaznia\`;
        if (_issue.format === "regex") return \`\\xC9rv\\xE9nytelen string: \${_issue.pattern} mint\\xE1nak kell megfelelnie\`;
        return \`\\xC9rv\\xE9nytelen \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\xC9rv\\xE9nytelen sz\\xE1m: \${issue2.divisor} t\\xF6bbsz\\xF6r\\xF6s\\xE9nek kell lennie\`;
      case "unrecognized_keys":
        return \`Ismeretlen kulcs\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\xC9rv\\xE9nytelen kulcs \${issue2.origin}\`;
      case "invalid_union":
        return "\\xC9rv\\xE9nytelen bemenet";
      case "invalid_element":
        return \`\\xC9rv\\xE9nytelen \\xE9rt\\xE9k: \${issue2.origin}\`;
      default:
        return \`\\xC9rv\\xE9nytelen bemenet\`;
    }
  };
}, "error");
function hu_default() {
  return {
    localeError: error16()
  };
}
__name(hu_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/id.js
var error17 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "karakter",
      verb: "memiliki"
    },
    file: {
      unit: "byte",
      verb: "memiliki"
    },
    array: {
      unit: "item",
      verb: "memiliki"
    },
    set: {
      unit: "item",
      verb: "memiliki"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "input",
    email: "alamat email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tanggal dan waktu format ISO",
    date: "tanggal format ISO",
    time: "jam format ISO",
    duration: "durasi format ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "rentang alamat IPv4",
    cidrv6: "rentang alamat IPv6",
    base64: "string dengan enkode base64",
    base64url: "string dengan enkode base64url",
    json_string: "string JSON",
    e164: "angka E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Input tidak valid: diharapkan \${issue2.expected}, diterima \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Input tidak valid: diharapkan \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Pilihan tidak valid: diharapkan salah satu dari \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Terlalu besar: diharapkan \${issue2.origin ?? "value"} memiliki \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elemen"}\`;
        return \`Terlalu besar: diharapkan \${issue2.origin ?? "value"} menjadi \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Terlalu kecil: diharapkan \${issue2.origin} memiliki \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Terlalu kecil: diharapkan \${issue2.origin} menjadi \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`String tidak valid: harus dimulai dengan "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`String tidak valid: harus berakhir dengan "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`String tidak valid: harus menyertakan "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`String tidak valid: harus sesuai pola \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} tidak valid\`;
      }
      case "not_multiple_of":
        return \`Angka tidak valid: harus kelipatan dari \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Kunci tidak dikenali \${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Kunci tidak valid di \${issue2.origin}\`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return \`Nilai tidak valid di \${issue2.origin}\`;
      default:
        return \`Input tidak valid\`;
    }
  };
}, "error");
function id_default() {
  return {
    localeError: error17()
  };
}
__name(id_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/is.js
var parsedType3 = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "n\\xFAmer";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "fylki";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
}, "parsedType");
var error18 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "stafi",
      verb: "a\\xF0 hafa"
    },
    file: {
      unit: "b\\xE6ti",
      verb: "a\\xF0 hafa"
    },
    array: {
      unit: "hluti",
      verb: "a\\xF0 hafa"
    },
    set: {
      unit: "hluti",
      verb: "a\\xF0 hafa"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const Nouns = {
    regex: "gildi",
    email: "netfang",
    url: "vefsl\\xF3\\xF0",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dagsetning og t\\xEDmi",
    date: "ISO dagsetning",
    time: "ISO t\\xEDmi",
    duration: "ISO t\\xEDmalengd",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded strengur",
    base64url: "base64url-encoded strengur",
    json_string: "JSON strengur",
    e164: "E.164 t\\xF6lugildi",
    jwt: "JWT",
    template_literal: "gildi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Rangt gildi: \\xDE\\xFA sl\\xF3st inn \${parsedType3(issue2.input)} \\xFEar sem \\xE1 a\\xF0 vera \${issue2.expected}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Rangt gildi: gert r\\xE1\\xF0 fyrir \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\xD3gilt val: m\\xE1 vera eitt af eftirfarandi \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Of st\\xF3rt: gert er r\\xE1\\xF0 fyrir a\\xF0 \${issue2.origin ?? "gildi"} hafi \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "hluti"}\`;
        return \`Of st\\xF3rt: gert er r\\xE1\\xF0 fyrir a\\xF0 \${issue2.origin ?? "gildi"} s\\xE9 \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Of l\\xEDti\\xF0: gert er r\\xE1\\xF0 fyrir a\\xF0 \${issue2.origin} hafi \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Of l\\xEDti\\xF0: gert er r\\xE1\\xF0 fyrir a\\xF0 \${issue2.origin} s\\xE9 \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\xD3gildur strengur: ver\\xF0ur a\\xF0 byrja \\xE1 "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`\\xD3gildur strengur: ver\\xF0ur a\\xF0 enda \\xE1 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\xD3gildur strengur: ver\\xF0ur a\\xF0 innihalda "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\xD3gildur strengur: ver\\xF0ur a\\xF0 fylgja mynstri \${_issue.pattern}\`;
        return \`Rangt \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`R\\xF6ng tala: ver\\xF0ur a\\xF0 vera margfeldi af \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\xD3\\xFEekkt \${issue2.keys.length > 1 ? "ir lyklar" : "ur lykill"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Rangur lykill \\xED \${issue2.origin}\`;
      case "invalid_union":
        return "Rangt gildi";
      case "invalid_element":
        return \`Rangt gildi \\xED \${issue2.origin}\`;
      default:
        return \`Rangt gildi\`;
    }
  };
}, "error");
function is_default() {
  return {
    localeError: error18()
  };
}
__name(is_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/it.js
var error19 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "caratteri",
      verb: "avere"
    },
    file: {
      unit: "byte",
      verb: "avere"
    },
    array: {
      unit: "elementi",
      verb: "avere"
    },
    set: {
      unit: "elementi",
      verb: "avere"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "vettore";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "input",
    email: "indirizzo email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e ora ISO",
    date: "data ISO",
    time: "ora ISO",
    duration: "durata ISO",
    ipv4: "indirizzo IPv4",
    ipv6: "indirizzo IPv6",
    cidrv4: "intervallo IPv4",
    cidrv6: "intervallo IPv6",
    base64: "stringa codificata in base64",
    base64url: "URL codificata in base64",
    json_string: "stringa JSON",
    e164: "numero E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Input non valido: atteso \${issue2.expected}, ricevuto \${parsedType7(issue2.input)}\`;
      // return \`Input non valido: atteso \${issue.expected}, ricevuto \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Input non valido: atteso \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Opzione non valida: atteso uno tra \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Troppo grande: \${issue2.origin ?? "valore"} deve avere \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementi"}\`;
        return \`Troppo grande: \${issue2.origin ?? "valore"} deve essere \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Troppo piccolo: \${issue2.origin} deve avere \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Troppo piccolo: \${issue2.origin} deve essere \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Stringa non valida: deve iniziare con "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Stringa non valida: deve terminare con "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Stringa non valida: deve includere "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Stringa non valida: deve corrispondere al pattern \${_issue.pattern}\`;
        return \`Invalid \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Numero non valido: deve essere un multiplo di \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Chiav\${issue2.keys.length > 1 ? "i" : "e"} non riconosciut\${issue2.keys.length > 1 ? "e" : "a"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Chiave non valida in \${issue2.origin}\`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return \`Valore non valido in \${issue2.origin}\`;
      default:
        return \`Input non valido\`;
    }
  };
}, "error");
function it_default() {
  return {
    localeError: error19()
  };
}
__name(it_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ja.js
var error20 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u6587\\u5B57",
      verb: "\\u3067\\u3042\\u308B"
    },
    file: {
      unit: "\\u30D0\\u30A4\\u30C8",
      verb: "\\u3067\\u3042\\u308B"
    },
    array: {
      unit: "\\u8981\\u7D20",
      verb: "\\u3067\\u3042\\u308B"
    },
    set: {
      unit: "\\u8981\\u7D20",
      verb: "\\u3067\\u3042\\u308B"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u6570\\u5024";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u914D\\u5217";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u5165\\u529B\\u5024",
    email: "\\u30E1\\u30FC\\u30EB\\u30A2\\u30C9\\u30EC\\u30B9",
    url: "URL",
    emoji: "\\u7D75\\u6587\\u5B57",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO\\u65E5\\u6642",
    date: "ISO\\u65E5\\u4ED8",
    time: "ISO\\u6642\\u523B",
    duration: "ISO\\u671F\\u9593",
    ipv4: "IPv4\\u30A2\\u30C9\\u30EC\\u30B9",
    ipv6: "IPv6\\u30A2\\u30C9\\u30EC\\u30B9",
    cidrv4: "IPv4\\u7BC4\\u56F2",
    cidrv6: "IPv6\\u7BC4\\u56F2",
    base64: "base64\\u30A8\\u30F3\\u30B3\\u30FC\\u30C9\\u6587\\u5B57\\u5217",
    base64url: "base64url\\u30A8\\u30F3\\u30B3\\u30FC\\u30C9\\u6587\\u5B57\\u5217",
    json_string: "JSON\\u6587\\u5B57\\u5217",
    e164: "E.164\\u756A\\u53F7",
    jwt: "JWT",
    template_literal: "\\u5165\\u529B\\u5024"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u7121\\u52B9\\u306A\\u5165\\u529B: \${issue2.expected}\\u304C\\u671F\\u5F85\\u3055\\u308C\\u307E\\u3057\\u305F\\u304C\\u3001\${parsedType7(issue2.input)}\\u304C\\u5165\\u529B\\u3055\\u308C\\u307E\\u3057\\u305F\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u7121\\u52B9\\u306A\\u5165\\u529B: \${stringifyPrimitive(issue2.values[0])}\\u304C\\u671F\\u5F85\\u3055\\u308C\\u307E\\u3057\\u305F\`;
        return \`\\u7121\\u52B9\\u306A\\u9078\\u629E: \${joinValues(issue2.values, "\\u3001")}\\u306E\\u3044\\u305A\\u308C\\u304B\\u3067\\u3042\\u308B\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
      case "too_big": {
        const adj = issue2.inclusive ? "\\u4EE5\\u4E0B\\u3067\\u3042\\u308B" : "\\u3088\\u308A\\u5C0F\\u3055\\u3044";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u5927\\u304D\\u3059\\u304E\\u308B\\u5024: \${issue2.origin ?? "\\u5024"}\\u306F\${issue2.maximum.toString()}\${sizing.unit ?? "\\u8981\\u7D20"}\${adj}\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
        return \`\\u5927\\u304D\\u3059\\u304E\\u308B\\u5024: \${issue2.origin ?? "\\u5024"}\\u306F\${issue2.maximum.toString()}\${adj}\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\\u4EE5\\u4E0A\\u3067\\u3042\\u308B" : "\\u3088\\u308A\\u5927\\u304D\\u3044";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u5C0F\\u3055\\u3059\\u304E\\u308B\\u5024: \${issue2.origin}\\u306F\${issue2.minimum.toString()}\${sizing.unit}\${adj}\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
        return \`\\u5C0F\\u3055\\u3059\\u304E\\u308B\\u5024: \${issue2.origin}\\u306F\${issue2.minimum.toString()}\${adj}\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u7121\\u52B9\\u306A\\u6587\\u5B57\\u5217: "\${_issue.prefix}"\\u3067\\u59CB\\u307E\\u308B\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
        if (_issue.format === "ends_with") return \`\\u7121\\u52B9\\u306A\\u6587\\u5B57\\u5217: "\${_issue.suffix}"\\u3067\\u7D42\\u308F\\u308B\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
        if (_issue.format === "includes") return \`\\u7121\\u52B9\\u306A\\u6587\\u5B57\\u5217: "\${_issue.includes}"\\u3092\\u542B\\u3080\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
        if (_issue.format === "regex") return \`\\u7121\\u52B9\\u306A\\u6587\\u5B57\\u5217: \\u30D1\\u30BF\\u30FC\\u30F3\${_issue.pattern}\\u306B\\u4E00\\u81F4\\u3059\\u308B\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
        return \`\\u7121\\u52B9\\u306A\${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u7121\\u52B9\\u306A\\u6570\\u5024: \${issue2.divisor}\\u306E\\u500D\\u6570\\u3067\\u3042\\u308B\\u5FC5\\u8981\\u304C\\u3042\\u308A\\u307E\\u3059\`;
      case "unrecognized_keys":
        return \`\\u8A8D\\u8B58\\u3055\\u308C\\u3066\\u3044\\u306A\\u3044\\u30AD\\u30FC\${issue2.keys.length > 1 ? "\\u7FA4" : ""}: \${joinValues(issue2.keys, "\\u3001")}\`;
      case "invalid_key":
        return \`\${issue2.origin}\\u5185\\u306E\\u7121\\u52B9\\u306A\\u30AD\\u30FC\`;
      case "invalid_union":
        return "\\u7121\\u52B9\\u306A\\u5165\\u529B";
      case "invalid_element":
        return \`\${issue2.origin}\\u5185\\u306E\\u7121\\u52B9\\u306A\\u5024\`;
      default:
        return \`\\u7121\\u52B9\\u306A\\u5165\\u529B\`;
    }
  };
}, "error");
function ja_default() {
  return {
    localeError: error20()
  };
}
__name(ja_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ka.js
var parsedType4 = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "\\u10E0\\u10D8\\u10EA\\u10EE\\u10D5\\u10D8";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "\\u10DB\\u10D0\\u10E1\\u10D8\\u10D5\\u10D8";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  const typeMap = {
    string: "\\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8",
    boolean: "\\u10D1\\u10E3\\u10DA\\u10D4\\u10D0\\u10DC\\u10D8",
    undefined: "undefined",
    bigint: "bigint",
    symbol: "symbol",
    function: "\\u10E4\\u10E3\\u10DC\\u10E5\\u10EA\\u10D8\\u10D0"
  };
  return typeMap[t] ?? t;
}, "parsedType");
var error21 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u10E1\\u10D8\\u10DB\\u10D1\\u10DD\\u10DA\\u10DD",
      verb: "\\u10E3\\u10DC\\u10D3\\u10D0 \\u10E8\\u10D4\\u10D8\\u10EA\\u10D0\\u10D5\\u10D3\\u10D4\\u10E1"
    },
    file: {
      unit: "\\u10D1\\u10D0\\u10D8\\u10E2\\u10D8",
      verb: "\\u10E3\\u10DC\\u10D3\\u10D0 \\u10E8\\u10D4\\u10D8\\u10EA\\u10D0\\u10D5\\u10D3\\u10D4\\u10E1"
    },
    array: {
      unit: "\\u10D4\\u10DA\\u10D4\\u10DB\\u10D4\\u10DC\\u10E2\\u10D8",
      verb: "\\u10E3\\u10DC\\u10D3\\u10D0 \\u10E8\\u10D4\\u10D8\\u10EA\\u10D0\\u10D5\\u10D3\\u10D4\\u10E1"
    },
    set: {
      unit: "\\u10D4\\u10DA\\u10D4\\u10DB\\u10D4\\u10DC\\u10E2\\u10D8",
      verb: "\\u10E3\\u10DC\\u10D3\\u10D0 \\u10E8\\u10D4\\u10D8\\u10EA\\u10D0\\u10D5\\u10D3\\u10D4\\u10E1"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const Nouns = {
    regex: "\\u10E8\\u10D4\\u10E7\\u10D5\\u10D0\\u10DC\\u10D0",
    email: "\\u10D4\\u10DA-\\u10E4\\u10DD\\u10E1\\u10E2\\u10D8\\u10E1 \\u10DB\\u10D8\\u10E1\\u10D0\\u10DB\\u10D0\\u10E0\\u10D7\\u10D8",
    url: "URL",
    emoji: "\\u10D4\\u10DB\\u10DD\\u10EF\\u10D8",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u10D7\\u10D0\\u10E0\\u10D8\\u10E6\\u10D8-\\u10D3\\u10E0\\u10DD",
    date: "\\u10D7\\u10D0\\u10E0\\u10D8\\u10E6\\u10D8",
    time: "\\u10D3\\u10E0\\u10DD",
    duration: "\\u10EE\\u10D0\\u10DC\\u10D2\\u10E0\\u10EB\\u10DA\\u10D8\\u10D5\\u10DD\\u10D1\\u10D0",
    ipv4: "IPv4 \\u10DB\\u10D8\\u10E1\\u10D0\\u10DB\\u10D0\\u10E0\\u10D7\\u10D8",
    ipv6: "IPv6 \\u10DB\\u10D8\\u10E1\\u10D0\\u10DB\\u10D0\\u10E0\\u10D7\\u10D8",
    cidrv4: "IPv4 \\u10D3\\u10D8\\u10D0\\u10DE\\u10D0\\u10D6\\u10DD\\u10DC\\u10D8",
    cidrv6: "IPv6 \\u10D3\\u10D8\\u10D0\\u10DE\\u10D0\\u10D6\\u10DD\\u10DC\\u10D8",
    base64: "base64-\\u10D9\\u10DD\\u10D3\\u10D8\\u10E0\\u10D4\\u10D1\\u10E3\\u10DA\\u10D8 \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8",
    base64url: "base64url-\\u10D9\\u10DD\\u10D3\\u10D8\\u10E0\\u10D4\\u10D1\\u10E3\\u10DA\\u10D8 \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8",
    json_string: "JSON \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8",
    e164: "E.164 \\u10DC\\u10DD\\u10DB\\u10D4\\u10E0\\u10D8",
    jwt: "JWT",
    template_literal: "\\u10E8\\u10D4\\u10E7\\u10D5\\u10D0\\u10DC\\u10D0"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E8\\u10D4\\u10E7\\u10D5\\u10D0\\u10DC\\u10D0: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8 \${issue2.expected}, \\u10DB\\u10D8\\u10E6\\u10D4\\u10D1\\u10E3\\u10DA\\u10D8 \${parsedType4(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E8\\u10D4\\u10E7\\u10D5\\u10D0\\u10DC\\u10D0: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8 \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10D5\\u10D0\\u10E0\\u10D8\\u10D0\\u10DC\\u10E2\\u10D8: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8\\u10D0 \\u10D4\\u10E0\\u10D7-\\u10D4\\u10E0\\u10D7\\u10D8 \${joinValues(issue2.values, "|")}-\\u10D3\\u10D0\\u10DC\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u10D6\\u10D4\\u10D3\\u10DB\\u10D4\\u10E2\\u10D0\\u10D3 \\u10D3\\u10D8\\u10D3\\u10D8: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8 \${issue2.origin ?? "\\u10DB\\u10DC\\u10D8\\u10E8\\u10D5\\u10DC\\u10D4\\u10DA\\u10DD\\u10D1\\u10D0"} \${sizing.verb} \${adj}\${issue2.maximum.toString()} \${sizing.unit}\`;
        return \`\\u10D6\\u10D4\\u10D3\\u10DB\\u10D4\\u10E2\\u10D0\\u10D3 \\u10D3\\u10D8\\u10D3\\u10D8: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8 \${issue2.origin ?? "\\u10DB\\u10DC\\u10D8\\u10E8\\u10D5\\u10DC\\u10D4\\u10DA\\u10DD\\u10D1\\u10D0"} \\u10D8\\u10E7\\u10DD\\u10E1 \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u10D6\\u10D4\\u10D3\\u10DB\\u10D4\\u10E2\\u10D0\\u10D3 \\u10DE\\u10D0\\u10E2\\u10D0\\u10E0\\u10D0: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8 \${issue2.origin} \${sizing.verb} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u10D6\\u10D4\\u10D3\\u10DB\\u10D4\\u10E2\\u10D0\\u10D3 \\u10DE\\u10D0\\u10E2\\u10D0\\u10E0\\u10D0: \\u10DB\\u10DD\\u10E1\\u10D0\\u10DA\\u10DD\\u10D3\\u10DC\\u10D4\\u10DA\\u10D8 \${issue2.origin} \\u10D8\\u10E7\\u10DD\\u10E1 \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8: \\u10E3\\u10DC\\u10D3\\u10D0 \\u10D8\\u10EC\\u10E7\\u10D4\\u10D1\\u10DD\\u10D3\\u10D4\\u10E1 "\${_issue.prefix}"-\\u10D8\\u10D7\`;
        }
        if (_issue.format === "ends_with") return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8: \\u10E3\\u10DC\\u10D3\\u10D0 \\u10DB\\u10D7\\u10D0\\u10D5\\u10E0\\u10D3\\u10D4\\u10D1\\u10DD\\u10D3\\u10D4\\u10E1 "\${_issue.suffix}"-\\u10D8\\u10D7\`;
        if (_issue.format === "includes") return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8: \\u10E3\\u10DC\\u10D3\\u10D0 \\u10E8\\u10D4\\u10D8\\u10EA\\u10D0\\u10D5\\u10D3\\u10D4\\u10E1 "\${_issue.includes}"-\\u10E1\`;
        if (_issue.format === "regex") return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E1\\u10E2\\u10E0\\u10D8\\u10DC\\u10D2\\u10D8: \\u10E3\\u10DC\\u10D3\\u10D0 \\u10E8\\u10D4\\u10D4\\u10E1\\u10D0\\u10D1\\u10D0\\u10DB\\u10D4\\u10D1\\u10DD\\u10D3\\u10D4\\u10E1 \\u10E8\\u10D0\\u10D1\\u10DA\\u10DD\\u10DC\\u10E1 \${_issue.pattern}\`;
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E0\\u10D8\\u10EA\\u10EE\\u10D5\\u10D8: \\u10E3\\u10DC\\u10D3\\u10D0 \\u10D8\\u10E7\\u10DD\\u10E1 \${issue2.divisor}-\\u10D8\\u10E1 \\u10EF\\u10D4\\u10E0\\u10D0\\u10D3\\u10D8\`;
      case "unrecognized_keys":
        return \`\\u10E3\\u10EA\\u10DC\\u10DD\\u10D1\\u10D8 \\u10D2\\u10D0\\u10E1\\u10D0\\u10E6\\u10D4\\u10D1\${issue2.keys.length > 1 ? "\\u10D4\\u10D1\\u10D8" : "\\u10D8"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10D2\\u10D0\\u10E1\\u10D0\\u10E6\\u10D4\\u10D1\\u10D8 \${issue2.origin}-\\u10E8\\u10D8\`;
      case "invalid_union":
        return "\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E8\\u10D4\\u10E7\\u10D5\\u10D0\\u10DC\\u10D0";
      case "invalid_element":
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10DB\\u10DC\\u10D8\\u10E8\\u10D5\\u10DC\\u10D4\\u10DA\\u10DD\\u10D1\\u10D0 \${issue2.origin}-\\u10E8\\u10D8\`;
      default:
        return \`\\u10D0\\u10E0\\u10D0\\u10E1\\u10EC\\u10DD\\u10E0\\u10D8 \\u10E8\\u10D4\\u10E7\\u10D5\\u10D0\\u10DC\\u10D0\`;
    }
  };
}, "error");
function ka_default() {
  return {
    localeError: error21()
  };
}
__name(ka_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/km.js
var error22 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u178F\\u17BD\\u17A2\\u1780\\u17D2\\u179F\\u179A",
      verb: "\\u1782\\u17BD\\u179A\\u1798\\u17B6\\u1793"
    },
    file: {
      unit: "\\u1794\\u17C3",
      verb: "\\u1782\\u17BD\\u179A\\u1798\\u17B6\\u1793"
    },
    array: {
      unit: "\\u1792\\u17B6\\u178F\\u17BB",
      verb: "\\u1782\\u17BD\\u179A\\u1798\\u17B6\\u1793"
    },
    set: {
      unit: "\\u1792\\u17B6\\u178F\\u17BB",
      verb: "\\u1782\\u17BD\\u179A\\u1798\\u17B6\\u1793"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\\u1798\\u17B7\\u1793\\u1798\\u17C2\\u1793\\u1787\\u17B6\\u179B\\u17C1\\u1781 (NaN)" : "\\u179B\\u17C1\\u1781";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u17A2\\u17B6\\u179A\\u17C1 (Array)";
        }
        if (data === null) {
          return "\\u1782\\u17D2\\u1798\\u17B6\\u1793\\u178F\\u1798\\u17D2\\u179B\\u17C3 (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1794\\u1789\\u17D2\\u1785\\u17BC\\u179B",
    email: "\\u17A2\\u17B6\\u179F\\u1799\\u178A\\u17D2\\u178B\\u17B6\\u1793\\u17A2\\u17CA\\u17B8\\u1798\\u17C2\\u179B",
    url: "URL",
    emoji: "\\u179F\\u1789\\u17D2\\u1789\\u17B6\\u17A2\\u17B6\\u179A\\u1798\\u17D2\\u1798\\u178E\\u17CD",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u1780\\u17B6\\u179B\\u1794\\u179A\\u17B7\\u1785\\u17D2\\u1786\\u17C1\\u1791 \\u1793\\u17B7\\u1784\\u1798\\u17C9\\u17C4\\u1784 ISO",
    date: "\\u1780\\u17B6\\u179B\\u1794\\u179A\\u17B7\\u1785\\u17D2\\u1786\\u17C1\\u1791 ISO",
    time: "\\u1798\\u17C9\\u17C4\\u1784 ISO",
    duration: "\\u179A\\u1799\\u17C8\\u1796\\u17C1\\u179B ISO",
    ipv4: "\\u17A2\\u17B6\\u179F\\u1799\\u178A\\u17D2\\u178B\\u17B6\\u1793 IPv4",
    ipv6: "\\u17A2\\u17B6\\u179F\\u1799\\u178A\\u17D2\\u178B\\u17B6\\u1793 IPv6",
    cidrv4: "\\u178A\\u17C2\\u1793\\u17A2\\u17B6\\u179F\\u1799\\u178A\\u17D2\\u178B\\u17B6\\u1793 IPv4",
    cidrv6: "\\u178A\\u17C2\\u1793\\u17A2\\u17B6\\u179F\\u1799\\u178A\\u17D2\\u178B\\u17B6\\u1793 IPv6",
    base64: "\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A\\u17A2\\u17CA\\u17B7\\u1780\\u17BC\\u178A base64",
    base64url: "\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A\\u17A2\\u17CA\\u17B7\\u1780\\u17BC\\u178A base64url",
    json_string: "\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A JSON",
    e164: "\\u179B\\u17C1\\u1781 E.164",
    jwt: "JWT",
    template_literal: "\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1794\\u1789\\u17D2\\u1785\\u17BC\\u179B"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1794\\u1789\\u17D2\\u1785\\u17BC\\u179B\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1780\\u17B6\\u179A \${issue2.expected} \\u1794\\u17C9\\u17BB\\u1793\\u17D2\\u178F\\u17C2\\u1791\\u1791\\u17BD\\u179B\\u1794\\u17B6\\u1793 \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1794\\u1789\\u17D2\\u1785\\u17BC\\u179B\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1780\\u17B6\\u179A \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u1787\\u1798\\u17D2\\u179A\\u17BE\\u179F\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1787\\u17B6\\u1798\\u17BD\\u1799\\u1780\\u17D2\\u1793\\u17BB\\u1784\\u1785\\u17C6\\u178E\\u17C4\\u1798 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u1792\\u17C6\\u1796\\u17C1\\u1780\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1780\\u17B6\\u179A \${issue2.origin ?? "\\u178F\\u1798\\u17D2\\u179B\\u17C3"} \${adj} \${issue2.maximum.toString()} \${sizing.unit ?? "\\u1792\\u17B6\\u178F\\u17BB"}\`;
        return \`\\u1792\\u17C6\\u1796\\u17C1\\u1780\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1780\\u17B6\\u179A \${issue2.origin ?? "\\u178F\\u1798\\u17D2\\u179B\\u17C3"} \${adj} \${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u178F\\u17BC\\u1785\\u1796\\u17C1\\u1780\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1780\\u17B6\\u179A \${issue2.origin} \${adj} \${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u178F\\u17BC\\u1785\\u1796\\u17C1\\u1780\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1780\\u17B6\\u179A \${issue2.origin} \${adj} \${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1785\\u17B6\\u1794\\u17CB\\u1795\\u17D2\\u178F\\u17BE\\u1798\\u178A\\u17C4\\u1799 "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1794\\u1789\\u17D2\\u1785\\u1794\\u17CB\\u178A\\u17C4\\u1799 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1798\\u17B6\\u1793 "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u1781\\u17D2\\u179F\\u17C2\\u17A2\\u1780\\u17D2\\u179F\\u179A\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u178F\\u17C2\\u1795\\u17D2\\u1782\\u17BC\\u1795\\u17D2\\u1782\\u1784\\u1793\\u17B9\\u1784\\u1791\\u1798\\u17D2\\u179A\\u1784\\u17CB\\u178A\\u17C2\\u179B\\u1794\\u17B6\\u1793\\u1780\\u17C6\\u178E\\u178F\\u17CB \${_issue.pattern}\`;
        return \`\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u179B\\u17C1\\u1781\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u17D6 \\u178F\\u17D2\\u179A\\u17BC\\u179C\\u178F\\u17C2\\u1787\\u17B6\\u1796\\u17A0\\u17BB\\u1782\\u17BB\\u178E\\u1793\\u17C3 \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\u179A\\u1780\\u1783\\u17BE\\u1789\\u179F\\u17C4\\u1798\\u17B7\\u1793\\u179F\\u17D2\\u1782\\u17B6\\u179B\\u17CB\\u17D6 \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u179F\\u17C4\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1793\\u17C5\\u1780\\u17D2\\u1793\\u17BB\\u1784 \${issue2.origin}\`;
      case "invalid_union":
        return \`\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\`;
      case "invalid_element":
        return \`\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\\u1793\\u17C5\\u1780\\u17D2\\u1793\\u17BB\\u1784 \${issue2.origin}\`;
      default:
        return \`\\u1791\\u17B7\\u1793\\u17D2\\u1793\\u1793\\u17D0\\u1799\\u1798\\u17B7\\u1793\\u178F\\u17D2\\u179A\\u17B9\\u1798\\u178F\\u17D2\\u179A\\u17BC\\u179C\`;
    }
  };
}, "error");
function km_default() {
  return {
    localeError: error22()
  };
}
__name(km_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/kh.js
function kh_default() {
  return km_default();
}
__name(kh_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ko.js
var error23 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\uBB38\\uC790",
      verb: "to have"
    },
    file: {
      unit: "\\uBC14\\uC774\\uD2B8",
      verb: "to have"
    },
    array: {
      unit: "\\uAC1C",
      verb: "to have"
    },
    set: {
      unit: "\\uAC1C",
      verb: "to have"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\uC785\\uB825",
    email: "\\uC774\\uBA54\\uC77C \\uC8FC\\uC18C",
    url: "URL",
    emoji: "\\uC774\\uBAA8\\uC9C0",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \\uB0A0\\uC9DC\\uC2DC\\uAC04",
    date: "ISO \\uB0A0\\uC9DC",
    time: "ISO \\uC2DC\\uAC04",
    duration: "ISO \\uAE30\\uAC04",
    ipv4: "IPv4 \\uC8FC\\uC18C",
    ipv6: "IPv6 \\uC8FC\\uC18C",
    cidrv4: "IPv4 \\uBC94\\uC704",
    cidrv6: "IPv6 \\uBC94\\uC704",
    base64: "base64 \\uC778\\uCF54\\uB529 \\uBB38\\uC790\\uC5F4",
    base64url: "base64url \\uC778\\uCF54\\uB529 \\uBB38\\uC790\\uC5F4",
    json_string: "JSON \\uBB38\\uC790\\uC5F4",
    e164: "E.164 \\uBC88\\uD638",
    jwt: "JWT",
    template_literal: "\\uC785\\uB825"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\uC798\\uBABB\\uB41C \\uC785\\uB825: \\uC608\\uC0C1 \\uD0C0\\uC785\\uC740 \${issue2.expected}, \\uBC1B\\uC740 \\uD0C0\\uC785\\uC740 \${parsedType7(issue2.input)}\\uC785\\uB2C8\\uB2E4\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\uC798\\uBABB\\uB41C \\uC785\\uB825: \\uAC12\\uC740 \${stringifyPrimitive(issue2.values[0])} \\uC774\\uC5B4\\uC57C \\uD569\\uB2C8\\uB2E4\`;
        return \`\\uC798\\uBABB\\uB41C \\uC635\\uC158: \${joinValues(issue2.values, "\\uB610\\uB294 ")} \\uC911 \\uD558\\uB098\\uC5EC\\uC57C \\uD569\\uB2C8\\uB2E4\`;
      case "too_big": {
        const adj = issue2.inclusive ? "\\uC774\\uD558" : "\\uBBF8\\uB9CC";
        const suffix = adj === "\\uBBF8\\uB9CC" ? "\\uC774\\uC5B4\\uC57C \\uD569\\uB2C8\\uB2E4" : "\\uC5EC\\uC57C \\uD569\\uB2C8\\uB2E4";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "\\uC694\\uC18C";
        if (sizing) return \`\${issue2.origin ?? "\\uAC12"}\\uC774 \\uB108\\uBB34 \\uD07D\\uB2C8\\uB2E4: \${issue2.maximum.toString()}\${unit} \${adj}\${suffix}\`;
        return \`\${issue2.origin ?? "\\uAC12"}\\uC774 \\uB108\\uBB34 \\uD07D\\uB2C8\\uB2E4: \${issue2.maximum.toString()} \${adj}\${suffix}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\\uC774\\uC0C1" : "\\uCD08\\uACFC";
        const suffix = adj === "\\uC774\\uC0C1" ? "\\uC774\\uC5B4\\uC57C \\uD569\\uB2C8\\uB2E4" : "\\uC5EC\\uC57C \\uD569\\uB2C8\\uB2E4";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "\\uC694\\uC18C";
        if (sizing) {
          return \`\${issue2.origin ?? "\\uAC12"}\\uC774 \\uB108\\uBB34 \\uC791\\uC2B5\\uB2C8\\uB2E4: \${issue2.minimum.toString()}\${unit} \${adj}\${suffix}\`;
        }
        return \`\${issue2.origin ?? "\\uAC12"}\\uC774 \\uB108\\uBB34 \\uC791\\uC2B5\\uB2C8\\uB2E4: \${issue2.minimum.toString()} \${adj}\${suffix}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\uC798\\uBABB\\uB41C \\uBB38\\uC790\\uC5F4: "\${_issue.prefix}"(\\uC73C)\\uB85C \\uC2DC\\uC791\\uD574\\uC57C \\uD569\\uB2C8\\uB2E4\`;
        }
        if (_issue.format === "ends_with") return \`\\uC798\\uBABB\\uB41C \\uBB38\\uC790\\uC5F4: "\${_issue.suffix}"(\\uC73C)\\uB85C \\uB05D\\uB098\\uC57C \\uD569\\uB2C8\\uB2E4\`;
        if (_issue.format === "includes") return \`\\uC798\\uBABB\\uB41C \\uBB38\\uC790\\uC5F4: "\${_issue.includes}"\\uC744(\\uB97C) \\uD3EC\\uD568\\uD574\\uC57C \\uD569\\uB2C8\\uB2E4\`;
        if (_issue.format === "regex") return \`\\uC798\\uBABB\\uB41C \\uBB38\\uC790\\uC5F4: \\uC815\\uADDC\\uC2DD \${_issue.pattern} \\uD328\\uD134\\uACFC \\uC77C\\uCE58\\uD574\\uC57C \\uD569\\uB2C8\\uB2E4\`;
        return \`\\uC798\\uBABB\\uB41C \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\uC798\\uBABB\\uB41C \\uC22B\\uC790: \${issue2.divisor}\\uC758 \\uBC30\\uC218\\uC5EC\\uC57C \\uD569\\uB2C8\\uB2E4\`;
      case "unrecognized_keys":
        return \`\\uC778\\uC2DD\\uD560 \\uC218 \\uC5C6\\uB294 \\uD0A4: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\uC798\\uBABB\\uB41C \\uD0A4: \${issue2.origin}\`;
      case "invalid_union":
        return \`\\uC798\\uBABB\\uB41C \\uC785\\uB825\`;
      case "invalid_element":
        return \`\\uC798\\uBABB\\uB41C \\uAC12: \${issue2.origin}\`;
      default:
        return \`\\uC798\\uBABB\\uB41C \\uC785\\uB825\`;
    }
  };
}, "error");
function ko_default() {
  return {
    localeError: error23()
  };
}
__name(ko_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/lt.js
var parsedType5 = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  return parsedTypeFromType(t, data);
}, "parsedType");
var parsedTypeFromType = /* @__PURE__ */ __name((t, data = void 0) => {
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "skai\\u010Dius";
    }
    case "bigint": {
      return "sveikasis skai\\u010Dius";
    }
    case "string": {
      return "eilut\\u0117";
    }
    case "boolean": {
      return "login\\u0117 reik\\u0161m\\u0117";
    }
    case "undefined":
    case "void": {
      return "neapibr\\u0117\\u017Eta reik\\u0161m\\u0117";
    }
    case "function": {
      return "funkcija";
    }
    case "symbol": {
      return "simbolis";
    }
    case "object": {
      if (data === void 0) return "ne\\u017Einomas objektas";
      if (data === null) return "nulin\\u0117 reik\\u0161m\\u0117";
      if (Array.isArray(data)) return "masyvas";
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
      return "objektas";
    }
    //Zod types below
    case "null": {
      return "nulin\\u0117 reik\\u0161m\\u0117";
    }
  }
  return t;
}, "parsedTypeFromType");
var capitalizeFirstCharacter = /* @__PURE__ */ __name((text2) => {
  return text2.charAt(0).toUpperCase() + text2.slice(1);
}, "capitalizeFirstCharacter");
function getUnitTypeFromNumber(number4) {
  const abs = Math.abs(number4);
  const last = abs % 10;
  const last2 = abs % 100;
  if (last2 >= 11 && last2 <= 19 || last === 0) return "many";
  if (last === 1) return "one";
  return "few";
}
__name(getUnitTypeFromNumber, "getUnitTypeFromNumber");
var error24 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: {
        one: "simbolis",
        few: "simboliai",
        many: "simboli\\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi b\\u016Bti ne ilgesn\\u0117 kaip",
          notInclusive: "turi b\\u016Bti trumpesn\\u0117 kaip"
        },
        bigger: {
          inclusive: "turi b\\u016Bti ne trumpesn\\u0117 kaip",
          notInclusive: "turi b\\u016Bti ilgesn\\u0117 kaip"
        }
      }
    },
    file: {
      unit: {
        one: "baitas",
        few: "baitai",
        many: "bait\\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi b\\u016Bti ne didesnis kaip",
          notInclusive: "turi b\\u016Bti ma\\u017Eesnis kaip"
        },
        bigger: {
          inclusive: "turi b\\u016Bti ne ma\\u017Eesnis kaip",
          notInclusive: "turi b\\u016Bti didesnis kaip"
        }
      }
    },
    array: {
      unit: {
        one: "element\\u0105",
        few: "elementus",
        many: "element\\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi tur\\u0117ti ne daugiau kaip",
          notInclusive: "turi tur\\u0117ti ma\\u017Eiau kaip"
        },
        bigger: {
          inclusive: "turi tur\\u0117ti ne ma\\u017Eiau kaip",
          notInclusive: "turi tur\\u0117ti daugiau kaip"
        }
      }
    },
    set: {
      unit: {
        one: "element\\u0105",
        few: "elementus",
        many: "element\\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi tur\\u0117ti ne daugiau kaip",
          notInclusive: "turi tur\\u0117ti ma\\u017Eiau kaip"
        },
        bigger: {
          inclusive: "turi tur\\u0117ti ne ma\\u017Eiau kaip",
          notInclusive: "turi tur\\u0117ti daugiau kaip"
        }
      }
    }
  };
  function getSizing(origin, unitType, inclusive, targetShouldBe) {
    const result = Sizable[origin] ?? null;
    if (result === null) return result;
    return {
      unit: result.unit[unitType],
      verb: result.verb[targetShouldBe][inclusive ? "inclusive" : "notInclusive"]
    };
  }
  __name(getSizing, "getSizing");
  const Nouns = {
    regex: "\\u012Fvestis",
    email: "el. pa\\u0161to adresas",
    url: "URL",
    emoji: "jaustukas",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO data ir laikas",
    date: "ISO data",
    time: "ISO laikas",
    duration: "ISO trukm\\u0117",
    ipv4: "IPv4 adresas",
    ipv6: "IPv6 adresas",
    cidrv4: "IPv4 tinklo prefiksas (CIDR)",
    cidrv6: "IPv6 tinklo prefiksas (CIDR)",
    base64: "base64 u\\u017Ekoduota eilut\\u0117",
    base64url: "base64url u\\u017Ekoduota eilut\\u0117",
    json_string: "JSON eilut\\u0117",
    e164: "E.164 numeris",
    jwt: "JWT",
    template_literal: "\\u012Fvestis"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Gautas tipas \${parsedType5(issue2.input)}, o tik\\u0117tasi - \${parsedTypeFromType(issue2.expected)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Privalo b\\u016Bti \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Privalo b\\u016Bti vienas i\\u0161 \${joinValues(issue2.values, "|")} pasirinkim\\u0173\`;
      case "too_big": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.maximum)), issue2.inclusive ?? false, "smaller");
        if (sizing?.verb) return \`\${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\\u0161m\\u0117")} \${sizing.verb} \${issue2.maximum.toString()} \${sizing.unit ?? "element\\u0173"}\`;
        const adj = issue2.inclusive ? "ne didesnis kaip" : "ma\\u017Eesnis kaip";
        return \`\${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\\u0161m\\u0117")} turi b\\u016Bti \${adj} \${issue2.maximum.toString()} \${sizing?.unit}\`;
      }
      case "too_small": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.minimum)), issue2.inclusive ?? false, "bigger");
        if (sizing?.verb) return \`\${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\\u0161m\\u0117")} \${sizing.verb} \${issue2.minimum.toString()} \${sizing.unit ?? "element\\u0173"}\`;
        const adj = issue2.inclusive ? "ne ma\\u017Eesnis kaip" : "didesnis kaip";
        return \`\${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\\u0161m\\u0117")} turi b\\u016Bti \${adj} \${issue2.minimum.toString()} \${sizing?.unit}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Eilut\\u0117 privalo prasid\\u0117ti "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`Eilut\\u0117 privalo pasibaigti "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Eilut\\u0117 privalo \\u012Ftraukti "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Eilut\\u0117 privalo atitikti \${_issue.pattern}\`;
        return \`Neteisingas \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Skai\\u010Dius privalo b\\u016Bti \${issue2.divisor} kartotinis.\`;
      case "unrecognized_keys":
        return \`Neatpa\\u017Eint\${issue2.keys.length > 1 ? "i" : "as"} rakt\${issue2.keys.length > 1 ? "ai" : "as"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return "Rastas klaidingas raktas";
      case "invalid_union":
        return "Klaidinga \\u012Fvestis";
      case "invalid_element": {
        const origin = parsedTypeFromType(issue2.origin);
        return \`\${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\\u0161m\\u0117")} turi klaiding\\u0105 \\u012Fvest\\u012F\`;
      }
      default:
        return "Klaidinga \\u012Fvestis";
    }
  };
}, "error");
function lt_default() {
  return {
    localeError: error24()
  };
}
__name(lt_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/mk.js
var error25 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u0437\\u043D\\u0430\\u0446\\u0438",
      verb: "\\u0434\\u0430 \\u0438\\u043C\\u0430\\u0430\\u0442"
    },
    file: {
      unit: "\\u0431\\u0430\\u0458\\u0442\\u0438",
      verb: "\\u0434\\u0430 \\u0438\\u043C\\u0430\\u0430\\u0442"
    },
    array: {
      unit: "\\u0441\\u0442\\u0430\\u0432\\u043A\\u0438",
      verb: "\\u0434\\u0430 \\u0438\\u043C\\u0430\\u0430\\u0442"
    },
    set: {
      unit: "\\u0441\\u0442\\u0430\\u0432\\u043A\\u0438",
      verb: "\\u0434\\u0430 \\u0438\\u043C\\u0430\\u0430\\u0442"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0431\\u0440\\u043E\\u0458";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u043D\\u0438\\u0437\\u0430";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0432\\u043D\\u0435\\u0441",
    email: "\\u0430\\u0434\\u0440\\u0435\\u0441\\u0430 \\u043D\\u0430 \\u0435-\\u043F\\u043E\\u0448\\u0442\\u0430",
    url: "URL",
    emoji: "\\u0435\\u043C\\u043E\\u045F\\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \\u0434\\u0430\\u0442\\u0443\\u043C \\u0438 \\u0432\\u0440\\u0435\\u043C\\u0435",
    date: "ISO \\u0434\\u0430\\u0442\\u0443\\u043C",
    time: "ISO \\u0432\\u0440\\u0435\\u043C\\u0435",
    duration: "ISO \\u0432\\u0440\\u0435\\u043C\\u0435\\u0442\\u0440\\u0430\\u0435\\u045A\\u0435",
    ipv4: "IPv4 \\u0430\\u0434\\u0440\\u0435\\u0441\\u0430",
    ipv6: "IPv6 \\u0430\\u0434\\u0440\\u0435\\u0441\\u0430",
    cidrv4: "IPv4 \\u043E\\u043F\\u0441\\u0435\\u0433",
    cidrv6: "IPv6 \\u043E\\u043F\\u0441\\u0435\\u0433",
    base64: "base64-\\u0435\\u043D\\u043A\\u043E\\u0434\\u0438\\u0440\\u0430\\u043D\\u0430 \\u043D\\u0438\\u0437\\u0430",
    base64url: "base64url-\\u0435\\u043D\\u043A\\u043E\\u0434\\u0438\\u0440\\u0430\\u043D\\u0430 \\u043D\\u0438\\u0437\\u0430",
    json_string: "JSON \\u043D\\u0438\\u0437\\u0430",
    e164: "E.164 \\u0431\\u0440\\u043E\\u0458",
    jwt: "JWT",
    template_literal: "\\u0432\\u043D\\u0435\\u0441"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0413\\u0440\\u0435\\u0448\\u0435\\u043D \\u0432\\u043D\\u0435\\u0441: \\u0441\\u0435 \\u043E\\u0447\\u0435\\u043A\\u0443\\u0432\\u0430 \${issue2.expected}, \\u043F\\u0440\\u0438\\u043C\\u0435\\u043D\\u043E \${parsedType7(issue2.input)}\`;
      // return \`Invalid input: expected \${issue.expected}, received \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Invalid input: expected \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u0413\\u0440\\u0435\\u0448\\u0430\\u043D\\u0430 \\u043E\\u043F\\u0446\\u0438\\u0458\\u0430: \\u0441\\u0435 \\u043E\\u0447\\u0435\\u043A\\u0443\\u0432\\u0430 \\u0435\\u0434\\u043D\\u0430 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u041F\\u0440\\u0435\\u043C\\u043D\\u043E\\u0433\\u0443 \\u0433\\u043E\\u043B\\u0435\\u043C: \\u0441\\u0435 \\u043E\\u0447\\u0435\\u043A\\u0443\\u0432\\u0430 \${issue2.origin ?? "\\u0432\\u0440\\u0435\\u0434\\u043D\\u043E\\u0441\\u0442\\u0430"} \\u0434\\u0430 \\u0438\\u043C\\u0430 \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u0435\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0438"}\`;
        return \`\\u041F\\u0440\\u0435\\u043C\\u043D\\u043E\\u0433\\u0443 \\u0433\\u043E\\u043B\\u0435\\u043C: \\u0441\\u0435 \\u043E\\u0447\\u0435\\u043A\\u0443\\u0432\\u0430 \${issue2.origin ?? "\\u0432\\u0440\\u0435\\u0434\\u043D\\u043E\\u0441\\u0442\\u0430"} \\u0434\\u0430 \\u0431\\u0438\\u0434\\u0435 \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u041F\\u0440\\u0435\\u043C\\u043D\\u043E\\u0433\\u0443 \\u043C\\u0430\\u043B: \\u0441\\u0435 \\u043E\\u0447\\u0435\\u043A\\u0443\\u0432\\u0430 \${issue2.origin} \\u0434\\u0430 \\u0438\\u043C\\u0430 \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u041F\\u0440\\u0435\\u043C\\u043D\\u043E\\u0433\\u0443 \\u043C\\u0430\\u043B: \\u0441\\u0435 \\u043E\\u0447\\u0435\\u043A\\u0443\\u0432\\u0430 \${issue2.origin} \\u0434\\u0430 \\u0431\\u0438\\u0434\\u0435 \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u041D\\u0435\\u0432\\u0430\\u0436\\u0435\\u0447\\u043A\\u0430 \\u043D\\u0438\\u0437\\u0430: \\u043C\\u043E\\u0440\\u0430 \\u0434\\u0430 \\u0437\\u0430\\u043F\\u043E\\u0447\\u043D\\u0443\\u0432\\u0430 \\u0441\\u043E "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`\\u041D\\u0435\\u0432\\u0430\\u0436\\u0435\\u0447\\u043A\\u0430 \\u043D\\u0438\\u0437\\u0430: \\u043C\\u043E\\u0440\\u0430 \\u0434\\u0430 \\u0437\\u0430\\u0432\\u0440\\u0448\\u0443\\u0432\\u0430 \\u0441\\u043E "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u041D\\u0435\\u0432\\u0430\\u0436\\u0435\\u0447\\u043A\\u0430 \\u043D\\u0438\\u0437\\u0430: \\u043C\\u043E\\u0440\\u0430 \\u0434\\u0430 \\u0432\\u043A\\u043B\\u0443\\u0447\\u0443\\u0432\\u0430 "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u041D\\u0435\\u0432\\u0430\\u0436\\u0435\\u0447\\u043A\\u0430 \\u043D\\u0438\\u0437\\u0430: \\u043C\\u043E\\u0440\\u0430 \\u0434\\u0430 \\u043E\\u0434\\u0433\\u043E\\u0430\\u0440\\u0430 \\u043D\\u0430 \\u043F\\u0430\\u0442\\u0435\\u0440\\u043D\\u043E\\u0442 \${_issue.pattern}\`;
        return \`Invalid \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u0413\\u0440\\u0435\\u0448\\u0435\\u043D \\u0431\\u0440\\u043E\\u0458: \\u043C\\u043E\\u0440\\u0430 \\u0434\\u0430 \\u0431\\u0438\\u0434\\u0435 \\u0434\\u0435\\u043B\\u0438\\u0432 \\u0441\\u043E \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\${issue2.keys.length > 1 ? "\\u041D\\u0435\\u043F\\u0440\\u0435\\u043F\\u043E\\u0437\\u043D\\u0430\\u0435\\u043D\\u0438 \\u043A\\u043B\\u0443\\u0447\\u0435\\u0432\\u0438" : "\\u041D\\u0435\\u043F\\u0440\\u0435\\u043F\\u043E\\u0437\\u043D\\u0430\\u0435\\u043D \\u043A\\u043B\\u0443\\u0447"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u0413\\u0440\\u0435\\u0448\\u0435\\u043D \\u043A\\u043B\\u0443\\u0447 \\u0432\\u043E \${issue2.origin}\`;
      case "invalid_union":
        return "\\u0413\\u0440\\u0435\\u0448\\u0435\\u043D \\u0432\\u043D\\u0435\\u0441";
      case "invalid_element":
        return \`\\u0413\\u0440\\u0435\\u0448\\u043D\\u0430 \\u0432\\u0440\\u0435\\u0434\\u043D\\u043E\\u0441\\u0442 \\u0432\\u043E \${issue2.origin}\`;
      default:
        return \`\\u0413\\u0440\\u0435\\u0448\\u0435\\u043D \\u0432\\u043D\\u0435\\u0441\`;
    }
  };
}, "error");
function mk_default() {
  return {
    localeError: error25()
  };
}
__name(mk_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ms.js
var error26 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "aksara",
      verb: "mempunyai"
    },
    file: {
      unit: "bait",
      verb: "mempunyai"
    },
    array: {
      unit: "elemen",
      verb: "mempunyai"
    },
    set: {
      unit: "elemen",
      verb: "mempunyai"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombor";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "input",
    email: "alamat e-mel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tarikh masa ISO",
    date: "tarikh ISO",
    time: "masa ISO",
    duration: "tempoh ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "julat IPv4",
    cidrv6: "julat IPv6",
    base64: "string dikodkan base64",
    base64url: "string dikodkan base64url",
    json_string: "string JSON",
    e164: "nombor E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Input tidak sah: dijangka \${issue2.expected}, diterima \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Input tidak sah: dijangka \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Pilihan tidak sah: dijangka salah satu daripada \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Terlalu besar: dijangka \${issue2.origin ?? "nilai"} \${sizing.verb} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elemen"}\`;
        return \`Terlalu besar: dijangka \${issue2.origin ?? "nilai"} adalah \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Terlalu kecil: dijangka \${issue2.origin} \${sizing.verb} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Terlalu kecil: dijangka \${issue2.origin} adalah \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`String tidak sah: mesti bermula dengan "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`String tidak sah: mesti berakhir dengan "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`String tidak sah: mesti mengandungi "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`String tidak sah: mesti sepadan dengan corak \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} tidak sah\`;
      }
      case "not_multiple_of":
        return \`Nombor tidak sah: perlu gandaan \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Kunci tidak dikenali: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Kunci tidak sah dalam \${issue2.origin}\`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return \`Nilai tidak sah dalam \${issue2.origin}\`;
      default:
        return \`Input tidak sah\`;
    }
  };
}, "error");
function ms_default() {
  return {
    localeError: error26()
  };
}
__name(ms_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/nl.js
var error27 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "tekens"
    },
    file: {
      unit: "bytes"
    },
    array: {
      unit: "elementen"
    },
    set: {
      unit: "elementen"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "getal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "invoer",
    email: "emailadres",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum en tijd",
    date: "ISO datum",
    time: "ISO tijd",
    duration: "ISO duur",
    ipv4: "IPv4-adres",
    ipv6: "IPv6-adres",
    cidrv4: "IPv4-bereik",
    cidrv6: "IPv6-bereik",
    base64: "base64-gecodeerde tekst",
    base64url: "base64 URL-gecodeerde tekst",
    json_string: "JSON string",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "invoer"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Ongeldige invoer: verwacht \${issue2.expected}, ontving \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Ongeldige invoer: verwacht \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Ongeldige optie: verwacht \\xE9\\xE9n van \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Te lang: verwacht dat \${issue2.origin ?? "waarde"} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementen"} bevat\`;
        return \`Te lang: verwacht dat \${issue2.origin ?? "waarde"} \${adj}\${issue2.maximum.toString()} is\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Te kort: verwacht dat \${issue2.origin} \${adj}\${issue2.minimum.toString()} \${sizing.unit} bevat\`;
        }
        return \`Te kort: verwacht dat \${issue2.origin} \${adj}\${issue2.minimum.toString()} is\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Ongeldige tekst: moet met "\${_issue.prefix}" beginnen\`;
        }
        if (_issue.format === "ends_with") return \`Ongeldige tekst: moet op "\${_issue.suffix}" eindigen\`;
        if (_issue.format === "includes") return \`Ongeldige tekst: moet "\${_issue.includes}" bevatten\`;
        if (_issue.format === "regex") return \`Ongeldige tekst: moet overeenkomen met patroon \${_issue.pattern}\`;
        return \`Ongeldig: \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Ongeldig getal: moet een veelvoud van \${issue2.divisor} zijn\`;
      case "unrecognized_keys":
        return \`Onbekende key\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Ongeldige key in \${issue2.origin}\`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return \`Ongeldige waarde in \${issue2.origin}\`;
      default:
        return \`Ongeldige invoer\`;
    }
  };
}, "error");
function nl_default() {
  return {
    localeError: error27()
  };
}
__name(nl_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/no.js
var error28 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "tegn",
      verb: "\\xE5 ha"
    },
    file: {
      unit: "bytes",
      verb: "\\xE5 ha"
    },
    array: {
      unit: "elementer",
      verb: "\\xE5 inneholde"
    },
    set: {
      unit: "elementer",
      verb: "\\xE5 inneholde"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tall";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "input",
    email: "e-postadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslett",
    date: "ISO-dato",
    time: "ISO-klokkeslett",
    duration: "ISO-varighet",
    ipv4: "IPv4-omr\\xE5de",
    ipv6: "IPv6-omr\\xE5de",
    cidrv4: "IPv4-spekter",
    cidrv6: "IPv6-spekter",
    base64: "base64-enkodet streng",
    base64url: "base64url-enkodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Ugyldig input: forventet \${issue2.expected}, fikk \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Ugyldig verdi: forventet \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Ugyldig valg: forventet en av \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`For stor(t): forventet \${issue2.origin ?? "value"} til \\xE5 ha \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementer"}\`;
        return \`For stor(t): forventet \${issue2.origin ?? "value"} til \\xE5 ha \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`For lite(n): forventet \${issue2.origin} til \\xE5 ha \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`For lite(n): forventet \${issue2.origin} til \\xE5 ha \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Ugyldig streng: m\\xE5 starte med "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Ugyldig streng: m\\xE5 ende med "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Ugyldig streng: m\\xE5 inneholde "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Ugyldig streng: m\\xE5 matche m\\xF8nsteret \${_issue.pattern}\`;
        return \`Ugyldig \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Ugyldig tall: m\\xE5 v\\xE6re et multiplum av \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\${issue2.keys.length > 1 ? "Ukjente n\\xF8kler" : "Ukjent n\\xF8kkel"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Ugyldig n\\xF8kkel i \${issue2.origin}\`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return \`Ugyldig verdi i \${issue2.origin}\`;
      default:
        return \`Ugyldig input\`;
    }
  };
}, "error");
function no_default() {
  return {
    localeError: error28()
  };
}
__name(no_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ota.js
var error29 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "harf",
      verb: "olmal\\u0131d\\u0131r"
    },
    file: {
      unit: "bayt",
      verb: "olmal\\u0131d\\u0131r"
    },
    array: {
      unit: "unsur",
      verb: "olmal\\u0131d\\u0131r"
    },
    set: {
      unit: "unsur",
      verb: "olmal\\u0131d\\u0131r"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numara";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "saf";
        }
        if (data === null) {
          return "gayb";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "giren",
    email: "epostag\\xE2h",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO heng\\xE2m\\u0131",
    date: "ISO tarihi",
    time: "ISO zaman\\u0131",
    duration: "ISO m\\xFCddeti",
    ipv4: "IPv4 ni\\u015F\\xE2n\\u0131",
    ipv6: "IPv6 ni\\u015F\\xE2n\\u0131",
    cidrv4: "IPv4 menzili",
    cidrv6: "IPv6 menzili",
    base64: "base64-\\u015Fifreli metin",
    base64url: "base64url-\\u015Fifreli metin",
    json_string: "JSON metin",
    e164: "E.164 say\\u0131s\\u0131",
    jwt: "JWT",
    template_literal: "giren"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`F\\xE2sit giren: umulan \${issue2.expected}, al\\u0131nan \${parsedType7(issue2.input)}\`;
      // return \`Fâsit giren: umulan \${issue.expected}, alınan \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`F\\xE2sit giren: umulan \${stringifyPrimitive(issue2.values[0])}\`;
        return \`F\\xE2sit tercih: m\\xFBteberler \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Fazla b\\xFCy\\xFCk: \${issue2.origin ?? "value"}, \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elements"} sahip olmal\\u0131yd\\u0131.\`;
        return \`Fazla b\\xFCy\\xFCk: \${issue2.origin ?? "value"}, \${adj}\${issue2.maximum.toString()} olmal\\u0131yd\\u0131.\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Fazla k\\xFC\\xE7\\xFCk: \${issue2.origin}, \${adj}\${issue2.minimum.toString()} \${sizing.unit} sahip olmal\\u0131yd\\u0131.\`;
        }
        return \`Fazla k\\xFC\\xE7\\xFCk: \${issue2.origin}, \${adj}\${issue2.minimum.toString()} olmal\\u0131yd\\u0131.\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`F\\xE2sit metin: "\${_issue.prefix}" ile ba\\u015Flamal\\u0131.\`;
        if (_issue.format === "ends_with") return \`F\\xE2sit metin: "\${_issue.suffix}" ile bitmeli.\`;
        if (_issue.format === "includes") return \`F\\xE2sit metin: "\${_issue.includes}" ihtiv\\xE2 etmeli.\`;
        if (_issue.format === "regex") return \`F\\xE2sit metin: \${_issue.pattern} nak\\u015F\\u0131na uymal\\u0131.\`;
        return \`F\\xE2sit \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`F\\xE2sit say\\u0131: \${issue2.divisor} kat\\u0131 olmal\\u0131yd\\u0131.\`;
      case "unrecognized_keys":
        return \`Tan\\u0131nmayan anahtar \${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\${issue2.origin} i\\xE7in tan\\u0131nmayan anahtar var.\`;
      case "invalid_union":
        return "Giren tan\\u0131namad\\u0131.";
      case "invalid_element":
        return \`\${issue2.origin} i\\xE7in tan\\u0131nmayan k\\u0131ymet var.\`;
      default:
        return \`K\\u0131ymet tan\\u0131namad\\u0131.\`;
    }
  };
}, "error");
function ota_default() {
  return {
    localeError: error29()
  };
}
__name(ota_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ps.js
var error30 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u062A\\u0648\\u06A9\\u064A",
      verb: "\\u0648\\u0644\\u0631\\u064A"
    },
    file: {
      unit: "\\u0628\\u0627\\u06CC\\u067C\\u0633",
      verb: "\\u0648\\u0644\\u0631\\u064A"
    },
    array: {
      unit: "\\u062A\\u0648\\u06A9\\u064A",
      verb: "\\u0648\\u0644\\u0631\\u064A"
    },
    set: {
      unit: "\\u062A\\u0648\\u06A9\\u064A",
      verb: "\\u0648\\u0644\\u0631\\u064A"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0639\\u062F\\u062F";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u0627\\u0631\\u06D0";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0648\\u0631\\u0648\\u062F\\u064A",
    email: "\\u0628\\u0631\\u06CC\\u069A\\u0646\\u0627\\u0644\\u06CC\\u06A9",
    url: "\\u06CC\\u0648 \\u0622\\u0631 \\u0627\\u0644",
    emoji: "\\u0627\\u06CC\\u0645\\u0648\\u062C\\u064A",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u0646\\u06CC\\u067C\\u0647 \\u0627\\u0648 \\u0648\\u062E\\u062A",
    date: "\\u0646\\u06D0\\u067C\\u0647",
    time: "\\u0648\\u062E\\u062A",
    duration: "\\u0645\\u0648\\u062F\\u0647",
    ipv4: "\\u062F IPv4 \\u067E\\u062A\\u0647",
    ipv6: "\\u062F IPv6 \\u067E\\u062A\\u0647",
    cidrv4: "\\u062F IPv4 \\u0633\\u0627\\u062D\\u0647",
    cidrv6: "\\u062F IPv6 \\u0633\\u0627\\u062D\\u0647",
    base64: "base64-encoded \\u0645\\u062A\\u0646",
    base64url: "base64url-encoded \\u0645\\u062A\\u0646",
    json_string: "JSON \\u0645\\u062A\\u0646",
    e164: "\\u062F E.164 \\u0634\\u0645\\u06D0\\u0631\\u0647",
    jwt: "JWT",
    template_literal: "\\u0648\\u0631\\u0648\\u062F\\u064A"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0646\\u0627\\u0633\\u0645 \\u0648\\u0631\\u0648\\u062F\\u064A: \\u0628\\u0627\\u06CC\\u062F \${issue2.expected} \\u0648\\u0627\\u06CC, \\u0645\\u06AB\\u0631 \${parsedType7(issue2.input)} \\u062A\\u0631\\u0644\\u0627\\u0633\\u0647 \\u0634\\u0648\`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return \`\\u0646\\u0627\\u0633\\u0645 \\u0648\\u0631\\u0648\\u062F\\u064A: \\u0628\\u0627\\u06CC\\u062F \${stringifyPrimitive(issue2.values[0])} \\u0648\\u0627\\u06CC\`;
        }
        return \`\\u0646\\u0627\\u0633\\u0645 \\u0627\\u0646\\u062A\\u062E\\u0627\\u0628: \\u0628\\u0627\\u06CC\\u062F \\u06CC\\u0648 \\u0644\\u0647 \${joinValues(issue2.values, "|")} \\u0685\\u062E\\u0647 \\u0648\\u0627\\u06CC\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0689\\u06CC\\u0631 \\u0644\\u0648\\u06CC: \${issue2.origin ?? "\\u0627\\u0631\\u0632\\u069A\\u062A"} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u0639\\u0646\\u0635\\u0631\\u0648\\u0646\\u0647"} \\u0648\\u0644\\u0631\\u064A\`;
        }
        return \`\\u0689\\u06CC\\u0631 \\u0644\\u0648\\u06CC: \${issue2.origin ?? "\\u0627\\u0631\\u0632\\u069A\\u062A"} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.maximum.toString()} \\u0648\\u064A\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0689\\u06CC\\u0631 \\u06A9\\u0648\\u0686\\u0646\\u06CC: \${issue2.origin} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.minimum.toString()} \${sizing.unit} \\u0648\\u0644\\u0631\\u064A\`;
        }
        return \`\\u0689\\u06CC\\u0631 \\u06A9\\u0648\\u0686\\u0646\\u06CC: \${issue2.origin} \\u0628\\u0627\\u06CC\\u062F \${adj}\${issue2.minimum.toString()} \\u0648\\u064A\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u0646\\u0627\\u0633\\u0645 \\u0645\\u062A\\u0646: \\u0628\\u0627\\u06CC\\u062F \\u062F "\${_issue.prefix}" \\u0633\\u0631\\u0647 \\u067E\\u06CC\\u0644 \\u0634\\u064A\`;
        }
        if (_issue.format === "ends_with") {
          return \`\\u0646\\u0627\\u0633\\u0645 \\u0645\\u062A\\u0646: \\u0628\\u0627\\u06CC\\u062F \\u062F "\${_issue.suffix}" \\u0633\\u0631\\u0647 \\u067E\\u0627\\u06CC \\u062A\\u0647 \\u0648\\u0631\\u0633\\u064A\\u0696\\u064A\`;
        }
        if (_issue.format === "includes") {
          return \`\\u0646\\u0627\\u0633\\u0645 \\u0645\\u062A\\u0646: \\u0628\\u0627\\u06CC\\u062F "\${_issue.includes}" \\u0648\\u0644\\u0631\\u064A\`;
        }
        if (_issue.format === "regex") {
          return \`\\u0646\\u0627\\u0633\\u0645 \\u0645\\u062A\\u0646: \\u0628\\u0627\\u06CC\\u062F \\u062F \${_issue.pattern} \\u0633\\u0631\\u0647 \\u0645\\u0637\\u0627\\u0628\\u0642\\u062A \\u0648\\u0644\\u0631\\u064A\`;
        }
        return \`\${Nouns[_issue.format] ?? issue2.format} \\u0646\\u0627\\u0633\\u0645 \\u062F\\u06CC\`;
      }
      case "not_multiple_of":
        return \`\\u0646\\u0627\\u0633\\u0645 \\u0639\\u062F\\u062F: \\u0628\\u0627\\u06CC\\u062F \\u062F \${issue2.divisor} \\u0645\\u0636\\u0631\\u0628 \\u0648\\u064A\`;
      case "unrecognized_keys":
        return \`\\u0646\\u0627\\u0633\\u0645 \${issue2.keys.length > 1 ? "\\u06A9\\u0644\\u06CC\\u0689\\u0648\\u0646\\u0647" : "\\u06A9\\u0644\\u06CC\\u0689"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u0646\\u0627\\u0633\\u0645 \\u06A9\\u0644\\u06CC\\u0689 \\u067E\\u0647 \${issue2.origin} \\u06A9\\u06D0\`;
      case "invalid_union":
        return \`\\u0646\\u0627\\u0633\\u0645\\u0647 \\u0648\\u0631\\u0648\\u062F\\u064A\`;
      case "invalid_element":
        return \`\\u0646\\u0627\\u0633\\u0645 \\u0639\\u0646\\u0635\\u0631 \\u067E\\u0647 \${issue2.origin} \\u06A9\\u06D0\`;
      default:
        return \`\\u0646\\u0627\\u0633\\u0645\\u0647 \\u0648\\u0631\\u0648\\u062F\\u064A\`;
    }
  };
}, "error");
function ps_default() {
  return {
    localeError: error30()
  };
}
__name(ps_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/pl.js
var error31 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "znak\\xF3w",
      verb: "mie\\u0107"
    },
    file: {
      unit: "bajt\\xF3w",
      verb: "mie\\u0107"
    },
    array: {
      unit: "element\\xF3w",
      verb: "mie\\u0107"
    },
    set: {
      unit: "element\\xF3w",
      verb: "mie\\u0107"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "liczba";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tablica";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "wyra\\u017Cenie",
    email: "adres email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i godzina w formacie ISO",
    date: "data w formacie ISO",
    time: "godzina w formacie ISO",
    duration: "czas trwania ISO",
    ipv4: "adres IPv4",
    ipv6: "adres IPv6",
    cidrv4: "zakres IPv4",
    cidrv6: "zakres IPv6",
    base64: "ci\\u0105g znak\\xF3w zakodowany w formacie base64",
    base64url: "ci\\u0105g znak\\xF3w zakodowany w formacie base64url",
    json_string: "ci\\u0105g znak\\xF3w w formacie JSON",
    e164: "liczba E.164",
    jwt: "JWT",
    template_literal: "wej\\u015Bcie"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Nieprawid\\u0142owe dane wej\\u015Bciowe: oczekiwano \${issue2.expected}, otrzymano \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Nieprawid\\u0142owe dane wej\\u015Bciowe: oczekiwano \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Nieprawid\\u0142owa opcja: oczekiwano jednej z warto\\u015Bci \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Za du\\u017Ca warto\\u015B\\u0107: oczekiwano, \\u017Ce \${issue2.origin ?? "warto\\u015B\\u0107"} b\\u0119dzie mie\\u0107 \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "element\\xF3w"}\`;
        }
        return \`Zbyt du\\u017C(y/a/e): oczekiwano, \\u017Ce \${issue2.origin ?? "warto\\u015B\\u0107"} b\\u0119dzie wynosi\\u0107 \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Za ma\\u0142a warto\\u015B\\u0107: oczekiwano, \\u017Ce \${issue2.origin ?? "warto\\u015B\\u0107"} b\\u0119dzie mie\\u0107 \${adj}\${issue2.minimum.toString()} \${sizing.unit ?? "element\\xF3w"}\`;
        }
        return \`Zbyt ma\\u0142(y/a/e): oczekiwano, \\u017Ce \${issue2.origin ?? "warto\\u015B\\u0107"} b\\u0119dzie wynosi\\u0107 \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Nieprawid\\u0142owy ci\\u0105g znak\\xF3w: musi zaczyna\\u0107 si\\u0119 od "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Nieprawid\\u0142owy ci\\u0105g znak\\xF3w: musi ko\\u0144czy\\u0107 si\\u0119 na "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Nieprawid\\u0142owy ci\\u0105g znak\\xF3w: musi zawiera\\u0107 "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Nieprawid\\u0142owy ci\\u0105g znak\\xF3w: musi odpowiada\\u0107 wzorcowi \${_issue.pattern}\`;
        return \`Nieprawid\\u0142ow(y/a/e) \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Nieprawid\\u0142owa liczba: musi by\\u0107 wielokrotno\\u015Bci\\u0105 \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Nierozpoznane klucze\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Nieprawid\\u0142owy klucz w \${issue2.origin}\`;
      case "invalid_union":
        return "Nieprawid\\u0142owe dane wej\\u015Bciowe";
      case "invalid_element":
        return \`Nieprawid\\u0142owa warto\\u015B\\u0107 w \${issue2.origin}\`;
      default:
        return \`Nieprawid\\u0142owe dane wej\\u015Bciowe\`;
    }
  };
}, "error");
function pl_default() {
  return {
    localeError: error31()
  };
}
__name(pl_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/pt.js
var error32 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "caracteres",
      verb: "ter"
    },
    file: {
      unit: "bytes",
      verb: "ter"
    },
    array: {
      unit: "itens",
      verb: "ter"
    },
    set: {
      unit: "itens",
      verb: "ter"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "n\\xFAmero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "nulo";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "padr\\xE3o",
    email: "endere\\xE7o de e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "dura\\xE7\\xE3o ISO",
    ipv4: "endere\\xE7o IPv4",
    ipv6: "endere\\xE7o IPv6",
    cidrv4: "faixa de IPv4",
    cidrv6: "faixa de IPv6",
    base64: "texto codificado em base64",
    base64url: "URL codificada em base64",
    json_string: "texto JSON",
    e164: "n\\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Tipo inv\\xE1lido: esperado \${issue2.expected}, recebido \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Entrada inv\\xE1lida: esperado \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Op\\xE7\\xE3o inv\\xE1lida: esperada uma das \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Muito grande: esperado que \${issue2.origin ?? "valor"} tivesse \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementos"}\`;
        return \`Muito grande: esperado que \${issue2.origin ?? "valor"} fosse \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Muito pequeno: esperado que \${issue2.origin} tivesse \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Muito pequeno: esperado que \${issue2.origin} fosse \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Texto inv\\xE1lido: deve come\\xE7ar com "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Texto inv\\xE1lido: deve terminar com "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Texto inv\\xE1lido: deve incluir "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Texto inv\\xE1lido: deve corresponder ao padr\\xE3o \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} inv\\xE1lido\`;
      }
      case "not_multiple_of":
        return \`N\\xFAmero inv\\xE1lido: deve ser m\\xFAltiplo de \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Chave\${issue2.keys.length > 1 ? "s" : ""} desconhecida\${issue2.keys.length > 1 ? "s" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Chave inv\\xE1lida em \${issue2.origin}\`;
      case "invalid_union":
        return "Entrada inv\\xE1lida";
      case "invalid_element":
        return \`Valor inv\\xE1lido em \${issue2.origin}\`;
      default:
        return \`Campo inv\\xE1lido\`;
    }
  };
}, "error");
function pt_default() {
  return {
    localeError: error32()
  };
}
__name(pt_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ru.js
function getRussianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
__name(getRussianPlural, "getRussianPlural");
var error33 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: {
        one: "\\u0441\\u0438\\u043C\\u0432\\u043E\\u043B",
        few: "\\u0441\\u0438\\u043C\\u0432\\u043E\\u043B\\u0430",
        many: "\\u0441\\u0438\\u043C\\u0432\\u043E\\u043B\\u043E\\u0432"
      },
      verb: "\\u0438\\u043C\\u0435\\u0442\\u044C"
    },
    file: {
      unit: {
        one: "\\u0431\\u0430\\u0439\\u0442",
        few: "\\u0431\\u0430\\u0439\\u0442\\u0430",
        many: "\\u0431\\u0430\\u0439\\u0442"
      },
      verb: "\\u0438\\u043C\\u0435\\u0442\\u044C"
    },
    array: {
      unit: {
        one: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442",
        few: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0430",
        many: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u043E\\u0432"
      },
      verb: "\\u0438\\u043C\\u0435\\u0442\\u044C"
    },
    set: {
      unit: {
        one: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442",
        few: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0430",
        many: "\\u044D\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u043E\\u0432"
      },
      verb: "\\u0438\\u043C\\u0435\\u0442\\u044C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0447\\u0438\\u0441\\u043B\\u043E";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u043C\\u0430\\u0441\\u0441\\u0438\\u0432";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0432\\u0432\\u043E\\u0434",
    email: "email \\u0430\\u0434\\u0440\\u0435\\u0441",
    url: "URL",
    emoji: "\\u044D\\u043C\\u043E\\u0434\\u0437\\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \\u0434\\u0430\\u0442\\u0430 \\u0438 \\u0432\\u0440\\u0435\\u043C\\u044F",
    date: "ISO \\u0434\\u0430\\u0442\\u0430",
    time: "ISO \\u0432\\u0440\\u0435\\u043C\\u044F",
    duration: "ISO \\u0434\\u043B\\u0438\\u0442\\u0435\\u043B\\u044C\\u043D\\u043E\\u0441\\u0442\\u044C",
    ipv4: "IPv4 \\u0430\\u0434\\u0440\\u0435\\u0441",
    ipv6: "IPv6 \\u0430\\u0434\\u0440\\u0435\\u0441",
    cidrv4: "IPv4 \\u0434\\u0438\\u0430\\u043F\\u0430\\u0437\\u043E\\u043D",
    cidrv6: "IPv6 \\u0434\\u0438\\u0430\\u043F\\u0430\\u0437\\u043E\\u043D",
    base64: "\\u0441\\u0442\\u0440\\u043E\\u043A\\u0430 \\u0432 \\u0444\\u043E\\u0440\\u043C\\u0430\\u0442\\u0435 base64",
    base64url: "\\u0441\\u0442\\u0440\\u043E\\u043A\\u0430 \\u0432 \\u0444\\u043E\\u0440\\u043C\\u0430\\u0442\\u0435 base64url",
    json_string: "JSON \\u0441\\u0442\\u0440\\u043E\\u043A\\u0430",
    e164: "\\u043D\\u043E\\u043C\\u0435\\u0440 E.164",
    jwt: "JWT",
    template_literal: "\\u0432\\u0432\\u043E\\u0434"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0439 \\u0432\\u0432\\u043E\\u0434: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C \${issue2.expected}, \\u043F\\u043E\\u043B\\u0443\\u0447\\u0435\\u043D\\u043E \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0439 \\u0432\\u0432\\u043E\\u0434: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0439 \\u0432\\u0430\\u0440\\u0438\\u0430\\u043D\\u0442: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C \\u043E\\u0434\\u043D\\u043E \\u0438\\u0437 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getRussianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return \`\\u0421\\u043B\\u0438\\u0448\\u043A\\u043E\\u043C \\u0431\\u043E\\u043B\\u044C\\u0448\\u043E\\u0435 \\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C, \\u0447\\u0442\\u043E \${issue2.origin ?? "\\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435"} \\u0431\\u0443\\u0434\\u0435\\u0442 \\u0438\\u043C\\u0435\\u0442\\u044C \${adj}\${issue2.maximum.toString()} \${unit}\`;
        }
        return \`\\u0421\\u043B\\u0438\\u0448\\u043A\\u043E\\u043C \\u0431\\u043E\\u043B\\u044C\\u0448\\u043E\\u0435 \\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C, \\u0447\\u0442\\u043E \${issue2.origin ?? "\\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435"} \\u0431\\u0443\\u0434\\u0435\\u0442 \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getRussianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return \`\\u0421\\u043B\\u0438\\u0448\\u043A\\u043E\\u043C \\u043C\\u0430\\u043B\\u0435\\u043D\\u044C\\u043A\\u043E\\u0435 \\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C, \\u0447\\u0442\\u043E \${issue2.origin} \\u0431\\u0443\\u0434\\u0435\\u0442 \\u0438\\u043C\\u0435\\u0442\\u044C \${adj}\${issue2.minimum.toString()} \${unit}\`;
        }
        return \`\\u0421\\u043B\\u0438\\u0448\\u043A\\u043E\\u043C \\u043C\\u0430\\u043B\\u0435\\u043D\\u044C\\u043A\\u043E\\u0435 \\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435: \\u043E\\u0436\\u0438\\u0434\\u0430\\u043B\\u043E\\u0441\\u044C, \\u0447\\u0442\\u043E \${issue2.origin} \\u0431\\u0443\\u0434\\u0435\\u0442 \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u0430\\u044F \\u0441\\u0442\\u0440\\u043E\\u043A\\u0430: \\u0434\\u043E\\u043B\\u0436\\u043D\\u0430 \\u043D\\u0430\\u0447\\u0438\\u043D\\u0430\\u0442\\u044C\\u0441\\u044F \\u0441 "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u0430\\u044F \\u0441\\u0442\\u0440\\u043E\\u043A\\u0430: \\u0434\\u043E\\u043B\\u0436\\u043D\\u0430 \\u0437\\u0430\\u043A\\u0430\\u043D\\u0447\\u0438\\u0432\\u0430\\u0442\\u044C\\u0441\\u044F \\u043D\\u0430 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u0430\\u044F \\u0441\\u0442\\u0440\\u043E\\u043A\\u0430: \\u0434\\u043E\\u043B\\u0436\\u043D\\u0430 \\u0441\\u043E\\u0434\\u0435\\u0440\\u0436\\u0430\\u0442\\u044C "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u0430\\u044F \\u0441\\u0442\\u0440\\u043E\\u043A\\u0430: \\u0434\\u043E\\u043B\\u0436\\u043D\\u0430 \\u0441\\u043E\\u043E\\u0442\\u0432\\u0435\\u0442\\u0441\\u0442\\u0432\\u043E\\u0432\\u0430\\u0442\\u044C \\u0448\\u0430\\u0431\\u043B\\u043E\\u043D\\u0443 \${_issue.pattern}\`;
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0439 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u043E\\u0435 \\u0447\\u0438\\u0441\\u043B\\u043E: \\u0434\\u043E\\u043B\\u0436\\u043D\\u043E \\u0431\\u044B\\u0442\\u044C \\u043A\\u0440\\u0430\\u0442\\u043D\\u044B\\u043C \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\u041D\\u0435\\u0440\\u0430\\u0441\\u043F\\u043E\\u0437\\u043D\\u0430\\u043D\\u043D\${issue2.keys.length > 1 ? "\\u044B\\u0435" : "\\u044B\\u0439"} \\u043A\\u043B\\u044E\\u0447\${issue2.keys.length > 1 ? "\\u0438" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0439 \\u043A\\u043B\\u044E\\u0447 \\u0432 \${issue2.origin}\`;
      case "invalid_union":
        return "\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0435 \\u0432\\u0445\\u043E\\u0434\\u043D\\u044B\\u0435 \\u0434\\u0430\\u043D\\u043D\\u044B\\u0435";
      case "invalid_element":
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u043E\\u0435 \\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u0438\\u0435 \\u0432 \${issue2.origin}\`;
      default:
        return \`\\u041D\\u0435\\u0432\\u0435\\u0440\\u043D\\u044B\\u0435 \\u0432\\u0445\\u043E\\u0434\\u043D\\u044B\\u0435 \\u0434\\u0430\\u043D\\u043D\\u044B\\u0435\`;
    }
  };
}, "error");
function ru_default() {
  return {
    localeError: error33()
  };
}
__name(ru_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/sl.js
var error34 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "znakov",
      verb: "imeti"
    },
    file: {
      unit: "bajtov",
      verb: "imeti"
    },
    array: {
      unit: "elementov",
      verb: "imeti"
    },
    set: {
      unit: "elementov",
      verb: "imeti"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0161tevilo";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tabela";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "vnos",
    email: "e-po\\u0161tni naslov",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum in \\u010Das",
    date: "ISO datum",
    time: "ISO \\u010Das",
    duration: "ISO trajanje",
    ipv4: "IPv4 naslov",
    ipv6: "IPv6 naslov",
    cidrv4: "obseg IPv4",
    cidrv6: "obseg IPv6",
    base64: "base64 kodiran niz",
    base64url: "base64url kodiran niz",
    json_string: "JSON niz",
    e164: "E.164 \\u0161tevilka",
    jwt: "JWT",
    template_literal: "vnos"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Neveljaven vnos: pri\\u010Dakovano \${issue2.expected}, prejeto \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Neveljaven vnos: pri\\u010Dakovano \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Neveljavna mo\\u017Enost: pri\\u010Dakovano eno izmed \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Preveliko: pri\\u010Dakovano, da bo \${issue2.origin ?? "vrednost"} imelo \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "elementov"}\`;
        return \`Preveliko: pri\\u010Dakovano, da bo \${issue2.origin ?? "vrednost"} \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Premajhno: pri\\u010Dakovano, da bo \${issue2.origin} imelo \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Premajhno: pri\\u010Dakovano, da bo \${issue2.origin} \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Neveljaven niz: mora se za\\u010Deti z "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`Neveljaven niz: mora se kon\\u010Dati z "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Neveljaven niz: mora vsebovati "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Neveljaven niz: mora ustrezati vzorcu \${_issue.pattern}\`;
        return \`Neveljaven \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Neveljavno \\u0161tevilo: mora biti ve\\u010Dkratnik \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Neprepoznan\${issue2.keys.length > 1 ? "i klju\\u010Di" : " klju\\u010D"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Neveljaven klju\\u010D v \${issue2.origin}\`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return \`Neveljavna vrednost v \${issue2.origin}\`;
      default:
        return "Neveljaven vnos";
    }
  };
}, "error");
function sl_default() {
  return {
    localeError: error34()
  };
}
__name(sl_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/sv.js
var error35 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "tecken",
      verb: "att ha"
    },
    file: {
      unit: "bytes",
      verb: "att ha"
    },
    array: {
      unit: "objekt",
      verb: "att inneh\\xE5lla"
    },
    set: {
      unit: "objekt",
      verb: "att inneh\\xE5lla"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "antal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "lista";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "regulj\\xE4rt uttryck",
    email: "e-postadress",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datum och tid",
    date: "ISO-datum",
    time: "ISO-tid",
    duration: "ISO-varaktighet",
    ipv4: "IPv4-intervall",
    ipv6: "IPv6-intervall",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodad str\\xE4ng",
    base64url: "base64url-kodad str\\xE4ng",
    json_string: "JSON-str\\xE4ng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "mall-literal"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Ogiltig inmatning: f\\xF6rv\\xE4ntat \${issue2.expected}, fick \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Ogiltig inmatning: f\\xF6rv\\xE4ntat \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Ogiltigt val: f\\xF6rv\\xE4ntade en av \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`F\\xF6r stor(t): f\\xF6rv\\xE4ntade \${issue2.origin ?? "v\\xE4rdet"} att ha \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "element"}\`;
        }
        return \`F\\xF6r stor(t): f\\xF6rv\\xE4ntat \${issue2.origin ?? "v\\xE4rdet"} att ha \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`F\\xF6r lite(t): f\\xF6rv\\xE4ntade \${issue2.origin ?? "v\\xE4rdet"} att ha \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`F\\xF6r lite(t): f\\xF6rv\\xE4ntade \${issue2.origin ?? "v\\xE4rdet"} att ha \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`Ogiltig str\\xE4ng: m\\xE5ste b\\xF6rja med "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`Ogiltig str\\xE4ng: m\\xE5ste sluta med "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Ogiltig str\\xE4ng: m\\xE5ste inneh\\xE5lla "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Ogiltig str\\xE4ng: m\\xE5ste matcha m\\xF6nstret "\${_issue.pattern}"\`;
        return \`Ogiltig(t) \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Ogiltigt tal: m\\xE5ste vara en multipel av \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\${issue2.keys.length > 1 ? "Ok\\xE4nda nycklar" : "Ok\\xE4nd nyckel"}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Ogiltig nyckel i \${issue2.origin ?? "v\\xE4rdet"}\`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return \`Ogiltigt v\\xE4rde i \${issue2.origin ?? "v\\xE4rdet"}\`;
      default:
        return \`Ogiltig input\`;
    }
  };
}, "error");
function sv_default() {
  return {
    localeError: error35()
  };
}
__name(sv_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ta.js
var error36 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u0B8E\\u0BB4\\u0BC1\\u0BA4\\u0BCD\\u0BA4\\u0BC1\\u0B95\\u0BCD\\u0B95\\u0BB3\\u0BCD",
      verb: "\\u0B95\\u0BCA\\u0BA3\\u0BCD\\u0B9F\\u0BBF\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD"
    },
    file: {
      unit: "\\u0BAA\\u0BC8\\u0B9F\\u0BCD\\u0B9F\\u0BC1\\u0B95\\u0BB3\\u0BCD",
      verb: "\\u0B95\\u0BCA\\u0BA3\\u0BCD\\u0B9F\\u0BBF\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD"
    },
    array: {
      unit: "\\u0B89\\u0BB1\\u0BC1\\u0BAA\\u0BCD\\u0BAA\\u0BC1\\u0B95\\u0BB3\\u0BCD",
      verb: "\\u0B95\\u0BCA\\u0BA3\\u0BCD\\u0B9F\\u0BBF\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD"
    },
    set: {
      unit: "\\u0B89\\u0BB1\\u0BC1\\u0BAA\\u0BCD\\u0BAA\\u0BC1\\u0B95\\u0BB3\\u0BCD",
      verb: "\\u0B95\\u0BCA\\u0BA3\\u0BCD\\u0B9F\\u0BBF\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\\u0B8E\\u0BA3\\u0BCD \\u0B85\\u0BB2\\u0BCD\\u0BB2\\u0BBE\\u0BA4\\u0BA4\\u0BC1" : "\\u0B8E\\u0BA3\\u0BCD";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u0B85\\u0BA3\\u0BBF";
        }
        if (data === null) {
          return "\\u0BB5\\u0BC6\\u0BB1\\u0BC1\\u0BAE\\u0BC8";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0B89\\u0BB3\\u0BCD\\u0BB3\\u0BC0\\u0B9F\\u0BC1",
    email: "\\u0BAE\\u0BBF\\u0BA9\\u0BCD\\u0BA9\\u0B9E\\u0BCD\\u0B9A\\u0BB2\\u0BCD \\u0BAE\\u0BC1\\u0B95\\u0BB5\\u0BB0\\u0BBF",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \\u0BA4\\u0BC7\\u0BA4\\u0BBF \\u0BA8\\u0BC7\\u0BB0\\u0BAE\\u0BCD",
    date: "ISO \\u0BA4\\u0BC7\\u0BA4\\u0BBF",
    time: "ISO \\u0BA8\\u0BC7\\u0BB0\\u0BAE\\u0BCD",
    duration: "ISO \\u0B95\\u0BBE\\u0BB2 \\u0B85\\u0BB3\\u0BB5\\u0BC1",
    ipv4: "IPv4 \\u0BAE\\u0BC1\\u0B95\\u0BB5\\u0BB0\\u0BBF",
    ipv6: "IPv6 \\u0BAE\\u0BC1\\u0B95\\u0BB5\\u0BB0\\u0BBF",
    cidrv4: "IPv4 \\u0BB5\\u0BB0\\u0BAE\\u0BCD\\u0BAA\\u0BC1",
    cidrv6: "IPv6 \\u0BB5\\u0BB0\\u0BAE\\u0BCD\\u0BAA\\u0BC1",
    base64: "base64-encoded \\u0B9A\\u0BB0\\u0BAE\\u0BCD",
    base64url: "base64url-encoded \\u0B9A\\u0BB0\\u0BAE\\u0BCD",
    json_string: "JSON \\u0B9A\\u0BB0\\u0BAE\\u0BCD",
    e164: "E.164 \\u0B8E\\u0BA3\\u0BCD",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B89\\u0BB3\\u0BCD\\u0BB3\\u0BC0\\u0B9F\\u0BC1: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${issue2.expected}, \\u0BAA\\u0BC6\\u0BB1\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B89\\u0BB3\\u0BCD\\u0BB3\\u0BC0\\u0B9F\\u0BC1: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0BB5\\u0BBF\\u0BB0\\u0BC1\\u0BAA\\u0BCD\\u0BAA\\u0BAE\\u0BCD: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${joinValues(issue2.values, "|")} \\u0B87\\u0BB2\\u0BCD \\u0B92\\u0BA9\\u0BCD\\u0BB1\\u0BC1\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0BAE\\u0BBF\\u0B95 \\u0BAA\\u0BC6\\u0BB0\\u0BBF\\u0BAF\\u0BA4\\u0BC1: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${issue2.origin ?? "\\u0BAE\\u0BA4\\u0BBF\\u0BAA\\u0BCD\\u0BAA\\u0BC1"} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u0B89\\u0BB1\\u0BC1\\u0BAA\\u0BCD\\u0BAA\\u0BC1\\u0B95\\u0BB3\\u0BCD"} \\u0B86\\u0B95 \\u0B87\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
        }
        return \`\\u0BAE\\u0BBF\\u0B95 \\u0BAA\\u0BC6\\u0BB0\\u0BBF\\u0BAF\\u0BA4\\u0BC1: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${issue2.origin ?? "\\u0BAE\\u0BA4\\u0BBF\\u0BAA\\u0BCD\\u0BAA\\u0BC1"} \${adj}\${issue2.maximum.toString()} \\u0B86\\u0B95 \\u0B87\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0BAE\\u0BBF\\u0B95\\u0B9A\\u0BCD \\u0B9A\\u0BBF\\u0BB1\\u0BBF\\u0BAF\\u0BA4\\u0BC1: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${issue2.origin} \${adj}\${issue2.minimum.toString()} \${sizing.unit} \\u0B86\\u0B95 \\u0B87\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
        }
        return \`\\u0BAE\\u0BBF\\u0B95\\u0B9A\\u0BCD \\u0B9A\\u0BBF\\u0BB1\\u0BBF\\u0BAF\\u0BA4\\u0BC1: \\u0B8E\\u0BA4\\u0BBF\\u0BB0\\u0BCD\\u0BAA\\u0BBE\\u0BB0\\u0BCD\\u0B95\\u0BCD\\u0B95\\u0BAA\\u0BCD\\u0BAA\\u0B9F\\u0BCD\\u0B9F\\u0BA4\\u0BC1 \${issue2.origin} \${adj}\${issue2.minimum.toString()} \\u0B86\\u0B95 \\u0B87\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B9A\\u0BB0\\u0BAE\\u0BCD: "\${_issue.prefix}" \\u0B87\\u0BB2\\u0BCD \\u0BA4\\u0BCA\\u0B9F\\u0B99\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
        if (_issue.format === "ends_with") return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B9A\\u0BB0\\u0BAE\\u0BCD: "\${_issue.suffix}" \\u0B87\\u0BB2\\u0BCD \\u0BAE\\u0BC1\\u0B9F\\u0BBF\\u0BB5\\u0B9F\\u0BC8\\u0BAF \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
        if (_issue.format === "includes") return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B9A\\u0BB0\\u0BAE\\u0BCD: "\${_issue.includes}" \\u0B90 \\u0B89\\u0BB3\\u0BCD\\u0BB3\\u0B9F\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
        if (_issue.format === "regex") return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B9A\\u0BB0\\u0BAE\\u0BCD: \${_issue.pattern} \\u0BAE\\u0BC1\\u0BB1\\u0BC8\\u0BAA\\u0BBE\\u0B9F\\u0BCD\\u0B9F\\u0BC1\\u0B9F\\u0BA9\\u0BCD \\u0BAA\\u0BCA\\u0BB0\\u0BC1\\u0BA8\\u0BCD\\u0BA4 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
        return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B8E\\u0BA3\\u0BCD: \${issue2.divisor} \\u0B87\\u0BA9\\u0BCD \\u0BAA\\u0BB2\\u0BAE\\u0BBE\\u0B95 \\u0B87\\u0BB0\\u0BC1\\u0B95\\u0BCD\\u0B95 \\u0BB5\\u0BC7\\u0BA3\\u0BCD\\u0B9F\\u0BC1\\u0BAE\\u0BCD\`;
      case "unrecognized_keys":
        return \`\\u0B85\\u0B9F\\u0BC8\\u0BAF\\u0BBE\\u0BB3\\u0BAE\\u0BCD \\u0BA4\\u0BC6\\u0BB0\\u0BBF\\u0BAF\\u0BBE\\u0BA4 \\u0BB5\\u0BBF\\u0B9A\\u0BC8\${issue2.keys.length > 1 ? "\\u0B95\\u0BB3\\u0BCD" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\${issue2.origin} \\u0B87\\u0BB2\\u0BCD \\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0BB5\\u0BBF\\u0B9A\\u0BC8\`;
      case "invalid_union":
        return "\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B89\\u0BB3\\u0BCD\\u0BB3\\u0BC0\\u0B9F\\u0BC1";
      case "invalid_element":
        return \`\${issue2.origin} \\u0B87\\u0BB2\\u0BCD \\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0BAE\\u0BA4\\u0BBF\\u0BAA\\u0BCD\\u0BAA\\u0BC1\`;
      default:
        return \`\\u0BA4\\u0BB5\\u0BB1\\u0BBE\\u0BA9 \\u0B89\\u0BB3\\u0BCD\\u0BB3\\u0BC0\\u0B9F\\u0BC1\`;
    }
  };
}, "error");
function ta_default() {
  return {
    localeError: error36()
  };
}
__name(ta_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/th.js
var error37 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u0E15\\u0E31\\u0E27\\u0E2D\\u0E31\\u0E01\\u0E29\\u0E23",
      verb: "\\u0E04\\u0E27\\u0E23\\u0E21\\u0E35"
    },
    file: {
      unit: "\\u0E44\\u0E1A\\u0E15\\u0E4C",
      verb: "\\u0E04\\u0E27\\u0E23\\u0E21\\u0E35"
    },
    array: {
      unit: "\\u0E23\\u0E32\\u0E22\\u0E01\\u0E32\\u0E23",
      verb: "\\u0E04\\u0E27\\u0E23\\u0E21\\u0E35"
    },
    set: {
      unit: "\\u0E23\\u0E32\\u0E22\\u0E01\\u0E32\\u0E23",
      verb: "\\u0E04\\u0E27\\u0E23\\u0E21\\u0E35"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\\u0E44\\u0E21\\u0E48\\u0E43\\u0E0A\\u0E48\\u0E15\\u0E31\\u0E27\\u0E40\\u0E25\\u0E02 (NaN)" : "\\u0E15\\u0E31\\u0E27\\u0E40\\u0E25\\u0E02";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u0E2D\\u0E32\\u0E23\\u0E4C\\u0E40\\u0E23\\u0E22\\u0E4C (Array)";
        }
        if (data === null) {
          return "\\u0E44\\u0E21\\u0E48\\u0E21\\u0E35\\u0E04\\u0E48\\u0E32 (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E17\\u0E35\\u0E48\\u0E1B\\u0E49\\u0E2D\\u0E19",
    email: "\\u0E17\\u0E35\\u0E48\\u0E2D\\u0E22\\u0E39\\u0E48\\u0E2D\\u0E35\\u0E40\\u0E21\\u0E25",
    url: "URL",
    emoji: "\\u0E2D\\u0E34\\u0E42\\u0E21\\u0E08\\u0E34",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u0E27\\u0E31\\u0E19\\u0E17\\u0E35\\u0E48\\u0E40\\u0E27\\u0E25\\u0E32\\u0E41\\u0E1A\\u0E1A ISO",
    date: "\\u0E27\\u0E31\\u0E19\\u0E17\\u0E35\\u0E48\\u0E41\\u0E1A\\u0E1A ISO",
    time: "\\u0E40\\u0E27\\u0E25\\u0E32\\u0E41\\u0E1A\\u0E1A ISO",
    duration: "\\u0E0A\\u0E48\\u0E27\\u0E07\\u0E40\\u0E27\\u0E25\\u0E32\\u0E41\\u0E1A\\u0E1A ISO",
    ipv4: "\\u0E17\\u0E35\\u0E48\\u0E2D\\u0E22\\u0E39\\u0E48 IPv4",
    ipv6: "\\u0E17\\u0E35\\u0E48\\u0E2D\\u0E22\\u0E39\\u0E48 IPv6",
    cidrv4: "\\u0E0A\\u0E48\\u0E27\\u0E07 IP \\u0E41\\u0E1A\\u0E1A IPv4",
    cidrv6: "\\u0E0A\\u0E48\\u0E27\\u0E07 IP \\u0E41\\u0E1A\\u0E1A IPv6",
    base64: "\\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\\u0E41\\u0E1A\\u0E1A Base64",
    base64url: "\\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\\u0E41\\u0E1A\\u0E1A Base64 \\u0E2A\\u0E33\\u0E2B\\u0E23\\u0E31\\u0E1A URL",
    json_string: "\\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\\u0E41\\u0E1A\\u0E1A JSON",
    e164: "\\u0E40\\u0E1A\\u0E2D\\u0E23\\u0E4C\\u0E42\\u0E17\\u0E23\\u0E28\\u0E31\\u0E1E\\u0E17\\u0E4C\\u0E23\\u0E30\\u0E2B\\u0E27\\u0E48\\u0E32\\u0E07\\u0E1B\\u0E23\\u0E30\\u0E40\\u0E17\\u0E28 (E.164)",
    jwt: "\\u0E42\\u0E17\\u0E40\\u0E04\\u0E19 JWT",
    template_literal: "\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E17\\u0E35\\u0E48\\u0E1B\\u0E49\\u0E2D\\u0E19"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0E1B\\u0E23\\u0E30\\u0E40\\u0E20\\u0E17\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E04\\u0E27\\u0E23\\u0E40\\u0E1B\\u0E47\\u0E19 \${issue2.expected} \\u0E41\\u0E15\\u0E48\\u0E44\\u0E14\\u0E49\\u0E23\\u0E31\\u0E1A \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u0E04\\u0E48\\u0E32\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E04\\u0E27\\u0E23\\u0E40\\u0E1B\\u0E47\\u0E19 \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u0E15\\u0E31\\u0E27\\u0E40\\u0E25\\u0E37\\u0E2D\\u0E01\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E04\\u0E27\\u0E23\\u0E40\\u0E1B\\u0E47\\u0E19\\u0E2B\\u0E19\\u0E36\\u0E48\\u0E07\\u0E43\\u0E19 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "\\u0E44\\u0E21\\u0E48\\u0E40\\u0E01\\u0E34\\u0E19" : "\\u0E19\\u0E49\\u0E2D\\u0E22\\u0E01\\u0E27\\u0E48\\u0E32";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u0E40\\u0E01\\u0E34\\u0E19\\u0E01\\u0E33\\u0E2B\\u0E19\\u0E14: \${issue2.origin ?? "\\u0E04\\u0E48\\u0E32"} \\u0E04\\u0E27\\u0E23\\u0E21\\u0E35\${adj} \${issue2.maximum.toString()} \${sizing.unit ?? "\\u0E23\\u0E32\\u0E22\\u0E01\\u0E32\\u0E23"}\`;
        return \`\\u0E40\\u0E01\\u0E34\\u0E19\\u0E01\\u0E33\\u0E2B\\u0E19\\u0E14: \${issue2.origin ?? "\\u0E04\\u0E48\\u0E32"} \\u0E04\\u0E27\\u0E23\\u0E21\\u0E35\${adj} \${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\\u0E2D\\u0E22\\u0E48\\u0E32\\u0E07\\u0E19\\u0E49\\u0E2D\\u0E22" : "\\u0E21\\u0E32\\u0E01\\u0E01\\u0E27\\u0E48\\u0E32";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0E19\\u0E49\\u0E2D\\u0E22\\u0E01\\u0E27\\u0E48\\u0E32\\u0E01\\u0E33\\u0E2B\\u0E19\\u0E14: \${issue2.origin} \\u0E04\\u0E27\\u0E23\\u0E21\\u0E35\${adj} \${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u0E19\\u0E49\\u0E2D\\u0E22\\u0E01\\u0E27\\u0E48\\u0E32\\u0E01\\u0E33\\u0E2B\\u0E19\\u0E14: \${issue2.origin} \\u0E04\\u0E27\\u0E23\\u0E21\\u0E35\${adj} \${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\\u0E15\\u0E49\\u0E2D\\u0E07\\u0E02\\u0E36\\u0E49\\u0E19\\u0E15\\u0E49\\u0E19\\u0E14\\u0E49\\u0E27\\u0E22 "\${_issue.prefix}"\`;
        }
        if (_issue.format === "ends_with") return \`\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\\u0E15\\u0E49\\u0E2D\\u0E07\\u0E25\\u0E07\\u0E17\\u0E49\\u0E32\\u0E22\\u0E14\\u0E49\\u0E27\\u0E22 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\\u0E15\\u0E49\\u0E2D\\u0E07\\u0E21\\u0E35 "\${_issue.includes}" \\u0E2D\\u0E22\\u0E39\\u0E48\\u0E43\\u0E19\\u0E02\\u0E49\\u0E2D\\u0E04\\u0E27\\u0E32\\u0E21\`;
        if (_issue.format === "regex") return \`\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E15\\u0E49\\u0E2D\\u0E07\\u0E15\\u0E23\\u0E07\\u0E01\\u0E31\\u0E1A\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E17\\u0E35\\u0E48\\u0E01\\u0E33\\u0E2B\\u0E19\\u0E14 \${_issue.pattern}\`;
        return \`\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u0E15\\u0E31\\u0E27\\u0E40\\u0E25\\u0E02\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E15\\u0E49\\u0E2D\\u0E07\\u0E40\\u0E1B\\u0E47\\u0E19\\u0E08\\u0E33\\u0E19\\u0E27\\u0E19\\u0E17\\u0E35\\u0E48\\u0E2B\\u0E32\\u0E23\\u0E14\\u0E49\\u0E27\\u0E22 \${issue2.divisor} \\u0E44\\u0E14\\u0E49\\u0E25\\u0E07\\u0E15\\u0E31\\u0E27\`;
      case "unrecognized_keys":
        return \`\\u0E1E\\u0E1A\\u0E04\\u0E35\\u0E22\\u0E4C\\u0E17\\u0E35\\u0E48\\u0E44\\u0E21\\u0E48\\u0E23\\u0E39\\u0E49\\u0E08\\u0E31\\u0E01: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u0E04\\u0E35\\u0E22\\u0E4C\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07\\u0E43\\u0E19 \${issue2.origin}\`;
      case "invalid_union":
        return "\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07: \\u0E44\\u0E21\\u0E48\\u0E15\\u0E23\\u0E07\\u0E01\\u0E31\\u0E1A\\u0E23\\u0E39\\u0E1B\\u0E41\\u0E1A\\u0E1A\\u0E22\\u0E39\\u0E40\\u0E19\\u0E35\\u0E22\\u0E19\\u0E17\\u0E35\\u0E48\\u0E01\\u0E33\\u0E2B\\u0E19\\u0E14\\u0E44\\u0E27\\u0E49";
      case "invalid_element":
        return \`\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07\\u0E43\\u0E19 \${issue2.origin}\`;
      default:
        return \`\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E44\\u0E21\\u0E48\\u0E16\\u0E39\\u0E01\\u0E15\\u0E49\\u0E2D\\u0E07\`;
    }
  };
}, "error");
function th_default() {
  return {
    localeError: error37()
  };
}
__name(th_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/tr.js
var parsedType6 = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
}, "parsedType");
var error38 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "karakter",
      verb: "olmal\\u0131"
    },
    file: {
      unit: "bayt",
      verb: "olmal\\u0131"
    },
    array: {
      unit: "\\xF6\\u011Fe",
      verb: "olmal\\u0131"
    },
    set: {
      unit: "\\xF6\\u011Fe",
      verb: "olmal\\u0131"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const Nouns = {
    regex: "girdi",
    email: "e-posta adresi",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO tarih ve saat",
    date: "ISO tarih",
    time: "ISO saat",
    duration: "ISO s\\xFCre",
    ipv4: "IPv4 adresi",
    ipv6: "IPv6 adresi",
    cidrv4: "IPv4 aral\\u0131\\u011F\\u0131",
    cidrv6: "IPv6 aral\\u0131\\u011F\\u0131",
    base64: "base64 ile \\u015Fifrelenmi\\u015F metin",
    base64url: "base64url ile \\u015Fifrelenmi\\u015F metin",
    json_string: "JSON dizesi",
    e164: "E.164 say\\u0131s\\u0131",
    jwt: "JWT",
    template_literal: "\\u015Eablon dizesi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`Ge\\xE7ersiz de\\u011Fer: beklenen \${issue2.expected}, al\\u0131nan \${parsedType6(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`Ge\\xE7ersiz de\\u011Fer: beklenen \${stringifyPrimitive(issue2.values[0])}\`;
        return \`Ge\\xE7ersiz se\\xE7enek: a\\u015Fa\\u011F\\u0131dakilerden biri olmal\\u0131: \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\xC7ok b\\xFCy\\xFCk: beklenen \${issue2.origin ?? "de\\u011Fer"} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\xF6\\u011Fe"}\`;
        return \`\\xC7ok b\\xFCy\\xFCk: beklenen \${issue2.origin ?? "de\\u011Fer"} \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\xC7ok k\\xFC\\xE7\\xFCk: beklenen \${issue2.origin} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        return \`\\xC7ok k\\xFC\\xE7\\xFCk: beklenen \${issue2.origin} \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Ge\\xE7ersiz metin: "\${_issue.prefix}" ile ba\\u015Flamal\\u0131\`;
        if (_issue.format === "ends_with") return \`Ge\\xE7ersiz metin: "\${_issue.suffix}" ile bitmeli\`;
        if (_issue.format === "includes") return \`Ge\\xE7ersiz metin: "\${_issue.includes}" i\\xE7ermeli\`;
        if (_issue.format === "regex") return \`Ge\\xE7ersiz metin: \${_issue.pattern} desenine uymal\\u0131\`;
        return \`Ge\\xE7ersiz \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`Ge\\xE7ersiz say\\u0131: \${issue2.divisor} ile tam b\\xF6l\\xFCnebilmeli\`;
      case "unrecognized_keys":
        return \`Tan\\u0131nmayan anahtar\${issue2.keys.length > 1 ? "lar" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\${issue2.origin} i\\xE7inde ge\\xE7ersiz anahtar\`;
      case "invalid_union":
        return "Ge\\xE7ersiz de\\u011Fer";
      case "invalid_element":
        return \`\${issue2.origin} i\\xE7inde ge\\xE7ersiz de\\u011Fer\`;
      default:
        return \`Ge\\xE7ersiz de\\u011Fer\`;
    }
  };
}, "error");
function tr_default() {
  return {
    localeError: error38()
  };
}
__name(tr_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/uk.js
var error39 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u0441\\u0438\\u043C\\u0432\\u043E\\u043B\\u0456\\u0432",
      verb: "\\u043C\\u0430\\u0442\\u0438\\u043C\\u0435"
    },
    file: {
      unit: "\\u0431\\u0430\\u0439\\u0442\\u0456\\u0432",
      verb: "\\u043C\\u0430\\u0442\\u0438\\u043C\\u0435"
    },
    array: {
      unit: "\\u0435\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0456\\u0432",
      verb: "\\u043C\\u0430\\u0442\\u0438\\u043C\\u0435"
    },
    set: {
      unit: "\\u0435\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0456\\u0432",
      verb: "\\u043C\\u0430\\u0442\\u0438\\u043C\\u0435"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0447\\u0438\\u0441\\u043B\\u043E";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u043C\\u0430\\u0441\\u0438\\u0432";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0432\\u0445\\u0456\\u0434\\u043D\\u0456 \\u0434\\u0430\\u043D\\u0456",
    email: "\\u0430\\u0434\\u0440\\u0435\\u0441\\u0430 \\u0435\\u043B\\u0435\\u043A\\u0442\\u0440\\u043E\\u043D\\u043D\\u043E\\u0457 \\u043F\\u043E\\u0448\\u0442\\u0438",
    url: "URL",
    emoji: "\\u0435\\u043C\\u043E\\u0434\\u0437\\u0456",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\u0434\\u0430\\u0442\\u0430 \\u0442\\u0430 \\u0447\\u0430\\u0441 ISO",
    date: "\\u0434\\u0430\\u0442\\u0430 ISO",
    time: "\\u0447\\u0430\\u0441 ISO",
    duration: "\\u0442\\u0440\\u0438\\u0432\\u0430\\u043B\\u0456\\u0441\\u0442\\u044C ISO",
    ipv4: "\\u0430\\u0434\\u0440\\u0435\\u0441\\u0430 IPv4",
    ipv6: "\\u0430\\u0434\\u0440\\u0435\\u0441\\u0430 IPv6",
    cidrv4: "\\u0434\\u0456\\u0430\\u043F\\u0430\\u0437\\u043E\\u043D IPv4",
    cidrv6: "\\u0434\\u0456\\u0430\\u043F\\u0430\\u0437\\u043E\\u043D IPv6",
    base64: "\\u0440\\u044F\\u0434\\u043E\\u043A \\u0443 \\u043A\\u043E\\u0434\\u0443\\u0432\\u0430\\u043D\\u043D\\u0456 base64",
    base64url: "\\u0440\\u044F\\u0434\\u043E\\u043A \\u0443 \\u043A\\u043E\\u0434\\u0443\\u0432\\u0430\\u043D\\u043D\\u0456 base64url",
    json_string: "\\u0440\\u044F\\u0434\\u043E\\u043A JSON",
    e164: "\\u043D\\u043E\\u043C\\u0435\\u0440 E.164",
    jwt: "JWT",
    template_literal: "\\u0432\\u0445\\u0456\\u0434\\u043D\\u0456 \\u0434\\u0430\\u043D\\u0456"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0456 \\u0432\\u0445\\u0456\\u0434\\u043D\\u0456 \\u0434\\u0430\\u043D\\u0456: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F \${issue2.expected}, \\u043E\\u0442\\u0440\\u0438\\u043C\\u0430\\u043D\\u043E \${parsedType7(issue2.input)}\`;
      // return \`Неправильні вхідні дані: очікується \${issue.expected}, отримано \${util.getParsedType(issue.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0456 \\u0432\\u0445\\u0456\\u0434\\u043D\\u0456 \\u0434\\u0430\\u043D\\u0456: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0430 \\u043E\\u043F\\u0446\\u0456\\u044F: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F \\u043E\\u0434\\u043D\\u0435 \\u0437 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u043E \\u0432\\u0435\\u043B\\u0438\\u043A\\u0435: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F, \\u0449\\u043E \${issue2.origin ?? "\\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u043D\\u044F"} \${sizing.verb} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u0435\\u043B\\u0435\\u043C\\u0435\\u043D\\u0442\\u0456\\u0432"}\`;
        return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u043E \\u0432\\u0435\\u043B\\u0438\\u043A\\u0435: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F, \\u0449\\u043E \${issue2.origin ?? "\\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u043D\\u044F"} \\u0431\\u0443\\u0434\\u0435 \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u043E \\u043C\\u0430\\u043B\\u0435: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F, \\u0449\\u043E \${issue2.origin} \${sizing.verb} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u0417\\u0430\\u043D\\u0430\\u0434\\u0442\\u043E \\u043C\\u0430\\u043B\\u0435: \\u043E\\u0447\\u0456\\u043A\\u0443\\u0454\\u0442\\u044C\\u0441\\u044F, \\u0449\\u043E \${issue2.origin} \\u0431\\u0443\\u0434\\u0435 \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0438\\u0439 \\u0440\\u044F\\u0434\\u043E\\u043A: \\u043F\\u043E\\u0432\\u0438\\u043D\\u0435\\u043D \\u043F\\u043E\\u0447\\u0438\\u043D\\u0430\\u0442\\u0438\\u0441\\u044F \\u0437 "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0438\\u0439 \\u0440\\u044F\\u0434\\u043E\\u043A: \\u043F\\u043E\\u0432\\u0438\\u043D\\u0435\\u043D \\u0437\\u0430\\u043A\\u0456\\u043D\\u0447\\u0443\\u0432\\u0430\\u0442\\u0438\\u0441\\u044F \\u043D\\u0430 "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0438\\u0439 \\u0440\\u044F\\u0434\\u043E\\u043A: \\u043F\\u043E\\u0432\\u0438\\u043D\\u0435\\u043D \\u043C\\u0456\\u0441\\u0442\\u0438\\u0442\\u0438 "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0438\\u0439 \\u0440\\u044F\\u0434\\u043E\\u043A: \\u043F\\u043E\\u0432\\u0438\\u043D\\u0435\\u043D \\u0432\\u0456\\u0434\\u043F\\u043E\\u0432\\u0456\\u0434\\u0430\\u0442\\u0438 \\u0448\\u0430\\u0431\\u043B\\u043E\\u043D\\u0443 \${_issue.pattern}\`;
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0438\\u0439 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0435 \\u0447\\u0438\\u0441\\u043B\\u043E: \\u043F\\u043E\\u0432\\u0438\\u043D\\u043D\\u043E \\u0431\\u0443\\u0442\\u0438 \\u043A\\u0440\\u0430\\u0442\\u043D\\u0438\\u043C \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`\\u041D\\u0435\\u0440\\u043E\\u0437\\u043F\\u0456\\u0437\\u043D\\u0430\\u043D\\u0438\\u0439 \\u043A\\u043B\\u044E\\u0447\${issue2.keys.length > 1 ? "\\u0456" : ""}: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0438\\u0439 \\u043A\\u043B\\u044E\\u0447 \\u0443 \${issue2.origin}\`;
      case "invalid_union":
        return "\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0456 \\u0432\\u0445\\u0456\\u0434\\u043D\\u0456 \\u0434\\u0430\\u043D\\u0456";
      case "invalid_element":
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0435 \\u0437\\u043D\\u0430\\u0447\\u0435\\u043D\\u043D\\u044F \\u0443 \${issue2.origin}\`;
      default:
        return \`\\u041D\\u0435\\u043F\\u0440\\u0430\\u0432\\u0438\\u043B\\u044C\\u043D\\u0456 \\u0432\\u0445\\u0456\\u0434\\u043D\\u0456 \\u0434\\u0430\\u043D\\u0456\`;
    }
  };
}, "error");
function uk_default() {
  return {
    localeError: error39()
  };
}
__name(uk_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ua.js
function ua_default() {
  return uk_default();
}
__name(ua_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/ur.js
var error40 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u062D\\u0631\\u0648\\u0641",
      verb: "\\u06C1\\u0648\\u0646\\u0627"
    },
    file: {
      unit: "\\u0628\\u0627\\u0626\\u0679\\u0633",
      verb: "\\u06C1\\u0648\\u0646\\u0627"
    },
    array: {
      unit: "\\u0622\\u0626\\u0679\\u0645\\u0632",
      verb: "\\u06C1\\u0648\\u0646\\u0627"
    },
    set: {
      unit: "\\u0622\\u0626\\u0679\\u0645\\u0632",
      verb: "\\u06C1\\u0648\\u0646\\u0627"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\\u0646\\u0645\\u0628\\u0631";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u0622\\u0631\\u06D2";
        }
        if (data === null) {
          return "\\u0646\\u0644";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0627\\u0646 \\u067E\\u0679",
    email: "\\u0627\\u06CC \\u0645\\u06CC\\u0644 \\u0627\\u06CC\\u0688\\u0631\\u06CC\\u0633",
    url: "\\u06CC\\u0648 \\u0622\\u0631 \\u0627\\u06CC\\u0644",
    emoji: "\\u0627\\u06CC\\u0645\\u0648\\u062C\\u06CC",
    uuid: "\\u06CC\\u0648 \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    uuidv4: "\\u06CC\\u0648 \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC \\u0648\\u06CC 4",
    uuidv6: "\\u06CC\\u0648 \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC \\u0648\\u06CC 6",
    nanoid: "\\u0646\\u06CC\\u0646\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    guid: "\\u062C\\u06CC \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    cuid: "\\u0633\\u06CC \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    cuid2: "\\u0633\\u06CC \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC 2",
    ulid: "\\u06CC\\u0648 \\u0627\\u06CC\\u0644 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    xid: "\\u0627\\u06CC\\u06A9\\u0633 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    ksuid: "\\u06A9\\u06D2 \\u0627\\u06CC\\u0633 \\u06CC\\u0648 \\u0622\\u0626\\u06CC \\u0688\\u06CC",
    datetime: "\\u0622\\u0626\\u06CC \\u0627\\u06CC\\u0633 \\u0627\\u0648 \\u0688\\u06CC\\u0679 \\u0679\\u0627\\u0626\\u0645",
    date: "\\u0622\\u0626\\u06CC \\u0627\\u06CC\\u0633 \\u0627\\u0648 \\u062A\\u0627\\u0631\\u06CC\\u062E",
    time: "\\u0622\\u0626\\u06CC \\u0627\\u06CC\\u0633 \\u0627\\u0648 \\u0648\\u0642\\u062A",
    duration: "\\u0622\\u0626\\u06CC \\u0627\\u06CC\\u0633 \\u0627\\u0648 \\u0645\\u062F\\u062A",
    ipv4: "\\u0622\\u0626\\u06CC \\u067E\\u06CC \\u0648\\u06CC 4 \\u0627\\u06CC\\u0688\\u0631\\u06CC\\u0633",
    ipv6: "\\u0622\\u0626\\u06CC \\u067E\\u06CC \\u0648\\u06CC 6 \\u0627\\u06CC\\u0688\\u0631\\u06CC\\u0633",
    cidrv4: "\\u0622\\u0626\\u06CC \\u067E\\u06CC \\u0648\\u06CC 4 \\u0631\\u06CC\\u0646\\u062C",
    cidrv6: "\\u0622\\u0626\\u06CC \\u067E\\u06CC \\u0648\\u06CC 6 \\u0631\\u06CC\\u0646\\u062C",
    base64: "\\u0628\\u06CC\\u0633 64 \\u0627\\u0646 \\u06A9\\u0648\\u0688\\u0688 \\u0633\\u0679\\u0631\\u0646\\u06AF",
    base64url: "\\u0628\\u06CC\\u0633 64 \\u06CC\\u0648 \\u0622\\u0631 \\u0627\\u06CC\\u0644 \\u0627\\u0646 \\u06A9\\u0648\\u0688\\u0688 \\u0633\\u0679\\u0631\\u0646\\u06AF",
    json_string: "\\u062C\\u06D2 \\u0627\\u06CC\\u0633 \\u0627\\u0648 \\u0627\\u06CC\\u0646 \\u0633\\u0679\\u0631\\u0646\\u06AF",
    e164: "\\u0627\\u06CC 164 \\u0646\\u0645\\u0628\\u0631",
    jwt: "\\u062C\\u06D2 \\u0688\\u0628\\u0644\\u06CC\\u0648 \\u0679\\u06CC",
    template_literal: "\\u0627\\u0646 \\u067E\\u0679"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u063A\\u0644\\u0637 \\u0627\\u0646 \\u067E\\u0679: \${issue2.expected} \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u0627\\u060C \${parsedType7(issue2.input)} \\u0645\\u0648\\u0635\\u0648\\u0644 \\u06C1\\u0648\\u0627\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u063A\\u0644\\u0637 \\u0627\\u0646 \\u067E\\u0679: \${stringifyPrimitive(issue2.values[0])} \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u0627\`;
        return \`\\u063A\\u0644\\u0637 \\u0622\\u067E\\u0634\\u0646: \${joinValues(issue2.values, "|")} \\u0645\\u06CC\\u06BA \\u0633\\u06D2 \\u0627\\u06CC\\u06A9 \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u0627\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u0628\\u06C1\\u062A \\u0628\\u0691\\u0627: \${issue2.origin ?? "\\u0648\\u06CC\\u0644\\u06CC\\u0648"} \\u06A9\\u06D2 \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u0639\\u0646\\u0627\\u0635\\u0631"} \\u06C1\\u0648\\u0646\\u06D2 \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u06D2\`;
        return \`\\u0628\\u06C1\\u062A \\u0628\\u0691\\u0627: \${issue2.origin ?? "\\u0648\\u06CC\\u0644\\u06CC\\u0648"} \\u06A9\\u0627 \${adj}\${issue2.maximum.toString()} \\u06C1\\u0648\\u0646\\u0627 \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u0627\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u0628\\u06C1\\u062A \\u0686\\u06BE\\u0648\\u0679\\u0627: \${issue2.origin} \\u06A9\\u06D2 \${adj}\${issue2.minimum.toString()} \${sizing.unit} \\u06C1\\u0648\\u0646\\u06D2 \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u06D2\`;
        }
        return \`\\u0628\\u06C1\\u062A \\u0686\\u06BE\\u0648\\u0679\\u0627: \${issue2.origin} \\u06A9\\u0627 \${adj}\${issue2.minimum.toString()} \\u06C1\\u0648\\u0646\\u0627 \\u0645\\u062A\\u0648\\u0642\\u0639 \\u062A\\u06BE\\u0627\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u063A\\u0644\\u0637 \\u0633\\u0679\\u0631\\u0646\\u06AF: "\${_issue.prefix}" \\u0633\\u06D2 \\u0634\\u0631\\u0648\\u0639 \\u06C1\\u0648\\u0646\\u0627 \\u0686\\u0627\\u06C1\\u06CC\\u06D2\`;
        }
        if (_issue.format === "ends_with") return \`\\u063A\\u0644\\u0637 \\u0633\\u0679\\u0631\\u0646\\u06AF: "\${_issue.suffix}" \\u067E\\u0631 \\u062E\\u062A\\u0645 \\u06C1\\u0648\\u0646\\u0627 \\u0686\\u0627\\u06C1\\u06CC\\u06D2\`;
        if (_issue.format === "includes") return \`\\u063A\\u0644\\u0637 \\u0633\\u0679\\u0631\\u0646\\u06AF: "\${_issue.includes}" \\u0634\\u0627\\u0645\\u0644 \\u06C1\\u0648\\u0646\\u0627 \\u0686\\u0627\\u06C1\\u06CC\\u06D2\`;
        if (_issue.format === "regex") return \`\\u063A\\u0644\\u0637 \\u0633\\u0679\\u0631\\u0646\\u06AF: \\u067E\\u06CC\\u0679\\u0631\\u0646 \${_issue.pattern} \\u0633\\u06D2 \\u0645\\u06CC\\u0686 \\u06C1\\u0648\\u0646\\u0627 \\u0686\\u0627\\u06C1\\u06CC\\u06D2\`;
        return \`\\u063A\\u0644\\u0637 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u063A\\u0644\\u0637 \\u0646\\u0645\\u0628\\u0631: \${issue2.divisor} \\u06A9\\u0627 \\u0645\\u0636\\u0627\\u0639\\u0641 \\u06C1\\u0648\\u0646\\u0627 \\u0686\\u0627\\u06C1\\u06CC\\u06D2\`;
      case "unrecognized_keys":
        return \`\\u063A\\u06CC\\u0631 \\u062A\\u0633\\u0644\\u06CC\\u0645 \\u0634\\u062F\\u06C1 \\u06A9\\u06CC\${issue2.keys.length > 1 ? "\\u0632" : ""}: \${joinValues(issue2.keys, "\\u060C ")}\`;
      case "invalid_key":
        return \`\${issue2.origin} \\u0645\\u06CC\\u06BA \\u063A\\u0644\\u0637 \\u06A9\\u06CC\`;
      case "invalid_union":
        return "\\u063A\\u0644\\u0637 \\u0627\\u0646 \\u067E\\u0679";
      case "invalid_element":
        return \`\${issue2.origin} \\u0645\\u06CC\\u06BA \\u063A\\u0644\\u0637 \\u0648\\u06CC\\u0644\\u06CC\\u0648\`;
      default:
        return \`\\u063A\\u0644\\u0637 \\u0627\\u0646 \\u067E\\u0679\`;
    }
  };
}, "error");
function ur_default() {
  return {
    localeError: error40()
  };
}
__name(ur_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/vi.js
var error41 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "k\\xFD t\\u1EF1",
      verb: "c\\xF3"
    },
    file: {
      unit: "byte",
      verb: "c\\xF3"
    },
    array: {
      unit: "ph\\u1EA7n t\\u1EED",
      verb: "c\\xF3"
    },
    set: {
      unit: "ph\\u1EA7n t\\u1EED",
      verb: "c\\xF3"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "s\\u1ED1";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "m\\u1EA3ng";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u0111\\u1EA7u v\\xE0o",
    email: "\\u0111\\u1ECBa ch\\u1EC9 email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ng\\xE0y gi\\u1EDD ISO",
    date: "ng\\xE0y ISO",
    time: "gi\\u1EDD ISO",
    duration: "kho\\u1EA3ng th\\u1EDDi gian ISO",
    ipv4: "\\u0111\\u1ECBa ch\\u1EC9 IPv4",
    ipv6: "\\u0111\\u1ECBa ch\\u1EC9 IPv6",
    cidrv4: "d\\u1EA3i IPv4",
    cidrv6: "d\\u1EA3i IPv6",
    base64: "chu\\u1ED7i m\\xE3 h\\xF3a base64",
    base64url: "chu\\u1ED7i m\\xE3 h\\xF3a base64url",
    json_string: "chu\\u1ED7i JSON",
    e164: "s\\u1ED1 E.164",
    jwt: "JWT",
    template_literal: "\\u0111\\u1EA7u v\\xE0o"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u0110\\u1EA7u v\\xE0o kh\\xF4ng h\\u1EE3p l\\u1EC7: mong \\u0111\\u1EE3i \${issue2.expected}, nh\\u1EADn \\u0111\\u01B0\\u1EE3c \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u0110\\u1EA7u v\\xE0o kh\\xF4ng h\\u1EE3p l\\u1EC7: mong \\u0111\\u1EE3i \${stringifyPrimitive(issue2.values[0])}\`;
        return \`T\\xF9y ch\\u1ECDn kh\\xF4ng h\\u1EE3p l\\u1EC7: mong \\u0111\\u1EE3i m\\u1ED9t trong c\\xE1c gi\\xE1 tr\\u1ECB \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`Qu\\xE1 l\\u1EDBn: mong \\u0111\\u1EE3i \${issue2.origin ?? "gi\\xE1 tr\\u1ECB"} \${sizing.verb} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "ph\\u1EA7n t\\u1EED"}\`;
        return \`Qu\\xE1 l\\u1EDBn: mong \\u0111\\u1EE3i \${issue2.origin ?? "gi\\xE1 tr\\u1ECB"} \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`Qu\\xE1 nh\\u1ECF: mong \\u0111\\u1EE3i \${issue2.origin} \${sizing.verb} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`Qu\\xE1 nh\\u1ECF: mong \\u0111\\u1EE3i \${issue2.origin} \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`Chu\\u1ED7i kh\\xF4ng h\\u1EE3p l\\u1EC7: ph\\u1EA3i b\\u1EAFt \\u0111\\u1EA7u b\\u1EB1ng "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`Chu\\u1ED7i kh\\xF4ng h\\u1EE3p l\\u1EC7: ph\\u1EA3i k\\u1EBFt th\\xFAc b\\u1EB1ng "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`Chu\\u1ED7i kh\\xF4ng h\\u1EE3p l\\u1EC7: ph\\u1EA3i bao g\\u1ED3m "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`Chu\\u1ED7i kh\\xF4ng h\\u1EE3p l\\u1EC7: ph\\u1EA3i kh\\u1EDBp v\\u1EDBi m\\u1EABu \${_issue.pattern}\`;
        return \`\${Nouns[_issue.format] ?? issue2.format} kh\\xF4ng h\\u1EE3p l\\u1EC7\`;
      }
      case "not_multiple_of":
        return \`S\\u1ED1 kh\\xF4ng h\\u1EE3p l\\u1EC7: ph\\u1EA3i l\\xE0 b\\u1ED9i s\\u1ED1 c\\u1EE7a \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`Kh\\xF3a kh\\xF4ng \\u0111\\u01B0\\u1EE3c nh\\u1EADn d\\u1EA1ng: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`Kh\\xF3a kh\\xF4ng h\\u1EE3p l\\u1EC7 trong \${issue2.origin}\`;
      case "invalid_union":
        return "\\u0110\\u1EA7u v\\xE0o kh\\xF4ng h\\u1EE3p l\\u1EC7";
      case "invalid_element":
        return \`Gi\\xE1 tr\\u1ECB kh\\xF4ng h\\u1EE3p l\\u1EC7 trong \${issue2.origin}\`;
      default:
        return \`\\u0110\\u1EA7u v\\xE0o kh\\xF4ng h\\u1EE3p l\\u1EC7\`;
    }
  };
}, "error");
function vi_default() {
  return {
    localeError: error41()
  };
}
__name(vi_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/zh-CN.js
var error42 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u5B57\\u7B26",
      verb: "\\u5305\\u542B"
    },
    file: {
      unit: "\\u5B57\\u8282",
      verb: "\\u5305\\u542B"
    },
    array: {
      unit: "\\u9879",
      verb: "\\u5305\\u542B"
    },
    set: {
      unit: "\\u9879",
      verb: "\\u5305\\u542B"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\\u975E\\u6570\\u5B57(NaN)" : "\\u6570\\u5B57";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\\u6570\\u7EC4";
        }
        if (data === null) {
          return "\\u7A7A\\u503C(null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u8F93\\u5165",
    email: "\\u7535\\u5B50\\u90AE\\u4EF6",
    url: "URL",
    emoji: "\\u8868\\u60C5\\u7B26\\u53F7",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO\\u65E5\\u671F\\u65F6\\u95F4",
    date: "ISO\\u65E5\\u671F",
    time: "ISO\\u65F6\\u95F4",
    duration: "ISO\\u65F6\\u957F",
    ipv4: "IPv4\\u5730\\u5740",
    ipv6: "IPv6\\u5730\\u5740",
    cidrv4: "IPv4\\u7F51\\u6BB5",
    cidrv6: "IPv6\\u7F51\\u6BB5",
    base64: "base64\\u7F16\\u7801\\u5B57\\u7B26\\u4E32",
    base64url: "base64url\\u7F16\\u7801\\u5B57\\u7B26\\u4E32",
    json_string: "JSON\\u5B57\\u7B26\\u4E32",
    e164: "E.164\\u53F7\\u7801",
    jwt: "JWT",
    template_literal: "\\u8F93\\u5165"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u65E0\\u6548\\u8F93\\u5165\\uFF1A\\u671F\\u671B \${issue2.expected}\\uFF0C\\u5B9E\\u9645\\u63A5\\u6536 \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u65E0\\u6548\\u8F93\\u5165\\uFF1A\\u671F\\u671B \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u65E0\\u6548\\u9009\\u9879\\uFF1A\\u671F\\u671B\\u4EE5\\u4E0B\\u4E4B\\u4E00 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u6570\\u503C\\u8FC7\\u5927\\uFF1A\\u671F\\u671B \${issue2.origin ?? "\\u503C"} \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u4E2A\\u5143\\u7D20"}\`;
        return \`\\u6570\\u503C\\u8FC7\\u5927\\uFF1A\\u671F\\u671B \${issue2.origin ?? "\\u503C"} \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u6570\\u503C\\u8FC7\\u5C0F\\uFF1A\\u671F\\u671B \${issue2.origin} \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u6570\\u503C\\u8FC7\\u5C0F\\uFF1A\\u671F\\u671B \${issue2.origin} \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u65E0\\u6548\\u5B57\\u7B26\\u4E32\\uFF1A\\u5FC5\\u987B\\u4EE5 "\${_issue.prefix}" \\u5F00\\u5934\`;
        if (_issue.format === "ends_with") return \`\\u65E0\\u6548\\u5B57\\u7B26\\u4E32\\uFF1A\\u5FC5\\u987B\\u4EE5 "\${_issue.suffix}" \\u7ED3\\u5C3E\`;
        if (_issue.format === "includes") return \`\\u65E0\\u6548\\u5B57\\u7B26\\u4E32\\uFF1A\\u5FC5\\u987B\\u5305\\u542B "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u65E0\\u6548\\u5B57\\u7B26\\u4E32\\uFF1A\\u5FC5\\u987B\\u6EE1\\u8DB3\\u6B63\\u5219\\u8868\\u8FBE\\u5F0F \${_issue.pattern}\`;
        return \`\\u65E0\\u6548\${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u65E0\\u6548\\u6570\\u5B57\\uFF1A\\u5FC5\\u987B\\u662F \${issue2.divisor} \\u7684\\u500D\\u6570\`;
      case "unrecognized_keys":
        return \`\\u51FA\\u73B0\\u672A\\u77E5\\u7684\\u952E(key): \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`\${issue2.origin} \\u4E2D\\u7684\\u952E(key)\\u65E0\\u6548\`;
      case "invalid_union":
        return "\\u65E0\\u6548\\u8F93\\u5165";
      case "invalid_element":
        return \`\${issue2.origin} \\u4E2D\\u5305\\u542B\\u65E0\\u6548\\u503C(value)\`;
      default:
        return \`\\u65E0\\u6548\\u8F93\\u5165\`;
    }
  };
}, "error");
function zh_CN_default() {
  return {
    localeError: error42()
  };
}
__name(zh_CN_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/zh-TW.js
var error43 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\u5B57\\u5143",
      verb: "\\u64C1\\u6709"
    },
    file: {
      unit: "\\u4F4D\\u5143\\u7D44",
      verb: "\\u64C1\\u6709"
    },
    array: {
      unit: "\\u9805\\u76EE",
      verb: "\\u64C1\\u6709"
    },
    set: {
      unit: "\\u9805\\u76EE",
      verb: "\\u64C1\\u6709"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u8F38\\u5165",
    email: "\\u90F5\\u4EF6\\u5730\\u5740",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \\u65E5\\u671F\\u6642\\u9593",
    date: "ISO \\u65E5\\u671F",
    time: "ISO \\u6642\\u9593",
    duration: "ISO \\u671F\\u9593",
    ipv4: "IPv4 \\u4F4D\\u5740",
    ipv6: "IPv6 \\u4F4D\\u5740",
    cidrv4: "IPv4 \\u7BC4\\u570D",
    cidrv6: "IPv6 \\u7BC4\\u570D",
    base64: "base64 \\u7DE8\\u78BC\\u5B57\\u4E32",
    base64url: "base64url \\u7DE8\\u78BC\\u5B57\\u4E32",
    json_string: "JSON \\u5B57\\u4E32",
    e164: "E.164 \\u6578\\u503C",
    jwt: "JWT",
    template_literal: "\\u8F38\\u5165"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\u7121\\u6548\\u7684\\u8F38\\u5165\\u503C\\uFF1A\\u9810\\u671F\\u70BA \${issue2.expected}\\uFF0C\\u4F46\\u6536\\u5230 \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\u7121\\u6548\\u7684\\u8F38\\u5165\\u503C\\uFF1A\\u9810\\u671F\\u70BA \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\u7121\\u6548\\u7684\\u9078\\u9805\\uFF1A\\u9810\\u671F\\u70BA\\u4EE5\\u4E0B\\u5176\\u4E2D\\u4E4B\\u4E00 \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`\\u6578\\u503C\\u904E\\u5927\\uFF1A\\u9810\\u671F \${issue2.origin ?? "\\u503C"} \\u61C9\\u70BA \${adj}\${issue2.maximum.toString()} \${sizing.unit ?? "\\u500B\\u5143\\u7D20"}\`;
        return \`\\u6578\\u503C\\u904E\\u5927\\uFF1A\\u9810\\u671F \${issue2.origin ?? "\\u503C"} \\u61C9\\u70BA \${adj}\${issue2.maximum.toString()}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return \`\\u6578\\u503C\\u904E\\u5C0F\\uFF1A\\u9810\\u671F \${issue2.origin} \\u61C9\\u70BA \${adj}\${issue2.minimum.toString()} \${sizing.unit}\`;
        }
        return \`\\u6578\\u503C\\u904E\\u5C0F\\uFF1A\\u9810\\u671F \${issue2.origin} \\u61C9\\u70BA \${adj}\${issue2.minimum.toString()}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return \`\\u7121\\u6548\\u7684\\u5B57\\u4E32\\uFF1A\\u5FC5\\u9808\\u4EE5 "\${_issue.prefix}" \\u958B\\u982D\`;
        }
        if (_issue.format === "ends_with") return \`\\u7121\\u6548\\u7684\\u5B57\\u4E32\\uFF1A\\u5FC5\\u9808\\u4EE5 "\${_issue.suffix}" \\u7D50\\u5C3E\`;
        if (_issue.format === "includes") return \`\\u7121\\u6548\\u7684\\u5B57\\u4E32\\uFF1A\\u5FC5\\u9808\\u5305\\u542B "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u7121\\u6548\\u7684\\u5B57\\u4E32\\uFF1A\\u5FC5\\u9808\\u7B26\\u5408\\u683C\\u5F0F \${_issue.pattern}\`;
        return \`\\u7121\\u6548\\u7684 \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`\\u7121\\u6548\\u7684\\u6578\\u5B57\\uFF1A\\u5FC5\\u9808\\u70BA \${issue2.divisor} \\u7684\\u500D\\u6578\`;
      case "unrecognized_keys":
        return \`\\u7121\\u6CD5\\u8B58\\u5225\\u7684\\u9375\\u503C\${issue2.keys.length > 1 ? "\\u5011" : ""}\\uFF1A\${joinValues(issue2.keys, "\\u3001")}\`;
      case "invalid_key":
        return \`\${issue2.origin} \\u4E2D\\u6709\\u7121\\u6548\\u7684\\u9375\\u503C\`;
      case "invalid_union":
        return "\\u7121\\u6548\\u7684\\u8F38\\u5165\\u503C";
      case "invalid_element":
        return \`\${issue2.origin} \\u4E2D\\u6709\\u7121\\u6548\\u7684\\u503C\`;
      default:
        return \`\\u7121\\u6548\\u7684\\u8F38\\u5165\\u503C\`;
    }
  };
}, "error");
function zh_TW_default() {
  return {
    localeError: error43()
  };
}
__name(zh_TW_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/locales/yo.js
var error44 = /* @__PURE__ */ __name(() => {
  const Sizable = {
    string: {
      unit: "\\xE0mi",
      verb: "n\\xED"
    },
    file: {
      unit: "bytes",
      verb: "n\\xED"
    },
    array: {
      unit: "nkan",
      verb: "n\\xED"
    },
    set: {
      unit: "nkan",
      verb: "n\\xED"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  __name(getSizing, "getSizing");
  const parsedType7 = /* @__PURE__ */ __name((data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "n\\u1ECD\\u0301mb\\xE0";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "akop\\u1ECD";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  }, "parsedType");
  const Nouns = {
    regex: "\\u1EB9\\u0300r\\u1ECD \\xECb\\xE1w\\u1ECDl\\xE9",
    email: "\\xE0d\\xEDr\\u1EB9\\u0301s\\xEC \\xECm\\u1EB9\\u0301l\\xEC",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\\xE0k\\xF3k\\xF2 ISO",
    date: "\\u1ECDj\\u1ECD\\u0301 ISO",
    time: "\\xE0k\\xF3k\\xF2 ISO",
    duration: "\\xE0k\\xF3k\\xF2 t\\xF3 p\\xE9 ISO",
    ipv4: "\\xE0d\\xEDr\\u1EB9\\u0301s\\xEC IPv4",
    ipv6: "\\xE0d\\xEDr\\u1EB9\\u0301s\\xEC IPv6",
    cidrv4: "\\xE0gb\\xE8gb\\xE8 IPv4",
    cidrv6: "\\xE0gb\\xE8gb\\xE8 IPv6",
    base64: "\\u1ECD\\u0300r\\u1ECD\\u0300 t\\xED a k\\u1ECD\\u0301 n\\xED base64",
    base64url: "\\u1ECD\\u0300r\\u1ECD\\u0300 base64url",
    json_string: "\\u1ECD\\u0300r\\u1ECD\\u0300 JSON",
    e164: "n\\u1ECD\\u0301mb\\xE0 E.164",
    jwt: "JWT",
    template_literal: "\\u1EB9\\u0300r\\u1ECD \\xECb\\xE1w\\u1ECDl\\xE9"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return \`\\xCCb\\xE1w\\u1ECDl\\xE9 a\\u1E63\\xEC\\u1E63e: a n\\xED l\\xE1ti fi \${issue2.expected}, \\xE0m\\u1ECD\\u0300 a r\\xED \${parsedType7(issue2.input)}\`;
      case "invalid_value":
        if (issue2.values.length === 1) return \`\\xCCb\\xE1w\\u1ECDl\\xE9 a\\u1E63\\xEC\\u1E63e: a n\\xED l\\xE1ti fi \${stringifyPrimitive(issue2.values[0])}\`;
        return \`\\xC0\\u1E63\\xE0y\\xE0n a\\u1E63\\xEC\\u1E63e: yan \\u1ECD\\u0300kan l\\xE1ra \${joinValues(issue2.values, "|")}\`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`T\\xF3 p\\u1ECD\\u0300 j\\xF9: a n\\xED l\\xE1ti j\\u1EB9\\u0301 p\\xE9 \${issue2.origin ?? "iye"} \${sizing.verb} \${adj}\${issue2.maximum} \${sizing.unit}\`;
        return \`T\\xF3 p\\u1ECD\\u0300 j\\xF9: a n\\xED l\\xE1ti j\\u1EB9\\u0301 \${adj}\${issue2.maximum}\`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) return \`K\\xE9r\\xE9 ju: a n\\xED l\\xE1ti j\\u1EB9\\u0301 p\\xE9 \${issue2.origin} \${sizing.verb} \${adj}\${issue2.minimum} \${sizing.unit}\`;
        return \`K\\xE9r\\xE9 ju: a n\\xED l\\xE1ti j\\u1EB9\\u0301 \${adj}\${issue2.minimum}\`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") return \`\\u1ECC\\u0300r\\u1ECD\\u0300 a\\u1E63\\xEC\\u1E63e: gb\\u1ECD\\u0301d\\u1ECD\\u0300 b\\u1EB9\\u0300r\\u1EB9\\u0300 p\\u1EB9\\u0300l\\xFA "\${_issue.prefix}"\`;
        if (_issue.format === "ends_with") return \`\\u1ECC\\u0300r\\u1ECD\\u0300 a\\u1E63\\xEC\\u1E63e: gb\\u1ECD\\u0301d\\u1ECD\\u0300 par\\xED p\\u1EB9\\u0300l\\xFA "\${_issue.suffix}"\`;
        if (_issue.format === "includes") return \`\\u1ECC\\u0300r\\u1ECD\\u0300 a\\u1E63\\xEC\\u1E63e: gb\\u1ECD\\u0301d\\u1ECD\\u0300 n\\xED "\${_issue.includes}"\`;
        if (_issue.format === "regex") return \`\\u1ECC\\u0300r\\u1ECD\\u0300 a\\u1E63\\xEC\\u1E63e: gb\\u1ECD\\u0301d\\u1ECD\\u0300 b\\xE1 \\xE0p\\u1EB9\\u1EB9r\\u1EB9 mu \${_issue.pattern}\`;
        return \`A\\u1E63\\xEC\\u1E63e: \${Nouns[_issue.format] ?? issue2.format}\`;
      }
      case "not_multiple_of":
        return \`N\\u1ECD\\u0301mb\\xE0 a\\u1E63\\xEC\\u1E63e: gb\\u1ECD\\u0301d\\u1ECD\\u0300 j\\u1EB9\\u0301 \\xE8y\\xE0 p\\xEDp\\xEDn ti \${issue2.divisor}\`;
      case "unrecognized_keys":
        return \`B\\u1ECDt\\xECn\\xEC \\xE0\\xECm\\u1ECD\\u0300: \${joinValues(issue2.keys, ", ")}\`;
      case "invalid_key":
        return \`B\\u1ECDt\\xECn\\xEC a\\u1E63\\xEC\\u1E63e n\\xEDn\\xFA \${issue2.origin}\`;
      case "invalid_union":
        return "\\xCCb\\xE1w\\u1ECDl\\xE9 a\\u1E63\\xEC\\u1E63e";
      case "invalid_element":
        return \`Iye a\\u1E63\\xEC\\u1E63e n\\xEDn\\xFA \${issue2.origin}\`;
      default:
        return "\\xCCb\\xE1w\\u1ECDl\\xE9 a\\u1E63\\xEC\\u1E63e";
    }
  };
}, "error");
function yo_default() {
  return {
    localeError: error44()
  };
}
__name(yo_default, "default");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/registries.js
var \$output = Symbol("ZodOutput");
var \$input = Symbol("ZodInput");
var \$ZodRegistry = class {
  static {
    __name(this, "\$ZodRegistry");
  }
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      if (this._idmap.has(meta.id)) {
        throw new Error(\`ID \${meta.id} already exists in the registry\`);
      }
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = {
        ...this.get(p) ?? {}
      };
      delete pm.id;
      const f = {
        ...pm,
        ...this._map.get(schema)
      };
      return Object.keys(f).length ? f : void 0;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
};
function registry() {
  return new \$ZodRegistry();
}
__name(registry, "registry");
var globalRegistry = /* @__PURE__ */ registry();

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/api.js
function _string(Class2, params) {
  return new Class2({
    type: "string",
    ...normalizeParams(params)
  });
}
__name(_string, "_string");
function _coercedString(Class2, params) {
  return new Class2({
    type: "string",
    coerce: true,
    ...normalizeParams(params)
  });
}
__name(_coercedString, "_coercedString");
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_email, "_email");
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_guid, "_guid");
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_uuid, "_uuid");
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
__name(_uuidv4, "_uuidv4");
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
__name(_uuidv6, "_uuidv6");
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
__name(_uuidv7, "_uuidv7");
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_url, "_url");
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_emoji2, "_emoji");
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_nanoid, "_nanoid");
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_cuid, "_cuid");
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_cuid2, "_cuid2");
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_ulid, "_ulid");
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_xid, "_xid");
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_ksuid, "_ksuid");
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_ipv4, "_ipv4");
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_ipv6, "_ipv6");
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_cidrv4, "_cidrv4");
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_cidrv6, "_cidrv6");
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_base64, "_base64");
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_base64url, "_base64url");
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_e164, "_e164");
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
__name(_jwt, "_jwt");
var TimePrecision = {
  Any: null,
  Minute: -1,
  Second: 0,
  Millisecond: 3,
  Microsecond: 6
};
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
__name(_isoDateTime, "_isoDateTime");
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
__name(_isoDate, "_isoDate");
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
__name(_isoTime, "_isoTime");
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
__name(_isoDuration, "_isoDuration");
function _number(Class2, params) {
  return new Class2({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
__name(_number, "_number");
function _coercedNumber(Class2, params) {
  return new Class2({
    type: "number",
    coerce: true,
    checks: [],
    ...normalizeParams(params)
  });
}
__name(_coercedNumber, "_coercedNumber");
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
__name(_int, "_int");
function _float32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float32",
    ...normalizeParams(params)
  });
}
__name(_float32, "_float32");
function _float64(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float64",
    ...normalizeParams(params)
  });
}
__name(_float64, "_float64");
function _int32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "int32",
    ...normalizeParams(params)
  });
}
__name(_int32, "_int32");
function _uint32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "uint32",
    ...normalizeParams(params)
  });
}
__name(_uint32, "_uint32");
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
__name(_boolean, "_boolean");
function _coercedBoolean(Class2, params) {
  return new Class2({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
__name(_coercedBoolean, "_coercedBoolean");
function _bigint(Class2, params) {
  return new Class2({
    type: "bigint",
    ...normalizeParams(params)
  });
}
__name(_bigint, "_bigint");
function _coercedBigint(Class2, params) {
  return new Class2({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
__name(_coercedBigint, "_coercedBigint");
function _int64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "int64",
    ...normalizeParams(params)
  });
}
__name(_int64, "_int64");
function _uint64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "uint64",
    ...normalizeParams(params)
  });
}
__name(_uint64, "_uint64");
function _symbol(Class2, params) {
  return new Class2({
    type: "symbol",
    ...normalizeParams(params)
  });
}
__name(_symbol, "_symbol");
function _undefined2(Class2, params) {
  return new Class2({
    type: "undefined",
    ...normalizeParams(params)
  });
}
__name(_undefined2, "_undefined");
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
__name(_null2, "_null");
function _any(Class2) {
  return new Class2({
    type: "any"
  });
}
__name(_any, "_any");
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
__name(_unknown, "_unknown");
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
__name(_never, "_never");
function _void(Class2, params) {
  return new Class2({
    type: "void",
    ...normalizeParams(params)
  });
}
__name(_void, "_void");
function _date(Class2, params) {
  return new Class2({
    type: "date",
    ...normalizeParams(params)
  });
}
__name(_date, "_date");
function _coercedDate(Class2, params) {
  return new Class2({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
__name(_coercedDate, "_coercedDate");
function _nan(Class2, params) {
  return new Class2({
    type: "nan",
    ...normalizeParams(params)
  });
}
__name(_nan, "_nan");
function _lt(value, params) {
  return new \$ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
__name(_lt, "_lt");
function _lte(value, params) {
  return new \$ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
__name(_lte, "_lte");
function _gt(value, params) {
  return new \$ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
__name(_gt, "_gt");
function _gte(value, params) {
  return new \$ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
__name(_gte, "_gte");
function _positive(params) {
  return _gt(0, params);
}
__name(_positive, "_positive");
function _negative(params) {
  return _lt(0, params);
}
__name(_negative, "_negative");
function _nonpositive(params) {
  return _lte(0, params);
}
__name(_nonpositive, "_nonpositive");
function _nonnegative(params) {
  return _gte(0, params);
}
__name(_nonnegative, "_nonnegative");
function _multipleOf(value, params) {
  return new \$ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
__name(_multipleOf, "_multipleOf");
function _maxSize(maximum, params) {
  return new \$ZodCheckMaxSize({
    check: "max_size",
    ...normalizeParams(params),
    maximum
  });
}
__name(_maxSize, "_maxSize");
function _minSize(minimum, params) {
  return new \$ZodCheckMinSize({
    check: "min_size",
    ...normalizeParams(params),
    minimum
  });
}
__name(_minSize, "_minSize");
function _size(size, params) {
  return new \$ZodCheckSizeEquals({
    check: "size_equals",
    ...normalizeParams(params),
    size
  });
}
__name(_size, "_size");
function _maxLength(maximum, params) {
  const ch = new \$ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
__name(_maxLength, "_maxLength");
function _minLength(minimum, params) {
  return new \$ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
__name(_minLength, "_minLength");
function _length(length, params) {
  return new \$ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
__name(_length, "_length");
function _regex(pattern, params) {
  return new \$ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
__name(_regex, "_regex");
function _lowercase(params) {
  return new \$ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
__name(_lowercase, "_lowercase");
function _uppercase(params) {
  return new \$ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
__name(_uppercase, "_uppercase");
function _includes(includes, params) {
  return new \$ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
__name(_includes, "_includes");
function _startsWith(prefix, params) {
  return new \$ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
__name(_startsWith, "_startsWith");
function _endsWith(suffix, params) {
  return new \$ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
__name(_endsWith, "_endsWith");
function _property(property, schema, params) {
  return new \$ZodCheckProperty({
    check: "property",
    property,
    schema,
    ...normalizeParams(params)
  });
}
__name(_property, "_property");
function _mime(types, params) {
  return new \$ZodCheckMimeType({
    check: "mime_type",
    mime: types,
    ...normalizeParams(params)
  });
}
__name(_mime, "_mime");
function _overwrite(tx) {
  return new \$ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
__name(_overwrite, "_overwrite");
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
__name(_normalize, "_normalize");
function _trim() {
  return _overwrite((input) => input.trim());
}
__name(_trim, "_trim");
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
__name(_toLowerCase, "_toLowerCase");
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
__name(_toUpperCase, "_toUpperCase");
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    // get element() {
    //   return element;
    // },
    ...normalizeParams(params)
  });
}
__name(_array, "_array");
function _union(Class2, options, params) {
  return new Class2({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
__name(_union, "_union");
function _discriminatedUnion(Class2, discriminator, options, params) {
  return new Class2({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
__name(_discriminatedUnion, "_discriminatedUnion");
function _intersection(Class2, left, right) {
  return new Class2({
    type: "intersection",
    left,
    right
  });
}
__name(_intersection, "_intersection");
function _tuple(Class2, items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof \$ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new Class2({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
__name(_tuple, "_tuple");
function _record(Class2, keyType, valueType, params) {
  return new Class2({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
__name(_record, "_record");
function _map(Class2, keyType, valueType, params) {
  return new Class2({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
__name(_map, "_map");
function _set(Class2, valueType, params) {
  return new Class2({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
__name(_set, "_set");
function _enum(Class2, values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [
    v,
    v
  ])) : values;
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
__name(_enum, "_enum");
function _nativeEnum(Class2, entries, params) {
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
__name(_nativeEnum, "_nativeEnum");
function _literal(Class2, value, params) {
  return new Class2({
    type: "literal",
    values: Array.isArray(value) ? value : [
      value
    ],
    ...normalizeParams(params)
  });
}
__name(_literal, "_literal");
function _file(Class2, params) {
  return new Class2({
    type: "file",
    ...normalizeParams(params)
  });
}
__name(_file, "_file");
function _transform(Class2, fn) {
  return new Class2({
    type: "transform",
    transform: fn
  });
}
__name(_transform, "_transform");
function _optional(Class2, innerType) {
  return new Class2({
    type: "optional",
    innerType
  });
}
__name(_optional, "_optional");
function _nullable(Class2, innerType) {
  return new Class2({
    type: "nullable",
    innerType
  });
}
__name(_nullable, "_nullable");
function _default(Class2, innerType, defaultValue) {
  return new Class2({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
__name(_default, "_default");
function _nonoptional(Class2, innerType, params) {
  return new Class2({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
__name(_nonoptional, "_nonoptional");
function _success(Class2, innerType) {
  return new Class2({
    type: "success",
    innerType
  });
}
__name(_success, "_success");
function _catch(Class2, innerType, catchValue) {
  return new Class2({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
__name(_catch, "_catch");
function _pipe(Class2, in_, out) {
  return new Class2({
    type: "pipe",
    in: in_,
    out
  });
}
__name(_pipe, "_pipe");
function _readonly(Class2, innerType) {
  return new Class2({
    type: "readonly",
    innerType
  });
}
__name(_readonly, "_readonly");
function _templateLiteral(Class2, parts, params) {
  return new Class2({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
__name(_templateLiteral, "_templateLiteral");
function _lazy(Class2, getter) {
  return new Class2({
    type: "lazy",
    getter
  });
}
__name(_lazy, "_lazy");
function _promise(Class2, innerType) {
  return new Class2({
    type: "promise",
    innerType
  });
}
__name(_promise, "_promise");
function _custom(Class2, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
__name(_custom, "_custom");
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
__name(_refine, "_refine");
function _superRefine(fn) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal) _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
__name(_superRefine, "_superRefine");
function _check(fn, params) {
  const ch = new \$ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
__name(_check, "_check");
function _stringbool(Classes, _params) {
  const params = normalizeParams(_params);
  let truthyArray = params.truthy ?? [
    "true",
    "1",
    "yes",
    "on",
    "y",
    "enabled"
  ];
  let falsyArray = params.falsy ?? [
    "false",
    "0",
    "no",
    "off",
    "n",
    "disabled"
  ];
  if (params.case !== "sensitive") {
    truthyArray = truthyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
    falsyArray = falsyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
  }
  const truthySet = new Set(truthyArray);
  const falsySet = new Set(falsyArray);
  const _Codec = Classes.Codec ?? \$ZodCodec;
  const _Boolean = Classes.Boolean ?? \$ZodBoolean;
  const _String = Classes.String ?? \$ZodString;
  const stringSchema = new _String({
    type: "string",
    error: params.error
  });
  const booleanSchema = new _Boolean({
    type: "boolean",
    error: params.error
  });
  const codec2 = new _Codec({
    type: "pipe",
    in: stringSchema,
    out: booleanSchema,
    transform: /* @__PURE__ */ __name((input, payload) => {
      let data = input;
      if (params.case !== "sensitive") data = data.toLowerCase();
      if (truthySet.has(data)) {
        return true;
      } else if (falsySet.has(data)) {
        return false;
      } else {
        payload.issues.push({
          code: "invalid_value",
          expected: "stringbool",
          values: [
            ...truthySet,
            ...falsySet
          ],
          input: payload.value,
          inst: codec2,
          continue: false
        });
        return {};
      }
    }, "transform"),
    reverseTransform: /* @__PURE__ */ __name((input, _payload) => {
      if (input === true) {
        return truthyArray[0] || "true";
      } else {
        return falsyArray[0] || "false";
      }
    }, "reverseTransform"),
    error: params.error
  });
  return codec2;
}
__name(_stringbool, "_stringbool");
function _stringFormat(Class2, format, fnOrRegex, _params = {}) {
  const params = normalizeParams(_params);
  const def = {
    ...normalizeParams(_params),
    check: "string_format",
    type: "string",
    format,
    fn: typeof fnOrRegex === "function" ? fnOrRegex : (val) => fnOrRegex.test(val),
    ...params
  };
  if (fnOrRegex instanceof RegExp) {
    def.pattern = fnOrRegex;
  }
  const inst = new Class2(def);
  return inst;
}
__name(_stringFormat, "_stringFormat");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/to-json-schema.js
var JSONSchemaGenerator = class {
  static {
    __name(this, "JSONSchemaGenerator");
  }
  constructor(params) {
    this.counter = 0;
    this.metadataRegistry = params?.metadata ?? globalRegistry;
    this.target = params?.target ?? "draft-2020-12";
    this.unrepresentable = params?.unrepresentable ?? "throw";
    this.override = params?.override ?? (() => {
    });
    this.io = params?.io ?? "output";
    this.seen = /* @__PURE__ */ new Map();
  }
  process(schema, _params = {
    path: [],
    schemaPath: []
  }) {
    var _a17;
    const def = schema._zod.def;
    const formatMap = {
      guid: "uuid",
      url: "uri",
      datetime: "date-time",
      json_string: "json-string",
      regex: ""
    };
    const seen = this.seen.get(schema);
    if (seen) {
      seen.count++;
      const isCycle = _params.schemaPath.includes(schema);
      if (isCycle) {
        seen.cycle = _params.path;
      }
      return seen.schema;
    }
    const result = {
      schema: {},
      count: 1,
      cycle: void 0,
      path: _params.path
    };
    this.seen.set(schema, result);
    const overrideSchema = schema._zod.toJSONSchema?.();
    if (overrideSchema) {
      result.schema = overrideSchema;
    } else {
      const params = {
        ..._params,
        schemaPath: [
          ..._params.schemaPath,
          schema
        ],
        path: _params.path
      };
      const parent = schema._zod.parent;
      if (parent) {
        result.ref = parent;
        this.process(parent, params);
        this.seen.get(parent).isParent = true;
      } else {
        const _json = result.schema;
        switch (def.type) {
          case "string": {
            const json2 = _json;
            json2.type = "string";
            const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
            if (typeof minimum === "number") json2.minLength = minimum;
            if (typeof maximum === "number") json2.maxLength = maximum;
            if (format) {
              json2.format = formatMap[format] ?? format;
              if (json2.format === "") delete json2.format;
            }
            if (contentEncoding) json2.contentEncoding = contentEncoding;
            if (patterns && patterns.size > 0) {
              const regexes = [
                ...patterns
              ];
              if (regexes.length === 1) json2.pattern = regexes[0].source;
              else if (regexes.length > 1) {
                result.schema.allOf = [
                  ...regexes.map((regex) => ({
                    ...this.target === "draft-7" || this.target === "draft-4" || this.target === "openapi-3.0" ? {
                      type: "string"
                    } : {},
                    pattern: regex.source
                  }))
                ];
              }
            }
            break;
          }
          case "number": {
            const json2 = _json;
            const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
            if (typeof format === "string" && format.includes("int")) json2.type = "integer";
            else json2.type = "number";
            if (typeof exclusiveMinimum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json2.minimum = exclusiveMinimum;
                json2.exclusiveMinimum = true;
              } else {
                json2.exclusiveMinimum = exclusiveMinimum;
              }
            }
            if (typeof minimum === "number") {
              json2.minimum = minimum;
              if (typeof exclusiveMinimum === "number" && this.target !== "draft-4") {
                if (exclusiveMinimum >= minimum) delete json2.minimum;
                else delete json2.exclusiveMinimum;
              }
            }
            if (typeof exclusiveMaximum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json2.maximum = exclusiveMaximum;
                json2.exclusiveMaximum = true;
              } else {
                json2.exclusiveMaximum = exclusiveMaximum;
              }
            }
            if (typeof maximum === "number") {
              json2.maximum = maximum;
              if (typeof exclusiveMaximum === "number" && this.target !== "draft-4") {
                if (exclusiveMaximum <= maximum) delete json2.maximum;
                else delete json2.exclusiveMaximum;
              }
            }
            if (typeof multipleOf === "number") json2.multipleOf = multipleOf;
            break;
          }
          case "boolean": {
            const json2 = _json;
            json2.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") {
              throw new Error("BigInt cannot be represented in JSON Schema");
            }
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") {
              throw new Error("Symbols cannot be represented in JSON Schema");
            }
            break;
          }
          case "null": {
            if (this.target === "openapi-3.0") {
              _json.type = "string";
              _json.nullable = true;
              _json.enum = [
                null
              ];
            } else _json.type = "null";
            break;
          }
          case "any": {
            break;
          }
          case "unknown": {
            break;
          }
          case "undefined": {
            if (this.unrepresentable === "throw") {
              throw new Error("Undefined cannot be represented in JSON Schema");
            }
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") {
              throw new Error("Void cannot be represented in JSON Schema");
            }
            break;
          }
          case "never": {
            _json.not = {};
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") {
              throw new Error("Date cannot be represented in JSON Schema");
            }
            break;
          }
          case "array": {
            const json2 = _json;
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number") json2.minItems = minimum;
            if (typeof maximum === "number") json2.maxItems = maximum;
            json2.type = "array";
            json2.items = this.process(def.element, {
              ...params,
              path: [
                ...params.path,
                "items"
              ]
            });
            break;
          }
          case "object": {
            const json2 = _json;
            json2.type = "object";
            json2.properties = {};
            const shape = def.shape;
            for (const key in shape) {
              json2.properties[key] = this.process(shape[key], {
                ...params,
                path: [
                  ...params.path,
                  "properties",
                  key
                ]
              });
            }
            const allKeys = new Set(Object.keys(shape));
            const requiredKeys = new Set([
              ...allKeys
            ].filter((key) => {
              const v = def.shape[key]._zod;
              if (this.io === "input") {
                return v.optin === void 0;
              } else {
                return v.optout === void 0;
              }
            }));
            if (requiredKeys.size > 0) {
              json2.required = Array.from(requiredKeys);
            }
            if (def.catchall?._zod.def.type === "never") {
              json2.additionalProperties = false;
            } else if (!def.catchall) {
              if (this.io === "output") json2.additionalProperties = false;
            } else if (def.catchall) {
              json2.additionalProperties = this.process(def.catchall, {
                ...params,
                path: [
                  ...params.path,
                  "additionalProperties"
                ]
              });
            }
            break;
          }
          case "union": {
            const json2 = _json;
            const options = def.options.map((x, i) => this.process(x, {
              ...params,
              path: [
                ...params.path,
                "anyOf",
                i
              ]
            }));
            json2.anyOf = options;
            break;
          }
          case "intersection": {
            const json2 = _json;
            const a = this.process(def.left, {
              ...params,
              path: [
                ...params.path,
                "allOf",
                0
              ]
            });
            const b = this.process(def.right, {
              ...params,
              path: [
                ...params.path,
                "allOf",
                1
              ]
            });
            const isSimpleIntersection = /* @__PURE__ */ __name((val) => "allOf" in val && Object.keys(val).length === 1, "isSimpleIntersection");
            const allOf = [
              ...isSimpleIntersection(a) ? a.allOf : [
                a
              ],
              ...isSimpleIntersection(b) ? b.allOf : [
                b
              ]
            ];
            json2.allOf = allOf;
            break;
          }
          case "tuple": {
            const json2 = _json;
            json2.type = "array";
            const prefixPath = this.target === "draft-2020-12" ? "prefixItems" : "items";
            const restPath = this.target === "draft-2020-12" ? "items" : this.target === "openapi-3.0" ? "items" : "additionalItems";
            const prefixItems = def.items.map((x, i) => this.process(x, {
              ...params,
              path: [
                ...params.path,
                prefixPath,
                i
              ]
            }));
            const rest = def.rest ? this.process(def.rest, {
              ...params,
              path: [
                ...params.path,
                restPath,
                ...this.target === "openapi-3.0" ? [
                  def.items.length
                ] : []
              ]
            }) : null;
            if (this.target === "draft-2020-12") {
              json2.prefixItems = prefixItems;
              if (rest) {
                json2.items = rest;
              }
            } else if (this.target === "openapi-3.0") {
              json2.items = {
                anyOf: prefixItems
              };
              if (rest) {
                json2.items.anyOf.push(rest);
              }
              json2.minItems = prefixItems.length;
              if (!rest) {
                json2.maxItems = prefixItems.length;
              }
            } else {
              json2.items = prefixItems;
              if (rest) {
                json2.additionalItems = rest;
              }
            }
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number") json2.minItems = minimum;
            if (typeof maximum === "number") json2.maxItems = maximum;
            break;
          }
          case "record": {
            const json2 = _json;
            json2.type = "object";
            if (this.target === "draft-7" || this.target === "draft-2020-12") {
              json2.propertyNames = this.process(def.keyType, {
                ...params,
                path: [
                  ...params.path,
                  "propertyNames"
                ]
              });
            }
            json2.additionalProperties = this.process(def.valueType, {
              ...params,
              path: [
                ...params.path,
                "additionalProperties"
              ]
            });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") {
              throw new Error("Map cannot be represented in JSON Schema");
            }
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") {
              throw new Error("Set cannot be represented in JSON Schema");
            }
            break;
          }
          case "enum": {
            const json2 = _json;
            const values = getEnumValues(def.entries);
            if (values.every((v) => typeof v === "number")) json2.type = "number";
            if (values.every((v) => typeof v === "string")) json2.type = "string";
            json2.enum = values;
            break;
          }
          case "literal": {
            const json2 = _json;
            const vals = [];
            for (const val of def.values) {
              if (val === void 0) {
                if (this.unrepresentable === "throw") {
                  throw new Error("Literal \`undefined\` cannot be represented in JSON Schema");
                } else {
                }
              } else if (typeof val === "bigint") {
                if (this.unrepresentable === "throw") {
                  throw new Error("BigInt literals cannot be represented in JSON Schema");
                } else {
                  vals.push(Number(val));
                }
              } else {
                vals.push(val);
              }
            }
            if (vals.length === 0) {
            } else if (vals.length === 1) {
              const val = vals[0];
              json2.type = val === null ? "null" : typeof val;
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json2.enum = [
                  val
                ];
              } else {
                json2.const = val;
              }
            } else {
              if (vals.every((v) => typeof v === "number")) json2.type = "number";
              if (vals.every((v) => typeof v === "string")) json2.type = "string";
              if (vals.every((v) => typeof v === "boolean")) json2.type = "string";
              if (vals.every((v) => v === null)) json2.type = "null";
              json2.enum = vals;
            }
            break;
          }
          case "file": {
            const json2 = _json;
            const file2 = {
              type: "string",
              format: "binary",
              contentEncoding: "binary"
            };
            const { minimum, maximum, mime } = schema._zod.bag;
            if (minimum !== void 0) file2.minLength = minimum;
            if (maximum !== void 0) file2.maxLength = maximum;
            if (mime) {
              if (mime.length === 1) {
                file2.contentMediaType = mime[0];
                Object.assign(json2, file2);
              } else {
                json2.anyOf = mime.map((m) => {
                  const mFile = {
                    ...file2,
                    contentMediaType: m
                  };
                  return mFile;
                });
              }
            } else {
              Object.assign(json2, file2);
            }
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") {
              throw new Error("Transforms cannot be represented in JSON Schema");
            }
            break;
          }
          case "nullable": {
            const inner = this.process(def.innerType, params);
            if (this.target === "openapi-3.0") {
              result.ref = def.innerType;
              _json.nullable = true;
            } else {
              _json.anyOf = [
                inner,
                {
                  type: "null"
                }
              ];
            }
            break;
          }
          case "nonoptional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "success": {
            const json2 = _json;
            json2.type = "boolean";
            break;
          }
          case "default": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.default = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "prefault": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            if (this.io === "input") _json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "catch": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            let catchValue;
            try {
              catchValue = def.catchValue(void 0);
            } catch {
              throw new Error("Dynamic catch values are not supported in JSON Schema");
            }
            _json.default = catchValue;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") {
              throw new Error("NaN cannot be represented in JSON Schema");
            }
            break;
          }
          case "template_literal": {
            const json2 = _json;
            const pattern = schema._zod.pattern;
            if (!pattern) throw new Error("Pattern not found in template literal");
            json2.type = "string";
            json2.pattern = pattern.source;
            break;
          }
          case "pipe": {
            const innerType = this.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "readonly": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.readOnly = true;
            break;
          }
          // passthrough types
          case "promise": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "optional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "lazy": {
            const innerType = schema._zod.innerType;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") {
              throw new Error("Custom types cannot be represented in JSON Schema");
            }
            break;
          }
          case "function": {
            if (this.unrepresentable === "throw") {
              throw new Error("Function types cannot be represented in JSON Schema");
            }
            break;
          }
          default: {
            def;
          }
        }
      }
    }
    const meta = this.metadataRegistry.get(schema);
    if (meta) Object.assign(result.schema, meta);
    if (this.io === "input" && isTransforming(schema)) {
      delete result.schema.examples;
      delete result.schema.default;
    }
    if (this.io === "input" && result.schema._prefault) (_a17 = result.schema).default ?? (_a17.default = result.schema._prefault);
    delete result.schema._prefault;
    const _result = this.seen.get(schema);
    return _result.schema;
  }
  emit(schema, _params) {
    const params = {
      cycles: _params?.cycles ?? "ref",
      reused: _params?.reused ?? "inline",
      // unrepresentable: _params?.unrepresentable ?? "throw",
      // uri: _params?.uri ?? ((id) => \`\${id}\`),
      external: _params?.external ?? void 0
    };
    const root = this.seen.get(schema);
    if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
    const makeURI = /* @__PURE__ */ __name((entry) => {
      const defsSegment = this.target === "draft-2020-12" ? "\$defs" : "definitions";
      if (params.external) {
        const externalId = params.external.registry.get(entry[0])?.id;
        const uriGenerator = params.external.uri ?? ((id2) => id2);
        if (externalId) {
          return {
            ref: uriGenerator(externalId)
          };
        }
        const id = entry[1].defId ?? entry[1].schema.id ?? \`schema\${this.counter++}\`;
        entry[1].defId = id;
        return {
          defId: id,
          ref: \`\${uriGenerator("__shared")}#/\${defsSegment}/\${id}\`
        };
      }
      if (entry[1] === root) {
        return {
          ref: "#"
        };
      }
      const uriPrefix = \`#\`;
      const defUriPrefix = \`\${uriPrefix}/\${defsSegment}/\`;
      const defId = entry[1].schema.id ?? \`__schema\${this.counter++}\`;
      return {
        defId,
        ref: defUriPrefix + defId
      };
    }, "makeURI");
    const extractToDef = /* @__PURE__ */ __name((entry) => {
      if (entry[1].schema.\$ref) {
        return;
      }
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);
      seen.def = {
        ...seen.schema
      };
      if (defId) seen.defId = defId;
      const schema2 = seen.schema;
      for (const key in schema2) {
        delete schema2[key];
      }
      schema2.\$ref = ref;
    }, "extractToDef");
    if (params.cycles === "throw") {
      for (const entry of this.seen.entries()) {
        const seen = entry[1];
        if (seen.cycle) {
          throw new Error(\`Cycle detected: #/\${seen.cycle?.join("/")}/<root>

Set the \\\`cycles\\\` parameter to \\\`"ref"\\\` to resolve cyclical schemas with defs.\`);
        }
      }
    }
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (schema === entry[0]) {
        extractToDef(entry);
        continue;
      }
      if (params.external) {
        const ext = params.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }
      const id = this.metadataRegistry.get(entry[0])?.id;
      if (id) {
        extractToDef(entry);
        continue;
      }
      if (seen.cycle) {
        extractToDef(entry);
        continue;
      }
      if (seen.count > 1) {
        if (params.reused === "ref") {
          extractToDef(entry);
          continue;
        }
      }
    }
    const flattenRef = /* @__PURE__ */ __name((zodSchema2, params2) => {
      const seen = this.seen.get(zodSchema2);
      const schema2 = seen.def ?? seen.schema;
      const _cached = {
        ...schema2
      };
      if (seen.ref === null) {
        return;
      }
      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref, params2);
        const refSchema = this.seen.get(ref).schema;
        if (refSchema.\$ref && (params2.target === "draft-7" || params2.target === "draft-4" || params2.target === "openapi-3.0")) {
          schema2.allOf = schema2.allOf ?? [];
          schema2.allOf.push(refSchema);
        } else {
          Object.assign(schema2, refSchema);
          Object.assign(schema2, _cached);
        }
      }
      if (!seen.isParent) this.override({
        zodSchema: zodSchema2,
        jsonSchema: schema2,
        path: seen.path ?? []
      });
    }, "flattenRef");
    for (const entry of [
      ...this.seen.entries()
    ].reverse()) {
      flattenRef(entry[0], {
        target: this.target
      });
    }
    const result = {};
    if (this.target === "draft-2020-12") {
      result.\$schema = "https://json-schema.org/draft/2020-12/schema";
    } else if (this.target === "draft-7") {
      result.\$schema = "http://json-schema.org/draft-07/schema#";
    } else if (this.target === "draft-4") {
      result.\$schema = "http://json-schema.org/draft-04/schema#";
    } else if (this.target === "openapi-3.0") {
    } else {
      console.warn(\`Invalid target: \${this.target}\`);
    }
    if (params.external?.uri) {
      const id = params.external.registry.get(schema)?.id;
      if (!id) throw new Error("Schema is missing an \`id\` property");
      result.\$id = params.external.uri(id);
    }
    Object.assign(result, root.def);
    const defs = params.external?.defs ?? {};
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        defs[seen.defId] = seen.def;
      }
    }
    if (params.external) {
    } else {
      if (Object.keys(defs).length > 0) {
        if (this.target === "draft-2020-12") {
          result.\$defs = defs;
        } else {
          result.definitions = defs;
        }
      }
    }
    try {
      return JSON.parse(JSON.stringify(result));
    } catch (_err) {
      throw new Error("Error converting schema to JSON.");
    }
  }
};
function toJSONSchema(input, _params) {
  if (input instanceof \$ZodRegistry) {
    const gen2 = new JSONSchemaGenerator(_params);
    const defs = {};
    for (const entry of input._idmap.entries()) {
      const [_, schema] = entry;
      gen2.process(schema);
    }
    const schemas = {};
    const external = {
      registry: input,
      uri: _params?.uri,
      defs
    };
    for (const entry of input._idmap.entries()) {
      const [key, schema] = entry;
      schemas[key] = gen2.emit(schema, {
        ..._params,
        external
      });
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = gen2.target === "draft-2020-12" ? "\$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return {
      schemas
    };
  }
  const gen = new JSONSchemaGenerator(_params);
  gen.process(input);
  return gen.emit(input, _params);
}
__name(toJSONSchema, "toJSONSchema");
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? {
    seen: /* @__PURE__ */ new Set()
  };
  if (ctx.seen.has(_schema)) return false;
  ctx.seen.add(_schema);
  const schema = _schema;
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array": {
      return isTransforming(def.element, ctx);
    }
    case "object": {
      for (const key in def.shape) {
        if (isTransforming(def.shape[key], ctx)) return true;
      }
      return false;
    }
    case "union": {
      for (const option of def.options) {
        if (isTransforming(option, ctx)) return true;
      }
      return false;
    }
    case "intersection": {
      return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
    }
    case "tuple": {
      for (const item of def.items) {
        if (isTransforming(item, ctx)) return true;
      }
      if (def.rest && isTransforming(def.rest, ctx)) return true;
      return false;
    }
    case "record": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "map": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "set": {
      return isTransforming(def.valueType, ctx);
    }
    // inner types
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return isTransforming(def.innerType, ctx);
    case "lazy":
      return isTransforming(def.getter(), ctx);
    case "default": {
      return isTransforming(def.innerType, ctx);
    }
    case "prefault": {
      return isTransforming(def.innerType, ctx);
    }
    case "custom": {
      return false;
    }
    case "transform": {
      return true;
    }
    case "pipe": {
      return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
    }
    case "success": {
      return false;
    }
    case "catch": {
      return false;
    }
    case "function": {
      return false;
    }
    default:
      def;
  }
  throw new Error(\`Unknown schema type: \${def.type}\`);
}
__name(isTransforming, "isTransforming");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/core/json-schema.js
var json_schema_exports = {};

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/iso.js
var iso_exports = {};
__export(iso_exports, {
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
var ZodISODateTime = /* @__PURE__ */ \$constructor("ZodISODateTime", (inst, def) => {
  \$ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
__name(datetime2, "datetime");
var ZodISODate = /* @__PURE__ */ \$constructor("ZodISODate", (inst, def) => {
  \$ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
__name(date2, "date");
var ZodISOTime = /* @__PURE__ */ \$constructor("ZodISOTime", (inst, def) => {
  \$ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
__name(time2, "time");
var ZodISODuration = /* @__PURE__ */ \$constructor("ZodISODuration", (inst, def) => {
  \$ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}
__name(duration2, "duration");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/errors.js
var initializer2 = /* @__PURE__ */ __name((inst, issues) => {
  \$ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: /* @__PURE__ */ __name((mapper) => formatError(inst, mapper), "value")
    },
    flatten: {
      value: /* @__PURE__ */ __name((mapper) => flattenError(inst, mapper), "value")
    },
    addIssue: {
      value: /* @__PURE__ */ __name((issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }, "value")
    },
    addIssues: {
      value: /* @__PURE__ */ __name((issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }, "value")
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
    }
  });
}, "initializer");
var ZodError = \$constructor("ZodError", initializer2);
var ZodRealError = \$constructor("ZodError", initializer2, {
  Parent: Error
});

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/schemas.js
var ZodType = /* @__PURE__ */ \$constructor("ZodType", (inst, def) => {
  \$ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", {
    value: def
  });
  inst.check = (...checks) => {
    return inst.clone(util_exports.mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? {
          _zod: {
            check: ch,
            def: {
              check: "custom"
            },
            onattach: []
          }
        } : ch)
      ]
    }));
  };
  inst.clone = (def2, params) => clone(inst, def2, params);
  inst.brand = () => inst;
  inst.register = (reg, meta) => {
    reg.add(inst, meta);
    return inst;
  };
  inst.parse = (data, params) => parse2(inst, data, params, {
    callee: inst.parse
  });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, {
    callee: inst.parseAsync
  });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  inst.refine = (check2, params) => inst.check(refine(check2, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(_overwrite(fn));
  inst.optional = () => optional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([
    inst,
    arg
  ]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def2) => _default2(inst, def2);
  inst.prefault = (def2) => prefault(inst, def2);
  inst.catch = (params) => _catch2(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, {
      description
    });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(void 0).success;
  inst.isNullable = () => inst.safeParse(null).success;
  return inst;
});
var _ZodString = /* @__PURE__ */ \$constructor("_ZodString", (inst, def) => {
  \$ZodString.init(inst, def);
  ZodType.init(inst, def);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(_regex(...args));
  inst.includes = (...args) => inst.check(_includes(...args));
  inst.startsWith = (...args) => inst.check(_startsWith(...args));
  inst.endsWith = (...args) => inst.check(_endsWith(...args));
  inst.min = (...args) => inst.check(_minLength(...args));
  inst.max = (...args) => inst.check(_maxLength(...args));
  inst.length = (...args) => inst.check(_length(...args));
  inst.nonempty = (...args) => inst.check(_minLength(1, ...args));
  inst.lowercase = (params) => inst.check(_lowercase(params));
  inst.uppercase = (params) => inst.check(_uppercase(params));
  inst.trim = () => inst.check(_trim());
  inst.normalize = (...args) => inst.check(_normalize(...args));
  inst.toLowerCase = () => inst.check(_toLowerCase());
  inst.toUpperCase = () => inst.check(_toUpperCase());
});
var ZodString = /* @__PURE__ */ \$constructor("ZodString", (inst, def) => {
  \$ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
__name(string2, "string");
var ZodStringFormat = /* @__PURE__ */ \$constructor("ZodStringFormat", (inst, def) => {
  \$ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ \$constructor("ZodEmail", (inst, def) => {
  \$ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
__name(email2, "email");
var ZodGUID = /* @__PURE__ */ \$constructor("ZodGUID", (inst, def) => {
  \$ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function guid2(params) {
  return _guid(ZodGUID, params);
}
__name(guid2, "guid");
var ZodUUID = /* @__PURE__ */ \$constructor("ZodUUID", (inst, def) => {
  \$ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function uuid2(params) {
  return _uuid(ZodUUID, params);
}
__name(uuid2, "uuid");
function uuidv4(params) {
  return _uuidv4(ZodUUID, params);
}
__name(uuidv4, "uuidv4");
function uuidv6(params) {
  return _uuidv6(ZodUUID, params);
}
__name(uuidv6, "uuidv6");
function uuidv7(params) {
  return _uuidv7(ZodUUID, params);
}
__name(uuidv7, "uuidv7");
var ZodURL = /* @__PURE__ */ \$constructor("ZodURL", (inst, def) => {
  \$ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
__name(url, "url");
function httpUrl(params) {
  return _url(ZodURL, {
    protocol: /^https?\$/,
    hostname: regexes_exports.domain,
    ...util_exports.normalizeParams(params)
  });
}
__name(httpUrl, "httpUrl");
var ZodEmoji = /* @__PURE__ */ \$constructor("ZodEmoji", (inst, def) => {
  \$ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function emoji2(params) {
  return _emoji2(ZodEmoji, params);
}
__name(emoji2, "emoji");
var ZodNanoID = /* @__PURE__ */ \$constructor("ZodNanoID", (inst, def) => {
  \$ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function nanoid2(params) {
  return _nanoid(ZodNanoID, params);
}
__name(nanoid2, "nanoid");
var ZodCUID = /* @__PURE__ */ \$constructor("ZodCUID", (inst, def) => {
  \$ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid3(params) {
  return _cuid(ZodCUID, params);
}
__name(cuid3, "cuid");
var ZodCUID2 = /* @__PURE__ */ \$constructor("ZodCUID2", (inst, def) => {
  \$ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid22(params) {
  return _cuid2(ZodCUID2, params);
}
__name(cuid22, "cuid2");
var ZodULID = /* @__PURE__ */ \$constructor("ZodULID", (inst, def) => {
  \$ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ulid2(params) {
  return _ulid(ZodULID, params);
}
__name(ulid2, "ulid");
var ZodXID = /* @__PURE__ */ \$constructor("ZodXID", (inst, def) => {
  \$ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function xid2(params) {
  return _xid(ZodXID, params);
}
__name(xid2, "xid");
var ZodKSUID = /* @__PURE__ */ \$constructor("ZodKSUID", (inst, def) => {
  \$ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ksuid2(params) {
  return _ksuid(ZodKSUID, params);
}
__name(ksuid2, "ksuid");
var ZodIPv4 = /* @__PURE__ */ \$constructor("ZodIPv4", (inst, def) => {
  \$ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv42(params) {
  return _ipv4(ZodIPv4, params);
}
__name(ipv42, "ipv4");
var ZodIPv6 = /* @__PURE__ */ \$constructor("ZodIPv6", (inst, def) => {
  \$ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv62(params) {
  return _ipv6(ZodIPv6, params);
}
__name(ipv62, "ipv6");
var ZodCIDRv4 = /* @__PURE__ */ \$constructor("ZodCIDRv4", (inst, def) => {
  \$ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv42(params) {
  return _cidrv4(ZodCIDRv4, params);
}
__name(cidrv42, "cidrv4");
var ZodCIDRv6 = /* @__PURE__ */ \$constructor("ZodCIDRv6", (inst, def) => {
  \$ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv62(params) {
  return _cidrv6(ZodCIDRv6, params);
}
__name(cidrv62, "cidrv6");
var ZodBase64 = /* @__PURE__ */ \$constructor("ZodBase64", (inst, def) => {
  \$ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base642(params) {
  return _base64(ZodBase64, params);
}
__name(base642, "base64");
var ZodBase64URL = /* @__PURE__ */ \$constructor("ZodBase64URL", (inst, def) => {
  \$ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base64url2(params) {
  return _base64url(ZodBase64URL, params);
}
__name(base64url2, "base64url");
var ZodE164 = /* @__PURE__ */ \$constructor("ZodE164", (inst, def) => {
  \$ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function e1642(params) {
  return _e164(ZodE164, params);
}
__name(e1642, "e164");
var ZodJWT = /* @__PURE__ */ \$constructor("ZodJWT", (inst, def) => {
  \$ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function jwt(params) {
  return _jwt(ZodJWT, params);
}
__name(jwt, "jwt");
var ZodCustomStringFormat = /* @__PURE__ */ \$constructor("ZodCustomStringFormat", (inst, def) => {
  \$ZodCustomStringFormat.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function stringFormat(format, fnOrRegex, _params = {}) {
  return _stringFormat(ZodCustomStringFormat, format, fnOrRegex, _params);
}
__name(stringFormat, "stringFormat");
function hostname2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hostname", regexes_exports.hostname, _params);
}
__name(hostname2, "hostname");
function hex2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hex", regexes_exports.hex, _params);
}
__name(hex2, "hex");
function hash(alg, params) {
  const enc = params?.enc ?? "hex";
  const format = \`\${alg}_\${enc}\`;
  const regex = regexes_exports[format];
  if (!regex) throw new Error(\`Unrecognized hash format: \${format}\`);
  return _stringFormat(ZodCustomStringFormat, format, regex, params);
}
__name(hash, "hash");
var ZodNumber = /* @__PURE__ */ \$constructor("ZodNumber", (inst, def) => {
  \$ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(_gt(0, params));
  inst.nonnegative = (params) => inst.check(_gte(0, params));
  inst.negative = (params) => inst.check(_lt(0, params));
  inst.nonpositive = (params) => inst.check(_lte(0, params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  inst.step = (value, params) => inst.check(_multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
__name(number2, "number");
var ZodNumberFormat = /* @__PURE__ */ \$constructor("ZodNumberFormat", (inst, def) => {
  \$ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
__name(int, "int");
function float32(params) {
  return _float32(ZodNumberFormat, params);
}
__name(float32, "float32");
function float64(params) {
  return _float64(ZodNumberFormat, params);
}
__name(float64, "float64");
function int32(params) {
  return _int32(ZodNumberFormat, params);
}
__name(int32, "int32");
function uint32(params) {
  return _uint32(ZodNumberFormat, params);
}
__name(uint32, "uint32");
var ZodBoolean = /* @__PURE__ */ \$constructor("ZodBoolean", (inst, def) => {
  \$ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
__name(boolean2, "boolean");
var ZodBigInt = /* @__PURE__ */ \$constructor("ZodBigInt", (inst, def) => {
  \$ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.positive = (params) => inst.check(_gt(BigInt(0), params));
  inst.negative = (params) => inst.check(_lt(BigInt(0), params));
  inst.nonpositive = (params) => inst.check(_lte(BigInt(0), params));
  inst.nonnegative = (params) => inst.check(_gte(BigInt(0), params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  const bag = inst._zod.bag;
  inst.minValue = bag.minimum ?? null;
  inst.maxValue = bag.maximum ?? null;
  inst.format = bag.format ?? null;
});
function bigint2(params) {
  return _bigint(ZodBigInt, params);
}
__name(bigint2, "bigint");
var ZodBigIntFormat = /* @__PURE__ */ \$constructor("ZodBigIntFormat", (inst, def) => {
  \$ZodBigIntFormat.init(inst, def);
  ZodBigInt.init(inst, def);
});
function int64(params) {
  return _int64(ZodBigIntFormat, params);
}
__name(int64, "int64");
function uint64(params) {
  return _uint64(ZodBigIntFormat, params);
}
__name(uint64, "uint64");
var ZodSymbol = /* @__PURE__ */ \$constructor("ZodSymbol", (inst, def) => {
  \$ZodSymbol.init(inst, def);
  ZodType.init(inst, def);
});
function symbol15(params) {
  return _symbol(ZodSymbol, params);
}
__name(symbol15, "symbol");
var ZodUndefined = /* @__PURE__ */ \$constructor("ZodUndefined", (inst, def) => {
  \$ZodUndefined.init(inst, def);
  ZodType.init(inst, def);
});
function _undefined3(params) {
  return _undefined2(ZodUndefined, params);
}
__name(_undefined3, "_undefined");
var ZodNull = /* @__PURE__ */ \$constructor("ZodNull", (inst, def) => {
  \$ZodNull.init(inst, def);
  ZodType.init(inst, def);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
__name(_null3, "_null");
var ZodAny = /* @__PURE__ */ \$constructor("ZodAny", (inst, def) => {
  \$ZodAny.init(inst, def);
  ZodType.init(inst, def);
});
function any() {
  return _any(ZodAny);
}
__name(any, "any");
var ZodUnknown = /* @__PURE__ */ \$constructor("ZodUnknown", (inst, def) => {
  \$ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
});
function unknown() {
  return _unknown(ZodUnknown);
}
__name(unknown, "unknown");
var ZodNever = /* @__PURE__ */ \$constructor("ZodNever", (inst, def) => {
  \$ZodNever.init(inst, def);
  ZodType.init(inst, def);
});
function never(params) {
  return _never(ZodNever, params);
}
__name(never, "never");
var ZodVoid = /* @__PURE__ */ \$constructor("ZodVoid", (inst, def) => {
  \$ZodVoid.init(inst, def);
  ZodType.init(inst, def);
});
function _void2(params) {
  return _void(ZodVoid, params);
}
__name(_void2, "_void");
var ZodDate = /* @__PURE__ */ \$constructor("ZodDate", (inst, def) => {
  \$ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  const c = inst._zod.bag;
  inst.minDate = c.minimum ? new Date(c.minimum) : null;
  inst.maxDate = c.maximum ? new Date(c.maximum) : null;
});
function date3(params) {
  return _date(ZodDate, params);
}
__name(date3, "date");
var ZodArray = /* @__PURE__ */ \$constructor("ZodArray", (inst, def) => {
  \$ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
  inst.nonempty = (params) => inst.check(_minLength(1, params));
  inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(_length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
__name(array, "array");
function keyof(schema) {
  const shape = schema._zod.def.shape;
  return _enum2(Object.keys(shape));
}
__name(keyof, "keyof");
var ZodObject = /* @__PURE__ */ \$constructor("ZodObject", (inst, def) => {
  \$ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  util_exports.defineLazy(inst, "shape", () => {
    return def.shape;
  });
  inst.keyof = () => _enum2(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({
    ...inst._zod.def,
    catchall
  });
  inst.passthrough = () => inst.clone({
    ...inst._zod.def,
    catchall: unknown()
  });
  inst.loose = () => inst.clone({
    ...inst._zod.def,
    catchall: unknown()
  });
  inst.strict = () => inst.clone({
    ...inst._zod.def,
    catchall: never()
  });
  inst.strip = () => inst.clone({
    ...inst._zod.def,
    catchall: void 0
  });
  inst.extend = (incoming) => {
    return util_exports.extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return util_exports.safeExtend(inst, incoming);
  };
  inst.merge = (other) => util_exports.merge(inst, other);
  inst.pick = (mask) => util_exports.pick(inst, mask);
  inst.omit = (mask) => util_exports.omit(inst, mask);
  inst.partial = (...args) => util_exports.partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => util_exports.required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...util_exports.normalizeParams(params)
  };
  return new ZodObject(def);
}
__name(object, "object");
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: never(),
    ...util_exports.normalizeParams(params)
  });
}
__name(strictObject, "strictObject");
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: unknown(),
    ...util_exports.normalizeParams(params)
  });
}
__name(looseObject, "looseObject");
var ZodUnion = /* @__PURE__ */ \$constructor("ZodUnion", (inst, def) => {
  \$ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...util_exports.normalizeParams(params)
  });
}
__name(union, "union");
var ZodDiscriminatedUnion = /* @__PURE__ */ \$constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  \$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...util_exports.normalizeParams(params)
  });
}
__name(discriminatedUnion, "discriminatedUnion");
var ZodIntersection = /* @__PURE__ */ \$constructor("ZodIntersection", (inst, def) => {
  \$ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
__name(intersection, "intersection");
var ZodTuple = /* @__PURE__ */ \$constructor("ZodTuple", (inst, def) => {
  \$ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst.rest = (rest) => inst.clone({
    ...inst._zod.def,
    rest
  });
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof \$ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...util_exports.normalizeParams(params)
  });
}
__name(tuple, "tuple");
var ZodRecord = /* @__PURE__ */ \$constructor("ZodRecord", (inst, def) => {
  \$ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
__name(record, "record");
function partialRecord(keyType, valueType, params) {
  const k = clone(keyType);
  k._zod.values = void 0;
  return new ZodRecord({
    type: "record",
    keyType: k,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
__name(partialRecord, "partialRecord");
var ZodMap = /* @__PURE__ */ \$constructor("ZodMap", (inst, def) => {
  \$ZodMap.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function map(keyType, valueType, params) {
  return new ZodMap({
    type: "map",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
__name(map, "map");
var ZodSet = /* @__PURE__ */ \$constructor("ZodSet", (inst, def) => {
  \$ZodSet.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function set(valueType, params) {
  return new ZodSet({
    type: "set",
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
__name(set, "set");
var ZodEnum = /* @__PURE__ */ \$constructor("ZodEnum", (inst, def) => {
  \$ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else throw new Error(\`Key \${value} not found in enum\`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = {
      ...def.entries
    };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else throw new Error(\`Key \${value} not found in enum\`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum2(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [
    v,
    v
  ])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
__name(_enum2, "_enum");
function nativeEnum(entries, params) {
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
__name(nativeEnum, "nativeEnum");
var ZodLiteral = /* @__PURE__ */ \$constructor("ZodLiteral", (inst, def) => {
  \$ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use \`.values\` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [
      value
    ],
    ...util_exports.normalizeParams(params)
  });
}
__name(literal, "literal");
var ZodFile = /* @__PURE__ */ \$constructor("ZodFile", (inst, def) => {
  \$ZodFile.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (size, params) => inst.check(_minSize(size, params));
  inst.max = (size, params) => inst.check(_maxSize(size, params));
  inst.mime = (types, params) => inst.check(_mime(Array.isArray(types) ? types : [
    types
  ], params));
});
function file(params) {
  return _file(ZodFile, params);
}
__name(file, "file");
var ZodTransform = /* @__PURE__ */ \$constructor("ZodTransform", (inst, def) => {
  \$ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new \$ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(util_exports.issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal) _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(util_exports.issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
__name(transform, "transform");
var ZodOptional = /* @__PURE__ */ \$constructor("ZodOptional", (inst, def) => {
  \$ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
__name(optional, "optional");
var ZodNullable = /* @__PURE__ */ \$constructor("ZodNullable", (inst, def) => {
  \$ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
__name(nullable, "nullable");
function nullish2(innerType) {
  return optional(nullable(innerType));
}
__name(nullish2, "nullish");
var ZodDefault = /* @__PURE__ */ \$constructor("ZodDefault", (inst, def) => {
  \$ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default2(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
__name(_default2, "_default");
var ZodPrefault = /* @__PURE__ */ \$constructor("ZodPrefault", (inst, def) => {
  \$ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
__name(prefault, "prefault");
var ZodNonOptional = /* @__PURE__ */ \$constructor("ZodNonOptional", (inst, def) => {
  \$ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...util_exports.normalizeParams(params)
  });
}
__name(nonoptional, "nonoptional");
var ZodSuccess = /* @__PURE__ */ \$constructor("ZodSuccess", (inst, def) => {
  \$ZodSuccess.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function success(innerType) {
  return new ZodSuccess({
    type: "success",
    innerType
  });
}
__name(success, "success");
var ZodCatch = /* @__PURE__ */ \$constructor("ZodCatch", (inst, def) => {
  \$ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch2(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
__name(_catch2, "_catch");
var ZodNaN = /* @__PURE__ */ \$constructor("ZodNaN", (inst, def) => {
  \$ZodNaN.init(inst, def);
  ZodType.init(inst, def);
});
function nan(params) {
  return _nan(ZodNaN, params);
}
__name(nan, "nan");
var ZodPipe = /* @__PURE__ */ \$constructor("ZodPipe", (inst, def) => {
  \$ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
__name(pipe, "pipe");
var ZodCodec = /* @__PURE__ */ \$constructor("ZodCodec", (inst, def) => {
  ZodPipe.init(inst, def);
  \$ZodCodec.init(inst, def);
});
function codec(in_, out, params) {
  return new ZodCodec({
    type: "pipe",
    in: in_,
    out,
    transform: params.decode,
    reverseTransform: params.encode
  });
}
__name(codec, "codec");
var ZodReadonly = /* @__PURE__ */ \$constructor("ZodReadonly", (inst, def) => {
  \$ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
__name(readonly, "readonly");
var ZodTemplateLiteral = /* @__PURE__ */ \$constructor("ZodTemplateLiteral", (inst, def) => {
  \$ZodTemplateLiteral.init(inst, def);
  ZodType.init(inst, def);
});
function templateLiteral(parts, params) {
  return new ZodTemplateLiteral({
    type: "template_literal",
    parts,
    ...util_exports.normalizeParams(params)
  });
}
__name(templateLiteral, "templateLiteral");
var ZodLazy = /* @__PURE__ */ \$constructor("ZodLazy", (inst, def) => {
  \$ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
__name(lazy, "lazy");
var ZodPromise = /* @__PURE__ */ \$constructor("ZodPromise", (inst, def) => {
  \$ZodPromise.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function promise(innerType) {
  return new ZodPromise({
    type: "promise",
    innerType
  });
}
__name(promise, "promise");
var ZodFunction = /* @__PURE__ */ \$constructor("ZodFunction", (inst, def) => {
  \$ZodFunction.init(inst, def);
  ZodType.init(inst, def);
});
function _function(params) {
  return new ZodFunction({
    type: "function",
    input: Array.isArray(params?.input) ? tuple(params?.input) : params?.input ?? array(unknown()),
    output: params?.output ?? unknown()
  });
}
__name(_function, "_function");
var ZodCustom = /* @__PURE__ */ \$constructor("ZodCustom", (inst, def) => {
  \$ZodCustom.init(inst, def);
  ZodType.init(inst, def);
});
function check(fn) {
  const ch = new \$ZodCheck({
    check: "custom"
  });
  ch._zod.check = fn;
  return ch;
}
__name(check, "check");
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
__name(custom, "custom");
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
__name(refine, "refine");
function superRefine(fn) {
  return _superRefine(fn);
}
__name(superRefine, "superRefine");
function _instanceof(cls, params = {
  error: \`Input not instance of \${cls.name}\`
}) {
  const inst = new ZodCustom({
    type: "custom",
    check: "custom",
    fn: /* @__PURE__ */ __name((data) => data instanceof cls, "fn"),
    abort: true,
    ...util_exports.normalizeParams(params)
  });
  inst._zod.bag.Class = cls;
  return inst;
}
__name(_instanceof, "_instanceof");
var stringbool = /* @__PURE__ */ __name((...args) => _stringbool({
  Codec: ZodCodec,
  Boolean: ZodBoolean,
  String: ZodString
}, ...args), "stringbool");
function json(params) {
  const jsonSchema2 = lazy(() => {
    return union([
      string2(params),
      number2(),
      boolean2(),
      _null3(),
      array(jsonSchema2),
      record(string2(), jsonSchema2)
    ]);
  });
  return jsonSchema2;
}
__name(json, "json");
function preprocess(fn, schema) {
  return pipe(transform(fn), schema);
}
__name(preprocess, "preprocess");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
function setErrorMap(map2) {
  config({
    customError: map2
  });
}
__name(setErrorMap, "setErrorMap");
function getErrorMap() {
  return config().customError;
}
__name(getErrorMap, "getErrorMap");
var ZodFirstPartyTypeKind;
/* @__PURE__ */ (function(ZodFirstPartyTypeKind3) {
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/coerce.js
var coerce_exports = {};
__export(coerce_exports, {
  bigint: () => bigint3,
  boolean: () => boolean3,
  date: () => date4,
  number: () => number3,
  string: () => string3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
__name(string3, "string");
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
__name(number3, "number");
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
__name(boolean3, "boolean");
function bigint3(params) {
  return _coercedBigint(ZodBigInt, params);
}
__name(bigint3, "bigint");
function date4(params) {
  return _coercedDate(ZodDate, params);
}
__name(date4, "date");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/external.js
config(en_default());

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/classic/index.js
var classic_default = external_exports;

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v4/index.js
var v4_default = classic_default;

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs2(_arg) {
  }
  __name(assertIs2, "assertIs");
  util2.assertIs = assertIs2;
  function assertNever2(_x) {
    throw new Error();
  }
  __name(assertNever2, "assertNever");
  util2.assertNever = assertNever2;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object3) => {
    const keys = [];
    for (const key in object3) {
      if (Object.prototype.hasOwnProperty.call(object3, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item)) return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues2(array2, separator = " | ") {
    return array2.map((val) => typeof val === "string" ? \`'\${val}'\` : val).join(separator);
  }
  __name(joinValues2, "joinValues");
  util2.joinValues = joinValues2;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType2 = /* @__PURE__ */ __name((data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
}, "getParsedType");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/ZodError.js
var ZodIssueCode2 = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var ZodError2 = class _ZodError extends Error {
  static {
    __name(this, "ZodError");
  }
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [
        ...this.issues,
        sub
      ];
    };
    this.addIssues = (subs = []) => {
      this.issues = [
        ...this.issues,
        ...subs
      ];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue2) {
      return issue2.message;
    };
    const fieldErrors = {
      _errors: []
    };
    const processError = /* @__PURE__ */ __name((error45) => {
      for (const issue2 of error45.issues) {
        if (issue2.code === "invalid_union") {
          issue2.unionErrors.map(processError);
        } else if (issue2.code === "invalid_return_type") {
          processError(issue2.returnTypeError);
        } else if (issue2.code === "invalid_arguments") {
          processError(issue2.argumentsError);
        } else if (issue2.path.length === 0) {
          fieldErrors._errors.push(mapper(issue2));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue2.path.length) {
            const el = issue2.path[i];
            const terminal = i === issue2.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || {
                _errors: []
              };
            } else {
              curr[el] = curr[el] || {
                _errors: []
              };
              curr[el]._errors.push(mapper(issue2));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    }, "processError");
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(\`Not a ZodError: \${value}\`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue2) => issue2.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return {
      formErrors,
      fieldErrors
    };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError2.create = (issues) => {
  const error45 = new ZodError2(issues);
  return error45;
};

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/locales/en.js
var errorMap = /* @__PURE__ */ __name((issue2, _ctx) => {
  let message;
  switch (issue2.code) {
    case ZodIssueCode2.invalid_type:
      if (issue2.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = \`Expected \${issue2.expected}, received \${issue2.received}\`;
      }
      break;
    case ZodIssueCode2.invalid_literal:
      message = \`Invalid literal value, expected \${JSON.stringify(issue2.expected, util.jsonStringifyReplacer)}\`;
      break;
    case ZodIssueCode2.unrecognized_keys:
      message = \`Unrecognized key(s) in object: \${util.joinValues(issue2.keys, ", ")}\`;
      break;
    case ZodIssueCode2.invalid_union:
      message = \`Invalid input\`;
      break;
    case ZodIssueCode2.invalid_union_discriminator:
      message = \`Invalid discriminator value. Expected \${util.joinValues(issue2.options)}\`;
      break;
    case ZodIssueCode2.invalid_enum_value:
      message = \`Invalid enum value. Expected \${util.joinValues(issue2.options)}, received '\${issue2.received}'\`;
      break;
    case ZodIssueCode2.invalid_arguments:
      message = \`Invalid function arguments\`;
      break;
    case ZodIssueCode2.invalid_return_type:
      message = \`Invalid function return type\`;
      break;
    case ZodIssueCode2.invalid_date:
      message = \`Invalid date\`;
      break;
    case ZodIssueCode2.invalid_string:
      if (typeof issue2.validation === "object") {
        if ("includes" in issue2.validation) {
          message = \`Invalid input: must include "\${issue2.validation.includes}"\`;
          if (typeof issue2.validation.position === "number") {
            message = \`\${message} at one or more positions greater than or equal to \${issue2.validation.position}\`;
          }
        } else if ("startsWith" in issue2.validation) {
          message = \`Invalid input: must start with "\${issue2.validation.startsWith}"\`;
        } else if ("endsWith" in issue2.validation) {
          message = \`Invalid input: must end with "\${issue2.validation.endsWith}"\`;
        } else {
          util.assertNever(issue2.validation);
        }
      } else if (issue2.validation !== "regex") {
        message = \`Invalid \${issue2.validation}\`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode2.too_small:
      if (issue2.type === "array") message = \`Array must contain \${issue2.exact ? "exactly" : issue2.inclusive ? \`at least\` : \`more than\`} \${issue2.minimum} element(s)\`;
      else if (issue2.type === "string") message = \`String must contain \${issue2.exact ? "exactly" : issue2.inclusive ? \`at least\` : \`over\`} \${issue2.minimum} character(s)\`;
      else if (issue2.type === "number") message = \`Number must be \${issue2.exact ? \`exactly equal to \` : issue2.inclusive ? \`greater than or equal to \` : \`greater than \`}\${issue2.minimum}\`;
      else if (issue2.type === "bigint") message = \`Number must be \${issue2.exact ? \`exactly equal to \` : issue2.inclusive ? \`greater than or equal to \` : \`greater than \`}\${issue2.minimum}\`;
      else if (issue2.type === "date") message = \`Date must be \${issue2.exact ? \`exactly equal to \` : issue2.inclusive ? \`greater than or equal to \` : \`greater than \`}\${new Date(Number(issue2.minimum))}\`;
      else message = "Invalid input";
      break;
    case ZodIssueCode2.too_big:
      if (issue2.type === "array") message = \`Array must contain \${issue2.exact ? \`exactly\` : issue2.inclusive ? \`at most\` : \`less than\`} \${issue2.maximum} element(s)\`;
      else if (issue2.type === "string") message = \`String must contain \${issue2.exact ? \`exactly\` : issue2.inclusive ? \`at most\` : \`under\`} \${issue2.maximum} character(s)\`;
      else if (issue2.type === "number") message = \`Number must be \${issue2.exact ? \`exactly\` : issue2.inclusive ? \`less than or equal to\` : \`less than\`} \${issue2.maximum}\`;
      else if (issue2.type === "bigint") message = \`BigInt must be \${issue2.exact ? \`exactly\` : issue2.inclusive ? \`less than or equal to\` : \`less than\`} \${issue2.maximum}\`;
      else if (issue2.type === "date") message = \`Date must be \${issue2.exact ? \`exactly\` : issue2.inclusive ? \`smaller than or equal to\` : \`smaller than\`} \${new Date(Number(issue2.maximum))}\`;
      else message = "Invalid input";
      break;
    case ZodIssueCode2.custom:
      message = \`Invalid input\`;
      break;
    case ZodIssueCode2.invalid_intersection_types:
      message = \`Intersection results could not be merged\`;
      break;
    case ZodIssueCode2.not_multiple_of:
      message = \`Number must be a multiple of \${issue2.multipleOf}\`;
      break;
    case ZodIssueCode2.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue2);
  }
  return {
    message
  };
}, "errorMap");
var en_default2 = errorMap;

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default2;
function getErrorMap2() {
  return overrideErrorMap;
}
__name(getErrorMap2, "getErrorMap");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = /* @__PURE__ */ __name((params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [
    ...path,
    ...issueData.path || []
  ];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map2 of maps) {
    errorMessage = map2(fullIssue, {
      data,
      defaultError: errorMessage
    }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
}, "makeIssue");
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap2();
  const issue2 = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default2 ? void 0 : en_default2
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue2);
}
__name(addIssueToContext, "addIssueToContext");
var ParseStatus = class _ParseStatus {
  static {
    __name(this, "ParseStatus");
  }
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid") this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted") this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted") return INVALID;
      if (s.status === "dirty") status.dirty();
      arrayValue.push(s.value);
    }
    return {
      status: status.value,
      value: arrayValue
    };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted") return INVALID;
      if (value.status === "aborted") return INVALID;
      if (key.status === "dirty") status.dirty();
      if (value.status === "dirty") status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return {
      status: status.value,
      value: finalObject
    };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = /* @__PURE__ */ __name((value) => ({
  status: "dirty",
  value
}), "DIRTY");
var OK = /* @__PURE__ */ __name((value) => ({
  status: "valid",
  value
}), "OK");
var isAborted = /* @__PURE__ */ __name((x) => x.status === "aborted", "isAborted");
var isDirty = /* @__PURE__ */ __name((x) => x.status === "dirty", "isDirty");
var isValid = /* @__PURE__ */ __name((x) => x.status === "valid", "isValid");
var isAsync = /* @__PURE__ */ __name((x) => typeof Promise !== "undefined" && x instanceof Promise, "isAsync");

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? {
    message
  } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../node_modules/.pnpm/zod@4.1.11/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  static {
    __name(this, "ParseInputLazyPath");
  }
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = /* @__PURE__ */ __name((ctx, result) => {
  if (isValid(result)) {
    return {
      success: true,
      data: result.value
    };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error) return this._error;
        const error45 = new ZodError2(ctx.common.issues);
        this._error = error45;
        return this._error;
      }
    };
  }
}, "handleResult");
function processCreateParams(params) {
  if (!params) return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(\`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.\`);
  }
  if (errorMap2) return {
    errorMap: errorMap2,
    description
  };
  const customMap = /* @__PURE__ */ __name((iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return {
        message: message ?? ctx.defaultError
      };
    }
    if (typeof ctx.data === "undefined") {
      return {
        message: message ?? required_error ?? ctx.defaultError
      };
    }
    if (iss.code !== "invalid_type") return {
      message: ctx.defaultError
    };
    return {
      message: message ?? invalid_type_error ?? ctx.defaultError
    };
  }, "customMap");
  return {
    errorMap: customMap,
    description
  };
}
__name(processCreateParams, "processCreateParams");
var ZodType2 = class {
  static {
    __name(this, "ZodType");
  }
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType2(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType2(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType2(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType2(data)
    };
    const result = this._parseSync({
      data,
      path: ctx.path,
      parent: ctx
    });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType2(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({
          data,
          path: [],
          parent: ctx
        });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({
      data,
      path: [],
      parent: ctx
    }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType2(data)
    };
    const maybeAsyncResult = this._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check2, message) {
    const getIssueProperties = /* @__PURE__ */ __name((val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return {
          message
        };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    }, "getIssueProperties");
    return this._refinement((val, ctx) => {
      const result = check2(val);
      const setError = /* @__PURE__ */ __name(() => ctx.addIssue({
        code: ZodIssueCode2.custom,
        ...getIssueProperties(val)
      }), "setError");
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check2, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check2(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind2.ZodEffects,
      effect: {
        type: "refinement",
        refinement
      }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: /* @__PURE__ */ __name((data) => this["~validate"](data), "validate")
    };
  }
  optional() {
    return ZodOptional2.create(this, this._def);
  }
  nullable() {
    return ZodNullable2.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray2.create(this);
  }
  promise() {
    return ZodPromise2.create(this, this._def);
  }
  or(option) {
    return ZodUnion2.create([
      this,
      option
    ], this._def);
  }
  and(incoming) {
    return ZodIntersection2.create(this, incoming, this._def);
  }
  transform(transform2) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind2.ZodEffects,
      effect: {
        type: "transform",
        transform: transform2
      }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault2({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind2.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind2.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch2({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind2.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly2.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\\s-]{8,}\$/i;
var cuid2Regex = /^[0-9a-z]+\$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}\$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{12}\$/i;
var nanoidRegex = /^[a-z0-9_-]{21}\$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]*\$/;
var durationRegex = /^[-+]?P(?!\$)(?:(?:[-+]?\\d+Y)|(?:[-+]?\\d+[.,]\\d+Y\$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M\$))?(?:(?:[-+]?\\d+W)|(?:[-+]?\\d+[.,]\\d+W\$))?(?:(?:[-+]?\\d+D)|(?:[-+]?\\d+[.,]\\d+D\$))?(?:T(?=[\\d+-])(?:(?:[-+]?\\d+H)|(?:[-+]?\\d+[.,]\\d+H\$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M\$))?(?:[-+]?\\d+(?:[.,]\\d+)?S)?)??\$/;
var emailRegex = /^(?!\\.)(?!.*\\.\\.)([A-Z0-9_'+\\-\\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\\-]*\\.)+[A-Z]{2,}\$/i;
var _emojiRegex = \`^(\\\\p{Extended_Pictographic}|\\\\p{Emoji_Component})+\$\`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/(3[0-2]|[12]?[0-9])\$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])\$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?\$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?\$/;
var dateRegexSource = \`((\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\\\d|30)|(02)-(0[1-9]|1\\\\d|2[0-8])))\`;
var dateRegex = new RegExp(\`^\${dateRegexSource}\$\`);
function timeRegexSource(args) {
  let secondsRegexSource = \`[0-5]\\\\d\`;
  if (args.precision) {
    secondsRegexSource = \`\${secondsRegexSource}\\\\.\\\\d{\${args.precision}}\`;
  } else if (args.precision == null) {
    secondsRegexSource = \`\${secondsRegexSource}(\\\\.\\\\d+)?\`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return \`([01]\\\\d|2[0-3]):[0-5]\\\\d(:\${secondsRegexSource})\${secondsQuantifier}\`;
}
__name(timeRegexSource, "timeRegexSource");
function timeRegex(args) {
  return new RegExp(\`^\${timeRegexSource(args)}\$\`);
}
__name(timeRegex, "timeRegex");
function datetimeRegex(args) {
  let regex = \`\${dateRegexSource}T\${timeRegexSource(args)}\`;
  const opts = [];
  opts.push(args.local ? \`Z?\` : \`Z\`);
  if (args.offset) opts.push(\`([+-]\\\\d{2}:?\\\\d{2})\`);
  regex = \`\${regex}(\${opts.join("|")})\`;
  return new RegExp(\`^\${regex}\$\`);
}
__name(datetimeRegex, "datetimeRegex");
function isValidIP(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
__name(isValidIP, "isValidIP");
function isValidJWT2(jwt2, alg) {
  if (!jwtRegex.test(jwt2)) return false;
  try {
    const [header] = jwt2.split(".");
    if (!header) return false;
    const base643 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base643));
    if (typeof decoded !== "object" || decoded === null) return false;
    if ("typ" in decoded && decoded?.typ !== "JWT") return false;
    if (!decoded.alg) return false;
    if (alg && decoded.alg !== alg) return false;
    return true;
  } catch {
    return false;
  }
}
__name(isValidJWT2, "isValidJWT");
function isValidCidr(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
__name(isValidCidr, "isValidCidr");
var ZodString2 = class _ZodString2 extends ZodType2 {
  static {
    __name(this, "ZodString");
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check2 of this._def.checks) {
      if (check2.kind === "min") {
        if (input.data.length < check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            minimum: check2.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        if (input.data.length > check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            maximum: check2.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "length") {
        const tooBig = input.data.length > check2.value;
        const tooSmall = input.data.length < check2.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode2.too_big,
              maximum: check2.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check2.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode2.too_small,
              minimum: check2.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check2.message
            });
          }
          status.dirty();
        }
      } else if (check2.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "regex") {
        check2.regex.lastIndex = 0;
        const testResult = check2.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "trim") {
        input.data = input.data.trim();
      } else if (check2.kind === "includes") {
        if (!input.data.includes(check2.value, check2.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: {
              includes: check2.value,
              position: check2.position
            },
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check2.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check2.kind === "startsWith") {
        if (!input.data.startsWith(check2.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: {
              startsWith: check2.value
            },
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "endsWith") {
        if (!input.data.endsWith(check2.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: {
              endsWith: check2.value
            },
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "datetime") {
        const regex = datetimeRegex(check2);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: "datetime",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: "date",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "time") {
        const regex = timeRegex(check2);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: "time",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "ip") {
        if (!isValidIP(input.data, check2.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "jwt") {
        if (!isValidJWT2(input.data, check2.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "cidr") {
        if (!isValidCidr(input.data, check2.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return {
      status: status.value,
      value: input.data
    };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode2.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check2) {
    return new _ZodString2({
      ...this._def,
      checks: [
        ...this._def.checks,
        check2
      ]
    });
  }
  email(message) {
    return this._addCheck({
      kind: "email",
      ...errorUtil.errToObj(message)
    });
  }
  url(message) {
    return this._addCheck({
      kind: "url",
      ...errorUtil.errToObj(message)
    });
  }
  emoji(message) {
    return this._addCheck({
      kind: "emoji",
      ...errorUtil.errToObj(message)
    });
  }
  uuid(message) {
    return this._addCheck({
      kind: "uuid",
      ...errorUtil.errToObj(message)
    });
  }
  nanoid(message) {
    return this._addCheck({
      kind: "nanoid",
      ...errorUtil.errToObj(message)
    });
  }
  cuid(message) {
    return this._addCheck({
      kind: "cuid",
      ...errorUtil.errToObj(message)
    });
  }
  cuid2(message) {
    return this._addCheck({
      kind: "cuid2",
      ...errorUtil.errToObj(message)
    });
  }
  ulid(message) {
    return this._addCheck({
      kind: "ulid",
      ...errorUtil.errToObj(message)
    });
  }
  base64(message) {
    return this._addCheck({
      kind: "base64",
      ...errorUtil.errToObj(message)
    });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({
      kind: "jwt",
      ...errorUtil.errToObj(options)
    });
  }
  ip(options) {
    return this._addCheck({
      kind: "ip",
      ...errorUtil.errToObj(options)
    });
  }
  cidr(options) {
    return this._addCheck({
      kind: "cidr",
      ...errorUtil.errToObj(options)
    });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({
      kind: "date",
      message
    });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({
      kind: "duration",
      ...errorUtil.errToObj(message)
    });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to \`.min(1)\`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString2({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind: "trim"
        }
      ]
    });
  }
  toLowerCase() {
    return new _ZodString2({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind: "toLowerCase"
        }
      ]
    });
  }
  toUpperCase() {
    return new _ZodString2({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind: "toUpperCase"
        }
      ]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
};
ZodString2.create = (params) => {
  return new ZodString2({
    checks: [],
    typeName: ZodFirstPartyTypeKind2.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder2(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
__name(floatSafeRemainder2, "floatSafeRemainder");
var ZodNumber2 = class _ZodNumber extends ZodType2 {
  static {
    __name(this, "ZodNumber");
  }
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check2 of this._def.checks) {
      if (check2.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: "integer",
            received: "float",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "min") {
        const tooSmall = check2.inclusive ? input.data < check2.value : input.data <= check2.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            minimum: check2.value,
            type: "number",
            inclusive: check2.inclusive,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        const tooBig = check2.inclusive ? input.data > check2.value : input.data >= check2.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            maximum: check2.value,
            type: "number",
            inclusive: check2.inclusive,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "multipleOf") {
        if (floatSafeRemainder2(input.data, check2.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.not_multiple_of,
            multipleOf: check2.value,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.not_finite,
            message: check2.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return {
      status: status.value,
      value: input.data
    };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check2) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        check2
      ]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber2.create = (params) => {
  return new ZodNumber2({
    checks: [],
    typeName: ZodFirstPartyTypeKind2.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt2 = class _ZodBigInt extends ZodType2 {
  static {
    __name(this, "ZodBigInt");
  }
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check2 of this._def.checks) {
      if (check2.kind === "min") {
        const tooSmall = check2.inclusive ? input.data < check2.value : input.data <= check2.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            type: "bigint",
            minimum: check2.value,
            inclusive: check2.inclusive,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        const tooBig = check2.inclusive ? input.data > check2.value : input.data >= check2.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            type: "bigint",
            maximum: check2.value,
            inclusive: check2.inclusive,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "multipleOf") {
        if (input.data % check2.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.not_multiple_of,
            multipleOf: check2.value,
            message: check2.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return {
      status: status.value,
      value: input.data
    };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode2.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check2) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        check2
      ]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt2.create = (params) => {
  return new ZodBigInt2({
    checks: [],
    typeName: ZodFirstPartyTypeKind2.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean2 = class extends ZodType2 {
  static {
    __name(this, "ZodBoolean");
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean2.create = (params) => {
  return new ZodBoolean2({
    typeName: ZodFirstPartyTypeKind2.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate2 = class _ZodDate extends ZodType2 {
  static {
    __name(this, "ZodDate");
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check2 of this._def.checks) {
      if (check2.kind === "min") {
        if (input.data.getTime() < check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            message: check2.message,
            inclusive: true,
            exact: false,
            minimum: check2.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        if (input.data.getTime() > check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            message: check2.message,
            inclusive: true,
            exact: false,
            maximum: check2.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check2) {
    return new _ZodDate({
      ...this._def,
      checks: [
        ...this._def.checks,
        check2
      ]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate2.create = (params) => {
  return new ZodDate2({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind2.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol2 = class extends ZodType2 {
  static {
    __name(this, "ZodSymbol");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol2.create = (params) => {
  return new ZodSymbol2({
    typeName: ZodFirstPartyTypeKind2.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined2 = class extends ZodType2 {
  static {
    __name(this, "ZodUndefined");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined2.create = (params) => {
  return new ZodUndefined2({
    typeName: ZodFirstPartyTypeKind2.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull2 = class extends ZodType2 {
  static {
    __name(this, "ZodNull");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull2.create = (params) => {
  return new ZodNull2({
    typeName: ZodFirstPartyTypeKind2.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny2 = class extends ZodType2 {
  static {
    __name(this, "ZodAny");
  }
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny2.create = (params) => {
  return new ZodAny2({
    typeName: ZodFirstPartyTypeKind2.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown2 = class extends ZodType2 {
  static {
    __name(this, "ZodUnknown");
  }
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown2.create = (params) => {
  return new ZodUnknown2({
    typeName: ZodFirstPartyTypeKind2.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever2 = class extends ZodType2 {
  static {
    __name(this, "ZodNever");
  }
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode2.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever2.create = (params) => {
  return new ZodNever2({
    typeName: ZodFirstPartyTypeKind2.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid2 = class extends ZodType2 {
  static {
    __name(this, "ZodVoid");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid2.create = (params) => {
  return new ZodVoid2({
    typeName: ZodFirstPartyTypeKind2.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray2 = class _ZodArray extends ZodType2 {
  static {
    __name(this, "ZodArray");
  }
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode2.too_big : ZodIssueCode2.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([
        ...ctx.data
      ].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [
      ...ctx.data
    ].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: {
        value: minLength,
        message: errorUtil.toString(message)
      }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: {
        value: maxLength,
        message: errorUtil.toString(message)
      }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: {
        value: len,
        message: errorUtil.toString(message)
      }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray2.create = (schema, params) => {
  return new ZodArray2({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind2.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject2) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional2.create(deepPartialify(fieldSchema));
    }
    return new ZodObject2({
      ...schema._def,
      shape: /* @__PURE__ */ __name(() => newShape, "shape")
    });
  } else if (schema instanceof ZodArray2) {
    return new ZodArray2({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional2) {
    return ZodOptional2.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable2) {
    return ZodNullable2.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple2) {
    return ZodTuple2.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
__name(deepPartialify, "deepPartialify");
var ZodObject2 = class _ZodObject extends ZodType2 {
  static {
    __name(this, "ZodObject");
  }
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = {
      shape,
      keys
    };
    return this._cached;
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever2 && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: {
          status: "valid",
          value: key
        },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever2) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: {
              status: "valid",
              value: key
            },
            value: {
              status: "valid",
              value: ctx.data[key]
            }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode2.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(\`Internal ZodObject error: invalid unknownKeys value.\`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: {
            status: "valid",
            value: key
          },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: /* @__PURE__ */ __name((issue2, ctx) => {
          const defaultError = this._def.errorMap?.(issue2, ctx).message ?? ctx.defaultError;
          if (issue2.code === "unrecognized_keys") return {
            message: errorUtil.errToObj(message).message ?? defaultError
          };
          return {
            message: defaultError
          };
        }, "errorMap")
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: /* @__PURE__ */ __name(() => ({
        ...this._def.shape(),
        ...augmentation
      }), "shape")
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: /* @__PURE__ */ __name(() => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }), "shape"),
      typeName: ZodFirstPartyTypeKind2.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({
      [key]: schema
    });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: /* @__PURE__ */ __name(() => shape, "shape")
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: /* @__PURE__ */ __name(() => shape, "shape")
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: /* @__PURE__ */ __name(() => newShape, "shape")
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional2) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: /* @__PURE__ */ __name(() => newShape, "shape")
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject2.create = (shape, params) => {
  return new ZodObject2({
    shape: /* @__PURE__ */ __name(() => shape, "shape"),
    unknownKeys: "strip",
    catchall: ZodNever2.create(),
    typeName: ZodFirstPartyTypeKind2.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject2.strictCreate = (shape, params) => {
  return new ZodObject2({
    shape: /* @__PURE__ */ __name(() => shape, "shape"),
    unknownKeys: "strict",
    catchall: ZodNever2.create(),
    typeName: ZodFirstPartyTypeKind2.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject2.lazycreate = (shape, params) => {
  return new ZodObject2({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever2.create(),
    typeName: ZodFirstPartyTypeKind2.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion2 = class extends ZodType2 {
  static {
    __name(this, "ZodUnion");
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError2(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    __name(handleResults, "handleResults");
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = {
            result,
            ctx: childCtx
          };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError2(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion2.create = (types, params) => {
  return new ZodUnion2({
    options: types,
    typeName: ZodFirstPartyTypeKind2.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = /* @__PURE__ */ __name((type) => {
  if (type instanceof ZodLazy2) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral2) {
    return [
      type.value
    ];
  } else if (type instanceof ZodEnum2) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault2) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined2) {
    return [
      void 0
    ];
  } else if (type instanceof ZodNull2) {
    return [
      null
    ];
  } else if (type instanceof ZodOptional2) {
    return [
      void 0,
      ...getDiscriminator(type.unwrap())
    ];
  } else if (type instanceof ZodNullable2) {
    return [
      null,
      ...getDiscriminator(type.unwrap())
    ];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly2) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch2) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
}, "getDiscriminator");
var ZodDiscriminatedUnion2 = class _ZodDiscriminatedUnion extends ZodType2 {
  static {
    __name(this, "ZodDiscriminatedUnion");
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [
          discriminator
        ]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(\`A discriminator value for key \\\`\${discriminator}\\\` could not be extracted from all schema options\`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(\`Discriminator property \${String(discriminator)} has duplicate value \${String(value)}\`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind2.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues2(a, b) {
  const aType = getParsedType2(a);
  const bType = getParsedType2(b);
  if (a === b) {
    return {
      valid: true,
      data: a
    };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = {
      ...a,
      ...b
    };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues2(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false
        };
      }
      newObj[key] = sharedValue.data;
    }
    return {
      valid: true,
      data: newObj
    };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return {
        valid: false
      };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues2(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false
        };
      }
      newArray.push(sharedValue.data);
    }
    return {
      valid: true,
      data: newArray
    };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return {
      valid: true,
      data: a
    };
  } else {
    return {
      valid: false
    };
  }
}
__name(mergeValues2, "mergeValues");
var ZodIntersection2 = class extends ZodType2 {
  static {
    __name(this, "ZodIntersection");
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = /* @__PURE__ */ __name((parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues2(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return {
        status: status.value,
        value: merged.data
      };
    }, "handleParsed");
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection2.create = (left, right, params) => {
  return new ZodIntersection2({
    left,
    right,
    typeName: ZodFirstPartyTypeKind2.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple2 = class _ZodTuple extends ZodType2 {
  static {
    __name(this, "ZodTuple");
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [
      ...ctx.data
    ].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema) return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple2.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple2({
    items: schemas,
    typeName: ZodFirstPartyTypeKind2.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord2 = class _ZodRecord extends ZodType2 {
  static {
    __name(this, "ZodRecord");
  }
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType2) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind2.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString2.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind2.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap2 = class extends ZodType2 {
  static {
    __name(this, "ZodMap");
  }
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [
      ...ctx.data.entries()
    ].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [
          index,
          "key"
        ])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [
          index,
          "value"
        ]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return {
          status: status.value,
          value: finalMap
        };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return {
        status: status.value,
        value: finalMap
      };
    }
  }
};
ZodMap2.create = (keyType, valueType, params) => {
  return new ZodMap2({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind2.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet2 = class _ZodSet extends ZodType2 {
  static {
    __name(this, "ZodSet");
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted") return INVALID;
        if (element.status === "dirty") status.dirty();
        parsedSet.add(element.value);
      }
      return {
        status: status.value,
        value: parsedSet
      };
    }
    __name(finalizeSet, "finalizeSet");
    const elements = [
      ...ctx.data.values()
    ].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: {
        value: minSize,
        message: errorUtil.toString(message)
      }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: {
        value: maxSize,
        message: errorUtil.toString(message)
      }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet2.create = (valueType, params) => {
  return new ZodSet2({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind2.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction2 = class _ZodFunction extends ZodType2 {
  static {
    __name(this, "ZodFunction");
  }
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error45) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap2(),
          en_default2
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode2.invalid_arguments,
          argumentsError: error45
        }
      });
    }
    __name(makeArgsIssue, "makeArgsIssue");
    function makeReturnsIssue(returns, error45) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap2(),
          en_default2
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode2.invalid_return_type,
          returnTypeError: error45
        }
      });
    }
    __name(makeReturnsIssue, "makeReturnsIssue");
    const params = {
      errorMap: ctx.common.contextualErrorMap
    };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise2) {
      const me = this;
      return OK(async function(...args) {
        const error45 = new ZodError2([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error45.addIssue(makeArgsIssue(args, e));
          throw error45;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error45.addIssue(makeReturnsIssue(result, e));
          throw error45;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError2([
            makeArgsIssue(args, parsedArgs.error)
          ]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError2([
            makeReturnsIssue(result, parsedReturns.error)
          ]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple2.create(items).rest(ZodUnknown2.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple2.create([]).rest(ZodUnknown2.create()),
      returns: returns || ZodUnknown2.create(),
      typeName: ZodFirstPartyTypeKind2.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy2 = class extends ZodType2 {
  static {
    __name(this, "ZodLazy");
  }
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({
      data: ctx.data,
      path: ctx.path,
      parent: ctx
    });
  }
};
ZodLazy2.create = (getter, params) => {
  return new ZodLazy2({
    getter,
    typeName: ZodFirstPartyTypeKind2.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral2 = class extends ZodType2 {
  static {
    __name(this, "ZodLiteral");
  }
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode2.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return {
      status: "valid",
      value: input.data
    };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral2.create = (value, params) => {
  return new ZodLiteral2({
    value,
    typeName: ZodFirstPartyTypeKind2.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum2({
    values,
    typeName: ZodFirstPartyTypeKind2.ZodEnum,
    ...processCreateParams(params)
  });
}
__name(createZodEnum, "createZodEnum");
var ZodEnum2 = class _ZodEnum extends ZodType2 {
  static {
    __name(this, "ZodEnum");
  }
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode2.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode2.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum2.create = createZodEnum;
var ZodNativeEnum = class extends ZodType2 {
  static {
    __name(this, "ZodNativeEnum");
  }
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode2.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode2.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind2.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise2 = class extends ZodType2 {
  static {
    __name(this, "ZodPromise");
  }
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise2.create = (schema, params) => {
  return new ZodPromise2({
    type: schema,
    typeName: ZodFirstPartyTypeKind2.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType2 {
  static {
    __name(this, "ZodEffects");
  }
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind2.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: /* @__PURE__ */ __name((arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      }, "addIssue"),
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted") return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted") return INVALID;
          if (result.status === "dirty") return DIRTY(result.value);
          if (status.value === "dirty") return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted") return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted") return INVALID;
        if (result.status === "dirty") return DIRTY(result.value);
        if (status.value === "dirty") return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = /* @__PURE__ */ __name((acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      }, "executeRefinement");
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted") return INVALID;
        if (inner.status === "dirty") status.dirty();
        executeRefinement(inner.value);
        return {
          status: status.value,
          value: inner.value
        };
      } else {
        return this._def.schema._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }).then((inner) => {
          if (inner.status === "aborted") return INVALID;
          if (inner.status === "dirty") status.dirty();
          return executeRefinement(inner.value).then(() => {
            return {
              status: status.value,
              value: inner.value
            };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base)) return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(\`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.\`);
        }
        return {
          status: status.value,
          value: result
        };
      } else {
        return this._def.schema._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }).then((base) => {
          if (!isValid(base)) return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind2.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess2, schema, params) => {
  return new ZodEffects({
    schema,
    effect: {
      type: "preprocess",
      transform: preprocess2
    },
    typeName: ZodFirstPartyTypeKind2.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional2 = class extends ZodType2 {
  static {
    __name(this, "ZodOptional");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional2.create = (type, params) => {
  return new ZodOptional2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable2 = class extends ZodType2 {
  static {
    __name(this, "ZodNullable");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable2.create = (type, params) => {
  return new ZodNullable2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault2 = class extends ZodType2 {
  static {
    __name(this, "ZodDefault");
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault2.create = (type, params) => {
  return new ZodDefault2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch2 = class extends ZodType2 {
  static {
    __name(this, "ZodCatch");
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError2(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError2(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch2.create = (type, params) => {
  return new ZodCatch2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN2 = class extends ZodType2 {
  static {
    __name(this, "ZodNaN");
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return {
      status: "valid",
      value: input.data
    };
  }
};
ZodNaN2.create = (params) => {
  return new ZodNaN2({
    typeName: ZodFirstPartyTypeKind2.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType2 {
  static {
    __name(this, "ZodBranded");
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType2 {
  static {
    __name(this, "ZodPipeline");
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = /* @__PURE__ */ __name(async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted") return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      }, "handleAsync");
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted") return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind2.ZodPipeline
    });
  }
};
var ZodReadonly2 = class extends ZodType2 {
  static {
    __name(this, "ZodReadonly");
  }
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = /* @__PURE__ */ __name((data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    }, "freeze");
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly2.create = (type, params) => {
  return new ZodReadonly2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodReadonly,
    ...processCreateParams(params)
  });
};
var late = {
  object: ZodObject2.lazycreate
};
var ZodFirstPartyTypeKind2;
(function(ZodFirstPartyTypeKind3) {
  ZodFirstPartyTypeKind3["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind3["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind3["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind3["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind3["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind3["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind3["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind3["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind3["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind3["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind3["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind3["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind3["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind3["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind3["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind3["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind3["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind3["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind3["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind3["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind3["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind3["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind3["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind3["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind3["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind3["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind3["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind3["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind3["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind3["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind3["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind3["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind3["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind3["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind3["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind3["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind2 || (ZodFirstPartyTypeKind2 = {}));
var stringType = ZodString2.create;
var numberType = ZodNumber2.create;
var nanType = ZodNaN2.create;
var bigIntType = ZodBigInt2.create;
var booleanType = ZodBoolean2.create;
var dateType = ZodDate2.create;
var symbolType = ZodSymbol2.create;
var undefinedType = ZodUndefined2.create;
var nullType = ZodNull2.create;
var anyType = ZodAny2.create;
var unknownType = ZodUnknown2.create;
var neverType = ZodNever2.create;
var voidType = ZodVoid2.create;
var arrayType = ZodArray2.create;
var objectType = ZodObject2.create;
var strictObjectType = ZodObject2.strictCreate;
var unionType = ZodUnion2.create;
var discriminatedUnionType = ZodDiscriminatedUnion2.create;
var intersectionType = ZodIntersection2.create;
var tupleType = ZodTuple2.create;
var recordType = ZodRecord2.create;
var mapType = ZodMap2.create;
var setType = ZodSet2.create;
var functionType = ZodFunction2.create;
var lazyType = ZodLazy2.create;
var literalType = ZodLiteral2.create;
var enumType = ZodEnum2.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise2.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional2.create;
var nullableType = ZodNullable2.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;

// ../../node_modules/.pnpm/@ai-sdk+provider-utils@3.0.12_zod@4.1.11/node_modules/@ai-sdk/provider-utils/dist/index.mjs
function combineHeaders(...headers) {
  return headers.reduce((combinedHeaders, currentHeaders) => ({
    ...combinedHeaders,
    ...currentHeaders != null ? currentHeaders : {}
  }), {});
}
__name(combineHeaders, "combineHeaders");
async function delay(delayInMs, options) {
  if (delayInMs == null) {
    return Promise.resolve();
  }
  const signal = options == null ? void 0 : options.abortSignal;
  return new Promise((resolve2, reject) => {
    if (signal == null ? void 0 : signal.aborted) {
      reject(createAbortError());
      return;
    }
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve2();
    }, delayInMs);
    const cleanup = /* @__PURE__ */ __name(() => {
      clearTimeout(timeoutId);
      signal == null ? void 0 : signal.removeEventListener("abort", onAbort);
    }, "cleanup");
    const onAbort = /* @__PURE__ */ __name(() => {
      cleanup();
      reject(createAbortError());
    }, "onAbort");
    signal == null ? void 0 : signal.addEventListener("abort", onAbort);
  });
}
__name(delay, "delay");
function createAbortError() {
  return new DOMException("Delay was aborted", "AbortError");
}
__name(createAbortError, "createAbortError");
function extractResponseHeaders(response) {
  return Object.fromEntries([
    ...response.headers
  ]);
}
__name(extractResponseHeaders, "extractResponseHeaders");
var createIdGenerator = /* @__PURE__ */ __name(({ prefix, size = 16, alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", separator = "-" } = {}) => {
  const generator = /* @__PURE__ */ __name(() => {
    const alphabetLength = alphabet.length;
    const chars = new Array(size);
    for (let i = 0; i < size; i++) {
      chars[i] = alphabet[Math.random() * alphabetLength | 0];
    }
    return chars.join("");
  }, "generator");
  if (prefix == null) {
    return generator;
  }
  if (alphabet.includes(separator)) {
    throw new InvalidArgumentError({
      argument: "separator",
      message: \`The separator "\${separator}" must not be part of the alphabet "\${alphabet}".\`
    });
  }
  return () => \`\${prefix}\${separator}\${generator()}\`;
}, "createIdGenerator");
var generateId = createIdGenerator();
function getErrorMessage2(error45) {
  if (error45 == null) {
    return "unknown error";
  }
  if (typeof error45 === "string") {
    return error45;
  }
  if (error45 instanceof Error) {
    return error45.message;
  }
  return JSON.stringify(error45);
}
__name(getErrorMessage2, "getErrorMessage");
function isAbortError(error45) {
  return (error45 instanceof Error || error45 instanceof DOMException) && (error45.name === "AbortError" || error45.name === "ResponseAborted" || // Next.js
  error45.name === "TimeoutError");
}
__name(isAbortError, "isAbortError");
var FETCH_FAILED_ERROR_MESSAGES = [
  "fetch failed",
  "failed to fetch"
];
function handleFetchError({ error: error45, url: url2, requestBodyValues }) {
  if (isAbortError(error45)) {
    return error45;
  }
  if (error45 instanceof TypeError && FETCH_FAILED_ERROR_MESSAGES.includes(error45.message.toLowerCase())) {
    const cause = error45.cause;
    if (cause != null) {
      return new APICallError({
        message: \`Cannot connect to API: \${cause.message}\`,
        cause,
        url: url2,
        requestBodyValues,
        isRetryable: true
      });
    }
  }
  return error45;
}
__name(handleFetchError, "handleFetchError");
function getRuntimeEnvironmentUserAgent(globalThisAny = globalThis) {
  var _a17, _b8, _c;
  if (globalThisAny.window) {
    return \`runtime/browser\`;
  }
  if ((_a17 = globalThisAny.navigator) == null ? void 0 : _a17.userAgent) {
    return \`runtime/\${globalThisAny.navigator.userAgent.toLowerCase()}\`;
  }
  if ((_c = (_b8 = globalThisAny.process) == null ? void 0 : _b8.versions) == null ? void 0 : _c.node) {
    return \`runtime/node.js/\${globalThisAny.process.version.substring(0)}\`;
  }
  if (globalThisAny.EdgeRuntime) {
    return \`runtime/vercel-edge\`;
  }
  return "runtime/unknown";
}
__name(getRuntimeEnvironmentUserAgent, "getRuntimeEnvironmentUserAgent");
function removeUndefinedEntries(record2) {
  return Object.fromEntries(Object.entries(record2).filter(([_key, value]) => value != null));
}
__name(removeUndefinedEntries, "removeUndefinedEntries");
function withUserAgentSuffix(headers, ...userAgentSuffixParts) {
  const cleanedHeaders = removeUndefinedEntries(headers != null ? headers : {});
  const normalizedHeaders = new Headers(cleanedHeaders);
  const currentUserAgentHeader = normalizedHeaders.get("user-agent") || "";
  normalizedHeaders.set("user-agent", [
    currentUserAgentHeader,
    ...userAgentSuffixParts
  ].filter(Boolean).join(" "));
  return Object.fromEntries(normalizedHeaders);
}
__name(withUserAgentSuffix, "withUserAgentSuffix");
var VERSION = true ? "3.0.12" : "0.0.0-test";
var getOriginalFetch = /* @__PURE__ */ __name(() => globalThis.fetch, "getOriginalFetch");
var getFromApi = /* @__PURE__ */ __name(async ({ url: url2, headers = {}, successfulResponseHandler, failedResponseHandler, abortSignal, fetch: fetch3 = getOriginalFetch() }) => {
  try {
    const response = await fetch3(url2, {
      method: "GET",
      headers: withUserAgentSuffix(headers, \`ai-sdk/provider-utils/\${VERSION}\`, getRuntimeEnvironmentUserAgent()),
      signal: abortSignal
    });
    const responseHeaders = extractResponseHeaders(response);
    if (!response.ok) {
      let errorInformation;
      try {
        errorInformation = await failedResponseHandler({
          response,
          url: url2,
          requestBodyValues: {}
        });
      } catch (error45) {
        if (isAbortError(error45) || APICallError.isInstance(error45)) {
          throw error45;
        }
        throw new APICallError({
          message: "Failed to process error response",
          cause: error45,
          statusCode: response.status,
          url: url2,
          responseHeaders,
          requestBodyValues: {}
        });
      }
      throw errorInformation.value;
    }
    try {
      return await successfulResponseHandler({
        response,
        url: url2,
        requestBodyValues: {}
      });
    } catch (error45) {
      if (error45 instanceof Error) {
        if (isAbortError(error45) || APICallError.isInstance(error45)) {
          throw error45;
        }
      }
      throw new APICallError({
        message: "Failed to process successful response",
        cause: error45,
        statusCode: response.status,
        url: url2,
        responseHeaders,
        requestBodyValues: {}
      });
    }
  } catch (error45) {
    throw handleFetchError({
      error: error45,
      url: url2,
      requestBodyValues: {}
    });
  }
}, "getFromApi");
function isUrlSupported({ mediaType, url: url2, supportedUrls }) {
  url2 = url2.toLowerCase();
  mediaType = mediaType.toLowerCase();
  return Object.entries(supportedUrls).map(([key, value]) => {
    const mediaType2 = key.toLowerCase();
    return mediaType2 === "*" || mediaType2 === "*/*" ? {
      mediaTypePrefix: "",
      regexes: value
    } : {
      mediaTypePrefix: mediaType2.replace(/\\*/, ""),
      regexes: value
    };
  }).filter(({ mediaTypePrefix }) => mediaType.startsWith(mediaTypePrefix)).flatMap(({ regexes }) => regexes).some((pattern) => pattern.test(url2));
}
__name(isUrlSupported, "isUrlSupported");
function loadOptionalSetting({ settingValue, environmentVariableName }) {
  if (typeof settingValue === "string") {
    return settingValue;
  }
  if (settingValue != null || typeof process === "undefined") {
    return void 0;
  }
  settingValue = process.env[environmentVariableName];
  if (settingValue == null || typeof settingValue !== "string") {
    return void 0;
  }
  return settingValue;
}
__name(loadOptionalSetting, "loadOptionalSetting");
var suspectProtoRx = /"__proto__"\\s*:/;
var suspectConstructorRx = /"constructor"\\s*:/;
function _parse2(text2) {
  const obj = JSON.parse(text2);
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (suspectProtoRx.test(text2) === false && suspectConstructorRx.test(text2) === false) {
    return obj;
  }
  return filter(obj);
}
__name(_parse2, "_parse");
function filter(obj) {
  let next = [
    obj
  ];
  while (next.length) {
    const nodes = next;
    next = [];
    for (const node of nodes) {
      if (Object.prototype.hasOwnProperty.call(node, "__proto__")) {
        throw new SyntaxError("Object contains forbidden prototype property");
      }
      if (Object.prototype.hasOwnProperty.call(node, "constructor") && Object.prototype.hasOwnProperty.call(node.constructor, "prototype")) {
        throw new SyntaxError("Object contains forbidden prototype property");
      }
      for (const key in node) {
        const value = node[key];
        if (value && typeof value === "object") {
          next.push(value);
        }
      }
    }
  }
  return obj;
}
__name(filter, "filter");
function secureJsonParse(text2) {
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  try {
    return _parse2(text2);
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
  }
}
__name(secureJsonParse, "secureJsonParse");
var validatorSymbol = Symbol.for("vercel.ai.validator");
function validator(validate) {
  return {
    [validatorSymbol]: true,
    validate
  };
}
__name(validator, "validator");
function isValidator(value) {
  return typeof value === "object" && value !== null && validatorSymbol in value && value[validatorSymbol] === true && "validate" in value;
}
__name(isValidator, "isValidator");
function lazyValidator(createValidator) {
  let validator2;
  return () => {
    if (validator2 == null) {
      validator2 = createValidator();
    }
    return validator2;
  };
}
__name(lazyValidator, "lazyValidator");
function asValidator(value) {
  return isValidator(value) ? value : typeof value === "function" ? value() : standardSchemaValidator(value);
}
__name(asValidator, "asValidator");
function standardSchemaValidator(standardSchema) {
  return validator(async (value) => {
    const result = await standardSchema["~standard"].validate(value);
    return result.issues == null ? {
      success: true,
      value: result.value
    } : {
      success: false,
      error: new TypeValidationError({
        value,
        cause: result.issues
      })
    };
  });
}
__name(standardSchemaValidator, "standardSchemaValidator");
async function validateTypes({ value, schema }) {
  const result = await safeValidateTypes({
    value,
    schema
  });
  if (!result.success) {
    throw TypeValidationError.wrap({
      value,
      cause: result.error
    });
  }
  return result.value;
}
__name(validateTypes, "validateTypes");
async function safeValidateTypes({ value, schema }) {
  const validator2 = asValidator(schema);
  try {
    if (validator2.validate == null) {
      return {
        success: true,
        value,
        rawValue: value
      };
    }
    const result = await validator2.validate(value);
    if (result.success) {
      return {
        success: true,
        value: result.value,
        rawValue: value
      };
    }
    return {
      success: false,
      error: TypeValidationError.wrap({
        value,
        cause: result.error
      }),
      rawValue: value
    };
  } catch (error45) {
    return {
      success: false,
      error: TypeValidationError.wrap({
        value,
        cause: error45
      }),
      rawValue: value
    };
  }
}
__name(safeValidateTypes, "safeValidateTypes");
async function parseJSON({ text: text2, schema }) {
  try {
    const value = secureJsonParse(text2);
    if (schema == null) {
      return value;
    }
    return validateTypes({
      value,
      schema
    });
  } catch (error45) {
    if (JSONParseError.isInstance(error45) || TypeValidationError.isInstance(error45)) {
      throw error45;
    }
    throw new JSONParseError({
      text: text2,
      cause: error45
    });
  }
}
__name(parseJSON, "parseJSON");
async function safeParseJSON({ text: text2, schema }) {
  try {
    const value = secureJsonParse(text2);
    if (schema == null) {
      return {
        success: true,
        value,
        rawValue: value
      };
    }
    return await safeValidateTypes({
      value,
      schema
    });
  } catch (error45) {
    return {
      success: false,
      error: JSONParseError.isInstance(error45) ? error45 : new JSONParseError({
        text: text2,
        cause: error45
      }),
      rawValue: void 0
    };
  }
}
__name(safeParseJSON, "safeParseJSON");
function parseJsonEventStream({ stream, schema }) {
  return stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).pipeThrough(new TransformStream({
    async transform({ data }, controller) {
      if (data === "[DONE]") {
        return;
      }
      controller.enqueue(await safeParseJSON({
        text: data,
        schema
      }));
    }
  }));
}
__name(parseJsonEventStream, "parseJsonEventStream");
var getOriginalFetch2 = /* @__PURE__ */ __name(() => globalThis.fetch, "getOriginalFetch2");
var postJsonToApi = /* @__PURE__ */ __name(async ({ url: url2, headers, body, failedResponseHandler, successfulResponseHandler, abortSignal, fetch: fetch3 }) => postToApi({
  url: url2,
  headers: {
    "Content-Type": "application/json",
    ...headers
  },
  body: {
    content: JSON.stringify(body),
    values: body
  },
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch3
}), "postJsonToApi");
var postToApi = /* @__PURE__ */ __name(async ({ url: url2, headers = {}, body, successfulResponseHandler, failedResponseHandler, abortSignal, fetch: fetch3 = getOriginalFetch2() }) => {
  try {
    const response = await fetch3(url2, {
      method: "POST",
      headers: withUserAgentSuffix(headers, \`ai-sdk/provider-utils/\${VERSION}\`, getRuntimeEnvironmentUserAgent()),
      body: body.content,
      signal: abortSignal
    });
    const responseHeaders = extractResponseHeaders(response);
    if (!response.ok) {
      let errorInformation;
      try {
        errorInformation = await failedResponseHandler({
          response,
          url: url2,
          requestBodyValues: body.values
        });
      } catch (error45) {
        if (isAbortError(error45) || APICallError.isInstance(error45)) {
          throw error45;
        }
        throw new APICallError({
          message: "Failed to process error response",
          cause: error45,
          statusCode: response.status,
          url: url2,
          responseHeaders,
          requestBodyValues: body.values
        });
      }
      throw errorInformation.value;
    }
    try {
      return await successfulResponseHandler({
        response,
        url: url2,
        requestBodyValues: body.values
      });
    } catch (error45) {
      if (error45 instanceof Error) {
        if (isAbortError(error45) || APICallError.isInstance(error45)) {
          throw error45;
        }
      }
      throw new APICallError({
        message: "Failed to process successful response",
        cause: error45,
        statusCode: response.status,
        url: url2,
        responseHeaders,
        requestBodyValues: body.values
      });
    }
  } catch (error45) {
    throw handleFetchError({
      error: error45,
      url: url2,
      requestBodyValues: body.values
    });
  }
}, "postToApi");
async function resolve(value) {
  if (typeof value === "function") {
    value = value();
  }
  return Promise.resolve(value);
}
__name(resolve, "resolve");
var createJsonErrorResponseHandler = /* @__PURE__ */ __name(({ errorSchema, errorToMessage, isRetryable }) => async ({ response, url: url2, requestBodyValues }) => {
  const responseBody = await response.text();
  const responseHeaders = extractResponseHeaders(response);
  if (responseBody.trim() === "") {
    return {
      responseHeaders,
      value: new APICallError({
        message: response.statusText,
        url: url2,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: isRetryable == null ? void 0 : isRetryable(response)
      })
    };
  }
  try {
    const parsedError = await parseJSON({
      text: responseBody,
      schema: errorSchema
    });
    return {
      responseHeaders,
      value: new APICallError({
        message: errorToMessage(parsedError),
        url: url2,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        data: parsedError,
        isRetryable: isRetryable == null ? void 0 : isRetryable(response, parsedError)
      })
    };
  } catch (parseError) {
    return {
      responseHeaders,
      value: new APICallError({
        message: response.statusText,
        url: url2,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: isRetryable == null ? void 0 : isRetryable(response)
      })
    };
  }
}, "createJsonErrorResponseHandler");
var createEventSourceResponseHandler = /* @__PURE__ */ __name((chunkSchema) => async ({ response }) => {
  const responseHeaders = extractResponseHeaders(response);
  if (response.body == null) {
    throw new EmptyResponseBodyError({});
  }
  return {
    responseHeaders,
    value: parseJsonEventStream({
      stream: response.body,
      schema: chunkSchema
    })
  };
}, "createEventSourceResponseHandler");
var createJsonResponseHandler = /* @__PURE__ */ __name((responseSchema) => async ({ response, url: url2, requestBodyValues }) => {
  const responseBody = await response.text();
  const parsedResult = await safeParseJSON({
    text: responseBody,
    schema: responseSchema
  });
  const responseHeaders = extractResponseHeaders(response);
  if (!parsedResult.success) {
    throw new APICallError({
      message: "Invalid JSON response",
      cause: parsedResult.error,
      statusCode: response.status,
      responseHeaders,
      responseBody,
      url: url2,
      requestBodyValues
    });
  }
  return {
    responseHeaders,
    value: parsedResult.value,
    rawValue: parsedResult.rawValue
  };
}, "createJsonResponseHandler");
var getRelativePath = /* @__PURE__ */ __name((pathA, pathB) => {
  let i = 0;
  for (; i < pathA.length && i < pathB.length; i++) {
    if (pathA[i] !== pathB[i]) break;
  }
  return [
    (pathA.length - i).toString(),
    ...pathB.slice(i)
  ].join("/");
}, "getRelativePath");
var ignoreOverride = Symbol("Let zodToJsonSchema decide on which parser to use");
var defaultOptions = {
  name: void 0,
  \$refStrategy: "root",
  basePath: [
    "#"
  ],
  effectStrategy: "input",
  pipeStrategy: "all",
  dateStrategy: "format:date-time",
  mapStrategy: "entries",
  removeAdditionalStrategy: "passthrough",
  allowedAdditionalProperties: true,
  rejectedAdditionalProperties: false,
  definitionPath: "definitions",
  strictUnions: false,
  definitions: {},
  errorMessages: false,
  patternStrategy: "escape",
  applyRegexFlags: false,
  emailStrategy: "format:email",
  base64Strategy: "contentEncoding:base64",
  nameStrategy: "ref"
};
var getDefaultOptions = /* @__PURE__ */ __name((options) => typeof options === "string" ? {
  ...defaultOptions,
  name: options
} : {
  ...defaultOptions,
  ...options
}, "getDefaultOptions");
function parseAnyDef() {
  return {};
}
__name(parseAnyDef, "parseAnyDef");
function parseArrayDef(def, refs) {
  var _a17, _b8, _c;
  const res = {
    type: "array"
  };
  if (((_a17 = def.type) == null ? void 0 : _a17._def) && ((_c = (_b8 = def.type) == null ? void 0 : _b8._def) == null ? void 0 : _c.typeName) !== ZodFirstPartyTypeKind2.ZodAny) {
    res.items = parseDef(def.type._def, {
      ...refs,
      currentPath: [
        ...refs.currentPath,
        "items"
      ]
    });
  }
  if (def.minLength) {
    res.minItems = def.minLength.value;
  }
  if (def.maxLength) {
    res.maxItems = def.maxLength.value;
  }
  if (def.exactLength) {
    res.minItems = def.exactLength.value;
    res.maxItems = def.exactLength.value;
  }
  return res;
}
__name(parseArrayDef, "parseArrayDef");
function parseBigintDef(def) {
  const res = {
    type: "integer",
    format: "int64"
  };
  if (!def.checks) return res;
  for (const check2 of def.checks) {
    switch (check2.kind) {
      case "min":
        if (check2.inclusive) {
          res.minimum = check2.value;
        } else {
          res.exclusiveMinimum = check2.value;
        }
        break;
      case "max":
        if (check2.inclusive) {
          res.maximum = check2.value;
        } else {
          res.exclusiveMaximum = check2.value;
        }
        break;
      case "multipleOf":
        res.multipleOf = check2.value;
        break;
    }
  }
  return res;
}
__name(parseBigintDef, "parseBigintDef");
function parseBooleanDef() {
  return {
    type: "boolean"
  };
}
__name(parseBooleanDef, "parseBooleanDef");
function parseBrandedDef(_def, refs) {
  return parseDef(_def.type._def, refs);
}
__name(parseBrandedDef, "parseBrandedDef");
var parseCatchDef = /* @__PURE__ */ __name((def, refs) => {
  return parseDef(def.innerType._def, refs);
}, "parseCatchDef");
function parseDateDef(def, refs, overrideDateStrategy) {
  const strategy = overrideDateStrategy != null ? overrideDateStrategy : refs.dateStrategy;
  if (Array.isArray(strategy)) {
    return {
      anyOf: strategy.map((item, i) => parseDateDef(def, refs, item))
    };
  }
  switch (strategy) {
    case "string":
    case "format:date-time":
      return {
        type: "string",
        format: "date-time"
      };
    case "format:date":
      return {
        type: "string",
        format: "date"
      };
    case "integer":
      return integerDateParser(def);
  }
}
__name(parseDateDef, "parseDateDef");
var integerDateParser = /* @__PURE__ */ __name((def) => {
  const res = {
    type: "integer",
    format: "unix-time"
  };
  for (const check2 of def.checks) {
    switch (check2.kind) {
      case "min":
        res.minimum = check2.value;
        break;
      case "max":
        res.maximum = check2.value;
        break;
    }
  }
  return res;
}, "integerDateParser");
function parseDefaultDef(_def, refs) {
  return {
    ...parseDef(_def.innerType._def, refs),
    default: _def.defaultValue()
  };
}
__name(parseDefaultDef, "parseDefaultDef");
function parseEffectsDef(_def, refs) {
  return refs.effectStrategy === "input" ? parseDef(_def.schema._def, refs) : parseAnyDef();
}
__name(parseEffectsDef, "parseEffectsDef");
function parseEnumDef(def) {
  return {
    type: "string",
    enum: Array.from(def.values)
  };
}
__name(parseEnumDef, "parseEnumDef");
var isJsonSchema7AllOfType = /* @__PURE__ */ __name((type) => {
  if ("type" in type && type.type === "string") return false;
  return "allOf" in type;
}, "isJsonSchema7AllOfType");
function parseIntersectionDef(def, refs) {
  const allOf = [
    parseDef(def.left._def, {
      ...refs,
      currentPath: [
        ...refs.currentPath,
        "allOf",
        "0"
      ]
    }),
    parseDef(def.right._def, {
      ...refs,
      currentPath: [
        ...refs.currentPath,
        "allOf",
        "1"
      ]
    })
  ].filter((x) => !!x);
  const mergedAllOf = [];
  allOf.forEach((schema) => {
    if (isJsonSchema7AllOfType(schema)) {
      mergedAllOf.push(...schema.allOf);
    } else {
      let nestedSchema = schema;
      if ("additionalProperties" in schema && schema.additionalProperties === false) {
        const { additionalProperties, ...rest } = schema;
        nestedSchema = rest;
      }
      mergedAllOf.push(nestedSchema);
    }
  });
  return mergedAllOf.length ? {
    allOf: mergedAllOf
  } : void 0;
}
__name(parseIntersectionDef, "parseIntersectionDef");
function parseLiteralDef(def) {
  const parsedType7 = typeof def.value;
  if (parsedType7 !== "bigint" && parsedType7 !== "number" && parsedType7 !== "boolean" && parsedType7 !== "string") {
    return {
      type: Array.isArray(def.value) ? "array" : "object"
    };
  }
  return {
    type: parsedType7 === "bigint" ? "integer" : parsedType7,
    const: def.value
  };
}
__name(parseLiteralDef, "parseLiteralDef");
var emojiRegex2 = void 0;
var zodPatterns = {
  /**
  * \`c\` was changed to \`[cC]\` to replicate /i flag
  */
  cuid: /^[cC][^\\s-]{8,}\$/,
  cuid2: /^[0-9a-z]+\$/,
  ulid: /^[0-9A-HJKMNP-TV-Z]{26}\$/,
  /**
  * \`a-z\` was added to replicate /i flag
  */
  email: /^(?!\\.)(?!.*\\.\\.)([a-zA-Z0-9_'+\\-\\.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.)+[a-zA-Z]{2,}\$/,
  /**
  * Constructed a valid Unicode RegExp
  *
  * Lazily instantiate since this type of regex isn't supported
  * in all envs (e.g. React Native).
  *
  * See:
  * https://github.com/colinhacks/zod/issues/2433
  * Fix in Zod:
  * https://github.com/colinhacks/zod/commit/9340fd51e48576a75adc919bff65dbc4a5d4c99b
  */
  emoji: /* @__PURE__ */ __name(() => {
    if (emojiRegex2 === void 0) {
      emojiRegex2 = RegExp("^(\\\\p{Extended_Pictographic}|\\\\p{Emoji_Component})+\$", "u");
    }
    return emojiRegex2;
  }, "emoji"),
  /**
  * Unused
  */
  uuid: /^[0-9a-fA-F]{8}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{12}\$/,
  /**
  * Unused
  */
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\$/,
  ipv4Cidr: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/(3[0-2]|[12]?[0-9])\$/,
  /**
  * Unused
  */
  ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))\$/,
  ipv6Cidr: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])\$/,
  base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?\$/,
  base64url: /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?\$/,
  nanoid: /^[a-zA-Z0-9_-]{21}\$/,
  jwt: /^[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]*\$/
};
function parseStringDef(def, refs) {
  const res = {
    type: "string"
  };
  if (def.checks) {
    for (const check2 of def.checks) {
      switch (check2.kind) {
        case "min":
          res.minLength = typeof res.minLength === "number" ? Math.max(res.minLength, check2.value) : check2.value;
          break;
        case "max":
          res.maxLength = typeof res.maxLength === "number" ? Math.min(res.maxLength, check2.value) : check2.value;
          break;
        case "email":
          switch (refs.emailStrategy) {
            case "format:email":
              addFormat(res, "email", check2.message, refs);
              break;
            case "format:idn-email":
              addFormat(res, "idn-email", check2.message, refs);
              break;
            case "pattern:zod":
              addPattern(res, zodPatterns.email, check2.message, refs);
              break;
          }
          break;
        case "url":
          addFormat(res, "uri", check2.message, refs);
          break;
        case "uuid":
          addFormat(res, "uuid", check2.message, refs);
          break;
        case "regex":
          addPattern(res, check2.regex, check2.message, refs);
          break;
        case "cuid":
          addPattern(res, zodPatterns.cuid, check2.message, refs);
          break;
        case "cuid2":
          addPattern(res, zodPatterns.cuid2, check2.message, refs);
          break;
        case "startsWith":
          addPattern(res, RegExp(\`^\${escapeLiteralCheckValue(check2.value, refs)}\`), check2.message, refs);
          break;
        case "endsWith":
          addPattern(res, RegExp(\`\${escapeLiteralCheckValue(check2.value, refs)}\$\`), check2.message, refs);
          break;
        case "datetime":
          addFormat(res, "date-time", check2.message, refs);
          break;
        case "date":
          addFormat(res, "date", check2.message, refs);
          break;
        case "time":
          addFormat(res, "time", check2.message, refs);
          break;
        case "duration":
          addFormat(res, "duration", check2.message, refs);
          break;
        case "length":
          res.minLength = typeof res.minLength === "number" ? Math.max(res.minLength, check2.value) : check2.value;
          res.maxLength = typeof res.maxLength === "number" ? Math.min(res.maxLength, check2.value) : check2.value;
          break;
        case "includes": {
          addPattern(res, RegExp(escapeLiteralCheckValue(check2.value, refs)), check2.message, refs);
          break;
        }
        case "ip": {
          if (check2.version !== "v6") {
            addFormat(res, "ipv4", check2.message, refs);
          }
          if (check2.version !== "v4") {
            addFormat(res, "ipv6", check2.message, refs);
          }
          break;
        }
        case "base64url":
          addPattern(res, zodPatterns.base64url, check2.message, refs);
          break;
        case "jwt":
          addPattern(res, zodPatterns.jwt, check2.message, refs);
          break;
        case "cidr": {
          if (check2.version !== "v6") {
            addPattern(res, zodPatterns.ipv4Cidr, check2.message, refs);
          }
          if (check2.version !== "v4") {
            addPattern(res, zodPatterns.ipv6Cidr, check2.message, refs);
          }
          break;
        }
        case "emoji":
          addPattern(res, zodPatterns.emoji(), check2.message, refs);
          break;
        case "ulid": {
          addPattern(res, zodPatterns.ulid, check2.message, refs);
          break;
        }
        case "base64": {
          switch (refs.base64Strategy) {
            case "format:binary": {
              addFormat(res, "binary", check2.message, refs);
              break;
            }
            case "contentEncoding:base64": {
              res.contentEncoding = "base64";
              break;
            }
            case "pattern:zod": {
              addPattern(res, zodPatterns.base64, check2.message, refs);
              break;
            }
          }
          break;
        }
        case "nanoid": {
          addPattern(res, zodPatterns.nanoid, check2.message, refs);
        }
        case "toLowerCase":
        case "toUpperCase":
        case "trim":
          break;
        default:
          /* @__PURE__ */ ((_) => {
          })(check2);
      }
    }
  }
  return res;
}
__name(parseStringDef, "parseStringDef");
function escapeLiteralCheckValue(literal2, refs) {
  return refs.patternStrategy === "escape" ? escapeNonAlphaNumeric(literal2) : literal2;
}
__name(escapeLiteralCheckValue, "escapeLiteralCheckValue");
var ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
function escapeNonAlphaNumeric(source) {
  let result = "";
  for (let i = 0; i < source.length; i++) {
    if (!ALPHA_NUMERIC.has(source[i])) {
      result += "\\\\";
    }
    result += source[i];
  }
  return result;
}
__name(escapeNonAlphaNumeric, "escapeNonAlphaNumeric");
function addFormat(schema, value, message, refs) {
  var _a17;
  if (schema.format || ((_a17 = schema.anyOf) == null ? void 0 : _a17.some((x) => x.format))) {
    if (!schema.anyOf) {
      schema.anyOf = [];
    }
    if (schema.format) {
      schema.anyOf.push({
        format: schema.format
      });
      delete schema.format;
    }
    schema.anyOf.push({
      format: value,
      ...message && refs.errorMessages && {
        errorMessage: {
          format: message
        }
      }
    });
  } else {
    schema.format = value;
  }
}
__name(addFormat, "addFormat");
function addPattern(schema, regex, message, refs) {
  var _a17;
  if (schema.pattern || ((_a17 = schema.allOf) == null ? void 0 : _a17.some((x) => x.pattern))) {
    if (!schema.allOf) {
      schema.allOf = [];
    }
    if (schema.pattern) {
      schema.allOf.push({
        pattern: schema.pattern
      });
      delete schema.pattern;
    }
    schema.allOf.push({
      pattern: stringifyRegExpWithFlags(regex, refs),
      ...message && refs.errorMessages && {
        errorMessage: {
          pattern: message
        }
      }
    });
  } else {
    schema.pattern = stringifyRegExpWithFlags(regex, refs);
  }
}
__name(addPattern, "addPattern");
function stringifyRegExpWithFlags(regex, refs) {
  var _a17;
  if (!refs.applyRegexFlags || !regex.flags) {
    return regex.source;
  }
  const flags = {
    i: regex.flags.includes("i"),
    // Case-insensitive
    m: regex.flags.includes("m"),
    // \`^\` and \`\$\` matches adjacent to newline characters
    s: regex.flags.includes("s")
  };
  const source = flags.i ? regex.source.toLowerCase() : regex.source;
  let pattern = "";
  let isEscaped = false;
  let inCharGroup = false;
  let inCharRange = false;
  for (let i = 0; i < source.length; i++) {
    if (isEscaped) {
      pattern += source[i];
      isEscaped = false;
      continue;
    }
    if (flags.i) {
      if (inCharGroup) {
        if (source[i].match(/[a-z]/)) {
          if (inCharRange) {
            pattern += source[i];
            pattern += \`\${source[i - 2]}-\${source[i]}\`.toUpperCase();
            inCharRange = false;
          } else if (source[i + 1] === "-" && ((_a17 = source[i + 2]) == null ? void 0 : _a17.match(/[a-z]/))) {
            pattern += source[i];
            inCharRange = true;
          } else {
            pattern += \`\${source[i]}\${source[i].toUpperCase()}\`;
          }
          continue;
        }
      } else if (source[i].match(/[a-z]/)) {
        pattern += \`[\${source[i]}\${source[i].toUpperCase()}]\`;
        continue;
      }
    }
    if (flags.m) {
      if (source[i] === "^") {
        pattern += \`(^|(?<=[\\r
]))\`;
        continue;
      } else if (source[i] === "\$") {
        pattern += \`(\$|(?=[\\r
]))\`;
        continue;
      }
    }
    if (flags.s && source[i] === ".") {
      pattern += inCharGroup ? \`\${source[i]}\\r
\` : \`[\${source[i]}\\r
]\`;
      continue;
    }
    pattern += source[i];
    if (source[i] === "\\\\") {
      isEscaped = true;
    } else if (inCharGroup && source[i] === "]") {
      inCharGroup = false;
    } else if (!inCharGroup && source[i] === "[") {
      inCharGroup = true;
    }
  }
  try {
    new RegExp(pattern);
  } catch (e) {
    console.warn(\`Could not convert regex pattern at \${refs.currentPath.join("/")} to a flag-independent form! Falling back to the flag-ignorant source\`);
    return regex.source;
  }
  return pattern;
}
__name(stringifyRegExpWithFlags, "stringifyRegExpWithFlags");
function parseRecordDef(def, refs) {
  var _a17, _b8, _c, _d, _e, _f;
  const schema = {
    type: "object",
    additionalProperties: (_a17 = parseDef(def.valueType._def, {
      ...refs,
      currentPath: [
        ...refs.currentPath,
        "additionalProperties"
      ]
    })) != null ? _a17 : refs.allowedAdditionalProperties
  };
  if (((_b8 = def.keyType) == null ? void 0 : _b8._def.typeName) === ZodFirstPartyTypeKind2.ZodString && ((_c = def.keyType._def.checks) == null ? void 0 : _c.length)) {
    const { type, ...keyType } = parseStringDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  } else if (((_d = def.keyType) == null ? void 0 : _d._def.typeName) === ZodFirstPartyTypeKind2.ZodEnum) {
    return {
      ...schema,
      propertyNames: {
        enum: def.keyType._def.values
      }
    };
  } else if (((_e = def.keyType) == null ? void 0 : _e._def.typeName) === ZodFirstPartyTypeKind2.ZodBranded && def.keyType._def.type._def.typeName === ZodFirstPartyTypeKind2.ZodString && ((_f = def.keyType._def.type._def.checks) == null ? void 0 : _f.length)) {
    const { type, ...keyType } = parseBrandedDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  }
  return schema;
}
__name(parseRecordDef, "parseRecordDef");
function parseMapDef(def, refs) {
  if (refs.mapStrategy === "record") {
    return parseRecordDef(def, refs);
  }
  const keys = parseDef(def.keyType._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "items",
      "items",
      "0"
    ]
  }) || parseAnyDef();
  const values = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "items",
      "items",
      "1"
    ]
  }) || parseAnyDef();
  return {
    type: "array",
    maxItems: 125,
    items: {
      type: "array",
      items: [
        keys,
        values
      ],
      minItems: 2,
      maxItems: 2
    }
  };
}
__name(parseMapDef, "parseMapDef");
function parseNativeEnumDef(def) {
  const object3 = def.values;
  const actualKeys = Object.keys(def.values).filter((key) => {
    return typeof object3[object3[key]] !== "number";
  });
  const actualValues = actualKeys.map((key) => object3[key]);
  const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
  return {
    type: parsedTypes.length === 1 ? parsedTypes[0] === "string" ? "string" : "number" : [
      "string",
      "number"
    ],
    enum: actualValues
  };
}
__name(parseNativeEnumDef, "parseNativeEnumDef");
function parseNeverDef() {
  return {
    not: parseAnyDef()
  };
}
__name(parseNeverDef, "parseNeverDef");
function parseNullDef() {
  return {
    type: "null"
  };
}
__name(parseNullDef, "parseNullDef");
var primitiveMappings = {
  ZodString: "string",
  ZodNumber: "number",
  ZodBigInt: "integer",
  ZodBoolean: "boolean",
  ZodNull: "null"
};
function parseUnionDef(def, refs) {
  const options = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
  if (options.every((x) => x._def.typeName in primitiveMappings && (!x._def.checks || !x._def.checks.length))) {
    const types = options.reduce((types2, x) => {
      const type = primitiveMappings[x._def.typeName];
      return type && !types2.includes(type) ? [
        ...types2,
        type
      ] : types2;
    }, []);
    return {
      type: types.length > 1 ? types : types[0]
    };
  } else if (options.every((x) => x._def.typeName === "ZodLiteral" && !x.description)) {
    const types = options.reduce((acc, x) => {
      const type = typeof x._def.value;
      switch (type) {
        case "string":
        case "number":
        case "boolean":
          return [
            ...acc,
            type
          ];
        case "bigint":
          return [
            ...acc,
            "integer"
          ];
        case "object":
          if (x._def.value === null) return [
            ...acc,
            "null"
          ];
        case "symbol":
        case "undefined":
        case "function":
        default:
          return acc;
      }
    }, []);
    if (types.length === options.length) {
      const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
      return {
        type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0],
        enum: options.reduce((acc, x) => {
          return acc.includes(x._def.value) ? acc : [
            ...acc,
            x._def.value
          ];
        }, [])
      };
    }
  } else if (options.every((x) => x._def.typeName === "ZodEnum")) {
    return {
      type: "string",
      enum: options.reduce((acc, x) => [
        ...acc,
        ...x._def.values.filter((x2) => !acc.includes(x2))
      ], [])
    };
  }
  return asAnyOf(def, refs);
}
__name(parseUnionDef, "parseUnionDef");
var asAnyOf = /* @__PURE__ */ __name((def, refs) => {
  const anyOf = (def.options instanceof Map ? Array.from(def.options.values()) : def.options).map((x, i) => parseDef(x._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "anyOf",
      \`\${i}\`
    ]
  })).filter((x) => !!x && (!refs.strictUnions || typeof x === "object" && Object.keys(x).length > 0));
  return anyOf.length ? {
    anyOf
  } : void 0;
}, "asAnyOf");
function parseNullableDef(def, refs) {
  if ([
    "ZodString",
    "ZodNumber",
    "ZodBigInt",
    "ZodBoolean",
    "ZodNull"
  ].includes(def.innerType._def.typeName) && (!def.innerType._def.checks || !def.innerType._def.checks.length)) {
    return {
      type: [
        primitiveMappings[def.innerType._def.typeName],
        "null"
      ]
    };
  }
  const base = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "anyOf",
      "0"
    ]
  });
  return base && {
    anyOf: [
      base,
      {
        type: "null"
      }
    ]
  };
}
__name(parseNullableDef, "parseNullableDef");
function parseNumberDef(def) {
  const res = {
    type: "number"
  };
  if (!def.checks) return res;
  for (const check2 of def.checks) {
    switch (check2.kind) {
      case "int":
        res.type = "integer";
        break;
      case "min":
        if (check2.inclusive) {
          res.minimum = check2.value;
        } else {
          res.exclusiveMinimum = check2.value;
        }
        break;
      case "max":
        if (check2.inclusive) {
          res.maximum = check2.value;
        } else {
          res.exclusiveMaximum = check2.value;
        }
        break;
      case "multipleOf":
        res.multipleOf = check2.value;
        break;
    }
  }
  return res;
}
__name(parseNumberDef, "parseNumberDef");
function parseObjectDef(def, refs) {
  const result = {
    type: "object",
    properties: {}
  };
  const required2 = [];
  const shape = def.shape();
  for (const propName in shape) {
    let propDef = shape[propName];
    if (propDef === void 0 || propDef._def === void 0) {
      continue;
    }
    const propOptional = safeIsOptional(propDef);
    const parsedDef = parseDef(propDef._def, {
      ...refs,
      currentPath: [
        ...refs.currentPath,
        "properties",
        propName
      ],
      propertyPath: [
        ...refs.currentPath,
        "properties",
        propName
      ]
    });
    if (parsedDef === void 0) {
      continue;
    }
    result.properties[propName] = parsedDef;
    if (!propOptional) {
      required2.push(propName);
    }
  }
  if (required2.length) {
    result.required = required2;
  }
  const additionalProperties = decideAdditionalProperties(def, refs);
  if (additionalProperties !== void 0) {
    result.additionalProperties = additionalProperties;
  }
  return result;
}
__name(parseObjectDef, "parseObjectDef");
function decideAdditionalProperties(def, refs) {
  if (def.catchall._def.typeName !== "ZodNever") {
    return parseDef(def.catchall._def, {
      ...refs,
      currentPath: [
        ...refs.currentPath,
        "additionalProperties"
      ]
    });
  }
  switch (def.unknownKeys) {
    case "passthrough":
      return refs.allowedAdditionalProperties;
    case "strict":
      return refs.rejectedAdditionalProperties;
    case "strip":
      return refs.removeAdditionalStrategy === "strict" ? refs.allowedAdditionalProperties : refs.rejectedAdditionalProperties;
  }
}
__name(decideAdditionalProperties, "decideAdditionalProperties");
function safeIsOptional(schema) {
  try {
    return schema.isOptional();
  } catch (e) {
    return true;
  }
}
__name(safeIsOptional, "safeIsOptional");
var parseOptionalDef = /* @__PURE__ */ __name((def, refs) => {
  var _a17;
  if (refs.currentPath.toString() === ((_a17 = refs.propertyPath) == null ? void 0 : _a17.toString())) {
    return parseDef(def.innerType._def, refs);
  }
  const innerSchema = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "anyOf",
      "1"
    ]
  });
  return innerSchema ? {
    anyOf: [
      {
        not: parseAnyDef()
      },
      innerSchema
    ]
  } : parseAnyDef();
}, "parseOptionalDef");
var parsePipelineDef = /* @__PURE__ */ __name((def, refs) => {
  if (refs.pipeStrategy === "input") {
    return parseDef(def.in._def, refs);
  } else if (refs.pipeStrategy === "output") {
    return parseDef(def.out._def, refs);
  }
  const a = parseDef(def.in._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "allOf",
      "0"
    ]
  });
  const b = parseDef(def.out._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "allOf",
      a ? "1" : "0"
    ]
  });
  return {
    allOf: [
      a,
      b
    ].filter((x) => x !== void 0)
  };
}, "parsePipelineDef");
function parsePromiseDef(def, refs) {
  return parseDef(def.type._def, refs);
}
__name(parsePromiseDef, "parsePromiseDef");
function parseSetDef(def, refs) {
  const items = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [
      ...refs.currentPath,
      "items"
    ]
  });
  const schema = {
    type: "array",
    uniqueItems: true,
    items
  };
  if (def.minSize) {
    schema.minItems = def.minSize.value;
  }
  if (def.maxSize) {
    schema.maxItems = def.maxSize.value;
  }
  return schema;
}
__name(parseSetDef, "parseSetDef");
function parseTupleDef(def, refs) {
  if (def.rest) {
    return {
      type: "array",
      minItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [
          ...refs.currentPath,
          "items",
          \`\${i}\`
        ]
      })).reduce((acc, x) => x === void 0 ? acc : [
        ...acc,
        x
      ], []),
      additionalItems: parseDef(def.rest._def, {
        ...refs,
        currentPath: [
          ...refs.currentPath,
          "additionalItems"
        ]
      })
    };
  } else {
    return {
      type: "array",
      minItems: def.items.length,
      maxItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [
          ...refs.currentPath,
          "items",
          \`\${i}\`
        ]
      })).reduce((acc, x) => x === void 0 ? acc : [
        ...acc,
        x
      ], [])
    };
  }
}
__name(parseTupleDef, "parseTupleDef");
function parseUndefinedDef() {
  return {
    not: parseAnyDef()
  };
}
__name(parseUndefinedDef, "parseUndefinedDef");
function parseUnknownDef() {
  return parseAnyDef();
}
__name(parseUnknownDef, "parseUnknownDef");
var parseReadonlyDef = /* @__PURE__ */ __name((def, refs) => {
  return parseDef(def.innerType._def, refs);
}, "parseReadonlyDef");
var selectParser = /* @__PURE__ */ __name((def, typeName, refs) => {
  switch (typeName) {
    case ZodFirstPartyTypeKind2.ZodString:
      return parseStringDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodNumber:
      return parseNumberDef(def);
    case ZodFirstPartyTypeKind2.ZodObject:
      return parseObjectDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodBigInt:
      return parseBigintDef(def);
    case ZodFirstPartyTypeKind2.ZodBoolean:
      return parseBooleanDef();
    case ZodFirstPartyTypeKind2.ZodDate:
      return parseDateDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodUndefined:
      return parseUndefinedDef();
    case ZodFirstPartyTypeKind2.ZodNull:
      return parseNullDef();
    case ZodFirstPartyTypeKind2.ZodArray:
      return parseArrayDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodUnion:
    case ZodFirstPartyTypeKind2.ZodDiscriminatedUnion:
      return parseUnionDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodIntersection:
      return parseIntersectionDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodTuple:
      return parseTupleDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodRecord:
      return parseRecordDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodLiteral:
      return parseLiteralDef(def);
    case ZodFirstPartyTypeKind2.ZodEnum:
      return parseEnumDef(def);
    case ZodFirstPartyTypeKind2.ZodNativeEnum:
      return parseNativeEnumDef(def);
    case ZodFirstPartyTypeKind2.ZodNullable:
      return parseNullableDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodOptional:
      return parseOptionalDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodMap:
      return parseMapDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodSet:
      return parseSetDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodLazy:
      return () => def.getter()._def;
    case ZodFirstPartyTypeKind2.ZodPromise:
      return parsePromiseDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodNaN:
    case ZodFirstPartyTypeKind2.ZodNever:
      return parseNeverDef();
    case ZodFirstPartyTypeKind2.ZodEffects:
      return parseEffectsDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodAny:
      return parseAnyDef();
    case ZodFirstPartyTypeKind2.ZodUnknown:
      return parseUnknownDef();
    case ZodFirstPartyTypeKind2.ZodDefault:
      return parseDefaultDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodBranded:
      return parseBrandedDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodReadonly:
      return parseReadonlyDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodCatch:
      return parseCatchDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodPipeline:
      return parsePipelineDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodFunction:
    case ZodFirstPartyTypeKind2.ZodVoid:
    case ZodFirstPartyTypeKind2.ZodSymbol:
      return void 0;
    default:
      return /* @__PURE__ */ ((_) => void 0)(typeName);
  }
}, "selectParser");
function parseDef(def, refs, forceResolution = false) {
  var _a17;
  const seenItem = refs.seen.get(def);
  if (refs.override) {
    const overrideResult = (_a17 = refs.override) == null ? void 0 : _a17.call(refs, def, refs, seenItem, forceResolution);
    if (overrideResult !== ignoreOverride) {
      return overrideResult;
    }
  }
  if (seenItem && !forceResolution) {
    const seenSchema = get\$ref(seenItem, refs);
    if (seenSchema !== void 0) {
      return seenSchema;
    }
  }
  const newItem = {
    def,
    path: refs.currentPath,
    jsonSchema: void 0
  };
  refs.seen.set(def, newItem);
  const jsonSchemaOrGetter = selectParser(def, def.typeName, refs);
  const jsonSchema2 = typeof jsonSchemaOrGetter === "function" ? parseDef(jsonSchemaOrGetter(), refs) : jsonSchemaOrGetter;
  if (jsonSchema2) {
    addMeta(def, refs, jsonSchema2);
  }
  if (refs.postProcess) {
    const postProcessResult = refs.postProcess(jsonSchema2, def, refs);
    newItem.jsonSchema = jsonSchema2;
    return postProcessResult;
  }
  newItem.jsonSchema = jsonSchema2;
  return jsonSchema2;
}
__name(parseDef, "parseDef");
var get\$ref = /* @__PURE__ */ __name((item, refs) => {
  switch (refs.\$refStrategy) {
    case "root":
      return {
        \$ref: item.path.join("/")
      };
    case "relative":
      return {
        \$ref: getRelativePath(refs.currentPath, item.path)
      };
    case "none":
    case "seen": {
      if (item.path.length < refs.currentPath.length && item.path.every((value, index) => refs.currentPath[index] === value)) {
        console.warn(\`Recursive reference detected at \${refs.currentPath.join("/")}! Defaulting to any\`);
        return parseAnyDef();
      }
      return refs.\$refStrategy === "seen" ? parseAnyDef() : void 0;
    }
  }
}, "get\$ref");
var addMeta = /* @__PURE__ */ __name((def, refs, jsonSchema2) => {
  if (def.description) {
    jsonSchema2.description = def.description;
  }
  return jsonSchema2;
}, "addMeta");
var getRefs = /* @__PURE__ */ __name((options) => {
  const _options = getDefaultOptions(options);
  const currentPath = _options.name !== void 0 ? [
    ..._options.basePath,
    _options.definitionPath,
    _options.name
  ] : _options.basePath;
  return {
    ..._options,
    currentPath,
    propertyPath: void 0,
    seen: new Map(Object.entries(_options.definitions).map(([name17, def]) => [
      def._def,
      {
        def: def._def,
        path: [
          ..._options.basePath,
          _options.definitionPath,
          name17
        ],
        // Resolution of references will be forced even though seen, so it's ok that the schema is undefined here for now.
        jsonSchema: void 0
      }
    ]))
  };
}, "getRefs");
var zodToJsonSchema = /* @__PURE__ */ __name((schema, options) => {
  var _a17;
  const refs = getRefs(options);
  let definitions = typeof options === "object" && options.definitions ? Object.entries(options.definitions).reduce((acc, [name24, schema2]) => {
    var _a24;
    return {
      ...acc,
      [name24]: (_a24 = parseDef(schema2._def, {
        ...refs,
        currentPath: [
          ...refs.basePath,
          refs.definitionPath,
          name24
        ]
      }, true)) != null ? _a24 : parseAnyDef()
    };
  }, {}) : void 0;
  const name17 = typeof options === "string" ? options : (options == null ? void 0 : options.nameStrategy) === "title" ? void 0 : options == null ? void 0 : options.name;
  const main = (_a17 = parseDef(schema._def, name17 === void 0 ? refs : {
    ...refs,
    currentPath: [
      ...refs.basePath,
      refs.definitionPath,
      name17
    ]
  }, false)) != null ? _a17 : parseAnyDef();
  const title = typeof options === "object" && options.name !== void 0 && options.nameStrategy === "title" ? options.name : void 0;
  if (title !== void 0) {
    main.title = title;
  }
  const combined = name17 === void 0 ? definitions ? {
    ...main,
    [refs.definitionPath]: definitions
  } : main : {
    \$ref: [
      ...refs.\$refStrategy === "relative" ? [] : refs.basePath,
      refs.definitionPath,
      name17
    ].join("/"),
    [refs.definitionPath]: {
      ...definitions,
      [name17]: main
    }
  };
  combined.\$schema = "http://json-schema.org/draft-07/schema#";
  return combined;
}, "zodToJsonSchema");
var zod_to_json_schema_default = zodToJsonSchema;
function zod3Schema(zodSchema2, options) {
  var _a17;
  const useReferences = (_a17 = options == null ? void 0 : options.useReferences) != null ? _a17 : false;
  return jsonSchema(
    // defer json schema creation to avoid unnecessary computation when only validation is needed
    () => zod_to_json_schema_default(zodSchema2, {
      \$refStrategy: useReferences ? "root" : "none"
    }),
    {
      validate: /* @__PURE__ */ __name(async (value) => {
        const result = await zodSchema2.safeParseAsync(value);
        return result.success ? {
          success: true,
          value: result.data
        } : {
          success: false,
          error: result.error
        };
      }, "validate")
    }
  );
}
__name(zod3Schema, "zod3Schema");
function zod4Schema(zodSchema2, options) {
  var _a17;
  const useReferences = (_a17 = options == null ? void 0 : options.useReferences) != null ? _a17 : false;
  return jsonSchema(
    // defer json schema creation to avoid unnecessary computation when only validation is needed
    () => toJSONSchema(zodSchema2, {
      target: "draft-7",
      io: "output",
      reused: useReferences ? "ref" : "inline"
    }),
    {
      validate: /* @__PURE__ */ __name(async (value) => {
        const result = await safeParseAsync2(zodSchema2, value);
        return result.success ? {
          success: true,
          value: result.data
        } : {
          success: false,
          error: result.error
        };
      }, "validate")
    }
  );
}
__name(zod4Schema, "zod4Schema");
function isZod4Schema(zodSchema2) {
  return "_zod" in zodSchema2;
}
__name(isZod4Schema, "isZod4Schema");
function zodSchema(zodSchema2, options) {
  if (isZod4Schema(zodSchema2)) {
    return zod4Schema(zodSchema2, options);
  } else {
    return zod3Schema(zodSchema2, options);
  }
}
__name(zodSchema, "zodSchema");
var schemaSymbol = Symbol.for("vercel.ai.schema");
function jsonSchema(jsonSchema2, { validate } = {}) {
  return {
    [schemaSymbol]: true,
    _type: void 0,
    // should never be used directly
    [validatorSymbol]: true,
    get jsonSchema() {
      if (typeof jsonSchema2 === "function") {
        jsonSchema2 = jsonSchema2();
      }
      return jsonSchema2;
    },
    validate
  };
}
__name(jsonSchema, "jsonSchema");
function isSchema(value) {
  return typeof value === "object" && value !== null && schemaSymbol in value && value[schemaSymbol] === true && "jsonSchema" in value && "validate" in value;
}
__name(isSchema, "isSchema");
function asSchema(schema) {
  return schema == null ? jsonSchema({
    properties: {},
    additionalProperties: false
  }) : isSchema(schema) ? schema : typeof schema === "function" ? schema() : zodSchema(schema);
}
__name(asSchema, "asSchema");
var { btoa: btoa2, atob: atob2 } = globalThis;
function convertBase64ToUint8Array(base64String) {
  const base64Url = base64String.replace(/-/g, "+").replace(/_/g, "/");
  const latin1string = atob2(base64Url);
  return Uint8Array.from(latin1string, (byte) => byte.codePointAt(0));
}
__name(convertBase64ToUint8Array, "convertBase64ToUint8Array");
function convertUint8ArrayToBase64(array2) {
  let latin1string = "";
  for (let i = 0; i < array2.length; i++) {
    latin1string += String.fromCodePoint(array2[i]);
  }
  return btoa2(latin1string);
}
__name(convertUint8ArrayToBase64, "convertUint8ArrayToBase64");
function withoutTrailingSlash(url2) {
  return url2 == null ? void 0 : url2.replace(/\\/\$/, "");
}
__name(withoutTrailingSlash, "withoutTrailingSlash");
function isAsyncIterable(obj) {
  return obj != null && typeof obj[Symbol.asyncIterator] === "function";
}
__name(isAsyncIterable, "isAsyncIterable");
async function* executeTool({ execute, input, options }) {
  const result = execute(input, options);
  if (isAsyncIterable(result)) {
    let lastOutput;
    for await (const output of result) {
      lastOutput = output;
      yield {
        type: "preliminary",
        output
      };
    }
    yield {
      type: "final",
      output: lastOutput
    };
  } else {
    yield {
      type: "final",
      output: await result
    };
  }
}
__name(executeTool, "executeTool");

// ../../node_modules/.pnpm/@ai-sdk+gateway@2.0.0_zod@4.1.11/node_modules/@ai-sdk/gateway/dist/index.mjs
var import_oidc = __toESM(require_index_browser(), 1);
var import_oidc2 = __toESM(require_index_browser(), 1);
var marker15 = "vercel.ai.gateway.error";
var symbol16 = Symbol.for(marker15);
var _a15;
var _b;
var GatewayError = class _GatewayError extends (_b = Error, _a15 = symbol16, _b) {
  static {
    __name(this, "_GatewayError");
  }
  constructor({ message, statusCode = 500, cause }) {
    super(message);
    this[_a15] = true;
    this.statusCode = statusCode;
    this.cause = cause;
  }
  /**
  * Checks if the given error is a Gateway Error.
  * @param {unknown} error - The error to check.
  * @returns {boolean} True if the error is a Gateway Error, false otherwise.
  */
  static isInstance(error45) {
    return _GatewayError.hasMarker(error45);
  }
  static hasMarker(error45) {
    return typeof error45 === "object" && error45 !== null && symbol16 in error45 && error45[symbol16] === true;
  }
};
var name14 = "GatewayAuthenticationError";
var marker22 = \`vercel.ai.gateway.error.\${name14}\`;
var symbol22 = Symbol.for(marker22);
var _a22;
var _b2;
var GatewayAuthenticationError = class _GatewayAuthenticationError extends (_b2 = GatewayError, _a22 = symbol22, _b2) {
  static {
    __name(this, "_GatewayAuthenticationError");
  }
  constructor({ message = "Authentication failed", statusCode = 401, cause } = {}) {
    super({
      message,
      statusCode,
      cause
    });
    this[_a22] = true;
    this.name = name14;
    this.type = "authentication_error";
  }
  static isInstance(error45) {
    return GatewayError.hasMarker(error45) && symbol22 in error45;
  }
  /**
  * Creates a contextual error message when authentication fails
  */
  static createContextualError({ apiKeyProvided, oidcTokenProvided, message = "Authentication failed", statusCode = 401, cause }) {
    let contextualMessage;
    if (apiKeyProvided) {
      contextualMessage = \`AI Gateway authentication failed: Invalid API key.

Create a new API key: https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys

Provide via 'apiKey' option or 'AI_GATEWAY_API_KEY' environment variable.\`;
    } else if (oidcTokenProvided) {
      contextualMessage = \`AI Gateway authentication failed: Invalid OIDC token.

Run 'npx vercel link' to link your project, then 'vc env pull' to fetch the token.

Alternatively, use an API key: https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys\`;
    } else {
      contextualMessage = \`AI Gateway authentication failed: No authentication provided.

Option 1 - API key:
Create an API key: https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys
Provide via 'apiKey' option or 'AI_GATEWAY_API_KEY' environment variable.

Option 2 - OIDC token:
Run 'npx vercel link' to link your project, then 'vc env pull' to fetch the token.\`;
    }
    return new _GatewayAuthenticationError({
      message: contextualMessage,
      statusCode,
      cause
    });
  }
};
var name22 = "GatewayInvalidRequestError";
var marker32 = \`vercel.ai.gateway.error.\${name22}\`;
var symbol32 = Symbol.for(marker32);
var _a32;
var _b3;
var GatewayInvalidRequestError = class extends (_b3 = GatewayError, _a32 = symbol32, _b3) {
  static {
    __name(this, "GatewayInvalidRequestError");
  }
  constructor({ message = "Invalid request", statusCode = 400, cause } = {}) {
    super({
      message,
      statusCode,
      cause
    });
    this[_a32] = true;
    this.name = name22;
    this.type = "invalid_request_error";
  }
  static isInstance(error45) {
    return GatewayError.hasMarker(error45) && symbol32 in error45;
  }
};
var name32 = "GatewayRateLimitError";
var marker42 = \`vercel.ai.gateway.error.\${name32}\`;
var symbol42 = Symbol.for(marker42);
var _a42;
var _b4;
var GatewayRateLimitError = class extends (_b4 = GatewayError, _a42 = symbol42, _b4) {
  static {
    __name(this, "GatewayRateLimitError");
  }
  constructor({ message = "Rate limit exceeded", statusCode = 429, cause } = {}) {
    super({
      message,
      statusCode,
      cause
    });
    this[_a42] = true;
    this.name = name32;
    this.type = "rate_limit_exceeded";
  }
  static isInstance(error45) {
    return GatewayError.hasMarker(error45) && symbol42 in error45;
  }
};
var name42 = "GatewayModelNotFoundError";
var marker52 = \`vercel.ai.gateway.error.\${name42}\`;
var symbol52 = Symbol.for(marker52);
var modelNotFoundParamSchema = lazyValidator(() => zodSchema(external_exports.object({
  modelId: external_exports.string()
})));
var _a52;
var _b5;
var GatewayModelNotFoundError = class extends (_b5 = GatewayError, _a52 = symbol52, _b5) {
  static {
    __name(this, "GatewayModelNotFoundError");
  }
  constructor({ message = "Model not found", statusCode = 404, modelId, cause } = {}) {
    super({
      message,
      statusCode,
      cause
    });
    this[_a52] = true;
    this.name = name42;
    this.type = "model_not_found";
    this.modelId = modelId;
  }
  static isInstance(error45) {
    return GatewayError.hasMarker(error45) && symbol52 in error45;
  }
};
var name52 = "GatewayInternalServerError";
var marker62 = \`vercel.ai.gateway.error.\${name52}\`;
var symbol62 = Symbol.for(marker62);
var _a62;
var _b6;
var GatewayInternalServerError = class extends (_b6 = GatewayError, _a62 = symbol62, _b6) {
  static {
    __name(this, "GatewayInternalServerError");
  }
  constructor({ message = "Internal server error", statusCode = 500, cause } = {}) {
    super({
      message,
      statusCode,
      cause
    });
    this[_a62] = true;
    this.name = name52;
    this.type = "internal_server_error";
  }
  static isInstance(error45) {
    return GatewayError.hasMarker(error45) && symbol62 in error45;
  }
};
var name62 = "GatewayResponseError";
var marker72 = \`vercel.ai.gateway.error.\${name62}\`;
var symbol72 = Symbol.for(marker72);
var _a72;
var _b7;
var GatewayResponseError = class extends (_b7 = GatewayError, _a72 = symbol72, _b7) {
  static {
    __name(this, "GatewayResponseError");
  }
  constructor({ message = "Invalid response from Gateway", statusCode = 502, response, validationError, cause } = {}) {
    super({
      message,
      statusCode,
      cause
    });
    this[_a72] = true;
    this.name = name62;
    this.type = "response_error";
    this.response = response;
    this.validationError = validationError;
  }
  static isInstance(error45) {
    return GatewayError.hasMarker(error45) && symbol72 in error45;
  }
};
async function createGatewayErrorFromResponse({ response, statusCode, defaultMessage = "Gateway request failed", cause, authMethod }) {
  const parseResult = await safeValidateTypes({
    value: response,
    schema: gatewayErrorResponseSchema
  });
  if (!parseResult.success) {
    return new GatewayResponseError({
      message: \`Invalid error response format: \${defaultMessage}\`,
      statusCode,
      response,
      validationError: parseResult.error,
      cause
    });
  }
  const validatedResponse = parseResult.value;
  const errorType = validatedResponse.error.type;
  const message = validatedResponse.error.message;
  switch (errorType) {
    case "authentication_error":
      return GatewayAuthenticationError.createContextualError({
        apiKeyProvided: authMethod === "api-key",
        oidcTokenProvided: authMethod === "oidc",
        statusCode,
        cause
      });
    case "invalid_request_error":
      return new GatewayInvalidRequestError({
        message,
        statusCode,
        cause
      });
    case "rate_limit_exceeded":
      return new GatewayRateLimitError({
        message,
        statusCode,
        cause
      });
    case "model_not_found": {
      const modelResult = await safeValidateTypes({
        value: validatedResponse.error.param,
        schema: modelNotFoundParamSchema
      });
      return new GatewayModelNotFoundError({
        message,
        statusCode,
        modelId: modelResult.success ? modelResult.value.modelId : void 0,
        cause
      });
    }
    case "internal_server_error":
      return new GatewayInternalServerError({
        message,
        statusCode,
        cause
      });
    default:
      return new GatewayInternalServerError({
        message,
        statusCode,
        cause
      });
  }
}
__name(createGatewayErrorFromResponse, "createGatewayErrorFromResponse");
var gatewayErrorResponseSchema = lazyValidator(() => zodSchema(external_exports.object({
  error: external_exports.object({
    message: external_exports.string(),
    type: external_exports.string().nullish(),
    param: external_exports.unknown().nullish(),
    code: external_exports.union([
      external_exports.string(),
      external_exports.number()
    ]).nullish()
  })
})));
function asGatewayError(error45, authMethod) {
  var _a83;
  if (GatewayError.isInstance(error45)) {
    return error45;
  }
  if (APICallError.isInstance(error45)) {
    return createGatewayErrorFromResponse({
      response: extractApiCallResponse(error45),
      statusCode: (_a83 = error45.statusCode) != null ? _a83 : 500,
      defaultMessage: "Gateway request failed",
      cause: error45,
      authMethod
    });
  }
  return createGatewayErrorFromResponse({
    response: {},
    statusCode: 500,
    defaultMessage: error45 instanceof Error ? \`Gateway request failed: \${error45.message}\` : "Unknown Gateway error",
    cause: error45,
    authMethod
  });
}
__name(asGatewayError, "asGatewayError");
function extractApiCallResponse(error45) {
  if (error45.data !== void 0) {
    return error45.data;
  }
  if (error45.responseBody != null) {
    try {
      return JSON.parse(error45.responseBody);
    } catch (e) {
      return error45.responseBody;
    }
  }
  return {};
}
__name(extractApiCallResponse, "extractApiCallResponse");
var GATEWAY_AUTH_METHOD_HEADER = "ai-gateway-auth-method";
async function parseAuthMethod(headers) {
  const result = await safeValidateTypes({
    value: headers[GATEWAY_AUTH_METHOD_HEADER],
    schema: gatewayAuthMethodSchema
  });
  return result.success ? result.value : void 0;
}
__name(parseAuthMethod, "parseAuthMethod");
var gatewayAuthMethodSchema = lazyValidator(() => zodSchema(external_exports.union([
  external_exports.literal("api-key"),
  external_exports.literal("oidc")
])));
var GatewayFetchMetadata = class {
  static {
    __name(this, "GatewayFetchMetadata");
  }
  constructor(config2) {
    this.config = config2;
  }
  async getAvailableModels() {
    try {
      const { value } = await getFromApi({
        url: \`\${this.config.baseURL}/config\`,
        headers: await resolve(this.config.headers()),
        successfulResponseHandler: createJsonResponseHandler(gatewayAvailableModelsResponseSchema),
        failedResponseHandler: createJsonErrorResponseHandler({
          errorSchema: external_exports.any(),
          errorToMessage: /* @__PURE__ */ __name((data) => data, "errorToMessage")
        }),
        fetch: this.config.fetch
      });
      return value;
    } catch (error45) {
      throw await asGatewayError(error45);
    }
  }
  async getCredits() {
    try {
      const baseUrl = new URL(this.config.baseURL);
      const { value } = await getFromApi({
        url: \`\${baseUrl.origin}/v1/credits\`,
        headers: await resolve(this.config.headers()),
        successfulResponseHandler: createJsonResponseHandler(gatewayCreditsResponseSchema),
        failedResponseHandler: createJsonErrorResponseHandler({
          errorSchema: external_exports.any(),
          errorToMessage: /* @__PURE__ */ __name((data) => data, "errorToMessage")
        }),
        fetch: this.config.fetch
      });
      return value;
    } catch (error45) {
      throw await asGatewayError(error45);
    }
  }
};
var gatewayAvailableModelsResponseSchema = lazyValidator(() => zodSchema(external_exports.object({
  models: external_exports.array(external_exports.object({
    id: external_exports.string(),
    name: external_exports.string(),
    description: external_exports.string().nullish(),
    pricing: external_exports.object({
      input: external_exports.string(),
      output: external_exports.string(),
      input_cache_read: external_exports.string().nullish(),
      input_cache_write: external_exports.string().nullish()
    }).transform(({ input, output, input_cache_read, input_cache_write }) => ({
      input,
      output,
      ...input_cache_read ? {
        cachedInputTokens: input_cache_read
      } : {},
      ...input_cache_write ? {
        cacheCreationInputTokens: input_cache_write
      } : {}
    })).nullish(),
    specification: external_exports.object({
      specificationVersion: external_exports.literal("v2"),
      provider: external_exports.string(),
      modelId: external_exports.string()
    }),
    modelType: external_exports.enum([
      "language",
      "embedding",
      "image"
    ]).nullish()
  }))
})));
var gatewayCreditsResponseSchema = lazyValidator(() => zodSchema(external_exports.object({
  balance: external_exports.string(),
  total_used: external_exports.string()
}).transform(({ balance, total_used }) => ({
  balance,
  totalUsed: total_used
}))));
var GatewayLanguageModel = class {
  static {
    __name(this, "GatewayLanguageModel");
  }
  constructor(modelId, config2) {
    this.modelId = modelId;
    this.config = config2;
    this.specificationVersion = "v2";
    this.supportedUrls = {
      "*/*": [
        /.*/
      ]
    };
  }
  get provider() {
    return this.config.provider;
  }
  async getArgs(options) {
    const { abortSignal: _abortSignal, ...optionsWithoutSignal } = options;
    return {
      args: this.maybeEncodeFileParts(optionsWithoutSignal),
      warnings: []
    };
  }
  async doGenerate(options) {
    const { args, warnings } = await this.getArgs(options);
    const { abortSignal } = options;
    const resolvedHeaders = await resolve(this.config.headers());
    try {
      const { responseHeaders, value: responseBody, rawValue: rawResponse } = await postJsonToApi({
        url: this.getUrl(),
        headers: combineHeaders(resolvedHeaders, options.headers, this.getModelConfigHeaders(this.modelId, false), await resolve(this.config.o11yHeaders)),
        body: args,
        successfulResponseHandler: createJsonResponseHandler(external_exports.any()),
        failedResponseHandler: createJsonErrorResponseHandler({
          errorSchema: external_exports.any(),
          errorToMessage: /* @__PURE__ */ __name((data) => data, "errorToMessage")
        }),
        ...abortSignal && {
          abortSignal
        },
        fetch: this.config.fetch
      });
      return {
        ...responseBody,
        request: {
          body: args
        },
        response: {
          headers: responseHeaders,
          body: rawResponse
        },
        warnings
      };
    } catch (error45) {
      throw await asGatewayError(error45, await parseAuthMethod(resolvedHeaders));
    }
  }
  async doStream(options) {
    const { args, warnings } = await this.getArgs(options);
    const { abortSignal } = options;
    const resolvedHeaders = await resolve(this.config.headers());
    try {
      const { value: response, responseHeaders } = await postJsonToApi({
        url: this.getUrl(),
        headers: combineHeaders(resolvedHeaders, options.headers, this.getModelConfigHeaders(this.modelId, true), await resolve(this.config.o11yHeaders)),
        body: args,
        successfulResponseHandler: createEventSourceResponseHandler(external_exports.any()),
        failedResponseHandler: createJsonErrorResponseHandler({
          errorSchema: external_exports.any(),
          errorToMessage: /* @__PURE__ */ __name((data) => data, "errorToMessage")
        }),
        ...abortSignal && {
          abortSignal
        },
        fetch: this.config.fetch
      });
      return {
        stream: response.pipeThrough(new TransformStream({
          start(controller) {
            if (warnings.length > 0) {
              controller.enqueue({
                type: "stream-start",
                warnings
              });
            }
          },
          transform(chunk2, controller) {
            if (chunk2.success) {
              const streamPart = chunk2.value;
              if (streamPart.type === "raw" && !options.includeRawChunks) {
                return;
              }
              if (streamPart.type === "response-metadata" && streamPart.timestamp && typeof streamPart.timestamp === "string") {
                streamPart.timestamp = new Date(streamPart.timestamp);
              }
              controller.enqueue(streamPart);
            } else {
              controller.error(chunk2.error);
            }
          }
        })),
        request: {
          body: args
        },
        response: {
          headers: responseHeaders
        }
      };
    } catch (error45) {
      throw await asGatewayError(error45, await parseAuthMethod(resolvedHeaders));
    }
  }
  isFilePart(part) {
    return part && typeof part === "object" && "type" in part && part.type === "file";
  }
  /**
  * Encodes file parts in the prompt to base64. Mutates the passed options
  * instance directly to avoid copying the file data.
  * @param options - The options to encode.
  * @returns The options with the file parts encoded.
  */
  maybeEncodeFileParts(options) {
    for (const message of options.prompt) {
      for (const part of message.content) {
        if (this.isFilePart(part)) {
          const filePart = part;
          if (filePart.data instanceof Uint8Array) {
            const buffer = Uint8Array.from(filePart.data);
            const base64Data = Buffer.from(buffer).toString("base64");
            filePart.data = new URL(\`data:\${filePart.mediaType || "application/octet-stream"};base64,\${base64Data}\`);
          }
        }
      }
    }
    return options;
  }
  getUrl() {
    return \`\${this.config.baseURL}/language-model\`;
  }
  getModelConfigHeaders(modelId, streaming) {
    return {
      "ai-language-model-specification-version": "2",
      "ai-language-model-id": modelId,
      "ai-language-model-streaming": String(streaming)
    };
  }
};
var GatewayEmbeddingModel = class {
  static {
    __name(this, "GatewayEmbeddingModel");
  }
  constructor(modelId, config2) {
    this.modelId = modelId;
    this.config = config2;
    this.specificationVersion = "v2";
    this.maxEmbeddingsPerCall = 2048;
    this.supportsParallelCalls = true;
  }
  get provider() {
    return this.config.provider;
  }
  async doEmbed({ values, headers, abortSignal, providerOptions }) {
    var _a83;
    const resolvedHeaders = await resolve(this.config.headers());
    try {
      const { responseHeaders, value: responseBody, rawValue } = await postJsonToApi({
        url: this.getUrl(),
        headers: combineHeaders(resolvedHeaders, headers != null ? headers : {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
        body: {
          input: values.length === 1 ? values[0] : values,
          ...providerOptions ? {
            providerOptions
          } : {}
        },
        successfulResponseHandler: createJsonResponseHandler(gatewayEmbeddingResponseSchema),
        failedResponseHandler: createJsonErrorResponseHandler({
          errorSchema: external_exports.any(),
          errorToMessage: /* @__PURE__ */ __name((data) => data, "errorToMessage")
        }),
        ...abortSignal && {
          abortSignal
        },
        fetch: this.config.fetch
      });
      return {
        embeddings: responseBody.embeddings,
        usage: (_a83 = responseBody.usage) != null ? _a83 : void 0,
        providerMetadata: responseBody.providerMetadata,
        response: {
          headers: responseHeaders,
          body: rawValue
        }
      };
    } catch (error45) {
      throw await asGatewayError(error45, await parseAuthMethod(resolvedHeaders));
    }
  }
  getUrl() {
    return \`\${this.config.baseURL}/embedding-model\`;
  }
  getModelConfigHeaders() {
    return {
      "ai-embedding-model-specification-version": "2",
      "ai-model-id": this.modelId
    };
  }
};
var gatewayEmbeddingResponseSchema = lazyValidator(() => zodSchema(external_exports.object({
  embeddings: external_exports.array(external_exports.array(external_exports.number())),
  usage: external_exports.object({
    tokens: external_exports.number()
  }).nullish(),
  providerMetadata: external_exports.record(external_exports.string(), external_exports.record(external_exports.string(), external_exports.unknown())).optional()
})));
async function getVercelRequestId() {
  var _a83;
  return (_a83 = (0, import_oidc.getContext)().headers) == null ? void 0 : _a83["x-vercel-id"];
}
__name(getVercelRequestId, "getVercelRequestId");
var VERSION2 = true ? "2.0.0" : "0.0.0-test";
var AI_GATEWAY_PROTOCOL_VERSION = "0.0.1";
function createGatewayProvider(options = {}) {
  var _a83, _b8;
  let pendingMetadata = null;
  let metadataCache = null;
  const cacheRefreshMillis = (_a83 = options.metadataCacheRefreshMillis) != null ? _a83 : 1e3 * 60 * 5;
  let lastFetchTime = 0;
  const baseURL = (_b8 = withoutTrailingSlash(options.baseURL)) != null ? _b8 : "https://ai-gateway.vercel.sh/v1/ai";
  const getHeaders = /* @__PURE__ */ __name(async () => {
    const auth = await getGatewayAuthToken(options);
    if (auth) {
      return withUserAgentSuffix({
        Authorization: \`Bearer \${auth.token}\`,
        "ai-gateway-protocol-version": AI_GATEWAY_PROTOCOL_VERSION,
        [GATEWAY_AUTH_METHOD_HEADER]: auth.authMethod,
        ...options.headers
      }, \`ai-sdk/gateway/\${VERSION2}\`);
    }
    throw GatewayAuthenticationError.createContextualError({
      apiKeyProvided: false,
      oidcTokenProvided: false,
      statusCode: 401
    });
  }, "getHeaders");
  const createO11yHeaders = /* @__PURE__ */ __name(() => {
    const deploymentId = loadOptionalSetting({
      settingValue: void 0,
      environmentVariableName: "VERCEL_DEPLOYMENT_ID"
    });
    const environment = loadOptionalSetting({
      settingValue: void 0,
      environmentVariableName: "VERCEL_ENV"
    });
    const region = loadOptionalSetting({
      settingValue: void 0,
      environmentVariableName: "VERCEL_REGION"
    });
    return async () => {
      const requestId = await getVercelRequestId();
      return {
        ...deploymentId && {
          "ai-o11y-deployment-id": deploymentId
        },
        ...environment && {
          "ai-o11y-environment": environment
        },
        ...region && {
          "ai-o11y-region": region
        },
        ...requestId && {
          "ai-o11y-request-id": requestId
        }
      };
    };
  }, "createO11yHeaders");
  const createLanguageModel = /* @__PURE__ */ __name((modelId) => {
    return new GatewayLanguageModel(modelId, {
      provider: "gateway",
      baseURL,
      headers: getHeaders,
      fetch: options.fetch,
      o11yHeaders: createO11yHeaders()
    });
  }, "createLanguageModel");
  const getAvailableModels = /* @__PURE__ */ __name(async () => {
    var _a93, _b9, _c;
    const now2 = (_c = (_b9 = (_a93 = options._internal) == null ? void 0 : _a93.currentDate) == null ? void 0 : _b9.call(_a93).getTime()) != null ? _c : Date.now();
    if (!pendingMetadata || now2 - lastFetchTime > cacheRefreshMillis) {
      lastFetchTime = now2;
      pendingMetadata = new GatewayFetchMetadata({
        baseURL,
        headers: getHeaders,
        fetch: options.fetch
      }).getAvailableModels().then((metadata) => {
        metadataCache = metadata;
        return metadata;
      }).catch(async (error45) => {
        throw await asGatewayError(error45, await parseAuthMethod(await getHeaders()));
      });
    }
    return metadataCache ? Promise.resolve(metadataCache) : pendingMetadata;
  }, "getAvailableModels");
  const getCredits = /* @__PURE__ */ __name(async () => {
    return new GatewayFetchMetadata({
      baseURL,
      headers: getHeaders,
      fetch: options.fetch
    }).getCredits().catch(async (error45) => {
      throw await asGatewayError(error45, await parseAuthMethod(await getHeaders()));
    });
  }, "getCredits");
  const provider = /* @__PURE__ */ __name(function(modelId) {
    if (new.target) {
      throw new Error("The Gateway Provider model function cannot be called with the new keyword.");
    }
    return createLanguageModel(modelId);
  }, "provider");
  provider.getAvailableModels = getAvailableModels;
  provider.getCredits = getCredits;
  provider.imageModel = (modelId) => {
    throw new NoSuchModelError({
      modelId,
      modelType: "imageModel"
    });
  };
  provider.languageModel = createLanguageModel;
  provider.textEmbeddingModel = (modelId) => {
    return new GatewayEmbeddingModel(modelId, {
      provider: "gateway",
      baseURL,
      headers: getHeaders,
      fetch: options.fetch,
      o11yHeaders: createO11yHeaders()
    });
  };
  return provider;
}
__name(createGatewayProvider, "createGatewayProvider");
var gateway = createGatewayProvider();
async function getGatewayAuthToken(options) {
  const apiKey = loadOptionalSetting({
    settingValue: options.apiKey,
    environmentVariableName: "AI_GATEWAY_API_KEY"
  });
  if (apiKey) {
    return {
      token: apiKey,
      authMethod: "api-key"
    };
  }
  try {
    const oidcToken = await (0, import_oidc2.getVercelOidcToken)();
    return {
      token: oidcToken,
      authMethod: "oidc"
    };
  } catch (e) {
    return null;
  }
}
__name(getGatewayAuthToken, "getGatewayAuthToken");

// ../../node_modules/.pnpm/ai@5.0.76_zod@4.1.11/node_modules/ai/dist/index.mjs
var import_api = __toESM(require_src(), 1);
var import_api2 = __toESM(require_src(), 1);
var __defProp2 = Object.defineProperty;
var __export2 = /* @__PURE__ */ __name((target, all) => {
  for (var name17 in all) __defProp2(target, name17, {
    get: all[name17],
    enumerable: true
  });
}, "__export");
var name15 = "AI_NoOutputSpecifiedError";
var marker16 = \`vercel.ai.error.\${name15}\`;
var symbol17 = Symbol.for(marker16);
var _a16;
var NoOutputSpecifiedError = class extends AISDKError {
  static {
    __name(this, "NoOutputSpecifiedError");
  }
  // used in isInstance
  constructor({ message = "No output specified." } = {}) {
    super({
      name: name15,
      message
    });
    this[_a16] = true;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker16);
  }
};
_a16 = symbol17;
function formatWarning(warning) {
  const prefix = "AI SDK Warning:";
  switch (warning.type) {
    case "unsupported-setting": {
      let message = \`\${prefix} The "\${warning.setting}" setting is not supported by this model\`;
      if (warning.details) {
        message += \` - \${warning.details}\`;
      }
      return message;
    }
    case "unsupported-tool": {
      const toolName = "name" in warning.tool ? warning.tool.name : "unknown tool";
      let message = \`\${prefix} The tool "\${toolName}" is not supported by this model\`;
      if (warning.details) {
        message += \` - \${warning.details}\`;
      }
      return message;
    }
    case "other": {
      return \`\${prefix} \${warning.message}\`;
    }
    default: {
      return \`\${prefix} \${JSON.stringify(warning, null, 2)}\`;
    }
  }
}
__name(formatWarning, "formatWarning");
var FIRST_WARNING_INFO_MESSAGE = "AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.";
var hasLoggedBefore = false;
var logWarnings = /* @__PURE__ */ __name((warnings) => {
  if (warnings.length === 0) {
    return;
  }
  const logger = globalThis.AI_SDK_LOG_WARNINGS;
  if (logger === false) {
    return;
  }
  if (typeof logger === "function") {
    logger(warnings);
    return;
  }
  if (!hasLoggedBefore) {
    hasLoggedBefore = true;
    console.info(FIRST_WARNING_INFO_MESSAGE);
  }
  for (const warning of warnings) {
    console.warn(formatWarning(warning));
  }
}, "logWarnings");
var name23 = "AI_InvalidArgumentError";
var marker23 = \`vercel.ai.error.\${name23}\`;
var symbol23 = Symbol.for(marker23);
var _a23;
var InvalidArgumentError2 = class extends AISDKError {
  static {
    __name(this, "InvalidArgumentError");
  }
  constructor({ parameter, value, message }) {
    super({
      name: name23,
      message: \`Invalid argument for parameter \${parameter}: \${message}\`
    });
    this[_a23] = true;
    this.parameter = parameter;
    this.value = value;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker23);
  }
};
_a23 = symbol23;
var name33 = "AI_InvalidStreamPartError";
var marker33 = \`vercel.ai.error.\${name33}\`;
var symbol33 = Symbol.for(marker33);
var _a33;
_a33 = symbol33;
var name43 = "AI_InvalidToolInputError";
var marker43 = \`vercel.ai.error.\${name43}\`;
var symbol43 = Symbol.for(marker43);
var _a43;
var InvalidToolInputError = class extends AISDKError {
  static {
    __name(this, "InvalidToolInputError");
  }
  constructor({ toolInput, toolName, cause, message = \`Invalid input for tool \${toolName}: \${getErrorMessage(cause)}\` }) {
    super({
      name: name43,
      message,
      cause
    });
    this[_a43] = true;
    this.toolInput = toolInput;
    this.toolName = toolName;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker43);
  }
};
_a43 = symbol43;
var name53 = "AI_MCPClientError";
var marker53 = \`vercel.ai.error.\${name53}\`;
var symbol53 = Symbol.for(marker53);
var _a53;
_a53 = symbol53;
var name63 = "AI_NoImageGeneratedError";
var marker63 = \`vercel.ai.error.\${name63}\`;
var symbol63 = Symbol.for(marker63);
var _a63;
_a63 = symbol63;
var name72 = "AI_NoObjectGeneratedError";
var marker73 = \`vercel.ai.error.\${name72}\`;
var symbol73 = Symbol.for(marker73);
var _a73;
var NoObjectGeneratedError = class extends AISDKError {
  static {
    __name(this, "NoObjectGeneratedError");
  }
  constructor({ message = "No object generated.", cause, text: text2, response, usage, finishReason }) {
    super({
      name: name72,
      message,
      cause
    });
    this[_a73] = true;
    this.text = text2;
    this.response = response;
    this.usage = usage;
    this.finishReason = finishReason;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker73);
  }
};
_a73 = symbol73;
var name82 = "AI_NoOutputGeneratedError";
var marker82 = \`vercel.ai.error.\${name82}\`;
var symbol82 = Symbol.for(marker82);
var _a82;
_a82 = symbol82;
var name92 = "AI_NoSuchToolError";
var marker92 = \`vercel.ai.error.\${name92}\`;
var symbol92 = Symbol.for(marker92);
var _a92;
var NoSuchToolError = class extends AISDKError {
  static {
    __name(this, "NoSuchToolError");
  }
  constructor({ toolName, availableTools = void 0, message = \`Model tried to call unavailable tool '\${toolName}'. \${availableTools === void 0 ? "No tools are available." : \`Available tools: \${availableTools.join(", ")}.\`}\` }) {
    super({
      name: name92,
      message
    });
    this[_a92] = true;
    this.toolName = toolName;
    this.availableTools = availableTools;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker92);
  }
};
_a92 = symbol92;
var name102 = "AI_ToolCallRepairError";
var marker102 = \`vercel.ai.error.\${name102}\`;
var symbol102 = Symbol.for(marker102);
var _a102;
var ToolCallRepairError = class extends AISDKError {
  static {
    __name(this, "ToolCallRepairError");
  }
  constructor({ cause, originalError, message = \`Error repairing tool call: \${getErrorMessage(cause)}\` }) {
    super({
      name: name102,
      message,
      cause
    });
    this[_a102] = true;
    this.originalError = originalError;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker102);
  }
};
_a102 = symbol102;
var UnsupportedModelVersionError = class extends AISDKError {
  static {
    __name(this, "UnsupportedModelVersionError");
  }
  constructor(options) {
    super({
      name: "AI_UnsupportedModelVersionError",
      message: \`Unsupported model version \${options.version} for provider "\${options.provider}" and model "\${options.modelId}". AI SDK 5 only supports models that implement specification version "v2".\`
    });
    this.version = options.version;
    this.provider = options.provider;
    this.modelId = options.modelId;
  }
};
var name112 = "AI_InvalidDataContentError";
var marker112 = \`vercel.ai.error.\${name112}\`;
var symbol112 = Symbol.for(marker112);
var _a112;
_a112 = symbol112;
var name122 = "AI_InvalidMessageRoleError";
var marker122 = \`vercel.ai.error.\${name122}\`;
var symbol122 = Symbol.for(marker122);
var _a122;
var InvalidMessageRoleError = class extends AISDKError {
  static {
    __name(this, "InvalidMessageRoleError");
  }
  constructor({ role, message = \`Invalid message role: '\${role}'. Must be one of: "system", "user", "assistant", "tool".\` }) {
    super({
      name: name122,
      message
    });
    this[_a122] = true;
    this.role = role;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker122);
  }
};
_a122 = symbol122;
var name132 = "AI_MessageConversionError";
var marker132 = \`vercel.ai.error.\${name132}\`;
var symbol132 = Symbol.for(marker132);
var _a132;
_a132 = symbol132;
var name142 = "AI_DownloadError";
var marker142 = \`vercel.ai.error.\${name142}\`;
var symbol142 = Symbol.for(marker142);
var _a142;
var DownloadError = class extends AISDKError {
  static {
    __name(this, "DownloadError");
  }
  constructor({ url: url2, statusCode, statusText, cause, message = cause == null ? \`Failed to download \${url2}: \${statusCode} \${statusText}\` : \`Failed to download \${url2}: \${cause}\` }) {
    super({
      name: name142,
      message,
      cause
    });
    this[_a142] = true;
    this.url = url2;
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker142);
  }
};
_a142 = symbol142;
var name152 = "AI_RetryError";
var marker152 = \`vercel.ai.error.\${name152}\`;
var symbol152 = Symbol.for(marker152);
var _a152;
var RetryError = class extends AISDKError {
  static {
    __name(this, "RetryError");
  }
  constructor({ message, reason, errors }) {
    super({
      name: name152,
      message
    });
    this[_a152] = true;
    this.reason = reason;
    this.errors = errors;
    this.lastError = errors[errors.length - 1];
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker152);
  }
};
_a152 = symbol152;
function resolveLanguageModel(model) {
  if (typeof model !== "string") {
    if (model.specificationVersion !== "v2") {
      throw new UnsupportedModelVersionError({
        version: model.specificationVersion,
        provider: model.provider,
        modelId: model.modelId
      });
    }
    return model;
  }
  return getGlobalProvider().languageModel(model);
}
__name(resolveLanguageModel, "resolveLanguageModel");
function getGlobalProvider() {
  var _a17;
  return (_a17 = globalThis.AI_SDK_DEFAULT_PROVIDER) != null ? _a17 : gateway;
}
__name(getGlobalProvider, "getGlobalProvider");
var imageMediaTypeSignatures = [
  {
    mediaType: "image/gif",
    bytesPrefix: [
      71,
      73,
      70
    ]
  },
  {
    mediaType: "image/png",
    bytesPrefix: [
      137,
      80,
      78,
      71
    ]
  },
  {
    mediaType: "image/jpeg",
    bytesPrefix: [
      255,
      216
    ]
  },
  {
    mediaType: "image/webp",
    bytesPrefix: [
      82,
      73,
      70,
      70,
      // "RIFF"
      null,
      null,
      null,
      null,
      // file size (variable)
      87,
      69,
      66,
      80
    ]
  },
  {
    mediaType: "image/bmp",
    bytesPrefix: [
      66,
      77
    ]
  },
  {
    mediaType: "image/tiff",
    bytesPrefix: [
      73,
      73,
      42,
      0
    ]
  },
  {
    mediaType: "image/tiff",
    bytesPrefix: [
      77,
      77,
      0,
      42
    ]
  },
  {
    mediaType: "image/avif",
    bytesPrefix: [
      0,
      0,
      0,
      32,
      102,
      116,
      121,
      112,
      97,
      118,
      105,
      102
    ]
  },
  {
    mediaType: "image/heic",
    bytesPrefix: [
      0,
      0,
      0,
      32,
      102,
      116,
      121,
      112,
      104,
      101,
      105,
      99
    ]
  }
];
var stripID3 = /* @__PURE__ */ __name((data) => {
  const bytes = typeof data === "string" ? convertBase64ToUint8Array(data) : data;
  const id3Size = (bytes[6] & 127) << 21 | (bytes[7] & 127) << 14 | (bytes[8] & 127) << 7 | bytes[9] & 127;
  return bytes.slice(id3Size + 10);
}, "stripID3");
function stripID3TagsIfPresent(data) {
  const hasId3 = typeof data === "string" && data.startsWith("SUQz") || typeof data !== "string" && data.length > 10 && data[0] === 73 && // 'I'
  data[1] === 68 && // 'D'
  data[2] === 51;
  return hasId3 ? stripID3(data) : data;
}
__name(stripID3TagsIfPresent, "stripID3TagsIfPresent");
function detectMediaType({ data, signatures }) {
  const processedData = stripID3TagsIfPresent(data);
  const bytes = typeof processedData === "string" ? convertBase64ToUint8Array(processedData.substring(0, Math.min(processedData.length, 24))) : processedData;
  for (const signature of signatures) {
    if (bytes.length >= signature.bytesPrefix.length && signature.bytesPrefix.every((byte, index) => byte === null || bytes[index] === byte)) {
      return signature.mediaType;
    }
  }
  return void 0;
}
__name(detectMediaType, "detectMediaType");
var VERSION3 = true ? "5.0.76" : "0.0.0-test";
var download = /* @__PURE__ */ __name(async ({ url: url2 }) => {
  var _a17;
  const urlText = url2.toString();
  try {
    const response = await fetch(urlText, {
      headers: withUserAgentSuffix({}, \`ai-sdk/\${VERSION3}\`, getRuntimeEnvironmentUserAgent())
    });
    if (!response.ok) {
      throw new DownloadError({
        url: urlText,
        statusCode: response.status,
        statusText: response.statusText
      });
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mediaType: (_a17 = response.headers.get("content-type")) != null ? _a17 : void 0
    };
  } catch (error45) {
    if (DownloadError.isInstance(error45)) {
      throw error45;
    }
    throw new DownloadError({
      url: urlText,
      cause: error45
    });
  }
}, "download");
var createDefaultDownloadFunction = /* @__PURE__ */ __name((download2 = download) => (requestedDownloads) => Promise.all(requestedDownloads.map(async (requestedDownload) => requestedDownload.isUrlSupportedByModel ? null : download2(requestedDownload))), "createDefaultDownloadFunction");
function splitDataUrl(dataUrl) {
  try {
    const [header, base64Content] = dataUrl.split(",");
    return {
      mediaType: header.split(";")[0].split(":")[1],
      base64Content
    };
  } catch (error45) {
    return {
      mediaType: void 0,
      base64Content: void 0
    };
  }
}
__name(splitDataUrl, "splitDataUrl");
var dataContentSchema = external_exports.union([
  external_exports.string(),
  external_exports.instanceof(Uint8Array),
  external_exports.instanceof(ArrayBuffer),
  external_exports.custom(
    // Buffer might not be available in some environments such as CloudFlare:
    (value) => {
      var _a17, _b8;
      return (_b8 = (_a17 = globalThis.Buffer) == null ? void 0 : _a17.isBuffer(value)) != null ? _b8 : false;
    },
    {
      message: "Must be a Buffer"
    }
  )
]);
function convertToLanguageModelV2DataContent(content) {
  if (content instanceof Uint8Array) {
    return {
      data: content,
      mediaType: void 0
    };
  }
  if (content instanceof ArrayBuffer) {
    return {
      data: new Uint8Array(content),
      mediaType: void 0
    };
  }
  if (typeof content === "string") {
    try {
      content = new URL(content);
    } catch (error45) {
    }
  }
  if (content instanceof URL && content.protocol === "data:") {
    const { mediaType: dataUrlMediaType, base64Content } = splitDataUrl(content.toString());
    if (dataUrlMediaType == null || base64Content == null) {
      throw new AISDKError({
        name: "InvalidDataContentError",
        message: \`Invalid data URL format in content \${content.toString()}\`
      });
    }
    return {
      data: base64Content,
      mediaType: dataUrlMediaType
    };
  }
  return {
    data: content,
    mediaType: void 0
  };
}
__name(convertToLanguageModelV2DataContent, "convertToLanguageModelV2DataContent");
function convertDataContentToBase64String(content) {
  if (typeof content === "string") {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return convertUint8ArrayToBase64(new Uint8Array(content));
  }
  return convertUint8ArrayToBase64(content);
}
__name(convertDataContentToBase64String, "convertDataContentToBase64String");
async function convertToLanguageModelPrompt({ prompt, supportedUrls, download: download2 = createDefaultDownloadFunction() }) {
  const downloadedAssets = await downloadAssets(prompt.messages, download2, supportedUrls);
  return [
    ...prompt.system != null ? [
      {
        role: "system",
        content: prompt.system
      }
    ] : [],
    ...prompt.messages.map((message) => convertToLanguageModelMessage({
      message,
      downloadedAssets
    }))
  ];
}
__name(convertToLanguageModelPrompt, "convertToLanguageModelPrompt");
function convertToLanguageModelMessage({ message, downloadedAssets }) {
  const role = message.role;
  switch (role) {
    case "system": {
      return {
        role: "system",
        content: message.content,
        providerOptions: message.providerOptions
      };
    }
    case "user": {
      if (typeof message.content === "string") {
        return {
          role: "user",
          content: [
            {
              type: "text",
              text: message.content
            }
          ],
          providerOptions: message.providerOptions
        };
      }
      return {
        role: "user",
        content: message.content.map((part) => convertPartToLanguageModelPart(part, downloadedAssets)).filter((part) => part.type !== "text" || part.text !== ""),
        providerOptions: message.providerOptions
      };
    }
    case "assistant": {
      if (typeof message.content === "string") {
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text: message.content
            }
          ],
          providerOptions: message.providerOptions
        };
      }
      return {
        role: "assistant",
        content: message.content.filter(
          // remove empty text parts (no text, and no provider options):
          (part) => part.type !== "text" || part.text !== "" || part.providerOptions != null
        ).map((part) => {
          const providerOptions = part.providerOptions;
          switch (part.type) {
            case "file": {
              const { data, mediaType } = convertToLanguageModelV2DataContent(part.data);
              return {
                type: "file",
                data,
                filename: part.filename,
                mediaType: mediaType != null ? mediaType : part.mediaType,
                providerOptions
              };
            }
            case "reasoning": {
              return {
                type: "reasoning",
                text: part.text,
                providerOptions
              };
            }
            case "text": {
              return {
                type: "text",
                text: part.text,
                providerOptions
              };
            }
            case "tool-call": {
              return {
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                providerExecuted: part.providerExecuted,
                providerOptions
              };
            }
            case "tool-result": {
              return {
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: part.output,
                providerOptions
              };
            }
          }
        }),
        providerOptions: message.providerOptions
      };
    }
    case "tool": {
      return {
        role: "tool",
        content: message.content.map((part) => ({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
          providerOptions: part.providerOptions
        })),
        providerOptions: message.providerOptions
      };
    }
    default: {
      const _exhaustiveCheck = role;
      throw new InvalidMessageRoleError({
        role: _exhaustiveCheck
      });
    }
  }
}
__name(convertToLanguageModelMessage, "convertToLanguageModelMessage");
async function downloadAssets(messages, download2, supportedUrls) {
  const plannedDownloads = messages.filter((message) => message.role === "user").map((message) => message.content).filter((content) => Array.isArray(content)).flat().filter((part) => part.type === "image" || part.type === "file").map((part) => {
    var _a17;
    const mediaType = (_a17 = part.mediaType) != null ? _a17 : part.type === "image" ? "image/*" : void 0;
    let data = part.type === "image" ? part.image : part.data;
    if (typeof data === "string") {
      try {
        data = new URL(data);
      } catch (ignored) {
      }
    }
    return {
      mediaType,
      data
    };
  }).filter((part) => part.data instanceof URL).map((part) => ({
    url: part.data,
    isUrlSupportedByModel: part.mediaType != null && isUrlSupported({
      url: part.data.toString(),
      mediaType: part.mediaType,
      supportedUrls
    })
  }));
  const downloadedFiles = await download2(plannedDownloads);
  return Object.fromEntries(downloadedFiles.map((file2, index) => file2 == null ? null : [
    plannedDownloads[index].url.toString(),
    {
      data: file2.data,
      mediaType: file2.mediaType
    }
  ]).filter((file2) => file2 != null));
}
__name(downloadAssets, "downloadAssets");
function convertPartToLanguageModelPart(part, downloadedAssets) {
  var _a17;
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
      providerOptions: part.providerOptions
    };
  }
  let originalData;
  const type = part.type;
  switch (type) {
    case "image":
      originalData = part.image;
      break;
    case "file":
      originalData = part.data;
      break;
    default:
      throw new Error(\`Unsupported part type: \${type}\`);
  }
  const { data: convertedData, mediaType: convertedMediaType } = convertToLanguageModelV2DataContent(originalData);
  let mediaType = convertedMediaType != null ? convertedMediaType : part.mediaType;
  let data = convertedData;
  if (data instanceof URL) {
    const downloadedFile = downloadedAssets[data.toString()];
    if (downloadedFile) {
      data = downloadedFile.data;
      mediaType != null ? mediaType : mediaType = downloadedFile.mediaType;
    }
  }
  switch (type) {
    case "image": {
      if (data instanceof Uint8Array || typeof data === "string") {
        mediaType = (_a17 = detectMediaType({
          data,
          signatures: imageMediaTypeSignatures
        })) != null ? _a17 : mediaType;
      }
      return {
        type: "file",
        mediaType: mediaType != null ? mediaType : "image/*",
        // any image
        filename: void 0,
        data,
        providerOptions: part.providerOptions
      };
    }
    case "file": {
      if (mediaType == null) {
        throw new Error(\`Media type is missing for file part\`);
      }
      return {
        type: "file",
        mediaType,
        filename: part.filename,
        data,
        providerOptions: part.providerOptions
      };
    }
  }
}
__name(convertPartToLanguageModelPart, "convertPartToLanguageModelPart");
function prepareCallSettings({ maxOutputTokens, temperature, topP, topK, presencePenalty, frequencyPenalty, seed, stopSequences }) {
  if (maxOutputTokens != null) {
    if (!Number.isInteger(maxOutputTokens)) {
      throw new InvalidArgumentError2({
        parameter: "maxOutputTokens",
        value: maxOutputTokens,
        message: "maxOutputTokens must be an integer"
      });
    }
    if (maxOutputTokens < 1) {
      throw new InvalidArgumentError2({
        parameter: "maxOutputTokens",
        value: maxOutputTokens,
        message: "maxOutputTokens must be >= 1"
      });
    }
  }
  if (temperature != null) {
    if (typeof temperature !== "number") {
      throw new InvalidArgumentError2({
        parameter: "temperature",
        value: temperature,
        message: "temperature must be a number"
      });
    }
  }
  if (topP != null) {
    if (typeof topP !== "number") {
      throw new InvalidArgumentError2({
        parameter: "topP",
        value: topP,
        message: "topP must be a number"
      });
    }
  }
  if (topK != null) {
    if (typeof topK !== "number") {
      throw new InvalidArgumentError2({
        parameter: "topK",
        value: topK,
        message: "topK must be a number"
      });
    }
  }
  if (presencePenalty != null) {
    if (typeof presencePenalty !== "number") {
      throw new InvalidArgumentError2({
        parameter: "presencePenalty",
        value: presencePenalty,
        message: "presencePenalty must be a number"
      });
    }
  }
  if (frequencyPenalty != null) {
    if (typeof frequencyPenalty !== "number") {
      throw new InvalidArgumentError2({
        parameter: "frequencyPenalty",
        value: frequencyPenalty,
        message: "frequencyPenalty must be a number"
      });
    }
  }
  if (seed != null) {
    if (!Number.isInteger(seed)) {
      throw new InvalidArgumentError2({
        parameter: "seed",
        value: seed,
        message: "seed must be an integer"
      });
    }
  }
  return {
    maxOutputTokens,
    temperature,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    stopSequences,
    seed
  };
}
__name(prepareCallSettings, "prepareCallSettings");
function isNonEmptyObject(object22) {
  return object22 != null && Object.keys(object22).length > 0;
}
__name(isNonEmptyObject, "isNonEmptyObject");
function prepareToolsAndToolChoice({ tools, toolChoice, activeTools }) {
  if (!isNonEmptyObject(tools)) {
    return {
      tools: void 0,
      toolChoice: void 0
    };
  }
  const filteredTools = activeTools != null ? Object.entries(tools).filter(([name17]) => activeTools.includes(name17)) : Object.entries(tools);
  return {
    tools: filteredTools.map(([name17, tool3]) => {
      const toolType = tool3.type;
      switch (toolType) {
        case void 0:
        case "dynamic":
        case "function":
          return {
            type: "function",
            name: name17,
            description: tool3.description,
            inputSchema: asSchema(tool3.inputSchema).jsonSchema,
            providerOptions: tool3.providerOptions
          };
        case "provider-defined":
          return {
            type: "provider-defined",
            name: name17,
            id: tool3.id,
            args: tool3.args
          };
        default: {
          const exhaustiveCheck = toolType;
          throw new Error(\`Unsupported tool type: \${exhaustiveCheck}\`);
        }
      }
    }),
    toolChoice: toolChoice == null ? {
      type: "auto"
    } : typeof toolChoice === "string" ? {
      type: toolChoice
    } : {
      type: "tool",
      toolName: toolChoice.toolName
    }
  };
}
__name(prepareToolsAndToolChoice, "prepareToolsAndToolChoice");
var jsonValueSchema = external_exports.lazy(() => external_exports.union([
  external_exports.null(),
  external_exports.string(),
  external_exports.number(),
  external_exports.boolean(),
  external_exports.record(external_exports.string(), jsonValueSchema),
  external_exports.array(jsonValueSchema)
]));
var providerMetadataSchema = external_exports.record(external_exports.string(), external_exports.record(external_exports.string(), jsonValueSchema));
var textPartSchema = external_exports.object({
  type: external_exports.literal("text"),
  text: external_exports.string(),
  providerOptions: providerMetadataSchema.optional()
});
var imagePartSchema = external_exports.object({
  type: external_exports.literal("image"),
  image: external_exports.union([
    dataContentSchema,
    external_exports.instanceof(URL)
  ]),
  mediaType: external_exports.string().optional(),
  providerOptions: providerMetadataSchema.optional()
});
var filePartSchema = external_exports.object({
  type: external_exports.literal("file"),
  data: external_exports.union([
    dataContentSchema,
    external_exports.instanceof(URL)
  ]),
  filename: external_exports.string().optional(),
  mediaType: external_exports.string(),
  providerOptions: providerMetadataSchema.optional()
});
var reasoningPartSchema = external_exports.object({
  type: external_exports.literal("reasoning"),
  text: external_exports.string(),
  providerOptions: providerMetadataSchema.optional()
});
var toolCallPartSchema = external_exports.object({
  type: external_exports.literal("tool-call"),
  toolCallId: external_exports.string(),
  toolName: external_exports.string(),
  input: external_exports.unknown(),
  providerOptions: providerMetadataSchema.optional(),
  providerExecuted: external_exports.boolean().optional()
});
var outputSchema = external_exports.discriminatedUnion("type", [
  external_exports.object({
    type: external_exports.literal("text"),
    value: external_exports.string()
  }),
  external_exports.object({
    type: external_exports.literal("json"),
    value: jsonValueSchema
  }),
  external_exports.object({
    type: external_exports.literal("error-text"),
    value: external_exports.string()
  }),
  external_exports.object({
    type: external_exports.literal("error-json"),
    value: jsonValueSchema
  }),
  external_exports.object({
    type: external_exports.literal("content"),
    value: external_exports.array(external_exports.union([
      external_exports.object({
        type: external_exports.literal("text"),
        text: external_exports.string()
      }),
      external_exports.object({
        type: external_exports.literal("media"),
        data: external_exports.string(),
        mediaType: external_exports.string()
      })
    ]))
  })
]);
var toolResultPartSchema = external_exports.object({
  type: external_exports.literal("tool-result"),
  toolCallId: external_exports.string(),
  toolName: external_exports.string(),
  output: outputSchema,
  providerOptions: providerMetadataSchema.optional()
});
var systemModelMessageSchema = external_exports.object({
  role: external_exports.literal("system"),
  content: external_exports.string(),
  providerOptions: providerMetadataSchema.optional()
});
var userModelMessageSchema = external_exports.object({
  role: external_exports.literal("user"),
  content: external_exports.union([
    external_exports.string(),
    external_exports.array(external_exports.union([
      textPartSchema,
      imagePartSchema,
      filePartSchema
    ]))
  ]),
  providerOptions: providerMetadataSchema.optional()
});
var assistantModelMessageSchema = external_exports.object({
  role: external_exports.literal("assistant"),
  content: external_exports.union([
    external_exports.string(),
    external_exports.array(external_exports.union([
      textPartSchema,
      filePartSchema,
      reasoningPartSchema,
      toolCallPartSchema,
      toolResultPartSchema
    ]))
  ]),
  providerOptions: providerMetadataSchema.optional()
});
var toolModelMessageSchema = external_exports.object({
  role: external_exports.literal("tool"),
  content: external_exports.array(toolResultPartSchema),
  providerOptions: providerMetadataSchema.optional()
});
var modelMessageSchema = external_exports.union([
  systemModelMessageSchema,
  userModelMessageSchema,
  assistantModelMessageSchema,
  toolModelMessageSchema
]);
async function standardizePrompt(prompt) {
  if (prompt.prompt == null && prompt.messages == null) {
    throw new InvalidPromptError({
      prompt,
      message: "prompt or messages must be defined"
    });
  }
  if (prompt.prompt != null && prompt.messages != null) {
    throw new InvalidPromptError({
      prompt,
      message: "prompt and messages cannot be defined at the same time"
    });
  }
  if (prompt.system != null && typeof prompt.system !== "string") {
    throw new InvalidPromptError({
      prompt,
      message: "system must be a string"
    });
  }
  let messages;
  if (prompt.prompt != null && typeof prompt.prompt === "string") {
    messages = [
      {
        role: "user",
        content: prompt.prompt
      }
    ];
  } else if (prompt.prompt != null && Array.isArray(prompt.prompt)) {
    messages = prompt.prompt;
  } else if (prompt.messages != null) {
    messages = prompt.messages;
  } else {
    throw new InvalidPromptError({
      prompt,
      message: "prompt or messages must be defined"
    });
  }
  if (messages.length === 0) {
    throw new InvalidPromptError({
      prompt,
      message: "messages must not be empty"
    });
  }
  const validationResult = await safeValidateTypes({
    value: messages,
    schema: external_exports.array(modelMessageSchema)
  });
  if (!validationResult.success) {
    throw new InvalidPromptError({
      prompt,
      message: "The messages must be a ModelMessage[]. If you have passed a UIMessage[], you can use convertToModelMessages to convert them.",
      cause: validationResult.error
    });
  }
  return {
    messages,
    system: prompt.system
  };
}
__name(standardizePrompt, "standardizePrompt");
function wrapGatewayError(error45) {
  if (GatewayAuthenticationError.isInstance(error45) || GatewayModelNotFoundError.isInstance(error45)) {
    return new AISDKError({
      name: "GatewayError",
      message: "Vercel AI Gateway access failed. If you want to use AI SDK providers directly, use the providers, e.g. @ai-sdk/openai, or register a different global default provider.",
      cause: error45
    });
  }
  return error45;
}
__name(wrapGatewayError, "wrapGatewayError");
function assembleOperationName({ operationId, telemetry }) {
  return {
    // standardized operation and resource name:
    "operation.name": \`\${operationId}\${(telemetry == null ? void 0 : telemetry.functionId) != null ? \` \${telemetry.functionId}\` : ""}\`,
    "resource.name": telemetry == null ? void 0 : telemetry.functionId,
    // detailed, AI SDK specific data:
    "ai.operationId": operationId,
    "ai.telemetry.functionId": telemetry == null ? void 0 : telemetry.functionId
  };
}
__name(assembleOperationName, "assembleOperationName");
function getBaseTelemetryAttributes({ model, settings, telemetry, headers }) {
  var _a17;
  return {
    "ai.model.provider": model.provider,
    "ai.model.id": model.modelId,
    // settings:
    ...Object.entries(settings).reduce((attributes, [key, value]) => {
      attributes[\`ai.settings.\${key}\`] = value;
      return attributes;
    }, {}),
    // add metadata as attributes:
    ...Object.entries((_a17 = telemetry == null ? void 0 : telemetry.metadata) != null ? _a17 : {}).reduce((attributes, [key, value]) => {
      attributes[\`ai.telemetry.metadata.\${key}\`] = value;
      return attributes;
    }, {}),
    // request headers
    ...Object.entries(headers != null ? headers : {}).reduce((attributes, [key, value]) => {
      if (value !== void 0) {
        attributes[\`ai.request.headers.\${key}\`] = value;
      }
      return attributes;
    }, {})
  };
}
__name(getBaseTelemetryAttributes, "getBaseTelemetryAttributes");
var noopTracer = {
  startSpan() {
    return noopSpan;
  },
  startActiveSpan(name17, arg1, arg2, arg3) {
    if (typeof arg1 === "function") {
      return arg1(noopSpan);
    }
    if (typeof arg2 === "function") {
      return arg2(noopSpan);
    }
    if (typeof arg3 === "function") {
      return arg3(noopSpan);
    }
  }
};
var noopSpan = {
  spanContext() {
    return noopSpanContext;
  },
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  addLink() {
    return this;
  },
  addLinks() {
    return this;
  },
  setStatus() {
    return this;
  },
  updateName() {
    return this;
  },
  end() {
    return this;
  },
  isRecording() {
    return false;
  },
  recordException() {
    return this;
  }
};
var noopSpanContext = {
  traceId: "",
  spanId: "",
  traceFlags: 0
};
function getTracer({ isEnabled = false, tracer } = {}) {
  if (!isEnabled) {
    return noopTracer;
  }
  if (tracer) {
    return tracer;
  }
  return import_api.trace.getTracer("ai");
}
__name(getTracer, "getTracer");
function recordSpan({ name: name17, tracer, attributes, fn, endWhenDone = true }) {
  return tracer.startActiveSpan(name17, {
    attributes
  }, async (span) => {
    try {
      const result = await fn(span);
      if (endWhenDone) {
        span.end();
      }
      return result;
    } catch (error45) {
      try {
        recordErrorOnSpan(span, error45);
      } finally {
        span.end();
      }
      throw error45;
    }
  });
}
__name(recordSpan, "recordSpan");
function recordErrorOnSpan(span, error45) {
  if (error45 instanceof Error) {
    span.recordException({
      name: error45.name,
      message: error45.message,
      stack: error45.stack
    });
    span.setStatus({
      code: import_api2.SpanStatusCode.ERROR,
      message: error45.message
    });
  } else {
    span.setStatus({
      code: import_api2.SpanStatusCode.ERROR
    });
  }
}
__name(recordErrorOnSpan, "recordErrorOnSpan");
function selectTelemetryAttributes({ telemetry, attributes }) {
  if ((telemetry == null ? void 0 : telemetry.isEnabled) !== true) {
    return {};
  }
  return Object.entries(attributes).reduce((attributes2, [key, value]) => {
    if (value == null) {
      return attributes2;
    }
    if (typeof value === "object" && "input" in value && typeof value.input === "function") {
      if ((telemetry == null ? void 0 : telemetry.recordInputs) === false) {
        return attributes2;
      }
      const result = value.input();
      return result == null ? attributes2 : {
        ...attributes2,
        [key]: result
      };
    }
    if (typeof value === "object" && "output" in value && typeof value.output === "function") {
      if ((telemetry == null ? void 0 : telemetry.recordOutputs) === false) {
        return attributes2;
      }
      const result = value.output();
      return result == null ? attributes2 : {
        ...attributes2,
        [key]: result
      };
    }
    return {
      ...attributes2,
      [key]: value
    };
  }, {});
}
__name(selectTelemetryAttributes, "selectTelemetryAttributes");
function stringifyForTelemetry(prompt) {
  return JSON.stringify(prompt.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "file" ? {
      ...part,
      data: part.data instanceof Uint8Array ? convertDataContentToBase64String(part.data) : part.data
    } : part)
  })));
}
__name(stringifyForTelemetry, "stringifyForTelemetry");
function addLanguageModelUsage(usage1, usage2) {
  return {
    inputTokens: addTokenCounts(usage1.inputTokens, usage2.inputTokens),
    outputTokens: addTokenCounts(usage1.outputTokens, usage2.outputTokens),
    totalTokens: addTokenCounts(usage1.totalTokens, usage2.totalTokens),
    reasoningTokens: addTokenCounts(usage1.reasoningTokens, usage2.reasoningTokens),
    cachedInputTokens: addTokenCounts(usage1.cachedInputTokens, usage2.cachedInputTokens)
  };
}
__name(addLanguageModelUsage, "addLanguageModelUsage");
function addTokenCounts(tokenCount1, tokenCount2) {
  return tokenCount1 == null && tokenCount2 == null ? void 0 : (tokenCount1 != null ? tokenCount1 : 0) + (tokenCount2 != null ? tokenCount2 : 0);
}
__name(addTokenCounts, "addTokenCounts");
function asArray(value) {
  return value === void 0 ? [] : Array.isArray(value) ? value : [
    value
  ];
}
__name(asArray, "asArray");
function getRetryDelayInMs({ error: error45, exponentialBackoffDelay }) {
  const headers = error45.responseHeaders;
  if (!headers) return exponentialBackoffDelay;
  let ms2;
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const timeoutMs = parseFloat(retryAfterMs);
    if (!Number.isNaN(timeoutMs)) {
      ms2 = timeoutMs;
    }
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter && ms2 === void 0) {
    const timeoutSeconds = parseFloat(retryAfter);
    if (!Number.isNaN(timeoutSeconds)) {
      ms2 = timeoutSeconds * 1e3;
    } else {
      ms2 = Date.parse(retryAfter) - Date.now();
    }
  }
  if (ms2 != null && !Number.isNaN(ms2) && 0 <= ms2 && (ms2 < 60 * 1e3 || ms2 < exponentialBackoffDelay)) {
    return ms2;
  }
  return exponentialBackoffDelay;
}
__name(getRetryDelayInMs, "getRetryDelayInMs");
var retryWithExponentialBackoffRespectingRetryHeaders = /* @__PURE__ */ __name(({ maxRetries = 2, initialDelayInMs = 2e3, backoffFactor = 2, abortSignal } = {}) => async (f) => _retryWithExponentialBackoff(f, {
  maxRetries,
  delayInMs: initialDelayInMs,
  backoffFactor,
  abortSignal
}), "retryWithExponentialBackoffRespectingRetryHeaders");
async function _retryWithExponentialBackoff(f, { maxRetries, delayInMs, backoffFactor, abortSignal }, errors = []) {
  try {
    return await f();
  } catch (error45) {
    if (isAbortError(error45)) {
      throw error45;
    }
    if (maxRetries === 0) {
      throw error45;
    }
    const errorMessage = getErrorMessage2(error45);
    const newErrors = [
      ...errors,
      error45
    ];
    const tryNumber = newErrors.length;
    if (tryNumber > maxRetries) {
      throw new RetryError({
        message: \`Failed after \${tryNumber} attempts. Last error: \${errorMessage}\`,
        reason: "maxRetriesExceeded",
        errors: newErrors
      });
    }
    if (error45 instanceof Error && APICallError.isInstance(error45) && error45.isRetryable === true && tryNumber <= maxRetries) {
      await delay(getRetryDelayInMs({
        error: error45,
        exponentialBackoffDelay: delayInMs
      }), {
        abortSignal
      });
      return _retryWithExponentialBackoff(f, {
        maxRetries,
        delayInMs: backoffFactor * delayInMs,
        backoffFactor,
        abortSignal
      }, newErrors);
    }
    if (tryNumber === 1) {
      throw error45;
    }
    throw new RetryError({
      message: \`Failed after \${tryNumber} attempts with non-retryable error: '\${errorMessage}'\`,
      reason: "errorNotRetryable",
      errors: newErrors
    });
  }
}
__name(_retryWithExponentialBackoff, "_retryWithExponentialBackoff");
function prepareRetries({ maxRetries, abortSignal }) {
  if (maxRetries != null) {
    if (!Number.isInteger(maxRetries)) {
      throw new InvalidArgumentError2({
        parameter: "maxRetries",
        value: maxRetries,
        message: "maxRetries must be an integer"
      });
    }
    if (maxRetries < 0) {
      throw new InvalidArgumentError2({
        parameter: "maxRetries",
        value: maxRetries,
        message: "maxRetries must be >= 0"
      });
    }
  }
  const maxRetriesResult = maxRetries != null ? maxRetries : 2;
  return {
    maxRetries: maxRetriesResult,
    retry: retryWithExponentialBackoffRespectingRetryHeaders({
      maxRetries: maxRetriesResult,
      abortSignal
    })
  };
}
__name(prepareRetries, "prepareRetries");
function extractTextContent(content) {
  const parts = content.filter((content2) => content2.type === "text");
  if (parts.length === 0) {
    return void 0;
  }
  return parts.map((content2) => content2.text).join("");
}
__name(extractTextContent, "extractTextContent");
var DefaultGeneratedFile = class {
  static {
    __name(this, "DefaultGeneratedFile");
  }
  constructor({ data, mediaType }) {
    const isUint8Array = data instanceof Uint8Array;
    this.base64Data = isUint8Array ? void 0 : data;
    this.uint8ArrayData = isUint8Array ? data : void 0;
    this.mediaType = mediaType;
  }
  // lazy conversion with caching to avoid unnecessary conversion overhead:
  get base64() {
    if (this.base64Data == null) {
      this.base64Data = convertUint8ArrayToBase64(this.uint8ArrayData);
    }
    return this.base64Data;
  }
  // lazy conversion with caching to avoid unnecessary conversion overhead:
  get uint8Array() {
    if (this.uint8ArrayData == null) {
      this.uint8ArrayData = convertBase64ToUint8Array(this.base64Data);
    }
    return this.uint8ArrayData;
  }
};
async function parseToolCall({ toolCall, tools, repairToolCall, system, messages }) {
  try {
    if (tools == null) {
      throw new NoSuchToolError({
        toolName: toolCall.toolName
      });
    }
    try {
      return await doParseToolCall({
        toolCall,
        tools
      });
    } catch (error45) {
      if (repairToolCall == null || !(NoSuchToolError.isInstance(error45) || InvalidToolInputError.isInstance(error45))) {
        throw error45;
      }
      let repairedToolCall = null;
      try {
        repairedToolCall = await repairToolCall({
          toolCall,
          tools,
          inputSchema: /* @__PURE__ */ __name(({ toolName }) => {
            const { inputSchema } = tools[toolName];
            return asSchema(inputSchema).jsonSchema;
          }, "inputSchema"),
          system,
          messages,
          error: error45
        });
      } catch (repairError) {
        throw new ToolCallRepairError({
          cause: repairError,
          originalError: error45
        });
      }
      if (repairedToolCall == null) {
        throw error45;
      }
      return await doParseToolCall({
        toolCall: repairedToolCall,
        tools
      });
    }
  } catch (error45) {
    const parsedInput = await safeParseJSON({
      text: toolCall.input
    });
    const input = parsedInput.success ? parsedInput.value : toolCall.input;
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input,
      dynamic: true,
      invalid: true,
      error: error45
    };
  }
}
__name(parseToolCall, "parseToolCall");
async function doParseToolCall({ toolCall, tools }) {
  const toolName = toolCall.toolName;
  const tool3 = tools[toolName];
  if (tool3 == null) {
    throw new NoSuchToolError({
      toolName: toolCall.toolName,
      availableTools: Object.keys(tools)
    });
  }
  const schema = asSchema(tool3.inputSchema);
  const parseResult = toolCall.input.trim() === "" ? await safeValidateTypes({
    value: {},
    schema
  }) : await safeParseJSON({
    text: toolCall.input,
    schema
  });
  if (parseResult.success === false) {
    throw new InvalidToolInputError({
      toolName,
      toolInput: toolCall.input,
      cause: parseResult.error
    });
  }
  return tool3.type === "dynamic" ? {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: parseResult.value,
    providerExecuted: toolCall.providerExecuted,
    providerMetadata: toolCall.providerMetadata,
    dynamic: true
  } : {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName,
    input: parseResult.value,
    providerExecuted: toolCall.providerExecuted,
    providerMetadata: toolCall.providerMetadata
  };
}
__name(doParseToolCall, "doParseToolCall");
var DefaultStepResult = class {
  static {
    __name(this, "DefaultStepResult");
  }
  constructor({ content, finishReason, usage, warnings, request, response, providerMetadata }) {
    this.content = content;
    this.finishReason = finishReason;
    this.usage = usage;
    this.warnings = warnings;
    this.request = request;
    this.response = response;
    this.providerMetadata = providerMetadata;
  }
  get text() {
    return this.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  get reasoning() {
    return this.content.filter((part) => part.type === "reasoning");
  }
  get reasoningText() {
    return this.reasoning.length === 0 ? void 0 : this.reasoning.map((part) => part.text).join("");
  }
  get files() {
    return this.content.filter((part) => part.type === "file").map((part) => part.file);
  }
  get sources() {
    return this.content.filter((part) => part.type === "source");
  }
  get toolCalls() {
    return this.content.filter((part) => part.type === "tool-call");
  }
  get staticToolCalls() {
    return this.toolCalls.filter((toolCall) => toolCall.dynamic !== true);
  }
  get dynamicToolCalls() {
    return this.toolCalls.filter((toolCall) => toolCall.dynamic === true);
  }
  get toolResults() {
    return this.content.filter((part) => part.type === "tool-result");
  }
  get staticToolResults() {
    return this.toolResults.filter((toolResult) => toolResult.dynamic !== true);
  }
  get dynamicToolResults() {
    return this.toolResults.filter((toolResult) => toolResult.dynamic === true);
  }
};
function stepCountIs(stepCount) {
  return ({ steps }) => steps.length === stepCount;
}
__name(stepCountIs, "stepCountIs");
async function isStopConditionMet({ stopConditions, steps }) {
  return (await Promise.all(stopConditions.map((condition) => condition({
    steps
  })))).some((result) => result);
}
__name(isStopConditionMet, "isStopConditionMet");
function createToolModelOutput({ output, tool: tool3, errorMode }) {
  if (errorMode === "text") {
    return {
      type: "error-text",
      value: getErrorMessage(output)
    };
  } else if (errorMode === "json") {
    return {
      type: "error-json",
      value: toJSONValue(output)
    };
  }
  if (tool3 == null ? void 0 : tool3.toModelOutput) {
    return tool3.toModelOutput(output);
  }
  return typeof output === "string" ? {
    type: "text",
    value: output
  } : {
    type: "json",
    value: toJSONValue(output)
  };
}
__name(createToolModelOutput, "createToolModelOutput");
function toJSONValue(value) {
  return value === void 0 ? null : value;
}
__name(toJSONValue, "toJSONValue");
function toResponseMessages({ content: inputContent, tools }) {
  const responseMessages = [];
  const content = inputContent.filter((part) => part.type !== "source").filter((part) => (part.type !== "tool-result" || part.providerExecuted) && (part.type !== "tool-error" || part.providerExecuted)).filter((part) => part.type !== "text" || part.text.length > 0).map((part) => {
    switch (part.type) {
      case "text":
        return {
          type: "text",
          text: part.text,
          providerOptions: part.providerMetadata
        };
      case "reasoning":
        return {
          type: "reasoning",
          text: part.text,
          providerOptions: part.providerMetadata
        };
      case "file":
        return {
          type: "file",
          data: part.file.base64,
          mediaType: part.file.mediaType,
          providerOptions: part.providerMetadata
        };
      case "tool-call":
        return {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          providerExecuted: part.providerExecuted,
          providerOptions: part.providerMetadata
        };
      case "tool-result":
        return {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: createToolModelOutput({
            tool: tools == null ? void 0 : tools[part.toolName],
            output: part.output,
            errorMode: "none"
          }),
          providerExecuted: true,
          providerOptions: part.providerMetadata
        };
      case "tool-error":
        return {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: createToolModelOutput({
            tool: tools == null ? void 0 : tools[part.toolName],
            output: part.error,
            errorMode: "json"
          }),
          providerOptions: part.providerMetadata
        };
    }
  });
  if (content.length > 0) {
    responseMessages.push({
      role: "assistant",
      content
    });
  }
  const toolResultContent = inputContent.filter((part) => part.type === "tool-result" || part.type === "tool-error").filter((part) => !part.providerExecuted).map((toolResult) => ({
    type: "tool-result",
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    output: createToolModelOutput({
      tool: tools == null ? void 0 : tools[toolResult.toolName],
      output: toolResult.type === "tool-result" ? toolResult.output : toolResult.error,
      errorMode: toolResult.type === "tool-error" ? "text" : "none"
    })
  }));
  if (toolResultContent.length > 0) {
    responseMessages.push({
      role: "tool",
      content: toolResultContent
    });
  }
  return responseMessages;
}
__name(toResponseMessages, "toResponseMessages");
async function generateText({ model: modelArg, tools, toolChoice, system, prompt, messages, maxRetries: maxRetriesArg, abortSignal, headers, stopWhen = stepCountIs(1), experimental_output: output, experimental_telemetry: telemetry, providerOptions, experimental_activeTools, activeTools = experimental_activeTools, experimental_prepareStep, prepareStep = experimental_prepareStep, experimental_repairToolCall: repairToolCall, experimental_download: download2, experimental_context, _internal: { generateId: generateId3 = originalGenerateId, currentDate = /* @__PURE__ */ __name(() => /* @__PURE__ */ new Date(), "currentDate") } = {}, onStepFinish, ...settings }) {
  const model = resolveLanguageModel(modelArg);
  const stopConditions = asArray(stopWhen);
  const { maxRetries, retry } = prepareRetries({
    maxRetries: maxRetriesArg,
    abortSignal
  });
  const callSettings = prepareCallSettings(settings);
  const headersWithUserAgent = withUserAgentSuffix(headers != null ? headers : {}, \`ai/\${VERSION3}\`);
  const baseTelemetryAttributes = getBaseTelemetryAttributes({
    model,
    telemetry,
    headers: headersWithUserAgent,
    settings: {
      ...callSettings,
      maxRetries
    }
  });
  const initialPrompt = await standardizePrompt({
    system,
    prompt,
    messages
  });
  const tracer = getTracer(telemetry);
  try {
    return await recordSpan({
      name: "ai.generateText",
      attributes: selectTelemetryAttributes({
        telemetry,
        attributes: {
          ...assembleOperationName({
            operationId: "ai.generateText",
            telemetry
          }),
          ...baseTelemetryAttributes,
          // model:
          "ai.model.provider": model.provider,
          "ai.model.id": model.modelId,
          // specific settings that only make sense on the outer level:
          "ai.prompt": {
            input: /* @__PURE__ */ __name(() => JSON.stringify({
              system,
              prompt,
              messages
            }), "input")
          }
        }
      }),
      tracer,
      fn: /* @__PURE__ */ __name(async (span) => {
        var _a17, _b8, _c, _d, _e, _f, _g;
        const callSettings2 = prepareCallSettings(settings);
        let currentModelResponse;
        let clientToolCalls = [];
        let clientToolOutputs = [];
        const responseMessages = [];
        const steps = [];
        do {
          const stepInputMessages = [
            ...initialPrompt.messages,
            ...responseMessages
          ];
          const prepareStepResult = await (prepareStep == null ? void 0 : prepareStep({
            model,
            steps,
            stepNumber: steps.length,
            messages: stepInputMessages
          }));
          const stepModel = resolveLanguageModel((_a17 = prepareStepResult == null ? void 0 : prepareStepResult.model) != null ? _a17 : model);
          const promptMessages = await convertToLanguageModelPrompt({
            prompt: {
              system: (_b8 = prepareStepResult == null ? void 0 : prepareStepResult.system) != null ? _b8 : initialPrompt.system,
              messages: (_c = prepareStepResult == null ? void 0 : prepareStepResult.messages) != null ? _c : stepInputMessages
            },
            supportedUrls: await stepModel.supportedUrls,
            download: download2
          });
          const { toolChoice: stepToolChoice, tools: stepTools } = prepareToolsAndToolChoice({
            tools,
            toolChoice: (_d = prepareStepResult == null ? void 0 : prepareStepResult.toolChoice) != null ? _d : toolChoice,
            activeTools: (_e = prepareStepResult == null ? void 0 : prepareStepResult.activeTools) != null ? _e : activeTools
          });
          currentModelResponse = await retry(() => {
            var _a18;
            return recordSpan({
              name: "ai.generateText.doGenerate",
              attributes: selectTelemetryAttributes({
                telemetry,
                attributes: {
                  ...assembleOperationName({
                    operationId: "ai.generateText.doGenerate",
                    telemetry
                  }),
                  ...baseTelemetryAttributes,
                  // model:
                  "ai.model.provider": stepModel.provider,
                  "ai.model.id": stepModel.modelId,
                  // prompt:
                  "ai.prompt.messages": {
                    input: /* @__PURE__ */ __name(() => stringifyForTelemetry(promptMessages), "input")
                  },
                  "ai.prompt.tools": {
                    // convert the language model level tools:
                    input: /* @__PURE__ */ __name(() => stepTools == null ? void 0 : stepTools.map((tool3) => JSON.stringify(tool3)), "input")
                  },
                  "ai.prompt.toolChoice": {
                    input: /* @__PURE__ */ __name(() => stepToolChoice != null ? JSON.stringify(stepToolChoice) : void 0, "input")
                  },
                  // standardized gen-ai llm span attributes:
                  "gen_ai.system": stepModel.provider,
                  "gen_ai.request.model": stepModel.modelId,
                  "gen_ai.request.frequency_penalty": settings.frequencyPenalty,
                  "gen_ai.request.max_tokens": settings.maxOutputTokens,
                  "gen_ai.request.presence_penalty": settings.presencePenalty,
                  "gen_ai.request.stop_sequences": settings.stopSequences,
                  "gen_ai.request.temperature": (_a18 = settings.temperature) != null ? _a18 : void 0,
                  "gen_ai.request.top_k": settings.topK,
                  "gen_ai.request.top_p": settings.topP
                }
              }),
              tracer,
              fn: /* @__PURE__ */ __name(async (span2) => {
                var _a19, _b22, _c2, _d2, _e2, _f2, _g2, _h;
                const result = await stepModel.doGenerate({
                  ...callSettings2,
                  tools: stepTools,
                  toolChoice: stepToolChoice,
                  responseFormat: output == null ? void 0 : output.responseFormat,
                  prompt: promptMessages,
                  providerOptions,
                  abortSignal,
                  headers: headersWithUserAgent
                });
                const responseData = {
                  id: (_b22 = (_a19 = result.response) == null ? void 0 : _a19.id) != null ? _b22 : generateId3(),
                  timestamp: (_d2 = (_c2 = result.response) == null ? void 0 : _c2.timestamp) != null ? _d2 : currentDate(),
                  modelId: (_f2 = (_e2 = result.response) == null ? void 0 : _e2.modelId) != null ? _f2 : stepModel.modelId,
                  headers: (_g2 = result.response) == null ? void 0 : _g2.headers,
                  body: (_h = result.response) == null ? void 0 : _h.body
                };
                span2.setAttributes(selectTelemetryAttributes({
                  telemetry,
                  attributes: {
                    "ai.response.finishReason": result.finishReason,
                    "ai.response.text": {
                      output: /* @__PURE__ */ __name(() => extractTextContent(result.content), "output")
                    },
                    "ai.response.toolCalls": {
                      output: /* @__PURE__ */ __name(() => {
                        const toolCalls = asToolCalls(result.content);
                        return toolCalls == null ? void 0 : JSON.stringify(toolCalls);
                      }, "output")
                    },
                    "ai.response.id": responseData.id,
                    "ai.response.model": responseData.modelId,
                    "ai.response.timestamp": responseData.timestamp.toISOString(),
                    "ai.response.providerMetadata": JSON.stringify(result.providerMetadata),
                    // TODO rename telemetry attributes to inputTokens and outputTokens
                    "ai.usage.promptTokens": result.usage.inputTokens,
                    "ai.usage.completionTokens": result.usage.outputTokens,
                    // standardized gen-ai llm span attributes:
                    "gen_ai.response.finish_reasons": [
                      result.finishReason
                    ],
                    "gen_ai.response.id": responseData.id,
                    "gen_ai.response.model": responseData.modelId,
                    "gen_ai.usage.input_tokens": result.usage.inputTokens,
                    "gen_ai.usage.output_tokens": result.usage.outputTokens
                  }
                }));
                return {
                  ...result,
                  response: responseData
                };
              }, "fn")
            });
          });
          const stepToolCalls = await Promise.all(currentModelResponse.content.filter((part) => part.type === "tool-call").map((toolCall) => parseToolCall({
            toolCall,
            tools,
            repairToolCall,
            system,
            messages: stepInputMessages
          })));
          for (const toolCall of stepToolCalls) {
            if (toolCall.invalid) {
              continue;
            }
            const tool3 = tools[toolCall.toolName];
            if ((tool3 == null ? void 0 : tool3.onInputAvailable) != null) {
              await tool3.onInputAvailable({
                input: toolCall.input,
                toolCallId: toolCall.toolCallId,
                messages: stepInputMessages,
                abortSignal,
                experimental_context
              });
            }
          }
          const invalidToolCalls = stepToolCalls.filter((toolCall) => toolCall.invalid && toolCall.dynamic);
          clientToolOutputs = [];
          for (const toolCall of invalidToolCalls) {
            clientToolOutputs.push({
              type: "tool-error",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              error: getErrorMessage2(toolCall.error),
              dynamic: true
            });
          }
          clientToolCalls = stepToolCalls.filter((toolCall) => !toolCall.providerExecuted);
          if (tools != null) {
            clientToolOutputs.push(...await executeTools({
              toolCalls: clientToolCalls.filter((toolCall) => !toolCall.invalid),
              tools,
              tracer,
              telemetry,
              messages: stepInputMessages,
              abortSignal,
              experimental_context
            }));
          }
          const stepContent = asContent({
            content: currentModelResponse.content,
            toolCalls: stepToolCalls,
            toolOutputs: clientToolOutputs
          });
          responseMessages.push(...toResponseMessages({
            content: stepContent,
            tools
          }));
          const currentStepResult = new DefaultStepResult({
            content: stepContent,
            finishReason: currentModelResponse.finishReason,
            usage: currentModelResponse.usage,
            warnings: currentModelResponse.warnings,
            providerMetadata: currentModelResponse.providerMetadata,
            request: (_f = currentModelResponse.request) != null ? _f : {},
            response: {
              ...currentModelResponse.response,
              // deep clone msgs to avoid mutating past messages in multi-step:
              messages: structuredClone(responseMessages)
            }
          });
          logWarnings((_g = currentModelResponse.warnings) != null ? _g : []);
          steps.push(currentStepResult);
          await (onStepFinish == null ? void 0 : onStepFinish(currentStepResult));
        } while (
          // there are tool calls:
          clientToolCalls.length > 0 && // all current tool calls have outputs (incl. execution errors):
          clientToolOutputs.length === clientToolCalls.length && // continue until a stop condition is met:
          !await isStopConditionMet({
            stopConditions,
            steps
          })
        );
        span.setAttributes(selectTelemetryAttributes({
          telemetry,
          attributes: {
            "ai.response.finishReason": currentModelResponse.finishReason,
            "ai.response.text": {
              output: /* @__PURE__ */ __name(() => extractTextContent(currentModelResponse.content), "output")
            },
            "ai.response.toolCalls": {
              output: /* @__PURE__ */ __name(() => {
                const toolCalls = asToolCalls(currentModelResponse.content);
                return toolCalls == null ? void 0 : JSON.stringify(toolCalls);
              }, "output")
            },
            "ai.response.providerMetadata": JSON.stringify(currentModelResponse.providerMetadata),
            // TODO rename telemetry attributes to inputTokens and outputTokens
            "ai.usage.promptTokens": currentModelResponse.usage.inputTokens,
            "ai.usage.completionTokens": currentModelResponse.usage.outputTokens
          }
        }));
        const lastStep = steps[steps.length - 1];
        let resolvedOutput;
        if (lastStep.finishReason === "stop") {
          resolvedOutput = await (output == null ? void 0 : output.parseOutput({
            text: lastStep.text
          }, {
            response: lastStep.response,
            usage: lastStep.usage,
            finishReason: lastStep.finishReason
          }));
        }
        return new DefaultGenerateTextResult({
          steps,
          resolvedOutput
        });
      }, "fn")
    });
  } catch (error45) {
    throw wrapGatewayError(error45);
  }
}
__name(generateText, "generateText");
async function executeTools({ toolCalls, tools, tracer, telemetry, messages, abortSignal, experimental_context }) {
  const toolOutputs = await Promise.all(toolCalls.map(async ({ toolCallId, toolName, input }) => {
    const tool3 = tools[toolName];
    if ((tool3 == null ? void 0 : tool3.execute) == null) {
      return void 0;
    }
    return recordSpan({
      name: "ai.toolCall",
      attributes: selectTelemetryAttributes({
        telemetry,
        attributes: {
          ...assembleOperationName({
            operationId: "ai.toolCall",
            telemetry
          }),
          "ai.toolCall.name": toolName,
          "ai.toolCall.id": toolCallId,
          "ai.toolCall.args": {
            output: /* @__PURE__ */ __name(() => JSON.stringify(input), "output")
          }
        }
      }),
      tracer,
      fn: /* @__PURE__ */ __name(async (span) => {
        try {
          const stream = executeTool({
            execute: tool3.execute.bind(tool3),
            input,
            options: {
              toolCallId,
              messages,
              abortSignal,
              experimental_context
            }
          });
          let output;
          for await (const part of stream) {
            if (part.type === "final") {
              output = part.output;
            }
          }
          try {
            span.setAttributes(selectTelemetryAttributes({
              telemetry,
              attributes: {
                "ai.toolCall.result": {
                  output: /* @__PURE__ */ __name(() => JSON.stringify(output), "output")
                }
              }
            }));
          } catch (ignored) {
          }
          return {
            type: "tool-result",
            toolCallId,
            toolName,
            input,
            output,
            dynamic: tool3.type === "dynamic"
          };
        } catch (error45) {
          recordErrorOnSpan(span, error45);
          return {
            type: "tool-error",
            toolCallId,
            toolName,
            input,
            error: error45,
            dynamic: tool3.type === "dynamic"
          };
        }
      }, "fn")
    });
  }));
  return toolOutputs.filter((output) => output != null);
}
__name(executeTools, "executeTools");
var DefaultGenerateTextResult = class {
  static {
    __name(this, "DefaultGenerateTextResult");
  }
  constructor(options) {
    this.steps = options.steps;
    this.resolvedOutput = options.resolvedOutput;
  }
  get finalStep() {
    return this.steps[this.steps.length - 1];
  }
  get content() {
    return this.finalStep.content;
  }
  get text() {
    return this.finalStep.text;
  }
  get files() {
    return this.finalStep.files;
  }
  get reasoningText() {
    return this.finalStep.reasoningText;
  }
  get reasoning() {
    return this.finalStep.reasoning;
  }
  get toolCalls() {
    return this.finalStep.toolCalls;
  }
  get staticToolCalls() {
    return this.finalStep.staticToolCalls;
  }
  get dynamicToolCalls() {
    return this.finalStep.dynamicToolCalls;
  }
  get toolResults() {
    return this.finalStep.toolResults;
  }
  get staticToolResults() {
    return this.finalStep.staticToolResults;
  }
  get dynamicToolResults() {
    return this.finalStep.dynamicToolResults;
  }
  get sources() {
    return this.finalStep.sources;
  }
  get finishReason() {
    return this.finalStep.finishReason;
  }
  get warnings() {
    return this.finalStep.warnings;
  }
  get providerMetadata() {
    return this.finalStep.providerMetadata;
  }
  get response() {
    return this.finalStep.response;
  }
  get request() {
    return this.finalStep.request;
  }
  get usage() {
    return this.finalStep.usage;
  }
  get totalUsage() {
    return this.steps.reduce((totalUsage, step) => {
      return addLanguageModelUsage(totalUsage, step.usage);
    }, {
      inputTokens: void 0,
      outputTokens: void 0,
      totalTokens: void 0,
      reasoningTokens: void 0,
      cachedInputTokens: void 0
    });
  }
  get experimental_output() {
    if (this.resolvedOutput == null) {
      throw new NoOutputSpecifiedError();
    }
    return this.resolvedOutput;
  }
};
function asToolCalls(content) {
  const parts = content.filter((part) => part.type === "tool-call");
  if (parts.length === 0) {
    return void 0;
  }
  return parts.map((toolCall) => ({
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input
  }));
}
__name(asToolCalls, "asToolCalls");
function asContent({ content, toolCalls, toolOutputs }) {
  return [
    ...content.map((part) => {
      switch (part.type) {
        case "text":
        case "reasoning":
        case "source":
          return part;
        case "file": {
          return {
            type: "file",
            file: new DefaultGeneratedFile(part)
          };
        }
        case "tool-call": {
          return toolCalls.find((toolCall) => toolCall.toolCallId === part.toolCallId);
        }
        case "tool-result": {
          const toolCall = toolCalls.find((toolCall2) => toolCall2.toolCallId === part.toolCallId);
          if (toolCall == null) {
            throw new Error(\`Tool call \${part.toolCallId} not found.\`);
          }
          if (part.isError) {
            return {
              type: "tool-error",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: toolCall.input,
              error: part.result,
              providerExecuted: true,
              dynamic: toolCall.dynamic
            };
          }
          return {
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: toolCall.input,
            output: part.result,
            providerExecuted: true,
            dynamic: toolCall.dynamic
          };
        }
      }
    }),
    ...toolOutputs
  ];
}
__name(asContent, "asContent");
var JsonToSseTransformStream = class extends TransformStream {
  static {
    __name(this, "JsonToSseTransformStream");
  }
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(\`data: \${JSON.stringify(part)}

\`);
      },
      flush(controller) {
        controller.enqueue("data: [DONE]\\n\\n");
      }
    });
  }
};
var uiMessageChunkSchema = lazyValidator(() => zodSchema(external_exports.union([
  external_exports.strictObject({
    type: external_exports.literal("text-start"),
    id: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("text-delta"),
    id: external_exports.string(),
    delta: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("text-end"),
    id: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("error"),
    errorText: external_exports.string()
  }),
  external_exports.strictObject({
    type: external_exports.literal("tool-input-start"),
    toolCallId: external_exports.string(),
    toolName: external_exports.string(),
    providerExecuted: external_exports.boolean().optional(),
    dynamic: external_exports.boolean().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("tool-input-delta"),
    toolCallId: external_exports.string(),
    inputTextDelta: external_exports.string()
  }),
  external_exports.strictObject({
    type: external_exports.literal("tool-input-available"),
    toolCallId: external_exports.string(),
    toolName: external_exports.string(),
    input: external_exports.unknown(),
    providerExecuted: external_exports.boolean().optional(),
    providerMetadata: providerMetadataSchema.optional(),
    dynamic: external_exports.boolean().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("tool-input-error"),
    toolCallId: external_exports.string(),
    toolName: external_exports.string(),
    input: external_exports.unknown(),
    providerExecuted: external_exports.boolean().optional(),
    providerMetadata: providerMetadataSchema.optional(),
    dynamic: external_exports.boolean().optional(),
    errorText: external_exports.string()
  }),
  external_exports.strictObject({
    type: external_exports.literal("tool-output-available"),
    toolCallId: external_exports.string(),
    output: external_exports.unknown(),
    providerExecuted: external_exports.boolean().optional(),
    dynamic: external_exports.boolean().optional(),
    preliminary: external_exports.boolean().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("tool-output-error"),
    toolCallId: external_exports.string(),
    errorText: external_exports.string(),
    providerExecuted: external_exports.boolean().optional(),
    dynamic: external_exports.boolean().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("reasoning-start"),
    id: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("reasoning-delta"),
    id: external_exports.string(),
    delta: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("reasoning-end"),
    id: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("source-url"),
    sourceId: external_exports.string(),
    url: external_exports.string(),
    title: external_exports.string().optional(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("source-document"),
    sourceId: external_exports.string(),
    mediaType: external_exports.string(),
    title: external_exports.string(),
    filename: external_exports.string().optional(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("file"),
    url: external_exports.string(),
    mediaType: external_exports.string(),
    providerMetadata: providerMetadataSchema.optional()
  }),
  external_exports.strictObject({
    type: external_exports.custom((value) => typeof value === "string" && value.startsWith("data-"), {
      message: 'Type must start with "data-"'
    }),
    id: external_exports.string().optional(),
    data: external_exports.unknown(),
    transient: external_exports.boolean().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("start-step")
  }),
  external_exports.strictObject({
    type: external_exports.literal("finish-step")
  }),
  external_exports.strictObject({
    type: external_exports.literal("start"),
    messageId: external_exports.string().optional(),
    messageMetadata: external_exports.unknown().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("finish"),
    messageMetadata: external_exports.unknown().optional()
  }),
  external_exports.strictObject({
    type: external_exports.literal("abort")
  }),
  external_exports.strictObject({
    type: external_exports.literal("message-metadata"),
    messageMetadata: external_exports.unknown()
  })
])));
function fixJson(input) {
  const stack = [
    "ROOT"
  ];
  let lastValidIndex = -1;
  let literalStart = null;
  function processValueStart(char, i, swapState) {
    {
      switch (char) {
        case '"': {
          lastValidIndex = i;
          stack.pop();
          stack.push(swapState);
          stack.push("INSIDE_STRING");
          break;
        }
        case "f":
        case "t":
        case "n": {
          lastValidIndex = i;
          literalStart = i;
          stack.pop();
          stack.push(swapState);
          stack.push("INSIDE_LITERAL");
          break;
        }
        case "-": {
          stack.pop();
          stack.push(swapState);
          stack.push("INSIDE_NUMBER");
          break;
        }
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9": {
          lastValidIndex = i;
          stack.pop();
          stack.push(swapState);
          stack.push("INSIDE_NUMBER");
          break;
        }
        case "{": {
          lastValidIndex = i;
          stack.pop();
          stack.push(swapState);
          stack.push("INSIDE_OBJECT_START");
          break;
        }
        case "[": {
          lastValidIndex = i;
          stack.pop();
          stack.push(swapState);
          stack.push("INSIDE_ARRAY_START");
          break;
        }
      }
    }
  }
  __name(processValueStart, "processValueStart");
  function processAfterObjectValue(char, i) {
    switch (char) {
      case ",": {
        stack.pop();
        stack.push("INSIDE_OBJECT_AFTER_COMMA");
        break;
      }
      case "}": {
        lastValidIndex = i;
        stack.pop();
        break;
      }
    }
  }
  __name(processAfterObjectValue, "processAfterObjectValue");
  function processAfterArrayValue(char, i) {
    switch (char) {
      case ",": {
        stack.pop();
        stack.push("INSIDE_ARRAY_AFTER_COMMA");
        break;
      }
      case "]": {
        lastValidIndex = i;
        stack.pop();
        break;
      }
    }
  }
  __name(processAfterArrayValue, "processAfterArrayValue");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const currentState = stack[stack.length - 1];
    switch (currentState) {
      case "ROOT":
        processValueStart(char, i, "FINISH");
        break;
      case "INSIDE_OBJECT_START": {
        switch (char) {
          case '"': {
            stack.pop();
            stack.push("INSIDE_OBJECT_KEY");
            break;
          }
          case "}": {
            lastValidIndex = i;
            stack.pop();
            break;
          }
        }
        break;
      }
      case "INSIDE_OBJECT_AFTER_COMMA": {
        switch (char) {
          case '"': {
            stack.pop();
            stack.push("INSIDE_OBJECT_KEY");
            break;
          }
        }
        break;
      }
      case "INSIDE_OBJECT_KEY": {
        switch (char) {
          case '"': {
            stack.pop();
            stack.push("INSIDE_OBJECT_AFTER_KEY");
            break;
          }
        }
        break;
      }
      case "INSIDE_OBJECT_AFTER_KEY": {
        switch (char) {
          case ":": {
            stack.pop();
            stack.push("INSIDE_OBJECT_BEFORE_VALUE");
            break;
          }
        }
        break;
      }
      case "INSIDE_OBJECT_BEFORE_VALUE": {
        processValueStart(char, i, "INSIDE_OBJECT_AFTER_VALUE");
        break;
      }
      case "INSIDE_OBJECT_AFTER_VALUE": {
        processAfterObjectValue(char, i);
        break;
      }
      case "INSIDE_STRING": {
        switch (char) {
          case '"': {
            stack.pop();
            lastValidIndex = i;
            break;
          }
          case "\\\\": {
            stack.push("INSIDE_STRING_ESCAPE");
            break;
          }
          default: {
            lastValidIndex = i;
          }
        }
        break;
      }
      case "INSIDE_ARRAY_START": {
        switch (char) {
          case "]": {
            lastValidIndex = i;
            stack.pop();
            break;
          }
          default: {
            lastValidIndex = i;
            processValueStart(char, i, "INSIDE_ARRAY_AFTER_VALUE");
            break;
          }
        }
        break;
      }
      case "INSIDE_ARRAY_AFTER_VALUE": {
        switch (char) {
          case ",": {
            stack.pop();
            stack.push("INSIDE_ARRAY_AFTER_COMMA");
            break;
          }
          case "]": {
            lastValidIndex = i;
            stack.pop();
            break;
          }
          default: {
            lastValidIndex = i;
            break;
          }
        }
        break;
      }
      case "INSIDE_ARRAY_AFTER_COMMA": {
        processValueStart(char, i, "INSIDE_ARRAY_AFTER_VALUE");
        break;
      }
      case "INSIDE_STRING_ESCAPE": {
        stack.pop();
        lastValidIndex = i;
        break;
      }
      case "INSIDE_NUMBER": {
        switch (char) {
          case "0":
          case "1":
          case "2":
          case "3":
          case "4":
          case "5":
          case "6":
          case "7":
          case "8":
          case "9": {
            lastValidIndex = i;
            break;
          }
          case "e":
          case "E":
          case "-":
          case ".": {
            break;
          }
          case ",": {
            stack.pop();
            if (stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE") {
              processAfterArrayValue(char, i);
            }
            if (stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE") {
              processAfterObjectValue(char, i);
            }
            break;
          }
          case "}": {
            stack.pop();
            if (stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE") {
              processAfterObjectValue(char, i);
            }
            break;
          }
          case "]": {
            stack.pop();
            if (stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE") {
              processAfterArrayValue(char, i);
            }
            break;
          }
          default: {
            stack.pop();
            break;
          }
        }
        break;
      }
      case "INSIDE_LITERAL": {
        const partialLiteral = input.substring(literalStart, i + 1);
        if (!"false".startsWith(partialLiteral) && !"true".startsWith(partialLiteral) && !"null".startsWith(partialLiteral)) {
          stack.pop();
          if (stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE") {
            processAfterObjectValue(char, i);
          } else if (stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE") {
            processAfterArrayValue(char, i);
          }
        } else {
          lastValidIndex = i;
        }
        break;
      }
    }
  }
  let result = input.slice(0, lastValidIndex + 1);
  for (let i = stack.length - 1; i >= 0; i--) {
    const state = stack[i];
    switch (state) {
      case "INSIDE_STRING": {
        result += '"';
        break;
      }
      case "INSIDE_OBJECT_KEY":
      case "INSIDE_OBJECT_AFTER_KEY":
      case "INSIDE_OBJECT_AFTER_COMMA":
      case "INSIDE_OBJECT_START":
      case "INSIDE_OBJECT_BEFORE_VALUE":
      case "INSIDE_OBJECT_AFTER_VALUE": {
        result += "}";
        break;
      }
      case "INSIDE_ARRAY_START":
      case "INSIDE_ARRAY_AFTER_COMMA":
      case "INSIDE_ARRAY_AFTER_VALUE": {
        result += "]";
        break;
      }
      case "INSIDE_LITERAL": {
        const partialLiteral = input.substring(literalStart, input.length);
        if ("true".startsWith(partialLiteral)) {
          result += "true".slice(partialLiteral.length);
        } else if ("false".startsWith(partialLiteral)) {
          result += "false".slice(partialLiteral.length);
        } else if ("null".startsWith(partialLiteral)) {
          result += "null".slice(partialLiteral.length);
        }
      }
    }
  }
  return result;
}
__name(fixJson, "fixJson");
async function parsePartialJson(jsonText) {
  if (jsonText === void 0) {
    return {
      value: void 0,
      state: "undefined-input"
    };
  }
  let result = await safeParseJSON({
    text: jsonText
  });
  if (result.success) {
    return {
      value: result.value,
      state: "successful-parse"
    };
  }
  result = await safeParseJSON({
    text: fixJson(jsonText)
  });
  if (result.success) {
    return {
      value: result.value,
      state: "repaired-parse"
    };
  }
  return {
    value: void 0,
    state: "failed-parse"
  };
}
__name(parsePartialJson, "parsePartialJson");
var output_exports = {};
__export2(output_exports, {
  object: /* @__PURE__ */ __name(() => object2, "object"),
  text: /* @__PURE__ */ __name(() => text, "text")
});
var text = /* @__PURE__ */ __name(() => ({
  type: "text",
  responseFormat: {
    type: "text"
  },
  async parsePartial({ text: text2 }) {
    return {
      partial: text2
    };
  },
  async parseOutput({ text: text2 }) {
    return text2;
  }
}), "text");
var object2 = /* @__PURE__ */ __name(({ schema: inputSchema }) => {
  const schema = asSchema(inputSchema);
  return {
    type: "object",
    responseFormat: {
      type: "json",
      schema: schema.jsonSchema
    },
    async parsePartial({ text: text2 }) {
      const result = await parsePartialJson(text2);
      switch (result.state) {
        case "failed-parse":
        case "undefined-input":
          return void 0;
        case "repaired-parse":
        case "successful-parse":
          return {
            // Note: currently no validation of partial results:
            partial: result.value
          };
        default: {
          const _exhaustiveCheck = result.state;
          throw new Error(\`Unsupported parse state: \${_exhaustiveCheck}\`);
        }
      }
    },
    async parseOutput({ text: text2 }, context) {
      const parseResult = await safeParseJSON({
        text: text2
      });
      if (!parseResult.success) {
        throw new NoObjectGeneratedError({
          message: "No object generated: could not parse the response.",
          cause: parseResult.error,
          text: text2,
          response: context.response,
          usage: context.usage,
          finishReason: context.finishReason
        });
      }
      const validationResult = await safeValidateTypes({
        value: parseResult.value,
        schema
      });
      if (!validationResult.success) {
        throw new NoObjectGeneratedError({
          message: "No object generated: response did not match schema.",
          cause: validationResult.error,
          text: text2,
          response: context.response,
          usage: context.usage,
          finishReason: context.finishReason
        });
      }
      return validationResult.value;
    }
  };
}, "object");
var name16 = "AI_NoSuchProviderError";
var marker162 = \`vercel.ai.error.\${name16}\`;
var symbol162 = Symbol.for(marker162);
var _a162;
_a162 = symbol162;
var ClientOrServerImplementationSchema = external_exports.looseObject({
  name: external_exports.string(),
  version: external_exports.string()
});
var BaseParamsSchema = external_exports.looseObject({
  _meta: external_exports.optional(external_exports.object({}).loose())
});
var ResultSchema = BaseParamsSchema;
var RequestSchema = external_exports.object({
  method: external_exports.string(),
  params: external_exports.optional(BaseParamsSchema)
});
var ServerCapabilitiesSchema = external_exports.looseObject({
  experimental: external_exports.optional(external_exports.object({}).loose()),
  logging: external_exports.optional(external_exports.object({}).loose()),
  prompts: external_exports.optional(external_exports.looseObject({
    listChanged: external_exports.optional(external_exports.boolean())
  })),
  resources: external_exports.optional(external_exports.looseObject({
    subscribe: external_exports.optional(external_exports.boolean()),
    listChanged: external_exports.optional(external_exports.boolean())
  })),
  tools: external_exports.optional(external_exports.looseObject({
    listChanged: external_exports.optional(external_exports.boolean())
  }))
});
var InitializeResultSchema = ResultSchema.extend({
  protocolVersion: external_exports.string(),
  capabilities: ServerCapabilitiesSchema,
  serverInfo: ClientOrServerImplementationSchema,
  instructions: external_exports.optional(external_exports.string())
});
var PaginatedResultSchema = ResultSchema.extend({
  nextCursor: external_exports.optional(external_exports.string())
});
var ToolSchema = external_exports.object({
  name: external_exports.string(),
  description: external_exports.optional(external_exports.string()),
  inputSchema: external_exports.object({
    type: external_exports.literal("object"),
    properties: external_exports.optional(external_exports.object({}).loose())
  }).loose()
}).loose();
var ListToolsResultSchema = PaginatedResultSchema.extend({
  tools: external_exports.array(ToolSchema)
});
var TextContentSchema = external_exports.object({
  type: external_exports.literal("text"),
  text: external_exports.string()
}).loose();
var ImageContentSchema = external_exports.object({
  type: external_exports.literal("image"),
  data: external_exports.base64(),
  mimeType: external_exports.string()
}).loose();
var ResourceContentsSchema = external_exports.object({
  /**
  * The URI of this resource.
  */
  uri: external_exports.string(),
  /**
  * The MIME type of this resource, if known.
  */
  mimeType: external_exports.optional(external_exports.string())
}).loose();
var TextResourceContentsSchema = ResourceContentsSchema.extend({
  text: external_exports.string()
});
var BlobResourceContentsSchema = ResourceContentsSchema.extend({
  blob: external_exports.base64()
});
var EmbeddedResourceSchema = external_exports.object({
  type: external_exports.literal("resource"),
  resource: external_exports.union([
    TextResourceContentsSchema,
    BlobResourceContentsSchema
  ])
}).loose();
var CallToolResultSchema = ResultSchema.extend({
  content: external_exports.array(external_exports.union([
    TextContentSchema,
    ImageContentSchema,
    EmbeddedResourceSchema
  ])),
  isError: external_exports.boolean().default(false).optional()
}).or(ResultSchema.extend({
  toolResult: external_exports.unknown()
}));
var JSONRPC_VERSION = "2.0";
var JSONRPCRequestSchema = external_exports.object({
  jsonrpc: external_exports.literal(JSONRPC_VERSION),
  id: external_exports.union([
    external_exports.string(),
    external_exports.number().int()
  ])
}).merge(RequestSchema).strict();
var JSONRPCResponseSchema = external_exports.object({
  jsonrpc: external_exports.literal(JSONRPC_VERSION),
  id: external_exports.union([
    external_exports.string(),
    external_exports.number().int()
  ]),
  result: ResultSchema
}).strict();
var JSONRPCErrorSchema = external_exports.object({
  jsonrpc: external_exports.literal(JSONRPC_VERSION),
  id: external_exports.union([
    external_exports.string(),
    external_exports.number().int()
  ]),
  error: external_exports.object({
    code: external_exports.number().int(),
    message: external_exports.string(),
    data: external_exports.optional(external_exports.unknown())
  })
}).strict();
var JSONRPCNotificationSchema = external_exports.object({
  jsonrpc: external_exports.literal(JSONRPC_VERSION)
}).merge(external_exports.object({
  method: external_exports.string(),
  params: external_exports.optional(BaseParamsSchema)
})).strict();
var JSONRPCMessageSchema = external_exports.union([
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResponseSchema,
  JSONRPCErrorSchema
]);
var uiMessagesSchema = lazyValidator(() => zodSchema(external_exports.array(external_exports.object({
  id: external_exports.string(),
  role: external_exports.enum([
    "system",
    "user",
    "assistant"
  ]),
  metadata: external_exports.unknown().optional(),
  parts: external_exports.array(external_exports.union([
    external_exports.object({
      type: external_exports.literal("text"),
      text: external_exports.string(),
      state: external_exports.enum([
        "streaming",
        "done"
      ]).optional(),
      providerMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.literal("reasoning"),
      text: external_exports.string(),
      state: external_exports.enum([
        "streaming",
        "done"
      ]).optional(),
      providerMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.literal("source-url"),
      sourceId: external_exports.string(),
      url: external_exports.string(),
      title: external_exports.string().optional(),
      providerMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.literal("source-document"),
      sourceId: external_exports.string(),
      mediaType: external_exports.string(),
      title: external_exports.string(),
      filename: external_exports.string().optional(),
      providerMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.literal("file"),
      mediaType: external_exports.string(),
      filename: external_exports.string().optional(),
      url: external_exports.string(),
      providerMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.literal("step-start")
    }),
    external_exports.object({
      type: external_exports.string().startsWith("data-"),
      id: external_exports.string().optional(),
      data: external_exports.unknown()
    }),
    external_exports.object({
      type: external_exports.literal("dynamic-tool"),
      toolName: external_exports.string(),
      toolCallId: external_exports.string(),
      state: external_exports.literal("input-streaming"),
      input: external_exports.unknown().optional(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional()
    }),
    external_exports.object({
      type: external_exports.literal("dynamic-tool"),
      toolName: external_exports.string(),
      toolCallId: external_exports.string(),
      state: external_exports.literal("input-available"),
      input: external_exports.unknown(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.literal("dynamic-tool"),
      toolName: external_exports.string(),
      toolCallId: external_exports.string(),
      state: external_exports.literal("output-available"),
      input: external_exports.unknown(),
      output: external_exports.unknown(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional(),
      preliminary: external_exports.boolean().optional()
    }),
    external_exports.object({
      type: external_exports.literal("dynamic-tool"),
      toolName: external_exports.string(),
      toolCallId: external_exports.string(),
      state: external_exports.literal("output-error"),
      input: external_exports.unknown(),
      output: external_exports.never().optional(),
      errorText: external_exports.string(),
      callProviderMetadata: providerMetadataSchema.optional()
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("input-streaming"),
      providerExecuted: external_exports.boolean().optional(),
      input: external_exports.unknown().optional(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional(),
      approval: external_exports.never().optional()
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("input-available"),
      providerExecuted: external_exports.boolean().optional(),
      input: external_exports.unknown(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional(),
      approval: external_exports.never().optional()
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("approval-requested"),
      input: external_exports.unknown(),
      providerExecuted: external_exports.boolean().optional(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional(),
      approval: external_exports.object({
        id: external_exports.string(),
        approved: external_exports.never().optional(),
        reason: external_exports.never().optional()
      })
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("approval-responded"),
      input: external_exports.unknown(),
      providerExecuted: external_exports.boolean().optional(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional(),
      approval: external_exports.object({
        id: external_exports.string(),
        approved: external_exports.boolean(),
        reason: external_exports.string().optional()
      })
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("output-available"),
      providerExecuted: external_exports.boolean().optional(),
      input: external_exports.unknown(),
      output: external_exports.unknown(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional(),
      preliminary: external_exports.boolean().optional(),
      approval: external_exports.object({
        id: external_exports.string(),
        approved: external_exports.literal(true),
        reason: external_exports.string().optional()
      }).optional()
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("output-error"),
      providerExecuted: external_exports.boolean().optional(),
      input: external_exports.unknown(),
      output: external_exports.never().optional(),
      errorText: external_exports.string(),
      callProviderMetadata: providerMetadataSchema.optional(),
      approval: external_exports.object({
        id: external_exports.string(),
        approved: external_exports.literal(true),
        reason: external_exports.string().optional()
      }).optional()
    }),
    external_exports.object({
      type: external_exports.string().startsWith("tool-"),
      toolCallId: external_exports.string(),
      state: external_exports.literal("output-denied"),
      providerExecuted: external_exports.boolean().optional(),
      input: external_exports.unknown(),
      output: external_exports.never().optional(),
      errorText: external_exports.never().optional(),
      callProviderMetadata: providerMetadataSchema.optional(),
      approval: external_exports.object({
        id: external_exports.string(),
        approved: external_exports.literal(false),
        reason: external_exports.string().optional()
      })
    })
  ]))
}))));

// ../example/workflows/4_ai.ts
async function getWeatherInformation({ city }) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/4_ai.ts//getWeatherInformation")({
    city
  });
}
__name(getWeatherInformation, "getWeatherInformation");
async function ai(prompt) {
  console.log("AI workflow started");
  const { text: text2 } = await generateText({
    model: "openai/o3",
    prompt
  });
  console.log(\`AI workflow completed. Result: \${text2}\`);
  return text2;
}
__name(ai, "ai");
async function agent(prompt) {
  console.log("Agent workflow started");
  const { text: text2 } = await generateText({
    model: "anthropic/claude-4-opus-20250514",
    prompt,
    tools: {
      getWeatherInformation: {
        description: "show the weather in a given city to the user",
        inputSchema: v4_default.object({
          city: v4_default.string()
        }),
        execute: getWeatherInformation
      }
    },
    // This can be a high as you want - no restriction on the lambda workflow runtime
    stopWhen: stepCountIs(10)
  });
  console.log(\`Agent workflow completed. Result: \${text2}\`);
  return text2;
}
__name(agent, "agent");
ai.workflowId = "workflow//example/workflows/4_ai.ts//ai";
agent.workflowId = "workflow//example/workflows/4_ai.ts//agent";

// ../example/workflows/5_hooks.ts
var hooks_exports = {};
__export(hooks_exports, {
  withCreateHook: () => withCreateHook,
  withWorkflowMetadata: () => withWorkflowMetadata
});

// ../../packages/errors/dist/index.js
var import_ms2 = __toESM(require_ms(), 1);

// ../../packages/core/dist/symbols.js
var WORKFLOW_USE_STEP = Symbol.for("WORKFLOW_USE_STEP");
var WORKFLOW_CREATE_HOOK = Symbol.for("WORKFLOW_CREATE_HOOK");
var WORKFLOW_CONTEXT = Symbol.for("WORKFLOW_CONTEXT");
var WORKFLOW_GET_STREAM_ID = Symbol.for("WORKFLOW_GET_STREAM_ID");
var STREAM_NAME_SYMBOL = Symbol.for("WORKFLOW_STREAM_NAME");
var STREAM_TYPE_SYMBOL = Symbol.for("WORKFLOW_STREAM_TYPE");
var BODY_INIT_SYMBOL = Symbol.for("BODY_INIT");
var WEBHOOK_RESPONSE_WRITABLE = Symbol.for("WEBHOOK_RESPONSE_WRITABLE");

// ../../packages/core/dist/workflow/get-workflow-metadata.js
var WORKFLOW_CONTEXT_SYMBOL = /* @__PURE__ */ Symbol.for("WORKFLOW_CONTEXT");
function getWorkflowMetadata() {
  const ctx = globalThis[WORKFLOW_CONTEXT_SYMBOL];
  if (!ctx) {
    throw new Error("\`getWorkflowMetadata()\` can only be called inside a workflow or step function");
  }
  return ctx;
}
__name(getWorkflowMetadata, "getWorkflowMetadata");

// ../../packages/core/dist/workflow/create-hook.js
function createHook(options) {
  const createHookFn = globalThis[WORKFLOW_CREATE_HOOK];
  if (!createHookFn) {
    throw new Error("\`createHook()\` can only be called inside a workflow function");
  }
  return createHookFn(options);
}
__name(createHook, "createHook");
function createWebhook(options) {
  const { respondWith, ...rest } = options ?? {};
  let metadata;
  if (typeof respondWith !== "undefined") {
    metadata = {
      respondWith
    };
  }
  const hook = createHook({
    ...rest,
    metadata
  });
  const { url: url2 } = getWorkflowMetadata();
  hook.url = \`\${url2}/.well-known/workflow/v1/webhook/\${encodeURIComponent(hook.token)}\`;
  return hook;
}
__name(createWebhook, "createWebhook");

// ../../packages/core/dist/workflow/writable-stream.js
function getWritable(options = {}) {
  const { namespace } = options;
  const name17 = globalThis[WORKFLOW_GET_STREAM_ID](namespace);
  return Object.create(globalThis.WritableStream.prototype, {
    [STREAM_NAME_SYMBOL]: {
      value: name17,
      writable: false
    }
  });
}
__name(getWritable, "getWritable");

// ../../packages/workflow/dist/stdlib.js
async function sleep(param) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//packages/workflow/dist/stdlib.js//sleep")(param);
}
__name(sleep, "sleep");
sleep.maxRetries = Infinity;
async function fetch2(...args) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//packages/workflow/dist/stdlib.js//fetch")(...args);
}
__name(fetch2, "fetch");

// ../example/workflows/5_hooks.ts
async function stepWithGetMetadata() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/5_hooks.ts//stepWithGetMetadata")();
}
__name(stepWithGetMetadata, "stepWithGetMetadata");
async function withWorkflowMetadata() {
  const ctx = getWorkflowMetadata();
  console.log("workflow context", ctx);
  await stepWithGetMetadata();
}
__name(withWorkflowMetadata, "withWorkflowMetadata");
async function initiateOpenAIResponse() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/5_hooks.ts//initiateOpenAIResponse")();
}
__name(initiateOpenAIResponse, "initiateOpenAIResponse");
async function getOpenAIResponse(respId) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/5_hooks.ts//getOpenAIResponse")(respId);
}
__name(getOpenAIResponse, "getOpenAIResponse");
async function withCreateHook() {
  const respId = await initiateOpenAIResponse();
  const hook = createHook({
    token: \`openai:\${respId}\`
  });
  console.log("Registered hook:", hook.token);
  const payload = await hook;
  console.log("Received hook payload:", payload);
  if (payload.type === "response.completed") {
    const text2 = await getOpenAIResponse(payload.data.id);
    console.log("OpenAI response text:", text2);
  }
  console.log("Hook demo workflow completed");
}
__name(withCreateHook, "withCreateHook");
withWorkflowMetadata.workflowId = "workflow//example/workflows/5_hooks.ts//withWorkflowMetadata";
withCreateHook.workflowId = "workflow//example/workflows/5_hooks.ts//withCreateHook";

// workflows/0_demo.ts
var demo_exports = {};
__export(demo_exports, {
  calc: () => calc
});
async function calc(n) {
  console.log("Simple workflow started");
  n = await pow(n);
  console.log("Simple workflow finished");
  return n;
}
__name(calc, "calc");
async function pow(a) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//workflows/0_demo.ts//pow")(a);
}
__name(pow, "pow");
calc.workflowId = "workflow//workflows/0_demo.ts//calc";

// ../example/workflows/6_batching.ts
var batching_exports = {};
__export(batching_exports, {
  batchInStep: () => batchInStep,
  batchOverSteps: () => batchOverSteps
});
var import_lodash = __toESM(require_lodash(), 1);
var ARRAY_LENGTH = 250;
var CHUNK_SIZE = 50;
async function batchOverSteps() {
  console.log("Workflow started");
  const arr = Array.from({
    length: ARRAY_LENGTH
  }, (_, i) => i + 1);
  const chunkSize = CHUNK_SIZE;
  console.log(\`Chunking array with size: \${arr.length} and chunk size: \${chunkSize}\`);
  const chunks = (0, import_lodash.default)(arr, chunkSize);
  console.log(\`Created \${chunks.length} chunks (\${chunks[0].length} items each)\`);
  console.log("Starting batch processing");
  for (const [index, batch] of chunks.entries()) {
    console.log(\`Batch \${index + 1}/\${chunks.length}\`);
    await Promise.all(batch.map(logItem));
  }
  console.log("Batch processing completed");
  console.log("Workflow completed");
}
__name(batchOverSteps, "batchOverSteps");
async function logItem(item) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/6_batching.ts//logItem")(item);
}
__name(logItem, "logItem");
async function batchInStep() {
  console.log("Workflow started");
  const arr = Array.from({
    length: ARRAY_LENGTH
  }, (_, i) => i + 1);
  const chunkSize = CHUNK_SIZE;
  console.log(\`Chunking array with size: \${arr.length} and chunk size: \${chunkSize}\`);
  const chunks = (0, import_lodash.default)(arr, chunkSize);
  console.log(\`Created \${chunks.length} chunks (\${chunks[0].length} items each)\`);
  console.log("Starting batch processing");
  for (const [index, batch] of chunks.entries()) {
    console.log(\`Batch \${index + 1}/\${chunks.length}\`);
    await processItems(batch);
  }
  console.log("Batch processing completed");
  console.log("Workflow completed");
}
__name(batchInStep, "batchInStep");
async function processItems(items) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/6_batching.ts//processItems")(items);
}
__name(processItems, "processItems");
batchOverSteps.workflowId = "workflow//example/workflows/6_batching.ts//batchOverSteps";
batchInStep.workflowId = "workflow//example/workflows/6_batching.ts//batchInStep";

// ../example/workflows/98_duplicate_case.ts
var duplicate_case_exports = {};
__export(duplicate_case_exports, {
  add: () => add2,
  addTenWorkflow: () => addTenWorkflow
});
async function addTenWorkflow(input) {
  const a = await add2(input, 2);
  const b = await add2(a, 3);
  const c = await add2(b, 5);
  return c;
}
__name(addTenWorkflow, "addTenWorkflow");
async function add2(a, b) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/98_duplicate_case.ts//add")(a, b);
}
__name(add2, "add");
addTenWorkflow.workflowId = "workflow//example/workflows/98_duplicate_case.ts//addTenWorkflow";

// ../example/workflows/1_simple.ts
var simple_exports = {};
__export(simple_exports, {
  simple: () => simple
});
async function add3(a, b) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/1_simple.ts//add")(a, b);
}
__name(add3, "add");
async function simple(i) {
  console.log("Simple workflow started");
  const a = await add3(i, 7);
  console.log("Workflow step 1 completed - Result:", a);
  const b = await add3(a, 8);
  console.log("Simple workflow completed. Result:", b);
  return b;
}
__name(simple, "simple");
simple.workflowId = "workflow//example/workflows/1_simple.ts//simple";

// ../example/workflows/99_e2e.ts
var e2e_exports = {};
__export(e2e_exports, {
  add: () => add4,
  addTenWorkflow: () => addTenWorkflow2,
  fetchWorkflow: () => fetchWorkflow,
  hookWorkflow: () => hookWorkflow,
  nullByteWorkflow: () => nullByteWorkflow,
  outputStreamWorkflow: () => outputStreamWorkflow,
  promiseAllWorkflow: () => promiseAllWorkflow,
  promiseAnyWorkflow: () => promiseAnyWorkflow,
  promiseRaceStressTestDelayStep: () => promiseRaceStressTestDelayStep,
  promiseRaceStressTestWorkflow: () => promiseRaceStressTestWorkflow,
  promiseRaceWorkflow: () => promiseRaceWorkflow,
  readableStreamWorkflow: () => readableStreamWorkflow,
  retryAttemptCounterWorkflow: () => retryAttemptCounterWorkflow,
  sleepingDateWorkflow: () => sleepingDateWorkflow,
  sleepingWorkflow: () => sleepingWorkflow,
  webhookWorkflow: () => webhookWorkflow,
  workflowAndStepMetadataWorkflow: () => workflowAndStepMetadataWorkflow
});
async function add4(a, b) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//add")(a, b);
}
__name(add4, "add");
async function addTenWorkflow2(input) {
  const a = await add4(input, 2);
  const b = await add4(a, 3);
  const c = await add4(b, 5);
  return c;
}
__name(addTenWorkflow2, "addTenWorkflow");
async function randomDelay(v) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//randomDelay")(v);
}
__name(randomDelay, "randomDelay");
async function promiseAllWorkflow() {
  const [a, b, c] = await Promise.all([
    randomDelay("a"),
    randomDelay("b"),
    randomDelay("c")
  ]);
  return a + b + c;
}
__name(promiseAllWorkflow, "promiseAllWorkflow");
async function specificDelay(delay2, v) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//specificDelay")(delay2, v);
}
__name(specificDelay, "specificDelay");
async function promiseRaceWorkflow() {
  const winner = await Promise.race([
    specificDelay(1e4, "a"),
    specificDelay(100, "b"),
    specificDelay(2e4, "c")
  ]);
  return winner;
}
__name(promiseRaceWorkflow, "promiseRaceWorkflow");
async function stepThatFails() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//stepThatFails")();
}
__name(stepThatFails, "stepThatFails");
async function promiseAnyWorkflow() {
  const winner = await Promise.any([
    stepThatFails(),
    specificDelay(1e3, "b"),
    specificDelay(3e3, "c")
  ]);
  return winner;
}
__name(promiseAnyWorkflow, "promiseAnyWorkflow");
async function genReadableStream() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//genReadableStream")();
}
__name(genReadableStream, "genReadableStream");
async function readableStreamWorkflow() {
  console.log("calling genReadableStream");
  const stream = await genReadableStream();
  console.log("genReadableStream returned", stream);
  return stream;
}
__name(readableStreamWorkflow, "readableStreamWorkflow");
async function hookWorkflow(token, customData) {
  const hook = createHook({
    token,
    metadata: {
      customData
    }
  });
  const payloads = [];
  for await (const payload of hook) {
    payloads.push(payload);
    if (payload.done) {
      break;
    }
  }
  return payloads;
}
__name(hookWorkflow, "hookWorkflow");
async function sendWebhookResponse(req) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//sendWebhookResponse")(req);
}
__name(sendWebhookResponse, "sendWebhookResponse");
async function webhookWorkflow(token, token2, token3) {
  const payloads = [];
  const webhookWithDefaultResponse = createWebhook({
    token
  });
  const res = new Response("Hello from static response!", {
    status: 402
  });
  console.log("res", res);
  const webhookWithStaticResponse = createWebhook({
    token: token2,
    respondWith: res
  });
  const webhookWithManualResponse = createWebhook({
    token: token3,
    respondWith: "manual"
  });
  {
    const req = await webhookWithDefaultResponse;
    const body = await req.text();
    payloads.push({
      url: req.url,
      method: req.method,
      body
    });
  }
  {
    const req = await webhookWithStaticResponse;
    const body = await req.text();
    payloads.push({
      url: req.url,
      method: req.method,
      body
    });
  }
  {
    const req = await webhookWithManualResponse;
    const body = await sendWebhookResponse(req);
    payloads.push({
      url: req.url,
      method: req.method,
      body
    });
  }
  return payloads;
}
__name(webhookWorkflow, "webhookWorkflow");
async function sleepingWorkflow() {
  const startTime = Date.now();
  await sleep("10s");
  const endTime = Date.now();
  return {
    startTime,
    endTime
  };
}
__name(sleepingWorkflow, "sleepingWorkflow");
async function sleepingDateWorkflow(endDate) {
  const startTime = Date.now();
  await sleep(endDate);
  const endTime = Date.now();
  return {
    startTime,
    endTime
  };
}
__name(sleepingDateWorkflow, "sleepingDateWorkflow");
async function nullByteStep() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//nullByteStep")();
}
__name(nullByteStep, "nullByteStep");
async function nullByteWorkflow() {
  const a = await nullByteStep();
  return a;
}
__name(nullByteWorkflow, "nullByteWorkflow");
async function stepWithMetadata() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//stepWithMetadata")();
}
__name(stepWithMetadata, "stepWithMetadata");
async function workflowAndStepMetadataWorkflow() {
  const workflowMetadata = getWorkflowMetadata();
  const { stepMetadata, workflowMetadata: innerWorkflowMetadata } = await stepWithMetadata();
  return {
    workflowMetadata: {
      workflowRunId: workflowMetadata.workflowRunId,
      workflowStartedAt: workflowMetadata.workflowStartedAt,
      url: workflowMetadata.url
    },
    stepMetadata,
    innerWorkflowMetadata
  };
}
__name(workflowAndStepMetadataWorkflow, "workflowAndStepMetadataWorkflow");
async function stepWithOutputStreamBinary(writable, text2) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//stepWithOutputStreamBinary")(writable, text2);
}
__name(stepWithOutputStreamBinary, "stepWithOutputStreamBinary");
async function stepWithOutputStreamObject(writable, obj) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//stepWithOutputStreamObject")(writable, obj);
}
__name(stepWithOutputStreamObject, "stepWithOutputStreamObject");
async function stepCloseOutputStream(writable) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//stepCloseOutputStream")(writable);
}
__name(stepCloseOutputStream, "stepCloseOutputStream");
async function outputStreamWorkflow() {
  const writable = getWritable();
  const namedWritable = getWritable({
    namespace: "test"
  });
  await sleep("1s");
  await stepWithOutputStreamBinary(writable, "Hello, world!");
  await sleep("1s");
  await stepWithOutputStreamBinary(namedWritable, "Hello, named stream!");
  await sleep("1s");
  await stepWithOutputStreamObject(writable, {
    foo: "test"
  });
  await sleep("1s");
  await stepWithOutputStreamObject(namedWritable, {
    foo: "bar"
  });
  await sleep("1s");
  await stepCloseOutputStream(writable);
  await stepCloseOutputStream(namedWritable);
  return "done";
}
__name(outputStreamWorkflow, "outputStreamWorkflow");
async function fetchWorkflow() {
  const response = await fetch2("https://jsonplaceholder.typicode.com/todos/1");
  const data = await response.json();
  return data;
}
__name(fetchWorkflow, "fetchWorkflow");
async function promiseRaceStressTestDelayStep(dur, resp) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//promiseRaceStressTestDelayStep")(dur, resp);
}
__name(promiseRaceStressTestDelayStep, "promiseRaceStressTestDelayStep");
async function promiseRaceStressTestWorkflow() {
  const promises = /* @__PURE__ */ new Map();
  const done = [];
  for (let i = 0; i < 5; i++) {
    const resp = i;
    const dur = 1e3 * 5 * i;
    console.log(\`sched\`, resp, \`/\`, dur);
    promises.set(i, promiseRaceStressTestDelayStep(dur, resp));
  }
  while (promises.size > 0) {
    console.log(\`promises.size\`, promises.size);
    const res = await Promise.race(promises.values());
    console.log(res);
    done.push(res);
    promises.delete(res);
  }
  return done;
}
__name(promiseRaceStressTestWorkflow, "promiseRaceStressTestWorkflow");
async function stepThatRetriesAndSucceeds() {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//example/workflows/99_e2e.ts//stepThatRetriesAndSucceeds")();
}
__name(stepThatRetriesAndSucceeds, "stepThatRetriesAndSucceeds");
async function retryAttemptCounterWorkflow() {
  console.log("Starting retry attempt counter workflow");
  const finalAttempt = await stepThatRetriesAndSucceeds();
  console.log(\`Workflow completed with final attempt: \${finalAttempt}\`);
  return {
    finalAttempt
  };
}
__name(retryAttemptCounterWorkflow, "retryAttemptCounterWorkflow");
addTenWorkflow2.workflowId = "workflow//example/workflows/99_e2e.ts//addTenWorkflow";
promiseAllWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseAllWorkflow";
promiseRaceWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseRaceWorkflow";
promiseAnyWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseAnyWorkflow";
readableStreamWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//readableStreamWorkflow";
hookWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//hookWorkflow";
webhookWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//webhookWorkflow";
sleepingWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//sleepingWorkflow";
sleepingDateWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//sleepingDateWorkflow";
nullByteWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//nullByteWorkflow";
workflowAndStepMetadataWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//workflowAndStepMetadataWorkflow";
outputStreamWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//outputStreamWorkflow";
fetchWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//fetchWorkflow";
promiseRaceStressTestWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseRaceStressTestWorkflow";
retryAttemptCounterWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//retryAttemptCounterWorkflow";

// virtual-entry.js
globalThis.__private_workflows = /* @__PURE__ */ new Map();
Object.values(streams_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(control_flow_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(ai_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(hooks_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(demo_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(batching_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(duplicate_case_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(simple_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
Object.values(e2e_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
`;

export const POST = workflowEntrypoint(workflowCode);
