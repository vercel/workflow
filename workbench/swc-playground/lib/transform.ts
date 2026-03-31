export interface TransformResult {
  workflow: { code: string; error?: string };
  step: { code: string; error?: string };
  client: { code: string; error?: string };
}

let wasmExports: {
  transform: (source: string, config_json: string) => string;
  transformAll: (source: string, config_json: string) => string;
} | null = null;

let initPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module. Safe to call multiple times —
 * subsequent calls are no-ops.
 */
export async function initWasm(): Promise<void> {
  if (wasmExports) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dynamically import the wasm-bindgen glue code.
    // The `/* webpackIgnore: true */` comment prevents the bundler
    // from statically analyzing the import and trying to resolve
    // the .wasm file reference inside the glue code.
    const glue = await import(
      /* webpackIgnore: true */
      '/wasm/swc_playground_wasm.js'
    );
    await glue.default({
      module_or_path: '/wasm/swc_playground_wasm_bg.wasm',
    });
    wasmExports = {
      transform: glue.transform,
      transformAll: glue.transformAll,
    };
  })();

  return initPromise;
}

/**
 * Transform source code using the workflow SWC plugin (runs in WASM).
 *
 * Automatically initializes the WASM module on first call.
 */
export async function transformCode(
  sourceCode: string,
  moduleSpecifier?: string
): Promise<TransformResult> {
  await initWasm();

  const config = JSON.stringify({
    moduleSpecifier,
    filename: 'input.ts',
  });

  const resultJson = wasmExports!.transformAll(sourceCode, config);
  return JSON.parse(resultJson) as TransformResult;
}
