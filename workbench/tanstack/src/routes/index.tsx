import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

export const Route = createFileRoute('/')({
  component: App,
  head: () => ({
    meta: [
      {
        title: 'Workflows DevKit + TanStack Example',
      },
    ],
  }),
});

function App() {
  const [output, setOutput] = useState('');
  const outputRef = useRef('');

  useEffect(() => {
    async function runWorkflow() {
      const log = (...args: unknown[]) => {
        const message =
          args
            .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
            .join(' ') + '\n';
        outputRef.current += message;
        setOutput(outputRef.current);
      };

      const tryFormatJSON = (text: string) => {
        try {
          return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          return text;
        }
      };

      const fetchAndLog = async (input: string, init?: RequestInit) => {
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
          log('Fetch error:', String(error));
        }
        return {};
      };

      const { runId } = await fetchAndLog(
        '/api/trigger?workflowFile=workflows/0_demo.ts&workflowFn=calc&args=2',
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

    runWorkflow();
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h1>Workflows DevKit + TanStack Example</h1>
      <hr />
      <textarea
        value={output}
        readOnly
        placeholder="output"
        style={{
          width: '100%',
          height: 'calc(100vh - 140px)',
          maxHeight: 'calc(100vh - 140px)',
          boxSizing: 'border-box',
          padding: '8px',
          fontFamily: 'monospace',
          fontSize: '14px',
          resize: 'none',
          overflow: 'auto',
          marginTop: '10px',
        }}
      />
    </div>
  );
}
