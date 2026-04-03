/**
 * Shared theme configuration for react-inspector's ObjectInspector.
 *
 * Color choices are inspired by Node.js `util.inspect()` ANSI stylizing:
 *   - property names: unstyled (default foreground — dark text on light, light text on dark)
 *   - strings / symbols: green
 *   - numbers / booleans / bigint: yellow
 *   - null: bold (foreground)
 *   - undefined: grey
 *   - regexp: red
 *   - functions (special): cyan
 *   - date: magenta
 *
 * See: https://github.com/nodejs/node/blob/main/lib/internal/util/inspect.js
 */

// ---------------------------------------------------------------------------
// Extended color tokens not supported by react-inspector's built-in theme
// system, applied via our custom nodeRenderer in data-inspector.tsx.
// ---------------------------------------------------------------------------

export interface InspectorThemeExtended {
  /** Color for Date values (Node: 'magenta') */
  OBJECT_VALUE_DATE_COLOR: string;
}

export const inspectorThemeExtendedLight: InspectorThemeExtended = {
  OBJECT_VALUE_DATE_COLOR: '#a21caf', // fuchsia-700
};

export const inspectorThemeExtendedDark: InspectorThemeExtended = {
  OBJECT_VALUE_DATE_COLOR: '#e879f9', // fuchsia-400
};

// ---------------------------------------------------------------------------
// Shared structural values (same in both themes)
// ---------------------------------------------------------------------------

const shared = {
  BASE_FONT_SIZE: '11px',
  BASE_LINE_HEIGHT: 1.4,
  BASE_BACKGROUND_COLOR: 'transparent',
  OBJECT_PREVIEW_ARRAY_MAX_PROPERTIES: 10,
  OBJECT_PREVIEW_OBJECT_MAX_PROPERTIES: 5,
  HTML_TAGNAME_TEXT_TRANSFORM: 'lowercase' as const,
  ARROW_MARGIN_RIGHT: 3,
  ARROW_FONT_SIZE: 12,
  TREENODE_FONT_FAMILY: 'var(--font-mono)',
  TREENODE_FONT_SIZE: '11px',
  TREENODE_LINE_HEIGHT: 1.4,
  TREENODE_PADDING_LEFT: 12,
  TABLE_DATA_BACKGROUND_IMAGE: 'none',
  TABLE_DATA_BACKGROUND_SIZE: '0',
};

// ---------------------------------------------------------------------------
// Light theme
// ---------------------------------------------------------------------------

export const inspectorThemeLight = {
  ...shared,

  // Base text
  BASE_COLOR: 'var(--ds-gray-1000)',

  // Property names — unstyled, same as base foreground (Node: no style)
  OBJECT_NAME_COLOR: 'var(--ds-gray-900)',

  // Strings & symbols — green (Node: 'green')
  OBJECT_VALUE_STRING_COLOR: '#16a34a', // green-600
  OBJECT_VALUE_SYMBOL_COLOR: '#16a34a',

  // Numbers & booleans — yellow/amber (Node: 'yellow')
  OBJECT_VALUE_NUMBER_COLOR: '#b45309', // amber-700 (readable on white)
  OBJECT_VALUE_BOOLEAN_COLOR: '#b45309',

  // null — bold foreground (Node: 'bold')
  OBJECT_VALUE_NULL_COLOR: 'var(--ds-gray-900)',

  // undefined — grey (Node: 'grey')
  OBJECT_VALUE_UNDEFINED_COLOR: 'var(--ds-gray-500)',

  // RegExp — red (Node regexp base uses green/red/yellow palette)
  OBJECT_VALUE_REGEXP_COLOR: '#dc2626', // red-600

  // Functions — cyan (Node: 'special' → 'cyan')
  OBJECT_VALUE_FUNCTION_PREFIX_COLOR: '#0891b2', // cyan-600

  // HTML (less relevant for data inspection, but reasonable defaults)
  HTML_TAG_COLOR: 'var(--ds-gray-500)',
  HTML_TAGNAME_COLOR: '#0891b2',
  HTML_ATTRIBUTE_NAME_COLOR: '#b45309',
  HTML_ATTRIBUTE_VALUE_COLOR: '#16a34a',
  HTML_COMMENT_COLOR: 'var(--ds-gray-400)',
  HTML_DOCTYPE_COLOR: 'var(--ds-gray-400)',

  // Structural
  ARROW_COLOR: 'var(--ds-gray-500)',
  TABLE_BORDER_COLOR: 'var(--ds-gray-300)',
  TABLE_TH_BACKGROUND_COLOR: 'var(--ds-gray-100)',
  TABLE_TH_HOVER_COLOR: 'var(--ds-gray-200)',
  TABLE_SORT_ICON_COLOR: 'var(--ds-gray-500)',
};

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------

export const inspectorThemeDark = {
  ...shared,

  // Base text
  BASE_COLOR: 'var(--ds-gray-1000)',

  // Property names — white/light foreground (Node: unstyled = white in dark terminal)
  OBJECT_NAME_COLOR: 'var(--ds-gray-900)',

  // Strings & symbols — green (Node: 'green')
  OBJECT_VALUE_STRING_COLOR: '#4ade80', // green-400
  OBJECT_VALUE_SYMBOL_COLOR: '#4ade80',

  // Numbers & booleans — yellow (Node: 'yellow')
  OBJECT_VALUE_NUMBER_COLOR: '#facc15', // yellow-400
  OBJECT_VALUE_BOOLEAN_COLOR: '#facc15',

  // null — bold foreground / white (Node: 'bold')
  OBJECT_VALUE_NULL_COLOR: 'var(--ds-gray-1000)',

  // undefined — grey (Node: 'grey')
  OBJECT_VALUE_UNDEFINED_COLOR: 'var(--ds-gray-500)',

  // RegExp — red (Node regexp palette)
  OBJECT_VALUE_REGEXP_COLOR: '#f87171', // red-400

  // Functions — cyan (Node: 'special' → 'cyan')
  OBJECT_VALUE_FUNCTION_PREFIX_COLOR: '#22d3ee', // cyan-400

  // HTML
  HTML_TAG_COLOR: 'var(--ds-gray-500)',
  HTML_TAGNAME_COLOR: '#22d3ee',
  HTML_ATTRIBUTE_NAME_COLOR: '#facc15',
  HTML_ATTRIBUTE_VALUE_COLOR: '#4ade80',
  HTML_COMMENT_COLOR: 'var(--ds-gray-500)',
  HTML_DOCTYPE_COLOR: 'var(--ds-gray-500)',

  // Structural
  ARROW_COLOR: 'var(--ds-gray-500)',
  TABLE_BORDER_COLOR: 'var(--ds-gray-300)',
  TABLE_TH_BACKGROUND_COLOR: 'var(--ds-gray-100)',
  TABLE_TH_HOVER_COLOR: 'var(--ds-gray-200)',
  TABLE_SORT_ICON_COLOR: 'var(--ds-gray-500)',
};
