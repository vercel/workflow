'use client';

import { AlertCircle, Loader2, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { transformCode } from '@/lib/transform-action';
import { CodeEditor } from './editor';

const STORAGE_KEY = 'swc-playground-code';

const DEFAULT_CODE = `
import { sleep } from 'workflow';

async function myStep(a: number) {
  "use step";
  return a + 1;
}

export async function main() {
  "use workflow";
  await sleep(1000);
  await myStep(1);
  return "hello world";
}
`.trim();

function getStoredCode(): string {
  if (typeof window === 'undefined') return DEFAULT_CODE;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_CODE;
}

type ViewMode = 'workflow' | 'step' | 'client';

interface CompilationResult {
  code: string;
  error?: string;
}

interface SwcPlaygroundProps {
  pluginVersion?: string;
}

export function SwcPlayground({ pluginVersion }: SwcPlaygroundProps) {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [isHydrated, setIsHydrated] = useState(false);
  const [results, setResults] = useState<Record<ViewMode, CompilationResult>>({
    workflow: { code: '' },
    step: { code: '' },
    client: { code: '' },
  });
  const [isCompiling, setIsCompiling] = useState(false);

  // Hydrate code from localStorage on mount
  useEffect(() => {
    const stored = getStoredCode();
    setCode(stored);
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

  const compile = useCallback(async (sourceCode: string) => {
    setIsCompiling(true);

    try {
      const transformResults = await transformCode(sourceCode);
      setResults(transformResults);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Server error';
      // Set error state for all modes
      setResults({
        workflow: { code: '', error: errorMessage },
        step: { code: '', error: errorMessage },
        client: { code: '', error: errorMessage },
      });
    } finally {
      setIsCompiling(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      compile(code);
    }, 500);
    return () => clearTimeout(timer);
  }, [code, compile]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <header className="flex items-center px-6 py-3 border-b bg-card">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">
            Workflow DevKit Compiler Playground
          </h1>
          <span className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground">
            @workflow/swc-plugin{pluginVersion ? `@${pluginVersion}` : ''}
          </span>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 overflow-hidden">
        {/* Input Section */}
        <div className="h-full border-r flex flex-col">
          <div className="bg-muted px-4 py-2 text-sm font-medium border-b flex items-center justify-between shrink-0">
            <span>Input (TypeScript)</span>
            <button
              type="button"
              onClick={() => setCode(DEFAULT_CODE)}
              disabled={code === DEFAULT_CODE}
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
            />
          </div>
        </div>

        {/* Output Section - 3 Views */}
        <div className="h-full flex flex-col overflow-hidden bg-muted/10">
          <div className="flex-1 border-b min-h-0">
            <OutputView
              mode="workflow"
              result={results.workflow}
              isCompiling={isCompiling}
            />
          </div>
          <div className="flex-1 border-b min-h-0">
            <OutputView
              mode="step"
              result={results.step}
              isCompiling={isCompiling}
            />
          </div>
          <div className="flex-1 min-h-0">
            <OutputView
              mode="client"
              result={results.client}
              isCompiling={isCompiling}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function OutputView({
  mode,
  result,
  isCompiling,
}: {
  mode: string;
  result: CompilationResult;
  isCompiling: boolean;
}) {
  return (
    <div className="h-full flex flex-col relative">
      <div className="bg-muted px-4 py-2 text-sm font-medium border-b flex items-center justify-between shrink-0">
        <span className="capitalize">{mode} Output</span>
        {isCompiling && (
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 relative overflow-hidden">
        {result.error ? (
          <div className="absolute inset-0 p-4 text-red-500 font-mono text-sm overflow-auto bg-red-50/10">
            <div className="flex items-center gap-2 mb-2 font-bold">
              <AlertCircle className="w-4 h-4" />
              Compilation Error
            </div>
            {result.error}
          </div>
        ) : (
          <CodeEditor
            language="javascript"
            value={result.code}
            options={{ readOnly: true }}
          />
        )}
      </div>
    </div>
  );
}
