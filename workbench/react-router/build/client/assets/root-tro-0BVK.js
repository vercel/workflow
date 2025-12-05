import {
  w as a,
  a as i,
  j as s,
  M as c,
  L as l,
  S as p,
  b as u,
  O as h,
  i as d,
} from './chunk-WWGJGFF6-DfkQwNBd.js';
const m = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
];
function f({ children: e }) {
  return s.jsxs('html', {
    lang: 'en',
    children: [
      s.jsxs('head', {
        children: [
          s.jsx('meta', { charSet: 'utf-8' }),
          s.jsx('meta', {
            name: 'viewport',
            content: 'width=device-width, initial-scale=1',
          }),
          s.jsx(c, {}),
          s.jsx(l, {}),
        ],
      }),
      s.jsxs('body', { children: [e, s.jsx(p, {}), s.jsx(u, {})] }),
    ],
  });
}
const j = a(function () {
    return s.jsx(h, {});
  }),
  g = i(function ({ error: t }) {
    let n = 'Oops!',
      o = 'An unexpected error occurred.',
      r;
    return (
      d(t) &&
        ((n = t.status === 404 ? '404' : 'Error'),
        (o =
          t.status === 404
            ? 'The requested page could not be found.'
            : t.statusText || o)),
      s.jsxs('main', {
        className: 'pt-16 p-4 container mx-auto',
        children: [
          s.jsx('h1', { children: n }),
          s.jsx('p', { children: o }),
          r,
        ],
      })
    );
  });
export { g as ErrorBoundary, f as Layout, j as default, m as links };
