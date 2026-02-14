import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command, isSsrBuild }) => ({
  build: {
    rollupOptions: isSsrBuild ? { input: './server/app.ts' } : undefined,
  },
  // Bundle all dependencies into the server build so that @workflow/web
  // can be installed and run without needing any of the UI dependencies
  // (Radix, lucide-react, etc.) at runtime. Only Node.js built-ins and
  // express (needed by server.js) remain external.
  //
  // During dev (`react-router dev`), Vite's SSR module runner evaluates
  // modules using its ESM evaluator which cannot handle CJS packages
  // (they fail with "module/exports is not defined"). We disable
  // noExternal for dev so dependencies are loaded natively by Node.js.
  ssr: {
    noExternal: command === 'build' ? true : undefined,
    external: ['express'],
  },
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    // Ensure all workspace packages resolve React from the same location
    // to prevent duplicate React instances (which cause "Invalid hook call"
    // errors). This is necessary during dev when noExternal is not set and
    // linked workspace packages might resolve their own copy of React.
    dedupe: ['react', 'react-dom'],
    alias: [{ find: '~', replacement: '/app' }],
  },
}));
