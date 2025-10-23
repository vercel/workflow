# Workflows with Nitro v3

Learn more about Nitro: https://v3.nitro.build/

## Commands

**Local development:**

```sh
npm run dev
```

**Production build (Vercel):**

```sh
NITRO_PRESET=vercel npm run build
npx vercel --prebuilt
```

**Production build (Node.js):**

```sh
npm run build
node .output/server/index.mjs
```
