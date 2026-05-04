/**
 * Shared theme configuration for react-inspector's ObjectInspector.
 *
 * Colors follow Geist's Shiki JSON palette so the inspector reads the same
 * as highlighted code blocks across the product:
 *   - property names / punctuation: --ds-gray-1000 (default foreground)
 *   - strings / numbers / booleans: --ds-green-900
 *   - null / undefined: --ds-gray-900 (muted)
 *   - regexp / function: --ds-purple-900
 *   - date: --ds-pink-900
 *
 * Because the `--ds-*` tokens adapt to theme automatically, the light and
 * dark objects are intentionally identical.
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
  OBJECT_VALUE_DATE_COLOR: 'var(--ds-pink-900)',
};

export const inspectorThemeExtendedDark: InspectorThemeExtended = {
  OBJECT_VALUE_DATE_COLOR: 'var(--ds-pink-900)',
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

const geistTheme = {
  ...shared,

  // Base text
  BASE_COLOR: 'var(--ds-gray-1000)',

  // Property names — default foreground (matches JSON key color in Geist Shiki)
  OBJECT_NAME_COLOR: 'var(--ds-gray-1000)',

  // Strings & symbols — green
  OBJECT_VALUE_STRING_COLOR: 'var(--ds-green-900)',
  OBJECT_VALUE_SYMBOL_COLOR: 'var(--ds-green-900)',

  // Numbers & booleans — green (Geist JSON tokens)
  OBJECT_VALUE_NUMBER_COLOR: 'var(--ds-green-900)',
  OBJECT_VALUE_BOOLEAN_COLOR: 'var(--ds-green-900)',

  // null — muted foreground
  OBJECT_VALUE_NULL_COLOR: 'var(--ds-gray-900)',

  // undefined — muted foreground
  OBJECT_VALUE_UNDEFINED_COLOR: 'var(--ds-gray-900)',

  // RegExp — purple
  OBJECT_VALUE_REGEXP_COLOR: 'var(--ds-purple-900)',

  // Functions — purple
  OBJECT_VALUE_FUNCTION_PREFIX_COLOR: 'var(--ds-purple-900)',

  // HTML (rarely used here, kept consistent with the palette)
  HTML_TAG_COLOR: 'var(--ds-gray-900)',
  HTML_TAGNAME_COLOR: 'var(--ds-blue-900)',
  HTML_ATTRIBUTE_NAME_COLOR: 'var(--ds-amber-900)',
  HTML_ATTRIBUTE_VALUE_COLOR: 'var(--ds-green-900)',
  HTML_COMMENT_COLOR: 'var(--ds-gray-700)',
  HTML_DOCTYPE_COLOR: 'var(--ds-gray-700)',

  // Structural
  ARROW_COLOR: 'var(--ds-gray-700)',
  TABLE_BORDER_COLOR: 'var(--ds-gray-300)',
  TABLE_TH_BACKGROUND_COLOR: 'var(--ds-gray-100)',
  TABLE_TH_HOVER_COLOR: 'var(--ds-gray-200)',
  TABLE_SORT_ICON_COLOR: 'var(--ds-gray-700)',
};

export const inspectorThemeLight = geistTheme;

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------

export const inspectorThemeDark = geistTheme;
