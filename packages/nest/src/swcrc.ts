/**
 * `.swcrc` generation.
 *
 * NestJS's SWC builder reads its configuration from `.swcrc`, and the workflow
 * transform is an SWC plugin that has to be referenced by absolute path. The
 * file is therefore generated rather than committed, and regenerated on every
 * build, which means generation must not discard whatever else the application
 * put in there.
 */

export type ModuleType = 'es6' | 'commonjs';

type SwcrcObject = Record<string, unknown>;

/**
 * Path fragments that identify the workflow plugin entry as ours, so it can be
 * replaced in place rather than appended to. The wasm filename covers both the
 * published package (`@workflow/swc-plugin`) and the workspace checkout
 * (`swc-plugin-workflow`); the package specifiers cover a hand-written entry.
 */
const WORKFLOW_PLUGIN_MARKERS = [
  'swc_plugin_workflow',
  '@workflow/swc-plugin',
  'swc-plugin-workflow',
];

function isRecord(value: unknown): value is SwcrcObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowPluginEntry(entry: unknown): boolean {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return false;
  const path = entry[0].replace(/\\/g, '/');
  return WORKFLOW_PLUGIN_MARKERS.some((marker) => path.includes(marker));
}

/**
 * Whether a `.swcrc` already references the workflow SWC plugin.
 */
export function hasWorkflowPlugin(swcrcContent: string): boolean {
  try {
    const parsed = JSON.parse(swcrcContent);
    const plugins = (parsed as SwcrcObject | null)?.jsc;
    if (!isRecord(plugins)) return false;
    const experimental = plugins.experimental;
    if (!isRecord(experimental)) return false;
    return (
      Array.isArray(experimental.plugins) &&
      experimental.plugins.some(
        (entry) =>
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          entry[0].includes('workflow')
      )
    );
  } catch {
    return false;
  }
}

/**
 * Merge the settings the workflow transform requires into an existing `.swcrc`.
 *
 * Only the keys the transform needs are touched:
 *  - the workflow plugin entry under `jsc.experimental.plugins` (replaced in
 *    place, since its absolute path changes between machines and installs)
 *  - decorator parsing and metadata emission, which NestJS DI depends on
 *  - `module.type`, which has to match how the app is compiled
 *
 * Everything else the application configured is preserved. Passing `undefined`
 * for `existingContent` produces a fresh config.
 */
export function mergeSwcrc(
  existingContent: string | undefined,
  pluginPath: string,
  moduleType: ModuleType
): { config: SwcrcObject; merged: boolean } {
  let existing: SwcrcObject = {};
  let merged = false;
  if (existingContent?.trim()) {
    try {
      const parsed = JSON.parse(existingContent);
      if (isRecord(parsed)) {
        existing = parsed;
        merged = true;
      }
    } catch {
      // An unparseable .swcrc cannot be merged into. Fall through to a fresh
      // config; the caller reports that the previous contents were replaced.
      merged = false;
    }
  }

  const jsc = isRecord(existing.jsc) ? { ...existing.jsc } : {};
  const parser = isRecord(jsc.parser) ? { ...jsc.parser } : {};
  const transform = isRecord(jsc.transform) ? { ...jsc.transform } : {};
  const experimental = isRecord(jsc.experimental)
    ? { ...jsc.experimental }
    : {};
  const moduleConfig = isRecord(existing.module) ? { ...existing.module } : {};

  const existingPlugins = Array.isArray(experimental.plugins)
    ? experimental.plugins
    : [];
  const otherPlugins = existingPlugins.filter(
    (entry) => !isWorkflowPluginEntry(entry)
  );

  return {
    merged,
    config: {
      $schema: 'https://swc.rs/schema.json',
      ...existing,
      jsc: {
        ...jsc,
        parser: {
          syntax: 'typescript',
          ...parser,
          // NestJS DI reads `design:paramtypes`, which only exists when both of
          // these are on. An app cannot opt out and still have working DI.
          decorators: true,
        },
        transform: {
          ...transform,
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        experimental: {
          ...experimental,
          plugins: [...otherPlugins, [pluginPath, { mode: 'step' }]],
        },
      },
      module: {
        ...moduleConfig,
        type: moduleType,
      },
      sourceMaps: existing.sourceMaps ?? true,
    },
  };
}

/**
 * Serialize a merged config for writing to disk.
 */
export function serializeSwcrc(config: SwcrcObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
