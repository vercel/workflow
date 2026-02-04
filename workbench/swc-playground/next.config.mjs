/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@swc/core', '@workflow/swc-plugin'],
  outputFileTracingIncludes: {
    '/*': ['node_modules/@workflow/swc-plugin/swc_plugin_workflow.wasm'],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
