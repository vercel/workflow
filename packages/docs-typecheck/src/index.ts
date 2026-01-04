export { extractCodeSamples, extractCodeSamplesFromFile } from './extractor.js';
export { addInferredImports } from './import-inference.js';
export { typeCheck, typeCheckBatch, formatResult } from './type-checker.js';
export type {
  CodeSample,
  ProcessedCodeSample,
  TypeCheckResult,
  TypeCheckDiagnostic,
} from './types.js';
