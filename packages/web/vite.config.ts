import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    rollupOptions: isSsrBuild ? { input: './server/app.ts' } : undefined,
  },
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: [{ find: '~', replacement: '/app' }],
  },
}));
