import { defineNuxtConfig } from 'nuxt/config';
import { workflowRollupPlugin } from 'workflow/rollup-plugin';

export default defineNuxtConfig({
  compatibilityDate: 'latest',
  nitro: {
    modules: ['workflow/nitro'],
  }
});
