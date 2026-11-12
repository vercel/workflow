import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard for the observability UI rule "never use opacity to set colour"
 * (see packages/web-shared/AGENTS.md).
 *
 * Text, icon, border and surface colours must come from a Geist token
 * (`gray-100`…`gray-1000`, `gray-alpha-*`, `background-100/200`, the named
 * colour scales). Fading an element with `opacity-*`, an alpha modifier such
 * as `text-foreground/70`, an inline `opacity`, or an `rgba()` literal looks
 * right on one surface and breaks on the next: on the inverted tooltip pill,
 * on a dark theme, or over a coloured row.
 *
 * Still allowed without comment:
 *   - `opacity-0` / `opacity-100` (show/hide and fade transitions);
 *   - `opacity` inside `@keyframes` (fade and pulse animations);
 *   - colour literals in the theme files, where tokens such as the shadow
 *     scale are defined.
 *
 * Anything else needs an `opacity-allowed: <reason>` comment on the same line
 * or the line above, so every exception is visible in review.
 */

export const ESCAPE_MARKER = 'opacity-allowed:';

const SOURCE_EXTENSIONS = /\.(tsx?|css)$/;
const IGNORED = /(\.test\.|\.d\.ts$|\/node_modules\/|\/dist\/|\/build\/)/;

const RULES: Array<{ name: string; pattern: RegExp; css?: boolean }> = [
  {
    name: 'Tailwind opacity utility used to dim a colour',
    pattern: /(?<![\w-])(?:[\w:[\]&=.-]*:)?opacity-(?!(?:0|100)\b)(?:\d+|\[)/,
  },
  {
    name: 'Tailwind colour alpha modifier',
    pattern:
      /(?<![\w-])(?:[\w:[\]&=.-]*:)?(?:text|bg|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|from|via|to|outline|shadow|divide|placeholder|decoration|accent|caret)-[a-z][\w-]*\/(?:\d{1,3}|\[[^\]]+\])(?![\w/])/,
  },
  {
    name: 'inline or CSS opacity',
    pattern: /(?<![\w-])opacity\s*:/,
  },
  {
    name: 'SVG fill/stroke opacity',
    pattern: /\b(?:fillOpacity|strokeOpacity|fill-opacity|stroke-opacity)\b/,
  },
  {
    name: 'colour literal with alpha',
    pattern:
      /\b(?:rgba|hsla)\(|\b(?:rgb|hsl|oklch|oklab|lab|lch)\([^)]*\/|#[0-9a-fA-F]{8}\b|\bcolor-mix\(/,
  },
];

export interface OpacityColourViolation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (IGNORED.test(full)) continue;
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (SOURCE_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Scan `dir` and return every use of opacity as a colour.
 * `themeFiles` are paths (relative to `dir`) where token definitions live;
 * colour literals are allowed there, opacity utilities are not.
 */
export function findOpacityColourViolations(
  dir: string,
  themeFiles: string[] = []
): OpacityColourViolation[] {
  const violations: OpacityColourViolation[] = [];
  for (const file of listSourceFiles(dir)) {
    const rel = relative(dir, file);
    const isTheme = themeFiles.includes(rel);
    const lines = readFileSync(file, 'utf8').split('\n');
    // Brace depth at which the current CSS @keyframes block opened, or -1.
    let keyframesAt = -1;
    let braceDepth = 0;
    lines.forEach((text, index) => {
      let inKeyframes = /@keyframes\b/.test(text);
      if (file.endsWith('.css')) {
        if (inKeyframes && keyframesAt < 0) keyframesAt = braceDepth;
        inKeyframes = inKeyframes || keyframesAt >= 0;
        braceDepth += (text.match(/{/g) ?? []).length;
        braceDepth -= (text.match(/}/g) ?? []).length;
        if (keyframesAt >= 0 && braceDepth <= keyframesAt) keyframesAt = -1;
      }

      const escaped =
        text.includes(ESCAPE_MARKER) ||
        (lines[index - 1] ?? '').includes(ESCAPE_MARKER);
      if (escaped) return;

      for (const rule of RULES) {
        if (rule.name === 'inline or CSS opacity' && inKeyframes) continue;
        if (rule.name === 'colour literal with alpha' && isTheme) continue;
        if (rule.pattern.test(text)) {
          violations.push({
            file: rel,
            line: index + 1,
            rule: rule.name,
            text: text.trim(),
          });
        }
      }
    });
  }
  return violations;
}

export function formatViolations(violations: OpacityColourViolation[]): string {
  return violations
    .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`)
    .join('\n');
}
