# Generate migrations

The migrations are generated and managed by drizzle. When you perform schema changes you have to generate new migrations using the following command:

```
pnpm drizzle-kit generate --dialect=postgresql --schema=./src/drizzle/schema.ts --out src/drizzle/migrations
```
