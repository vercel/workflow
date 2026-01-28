import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
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
import "node:url";
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
import "node:worker_threads";
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
var dateHelp = {
  name: "date",
  summary: "display the current time in the given FORMAT",
  usage: "date [OPTION]... [+FORMAT]",
  options: [
    "-d, --date=STRING   display time described by STRING",
    "-u, --utc           print Coordinated Universal Time (UTC)",
    "-I, --iso-8601      output date/time in ISO 8601 format",
    "-R, --rfc-email     output RFC 5322 date format",
    "    --help          display this help and exit"
  ]
};
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
__name(pad, "pad");
function tzOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}
__name(tzOffset, "tzOffset");
function formatDate(d, fmt, utc) {
  const g = utc ? {
    Y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    D: d.getUTCDate(),
    H: d.getUTCHours(),
    M: d.getUTCMinutes(),
    S: d.getUTCSeconds(),
    w: d.getUTCDay()
  } : {
    Y: d.getFullYear(),
    m: d.getMonth(),
    D: d.getDate(),
    H: d.getHours(),
    M: d.getMinutes(),
    S: d.getSeconds(),
    w: d.getDay()
  };
  let r = "", i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const s = fmt[++i];
      switch (s) {
        case "%":
          r += "%";
          break;
        case "a":
          r += DAYS[g.w];
          break;
        case "b":
        case "h":
          r += MONTHS[g.m];
          break;
        case "d":
          r += pad(g.D);
          break;
        case "e":
          r += String(g.D).padStart(2, " ");
          break;
        case "F":
          r += `${g.Y}-${pad(g.m + 1)}-${pad(g.D)}`;
          break;
        case "H":
          r += pad(g.H);
          break;
        case "I":
          r += pad(g.H % 12 || 12);
          break;
        case "m":
          r += pad(g.m + 1);
          break;
        case "M":
          r += pad(g.M);
          break;
        case "n":
          r += "\n";
          break;
        case "p":
          r += g.H < 12 ? "AM" : "PM";
          break;
        case "P":
          r += g.H < 12 ? "am" : "pm";
          break;
        case "R":
          r += `${pad(g.H)}:${pad(g.M)}`;
          break;
        case "s":
          r += Math.floor(d.getTime() / 1e3);
          break;
        case "S":
          r += pad(g.S);
          break;
        case "t":
          r += "	";
          break;
        case "T":
          r += `${pad(g.H)}:${pad(g.M)}:${pad(g.S)}`;
          break;
        case "u":
          r += g.w || 7;
          break;
        case "w":
          r += g.w;
          break;
        case "y":
          r += pad(g.Y % 100);
          break;
        case "Y":
          r += g.Y;
          break;
        case "z":
          r += utc ? "+0000" : tzOffset(d);
          break;
        case "Z":
          r += utc ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
          break;
        default:
          r += `%${s}`;
      }
    } else {
      r += fmt[i];
    }
    i++;
  }
  return r;
}
__name(formatDate, "formatDate");
function parseDate(s) {
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()))
    return d;
  if (/^\d+$/.test(s))
    return new Date(Number.parseInt(s, 10) * 1e3);
  const l = s.toLowerCase();
  if (l === "now" || l === "today")
    return /* @__PURE__ */ new Date();
  if (l === "yesterday")
    return new Date(Date.now() - 864e5);
  if (l === "tomorrow")
    return new Date(Date.now() + 864e5);
  return null;
}
__name(parseDate, "parseDate");
var dateCommand = {
  name: "date",
  async execute(args, _ctx) {
    if (hasHelpFlag(args))
      return showHelp(dateHelp);
    let utc = false, dateStr = null, fmt = null, iso = false, rfc = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-u" || a === "--utc")
        utc = true;
      else if (a === "-d" || a === "--date")
        dateStr = args[++i] ?? "";
      else if (a.startsWith("--date="))
        dateStr = a.slice(7);
      else if (a === "-I" || a === "--iso-8601")
        iso = true;
      else if (a === "-R" || a === "--rfc-email")
        rfc = true;
      else if (a.startsWith("+"))
        fmt = a.slice(1);
      else if (a.startsWith("--"))
        return unknownOption("date", a);
      else if (a.startsWith("-")) {
        for (const c of a.slice(1)) {
          if (c === "u")
            utc = true;
          else if (c === "I")
            iso = true;
          else if (c === "R")
            rfc = true;
          else
            return unknownOption("date", `-${c}`);
        }
      }
    }
    const date = dateStr !== null ? parseDate(dateStr) : /* @__PURE__ */ new Date();
    if (!date)
      return {
        stdout: "",
        stderr: `date: invalid date '${dateStr}'
`,
        exitCode: 1
      };
    let out;
    if (fmt)
      out = formatDate(date, fmt, utc);
    else if (iso)
      out = formatDate(date, "%Y-%m-%dT%H:%M:%S%z", utc);
    else if (rfc)
      out = formatDate(date, "%a, %d %b %Y %H:%M:%S %z", utc);
    else
      out = formatDate(date, "%a %b %e %H:%M:%S %Z %Y", utc);
    return { stdout: `${out}
`, stderr: "", exitCode: 0 };
  }
};
export {
  dateCommand
};
