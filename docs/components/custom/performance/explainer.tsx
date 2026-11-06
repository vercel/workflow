import { geistShikiTheme } from '@vercel/geistdocs/shiki-theme';
import { codeToTokens } from 'shiki';
import {
  type ModelTokens,
  PerformanceExplainerClient,
} from './explainer-client';
import { models } from './models';

/**
 * Interactive explainer for the benchmarks on /docs/performance: choose a metric, then play
 * or scrub through a schematic run to see where its clock starts and stops. Code is
 * highlighted here, on the server, with the same Shiki theme as the docs' code blocks.
 */
export const PerformanceExplainer = async () => {
  const entries = await Promise.all(
    models.map(async (model) => {
      const { tokens } = await codeToTokens(
        model.code.map((line) => line.s).join('\n'),
        { lang: 'ts', theme: geistShikiTheme }
      );
      if (tokens.length !== model.code.length) {
        throw new Error(
          `${model.id}: ${tokens.length} highlighted lines for ${model.code.length} lines of code`
        );
      }
      return [
        model.id,
        tokens.map((line) =>
          line.map(({ content, color }) => ({ content, color }))
        ),
      ] as const;
    })
  );
  return (
    <PerformanceExplainerClient
      tokens={Object.fromEntries(entries) as ModelTokens}
    />
  );
};
