import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(PACKAGE_ROOT, 'src');
const STYLES_PATH = resolve(PACKAGE_ROOT, 'src/styles.css');

const SYSTEM_TOKEN_PATTERN =
  /\btext-(?:heading|button|label|copy)-[a-z0-9-]+\b/g;
const SYSTEM_TOKEN_DEFINITION_PATTERN =
  /@utility\s+(text-(?:heading|button|label|copy)-[a-z0-9-]+)\s*\{/g;
const RAW_TAILWIND_SIZE_PATTERN = /\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/g;
const ARBITRARY_TEXT_PATTERN = /\btext-\[([^\]\s]+)\]/g;
const CSS_LENGTH_PATTERN =
  /^-?(?:(?:\d+(?:\.\d+)?)|(?:\.\d+))(?:px|rem|em|%|pt|pc|in|cm|mm|q|ch|ex|cap|lh|rlh|vw|vh|vi|vb|vmin|vmax)$/i;
const CSS_FONT_SIZE_KEYWORD_PATTERN =
  /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i;

/**
 * The typography scale currently stops at 12px. Keep the audited 10px/11px
 * debt fixed until matching design-system tokens are defined.
 */
const EXPECTED_LEGACY_SIZE_COUNTS = {
  'components/event-list-view.tsx': {
    'text-[11px]': 1,
  },
  'components/new-trace-viewer/components/timeline.tsx': {
    'text-[10px]': 2,
    'text-[11px]': 1,
  },
  'components/sidebar/attribute-panel.tsx': {
    'text-[11px]': 3,
  },
  'components/sidebar/conversation-view.tsx': {
    'text-[10px]': 5,
    'text-[11px]': 3,
  },
  'components/ui/data-inspector.tsx': {
    'text-[10px]': 4,
  },
  'components/ui/kbd.tsx': {
    'text-[11px]': 1,
  },
} as const;

type TypographyViolation = {
  file: string;
  line: number;
  utility: string;
  reason: string;
};

type LegacySizeCounts = Record<string, Record<string, number>>;

type TypographyAudit = {
  legacySizeCounts: LegacySizeCounts;
  violations: TypographyViolation[];
};

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          return listSourceFiles(path);
        }
        return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
      })
  );
  return nestedFiles.flat();
}

function relativeSourcePath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join('/');
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function isArbitraryFontSize(value: string): boolean {
  const normalized = value.replaceAll('_', '');
  return (
    normalized === '0' ||
    normalized.startsWith('length:') ||
    /^(?:calc|min|max|clamp)\(/i.test(normalized) ||
    CSS_LENGTH_PATTERN.test(normalized) ||
    CSS_FONT_SIZE_KEYWORD_PATTERN.test(normalized)
  );
}

function legacyUtility(value: string): 'text-[10px]' | 'text-[11px]' | null {
  const match = value.match(/^(\d+(?:\.\d+)?)px$/i);
  if (!match) return null;

  const pixels = Number(match[1]);
  if (pixels === 10 || pixels === 11) {
    return `text-[${pixels}px]`;
  }
  return null;
}

function incrementLegacyCount(
  counts: LegacySizeCounts,
  file: string,
  utility: string
): void {
  counts[file] ??= {};
  counts[file][utility] = (counts[file][utility] ?? 0) + 1;
}

async function auditTypography(): Promise<TypographyAudit> {
  const styles = await readFile(STYLES_PATH, 'utf8');
  const definedSystemTokens = new Set(
    Array.from(
      styles.matchAll(SYSTEM_TOKEN_DEFINITION_PATTERN),
      (match) => match[1]
    )
  );
  const files = await listSourceFiles(SOURCE_ROOT);
  const legacySizeCounts: LegacySizeCounts = {};
  const violations: TypographyViolation[] = [];

  for (const path of files) {
    const file = relativeSourcePath(path);
    const source = await readFile(path, 'utf8');

    for (const match of source.matchAll(RAW_TAILWIND_SIZE_PATTERN)) {
      violations.push({
        file,
        line: lineNumberAt(source, match.index),
        utility: match[0],
        reason: 'use a defined typography token',
      });
    }

    for (const match of source.matchAll(ARBITRARY_TEXT_PATTERN)) {
      const value = match[1];
      if (!isArbitraryFontSize(value)) continue;

      const legacy = legacyUtility(value);
      if (legacy) {
        incrementLegacyCount(legacySizeCounts, file, legacy);
        continue;
      }

      violations.push({
        file,
        line: lineNumberAt(source, match.index),
        utility: match[0],
        reason: 'use a defined typography token',
      });
    }

    for (const match of source.matchAll(SYSTEM_TOKEN_PATTERN)) {
      if (definedSystemTokens.has(match[0])) continue;
      violations.push({
        file,
        line: lineNumberAt(source, match.index),
        utility: match[0],
        reason: 'typography token is not defined in src/styles.css',
      });
    }
  }

  return { legacySizeCounts, violations };
}

describe('typography tokens', () => {
  it('rejects raw Tailwind sizes and undefined system tokens', async () => {
    const { violations } = await auditTypography();
    expect(violations).toEqual([]);
  });

  it('does not allow the audited 10px/11px debt to grow', async () => {
    const { legacySizeCounts } = await auditTypography();
    expect(legacySizeCounts).toEqual(EXPECTED_LEGACY_SIZE_COUNTS);
  });
});
