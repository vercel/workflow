import { w as x, r as d, j as r } from './chunk-WWGJGFF6-DfkQwNBd.js';
function h(p) {
  return [
    { title: 'Workflow DevKit + React Router Example' },
    {
      name: 'description',
      content: 'Workflow DevKit running with React Router',
    },
  ];
}
const m = x(function () {
  const c = d.useRef(null);
  return (
    d.useEffect(() => {
      const i = c.current;
      if (!i) return;
      function o(...t) {
        i &&
          (i.textContent +=
            t
              .map((n) => (typeof n == 'string' ? n : JSON.stringify(n)))
              .join(' ') +
            `
`);
      }
      function l(t) {
        try {
          return JSON.stringify(JSON.parse(t), null, 2);
        } catch {
          return t;
        }
      }
      async function u(t, n) {
        try {
          const e = new Request(t, n);
          o(`[${e.method}] ${t}`);
          const a = await fetch(e),
            s = await a.text();
          if (a.ok) return o('Response:', l(s)), JSON.parse(s);
          o('Error', a.status, a.statusText, l(s));
        } catch (e) {
          o('Fetch error:', e instanceof Error ? e.toString() : String(e));
        }
        return {};
      }
      async function f() {
        const { runId: t } = await u(
          '/api/trigger?workflowFile=workflows/0_calc.ts&workflowFn=calc&args=2',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '',
          }
        );
        t &&
          (o('Getting workflow status with runId:', t),
          await u(`/api/trigger?runId=${t}`));
      }
      f().catch((t) =>
        o('Main error:', t instanceof Error ? t.toString() : String(t))
      );
    }, []),
    r.jsxs(r.Fragment, {
      children: [
        r.jsx('style', {
          children: `
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
        `,
        }),
        r.jsx('h1', { children: 'Workflow DevKit + React Router Example' }),
        r.jsx('hr', {}),
        r.jsx('textarea', { ref: c, readOnly: !0, placeholder: 'output' }),
      ],
    })
  );
});
export { m as default, h as meta };
