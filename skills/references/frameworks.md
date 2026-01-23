# Framework Setup

## Table of Contents
- [Next.js](#nextjs)
- [Express](#express)
- [Hono](#hono)
- [Vite](#vite)
- [Astro](#astro)
- [Fastify](#fastify)
- [Nitro](#nitro)
- [Nuxt](#nuxt)
- [SvelteKit](#sveltekit)

## Next.js

```bash
npm create next-app@latest my-app && cd my-app && npm i workflow
```

**next.config.ts:**
```typescript
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default withWorkflow(nextConfig);
```

**tsconfig.json** (optional IDE support):
```json
{ "compilerOptions": { "plugins": [{ "name": "workflow" }] } }
```

**API Route:**
```typescript
// app/api/signup/route.ts
import { start } from "workflow/api";
import { handleUserSignup } from "@/workflows/user-signup";

export async function POST(req: Request) {
  const { email } = await req.json();
  await start(handleUserSignup, [email]);
  return Response.json({ message: "Workflow started" });
}
```

## Express

```bash
mkdir my-app && cd my-app && npm init -y
npm i workflow express nitro rollup && npm i -D @types/express
```

**nitro.config.ts:**
```typescript
import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  modules: ["workflow/nitro"],
  vercel: { entryFormat: "node" },
  routes: { "/**": { handler: "./src/index.ts", format: "node" } },
});
```

**src/index.ts:**
```typescript
import express from "express";
import { start } from "workflow/api";

const app = express();
app.use(express.json());

app.post("/api/signup", async (req, res) => {
  await start(handleUserSignup, [req.body.email]);
  return res.json({ message: "Workflow started" });
});

export default app;
```

## Hono

```bash
npm create hono@latest my-app -- --template=nodejs
cd my-app && npm i workflow nitro rollup
```

**nitro.config.ts:**
```typescript
import { defineConfig } from "nitro";

export default defineConfig({
  modules: ["workflow/nitro"],
  routes: { "/**": "./src/index.ts" }
});
```

## Vite

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app && npm i workflow nitro rollup
```

**vite.config.ts:**
```typescript
import { defineConfig } from "vite";
import { nitro } from "nitro/plugin";
import { workflow } from "workflow/vite";

export default defineConfig({
  plugins: [nitro({ serverDir: "." }), workflow()],
});
```

## Astro

```bash
npm create astro@latest my-app -- --template minimal --install --yes
cd my-app && npm i workflow
```

**astro.config.mjs:**
```typescript
import { defineConfig } from "astro/config";
import { workflow } from "workflow/astro";

export default defineConfig({ integrations: [workflow()] });
```

**src/pages/api/signup.ts:**
```typescript
import type { APIRoute } from "astro";
import { start } from "workflow/api";

export const POST: APIRoute = async ({ request }) => {
  const { email } = await request.json();
  await start(handleUserSignup, [email]);
  return Response.json({ message: "Workflow started" });
};
```

## Fastify

```bash
mkdir my-app && cd my-app && npm init -y
npm i workflow fastify nitro rollup && npm i -D @types/node typescript
```

**nitro.config.ts:**
```typescript
import { defineNitroConfig } from "nitro/config";
export default defineNitroConfig({ modules: ["workflow/nitro"] });
```

## Nitro

```bash
npx create-nitro-app my-app && cd my-app && npm i workflow
```

**nitro.config.ts:**
```typescript
export default defineConfig({
  serverDir: "./server",
  modules: ["workflow/nitro"],
});
```

## Nuxt

```bash
npm create nuxt@latest my-app && cd my-app && npm i workflow
```

**nuxt.config.ts:**
```typescript
export default defineNuxtConfig({
  modules: ["workflow/nuxt"],
  compatibilityDate: "latest",
});
```

## SvelteKit

```bash
npx sv create my-app --template=minimal --types=ts --no-add-ones
cd my-app && npm i workflow
```

**vite.config.ts:**
```typescript
import { sveltekit } from "@sveltejs/kit/vite";
import { workflowPlugin } from "workflow/sveltekit";

export default { plugins: [sveltekit(), workflowPlugin()] };
```

## Run and Inspect

```bash
# Start your app on the default port (3000)
npm run dev

# In a separate terminal, open the dashboard
npx workflow web
```

**Important:** The dashboard (`npx workflow web`) connects to your app at `http://localhost:3000` by default. If your app runs on a different port, specify it:

```bash
# If your app is on port 3001
npx workflow web --app-url http://localhost:3001
```

The dashboard opens at `http://localhost:3456` and shows:
- **Workflows tab:** Lists registered workflow functions
- **Runs tab:** Shows triggered workflow runs with status and events

**Troubleshooting:** If runs don't appear:
1. Ensure your app is running on the expected port
2. Restart the dashboard after starting your app
3. Check that workflows are being triggered (API returns `runId`)
4. Workflow data is stored in `.next/workflow-data/` (Next.js) or `.workflow-data/`

## HTTP Endpoints (Auto-generated)

| Endpoint | Purpose |
|----------|---------|
| `POST /.well-known/workflow/v1/flow` | Execute workflow |
| `POST /.well-known/workflow/v1/step` | Execute step |
| `POST /.well-known/workflow/v1/webhook/:token` | Deliver webhook |
