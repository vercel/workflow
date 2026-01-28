import {
  getErrorMessage
} from "./chunk-3EDCHFHY.js";
import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/curl/form.js
function encodeFormData(input) {
  const eqIndex = input.indexOf("=");
  if (eqIndex >= 0) {
    const name = input.slice(0, eqIndex);
    const value = input.slice(eqIndex + 1);
    if (name) {
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    }
    return encodeURIComponent(value);
  }
  return encodeURIComponent(input);
}
__name(encodeFormData, "encodeFormData");
function parseFormField(spec) {
  const eqIndex = spec.indexOf("=");
  if (eqIndex < 0)
    return null;
  const name = spec.slice(0, eqIndex);
  let value = spec.slice(eqIndex + 1);
  let filename;
  let contentType;
  const typeMatch = value.match(/;type=([^;]+)$/);
  if (typeMatch) {
    contentType = typeMatch[1];
    value = value.slice(0, -typeMatch[0].length);
  }
  const filenameMatch = value.match(/;filename=([^;]+)/);
  if (filenameMatch) {
    filename = filenameMatch[1];
    value = value.replace(filenameMatch[0], "");
  }
  if (value.startsWith("@") || value.startsWith("<")) {
    filename = filename ?? value.slice(1).split("/").pop();
  }
  return { name, value, filename, contentType };
}
__name(parseFormField, "parseFormField");
function generateMultipartBody(fields, fileContents) {
  const boundary = `----CurlFormBoundary${Date.now().toString(36)}`;
  const parts = [];
  for (const field of fields) {
    let value = field.value;
    if (value.startsWith("@") || value.startsWith("<")) {
      const filePath = value.slice(1);
      value = fileContents.get(filePath) ?? "";
    }
    let part = `--${boundary}\r
`;
    if (field.filename) {
      part += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r
`;
      if (field.contentType) {
        part += `Content-Type: ${field.contentType}\r
`;
      }
    } else {
      part += `Content-Disposition: form-data; name="${field.name}"\r
`;
    }
    part += `\r
${value}\r
`;
    parts.push(part);
  }
  parts.push(`--${boundary}--\r
`);
  return { body: parts.join(""), boundary };
}
__name(generateMultipartBody, "generateMultipartBody");

// dist/commands/curl/help.js
var curlHelp = {
  name: "curl",
  summary: "transfer a URL",
  usage: "curl [OPTIONS] URL",
  options: [
    "-X, --request METHOD  HTTP method (GET, POST, PUT, DELETE, etc.)",
    "-H, --header HEADER   Add header (can be used multiple times)",
    "-d, --data DATA       HTTP POST data",
    "    --data-raw DATA   HTTP POST data (no @ interpretation)",
    "    --data-binary DATA  HTTP POST binary data",
    "    --data-urlencode DATA  URL-encode and POST data",
    "-F, --form NAME=VALUE  Multipart form data",
    "-u, --user USER:PASS  HTTP authentication",
    "-A, --user-agent STR  Set User-Agent header",
    "-e, --referer URL     Set Referer header",
    "-b, --cookie DATA     Send cookies (name=value or @file)",
    "-c, --cookie-jar FILE Save cookies to file",
    "-T, --upload-file FILE  Upload file (PUT)",
    "-o, --output FILE     Write output to file",
    "-O, --remote-name     Write to file named from URL",
    "-I, --head            Show headers only (HEAD request)",
    "-i, --include         Include response headers in output",
    "-s, --silent          Silent mode (no progress)",
    "-S, --show-error      Show errors even when silent",
    "-f, --fail            Fail silently on HTTP errors (no output)",
    "-L, --location        Follow redirects (default)",
    "    --max-redirs NUM  Maximum redirects (default: 20)",
    "-m, --max-time SECS   Maximum time for request",
    "    --connect-timeout SECS  Connection timeout",
    "-w, --write-out FMT   Output format after completion",
    "-v, --verbose         Verbose output",
    "    --help            Display this help and exit",
    "",
    "Note: Network access must be configured via BashEnv network option.",
    "      curl is not available by default for security reasons."
  ]
};

// dist/commands/curl/parse.js
function parseOptions(args) {
  const options = {
    method: "GET",
    headers: {},
    dataBinary: false,
    formFields: [],
    useRemoteName: false,
    headOnly: false,
    includeHeaders: false,
    silent: false,
    showError: false,
    failSilently: false,
    followRedirects: true,
    verbose: false
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-X" || arg === "--request") {
      options.method = args[++i] ?? "GET";
    } else if (arg.startsWith("-X")) {
      options.method = arg.slice(2);
    } else if (arg.startsWith("--request=")) {
      options.method = arg.slice(10);
    } else if (arg === "-H" || arg === "--header") {
      const header = args[++i];
      if (header) {
        const colonIndex = header.indexOf(":");
        if (colonIndex > 0) {
          const name = header.slice(0, colonIndex).trim();
          const value = header.slice(colonIndex + 1).trim();
          options.headers[name] = value;
        }
      }
    } else if (arg.startsWith("--header=")) {
      const header = arg.slice(9);
      const colonIndex = header.indexOf(":");
      if (colonIndex > 0) {
        const name = header.slice(0, colonIndex).trim();
        const value = header.slice(colonIndex + 1).trim();
        options.headers[name] = value;
      }
    } else if (arg === "-d" || arg === "--data" || arg === "--data-raw") {
      options.data = args[++i] ?? "";
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg.startsWith("-d")) {
      options.data = arg.slice(2);
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg.startsWith("--data=")) {
      options.data = arg.slice(7);
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg.startsWith("--data-raw=")) {
      options.data = arg.slice(11);
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg === "--data-binary") {
      options.data = args[++i] ?? "";
      options.dataBinary = true;
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg.startsWith("--data-binary=")) {
      options.data = arg.slice(14);
      options.dataBinary = true;
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg === "--data-urlencode") {
      const value = args[++i] ?? "";
      options.data = (options.data ? `${options.data}&` : "") + encodeFormData(value);
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg.startsWith("--data-urlencode=")) {
      const value = arg.slice(17);
      options.data = (options.data ? `${options.data}&` : "") + encodeFormData(value);
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg === "-F" || arg === "--form") {
      const formData = args[++i] ?? "";
      const field = parseFormField(formData);
      if (field) {
        options.formFields.push(field);
      }
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg.startsWith("--form=")) {
      const formData = arg.slice(7);
      const field = parseFormField(formData);
      if (field) {
        options.formFields.push(field);
      }
      if (options.method === "GET") {
        options.method = "POST";
      }
    } else if (arg === "-u" || arg === "--user") {
      options.user = args[++i];
    } else if (arg.startsWith("-u")) {
      options.user = arg.slice(2);
    } else if (arg.startsWith("--user=")) {
      options.user = arg.slice(7);
    } else if (arg === "-A" || arg === "--user-agent") {
      options.headers["User-Agent"] = args[++i] ?? "";
    } else if (arg.startsWith("-A")) {
      options.headers["User-Agent"] = arg.slice(2);
    } else if (arg.startsWith("--user-agent=")) {
      options.headers["User-Agent"] = arg.slice(13);
    } else if (arg === "-e" || arg === "--referer") {
      options.headers.Referer = args[++i] ?? "";
    } else if (arg.startsWith("-e")) {
      options.headers.Referer = arg.slice(2);
    } else if (arg.startsWith("--referer=")) {
      options.headers.Referer = arg.slice(10);
    } else if (arg === "-b" || arg === "--cookie") {
      options.headers.Cookie = args[++i] ?? "";
    } else if (arg.startsWith("-b")) {
      options.headers.Cookie = arg.slice(2);
    } else if (arg.startsWith("--cookie=")) {
      options.headers.Cookie = arg.slice(9);
    } else if (arg === "-c" || arg === "--cookie-jar") {
      options.cookieJar = args[++i];
    } else if (arg.startsWith("--cookie-jar=")) {
      options.cookieJar = arg.slice(13);
    } else if (arg === "-T" || arg === "--upload-file") {
      options.uploadFile = args[++i];
      if (options.method === "GET") {
        options.method = "PUT";
      }
    } else if (arg.startsWith("--upload-file=")) {
      options.uploadFile = arg.slice(14);
      if (options.method === "GET") {
        options.method = "PUT";
      }
    } else if (arg === "-m" || arg === "--max-time") {
      const secs = parseFloat(args[++i] ?? "0");
      if (!Number.isNaN(secs) && secs > 0) {
        options.timeoutMs = secs * 1e3;
      }
    } else if (arg.startsWith("--max-time=")) {
      const secs = parseFloat(arg.slice(11));
      if (!Number.isNaN(secs) && secs > 0) {
        options.timeoutMs = secs * 1e3;
      }
    } else if (arg === "--connect-timeout") {
      const secs = parseFloat(args[++i] ?? "0");
      if (!Number.isNaN(secs) && secs > 0) {
        if (options.timeoutMs === void 0) {
          options.timeoutMs = secs * 1e3;
        }
      }
    } else if (arg.startsWith("--connect-timeout=")) {
      const secs = parseFloat(arg.slice(18));
      if (!Number.isNaN(secs) && secs > 0) {
        if (options.timeoutMs === void 0) {
          options.timeoutMs = secs * 1e3;
        }
      }
    } else if (arg === "-o" || arg === "--output") {
      options.outputFile = args[++i];
    } else if (arg.startsWith("--output=")) {
      options.outputFile = arg.slice(9);
    } else if (arg === "-O" || arg === "--remote-name") {
      options.useRemoteName = true;
    } else if (arg === "-I" || arg === "--head") {
      options.headOnly = true;
      options.method = "HEAD";
    } else if (arg === "-i" || arg === "--include") {
      options.includeHeaders = true;
    } else if (arg === "-s" || arg === "--silent") {
      options.silent = true;
    } else if (arg === "-S" || arg === "--show-error") {
      options.showError = true;
    } else if (arg === "-f" || arg === "--fail") {
      options.failSilently = true;
    } else if (arg === "-L" || arg === "--location") {
      options.followRedirects = true;
    } else if (arg === "--max-redirs") {
      i++;
    } else if (arg.startsWith("--max-redirs=")) {
    } else if (arg === "-w" || arg === "--write-out") {
      options.writeOut = args[++i];
    } else if (arg.startsWith("--write-out=")) {
      options.writeOut = arg.slice(12);
    } else if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--") && arg !== "--") {
      return unknownOption("curl", arg);
    } else if (arg.startsWith("-") && arg !== "-") {
      for (const c of arg.slice(1)) {
        switch (c) {
          case "s":
            options.silent = true;
            break;
          case "S":
            options.showError = true;
            break;
          case "f":
            options.failSilently = true;
            break;
          case "L":
            options.followRedirects = true;
            break;
          case "I":
            options.headOnly = true;
            options.method = "HEAD";
            break;
          case "i":
            options.includeHeaders = true;
            break;
          case "O":
            options.useRemoteName = true;
            break;
          case "v":
            options.verbose = true;
            break;
          default:
            return unknownOption("curl", `-${c}`);
        }
      }
    } else if (!arg.startsWith("-")) {
      options.url = arg;
    }
  }
  return options;
}
__name(parseOptions, "parseOptions");

// dist/commands/curl/response-formatting.js
function formatHeaders(headers) {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
}
__name(formatHeaders, "formatHeaders");
function extractFilename(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop();
    return filename || "index.html";
  } catch {
    return "index.html";
  }
}
__name(extractFilename, "extractFilename");
function applyWriteOut(format, result) {
  let output = format;
  output = output.replace(/%\{http_code\}/g, String(result.status));
  output = output.replace(/%\{content_type\}/g, result.headers["content-type"] || "");
  output = output.replace(/%\{url_effective\}/g, result.url);
  output = output.replace(/%\{size_download\}/g, String(result.bodyLength));
  output = output.replace(/\\n/g, "\n");
  return output;
}
__name(applyWriteOut, "applyWriteOut");

// dist/commands/curl/curl.js
async function prepareRequestBody(options, ctx) {
  if (options.uploadFile) {
    const filePath = ctx.fs.resolvePath(ctx.cwd, options.uploadFile);
    const content = await ctx.fs.readFile(filePath);
    return { body: content };
  }
  if (options.formFields.length > 0) {
    const fileContents = /* @__PURE__ */ new Map();
    for (const field of options.formFields) {
      if (field.value.startsWith("@") || field.value.startsWith("<")) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, field.value.slice(1));
        try {
          const content = await ctx.fs.readFile(filePath);
          fileContents.set(field.value.slice(1), content);
        } catch {
          fileContents.set(field.value.slice(1), "");
        }
      }
    }
    const { body, boundary } = generateMultipartBody(options.formFields, fileContents);
    return {
      body,
      contentType: `multipart/form-data; boundary=${boundary}`
    };
  }
  if (options.data !== void 0) {
    return { body: options.data };
  }
  return {};
}
__name(prepareRequestBody, "prepareRequestBody");
function prepareHeaders(options, contentType) {
  const headers = { ...options.headers };
  if (options.user) {
    const encoded = Buffer.from(options.user).toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  }
  if (contentType && !headers["Content-Type"]) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}
__name(prepareHeaders, "prepareHeaders");
async function saveCookies(options, headers, ctx) {
  if (!options.cookieJar)
    return;
  const setCookie = headers["set-cookie"];
  if (!setCookie)
    return;
  const filePath = ctx.fs.resolvePath(ctx.cwd, options.cookieJar);
  await ctx.fs.writeFile(filePath, setCookie);
}
__name(saveCookies, "saveCookies");
function buildOutput(options, result, requestUrl) {
  let output = "";
  if (options.verbose) {
    output += `> ${options.method} ${requestUrl}
`;
    for (const [name, value] of Object.entries(options.headers)) {
      output += `> ${name}: ${value}
`;
    }
    output += ">\n";
    output += `< HTTP/1.1 ${result.status} ${result.statusText}
`;
    for (const [name, value] of Object.entries(result.headers)) {
      output += `< ${name}: ${value}
`;
    }
    output += "<\n";
  }
  if (options.includeHeaders && !options.verbose) {
    output += `HTTP/1.1 ${result.status} ${result.statusText}\r
`;
    output += formatHeaders(result.headers);
    output += "\r\n\r\n";
  }
  if (!options.headOnly) {
    output += result.body;
  } else if (options.includeHeaders || options.verbose) {
  } else {
    output += `HTTP/1.1 ${result.status} ${result.statusText}\r
`;
    output += formatHeaders(result.headers);
    output += "\r\n";
  }
  if (options.writeOut) {
    output += applyWriteOut(options.writeOut, {
      status: result.status,
      headers: result.headers,
      url: result.url,
      bodyLength: result.body.length
    });
  }
  return output;
}
__name(buildOutput, "buildOutput");
var curlCommand = {
  name: "curl",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(curlHelp);
    }
    const parseResult = parseOptions(args);
    if ("exitCode" in parseResult) {
      return parseResult;
    }
    const options = parseResult;
    if (!options.url) {
      return {
        stdout: "",
        stderr: "curl: no URL specified\n",
        exitCode: 2
      };
    }
    if (!ctx.fetch) {
      return {
        stdout: "",
        stderr: "curl: internal error: fetch not available\n",
        exitCode: 1
      };
    }
    let url = options.url;
    if (!url.match(/^https?:\/\//)) {
      url = `https://${url}`;
    }
    try {
      const { body, contentType } = await prepareRequestBody(options, ctx);
      const headers = prepareHeaders(options, contentType);
      const result = await ctx.fetch(url, {
        method: options.method,
        headers: Object.keys(headers).length > 0 ? headers : void 0,
        body,
        followRedirects: options.followRedirects,
        timeoutMs: options.timeoutMs
      });
      await saveCookies(options, result.headers, ctx);
      if (options.failSilently && result.status >= 400) {
        const stderr = options.showError || !options.silent ? `curl: (22) The requested URL returned error: ${result.status}
` : "";
        return { stdout: "", stderr, exitCode: 22 };
      }
      let output = buildOutput(options, result, url);
      if (options.outputFile || options.useRemoteName) {
        const filename = options.outputFile || extractFilename(url);
        const filePath = ctx.fs.resolvePath(ctx.cwd, filename);
        await ctx.fs.writeFile(filePath, options.headOnly ? "" : result.body);
        if (!options.verbose) {
          output = "";
        }
        if (options.writeOut) {
          output = applyWriteOut(options.writeOut, {
            status: result.status,
            headers: result.headers,
            url: result.url,
            bodyLength: result.body.length
          });
        }
      }
      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (error) {
      const message = getErrorMessage(error);
      let exitCode = 1;
      if (message.includes("Network access denied")) {
        exitCode = 7;
      } else if (message.includes("HTTP method") && message.includes("not allowed")) {
        exitCode = 3;
      } else if (message.includes("Redirect target not in allow-list")) {
        exitCode = 47;
      } else if (message.includes("Too many redirects")) {
        exitCode = 47;
      } else if (message.includes("aborted")) {
        exitCode = 28;
      }
      const showErr = !options.silent || options.showError;
      const stderr = showErr ? `curl: (${exitCode}) ${message}
` : "";
      return { stdout: "", stderr, exitCode };
    }
  }
};
export {
  curlCommand
};
