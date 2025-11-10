import { z as withResolvers, A as stepLogger, B as EventConsumerResult, e as WorkflowRuntimeError, F as FatalError, C as hydrateStepReturnValue, G as seedrandom, I as webhookLogger, J as parseDurationToDate, t as trace, K as WorkflowEventsCount, u as WorkflowRunStatus, f as WorkflowRunId, l as WorkflowName, L as getPort, M as monotonicFactory, N as EventsConsumer, O as WORKFLOW_USE_STEP, P as WORKFLOW_CREATE_HOOK, Q as WORKFLOW_SLEEP, g as getWorkflowRunStreamId, R as WORKFLOW_GET_STREAM_ID, E as ERROR_SLUGS, v as hydrateWorkflowArguments, p as WorkflowArgumentsCount, S as dehydrateWorkflowReturnValue, T as WorkflowResultType, U as BODY_INIT_SYMBOL, V as getWorldHandlers, X as WorkflowInvokePayloadSchema, Y as withTraceContext, Z as StepInvokePayloadSchema, c as getWorld, _ as getExternalRevivers, $ as hydrateWorkflowReturnValue, a0 as WorkflowRunCancelledError, y as WorkflowRunFailedError, x as WorkflowRunNotCompletedError, a1 as QueueName, o as WorkflowOperation, a2 as WorkflowTracePropagated, a3 as WorkflowStartedAt, a4 as buildWorkflowSuspensionMessage, a5 as dehydrateStepArguments, k as functionsExports, s as serializeTraceCarrier, a6 as WorkflowAPIError, a7 as WorkflowStepsCreated, a8 as WorkflowErrorMessage, a9 as WorkflowErrorName, aa as StepAttempt, ab as StepName, ac as getStepFunction, ad as StepTracePropagated, ae as StepMaxRetries, af as StepId, ag as runtimeLogger, ah as StepStatus, ai as StepRetryTimeoutSeconds, aj as StepSkipReason, ak as StepSkipped, h as hydrateStepArguments, al as StepArgumentsCount, j as dehydrateStepReturnValue, am as StepResultType, an as StepErrorMessage, ao as StepErrorName, ap as StepFatalError, aq as StepRetryExhausted, ar as RetryableError, as as StepRetryWillRetry } from './index_ePTMDSOu.mjs';
import { decode } from '@jridgewell/sourcemap-codec';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { createContext as createContext$1, runInContext } from 'node:vm';
import * as nanoid from 'nanoid';

/**
 * An error that is thrown when one or more operations (steps/hooks/etc.) are called but do
 * not yet have corresponding entries in the event log. The workflow
 * dispatcher will catch this error and push the operations
 * onto the queue.
 */
class WorkflowSuspension extends Error {
    steps;
    globalThis;
    stepCount;
    hookCount;
    waitCount;
    constructor(steps, global) {
        const stepCount = steps.filter((s) => s.type === 'step').length;
        const hookCount = steps.filter((s) => s.type === 'hook').length;
        const waitCount = steps.filter((s) => s.type === 'wait').length;
        // Build description parts
        const parts = [];
        if (stepCount > 0) {
            parts.push(`${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`);
        }
        if (hookCount > 0) {
            parts.push(`${hookCount} ${hookCount === 1 ? 'hook' : 'hooks'}`);
        }
        if (waitCount > 0) {
            parts.push(`${waitCount} ${waitCount === 1 ? 'wait' : 'waits'}`);
        }
        // Determine verb (has/have) and action (run/created/received)
        const totalCount = stepCount + hookCount + waitCount;
        const hasOrHave = totalCount === 1 ? 'has' : 'have';
        let action;
        if (stepCount > 0) {
            action = 'run';
        }
        else if (hookCount > 0) {
            action = 'created';
        }
        else if (waitCount > 0) {
            action = 'created';
        }
        else {
            action = 'received';
        }
        const description = parts.length > 0
            ? `${parts.join(' and ')} ${hasOrHave} not been ${action} yet`
            : '0 steps have not been run yet'; // Default case for empty array
        super(description);
        this.name = 'WorkflowSuspension';
        this.steps = steps;
        this.globalThis = global;
        this.stepCount = stepCount;
        this.hookCount = hookCount;
        this.waitCount = waitCount;
    }
    static is(value) {
        return value instanceof WorkflowSuspension;
    }
}
function ENOTSUP() {
    throw new Error('Not supported in workflow functions');
}

/**
 * Parse a machine readable name.
 *
 * @see {@link ../../swc-plugin-workflow/transform/src/naming.rs} for the naming scheme.
 */
function parseName(tag, name) {
    if (typeof name !== 'string') {
        return null;
    }
    const [prefix, path, ...functionNameParts] = name.split('//');
    if (prefix !== tag || !path || functionNameParts.length === 0) {
        return null;
    }
    return {
        shortName: functionNameParts.at(-1) ?? '',
        path,
        functionName: functionNameParts.join('//'),
    };
}
/**
 * Parse a workflow name into its components.
 *
 * @param name - The workflow name to parse.
 * @returns An object with `shortName`, `path`, and `functionName` properties.
 * When the name is invalid, returns `null`.
 */
function parseWorkflowName(name) {
    return parseName('workflow', name);
}

// Matches the scheme of a URL, eg "http://"
const schemeRegex = /^[\w+.-]+:\/\//;
/**
 * Matches the parts of a URL:
 * 1. Scheme, including ":", guaranteed.
 * 2. User/password, including "@", optional.
 * 3. Host, guaranteed.
 * 4. Port, including ":", optional.
 * 5. Path, including "/", optional.
 * 6. Query, including "?", optional.
 * 7. Hash, including "#", optional.
 */
const urlRegex = /^([\w+.-]+:)\/\/([^@/#?]*@)?([^:/#?]*)(:\d+)?(\/[^#?]*)?(\?[^#]*)?(#.*)?/;
/**
 * File URLs are weird. They dont' need the regular `//` in the scheme, they may or may not start
 * with a leading `/`, they can have a domain (but only if they don't start with a Windows drive).
 *
 * 1. Host, optional.
 * 2. Path, which may include "/", guaranteed.
 * 3. Query, including "?", optional.
 * 4. Hash, including "#", optional.
 */
const fileRegex = /^file:(?:\/\/((?![a-z]:)[^/#?]*)?)?(\/?[^#?]*)(\?[^#]*)?(#.*)?/i;
function isAbsoluteUrl(input) {
    return schemeRegex.test(input);
}
function isSchemeRelativeUrl(input) {
    return input.startsWith('//');
}
function isAbsolutePath(input) {
    return input.startsWith('/');
}
function isFileUrl(input) {
    return input.startsWith('file:');
}
function isRelative(input) {
    return /^[.?#]/.test(input);
}
function parseAbsoluteUrl(input) {
    const match = urlRegex.exec(input);
    return makeUrl(match[1], match[2] || '', match[3], match[4] || '', match[5] || '/', match[6] || '', match[7] || '');
}
function parseFileUrl(input) {
    const match = fileRegex.exec(input);
    const path = match[2];
    return makeUrl('file:', '', match[1] || '', '', isAbsolutePath(path) ? path : '/' + path, match[3] || '', match[4] || '');
}
function makeUrl(scheme, user, host, port, path, query, hash) {
    return {
        scheme,
        user,
        host,
        port,
        path,
        query,
        hash,
        type: 7 /* Absolute */,
    };
}
function parseUrl(input) {
    if (isSchemeRelativeUrl(input)) {
        const url = parseAbsoluteUrl('http:' + input);
        url.scheme = '';
        url.type = 6 /* SchemeRelative */;
        return url;
    }
    if (isAbsolutePath(input)) {
        const url = parseAbsoluteUrl('http://foo.com' + input);
        url.scheme = '';
        url.host = '';
        url.type = 5 /* AbsolutePath */;
        return url;
    }
    if (isFileUrl(input))
        return parseFileUrl(input);
    if (isAbsoluteUrl(input))
        return parseAbsoluteUrl(input);
    const url = parseAbsoluteUrl('http://foo.com/' + input);
    url.scheme = '';
    url.host = '';
    url.type = input
        ? input.startsWith('?')
            ? 3 /* Query */
            : input.startsWith('#')
                ? 2 /* Hash */
                : 4 /* RelativePath */
        : 1 /* Empty */;
    return url;
}
function stripPathFilename(path) {
    // If a path ends with a parent directory "..", then it's a relative path with excess parent
    // paths. It's not a file, so we can't strip it.
    if (path.endsWith('/..'))
        return path;
    const index = path.lastIndexOf('/');
    return path.slice(0, index + 1);
}
function mergePaths(url, base) {
    normalizePath(base, base.type);
    // If the path is just a "/", then it was an empty path to begin with (remember, we're a relative
    // path).
    if (url.path === '/') {
        url.path = base.path;
    }
    else {
        // Resolution happens relative to the base path's directory, not the file.
        url.path = stripPathFilename(base.path) + url.path;
    }
}
/**
 * The path can have empty directories "//", unneeded parents "foo/..", or current directory
 * "foo/.". We need to normalize to a standard representation.
 */
function normalizePath(url, type) {
    const rel = type <= 4 /* RelativePath */;
    const pieces = url.path.split('/');
    // We need to preserve the first piece always, so that we output a leading slash. The item at
    // pieces[0] is an empty string.
    let pointer = 1;
    // Positive is the number of real directories we've output, used for popping a parent directory.
    // Eg, "foo/bar/.." will have a positive 2, and we can decrement to be left with just "foo".
    let positive = 0;
    // We need to keep a trailing slash if we encounter an empty directory (eg, splitting "foo/" will
    // generate `["foo", ""]` pieces). And, if we pop a parent directory. But once we encounter a
    // real directory, we won't need to append, unless the other conditions happen again.
    let addTrailingSlash = false;
    for (let i = 1; i < pieces.length; i++) {
        const piece = pieces[i];
        // An empty directory, could be a trailing slash, or just a double "//" in the path.
        if (!piece) {
            addTrailingSlash = true;
            continue;
        }
        // If we encounter a real directory, then we don't need to append anymore.
        addTrailingSlash = false;
        // A current directory, which we can always drop.
        if (piece === '.')
            continue;
        // A parent directory, we need to see if there are any real directories we can pop. Else, we
        // have an excess of parents, and we'll need to keep the "..".
        if (piece === '..') {
            if (positive) {
                addTrailingSlash = true;
                positive--;
                pointer--;
            }
            else if (rel) {
                // If we're in a relativePath, then we need to keep the excess parents. Else, in an absolute
                // URL, protocol relative URL, or an absolute path, we don't need to keep excess.
                pieces[pointer++] = piece;
            }
            continue;
        }
        // We've encountered a real directory. Move it to the next insertion pointer, which accounts for
        // any popped or dropped directories.
        pieces[pointer++] = piece;
        positive++;
    }
    let path = '';
    for (let i = 1; i < pointer; i++) {
        path += '/' + pieces[i];
    }
    if (!path || (addTrailingSlash && !path.endsWith('/..'))) {
        path += '/';
    }
    url.path = path;
}
/**
 * Attempts to resolve `input` URL/path relative to `base`.
 */
function resolve(input, base) {
    if (!input && !base)
        return '';
    const url = parseUrl(input);
    let inputType = url.type;
    if (base && inputType !== 7 /* Absolute */) {
        const baseUrl = parseUrl(base);
        const baseType = baseUrl.type;
        switch (inputType) {
            case 1 /* Empty */:
                url.hash = baseUrl.hash;
            // fall through
            case 2 /* Hash */:
                url.query = baseUrl.query;
            // fall through
            case 3 /* Query */:
            case 4 /* RelativePath */:
                mergePaths(url, baseUrl);
            // fall through
            case 5 /* AbsolutePath */:
                // The host, user, and port are joined, you can't copy one without the others.
                url.user = baseUrl.user;
                url.host = baseUrl.host;
                url.port = baseUrl.port;
            // fall through
            case 6 /* SchemeRelative */:
                // The input doesn't have a schema at least, so we need to copy at least that over.
                url.scheme = baseUrl.scheme;
        }
        if (baseType > inputType)
            inputType = baseType;
    }
    normalizePath(url, inputType);
    const queryHash = url.query + url.hash;
    switch (inputType) {
        // This is impossible, because of the empty checks at the start of the function.
        // case UrlType.Empty:
        case 2 /* Hash */:
        case 3 /* Query */:
            return queryHash;
        case 4 /* RelativePath */: {
            // The first char is always a "/", and we need it to be relative.
            const path = url.path.slice(1);
            if (!path)
                return queryHash || '.';
            if (isRelative(base || input) && !isRelative(path)) {
                // If base started with a leading ".", or there is no base and input started with a ".",
                // then we need to ensure that the relative path starts with a ".". We don't know if
                // relative starts with a "..", though, so check before prepending.
                return './' + path + queryHash;
            }
            return path + queryHash;
        }
        case 5 /* AbsolutePath */:
            return url.path + queryHash;
        default:
            return url.scheme + '//' + url.user + url.host + url.port + url.path + queryHash;
    }
}

// src/trace-mapping.ts

// src/strip-filename.ts
function stripFilename(path) {
  if (!path) return "";
  const index = path.lastIndexOf("/");
  return path.slice(0, index + 1);
}

// src/resolve.ts
function resolver(mapUrl, sourceRoot) {
  const from = stripFilename(mapUrl);
  const prefix = sourceRoot ? sourceRoot + "/" : "";
  return (source) => resolve(prefix + (source || ""), from);
}

// src/sourcemap-segment.ts
var COLUMN = 0;
var SOURCES_INDEX = 1;
var SOURCE_LINE = 2;
var SOURCE_COLUMN = 3;
var NAMES_INDEX = 4;

// src/sort.ts
function maybeSort(mappings, owned) {
  const unsortedIndex = nextUnsortedSegmentLine(mappings, 0);
  if (unsortedIndex === mappings.length) return mappings;
  if (!owned) mappings = mappings.slice();
  for (let i = unsortedIndex; i < mappings.length; i = nextUnsortedSegmentLine(mappings, i + 1)) {
    mappings[i] = sortSegments(mappings[i], owned);
  }
  return mappings;
}
function nextUnsortedSegmentLine(mappings, start) {
  for (let i = start; i < mappings.length; i++) {
    if (!isSorted(mappings[i])) return i;
  }
  return mappings.length;
}
function isSorted(line) {
  for (let j = 1; j < line.length; j++) {
    if (line[j][COLUMN] < line[j - 1][COLUMN]) {
      return false;
    }
  }
  return true;
}
function sortSegments(line, owned) {
  if (!owned) line = line.slice();
  return line.sort(sortComparator);
}
function sortComparator(a, b) {
  return a[COLUMN] - b[COLUMN];
}

// src/binary-search.ts
var found = false;
function binarySearch(haystack, needle, low, high) {
  while (low <= high) {
    const mid = low + (high - low >> 1);
    const cmp = haystack[mid][COLUMN] - needle;
    if (cmp === 0) {
      found = true;
      return mid;
    }
    if (cmp < 0) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  found = false;
  return low - 1;
}
function upperBound(haystack, needle, index) {
  for (let i = index + 1; i < haystack.length; index = i++) {
    if (haystack[i][COLUMN] !== needle) break;
  }
  return index;
}
function lowerBound(haystack, needle, index) {
  for (let i = index - 1; i >= 0; index = i--) {
    if (haystack[i][COLUMN] !== needle) break;
  }
  return index;
}
function memoizedState() {
  return {
    lastKey: -1,
    lastNeedle: -1,
    lastIndex: -1
  };
}
function memoizedBinarySearch(haystack, needle, state, key) {
  const { lastKey, lastNeedle, lastIndex } = state;
  let low = 0;
  let high = haystack.length - 1;
  if (key === lastKey) {
    if (needle === lastNeedle) {
      found = lastIndex !== -1 && haystack[lastIndex][COLUMN] === needle;
      return lastIndex;
    }
    if (needle >= lastNeedle) {
      low = lastIndex === -1 ? 0 : lastIndex;
    } else {
      high = lastIndex;
    }
  }
  state.lastKey = key;
  state.lastNeedle = needle;
  return state.lastIndex = binarySearch(haystack, needle, low, high);
}

// src/types.ts
function parse(map) {
  return typeof map === "string" ? JSON.parse(map) : map;
}

// src/trace-mapping.ts
var LINE_GTR_ZERO = "`line` must be greater than 0 (lines start at line 1)";
var COL_GTR_EQ_ZERO = "`column` must be greater than or equal to 0 (columns start at column 0)";
var LEAST_UPPER_BOUND = -1;
var GREATEST_LOWER_BOUND = 1;
var TraceMap = class {
  constructor(map, mapUrl) {
    const isString = typeof map === "string";
    if (!isString && map._decodedMemo) return map;
    const parsed = parse(map);
    const { version, file, names, sourceRoot, sources, sourcesContent } = parsed;
    this.version = version;
    this.file = file;
    this.names = names || [];
    this.sourceRoot = sourceRoot;
    this.sources = sources;
    this.sourcesContent = sourcesContent;
    this.ignoreList = parsed.ignoreList || parsed.x_google_ignoreList || void 0;
    const resolve = resolver(mapUrl, sourceRoot);
    this.resolvedSources = sources.map(resolve);
    const { mappings } = parsed;
    if (typeof mappings === "string") {
      this._encoded = mappings;
      this._decoded = void 0;
    } else if (Array.isArray(mappings)) {
      this._encoded = void 0;
      this._decoded = maybeSort(mappings, isString);
    } else if (parsed.sections) {
      throw new Error(`TraceMap passed sectioned source map, please use FlattenMap export instead`);
    } else {
      throw new Error(`invalid source map: ${JSON.stringify(parsed)}`);
    }
    this._decodedMemo = memoizedState();
    this._bySources = void 0;
    this._bySourceMemos = void 0;
  }
};
function cast(map) {
  return map;
}
function decodedMappings(map) {
  var _a;
  return (_a = cast(map))._decoded || (_a._decoded = decode(cast(map)._encoded));
}
function originalPositionFor(map, needle) {
  let { line, column, bias } = needle;
  line--;
  if (line < 0) throw new Error(LINE_GTR_ZERO);
  if (column < 0) throw new Error(COL_GTR_EQ_ZERO);
  const decoded = decodedMappings(map);
  if (line >= decoded.length) return OMapping(null, null, null, null);
  const segments = decoded[line];
  const index = traceSegmentInternal(
    segments,
    cast(map)._decodedMemo,
    line,
    column,
    bias || GREATEST_LOWER_BOUND
  );
  if (index === -1) return OMapping(null, null, null, null);
  const segment = segments[index];
  if (segment.length === 1) return OMapping(null, null, null, null);
  const { names, resolvedSources } = map;
  return OMapping(
    resolvedSources[segment[SOURCES_INDEX]],
    segment[SOURCE_LINE] + 1,
    segment[SOURCE_COLUMN],
    segment.length === 5 ? names[segment[NAMES_INDEX]] : null
  );
}
function OMapping(source, line, column, name) {
  return { source, line, column, name };
}
function traceSegmentInternal(segments, memo, line, column, bias) {
  let index = memoizedBinarySearch(segments, column, memo, line);
  if (found) {
    index = (bias === LEAST_UPPER_BOUND ? upperBound : lowerBound)(segments, column, index);
  } else if (bias === LEAST_UPPER_BOUND) index++;
  if (index === -1 || index === segments.length) return -1;
  return index;
}

/**
 * Remaps an error stack trace using inline source maps to show original source locations.
 *
 * @param stack - The error stack trace to remap
 * @param filename - The workflow filename to match in stack frames
 * @param workflowCode - The workflow bundle code containing inline source maps
 * @returns The remapped stack trace with original source locations
 */
function remapErrorStack(stack, filename, workflowCode) {
    // Extract inline source map from workflow code
    const sourceMapMatch = workflowCode.match(/\/\/# sourceMappingURL=data:application\/json;base64,(.+)/);
    if (!sourceMapMatch) {
        return stack; // No source map found
    }
    try {
        const base64 = sourceMapMatch[1];
        const sourceMapJson = Buffer.from(base64, 'base64').toString('utf-8');
        const sourceMapData = JSON.parse(sourceMapJson);
        // Use TraceMap (pure JS, no WASM required)
        const tracer = new TraceMap(sourceMapData);
        // Parse and remap each line in the stack trace
        const lines = stack.split('\n');
        const remappedLines = lines.map((line) => {
            // Match stack frames: "at functionName (filename:line:column)" or "at filename:line:column"
            const frameMatch = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
            if (!frameMatch) {
                return line; // Not a stack frame, return as-is
            }
            const [, functionName, file, lineStr, colStr] = frameMatch;
            // Only remap frames from our workflow file
            if (!file.includes(filename)) {
                return line;
            }
            const lineNumber = parseInt(lineStr, 10);
            const columnNumber = parseInt(colStr, 10);
            // Map to original source position
            const original = originalPositionFor(tracer, {
                line: lineNumber,
                column: columnNumber,
            });
            if (original.source && original.line !== null) {
                const func = functionName || original.name || 'anonymous';
                const col = original.column !== null ? original.column : columnNumber;
                return `    at ${func} (${original.source}:${original.line}:${col})`;
            }
            return line; // Couldn't map, return original
        });
        return remappedLines.join('\n');
    }
    catch (e) {
        // If source map processing fails, return original stack
        return stack;
    }
}

const contextStorage = /* @__PURE__ */ new AsyncLocalStorage();

function getErrorName(v) {
    if (types.isNativeError(v)) {
        return v.name;
    }
    return 'Error';
}
function getErrorStack(v) {
    if (types.isNativeError(v)) {
        return v.stack ?? '';
    }
    return '';
}

function createUseStep(ctx) {
    return function useStep(stepName) {
        return (...args) => {
            const { promise, resolve, reject } = withResolvers();
            const correlationId = `step_${ctx.generateUlid()}`;
            ctx.invocationsQueue.push({
                type: 'step',
                correlationId,
                stepName,
                args,
            });
            // Track whether we've already seen a "step_started" event for this step.
            // This is important because after a retryable failure, the step moves back to
            // "pending" status which causes another "step_started" event to be emitted.
            let hasSeenStepStarted = false;
            stepLogger.debug('Step consumer setup', {
                correlationId,
                stepName,
                args,
            });
            ctx.eventsConsumer.subscribe((event) => {
                if (!event) {
                    // We've reached the end of the events, so this step has either not been run or is currently running.
                    // Crucially, if we got here, then this step Promise does
                    // not resolve so that the user workflow code does not proceed any further.
                    // Notify the workflow handler that this step has not been run / has not completed yet.
                    setTimeout(() => {
                        ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                    }, 0);
                    return EventConsumerResult.NotConsumed;
                }
                stepLogger.debug('Step consumer event processing', {
                    correlationId,
                    stepName,
                    args: args.join(', '),
                    incomingCorrelationId: event.correlationId,
                    isMatch: correlationId === event.correlationId,
                    eventType: event.eventType,
                });
                if (event.correlationId !== correlationId) {
                    // We're not interested in this event - the correlationId belongs to a different step
                    return EventConsumerResult.NotConsumed;
                }
                if (event.eventType === 'step_started') {
                    // Step has started - so remove from the invocations queue (only on the first "step_started" event)
                    if (!hasSeenStepStarted) {
                        const invocationsQueueIndex = ctx.invocationsQueue.findIndex((invocation) => invocation.type === 'step' &&
                            invocation.correlationId === correlationId);
                        if (invocationsQueueIndex !== -1) {
                            ctx.invocationsQueue.splice(invocationsQueueIndex, 1);
                        }
                        else {
                            setTimeout(() => {
                                reject(new WorkflowRuntimeError(`Corrupted event log: step ${correlationId} (${stepName}) started but not found in invocation queue`));
                            }, 0);
                            return EventConsumerResult.Finished;
                        }
                        hasSeenStepStarted = true;
                    }
                    // If this is a subsequent "step_started" event (after a retry), we just consume it
                    // without trying to remove from the queue again or logging a warning
                    return EventConsumerResult.Consumed;
                }
                if (event.eventType === 'step_failed') {
                    // Step failed - bubble up to workflow
                    if (event.eventData.fatal) {
                        setTimeout(() => {
                            reject(new FatalError(event.eventData.error));
                        }, 0);
                        return EventConsumerResult.Finished;
                    }
                    else {
                        // This is a retryable error, so nothing to do here,
                        // but we will consume the event
                        return EventConsumerResult.Consumed;
                    }
                }
                else if (event.eventType === 'step_completed') {
                    // Step has already completed, so resolve the Promise with the cached result
                    const hydratedResult = hydrateStepReturnValue(event.eventData.result, ctx.globalThis);
                    setTimeout(() => {
                        resolve(hydratedResult);
                    }, 0);
                    return EventConsumerResult.Finished;
                }
                else {
                    // An unexpected event type has been received, but it does belong to this step (matching `correlationId`)
                    setTimeout(() => {
                        reject(new WorkflowRuntimeError(`Unexpected event type: "${event.eventType}"`));
                    }, 0);
                    return EventConsumerResult.Finished;
                }
            });
            return promise;
        };
    };
}

/**
 * Returns a function that generates a random UUID, based on the given RNG.
 *
 * `rng` is expected to be a seeded random number generator (i.e. `seedrandom.PRNG` instance).
 *
 * @param rng - A function that returns a random number between 0 and 1.
 * @returns A `crypto.randomUUID`-like function.
 */
function createRandomUUID(rng) {
    return function randomUUID() {
        const chars = '0123456789abcdef';
        let uuid = '';
        for (let i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) {
                uuid += '-';
            }
            else if (i === 14) {
                uuid += '4'; // Version 4 UUID
            }
            else if (i === 19) {
                uuid += chars[Math.floor(rng() * 4) + 8]; // 8, 9, a, or b
            }
            else {
                uuid += chars[Math.floor(rng() * 16)];
            }
        }
        return uuid;
    };
}

/**
 * Creates a Node.js `vm.Context` configured to be usable for
 * executing workflow logic in a deterministic environment.
 *
 * @param options - The options for the context.
 * @returns The context.
 */
function createContext(options) {
    let { fixedTimestamp } = options;
    const { seed } = options;
    const rng = seedrandom(seed);
    const context = createContext$1();
    const g = runInContext('globalThis', context);
    // Deterministic `Math.random()`
    g.Math.random = rng;
    // Override `Date` constructor to return fixed time when called without arguments
    const Date_ = g.Date;
    // biome-ignore lint/suspicious/noShadowRestrictedNames: We're shadowing the global `Date` property to make it deterministic.
    g.Date = function Date(...args) {
        if (args.length === 0) {
            return new Date_(fixedTimestamp);
        }
        // @ts-expect-error - Args is `Date` constructor arguments
        return new Date_(...args);
    };
    g.Date.prototype = Date_.prototype;
    // Preserve static methods
    Object.setPrototypeOf(g.Date, Date_);
    g.Date.now = () => fixedTimestamp;
    // Deterministic `crypto` using Proxy to avoid mutating global objects
    const originalCrypto = globalThis.crypto;
    const originalSubtle = originalCrypto.subtle;
    function getRandomValues(array) {
        for (let i = 0; i < array.length; i++) {
            array[i] = Math.floor(rng() * 256);
        }
        return array;
    }
    const randomUUID = createRandomUUID(rng);
    const boundDigest = originalSubtle.digest.bind(originalSubtle);
    g.crypto = new Proxy(originalCrypto, {
        get(target, prop) {
            if (prop === 'getRandomValues') {
                return getRandomValues;
            }
            if (prop === 'randomUUID') {
                return randomUUID;
            }
            if (prop === 'subtle') {
                return new Proxy(originalSubtle, {
                    get(target, prop) {
                        if (prop === 'generateKey') {
                            return () => {
                                throw new Error('Not implemented');
                            };
                        }
                        else if (prop === 'digest') {
                            return boundDigest;
                        }
                        return target[prop];
                    },
                });
            }
            return target[prop];
        },
    });
    // Propagate environment variables
    g.process = {
        env: Object.freeze({ ...process.env }),
    };
    // Stateless + synchronous Web APIs that are made available inside the sandbox
    g.Headers = globalThis.Headers;
    g.TextEncoder = globalThis.TextEncoder;
    g.TextDecoder = globalThis.TextDecoder;
    g.console = globalThis.console;
    g.URL = globalThis.URL;
    g.URLSearchParams = globalThis.URLSearchParams;
    g.structuredClone = globalThis.structuredClone;
    // HACK: Shim `exports` for the bundle
    g.exports = {};
    g.module = { exports: g.exports };
    return {
        context,
        globalThis: g,
        updateTimestamp: (timestamp) => {
            fixedTimestamp = timestamp;
        },
    };
}

const WORKFLOW_CONTEXT_SYMBOL = 
/* @__PURE__ */ Symbol.for('WORKFLOW_CONTEXT');

function createCreateHook(ctx) {
    return function createHookImpl(options = {}) {
        // Generate hook ID and token
        const correlationId = `hook_${ctx.generateUlid()}`;
        const token = options.token ?? ctx.generateNanoid();
        // Add hook creation to invocations queue
        ctx.invocationsQueue.push({
            type: 'hook',
            correlationId,
            token,
            metadata: options.metadata,
        });
        // Queue of hook events that have been received but not yet processed
        const payloadsQueue = [];
        // Queue of promises that resolve to the next hook payload
        const promises = [];
        let eventLogEmpty = false;
        webhookLogger.debug('Hook consumer setup', { correlationId, token });
        ctx.eventsConsumer.subscribe((event) => {
            // If there are no events and there are promises waiting,
            // it means the hook has been awaited, but an incoming payload has not yet been received.
            // In this case, the workflow should be suspended until the hook is resumed.
            if (!event) {
                eventLogEmpty = true;
                if (promises.length > 0) {
                    setTimeout(() => {
                        ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                    }, 0);
                    return EventConsumerResult.Finished;
                }
            }
            // Check for hook_created event to remove this hook from the queue if it was already created
            if (event?.eventType === 'hook_created' &&
                event.correlationId === correlationId) {
                // Remove this hook from the invocations queue if it exists
                const index = ctx.invocationsQueue.findIndex((item) => item.type === 'hook' && item.correlationId === correlationId);
                if (index !== -1) {
                    ctx.invocationsQueue.splice(index, 1);
                }
                return EventConsumerResult.Consumed;
            }
            if (event?.eventType === 'hook_received' &&
                event.correlationId === correlationId) {
                if (promises.length > 0) {
                    const next = promises.shift();
                    if (next) {
                        // Reconstruct the payload from the event data
                        const payload = hydrateStepReturnValue(event.eventData.payload, ctx.globalThis);
                        next.resolve(payload);
                    }
                }
                else {
                    payloadsQueue.push(event);
                }
                return EventConsumerResult.Consumed;
            }
            return EventConsumerResult.NotConsumed;
        });
        // Helper function to create a new promise that waits for the next hook payload
        function createHookPromise() {
            const resolvers = withResolvers();
            if (payloadsQueue.length > 0) {
                const nextPayload = payloadsQueue.shift();
                if (nextPayload) {
                    const payload = hydrateStepReturnValue(nextPayload.eventData.payload, ctx.globalThis);
                    resolvers.resolve(payload);
                    return resolvers.promise;
                }
            }
            if (eventLogEmpty) {
                // If the event log is already empty then we know the hook will not be resolved.
                // Treat this case as a "step not run" scenario and suspend the workflow.
                setTimeout(() => {
                    ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                }, 0);
            }
            promises.push(resolvers);
            return resolvers.promise;
        }
        const hook = {
            token,
            // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
            then(onfulfilled, onrejected) {
                return createHookPromise().then(onfulfilled, onrejected);
            },
            // Support `for await (const payload of hook) { … }` syntax
            async *[Symbol.asyncIterator]() {
                while (true) {
                    yield await this;
                }
            },
        };
        return hook;
    };
}

function createSleep(ctx) {
    return async function sleepImpl(param) {
        const { promise, resolve } = withResolvers();
        const correlationId = `wait_${ctx.generateUlid()}`;
        // Calculate the resume time
        const resumeAt = parseDurationToDate(param);
        // Add wait to invocations queue
        ctx.invocationsQueue.push({
            type: 'wait',
            correlationId,
            resumeAt,
        });
        ctx.eventsConsumer.subscribe((event) => {
            // If there are no events and we're waiting for wait_completed,
            // suspend the workflow until the wait fires
            if (!event) {
                setTimeout(() => {
                    ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                }, 0);
                return EventConsumerResult.NotConsumed;
            }
            // Check for wait_created event to mark this wait as having the event created
            if (event?.eventType === 'wait_created' &&
                event.correlationId === correlationId) {
                // Mark this wait as having the created event, but keep it in the queue
                const waitItem = ctx.invocationsQueue.find((item) => item.type === 'wait' && item.correlationId === correlationId);
                if (waitItem) {
                    waitItem.hasCreatedEvent = true;
                    waitItem.resumeAt = event.eventData.resumeAt;
                }
                return EventConsumerResult.Consumed;
            }
            // Check for wait_completed event
            if (event?.eventType === 'wait_completed' &&
                event.correlationId === correlationId) {
                // Remove this wait from the invocations queue
                const index = ctx.invocationsQueue.findIndex((item) => item.type === 'wait' && item.correlationId === correlationId);
                if (index !== -1) {
                    ctx.invocationsQueue.splice(index, 1);
                }
                // Wait has elapsed, resolve the sleep
                setTimeout(() => {
                    resolve();
                }, 0);
                return EventConsumerResult.Finished;
            }
            return EventConsumerResult.NotConsumed;
        });
        return promise;
    };
}

async function runWorkflow(workflowCode, workflowRun, events) {
    return trace(`WORKFLOW.run ${workflowRun.workflowName}`, async (span) => {
        span?.setAttributes({
            ...WorkflowName(workflowRun.workflowName),
            ...WorkflowRunId(workflowRun.runId),
            ...WorkflowRunStatus(workflowRun.status),
            ...WorkflowEventsCount(events.length),
        });
        const startedAt = workflowRun.startedAt;
        if (!startedAt) {
            throw new Error(`Workflow run "${workflowRun.runId}" has no "startedAt" timestamp (should not happen)`);
        }
        // Get the port before creating VM context to avoid async operations
        // affecting the deterministic timestamp
        const port = await getPort();
        const { context, globalThis: vmGlobalThis, updateTimestamp, } = createContext({
            seed: workflowRun.runId,
            fixedTimestamp: +startedAt,
        });
        const workflowDiscontinuation = withResolvers();
        const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
        const generateNanoid = nanoid.customRandom(nanoid.urlAlphabet, 21, (size) => new Uint8Array(size).map(() => 256 * vmGlobalThis.Math.random()));
        const workflowContext = {
            globalThis: vmGlobalThis,
            onWorkflowError: workflowDiscontinuation.reject,
            eventsConsumer: new EventsConsumer(events),
            generateUlid: () => ulid(+startedAt),
            generateNanoid,
            invocationsQueue: [],
        };
        // Subscribe to the events log to update the timestamp in the vm context
        workflowContext.eventsConsumer.subscribe((event) => {
            const createdAt = event?.createdAt;
            if (createdAt) {
                updateTimestamp(+createdAt);
            }
            // Never consume events - this is only a passive subscriber
            return EventConsumerResult.NotConsumed;
        });
        const useStep = createUseStep(workflowContext);
        const createHook = createCreateHook(workflowContext);
        const sleep = createSleep(workflowContext);
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_USE_STEP] = useStep;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_CREATE_HOOK] = createHook;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_SLEEP] = sleep;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_GET_STREAM_ID] = (namespace) => getWorkflowRunStreamId(workflowRun.runId, namespace);
        // TODO: there should be a getUrl method on the world interface itself. This
        // solution only works for vercel + embedded worlds.
        const url = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : `http://localhost:${port ?? 3000}`;
        // For the workflow VM, we store the context in a symbol on the `globalThis` object
        const ctx = {
            workflowRunId: workflowRun.runId,
            workflowStartedAt: new vmGlobalThis.Date(+startedAt),
            url,
        };
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_CONTEXT_SYMBOL] = ctx;
        // NOTE: Will have a config override to use the custom fetch step.
        //       For now `fetch` must be explicitly imported from `workflow`.
        vmGlobalThis.fetch = () => {
            throw new vmGlobalThis.Error(`Global "fetch" is unavailable in workflow functions. Use the "fetch" step function from "workflow" to make HTTP requests.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.FETCH_IN_WORKFLOW_FUNCTION}`);
        };
        // `Request` and `Response` are special built-in classes that invoke steps
        // for the `json()`, `text()` and `arrayBuffer()` instance methods
        class Request {
            cache;
            credentials;
            destination;
            headers;
            integrity;
            method;
            mode;
            redirect;
            referrer;
            referrerPolicy;
            url;
            keepalive;
            signal;
            duplex;
            body;
            constructor(input, init) {
                // Handle URL input
                if (typeof input === 'string' || input instanceof vmGlobalThis.URL) {
                    const urlString = String(input);
                    // Validate URL format
                    try {
                        new vmGlobalThis.URL(urlString);
                        this.url = urlString;
                    }
                    catch (cause) {
                        throw new TypeError(`Failed to parse URL from ${urlString}`, {
                            cause,
                        });
                    }
                }
                else {
                    // Input is a Request object - clone its properties
                    this.url = input.url;
                    if (!init) {
                        this.method = input.method;
                        this.headers = new vmGlobalThis.Headers(input.headers);
                        this.body = input.body;
                        this.mode = input.mode;
                        this.credentials = input.credentials;
                        this.cache = input.cache;
                        this.redirect = input.redirect;
                        this.referrer = input.referrer;
                        this.referrerPolicy = input.referrerPolicy;
                        this.integrity = input.integrity;
                        this.keepalive = input.keepalive;
                        this.signal = input.signal;
                        this.duplex = input.duplex;
                        this.destination = input.destination;
                        return;
                    }
                    // If init is provided, merge: use source properties, then override with init
                    // Copy all properties from the source Request first
                    this.method = input.method;
                    this.headers = new vmGlobalThis.Headers(input.headers);
                    this.body = input.body;
                    this.mode = input.mode;
                    this.credentials = input.credentials;
                    this.cache = input.cache;
                    this.redirect = input.redirect;
                    this.referrer = input.referrer;
                    this.referrerPolicy = input.referrerPolicy;
                    this.integrity = input.integrity;
                    this.keepalive = input.keepalive;
                    this.signal = input.signal;
                    this.duplex = input.duplex;
                    this.destination = input.destination;
                }
                // Override with init options if provided
                // Set method
                if (init?.method) {
                    this.method = init.method.toUpperCase();
                }
                else if (typeof this.method !== 'string') {
                    // Fallback to default for string input case
                    this.method = 'GET';
                }
                // Set headers
                if (init?.headers) {
                    this.headers = new vmGlobalThis.Headers(init.headers);
                }
                else if (typeof input === 'string' ||
                    input instanceof vmGlobalThis.URL) {
                    // For string/URL input, create empty headers
                    this.headers = new vmGlobalThis.Headers();
                }
                // Set other properties with init values or defaults
                if (init?.mode !== undefined) {
                    this.mode = init.mode;
                }
                else if (typeof this.mode !== 'string') {
                    this.mode = 'cors';
                }
                if (init?.credentials !== undefined) {
                    this.credentials = init.credentials;
                }
                else if (typeof this.credentials !== 'string') {
                    this.credentials = 'same-origin';
                }
                // `any` cast here because @types/node v22 does not yet have `cache`
                if (init?.cache !== undefined) {
                    this.cache = init.cache;
                }
                else if (typeof this.cache !== 'string') {
                    this.cache = 'default';
                }
                if (init?.redirect !== undefined) {
                    this.redirect = init.redirect;
                }
                else if (typeof this.redirect !== 'string') {
                    this.redirect = 'follow';
                }
                if (init?.referrer !== undefined) {
                    this.referrer = init.referrer;
                }
                else if (typeof this.referrer !== 'string') {
                    this.referrer = 'about:client';
                }
                if (init?.referrerPolicy !== undefined) {
                    this.referrerPolicy = init.referrerPolicy;
                }
                else if (typeof this.referrerPolicy !== 'string') {
                    this.referrerPolicy = '';
                }
                if (init?.integrity !== undefined) {
                    this.integrity = init.integrity;
                }
                else if (typeof this.integrity !== 'string') {
                    this.integrity = '';
                }
                if (init?.keepalive !== undefined) {
                    this.keepalive = init.keepalive;
                }
                else if (typeof this.keepalive !== 'boolean') {
                    this.keepalive = false;
                }
                if (init?.signal !== undefined) {
                    // @ts-expect-error - AbortSignal stub
                    this.signal = init.signal;
                }
                else if (!this.signal) {
                    // @ts-expect-error - AbortSignal stub
                    this.signal = { aborted: false };
                }
                if (!this.duplex) {
                    this.duplex = 'half';
                }
                if (!this.destination) {
                    this.destination = 'document';
                }
                const body = init?.body;
                // Validate that GET/HEAD methods don't have a body
                if (body !== null &&
                    body !== undefined &&
                    (this.method === 'GET' || this.method === 'HEAD')) {
                    throw new TypeError(`Request with GET/HEAD method cannot have body.`);
                }
                // Store the original BodyInit for serialization
                if (body !== null && body !== undefined) {
                    // Create a "fake" ReadableStream that stores the original body
                    // This avoids doing async work during workflow replay
                    this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
                        [BODY_INIT_SYMBOL]: {
                            value: body,
                            writable: false,
                        },
                    });
                }
                else {
                    this.body = null;
                }
            }
            clone() {
                ENOTSUP();
            }
            get bodyUsed() {
                return false;
            }
            // TODO: implement these
            blob;
            formData;
            async arrayBuffer() {
                return resArrayBuffer(this);
            }
            async bytes() {
                return new Uint8Array(await resArrayBuffer(this));
            }
            async json() {
                return resJson(this);
            }
            async text() {
                return resText(this);
            }
        }
        vmGlobalThis.Request = Request;
        const resJson = useStep('__builtin_response_json');
        const resText = useStep('__builtin_response_text');
        const resArrayBuffer = useStep('__builtin_response_array_buffer');
        class Response {
            type;
            url;
            status;
            statusText;
            body;
            headers;
            redirected;
            constructor(body, init) {
                this.status = init?.status ?? 200;
                this.statusText = init?.statusText ?? '';
                this.headers = new vmGlobalThis.Headers(init?.headers);
                this.type = 'default';
                this.url = '';
                this.redirected = false;
                // Validate that null-body status codes don't have a body
                // Per HTTP spec: 204 (No Content), 205 (Reset Content), and 304 (Not Modified)
                if (body !== null &&
                    body !== undefined &&
                    (this.status === 204 || this.status === 205 || this.status === 304)) {
                    throw new TypeError(`Response constructor: Invalid response status code ${this.status}`);
                }
                // Store the original BodyInit for serialization
                if (body !== null && body !== undefined) {
                    // Create a "fake" ReadableStream that stores the original body
                    // This avoids doing async work during workflow replay
                    this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
                        [BODY_INIT_SYMBOL]: {
                            value: body,
                            writable: false,
                        },
                    });
                }
                else {
                    this.body = null;
                }
            }
            // TODO: implement these
            clone;
            blob;
            formData;
            get ok() {
                return this.status >= 200 && this.status < 300;
            }
            get bodyUsed() {
                return false;
            }
            async arrayBuffer() {
                return resArrayBuffer(this);
            }
            async bytes() {
                return new Uint8Array(await resArrayBuffer(this));
            }
            async json() {
                return resJson(this);
            }
            static json(data, init) {
                const body = JSON.stringify(data);
                const headers = new vmGlobalThis.Headers(init?.headers);
                if (!headers.has('content-type')) {
                    headers.set('content-type', 'application/json');
                }
                return new Response(body, { ...init, headers });
            }
            async text() {
                return resText(this);
            }
            static error() {
                ENOTSUP();
            }
            static redirect(url, status = 302) {
                // Validate status code - only specific redirect codes are allowed
                if (![301, 302, 303, 307, 308].includes(status)) {
                    throw new RangeError(`Invalid redirect status code: ${status}. Must be one of: 301, 302, 303, 307, 308`);
                }
                // Create response with Location header
                const headers = new vmGlobalThis.Headers();
                headers.set('Location', String(url));
                const response = Object.create(Response.prototype);
                response.status = status;
                response.statusText = '';
                response.headers = headers;
                response.body = null;
                response.type = 'default';
                response.url = '';
                response.redirected = false;
                return response;
            }
        }
        vmGlobalThis.Response = Response;
        class ReadableStream {
            constructor() {
                ENOTSUP();
            }
            get locked() {
                return false;
            }
            cancel() {
                ENOTSUP();
            }
            getReader() {
                ENOTSUP();
            }
            pipeThrough() {
                ENOTSUP();
            }
            pipeTo() {
                ENOTSUP();
            }
            tee() {
                ENOTSUP();
            }
            values() {
                ENOTSUP();
            }
            static from() {
                ENOTSUP();
            }
            [Symbol.asyncIterator]() {
                ENOTSUP();
            }
        }
        vmGlobalThis.ReadableStream = ReadableStream;
        class WritableStream {
            constructor() {
                ENOTSUP();
            }
            get locked() {
                return false;
            }
            abort() {
                ENOTSUP();
            }
            close() {
                ENOTSUP();
            }
            getWriter() {
                ENOTSUP();
            }
        }
        vmGlobalThis.WritableStream = WritableStream;
        class TransformStream {
            readable;
            writable;
            constructor() {
                ENOTSUP();
            }
        }
        vmGlobalThis.TransformStream = TransformStream;
        // Eventually we'll probably want to provide our own `console` object,
        // but for now we'll just expose the global one.
        vmGlobalThis.console = globalThis.console;
        // HACK: propagate symbol needed for AI gateway usage
        const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[SYMBOL_FOR_REQ_CONTEXT] = globalThis[SYMBOL_FOR_REQ_CONTEXT];
        // Get a reference to the user-defined workflow function.
        // The filename parameter ensures stack traces show a meaningful name
        // (e.g., "example/workflows/99_e2e.ts") instead of "evalmachine.<anonymous>".
        const parsedName = parseWorkflowName(workflowRun.workflowName);
        const filename = parsedName?.path || workflowRun.workflowName;
        const workflowFn = runInContext(`${workflowCode}; globalThis.__private_workflows?.get(${JSON.stringify(workflowRun.workflowName)})`, context, { filename });
        if (typeof workflowFn !== 'function') {
            throw new ReferenceError(`Workflow ${JSON.stringify(workflowRun.workflowName)} must be a function, but got "${typeof workflowFn}" instead`);
        }
        const args = hydrateWorkflowArguments(workflowRun.input, vmGlobalThis);
        span?.setAttributes({
            ...WorkflowArgumentsCount(args.length),
        });
        // Invoke user workflow
        const result = await Promise.race([
            workflowFn(...args),
            workflowDiscontinuation.promise,
        ]);
        const dehydrated = dehydrateWorkflowReturnValue(result, vmGlobalThis);
        span?.setAttributes({
            ...WorkflowResultType(typeof result),
        });
        return dehydrated;
    });
}

/**
 * A handler class for a workflow run.
 */
class Run {
    /**
     * The ID of the workflow run.
     */
    runId;
    /**
     * The world object.
     * @internal
     */
    world;
    constructor(runId) {
        this.runId = runId;
        this.world = getWorld();
    }
    /**
     * Cancels the workflow run.
     */
    async cancel() {
        await this.world.runs.cancel(this.runId);
    }
    /**
     * The status of the workflow run.
     */
    get status() {
        return this.world.runs.get(this.runId).then((run) => run.status);
    }
    /**
     * The return value of the workflow run.
     * Polls the workflow return value until it is completed.
     */
    get returnValue() {
        return this.pollReturnValue();
    }
    /**
     * The name of the workflow.
     */
    get workflowName() {
        return this.world.runs.get(this.runId).then((run) => run.workflowName);
    }
    /**
     * The timestamp when the workflow run was created.
     */
    get createdAt() {
        return this.world.runs.get(this.runId).then((run) => run.createdAt);
    }
    /**
     * The timestamp when the workflow run started execution.
     * Returns undefined if the workflow has not started yet.
     */
    get startedAt() {
        return this.world.runs.get(this.runId).then((run) => run.startedAt);
    }
    /**
     * The timestamp when the workflow run completed.
     * Returns undefined if the workflow has not completed yet.
     */
    get completedAt() {
        return this.world.runs.get(this.runId).then((run) => run.completedAt);
    }
    /**
     * The readable stream of the workflow run.
     */
    get readable() {
        return this.getReadable();
    }
    /**
     * Retrieves the workflow run's default readable stream, which reads chunks
     * written to the corresponding writable stream {@link getWritable}.
     *
     * @param options - The options for the readable stream.
     * @returns The `ReadableStream` for the workflow run.
     */
    getReadable(options = {}) {
        const { ops = [], global = globalThis, startIndex, namespace } = options;
        const name = getWorkflowRunStreamId(this.runId, namespace);
        return getExternalRevivers(global, ops).ReadableStream({
            name,
            startIndex,
        });
    }
    /**
     * Polls the workflow return value every 1 second until it is completed.
     * @internal
     * @returns The workflow return value.
     */
    async pollReturnValue() {
        while (true) {
            try {
                const run = await this.world.runs.get(this.runId);
                if (run.status === 'completed') {
                    return hydrateWorkflowReturnValue(run.output, [], globalThis);
                }
                if (run.status === 'cancelled') {
                    throw new WorkflowRunCancelledError(this.runId);
                }
                if (run.status === 'failed') {
                    throw new WorkflowRunFailedError(this.runId, run.error);
                }
                throw new WorkflowRunNotCompletedError(this.runId, run.status);
            }
            catch (error) {
                if (WorkflowRunNotCompletedError.is(error)) {
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                    continue;
                }
                throw error;
            }
        }
    }
}
/**
 * Retrieves a `Run` object for a given run ID.
 *
 * @param runId - The workflow run ID obtained from {@link start}.
 * @returns A `Run` object.
 * @throws WorkflowRunNotFoundError if the run ID is not found.
 */
function getRun(runId) {
    return new Run(runId);
}
/**
 * Loads all workflow run events by iterating through all pages of paginated results.
 * This ensures that *all* events are loaded into memory before running the workflow.
 * Events must be in chronological order (ascending) for proper workflow replay.
 */
async function getAllWorkflowRunEvents(runId) {
    const allEvents = [];
    let cursor = null;
    let hasMore = true;
    const world = getWorld();
    while (hasMore) {
        const response = await world.events.list({
            runId,
            pagination: {
                sortOrder: 'asc', // Required: events must be in chronological order for replay
                cursor: cursor ?? undefined,
            },
        });
        allEvents.push(...response.data);
        hasMore = response.hasMore;
        cursor = response.cursor;
    }
    return allEvents;
}
/**
 * Function that creates a single route which handles any workflow execution
 * request and routes to the appropriate workflow function.
 *
 * @param workflowCode - The workflow bundle code containing all the workflow
 * functions at the top level.
 * @returns A function that can be used as a Vercel API route.
 */
function workflowEntrypoint(workflowCode) {
    return getWorldHandlers().createQueueHandler('__wkf_workflow_', async (message_, metadata) => {
        const { runId, traceCarrier: traceContext } = WorkflowInvokePayloadSchema.parse(message_);
        // Extract the workflow name from the topic name
        const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);
        // Invoke user workflow within the propagated trace context
        return await withTraceContext(traceContext, async () => {
            const world = getWorld();
            return trace(`WORKFLOW ${workflowName}`, async (span) => {
                span?.setAttributes({
                    ...WorkflowName(workflowName),
                    ...WorkflowOperation('execute'),
                    ...QueueName(metadata.queueName),
                });
                // TODO: validate `workflowName` exists before consuming message?
                span?.setAttributes({
                    ...WorkflowRunId(runId),
                    ...WorkflowTracePropagated(!!traceContext),
                });
                let workflowStartedAt = -1;
                try {
                    let workflowRun = await world.runs.get(runId);
                    if (workflowRun.status === 'pending') {
                        workflowRun = await world.runs.update(runId, {
                            // This sets the `startedAt` timestamp at the database level
                            status: 'running',
                        });
                    }
                    // At this point, the workflow is "running" and `startedAt` should
                    // definitely be set.
                    if (!workflowRun.startedAt) {
                        throw new Error(`Workflow run "${runId}" has no "startedAt" timestamp`);
                    }
                    workflowStartedAt = +workflowRun.startedAt;
                    span?.setAttributes({
                        ...WorkflowRunStatus(workflowRun.status),
                        ...WorkflowStartedAt(workflowStartedAt),
                    });
                    if (workflowRun.status !== 'running') {
                        // Workflow has already completed or failed, so we can skip it
                        console.warn(`Workflow "${runId}" has status "${workflowRun.status}", skipping`);
                        // TODO: for `cancel`, we actually want to propagate a WorkflowCancelled event
                        // inside the workflow context so the user can gracefully exit. this is SIGTERM
                        // TODO: furthermore, there should be a timeout or a way to force cancel SIGKILL
                        // so that we actually exit here without replaying the workflow at all, in the case
                        // the replaying the workflow is itself failing.
                        return;
                    }
                    // Load all events into memory before running
                    const events = await getAllWorkflowRunEvents(workflowRun.runId);
                    // Check for any elapsed waits and create wait_completed events
                    const now = Date.now();
                    for (const event of events) {
                        if (event.eventType === 'wait_created') {
                            const resumeAt = event.eventData.resumeAt;
                            const hasCompleted = events.some((e) => e.eventType === 'wait_completed' &&
                                e.correlationId === event.correlationId);
                            // If wait has elapsed and hasn't been completed yet
                            if (!hasCompleted && now >= resumeAt.getTime()) {
                                const completedEvent = await world.events.create(runId, {
                                    eventType: 'wait_completed',
                                    correlationId: event.correlationId,
                                });
                                // Add the event to the events array so the workflow can see it
                                events.push(completedEvent);
                            }
                        }
                    }
                    const result = await runWorkflow(workflowCode, workflowRun, events);
                    // Update the workflow run with the result
                    await world.runs.update(runId, {
                        status: 'completed',
                        output: result,
                    });
                    span?.setAttributes({
                        ...WorkflowRunStatus('completed'),
                        ...WorkflowEventsCount(events.length),
                    });
                }
                catch (err) {
                    if (WorkflowSuspension.is(err)) {
                        buildWorkflowSuspensionMessage(runId, err.stepCount, err.hookCount, err.waitCount);
                        // Process each operation in the queue (steps and hooks)
                        let minTimeoutSeconds = null;
                        for (const queueItem of err.steps) {
                            if (queueItem.type === 'step') {
                                // Handle step operations
                                const ops = [];
                                const dehydratedArgs = dehydrateStepArguments(queueItem.args, err.globalThis);
                                try {
                                    const step = await world.steps.create(runId, {
                                        stepId: queueItem.correlationId,
                                        stepName: queueItem.stepName,
                                        input: dehydratedArgs,
                                    });
                                    functionsExports.waitUntil(Promise.all(ops));
                                    await world.queue(`__wkf_step_${queueItem.stepName}`, {
                                        workflowName,
                                        workflowRunId: runId,
                                        workflowStartedAt,
                                        stepId: step.stepId,
                                        traceCarrier: await serializeTraceCarrier(),
                                    }, {
                                        idempotencyKey: queueItem.correlationId,
                                    });
                                }
                                catch (err) {
                                    if (WorkflowAPIError.is(err) && err.status === 409) {
                                        // Step already exists, so we can skip it
                                        console.warn(`Step "${queueItem.stepName}" with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`);
                                        continue;
                                    }
                                    throw err;
                                }
                            }
                            else if (queueItem.type === 'hook') {
                                // Handle hook operations
                                try {
                                    // Create hook in database
                                    const hookMetadata = typeof queueItem.metadata === 'undefined'
                                        ? undefined
                                        : dehydrateStepArguments(queueItem.metadata, err.globalThis);
                                    await world.hooks.create(runId, {
                                        hookId: queueItem.correlationId,
                                        token: queueItem.token,
                                        metadata: hookMetadata,
                                    });
                                    // Create hook_created event in event log
                                    await world.events.create(runId, {
                                        eventType: 'hook_created',
                                        correlationId: queueItem.correlationId,
                                    });
                                }
                                catch (err) {
                                    if (WorkflowAPIError.is(err)) {
                                        if (err.status === 409) {
                                            // Hook already exists (duplicate hook_id constraint), so we can skip it
                                            console.warn(`Hook with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`);
                                            continue;
                                        }
                                        else if (err.status === 410) {
                                            // Workflow has already completed, so no-op
                                            console.warn(`Workflow run "${runId}" has already completed, skipping hook "${queueItem.correlationId}": ${err.message}`);
                                            continue;
                                        }
                                    }
                                    throw err;
                                }
                            }
                            else if (queueItem.type === 'wait') {
                                // Handle wait operations
                                try {
                                    // Only create wait_created event if it hasn't been created yet
                                    if (!queueItem.hasCreatedEvent) {
                                        await world.events.create(runId, {
                                            eventType: 'wait_created',
                                            correlationId: queueItem.correlationId,
                                            eventData: {
                                                resumeAt: queueItem.resumeAt,
                                            },
                                        });
                                    }
                                    // Calculate how long to wait before resuming
                                    const now = Date.now();
                                    const resumeAtMs = queueItem.resumeAt.getTime();
                                    const delayMs = Math.max(1000, resumeAtMs - now);
                                    const timeoutSeconds = Math.ceil(delayMs / 1000);
                                    // Track the minimum timeout across all waits
                                    if (minTimeoutSeconds === null ||
                                        timeoutSeconds < minTimeoutSeconds) {
                                        minTimeoutSeconds = timeoutSeconds;
                                    }
                                }
                                catch (err) {
                                    if (WorkflowAPIError.is(err) && err.status === 409) {
                                        // Wait already exists, so we can skip it
                                        console.warn(`Wait with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`);
                                        continue;
                                    }
                                    throw err;
                                }
                            }
                        }
                        span?.setAttributes({
                            ...WorkflowRunStatus('pending_steps'),
                            ...WorkflowStepsCreated(err.steps.length),
                        });
                        // If we encountered any waits, return the minimum timeout
                        if (minTimeoutSeconds !== null) {
                            return { timeoutSeconds: minTimeoutSeconds };
                        }
                    }
                    else {
                        const errorName = getErrorName(err);
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        let errorStack = getErrorStack(err);
                        // Remap error stack using source maps to show original source locations
                        if (errorStack) {
                            const parsedName = parseWorkflowName(workflowName);
                            const filename = parsedName?.path || workflowName;
                            errorStack = remapErrorStack(errorStack, filename, workflowCode);
                        }
                        console.error(`${errorName} while running "${runId}" workflow:\n\n${errorStack}`);
                        await world.runs.update(runId, {
                            status: 'failed',
                            error: {
                                message: errorMessage,
                                stack: errorStack,
                                // TODO: include error codes when we define them
                            },
                        });
                        span?.setAttributes({
                            ...WorkflowRunStatus('failed'),
                            ...WorkflowErrorName(errorName),
                            ...WorkflowErrorMessage(String(err)),
                        });
                    }
                }
            }); // End withTraceContext
        });
    });
}
/**
 * A single route that handles any step execution request and routes to the
 * appropriate step function. We may eventually want to create different bundles
 * for each step, this is temporary.
 */
const stepEntrypoint = 
/* @__PURE__ */ getWorldHandlers().createQueueHandler('__wkf_step_', async (message_, metadata) => {
    const { workflowName, workflowRunId, workflowStartedAt, stepId, traceCarrier: traceContext, } = StepInvokePayloadSchema.parse(message_);
    // Execute step within the propagated trace context
    return await withTraceContext(traceContext, async () => {
        // Extract the step name from the topic name
        const stepName = metadata.queueName.slice('__wkf_step_'.length);
        const world = getWorld();
        // Get the port early to avoid async operations during step execution
        const port = await getPort();
        return trace(`STEP ${stepName}`, async (span) => {
            span?.setAttributes({
                ...StepName(stepName),
                ...StepAttempt(metadata.attempt),
                ...QueueName(metadata.queueName),
            });
            const stepFn = getStepFunction(stepName);
            if (!stepFn) {
                throw new Error(`Step "${stepName}" not found`);
            }
            if (typeof stepFn !== 'function') {
                throw new Error(`Step "${stepName}" is not a function (got ${typeof stepFn})`);
            }
            span?.setAttributes({
                ...WorkflowName(workflowName),
                ...WorkflowRunId(workflowRunId),
                ...StepId(stepId),
                ...StepMaxRetries(stepFn.maxRetries ?? 3),
                ...StepTracePropagated(!!traceContext),
            });
            let step = await world.steps.get(workflowRunId, stepId);
            runtimeLogger.debug('Step execution details', {
                stepName,
                stepId: step.stepId,
                status: step.status,
                attempt: step.attempt,
            });
            span?.setAttributes({
                ...StepStatus(step.status),
            });
            // Check if the step has a `retryAfter` timestamp that hasn't been reached yet
            const now = Date.now();
            if (step.retryAfter && step.retryAfter.getTime() > now) {
                const timeoutSeconds = Math.ceil((step.retryAfter.getTime() - now) / 1000);
                span?.setAttributes({
                    ...StepRetryTimeoutSeconds(timeoutSeconds),
                });
                runtimeLogger.debug('Step retryAfter timestamp not yet reached', {
                    stepName,
                    stepId: step.stepId,
                    retryAfter: step.retryAfter,
                    timeoutSeconds,
                });
                return { timeoutSeconds };
            }
            let result;
            const attempt = step.attempt + 1;
            try {
                if (step.status !== 'pending') {
                    // We should only be running the step if it's pending
                    // (initial state, or state set on re-try), so the step has been
                    // invoked erroneously.
                    console.error(`[Workflows] "${workflowRunId}" - Step invoked erroneously, expected status "pending", got "${step.status}" instead, skipping execution`);
                    span?.setAttributes({
                        ...StepSkipped(true),
                        ...StepSkipReason(step.status),
                    });
                    return;
                }
                await world.events.create(workflowRunId, {
                    eventType: 'step_started', // TODO: Replace with 'step_retrying'
                    correlationId: stepId,
                });
                step = await world.steps.update(workflowRunId, stepId, {
                    attempt,
                    status: 'running',
                });
                if (!step.startedAt) {
                    throw new WorkflowRuntimeError(`Step "${stepId}" has no "startedAt" timestamp`);
                }
                // Hydrate the step input arguments
                const ops = [];
                const args = hydrateStepArguments(step.input, ops);
                span?.setAttributes({
                    ...StepArgumentsCount(args.length),
                });
                result = await contextStorage.run({
                    stepMetadata: {
                        stepId,
                        stepStartedAt: new Date(+step.startedAt),
                        attempt,
                    },
                    workflowMetadata: {
                        workflowRunId,
                        workflowStartedAt: new Date(+workflowStartedAt),
                        // TODO: there should be a getUrl method on the world interface itself. This
                        // solution only works for vercel + local worlds.
                        url: process.env.VERCEL_URL
                            ? `https://${process.env.VERCEL_URL}`
                            : `http://localhost:${port ?? 3000}`,
                    },
                    ops,
                }, () => stepFn(...args));
                result = dehydrateStepReturnValue(result, ops);
                functionsExports.waitUntil(Promise.all(ops));
                // Update the event log with the step result
                await world.events.create(workflowRunId, {
                    eventType: 'step_completed',
                    correlationId: stepId,
                    eventData: {
                        result: result,
                    },
                });
                await world.steps.update(workflowRunId, stepId, {
                    status: 'completed',
                    output: result,
                });
                span?.setAttributes({
                    ...StepStatus('completed'),
                    ...StepResultType(typeof result),
                });
            }
            catch (err) {
                span?.setAttributes({
                    ...StepErrorName(getErrorName(err)),
                    ...StepErrorMessage(String(err)),
                });
                if (WorkflowAPIError.is(err)) {
                    if (err.status === 410) {
                        // Workflow has already completed, so no-op
                        console.warn(`Workflow run "${workflowRunId}" has already completed, skipping step "${stepId}": ${err.message}`);
                        return;
                    }
                }
                if (FatalError.is(err)) {
                    const errorStack = getErrorStack(err);
                    const stackLines = errorStack.split('\n').slice(0, 4);
                    console.error(`[Workflows] "${workflowRunId}" - Encountered \`FatalError\` while executing step "${stepName}":\n  > ${stackLines.join('\n    > ')}\n\nBubbling up error to parent workflow`);
                    // Fatal error - store the error in the event log and re-invoke the workflow
                    await world.events.create(workflowRunId, {
                        eventType: 'step_failed',
                        correlationId: stepId,
                        eventData: {
                            error: String(err),
                            stack: errorStack,
                            fatal: true,
                        },
                    });
                    await world.steps.update(workflowRunId, stepId, {
                        status: 'failed',
                        error: {
                            message: err.message || String(err),
                            stack: errorStack,
                            // TODO: include error codes when we define them
                        },
                    });
                    span?.setAttributes({
                        ...StepStatus('failed'),
                        ...StepFatalError(true),
                    });
                }
                else {
                    const maxRetries = stepFn.maxRetries ?? 3;
                    span?.setAttributes({
                        ...StepAttempt(attempt),
                        ...StepMaxRetries(maxRetries),
                    });
                    if (attempt >= maxRetries) {
                        // Max retries reached
                        const errorStack = getErrorStack(err);
                        const stackLines = errorStack.split('\n').slice(0, 4);
                        console.error(`[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${stackLines.join('\n    > ')}\n\n  Max retries reached\n  Bubbling error to parent workflow`);
                        const errorMessage = `Step "${stepName}" failed after max retries: ${String(err)}`;
                        await world.events.create(workflowRunId, {
                            eventType: 'step_failed',
                            correlationId: stepId,
                            eventData: {
                                error: errorMessage,
                                stack: errorStack,
                                fatal: true,
                            },
                        });
                        await world.steps.update(workflowRunId, stepId, {
                            status: 'failed',
                            error: {
                                message: errorMessage,
                                stack: errorStack,
                            },
                        });
                        span?.setAttributes({
                            ...StepStatus('failed'),
                            ...StepRetryExhausted(true),
                        });
                    }
                    else {
                        // Not at max retries yet - log as a retryable error
                        if (RetryableError.is(err)) {
                            console.warn(`[Workflows] "${workflowRunId}" - Encountered \`RetryableError\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${String(err.message)}\n\n  This step has failed but will be retried`);
                        }
                        else {
                            const stackLines = getErrorStack(err).split('\n').slice(0, 4);
                            console.error(`[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${stackLines.join('\n    > ')}\n\n  This step has failed but will be retried`);
                        }
                        await world.events.create(workflowRunId, {
                            eventType: 'step_failed',
                            correlationId: stepId,
                            eventData: {
                                error: String(err),
                                stack: getErrorStack(err),
                            },
                        });
                        await world.steps.update(workflowRunId, stepId, {
                            status: 'pending', // TODO: Should be "retrying" once we have that status
                            ...(RetryableError.is(err) && {
                                retryAfter: err.retryAfter,
                            }),
                        });
                        const timeoutSeconds = Math.max(1, RetryableError.is(err)
                            ? Math.ceil((+err.retryAfter.getTime() - Date.now()) / 1000)
                            : 1);
                        span?.setAttributes({
                            ...StepRetryTimeoutSeconds(timeoutSeconds),
                            ...StepRetryWillRetry(true),
                        });
                        // It's a retryable error - so have the queue keep the message visible
                        // so that it gets retried.
                        return { timeoutSeconds };
                    }
                }
            }
            await world.queue(`__wkf_workflow_${workflowName}`, {
                runId: workflowRunId,
                traceCarrier: await serializeTraceCarrier(),
            });
        });
    });
});

export { Run as R, contextStorage as c, getRun as g, stepEntrypoint as s, workflowEntrypoint as w };
