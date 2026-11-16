import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CloudflareContext } from './transform.js';

/** Binding tables of a wrangler config, and what each one is. */
const BINDING_TABLES: Record<string, { kind: string; key: string }> = {
  kv_namespaces: { kind: 'KV namespace', key: 'binding' },
  d1_databases: { kind: 'D1 database', key: 'binding' },
  r2_buckets: { kind: 'R2 bucket', key: 'binding' },
  'queues.producers': { kind: 'Queue', key: 'binding' },
  'durable_objects.bindings': { kind: 'Durable Object namespace', key: 'name' },
  services: { kind: 'service', key: 'binding' },
  vectorize: { kind: 'Vectorize index', key: 'binding' },
  hyperdrive: { kind: 'Hyperdrive', key: 'binding' },
  analytics_engine_datasets: {
    kind: 'Analytics Engine dataset',
    key: 'binding',
  },
  workflows: { kind: 'Workflow', key: 'binding' },
};
const SINGLE_BINDINGS: Record<string, string> = {
  ai: 'Workers AI',
  browser: 'Browser Rendering',
  images: 'Images',
};

type Table = Record<string, unknown>;

/**
 * Read the wrangler config in `dir` (wrangler.jsonc, wrangler.json or
 * wrangler.toml), for the workflow bindings, the vars and the other
 * bindings `this.env` can hold. Returns empty facts when there is none.
 */
export function readWranglerConfig(dir: string): CloudflareContext {
  const context: CloudflareContext = {
    vars: new Set(),
    bindings: new Map(),
    workflows: [],
  };
  let config: Table | undefined;
  for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    try {
      config = name.endsWith('.toml')
        ? parseToml(text)
        : (JSON.parse(stripJsonComments(text)) as Table);
      context.configFile = relative(dir, file);
    } catch {
      config = undefined;
    }
    break;
  }
  if (!config) return context;

  const vars = config.vars;
  if (vars && typeof vars === 'object') {
    for (const key of Object.keys(vars)) context.vars.add(key);
  }
  for (const [path, { kind, key }] of Object.entries(BINDING_TABLES)) {
    const value = path
      .split('.')
      .reduce<unknown>(
        (v, k) => (v && typeof v === 'object' ? (v as Table)[k] : undefined),
        config
      );
    if (!Array.isArray(value)) continue;
    for (const entry of value as Table[]) {
      const binding = entry?.[key];
      if (typeof binding !== 'string') continue;
      context.bindings.set(binding, kind);
      if (path === 'workflows') {
        context.workflows.push({
          binding,
          className: String(entry.class_name ?? ''),
          name: typeof entry.name === 'string' ? entry.name : undefined,
        });
      }
    }
  }
  for (const [key, kind] of Object.entries(SINGLE_BINDINGS)) {
    const entry = config[key] as Table | undefined;
    if (entry && typeof entry.binding === 'string')
      context.bindings.set(entry.binding, kind);
  }
  return context;
}

/** Remove // and /* *\/ comments and trailing commas from JSONC. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * The subset of TOML wrangler configs use: tables, arrays of tables, and
 * string, number, boolean, array and inline-table values on one line.
 */
export function parseToml(text: string): Table {
  const root: Table = {};
  let current: Table = root;
  const at = (path: string[], array: boolean): Table => {
    let node: Table = root;
    path.forEach((key, index) => {
      const last = index === path.length - 1;
      if (last && array) {
        const list = (node[key] as Table[] | undefined) ?? [];
        node[key] = list;
        const entry: Table = {};
        list.push(entry);
        node = entry;
        return;
      }
      let next = node[key];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!next || typeof next !== 'object') {
        next = {};
        node[key] = next;
      }
      node = next as Table;
    });
    return node;
  };
  for (const raw of text.split('\n')) {
    const lineText = stripTomlComment(raw).trim();
    if (!lineText) continue;
    const arrayTable = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(lineText);
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(lineText);
    if (arrayTable) {
      current = at(splitKey(arrayTable[1]), true);
      continue;
    }
    if (table) {
      current = at(splitKey(table[1]), false);
      continue;
    }
    const eq = lineText.indexOf('=');
    if (eq === -1) continue;
    const keys = splitKey(lineText.slice(0, eq).trim());
    let target = current;
    for (const key of keys.slice(0, -1)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      target = target[key] as Table;
    }
    target[keys[keys.length - 1]] = parseTomlValue(
      lineText.slice(eq + 1).trim()
    );
  }
  return root;
}

function splitKey(key: string): string[] {
  return key.split('.').map((k) => k.trim().replace(/^"(.*)"$/, '$1'));
}

function stripTomlComment(line: string): string {
  let inString: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = undefined;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(value: string): unknown {
  if (/^".*"$/.test(value)) return JSON.parse(value);
  if (/^'.*'$/.test(value)) return value.slice(1, -1);
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('{') && value.endsWith('}')) {
    const out: Table = {};
    for (const part of splitTopLevel(value.slice(1, -1))) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      out[splitKey(part.slice(0, eq).trim()).join('.')] = parseTomlValue(
        part.slice(eq + 1).trim()
      );
    }
    return out;
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTopLevel(value.slice(1, -1))
      .map((v) => v.trim())
      .filter(Boolean)
      .map(parseTomlValue);
  }
  return value;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = undefined;
      continue;
    }
    if (c === '"' || c === "'") inString = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
