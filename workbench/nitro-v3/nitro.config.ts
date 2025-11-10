import { defineConfig } from "nitro";

<<<<<<< HEAD
export default defineConfig({
  modules: ["workflow/nitro"],
  serverDir: "./",
=======
export default defineNitroConfig({
  serverDir: './',
  modules: [
    'workflow/nitro'
  ],
  // Workaround for monorepo symlinks
  noExternals: true,
  rollupConfig: {
    watch: {
      exclude: ['**/.workflow-data/**', '**/node_modules/**']
    }
  }
>>>>>>> 2d31493b (update workaround)
});
