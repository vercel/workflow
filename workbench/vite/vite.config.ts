import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { workflow } from 'workflow/vite'

export default defineConfig({
  plugins: [nitro(), workflow()]
});
