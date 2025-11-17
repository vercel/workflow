import { defineConfig } from "nitro";

<<<<<<< HEAD
export default defineConfig({
  modules: ["workflow/nitro"],
  routes: {
    "/**": "./src/index.ts",
  },
=======
export default defineNitroConfig({
  modules: ['workflow/nitro'],
  handlers: [
    {
      route: '/api/**',
      handler: './server.ts',
    },
  ],
>>>>>>> 4bdc6c3a (fix(nitro): externalize .nitro/workflow folder)
});
