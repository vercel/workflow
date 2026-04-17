'use client';

import type { Monaco } from '@monaco-editor/react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDownIcon,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Switch } from '@/components/ui/switch';
import { nodeTypeDeclarations, typeDeclarations } from '@/lib/generated-types';
import {
  analyzeSerdeFromTransformOutput,
  initWasm,
  type SerdeAnalysis,
  transformCode,
} from '@/lib/transform';
import { CodeEditor } from './editor';

const STORAGE_KEY = 'swc-playground-code';
const MODULE_SPECIFIER_STORAGE_KEY = 'swc-playground-module-specifier';
const VIM_MODE_STORAGE_KEY = 'swc-playground-vim-mode';

const DEFAULT_CODE = `
import { sleep } from 'workflow';
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
import { readFile } from 'node:fs/promises';

export class Document {
  constructor(public path: string, public content: string) {}

  static [WORKFLOW_SERIALIZE](instance: Document) {
    return { path: instance.path, content: instance.content };
  }

  static [WORKFLOW_DESERIALIZE](data: { path: string; content: string }) {
    return new Document(data.path, data.content);
  }

  async load() {
    "use step";
    const content = await readFile(this.path, 'utf-8');
    return new Document(this.path, content);
  }
}

async function processDocument(doc: Document) {
  "use step";
  return doc.content.length;
}

export async function main(filePath: string) {
  "use workflow";
  const doc = new Document(filePath, '');
  const loaded = await doc.load();
  await sleep(1000);
  const length = await processDocument(loaded);
  return length;
}
`.trim();

function getStoredCode(): string {
  if (typeof window === 'undefined') return DEFAULT_CODE;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_CODE;
}

function getStoredModuleSpecifier(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(MODULE_SPECIFIER_STORAGE_KEY) || '';
}

function getStoredVimMode(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(VIM_MODE_STORAGE_KEY) === 'true';
}

type ViewMode = 'workflow' | 'step';
type PanelId = ViewMode | 'serde';

interface CompilationResult {
  code: string;
  error?: string;
}

interface SwcPlaygroundProps {
  pluginVersion?: string;
  gitCommitSha?: string;
}

export function SwcPlayground({
  pluginVersion,
  gitCommitSha,
}: SwcPlaygroundProps) {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [moduleSpecifier, setModuleSpecifier] = useState('');
  const [vimMode, setVimMode] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<ViewMode, CompilationResult>>({
    workflow: { code: '' },
    step: { code: '' },
  });
  const [isCompiling, setIsCompiling] = useState(false);
  const [serdeAnalysis, setSerdeAnalysis] = useState<SerdeAnalysis | null>(
    null
  );
  const [expandedPanels, setExpandedPanels] = useState<Set<PanelId>>(
    new Set(['workflow', 'step', 'serde'])
  );
  const monacoConfigured = useRef(false);

  // Configure Monaco TypeScript language service with workflow type definitions
  const configureMonaco = useCallback((monaco: Monaco) => {
    if (monacoConfigured.current) return;
    monacoConfigured.current = true;

    const ts = monaco.languages.typescript;

    // Configure TypeScript compiler options for the editor
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      strict: true,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowImportingTsExtensions: true,
    });

    // Register ambient module declarations for workflow packages.
    // This is a single string containing `declare module "..."` blocks
    // with inlined type content for each package.
    ts.typescriptDefaults.addExtraLib(typeDeclarations);

    // Register @types/node declarations for Node.js built-in modules
    for (const [path, content] of Object.entries(nodeTypeDeclarations)) {
      ts.typescriptDefaults.addExtraLib(content, path);
    }
  }, []);

  // Initialize WASM module on mount
  useEffect(() => {
    initWasm()
      .then(() => setWasmReady(true))
      .catch((err) => {
        console.error('Failed to initialize WASM:', err);
        setWasmError(
          err instanceof Error ? err.message : 'Failed to load WASM module'
        );
      });
  }, []);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const stored = getStoredCode();
    setCode(stored);
    const storedModuleSpecifier = getStoredModuleSpecifier();
    setModuleSpecifier(storedModuleSpecifier);
    const storedVimMode = getStoredVimMode();
    setVimMode(storedVimMode);
    setIsHydrated(true);
  }, []);

  // Save code to localStorage when it changes
  useEffect(() => {
    if (isHydrated) {
      try {
        localStorage.setItem(STORAGE_KEY, code);
      } catch {
        // localStorage may be disabled or full
      }
    }
  }, [code, isHydrated]);

  // Save moduleSpecifier to localStorage when it changes
  useEffect(() => {
    if (isHydrated) {
      try {
        localStorage.setItem(MODULE_SPECIFIER_STORAGE_KEY, moduleSpecifier);
      } catch {
        // localStorage may be disabled or full
      }
    }
  }, [moduleSpecifier, isHydrated]);

  // Save vim mode to localStorage when it changes
  useEffect(() => {
    if (isHydrated) {
      try {
        localStorage.setItem(VIM_MODE_STORAGE_KEY, String(vimMode));
      } catch {
        // localStorage may be disabled or full
      }
    }
  }, [vimMode, isHydrated]);

  const compile = useCallback(
    async (sourceCode: string) => {
      if (!wasmReady) return;
      setIsCompiling(true);

      try {
        const transformResults = await transformCode(
          sourceCode,
          moduleSpecifier || undefined
        );
        setResults(transformResults);
        // Run serde analysis on workflow output
        if (
          transformResults.workflow.code &&
          !transformResults.workflow.error
        ) {
          setSerdeAnalysis(
            analyzeSerdeFromTransformOutput(
              sourceCode,
              transformResults.workflow.code
            )
          );
        } else {
          setSerdeAnalysis(null);
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Transform error';
        setResults({
          workflow: { code: '', error: errorMessage },
          step: { code: '', error: errorMessage },
        });
        setSerdeAnalysis(null);
      } finally {
        setIsCompiling(false);
      }
    },
    [moduleSpecifier, wasmReady]
  );

  useEffect(() => {
    if (!wasmReady) return;
    const timer = setTimeout(() => {
      compile(code);
    }, 300);
    return () => clearTimeout(timer);
  }, [code, compile, wasmReady]);

  const togglePanel = (mode: PanelId) => {
    setExpandedPanels((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
      } else {
        next.add(mode);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-3 border-b bg-card">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">
            Workflow SDK Compiler Playground
          </h1>
          <span className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground">
            @workflow/swc-plugin{pluginVersion ? `@${pluginVersion}` : ''}
          </span>
          {!wasmReady && !wasmError && (
            <span className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading WASM...
            </span>
          )}
          {wasmError && (
            <span className="text-xs px-2 py-1 bg-red-100 dark:bg-red-900/30 rounded text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              WASM failed to load
            </span>
          )}
          {gitCommitSha && (
            <a
              href={`https://github.com/vercel/workflow/commit/${gitCommitSha}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground hover:text-foreground transition-colors"
            >
              {gitCommitSha.slice(0, 7)}
            </a>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="vim-mode" className="text-sm text-muted-foreground">
              Vim
            </label>
            <Switch
              id="vim-mode"
              size="sm"
              checked={vimMode}
              onCheckedChange={setVimMode}
            />
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor="module-specifier"
              className="text-sm text-muted-foreground"
            >
              Module Specifier:
            </label>
            <input
              id="module-specifier"
              type="text"
              value={moduleSpecifier}
              onChange={(e) => setModuleSpecifier(e.target.value)}
              placeholder="e.g., my-package@1.0.0"
              className="text-sm px-3 py-1 bg-muted rounded border border-input focus:outline-none focus:ring-2 focus:ring-ring w-64"
            />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Input Section */}
          <ResizablePanel defaultSize={50} minSize={25}>
            <div className="h-full flex flex-col">
              <div className="bg-muted px-4 py-2 text-sm font-medium border-b flex items-center justify-between shrink-0">
                <span>Input (TypeScript)</span>
                <button
                  type="button"
                  onClick={() => setCode(DEFAULT_CODE)}
                  disabled={isHydrated && code === DEFAULT_CODE}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
                  title="Reset to default code"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <CodeEditor
                  language="typescript"
                  value={code}
                  onChange={(val) => setCode(val || '')}
                  vimMode={vimMode}
                  onMount={(_editor, monaco) => configureMonaco(monaco)}
                />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Output Section - Collapsible Panels */}
          <ResizablePanel defaultSize={50} minSize={25}>
            <div className="h-full flex flex-col overflow-hidden bg-muted/10">
              {(['workflow', 'step'] as const).map((mode) => {
                const isOpen = expandedPanels.has(mode);
                return (
                  <div
                    key={mode}
                    className={`flex flex-col min-h-0 border-b last:border-b-0 ${
                      isOpen ? 'flex-1' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => togglePanel(mode)}
                      aria-expanded={isOpen}
                      aria-controls={`output-panel-${mode}`}
                      className="bg-muted px-4 py-2 text-sm font-medium border-b flex items-center justify-between shrink-0 hover:bg-muted/80 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <ChevronDownIcon
                          className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
                            isOpen ? '' : '-rotate-90'
                          }`}
                        />
                        <span className="capitalize">{mode} Output</span>
                        {isCompiling && (
                          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                        )}
                      </div>
                    </button>
                    {isOpen && (
                      <div
                        id={`output-panel-${mode}`}
                        className="flex-1 min-h-0 relative"
                      >
                        {results[mode].error ? (
                          <div className="absolute inset-0 p-4 text-red-500 font-mono text-sm overflow-auto bg-red-50/10">
                            <div className="flex items-center gap-2 mb-2 font-bold">
                              <AlertCircle className="w-4 h-4" />
                              Compilation Error
                            </div>
                            {results[mode].error}
                          </div>
                        ) : (
                          <CodeEditor
                            language="javascript"
                            value={results[mode].code}
                            options={{ readOnly: true }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Serde Analysis Panel */}
              {serdeAnalysis &&
                (() => {
                  const isSerdeOpen = expandedPanels.has('serde');
                  const allCompliant = serdeAnalysis.classes.every(
                    (c) => c.compliant
                  );
                  return (
                    <div
                      className={`flex flex-col min-h-0 border-b last:border-b-0 ${
                        isSerdeOpen ? 'flex-1' : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => togglePanel('serde')}
                        aria-expanded={isSerdeOpen}
                        aria-controls="output-panel-serde"
                        className="bg-muted px-4 py-2 text-sm font-medium border-b flex items-center justify-between shrink-0 hover:bg-muted/80 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <ChevronDownIcon
                            className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
                              isSerdeOpen ? '' : '-rotate-90'
                            }`}
                          />
                          <span>Serde Analysis</span>
                          {allCompliant ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-red-500" />
                          )}
                        </div>
                      </button>
                      {isSerdeOpen && (
                        <div
                          id="output-panel-serde"
                          className="flex-1 min-h-0 overflow-auto p-4 text-sm"
                        >
                          {serdeAnalysis.classes.map((cls) => (
                            <div
                              key={cls.classId || cls.className}
                              className="mb-3 last:mb-0"
                            >
                              <div className="flex items-center gap-2 mb-1">
                                {cls.compliant ? (
                                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                                ) : (
                                  <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                                )}
                                <span className="font-medium">
                                  {cls.className}
                                </span>
                                <span
                                  className={
                                    cls.compliant
                                      ? 'text-green-500'
                                      : 'text-red-500'
                                  }
                                >
                                  {cls.compliant
                                    ? 'Compliant'
                                    : 'Not Compliant'}
                                </span>
                              </div>
                              <div className="ml-6 text-muted-foreground space-y-0.5">
                                {cls.classId && (
                                  <div>
                                    classId:{' '}
                                    <code className="text-xs bg-muted px-1 rounded">
                                      {cls.classId}
                                    </code>
                                  </div>
                                )}
                                <div>
                                  Detected by SWC: {cls.detected ? 'yes' : 'no'}
                                </div>
                                <div>
                                  Registration IIFE:{' '}
                                  {cls.registered ? 'yes' : 'no'}
                                </div>
                                {cls.nodeImports.length > 0 && (
                                  <div className="text-yellow-500">
                                    Node.js imports in workflow bundle:{' '}
                                    {cls.nodeImports.join(', ')}
                                  </div>
                                )}
                                {cls.issues.map((issue, i) => (
                                  <div key={i} className="text-yellow-500">
                                    {issue}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                          {serdeAnalysis.globalNodeImports.length > 0 && (
                            <div className="mt-2 pt-2 border-t text-yellow-500">
                              All Node.js imports in workflow output:{' '}
                              {serdeAnalysis.globalNodeImports.join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </div>
  );
}
