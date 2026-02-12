import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    rollupOptions: isSsrBuild ? { input: './server/app.ts' } : undefined,
  },
  // Bundle all dependencies into the server build so that @workflow/web
  // can be installed and run without needing any of the UI dependencies
  // (Radix, lucide-react, etc.) at runtime. Only Node.js built-ins and
  // express (needed by server.js) remain external.
  ssr: {
    noExternal: true,
    external: ['express'],
  },
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: [{ find: '~', replacement: '/app' }],
  },
}));
