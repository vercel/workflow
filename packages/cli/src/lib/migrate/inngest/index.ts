import type * as TS from 'typescript';
import type { MigrationFramework } from '../framework.js';
import { renderMarkdown } from './report.js';
import { transformInngestFile } from './transform.js';

/** `workflow migrate inngest` */
export const inngestFramework: MigrationFramework<Set<string>> = {
  id: 'inngest',
  label: 'Inngest',
  mightUse: (text) =>
    text.includes('createFunction') ||
    /\binngest\b/i.test(text) ||
    text.includes('NonRetriableError') ||
    text.includes('RetryAfterError'),
  // Every Inngest client name in the project, so `inngest.send()` calls are
  // reported even in files that define no functions.
  prepare(ts: typeof TS, program: TS.Program, files: string[]) {
    const clientNames = new Set<string>();
    for (const file of files) {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      const visit = (node: TS.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isNewExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'Inngest'
        ) {
          clientNames.add(node.name.text);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'createFunction' &&
          ts.isIdentifier(node.expression)
        ) {
          clientNames.add(node.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return clientNames;
  },
  transform: ({ context, ...options }) =>
    transformInngestFile({ ...options, clientNames: context }),
  renderMarkdown,
  boundaryHint:
    'Pass --report <file> for a Markdown report with suggested replacements for inngest.send() calls.',
};
