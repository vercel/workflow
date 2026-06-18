/**
 * Class names and styles for the data inspector tree.
 *
 * Kept out of the component module for readability. The CSS is injected via a
 * React 19 hoistable `<style>` (see DataInspector), so it stays bundler-agnostic
 * for every consumer. Colors use theme-aware `--ds-*` tokens that adapt to
 * light/dark automatically, so no per-theme overrides are needed.
 */

export const CLS = {
  container: 'wf-json-view',
  child: 'wf-json-child',
  childFields: 'wf-json-child-fields',
  label: 'wf-json-label',
  clickableLabel: 'wf-json-clickable-label',
  punctuation: 'wf-json-punctuation',
  className: 'wf-json-classname',
  expandIcon: 'wf-json-expand-icon',
  collapseIcon: 'wf-json-collapse-icon',
  collapsedContent: 'wf-json-collapsed-content',
  string: 'wf-json-string',
  number: 'wf-json-number',
  boolean: 'wf-json-boolean',
  null: 'wf-json-null',
  undefined: 'wf-json-undefined',
  date: 'wf-json-date',
  regexp: 'wf-json-regexp',
} as const;

export const JSON_VIEW_STYLES = `
.${CLS.container} {
  display: inline;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 20px;
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--ds-gray-1000);
  white-space: pre-wrap;
  word-wrap: break-word;
}
.${CLS.container} > .${CLS.child} > ul { padding-left: 0ch; }
.${CLS.container} > .${CLS.child} { padding-left: 1.5ch; }
.${CLS.child} { display: block; margin: 0; padding: 0 0 0 2ch; }
.${CLS.child}:hover:not(:has(.${CLS.child}:hover)):not(:has(.${CLS.child} ~ .${CLS.child})) {
  background-color: var(--ds-gray-alpha-100);
  border-radius: 4px;
}
.${CLS.childFields} { margin: 0; padding: 0; list-style: none; }
.${CLS.label}, .${CLS.clickableLabel} {
  color: var(--ds-pink-900);
  font-weight: 400;
  margin-right: 1ch;
}
.${CLS.clickableLabel} { cursor: pointer; }
.${CLS.punctuation} { color: var(--ds-gray-1000); }
.${CLS.className} { font-style: italic; color: var(--ds-gray-900); margin-right: 1ch; }
.${CLS.string} { color: var(--ds-green-900); }
.${CLS.number} { color: var(--ds-blue-900); }
.${CLS.boolean} { color: var(--ds-amber-900); }
.${CLS.null}, .${CLS.undefined} { color: var(--ds-gray-900); }
.${CLS.date} { color: var(--ds-pink-900); }
.${CLS.regexp} { color: var(--ds-purple-900); }
.${CLS.container} > .${CLS.child} > .${CLS.expandIcon},
.${CLS.container} > .${CLS.child} > .${CLS.collapseIcon} { margin-left: -1.5ch; }
.${CLS.expandIcon}, .${CLS.collapseIcon} {
  appearance: none;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  vertical-align: baseline;
  cursor: pointer;
  display: inline-block;
  margin-right: 0ch;
  margin-left: -1.5ch;
  color: var(--ds-gray-500);
  user-select: none;
  outline: none;
}
.${CLS.expandIcon}::after {
  content: '\\25B8';
  margin-right: 0.5ch;
  transform: translateY(-0.5px);
  display: block;
}
.${CLS.collapseIcon}::after { content: '\\25BE'; margin-right: 0.5ch; }
.${CLS.expandIcon}:hover, .${CLS.collapseIcon}:hover,
.${CLS.child}:has(> .${CLS.clickableLabel}:hover) > .${CLS.expandIcon},
.${CLS.child}:has(> .${CLS.clickableLabel}:hover) > .${CLS.collapseIcon} {
  color: var(--ds-gray-1000);
}
.${CLS.collapsedContent} { color: var(--ds-gray-900); }
.${CLS.collapsedContent}::after { content: '...'; }
`;
