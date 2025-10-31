import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import viteTsConfigPaths from 'vite-tsconfig-paths';
import { workflowRollupPlugin } from 'workflow/rollup-plugin';

const config = defineConfig({
  plugins: [
    workflowRollupPlugin(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    nitro({
      config: {
        modules: ['workflow/nitro'],
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});

export default config;
