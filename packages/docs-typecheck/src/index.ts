export { extractCodeSamples, extractCodeSamplesFromFile } from './extractor.js';
export { addInferredImports } from './import-inference.js';
export { formatResult, typeCheck, typeCheckBatch } from './type-checker.js';
export type {
  CodeSample,
  ProcessedCodeSample,
  TypeCheckDiagnostic,
  TypeCheckResult,
} from './types.js';
