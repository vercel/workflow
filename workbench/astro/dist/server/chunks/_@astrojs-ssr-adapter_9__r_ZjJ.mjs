import { n as decryptString, o as createSlotValueFromString, p as isAstroComponentFactory, q as renderComponent, r as renderTemplate, R as ROUTE_TYPE_HEADER, v as REROUTE_DIRECTIVE_HEADER, A as AstroError, w as i18nNoLocaleFoundInPath, x as ResponseSentError, y as ActionNotFoundError, z as MiddlewareNoDataOrNextCalled, B as MiddlewareNotAResponse, C as originPathnameSymbol, D as RewriteWithBodyUsed, G as GetStaticPathsRequired, H as InvalidGetStaticPathsReturn, J as InvalidGetStaticPathsEntry, K as GetStaticPathsExpectedParams, O as GetStaticPathsInvalidRouteParam, P as PageNumberParamNotFound, Q as DEFAULT_404_COMPONENT, S as NoMatchingStaticPathFound, T as PrerenderDynamicEndpointPathCollide, V as ReservedSlotName, W as renderSlotToString, X as renderJSX, Y as chunkToString, Z as isRenderInstruction, _ as ForbiddenRewrite, $ as SessionStorageInitError, a0 as SessionStorageSaveError, a1 as ASTRO_VERSION, a2 as CspNotEnabled, a3 as LocalsReassigned, a4 as generateCspDigest, a5 as PrerenderClientAddressNotAvailable, a6 as clientAddressSymbol, a7 as ClientAddressNotAvailable, a8 as StaticClientAddressNotAvailable, a9 as AstroResponseHeadersReassigned, aa as responseSentSymbol$1, ab as renderPage, ac as REWRITE_DIRECTIVE_HEADER_KEY, ad as REWRITE_DIRECTIVE_HEADER_VALUE, ae as renderEndpoint, af as LocalsNotAnObject, ag as REROUTABLE_STATUS_CODES, ah as nodeRequestAbortControllerCleanupSymbol } from './astro/server_DhWKww_t.mjs';
import 'clsx';
import { serialize, parse } from 'cookie';
import { A as ActionError, d as deserializeActionResult, s as serializeActionResult, a as ACTION_RPC_ROUTE_PATTERN, b as ACTION_QUERY_PARAMS, g as getActionQueryString, D as DEFAULT_404_ROUTE, c as default404Instance, N as NOOP_MIDDLEWARE_FN, e as ensure404Route } from './astro-designed-error-pages_pFA87nEA.mjs';
import 'es-module-lexer';
import require$$0$3 from 'node:buffer';
import crypto$1 from 'node:crypto';
import fs, { existsSync, readFileSync } from 'node:fs';
import { Http2ServerResponse } from 'node:http2';
import { c as appendForwardSlash$1, j as joinPaths, f as fileExtension, s as slash, p as prependForwardSlash$1, d as removeTrailingForwardSlash, t as trimSlashes, m as matchPattern, e as isInternalPath, g as collapseDuplicateTrailingSlashes, h as hasFileExtension } from './remote_OOD9OFqU.mjs';
import colors from 'picocolors';
import { unflatten as unflatten$1, stringify as stringify$1 } from 'devalue';
import { createStorage, builtinDrivers } from 'unstorage';
import { AsyncLocalStorage } from 'node:async_hooks';
import require$$2 from 'node:http';
import https from 'node:https';
import { g as getDefaultExportFromCjs } from './_commonjsHelpers_BFTU3MAI.mjs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import require$$0$4 from 'path';
import debug$1 from 'debug';
import require$$0$6 from 'crypto';
import require$$0$5 from 'fs';
import ms from 'ms';
import require$$13 from 'stream';
import require$$14 from 'util';

function shouldAppendForwardSlash(trailingSlash, buildFormat) {
  switch (trailingSlash) {
    case "always":
      return true;
    case "never":
      return false;
    case "ignore": {
      switch (buildFormat) {
        case "directory":
          return true;
        case "preserve":
        case "file":
          return false;
      }
    }
  }
}

function redirectIsExternal(redirect) {
  if (typeof redirect === "string") {
    return redirect.startsWith("http://") || redirect.startsWith("https://");
  } else {
    return redirect.destination.startsWith("http://") || redirect.destination.startsWith("https://");
  }
}
async function renderRedirect(renderContext) {
  const {
    request: { method },
    routeData
  } = renderContext;
  const { redirect, redirectRoute } = routeData;
  const status = redirectRoute && typeof redirect === "object" ? redirect.status : method === "GET" ? 301 : 308;
  const headers = { location: encodeURI(redirectRouteGenerate(renderContext)) };
  if (redirect && redirectIsExternal(redirect)) {
    if (typeof redirect === "string") {
      return Response.redirect(redirect, status);
    } else {
      return Response.redirect(redirect.destination, status);
    }
  }
  return new Response(null, { status, headers });
}
function redirectRouteGenerate(renderContext) {
  const {
    params,
    routeData: { redirect, redirectRoute }
  } = renderContext;
  if (typeof redirectRoute !== "undefined") {
    return redirectRoute?.generate(params) || redirectRoute?.pathname || "/";
  } else if (typeof redirect === "string") {
    if (redirectIsExternal(redirect)) {
      return redirect;
    } else {
      let target = redirect;
      for (const param of Object.keys(params)) {
        const paramValue = params[param];
        target = target.replace(`[${param}]`, paramValue).replace(`[...${param}]`, paramValue);
      }
      return target;
    }
  } else if (typeof redirect === "undefined") {
    return "/";
  }
  return redirect.destination;
}

const SERVER_ISLAND_ROUTE = "/_server-islands/[name]";
const SERVER_ISLAND_COMPONENT = "_server-islands.astro";
const SERVER_ISLAND_BASE_PREFIX = "_server-islands";
function badRequest(reason) {
  return new Response(null, {
    status: 400,
    statusText: "Bad request: " + reason
  });
}
async function getRequestData(request) {
  switch (request.method) {
    case "GET": {
      const url = new URL(request.url);
      const params = url.searchParams;
      if (!params.has("s") || !params.has("e") || !params.has("p")) {
        return badRequest("Missing required query parameters.");
      }
      const rawSlots = params.get("s");
      try {
        return {
          componentExport: params.get("e"),
          encryptedProps: params.get("p"),
          slots: JSON.parse(rawSlots)
        };
      } catch {
        return badRequest("Invalid slots format.");
      }
    }
    case "POST": {
      try {
        const raw = await request.text();
        const data = JSON.parse(raw);
        return data;
      } catch {
        return badRequest("Request format is invalid.");
      }
    }
    default: {
      return new Response(null, { status: 405 });
    }
  }
}
function createEndpoint(manifest) {
  const page = async (result) => {
    const params = result.params;
    if (!params.name) {
      return new Response(null, {
        status: 400,
        statusText: "Bad request"
      });
    }
    const componentId = params.name;
    const data = await getRequestData(result.request);
    if (data instanceof Response) {
      return data;
    }
    const imp = manifest.serverIslandMap?.get(componentId);
    if (!imp) {
      return new Response(null, {
        status: 404,
        statusText: "Not found"
      });
    }
    const key = await manifest.key;
    const encryptedProps = data.encryptedProps;
    const propString = encryptedProps === "" ? "{}" : await decryptString(key, encryptedProps);
    const props = JSON.parse(propString);
    const componentModule = await imp();
    let Component = componentModule[data.componentExport];
    const slots = {};
    for (const prop in data.slots) {
      slots[prop] = createSlotValueFromString(data.slots[prop]);
    }
    result.response.headers.set("X-Robots-Tag", "noindex");
    if (isAstroComponentFactory(Component)) {
      const ServerIsland = Component;
      Component = function(...args) {
        return ServerIsland.apply(this, args);
      };
      Object.assign(Component, ServerIsland);
      Component.propagation = "self";
    }
    return renderTemplate`${renderComponent(result, "Component", Component, props, slots)}`;
  };
  page.isAstroComponentFactory = true;
  const instance = {
    default: page,
    partial: true
  };
  return instance;
}

function matchRoute(pathname, manifest) {
  return manifest.routes.find((route) => {
    return route.pattern.test(pathname) || route.fallbackRoutes.some((fallbackRoute) => fallbackRoute.pattern.test(pathname));
  });
}
const ROUTE404_RE = /^\/404\/?$/;
const ROUTE500_RE = /^\/500\/?$/;
function isRoute404(route) {
  return ROUTE404_RE.test(route);
}
function isRoute500(route) {
  return ROUTE500_RE.test(route);
}
function isRoute404or500(route) {
  return isRoute404(route.route) || isRoute500(route.route);
}
function isRouteServerIsland(route) {
  return route.component === SERVER_ISLAND_COMPONENT;
}
function isRequestServerIsland(request, base = "") {
  const url = new URL(request.url);
  const pathname = base === "/" ? url.pathname.slice(base.length) : url.pathname.slice(base.length + 1);
  return pathname.startsWith(SERVER_ISLAND_BASE_PREFIX);
}
function requestIs404Or500(request, base = "") {
  const url = new URL(request.url);
  const pathname = url.pathname.slice(base.length);
  return isRoute404(pathname) || isRoute500(pathname);
}
function isRouteExternalRedirect(route) {
  return !!(route.type === "redirect" && route.redirect && redirectIsExternal(route.redirect));
}

function createI18nMiddleware(i18n, base, trailingSlash, format) {
  if (!i18n) return (_, next) => next();
  const payload = {
    ...i18n,
    trailingSlash,
    base,
    format};
  const _redirectToDefaultLocale = redirectToDefaultLocale(payload);
  const _noFoundForNonLocaleRoute = notFound(payload);
  const _requestHasLocale = requestHasLocale(payload.locales);
  const _redirectToFallback = redirectToFallback(payload);
  const prefixAlways = (context, response) => {
    const url = context.url;
    if (url.pathname === base + "/" || url.pathname === base) {
      return _redirectToDefaultLocale(context);
    } else if (!_requestHasLocale(context)) {
      return _noFoundForNonLocaleRoute(context, response);
    }
    return void 0;
  };
  const prefixOtherLocales = (context, response) => {
    let pathnameContainsDefaultLocale = false;
    const url = context.url;
    for (const segment of url.pathname.split("/")) {
      if (normalizeTheLocale(segment) === normalizeTheLocale(i18n.defaultLocale)) {
        pathnameContainsDefaultLocale = true;
        break;
      }
    }
    if (pathnameContainsDefaultLocale) {
      const newLocation = url.pathname.replace(`/${i18n.defaultLocale}`, "");
      response.headers.set("Location", newLocation);
      return _noFoundForNonLocaleRoute(context);
    }
    return void 0;
  };
  return async (context, next) => {
    const response = await next();
    const type = response.headers.get(ROUTE_TYPE_HEADER);
    const isReroute = response.headers.get(REROUTE_DIRECTIVE_HEADER);
    if (isReroute === "no" && typeof i18n.fallback === "undefined") {
      return response;
    }
    if (type !== "page" && type !== "fallback") {
      return response;
    }
    if (requestIs404Or500(context.request, base)) {
      return response;
    }
    if (isRequestServerIsland(context.request, base)) {
      return response;
    }
    const { currentLocale } = context;
    switch (i18n.strategy) {
      // NOTE: theoretically, we should never hit this code path
      case "manual": {
        return response;
      }
      case "domains-prefix-other-locales": {
        if (localeHasntDomain(i18n, currentLocale)) {
          const result = prefixOtherLocales(context, response);
          if (result) {
            return result;
          }
        }
        break;
      }
      case "pathname-prefix-other-locales": {
        const result = prefixOtherLocales(context, response);
        if (result) {
          return result;
        }
        break;
      }
      case "domains-prefix-always-no-redirect": {
        if (localeHasntDomain(i18n, currentLocale)) {
          const result = _noFoundForNonLocaleRoute(context, response);
          if (result) {
            return result;
          }
        }
        break;
      }
      case "pathname-prefix-always-no-redirect": {
        const result = _noFoundForNonLocaleRoute(context, response);
        if (result) {
          return result;
        }
        break;
      }
      case "pathname-prefix-always": {
        const result = prefixAlways(context, response);
        if (result) {
          return result;
        }
        break;
      }
      case "domains-prefix-always": {
        if (localeHasntDomain(i18n, currentLocale)) {
          const result = prefixAlways(context, response);
          if (result) {
            return result;
          }
        }
        break;
      }
    }
    return _redirectToFallback(context, response);
  };
}
function localeHasntDomain(i18n, currentLocale) {
  for (const domainLocale of Object.values(i18n.domainLookupTable)) {
    if (domainLocale === currentLocale) {
      return false;
    }
  }
  return true;
}

function requestHasLocale(locales) {
  return function(context) {
    return pathHasLocale(context.url.pathname, locales);
  };
}
function pathHasLocale(path, locales) {
  const segments = path.split("/").map(normalizeThePath);
  for (const segment of segments) {
    for (const locale of locales) {
      if (typeof locale === "string") {
        if (normalizeTheLocale(segment) === normalizeTheLocale(locale)) {
          return true;
        }
      } else if (segment === locale.path) {
        return true;
      }
    }
  }
  return false;
}
function getPathByLocale(locale, locales) {
  for (const loopLocale of locales) {
    if (typeof loopLocale === "string") {
      if (loopLocale === locale) {
        return loopLocale;
      }
    } else {
      for (const code of loopLocale.codes) {
        if (code === locale) {
          return loopLocale.path;
        }
      }
    }
  }
  throw new AstroError(i18nNoLocaleFoundInPath);
}
function normalizeTheLocale(locale) {
  return locale.replaceAll("_", "-").toLowerCase();
}
function normalizeThePath(path) {
  return path.endsWith(".html") ? path.slice(0, -5) : path;
}
function getAllCodes(locales) {
  const result = [];
  for (const loopLocale of locales) {
    if (typeof loopLocale === "string") {
      result.push(loopLocale);
    } else {
      result.push(...loopLocale.codes);
    }
  }
  return result;
}
function redirectToDefaultLocale({
  trailingSlash,
  format,
  base,
  defaultLocale
}) {
  return function(context, statusCode) {
    if (shouldAppendForwardSlash(trailingSlash, format)) {
      return context.redirect(`${appendForwardSlash$1(joinPaths(base, defaultLocale))}`, statusCode);
    } else {
      return context.redirect(`${joinPaths(base, defaultLocale)}`, statusCode);
    }
  };
}
function notFound({ base, locales, fallback }) {
  return function(context, response) {
    if (response?.headers.get(REROUTE_DIRECTIVE_HEADER) === "no" && typeof fallback === "undefined") {
      return response;
    }
    const url = context.url;
    const isRoot = url.pathname === base + "/" || url.pathname === base;
    if (!(isRoot || pathHasLocale(url.pathname, locales))) {
      if (response) {
        response.headers.set(REROUTE_DIRECTIVE_HEADER, "no");
        return new Response(response.body, {
          status: 404,
          headers: response.headers
        });
      } else {
        return new Response(null, {
          status: 404,
          headers: {
            [REROUTE_DIRECTIVE_HEADER]: "no"
          }
        });
      }
    }
    return void 0;
  };
}
function redirectToFallback({
  fallback,
  locales,
  defaultLocale,
  strategy,
  base,
  fallbackType
}) {
  return async function(context, response) {
    if (response.status >= 300 && fallback) {
      const fallbackKeys = fallback ? Object.keys(fallback) : [];
      const segments = context.url.pathname.split("/");
      const urlLocale = segments.find((segment) => {
        for (const locale of locales) {
          if (typeof locale === "string") {
            if (locale === segment) {
              return true;
            }
          } else if (locale.path === segment) {
            return true;
          }
        }
        return false;
      });
      if (urlLocale && fallbackKeys.includes(urlLocale)) {
        const fallbackLocale = fallback[urlLocale];
        const pathFallbackLocale = getPathByLocale(fallbackLocale, locales);
        let newPathname;
        if (pathFallbackLocale === defaultLocale && strategy === "pathname-prefix-other-locales") {
          if (context.url.pathname.includes(`${base}`)) {
            newPathname = context.url.pathname.replace(`/${urlLocale}`, ``);
            if (newPathname === "") {
              newPathname = "/";
            }
          } else {
            newPathname = context.url.pathname.replace(`/${urlLocale}`, `/`);
          }
        } else {
          newPathname = context.url.pathname.replace(`/${urlLocale}`, `/${pathFallbackLocale}`);
        }
        if (fallbackType === "rewrite") {
          return await context.rewrite(newPathname + context.url.search);
        } else {
          return context.redirect(newPathname + context.url.search);
        }
      }
    }
    return response;
  };
}

const DELETED_EXPIRATION = /* @__PURE__ */ new Date(0);
const DELETED_VALUE = "deleted";
const responseSentSymbol = Symbol.for("astro.responseSent");
const identity = (value) => value;
class AstroCookie {
  constructor(value) {
    this.value = value;
  }
  json() {
    if (this.value === void 0) {
      throw new Error(`Cannot convert undefined to an object.`);
    }
    return JSON.parse(this.value);
  }
  number() {
    return Number(this.value);
  }
  boolean() {
    if (this.value === "false") return false;
    if (this.value === "0") return false;
    return Boolean(this.value);
  }
}
class AstroCookies {
  #request;
  #requestValues;
  #outgoing;
  #consumed;
  constructor(request) {
    this.#request = request;
    this.#requestValues = null;
    this.#outgoing = null;
    this.#consumed = false;
  }
  /**
   * Astro.cookies.delete(key) is used to delete a cookie. Using this method will result
   * in a Set-Cookie header added to the response.
   * @param key The cookie to delete
   * @param options Options related to this deletion, such as the path of the cookie.
   */
  delete(key, options) {
    const {
      // @ts-expect-error
      maxAge: _ignoredMaxAge,
      // @ts-expect-error
      expires: _ignoredExpires,
      ...sanitizedOptions
    } = options || {};
    const serializeOptions = {
      expires: DELETED_EXPIRATION,
      ...sanitizedOptions
    };
    this.#ensureOutgoingMap().set(key, [
      DELETED_VALUE,
      serialize(key, DELETED_VALUE, serializeOptions),
      false
    ]);
  }
  /**
   * Astro.cookies.get(key) is used to get a cookie value. The cookie value is read from the
   * request. If you have set a cookie via Astro.cookies.set(key, value), the value will be taken
   * from that set call, overriding any values already part of the request.
   * @param key The cookie to get.
   * @returns An object containing the cookie value as well as convenience methods for converting its value.
   */
  get(key, options = void 0) {
    if (this.#outgoing?.has(key)) {
      let [serializedValue, , isSetValue] = this.#outgoing.get(key);
      if (isSetValue) {
        return new AstroCookie(serializedValue);
      } else {
        return void 0;
      }
    }
    const decode = options?.decode ?? decodeURIComponent;
    const values = this.#ensureParsed();
    if (key in values) {
      const value = values[key];
      if (value) {
        let decodedValue;
        try {
          decodedValue = decode(value);
        } catch (_error) {
          decodedValue = value;
        }
        return new AstroCookie(decodedValue);
      }
    }
  }
  /**
   * Astro.cookies.has(key) returns a boolean indicating whether this cookie is either
   * part of the initial request or set via Astro.cookies.set(key)
   * @param key The cookie to check for.
   * @param _options This parameter is no longer used.
   * @returns
   */
  has(key, _options) {
    if (this.#outgoing?.has(key)) {
      let [, , isSetValue] = this.#outgoing.get(key);
      return isSetValue;
    }
    const values = this.#ensureParsed();
    return values[key] !== void 0;
  }
  /**
   * Astro.cookies.set(key, value) is used to set a cookie's value. If provided
   * an object it will be stringified via JSON.stringify(value). Additionally you
   * can provide options customizing how this cookie will be set, such as setting httpOnly
   * in order to prevent the cookie from being read in client-side JavaScript.
   * @param key The name of the cookie to set.
   * @param value A value, either a string or other primitive or an object.
   * @param options Options for the cookie, such as the path and security settings.
   */
  set(key, value, options) {
    if (this.#consumed) {
      const warning = new Error(
        "Astro.cookies.set() was called after the cookies had already been sent to the browser.\nThis may have happened if this method was called in an imported component.\nPlease make sure that Astro.cookies.set() is only called in the frontmatter of the main page."
      );
      warning.name = "Warning";
      console.warn(warning);
    }
    let serializedValue;
    if (typeof value === "string") {
      serializedValue = value;
    } else {
      let toStringValue = value.toString();
      if (toStringValue === Object.prototype.toString.call(value)) {
        serializedValue = JSON.stringify(value);
      } else {
        serializedValue = toStringValue;
      }
    }
    const serializeOptions = {};
    if (options) {
      Object.assign(serializeOptions, options);
    }
    this.#ensureOutgoingMap().set(key, [
      serializedValue,
      serialize(key, serializedValue, serializeOptions),
      true
    ]);
    if (this.#request[responseSentSymbol]) {
      throw new AstroError({
        ...ResponseSentError
      });
    }
  }
  /**
   * Merges a new AstroCookies instance into the current instance. Any new cookies
   * will be added to the current instance, overwriting any existing cookies with the same name.
   */
  merge(cookies) {
    const outgoing = cookies.#outgoing;
    if (outgoing) {
      for (const [key, value] of outgoing) {
        this.#ensureOutgoingMap().set(key, value);
      }
    }
  }
  /**
   * Astro.cookies.header() returns an iterator for the cookies that have previously
   * been set by either Astro.cookies.set() or Astro.cookies.delete().
   * This method is primarily used by adapters to set the header on outgoing responses.
   * @returns
   */
  *headers() {
    if (this.#outgoing == null) return;
    for (const [, value] of this.#outgoing) {
      yield value[1];
    }
  }
  /**
   * Behaves the same as AstroCookies.prototype.headers(),
   * but allows a warning when cookies are set after the instance is consumed.
   */
  static consume(cookies) {
    cookies.#consumed = true;
    return cookies.headers();
  }
  #ensureParsed() {
    if (!this.#requestValues) {
      this.#parse();
    }
    if (!this.#requestValues) {
      this.#requestValues = {};
    }
    return this.#requestValues;
  }
  #ensureOutgoingMap() {
    if (!this.#outgoing) {
      this.#outgoing = /* @__PURE__ */ new Map();
    }
    return this.#outgoing;
  }
  #parse() {
    const raw = this.#request.headers.get("cookie");
    if (!raw) {
      return;
    }
    this.#requestValues = parse(raw, { decode: identity });
  }
}

const astroCookiesSymbol = Symbol.for("astro.cookies");
function attachCookiesToResponse(response, cookies) {
  Reflect.set(response, astroCookiesSymbol, cookies);
}
function getCookiesFromResponse(response) {
  let cookies = Reflect.get(response, astroCookiesSymbol);
  if (cookies != null) {
    return cookies;
  } else {
    return void 0;
  }
}
function* getSetCookiesFromResponse(response) {
  const cookies = getCookiesFromResponse(response);
  if (!cookies) {
    return [];
  }
  for (const headerValue of AstroCookies.consume(cookies)) {
    yield headerValue;
  }
  return [];
}

const dateTimeFormat = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});
const levels = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 90
};
function log(opts, level, label, message, newLine = true) {
  const logLevel = opts.level;
  const dest = opts.dest;
  const event = {
    label,
    level,
    message,
    newLine
  };
  if (!isLogLevelEnabled(logLevel, level)) {
    return;
  }
  dest.write(event);
}
function isLogLevelEnabled(configuredLogLevel, level) {
  return levels[configuredLogLevel] <= levels[level];
}
function info(opts, label, message, newLine = true) {
  return log(opts, "info", label, message, newLine);
}
function warn(opts, label, message, newLine = true) {
  return log(opts, "warn", label, message, newLine);
}
function error(opts, label, message, newLine = true) {
  return log(opts, "error", label, message, newLine);
}
function debug(...args) {
  if ("_astroGlobalDebug" in globalThis) {
    globalThis._astroGlobalDebug(...args);
  }
}
function getEventPrefix({ level, label }) {
  const timestamp = `${dateTimeFormat.format(/* @__PURE__ */ new Date())}`;
  const prefix = [];
  if (level === "error" || level === "warn") {
    prefix.push(colors.bold(timestamp));
    prefix.push(`[${level.toUpperCase()}]`);
  } else {
    prefix.push(timestamp);
  }
  if (label) {
    prefix.push(`[${label}]`);
  }
  if (level === "error") {
    return colors.red(prefix.join(" "));
  }
  if (level === "warn") {
    return colors.yellow(prefix.join(" "));
  }
  if (prefix.length === 1) {
    return colors.dim(prefix[0]);
  }
  return colors.dim(prefix[0]) + " " + colors.blue(prefix.splice(1).join(" "));
}
class Logger {
  options;
  constructor(options) {
    this.options = options;
  }
  info(label, message, newLine = true) {
    info(this.options, label, message, newLine);
  }
  warn(label, message, newLine = true) {
    warn(this.options, label, message, newLine);
  }
  error(label, message, newLine = true) {
    error(this.options, label, message, newLine);
  }
  debug(label, ...messages) {
    debug(label, ...messages);
  }
  level() {
    return this.options.level;
  }
  forkIntegrationLogger(label) {
    return new AstroIntegrationLogger(this.options, label);
  }
}
class AstroIntegrationLogger {
  options;
  label;
  constructor(logging, label) {
    this.options = logging;
    this.label = label;
  }
  /**
   * Creates a new logger instance with a new label, but the same log options.
   */
  fork(label) {
    return new AstroIntegrationLogger(this.options, label);
  }
  info(message) {
    info(this.options, this.label, message);
  }
  warn(message) {
    warn(this.options, this.label, message);
  }
  error(message) {
    error(this.options, this.label, message);
  }
  debug(message) {
    debug(this.label, message);
  }
}

const consoleLogDestination = {
  write(event) {
    let dest = console.error;
    if (levels[event.level] < levels["error"]) {
      dest = console.info;
    }
    if (event.label === "SKIP_FORMAT") {
      dest(event.message);
    } else {
      dest(getEventPrefix(event) + " " + event.message);
    }
    return true;
  }
};

function getAssetsPrefix(fileExtension, assetsPrefix) {
  let prefix = "";
  if (!assetsPrefix) {
    prefix = "";
  } else if (typeof assetsPrefix === "string") {
    prefix = assetsPrefix;
  } else {
    const dotLessFileExtension = fileExtension.slice(1);
    prefix = assetsPrefix[dotLessFileExtension] || assetsPrefix.fallback;
  }
  return prefix;
}

function createAssetLink(href, base, assetsPrefix, queryParams) {
  let url = "";
  if (assetsPrefix) {
    const pf = getAssetsPrefix(fileExtension(href), assetsPrefix);
    url = joinPaths(pf, slash(href));
  } else if (base) {
    url = prependForwardSlash$1(joinPaths(base, slash(href)));
  } else {
    url = href;
  }
  return url;
}
function createStylesheetElement(stylesheet, base, assetsPrefix, queryParams) {
  if (stylesheet.type === "inline") {
    return {
      props: {},
      children: stylesheet.content
    };
  } else {
    return {
      props: {
        rel: "stylesheet",
        href: createAssetLink(stylesheet.src, base, assetsPrefix)
      },
      children: ""
    };
  }
}
function createStylesheetElementSet(stylesheets, base, assetsPrefix, queryParams) {
  return new Set(
    stylesheets.map((s) => createStylesheetElement(s, base, assetsPrefix))
  );
}
function createModuleScriptElement(script, base, assetsPrefix, queryParams) {
  if (script.type === "external") {
    return createModuleScriptElementWithSrc(script.value, base, assetsPrefix);
  } else {
    return {
      props: {
        type: "module"
      },
      children: script.value
    };
  }
}
function createModuleScriptElementWithSrc(src, base, assetsPrefix, queryParams) {
  return {
    props: {
      type: "module",
      src: createAssetLink(src, base, assetsPrefix)
    },
    children: ""
  };
}

const ACTION_API_CONTEXT_SYMBOL = Symbol.for("astro.actionAPIContext");
const formContentTypes = ["application/x-www-form-urlencoded", "multipart/form-data"];
function hasContentType(contentType, expected) {
  const type = contentType.split(";")[0].toLowerCase();
  return expected.some((t) => type === t);
}

function getActionContext(context) {
  const callerInfo = getCallerInfo(context);
  const actionResultAlreadySet = Boolean(context.locals._actionPayload);
  let action = void 0;
  if (callerInfo && context.request.method === "POST" && !actionResultAlreadySet) {
    action = {
      calledFrom: callerInfo.from,
      name: callerInfo.name,
      handler: async () => {
        const pipeline = Reflect.get(context, apiContextRoutesSymbol);
        const callerInfoName = shouldAppendForwardSlash(
          pipeline.manifest.trailingSlash,
          pipeline.manifest.buildFormat
        ) ? removeTrailingForwardSlash(callerInfo.name) : callerInfo.name;
        let baseAction;
        try {
          baseAction = await pipeline.getAction(callerInfoName);
        } catch (error) {
          if (error instanceof Error && "name" in error && typeof error.name === "string" && error.name === ActionNotFoundError.name) {
            return { data: void 0, error: new ActionError({ code: "NOT_FOUND" }) };
          }
          throw error;
        }
        let input;
        try {
          input = await parseRequestBody(context.request);
        } catch (e) {
          if (e instanceof TypeError) {
            return { data: void 0, error: new ActionError({ code: "UNSUPPORTED_MEDIA_TYPE" }) };
          }
          throw e;
        }
        const omitKeys = ["props", "getActionResult", "callAction", "redirect"];
        const actionAPIContext = Object.create(
          Object.getPrototypeOf(context),
          Object.fromEntries(
            Object.entries(Object.getOwnPropertyDescriptors(context)).filter(
              ([key]) => !omitKeys.includes(key)
            )
          )
        );
        Reflect.set(actionAPIContext, ACTION_API_CONTEXT_SYMBOL, true);
        const handler = baseAction.bind(actionAPIContext);
        return handler(input);
      }
    };
  }
  function setActionResult(actionName, actionResult) {
    context.locals._actionPayload = {
      actionResult,
      actionName
    };
  }
  return {
    action,
    setActionResult,
    serializeActionResult,
    deserializeActionResult
  };
}
function getCallerInfo(ctx) {
  if (ctx.routePattern === ACTION_RPC_ROUTE_PATTERN) {
    return { from: "rpc", name: ctx.url.pathname.replace(/^.*\/_actions\//, "") };
  }
  const queryParam = ctx.url.searchParams.get(ACTION_QUERY_PARAMS.actionName);
  if (queryParam) {
    return { from: "form", name: queryParam };
  }
  return void 0;
}
async function parseRequestBody(request) {
  const contentType = request.headers.get("content-type");
  const contentLength = request.headers.get("Content-Length");
  if (!contentType) return void 0;
  if (hasContentType(contentType, formContentTypes)) {
    return await request.clone().formData();
  }
  if (hasContentType(contentType, ["application/json"])) {
    return contentLength === "0" ? void 0 : await request.clone().json();
  }
  throw new TypeError("Unsupported content type");
}

function hasActionPayload(locals) {
  return "_actionPayload" in locals;
}
function createGetActionResult(locals) {
  return (actionFn) => {
    if (!hasActionPayload(locals) || actionFn.toString() !== getActionQueryString(locals._actionPayload.actionName)) {
      return void 0;
    }
    return deserializeActionResult(locals._actionPayload.actionResult);
  };
}
function createCallAction(context) {
  return (baseAction, input) => {
    Reflect.set(context, ACTION_API_CONTEXT_SYMBOL, true);
    const action = baseAction.bind(context);
    return action(input);
  };
}

function parseLocale(header) {
  if (header === "*") {
    return [{ locale: header, qualityValue: void 0 }];
  }
  const result = [];
  const localeValues = header.split(",").map((str) => str.trim());
  for (const localeValue of localeValues) {
    const split = localeValue.split(";").map((str) => str.trim());
    const localeName = split[0];
    const qualityValue = split[1];
    if (!split) {
      continue;
    }
    if (qualityValue && qualityValue.startsWith("q=")) {
      const qualityValueAsFloat = Number.parseFloat(qualityValue.slice("q=".length));
      if (Number.isNaN(qualityValueAsFloat) || qualityValueAsFloat > 1) {
        result.push({
          locale: localeName,
          qualityValue: void 0
        });
      } else {
        result.push({
          locale: localeName,
          qualityValue: qualityValueAsFloat
        });
      }
    } else {
      result.push({
        locale: localeName,
        qualityValue: void 0
      });
    }
  }
  return result;
}
function sortAndFilterLocales(browserLocaleList, locales) {
  const normalizedLocales = getAllCodes(locales).map(normalizeTheLocale);
  return browserLocaleList.filter((browserLocale) => {
    if (browserLocale.locale !== "*") {
      return normalizedLocales.includes(normalizeTheLocale(browserLocale.locale));
    }
    return true;
  }).sort((a, b) => {
    if (a.qualityValue && b.qualityValue) {
      return Math.sign(b.qualityValue - a.qualityValue);
    }
    return 0;
  });
}
function computePreferredLocale(request, locales) {
  const acceptHeader = request.headers.get("Accept-Language");
  let result = void 0;
  if (acceptHeader) {
    const browserLocaleList = sortAndFilterLocales(parseLocale(acceptHeader), locales);
    const firstResult = browserLocaleList.at(0);
    if (firstResult && firstResult.locale !== "*") {
      for (const currentLocale of locales) {
        if (typeof currentLocale === "string") {
          if (normalizeTheLocale(currentLocale) === normalizeTheLocale(firstResult.locale)) {
            result = currentLocale;
            break;
          }
        } else {
          for (const currentCode of currentLocale.codes) {
            if (normalizeTheLocale(currentCode) === normalizeTheLocale(firstResult.locale)) {
              result = currentCode;
              break;
            }
          }
        }
      }
    }
  }
  return result;
}
function computePreferredLocaleList(request, locales) {
  const acceptHeader = request.headers.get("Accept-Language");
  let result = [];
  if (acceptHeader) {
    const browserLocaleList = sortAndFilterLocales(parseLocale(acceptHeader), locales);
    if (browserLocaleList.length === 1 && browserLocaleList.at(0).locale === "*") {
      return getAllCodes(locales);
    } else if (browserLocaleList.length > 0) {
      for (const browserLocale of browserLocaleList) {
        for (const loopLocale of locales) {
          if (typeof loopLocale === "string") {
            if (normalizeTheLocale(loopLocale) === normalizeTheLocale(browserLocale.locale)) {
              result.push(loopLocale);
            }
          } else {
            for (const code of loopLocale.codes) {
              if (code === browserLocale.locale) {
                result.push(code);
              }
            }
          }
        }
      }
    }
  }
  return result;
}
function computeCurrentLocale(pathname, locales, defaultLocale) {
  for (const segment of pathname.split("/").map(normalizeThePath)) {
    for (const locale of locales) {
      if (typeof locale === "string") {
        if (!segment.includes(locale)) continue;
        if (normalizeTheLocale(locale) === normalizeTheLocale(segment)) {
          return locale;
        }
      } else {
        if (locale.path === segment) {
          return locale.codes.at(0);
        } else {
          for (const code of locale.codes) {
            if (normalizeTheLocale(code) === normalizeTheLocale(segment)) {
              return code;
            }
          }
        }
      }
    }
  }
  for (const locale of locales) {
    if (typeof locale === "string") {
      if (locale === defaultLocale) {
        return locale;
      }
    } else {
      if (locale.path === defaultLocale) {
        return locale.codes.at(0);
      }
    }
  }
}

async function callMiddleware(onRequest, apiContext, responseFunction) {
  let nextCalled = false;
  let responseFunctionPromise = void 0;
  const next = async (payload) => {
    nextCalled = true;
    responseFunctionPromise = responseFunction(apiContext, payload);
    return responseFunctionPromise;
  };
  let middlewarePromise = onRequest(apiContext, next);
  return await Promise.resolve(middlewarePromise).then(async (value) => {
    if (nextCalled) {
      if (typeof value !== "undefined") {
        if (value instanceof Response === false) {
          throw new AstroError(MiddlewareNotAResponse);
        }
        return value;
      } else {
        if (responseFunctionPromise) {
          return responseFunctionPromise;
        } else {
          throw new AstroError(MiddlewareNotAResponse);
        }
      }
    } else if (typeof value === "undefined") {
      throw new AstroError(MiddlewareNoDataOrNextCalled);
    } else if (value instanceof Response === false) {
      throw new AstroError(MiddlewareNotAResponse);
    } else {
      return value;
    }
  });
}

function createRequest({
  url,
  headers,
  method = "GET",
  body = void 0,
  logger,
  isPrerendered = false,
  routePattern,
  init
}) {
  const headersObj = isPrerendered ? void 0 : headers instanceof Headers ? headers : new Headers(
    // Filter out HTTP/2 pseudo-headers. These are internally-generated headers added to all HTTP/2 requests with trusted metadata about the request.
    // Examples include `:method`, `:scheme`, `:authority`, and `:path`.
    // They are always prefixed with a colon to distinguish them from other headers, and it is an error to add the to a Headers object manually.
    // See https://httpwg.org/specs/rfc7540.html#HttpRequest
    Object.entries(headers).filter(([name]) => !name.startsWith(":"))
  );
  if (typeof url === "string") url = new URL(url);
  if (isPrerendered) {
    url.search = "";
  }
  const request = new Request(url, {
    method,
    headers: headersObj,
    // body is made available only if the request is for a page that will be on-demand rendered
    body: isPrerendered ? null : body,
    ...init
  });
  if (isPrerendered) {
    let _headers = request.headers;
    const { value, writable, ...headersDesc } = Object.getOwnPropertyDescriptor(request, "headers") || {};
    Object.defineProperty(request, "headers", {
      ...headersDesc,
      get() {
        logger.warn(
          null,
          `\`Astro.request.headers\` was used when rendering the route \`${routePattern}'\`. \`Astro.request.headers\` is not available on prerendered pages. If you need access to request headers, make sure that the page is server-rendered using \`export const prerender = false;\` or by setting \`output\` to \`"server"\` in your Astro config to make all your pages server-rendered by default.`
        );
        return _headers;
      },
      set(newHeaders) {
        _headers = newHeaders;
      }
    });
  }
  return request;
}

function findRouteToRewrite({
  payload,
  routes,
  request,
  trailingSlash,
  buildFormat,
  base,
  outDir
}) {
  let newUrl = void 0;
  if (payload instanceof URL) {
    newUrl = payload;
  } else if (payload instanceof Request) {
    newUrl = new URL(payload.url);
  } else {
    newUrl = new URL(payload, new URL(request.url).origin);
  }
  let pathname = newUrl.pathname;
  const shouldAppendSlash = shouldAppendForwardSlash(trailingSlash, buildFormat);
  if (base !== "/") {
    const isBasePathRequest = newUrl.pathname === base || newUrl.pathname === removeTrailingForwardSlash(base);
    if (isBasePathRequest) {
      pathname = shouldAppendSlash ? "/" : "";
    } else if (newUrl.pathname.startsWith(base)) {
      pathname = shouldAppendSlash ? appendForwardSlash$1(newUrl.pathname) : removeTrailingForwardSlash(newUrl.pathname);
      pathname = pathname.slice(base.length);
    }
  }
  if (!pathname.startsWith("/") && shouldAppendSlash && newUrl.pathname.endsWith("/")) {
    pathname = prependForwardSlash$1(pathname);
  }
  if (pathname === "/" && base !== "/" && !shouldAppendSlash) {
    pathname = "";
  }
  if (buildFormat === "file") {
    pathname = pathname.replace(/\.html$/, "");
  }
  if (base !== "/" && (pathname === "" || pathname === "/") && !shouldAppendSlash) {
    newUrl.pathname = removeTrailingForwardSlash(base);
  } else {
    newUrl.pathname = joinPaths(...[base, pathname].filter(Boolean));
  }
  const decodedPathname = decodeURI(pathname);
  let foundRoute;
  for (const route of routes) {
    if (route.pattern.test(decodedPathname)) {
      if (route.params && route.params.length !== 0 && route.distURL && route.distURL.length !== 0) {
        if (!route.distURL.find(
          (url) => url.href.replace(outDir.toString(), "").replace(/(?:\/index\.html|\.html)$/, "") == trimSlashes(decodedPathname)
        )) {
          continue;
        }
      }
      foundRoute = route;
      break;
    }
  }
  if (foundRoute) {
    return {
      routeData: foundRoute,
      newUrl,
      pathname: decodedPathname
    };
  } else {
    const custom404 = routes.find((route) => route.route === "/404");
    if (custom404) {
      return { routeData: custom404, newUrl, pathname };
    } else {
      return { routeData: DEFAULT_404_ROUTE, newUrl, pathname };
    }
  }
}
function copyRequest(newUrl, oldRequest, isPrerendered, logger, routePattern) {
  if (oldRequest.bodyUsed) {
    throw new AstroError(RewriteWithBodyUsed);
  }
  return createRequest({
    url: newUrl,
    method: oldRequest.method,
    body: oldRequest.body,
    isPrerendered,
    logger,
    headers: isPrerendered ? {} : oldRequest.headers,
    routePattern,
    init: {
      referrer: oldRequest.referrer,
      referrerPolicy: oldRequest.referrerPolicy,
      mode: oldRequest.mode,
      credentials: oldRequest.credentials,
      cache: oldRequest.cache,
      redirect: oldRequest.redirect,
      integrity: oldRequest.integrity,
      signal: oldRequest.signal,
      keepalive: oldRequest.keepalive,
      // https://fetch.spec.whatwg.org/#dom-request-duplex
      // @ts-expect-error It isn't part of the types, but undici accepts it and it allows to carry over the body to a new request
      duplex: "half"
    }
  });
}
function setOriginPathname(request, pathname, trailingSlash, buildFormat) {
  if (!pathname) {
    pathname = "/";
  }
  const shouldAppendSlash = shouldAppendForwardSlash(trailingSlash, buildFormat);
  let finalPathname;
  if (pathname === "/") {
    finalPathname = "/";
  } else if (shouldAppendSlash) {
    finalPathname = appendForwardSlash$1(pathname);
  } else {
    finalPathname = removeTrailingForwardSlash(pathname);
  }
  Reflect.set(request, originPathnameSymbol, encodeURIComponent(finalPathname));
}
function getOriginPathname(request) {
  const origin = Reflect.get(request, originPathnameSymbol);
  if (origin) {
    return decodeURIComponent(origin);
  }
  return new URL(request.url).pathname;
}

const NOOP_ACTIONS_MOD = {
  server: {}
};

const FORM_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain"
];
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
function createOriginCheckMiddleware() {
  return defineMiddleware((context, next) => {
    const { request, url, isPrerendered } = context;
    if (isPrerendered) {
      return next();
    }
    if (SAFE_METHODS.includes(request.method)) {
      return next();
    }
    const isSameOrigin = request.headers.get("origin") === url.origin;
    const hasContentType = request.headers.has("content-type");
    if (hasContentType) {
      const formLikeHeader = hasFormLikeHeader(request.headers.get("content-type"));
      if (formLikeHeader && !isSameOrigin) {
        return new Response(`Cross-site ${request.method} form submissions are forbidden`, {
          status: 403
        });
      }
    } else {
      if (!isSameOrigin) {
        return new Response(`Cross-site ${request.method} form submissions are forbidden`, {
          status: 403
        });
      }
    }
    return next();
  });
}
function hasFormLikeHeader(contentType) {
  if (contentType) {
    for (const FORM_CONTENT_TYPE of FORM_CONTENT_TYPES) {
      if (contentType.toLowerCase().includes(FORM_CONTENT_TYPE)) {
        return true;
      }
    }
  }
  return false;
}

const VALID_PARAM_TYPES = ["string", "number", "undefined"];
function validateGetStaticPathsParameter([key, value], route) {
  if (!VALID_PARAM_TYPES.includes(typeof value)) {
    throw new AstroError({
      ...GetStaticPathsInvalidRouteParam,
      message: GetStaticPathsInvalidRouteParam.message(key, value, typeof value),
      location: {
        file: route
      }
    });
  }
}
function validateDynamicRouteModule(mod, {
  ssr,
  route
}) {
  if ((!ssr || route.prerender) && !mod.getStaticPaths) {
    throw new AstroError({
      ...GetStaticPathsRequired,
      location: { file: route.component }
    });
  }
}
function validateGetStaticPathsResult(result, logger, route) {
  if (!Array.isArray(result)) {
    throw new AstroError({
      ...InvalidGetStaticPathsReturn,
      message: InvalidGetStaticPathsReturn.message(typeof result),
      location: {
        file: route.component
      }
    });
  }
  result.forEach((pathObject) => {
    if (typeof pathObject === "object" && Array.isArray(pathObject) || pathObject === null) {
      throw new AstroError({
        ...InvalidGetStaticPathsEntry,
        message: InvalidGetStaticPathsEntry.message(
          Array.isArray(pathObject) ? "array" : typeof pathObject
        )
      });
    }
    if (pathObject.params === void 0 || pathObject.params === null || pathObject.params && Object.keys(pathObject.params).length === 0) {
      throw new AstroError({
        ...GetStaticPathsExpectedParams,
        location: {
          file: route.component
        }
      });
    }
    for (const [key, val] of Object.entries(pathObject.params)) {
      if (!(typeof val === "undefined" || typeof val === "string" || typeof val === "number")) {
        logger.warn(
          "router",
          `getStaticPaths() returned an invalid path param: "${key}". A string, number or undefined value was expected, but got \`${JSON.stringify(
            val
          )}\`.`
        );
      }
      if (typeof val === "string" && val === "") {
        logger.warn(
          "router",
          `getStaticPaths() returned an invalid path param: "${key}". \`undefined\` expected for an optional param, but got empty string.`
        );
      }
    }
  });
}

function stringifyParams(params, route) {
  const validatedParams = Object.entries(params).reduce((acc, next) => {
    validateGetStaticPathsParameter(next, route.component);
    const [key, value] = next;
    if (value !== void 0) {
      acc[key] = typeof value === "string" ? trimSlashes(value) : value.toString();
    }
    return acc;
  }, {});
  return route.generate(validatedParams);
}

function generatePaginateFunction(routeMatch, base) {
  return function paginateUtility(data, args = {}) {
    let { pageSize: _pageSize, params: _params, props: _props } = args;
    const pageSize = _pageSize || 10;
    const paramName = "page";
    const additionalParams = _params || {};
    const additionalProps = _props || {};
    let includesFirstPageNumber;
    if (routeMatch.params.includes(`...${paramName}`)) {
      includesFirstPageNumber = false;
    } else if (routeMatch.params.includes(`${paramName}`)) {
      includesFirstPageNumber = true;
    } else {
      throw new AstroError({
        ...PageNumberParamNotFound,
        message: PageNumberParamNotFound.message(paramName)
      });
    }
    const lastPage = Math.max(1, Math.ceil(data.length / pageSize));
    const result = [...Array(lastPage).keys()].map((num) => {
      const pageNum = num + 1;
      const start = pageSize === Infinity ? 0 : (pageNum - 1) * pageSize;
      const end = Math.min(start + pageSize, data.length);
      const params = {
        ...additionalParams,
        [paramName]: includesFirstPageNumber || pageNum > 1 ? String(pageNum) : void 0
      };
      const current = addRouteBase(routeMatch.generate({ ...params }), base);
      const next = pageNum === lastPage ? void 0 : addRouteBase(routeMatch.generate({ ...params, page: String(pageNum + 1) }), base);
      const prev = pageNum === 1 ? void 0 : addRouteBase(
        routeMatch.generate({
          ...params,
          page: !includesFirstPageNumber && pageNum - 1 === 1 ? void 0 : String(pageNum - 1)
        }),
        base
      );
      const first = pageNum === 1 ? void 0 : addRouteBase(
        routeMatch.generate({
          ...params,
          page: includesFirstPageNumber ? "1" : void 0
        }),
        base
      );
      const last = pageNum === lastPage ? void 0 : addRouteBase(routeMatch.generate({ ...params, page: String(lastPage) }), base);
      return {
        params,
        props: {
          ...additionalProps,
          page: {
            data: data.slice(start, end),
            start,
            end: end - 1,
            size: pageSize,
            total: data.length,
            currentPage: pageNum,
            lastPage,
            url: { current, next, prev, first, last }
          }
        }
      };
    });
    return result;
  };
}
function addRouteBase(route, base) {
  let routeWithBase = joinPaths(base, route);
  if (routeWithBase === "") routeWithBase = "/";
  return routeWithBase;
}

async function callGetStaticPaths({
  mod,
  route,
  routeCache,
  logger,
  ssr,
  base
}) {
  const cached = routeCache.get(route);
  if (!mod) {
    throw new Error("This is an error caused by Astro and not your code. Please file an issue.");
  }
  if (cached?.staticPaths) {
    return cached.staticPaths;
  }
  validateDynamicRouteModule(mod, { ssr, route });
  if (ssr && !route.prerender) {
    const entry = Object.assign([], { keyed: /* @__PURE__ */ new Map() });
    routeCache.set(route, { ...cached, staticPaths: entry });
    return entry;
  }
  let staticPaths = [];
  if (!mod.getStaticPaths) {
    throw new Error("Unexpected Error.");
  }
  staticPaths = await mod.getStaticPaths({
    // Q: Why the cast?
    // A: So users downstream can have nicer typings, we have to make some sacrifice in our internal typings, which necessitate a cast here
    paginate: generatePaginateFunction(route, base),
    routePattern: route.route
  });
  validateGetStaticPathsResult(staticPaths, logger, route);
  const keyedStaticPaths = staticPaths;
  keyedStaticPaths.keyed = /* @__PURE__ */ new Map();
  for (const sp of keyedStaticPaths) {
    const paramsKey = stringifyParams(sp.params, route);
    keyedStaticPaths.keyed.set(paramsKey, sp);
  }
  routeCache.set(route, { ...cached, staticPaths: keyedStaticPaths });
  return keyedStaticPaths;
}
class RouteCache {
  logger;
  cache = {};
  runtimeMode;
  constructor(logger, runtimeMode = "production") {
    this.logger = logger;
    this.runtimeMode = runtimeMode;
  }
  /** Clear the cache. */
  clearAll() {
    this.cache = {};
  }
  set(route, entry) {
    const key = this.key(route);
    if (this.runtimeMode === "production" && this.cache[key]?.staticPaths) {
      this.logger.warn(null, `Internal Warning: route cache overwritten. (${key})`);
    }
    this.cache[key] = entry;
  }
  get(route) {
    return this.cache[this.key(route)];
  }
  key(route) {
    return `${route.route}_${route.component}`;
  }
}
function findPathItemByKey(staticPaths, params, route, logger) {
  const paramsKey = stringifyParams(params, route);
  const matchedStaticPath = staticPaths.keyed.get(paramsKey);
  if (matchedStaticPath) {
    return matchedStaticPath;
  }
  logger.debug("router", `findPathItemByKey() - Unexpected cache miss looking for ${paramsKey}`);
}

function createDefaultRoutes(manifest) {
  const root = new URL(manifest.hrefRoot);
  return [
    {
      instance: default404Instance,
      matchesComponent: (filePath) => filePath.href === new URL(DEFAULT_404_COMPONENT, root).href,
      route: DEFAULT_404_ROUTE.route,
      component: DEFAULT_404_COMPONENT
    },
    {
      instance: createEndpoint(manifest),
      matchesComponent: (filePath) => filePath.href === new URL(SERVER_ISLAND_COMPONENT, root).href,
      route: SERVER_ISLAND_ROUTE,
      component: SERVER_ISLAND_COMPONENT
    }
  ];
}

class Pipeline {
  constructor(logger, manifest, runtimeMode, renderers, resolve, serverLike, streaming, adapterName = manifest.adapterName, clientDirectives = manifest.clientDirectives, inlinedScripts = manifest.inlinedScripts, compressHTML = manifest.compressHTML, i18n = manifest.i18n, middleware = manifest.middleware, routeCache = new RouteCache(logger, runtimeMode), site = manifest.site ? new URL(manifest.site) : void 0, defaultRoutes = createDefaultRoutes(manifest), actions = manifest.actions) {
    this.logger = logger;
    this.manifest = manifest;
    this.runtimeMode = runtimeMode;
    this.renderers = renderers;
    this.resolve = resolve;
    this.serverLike = serverLike;
    this.streaming = streaming;
    this.adapterName = adapterName;
    this.clientDirectives = clientDirectives;
    this.inlinedScripts = inlinedScripts;
    this.compressHTML = compressHTML;
    this.i18n = i18n;
    this.middleware = middleware;
    this.routeCache = routeCache;
    this.site = site;
    this.defaultRoutes = defaultRoutes;
    this.actions = actions;
    this.internalMiddleware = [];
    if (i18n?.strategy !== "manual") {
      this.internalMiddleware.push(
        createI18nMiddleware(i18n, manifest.base, manifest.trailingSlash, manifest.buildFormat)
      );
    }
  }
  internalMiddleware;
  resolvedMiddleware = void 0;
  resolvedActions = void 0;
  /**
   * Resolves the middleware from the manifest, and returns the `onRequest` function. If `onRequest` isn't there,
   * it returns a no-op function
   */
  async getMiddleware() {
    if (this.resolvedMiddleware) {
      return this.resolvedMiddleware;
    } else if (this.middleware) {
      const middlewareInstance = await this.middleware();
      const onRequest = middlewareInstance.onRequest ?? NOOP_MIDDLEWARE_FN;
      const internalMiddlewares = [onRequest];
      if (this.manifest.checkOrigin) {
        internalMiddlewares.unshift(createOriginCheckMiddleware());
      }
      this.resolvedMiddleware = sequence(...internalMiddlewares);
      return this.resolvedMiddleware;
    } else {
      this.resolvedMiddleware = NOOP_MIDDLEWARE_FN;
      return this.resolvedMiddleware;
    }
  }
  setActions(actions) {
    this.resolvedActions = actions;
  }
  async getActions() {
    if (this.resolvedActions) {
      return this.resolvedActions;
    } else if (this.actions) {
      return await this.actions();
    }
    return NOOP_ACTIONS_MOD;
  }
  async getAction(path) {
    const pathKeys = path.split(".").map((key) => decodeURIComponent(key));
    let { server } = await this.getActions();
    if (!server || !(typeof server === "object")) {
      throw new TypeError(
        `Expected \`server\` export in actions file to be an object. Received ${typeof server}.`
      );
    }
    for (const key of pathKeys) {
      if (!(key in server)) {
        throw new AstroError({
          ...ActionNotFoundError,
          message: ActionNotFoundError.message(pathKeys.join("."))
        });
      }
      server = server[key];
    }
    if (typeof server !== "function") {
      throw new TypeError(
        `Expected handler for action ${pathKeys.join(".")} to be a function. Received ${typeof server}.`
      );
    }
    return server;
  }
}

function routeIsRedirect(route) {
  return route?.type === "redirect";
}
function routeIsFallback(route) {
  return route?.type === "fallback";
}

const RedirectComponentInstance = {
  default() {
    return new Response(null, {
      status: 301
    });
  }
};
const RedirectSinglePageBuiltModule = {
  page: () => Promise.resolve(RedirectComponentInstance),
  onRequest: (_, next) => next(),
  renderers: []
};

async function getProps(opts) {
  const { logger, mod, routeData: route, routeCache, pathname, serverLike, base } = opts;
  if (!route || route.pathname) {
    return {};
  }
  if (routeIsRedirect(route) || routeIsFallback(route) || route.component === DEFAULT_404_COMPONENT) {
    return {};
  }
  const staticPaths = await callGetStaticPaths({
    mod,
    route,
    routeCache,
    logger,
    ssr: serverLike,
    base
  });
  const params = getParams(route, pathname);
  const matchedStaticPath = findPathItemByKey(staticPaths, params, route, logger);
  if (!matchedStaticPath && (serverLike ? route.prerender : true)) {
    throw new AstroError({
      ...NoMatchingStaticPathFound,
      message: NoMatchingStaticPathFound.message(pathname),
      hint: NoMatchingStaticPathFound.hint([route.component])
    });
  }
  if (mod) {
    validatePrerenderEndpointCollision(route, mod, params);
  }
  const props = matchedStaticPath?.props ? { ...matchedStaticPath.props } : {};
  return props;
}
function getParams(route, pathname) {
  if (!route.params.length) return {};
  const paramsMatch = route.pattern.exec(pathname) || route.fallbackRoutes.map((fallbackRoute) => fallbackRoute.pattern.exec(pathname)).find((x) => x);
  if (!paramsMatch) return {};
  const params = {};
  route.params.forEach((key, i) => {
    if (key.startsWith("...")) {
      params[key.slice(3)] = paramsMatch[i + 1] ? paramsMatch[i + 1] : void 0;
    } else {
      params[key] = paramsMatch[i + 1];
    }
  });
  return params;
}
function validatePrerenderEndpointCollision(route, mod, params) {
  if (route.type === "endpoint" && mod.getStaticPaths) {
    const lastSegment = route.segments[route.segments.length - 1];
    const paramValues = Object.values(params);
    const lastParam = paramValues[paramValues.length - 1];
    if (lastSegment.length === 1 && lastSegment[0].dynamic && lastParam === void 0) {
      throw new AstroError({
        ...PrerenderDynamicEndpointPathCollide,
        message: PrerenderDynamicEndpointPathCollide.message(route.route),
        hint: PrerenderDynamicEndpointPathCollide.hint(route.component),
        location: {
          file: route.component
        }
      });
    }
  }
}

function getFunctionExpression(slot) {
  if (!slot) return;
  const expressions = slot?.expressions?.filter((e) => isRenderInstruction(e) === false);
  if (expressions?.length !== 1) return;
  return expressions[0];
}
class Slots {
  #result;
  #slots;
  #logger;
  constructor(result, slots, logger) {
    this.#result = result;
    this.#slots = slots;
    this.#logger = logger;
    if (slots) {
      for (const key of Object.keys(slots)) {
        if (this[key] !== void 0) {
          throw new AstroError({
            ...ReservedSlotName,
            message: ReservedSlotName.message(key)
          });
        }
        Object.defineProperty(this, key, {
          get() {
            return true;
          },
          enumerable: true
        });
      }
    }
  }
  has(name) {
    if (!this.#slots) return false;
    return Boolean(this.#slots[name]);
  }
  async render(name, args = []) {
    if (!this.#slots || !this.has(name)) return;
    const result = this.#result;
    if (!Array.isArray(args)) {
      this.#logger.warn(
        null,
        `Expected second parameter to be an array, received a ${typeof args}. If you're trying to pass an array as a single argument and getting unexpected results, make sure you're passing your array as a item of an array. Ex: Astro.slots.render('default', [["Hello", "World"]])`
      );
    } else if (args.length > 0) {
      const slotValue = this.#slots[name];
      const component = typeof slotValue === "function" ? await slotValue(result) : await slotValue;
      const expression = getFunctionExpression(component);
      if (expression) {
        const slot = async () => typeof expression === "function" ? expression(...args) : expression;
        return await renderSlotToString(result, slot).then((res) => {
          return res;
        });
      }
      if (typeof component === "function") {
        return await renderJSX(result, component(...args)).then(
          (res) => res != null ? String(res) : res
        );
      }
    }
    const content = await renderSlotToString(result, this.#slots[name]);
    const outHTML = chunkToString(result, content);
    return outHTML;
  }
}

function sequence(...handlers) {
  const filtered = handlers.filter((h) => !!h);
  const length = filtered.length;
  if (!length) {
    return defineMiddleware((_context, next) => {
      return next();
    });
  }
  return defineMiddleware((context, next) => {
    let carriedPayload = void 0;
    return applyHandle(0, context);
    function applyHandle(i, handleContext) {
      const handle = filtered[i];
      const result = handle(handleContext, async (payload) => {
        if (i < length - 1) {
          if (payload) {
            let newRequest;
            if (payload instanceof Request) {
              newRequest = payload;
            } else if (payload instanceof URL) {
              newRequest = new Request(payload, handleContext.request.clone());
            } else {
              newRequest = new Request(
                new URL(payload, handleContext.url.origin),
                handleContext.request.clone()
              );
            }
            const oldPathname = handleContext.url.pathname;
            const pipeline = Reflect.get(handleContext, apiContextRoutesSymbol);
            const { routeData, pathname } = await pipeline.tryRewrite(
              payload,
              handleContext.request
            );
            if (pipeline.serverLike === true && handleContext.isPrerendered === false && routeData.prerender === true) {
              throw new AstroError({
                ...ForbiddenRewrite,
                message: ForbiddenRewrite.message(
                  handleContext.url.pathname,
                  pathname,
                  routeData.component
                ),
                hint: ForbiddenRewrite.hint(routeData.component)
              });
            }
            carriedPayload = payload;
            handleContext.request = newRequest;
            handleContext.url = new URL(newRequest.url);
            handleContext.params = getParams(routeData, pathname);
            handleContext.routePattern = routeData.route;
            setOriginPathname(
              handleContext.request,
              oldPathname,
              pipeline.manifest.trailingSlash,
              pipeline.manifest.buildFormat
            );
          }
          return applyHandle(i + 1, handleContext);
        } else {
          return next(payload ?? carriedPayload);
        }
      });
      return result;
    }
  });
}

function defineMiddleware(fn) {
  return fn;
}

const PERSIST_SYMBOL = Symbol();
const DEFAULT_COOKIE_NAME = "astro-session";
const VALID_COOKIE_REGEX = /^[\w-]+$/;
const unflatten = (parsed, _) => {
  return unflatten$1(parsed, {
    URL: (href) => new URL(href)
  });
};
const stringify = (data, _) => {
  return stringify$1(data, {
    // Support URL objects
    URL: (val) => val instanceof URL && val.href
  });
};
class AstroSession {
  // The cookies object.
  #cookies;
  // The session configuration.
  #config;
  // The cookie config
  #cookieConfig;
  // The cookie name
  #cookieName;
  // The unstorage object for the session driver.
  #storage;
  #data;
  // The session ID. A v4 UUID.
  #sessionID;
  // Sessions to destroy. Needed because we won't have the old session ID after it's destroyed locally.
  #toDestroy = /* @__PURE__ */ new Set();
  // Session keys to delete. Used for partial data sets to avoid overwriting the deleted value.
  #toDelete = /* @__PURE__ */ new Set();
  // Whether the session is dirty and needs to be saved.
  #dirty = false;
  // Whether the session cookie has been set.
  #cookieSet = false;
  // The local data is "partial" if it has not been loaded from storage yet and only
  // contains values that have been set or deleted in-memory locally.
  // We do this to avoid the need to block on loading data when it is only being set.
  // When we load the data from storage, we need to merge it with the local partial data,
  // preserving in-memory changes and deletions.
  #partial = true;
  static #sharedStorage = /* @__PURE__ */ new Map();
  constructor(cookies, {
    cookie: cookieConfig = DEFAULT_COOKIE_NAME,
    ...config
  }, runtimeMode) {
    const { driver } = config;
    if (!driver) {
      throw new AstroError({
        ...SessionStorageInitError,
        message: SessionStorageInitError.message(
          "No driver was defined in the session configuration and the adapter did not provide a default driver."
        )
      });
    }
    this.#cookies = cookies;
    let cookieConfigObject;
    if (typeof cookieConfig === "object") {
      const { name = DEFAULT_COOKIE_NAME, ...rest } = cookieConfig;
      this.#cookieName = name;
      cookieConfigObject = rest;
    } else {
      this.#cookieName = cookieConfig || DEFAULT_COOKIE_NAME;
    }
    this.#cookieConfig = {
      sameSite: "lax",
      secure: runtimeMode === "production",
      path: "/",
      ...cookieConfigObject,
      httpOnly: true
    };
    this.#config = { ...config, driver };
  }
  /**
   * Gets a session value. Returns `undefined` if the session or value does not exist.
   */
  async get(key) {
    return (await this.#ensureData()).get(key)?.data;
  }
  /**
   * Checks if a session value exists.
   */
  async has(key) {
    return (await this.#ensureData()).has(key);
  }
  /**
   * Gets all session values.
   */
  async keys() {
    return (await this.#ensureData()).keys();
  }
  /**
   * Gets all session values.
   */
  async values() {
    return [...(await this.#ensureData()).values()].map((entry) => entry.data);
  }
  /**
   * Gets all session entries.
   */
  async entries() {
    return [...(await this.#ensureData()).entries()].map(([key, entry]) => [key, entry.data]);
  }
  /**
   * Deletes a session value.
   */
  delete(key) {
    this.#data?.delete(key);
    if (this.#partial) {
      this.#toDelete.add(key);
    }
    this.#dirty = true;
  }
  /**
   * Sets a session value. The session is created if it does not exist.
   */
  set(key, value, { ttl } = {}) {
    if (!key) {
      throw new AstroError({
        ...SessionStorageSaveError,
        message: "The session key was not provided."
      });
    }
    let cloned;
    try {
      cloned = unflatten(JSON.parse(stringify(value)));
    } catch (err) {
      throw new AstroError(
        {
          ...SessionStorageSaveError,
          message: `The session data for ${key} could not be serialized.`,
          hint: "See the devalue library for all supported types: https://github.com/rich-harris/devalue"
        },
        { cause: err }
      );
    }
    if (!this.#cookieSet) {
      this.#setCookie();
      this.#cookieSet = true;
    }
    this.#data ??= /* @__PURE__ */ new Map();
    const lifetime = ttl ?? this.#config.ttl;
    const expires = typeof lifetime === "number" ? Date.now() + lifetime * 1e3 : lifetime;
    this.#data.set(key, {
      data: cloned,
      expires
    });
    this.#dirty = true;
  }
  /**
   * Destroys the session, clearing the cookie and storage if it exists.
   */
  destroy() {
    const sessionId = this.#sessionID ?? this.#cookies.get(this.#cookieName)?.value;
    if (sessionId) {
      this.#toDestroy.add(sessionId);
    }
    this.#cookies.delete(this.#cookieName, this.#cookieConfig);
    this.#sessionID = void 0;
    this.#data = void 0;
    this.#dirty = true;
  }
  /**
   * Regenerates the session, creating a new session ID. The existing session data is preserved.
   */
  async regenerate() {
    let data = /* @__PURE__ */ new Map();
    try {
      data = await this.#ensureData();
    } catch (err) {
      console.error("Failed to load session data during regeneration:", err);
    }
    const oldSessionId = this.#sessionID;
    this.#sessionID = crypto.randomUUID();
    this.#data = data;
    await this.#setCookie();
    if (oldSessionId && this.#storage) {
      this.#storage.removeItem(oldSessionId).catch((err) => {
        console.error("Failed to remove old session data:", err);
      });
    }
  }
  // Persists the session data to storage.
  // This is called automatically at the end of the request.
  // Uses a symbol to prevent users from calling it directly.
  async [PERSIST_SYMBOL]() {
    if (!this.#dirty && !this.#toDestroy.size) {
      return;
    }
    const storage = await this.#ensureStorage();
    if (this.#dirty && this.#data) {
      const data = await this.#ensureData();
      this.#toDelete.forEach((key2) => data.delete(key2));
      const key = this.#ensureSessionID();
      let serialized;
      try {
        serialized = stringify(data);
      } catch (err) {
        throw new AstroError(
          {
            ...SessionStorageSaveError,
            message: SessionStorageSaveError.message(
              "The session data could not be serialized.",
              this.#config.driver
            )
          },
          { cause: err }
        );
      }
      await storage.setItem(key, serialized);
      this.#dirty = false;
    }
    if (this.#toDestroy.size > 0) {
      const cleanupPromises = [...this.#toDestroy].map(
        (sessionId) => storage.removeItem(sessionId).catch((err) => {
          console.error(`Failed to clean up session ${sessionId}:`, err);
        })
      );
      await Promise.all(cleanupPromises);
      this.#toDestroy.clear();
    }
  }
  get sessionID() {
    return this.#sessionID;
  }
  /**
   * Loads a session from storage with the given ID, and replaces the current session.
   * Any changes made to the current session will be lost.
   * This is not normally needed, as the session is automatically loaded using the cookie.
   * However it can be used to restore a session where the ID has been recorded somewhere
   * else (e.g. in a database).
   */
  async load(sessionID) {
    this.#sessionID = sessionID;
    this.#data = void 0;
    await this.#setCookie();
    await this.#ensureData();
  }
  /**
   * Sets the session cookie.
   */
  async #setCookie() {
    if (!VALID_COOKIE_REGEX.test(this.#cookieName)) {
      throw new AstroError({
        ...SessionStorageSaveError,
        message: "Invalid cookie name. Cookie names can only contain letters, numbers, and dashes."
      });
    }
    const value = this.#ensureSessionID();
    this.#cookies.set(this.#cookieName, value, this.#cookieConfig);
  }
  /**
   * Attempts to load the session data from storage, or creates a new data object if none exists.
   * If there is existing partial data, it will be merged into the new data object.
   */
  async #ensureData() {
    const storage = await this.#ensureStorage();
    if (this.#data && !this.#partial) {
      return this.#data;
    }
    this.#data ??= /* @__PURE__ */ new Map();
    const raw = await storage.get(this.#ensureSessionID());
    if (!raw) {
      return this.#data;
    }
    try {
      const storedMap = unflatten(raw);
      if (!(storedMap instanceof Map)) {
        await this.destroy();
        throw new AstroError({
          ...SessionStorageInitError,
          message: SessionStorageInitError.message(
            "The session data was an invalid type.",
            this.#config.driver
          )
        });
      }
      const now = Date.now();
      for (const [key, value] of storedMap) {
        const expired = typeof value.expires === "number" && value.expires < now;
        if (!this.#data.has(key) && !this.#toDelete.has(key) && !expired) {
          this.#data.set(key, value);
        }
      }
      this.#partial = false;
      return this.#data;
    } catch (err) {
      await this.destroy();
      if (err instanceof AstroError) {
        throw err;
      }
      throw new AstroError(
        {
          ...SessionStorageInitError,
          message: SessionStorageInitError.message(
            "The session data could not be parsed.",
            this.#config.driver
          )
        },
        { cause: err }
      );
    }
  }
  /**
   * Returns the session ID, generating a new one if it does not exist.
   */
  #ensureSessionID() {
    this.#sessionID ??= this.#cookies.get(this.#cookieName)?.value ?? crypto.randomUUID();
    return this.#sessionID;
  }
  /**
   * Ensures the storage is initialized.
   * This is called automatically when a storage operation is needed.
   */
  async #ensureStorage() {
    if (this.#storage) {
      return this.#storage;
    }
    if (AstroSession.#sharedStorage.has(this.#config.driver)) {
      this.#storage = AstroSession.#sharedStorage.get(this.#config.driver);
      return this.#storage;
    }
    if (this.#config.driver === "test") {
      this.#storage = this.#config.options.mockStorage;
      return this.#storage;
    }
    if (this.#config.driver === "fs" || this.#config.driver === "fsLite" || this.#config.driver === "fs-lite") {
      this.#config.options ??= {};
      this.#config.driver = "fs-lite";
      this.#config.options.base ??= ".astro/session";
    }
    let driver = null;
    try {
      if (this.#config.driverModule) {
        driver = (await this.#config.driverModule()).default;
      } else if (this.#config.driver) {
        const driverName = resolveSessionDriverName(this.#config.driver);
        if (driverName) {
          driver = (await import(driverName)).default;
        }
      }
    } catch (err) {
      if (err.code === "ERR_MODULE_NOT_FOUND") {
        throw new AstroError(
          {
            ...SessionStorageInitError,
            message: SessionStorageInitError.message(
              err.message.includes(`Cannot find package`) ? "The driver module could not be found." : err.message,
              this.#config.driver
            )
          },
          { cause: err }
        );
      }
      throw err;
    }
    if (!driver) {
      throw new AstroError({
        ...SessionStorageInitError,
        message: SessionStorageInitError.message(
          "The module did not export a driver.",
          this.#config.driver
        )
      });
    }
    try {
      this.#storage = createStorage({
        driver: driver(this.#config.options)
      });
      AstroSession.#sharedStorage.set(this.#config.driver, this.#storage);
      return this.#storage;
    } catch (err) {
      throw new AstroError(
        {
          ...SessionStorageInitError,
          message: SessionStorageInitError.message("Unknown error", this.#config.driver)
        },
        { cause: err }
      );
    }
  }
}
function resolveSessionDriverName(driver) {
  if (!driver) {
    return null;
  }
  try {
    if (driver === "fs") {
      return builtinDrivers.fsLite;
    }
    if (driver in builtinDrivers) {
      return builtinDrivers[driver];
    }
  } catch {
    return null;
  }
  return driver;
}

const apiContextRoutesSymbol = Symbol.for("context.routes");
class RenderContext {
  constructor(pipeline, locals, middleware, actions, pathname, request, routeData, status, clientAddress, cookies = new AstroCookies(request), params = getParams(routeData, pathname), url = new URL(request.url), props = {}, partial = void 0, shouldInjectCspMetaTags = !!pipeline.manifest.csp, session = pipeline.manifest.sessionConfig ? new AstroSession(cookies, pipeline.manifest.sessionConfig, pipeline.runtimeMode) : void 0) {
    this.pipeline = pipeline;
    this.locals = locals;
    this.middleware = middleware;
    this.actions = actions;
    this.pathname = pathname;
    this.request = request;
    this.routeData = routeData;
    this.status = status;
    this.clientAddress = clientAddress;
    this.cookies = cookies;
    this.params = params;
    this.url = url;
    this.props = props;
    this.partial = partial;
    this.shouldInjectCspMetaTags = shouldInjectCspMetaTags;
    this.session = session;
  }
  /**
   * A flag that tells the render content if the rewriting was triggered
   */
  isRewriting = false;
  /**
   * A safety net in case of loops
   */
  counter = 0;
  result = void 0;
  static async create({
    locals = {},
    middleware,
    pathname,
    pipeline,
    request,
    routeData,
    clientAddress,
    status = 200,
    props,
    partial = void 0,
    actions,
    shouldInjectCspMetaTags
  }) {
    const pipelineMiddleware = await pipeline.getMiddleware();
    const pipelineActions = actions ?? await pipeline.getActions();
    setOriginPathname(
      request,
      pathname,
      pipeline.manifest.trailingSlash,
      pipeline.manifest.buildFormat
    );
    return new RenderContext(
      pipeline,
      locals,
      sequence(...pipeline.internalMiddleware, middleware ?? pipelineMiddleware),
      pipelineActions,
      pathname,
      request,
      routeData,
      status,
      clientAddress,
      void 0,
      void 0,
      void 0,
      props,
      partial,
      shouldInjectCspMetaTags ?? !!pipeline.manifest.csp
    );
  }
  /**
   * The main function of the RenderContext.
   *
   * Use this function to render any route known to Astro.
   * It attempts to render a route. A route can be a:
   *
   * - page
   * - redirect
   * - endpoint
   * - fallback
   */
  async render(componentInstance, slots = {}) {
    const { middleware, pipeline } = this;
    const { logger, serverLike, streaming, manifest } = pipeline;
    const props = Object.keys(this.props).length > 0 ? this.props : await getProps({
      mod: componentInstance,
      routeData: this.routeData,
      routeCache: this.pipeline.routeCache,
      pathname: this.pathname,
      logger,
      serverLike,
      base: manifest.base
    });
    const actionApiContext = this.createActionAPIContext();
    const apiContext = this.createAPIContext(props, actionApiContext);
    this.counter++;
    if (this.counter === 4) {
      return new Response("Loop Detected", {
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/508
        status: 508,
        statusText: "Astro detected a loop where you tried to call the rewriting logic more than four times."
      });
    }
    const lastNext = async (ctx, payload) => {
      if (payload) {
        const oldPathname = this.pathname;
        pipeline.logger.debug("router", "Called rewriting to:", payload);
        const {
          routeData,
          componentInstance: newComponent,
          pathname,
          newUrl
        } = await pipeline.tryRewrite(payload, this.request);
        if (this.pipeline.serverLike === true && this.routeData.prerender === false && routeData.prerender === true) {
          throw new AstroError({
            ...ForbiddenRewrite,
            message: ForbiddenRewrite.message(this.pathname, pathname, routeData.component),
            hint: ForbiddenRewrite.hint(routeData.component)
          });
        }
        this.routeData = routeData;
        componentInstance = newComponent;
        if (payload instanceof Request) {
          this.request = payload;
        } else {
          this.request = copyRequest(
            newUrl,
            this.request,
            // need to send the flag of the previous routeData
            routeData.prerender,
            this.pipeline.logger,
            this.routeData.route
          );
        }
        this.isRewriting = true;
        this.url = new URL(this.request.url);
        this.params = getParams(routeData, pathname);
        this.pathname = pathname;
        this.status = 200;
        setOriginPathname(
          this.request,
          oldPathname,
          this.pipeline.manifest.trailingSlash,
          this.pipeline.manifest.buildFormat
        );
      }
      let response2;
      if (!ctx.isPrerendered) {
        const { action, setActionResult, serializeActionResult } = getActionContext(ctx);
        if (action?.calledFrom === "form") {
          const actionResult = await action.handler();
          setActionResult(action.name, serializeActionResult(actionResult));
        }
      }
      switch (this.routeData.type) {
        case "endpoint": {
          response2 = await renderEndpoint(
            componentInstance,
            ctx,
            this.routeData.prerender,
            logger
          );
          break;
        }
        case "redirect":
          return renderRedirect(this);
        case "page": {
          this.result = await this.createResult(componentInstance, actionApiContext);
          try {
            response2 = await renderPage(
              this.result,
              componentInstance?.default,
              props,
              slots,
              streaming,
              this.routeData
            );
          } catch (e) {
            this.result.cancelled = true;
            throw e;
          }
          response2.headers.set(ROUTE_TYPE_HEADER, "page");
          if (this.routeData.route === "/404" || this.routeData.route === "/500") {
            response2.headers.set(REROUTE_DIRECTIVE_HEADER, "no");
          }
          if (this.isRewriting) {
            response2.headers.set(REWRITE_DIRECTIVE_HEADER_KEY, REWRITE_DIRECTIVE_HEADER_VALUE);
          }
          break;
        }
        case "fallback": {
          return new Response(null, { status: 500, headers: { [ROUTE_TYPE_HEADER]: "fallback" } });
        }
      }
      const responseCookies = getCookiesFromResponse(response2);
      if (responseCookies) {
        this.cookies.merge(responseCookies);
      }
      return response2;
    };
    if (isRouteExternalRedirect(this.routeData)) {
      return renderRedirect(this);
    }
    const response = await callMiddleware(middleware, apiContext, lastNext);
    if (response.headers.get(ROUTE_TYPE_HEADER)) {
      response.headers.delete(ROUTE_TYPE_HEADER);
    }
    attachCookiesToResponse(response, this.cookies);
    return response;
  }
  createAPIContext(props, context) {
    const redirect = (path, status = 302) => new Response(null, { status, headers: { Location: path } });
    Reflect.set(context, apiContextRoutesSymbol, this.pipeline);
    return Object.assign(context, {
      props,
      redirect,
      getActionResult: createGetActionResult(context.locals),
      callAction: createCallAction(context)
    });
  }
  async #executeRewrite(reroutePayload) {
    this.pipeline.logger.debug("router", "Calling rewrite: ", reroutePayload);
    const oldPathname = this.pathname;
    const { routeData, componentInstance, newUrl, pathname } = await this.pipeline.tryRewrite(
      reroutePayload,
      this.request
    );
    const isI18nFallback = routeData.fallbackRoutes && routeData.fallbackRoutes.length > 0;
    if (this.pipeline.serverLike && !this.routeData.prerender && routeData.prerender && !isI18nFallback) {
      throw new AstroError({
        ...ForbiddenRewrite,
        message: ForbiddenRewrite.message(this.pathname, pathname, routeData.component),
        hint: ForbiddenRewrite.hint(routeData.component)
      });
    }
    this.routeData = routeData;
    if (reroutePayload instanceof Request) {
      this.request = reroutePayload;
    } else {
      this.request = copyRequest(
        newUrl,
        this.request,
        // need to send the flag of the previous routeData
        routeData.prerender,
        this.pipeline.logger,
        this.routeData.route
      );
    }
    this.url = new URL(this.request.url);
    const newCookies = new AstroCookies(this.request);
    if (this.cookies) {
      newCookies.merge(this.cookies);
    }
    this.cookies = newCookies;
    this.params = getParams(routeData, pathname);
    this.pathname = pathname;
    this.isRewriting = true;
    this.status = 200;
    setOriginPathname(
      this.request,
      oldPathname,
      this.pipeline.manifest.trailingSlash,
      this.pipeline.manifest.buildFormat
    );
    return await this.render(componentInstance);
  }
  createActionAPIContext() {
    const renderContext = this;
    const { params, pipeline, url } = this;
    const generator = `Astro v${ASTRO_VERSION}`;
    const rewrite = async (reroutePayload) => {
      return await this.#executeRewrite(reroutePayload);
    };
    return {
      // Don't allow reassignment of cookies because it doesn't work
      get cookies() {
        return renderContext.cookies;
      },
      routePattern: this.routeData.route,
      isPrerendered: this.routeData.prerender,
      get clientAddress() {
        return renderContext.getClientAddress();
      },
      get currentLocale() {
        return renderContext.computeCurrentLocale();
      },
      generator,
      get locals() {
        return renderContext.locals;
      },
      set locals(_) {
        throw new AstroError(LocalsReassigned);
      },
      params,
      get preferredLocale() {
        return renderContext.computePreferredLocale();
      },
      get preferredLocaleList() {
        return renderContext.computePreferredLocaleList();
      },
      rewrite,
      request: this.request,
      site: pipeline.site,
      url,
      get originPathname() {
        return getOriginPathname(renderContext.request);
      },
      get session() {
        if (this.isPrerendered) {
          pipeline.logger.warn(
            "session",
            `context.session was used when rendering the route ${colors.green(this.routePattern)}, but it is not available on prerendered routes. If you need access to sessions, make sure that the route is server-rendered using \`export const prerender = false;\` or by setting \`output\` to \`"server"\` in your Astro config to make all your routes server-rendered by default. For more information, see https://docs.astro.build/en/guides/sessions/`
          );
          return void 0;
        }
        if (!renderContext.session) {
          pipeline.logger.warn(
            "session",
            `context.session was used when rendering the route ${colors.green(this.routePattern)}, but no storage configuration was provided. Either configure the storage manually or use an adapter that provides session storage. For more information, see https://docs.astro.build/en/guides/sessions/`
          );
          return void 0;
        }
        return renderContext.session;
      },
      get csp() {
        return {
          insertDirective(payload) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.directives.push(payload);
          },
          insertScriptResource(resource) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.scriptResources.push(resource);
          },
          insertStyleResource(resource) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.styleResources.push(resource);
          },
          insertStyleHash(hash) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.styleHashes.push(hash);
          },
          insertScriptHash(hash) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.scriptHashes.push(hash);
          }
        };
      }
    };
  }
  async createResult(mod, ctx) {
    const { cookies, pathname, pipeline, routeData, status } = this;
    const { clientDirectives, inlinedScripts, compressHTML, manifest, renderers, resolve } = pipeline;
    const { links, scripts, styles } = await pipeline.headElements(routeData);
    const extraStyleHashes = [];
    const extraScriptHashes = [];
    const shouldInjectCspMetaTags = this.shouldInjectCspMetaTags;
    const cspAlgorithm = manifest.csp?.algorithm ?? "SHA-256";
    if (shouldInjectCspMetaTags) {
      for (const style of styles) {
        extraStyleHashes.push(await generateCspDigest(style.children, cspAlgorithm));
      }
      for (const script of scripts) {
        extraScriptHashes.push(await generateCspDigest(script.children, cspAlgorithm));
      }
    }
    const componentMetadata = await pipeline.componentMetadata(routeData) ?? manifest.componentMetadata;
    const headers = new Headers({ "Content-Type": "text/html" });
    const partial = typeof this.partial === "boolean" ? this.partial : Boolean(mod.partial);
    const actionResult = hasActionPayload(this.locals) ? deserializeActionResult(this.locals._actionPayload.actionResult) : void 0;
    const response = {
      status: actionResult?.error ? actionResult?.error.status : status,
      statusText: actionResult?.error ? actionResult?.error.type : "OK",
      get headers() {
        return headers;
      },
      // Disallow `Astro.response.headers = new Headers`
      set headers(_) {
        throw new AstroError(AstroResponseHeadersReassigned);
      }
    };
    const result = {
      base: manifest.base,
      userAssetsBase: manifest.userAssetsBase,
      cancelled: false,
      clientDirectives,
      inlinedScripts,
      componentMetadata,
      compressHTML,
      cookies,
      /** This function returns the `Astro` faux-global */
      createAstro: (astroGlobal, props, slots) => this.createAstro(result, astroGlobal, props, slots, ctx),
      links,
      params: this.params,
      partial,
      pathname,
      renderers,
      resolve,
      response,
      request: this.request,
      scripts,
      styles,
      actionResult,
      serverIslandNameMap: manifest.serverIslandNameMap ?? /* @__PURE__ */ new Map(),
      key: manifest.key,
      trailingSlash: manifest.trailingSlash,
      _metadata: {
        hasHydrationScript: false,
        rendererSpecificHydrationScripts: /* @__PURE__ */ new Set(),
        hasRenderedHead: false,
        renderedScripts: /* @__PURE__ */ new Set(),
        hasDirectives: /* @__PURE__ */ new Set(),
        hasRenderedServerIslandRuntime: false,
        headInTree: false,
        extraHead: [],
        extraStyleHashes,
        extraScriptHashes,
        propagators: /* @__PURE__ */ new Set()
      },
      cspDestination: manifest.csp?.cspDestination ?? (routeData.prerender ? "meta" : "header"),
      shouldInjectCspMetaTags,
      cspAlgorithm,
      // The following arrays must be cloned, otherwise they become mutable across routes.
      scriptHashes: manifest.csp?.scriptHashes ? [...manifest.csp.scriptHashes] : [],
      scriptResources: manifest.csp?.scriptResources ? [...manifest.csp.scriptResources] : [],
      styleHashes: manifest.csp?.styleHashes ? [...manifest.csp.styleHashes] : [],
      styleResources: manifest.csp?.styleResources ? [...manifest.csp.styleResources] : [],
      directives: manifest.csp?.directives ? [...manifest.csp.directives] : [],
      isStrictDynamic: manifest.csp?.isStrictDynamic ?? false,
      internalFetchHeaders: manifest.internalFetchHeaders
    };
    return result;
  }
  #astroPagePartial;
  /**
   * The Astro global is sourced in 3 different phases:
   * - **Static**: `.generator` and `.glob` is printed by the compiler, instantiated once per process per astro file
   * - **Page-level**: `.request`, `.cookies`, `.locals` etc. These remain the same for the duration of the request.
   * - **Component-level**: `.props`, `.slots`, and `.self` are unique to each _use_ of each component.
   *
   * The page level partial is used as the prototype of the user-visible `Astro` global object, which is instantiated once per use of a component.
   */
  createAstro(result, astroStaticPartial, props, slotValues, apiContext) {
    let astroPagePartial;
    if (this.isRewriting) {
      astroPagePartial = this.#astroPagePartial = this.createAstroPagePartial(
        result,
        astroStaticPartial,
        apiContext
      );
    } else {
      astroPagePartial = this.#astroPagePartial ??= this.createAstroPagePartial(
        result,
        astroStaticPartial,
        apiContext
      );
    }
    const astroComponentPartial = { props, self: null };
    const Astro = Object.assign(
      Object.create(astroPagePartial),
      astroComponentPartial
    );
    let _slots;
    Object.defineProperty(Astro, "slots", {
      get: () => {
        if (!_slots) {
          _slots = new Slots(
            result,
            slotValues,
            this.pipeline.logger
          );
        }
        return _slots;
      }
    });
    return Astro;
  }
  createAstroPagePartial(result, astroStaticPartial, apiContext) {
    const renderContext = this;
    const { cookies, locals, params, pipeline, url } = this;
    const { response } = result;
    const redirect = (path, status = 302) => {
      if (this.request[responseSentSymbol$1]) {
        throw new AstroError({
          ...ResponseSentError
        });
      }
      return new Response(null, { status, headers: { Location: path } });
    };
    const rewrite = async (reroutePayload) => {
      return await this.#executeRewrite(reroutePayload);
    };
    const callAction = createCallAction(apiContext);
    return {
      generator: astroStaticPartial.generator,
      glob: astroStaticPartial.glob,
      routePattern: this.routeData.route,
      isPrerendered: this.routeData.prerender,
      cookies,
      get session() {
        if (this.isPrerendered) {
          pipeline.logger.warn(
            "session",
            `Astro.session was used when rendering the route ${colors.green(this.routePattern)}, but it is not available on prerendered pages. If you need access to sessions, make sure that the page is server-rendered using \`export const prerender = false;\` or by setting \`output\` to \`"server"\` in your Astro config to make all your pages server-rendered by default. For more information, see https://docs.astro.build/en/guides/sessions/`
          );
          return void 0;
        }
        if (!renderContext.session) {
          pipeline.logger.warn(
            "session",
            `Astro.session was used when rendering the route ${colors.green(this.routePattern)}, but no storage configuration was provided. Either configure the storage manually or use an adapter that provides session storage. For more information, see https://docs.astro.build/en/guides/sessions/`
          );
          return void 0;
        }
        return renderContext.session;
      },
      get clientAddress() {
        return renderContext.getClientAddress();
      },
      get currentLocale() {
        return renderContext.computeCurrentLocale();
      },
      params,
      get preferredLocale() {
        return renderContext.computePreferredLocale();
      },
      get preferredLocaleList() {
        return renderContext.computePreferredLocaleList();
      },
      locals,
      redirect,
      rewrite,
      request: this.request,
      response,
      site: pipeline.site,
      getActionResult: createGetActionResult(locals),
      get callAction() {
        return callAction;
      },
      url,
      get originPathname() {
        return getOriginPathname(renderContext.request);
      },
      get csp() {
        return {
          insertDirective(payload) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.directives.push(payload);
          },
          insertScriptResource(resource) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.scriptResources.push(resource);
          },
          insertStyleResource(resource) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.styleResources.push(resource);
          },
          insertStyleHash(hash) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.styleHashes.push(hash);
          },
          insertScriptHash(hash) {
            if (!pipeline.manifest.csp) {
              throw new AstroError(CspNotEnabled);
            }
            renderContext.result?.scriptHashes.push(hash);
          }
        };
      }
    };
  }
  getClientAddress() {
    const { pipeline, request, routeData, clientAddress } = this;
    if (routeData.prerender) {
      throw new AstroError({
        ...PrerenderClientAddressNotAvailable,
        message: PrerenderClientAddressNotAvailable.message(routeData.component)
      });
    }
    if (clientAddress) {
      return clientAddress;
    }
    if (clientAddressSymbol in request) {
      return Reflect.get(request, clientAddressSymbol);
    }
    if (pipeline.adapterName) {
      throw new AstroError({
        ...ClientAddressNotAvailable,
        message: ClientAddressNotAvailable.message(pipeline.adapterName)
      });
    }
    throw new AstroError(StaticClientAddressNotAvailable);
  }
  /**
   * API Context may be created multiple times per request, i18n data needs to be computed only once.
   * So, it is computed and saved here on creation of the first APIContext and reused for later ones.
   */
  #currentLocale;
  computeCurrentLocale() {
    const {
      url,
      pipeline: { i18n },
      routeData
    } = this;
    if (!i18n) return;
    const { defaultLocale, locales, strategy } = i18n;
    const fallbackTo = strategy === "pathname-prefix-other-locales" || strategy === "domains-prefix-other-locales" ? defaultLocale : void 0;
    if (this.#currentLocale) {
      return this.#currentLocale;
    }
    let computedLocale;
    if (isRouteServerIsland(routeData)) {
      let referer = this.request.headers.get("referer");
      if (referer) {
        if (URL.canParse(referer)) {
          referer = new URL(referer).pathname;
        }
        computedLocale = computeCurrentLocale(referer, locales, defaultLocale);
      }
    } else {
      let pathname = routeData.pathname;
      if (!routeData.pattern.test(url.pathname)) {
        for (const fallbackRoute of routeData.fallbackRoutes) {
          if (fallbackRoute.pattern.test(url.pathname)) {
            pathname = fallbackRoute.pathname;
            break;
          }
        }
      }
      pathname = pathname && !isRoute404or500(routeData) ? pathname : url.pathname;
      computedLocale = computeCurrentLocale(pathname, locales, defaultLocale);
    }
    this.#currentLocale = computedLocale ?? fallbackTo;
    return this.#currentLocale;
  }
  #preferredLocale;
  computePreferredLocale() {
    const {
      pipeline: { i18n },
      request
    } = this;
    if (!i18n) return;
    return this.#preferredLocale ??= computePreferredLocale(request, i18n.locales);
  }
  #preferredLocaleList;
  computePreferredLocaleList() {
    const {
      pipeline: { i18n },
      request
    } = this;
    if (!i18n) return;
    return this.#preferredLocaleList ??= computePreferredLocaleList(request, i18n.locales);
  }
}

function redirectTemplate({
  status,
  absoluteLocation,
  relativeLocation,
  from
}) {
  const delay = status === 302 ? 2 : 0;
  return `<!doctype html>
<title>Redirecting to: ${relativeLocation}</title>
<meta http-equiv="refresh" content="${delay};url=${relativeLocation}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${absoluteLocation}">
<body>
	<a href="${relativeLocation}">Redirecting ${from ? `from <code>${from}</code> ` : ""}to <code>${relativeLocation}</code></a>
</body>`;
}

class AppPipeline extends Pipeline {
  static create({
    logger,
    manifest,
    runtimeMode,
    renderers,
    resolve,
    serverLike,
    streaming,
    defaultRoutes
  }) {
    const pipeline = new AppPipeline(
      logger,
      manifest,
      runtimeMode,
      renderers,
      resolve,
      serverLike,
      streaming,
      void 0,
      void 0,
      void 0,
      void 0,
      void 0,
      void 0,
      void 0,
      void 0,
      defaultRoutes
    );
    return pipeline;
  }
  headElements(routeData) {
    const routeInfo = this.manifest.routes.find((route) => route.routeData === routeData);
    const links = /* @__PURE__ */ new Set();
    const scripts = /* @__PURE__ */ new Set();
    const styles = createStylesheetElementSet(routeInfo?.styles ?? []);
    for (const script of routeInfo?.scripts ?? []) {
      if ("stage" in script) {
        if (script.stage === "head-inline") {
          scripts.add({
            props: {},
            children: script.children
          });
        }
      } else {
        scripts.add(createModuleScriptElement(script));
      }
    }
    return { links, styles, scripts };
  }
  componentMetadata() {
  }
  async getComponentByRoute(routeData) {
    const module = await this.getModuleForRoute(routeData);
    return module.page();
  }
  async tryRewrite(payload, request) {
    const { newUrl, pathname, routeData } = findRouteToRewrite({
      payload,
      request,
      routes: this.manifest?.routes.map((r) => r.routeData),
      trailingSlash: this.manifest.trailingSlash,
      buildFormat: this.manifest.buildFormat,
      base: this.manifest.base,
      outDir: this.serverLike ? this.manifest.buildClientDir : this.manifest.outDir
    });
    const componentInstance = await this.getComponentByRoute(routeData);
    return { newUrl, pathname, componentInstance, routeData };
  }
  async getModuleForRoute(route) {
    for (const defaultRoute of this.defaultRoutes) {
      if (route.component === defaultRoute.component) {
        return {
          page: () => Promise.resolve(defaultRoute.instance),
          renderers: []
        };
      }
    }
    if (route.type === "redirect") {
      return RedirectSinglePageBuiltModule;
    } else {
      if (this.manifest.pageMap) {
        const importComponentInstance = this.manifest.pageMap.get(route.component);
        if (!importComponentInstance) {
          throw new Error(
            `Unexpectedly unable to find a component instance for route ${route.route}`
          );
        }
        return await importComponentInstance();
      } else if (this.manifest.pageModule) {
        return this.manifest.pageModule;
      }
      throw new Error(
        "Astro couldn't find the correct page to render, probably because it wasn't correctly mapped for SSR usage. This is an internal error, please file an issue."
      );
    }
  }
}

class App {
  #manifest;
  #manifestData;
  #logger = new Logger({
    dest: consoleLogDestination,
    level: "info"
  });
  #baseWithoutTrailingSlash;
  #pipeline;
  #adapterLogger;
  constructor(manifest, streaming = true) {
    this.#manifest = manifest;
    this.#manifestData = {
      routes: manifest.routes.map((route) => route.routeData)
    };
    ensure404Route(this.#manifestData);
    this.#baseWithoutTrailingSlash = removeTrailingForwardSlash(this.#manifest.base);
    this.#pipeline = this.#createPipeline(streaming);
    this.#adapterLogger = new AstroIntegrationLogger(
      this.#logger.options,
      this.#manifest.adapterName
    );
  }
  getAdapterLogger() {
    return this.#adapterLogger;
  }
  getAllowedDomains() {
    return this.#manifest.allowedDomains;
  }
  get manifest() {
    return this.#manifest;
  }
  set manifest(value) {
    this.#manifest = value;
  }
  matchesAllowedDomains(forwardedHost, protocol) {
    return App.validateForwardedHost(forwardedHost, this.#manifest.allowedDomains, protocol);
  }
  static validateForwardedHost(forwardedHost, allowedDomains, protocol) {
    if (!allowedDomains || allowedDomains.length === 0) {
      return false;
    }
    try {
      const testUrl = new URL(`${protocol || "https"}://${forwardedHost}`);
      return allowedDomains.some((pattern) => {
        return matchPattern(testUrl, pattern);
      });
    } catch {
      return false;
    }
  }
  /**
   * Validate a hostname by rejecting any with path separators.
   * Prevents path injection attacks. Invalid hostnames return undefined.
   */
  static sanitizeHost(hostname) {
    if (!hostname) return void 0;
    if (/[/\\]/.test(hostname)) return void 0;
    return hostname;
  }
  /**
   * Validate forwarded headers (proto, host, port) against allowedDomains.
   * Returns validated values or undefined for rejected headers.
   * Uses strict defaults: http/https only for proto, rejects port if not in allowedDomains.
   */
  static validateForwardedHeaders(forwardedProtocol, forwardedHost, forwardedPort, allowedDomains) {
    const result = {};
    if (forwardedProtocol) {
      if (allowedDomains && allowedDomains.length > 0) {
        const hasProtocolPatterns = allowedDomains.some(
          (pattern) => pattern.protocol !== void 0
        );
        if (hasProtocolPatterns) {
          try {
            const testUrl = new URL(`${forwardedProtocol}://example.com`);
            const isAllowed = allowedDomains.some((pattern) => matchPattern(testUrl, pattern));
            if (isAllowed) {
              result.protocol = forwardedProtocol;
            }
          } catch {
          }
        } else if (/^https?$/.test(forwardedProtocol)) {
          result.protocol = forwardedProtocol;
        }
      } else if (/^https?$/.test(forwardedProtocol)) {
        result.protocol = forwardedProtocol;
      }
    }
    if (forwardedPort && allowedDomains && allowedDomains.length > 0) {
      const hasPortPatterns = allowedDomains.some((pattern) => pattern.port !== void 0);
      if (hasPortPatterns) {
        const isAllowed = allowedDomains.some((pattern) => pattern.port === forwardedPort);
        if (isAllowed) {
          result.port = forwardedPort;
        }
      }
    }
    if (forwardedHost && forwardedHost.length > 0 && allowedDomains && allowedDomains.length > 0) {
      const protoForValidation = result.protocol || "https";
      const sanitized = App.sanitizeHost(forwardedHost);
      if (sanitized) {
        try {
          const hostnameOnly = sanitized.split(":")[0];
          const portFromHost = sanitized.includes(":") ? sanitized.split(":")[1] : void 0;
          const portForValidation = result.port || portFromHost;
          const hostWithPort = portForValidation ? `${hostnameOnly}:${portForValidation}` : hostnameOnly;
          const testUrl = new URL(`${protoForValidation}://${hostWithPort}`);
          const isAllowed = allowedDomains.some((pattern) => matchPattern(testUrl, pattern));
          if (isAllowed) {
            result.host = sanitized;
          }
        } catch {
        }
      }
    }
    return result;
  }
  /**
   * Creates a pipeline by reading the stored manifest
   *
   * @param streaming
   * @private
   */
  #createPipeline(streaming = false) {
    return AppPipeline.create({
      logger: this.#logger,
      manifest: this.#manifest,
      runtimeMode: "production",
      renderers: this.#manifest.renderers,
      defaultRoutes: createDefaultRoutes(this.#manifest),
      resolve: async (specifier) => {
        if (!(specifier in this.#manifest.entryModules)) {
          throw new Error(`Unable to resolve [${specifier}]`);
        }
        const bundlePath = this.#manifest.entryModules[specifier];
        if (bundlePath.startsWith("data:") || bundlePath.length === 0) {
          return bundlePath;
        } else {
          return createAssetLink(bundlePath, this.#manifest.base, this.#manifest.assetsPrefix);
        }
      },
      serverLike: true,
      streaming
    });
  }
  set setManifestData(newManifestData) {
    this.#manifestData = newManifestData;
  }
  removeBase(pathname) {
    if (pathname.startsWith(this.#manifest.base)) {
      return pathname.slice(this.#baseWithoutTrailingSlash.length + 1);
    }
    return pathname;
  }
  /**
   * It removes the base from the request URL, prepends it with a forward slash and attempts to decoded it.
   *
   * If the decoding fails, it logs the error and return the pathname as is.
   * @param request
   * @private
   */
  #getPathnameFromRequest(request) {
    const url = new URL(request.url);
    const pathname = prependForwardSlash$1(this.removeBase(url.pathname));
    try {
      return decodeURI(pathname);
    } catch (e) {
      this.getAdapterLogger().error(e.toString());
      return pathname;
    }
  }
  /**
   * Given a `Request`, it returns the `RouteData` that matches its `pathname`. By default, prerendered
   * routes aren't returned, even if they are matched.
   *
   * When `allowPrerenderedRoutes` is `true`, the function returns matched prerendered routes too.
   * @param request
   * @param allowPrerenderedRoutes
   */
  match(request, allowPrerenderedRoutes = false) {
    const url = new URL(request.url);
    if (this.#manifest.assets.has(url.pathname)) return void 0;
    let pathname = this.#computePathnameFromDomain(request);
    if (!pathname) {
      pathname = prependForwardSlash$1(this.removeBase(url.pathname));
    }
    let routeData = matchRoute(decodeURI(pathname), this.#manifestData);
    if (!routeData) return void 0;
    if (allowPrerenderedRoutes) {
      return routeData;
    } else if (routeData.prerender) {
      return void 0;
    }
    return routeData;
  }
  #computePathnameFromDomain(request) {
    let pathname = void 0;
    const url = new URL(request.url);
    if (this.#manifest.i18n && (this.#manifest.i18n.strategy === "domains-prefix-always" || this.#manifest.i18n.strategy === "domains-prefix-other-locales" || this.#manifest.i18n.strategy === "domains-prefix-always-no-redirect")) {
      const validated = App.validateForwardedHeaders(
        request.headers.get("X-Forwarded-Proto") ?? void 0,
        request.headers.get("X-Forwarded-Host") ?? void 0,
        request.headers.get("X-Forwarded-Port") ?? void 0,
        this.#manifest.allowedDomains
      );
      let protocol = validated.protocol ? validated.protocol + ":" : url.protocol;
      let host = validated.host ?? request.headers.get("Host");
      if (host && protocol) {
        host = host.split(":")[0];
        try {
          let locale;
          const hostAsUrl = new URL(`${protocol}//${host}`);
          for (const [domainKey, localeValue] of Object.entries(
            this.#manifest.i18n.domainLookupTable
          )) {
            const domainKeyAsUrl = new URL(domainKey);
            if (hostAsUrl.host === domainKeyAsUrl.host && hostAsUrl.protocol === domainKeyAsUrl.protocol) {
              locale = localeValue;
              break;
            }
          }
          if (locale) {
            pathname = prependForwardSlash$1(
              joinPaths(normalizeTheLocale(locale), this.removeBase(url.pathname))
            );
            if (url.pathname.endsWith("/")) {
              pathname = appendForwardSlash$1(pathname);
            }
          }
        } catch (e) {
          this.#logger.error(
            "router",
            `Astro tried to parse ${protocol}//${host} as an URL, but it threw a parsing error. Check the X-Forwarded-Host and X-Forwarded-Proto headers.`
          );
          this.#logger.error("router", `Error: ${e}`);
        }
      }
    }
    return pathname;
  }
  #redirectTrailingSlash(pathname) {
    const { trailingSlash } = this.#manifest;
    if (pathname === "/" || isInternalPath(pathname)) {
      return pathname;
    }
    const path = collapseDuplicateTrailingSlashes(pathname, trailingSlash !== "never");
    if (path !== pathname) {
      return path;
    }
    if (trailingSlash === "ignore") {
      return pathname;
    }
    if (trailingSlash === "always" && !hasFileExtension(pathname)) {
      return appendForwardSlash$1(pathname);
    }
    if (trailingSlash === "never") {
      return removeTrailingForwardSlash(pathname);
    }
    return pathname;
  }
  async render(request, renderOptions) {
    let routeData;
    let locals;
    let clientAddress;
    let addCookieHeader;
    const url = new URL(request.url);
    const redirect = this.#redirectTrailingSlash(url.pathname);
    const prerenderedErrorPageFetch = renderOptions?.prerenderedErrorPageFetch ?? fetch;
    if (redirect !== url.pathname) {
      const status = request.method === "GET" ? 301 : 308;
      return new Response(
        redirectTemplate({
          status,
          relativeLocation: url.pathname,
          absoluteLocation: redirect,
          from: request.url
        }),
        {
          status,
          headers: {
            location: redirect + url.search
          }
        }
      );
    }
    addCookieHeader = renderOptions?.addCookieHeader;
    clientAddress = renderOptions?.clientAddress ?? Reflect.get(request, clientAddressSymbol);
    routeData = renderOptions?.routeData;
    locals = renderOptions?.locals;
    if (routeData) {
      this.#logger.debug(
        "router",
        "The adapter " + this.#manifest.adapterName + " provided a custom RouteData for ",
        request.url
      );
      this.#logger.debug("router", "RouteData:\n" + routeData);
    }
    if (locals) {
      if (typeof locals !== "object") {
        const error = new AstroError(LocalsNotAnObject);
        this.#logger.error(null, error.stack);
        return this.#renderError(request, {
          status: 500,
          error,
          clientAddress,
          prerenderedErrorPageFetch
        });
      }
    }
    if (!routeData) {
      routeData = this.match(request);
      this.#logger.debug("router", "Astro matched the following route for " + request.url);
      this.#logger.debug("router", "RouteData:\n" + routeData);
    }
    if (!routeData) {
      routeData = this.#manifestData.routes.find(
        (route) => route.component === "404.astro" || route.component === DEFAULT_404_COMPONENT
      );
    }
    if (!routeData) {
      this.#logger.debug("router", "Astro hasn't found routes that match " + request.url);
      this.#logger.debug("router", "Here's the available routes:\n", this.#manifestData);
      return this.#renderError(request, {
        locals,
        status: 404,
        clientAddress,
        prerenderedErrorPageFetch
      });
    }
    const pathname = this.#getPathnameFromRequest(request);
    const defaultStatus = this.#getDefaultStatusCode(routeData, pathname);
    let response;
    let session;
    try {
      const mod = await this.#pipeline.getModuleForRoute(routeData);
      const renderContext = await RenderContext.create({
        pipeline: this.#pipeline,
        locals,
        pathname,
        request,
        routeData,
        status: defaultStatus,
        clientAddress
      });
      session = renderContext.session;
      response = await renderContext.render(await mod.page());
    } catch (err) {
      this.#logger.error(null, err.stack || err.message || String(err));
      return this.#renderError(request, {
        locals,
        status: 500,
        error: err,
        clientAddress,
        prerenderedErrorPageFetch
      });
    } finally {
      await session?.[PERSIST_SYMBOL]();
    }
    if (REROUTABLE_STATUS_CODES.includes(response.status) && response.headers.get(REROUTE_DIRECTIVE_HEADER) !== "no") {
      return this.#renderError(request, {
        locals,
        response,
        status: response.status,
        // We don't have an error to report here. Passing null means we pass nothing intentionally
        // while undefined means there's no error
        error: response.status === 500 ? null : void 0,
        clientAddress,
        prerenderedErrorPageFetch
      });
    }
    if (response.headers.has(REROUTE_DIRECTIVE_HEADER)) {
      response.headers.delete(REROUTE_DIRECTIVE_HEADER);
    }
    if (addCookieHeader) {
      for (const setCookieHeaderValue of App.getSetCookieFromResponse(response)) {
        response.headers.append("set-cookie", setCookieHeaderValue);
      }
    }
    Reflect.set(response, responseSentSymbol$1, true);
    return response;
  }
  setCookieHeaders(response) {
    return getSetCookiesFromResponse(response);
  }
  /**
   * Reads all the cookies written by `Astro.cookie.set()` onto the passed response.
   * For example,
   * ```ts
   * for (const cookie_ of App.getSetCookieFromResponse(response)) {
   *     const cookie: string = cookie_
   * }
   * ```
   * @param response The response to read cookies from.
   * @returns An iterator that yields key-value pairs as equal-sign-separated strings.
   */
  static getSetCookieFromResponse = getSetCookiesFromResponse;
  /**
   * If it is a known error code, try sending the according page (e.g. 404.astro / 500.astro).
   * This also handles pre-rendered /404 or /500 routes
   */
  async #renderError(request, {
    locals,
    status,
    response: originalResponse,
    skipMiddleware = false,
    error,
    clientAddress,
    prerenderedErrorPageFetch
  }) {
    const errorRoutePath = `/${status}${this.#manifest.trailingSlash === "always" ? "/" : ""}`;
    const errorRouteData = matchRoute(errorRoutePath, this.#manifestData);
    const url = new URL(request.url);
    if (errorRouteData) {
      if (errorRouteData.prerender) {
        const maybeDotHtml = errorRouteData.route.endsWith(`/${status}`) ? ".html" : "";
        const statusURL = new URL(
          `${this.#baseWithoutTrailingSlash}/${status}${maybeDotHtml}`,
          url
        );
        if (statusURL.toString() !== request.url) {
          const response2 = await prerenderedErrorPageFetch(statusURL.toString());
          const override = { status, removeContentEncodingHeaders: true };
          return this.#mergeResponses(response2, originalResponse, override);
        }
      }
      const mod = await this.#pipeline.getModuleForRoute(errorRouteData);
      let session;
      try {
        const renderContext = await RenderContext.create({
          locals,
          pipeline: this.#pipeline,
          middleware: skipMiddleware ? NOOP_MIDDLEWARE_FN : void 0,
          pathname: this.#getPathnameFromRequest(request),
          request,
          routeData: errorRouteData,
          status,
          props: { error },
          clientAddress
        });
        session = renderContext.session;
        const response2 = await renderContext.render(await mod.page());
        return this.#mergeResponses(response2, originalResponse);
      } catch {
        if (skipMiddleware === false) {
          return this.#renderError(request, {
            locals,
            status,
            response: originalResponse,
            skipMiddleware: true,
            clientAddress,
            prerenderedErrorPageFetch
          });
        }
      } finally {
        await session?.[PERSIST_SYMBOL]();
      }
    }
    const response = this.#mergeResponses(new Response(null, { status }), originalResponse);
    Reflect.set(response, responseSentSymbol$1, true);
    return response;
  }
  #mergeResponses(newResponse, originalResponse, override) {
    let newResponseHeaders = newResponse.headers;
    if (override?.removeContentEncodingHeaders) {
      newResponseHeaders = new Headers(newResponseHeaders);
      newResponseHeaders.delete("Content-Encoding");
      newResponseHeaders.delete("Content-Length");
    }
    if (!originalResponse) {
      if (override !== void 0) {
        return new Response(newResponse.body, {
          status: override.status,
          statusText: newResponse.statusText,
          headers: newResponseHeaders
        });
      }
      return newResponse;
    }
    const status = override?.status ? override.status : originalResponse.status === 200 ? newResponse.status : originalResponse.status;
    try {
      originalResponse.headers.delete("Content-type");
    } catch {
    }
    const mergedHeaders = new Map([
      ...Array.from(newResponseHeaders),
      ...Array.from(originalResponse.headers)
    ]);
    const newHeaders = new Headers();
    for (const [name, value] of mergedHeaders) {
      newHeaders.set(name, value);
    }
    return new Response(newResponse.body, {
      status,
      statusText: status === 200 ? newResponse.statusText : originalResponse.statusText,
      // If you're looking at here for possible bugs, it means that it's not a bug.
      // With the middleware, users can meddle with headers, and we should pass to the 404/500.
      // If users see something weird, it's because they are setting some headers they should not.
      //
      // Although, we don't want it to replace the content-type, because the error page must return `text/html`
      headers: newHeaders
    });
  }
  #getDefaultStatusCode(routeData, pathname) {
    if (!routeData.pattern.test(pathname)) {
      for (const fallbackRoute of routeData.fallbackRoutes) {
        if (fallbackRoute.pattern.test(pathname)) {
          return 302;
        }
      }
    }
    const route = removeTrailingForwardSlash(routeData.route);
    if (route.endsWith("/404")) return 404;
    if (route.endsWith("/500")) return 500;
    return 200;
  }
}

const createOutgoingHttpHeaders = (headers) => {
  if (!headers) {
    return void 0;
  }
  const nodeHeaders = Object.fromEntries(headers.entries());
  if (Object.keys(nodeHeaders).length === 0) {
    return void 0;
  }
  if (headers.has("set-cookie")) {
    const cookieHeaders = headers.getSetCookie();
    if (cookieHeaders.length > 1) {
      nodeHeaders["set-cookie"] = cookieHeaders;
    }
  }
  return nodeHeaders;
};

function apply() {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, "crypto", {
      value: crypto$1.webcrypto
    });
  }
  if (!globalThis.File) {
    Object.defineProperty(globalThis, "File", {
      value: require$$0$3.File
    });
  }
}

class NodeApp extends App {
  headersMap = void 0;
  setHeadersMap(headers) {
    this.headersMap = headers;
  }
  match(req, allowPrerenderedRoutes = false) {
    if (!(req instanceof Request)) {
      req = NodeApp.createRequest(req, {
        skipBody: true,
        allowedDomains: this.manifest.allowedDomains
      });
    }
    return super.match(req, allowPrerenderedRoutes);
  }
  render(req, routeDataOrOptions, maybeLocals) {
    if (!(req instanceof Request)) {
      req = NodeApp.createRequest(req, {
        allowedDomains: this.manifest.allowedDomains
      });
    }
    return super.render(req, routeDataOrOptions, maybeLocals);
  }
  /**
   * Converts a NodeJS IncomingMessage into a web standard Request.
   * ```js
   * import { NodeApp } from 'astro/app/node';
   * import { createServer } from 'node:http';
   *
   * const server = createServer(async (req, res) => {
   *     const request = NodeApp.createRequest(req);
   *     const response = await app.render(request);
   *     await NodeApp.writeResponse(response, res);
   * })
   * ```
   */
  static createRequest(req, {
    skipBody = false,
    allowedDomains = []
  } = {}) {
    const controller = new AbortController();
    const isEncrypted = "encrypted" in req.socket && req.socket.encrypted;
    const getFirstForwardedValue = (multiValueHeader) => {
      return multiValueHeader?.toString()?.split(",").map((e) => e.trim())?.[0];
    };
    const providedProtocol = isEncrypted ? "https" : "http";
    const providedHostname = req.headers.host ?? req.headers[":authority"];
    const validated = App.validateForwardedHeaders(
      getFirstForwardedValue(req.headers["x-forwarded-proto"]),
      getFirstForwardedValue(req.headers["x-forwarded-host"]),
      getFirstForwardedValue(req.headers["x-forwarded-port"]),
      allowedDomains
    );
    const protocol = validated.protocol ?? providedProtocol;
    const sanitizedProvidedHostname = App.sanitizeHost(
      typeof providedHostname === "string" ? providedHostname : void 0
    );
    const hostname = validated.host ?? sanitizedProvidedHostname;
    const port = validated.port;
    let url;
    try {
      const hostnamePort = getHostnamePort(hostname, port);
      url = new URL(`${protocol}://${hostnamePort}${req.url}`);
    } catch {
      const hostnamePort = getHostnamePort(providedHostname, port);
      url = new URL(`${providedProtocol}://${hostnamePort}`);
    }
    const options = {
      method: req.method || "GET",
      headers: makeRequestHeaders(req),
      signal: controller.signal
    };
    const bodyAllowed = options.method !== "HEAD" && options.method !== "GET" && skipBody === false;
    if (bodyAllowed) {
      Object.assign(options, makeRequestBody(req));
    }
    const request = new Request(url, options);
    const socket = getRequestSocket(req);
    if (socket && typeof socket.on === "function") {
      const existingCleanup = getAbortControllerCleanup(req);
      if (existingCleanup) {
        existingCleanup();
      }
      let cleanedUp = false;
      const removeSocketListener = () => {
        if (typeof socket.off === "function") {
          socket.off("close", onSocketClose);
        } else if (typeof socket.removeListener === "function") {
          socket.removeListener("close", onSocketClose);
        }
      };
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        removeSocketListener();
        controller.signal.removeEventListener("abort", cleanup);
        Reflect.deleteProperty(req, nodeRequestAbortControllerCleanupSymbol);
      };
      const onSocketClose = () => {
        cleanup();
        if (!controller.signal.aborted) {
          controller.abort();
        }
      };
      socket.on("close", onSocketClose);
      controller.signal.addEventListener("abort", cleanup, { once: true });
      Reflect.set(req, nodeRequestAbortControllerCleanupSymbol, cleanup);
      if (socket.destroyed) {
        onSocketClose();
      }
    }
    const forwardedClientIp = getFirstForwardedValue(req.headers["x-forwarded-for"]);
    const clientIp = forwardedClientIp || req.socket?.remoteAddress;
    if (clientIp) {
      Reflect.set(request, clientAddressSymbol, clientIp);
    }
    return request;
  }
  /**
   * Streams a web-standard Response into a NodeJS Server Response.
   * ```js
   * import { NodeApp } from 'astro/app/node';
   * import { createServer } from 'node:http';
   *
   * const server = createServer(async (req, res) => {
   *     const request = NodeApp.createRequest(req);
   *     const response = await app.render(request);
   *     await NodeApp.writeResponse(response, res);
   * })
   * ```
   * @param source WhatWG Response
   * @param destination NodeJS ServerResponse
   */
  static async writeResponse(source, destination) {
    const { status, headers, body, statusText } = source;
    if (!(destination instanceof Http2ServerResponse)) {
      destination.statusMessage = statusText;
    }
    destination.writeHead(status, createOutgoingHttpHeaders(headers));
    const cleanupAbortFromDestination = getAbortControllerCleanup(
      destination.req ?? void 0
    );
    if (cleanupAbortFromDestination) {
      const runCleanup = () => {
        cleanupAbortFromDestination();
        if (typeof destination.off === "function") {
          destination.off("finish", runCleanup);
          destination.off("close", runCleanup);
        } else {
          destination.removeListener?.("finish", runCleanup);
          destination.removeListener?.("close", runCleanup);
        }
      };
      destination.on("finish", runCleanup);
      destination.on("close", runCleanup);
    }
    if (!body) return destination.end();
    try {
      const reader = body.getReader();
      destination.on("close", () => {
        reader.cancel().catch((err) => {
          console.error(
            `There was an uncaught error in the middle of the stream while rendering ${destination.req.url}.`,
            err
          );
        });
      });
      let result = await reader.read();
      while (!result.done) {
        destination.write(result.value);
        result = await reader.read();
      }
      destination.end();
    } catch (err) {
      destination.write("Internal server error", () => {
        err instanceof Error ? destination.destroy(err) : destination.destroy();
      });
    }
  }
}
function getHostnamePort(hostname, port) {
  const portInHostname = typeof hostname === "string" && /:\d+$/.test(hostname);
  const hostnamePort = portInHostname ? hostname : `${hostname}${port ? `:${port}` : ""}`;
  return hostnamePort;
}
function makeRequestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === void 0) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}
function makeRequestBody(req) {
  if (req.body !== void 0) {
    if (typeof req.body === "string" && req.body.length > 0) {
      return { body: Buffer.from(req.body) };
    }
    if (typeof req.body === "object" && req.body !== null && Object.keys(req.body).length > 0) {
      return { body: Buffer.from(JSON.stringify(req.body)) };
    }
    if (typeof req.body === "object" && req.body !== null && typeof req.body[Symbol.asyncIterator] !== "undefined") {
      return asyncIterableToBodyProps(req.body);
    }
  }
  return asyncIterableToBodyProps(req);
}
function asyncIterableToBodyProps(iterable) {
  return {
    // Node uses undici for the Request implementation. Undici accepts
    // a non-standard async iterable for the body.
    // @ts-expect-error
    body: iterable,
    // The duplex property is required when using a ReadableStream or async
    // iterable for the body. The type definitions do not include the duplex
    // property because they are not up-to-date.
    duplex: "half"
  };
}
function getAbortControllerCleanup(req) {
  if (!req) return void 0;
  const cleanup = Reflect.get(req, nodeRequestAbortControllerCleanupSymbol);
  return typeof cleanup === "function" ? cleanup : void 0;
}
function getRequestSocket(req) {
  if (req.socket && typeof req.socket.on === "function") {
    return req.socket;
  }
  const http2Socket = req.stream?.session?.socket;
  if (http2Socket && typeof http2Socket.on === "function") {
    return http2Socket;
  }
  return void 0;
}

apply();

function createAppHandler(app, options) {
  const als = new AsyncLocalStorage();
  const logger = app.getAdapterLogger();
  process.on("unhandledRejection", (reason) => {
    const requestUrl = als.getStore();
    logger.error(`Unhandled rejection while rendering ${requestUrl}`);
    console.error(reason);
  });
  const originUrl = options.experimentalErrorPageHost ? new URL(options.experimentalErrorPageHost) : void 0;
  const prerenderedErrorPageFetch = originUrl ? (url) => {
    const errorPageUrl = new URL(url);
    errorPageUrl.protocol = originUrl.protocol;
    errorPageUrl.host = originUrl.host;
    return fetch(errorPageUrl);
  } : void 0;
  return async (req, res, next, locals) => {
    let request;
    try {
      request = NodeApp.createRequest(req, {
        allowedDomains: app.getAllowedDomains?.() ?? []
      });
    } catch (err) {
      logger.error(`Could not render ${req.url}`);
      console.error(err);
      res.statusCode = 500;
      res.end("Internal Server Error");
      return;
    }
    const routeData = app.match(request, true);
    if (routeData) {
      const response = await als.run(
        request.url,
        () => app.render(request, {
          addCookieHeader: true,
          locals,
          routeData,
          prerenderedErrorPageFetch
        })
      );
      await NodeApp.writeResponse(response, res);
    } else if (next) {
      return next();
    } else {
      const response = await app.render(req, { addCookieHeader: true, prerenderedErrorPageFetch });
      await NodeApp.writeResponse(response, res);
    }
  };
}

function createMiddleware(app, options) {
  const handler = createAppHandler(app, options);
  const logger = app.getAdapterLogger();
  return async (...args) => {
    const [req, res, next, locals] = args;
    if (req instanceof Error) {
      const error = req;
      if (next) {
        return next(error);
      } else {
        throw error;
      }
    }
    try {
      await handler(req, res, next, locals);
    } catch (err) {
      logger.error(`Could not render ${req.url}`);
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500, `Server error`);
        res.end();
      }
    }
  };
}

const STATIC_HEADERS_FILE = "_experimentalHeaders.json";

var serverDestroy;
var hasRequiredServerDestroy;

function requireServerDestroy () {
	if (hasRequiredServerDestroy) return serverDestroy;
	hasRequiredServerDestroy = 1;
	serverDestroy = enableDestroy;

	function enableDestroy(server) {
	  var connections = {};

	  server.on('connection', function(conn) {
	    var key = conn.remoteAddress + ':' + conn.remotePort;
	    connections[key] = conn;
	    conn.on('close', function() {
	      delete connections[key];
	    });
	  });

	  server.destroy = function(cb) {
	    server.close(cb);
	    for (var key in connections)
	      connections[key].destroy();
	  };
	}
	return serverDestroy;
}

var serverDestroyExports = requireServerDestroy();
const enableDestroy = /*@__PURE__*/getDefaultExportFromCjs(serverDestroyExports);

const wildcardHosts = /* @__PURE__ */ new Set(["0.0.0.0", "::", "0000:0000:0000:0000:0000:0000:0000:0000"]);
async function logListeningOn(logger, server, configuredHost) {
  await new Promise((resolve) => server.once("listening", resolve));
  const protocol = server instanceof https.Server ? "https" : "http";
  const host = getResolvedHostForHttpServer(configuredHost);
  const { port } = server.address();
  const address = getNetworkAddress(protocol, host, port);
  if (host === void 0 || wildcardHosts.has(host)) {
    logger.info(
      `Server listening on 
  local: ${address.local[0]} 	
  network: ${address.network[0]}
`
    );
  } else {
    logger.info(`Server listening on ${address.local[0]}`);
  }
}
function getResolvedHostForHttpServer(host) {
  if (host === false) {
    return "localhost";
  } else if (host === true) {
    return void 0;
  } else {
    return host;
  }
}
function getNetworkAddress(protocol = "http", hostname, port, base) {
  const NetworkAddress = {
    local: [],
    network: []
  };
  Object.values(os.networkInterfaces()).flatMap((nInterface) => nInterface ?? []).filter(
    (detail) => detail && detail.address && (detail.family === "IPv4" || // @ts-expect-error Node 18.0 - 18.3 returns number
    detail.family === 4)
  ).forEach((detail) => {
    let host = detail.address.replace(
      "127.0.0.1",
      hostname === void 0 || wildcardHosts.has(hostname) ? "localhost" : hostname
    );
    if (host.includes(":")) {
      host = `[${host}]`;
    }
    const url = `${protocol}://${host}:${port}${""}`;
    if (detail.address.includes("127.0.0.1")) {
      NetworkAddress.local.push(url);
    } else {
      NetworkAddress.network.push(url);
    }
  });
  return NetworkAddress;
}

var httpErrors = {exports: {}};

/*!
 * depd
 * Copyright(c) 2014-2018 Douglas Christopher Wilson
 * MIT Licensed
 */

var depd_1;
var hasRequiredDepd;

function requireDepd () {
	if (hasRequiredDepd) return depd_1;
	hasRequiredDepd = 1;
	/**
	 * Module dependencies.
	 */

	var relative = require$$0$4.relative;

	/**
	 * Module exports.
	 */

	depd_1 = depd;

	/**
	 * Get the path to base files on.
	 */

	var basePath = process.cwd();

	/**
	 * Determine if namespace is contained in the string.
	 */

	function containsNamespace (str, namespace) {
	  var vals = str.split(/[ ,]+/);
	  var ns = String(namespace).toLowerCase();

	  for (var i = 0; i < vals.length; i++) {
	    var val = vals[i];

	    // namespace contained
	    if (val && (val === '*' || val.toLowerCase() === ns)) {
	      return true
	    }
	  }

	  return false
	}

	/**
	 * Convert a data descriptor to accessor descriptor.
	 */

	function convertDataDescriptorToAccessor (obj, prop, message) {
	  var descriptor = Object.getOwnPropertyDescriptor(obj, prop);
	  var value = descriptor.value;

	  descriptor.get = function getter () { return value };

	  if (descriptor.writable) {
	    descriptor.set = function setter (val) { return (value = val) };
	  }

	  delete descriptor.value;
	  delete descriptor.writable;

	  Object.defineProperty(obj, prop, descriptor);

	  return descriptor
	}

	/**
	 * Create arguments string to keep arity.
	 */

	function createArgumentsString (arity) {
	  var str = '';

	  for (var i = 0; i < arity; i++) {
	    str += ', arg' + i;
	  }

	  return str.substr(2)
	}

	/**
	 * Create stack string from stack.
	 */

	function createStackString (stack) {
	  var str = this.name + ': ' + this.namespace;

	  if (this.message) {
	    str += ' deprecated ' + this.message;
	  }

	  for (var i = 0; i < stack.length; i++) {
	    str += '\n    at ' + stack[i].toString();
	  }

	  return str
	}

	/**
	 * Create deprecate for namespace in caller.
	 */

	function depd (namespace) {
	  if (!namespace) {
	    throw new TypeError('argument namespace is required')
	  }

	  var stack = getStack();
	  var site = callSiteLocation(stack[1]);
	  var file = site[0];

	  function deprecate (message) {
	    // call to self as log
	    log.call(deprecate, message);
	  }

	  deprecate._file = file;
	  deprecate._ignored = isignored(namespace);
	  deprecate._namespace = namespace;
	  deprecate._traced = istraced(namespace);
	  deprecate._warned = Object.create(null);

	  deprecate.function = wrapfunction;
	  deprecate.property = wrapproperty;

	  return deprecate
	}

	/**
	 * Determine if event emitter has listeners of a given type.
	 *
	 * The way to do this check is done three different ways in Node.js >= 0.8
	 * so this consolidates them into a minimal set using instance methods.
	 *
	 * @param {EventEmitter} emitter
	 * @param {string} type
	 * @returns {boolean}
	 * @private
	 */

	function eehaslisteners (emitter, type) {
	  var count = typeof emitter.listenerCount !== 'function'
	    ? emitter.listeners(type).length
	    : emitter.listenerCount(type);

	  return count > 0
	}

	/**
	 * Determine if namespace is ignored.
	 */

	function isignored (namespace) {
	  if (process.noDeprecation) {
	    // --no-deprecation support
	    return true
	  }

	  var str = process.env.NO_DEPRECATION || '';

	  // namespace ignored
	  return containsNamespace(str, namespace)
	}

	/**
	 * Determine if namespace is traced.
	 */

	function istraced (namespace) {
	  if (process.traceDeprecation) {
	    // --trace-deprecation support
	    return true
	  }

	  var str = process.env.TRACE_DEPRECATION || '';

	  // namespace traced
	  return containsNamespace(str, namespace)
	}

	/**
	 * Display deprecation message.
	 */

	function log (message, site) {
	  var haslisteners = eehaslisteners(process, 'deprecation');

	  // abort early if no destination
	  if (!haslisteners && this._ignored) {
	    return
	  }

	  var caller;
	  var callFile;
	  var callSite;
	  var depSite;
	  var i = 0;
	  var seen = false;
	  var stack = getStack();
	  var file = this._file;

	  if (site) {
	    // provided site
	    depSite = site;
	    callSite = callSiteLocation(stack[1]);
	    callSite.name = depSite.name;
	    file = callSite[0];
	  } else {
	    // get call site
	    i = 2;
	    depSite = callSiteLocation(stack[i]);
	    callSite = depSite;
	  }

	  // get caller of deprecated thing in relation to file
	  for (; i < stack.length; i++) {
	    caller = callSiteLocation(stack[i]);
	    callFile = caller[0];

	    if (callFile === file) {
	      seen = true;
	    } else if (callFile === this._file) {
	      file = this._file;
	    } else if (seen) {
	      break
	    }
	  }

	  var key = caller
	    ? depSite.join(':') + '__' + caller.join(':')
	    : undefined;

	  if (key !== undefined && key in this._warned) {
	    // already warned
	    return
	  }

	  this._warned[key] = true;

	  // generate automatic message from call site
	  var msg = message;
	  if (!msg) {
	    msg = callSite === depSite || !callSite.name
	      ? defaultMessage(depSite)
	      : defaultMessage(callSite);
	  }

	  // emit deprecation if listeners exist
	  if (haslisteners) {
	    var err = DeprecationError(this._namespace, msg, stack.slice(i));
	    process.emit('deprecation', err);
	    return
	  }

	  // format and write message
	  var format = process.stderr.isTTY
	    ? formatColor
	    : formatPlain;
	  var output = format.call(this, msg, caller, stack.slice(i));
	  process.stderr.write(output + '\n', 'utf8');
	}

	/**
	 * Get call site location as array.
	 */

	function callSiteLocation (callSite) {
	  var file = callSite.getFileName() || '<anonymous>';
	  var line = callSite.getLineNumber();
	  var colm = callSite.getColumnNumber();

	  if (callSite.isEval()) {
	    file = callSite.getEvalOrigin() + ', ' + file;
	  }

	  var site = [file, line, colm];

	  site.callSite = callSite;
	  site.name = callSite.getFunctionName();

	  return site
	}

	/**
	 * Generate a default message from the site.
	 */

	function defaultMessage (site) {
	  var callSite = site.callSite;
	  var funcName = site.name;

	  // make useful anonymous name
	  if (!funcName) {
	    funcName = '<anonymous@' + formatLocation(site) + '>';
	  }

	  var context = callSite.getThis();
	  var typeName = context && callSite.getTypeName();

	  // ignore useless type name
	  if (typeName === 'Object') {
	    typeName = undefined;
	  }

	  // make useful type name
	  if (typeName === 'Function') {
	    typeName = context.name || typeName;
	  }

	  return typeName && callSite.getMethodName()
	    ? typeName + '.' + funcName
	    : funcName
	}

	/**
	 * Format deprecation message without color.
	 */

	function formatPlain (msg, caller, stack) {
	  var timestamp = new Date().toUTCString();

	  var formatted = timestamp +
	    ' ' + this._namespace +
	    ' deprecated ' + msg;

	  // add stack trace
	  if (this._traced) {
	    for (var i = 0; i < stack.length; i++) {
	      formatted += '\n    at ' + stack[i].toString();
	    }

	    return formatted
	  }

	  if (caller) {
	    formatted += ' at ' + formatLocation(caller);
	  }

	  return formatted
	}

	/**
	 * Format deprecation message with color.
	 */

	function formatColor (msg, caller, stack) {
	  var formatted = '\x1b[36;1m' + this._namespace + '\x1b[22;39m' + // bold cyan
	    ' \x1b[33;1mdeprecated\x1b[22;39m' + // bold yellow
	    ' \x1b[0m' + msg + '\x1b[39m'; // reset

	  // add stack trace
	  if (this._traced) {
	    for (var i = 0; i < stack.length; i++) {
	      formatted += '\n    \x1b[36mat ' + stack[i].toString() + '\x1b[39m'; // cyan
	    }

	    return formatted
	  }

	  if (caller) {
	    formatted += ' \x1b[36m' + formatLocation(caller) + '\x1b[39m'; // cyan
	  }

	  return formatted
	}

	/**
	 * Format call site location.
	 */

	function formatLocation (callSite) {
	  return relative(basePath, callSite[0]) +
	    ':' + callSite[1] +
	    ':' + callSite[2]
	}

	/**
	 * Get the stack as array of call sites.
	 */

	function getStack () {
	  var limit = Error.stackTraceLimit;
	  var obj = {};
	  var prep = Error.prepareStackTrace;

	  Error.prepareStackTrace = prepareObjectStackTrace;
	  Error.stackTraceLimit = Math.max(10, limit);

	  // capture the stack
	  Error.captureStackTrace(obj);

	  // slice this function off the top
	  var stack = obj.stack.slice(1);

	  Error.prepareStackTrace = prep;
	  Error.stackTraceLimit = limit;

	  return stack
	}

	/**
	 * Capture call site stack from v8.
	 */

	function prepareObjectStackTrace (obj, stack) {
	  return stack
	}

	/**
	 * Return a wrapped function in a deprecation message.
	 */

	function wrapfunction (fn, message) {
	  if (typeof fn !== 'function') {
	    throw new TypeError('argument fn must be a function')
	  }

	  var args = createArgumentsString(fn.length);
	  var stack = getStack();
	  var site = callSiteLocation(stack[1]);

	  site.name = fn.name;

	  // eslint-disable-next-line no-new-func
	  var deprecatedfn = new Function('fn', 'log', 'deprecate', 'message', 'site',
	    '"use strict"\n' +
	    'return function (' + args + ') {' +
	    'log.call(deprecate, message, site)\n' +
	    'return fn.apply(this, arguments)\n' +
	    '}')(fn, log, this, message, site);

	  return deprecatedfn
	}

	/**
	 * Wrap property in a deprecation message.
	 */

	function wrapproperty (obj, prop, message) {
	  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
	    throw new TypeError('argument obj must be object')
	  }

	  var descriptor = Object.getOwnPropertyDescriptor(obj, prop);

	  if (!descriptor) {
	    throw new TypeError('must call property on owner object')
	  }

	  if (!descriptor.configurable) {
	    throw new TypeError('property must be configurable')
	  }

	  var deprecate = this;
	  var stack = getStack();
	  var site = callSiteLocation(stack[1]);

	  // set site name
	  site.name = prop;

	  // convert data descriptor
	  if ('value' in descriptor) {
	    descriptor = convertDataDescriptorToAccessor(obj, prop);
	  }

	  var get = descriptor.get;
	  var set = descriptor.set;

	  // wrap getter
	  if (typeof get === 'function') {
	    descriptor.get = function getter () {
	      log.call(deprecate, message, site);
	      return get.apply(this, arguments)
	    };
	  }

	  // wrap setter
	  if (typeof set === 'function') {
	    descriptor.set = function setter () {
	      log.call(deprecate, message, site);
	      return set.apply(this, arguments)
	    };
	  }

	  Object.defineProperty(obj, prop, descriptor);
	}

	/**
	 * Create DeprecationError for deprecation
	 */

	function DeprecationError (namespace, message, stack) {
	  var error = new Error();
	  var stackString;

	  Object.defineProperty(error, 'constructor', {
	    value: DeprecationError
	  });

	  Object.defineProperty(error, 'message', {
	    configurable: true,
	    enumerable: false,
	    value: message,
	    writable: true
	  });

	  Object.defineProperty(error, 'name', {
	    enumerable: false,
	    configurable: true,
	    value: 'DeprecationError',
	    writable: true
	  });

	  Object.defineProperty(error, 'namespace', {
	    configurable: true,
	    enumerable: false,
	    value: namespace,
	    writable: true
	  });

	  Object.defineProperty(error, 'stack', {
	    configurable: true,
	    enumerable: false,
	    get: function () {
	      if (stackString !== undefined) {
	        return stackString
	      }

	      // prepare stack trace
	      return (stackString = createStackString.call(this, stack))
	    },
	    set: function setter (val) {
	      stackString = val;
	    }
	  });

	  return error
	}
	return depd_1;
}

var setprototypeof;
var hasRequiredSetprototypeof;

function requireSetprototypeof () {
	if (hasRequiredSetprototypeof) return setprototypeof;
	hasRequiredSetprototypeof = 1;
	/* eslint no-proto: 0 */
	setprototypeof = Object.setPrototypeOf || ({ __proto__: [] } instanceof Array ? setProtoOf : mixinProperties);

	function setProtoOf (obj, proto) {
	  obj.__proto__ = proto;
	  return obj
	}

	function mixinProperties (obj, proto) {
	  for (var prop in proto) {
	    if (!Object.prototype.hasOwnProperty.call(obj, prop)) {
	      obj[prop] = proto[prop];
	    }
	  }
	  return obj
	}
	return setprototypeof;
}

const require$$0$2 = {
  "100": "Continue",
  "101": "Switching Protocols",
  "102": "Processing",
  "103": "Early Hints",
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "205": "Reset Content",
  "206": "Partial Content",
  "207": "Multi-Status",
  "208": "Already Reported",
  "226": "IM Used",
  "300": "Multiple Choices",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "305": "Use Proxy",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "407": "Proxy Authentication Required",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "411": "Length Required",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "414": "URI Too Long",
  "415": "Unsupported Media Type",
  "416": "Range Not Satisfiable",
  "417": "Expectation Failed",
  "418": "I'm a Teapot",
  "421": "Misdirected Request",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "424": "Failed Dependency",
  "425": "Too Early",
  "426": "Upgrade Required",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "431": "Request Header Fields Too Large",
  "451": "Unavailable For Legal Reasons",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  "505": "HTTP Version Not Supported",
  "506": "Variant Also Negotiates",
  "507": "Insufficient Storage",
  "508": "Loop Detected",
  "509": "Bandwidth Limit Exceeded",
  "510": "Not Extended",
  "511": "Network Authentication Required",
};

/*!
 * statuses
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var statuses$1;
var hasRequiredStatuses$1;

function requireStatuses$1 () {
	if (hasRequiredStatuses$1) return statuses$1;
	hasRequiredStatuses$1 = 1;

	/**
	 * Module dependencies.
	 * @private
	 */

	var codes = require$$0$2;

	/**
	 * Module exports.
	 * @public
	 */

	statuses$1 = status;

	// status code to message map
	status.message = codes;

	// status message (lower-case) to code map
	status.code = createMessageToStatusCodeMap(codes);

	// array of status codes
	status.codes = createStatusCodeList(codes);

	// status codes for redirects
	status.redirect = {
	  300: true,
	  301: true,
	  302: true,
	  303: true,
	  305: true,
	  307: true,
	  308: true
	};

	// status codes for empty bodies
	status.empty = {
	  204: true,
	  205: true,
	  304: true
	};

	// status codes for when you should retry the request
	status.retry = {
	  502: true,
	  503: true,
	  504: true
	};

	/**
	 * Create a map of message to status code.
	 * @private
	 */

	function createMessageToStatusCodeMap (codes) {
	  var map = {};

	  Object.keys(codes).forEach(function forEachCode (code) {
	    var message = codes[code];
	    var status = Number(code);

	    // populate map
	    map[message.toLowerCase()] = status;
	  });

	  return map
	}

	/**
	 * Create a list of all status codes.
	 * @private
	 */

	function createStatusCodeList (codes) {
	  return Object.keys(codes).map(function mapCode (code) {
	    return Number(code)
	  })
	}

	/**
	 * Get the status code for given message.
	 * @private
	 */

	function getStatusCode (message) {
	  var msg = message.toLowerCase();

	  if (!Object.prototype.hasOwnProperty.call(status.code, msg)) {
	    throw new Error('invalid status message: "' + message + '"')
	  }

	  return status.code[msg]
	}

	/**
	 * Get the status message for given code.
	 * @private
	 */

	function getStatusMessage (code) {
	  if (!Object.prototype.hasOwnProperty.call(status.message, code)) {
	    throw new Error('invalid status code: ' + code)
	  }

	  return status.message[code]
	}

	/**
	 * Get the status code.
	 *
	 * Given a number, this will throw if it is not a known status
	 * code, otherwise the code will be returned. Given a string,
	 * the string will be parsed for a number and return the code
	 * if valid, otherwise will lookup the code assuming this is
	 * the status message.
	 *
	 * @param {string|number} code
	 * @returns {number}
	 * @public
	 */

	function status (code) {
	  if (typeof code === 'number') {
	    return getStatusMessage(code)
	  }

	  if (typeof code !== 'string') {
	    throw new TypeError('code must be a number or string')
	  }

	  // '403'
	  var n = parseInt(code, 10);
	  if (!isNaN(n)) {
	    return getStatusMessage(n)
	  }

	  return getStatusCode(code)
	}
	return statuses$1;
}

var inherits = {exports: {}};

var inherits_browser = {exports: {}};

var hasRequiredInherits_browser;

function requireInherits_browser () {
	if (hasRequiredInherits_browser) return inherits_browser.exports;
	hasRequiredInherits_browser = 1;
	if (typeof Object.create === 'function') {
	  // implementation from standard node.js 'util' module
	  inherits_browser.exports = function inherits(ctor, superCtor) {
	    if (superCtor) {
	      ctor.super_ = superCtor;
	      ctor.prototype = Object.create(superCtor.prototype, {
	        constructor: {
	          value: ctor,
	          enumerable: false,
	          writable: true,
	          configurable: true
	        }
	      });
	    }
	  };
	} else {
	  // old school shim for old browsers
	  inherits_browser.exports = function inherits(ctor, superCtor) {
	    if (superCtor) {
	      ctor.super_ = superCtor;
	      var TempCtor = function () {};
	      TempCtor.prototype = superCtor.prototype;
	      ctor.prototype = new TempCtor();
	      ctor.prototype.constructor = ctor;
	    }
	  };
	}
	return inherits_browser.exports;
}

var hasRequiredInherits;

function requireInherits () {
	if (hasRequiredInherits) return inherits.exports;
	hasRequiredInherits = 1;
	try {
	  var util = require('util');
	  /* istanbul ignore next */
	  if (typeof util.inherits !== 'function') throw '';
	  inherits.exports = util.inherits;
	} catch (e) {
	  /* istanbul ignore next */
	  inherits.exports = requireInherits_browser();
	}
	return inherits.exports;
}

/*!
 * toidentifier
 * Copyright(c) 2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var toidentifier;
var hasRequiredToidentifier;

function requireToidentifier () {
	if (hasRequiredToidentifier) return toidentifier;
	hasRequiredToidentifier = 1;

	/**
	 * Module exports.
	 * @public
	 */

	toidentifier = toIdentifier;

	/**
	 * Trasform the given string into a JavaScript identifier
	 *
	 * @param {string} str
	 * @returns {string}
	 * @public
	 */

	function toIdentifier (str) {
	  return str
	    .split(' ')
	    .map(function (token) {
	      return token.slice(0, 1).toUpperCase() + token.slice(1)
	    })
	    .join('')
	    .replace(/[^ _0-9a-z]/gi, '')
	}
	return toidentifier;
}

/*!
 * http-errors
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var hasRequiredHttpErrors;

function requireHttpErrors () {
	if (hasRequiredHttpErrors) return httpErrors.exports;
	hasRequiredHttpErrors = 1;
	(function (module) {

		/**
		 * Module dependencies.
		 * @private
		 */

		var deprecate = requireDepd()('http-errors');
		var setPrototypeOf = requireSetprototypeof();
		var statuses = requireStatuses$1();
		var inherits = requireInherits();
		var toIdentifier = requireToidentifier();

		/**
		 * Module exports.
		 * @public
		 */

		module.exports = createError;
		module.exports.HttpError = createHttpErrorConstructor();
		module.exports.isHttpError = createIsHttpErrorFunction(module.exports.HttpError);

		// Populate exports for all constructors
		populateConstructorExports(module.exports, statuses.codes, module.exports.HttpError);

		/**
		 * Get the code class of a status code.
		 * @private
		 */

		function codeClass (status) {
		  return Number(String(status).charAt(0) + '00')
		}

		/**
		 * Create a new HTTP Error.
		 *
		 * @returns {Error}
		 * @public
		 */

		function createError () {
		  // so much arity going on ~_~
		  var err;
		  var msg;
		  var status = 500;
		  var props = {};
		  for (var i = 0; i < arguments.length; i++) {
		    var arg = arguments[i];
		    var type = typeof arg;
		    if (type === 'object' && arg instanceof Error) {
		      err = arg;
		      status = err.status || err.statusCode || status;
		    } else if (type === 'number' && i === 0) {
		      status = arg;
		    } else if (type === 'string') {
		      msg = arg;
		    } else if (type === 'object') {
		      props = arg;
		    } else {
		      throw new TypeError('argument #' + (i + 1) + ' unsupported type ' + type)
		    }
		  }

		  if (typeof status === 'number' && (status < 400 || status >= 600)) {
		    deprecate('non-error status code; use only 4xx or 5xx status codes');
		  }

		  if (typeof status !== 'number' ||
		    (!statuses.message[status] && (status < 400 || status >= 600))) {
		    status = 500;
		  }

		  // constructor
		  var HttpError = createError[status] || createError[codeClass(status)];

		  if (!err) {
		    // create error
		    err = HttpError
		      ? new HttpError(msg)
		      : new Error(msg || statuses.message[status]);
		    Error.captureStackTrace(err, createError);
		  }

		  if (!HttpError || !(err instanceof HttpError) || err.status !== status) {
		    // add properties to generic error
		    err.expose = status < 500;
		    err.status = err.statusCode = status;
		  }

		  for (var key in props) {
		    if (key !== 'status' && key !== 'statusCode') {
		      err[key] = props[key];
		    }
		  }

		  return err
		}

		/**
		 * Create HTTP error abstract base class.
		 * @private
		 */

		function createHttpErrorConstructor () {
		  function HttpError () {
		    throw new TypeError('cannot construct abstract class')
		  }

		  inherits(HttpError, Error);

		  return HttpError
		}

		/**
		 * Create a constructor for a client error.
		 * @private
		 */

		function createClientErrorConstructor (HttpError, name, code) {
		  var className = toClassName(name);

		  function ClientError (message) {
		    // create the error object
		    var msg = message != null ? message : statuses.message[code];
		    var err = new Error(msg);

		    // capture a stack trace to the construction point
		    Error.captureStackTrace(err, ClientError);

		    // adjust the [[Prototype]]
		    setPrototypeOf(err, ClientError.prototype);

		    // redefine the error message
		    Object.defineProperty(err, 'message', {
		      enumerable: true,
		      configurable: true,
		      value: msg,
		      writable: true
		    });

		    // redefine the error name
		    Object.defineProperty(err, 'name', {
		      enumerable: false,
		      configurable: true,
		      value: className,
		      writable: true
		    });

		    return err
		  }

		  inherits(ClientError, HttpError);
		  nameFunc(ClientError, className);

		  ClientError.prototype.status = code;
		  ClientError.prototype.statusCode = code;
		  ClientError.prototype.expose = true;

		  return ClientError
		}

		/**
		 * Create function to test is a value is a HttpError.
		 * @private
		 */

		function createIsHttpErrorFunction (HttpError) {
		  return function isHttpError (val) {
		    if (!val || typeof val !== 'object') {
		      return false
		    }

		    if (val instanceof HttpError) {
		      return true
		    }

		    return val instanceof Error &&
		      typeof val.expose === 'boolean' &&
		      typeof val.statusCode === 'number' && val.status === val.statusCode
		  }
		}

		/**
		 * Create a constructor for a server error.
		 * @private
		 */

		function createServerErrorConstructor (HttpError, name, code) {
		  var className = toClassName(name);

		  function ServerError (message) {
		    // create the error object
		    var msg = message != null ? message : statuses.message[code];
		    var err = new Error(msg);

		    // capture a stack trace to the construction point
		    Error.captureStackTrace(err, ServerError);

		    // adjust the [[Prototype]]
		    setPrototypeOf(err, ServerError.prototype);

		    // redefine the error message
		    Object.defineProperty(err, 'message', {
		      enumerable: true,
		      configurable: true,
		      value: msg,
		      writable: true
		    });

		    // redefine the error name
		    Object.defineProperty(err, 'name', {
		      enumerable: false,
		      configurable: true,
		      value: className,
		      writable: true
		    });

		    return err
		  }

		  inherits(ServerError, HttpError);
		  nameFunc(ServerError, className);

		  ServerError.prototype.status = code;
		  ServerError.prototype.statusCode = code;
		  ServerError.prototype.expose = false;

		  return ServerError
		}

		/**
		 * Set the name of a function, if possible.
		 * @private
		 */

		function nameFunc (func, name) {
		  var desc = Object.getOwnPropertyDescriptor(func, 'name');

		  if (desc && desc.configurable) {
		    desc.value = name;
		    Object.defineProperty(func, 'name', desc);
		  }
		}

		/**
		 * Populate the exports object with constructors for every error class.
		 * @private
		 */

		function populateConstructorExports (exports, codes, HttpError) {
		  codes.forEach(function forEachCode (code) {
		    var CodeError;
		    var name = toIdentifier(statuses.message[code]);

		    switch (codeClass(code)) {
		      case 400:
		        CodeError = createClientErrorConstructor(HttpError, name, code);
		        break
		      case 500:
		        CodeError = createServerErrorConstructor(HttpError, name, code);
		        break
		    }

		    if (CodeError) {
		      // export the constructor
		      exports[code] = CodeError;
		      exports[name] = CodeError;
		    }
		  });
		}

		/**
		 * Get a class name from a name identifier.
		 * @private
		 */

		function toClassName (name) {
		  return name.substr(-5) !== 'Error'
		    ? name + 'Error'
		    : name
		} 
	} (httpErrors));
	return httpErrors.exports;
}

/*!
 * encodeurl
 * Copyright(c) 2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var encodeurl;
var hasRequiredEncodeurl;

function requireEncodeurl () {
	if (hasRequiredEncodeurl) return encodeurl;
	hasRequiredEncodeurl = 1;

	/**
	 * Module exports.
	 * @public
	 */

	encodeurl = encodeUrl;

	/**
	 * RegExp to match non-URL code points, *after* encoding (i.e. not including "%")
	 * and including invalid escape sequences.
	 * @private
	 */

	var ENCODE_CHARS_REGEXP = /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]|%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|$))+/g;

	/**
	 * RegExp to match unmatched surrogate pair.
	 * @private
	 */

	var UNMATCHED_SURROGATE_PAIR_REGEXP = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g;

	/**
	 * String to replace unmatched surrogate pair with.
	 * @private
	 */

	var UNMATCHED_SURROGATE_PAIR_REPLACE = '$1\uFFFD$2';

	/**
	 * Encode a URL to a percent-encoded form, excluding already-encoded sequences.
	 *
	 * This function will take an already-encoded URL and encode all the non-URL
	 * code points. This function will not encode the "%" character unless it is
	 * not part of a valid sequence (`%20` will be left as-is, but `%foo` will
	 * be encoded as `%25foo`).
	 *
	 * This encode is meant to be "safe" and does not throw errors. It will try as
	 * hard as it can to properly encode the given URL, including replacing any raw,
	 * unpaired surrogate pairs with the Unicode replacement character prior to
	 * encoding.
	 *
	 * @param {string} url
	 * @return {string}
	 * @public
	 */

	function encodeUrl (url) {
	  return String(url)
	    .replace(UNMATCHED_SURROGATE_PAIR_REGEXP, UNMATCHED_SURROGATE_PAIR_REPLACE)
	    .replace(ENCODE_CHARS_REGEXP, encodeURI)
	}
	return encodeurl;
}

/*!
 * escape-html
 * Copyright(c) 2012-2013 TJ Holowaychuk
 * Copyright(c) 2015 Andreas Lubbe
 * Copyright(c) 2015 Tiancheng "Timothy" Gu
 * MIT Licensed
 */

var escapeHtml_1;
var hasRequiredEscapeHtml;

function requireEscapeHtml () {
	if (hasRequiredEscapeHtml) return escapeHtml_1;
	hasRequiredEscapeHtml = 1;

	/**
	 * Module variables.
	 * @private
	 */

	var matchHtmlRegExp = /["'&<>]/;

	/**
	 * Module exports.
	 * @public
	 */

	escapeHtml_1 = escapeHtml;

	/**
	 * Escape special characters in the given string of html.
	 *
	 * @param  {string} string The string to escape for inserting into HTML
	 * @return {string}
	 * @public
	 */

	function escapeHtml(string) {
	  var str = '' + string;
	  var match = matchHtmlRegExp.exec(str);

	  if (!match) {
	    return str;
	  }

	  var escape;
	  var html = '';
	  var index = 0;
	  var lastIndex = 0;

	  for (index = match.index; index < str.length; index++) {
	    switch (str.charCodeAt(index)) {
	      case 34: // "
	        escape = '&quot;';
	        break;
	      case 38: // &
	        escape = '&amp;';
	        break;
	      case 39: // '
	        escape = '&#39;';
	        break;
	      case 60: // <
	        escape = '&lt;';
	        break;
	      case 62: // >
	        escape = '&gt;';
	        break;
	      default:
	        continue;
	    }

	    if (lastIndex !== index) {
	      html += str.substring(lastIndex, index);
	    }

	    lastIndex = index + 1;
	    html += escape;
	  }

	  return lastIndex !== index
	    ? html + str.substring(lastIndex, index)
	    : html;
	}
	return escapeHtml_1;
}

/*!
 * etag
 * Copyright(c) 2014-2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var etag_1;
var hasRequiredEtag;

function requireEtag () {
	if (hasRequiredEtag) return etag_1;
	hasRequiredEtag = 1;

	/**
	 * Module exports.
	 * @public
	 */

	etag_1 = etag;

	/**
	 * Module dependencies.
	 * @private
	 */

	var crypto = require$$0$6;
	var Stats = require$$0$5.Stats;

	/**
	 * Module variables.
	 * @private
	 */

	var toString = Object.prototype.toString;

	/**
	 * Generate an entity tag.
	 *
	 * @param {Buffer|string} entity
	 * @return {string}
	 * @private
	 */

	function entitytag (entity) {
	  if (entity.length === 0) {
	    // fast-path empty
	    return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'
	  }

	  // compute hash of entity
	  var hash = crypto
	    .createHash('sha1')
	    .update(entity, 'utf8')
	    .digest('base64')
	    .substring(0, 27);

	  // compute length of entity
	  var len = typeof entity === 'string'
	    ? Buffer.byteLength(entity, 'utf8')
	    : entity.length;

	  return '"' + len.toString(16) + '-' + hash + '"'
	}

	/**
	 * Create a simple ETag.
	 *
	 * @param {string|Buffer|Stats} entity
	 * @param {object} [options]
	 * @param {boolean} [options.weak]
	 * @return {String}
	 * @public
	 */

	function etag (entity, options) {
	  if (entity == null) {
	    throw new TypeError('argument entity is required')
	  }

	  // support fs.Stats object
	  var isStats = isstats(entity);
	  var weak = options && typeof options.weak === 'boolean'
	    ? options.weak
	    : isStats;

	  // validate argument
	  if (!isStats && typeof entity !== 'string' && !Buffer.isBuffer(entity)) {
	    throw new TypeError('argument entity must be string, Buffer, or fs.Stats')
	  }

	  // generate entity tag
	  var tag = isStats
	    ? stattag(entity)
	    : entitytag(entity);

	  return weak
	    ? 'W/' + tag
	    : tag
	}

	/**
	 * Determine if object is a Stats object.
	 *
	 * @param {object} obj
	 * @return {boolean}
	 * @api private
	 */

	function isstats (obj) {
	  // genuine fs.Stats
	  if (typeof Stats === 'function' && obj instanceof Stats) {
	    return true
	  }

	  // quack quack
	  return obj && typeof obj === 'object' &&
	    'ctime' in obj && toString.call(obj.ctime) === '[object Date]' &&
	    'mtime' in obj && toString.call(obj.mtime) === '[object Date]' &&
	    'ino' in obj && typeof obj.ino === 'number' &&
	    'size' in obj && typeof obj.size === 'number'
	}

	/**
	 * Generate a tag for a stat.
	 *
	 * @param {object} stat
	 * @return {string}
	 * @private
	 */

	function stattag (stat) {
	  var mtime = stat.mtime.getTime().toString(16);
	  var size = stat.size.toString(16);

	  return '"' + size + '-' + mtime + '"'
	}
	return etag_1;
}

/*!
 * fresh
 * Copyright(c) 2012 TJ Holowaychuk
 * Copyright(c) 2016-2017 Douglas Christopher Wilson
 * MIT Licensed
 */

var fresh_1;
var hasRequiredFresh;

function requireFresh () {
	if (hasRequiredFresh) return fresh_1;
	hasRequiredFresh = 1;

	/**
	 * RegExp to check for no-cache token in Cache-Control.
	 * @private
	 */

	var CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

	/**
	 * Module exports.
	 * @public
	 */

	fresh_1 = fresh;

	/**
	 * Check freshness of the response using request and response headers.
	 *
	 * @param {Object} reqHeaders
	 * @param {Object} resHeaders
	 * @return {Boolean}
	 * @public
	 */

	function fresh (reqHeaders, resHeaders) {
	  // fields
	  var modifiedSince = reqHeaders['if-modified-since'];
	  var noneMatch = reqHeaders['if-none-match'];

	  // unconditional request
	  if (!modifiedSince && !noneMatch) {
	    return false
	  }

	  // Always return stale when Cache-Control: no-cache
	  // to support end-to-end reload requests
	  // https://tools.ietf.org/html/rfc2616#section-14.9.4
	  var cacheControl = reqHeaders['cache-control'];
	  if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) {
	    return false
	  }

	  // if-none-match takes precedent over if-modified-since
	  if (noneMatch) {
	    if (noneMatch === '*') {
	      return true
	    }
	    var etag = resHeaders.etag;

	    if (!etag) {
	      return false
	    }

	    var matches = parseTokenList(noneMatch);
	    for (var i = 0; i < matches.length; i++) {
	      var match = matches[i];
	      if (match === etag || match === 'W/' + etag || 'W/' + match === etag) {
	        return true
	      }
	    }

	    return false
	  }

	  // if-modified-since
	  if (modifiedSince) {
	    var lastModified = resHeaders['last-modified'];
	    var modifiedStale = !lastModified || !(parseHttpDate(lastModified) <= parseHttpDate(modifiedSince));

	    if (modifiedStale) {
	      return false
	    }
	  }

	  return true
	}

	/**
	 * Parse an HTTP Date into a number.
	 *
	 * @param {string} date
	 * @private
	 */

	function parseHttpDate (date) {
	  var timestamp = date && Date.parse(date);

	  // istanbul ignore next: guard against date.js Date.parse patching
	  return typeof timestamp === 'number'
	    ? timestamp
	    : NaN
	}

	/**
	 * Parse a HTTP token list.
	 *
	 * @param {string} str
	 * @private
	 */

	function parseTokenList (str) {
	  var end = 0;
	  var list = [];
	  var start = 0;

	  // gather tokens
	  for (var i = 0, len = str.length; i < len; i++) {
	    switch (str.charCodeAt(i)) {
	      case 0x20: /*   */
	        if (start === end) {
	          start = end = i + 1;
	        }
	        break
	      case 0x2c: /* , */
	        list.push(str.substring(start, end));
	        start = end = i + 1;
	        break
	      default:
	        end = i + 1;
	        break
	    }
	  }

	  // final token
	  list.push(str.substring(start, end));

	  return list
	}
	return fresh_1;
}

var mimeTypes = {};

const require$$0$1 = {
  "application/1d-interleaved-parityfec": {"source":"iana"},
  "application/3gpdash-qoe-report+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/3gpp-ims+xml": {"source":"iana","compressible":true},
  "application/3gpphal+json": {"source":"iana","compressible":true},
  "application/3gpphalforms+json": {"source":"iana","compressible":true},
  "application/a2l": {"source":"iana"},
  "application/ace+cbor": {"source":"iana"},
  "application/ace+json": {"source":"iana","compressible":true},
  "application/ace-groupcomm+cbor": {"source":"iana"},
  "application/ace-trl+cbor": {"source":"iana"},
  "application/activemessage": {"source":"iana"},
  "application/activity+json": {"source":"iana","compressible":true},
  "application/aif+cbor": {"source":"iana"},
  "application/aif+json": {"source":"iana","compressible":true},
  "application/alto-cdni+json": {"source":"iana","compressible":true},
  "application/alto-cdnifilter+json": {"source":"iana","compressible":true},
  "application/alto-costmap+json": {"source":"iana","compressible":true},
  "application/alto-costmapfilter+json": {"source":"iana","compressible":true},
  "application/alto-directory+json": {"source":"iana","compressible":true},
  "application/alto-endpointcost+json": {"source":"iana","compressible":true},
  "application/alto-endpointcostparams+json": {"source":"iana","compressible":true},
  "application/alto-endpointprop+json": {"source":"iana","compressible":true},
  "application/alto-endpointpropparams+json": {"source":"iana","compressible":true},
  "application/alto-error+json": {"source":"iana","compressible":true},
  "application/alto-networkmap+json": {"source":"iana","compressible":true},
  "application/alto-networkmapfilter+json": {"source":"iana","compressible":true},
  "application/alto-propmap+json": {"source":"iana","compressible":true},
  "application/alto-propmapparams+json": {"source":"iana","compressible":true},
  "application/alto-tips+json": {"source":"iana","compressible":true},
  "application/alto-tipsparams+json": {"source":"iana","compressible":true},
  "application/alto-updatestreamcontrol+json": {"source":"iana","compressible":true},
  "application/alto-updatestreamparams+json": {"source":"iana","compressible":true},
  "application/aml": {"source":"iana"},
  "application/andrew-inset": {"source":"iana","extensions":["ez"]},
  "application/appinstaller": {"compressible":false,"extensions":["appinstaller"]},
  "application/applefile": {"source":"iana"},
  "application/applixware": {"source":"apache","extensions":["aw"]},
  "application/appx": {"compressible":false,"extensions":["appx"]},
  "application/appxbundle": {"compressible":false,"extensions":["appxbundle"]},
  "application/at+jwt": {"source":"iana"},
  "application/atf": {"source":"iana"},
  "application/atfx": {"source":"iana"},
  "application/atom+xml": {"source":"iana","compressible":true,"extensions":["atom"]},
  "application/atomcat+xml": {"source":"iana","compressible":true,"extensions":["atomcat"]},
  "application/atomdeleted+xml": {"source":"iana","compressible":true,"extensions":["atomdeleted"]},
  "application/atomicmail": {"source":"iana"},
  "application/atomsvc+xml": {"source":"iana","compressible":true,"extensions":["atomsvc"]},
  "application/atsc-dwd+xml": {"source":"iana","compressible":true,"extensions":["dwd"]},
  "application/atsc-dynamic-event-message": {"source":"iana"},
  "application/atsc-held+xml": {"source":"iana","compressible":true,"extensions":["held"]},
  "application/atsc-rdt+json": {"source":"iana","compressible":true},
  "application/atsc-rsat+xml": {"source":"iana","compressible":true,"extensions":["rsat"]},
  "application/atxml": {"source":"iana"},
  "application/auth-policy+xml": {"source":"iana","compressible":true},
  "application/automationml-aml+xml": {"source":"iana","compressible":true,"extensions":["aml"]},
  "application/automationml-amlx+zip": {"source":"iana","compressible":false,"extensions":["amlx"]},
  "application/bacnet-xdd+zip": {"source":"iana","compressible":false},
  "application/batch-smtp": {"source":"iana"},
  "application/bdoc": {"compressible":false,"extensions":["bdoc"]},
  "application/beep+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/bufr": {"source":"iana"},
  "application/c2pa": {"source":"iana"},
  "application/calendar+json": {"source":"iana","compressible":true},
  "application/calendar+xml": {"source":"iana","compressible":true,"extensions":["xcs"]},
  "application/call-completion": {"source":"iana"},
  "application/cals-1840": {"source":"iana"},
  "application/captive+json": {"source":"iana","compressible":true},
  "application/cbor": {"source":"iana"},
  "application/cbor-seq": {"source":"iana"},
  "application/cccex": {"source":"iana"},
  "application/ccmp+xml": {"source":"iana","compressible":true},
  "application/ccxml+xml": {"source":"iana","compressible":true,"extensions":["ccxml"]},
  "application/cda+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/cdfx+xml": {"source":"iana","compressible":true,"extensions":["cdfx"]},
  "application/cdmi-capability": {"source":"iana","extensions":["cdmia"]},
  "application/cdmi-container": {"source":"iana","extensions":["cdmic"]},
  "application/cdmi-domain": {"source":"iana","extensions":["cdmid"]},
  "application/cdmi-object": {"source":"iana","extensions":["cdmio"]},
  "application/cdmi-queue": {"source":"iana","extensions":["cdmiq"]},
  "application/cdni": {"source":"iana"},
  "application/ce+cbor": {"source":"iana"},
  "application/cea": {"source":"iana"},
  "application/cea-2018+xml": {"source":"iana","compressible":true},
  "application/cellml+xml": {"source":"iana","compressible":true},
  "application/cfw": {"source":"iana"},
  "application/cid-edhoc+cbor-seq": {"source":"iana"},
  "application/city+json": {"source":"iana","compressible":true},
  "application/city+json-seq": {"source":"iana"},
  "application/clr": {"source":"iana"},
  "application/clue+xml": {"source":"iana","compressible":true},
  "application/clue_info+xml": {"source":"iana","compressible":true},
  "application/cms": {"source":"iana"},
  "application/cnrp+xml": {"source":"iana","compressible":true},
  "application/coap-eap": {"source":"iana"},
  "application/coap-group+json": {"source":"iana","compressible":true},
  "application/coap-payload": {"source":"iana"},
  "application/commonground": {"source":"iana"},
  "application/concise-problem-details+cbor": {"source":"iana"},
  "application/conference-info+xml": {"source":"iana","compressible":true},
  "application/cose": {"source":"iana"},
  "application/cose-key": {"source":"iana"},
  "application/cose-key-set": {"source":"iana"},
  "application/cose-x509": {"source":"iana"},
  "application/cpl+xml": {"source":"iana","compressible":true,"extensions":["cpl"]},
  "application/csrattrs": {"source":"iana"},
  "application/csta+xml": {"source":"iana","compressible":true},
  "application/cstadata+xml": {"source":"iana","compressible":true},
  "application/csvm+json": {"source":"iana","compressible":true},
  "application/cu-seeme": {"source":"apache","extensions":["cu"]},
  "application/cwl": {"source":"iana","extensions":["cwl"]},
  "application/cwl+json": {"source":"iana","compressible":true},
  "application/cwl+yaml": {"source":"iana"},
  "application/cwt": {"source":"iana"},
  "application/cybercash": {"source":"iana"},
  "application/dart": {"compressible":true},
  "application/dash+xml": {"source":"iana","compressible":true,"extensions":["mpd"]},
  "application/dash-patch+xml": {"source":"iana","compressible":true,"extensions":["mpp"]},
  "application/dashdelta": {"source":"iana"},
  "application/davmount+xml": {"source":"iana","compressible":true,"extensions":["davmount"]},
  "application/dca-rft": {"source":"iana"},
  "application/dcd": {"source":"iana"},
  "application/dec-dx": {"source":"iana"},
  "application/dialog-info+xml": {"source":"iana","compressible":true},
  "application/dicom": {"source":"iana","extensions":["dcm"]},
  "application/dicom+json": {"source":"iana","compressible":true},
  "application/dicom+xml": {"source":"iana","compressible":true},
  "application/dii": {"source":"iana"},
  "application/dit": {"source":"iana"},
  "application/dns": {"source":"iana"},
  "application/dns+json": {"source":"iana","compressible":true},
  "application/dns-message": {"source":"iana"},
  "application/docbook+xml": {"source":"apache","compressible":true,"extensions":["dbk"]},
  "application/dots+cbor": {"source":"iana"},
  "application/dpop+jwt": {"source":"iana"},
  "application/dskpp+xml": {"source":"iana","compressible":true},
  "application/dssc+der": {"source":"iana","extensions":["dssc"]},
  "application/dssc+xml": {"source":"iana","compressible":true,"extensions":["xdssc"]},
  "application/dvcs": {"source":"iana"},
  "application/eat+cwt": {"source":"iana"},
  "application/eat+jwt": {"source":"iana"},
  "application/eat-bun+cbor": {"source":"iana"},
  "application/eat-bun+json": {"source":"iana","compressible":true},
  "application/eat-ucs+cbor": {"source":"iana"},
  "application/eat-ucs+json": {"source":"iana","compressible":true},
  "application/ecmascript": {"source":"apache","compressible":true,"extensions":["ecma"]},
  "application/edhoc+cbor-seq": {"source":"iana"},
  "application/edi-consent": {"source":"iana"},
  "application/edi-x12": {"source":"iana","compressible":false},
  "application/edifact": {"source":"iana","compressible":false},
  "application/efi": {"source":"iana"},
  "application/elm+json": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/elm+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.cap+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/emergencycalldata.comment+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.control+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.deviceinfo+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.ecall.msd": {"source":"iana"},
  "application/emergencycalldata.legacyesn+json": {"source":"iana","compressible":true},
  "application/emergencycalldata.providerinfo+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.serviceinfo+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.subscriberinfo+xml": {"source":"iana","compressible":true},
  "application/emergencycalldata.veds+xml": {"source":"iana","compressible":true},
  "application/emma+xml": {"source":"iana","compressible":true,"extensions":["emma"]},
  "application/emotionml+xml": {"source":"iana","compressible":true,"extensions":["emotionml"]},
  "application/encaprtp": {"source":"iana"},
  "application/entity-statement+jwt": {"source":"iana"},
  "application/epp+xml": {"source":"iana","compressible":true},
  "application/epub+zip": {"source":"iana","compressible":false,"extensions":["epub"]},
  "application/eshop": {"source":"iana"},
  "application/exi": {"source":"iana","extensions":["exi"]},
  "application/expect-ct-report+json": {"source":"iana","compressible":true},
  "application/express": {"source":"iana","extensions":["exp"]},
  "application/fastinfoset": {"source":"iana"},
  "application/fastsoap": {"source":"iana"},
  "application/fdf": {"source":"iana","extensions":["fdf"]},
  "application/fdt+xml": {"source":"iana","compressible":true,"extensions":["fdt"]},
  "application/fhir+json": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/fhir+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/fido.trusted-apps+json": {"compressible":true},
  "application/fits": {"source":"iana"},
  "application/flexfec": {"source":"iana"},
  "application/font-sfnt": {"source":"iana"},
  "application/font-tdpfr": {"source":"iana","extensions":["pfr"]},
  "application/font-woff": {"source":"iana","compressible":false},
  "application/framework-attributes+xml": {"source":"iana","compressible":true},
  "application/geo+json": {"source":"iana","compressible":true,"extensions":["geojson"]},
  "application/geo+json-seq": {"source":"iana"},
  "application/geopackage+sqlite3": {"source":"iana"},
  "application/geopose+json": {"source":"iana","compressible":true},
  "application/geoxacml+json": {"source":"iana","compressible":true},
  "application/geoxacml+xml": {"source":"iana","compressible":true},
  "application/gltf-buffer": {"source":"iana"},
  "application/gml+xml": {"source":"iana","compressible":true,"extensions":["gml"]},
  "application/gnap-binding-jws": {"source":"iana"},
  "application/gnap-binding-jwsd": {"source":"iana"},
  "application/gnap-binding-rotation-jws": {"source":"iana"},
  "application/gnap-binding-rotation-jwsd": {"source":"iana"},
  "application/gpx+xml": {"source":"apache","compressible":true,"extensions":["gpx"]},
  "application/grib": {"source":"iana"},
  "application/gxf": {"source":"apache","extensions":["gxf"]},
  "application/gzip": {"source":"iana","compressible":false,"extensions":["gz"]},
  "application/h224": {"source":"iana"},
  "application/held+xml": {"source":"iana","compressible":true},
  "application/hjson": {"extensions":["hjson"]},
  "application/hl7v2+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/http": {"source":"iana"},
  "application/hyperstudio": {"source":"iana","extensions":["stk"]},
  "application/ibe-key-request+xml": {"source":"iana","compressible":true},
  "application/ibe-pkg-reply+xml": {"source":"iana","compressible":true},
  "application/ibe-pp-data": {"source":"iana"},
  "application/iges": {"source":"iana"},
  "application/im-iscomposing+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/index": {"source":"iana"},
  "application/index.cmd": {"source":"iana"},
  "application/index.obj": {"source":"iana"},
  "application/index.response": {"source":"iana"},
  "application/index.vnd": {"source":"iana"},
  "application/inkml+xml": {"source":"iana","compressible":true,"extensions":["ink","inkml"]},
  "application/iotp": {"source":"iana"},
  "application/ipfix": {"source":"iana","extensions":["ipfix"]},
  "application/ipp": {"source":"iana"},
  "application/isup": {"source":"iana"},
  "application/its+xml": {"source":"iana","compressible":true,"extensions":["its"]},
  "application/java-archive": {"source":"iana","compressible":false,"extensions":["jar","war","ear"]},
  "application/java-serialized-object": {"source":"apache","compressible":false,"extensions":["ser"]},
  "application/java-vm": {"source":"apache","compressible":false,"extensions":["class"]},
  "application/javascript": {"source":"apache","charset":"UTF-8","compressible":true,"extensions":["js"]},
  "application/jf2feed+json": {"source":"iana","compressible":true},
  "application/jose": {"source":"iana"},
  "application/jose+json": {"source":"iana","compressible":true},
  "application/jrd+json": {"source":"iana","compressible":true},
  "application/jscalendar+json": {"source":"iana","compressible":true},
  "application/jscontact+json": {"source":"iana","compressible":true},
  "application/json": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["json","map"]},
  "application/json-patch+json": {"source":"iana","compressible":true},
  "application/json-seq": {"source":"iana"},
  "application/json5": {"extensions":["json5"]},
  "application/jsonml+json": {"source":"apache","compressible":true,"extensions":["jsonml"]},
  "application/jsonpath": {"source":"iana"},
  "application/jwk+json": {"source":"iana","compressible":true},
  "application/jwk-set+json": {"source":"iana","compressible":true},
  "application/jwk-set+jwt": {"source":"iana"},
  "application/jwt": {"source":"iana"},
  "application/kpml-request+xml": {"source":"iana","compressible":true},
  "application/kpml-response+xml": {"source":"iana","compressible":true},
  "application/ld+json": {"source":"iana","compressible":true,"extensions":["jsonld"]},
  "application/lgr+xml": {"source":"iana","compressible":true,"extensions":["lgr"]},
  "application/link-format": {"source":"iana"},
  "application/linkset": {"source":"iana"},
  "application/linkset+json": {"source":"iana","compressible":true},
  "application/load-control+xml": {"source":"iana","compressible":true},
  "application/logout+jwt": {"source":"iana"},
  "application/lost+xml": {"source":"iana","compressible":true,"extensions":["lostxml"]},
  "application/lostsync+xml": {"source":"iana","compressible":true},
  "application/lpf+zip": {"source":"iana","compressible":false},
  "application/lxf": {"source":"iana"},
  "application/mac-binhex40": {"source":"iana","extensions":["hqx"]},
  "application/mac-compactpro": {"source":"apache","extensions":["cpt"]},
  "application/macwriteii": {"source":"iana"},
  "application/mads+xml": {"source":"iana","compressible":true,"extensions":["mads"]},
  "application/manifest+json": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["webmanifest"]},
  "application/marc": {"source":"iana","extensions":["mrc"]},
  "application/marcxml+xml": {"source":"iana","compressible":true,"extensions":["mrcx"]},
  "application/mathematica": {"source":"iana","extensions":["ma","nb","mb"]},
  "application/mathml+xml": {"source":"iana","compressible":true,"extensions":["mathml"]},
  "application/mathml-content+xml": {"source":"iana","compressible":true},
  "application/mathml-presentation+xml": {"source":"iana","compressible":true},
  "application/mbms-associated-procedure-description+xml": {"source":"iana","compressible":true},
  "application/mbms-deregister+xml": {"source":"iana","compressible":true},
  "application/mbms-envelope+xml": {"source":"iana","compressible":true},
  "application/mbms-msk+xml": {"source":"iana","compressible":true},
  "application/mbms-msk-response+xml": {"source":"iana","compressible":true},
  "application/mbms-protection-description+xml": {"source":"iana","compressible":true},
  "application/mbms-reception-report+xml": {"source":"iana","compressible":true},
  "application/mbms-register+xml": {"source":"iana","compressible":true},
  "application/mbms-register-response+xml": {"source":"iana","compressible":true},
  "application/mbms-schedule+xml": {"source":"iana","compressible":true},
  "application/mbms-user-service-description+xml": {"source":"iana","compressible":true},
  "application/mbox": {"source":"iana","extensions":["mbox"]},
  "application/media-policy-dataset+xml": {"source":"iana","compressible":true,"extensions":["mpf"]},
  "application/media_control+xml": {"source":"iana","compressible":true},
  "application/mediaservercontrol+xml": {"source":"iana","compressible":true,"extensions":["mscml"]},
  "application/merge-patch+json": {"source":"iana","compressible":true},
  "application/metalink+xml": {"source":"apache","compressible":true,"extensions":["metalink"]},
  "application/metalink4+xml": {"source":"iana","compressible":true,"extensions":["meta4"]},
  "application/mets+xml": {"source":"iana","compressible":true,"extensions":["mets"]},
  "application/mf4": {"source":"iana"},
  "application/mikey": {"source":"iana"},
  "application/mipc": {"source":"iana"},
  "application/missing-blocks+cbor-seq": {"source":"iana"},
  "application/mmt-aei+xml": {"source":"iana","compressible":true,"extensions":["maei"]},
  "application/mmt-usd+xml": {"source":"iana","compressible":true,"extensions":["musd"]},
  "application/mods+xml": {"source":"iana","compressible":true,"extensions":["mods"]},
  "application/moss-keys": {"source":"iana"},
  "application/moss-signature": {"source":"iana"},
  "application/mosskey-data": {"source":"iana"},
  "application/mosskey-request": {"source":"iana"},
  "application/mp21": {"source":"iana","extensions":["m21","mp21"]},
  "application/mp4": {"source":"iana","extensions":["mp4","mpg4","mp4s","m4p"]},
  "application/mpeg4-generic": {"source":"iana"},
  "application/mpeg4-iod": {"source":"iana"},
  "application/mpeg4-iod-xmt": {"source":"iana"},
  "application/mrb-consumer+xml": {"source":"iana","compressible":true},
  "application/mrb-publish+xml": {"source":"iana","compressible":true},
  "application/msc-ivr+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/msc-mixer+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/msix": {"compressible":false,"extensions":["msix"]},
  "application/msixbundle": {"compressible":false,"extensions":["msixbundle"]},
  "application/msword": {"source":"iana","compressible":false,"extensions":["doc","dot"]},
  "application/mud+json": {"source":"iana","compressible":true},
  "application/multipart-core": {"source":"iana"},
  "application/mxf": {"source":"iana","extensions":["mxf"]},
  "application/n-quads": {"source":"iana","extensions":["nq"]},
  "application/n-triples": {"source":"iana","extensions":["nt"]},
  "application/nasdata": {"source":"iana"},
  "application/news-checkgroups": {"source":"iana","charset":"US-ASCII"},
  "application/news-groupinfo": {"source":"iana","charset":"US-ASCII"},
  "application/news-transmission": {"source":"iana"},
  "application/nlsml+xml": {"source":"iana","compressible":true},
  "application/node": {"source":"iana","extensions":["cjs"]},
  "application/nss": {"source":"iana"},
  "application/oauth-authz-req+jwt": {"source":"iana"},
  "application/oblivious-dns-message": {"source":"iana"},
  "application/ocsp-request": {"source":"iana"},
  "application/ocsp-response": {"source":"iana"},
  "application/octet-stream": {"source":"iana","compressible":true,"extensions":["bin","dms","lrf","mar","so","dist","distz","pkg","bpk","dump","elc","deploy","exe","dll","deb","dmg","iso","img","msi","msp","msm","buffer"]},
  "application/oda": {"source":"iana","extensions":["oda"]},
  "application/odm+xml": {"source":"iana","compressible":true},
  "application/odx": {"source":"iana"},
  "application/oebps-package+xml": {"source":"iana","compressible":true,"extensions":["opf"]},
  "application/ogg": {"source":"iana","compressible":false,"extensions":["ogx"]},
  "application/ohttp-keys": {"source":"iana"},
  "application/omdoc+xml": {"source":"apache","compressible":true,"extensions":["omdoc"]},
  "application/onenote": {"source":"apache","extensions":["onetoc","onetoc2","onetmp","onepkg","one","onea"]},
  "application/opc-nodeset+xml": {"source":"iana","compressible":true},
  "application/oscore": {"source":"iana"},
  "application/oxps": {"source":"iana","extensions":["oxps"]},
  "application/p21": {"source":"iana"},
  "application/p21+zip": {"source":"iana","compressible":false},
  "application/p2p-overlay+xml": {"source":"iana","compressible":true,"extensions":["relo"]},
  "application/parityfec": {"source":"iana"},
  "application/passport": {"source":"iana"},
  "application/patch-ops-error+xml": {"source":"iana","compressible":true,"extensions":["xer"]},
  "application/pdf": {"source":"iana","compressible":false,"extensions":["pdf"]},
  "application/pdx": {"source":"iana"},
  "application/pem-certificate-chain": {"source":"iana"},
  "application/pgp-encrypted": {"source":"iana","compressible":false,"extensions":["pgp"]},
  "application/pgp-keys": {"source":"iana","extensions":["asc"]},
  "application/pgp-signature": {"source":"iana","extensions":["sig","asc"]},
  "application/pics-rules": {"source":"apache","extensions":["prf"]},
  "application/pidf+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/pidf-diff+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/pkcs10": {"source":"iana","extensions":["p10"]},
  "application/pkcs12": {"source":"iana"},
  "application/pkcs7-mime": {"source":"iana","extensions":["p7m","p7c"]},
  "application/pkcs7-signature": {"source":"iana","extensions":["p7s"]},
  "application/pkcs8": {"source":"iana","extensions":["p8"]},
  "application/pkcs8-encrypted": {"source":"iana"},
  "application/pkix-attr-cert": {"source":"iana","extensions":["ac"]},
  "application/pkix-cert": {"source":"iana","extensions":["cer"]},
  "application/pkix-crl": {"source":"iana","extensions":["crl"]},
  "application/pkix-pkipath": {"source":"iana","extensions":["pkipath"]},
  "application/pkixcmp": {"source":"iana","extensions":["pki"]},
  "application/pls+xml": {"source":"iana","compressible":true,"extensions":["pls"]},
  "application/poc-settings+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/postscript": {"source":"iana","compressible":true,"extensions":["ai","eps","ps"]},
  "application/ppsp-tracker+json": {"source":"iana","compressible":true},
  "application/private-token-issuer-directory": {"source":"iana"},
  "application/private-token-request": {"source":"iana"},
  "application/private-token-response": {"source":"iana"},
  "application/problem+json": {"source":"iana","compressible":true},
  "application/problem+xml": {"source":"iana","compressible":true},
  "application/provenance+xml": {"source":"iana","compressible":true,"extensions":["provx"]},
  "application/provided-claims+jwt": {"source":"iana"},
  "application/prs.alvestrand.titrax-sheet": {"source":"iana"},
  "application/prs.cww": {"source":"iana","extensions":["cww"]},
  "application/prs.cyn": {"source":"iana","charset":"7-BIT"},
  "application/prs.hpub+zip": {"source":"iana","compressible":false},
  "application/prs.implied-document+xml": {"source":"iana","compressible":true},
  "application/prs.implied-executable": {"source":"iana"},
  "application/prs.implied-object+json": {"source":"iana","compressible":true},
  "application/prs.implied-object+json-seq": {"source":"iana"},
  "application/prs.implied-object+yaml": {"source":"iana"},
  "application/prs.implied-structure": {"source":"iana"},
  "application/prs.mayfile": {"source":"iana"},
  "application/prs.nprend": {"source":"iana"},
  "application/prs.plucker": {"source":"iana"},
  "application/prs.rdf-xml-crypt": {"source":"iana"},
  "application/prs.vcfbzip2": {"source":"iana"},
  "application/prs.xsf+xml": {"source":"iana","compressible":true,"extensions":["xsf"]},
  "application/pskc+xml": {"source":"iana","compressible":true,"extensions":["pskcxml"]},
  "application/pvd+json": {"source":"iana","compressible":true},
  "application/qsig": {"source":"iana"},
  "application/raml+yaml": {"compressible":true,"extensions":["raml"]},
  "application/raptorfec": {"source":"iana"},
  "application/rdap+json": {"source":"iana","compressible":true},
  "application/rdf+xml": {"source":"iana","compressible":true,"extensions":["rdf","owl"]},
  "application/reginfo+xml": {"source":"iana","compressible":true,"extensions":["rif"]},
  "application/relax-ng-compact-syntax": {"source":"iana","extensions":["rnc"]},
  "application/remote-printing": {"source":"apache"},
  "application/reputon+json": {"source":"iana","compressible":true},
  "application/resolve-response+jwt": {"source":"iana"},
  "application/resource-lists+xml": {"source":"iana","compressible":true,"extensions":["rl"]},
  "application/resource-lists-diff+xml": {"source":"iana","compressible":true,"extensions":["rld"]},
  "application/rfc+xml": {"source":"iana","compressible":true},
  "application/riscos": {"source":"iana"},
  "application/rlmi+xml": {"source":"iana","compressible":true},
  "application/rls-services+xml": {"source":"iana","compressible":true,"extensions":["rs"]},
  "application/route-apd+xml": {"source":"iana","compressible":true,"extensions":["rapd"]},
  "application/route-s-tsid+xml": {"source":"iana","compressible":true,"extensions":["sls"]},
  "application/route-usd+xml": {"source":"iana","compressible":true,"extensions":["rusd"]},
  "application/rpki-checklist": {"source":"iana"},
  "application/rpki-ghostbusters": {"source":"iana","extensions":["gbr"]},
  "application/rpki-manifest": {"source":"iana","extensions":["mft"]},
  "application/rpki-publication": {"source":"iana"},
  "application/rpki-roa": {"source":"iana","extensions":["roa"]},
  "application/rpki-signed-tal": {"source":"iana"},
  "application/rpki-updown": {"source":"iana"},
  "application/rsd+xml": {"source":"apache","compressible":true,"extensions":["rsd"]},
  "application/rss+xml": {"source":"apache","compressible":true,"extensions":["rss"]},
  "application/rtf": {"source":"iana","compressible":true,"extensions":["rtf"]},
  "application/rtploopback": {"source":"iana"},
  "application/rtx": {"source":"iana"},
  "application/samlassertion+xml": {"source":"iana","compressible":true},
  "application/samlmetadata+xml": {"source":"iana","compressible":true},
  "application/sarif+json": {"source":"iana","compressible":true},
  "application/sarif-external-properties+json": {"source":"iana","compressible":true},
  "application/sbe": {"source":"iana"},
  "application/sbml+xml": {"source":"iana","compressible":true,"extensions":["sbml"]},
  "application/scaip+xml": {"source":"iana","compressible":true},
  "application/scim+json": {"source":"iana","compressible":true},
  "application/scvp-cv-request": {"source":"iana","extensions":["scq"]},
  "application/scvp-cv-response": {"source":"iana","extensions":["scs"]},
  "application/scvp-vp-request": {"source":"iana","extensions":["spq"]},
  "application/scvp-vp-response": {"source":"iana","extensions":["spp"]},
  "application/sdp": {"source":"iana","extensions":["sdp"]},
  "application/secevent+jwt": {"source":"iana"},
  "application/senml+cbor": {"source":"iana"},
  "application/senml+json": {"source":"iana","compressible":true},
  "application/senml+xml": {"source":"iana","compressible":true,"extensions":["senmlx"]},
  "application/senml-etch+cbor": {"source":"iana"},
  "application/senml-etch+json": {"source":"iana","compressible":true},
  "application/senml-exi": {"source":"iana"},
  "application/sensml+cbor": {"source":"iana"},
  "application/sensml+json": {"source":"iana","compressible":true},
  "application/sensml+xml": {"source":"iana","compressible":true,"extensions":["sensmlx"]},
  "application/sensml-exi": {"source":"iana"},
  "application/sep+xml": {"source":"iana","compressible":true},
  "application/sep-exi": {"source":"iana"},
  "application/session-info": {"source":"iana"},
  "application/set-payment": {"source":"iana"},
  "application/set-payment-initiation": {"source":"iana","extensions":["setpay"]},
  "application/set-registration": {"source":"iana"},
  "application/set-registration-initiation": {"source":"iana","extensions":["setreg"]},
  "application/sgml": {"source":"iana"},
  "application/sgml-open-catalog": {"source":"iana"},
  "application/shf+xml": {"source":"iana","compressible":true,"extensions":["shf"]},
  "application/sieve": {"source":"iana","extensions":["siv","sieve"]},
  "application/simple-filter+xml": {"source":"iana","compressible":true},
  "application/simple-message-summary": {"source":"iana"},
  "application/simplesymbolcontainer": {"source":"iana"},
  "application/sipc": {"source":"iana"},
  "application/slate": {"source":"iana"},
  "application/smil": {"source":"apache"},
  "application/smil+xml": {"source":"iana","compressible":true,"extensions":["smi","smil"]},
  "application/smpte336m": {"source":"iana"},
  "application/soap+fastinfoset": {"source":"iana"},
  "application/soap+xml": {"source":"iana","compressible":true},
  "application/sparql-query": {"source":"iana","extensions":["rq"]},
  "application/sparql-results+xml": {"source":"iana","compressible":true,"extensions":["srx"]},
  "application/spdx+json": {"source":"iana","compressible":true},
  "application/spirits-event+xml": {"source":"iana","compressible":true},
  "application/sql": {"source":"iana","extensions":["sql"]},
  "application/srgs": {"source":"iana","extensions":["gram"]},
  "application/srgs+xml": {"source":"iana","compressible":true,"extensions":["grxml"]},
  "application/sru+xml": {"source":"iana","compressible":true,"extensions":["sru"]},
  "application/ssdl+xml": {"source":"apache","compressible":true,"extensions":["ssdl"]},
  "application/sslkeylogfile": {"source":"iana"},
  "application/ssml+xml": {"source":"iana","compressible":true,"extensions":["ssml"]},
  "application/st2110-41": {"source":"iana"},
  "application/stix+json": {"source":"iana","compressible":true},
  "application/stratum": {"source":"iana"},
  "application/swid+cbor": {"source":"iana"},
  "application/swid+xml": {"source":"iana","compressible":true,"extensions":["swidtag"]},
  "application/tamp-apex-update": {"source":"iana"},
  "application/tamp-apex-update-confirm": {"source":"iana"},
  "application/tamp-community-update": {"source":"iana"},
  "application/tamp-community-update-confirm": {"source":"iana"},
  "application/tamp-error": {"source":"iana"},
  "application/tamp-sequence-adjust": {"source":"iana"},
  "application/tamp-sequence-adjust-confirm": {"source":"iana"},
  "application/tamp-status-query": {"source":"iana"},
  "application/tamp-status-response": {"source":"iana"},
  "application/tamp-update": {"source":"iana"},
  "application/tamp-update-confirm": {"source":"iana"},
  "application/tar": {"compressible":true},
  "application/taxii+json": {"source":"iana","compressible":true},
  "application/td+json": {"source":"iana","compressible":true},
  "application/tei+xml": {"source":"iana","compressible":true,"extensions":["tei","teicorpus"]},
  "application/tetra_isi": {"source":"iana"},
  "application/thraud+xml": {"source":"iana","compressible":true,"extensions":["tfi"]},
  "application/timestamp-query": {"source":"iana"},
  "application/timestamp-reply": {"source":"iana"},
  "application/timestamped-data": {"source":"iana","extensions":["tsd"]},
  "application/tlsrpt+gzip": {"source":"iana"},
  "application/tlsrpt+json": {"source":"iana","compressible":true},
  "application/tm+json": {"source":"iana","compressible":true},
  "application/tnauthlist": {"source":"iana"},
  "application/toc+cbor": {"source":"iana"},
  "application/token-introspection+jwt": {"source":"iana"},
  "application/toml": {"source":"iana","compressible":true,"extensions":["toml"]},
  "application/trickle-ice-sdpfrag": {"source":"iana"},
  "application/trig": {"source":"iana","extensions":["trig"]},
  "application/trust-chain+json": {"source":"iana","compressible":true},
  "application/trust-mark+jwt": {"source":"iana"},
  "application/trust-mark-delegation+jwt": {"source":"iana"},
  "application/ttml+xml": {"source":"iana","compressible":true,"extensions":["ttml"]},
  "application/tve-trigger": {"source":"iana"},
  "application/tzif": {"source":"iana"},
  "application/tzif-leap": {"source":"iana"},
  "application/ubjson": {"compressible":false,"extensions":["ubj"]},
  "application/uccs+cbor": {"source":"iana"},
  "application/ujcs+json": {"source":"iana","compressible":true},
  "application/ulpfec": {"source":"iana"},
  "application/urc-grpsheet+xml": {"source":"iana","compressible":true},
  "application/urc-ressheet+xml": {"source":"iana","compressible":true,"extensions":["rsheet"]},
  "application/urc-targetdesc+xml": {"source":"iana","compressible":true,"extensions":["td"]},
  "application/urc-uisocketdesc+xml": {"source":"iana","compressible":true},
  "application/vc": {"source":"iana"},
  "application/vc+cose": {"source":"iana"},
  "application/vc+jwt": {"source":"iana"},
  "application/vcard+json": {"source":"iana","compressible":true},
  "application/vcard+xml": {"source":"iana","compressible":true},
  "application/vemmi": {"source":"iana"},
  "application/vividence.scriptfile": {"source":"apache"},
  "application/vnd.1000minds.decision-model+xml": {"source":"iana","compressible":true,"extensions":["1km"]},
  "application/vnd.1ob": {"source":"iana"},
  "application/vnd.3gpp-prose+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp-prose-pc3a+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp-prose-pc3ach+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp-prose-pc3ch+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp-prose-pc8+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp-v2x-local-service-information": {"source":"iana"},
  "application/vnd.3gpp.5gnas": {"source":"iana"},
  "application/vnd.3gpp.5gsa2x": {"source":"iana"},
  "application/vnd.3gpp.5gsa2x-local-service-information": {"source":"iana"},
  "application/vnd.3gpp.5gsv2x": {"source":"iana"},
  "application/vnd.3gpp.5gsv2x-local-service-information": {"source":"iana"},
  "application/vnd.3gpp.access-transfer-events+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.bsf+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.crs+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.current-location-discovery+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.gmop+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.gtpc": {"source":"iana"},
  "application/vnd.3gpp.interworking-data": {"source":"iana"},
  "application/vnd.3gpp.lpp": {"source":"iana"},
  "application/vnd.3gpp.mc-signalling-ear": {"source":"iana"},
  "application/vnd.3gpp.mcdata-affiliation-command+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcdata-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcdata-msgstore-ctrl-request+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcdata-payload": {"source":"iana"},
  "application/vnd.3gpp.mcdata-regroup+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcdata-service-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcdata-signalling": {"source":"iana"},
  "application/vnd.3gpp.mcdata-ue-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcdata-user-profile+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-affiliation-command+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-floor-request+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-location-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-mbms-usage-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-regroup+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-service-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-signed+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-ue-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-ue-init-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcptt-user-profile+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-affiliation-command+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-location-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-mbms-usage-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-regroup+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-service-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-transmission-request+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-ue-config+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mcvideo-user-profile+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.mid-call+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.ngap": {"source":"iana"},
  "application/vnd.3gpp.pfcp": {"source":"iana"},
  "application/vnd.3gpp.pic-bw-large": {"source":"iana","extensions":["plb"]},
  "application/vnd.3gpp.pic-bw-small": {"source":"iana","extensions":["psb"]},
  "application/vnd.3gpp.pic-bw-var": {"source":"iana","extensions":["pvb"]},
  "application/vnd.3gpp.pinapp-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.s1ap": {"source":"iana"},
  "application/vnd.3gpp.seal-group-doc+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-location-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-mbms-usage-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-network-qos-management-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-ue-config-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-unicast-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.seal-user-profile-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.sms": {"source":"iana"},
  "application/vnd.3gpp.sms+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.srvcc-ext+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.srvcc-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.state-and-event-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.ussd+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp.v2x": {"source":"iana"},
  "application/vnd.3gpp.vae-info+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp2.bcmcsinfo+xml": {"source":"iana","compressible":true},
  "application/vnd.3gpp2.sms": {"source":"iana"},
  "application/vnd.3gpp2.tcap": {"source":"iana","extensions":["tcap"]},
  "application/vnd.3lightssoftware.imagescal": {"source":"iana"},
  "application/vnd.3m.post-it-notes": {"source":"iana","extensions":["pwn"]},
  "application/vnd.accpac.simply.aso": {"source":"iana","extensions":["aso"]},
  "application/vnd.accpac.simply.imp": {"source":"iana","extensions":["imp"]},
  "application/vnd.acm.addressxfer+json": {"source":"iana","compressible":true},
  "application/vnd.acm.chatbot+json": {"source":"iana","compressible":true},
  "application/vnd.acucobol": {"source":"iana","extensions":["acu"]},
  "application/vnd.acucorp": {"source":"iana","extensions":["atc","acutc"]},
  "application/vnd.adobe.air-application-installer-package+zip": {"source":"apache","compressible":false,"extensions":["air"]},
  "application/vnd.adobe.flash.movie": {"source":"iana"},
  "application/vnd.adobe.formscentral.fcdt": {"source":"iana","extensions":["fcdt"]},
  "application/vnd.adobe.fxp": {"source":"iana","extensions":["fxp","fxpl"]},
  "application/vnd.adobe.partial-upload": {"source":"iana"},
  "application/vnd.adobe.xdp+xml": {"source":"iana","compressible":true,"extensions":["xdp"]},
  "application/vnd.adobe.xfdf": {"source":"apache","extensions":["xfdf"]},
  "application/vnd.aether.imp": {"source":"iana"},
  "application/vnd.afpc.afplinedata": {"source":"iana"},
  "application/vnd.afpc.afplinedata-pagedef": {"source":"iana"},
  "application/vnd.afpc.cmoca-cmresource": {"source":"iana"},
  "application/vnd.afpc.foca-charset": {"source":"iana"},
  "application/vnd.afpc.foca-codedfont": {"source":"iana"},
  "application/vnd.afpc.foca-codepage": {"source":"iana"},
  "application/vnd.afpc.modca": {"source":"iana"},
  "application/vnd.afpc.modca-cmtable": {"source":"iana"},
  "application/vnd.afpc.modca-formdef": {"source":"iana"},
  "application/vnd.afpc.modca-mediummap": {"source":"iana"},
  "application/vnd.afpc.modca-objectcontainer": {"source":"iana"},
  "application/vnd.afpc.modca-overlay": {"source":"iana"},
  "application/vnd.afpc.modca-pagesegment": {"source":"iana"},
  "application/vnd.age": {"source":"iana","extensions":["age"]},
  "application/vnd.ah-barcode": {"source":"apache"},
  "application/vnd.ahead.space": {"source":"iana","extensions":["ahead"]},
  "application/vnd.airzip.filesecure.azf": {"source":"iana","extensions":["azf"]},
  "application/vnd.airzip.filesecure.azs": {"source":"iana","extensions":["azs"]},
  "application/vnd.amadeus+json": {"source":"iana","compressible":true},
  "application/vnd.amazon.ebook": {"source":"apache","extensions":["azw"]},
  "application/vnd.amazon.mobi8-ebook": {"source":"iana"},
  "application/vnd.americandynamics.acc": {"source":"iana","extensions":["acc"]},
  "application/vnd.amiga.ami": {"source":"iana","extensions":["ami"]},
  "application/vnd.amundsen.maze+xml": {"source":"iana","compressible":true},
  "application/vnd.android.ota": {"source":"iana"},
  "application/vnd.android.package-archive": {"source":"apache","compressible":false,"extensions":["apk"]},
  "application/vnd.anki": {"source":"iana"},
  "application/vnd.anser-web-certificate-issue-initiation": {"source":"iana","extensions":["cii"]},
  "application/vnd.anser-web-funds-transfer-initiation": {"source":"apache","extensions":["fti"]},
  "application/vnd.antix.game-component": {"source":"iana","extensions":["atx"]},
  "application/vnd.apache.arrow.file": {"source":"iana"},
  "application/vnd.apache.arrow.stream": {"source":"iana"},
  "application/vnd.apache.parquet": {"source":"iana"},
  "application/vnd.apache.thrift.binary": {"source":"iana"},
  "application/vnd.apache.thrift.compact": {"source":"iana"},
  "application/vnd.apache.thrift.json": {"source":"iana"},
  "application/vnd.apexlang": {"source":"iana"},
  "application/vnd.api+json": {"source":"iana","compressible":true},
  "application/vnd.aplextor.warrp+json": {"source":"iana","compressible":true},
  "application/vnd.apothekende.reservation+json": {"source":"iana","compressible":true},
  "application/vnd.apple.installer+xml": {"source":"iana","compressible":true,"extensions":["mpkg"]},
  "application/vnd.apple.keynote": {"source":"iana","extensions":["key"]},
  "application/vnd.apple.mpegurl": {"source":"iana","extensions":["m3u8"]},
  "application/vnd.apple.numbers": {"source":"iana","extensions":["numbers"]},
  "application/vnd.apple.pages": {"source":"iana","extensions":["pages"]},
  "application/vnd.apple.pkpass": {"compressible":false,"extensions":["pkpass"]},
  "application/vnd.arastra.swi": {"source":"apache"},
  "application/vnd.aristanetworks.swi": {"source":"iana","extensions":["swi"]},
  "application/vnd.artisan+json": {"source":"iana","compressible":true},
  "application/vnd.artsquare": {"source":"iana"},
  "application/vnd.astraea-software.iota": {"source":"iana","extensions":["iota"]},
  "application/vnd.audiograph": {"source":"iana","extensions":["aep"]},
  "application/vnd.autodesk.fbx": {"extensions":["fbx"]},
  "application/vnd.autopackage": {"source":"iana"},
  "application/vnd.avalon+json": {"source":"iana","compressible":true},
  "application/vnd.avistar+xml": {"source":"iana","compressible":true},
  "application/vnd.balsamiq.bmml+xml": {"source":"iana","compressible":true,"extensions":["bmml"]},
  "application/vnd.balsamiq.bmpr": {"source":"iana"},
  "application/vnd.banana-accounting": {"source":"iana"},
  "application/vnd.bbf.usp.error": {"source":"iana"},
  "application/vnd.bbf.usp.msg": {"source":"iana"},
  "application/vnd.bbf.usp.msg+json": {"source":"iana","compressible":true},
  "application/vnd.bekitzur-stech+json": {"source":"iana","compressible":true},
  "application/vnd.belightsoft.lhzd+zip": {"source":"iana","compressible":false},
  "application/vnd.belightsoft.lhzl+zip": {"source":"iana","compressible":false},
  "application/vnd.bint.med-content": {"source":"iana"},
  "application/vnd.biopax.rdf+xml": {"source":"iana","compressible":true},
  "application/vnd.blink-idb-value-wrapper": {"source":"iana"},
  "application/vnd.blueice.multipass": {"source":"iana","extensions":["mpm"]},
  "application/vnd.bluetooth.ep.oob": {"source":"iana"},
  "application/vnd.bluetooth.le.oob": {"source":"iana"},
  "application/vnd.bmi": {"source":"iana","extensions":["bmi"]},
  "application/vnd.bpf": {"source":"iana"},
  "application/vnd.bpf3": {"source":"iana"},
  "application/vnd.businessobjects": {"source":"iana","extensions":["rep"]},
  "application/vnd.byu.uapi+json": {"source":"iana","compressible":true},
  "application/vnd.bzip3": {"source":"iana"},
  "application/vnd.c3voc.schedule+xml": {"source":"iana","compressible":true},
  "application/vnd.cab-jscript": {"source":"iana"},
  "application/vnd.canon-cpdl": {"source":"iana"},
  "application/vnd.canon-lips": {"source":"iana"},
  "application/vnd.capasystems-pg+json": {"source":"iana","compressible":true},
  "application/vnd.cendio.thinlinc.clientconf": {"source":"iana"},
  "application/vnd.century-systems.tcp_stream": {"source":"iana"},
  "application/vnd.chemdraw+xml": {"source":"iana","compressible":true,"extensions":["cdxml"]},
  "application/vnd.chess-pgn": {"source":"iana"},
  "application/vnd.chipnuts.karaoke-mmd": {"source":"iana","extensions":["mmd"]},
  "application/vnd.ciedi": {"source":"iana"},
  "application/vnd.cinderella": {"source":"iana","extensions":["cdy"]},
  "application/vnd.cirpack.isdn-ext": {"source":"iana"},
  "application/vnd.citationstyles.style+xml": {"source":"iana","compressible":true,"extensions":["csl"]},
  "application/vnd.claymore": {"source":"iana","extensions":["cla"]},
  "application/vnd.cloanto.rp9": {"source":"iana","extensions":["rp9"]},
  "application/vnd.clonk.c4group": {"source":"iana","extensions":["c4g","c4d","c4f","c4p","c4u"]},
  "application/vnd.cluetrust.cartomobile-config": {"source":"iana","extensions":["c11amc"]},
  "application/vnd.cluetrust.cartomobile-config-pkg": {"source":"iana","extensions":["c11amz"]},
  "application/vnd.cncf.helm.chart.content.v1.tar+gzip": {"source":"iana"},
  "application/vnd.cncf.helm.chart.provenance.v1.prov": {"source":"iana"},
  "application/vnd.cncf.helm.config.v1+json": {"source":"iana","compressible":true},
  "application/vnd.coffeescript": {"source":"iana"},
  "application/vnd.collabio.xodocuments.document": {"source":"iana"},
  "application/vnd.collabio.xodocuments.document-template": {"source":"iana"},
  "application/vnd.collabio.xodocuments.presentation": {"source":"iana"},
  "application/vnd.collabio.xodocuments.presentation-template": {"source":"iana"},
  "application/vnd.collabio.xodocuments.spreadsheet": {"source":"iana"},
  "application/vnd.collabio.xodocuments.spreadsheet-template": {"source":"iana"},
  "application/vnd.collection+json": {"source":"iana","compressible":true},
  "application/vnd.collection.doc+json": {"source":"iana","compressible":true},
  "application/vnd.collection.next+json": {"source":"iana","compressible":true},
  "application/vnd.comicbook+zip": {"source":"iana","compressible":false},
  "application/vnd.comicbook-rar": {"source":"iana"},
  "application/vnd.commerce-battelle": {"source":"iana"},
  "application/vnd.commonspace": {"source":"iana","extensions":["csp"]},
  "application/vnd.contact.cmsg": {"source":"iana","extensions":["cdbcmsg"]},
  "application/vnd.coreos.ignition+json": {"source":"iana","compressible":true},
  "application/vnd.cosmocaller": {"source":"iana","extensions":["cmc"]},
  "application/vnd.crick.clicker": {"source":"iana","extensions":["clkx"]},
  "application/vnd.crick.clicker.keyboard": {"source":"iana","extensions":["clkk"]},
  "application/vnd.crick.clicker.palette": {"source":"iana","extensions":["clkp"]},
  "application/vnd.crick.clicker.template": {"source":"iana","extensions":["clkt"]},
  "application/vnd.crick.clicker.wordbank": {"source":"iana","extensions":["clkw"]},
  "application/vnd.criticaltools.wbs+xml": {"source":"iana","compressible":true,"extensions":["wbs"]},
  "application/vnd.cryptii.pipe+json": {"source":"iana","compressible":true},
  "application/vnd.crypto-shade-file": {"source":"iana"},
  "application/vnd.cryptomator.encrypted": {"source":"iana"},
  "application/vnd.cryptomator.vault": {"source":"iana"},
  "application/vnd.ctc-posml": {"source":"iana","extensions":["pml"]},
  "application/vnd.ctct.ws+xml": {"source":"iana","compressible":true},
  "application/vnd.cups-pdf": {"source":"iana"},
  "application/vnd.cups-postscript": {"source":"iana"},
  "application/vnd.cups-ppd": {"source":"iana","extensions":["ppd"]},
  "application/vnd.cups-raster": {"source":"iana"},
  "application/vnd.cups-raw": {"source":"iana"},
  "application/vnd.curl": {"source":"iana"},
  "application/vnd.curl.car": {"source":"apache","extensions":["car"]},
  "application/vnd.curl.pcurl": {"source":"apache","extensions":["pcurl"]},
  "application/vnd.cyan.dean.root+xml": {"source":"iana","compressible":true},
  "application/vnd.cybank": {"source":"iana"},
  "application/vnd.cyclonedx+json": {"source":"iana","compressible":true},
  "application/vnd.cyclonedx+xml": {"source":"iana","compressible":true},
  "application/vnd.d2l.coursepackage1p0+zip": {"source":"iana","compressible":false},
  "application/vnd.d3m-dataset": {"source":"iana"},
  "application/vnd.d3m-problem": {"source":"iana"},
  "application/vnd.dart": {"source":"iana","compressible":true,"extensions":["dart"]},
  "application/vnd.data-vision.rdz": {"source":"iana","extensions":["rdz"]},
  "application/vnd.datalog": {"source":"iana"},
  "application/vnd.datapackage+json": {"source":"iana","compressible":true},
  "application/vnd.dataresource+json": {"source":"iana","compressible":true},
  "application/vnd.dbf": {"source":"iana","extensions":["dbf"]},
  "application/vnd.dcmp+xml": {"source":"iana","compressible":true,"extensions":["dcmp"]},
  "application/vnd.debian.binary-package": {"source":"iana"},
  "application/vnd.dece.data": {"source":"iana","extensions":["uvf","uvvf","uvd","uvvd"]},
  "application/vnd.dece.ttml+xml": {"source":"iana","compressible":true,"extensions":["uvt","uvvt"]},
  "application/vnd.dece.unspecified": {"source":"iana","extensions":["uvx","uvvx"]},
  "application/vnd.dece.zip": {"source":"iana","extensions":["uvz","uvvz"]},
  "application/vnd.denovo.fcselayout-link": {"source":"iana","extensions":["fe_launch"]},
  "application/vnd.desmume.movie": {"source":"iana"},
  "application/vnd.dir-bi.plate-dl-nosuffix": {"source":"iana"},
  "application/vnd.dm.delegation+xml": {"source":"iana","compressible":true},
  "application/vnd.dna": {"source":"iana","extensions":["dna"]},
  "application/vnd.document+json": {"source":"iana","compressible":true},
  "application/vnd.dolby.mlp": {"source":"apache","extensions":["mlp"]},
  "application/vnd.dolby.mobile.1": {"source":"iana"},
  "application/vnd.dolby.mobile.2": {"source":"iana"},
  "application/vnd.doremir.scorecloud-binary-document": {"source":"iana"},
  "application/vnd.dpgraph": {"source":"iana","extensions":["dpg"]},
  "application/vnd.dreamfactory": {"source":"iana","extensions":["dfac"]},
  "application/vnd.drive+json": {"source":"iana","compressible":true},
  "application/vnd.ds-keypoint": {"source":"apache","extensions":["kpxx"]},
  "application/vnd.dtg.local": {"source":"iana"},
  "application/vnd.dtg.local.flash": {"source":"iana"},
  "application/vnd.dtg.local.html": {"source":"iana"},
  "application/vnd.dvb.ait": {"source":"iana","extensions":["ait"]},
  "application/vnd.dvb.dvbisl+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.dvbj": {"source":"iana"},
  "application/vnd.dvb.esgcontainer": {"source":"iana"},
  "application/vnd.dvb.ipdcdftnotifaccess": {"source":"iana"},
  "application/vnd.dvb.ipdcesgaccess": {"source":"iana"},
  "application/vnd.dvb.ipdcesgaccess2": {"source":"iana"},
  "application/vnd.dvb.ipdcesgpdd": {"source":"iana"},
  "application/vnd.dvb.ipdcroaming": {"source":"iana"},
  "application/vnd.dvb.iptv.alfec-base": {"source":"iana"},
  "application/vnd.dvb.iptv.alfec-enhancement": {"source":"iana"},
  "application/vnd.dvb.notif-aggregate-root+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.notif-container+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.notif-generic+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.notif-ia-msglist+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.notif-ia-registration-request+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.notif-ia-registration-response+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.notif-init+xml": {"source":"iana","compressible":true},
  "application/vnd.dvb.pfr": {"source":"iana"},
  "application/vnd.dvb.service": {"source":"iana","extensions":["svc"]},
  "application/vnd.dxr": {"source":"iana"},
  "application/vnd.dynageo": {"source":"iana","extensions":["geo"]},
  "application/vnd.dzr": {"source":"iana"},
  "application/vnd.easykaraoke.cdgdownload": {"source":"iana"},
  "application/vnd.ecdis-update": {"source":"iana"},
  "application/vnd.ecip.rlp": {"source":"iana"},
  "application/vnd.eclipse.ditto+json": {"source":"iana","compressible":true},
  "application/vnd.ecowin.chart": {"source":"iana","extensions":["mag"]},
  "application/vnd.ecowin.filerequest": {"source":"iana"},
  "application/vnd.ecowin.fileupdate": {"source":"iana"},
  "application/vnd.ecowin.series": {"source":"iana"},
  "application/vnd.ecowin.seriesrequest": {"source":"iana"},
  "application/vnd.ecowin.seriesupdate": {"source":"iana"},
  "application/vnd.efi.img": {"source":"iana"},
  "application/vnd.efi.iso": {"source":"iana"},
  "application/vnd.eln+zip": {"source":"iana","compressible":false},
  "application/vnd.emclient.accessrequest+xml": {"source":"iana","compressible":true},
  "application/vnd.enliven": {"source":"iana","extensions":["nml"]},
  "application/vnd.enphase.envoy": {"source":"iana"},
  "application/vnd.eprints.data+xml": {"source":"iana","compressible":true},
  "application/vnd.epson.esf": {"source":"iana","extensions":["esf"]},
  "application/vnd.epson.msf": {"source":"iana","extensions":["msf"]},
  "application/vnd.epson.quickanime": {"source":"iana","extensions":["qam"]},
  "application/vnd.epson.salt": {"source":"iana","extensions":["slt"]},
  "application/vnd.epson.ssf": {"source":"iana","extensions":["ssf"]},
  "application/vnd.ericsson.quickcall": {"source":"iana"},
  "application/vnd.erofs": {"source":"iana"},
  "application/vnd.espass-espass+zip": {"source":"iana","compressible":false},
  "application/vnd.eszigno3+xml": {"source":"iana","compressible":true,"extensions":["es3","et3"]},
  "application/vnd.etsi.aoc+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.asic-e+zip": {"source":"iana","compressible":false},
  "application/vnd.etsi.asic-s+zip": {"source":"iana","compressible":false},
  "application/vnd.etsi.cug+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvcommand+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvdiscovery+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvprofile+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvsad-bc+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvsad-cod+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvsad-npvr+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvservice+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvsync+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.iptvueprofile+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.mcid+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.mheg5": {"source":"iana"},
  "application/vnd.etsi.overload-control-policy-dataset+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.pstn+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.sci+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.simservs+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.timestamp-token": {"source":"iana"},
  "application/vnd.etsi.tsl+xml": {"source":"iana","compressible":true},
  "application/vnd.etsi.tsl.der": {"source":"iana"},
  "application/vnd.eu.kasparian.car+json": {"source":"iana","compressible":true},
  "application/vnd.eudora.data": {"source":"iana"},
  "application/vnd.evolv.ecig.profile": {"source":"iana"},
  "application/vnd.evolv.ecig.settings": {"source":"iana"},
  "application/vnd.evolv.ecig.theme": {"source":"iana"},
  "application/vnd.exstream-empower+zip": {"source":"iana","compressible":false},
  "application/vnd.exstream-package": {"source":"iana"},
  "application/vnd.ezpix-album": {"source":"iana","extensions":["ez2"]},
  "application/vnd.ezpix-package": {"source":"iana","extensions":["ez3"]},
  "application/vnd.f-secure.mobile": {"source":"iana"},
  "application/vnd.familysearch.gedcom+zip": {"source":"iana","compressible":false},
  "application/vnd.fastcopy-disk-image": {"source":"iana"},
  "application/vnd.fdf": {"source":"apache","extensions":["fdf"]},
  "application/vnd.fdsn.mseed": {"source":"iana","extensions":["mseed"]},
  "application/vnd.fdsn.seed": {"source":"iana","extensions":["seed","dataless"]},
  "application/vnd.fdsn.stationxml+xml": {"source":"iana","charset":"XML-BASED","compressible":true},
  "application/vnd.ffsns": {"source":"iana"},
  "application/vnd.ficlab.flb+zip": {"source":"iana","compressible":false},
  "application/vnd.filmit.zfc": {"source":"iana"},
  "application/vnd.fints": {"source":"iana"},
  "application/vnd.firemonkeys.cloudcell": {"source":"iana"},
  "application/vnd.flographit": {"source":"iana","extensions":["gph"]},
  "application/vnd.fluxtime.clip": {"source":"iana","extensions":["ftc"]},
  "application/vnd.font-fontforge-sfd": {"source":"iana"},
  "application/vnd.framemaker": {"source":"iana","extensions":["fm","frame","maker","book"]},
  "application/vnd.freelog.comic": {"source":"iana"},
  "application/vnd.frogans.fnc": {"source":"apache","extensions":["fnc"]},
  "application/vnd.frogans.ltf": {"source":"apache","extensions":["ltf"]},
  "application/vnd.fsc.weblaunch": {"source":"iana","extensions":["fsc"]},
  "application/vnd.fujifilm.fb.docuworks": {"source":"iana"},
  "application/vnd.fujifilm.fb.docuworks.binder": {"source":"iana"},
  "application/vnd.fujifilm.fb.docuworks.container": {"source":"iana"},
  "application/vnd.fujifilm.fb.jfi+xml": {"source":"iana","compressible":true},
  "application/vnd.fujitsu.oasys": {"source":"iana","extensions":["oas"]},
  "application/vnd.fujitsu.oasys2": {"source":"iana","extensions":["oa2"]},
  "application/vnd.fujitsu.oasys3": {"source":"iana","extensions":["oa3"]},
  "application/vnd.fujitsu.oasysgp": {"source":"iana","extensions":["fg5"]},
  "application/vnd.fujitsu.oasysprs": {"source":"iana","extensions":["bh2"]},
  "application/vnd.fujixerox.art-ex": {"source":"iana"},
  "application/vnd.fujixerox.art4": {"source":"iana"},
  "application/vnd.fujixerox.ddd": {"source":"iana","extensions":["ddd"]},
  "application/vnd.fujixerox.docuworks": {"source":"iana","extensions":["xdw"]},
  "application/vnd.fujixerox.docuworks.binder": {"source":"iana","extensions":["xbd"]},
  "application/vnd.fujixerox.docuworks.container": {"source":"iana"},
  "application/vnd.fujixerox.hbpl": {"source":"iana"},
  "application/vnd.fut-misnet": {"source":"iana"},
  "application/vnd.futoin+cbor": {"source":"iana"},
  "application/vnd.futoin+json": {"source":"iana","compressible":true},
  "application/vnd.fuzzysheet": {"source":"iana","extensions":["fzs"]},
  "application/vnd.ga4gh.passport+jwt": {"source":"iana"},
  "application/vnd.genomatix.tuxedo": {"source":"iana","extensions":["txd"]},
  "application/vnd.genozip": {"source":"iana"},
  "application/vnd.gentics.grd+json": {"source":"iana","compressible":true},
  "application/vnd.gentoo.catmetadata+xml": {"source":"iana","compressible":true},
  "application/vnd.gentoo.ebuild": {"source":"iana"},
  "application/vnd.gentoo.eclass": {"source":"iana"},
  "application/vnd.gentoo.gpkg": {"source":"iana"},
  "application/vnd.gentoo.manifest": {"source":"iana"},
  "application/vnd.gentoo.pkgmetadata+xml": {"source":"iana","compressible":true},
  "application/vnd.gentoo.xpak": {"source":"iana"},
  "application/vnd.geo+json": {"source":"apache","compressible":true},
  "application/vnd.geocube+xml": {"source":"apache","compressible":true},
  "application/vnd.geogebra.file": {"source":"iana","extensions":["ggb"]},
  "application/vnd.geogebra.pinboard": {"source":"iana"},
  "application/vnd.geogebra.slides": {"source":"iana","extensions":["ggs"]},
  "application/vnd.geogebra.tool": {"source":"iana","extensions":["ggt"]},
  "application/vnd.geometry-explorer": {"source":"iana","extensions":["gex","gre"]},
  "application/vnd.geonext": {"source":"iana","extensions":["gxt"]},
  "application/vnd.geoplan": {"source":"iana","extensions":["g2w"]},
  "application/vnd.geospace": {"source":"iana","extensions":["g3w"]},
  "application/vnd.gerber": {"source":"iana"},
  "application/vnd.globalplatform.card-content-mgt": {"source":"iana"},
  "application/vnd.globalplatform.card-content-mgt-response": {"source":"iana"},
  "application/vnd.gmx": {"source":"iana","extensions":["gmx"]},
  "application/vnd.gnu.taler.exchange+json": {"source":"iana","compressible":true},
  "application/vnd.gnu.taler.merchant+json": {"source":"iana","compressible":true},
  "application/vnd.google-apps.audio": {},
  "application/vnd.google-apps.document": {"compressible":false,"extensions":["gdoc"]},
  "application/vnd.google-apps.drawing": {"compressible":false,"extensions":["gdraw"]},
  "application/vnd.google-apps.drive-sdk": {"compressible":false},
  "application/vnd.google-apps.file": {},
  "application/vnd.google-apps.folder": {"compressible":false},
  "application/vnd.google-apps.form": {"compressible":false,"extensions":["gform"]},
  "application/vnd.google-apps.fusiontable": {},
  "application/vnd.google-apps.jam": {"compressible":false,"extensions":["gjam"]},
  "application/vnd.google-apps.mail-layout": {},
  "application/vnd.google-apps.map": {"compressible":false,"extensions":["gmap"]},
  "application/vnd.google-apps.photo": {},
  "application/vnd.google-apps.presentation": {"compressible":false,"extensions":["gslides"]},
  "application/vnd.google-apps.script": {"compressible":false,"extensions":["gscript"]},
  "application/vnd.google-apps.shortcut": {},
  "application/vnd.google-apps.site": {"compressible":false,"extensions":["gsite"]},
  "application/vnd.google-apps.spreadsheet": {"compressible":false,"extensions":["gsheet"]},
  "application/vnd.google-apps.unknown": {},
  "application/vnd.google-apps.video": {},
  "application/vnd.google-earth.kml+xml": {"source":"iana","compressible":true,"extensions":["kml"]},
  "application/vnd.google-earth.kmz": {"source":"iana","compressible":false,"extensions":["kmz"]},
  "application/vnd.gov.sk.e-form+xml": {"source":"apache","compressible":true},
  "application/vnd.gov.sk.e-form+zip": {"source":"iana","compressible":false},
  "application/vnd.gov.sk.xmldatacontainer+xml": {"source":"iana","compressible":true,"extensions":["xdcf"]},
  "application/vnd.gpxsee.map+xml": {"source":"iana","compressible":true},
  "application/vnd.grafeq": {"source":"iana","extensions":["gqf","gqs"]},
  "application/vnd.gridmp": {"source":"iana"},
  "application/vnd.groove-account": {"source":"iana","extensions":["gac"]},
  "application/vnd.groove-help": {"source":"iana","extensions":["ghf"]},
  "application/vnd.groove-identity-message": {"source":"iana","extensions":["gim"]},
  "application/vnd.groove-injector": {"source":"iana","extensions":["grv"]},
  "application/vnd.groove-tool-message": {"source":"iana","extensions":["gtm"]},
  "application/vnd.groove-tool-template": {"source":"iana","extensions":["tpl"]},
  "application/vnd.groove-vcard": {"source":"iana","extensions":["vcg"]},
  "application/vnd.hal+json": {"source":"iana","compressible":true},
  "application/vnd.hal+xml": {"source":"iana","compressible":true,"extensions":["hal"]},
  "application/vnd.handheld-entertainment+xml": {"source":"iana","compressible":true,"extensions":["zmm"]},
  "application/vnd.hbci": {"source":"iana","extensions":["hbci"]},
  "application/vnd.hc+json": {"source":"iana","compressible":true},
  "application/vnd.hcl-bireports": {"source":"iana"},
  "application/vnd.hdt": {"source":"iana"},
  "application/vnd.heroku+json": {"source":"iana","compressible":true},
  "application/vnd.hhe.lesson-player": {"source":"iana","extensions":["les"]},
  "application/vnd.hp-hpgl": {"source":"iana","extensions":["hpgl"]},
  "application/vnd.hp-hpid": {"source":"iana","extensions":["hpid"]},
  "application/vnd.hp-hps": {"source":"iana","extensions":["hps"]},
  "application/vnd.hp-jlyt": {"source":"iana","extensions":["jlt"]},
  "application/vnd.hp-pcl": {"source":"iana","extensions":["pcl"]},
  "application/vnd.hp-pclxl": {"source":"iana","extensions":["pclxl"]},
  "application/vnd.hsl": {"source":"iana"},
  "application/vnd.httphone": {"source":"iana"},
  "application/vnd.hydrostatix.sof-data": {"source":"iana","extensions":["sfd-hdstx"]},
  "application/vnd.hyper+json": {"source":"iana","compressible":true},
  "application/vnd.hyper-item+json": {"source":"iana","compressible":true},
  "application/vnd.hyperdrive+json": {"source":"iana","compressible":true},
  "application/vnd.hzn-3d-crossword": {"source":"iana"},
  "application/vnd.ibm.afplinedata": {"source":"apache"},
  "application/vnd.ibm.electronic-media": {"source":"iana"},
  "application/vnd.ibm.minipay": {"source":"iana","extensions":["mpy"]},
  "application/vnd.ibm.modcap": {"source":"apache","extensions":["afp","listafp","list3820"]},
  "application/vnd.ibm.rights-management": {"source":"iana","extensions":["irm"]},
  "application/vnd.ibm.secure-container": {"source":"iana","extensions":["sc"]},
  "application/vnd.iccprofile": {"source":"iana","extensions":["icc","icm"]},
  "application/vnd.ieee.1905": {"source":"iana"},
  "application/vnd.igloader": {"source":"iana","extensions":["igl"]},
  "application/vnd.imagemeter.folder+zip": {"source":"iana","compressible":false},
  "application/vnd.imagemeter.image+zip": {"source":"iana","compressible":false},
  "application/vnd.immervision-ivp": {"source":"iana","extensions":["ivp"]},
  "application/vnd.immervision-ivu": {"source":"iana","extensions":["ivu"]},
  "application/vnd.ims.imsccv1p1": {"source":"iana"},
  "application/vnd.ims.imsccv1p2": {"source":"iana"},
  "application/vnd.ims.imsccv1p3": {"source":"iana"},
  "application/vnd.ims.lis.v2.result+json": {"source":"iana","compressible":true},
  "application/vnd.ims.lti.v2.toolconsumerprofile+json": {"source":"iana","compressible":true},
  "application/vnd.ims.lti.v2.toolproxy+json": {"source":"iana","compressible":true},
  "application/vnd.ims.lti.v2.toolproxy.id+json": {"source":"iana","compressible":true},
  "application/vnd.ims.lti.v2.toolsettings+json": {"source":"iana","compressible":true},
  "application/vnd.ims.lti.v2.toolsettings.simple+json": {"source":"iana","compressible":true},
  "application/vnd.informedcontrol.rms+xml": {"source":"iana","compressible":true},
  "application/vnd.informix-visionary": {"source":"apache"},
  "application/vnd.infotech.project": {"source":"iana"},
  "application/vnd.infotech.project+xml": {"source":"iana","compressible":true},
  "application/vnd.innopath.wamp.notification": {"source":"iana"},
  "application/vnd.insors.igm": {"source":"iana","extensions":["igm"]},
  "application/vnd.intercon.formnet": {"source":"iana","extensions":["xpw","xpx"]},
  "application/vnd.intergeo": {"source":"iana","extensions":["i2g"]},
  "application/vnd.intertrust.digibox": {"source":"iana"},
  "application/vnd.intertrust.nncp": {"source":"iana"},
  "application/vnd.intu.qbo": {"source":"iana","extensions":["qbo"]},
  "application/vnd.intu.qfx": {"source":"iana","extensions":["qfx"]},
  "application/vnd.ipfs.ipns-record": {"source":"iana"},
  "application/vnd.ipld.car": {"source":"iana"},
  "application/vnd.ipld.dag-cbor": {"source":"iana"},
  "application/vnd.ipld.dag-json": {"source":"iana"},
  "application/vnd.ipld.raw": {"source":"iana"},
  "application/vnd.iptc.g2.catalogitem+xml": {"source":"iana","compressible":true},
  "application/vnd.iptc.g2.conceptitem+xml": {"source":"iana","compressible":true},
  "application/vnd.iptc.g2.knowledgeitem+xml": {"source":"iana","compressible":true},
  "application/vnd.iptc.g2.newsitem+xml": {"source":"iana","compressible":true},
  "application/vnd.iptc.g2.newsmessage+xml": {"source":"iana","compressible":true},
  "application/vnd.iptc.g2.packageitem+xml": {"source":"iana","compressible":true},
  "application/vnd.iptc.g2.planningitem+xml": {"source":"iana","compressible":true},
  "application/vnd.ipunplugged.rcprofile": {"source":"iana","extensions":["rcprofile"]},
  "application/vnd.irepository.package+xml": {"source":"iana","compressible":true,"extensions":["irp"]},
  "application/vnd.is-xpr": {"source":"iana","extensions":["xpr"]},
  "application/vnd.isac.fcs": {"source":"iana","extensions":["fcs"]},
  "application/vnd.iso11783-10+zip": {"source":"iana","compressible":false},
  "application/vnd.jam": {"source":"iana","extensions":["jam"]},
  "application/vnd.japannet-directory-service": {"source":"iana"},
  "application/vnd.japannet-jpnstore-wakeup": {"source":"iana"},
  "application/vnd.japannet-payment-wakeup": {"source":"iana"},
  "application/vnd.japannet-registration": {"source":"iana"},
  "application/vnd.japannet-registration-wakeup": {"source":"iana"},
  "application/vnd.japannet-setstore-wakeup": {"source":"iana"},
  "application/vnd.japannet-verification": {"source":"iana"},
  "application/vnd.japannet-verification-wakeup": {"source":"iana"},
  "application/vnd.jcp.javame.midlet-rms": {"source":"iana","extensions":["rms"]},
  "application/vnd.jisp": {"source":"iana","extensions":["jisp"]},
  "application/vnd.joost.joda-archive": {"source":"iana","extensions":["joda"]},
  "application/vnd.jsk.isdn-ngn": {"source":"iana"},
  "application/vnd.kahootz": {"source":"iana","extensions":["ktz","ktr"]},
  "application/vnd.kde.karbon": {"source":"iana","extensions":["karbon"]},
  "application/vnd.kde.kchart": {"source":"iana","extensions":["chrt"]},
  "application/vnd.kde.kformula": {"source":"iana","extensions":["kfo"]},
  "application/vnd.kde.kivio": {"source":"iana","extensions":["flw"]},
  "application/vnd.kde.kontour": {"source":"iana","extensions":["kon"]},
  "application/vnd.kde.kpresenter": {"source":"iana","extensions":["kpr","kpt"]},
  "application/vnd.kde.kspread": {"source":"iana","extensions":["ksp"]},
  "application/vnd.kde.kword": {"source":"iana","extensions":["kwd","kwt"]},
  "application/vnd.kdl": {"source":"iana"},
  "application/vnd.kenameaapp": {"source":"iana","extensions":["htke"]},
  "application/vnd.keyman.kmp+zip": {"source":"iana","compressible":false},
  "application/vnd.keyman.kmx": {"source":"iana"},
  "application/vnd.kidspiration": {"source":"iana","extensions":["kia"]},
  "application/vnd.kinar": {"source":"iana","extensions":["kne","knp"]},
  "application/vnd.koan": {"source":"iana","extensions":["skp","skd","skt","skm"]},
  "application/vnd.kodak-descriptor": {"source":"iana","extensions":["sse"]},
  "application/vnd.las": {"source":"iana"},
  "application/vnd.las.las+json": {"source":"iana","compressible":true},
  "application/vnd.las.las+xml": {"source":"iana","compressible":true,"extensions":["lasxml"]},
  "application/vnd.laszip": {"source":"iana"},
  "application/vnd.ldev.productlicensing": {"source":"iana"},
  "application/vnd.leap+json": {"source":"iana","compressible":true},
  "application/vnd.liberty-request+xml": {"source":"iana","compressible":true},
  "application/vnd.llamagraphics.life-balance.desktop": {"source":"iana","extensions":["lbd"]},
  "application/vnd.llamagraphics.life-balance.exchange+xml": {"source":"iana","compressible":true,"extensions":["lbe"]},
  "application/vnd.logipipe.circuit+zip": {"source":"iana","compressible":false},
  "application/vnd.loom": {"source":"iana"},
  "application/vnd.lotus-1-2-3": {"source":"iana","extensions":["123"]},
  "application/vnd.lotus-approach": {"source":"iana","extensions":["apr"]},
  "application/vnd.lotus-freelance": {"source":"iana","extensions":["pre"]},
  "application/vnd.lotus-notes": {"source":"iana","extensions":["nsf"]},
  "application/vnd.lotus-organizer": {"source":"iana","extensions":["org"]},
  "application/vnd.lotus-screencam": {"source":"iana","extensions":["scm"]},
  "application/vnd.lotus-wordpro": {"source":"iana","extensions":["lwp"]},
  "application/vnd.macports.portpkg": {"source":"iana","extensions":["portpkg"]},
  "application/vnd.mapbox-vector-tile": {"source":"iana","extensions":["mvt"]},
  "application/vnd.marlin.drm.actiontoken+xml": {"source":"iana","compressible":true},
  "application/vnd.marlin.drm.conftoken+xml": {"source":"iana","compressible":true},
  "application/vnd.marlin.drm.license+xml": {"source":"iana","compressible":true},
  "application/vnd.marlin.drm.mdcf": {"source":"iana"},
  "application/vnd.mason+json": {"source":"iana","compressible":true},
  "application/vnd.maxar.archive.3tz+zip": {"source":"iana","compressible":false},
  "application/vnd.maxmind.maxmind-db": {"source":"iana"},
  "application/vnd.mcd": {"source":"iana","extensions":["mcd"]},
  "application/vnd.mdl": {"source":"iana"},
  "application/vnd.mdl-mbsdf": {"source":"iana"},
  "application/vnd.medcalcdata": {"source":"iana","extensions":["mc1"]},
  "application/vnd.mediastation.cdkey": {"source":"iana","extensions":["cdkey"]},
  "application/vnd.medicalholodeck.recordxr": {"source":"iana"},
  "application/vnd.meridian-slingshot": {"source":"iana"},
  "application/vnd.mermaid": {"source":"iana"},
  "application/vnd.mfer": {"source":"iana","extensions":["mwf"]},
  "application/vnd.mfmp": {"source":"iana","extensions":["mfm"]},
  "application/vnd.micro+json": {"source":"iana","compressible":true},
  "application/vnd.micrografx.flo": {"source":"iana","extensions":["flo"]},
  "application/vnd.micrografx.igx": {"source":"iana","extensions":["igx"]},
  "application/vnd.microsoft.portable-executable": {"source":"iana"},
  "application/vnd.microsoft.windows.thumbnail-cache": {"source":"iana"},
  "application/vnd.miele+json": {"source":"iana","compressible":true},
  "application/vnd.mif": {"source":"iana","extensions":["mif"]},
  "application/vnd.minisoft-hp3000-save": {"source":"iana"},
  "application/vnd.mitsubishi.misty-guard.trustweb": {"source":"iana"},
  "application/vnd.mobius.daf": {"source":"iana","extensions":["daf"]},
  "application/vnd.mobius.dis": {"source":"iana","extensions":["dis"]},
  "application/vnd.mobius.mbk": {"source":"iana","extensions":["mbk"]},
  "application/vnd.mobius.mqy": {"source":"iana","extensions":["mqy"]},
  "application/vnd.mobius.msl": {"source":"iana","extensions":["msl"]},
  "application/vnd.mobius.plc": {"source":"iana","extensions":["plc"]},
  "application/vnd.mobius.txf": {"source":"iana","extensions":["txf"]},
  "application/vnd.modl": {"source":"iana"},
  "application/vnd.mophun.application": {"source":"iana","extensions":["mpn"]},
  "application/vnd.mophun.certificate": {"source":"iana","extensions":["mpc"]},
  "application/vnd.motorola.flexsuite": {"source":"iana"},
  "application/vnd.motorola.flexsuite.adsi": {"source":"iana"},
  "application/vnd.motorola.flexsuite.fis": {"source":"iana"},
  "application/vnd.motorola.flexsuite.gotap": {"source":"iana"},
  "application/vnd.motorola.flexsuite.kmr": {"source":"iana"},
  "application/vnd.motorola.flexsuite.ttc": {"source":"iana"},
  "application/vnd.motorola.flexsuite.wem": {"source":"iana"},
  "application/vnd.motorola.iprm": {"source":"iana"},
  "application/vnd.mozilla.xul+xml": {"source":"iana","compressible":true,"extensions":["xul"]},
  "application/vnd.ms-3mfdocument": {"source":"iana"},
  "application/vnd.ms-artgalry": {"source":"iana","extensions":["cil"]},
  "application/vnd.ms-asf": {"source":"iana"},
  "application/vnd.ms-cab-compressed": {"source":"iana","extensions":["cab"]},
  "application/vnd.ms-color.iccprofile": {"source":"apache"},
  "application/vnd.ms-excel": {"source":"iana","compressible":false,"extensions":["xls","xlm","xla","xlc","xlt","xlw"]},
  "application/vnd.ms-excel.addin.macroenabled.12": {"source":"iana","extensions":["xlam"]},
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": {"source":"iana","extensions":["xlsb"]},
  "application/vnd.ms-excel.sheet.macroenabled.12": {"source":"iana","extensions":["xlsm"]},
  "application/vnd.ms-excel.template.macroenabled.12": {"source":"iana","extensions":["xltm"]},
  "application/vnd.ms-fontobject": {"source":"iana","compressible":true,"extensions":["eot"]},
  "application/vnd.ms-htmlhelp": {"source":"iana","extensions":["chm"]},
  "application/vnd.ms-ims": {"source":"iana","extensions":["ims"]},
  "application/vnd.ms-lrm": {"source":"iana","extensions":["lrm"]},
  "application/vnd.ms-office.activex+xml": {"source":"iana","compressible":true},
  "application/vnd.ms-officetheme": {"source":"iana","extensions":["thmx"]},
  "application/vnd.ms-opentype": {"source":"apache","compressible":true},
  "application/vnd.ms-outlook": {"compressible":false,"extensions":["msg"]},
  "application/vnd.ms-package.obfuscated-opentype": {"source":"apache"},
  "application/vnd.ms-pki.seccat": {"source":"apache","extensions":["cat"]},
  "application/vnd.ms-pki.stl": {"source":"apache","extensions":["stl"]},
  "application/vnd.ms-playready.initiator+xml": {"source":"iana","compressible":true},
  "application/vnd.ms-powerpoint": {"source":"iana","compressible":false,"extensions":["ppt","pps","pot"]},
  "application/vnd.ms-powerpoint.addin.macroenabled.12": {"source":"iana","extensions":["ppam"]},
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": {"source":"iana","extensions":["pptm"]},
  "application/vnd.ms-powerpoint.slide.macroenabled.12": {"source":"iana","extensions":["sldm"]},
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12": {"source":"iana","extensions":["ppsm"]},
  "application/vnd.ms-powerpoint.template.macroenabled.12": {"source":"iana","extensions":["potm"]},
  "application/vnd.ms-printdevicecapabilities+xml": {"source":"iana","compressible":true},
  "application/vnd.ms-printing.printticket+xml": {"source":"apache","compressible":true},
  "application/vnd.ms-printschematicket+xml": {"source":"iana","compressible":true},
  "application/vnd.ms-project": {"source":"iana","extensions":["mpp","mpt"]},
  "application/vnd.ms-tnef": {"source":"iana"},
  "application/vnd.ms-visio.viewer": {"extensions":["vdx"]},
  "application/vnd.ms-windows.devicepairing": {"source":"iana"},
  "application/vnd.ms-windows.nwprinting.oob": {"source":"iana"},
  "application/vnd.ms-windows.printerpairing": {"source":"iana"},
  "application/vnd.ms-windows.wsd.oob": {"source":"iana"},
  "application/vnd.ms-wmdrm.lic-chlg-req": {"source":"iana"},
  "application/vnd.ms-wmdrm.lic-resp": {"source":"iana"},
  "application/vnd.ms-wmdrm.meter-chlg-req": {"source":"iana"},
  "application/vnd.ms-wmdrm.meter-resp": {"source":"iana"},
  "application/vnd.ms-word.document.macroenabled.12": {"source":"iana","extensions":["docm"]},
  "application/vnd.ms-word.template.macroenabled.12": {"source":"iana","extensions":["dotm"]},
  "application/vnd.ms-works": {"source":"iana","extensions":["wps","wks","wcm","wdb"]},
  "application/vnd.ms-wpl": {"source":"iana","extensions":["wpl"]},
  "application/vnd.ms-xpsdocument": {"source":"iana","compressible":false,"extensions":["xps"]},
  "application/vnd.msa-disk-image": {"source":"iana"},
  "application/vnd.mseq": {"source":"iana","extensions":["mseq"]},
  "application/vnd.msgpack": {"source":"iana"},
  "application/vnd.msign": {"source":"iana"},
  "application/vnd.multiad.creator": {"source":"iana"},
  "application/vnd.multiad.creator.cif": {"source":"iana"},
  "application/vnd.music-niff": {"source":"iana"},
  "application/vnd.musician": {"source":"iana","extensions":["mus"]},
  "application/vnd.muvee.style": {"source":"iana","extensions":["msty"]},
  "application/vnd.mynfc": {"source":"iana","extensions":["taglet"]},
  "application/vnd.nacamar.ybrid+json": {"source":"iana","compressible":true},
  "application/vnd.nato.bindingdataobject+cbor": {"source":"iana"},
  "application/vnd.nato.bindingdataobject+json": {"source":"iana","compressible":true},
  "application/vnd.nato.bindingdataobject+xml": {"source":"iana","compressible":true,"extensions":["bdo"]},
  "application/vnd.nato.openxmlformats-package.iepd+zip": {"source":"iana","compressible":false},
  "application/vnd.ncd.control": {"source":"iana"},
  "application/vnd.ncd.reference": {"source":"iana"},
  "application/vnd.nearst.inv+json": {"source":"iana","compressible":true},
  "application/vnd.nebumind.line": {"source":"iana"},
  "application/vnd.nervana": {"source":"iana"},
  "application/vnd.netfpx": {"source":"iana"},
  "application/vnd.neurolanguage.nlu": {"source":"iana","extensions":["nlu"]},
  "application/vnd.nimn": {"source":"iana"},
  "application/vnd.nintendo.nitro.rom": {"source":"iana"},
  "application/vnd.nintendo.snes.rom": {"source":"iana"},
  "application/vnd.nitf": {"source":"iana","extensions":["ntf","nitf"]},
  "application/vnd.noblenet-directory": {"source":"iana","extensions":["nnd"]},
  "application/vnd.noblenet-sealer": {"source":"iana","extensions":["nns"]},
  "application/vnd.noblenet-web": {"source":"iana","extensions":["nnw"]},
  "application/vnd.nokia.catalogs": {"source":"iana"},
  "application/vnd.nokia.conml+wbxml": {"source":"iana"},
  "application/vnd.nokia.conml+xml": {"source":"iana","compressible":true},
  "application/vnd.nokia.iptv.config+xml": {"source":"iana","compressible":true},
  "application/vnd.nokia.isds-radio-presets": {"source":"iana"},
  "application/vnd.nokia.landmark+wbxml": {"source":"iana"},
  "application/vnd.nokia.landmark+xml": {"source":"iana","compressible":true},
  "application/vnd.nokia.landmarkcollection+xml": {"source":"iana","compressible":true},
  "application/vnd.nokia.n-gage.ac+xml": {"source":"iana","compressible":true,"extensions":["ac"]},
  "application/vnd.nokia.n-gage.data": {"source":"iana","extensions":["ngdat"]},
  "application/vnd.nokia.n-gage.symbian.install": {"source":"apache","extensions":["n-gage"]},
  "application/vnd.nokia.ncd": {"source":"iana"},
  "application/vnd.nokia.pcd+wbxml": {"source":"iana"},
  "application/vnd.nokia.pcd+xml": {"source":"iana","compressible":true},
  "application/vnd.nokia.radio-preset": {"source":"iana","extensions":["rpst"]},
  "application/vnd.nokia.radio-presets": {"source":"iana","extensions":["rpss"]},
  "application/vnd.novadigm.edm": {"source":"iana","extensions":["edm"]},
  "application/vnd.novadigm.edx": {"source":"iana","extensions":["edx"]},
  "application/vnd.novadigm.ext": {"source":"iana","extensions":["ext"]},
  "application/vnd.ntt-local.content-share": {"source":"iana"},
  "application/vnd.ntt-local.file-transfer": {"source":"iana"},
  "application/vnd.ntt-local.ogw_remote-access": {"source":"iana"},
  "application/vnd.ntt-local.sip-ta_remote": {"source":"iana"},
  "application/vnd.ntt-local.sip-ta_tcp_stream": {"source":"iana"},
  "application/vnd.oai.workflows": {"source":"iana"},
  "application/vnd.oai.workflows+json": {"source":"iana","compressible":true},
  "application/vnd.oai.workflows+yaml": {"source":"iana"},
  "application/vnd.oasis.opendocument.base": {"source":"iana"},
  "application/vnd.oasis.opendocument.chart": {"source":"iana","extensions":["odc"]},
  "application/vnd.oasis.opendocument.chart-template": {"source":"iana","extensions":["otc"]},
  "application/vnd.oasis.opendocument.database": {"source":"apache","extensions":["odb"]},
  "application/vnd.oasis.opendocument.formula": {"source":"iana","extensions":["odf"]},
  "application/vnd.oasis.opendocument.formula-template": {"source":"iana","extensions":["odft"]},
  "application/vnd.oasis.opendocument.graphics": {"source":"iana","compressible":false,"extensions":["odg"]},
  "application/vnd.oasis.opendocument.graphics-template": {"source":"iana","extensions":["otg"]},
  "application/vnd.oasis.opendocument.image": {"source":"iana","extensions":["odi"]},
  "application/vnd.oasis.opendocument.image-template": {"source":"iana","extensions":["oti"]},
  "application/vnd.oasis.opendocument.presentation": {"source":"iana","compressible":false,"extensions":["odp"]},
  "application/vnd.oasis.opendocument.presentation-template": {"source":"iana","extensions":["otp"]},
  "application/vnd.oasis.opendocument.spreadsheet": {"source":"iana","compressible":false,"extensions":["ods"]},
  "application/vnd.oasis.opendocument.spreadsheet-template": {"source":"iana","extensions":["ots"]},
  "application/vnd.oasis.opendocument.text": {"source":"iana","compressible":false,"extensions":["odt"]},
  "application/vnd.oasis.opendocument.text-master": {"source":"iana","extensions":["odm"]},
  "application/vnd.oasis.opendocument.text-master-template": {"source":"iana"},
  "application/vnd.oasis.opendocument.text-template": {"source":"iana","extensions":["ott"]},
  "application/vnd.oasis.opendocument.text-web": {"source":"iana","extensions":["oth"]},
  "application/vnd.obn": {"source":"iana"},
  "application/vnd.ocf+cbor": {"source":"iana"},
  "application/vnd.oci.image.manifest.v1+json": {"source":"iana","compressible":true},
  "application/vnd.oftn.l10n+json": {"source":"iana","compressible":true},
  "application/vnd.oipf.contentaccessdownload+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.contentaccessstreaming+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.cspg-hexbinary": {"source":"iana"},
  "application/vnd.oipf.dae.svg+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.dae.xhtml+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.mippvcontrolmessage+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.pae.gem": {"source":"iana"},
  "application/vnd.oipf.spdiscovery+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.spdlist+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.ueprofile+xml": {"source":"iana","compressible":true},
  "application/vnd.oipf.userprofile+xml": {"source":"iana","compressible":true},
  "application/vnd.olpc-sugar": {"source":"iana","extensions":["xo"]},
  "application/vnd.oma-scws-config": {"source":"iana"},
  "application/vnd.oma-scws-http-request": {"source":"iana"},
  "application/vnd.oma-scws-http-response": {"source":"iana"},
  "application/vnd.oma.bcast.associated-procedure-parameter+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.bcast.drm-trigger+xml": {"source":"apache","compressible":true},
  "application/vnd.oma.bcast.imd+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.bcast.ltkm": {"source":"iana"},
  "application/vnd.oma.bcast.notification+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.bcast.provisioningtrigger": {"source":"iana"},
  "application/vnd.oma.bcast.sgboot": {"source":"iana"},
  "application/vnd.oma.bcast.sgdd+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.bcast.sgdu": {"source":"iana"},
  "application/vnd.oma.bcast.simple-symbol-container": {"source":"iana"},
  "application/vnd.oma.bcast.smartcard-trigger+xml": {"source":"apache","compressible":true},
  "application/vnd.oma.bcast.sprov+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.bcast.stkm": {"source":"iana"},
  "application/vnd.oma.cab-address-book+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.cab-feature-handler+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.cab-pcc+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.cab-subs-invite+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.cab-user-prefs+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.dcd": {"source":"iana"},
  "application/vnd.oma.dcdc": {"source":"iana"},
  "application/vnd.oma.dd2+xml": {"source":"iana","compressible":true,"extensions":["dd2"]},
  "application/vnd.oma.drm.risd+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.group-usage-list+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.lwm2m+cbor": {"source":"iana"},
  "application/vnd.oma.lwm2m+json": {"source":"iana","compressible":true},
  "application/vnd.oma.lwm2m+tlv": {"source":"iana"},
  "application/vnd.oma.pal+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.poc.detailed-progress-report+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.poc.final-report+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.poc.groups+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.poc.invocation-descriptor+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.poc.optimized-progress-report+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.push": {"source":"iana"},
  "application/vnd.oma.scidm.messages+xml": {"source":"iana","compressible":true},
  "application/vnd.oma.xcap-directory+xml": {"source":"iana","compressible":true},
  "application/vnd.omads-email+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/vnd.omads-file+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/vnd.omads-folder+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/vnd.omaloc-supl-init": {"source":"iana"},
  "application/vnd.onepager": {"source":"iana"},
  "application/vnd.onepagertamp": {"source":"iana"},
  "application/vnd.onepagertamx": {"source":"iana"},
  "application/vnd.onepagertat": {"source":"iana"},
  "application/vnd.onepagertatp": {"source":"iana"},
  "application/vnd.onepagertatx": {"source":"iana"},
  "application/vnd.onvif.metadata": {"source":"iana"},
  "application/vnd.openblox.game+xml": {"source":"iana","compressible":true,"extensions":["obgx"]},
  "application/vnd.openblox.game-binary": {"source":"iana"},
  "application/vnd.openeye.oeb": {"source":"iana"},
  "application/vnd.openofficeorg.extension": {"source":"apache","extensions":["oxt"]},
  "application/vnd.openstreetmap.data+xml": {"source":"iana","compressible":true,"extensions":["osm"]},
  "application/vnd.opentimestamps.ots": {"source":"iana"},
  "application/vnd.openvpi.dspx+json": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.custom-properties+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.customxmlproperties+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawing+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawingml.chart+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawingml.diagramcolors+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawingml.diagramdata+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawingml.diagramlayout+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.drawingml.diagramstyle+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.extended-properties+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.commentauthors+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.comments+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.handoutmaster+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.notesmaster+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.notesslide+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {"source":"iana","compressible":false,"extensions":["pptx"]},
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.presprops+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.slide": {"source":"iana","extensions":["sldx"]},
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.slidelayout+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.slidemaster+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": {"source":"iana","extensions":["ppsx"]},
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.slideupdateinfo+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.tablestyles+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.tags+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.template": {"source":"iana","extensions":["potx"]},
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.presentationml.viewprops+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.calcchain+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.externallink+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcachedefinition+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcacherecords+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivottable+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.querytable+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionheaders+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionlog+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedstrings+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {"source":"iana","compressible":false,"extensions":["xlsx"]},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetmetadata+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.tablesinglecells+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template": {"source":"iana","extensions":["xltx"]},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.usernames+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.volatiledependencies+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.theme+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.themeoverride+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.vmldrawing": {"source":"iana"},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {"source":"iana","compressible":false,"extensions":["docx"]},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.fonttable+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": {"source":"iana","extensions":["dotx"]},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.websettings+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-package.core-properties+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml": {"source":"iana","compressible":true},
  "application/vnd.openxmlformats-package.relationships+xml": {"source":"iana","compressible":true},
  "application/vnd.oracle.resource+json": {"source":"iana","compressible":true},
  "application/vnd.orange.indata": {"source":"iana"},
  "application/vnd.osa.netdeploy": {"source":"iana"},
  "application/vnd.osgeo.mapguide.package": {"source":"iana","extensions":["mgp"]},
  "application/vnd.osgi.bundle": {"source":"iana"},
  "application/vnd.osgi.dp": {"source":"iana","extensions":["dp"]},
  "application/vnd.osgi.subsystem": {"source":"iana","extensions":["esa"]},
  "application/vnd.otps.ct-kip+xml": {"source":"iana","compressible":true},
  "application/vnd.oxli.countgraph": {"source":"iana"},
  "application/vnd.pagerduty+json": {"source":"iana","compressible":true},
  "application/vnd.palm": {"source":"iana","extensions":["pdb","pqa","oprc"]},
  "application/vnd.panoply": {"source":"iana"},
  "application/vnd.paos.xml": {"source":"iana"},
  "application/vnd.patentdive": {"source":"iana"},
  "application/vnd.patientecommsdoc": {"source":"iana"},
  "application/vnd.pawaafile": {"source":"iana","extensions":["paw"]},
  "application/vnd.pcos": {"source":"iana"},
  "application/vnd.pg.format": {"source":"iana","extensions":["str"]},
  "application/vnd.pg.osasli": {"source":"iana","extensions":["ei6"]},
  "application/vnd.piaccess.application-licence": {"source":"iana"},
  "application/vnd.picsel": {"source":"iana","extensions":["efif"]},
  "application/vnd.pmi.widget": {"source":"iana","extensions":["wg"]},
  "application/vnd.poc.group-advertisement+xml": {"source":"iana","compressible":true},
  "application/vnd.pocketlearn": {"source":"iana","extensions":["plf"]},
  "application/vnd.powerbuilder6": {"source":"iana","extensions":["pbd"]},
  "application/vnd.powerbuilder6-s": {"source":"iana"},
  "application/vnd.powerbuilder7": {"source":"iana"},
  "application/vnd.powerbuilder7-s": {"source":"iana"},
  "application/vnd.powerbuilder75": {"source":"iana"},
  "application/vnd.powerbuilder75-s": {"source":"iana"},
  "application/vnd.preminet": {"source":"iana"},
  "application/vnd.previewsystems.box": {"source":"iana","extensions":["box"]},
  "application/vnd.procrate.brushset": {"extensions":["brushset"]},
  "application/vnd.procreate.brush": {"extensions":["brush"]},
  "application/vnd.procreate.dream": {"extensions":["drm"]},
  "application/vnd.proteus.magazine": {"source":"iana","extensions":["mgz"]},
  "application/vnd.psfs": {"source":"iana"},
  "application/vnd.pt.mundusmundi": {"source":"iana"},
  "application/vnd.publishare-delta-tree": {"source":"iana","extensions":["qps"]},
  "application/vnd.pvi.ptid1": {"source":"iana","extensions":["ptid"]},
  "application/vnd.pwg-multiplexed": {"source":"iana"},
  "application/vnd.pwg-xhtml-print+xml": {"source":"iana","compressible":true,"extensions":["xhtm"]},
  "application/vnd.qualcomm.brew-app-res": {"source":"iana"},
  "application/vnd.quarantainenet": {"source":"iana"},
  "application/vnd.quark.quarkxpress": {"source":"iana","extensions":["qxd","qxt","qwd","qwt","qxl","qxb"]},
  "application/vnd.quobject-quoxdocument": {"source":"iana"},
  "application/vnd.radisys.moml+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-audit+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-audit-conf+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-audit-conn+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-audit-dialog+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-audit-stream+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-conf+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog-base+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog-fax-detect+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog-fax-sendrecv+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog-group+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog-speech+xml": {"source":"iana","compressible":true},
  "application/vnd.radisys.msml-dialog-transform+xml": {"source":"iana","compressible":true},
  "application/vnd.rainstor.data": {"source":"iana"},
  "application/vnd.rapid": {"source":"iana"},
  "application/vnd.rar": {"source":"iana","extensions":["rar"]},
  "application/vnd.realvnc.bed": {"source":"iana","extensions":["bed"]},
  "application/vnd.recordare.musicxml": {"source":"iana","extensions":["mxl"]},
  "application/vnd.recordare.musicxml+xml": {"source":"iana","compressible":true,"extensions":["musicxml"]},
  "application/vnd.relpipe": {"source":"iana"},
  "application/vnd.renlearn.rlprint": {"source":"iana"},
  "application/vnd.resilient.logic": {"source":"iana"},
  "application/vnd.restful+json": {"source":"iana","compressible":true},
  "application/vnd.rig.cryptonote": {"source":"iana","extensions":["cryptonote"]},
  "application/vnd.rim.cod": {"source":"apache","extensions":["cod"]},
  "application/vnd.rn-realmedia": {"source":"apache","extensions":["rm"]},
  "application/vnd.rn-realmedia-vbr": {"source":"apache","extensions":["rmvb"]},
  "application/vnd.route66.link66+xml": {"source":"iana","compressible":true,"extensions":["link66"]},
  "application/vnd.rs-274x": {"source":"iana"},
  "application/vnd.ruckus.download": {"source":"iana"},
  "application/vnd.s3sms": {"source":"iana"},
  "application/vnd.sailingtracker.track": {"source":"iana","extensions":["st"]},
  "application/vnd.sar": {"source":"iana"},
  "application/vnd.sbm.cid": {"source":"iana"},
  "application/vnd.sbm.mid2": {"source":"iana"},
  "application/vnd.scribus": {"source":"iana"},
  "application/vnd.sealed.3df": {"source":"iana"},
  "application/vnd.sealed.csf": {"source":"iana"},
  "application/vnd.sealed.doc": {"source":"iana"},
  "application/vnd.sealed.eml": {"source":"iana"},
  "application/vnd.sealed.mht": {"source":"iana"},
  "application/vnd.sealed.net": {"source":"iana"},
  "application/vnd.sealed.ppt": {"source":"iana"},
  "application/vnd.sealed.tiff": {"source":"iana"},
  "application/vnd.sealed.xls": {"source":"iana"},
  "application/vnd.sealedmedia.softseal.html": {"source":"iana"},
  "application/vnd.sealedmedia.softseal.pdf": {"source":"iana"},
  "application/vnd.seemail": {"source":"iana","extensions":["see"]},
  "application/vnd.seis+json": {"source":"iana","compressible":true},
  "application/vnd.sema": {"source":"iana","extensions":["sema"]},
  "application/vnd.semd": {"source":"iana","extensions":["semd"]},
  "application/vnd.semf": {"source":"iana","extensions":["semf"]},
  "application/vnd.shade-save-file": {"source":"iana"},
  "application/vnd.shana.informed.formdata": {"source":"iana","extensions":["ifm"]},
  "application/vnd.shana.informed.formtemplate": {"source":"iana","extensions":["itp"]},
  "application/vnd.shana.informed.interchange": {"source":"iana","extensions":["iif"]},
  "application/vnd.shana.informed.package": {"source":"iana","extensions":["ipk"]},
  "application/vnd.shootproof+json": {"source":"iana","compressible":true},
  "application/vnd.shopkick+json": {"source":"iana","compressible":true},
  "application/vnd.shp": {"source":"iana"},
  "application/vnd.shx": {"source":"iana"},
  "application/vnd.sigrok.session": {"source":"iana"},
  "application/vnd.simtech-mindmapper": {"source":"iana","extensions":["twd","twds"]},
  "application/vnd.siren+json": {"source":"iana","compressible":true},
  "application/vnd.sketchometry": {"source":"iana"},
  "application/vnd.smaf": {"source":"iana","extensions":["mmf"]},
  "application/vnd.smart.notebook": {"source":"iana"},
  "application/vnd.smart.teacher": {"source":"iana","extensions":["teacher"]},
  "application/vnd.smintio.portals.archive": {"source":"iana"},
  "application/vnd.snesdev-page-table": {"source":"iana"},
  "application/vnd.software602.filler.form+xml": {"source":"iana","compressible":true,"extensions":["fo"]},
  "application/vnd.software602.filler.form-xml-zip": {"source":"iana"},
  "application/vnd.solent.sdkm+xml": {"source":"iana","compressible":true,"extensions":["sdkm","sdkd"]},
  "application/vnd.spotfire.dxp": {"source":"iana","extensions":["dxp"]},
  "application/vnd.spotfire.sfs": {"source":"iana","extensions":["sfs"]},
  "application/vnd.sqlite3": {"source":"iana"},
  "application/vnd.sss-cod": {"source":"iana"},
  "application/vnd.sss-dtf": {"source":"iana"},
  "application/vnd.sss-ntf": {"source":"iana"},
  "application/vnd.stardivision.calc": {"source":"apache","extensions":["sdc"]},
  "application/vnd.stardivision.draw": {"source":"apache","extensions":["sda"]},
  "application/vnd.stardivision.impress": {"source":"apache","extensions":["sdd"]},
  "application/vnd.stardivision.math": {"source":"apache","extensions":["smf"]},
  "application/vnd.stardivision.writer": {"source":"apache","extensions":["sdw","vor"]},
  "application/vnd.stardivision.writer-global": {"source":"apache","extensions":["sgl"]},
  "application/vnd.stepmania.package": {"source":"iana","extensions":["smzip"]},
  "application/vnd.stepmania.stepchart": {"source":"iana","extensions":["sm"]},
  "application/vnd.street-stream": {"source":"iana"},
  "application/vnd.sun.wadl+xml": {"source":"iana","compressible":true,"extensions":["wadl"]},
  "application/vnd.sun.xml.calc": {"source":"apache","extensions":["sxc"]},
  "application/vnd.sun.xml.calc.template": {"source":"apache","extensions":["stc"]},
  "application/vnd.sun.xml.draw": {"source":"apache","extensions":["sxd"]},
  "application/vnd.sun.xml.draw.template": {"source":"apache","extensions":["std"]},
  "application/vnd.sun.xml.impress": {"source":"apache","extensions":["sxi"]},
  "application/vnd.sun.xml.impress.template": {"source":"apache","extensions":["sti"]},
  "application/vnd.sun.xml.math": {"source":"apache","extensions":["sxm"]},
  "application/vnd.sun.xml.writer": {"source":"apache","extensions":["sxw"]},
  "application/vnd.sun.xml.writer.global": {"source":"apache","extensions":["sxg"]},
  "application/vnd.sun.xml.writer.template": {"source":"apache","extensions":["stw"]},
  "application/vnd.sus-calendar": {"source":"iana","extensions":["sus","susp"]},
  "application/vnd.svd": {"source":"iana","extensions":["svd"]},
  "application/vnd.swiftview-ics": {"source":"iana"},
  "application/vnd.sybyl.mol2": {"source":"iana"},
  "application/vnd.sycle+xml": {"source":"iana","compressible":true},
  "application/vnd.syft+json": {"source":"iana","compressible":true},
  "application/vnd.symbian.install": {"source":"apache","extensions":["sis","sisx"]},
  "application/vnd.syncml+xml": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["xsm"]},
  "application/vnd.syncml.dm+wbxml": {"source":"iana","charset":"UTF-8","extensions":["bdm"]},
  "application/vnd.syncml.dm+xml": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["xdm"]},
  "application/vnd.syncml.dm.notification": {"source":"iana"},
  "application/vnd.syncml.dmddf+wbxml": {"source":"iana"},
  "application/vnd.syncml.dmddf+xml": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["ddf"]},
  "application/vnd.syncml.dmtnds+wbxml": {"source":"iana"},
  "application/vnd.syncml.dmtnds+xml": {"source":"iana","charset":"UTF-8","compressible":true},
  "application/vnd.syncml.ds.notification": {"source":"iana"},
  "application/vnd.tableschema+json": {"source":"iana","compressible":true},
  "application/vnd.tao.intent-module-archive": {"source":"iana","extensions":["tao"]},
  "application/vnd.tcpdump.pcap": {"source":"iana","extensions":["pcap","cap","dmp"]},
  "application/vnd.think-cell.ppttc+json": {"source":"iana","compressible":true},
  "application/vnd.tmd.mediaflex.api+xml": {"source":"iana","compressible":true},
  "application/vnd.tml": {"source":"iana"},
  "application/vnd.tmobile-livetv": {"source":"iana","extensions":["tmo"]},
  "application/vnd.tri.onesource": {"source":"iana"},
  "application/vnd.trid.tpt": {"source":"iana","extensions":["tpt"]},
  "application/vnd.triscape.mxs": {"source":"iana","extensions":["mxs"]},
  "application/vnd.trueapp": {"source":"iana","extensions":["tra"]},
  "application/vnd.truedoc": {"source":"iana"},
  "application/vnd.ubisoft.webplayer": {"source":"iana"},
  "application/vnd.ufdl": {"source":"iana","extensions":["ufd","ufdl"]},
  "application/vnd.uic.osdm+json": {"source":"iana","compressible":true},
  "application/vnd.uiq.theme": {"source":"iana","extensions":["utz"]},
  "application/vnd.umajin": {"source":"iana","extensions":["umj"]},
  "application/vnd.unity": {"source":"iana","extensions":["unityweb"]},
  "application/vnd.uoml+xml": {"source":"iana","compressible":true,"extensions":["uoml","uo"]},
  "application/vnd.uplanet.alert": {"source":"iana"},
  "application/vnd.uplanet.alert-wbxml": {"source":"iana"},
  "application/vnd.uplanet.bearer-choice": {"source":"iana"},
  "application/vnd.uplanet.bearer-choice-wbxml": {"source":"iana"},
  "application/vnd.uplanet.cacheop": {"source":"iana"},
  "application/vnd.uplanet.cacheop-wbxml": {"source":"iana"},
  "application/vnd.uplanet.channel": {"source":"iana"},
  "application/vnd.uplanet.channel-wbxml": {"source":"iana"},
  "application/vnd.uplanet.list": {"source":"iana"},
  "application/vnd.uplanet.list-wbxml": {"source":"iana"},
  "application/vnd.uplanet.listcmd": {"source":"iana"},
  "application/vnd.uplanet.listcmd-wbxml": {"source":"iana"},
  "application/vnd.uplanet.signal": {"source":"iana"},
  "application/vnd.uri-map": {"source":"iana"},
  "application/vnd.valve.source.material": {"source":"iana"},
  "application/vnd.vcx": {"source":"iana","extensions":["vcx"]},
  "application/vnd.vd-study": {"source":"iana"},
  "application/vnd.vectorworks": {"source":"iana"},
  "application/vnd.vel+json": {"source":"iana","compressible":true},
  "application/vnd.veraison.tsm-report+cbor": {"source":"iana"},
  "application/vnd.veraison.tsm-report+json": {"source":"iana","compressible":true},
  "application/vnd.verimatrix.vcas": {"source":"iana"},
  "application/vnd.veritone.aion+json": {"source":"iana","compressible":true},
  "application/vnd.veryant.thin": {"source":"iana"},
  "application/vnd.ves.encrypted": {"source":"iana"},
  "application/vnd.vidsoft.vidconference": {"source":"iana"},
  "application/vnd.visio": {"source":"iana","extensions":["vsd","vst","vss","vsw","vsdx","vtx"]},
  "application/vnd.visionary": {"source":"iana","extensions":["vis"]},
  "application/vnd.vividence.scriptfile": {"source":"iana"},
  "application/vnd.vocalshaper.vsp4": {"source":"iana"},
  "application/vnd.vsf": {"source":"iana","extensions":["vsf"]},
  "application/vnd.wap.sic": {"source":"iana"},
  "application/vnd.wap.slc": {"source":"iana"},
  "application/vnd.wap.wbxml": {"source":"iana","charset":"UTF-8","extensions":["wbxml"]},
  "application/vnd.wap.wmlc": {"source":"iana","extensions":["wmlc"]},
  "application/vnd.wap.wmlscriptc": {"source":"iana","extensions":["wmlsc"]},
  "application/vnd.wasmflow.wafl": {"source":"iana"},
  "application/vnd.webturbo": {"source":"iana","extensions":["wtb"]},
  "application/vnd.wfa.dpp": {"source":"iana"},
  "application/vnd.wfa.p2p": {"source":"iana"},
  "application/vnd.wfa.wsc": {"source":"iana"},
  "application/vnd.windows.devicepairing": {"source":"iana"},
  "application/vnd.wmc": {"source":"iana"},
  "application/vnd.wmf.bootstrap": {"source":"iana"},
  "application/vnd.wolfram.mathematica": {"source":"iana"},
  "application/vnd.wolfram.mathematica.package": {"source":"iana"},
  "application/vnd.wolfram.player": {"source":"iana","extensions":["nbp"]},
  "application/vnd.wordlift": {"source":"iana"},
  "application/vnd.wordperfect": {"source":"iana","extensions":["wpd"]},
  "application/vnd.wqd": {"source":"iana","extensions":["wqd"]},
  "application/vnd.wrq-hp3000-labelled": {"source":"iana"},
  "application/vnd.wt.stf": {"source":"iana","extensions":["stf"]},
  "application/vnd.wv.csp+wbxml": {"source":"iana"},
  "application/vnd.wv.csp+xml": {"source":"iana","compressible":true},
  "application/vnd.wv.ssp+xml": {"source":"iana","compressible":true},
  "application/vnd.xacml+json": {"source":"iana","compressible":true},
  "application/vnd.xara": {"source":"iana","extensions":["xar"]},
  "application/vnd.xarin.cpj": {"source":"iana"},
  "application/vnd.xecrets-encrypted": {"source":"iana"},
  "application/vnd.xfdl": {"source":"iana","extensions":["xfdl"]},
  "application/vnd.xfdl.webform": {"source":"iana"},
  "application/vnd.xmi+xml": {"source":"iana","compressible":true},
  "application/vnd.xmpie.cpkg": {"source":"iana"},
  "application/vnd.xmpie.dpkg": {"source":"iana"},
  "application/vnd.xmpie.plan": {"source":"iana"},
  "application/vnd.xmpie.ppkg": {"source":"iana"},
  "application/vnd.xmpie.xlim": {"source":"iana"},
  "application/vnd.yamaha.hv-dic": {"source":"iana","extensions":["hvd"]},
  "application/vnd.yamaha.hv-script": {"source":"iana","extensions":["hvs"]},
  "application/vnd.yamaha.hv-voice": {"source":"iana","extensions":["hvp"]},
  "application/vnd.yamaha.openscoreformat": {"source":"iana","extensions":["osf"]},
  "application/vnd.yamaha.openscoreformat.osfpvg+xml": {"source":"iana","compressible":true,"extensions":["osfpvg"]},
  "application/vnd.yamaha.remote-setup": {"source":"iana"},
  "application/vnd.yamaha.smaf-audio": {"source":"iana","extensions":["saf"]},
  "application/vnd.yamaha.smaf-phrase": {"source":"iana","extensions":["spf"]},
  "application/vnd.yamaha.through-ngn": {"source":"iana"},
  "application/vnd.yamaha.tunnel-udpencap": {"source":"iana"},
  "application/vnd.yaoweme": {"source":"iana"},
  "application/vnd.yellowriver-custom-menu": {"source":"iana","extensions":["cmp"]},
  "application/vnd.zul": {"source":"iana","extensions":["zir","zirz"]},
  "application/vnd.zzazz.deck+xml": {"source":"iana","compressible":true,"extensions":["zaz"]},
  "application/voicexml+xml": {"source":"iana","compressible":true,"extensions":["vxml"]},
  "application/voucher-cms+json": {"source":"iana","compressible":true},
  "application/voucher-jws+json": {"source":"iana","compressible":true},
  "application/vp": {"source":"iana"},
  "application/vp+cose": {"source":"iana"},
  "application/vp+jwt": {"source":"iana"},
  "application/vq-rtcpxr": {"source":"iana"},
  "application/wasm": {"source":"iana","compressible":true,"extensions":["wasm"]},
  "application/watcherinfo+xml": {"source":"iana","compressible":true,"extensions":["wif"]},
  "application/webpush-options+json": {"source":"iana","compressible":true},
  "application/whoispp-query": {"source":"iana"},
  "application/whoispp-response": {"source":"iana"},
  "application/widget": {"source":"iana","extensions":["wgt"]},
  "application/winhlp": {"source":"apache","extensions":["hlp"]},
  "application/wita": {"source":"iana"},
  "application/wordperfect5.1": {"source":"iana"},
  "application/wsdl+xml": {"source":"iana","compressible":true,"extensions":["wsdl"]},
  "application/wspolicy+xml": {"source":"iana","compressible":true,"extensions":["wspolicy"]},
  "application/x-7z-compressed": {"source":"apache","compressible":false,"extensions":["7z"]},
  "application/x-abiword": {"source":"apache","extensions":["abw"]},
  "application/x-ace-compressed": {"source":"apache","extensions":["ace"]},
  "application/x-amf": {"source":"apache"},
  "application/x-apple-diskimage": {"source":"apache","extensions":["dmg"]},
  "application/x-arj": {"compressible":false,"extensions":["arj"]},
  "application/x-authorware-bin": {"source":"apache","extensions":["aab","x32","u32","vox"]},
  "application/x-authorware-map": {"source":"apache","extensions":["aam"]},
  "application/x-authorware-seg": {"source":"apache","extensions":["aas"]},
  "application/x-bcpio": {"source":"apache","extensions":["bcpio"]},
  "application/x-bdoc": {"compressible":false,"extensions":["bdoc"]},
  "application/x-bittorrent": {"source":"apache","extensions":["torrent"]},
  "application/x-blender": {"extensions":["blend"]},
  "application/x-blorb": {"source":"apache","extensions":["blb","blorb"]},
  "application/x-bzip": {"source":"apache","compressible":false,"extensions":["bz"]},
  "application/x-bzip2": {"source":"apache","compressible":false,"extensions":["bz2","boz"]},
  "application/x-cbr": {"source":"apache","extensions":["cbr","cba","cbt","cbz","cb7"]},
  "application/x-cdlink": {"source":"apache","extensions":["vcd"]},
  "application/x-cfs-compressed": {"source":"apache","extensions":["cfs"]},
  "application/x-chat": {"source":"apache","extensions":["chat"]},
  "application/x-chess-pgn": {"source":"apache","extensions":["pgn"]},
  "application/x-chrome-extension": {"extensions":["crx"]},
  "application/x-cocoa": {"source":"nginx","extensions":["cco"]},
  "application/x-compress": {"source":"apache"},
  "application/x-compressed": {"extensions":["rar"]},
  "application/x-conference": {"source":"apache","extensions":["nsc"]},
  "application/x-cpio": {"source":"apache","extensions":["cpio"]},
  "application/x-csh": {"source":"apache","extensions":["csh"]},
  "application/x-deb": {"compressible":false},
  "application/x-debian-package": {"source":"apache","extensions":["deb","udeb"]},
  "application/x-dgc-compressed": {"source":"apache","extensions":["dgc"]},
  "application/x-director": {"source":"apache","extensions":["dir","dcr","dxr","cst","cct","cxt","w3d","fgd","swa"]},
  "application/x-doom": {"source":"apache","extensions":["wad"]},
  "application/x-dtbncx+xml": {"source":"apache","compressible":true,"extensions":["ncx"]},
  "application/x-dtbook+xml": {"source":"apache","compressible":true,"extensions":["dtb"]},
  "application/x-dtbresource+xml": {"source":"apache","compressible":true,"extensions":["res"]},
  "application/x-dvi": {"source":"apache","compressible":false,"extensions":["dvi"]},
  "application/x-envoy": {"source":"apache","extensions":["evy"]},
  "application/x-eva": {"source":"apache","extensions":["eva"]},
  "application/x-font-bdf": {"source":"apache","extensions":["bdf"]},
  "application/x-font-dos": {"source":"apache"},
  "application/x-font-framemaker": {"source":"apache"},
  "application/x-font-ghostscript": {"source":"apache","extensions":["gsf"]},
  "application/x-font-libgrx": {"source":"apache"},
  "application/x-font-linux-psf": {"source":"apache","extensions":["psf"]},
  "application/x-font-pcf": {"source":"apache","extensions":["pcf"]},
  "application/x-font-snf": {"source":"apache","extensions":["snf"]},
  "application/x-font-speedo": {"source":"apache"},
  "application/x-font-sunos-news": {"source":"apache"},
  "application/x-font-type1": {"source":"apache","extensions":["pfa","pfb","pfm","afm"]},
  "application/x-font-vfont": {"source":"apache"},
  "application/x-freearc": {"source":"apache","extensions":["arc"]},
  "application/x-futuresplash": {"source":"apache","extensions":["spl"]},
  "application/x-gca-compressed": {"source":"apache","extensions":["gca"]},
  "application/x-glulx": {"source":"apache","extensions":["ulx"]},
  "application/x-gnumeric": {"source":"apache","extensions":["gnumeric"]},
  "application/x-gramps-xml": {"source":"apache","extensions":["gramps"]},
  "application/x-gtar": {"source":"apache","extensions":["gtar"]},
  "application/x-gzip": {"source":"apache"},
  "application/x-hdf": {"source":"apache","extensions":["hdf"]},
  "application/x-httpd-php": {"compressible":true,"extensions":["php"]},
  "application/x-install-instructions": {"source":"apache","extensions":["install"]},
  "application/x-ipynb+json": {"compressible":true,"extensions":["ipynb"]},
  "application/x-iso9660-image": {"source":"apache","extensions":["iso"]},
  "application/x-iwork-keynote-sffkey": {"extensions":["key"]},
  "application/x-iwork-numbers-sffnumbers": {"extensions":["numbers"]},
  "application/x-iwork-pages-sffpages": {"extensions":["pages"]},
  "application/x-java-archive-diff": {"source":"nginx","extensions":["jardiff"]},
  "application/x-java-jnlp-file": {"source":"apache","compressible":false,"extensions":["jnlp"]},
  "application/x-javascript": {"compressible":true},
  "application/x-keepass2": {"extensions":["kdbx"]},
  "application/x-latex": {"source":"apache","compressible":false,"extensions":["latex"]},
  "application/x-lua-bytecode": {"extensions":["luac"]},
  "application/x-lzh-compressed": {"source":"apache","extensions":["lzh","lha"]},
  "application/x-makeself": {"source":"nginx","extensions":["run"]},
  "application/x-mie": {"source":"apache","extensions":["mie"]},
  "application/x-mobipocket-ebook": {"source":"apache","extensions":["prc","mobi"]},
  "application/x-mpegurl": {"compressible":false},
  "application/x-ms-application": {"source":"apache","extensions":["application"]},
  "application/x-ms-shortcut": {"source":"apache","extensions":["lnk"]},
  "application/x-ms-wmd": {"source":"apache","extensions":["wmd"]},
  "application/x-ms-wmz": {"source":"apache","extensions":["wmz"]},
  "application/x-ms-xbap": {"source":"apache","extensions":["xbap"]},
  "application/x-msaccess": {"source":"apache","extensions":["mdb"]},
  "application/x-msbinder": {"source":"apache","extensions":["obd"]},
  "application/x-mscardfile": {"source":"apache","extensions":["crd"]},
  "application/x-msclip": {"source":"apache","extensions":["clp"]},
  "application/x-msdos-program": {"extensions":["exe"]},
  "application/x-msdownload": {"source":"apache","extensions":["exe","dll","com","bat","msi"]},
  "application/x-msmediaview": {"source":"apache","extensions":["mvb","m13","m14"]},
  "application/x-msmetafile": {"source":"apache","extensions":["wmf","wmz","emf","emz"]},
  "application/x-msmoney": {"source":"apache","extensions":["mny"]},
  "application/x-mspublisher": {"source":"apache","extensions":["pub"]},
  "application/x-msschedule": {"source":"apache","extensions":["scd"]},
  "application/x-msterminal": {"source":"apache","extensions":["trm"]},
  "application/x-mswrite": {"source":"apache","extensions":["wri"]},
  "application/x-netcdf": {"source":"apache","extensions":["nc","cdf"]},
  "application/x-ns-proxy-autoconfig": {"compressible":true,"extensions":["pac"]},
  "application/x-nzb": {"source":"apache","extensions":["nzb"]},
  "application/x-perl": {"source":"nginx","extensions":["pl","pm"]},
  "application/x-pilot": {"source":"nginx","extensions":["prc","pdb"]},
  "application/x-pkcs12": {"source":"apache","compressible":false,"extensions":["p12","pfx"]},
  "application/x-pkcs7-certificates": {"source":"apache","extensions":["p7b","spc"]},
  "application/x-pkcs7-certreqresp": {"source":"apache","extensions":["p7r"]},
  "application/x-pki-message": {"source":"iana"},
  "application/x-rar-compressed": {"source":"apache","compressible":false,"extensions":["rar"]},
  "application/x-redhat-package-manager": {"source":"nginx","extensions":["rpm"]},
  "application/x-research-info-systems": {"source":"apache","extensions":["ris"]},
  "application/x-sea": {"source":"nginx","extensions":["sea"]},
  "application/x-sh": {"source":"apache","compressible":true,"extensions":["sh"]},
  "application/x-shar": {"source":"apache","extensions":["shar"]},
  "application/x-shockwave-flash": {"source":"apache","compressible":false,"extensions":["swf"]},
  "application/x-silverlight-app": {"source":"apache","extensions":["xap"]},
  "application/x-sql": {"source":"apache","extensions":["sql"]},
  "application/x-stuffit": {"source":"apache","compressible":false,"extensions":["sit"]},
  "application/x-stuffitx": {"source":"apache","extensions":["sitx"]},
  "application/x-subrip": {"source":"apache","extensions":["srt"]},
  "application/x-sv4cpio": {"source":"apache","extensions":["sv4cpio"]},
  "application/x-sv4crc": {"source":"apache","extensions":["sv4crc"]},
  "application/x-t3vm-image": {"source":"apache","extensions":["t3"]},
  "application/x-tads": {"source":"apache","extensions":["gam"]},
  "application/x-tar": {"source":"apache","compressible":true,"extensions":["tar"]},
  "application/x-tcl": {"source":"apache","extensions":["tcl","tk"]},
  "application/x-tex": {"source":"apache","extensions":["tex"]},
  "application/x-tex-tfm": {"source":"apache","extensions":["tfm"]},
  "application/x-texinfo": {"source":"apache","extensions":["texinfo","texi"]},
  "application/x-tgif": {"source":"apache","extensions":["obj"]},
  "application/x-ustar": {"source":"apache","extensions":["ustar"]},
  "application/x-virtualbox-hdd": {"compressible":true,"extensions":["hdd"]},
  "application/x-virtualbox-ova": {"compressible":true,"extensions":["ova"]},
  "application/x-virtualbox-ovf": {"compressible":true,"extensions":["ovf"]},
  "application/x-virtualbox-vbox": {"compressible":true,"extensions":["vbox"]},
  "application/x-virtualbox-vbox-extpack": {"compressible":false,"extensions":["vbox-extpack"]},
  "application/x-virtualbox-vdi": {"compressible":true,"extensions":["vdi"]},
  "application/x-virtualbox-vhd": {"compressible":true,"extensions":["vhd"]},
  "application/x-virtualbox-vmdk": {"compressible":true,"extensions":["vmdk"]},
  "application/x-wais-source": {"source":"apache","extensions":["src"]},
  "application/x-web-app-manifest+json": {"compressible":true,"extensions":["webapp"]},
  "application/x-www-form-urlencoded": {"source":"iana","compressible":true},
  "application/x-x509-ca-cert": {"source":"iana","extensions":["der","crt","pem"]},
  "application/x-x509-ca-ra-cert": {"source":"iana"},
  "application/x-x509-next-ca-cert": {"source":"iana"},
  "application/x-xfig": {"source":"apache","extensions":["fig"]},
  "application/x-xliff+xml": {"source":"apache","compressible":true,"extensions":["xlf"]},
  "application/x-xpinstall": {"source":"apache","compressible":false,"extensions":["xpi"]},
  "application/x-xz": {"source":"apache","extensions":["xz"]},
  "application/x-zip-compressed": {"extensions":["zip"]},
  "application/x-zmachine": {"source":"apache","extensions":["z1","z2","z3","z4","z5","z6","z7","z8"]},
  "application/x400-bp": {"source":"iana"},
  "application/xacml+xml": {"source":"iana","compressible":true},
  "application/xaml+xml": {"source":"apache","compressible":true,"extensions":["xaml"]},
  "application/xcap-att+xml": {"source":"iana","compressible":true,"extensions":["xav"]},
  "application/xcap-caps+xml": {"source":"iana","compressible":true,"extensions":["xca"]},
  "application/xcap-diff+xml": {"source":"iana","compressible":true,"extensions":["xdf"]},
  "application/xcap-el+xml": {"source":"iana","compressible":true,"extensions":["xel"]},
  "application/xcap-error+xml": {"source":"iana","compressible":true},
  "application/xcap-ns+xml": {"source":"iana","compressible":true,"extensions":["xns"]},
  "application/xcon-conference-info+xml": {"source":"iana","compressible":true},
  "application/xcon-conference-info-diff+xml": {"source":"iana","compressible":true},
  "application/xenc+xml": {"source":"iana","compressible":true,"extensions":["xenc"]},
  "application/xfdf": {"source":"iana","extensions":["xfdf"]},
  "application/xhtml+xml": {"source":"iana","compressible":true,"extensions":["xhtml","xht"]},
  "application/xhtml-voice+xml": {"source":"apache","compressible":true},
  "application/xliff+xml": {"source":"iana","compressible":true,"extensions":["xlf"]},
  "application/xml": {"source":"iana","compressible":true,"extensions":["xml","xsl","xsd","rng"]},
  "application/xml-dtd": {"source":"iana","compressible":true,"extensions":["dtd"]},
  "application/xml-external-parsed-entity": {"source":"iana"},
  "application/xml-patch+xml": {"source":"iana","compressible":true},
  "application/xmpp+xml": {"source":"iana","compressible":true},
  "application/xop+xml": {"source":"iana","compressible":true,"extensions":["xop"]},
  "application/xproc+xml": {"source":"apache","compressible":true,"extensions":["xpl"]},
  "application/xslt+xml": {"source":"iana","compressible":true,"extensions":["xsl","xslt"]},
  "application/xspf+xml": {"source":"apache","compressible":true,"extensions":["xspf"]},
  "application/xv+xml": {"source":"iana","compressible":true,"extensions":["mxml","xhvml","xvml","xvm"]},
  "application/yaml": {"source":"iana"},
  "application/yang": {"source":"iana","extensions":["yang"]},
  "application/yang-data+cbor": {"source":"iana"},
  "application/yang-data+json": {"source":"iana","compressible":true},
  "application/yang-data+xml": {"source":"iana","compressible":true},
  "application/yang-patch+json": {"source":"iana","compressible":true},
  "application/yang-patch+xml": {"source":"iana","compressible":true},
  "application/yang-sid+json": {"source":"iana","compressible":true},
  "application/yin+xml": {"source":"iana","compressible":true,"extensions":["yin"]},
  "application/zip": {"source":"iana","compressible":false,"extensions":["zip"]},
  "application/zip+dotlottie": {"extensions":["lottie"]},
  "application/zlib": {"source":"iana"},
  "application/zstd": {"source":"iana"},
  "audio/1d-interleaved-parityfec": {"source":"iana"},
  "audio/32kadpcm": {"source":"iana"},
  "audio/3gpp": {"source":"iana","compressible":false,"extensions":["3gpp"]},
  "audio/3gpp2": {"source":"iana"},
  "audio/aac": {"source":"iana","extensions":["adts","aac"]},
  "audio/ac3": {"source":"iana"},
  "audio/adpcm": {"source":"apache","extensions":["adp"]},
  "audio/amr": {"source":"iana","extensions":["amr"]},
  "audio/amr-wb": {"source":"iana"},
  "audio/amr-wb+": {"source":"iana"},
  "audio/aptx": {"source":"iana"},
  "audio/asc": {"source":"iana"},
  "audio/atrac-advanced-lossless": {"source":"iana"},
  "audio/atrac-x": {"source":"iana"},
  "audio/atrac3": {"source":"iana"},
  "audio/basic": {"source":"iana","compressible":false,"extensions":["au","snd"]},
  "audio/bv16": {"source":"iana"},
  "audio/bv32": {"source":"iana"},
  "audio/clearmode": {"source":"iana"},
  "audio/cn": {"source":"iana"},
  "audio/dat12": {"source":"iana"},
  "audio/dls": {"source":"iana"},
  "audio/dsr-es201108": {"source":"iana"},
  "audio/dsr-es202050": {"source":"iana"},
  "audio/dsr-es202211": {"source":"iana"},
  "audio/dsr-es202212": {"source":"iana"},
  "audio/dv": {"source":"iana"},
  "audio/dvi4": {"source":"iana"},
  "audio/eac3": {"source":"iana"},
  "audio/encaprtp": {"source":"iana"},
  "audio/evrc": {"source":"iana"},
  "audio/evrc-qcp": {"source":"iana"},
  "audio/evrc0": {"source":"iana"},
  "audio/evrc1": {"source":"iana"},
  "audio/evrcb": {"source":"iana"},
  "audio/evrcb0": {"source":"iana"},
  "audio/evrcb1": {"source":"iana"},
  "audio/evrcnw": {"source":"iana"},
  "audio/evrcnw0": {"source":"iana"},
  "audio/evrcnw1": {"source":"iana"},
  "audio/evrcwb": {"source":"iana"},
  "audio/evrcwb0": {"source":"iana"},
  "audio/evrcwb1": {"source":"iana"},
  "audio/evs": {"source":"iana"},
  "audio/flac": {"source":"iana"},
  "audio/flexfec": {"source":"iana"},
  "audio/fwdred": {"source":"iana"},
  "audio/g711-0": {"source":"iana"},
  "audio/g719": {"source":"iana"},
  "audio/g722": {"source":"iana"},
  "audio/g7221": {"source":"iana"},
  "audio/g723": {"source":"iana"},
  "audio/g726-16": {"source":"iana"},
  "audio/g726-24": {"source":"iana"},
  "audio/g726-32": {"source":"iana"},
  "audio/g726-40": {"source":"iana"},
  "audio/g728": {"source":"iana"},
  "audio/g729": {"source":"iana"},
  "audio/g7291": {"source":"iana"},
  "audio/g729d": {"source":"iana"},
  "audio/g729e": {"source":"iana"},
  "audio/gsm": {"source":"iana"},
  "audio/gsm-efr": {"source":"iana"},
  "audio/gsm-hr-08": {"source":"iana"},
  "audio/ilbc": {"source":"iana"},
  "audio/ip-mr_v2.5": {"source":"iana"},
  "audio/isac": {"source":"apache"},
  "audio/l16": {"source":"iana"},
  "audio/l20": {"source":"iana"},
  "audio/l24": {"source":"iana","compressible":false},
  "audio/l8": {"source":"iana"},
  "audio/lpc": {"source":"iana"},
  "audio/matroska": {"source":"iana"},
  "audio/melp": {"source":"iana"},
  "audio/melp1200": {"source":"iana"},
  "audio/melp2400": {"source":"iana"},
  "audio/melp600": {"source":"iana"},
  "audio/mhas": {"source":"iana"},
  "audio/midi": {"source":"apache","extensions":["mid","midi","kar","rmi"]},
  "audio/midi-clip": {"source":"iana"},
  "audio/mobile-xmf": {"source":"iana","extensions":["mxmf"]},
  "audio/mp3": {"compressible":false,"extensions":["mp3"]},
  "audio/mp4": {"source":"iana","compressible":false,"extensions":["m4a","mp4a","m4b"]},
  "audio/mp4a-latm": {"source":"iana"},
  "audio/mpa": {"source":"iana"},
  "audio/mpa-robust": {"source":"iana"},
  "audio/mpeg": {"source":"iana","compressible":false,"extensions":["mpga","mp2","mp2a","mp3","m2a","m3a"]},
  "audio/mpeg4-generic": {"source":"iana"},
  "audio/musepack": {"source":"apache"},
  "audio/ogg": {"source":"iana","compressible":false,"extensions":["oga","ogg","spx","opus"]},
  "audio/opus": {"source":"iana"},
  "audio/parityfec": {"source":"iana"},
  "audio/pcma": {"source":"iana"},
  "audio/pcma-wb": {"source":"iana"},
  "audio/pcmu": {"source":"iana"},
  "audio/pcmu-wb": {"source":"iana"},
  "audio/prs.sid": {"source":"iana"},
  "audio/qcelp": {"source":"iana"},
  "audio/raptorfec": {"source":"iana"},
  "audio/red": {"source":"iana"},
  "audio/rtp-enc-aescm128": {"source":"iana"},
  "audio/rtp-midi": {"source":"iana"},
  "audio/rtploopback": {"source":"iana"},
  "audio/rtx": {"source":"iana"},
  "audio/s3m": {"source":"apache","extensions":["s3m"]},
  "audio/scip": {"source":"iana"},
  "audio/silk": {"source":"apache","extensions":["sil"]},
  "audio/smv": {"source":"iana"},
  "audio/smv-qcp": {"source":"iana"},
  "audio/smv0": {"source":"iana"},
  "audio/sofa": {"source":"iana"},
  "audio/sp-midi": {"source":"iana"},
  "audio/speex": {"source":"iana"},
  "audio/t140c": {"source":"iana"},
  "audio/t38": {"source":"iana"},
  "audio/telephone-event": {"source":"iana"},
  "audio/tetra_acelp": {"source":"iana"},
  "audio/tetra_acelp_bb": {"source":"iana"},
  "audio/tone": {"source":"iana"},
  "audio/tsvcis": {"source":"iana"},
  "audio/uemclip": {"source":"iana"},
  "audio/ulpfec": {"source":"iana"},
  "audio/usac": {"source":"iana"},
  "audio/vdvi": {"source":"iana"},
  "audio/vmr-wb": {"source":"iana"},
  "audio/vnd.3gpp.iufp": {"source":"iana"},
  "audio/vnd.4sb": {"source":"iana"},
  "audio/vnd.audiokoz": {"source":"iana"},
  "audio/vnd.celp": {"source":"iana"},
  "audio/vnd.cisco.nse": {"source":"iana"},
  "audio/vnd.cmles.radio-events": {"source":"iana"},
  "audio/vnd.cns.anp1": {"source":"iana"},
  "audio/vnd.cns.inf1": {"source":"iana"},
  "audio/vnd.dece.audio": {"source":"iana","extensions":["uva","uvva"]},
  "audio/vnd.digital-winds": {"source":"iana","extensions":["eol"]},
  "audio/vnd.dlna.adts": {"source":"iana"},
  "audio/vnd.dolby.heaac.1": {"source":"iana"},
  "audio/vnd.dolby.heaac.2": {"source":"iana"},
  "audio/vnd.dolby.mlp": {"source":"iana"},
  "audio/vnd.dolby.mps": {"source":"iana"},
  "audio/vnd.dolby.pl2": {"source":"iana"},
  "audio/vnd.dolby.pl2x": {"source":"iana"},
  "audio/vnd.dolby.pl2z": {"source":"iana"},
  "audio/vnd.dolby.pulse.1": {"source":"iana"},
  "audio/vnd.dra": {"source":"iana","extensions":["dra"]},
  "audio/vnd.dts": {"source":"iana","extensions":["dts"]},
  "audio/vnd.dts.hd": {"source":"iana","extensions":["dtshd"]},
  "audio/vnd.dts.uhd": {"source":"iana"},
  "audio/vnd.dvb.file": {"source":"iana"},
  "audio/vnd.everad.plj": {"source":"iana"},
  "audio/vnd.hns.audio": {"source":"iana"},
  "audio/vnd.lucent.voice": {"source":"iana","extensions":["lvp"]},
  "audio/vnd.ms-playready.media.pya": {"source":"iana","extensions":["pya"]},
  "audio/vnd.nokia.mobile-xmf": {"source":"iana"},
  "audio/vnd.nortel.vbk": {"source":"iana"},
  "audio/vnd.nuera.ecelp4800": {"source":"iana","extensions":["ecelp4800"]},
  "audio/vnd.nuera.ecelp7470": {"source":"iana","extensions":["ecelp7470"]},
  "audio/vnd.nuera.ecelp9600": {"source":"iana","extensions":["ecelp9600"]},
  "audio/vnd.octel.sbc": {"source":"iana"},
  "audio/vnd.presonus.multitrack": {"source":"iana"},
  "audio/vnd.qcelp": {"source":"apache"},
  "audio/vnd.rhetorex.32kadpcm": {"source":"iana"},
  "audio/vnd.rip": {"source":"iana","extensions":["rip"]},
  "audio/vnd.rn-realaudio": {"compressible":false},
  "audio/vnd.sealedmedia.softseal.mpeg": {"source":"iana"},
  "audio/vnd.vmx.cvsd": {"source":"iana"},
  "audio/vnd.wave": {"compressible":false},
  "audio/vorbis": {"source":"iana","compressible":false},
  "audio/vorbis-config": {"source":"iana"},
  "audio/wav": {"compressible":false,"extensions":["wav"]},
  "audio/wave": {"compressible":false,"extensions":["wav"]},
  "audio/webm": {"source":"apache","compressible":false,"extensions":["weba"]},
  "audio/x-aac": {"source":"apache","compressible":false,"extensions":["aac"]},
  "audio/x-aiff": {"source":"apache","extensions":["aif","aiff","aifc"]},
  "audio/x-caf": {"source":"apache","compressible":false,"extensions":["caf"]},
  "audio/x-flac": {"source":"apache","extensions":["flac"]},
  "audio/x-m4a": {"source":"nginx","extensions":["m4a"]},
  "audio/x-matroska": {"source":"apache","extensions":["mka"]},
  "audio/x-mpegurl": {"source":"apache","extensions":["m3u"]},
  "audio/x-ms-wax": {"source":"apache","extensions":["wax"]},
  "audio/x-ms-wma": {"source":"apache","extensions":["wma"]},
  "audio/x-pn-realaudio": {"source":"apache","extensions":["ram","ra"]},
  "audio/x-pn-realaudio-plugin": {"source":"apache","extensions":["rmp"]},
  "audio/x-realaudio": {"source":"nginx","extensions":["ra"]},
  "audio/x-tta": {"source":"apache"},
  "audio/x-wav": {"source":"apache","extensions":["wav"]},
  "audio/xm": {"source":"apache","extensions":["xm"]},
  "chemical/x-cdx": {"source":"apache","extensions":["cdx"]},
  "chemical/x-cif": {"source":"apache","extensions":["cif"]},
  "chemical/x-cmdf": {"source":"apache","extensions":["cmdf"]},
  "chemical/x-cml": {"source":"apache","extensions":["cml"]},
  "chemical/x-csml": {"source":"apache","extensions":["csml"]},
  "chemical/x-pdb": {"source":"apache"},
  "chemical/x-xyz": {"source":"apache","extensions":["xyz"]},
  "font/collection": {"source":"iana","extensions":["ttc"]},
  "font/otf": {"source":"iana","compressible":true,"extensions":["otf"]},
  "font/sfnt": {"source":"iana"},
  "font/ttf": {"source":"iana","compressible":true,"extensions":["ttf"]},
  "font/woff": {"source":"iana","extensions":["woff"]},
  "font/woff2": {"source":"iana","extensions":["woff2"]},
  "image/aces": {"source":"iana","extensions":["exr"]},
  "image/apng": {"source":"iana","compressible":false,"extensions":["apng"]},
  "image/avci": {"source":"iana","extensions":["avci"]},
  "image/avcs": {"source":"iana","extensions":["avcs"]},
  "image/avif": {"source":"iana","compressible":false,"extensions":["avif"]},
  "image/bmp": {"source":"iana","compressible":true,"extensions":["bmp","dib"]},
  "image/cgm": {"source":"iana","extensions":["cgm"]},
  "image/dicom-rle": {"source":"iana","extensions":["drle"]},
  "image/dpx": {"source":"iana","extensions":["dpx"]},
  "image/emf": {"source":"iana","extensions":["emf"]},
  "image/fits": {"source":"iana","extensions":["fits"]},
  "image/g3fax": {"source":"iana","extensions":["g3"]},
  "image/gif": {"source":"iana","compressible":false,"extensions":["gif"]},
  "image/heic": {"source":"iana","extensions":["heic"]},
  "image/heic-sequence": {"source":"iana","extensions":["heics"]},
  "image/heif": {"source":"iana","extensions":["heif"]},
  "image/heif-sequence": {"source":"iana","extensions":["heifs"]},
  "image/hej2k": {"source":"iana","extensions":["hej2"]},
  "image/ief": {"source":"iana","extensions":["ief"]},
  "image/j2c": {"source":"iana"},
  "image/jaii": {"source":"iana","extensions":["jaii"]},
  "image/jais": {"source":"iana","extensions":["jais"]},
  "image/jls": {"source":"iana","extensions":["jls"]},
  "image/jp2": {"source":"iana","compressible":false,"extensions":["jp2","jpg2"]},
  "image/jpeg": {"source":"iana","compressible":false,"extensions":["jpg","jpeg","jpe"]},
  "image/jph": {"source":"iana","extensions":["jph"]},
  "image/jphc": {"source":"iana","extensions":["jhc"]},
  "image/jpm": {"source":"iana","compressible":false,"extensions":["jpm","jpgm"]},
  "image/jpx": {"source":"iana","compressible":false,"extensions":["jpx","jpf"]},
  "image/jxl": {"source":"iana","extensions":["jxl"]},
  "image/jxr": {"source":"iana","extensions":["jxr"]},
  "image/jxra": {"source":"iana","extensions":["jxra"]},
  "image/jxrs": {"source":"iana","extensions":["jxrs"]},
  "image/jxs": {"source":"iana","extensions":["jxs"]},
  "image/jxsc": {"source":"iana","extensions":["jxsc"]},
  "image/jxsi": {"source":"iana","extensions":["jxsi"]},
  "image/jxss": {"source":"iana","extensions":["jxss"]},
  "image/ktx": {"source":"iana","extensions":["ktx"]},
  "image/ktx2": {"source":"iana","extensions":["ktx2"]},
  "image/naplps": {"source":"iana"},
  "image/pjpeg": {"compressible":false,"extensions":["jfif"]},
  "image/png": {"source":"iana","compressible":false,"extensions":["png"]},
  "image/prs.btif": {"source":"iana","extensions":["btif","btf"]},
  "image/prs.pti": {"source":"iana","extensions":["pti"]},
  "image/pwg-raster": {"source":"iana"},
  "image/sgi": {"source":"apache","extensions":["sgi"]},
  "image/svg+xml": {"source":"iana","compressible":true,"extensions":["svg","svgz"]},
  "image/t38": {"source":"iana","extensions":["t38"]},
  "image/tiff": {"source":"iana","compressible":false,"extensions":["tif","tiff"]},
  "image/tiff-fx": {"source":"iana","extensions":["tfx"]},
  "image/vnd.adobe.photoshop": {"source":"iana","compressible":true,"extensions":["psd"]},
  "image/vnd.airzip.accelerator.azv": {"source":"iana","extensions":["azv"]},
  "image/vnd.clip": {"source":"iana"},
  "image/vnd.cns.inf2": {"source":"iana"},
  "image/vnd.dece.graphic": {"source":"iana","extensions":["uvi","uvvi","uvg","uvvg"]},
  "image/vnd.djvu": {"source":"iana","extensions":["djvu","djv"]},
  "image/vnd.dvb.subtitle": {"source":"iana","extensions":["sub"]},
  "image/vnd.dwg": {"source":"iana","extensions":["dwg"]},
  "image/vnd.dxf": {"source":"iana","extensions":["dxf"]},
  "image/vnd.fastbidsheet": {"source":"iana","extensions":["fbs"]},
  "image/vnd.fpx": {"source":"iana","extensions":["fpx"]},
  "image/vnd.fst": {"source":"iana","extensions":["fst"]},
  "image/vnd.fujixerox.edmics-mmr": {"source":"iana","extensions":["mmr"]},
  "image/vnd.fujixerox.edmics-rlc": {"source":"iana","extensions":["rlc"]},
  "image/vnd.globalgraphics.pgb": {"source":"iana"},
  "image/vnd.microsoft.icon": {"source":"iana","compressible":true,"extensions":["ico"]},
  "image/vnd.mix": {"source":"iana"},
  "image/vnd.mozilla.apng": {"source":"iana"},
  "image/vnd.ms-dds": {"compressible":true,"extensions":["dds"]},
  "image/vnd.ms-modi": {"source":"iana","extensions":["mdi"]},
  "image/vnd.ms-photo": {"source":"apache","extensions":["wdp"]},
  "image/vnd.net-fpx": {"source":"iana","extensions":["npx"]},
  "image/vnd.pco.b16": {"source":"iana","extensions":["b16"]},
  "image/vnd.radiance": {"source":"iana"},
  "image/vnd.sealed.png": {"source":"iana"},
  "image/vnd.sealedmedia.softseal.gif": {"source":"iana"},
  "image/vnd.sealedmedia.softseal.jpg": {"source":"iana"},
  "image/vnd.svf": {"source":"iana"},
  "image/vnd.tencent.tap": {"source":"iana","extensions":["tap"]},
  "image/vnd.valve.source.texture": {"source":"iana","extensions":["vtf"]},
  "image/vnd.wap.wbmp": {"source":"iana","extensions":["wbmp"]},
  "image/vnd.xiff": {"source":"iana","extensions":["xif"]},
  "image/vnd.zbrush.pcx": {"source":"iana","extensions":["pcx"]},
  "image/webp": {"source":"iana","extensions":["webp"]},
  "image/wmf": {"source":"iana","extensions":["wmf"]},
  "image/x-3ds": {"source":"apache","extensions":["3ds"]},
  "image/x-adobe-dng": {"extensions":["dng"]},
  "image/x-cmu-raster": {"source":"apache","extensions":["ras"]},
  "image/x-cmx": {"source":"apache","extensions":["cmx"]},
  "image/x-emf": {"source":"iana"},
  "image/x-freehand": {"source":"apache","extensions":["fh","fhc","fh4","fh5","fh7"]},
  "image/x-icon": {"source":"apache","compressible":true,"extensions":["ico"]},
  "image/x-jng": {"source":"nginx","extensions":["jng"]},
  "image/x-mrsid-image": {"source":"apache","extensions":["sid"]},
  "image/x-ms-bmp": {"source":"nginx","compressible":true,"extensions":["bmp"]},
  "image/x-pcx": {"source":"apache","extensions":["pcx"]},
  "image/x-pict": {"source":"apache","extensions":["pic","pct"]},
  "image/x-portable-anymap": {"source":"apache","extensions":["pnm"]},
  "image/x-portable-bitmap": {"source":"apache","extensions":["pbm"]},
  "image/x-portable-graymap": {"source":"apache","extensions":["pgm"]},
  "image/x-portable-pixmap": {"source":"apache","extensions":["ppm"]},
  "image/x-rgb": {"source":"apache","extensions":["rgb"]},
  "image/x-tga": {"source":"apache","extensions":["tga"]},
  "image/x-wmf": {"source":"iana"},
  "image/x-xbitmap": {"source":"apache","extensions":["xbm"]},
  "image/x-xcf": {"compressible":false},
  "image/x-xpixmap": {"source":"apache","extensions":["xpm"]},
  "image/x-xwindowdump": {"source":"apache","extensions":["xwd"]},
  "message/bhttp": {"source":"iana"},
  "message/cpim": {"source":"iana"},
  "message/delivery-status": {"source":"iana"},
  "message/disposition-notification": {"source":"iana","extensions":["disposition-notification"]},
  "message/external-body": {"source":"iana"},
  "message/feedback-report": {"source":"iana"},
  "message/global": {"source":"iana","extensions":["u8msg"]},
  "message/global-delivery-status": {"source":"iana","extensions":["u8dsn"]},
  "message/global-disposition-notification": {"source":"iana","extensions":["u8mdn"]},
  "message/global-headers": {"source":"iana","extensions":["u8hdr"]},
  "message/http": {"source":"iana","compressible":false},
  "message/imdn+xml": {"source":"iana","compressible":true},
  "message/mls": {"source":"iana"},
  "message/news": {"source":"apache"},
  "message/ohttp-req": {"source":"iana"},
  "message/ohttp-res": {"source":"iana"},
  "message/partial": {"source":"iana","compressible":false},
  "message/rfc822": {"source":"iana","compressible":true,"extensions":["eml","mime","mht","mhtml"]},
  "message/s-http": {"source":"apache"},
  "message/sip": {"source":"iana"},
  "message/sipfrag": {"source":"iana"},
  "message/tracking-status": {"source":"iana"},
  "message/vnd.si.simp": {"source":"apache"},
  "message/vnd.wfa.wsc": {"source":"iana","extensions":["wsc"]},
  "model/3mf": {"source":"iana","extensions":["3mf"]},
  "model/e57": {"source":"iana"},
  "model/gltf+json": {"source":"iana","compressible":true,"extensions":["gltf"]},
  "model/gltf-binary": {"source":"iana","compressible":true,"extensions":["glb"]},
  "model/iges": {"source":"iana","compressible":false,"extensions":["igs","iges"]},
  "model/jt": {"source":"iana","extensions":["jt"]},
  "model/mesh": {"source":"iana","compressible":false,"extensions":["msh","mesh","silo"]},
  "model/mtl": {"source":"iana","extensions":["mtl"]},
  "model/obj": {"source":"iana","extensions":["obj"]},
  "model/prc": {"source":"iana","extensions":["prc"]},
  "model/step": {"source":"iana","extensions":["step","stp","stpnc","p21","210"]},
  "model/step+xml": {"source":"iana","compressible":true,"extensions":["stpx"]},
  "model/step+zip": {"source":"iana","compressible":false,"extensions":["stpz"]},
  "model/step-xml+zip": {"source":"iana","compressible":false,"extensions":["stpxz"]},
  "model/stl": {"source":"iana","extensions":["stl"]},
  "model/u3d": {"source":"iana","extensions":["u3d"]},
  "model/vnd.bary": {"source":"iana","extensions":["bary"]},
  "model/vnd.cld": {"source":"iana","extensions":["cld"]},
  "model/vnd.collada+xml": {"source":"iana","compressible":true,"extensions":["dae"]},
  "model/vnd.dwf": {"source":"iana","extensions":["dwf"]},
  "model/vnd.flatland.3dml": {"source":"iana"},
  "model/vnd.gdl": {"source":"iana","extensions":["gdl"]},
  "model/vnd.gs-gdl": {"source":"apache"},
  "model/vnd.gs.gdl": {"source":"iana"},
  "model/vnd.gtw": {"source":"iana","extensions":["gtw"]},
  "model/vnd.moml+xml": {"source":"iana","compressible":true},
  "model/vnd.mts": {"source":"iana","extensions":["mts"]},
  "model/vnd.opengex": {"source":"iana","extensions":["ogex"]},
  "model/vnd.parasolid.transmit.binary": {"source":"iana","extensions":["x_b"]},
  "model/vnd.parasolid.transmit.text": {"source":"iana","extensions":["x_t"]},
  "model/vnd.pytha.pyox": {"source":"iana","extensions":["pyo","pyox"]},
  "model/vnd.rosette.annotated-data-model": {"source":"iana"},
  "model/vnd.sap.vds": {"source":"iana","extensions":["vds"]},
  "model/vnd.usda": {"source":"iana","extensions":["usda"]},
  "model/vnd.usdz+zip": {"source":"iana","compressible":false,"extensions":["usdz"]},
  "model/vnd.valve.source.compiled-map": {"source":"iana","extensions":["bsp"]},
  "model/vnd.vtu": {"source":"iana","extensions":["vtu"]},
  "model/vrml": {"source":"iana","compressible":false,"extensions":["wrl","vrml"]},
  "model/x3d+binary": {"source":"apache","compressible":false,"extensions":["x3db","x3dbz"]},
  "model/x3d+fastinfoset": {"source":"iana","extensions":["x3db"]},
  "model/x3d+vrml": {"source":"apache","compressible":false,"extensions":["x3dv","x3dvz"]},
  "model/x3d+xml": {"source":"iana","compressible":true,"extensions":["x3d","x3dz"]},
  "model/x3d-vrml": {"source":"iana","extensions":["x3dv"]},
  "multipart/alternative": {"source":"iana","compressible":false},
  "multipart/appledouble": {"source":"iana"},
  "multipart/byteranges": {"source":"iana"},
  "multipart/digest": {"source":"iana"},
  "multipart/encrypted": {"source":"iana","compressible":false},
  "multipart/form-data": {"source":"iana","compressible":false},
  "multipart/header-set": {"source":"iana"},
  "multipart/mixed": {"source":"iana"},
  "multipart/multilingual": {"source":"iana"},
  "multipart/parallel": {"source":"iana"},
  "multipart/related": {"source":"iana","compressible":false},
  "multipart/report": {"source":"iana"},
  "multipart/signed": {"source":"iana","compressible":false},
  "multipart/vnd.bint.med-plus": {"source":"iana"},
  "multipart/voice-message": {"source":"iana"},
  "multipart/x-mixed-replace": {"source":"iana"},
  "text/1d-interleaved-parityfec": {"source":"iana"},
  "text/cache-manifest": {"source":"iana","compressible":true,"extensions":["appcache","manifest"]},
  "text/calendar": {"source":"iana","extensions":["ics","ifb"]},
  "text/calender": {"compressible":true},
  "text/cmd": {"compressible":true},
  "text/coffeescript": {"extensions":["coffee","litcoffee"]},
  "text/cql": {"source":"iana"},
  "text/cql-expression": {"source":"iana"},
  "text/cql-identifier": {"source":"iana"},
  "text/css": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["css"]},
  "text/csv": {"source":"iana","compressible":true,"extensions":["csv"]},
  "text/csv-schema": {"source":"iana"},
  "text/directory": {"source":"iana"},
  "text/dns": {"source":"iana"},
  "text/ecmascript": {"source":"apache"},
  "text/encaprtp": {"source":"iana"},
  "text/enriched": {"source":"iana"},
  "text/fhirpath": {"source":"iana"},
  "text/flexfec": {"source":"iana"},
  "text/fwdred": {"source":"iana"},
  "text/gff3": {"source":"iana"},
  "text/grammar-ref-list": {"source":"iana"},
  "text/hl7v2": {"source":"iana"},
  "text/html": {"source":"iana","compressible":true,"extensions":["html","htm","shtml"]},
  "text/jade": {"extensions":["jade"]},
  "text/javascript": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["js","mjs"]},
  "text/jcr-cnd": {"source":"iana"},
  "text/jsx": {"compressible":true,"extensions":["jsx"]},
  "text/less": {"compressible":true,"extensions":["less"]},
  "text/markdown": {"source":"iana","compressible":true,"extensions":["md","markdown"]},
  "text/mathml": {"source":"nginx","extensions":["mml"]},
  "text/mdx": {"compressible":true,"extensions":["mdx"]},
  "text/mizar": {"source":"iana"},
  "text/n3": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["n3"]},
  "text/parameters": {"source":"iana","charset":"UTF-8"},
  "text/parityfec": {"source":"iana"},
  "text/plain": {"source":"iana","compressible":true,"extensions":["txt","text","conf","def","list","log","in","ini"]},
  "text/provenance-notation": {"source":"iana","charset":"UTF-8"},
  "text/prs.fallenstein.rst": {"source":"iana"},
  "text/prs.lines.tag": {"source":"iana","extensions":["dsc"]},
  "text/prs.prop.logic": {"source":"iana"},
  "text/prs.texi": {"source":"iana"},
  "text/raptorfec": {"source":"iana"},
  "text/red": {"source":"iana"},
  "text/rfc822-headers": {"source":"iana"},
  "text/richtext": {"source":"iana","compressible":true,"extensions":["rtx"]},
  "text/rtf": {"source":"iana","compressible":true,"extensions":["rtf"]},
  "text/rtp-enc-aescm128": {"source":"iana"},
  "text/rtploopback": {"source":"iana"},
  "text/rtx": {"source":"iana"},
  "text/sgml": {"source":"iana","extensions":["sgml","sgm"]},
  "text/shaclc": {"source":"iana"},
  "text/shex": {"source":"iana","extensions":["shex"]},
  "text/slim": {"extensions":["slim","slm"]},
  "text/spdx": {"source":"iana","extensions":["spdx"]},
  "text/strings": {"source":"iana"},
  "text/stylus": {"extensions":["stylus","styl"]},
  "text/t140": {"source":"iana"},
  "text/tab-separated-values": {"source":"iana","compressible":true,"extensions":["tsv"]},
  "text/troff": {"source":"iana","extensions":["t","tr","roff","man","me","ms"]},
  "text/turtle": {"source":"iana","charset":"UTF-8","extensions":["ttl"]},
  "text/ulpfec": {"source":"iana"},
  "text/uri-list": {"source":"iana","compressible":true,"extensions":["uri","uris","urls"]},
  "text/vcard": {"source":"iana","compressible":true,"extensions":["vcard"]},
  "text/vnd.a": {"source":"iana"},
  "text/vnd.abc": {"source":"iana"},
  "text/vnd.ascii-art": {"source":"iana"},
  "text/vnd.curl": {"source":"iana","extensions":["curl"]},
  "text/vnd.curl.dcurl": {"source":"apache","extensions":["dcurl"]},
  "text/vnd.curl.mcurl": {"source":"apache","extensions":["mcurl"]},
  "text/vnd.curl.scurl": {"source":"apache","extensions":["scurl"]},
  "text/vnd.debian.copyright": {"source":"iana","charset":"UTF-8"},
  "text/vnd.dmclientscript": {"source":"iana"},
  "text/vnd.dvb.subtitle": {"source":"iana","extensions":["sub"]},
  "text/vnd.esmertec.theme-descriptor": {"source":"iana","charset":"UTF-8"},
  "text/vnd.exchangeable": {"source":"iana"},
  "text/vnd.familysearch.gedcom": {"source":"iana","extensions":["ged"]},
  "text/vnd.ficlab.flt": {"source":"iana"},
  "text/vnd.fly": {"source":"iana","extensions":["fly"]},
  "text/vnd.fmi.flexstor": {"source":"iana","extensions":["flx"]},
  "text/vnd.gml": {"source":"iana"},
  "text/vnd.graphviz": {"source":"iana","extensions":["gv"]},
  "text/vnd.hans": {"source":"iana"},
  "text/vnd.hgl": {"source":"iana"},
  "text/vnd.in3d.3dml": {"source":"iana","extensions":["3dml"]},
  "text/vnd.in3d.spot": {"source":"iana","extensions":["spot"]},
  "text/vnd.iptc.newsml": {"source":"iana"},
  "text/vnd.iptc.nitf": {"source":"iana"},
  "text/vnd.latex-z": {"source":"iana"},
  "text/vnd.motorola.reflex": {"source":"iana"},
  "text/vnd.ms-mediapackage": {"source":"iana"},
  "text/vnd.net2phone.commcenter.command": {"source":"iana"},
  "text/vnd.radisys.msml-basic-layout": {"source":"iana"},
  "text/vnd.senx.warpscript": {"source":"iana"},
  "text/vnd.si.uricatalogue": {"source":"apache"},
  "text/vnd.sosi": {"source":"iana"},
  "text/vnd.sun.j2me.app-descriptor": {"source":"iana","charset":"UTF-8","extensions":["jad"]},
  "text/vnd.trolltech.linguist": {"source":"iana","charset":"UTF-8"},
  "text/vnd.vcf": {"source":"iana"},
  "text/vnd.wap.si": {"source":"iana"},
  "text/vnd.wap.sl": {"source":"iana"},
  "text/vnd.wap.wml": {"source":"iana","extensions":["wml"]},
  "text/vnd.wap.wmlscript": {"source":"iana","extensions":["wmls"]},
  "text/vnd.zoo.kcl": {"source":"iana"},
  "text/vtt": {"source":"iana","charset":"UTF-8","compressible":true,"extensions":["vtt"]},
  "text/wgsl": {"source":"iana","extensions":["wgsl"]},
  "text/x-asm": {"source":"apache","extensions":["s","asm"]},
  "text/x-c": {"source":"apache","extensions":["c","cc","cxx","cpp","h","hh","dic"]},
  "text/x-component": {"source":"nginx","extensions":["htc"]},
  "text/x-fortran": {"source":"apache","extensions":["f","for","f77","f90"]},
  "text/x-gwt-rpc": {"compressible":true},
  "text/x-handlebars-template": {"extensions":["hbs"]},
  "text/x-java-source": {"source":"apache","extensions":["java"]},
  "text/x-jquery-tmpl": {"compressible":true},
  "text/x-lua": {"extensions":["lua"]},
  "text/x-markdown": {"compressible":true,"extensions":["mkd"]},
  "text/x-nfo": {"source":"apache","extensions":["nfo"]},
  "text/x-opml": {"source":"apache","extensions":["opml"]},
  "text/x-org": {"compressible":true,"extensions":["org"]},
  "text/x-pascal": {"source":"apache","extensions":["p","pas"]},
  "text/x-processing": {"compressible":true,"extensions":["pde"]},
  "text/x-sass": {"extensions":["sass"]},
  "text/x-scss": {"extensions":["scss"]},
  "text/x-setext": {"source":"apache","extensions":["etx"]},
  "text/x-sfv": {"source":"apache","extensions":["sfv"]},
  "text/x-suse-ymp": {"compressible":true,"extensions":["ymp"]},
  "text/x-uuencode": {"source":"apache","extensions":["uu"]},
  "text/x-vcalendar": {"source":"apache","extensions":["vcs"]},
  "text/x-vcard": {"source":"apache","extensions":["vcf"]},
  "text/xml": {"source":"iana","compressible":true,"extensions":["xml"]},
  "text/xml-external-parsed-entity": {"source":"iana"},
  "text/yaml": {"compressible":true,"extensions":["yaml","yml"]},
  "video/1d-interleaved-parityfec": {"source":"iana"},
  "video/3gpp": {"source":"iana","extensions":["3gp","3gpp"]},
  "video/3gpp-tt": {"source":"iana"},
  "video/3gpp2": {"source":"iana","extensions":["3g2"]},
  "video/av1": {"source":"iana"},
  "video/bmpeg": {"source":"iana"},
  "video/bt656": {"source":"iana"},
  "video/celb": {"source":"iana"},
  "video/dv": {"source":"iana"},
  "video/encaprtp": {"source":"iana"},
  "video/evc": {"source":"iana"},
  "video/ffv1": {"source":"iana"},
  "video/flexfec": {"source":"iana"},
  "video/h261": {"source":"iana","extensions":["h261"]},
  "video/h263": {"source":"iana","extensions":["h263"]},
  "video/h263-1998": {"source":"iana"},
  "video/h263-2000": {"source":"iana"},
  "video/h264": {"source":"iana","extensions":["h264"]},
  "video/h264-rcdo": {"source":"iana"},
  "video/h264-svc": {"source":"iana"},
  "video/h265": {"source":"iana"},
  "video/h266": {"source":"iana"},
  "video/iso.segment": {"source":"iana","extensions":["m4s"]},
  "video/jpeg": {"source":"iana","extensions":["jpgv"]},
  "video/jpeg2000": {"source":"iana"},
  "video/jpm": {"source":"apache","extensions":["jpm","jpgm"]},
  "video/jxsv": {"source":"iana"},
  "video/lottie+json": {"source":"iana","compressible":true},
  "video/matroska": {"source":"iana"},
  "video/matroska-3d": {"source":"iana"},
  "video/mj2": {"source":"iana","extensions":["mj2","mjp2"]},
  "video/mp1s": {"source":"iana"},
  "video/mp2p": {"source":"iana"},
  "video/mp2t": {"source":"iana","extensions":["ts","m2t","m2ts","mts"]},
  "video/mp4": {"source":"iana","compressible":false,"extensions":["mp4","mp4v","mpg4"]},
  "video/mp4v-es": {"source":"iana"},
  "video/mpeg": {"source":"iana","compressible":false,"extensions":["mpeg","mpg","mpe","m1v","m2v"]},
  "video/mpeg4-generic": {"source":"iana"},
  "video/mpv": {"source":"iana"},
  "video/nv": {"source":"iana"},
  "video/ogg": {"source":"iana","compressible":false,"extensions":["ogv"]},
  "video/parityfec": {"source":"iana"},
  "video/pointer": {"source":"iana"},
  "video/quicktime": {"source":"iana","compressible":false,"extensions":["qt","mov"]},
  "video/raptorfec": {"source":"iana"},
  "video/raw": {"source":"iana"},
  "video/rtp-enc-aescm128": {"source":"iana"},
  "video/rtploopback": {"source":"iana"},
  "video/rtx": {"source":"iana"},
  "video/scip": {"source":"iana"},
  "video/smpte291": {"source":"iana"},
  "video/smpte292m": {"source":"iana"},
  "video/ulpfec": {"source":"iana"},
  "video/vc1": {"source":"iana"},
  "video/vc2": {"source":"iana"},
  "video/vnd.cctv": {"source":"iana"},
  "video/vnd.dece.hd": {"source":"iana","extensions":["uvh","uvvh"]},
  "video/vnd.dece.mobile": {"source":"iana","extensions":["uvm","uvvm"]},
  "video/vnd.dece.mp4": {"source":"iana"},
  "video/vnd.dece.pd": {"source":"iana","extensions":["uvp","uvvp"]},
  "video/vnd.dece.sd": {"source":"iana","extensions":["uvs","uvvs"]},
  "video/vnd.dece.video": {"source":"iana","extensions":["uvv","uvvv"]},
  "video/vnd.directv.mpeg": {"source":"iana"},
  "video/vnd.directv.mpeg-tts": {"source":"iana"},
  "video/vnd.dlna.mpeg-tts": {"source":"iana"},
  "video/vnd.dvb.file": {"source":"iana","extensions":["dvb"]},
  "video/vnd.fvt": {"source":"iana","extensions":["fvt"]},
  "video/vnd.hns.video": {"source":"iana"},
  "video/vnd.iptvforum.1dparityfec-1010": {"source":"iana"},
  "video/vnd.iptvforum.1dparityfec-2005": {"source":"iana"},
  "video/vnd.iptvforum.2dparityfec-1010": {"source":"iana"},
  "video/vnd.iptvforum.2dparityfec-2005": {"source":"iana"},
  "video/vnd.iptvforum.ttsavc": {"source":"iana"},
  "video/vnd.iptvforum.ttsmpeg2": {"source":"iana"},
  "video/vnd.motorola.video": {"source":"iana"},
  "video/vnd.motorola.videop": {"source":"iana"},
  "video/vnd.mpegurl": {"source":"iana","extensions":["mxu","m4u"]},
  "video/vnd.ms-playready.media.pyv": {"source":"iana","extensions":["pyv"]},
  "video/vnd.nokia.interleaved-multimedia": {"source":"iana"},
  "video/vnd.nokia.mp4vr": {"source":"iana"},
  "video/vnd.nokia.videovoip": {"source":"iana"},
  "video/vnd.objectvideo": {"source":"iana"},
  "video/vnd.planar": {"source":"iana"},
  "video/vnd.radgamettools.bink": {"source":"iana"},
  "video/vnd.radgamettools.smacker": {"source":"apache"},
  "video/vnd.sealed.mpeg1": {"source":"iana"},
  "video/vnd.sealed.mpeg4": {"source":"iana"},
  "video/vnd.sealed.swf": {"source":"iana"},
  "video/vnd.sealedmedia.softseal.mov": {"source":"iana"},
  "video/vnd.uvvu.mp4": {"source":"iana","extensions":["uvu","uvvu"]},
  "video/vnd.vivo": {"source":"iana","extensions":["viv"]},
  "video/vnd.youtube.yt": {"source":"iana"},
  "video/vp8": {"source":"iana"},
  "video/vp9": {"source":"iana"},
  "video/webm": {"source":"apache","compressible":false,"extensions":["webm"]},
  "video/x-f4v": {"source":"apache","extensions":["f4v"]},
  "video/x-fli": {"source":"apache","extensions":["fli"]},
  "video/x-flv": {"source":"apache","compressible":false,"extensions":["flv"]},
  "video/x-m4v": {"source":"apache","extensions":["m4v"]},
  "video/x-matroska": {"source":"apache","compressible":false,"extensions":["mkv","mk3d","mks"]},
  "video/x-mng": {"source":"apache","extensions":["mng"]},
  "video/x-ms-asf": {"source":"apache","extensions":["asf","asx"]},
  "video/x-ms-vob": {"source":"apache","extensions":["vob"]},
  "video/x-ms-wm": {"source":"apache","extensions":["wm"]},
  "video/x-ms-wmv": {"source":"apache","compressible":false,"extensions":["wmv"]},
  "video/x-ms-wmx": {"source":"apache","extensions":["wmx"]},
  "video/x-ms-wvx": {"source":"apache","extensions":["wvx"]},
  "video/x-msvideo": {"source":"apache","extensions":["avi"]},
  "video/x-sgi-movie": {"source":"apache","extensions":["movie"]},
  "video/x-smv": {"source":"apache","extensions":["smv"]},
  "x-conference/x-cooltalk": {"source":"apache","extensions":["ice"]},
  "x-shader/x-fragment": {"compressible":true},
  "x-shader/x-vertex": {"compressible":true},
};

/*!
 * mime-db
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2015-2022 Douglas Christopher Wilson
 * MIT Licensed
 */

var mimeDb;
var hasRequiredMimeDb;

function requireMimeDb () {
	if (hasRequiredMimeDb) return mimeDb;
	hasRequiredMimeDb = 1;
	/**
	 * Module exports.
	 */

	mimeDb = require$$0$1;
	return mimeDb;
}

var mimeScore;
var hasRequiredMimeScore;

function requireMimeScore () {
	if (hasRequiredMimeScore) return mimeScore;
	hasRequiredMimeScore = 1;
	// 'mime-score' back-ported to CommonJS

	// Score RFC facets (see https://tools.ietf.org/html/rfc6838#section-3)
	var FACET_SCORES = {
	  'prs.': 100,
	  'x-': 200,
	  'x.': 300,
	  'vnd.': 400,
	  default: 900
	};

	// Score mime source (Logic originally from `jshttp/mime-types` module)
	var SOURCE_SCORES = {
	  nginx: 10,
	  apache: 20,
	  iana: 40,
	  default: 30 // definitions added by `jshttp/mime-db` project?
	};

	var TYPE_SCORES = {
	  // prefer application/xml over text/xml
	  // prefer application/rtf over text/rtf
	  application: 1,

	  // prefer font/woff over application/font-woff
	  font: 2,

	  default: 0
	};

	/**
	 * Get each component of the score for a mime type.  The sum of these is the
	 * total score.  The higher the score, the more "official" the type.
	 */
	mimeScore = function mimeScore (mimeType, source = 'default') {
	  if (mimeType === 'application/octet-stream') {
	    return 0
	  }

	  const [type, subtype] = mimeType.split('/');

	  const facet = subtype.replace(/(\.|x-).*/, '$1');

	  const facetScore = FACET_SCORES[facet] || FACET_SCORES.default;
	  const sourceScore = SOURCE_SCORES[source] || SOURCE_SCORES.default;
	  const typeScore = TYPE_SCORES[type] || TYPE_SCORES.default;

	  // All else being equal prefer shorter types
	  const lengthScore = 1 - mimeType.length / 100;

	  return facetScore + sourceScore + typeScore + lengthScore
	};
	return mimeScore;
}

/*!
 * mime-types
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2015 Douglas Christopher Wilson
 * MIT Licensed
 */

var hasRequiredMimeTypes;

function requireMimeTypes () {
	if (hasRequiredMimeTypes) return mimeTypes;
	hasRequiredMimeTypes = 1;
	(function (exports) {

		/**
		 * Module dependencies.
		 * @private
		 */

		var db = requireMimeDb();
		var extname = require$$0$4.extname;
		var mimeScore = requireMimeScore();

		/**
		 * Module variables.
		 * @private
		 */

		var EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/;
		var TEXT_TYPE_REGEXP = /^text\//i;

		/**
		 * Module exports.
		 * @public
		 */

		exports.charset = charset;
		exports.charsets = { lookup: charset };
		exports.contentType = contentType;
		exports.extension = extension;
		exports.extensions = Object.create(null);
		exports.lookup = lookup;
		exports.types = Object.create(null);
		exports._extensionConflicts = [];

		// Populate the extensions/types maps
		populateMaps(exports.extensions, exports.types);

		/**
		 * Get the default charset for a MIME type.
		 *
		 * @param {string} type
		 * @return {boolean|string}
		 */

		function charset (type) {
		  if (!type || typeof type !== 'string') {
		    return false
		  }

		  // TODO: use media-typer
		  var match = EXTRACT_TYPE_REGEXP.exec(type);
		  var mime = match && db[match[1].toLowerCase()];

		  if (mime && mime.charset) {
		    return mime.charset
		  }

		  // default text/* to utf-8
		  if (match && TEXT_TYPE_REGEXP.test(match[1])) {
		    return 'UTF-8'
		  }

		  return false
		}

		/**
		 * Create a full Content-Type header given a MIME type or extension.
		 *
		 * @param {string} str
		 * @return {boolean|string}
		 */

		function contentType (str) {
		  // TODO: should this even be in this module?
		  if (!str || typeof str !== 'string') {
		    return false
		  }

		  var mime = str.indexOf('/') === -1 ? exports.lookup(str) : str;

		  if (!mime) {
		    return false
		  }

		  // TODO: use content-type or other module
		  if (mime.indexOf('charset') === -1) {
		    var charset = exports.charset(mime);
		    if (charset) mime += '; charset=' + charset.toLowerCase();
		  }

		  return mime
		}

		/**
		 * Get the default extension for a MIME type.
		 *
		 * @param {string} type
		 * @return {boolean|string}
		 */

		function extension (type) {
		  if (!type || typeof type !== 'string') {
		    return false
		  }

		  // TODO: use media-typer
		  var match = EXTRACT_TYPE_REGEXP.exec(type);

		  // get extensions
		  var exts = match && exports.extensions[match[1].toLowerCase()];

		  if (!exts || !exts.length) {
		    return false
		  }

		  return exts[0]
		}

		/**
		 * Lookup the MIME type for a file path/extension.
		 *
		 * @param {string} path
		 * @return {boolean|string}
		 */

		function lookup (path) {
		  if (!path || typeof path !== 'string') {
		    return false
		  }

		  // get the extension ("ext" or ".ext" or full path)
		  var extension = extname('x.' + path)
		    .toLowerCase()
		    .slice(1);

		  if (!extension) {
		    return false
		  }

		  return exports.types[extension] || false
		}

		/**
		 * Populate the extensions and types maps.
		 * @private
		 */

		function populateMaps (extensions, types) {
		  Object.keys(db).forEach(function forEachMimeType (type) {
		    var mime = db[type];
		    var exts = mime.extensions;

		    if (!exts || !exts.length) {
		      return
		    }

		    // mime -> extensions
		    extensions[type] = exts;

		    // extension -> mime
		    for (var i = 0; i < exts.length; i++) {
		      var extension = exts[i];
		      types[extension] = _preferredType(extension, types[extension], type);

		      // DELETE (eventually): Capture extension->type maps that change as a
		      // result of switching to mime-score.  This is just to help make reviewing
		      // PR #119 easier, and can be removed once that PR is approved.
		      const legacyType = _preferredTypeLegacy(
		        extension,
		        types[extension],
		        type
		      );
		      if (legacyType !== types[extension]) {
		        exports._extensionConflicts.push([extension, legacyType, types[extension]]);
		      }
		    }
		  });
		}

		// Resolve type conflict using mime-score
		function _preferredType (ext, type0, type1) {
		  var score0 = type0 ? mimeScore(type0, db[type0].source) : 0;
		  var score1 = type1 ? mimeScore(type1, db[type1].source) : 0;

		  return score0 > score1 ? type0 : type1
		}

		// Resolve type conflict using pre-mime-score logic
		function _preferredTypeLegacy (ext, type0, type1) {
		  var SOURCE_RANK = ['nginx', 'apache', undefined, 'iana'];

		  var score0 = type0 ? SOURCE_RANK.indexOf(db[type0].source) : 0;
		  var score1 = type1 ? SOURCE_RANK.indexOf(db[type1].source) : 0;

		  if (
		    exports.types[extension] !== 'application/octet-stream' &&
		    (score0 > score1 ||
		      (score0 === score1 &&
		        exports.types[extension]?.slice(0, 12) === 'application/'))
		  ) {
		    return type0
		  }

		  return score0 > score1 ? type0 : type1
		} 
	} (mimeTypes));
	return mimeTypes;
}

var onFinished = {exports: {}};

/*!
 * ee-first
 * Copyright(c) 2014 Jonathan Ong
 * MIT Licensed
 */

var eeFirst;
var hasRequiredEeFirst;

function requireEeFirst () {
	if (hasRequiredEeFirst) return eeFirst;
	hasRequiredEeFirst = 1;

	/**
	 * Module exports.
	 * @public
	 */

	eeFirst = first;

	/**
	 * Get the first event in a set of event emitters and event pairs.
	 *
	 * @param {array} stuff
	 * @param {function} done
	 * @public
	 */

	function first(stuff, done) {
	  if (!Array.isArray(stuff))
	    throw new TypeError('arg must be an array of [ee, events...] arrays')

	  var cleanups = [];

	  for (var i = 0; i < stuff.length; i++) {
	    var arr = stuff[i];

	    if (!Array.isArray(arr) || arr.length < 2)
	      throw new TypeError('each array member must be [ee, events...]')

	    var ee = arr[0];

	    for (var j = 1; j < arr.length; j++) {
	      var event = arr[j];
	      var fn = listener(event, callback);

	      // listen to the event
	      ee.on(event, fn);
	      // push this listener to the list of cleanups
	      cleanups.push({
	        ee: ee,
	        event: event,
	        fn: fn,
	      });
	    }
	  }

	  function callback() {
	    cleanup();
	    done.apply(null, arguments);
	  }

	  function cleanup() {
	    var x;
	    for (var i = 0; i < cleanups.length; i++) {
	      x = cleanups[i];
	      x.ee.removeListener(x.event, x.fn);
	    }
	  }

	  function thunk(fn) {
	    done = fn;
	  }

	  thunk.cancel = cleanup;

	  return thunk
	}

	/**
	 * Create the event listener.
	 * @private
	 */

	function listener(event, done) {
	  return function onevent(arg1) {
	    var args = new Array(arguments.length);
	    var ee = this;
	    var err = event === 'error'
	      ? arg1
	      : null;

	    // copy args to prevent arguments escaping scope
	    for (var i = 0; i < args.length; i++) {
	      args[i] = arguments[i];
	    }

	    done(err, ee, event, args);
	  }
	}
	return eeFirst;
}

/*!
 * on-finished
 * Copyright(c) 2013 Jonathan Ong
 * Copyright(c) 2014 Douglas Christopher Wilson
 * MIT Licensed
 */

var hasRequiredOnFinished;

function requireOnFinished () {
	if (hasRequiredOnFinished) return onFinished.exports;
	hasRequiredOnFinished = 1;

	/**
	 * Module exports.
	 * @public
	 */

	onFinished.exports = onFinished$1;
	onFinished.exports.isFinished = isFinished;

	/**
	 * Module dependencies.
	 * @private
	 */

	var asyncHooks = tryRequireAsyncHooks();
	var first = requireEeFirst();

	/**
	 * Variables.
	 * @private
	 */

	/* istanbul ignore next */
	var defer = typeof setImmediate === 'function'
	  ? setImmediate
	  : function (fn) { process.nextTick(fn.bind.apply(fn, arguments)); };

	/**
	 * Invoke callback when the response has finished, useful for
	 * cleaning up resources afterwards.
	 *
	 * @param {object} msg
	 * @param {function} listener
	 * @return {object}
	 * @public
	 */

	function onFinished$1 (msg, listener) {
	  if (isFinished(msg) !== false) {
	    defer(listener, null, msg);
	    return msg
	  }

	  // attach the listener to the message
	  attachListener(msg, wrap(listener));

	  return msg
	}

	/**
	 * Determine if message is already finished.
	 *
	 * @param {object} msg
	 * @return {boolean}
	 * @public
	 */

	function isFinished (msg) {
	  var socket = msg.socket;

	  if (typeof msg.finished === 'boolean') {
	    // OutgoingMessage
	    return Boolean(msg.finished || (socket && !socket.writable))
	  }

	  if (typeof msg.complete === 'boolean') {
	    // IncomingMessage
	    return Boolean(msg.upgrade || !socket || !socket.readable || (msg.complete && !msg.readable))
	  }

	  // don't know
	  return undefined
	}

	/**
	 * Attach a finished listener to the message.
	 *
	 * @param {object} msg
	 * @param {function} callback
	 * @private
	 */

	function attachFinishedListener (msg, callback) {
	  var eeMsg;
	  var eeSocket;
	  var finished = false;

	  function onFinish (error) {
	    eeMsg.cancel();
	    eeSocket.cancel();

	    finished = true;
	    callback(error);
	  }

	  // finished on first message event
	  eeMsg = eeSocket = first([[msg, 'end', 'finish']], onFinish);

	  function onSocket (socket) {
	    // remove listener
	    msg.removeListener('socket', onSocket);

	    if (finished) return
	    if (eeMsg !== eeSocket) return

	    // finished on first socket event
	    eeSocket = first([[socket, 'error', 'close']], onFinish);
	  }

	  if (msg.socket) {
	    // socket already assigned
	    onSocket(msg.socket);
	    return
	  }

	  // wait for socket to be assigned
	  msg.on('socket', onSocket);

	  if (msg.socket === undefined) {
	    // istanbul ignore next: node.js 0.8 patch
	    patchAssignSocket(msg, onSocket);
	  }
	}

	/**
	 * Attach the listener to the message.
	 *
	 * @param {object} msg
	 * @return {function}
	 * @private
	 */

	function attachListener (msg, listener) {
	  var attached = msg.__onFinished;

	  // create a private single listener with queue
	  if (!attached || !attached.queue) {
	    attached = msg.__onFinished = createListener(msg);
	    attachFinishedListener(msg, attached);
	  }

	  attached.queue.push(listener);
	}

	/**
	 * Create listener on message.
	 *
	 * @param {object} msg
	 * @return {function}
	 * @private
	 */

	function createListener (msg) {
	  function listener (err) {
	    if (msg.__onFinished === listener) msg.__onFinished = null;
	    if (!listener.queue) return

	    var queue = listener.queue;
	    listener.queue = null;

	    for (var i = 0; i < queue.length; i++) {
	      queue[i](err, msg);
	    }
	  }

	  listener.queue = [];

	  return listener
	}

	/**
	 * Patch ServerResponse.prototype.assignSocket for node.js 0.8.
	 *
	 * @param {ServerResponse} res
	 * @param {function} callback
	 * @private
	 */

	// istanbul ignore next: node.js 0.8 patch
	function patchAssignSocket (res, callback) {
	  var assignSocket = res.assignSocket;

	  if (typeof assignSocket !== 'function') return

	  // res.on('socket', callback) is broken in 0.8
	  res.assignSocket = function _assignSocket (socket) {
	    assignSocket.call(this, socket);
	    callback(socket);
	  };
	}

	/**
	 * Try to require async_hooks
	 * @private
	 */

	function tryRequireAsyncHooks () {
	  try {
	    return require('async_hooks')
	  } catch (e) {
	    return {}
	  }
	}

	/**
	 * Wrap function with async resource, if possible.
	 * AsyncResource.bind static method backported.
	 * @private
	 */

	function wrap (fn) {
	  var res;

	  // create anonymous resource
	  if (asyncHooks.AsyncResource) {
	    res = new asyncHooks.AsyncResource(fn.name || 'bound-anonymous-fn');
	  }

	  // incompatible node.js
	  if (!res || !res.runInAsyncScope) {
	    return fn
	  }

	  // return bound function
	  return res.runInAsyncScope.bind(res, fn, null)
	}
	return onFinished.exports;
}

/*!
 * range-parser
 * Copyright(c) 2012-2014 TJ Holowaychuk
 * Copyright(c) 2015-2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var rangeParser_1;
var hasRequiredRangeParser;

function requireRangeParser () {
	if (hasRequiredRangeParser) return rangeParser_1;
	hasRequiredRangeParser = 1;

	/**
	 * Module exports.
	 * @public
	 */

	rangeParser_1 = rangeParser;

	/**
	 * Parse "Range" header `str` relative to the given file `size`.
	 *
	 * @param {Number} size
	 * @param {String} str
	 * @param {Object} [options]
	 * @return {Array}
	 * @public
	 */

	function rangeParser (size, str, options) {
	  if (typeof str !== 'string') {
	    throw new TypeError('argument str must be a string')
	  }

	  var index = str.indexOf('=');

	  if (index === -1) {
	    return -2
	  }

	  // split the range string
	  var arr = str.slice(index + 1).split(',');
	  var ranges = [];

	  // add ranges type
	  ranges.type = str.slice(0, index);

	  // parse all ranges
	  for (var i = 0; i < arr.length; i++) {
	    var range = arr[i].split('-');
	    var start = parseInt(range[0], 10);
	    var end = parseInt(range[1], 10);

	    // -nnn
	    if (isNaN(start)) {
	      start = size - end;
	      end = size - 1;
	    // nnn-
	    } else if (isNaN(end)) {
	      end = size - 1;
	    }

	    // limit last-byte-pos to current length
	    if (end > size - 1) {
	      end = size - 1;
	    }

	    // invalid or unsatisifiable
	    if (isNaN(start) || isNaN(end) || start > end || start < 0) {
	      continue
	    }

	    // add range
	    ranges.push({
	      start: start,
	      end: end
	    });
	  }

	  if (ranges.length < 1) {
	    // unsatisifiable
	    return -1
	  }

	  return options && options.combine
	    ? combineRanges(ranges)
	    : ranges
	}

	/**
	 * Combine overlapping & adjacent ranges.
	 * @private
	 */

	function combineRanges (ranges) {
	  var ordered = ranges.map(mapWithIndex).sort(sortByRangeStart);

	  for (var j = 0, i = 1; i < ordered.length; i++) {
	    var range = ordered[i];
	    var current = ordered[j];

	    if (range.start > current.end + 1) {
	      // next range
	      ordered[++j] = range;
	    } else if (range.end > current.end) {
	      // extend range
	      current.end = range.end;
	      current.index = Math.min(current.index, range.index);
	    }
	  }

	  // trim ordered array
	  ordered.length = j + 1;

	  // generate combined range
	  var combined = ordered.sort(sortByRangeIndex).map(mapWithoutIndex);

	  // copy ranges type
	  combined.type = ranges.type;

	  return combined
	}

	/**
	 * Map function to add index value to ranges.
	 * @private
	 */

	function mapWithIndex (range, index) {
	  return {
	    start: range.start,
	    end: range.end,
	    index: index
	  }
	}

	/**
	 * Map function to remove index value from ranges.
	 * @private
	 */

	function mapWithoutIndex (range) {
	  return {
	    start: range.start,
	    end: range.end
	  }
	}

	/**
	 * Sort function to sort ranges by index.
	 * @private
	 */

	function sortByRangeIndex (a, b) {
	  return a.index - b.index
	}

	/**
	 * Sort function to sort ranges by start position.
	 * @private
	 */

	function sortByRangeStart (a, b) {
	  return a.start - b.start
	}
	return rangeParser_1;
}

const require$$0 = {
  "100": "Continue",
  "101": "Switching Protocols",
  "102": "Processing",
  "103": "Early Hints",
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "205": "Reset Content",
  "206": "Partial Content",
  "207": "Multi-Status",
  "208": "Already Reported",
  "226": "IM Used",
  "300": "Multiple Choices",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "305": "Use Proxy",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "407": "Proxy Authentication Required",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "411": "Length Required",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "414": "URI Too Long",
  "415": "Unsupported Media Type",
  "416": "Range Not Satisfiable",
  "417": "Expectation Failed",
  "418": "I'm a Teapot",
  "421": "Misdirected Request",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "424": "Failed Dependency",
  "425": "Too Early",
  "426": "Upgrade Required",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "431": "Request Header Fields Too Large",
  "451": "Unavailable For Legal Reasons",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  "505": "HTTP Version Not Supported",
  "506": "Variant Also Negotiates",
  "507": "Insufficient Storage",
  "508": "Loop Detected",
  "509": "Bandwidth Limit Exceeded",
  "510": "Not Extended",
  "511": "Network Authentication Required",
};

/*!
 * statuses
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2016 Douglas Christopher Wilson
 * MIT Licensed
 */

var statuses;
var hasRequiredStatuses;

function requireStatuses () {
	if (hasRequiredStatuses) return statuses;
	hasRequiredStatuses = 1;

	/**
	 * Module dependencies.
	 * @private
	 */

	var codes = require$$0;

	/**
	 * Module exports.
	 * @public
	 */

	statuses = status;

	// status code to message map
	status.message = codes;

	// status message (lower-case) to code map
	status.code = createMessageToStatusCodeMap(codes);

	// array of status codes
	status.codes = createStatusCodeList(codes);

	// status codes for redirects
	status.redirect = {
	  300: true,
	  301: true,
	  302: true,
	  303: true,
	  305: true,
	  307: true,
	  308: true
	};

	// status codes for empty bodies
	status.empty = {
	  204: true,
	  205: true,
	  304: true
	};

	// status codes for when you should retry the request
	status.retry = {
	  502: true,
	  503: true,
	  504: true
	};

	/**
	 * Create a map of message to status code.
	 * @private
	 */

	function createMessageToStatusCodeMap (codes) {
	  var map = {};

	  Object.keys(codes).forEach(function forEachCode (code) {
	    var message = codes[code];
	    var status = Number(code);

	    // populate map
	    map[message.toLowerCase()] = status;
	  });

	  return map
	}

	/**
	 * Create a list of all status codes.
	 * @private
	 */

	function createStatusCodeList (codes) {
	  return Object.keys(codes).map(function mapCode (code) {
	    return Number(code)
	  })
	}

	/**
	 * Get the status code for given message.
	 * @private
	 */

	function getStatusCode (message) {
	  var msg = message.toLowerCase();

	  if (!Object.prototype.hasOwnProperty.call(status.code, msg)) {
	    throw new Error('invalid status message: "' + message + '"')
	  }

	  return status.code[msg]
	}

	/**
	 * Get the status message for given code.
	 * @private
	 */

	function getStatusMessage (code) {
	  if (!Object.prototype.hasOwnProperty.call(status.message, code)) {
	    throw new Error('invalid status code: ' + code)
	  }

	  return status.message[code]
	}

	/**
	 * Get the status code.
	 *
	 * Given a number, this will throw if it is not a known status
	 * code, otherwise the code will be returned. Given a string,
	 * the string will be parsed for a number and return the code
	 * if valid, otherwise will lookup the code assuming this is
	 * the status message.
	 *
	 * @param {string|number} code
	 * @returns {number}
	 * @public
	 */

	function status (code) {
	  if (typeof code === 'number') {
	    return getStatusMessage(code)
	  }

	  if (typeof code !== 'string') {
	    throw new TypeError('code must be a number or string')
	  }

	  // '403'
	  var n = parseInt(code, 10);
	  if (!isNaN(n)) {
	    return getStatusMessage(n)
	  }

	  return getStatusCode(code)
	}
	return statuses;
}

/*!
 * send
 * Copyright(c) 2012 TJ Holowaychuk
 * Copyright(c) 2014-2022 Douglas Christopher Wilson
 * MIT Licensed
 */

var send_1;
var hasRequiredSend;

function requireSend () {
	if (hasRequiredSend) return send_1;
	hasRequiredSend = 1;

	/**
	 * Module dependencies.
	 * @private
	 */

	var createError = requireHttpErrors();
	var debug = debug$1('send');
	var encodeUrl = requireEncodeurl();
	var escapeHtml = requireEscapeHtml();
	var etag = requireEtag();
	var fresh = requireFresh();
	var fs = require$$0$5;
	var mime = requireMimeTypes();
	var ms$1 = ms;
	var onFinished = requireOnFinished();
	var parseRange = requireRangeParser();
	var path = require$$0$4;
	var statuses = requireStatuses();
	var Stream = require$$13;
	var util = require$$14;

	/**
	 * Path function references.
	 * @private
	 */

	var extname = path.extname;
	var join = path.join;
	var normalize = path.normalize;
	var resolve = path.resolve;
	var sep = path.sep;

	/**
	 * Regular expression for identifying a bytes Range header.
	 * @private
	 */

	var BYTES_RANGE_REGEXP = /^ *bytes=/;

	/**
	 * Maximum value allowed for the max age.
	 * @private
	 */

	var MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000; // 1 year

	/**
	 * Regular expression to match a path with a directory up component.
	 * @private
	 */

	var UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

	/**
	 * Module exports.
	 * @public
	 */

	send_1 = send;

	/**
	 * Return a `SendStream` for `req` and `path`.
	 *
	 * @param {object} req
	 * @param {string} path
	 * @param {object} [options]
	 * @return {SendStream}
	 * @public
	 */

	function send (req, path, options) {
	  return new SendStream(req, path, options)
	}

	/**
	 * Initialize a `SendStream` with the given `path`.
	 *
	 * @param {Request} req
	 * @param {String} path
	 * @param {object} [options]
	 * @private
	 */

	function SendStream (req, path, options) {
	  Stream.call(this);

	  var opts = options || {};

	  this.options = opts;
	  this.path = path;
	  this.req = req;

	  this._acceptRanges = opts.acceptRanges !== undefined
	    ? Boolean(opts.acceptRanges)
	    : true;

	  this._cacheControl = opts.cacheControl !== undefined
	    ? Boolean(opts.cacheControl)
	    : true;

	  this._etag = opts.etag !== undefined
	    ? Boolean(opts.etag)
	    : true;

	  this._dotfiles = opts.dotfiles !== undefined
	    ? opts.dotfiles
	    : 'ignore';

	  if (this._dotfiles !== 'ignore' && this._dotfiles !== 'allow' && this._dotfiles !== 'deny') {
	    throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"')
	  }

	  this._extensions = opts.extensions !== undefined
	    ? normalizeList(opts.extensions, 'extensions option')
	    : [];

	  this._immutable = opts.immutable !== undefined
	    ? Boolean(opts.immutable)
	    : false;

	  this._index = opts.index !== undefined
	    ? normalizeList(opts.index, 'index option')
	    : ['index.html'];

	  this._lastModified = opts.lastModified !== undefined
	    ? Boolean(opts.lastModified)
	    : true;

	  this._maxage = opts.maxAge || opts.maxage;
	  this._maxage = typeof this._maxage === 'string'
	    ? ms$1(this._maxage)
	    : Number(this._maxage);
	  this._maxage = !isNaN(this._maxage)
	    ? Math.min(Math.max(0, this._maxage), MAX_MAXAGE)
	    : 0;

	  this._root = opts.root
	    ? resolve(opts.root)
	    : null;
	}

	/**
	 * Inherits from `Stream`.
	 */

	util.inherits(SendStream, Stream);

	/**
	 * Emit error with `status`.
	 *
	 * @param {number} status
	 * @param {Error} [err]
	 * @private
	 */

	SendStream.prototype.error = function error (status, err) {
	  // emit if listeners instead of responding
	  if (hasListeners(this, 'error')) {
	    return this.emit('error', createHttpError(status, err))
	  }

	  var res = this.res;
	  var msg = statuses.message[status] || String(status);
	  var doc = createHtmlDocument('Error', escapeHtml(msg));

	  // clear existing headers
	  clearHeaders(res);

	  // add error headers
	  if (err && err.headers) {
	    setHeaders(res, err.headers);
	  }

	  // send basic response
	  res.statusCode = status;
	  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	  res.setHeader('Content-Length', Buffer.byteLength(doc));
	  res.setHeader('Content-Security-Policy', "default-src 'none'");
	  res.setHeader('X-Content-Type-Options', 'nosniff');
	  res.end(doc);
	};

	/**
	 * Check if the pathname ends with "/".
	 *
	 * @return {boolean}
	 * @private
	 */

	SendStream.prototype.hasTrailingSlash = function hasTrailingSlash () {
	  return this.path[this.path.length - 1] === '/'
	};

	/**
	 * Check if this is a conditional GET request.
	 *
	 * @return {Boolean}
	 * @api private
	 */

	SendStream.prototype.isConditionalGET = function isConditionalGET () {
	  return this.req.headers['if-match'] ||
	    this.req.headers['if-unmodified-since'] ||
	    this.req.headers['if-none-match'] ||
	    this.req.headers['if-modified-since']
	};

	/**
	 * Check if the request preconditions failed.
	 *
	 * @return {boolean}
	 * @private
	 */

	SendStream.prototype.isPreconditionFailure = function isPreconditionFailure () {
	  var req = this.req;
	  var res = this.res;

	  // if-match
	  var match = req.headers['if-match'];
	  if (match) {
	    var etag = res.getHeader('ETag');
	    return !etag || (match !== '*' && parseTokenList(match).every(function (match) {
	      return match !== etag && match !== 'W/' + etag && 'W/' + match !== etag
	    }))
	  }

	  // if-unmodified-since
	  var unmodifiedSince = parseHttpDate(req.headers['if-unmodified-since']);
	  if (!isNaN(unmodifiedSince)) {
	    var lastModified = parseHttpDate(res.getHeader('Last-Modified'));
	    return isNaN(lastModified) || lastModified > unmodifiedSince
	  }

	  return false
	};

	/**
	 * Strip various content header fields for a change in entity.
	 *
	 * @private
	 */

	SendStream.prototype.removeContentHeaderFields = function removeContentHeaderFields () {
	  var res = this.res;

	  res.removeHeader('Content-Encoding');
	  res.removeHeader('Content-Language');
	  res.removeHeader('Content-Length');
	  res.removeHeader('Content-Range');
	  res.removeHeader('Content-Type');
	};

	/**
	 * Respond with 304 not modified.
	 *
	 * @api private
	 */

	SendStream.prototype.notModified = function notModified () {
	  var res = this.res;
	  debug('not modified');
	  this.removeContentHeaderFields();
	  res.statusCode = 304;
	  res.end();
	};

	/**
	 * Raise error that headers already sent.
	 *
	 * @api private
	 */

	SendStream.prototype.headersAlreadySent = function headersAlreadySent () {
	  var err = new Error('Can\'t set headers after they are sent.');
	  debug('headers already sent');
	  this.error(500, err);
	};

	/**
	 * Check if the request is cacheable, aka
	 * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
	 *
	 * @return {Boolean}
	 * @api private
	 */

	SendStream.prototype.isCachable = function isCachable () {
	  var statusCode = this.res.statusCode;
	  return (statusCode >= 200 && statusCode < 300) ||
	    statusCode === 304
	};

	/**
	 * Handle stat() error.
	 *
	 * @param {Error} error
	 * @private
	 */

	SendStream.prototype.onStatError = function onStatError (error) {
	  switch (error.code) {
	    case 'ENAMETOOLONG':
	    case 'ENOENT':
	    case 'ENOTDIR':
	      this.error(404, error);
	      break
	    default:
	      this.error(500, error);
	      break
	  }
	};

	/**
	 * Check if the cache is fresh.
	 *
	 * @return {Boolean}
	 * @api private
	 */

	SendStream.prototype.isFresh = function isFresh () {
	  return fresh(this.req.headers, {
	    etag: this.res.getHeader('ETag'),
	    'last-modified': this.res.getHeader('Last-Modified')
	  })
	};

	/**
	 * Check if the range is fresh.
	 *
	 * @return {Boolean}
	 * @api private
	 */

	SendStream.prototype.isRangeFresh = function isRangeFresh () {
	  var ifRange = this.req.headers['if-range'];

	  if (!ifRange) {
	    return true
	  }

	  // if-range as etag
	  if (ifRange.indexOf('"') !== -1) {
	    var etag = this.res.getHeader('ETag');
	    return Boolean(etag && ifRange.indexOf(etag) !== -1)
	  }

	  // if-range as modified date
	  var lastModified = this.res.getHeader('Last-Modified');
	  return parseHttpDate(lastModified) <= parseHttpDate(ifRange)
	};

	/**
	 * Redirect to path.
	 *
	 * @param {string} path
	 * @private
	 */

	SendStream.prototype.redirect = function redirect (path) {
	  var res = this.res;

	  if (hasListeners(this, 'directory')) {
	    this.emit('directory', res, path);
	    return
	  }

	  if (this.hasTrailingSlash()) {
	    this.error(403);
	    return
	  }

	  var loc = encodeUrl(collapseLeadingSlashes(this.path + '/'));
	  var doc = createHtmlDocument('Redirecting', 'Redirecting to ' + escapeHtml(loc));

	  // redirect
	  res.statusCode = 301;
	  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	  res.setHeader('Content-Length', Buffer.byteLength(doc));
	  res.setHeader('Content-Security-Policy', "default-src 'none'");
	  res.setHeader('X-Content-Type-Options', 'nosniff');
	  res.setHeader('Location', loc);
	  res.end(doc);
	};

	/**
	 * Pipe to `res.
	 *
	 * @param {Stream} res
	 * @return {Stream} res
	 * @api public
	 */

	SendStream.prototype.pipe = function pipe (res) {
	  // root path
	  var root = this._root;

	  // references
	  this.res = res;

	  // decode the path
	  var path = decode(this.path);
	  if (path === -1) {
	    this.error(400);
	    return res
	  }

	  // null byte(s)
	  if (~path.indexOf('\0')) {
	    this.error(400);
	    return res
	  }

	  var parts;
	  if (root !== null) {
	    // normalize
	    if (path) {
	      path = normalize('.' + sep + path);
	    }

	    // malicious path
	    if (UP_PATH_REGEXP.test(path)) {
	      debug('malicious path "%s"', path);
	      this.error(403);
	      return res
	    }

	    // explode path parts
	    parts = path.split(sep);

	    // join / normalize from optional root dir
	    path = normalize(join(root, path));
	  } else {
	    // ".." is malicious without "root"
	    if (UP_PATH_REGEXP.test(path)) {
	      debug('malicious path "%s"', path);
	      this.error(403);
	      return res
	    }

	    // explode path parts
	    parts = normalize(path).split(sep);

	    // resolve the path
	    path = resolve(path);
	  }

	  // dotfile handling
	  if (containsDotFile(parts)) {
	    debug('%s dotfile "%s"', this._dotfiles, path);
	    switch (this._dotfiles) {
	      case 'allow':
	        break
	      case 'deny':
	        this.error(403);
	        return res
	      case 'ignore':
	      default:
	        this.error(404);
	        return res
	    }
	  }

	  // index file support
	  if (this._index.length && this.hasTrailingSlash()) {
	    this.sendIndex(path);
	    return res
	  }

	  this.sendFile(path);
	  return res
	};

	/**
	 * Transfer `path`.
	 *
	 * @param {String} path
	 * @api public
	 */

	SendStream.prototype.send = function send (path, stat) {
	  var len = stat.size;
	  var options = this.options;
	  var opts = {};
	  var res = this.res;
	  var req = this.req;
	  var ranges = req.headers.range;
	  var offset = options.start || 0;

	  if (res.headersSent) {
	    // impossible to send now
	    this.headersAlreadySent();
	    return
	  }

	  debug('pipe "%s"', path);

	  // set header fields
	  this.setHeader(path, stat);

	  // set content-type
	  this.type(path);

	  // conditional GET support
	  if (this.isConditionalGET()) {
	    if (this.isPreconditionFailure()) {
	      this.error(412);
	      return
	    }

	    if (this.isCachable() && this.isFresh()) {
	      this.notModified();
	      return
	    }
	  }

	  // adjust len to start/end options
	  len = Math.max(0, len - offset);
	  if (options.end !== undefined) {
	    var bytes = options.end - offset + 1;
	    if (len > bytes) len = bytes;
	  }

	  // Range support
	  if (this._acceptRanges && BYTES_RANGE_REGEXP.test(ranges)) {
	    // parse
	    ranges = parseRange(len, ranges, {
	      combine: true
	    });

	    // If-Range support
	    if (!this.isRangeFresh()) {
	      debug('range stale');
	      ranges = -2;
	    }

	    // unsatisfiable
	    if (ranges === -1) {
	      debug('range unsatisfiable');

	      // Content-Range
	      res.setHeader('Content-Range', contentRange('bytes', len));

	      // 416 Requested Range Not Satisfiable
	      return this.error(416, {
	        headers: { 'Content-Range': res.getHeader('Content-Range') }
	      })
	    }

	    // valid (syntactically invalid/multiple ranges are treated as a regular response)
	    if (ranges !== -2 && ranges.length === 1) {
	      debug('range %j', ranges);

	      // Content-Range
	      res.statusCode = 206;
	      res.setHeader('Content-Range', contentRange('bytes', len, ranges[0]));

	      // adjust for requested range
	      offset += ranges[0].start;
	      len = ranges[0].end - ranges[0].start + 1;
	    }
	  }

	  // clone options
	  for (var prop in options) {
	    opts[prop] = options[prop];
	  }

	  // set read options
	  opts.start = offset;
	  opts.end = Math.max(offset, offset + len - 1);

	  // content-length
	  res.setHeader('Content-Length', len);

	  // HEAD support
	  if (req.method === 'HEAD') {
	    res.end();
	    return
	  }

	  this.stream(path, opts);
	};

	/**
	 * Transfer file for `path`.
	 *
	 * @param {String} path
	 * @api private
	 */
	SendStream.prototype.sendFile = function sendFile (path) {
	  var i = 0;
	  var self = this;

	  debug('stat "%s"', path);
	  fs.stat(path, function onstat (err, stat) {
	    var pathEndsWithSep = path[path.length - 1] === sep;
	    if (err && err.code === 'ENOENT' && !extname(path) && !pathEndsWithSep) {
	      // not found, check extensions
	      return next(err)
	    }
	    if (err) return self.onStatError(err)
	    if (stat.isDirectory()) return self.redirect(path)
	    if (pathEndsWithSep) return self.error(404)
	    self.emit('file', path, stat);
	    self.send(path, stat);
	  });

	  function next (err) {
	    if (self._extensions.length <= i) {
	      return err
	        ? self.onStatError(err)
	        : self.error(404)
	    }

	    var p = path + '.' + self._extensions[i++];

	    debug('stat "%s"', p);
	    fs.stat(p, function (err, stat) {
	      if (err) return next(err)
	      if (stat.isDirectory()) return next()
	      self.emit('file', p, stat);
	      self.send(p, stat);
	    });
	  }
	};

	/**
	 * Transfer index for `path`.
	 *
	 * @param {String} path
	 * @api private
	 */
	SendStream.prototype.sendIndex = function sendIndex (path) {
	  var i = -1;
	  var self = this;

	  function next (err) {
	    if (++i >= self._index.length) {
	      if (err) return self.onStatError(err)
	      return self.error(404)
	    }

	    var p = join(path, self._index[i]);

	    debug('stat "%s"', p);
	    fs.stat(p, function (err, stat) {
	      if (err) return next(err)
	      if (stat.isDirectory()) return next()
	      self.emit('file', p, stat);
	      self.send(p, stat);
	    });
	  }

	  next();
	};

	/**
	 * Stream `path` to the response.
	 *
	 * @param {String} path
	 * @param {Object} options
	 * @api private
	 */

	SendStream.prototype.stream = function stream (path, options) {
	  var self = this;
	  var res = this.res;

	  // pipe
	  var stream = fs.createReadStream(path, options);
	  this.emit('stream', stream);
	  stream.pipe(res);

	  // cleanup
	  function cleanup () {
	    stream.destroy();
	  }

	  // response finished, cleanup
	  onFinished(res, cleanup);

	  // error handling
	  stream.on('error', function onerror (err) {
	    // clean up stream early
	    cleanup();

	    // error
	    self.onStatError(err);
	  });

	  // end
	  stream.on('end', function onend () {
	    self.emit('end');
	  });
	};

	/**
	 * Set content-type based on `path`
	 * if it hasn't been explicitly set.
	 *
	 * @param {String} path
	 * @api private
	 */

	SendStream.prototype.type = function type (path) {
	  var res = this.res;

	  if (res.getHeader('Content-Type')) return

	  var ext = extname(path);
	  var type = mime.contentType(ext) || 'application/octet-stream';

	  debug('content-type %s', type);
	  res.setHeader('Content-Type', type);
	};

	/**
	 * Set response header fields, most
	 * fields may be pre-defined.
	 *
	 * @param {String} path
	 * @param {Object} stat
	 * @api private
	 */

	SendStream.prototype.setHeader = function setHeader (path, stat) {
	  var res = this.res;

	  this.emit('headers', res, path, stat);

	  if (this._acceptRanges && !res.getHeader('Accept-Ranges')) {
	    debug('accept ranges');
	    res.setHeader('Accept-Ranges', 'bytes');
	  }

	  if (this._cacheControl && !res.getHeader('Cache-Control')) {
	    var cacheControl = 'public, max-age=' + Math.floor(this._maxage / 1000);

	    if (this._immutable) {
	      cacheControl += ', immutable';
	    }

	    debug('cache-control %s', cacheControl);
	    res.setHeader('Cache-Control', cacheControl);
	  }

	  if (this._lastModified && !res.getHeader('Last-Modified')) {
	    var modified = stat.mtime.toUTCString();
	    debug('modified %s', modified);
	    res.setHeader('Last-Modified', modified);
	  }

	  if (this._etag && !res.getHeader('ETag')) {
	    var val = etag(stat);
	    debug('etag %s', val);
	    res.setHeader('ETag', val);
	  }
	};

	/**
	 * Clear all headers from a response.
	 *
	 * @param {object} res
	 * @private
	 */

	function clearHeaders (res) {
	  for (const header of res.getHeaderNames()) {
	    res.removeHeader(header);
	  }
	}

	/**
	 * Collapse all leading slashes into a single slash
	 *
	 * @param {string} str
	 * @private
	 */
	function collapseLeadingSlashes (str) {
	  for (var i = 0; i < str.length; i++) {
	    if (str[i] !== '/') {
	      break
	    }
	  }

	  return i > 1
	    ? '/' + str.substr(i)
	    : str
	}

	/**
	 * Determine if path parts contain a dotfile.
	 *
	 * @api private
	 */

	function containsDotFile (parts) {
	  for (var i = 0; i < parts.length; i++) {
	    var part = parts[i];
	    if (part.length > 1 && part[0] === '.') {
	      return true
	    }
	  }

	  return false
	}

	/**
	 * Create a Content-Range header.
	 *
	 * @param {string} type
	 * @param {number} size
	 * @param {array} [range]
	 */

	function contentRange (type, size, range) {
	  return type + ' ' + (range ? range.start + '-' + range.end : '*') + '/' + size
	}

	/**
	 * Create a minimal HTML document.
	 *
	 * @param {string} title
	 * @param {string} body
	 * @private
	 */

	function createHtmlDocument (title, body) {
	  return '<!DOCTYPE html>\n' +
	    '<html lang="en">\n' +
	    '<head>\n' +
	    '<meta charset="utf-8">\n' +
	    '<title>' + title + '</title>\n' +
	    '</head>\n' +
	    '<body>\n' +
	    '<pre>' + body + '</pre>\n' +
	    '</body>\n' +
	    '</html>\n'
	}

	/**
	 * Create a HttpError object from simple arguments.
	 *
	 * @param {number} status
	 * @param {Error|object} err
	 * @private
	 */

	function createHttpError (status, err) {
	  if (!err) {
	    return createError(status)
	  }

	  return err instanceof Error
	    ? createError(status, err, { expose: false })
	    : createError(status, err)
	}

	/**
	 * decodeURIComponent.
	 *
	 * Allows V8 to only deoptimize this fn instead of all
	 * of send().
	 *
	 * @param {String} path
	 * @api private
	 */

	function decode (path) {
	  try {
	    return decodeURIComponent(path)
	  } catch (err) {
	    return -1
	  }
	}

	/**
	 * Determine if emitter has listeners of a given type.
	 *
	 * The way to do this check is done three different ways in Node.js >= 0.10
	 * so this consolidates them into a minimal set using instance methods.
	 *
	 * @param {EventEmitter} emitter
	 * @param {string} type
	 * @returns {boolean}
	 * @private
	 */

	function hasListeners (emitter, type) {
	  var count = typeof emitter.listenerCount !== 'function'
	    ? emitter.listeners(type).length
	    : emitter.listenerCount(type);

	  return count > 0
	}

	/**
	 * Normalize the index option into an array.
	 *
	 * @param {boolean|string|array} val
	 * @param {string} name
	 * @private
	 */

	function normalizeList (val, name) {
	  var list = [].concat(val || []);

	  for (var i = 0; i < list.length; i++) {
	    if (typeof list[i] !== 'string') {
	      throw new TypeError(name + ' must be array of strings or false')
	    }
	  }

	  return list
	}

	/**
	 * Parse an HTTP Date into a number.
	 *
	 * @param {string} date
	 * @private
	 */

	function parseHttpDate (date) {
	  var timestamp = date && Date.parse(date);

	  return typeof timestamp === 'number'
	    ? timestamp
	    : NaN
	}

	/**
	 * Parse a HTTP token list.
	 *
	 * @param {string} str
	 * @private
	 */

	function parseTokenList (str) {
	  var end = 0;
	  var list = [];
	  var start = 0;

	  // gather tokens
	  for (var i = 0, len = str.length; i < len; i++) {
	    switch (str.charCodeAt(i)) {
	      case 0x20: /*   */
	        if (start === end) {
	          start = end = i + 1;
	        }
	        break
	      case 0x2c: /* , */
	        if (start !== end) {
	          list.push(str.substring(start, end));
	        }
	        start = end = i + 1;
	        break
	      default:
	        end = i + 1;
	        break
	    }
	  }

	  // final token
	  if (start !== end) {
	    list.push(str.substring(start, end));
	  }

	  return list
	}

	/**
	 * Set an object of headers on a response.
	 *
	 * @param {object} res
	 * @param {object} headers
	 * @private
	 */

	function setHeaders (res, headers) {
	  var keys = Object.keys(headers);

	  for (var i = 0; i < keys.length; i++) {
	    var key = keys[i];
	    res.setHeader(key, headers[key]);
	  }
	}
	return send_1;
}

var sendExports = requireSend();
const send = /*@__PURE__*/getDefaultExportFromCjs(sendExports);

function createStaticHandler(app, options) {
  const client = resolveClientDir(options);
  return (req, res, ssr) => {
    if (req.url) {
      const [urlPath, urlQuery] = req.url.split("?");
      const filePath = path.join(client, app.removeBase(urlPath));
      let isDirectory = false;
      try {
        isDirectory = fs.lstatSync(filePath).isDirectory();
      } catch {
      }
      const { trailingSlash = "ignore" } = options;
      const hasSlash = urlPath.endsWith("/");
      let pathname = urlPath;
      if (app.headersMap && app.headersMap.length > 0) {
        const routeData = app.match(req, true);
        if (routeData && routeData.prerender) {
          const matchedRoute = app.headersMap.find((header) => header.pathname.includes(pathname));
          if (matchedRoute) {
            for (const header of matchedRoute.headers) {
              res.setHeader(header.key, header.value);
            }
          }
        }
      }
      switch (trailingSlash) {
        case "never": {
          if (isDirectory && urlPath !== "/" && hasSlash) {
            pathname = urlPath.slice(0, -1) + (urlQuery ? "?" + urlQuery : "");
            res.statusCode = 301;
            res.setHeader("Location", pathname);
            return res.end();
          }
          if (isDirectory && !hasSlash) {
            pathname = `${urlPath}/index.html`;
          }
          break;
        }
        case "ignore": {
          if (isDirectory && !hasSlash) {
            pathname = `${urlPath}/index.html`;
          }
          break;
        }
        case "always": {
          if (!hasSlash && !hasFileExtension(urlPath) && !isInternalPath(urlPath)) {
            pathname = urlPath + "/" + (urlQuery ? "?" + urlQuery : "");
            res.statusCode = 301;
            res.setHeader("Location", pathname);
            return res.end();
          }
          break;
        }
      }
      pathname = prependForwardSlash(app.removeBase(pathname));
      const stream = send(req, pathname, {
        root: client,
        dotfiles: pathname.startsWith("/.well-known/") ? "allow" : "deny"
      });
      let forwardError = false;
      stream.on("error", (err) => {
        if (forwardError) {
          console.error(err.toString());
          res.writeHead(500);
          res.end("Internal server error");
          return;
        }
        ssr();
      });
      stream.on("headers", (_res) => {
        if (pathname.startsWith(`/${options.assets}/`)) {
          _res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      });
      stream.on("file", () => {
        forwardError = true;
      });
      stream.pipe(res);
    } else {
      ssr();
    }
  };
}
function resolveClientDir(options) {
  const clientURLRaw = new URL(options.client);
  const serverURLRaw = new URL(options.server);
  const rel = path.relative(url.fileURLToPath(serverURLRaw), url.fileURLToPath(clientURLRaw));
  const serverFolder = path.basename(options.server);
  let serverEntryFolderURL = path.dirname(import.meta.url);
  while (!serverEntryFolderURL.endsWith(serverFolder)) {
    serverEntryFolderURL = path.dirname(serverEntryFolderURL);
  }
  const serverEntryURL = serverEntryFolderURL + "/entry.mjs";
  const clientURL = new URL(appendForwardSlash(rel), serverEntryURL);
  const client = url.fileURLToPath(clientURL);
  return client;
}
function prependForwardSlash(pth) {
  return pth.startsWith("/") ? pth : "/" + pth;
}
function appendForwardSlash(pth) {
  return pth.endsWith("/") ? pth : pth + "/";
}

const hostOptions = (host) => {
  if (typeof host === "boolean") {
    return host ? "0.0.0.0" : "localhost";
  }
  return host;
};
function standalone(app, options) {
  const port = process.env.PORT ? Number(process.env.PORT) : options.port ?? 8080;
  const host = process.env.HOST ?? hostOptions(options.host);
  const handler = createStandaloneHandler(app, options);
  const server = createServer(handler, host, port);
  server.server.listen(port, host);
  if (process.env.ASTRO_NODE_LOGGING !== "disabled") {
    logListeningOn(app.getAdapterLogger(), server.server, host);
  }
  return {
    server,
    done: server.closed()
  };
}
function createStandaloneHandler(app, options) {
  const appHandler = createAppHandler(app, options);
  const staticHandler = createStaticHandler(app, options);
  return (req, res) => {
    try {
      decodeURI(req.url);
    } catch {
      res.writeHead(400);
      res.end("Bad request.");
      return;
    }
    staticHandler(req, res, () => appHandler(req, res));
  };
}
function createServer(listener, host, port) {
  let httpServer;
  if (process.env.SERVER_CERT_PATH && process.env.SERVER_KEY_PATH) {
    httpServer = https.createServer(
      {
        key: fs.readFileSync(process.env.SERVER_KEY_PATH),
        cert: fs.readFileSync(process.env.SERVER_CERT_PATH)
      },
      listener
    );
  } else {
    httpServer = require$$2.createServer(listener);
  }
  enableDestroy(httpServer);
  const closed = new Promise((resolve, reject) => {
    httpServer.addListener("close", resolve);
    httpServer.addListener("error", reject);
  });
  const previewable = {
    host,
    port,
    closed() {
      return closed;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        httpServer.destroy((err) => err ? reject(err) : resolve(void 0));
      });
    }
  };
  return {
    server: httpServer,
    ...previewable
  };
}

function createExports(manifest, options) {
  const app = new NodeApp(manifest, !options.experimentalDisableStreaming);
  let headersMap = void 0;
  if (options.experimentalStaticHeaders) {
    headersMap = readHeadersJson(manifest.outDir);
  }
  if (headersMap) {
    app.setHeadersMap(headersMap);
  }
  options.trailingSlash = manifest.trailingSlash;
  return {
    options,
    handler: options.mode === "middleware" ? createMiddleware(app, options) : createStandaloneHandler(app, options),
    startServer: () => standalone(app, options)
  };
}
function start(manifest, options) {
  if (options.mode !== "standalone" || process.env.ASTRO_NODE_AUTOSTART === "disabled") {
    return;
  }
  let headersMap = void 0;
  if (options.experimentalStaticHeaders) {
    headersMap = readHeadersJson(manifest.outDir);
  }
  const app = new NodeApp(manifest, !options.experimentalDisableStreaming);
  if (headersMap) {
    app.setHeadersMap(headersMap);
  }
  standalone(app, options);
}
function readHeadersJson(outDir) {
  let headersMap = void 0;
  const headersUrl = new URL(STATIC_HEADERS_FILE, outDir);
  if (existsSync(headersUrl)) {
    const content = readFileSync(headersUrl, "utf-8");
    try {
      headersMap = JSON.parse(content);
    } catch (e) {
      console.error("[@astrojs/node] Error parsing _headers.json: " + e.message);
      console.error("[@astrojs/node] Please make sure your _headers.json is valid JSON.");
    }
  }
  return headersMap;
}

const serverEntrypointModule = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  createExports,
  start
}, Symbol.toStringTag, { value: 'Module' }));

export { start as a, createExports as c, serverEntrypointModule as s };
