# Workflows with ElysiaJS Node (Nitro v3)

- Learn more about ElysiaJS: https://elysiajs.com/
- Learn more about Nitro: https://v3.nitro.build/

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

**Production build (Bun):**

```sh
npm run build
bun run .output/server/index.mjs
```

## Limitations

Currently, Nitro does not support passing `idleTimeout` to the underlying Bun server that ElysiaJS uses. By default, Bun sets `idleTimeout = 10` seconds, which means workflow suspensions over 10 seconds will fail.
