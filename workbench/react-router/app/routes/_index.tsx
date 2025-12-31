import { useEffect, useRef } from 'react';
import type { Route } from './+types/_index';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Workflow DevKit + React Router Example' },
    {
      name: 'description',
      content: 'Workflow DevKit running with React Router',
    },
  ];
}

export default function Home() {
  const outputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const outputEl = outputRef.current;
    if (!outputEl) return;

    function log(...args: unknown[]) {
      if (!outputEl) return;
      outputEl.textContent +=
        args
          .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
          .join(' ') + '\n';
    }

    function tryFormatJSON(text: string) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }

    async function fetchAndLog(
      input: string,
      init?: RequestInit
    ): Promise<Record<string, unknown>> {
      try {
        const req = new Request(input, init);
        log(`[${req.method}] ${input}`);
        const res = await fetch(req);
        const text = await res.text();
        if (res.ok) {
          log('Response:', tryFormatJSON(text));
          return JSON.parse(text);
        } else {
          log('Error', res.status, res.statusText, tryFormatJSON(text));
        }
      } catch (error) {
        log(
          'Fetch error:',
          error instanceof Error ? error.toString() : String(error)
        );
      }
      return {};
    }

    async function main() {
      const { runId } = await fetchAndLog(
        '/api/trigger?workflowFile=workflows/0_calc.ts&workflowFn=calc&args=2',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '',
        }
      );

      if (runId) {
        log('Getting workflow status with runId:', runId);
        await fetchAndLog(`/api/trigger?runId=${runId}`);
      }
    }

    main().catch((error) =>
      log(
        'Main error:',
        error instanceof Error ? error.toString() : String(error)
      )
    );
  }, []);

  return (
    <>
      <style>
        {`
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            background-color: #1e1e1e;
            color: #d4d4d4;
            font-family:
              -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
              Cantarell, sans-serif;
            padding: 20px;
          }

          h1 {
            font-size: 24px;
            margin-bottom: 10px;
          }

          hr {
            border: none;
            border-top: 1px solid #3e3e3e;
            margin-bottom: 20px;
          }

          textarea {
            width: 100%;
            height: calc(100vh - 140px);
            max-height: calc(100vh - 140px);
            box-sizing: border-box;
            padding: 12px;
            font-family: "Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace;
            font-size: 14px;
            resize: none;
            overflow: auto;
            background-color: #252526;
            color: #d4d4d4;
            border: 1px solid #3e3e3e;
            border-radius: 4px;
          }

          textarea:focus {
            outline: none;
            border-color: #007acc;
          }

          textarea::placeholder {
            color: #6a6a6a;
          }
        `}
      </style>
      <h1>Workflow DevKit + React Router Example</h1>
      <hr />
      <textarea ref={outputRef} readOnly placeholder="output" />
    </>
  );
}
