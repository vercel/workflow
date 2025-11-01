import { transform } from '@swc/core';

// This loader applies the "use workflow"/"use step"
// client transformation
export default async function workflowLoader(
  this: {
    resourcePath: string;
  },
  source: string | Buffer,
  sourceMap: any
): Promise<string> {
  const filename = this.resourcePath;
  const normalizedSource = source.toString();

  console.log(
    '[workflowLoader] Processing file:',
    filename,
    'Source length:',
    normalizedSource.length
  );

  // only apply the transform if file needs it
  if (!normalizedSource.match(/(use step|use workflow)/)) {
    console.log(
      '[workflowLoader] No workflow/step directives found in:',
      filename
    );
    return normalizedSource;
  }

  console.log('[workflowLoader] Found workflow/step directives in:', filename);

  const isTypeScript = filename.endsWith('.ts') || filename.endsWith('.tsx');
  const isTsx = filename.endsWith('.tsx');

  // Transform with SWC
  const result = await transform(normalizedSource, {
    filename,
    jsc: {
      parser: {
        syntax: isTypeScript ? 'typescript' : 'ecmascript',
        tsx: isTsx,
      },
      target: 'es2022',
      experimental: {
        plugins: [
          [require.resolve('@workflow/swc-plugin'), { mode: 'client' }],
        ],
      },
    },
    minify: false,
    inputSourceMap: sourceMap,
    sourceMaps: true,
    inlineSourcesContent: true,
  });

  return result.code;
}
