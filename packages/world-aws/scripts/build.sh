#!/bin/bash
set -e

echo "🔨 Building Lambda deployment package with Docker bundling..."
echo ""

# Determine if we're running from the package or from a user's project
if [ -n "$AWS_WORKFLOW_PACKAGE_ROOT" ]; then
  # Running from user's project via npx
  PACKAGE_ROOT="$AWS_WORKFLOW_PACKAGE_ROOT"
  PROJECT_ROOT="$(pwd)"
else
  # Running from within the package (development mode)
  PACKAGE_ROOT="$(pwd)"
  PROJECT_ROOT="$PACKAGE_ROOT/examples/nextjs-example"
fi

# ============================================================================
# STEP 0: Compile TypeScript (Lambda handler as ESM, world as CommonJS)
# ============================================================================
echo "📦 Step 0/3: Compiling TypeScript..."
cd "$PACKAGE_ROOT"
pnpm tsc --build
echo "   Compiling Lambda handler as ESM..."
pnpm tsc --project lambda/tsconfig.json
echo "   ✓ TypeScript compiled"
echo ""

# ============================================================================
# STEP 1: Build Next.js app to generate workflow bundles
# ============================================================================
echo "📦 Step 1/3: Building Next.js workflow bundles..."

cd "$PROJECT_ROOT"

# IMPORTANT: Use npm instead of pnpm to avoid .pnpm path issues in generated route files
if [ ! -f "package-lock.json" ]; then
  echo "   Installing Next.js dependencies with npm (first time)..."
  echo "   This creates flat node_modules without .pnpm symlinks..."
  rm -rf node_modules pnpm-lock.yaml
  npm install --legacy-peer-deps
fi

# Build Next.js (generates workflow bundles via withWorkflow())
# IMPORTANT: Unset AWS credentials to prevent them from being bundled
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
export WORKFLOW_TARGET_WORLD=aws-workflow

npm run build

cd "$PACKAGE_ROOT"

echo "   ✓ Workflow bundles generated"
echo ""

# ============================================================================
# STEP 2: Prepare Lambda bundle directory (Docker will install dependencies)
# ============================================================================
echo "📦 Step 2/3: Preparing Lambda bundle..."

rm -rf cdk.out/lambda-bundle
mkdir -p cdk.out/lambda-bundle

# Copy workflow route files
echo "   Copying workflow routes..."
mkdir -p cdk.out/lambda-bundle/.well-known/workflow/v1/flow
mkdir -p cdk.out/lambda-bundle/.well-known/workflow/v1/step
cp "$PROJECT_ROOT/app/.well-known/workflow/v1/flow/route.js" cdk.out/lambda-bundle/.well-known/workflow/v1/flow/
cp "$PROJECT_ROOT/app/.well-known/workflow/v1/step/route.js" cdk.out/lambda-bundle/.well-known/workflow/v1/step/

# Copy Lambda handler (from compiled dist directory) - now ESM
echo "   Copying Lambda handler..."
cp dist/lambda/worker/index.js cdk.out/lambda-bundle/index.js

# Create minimal package.json (ESM for both handler and route files)
echo "   Creating package.json..."
cat > cdk.out/lambda-bundle/package.json << 'EOF'
{
  "name": "workflow-lambda-worker",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "@vercel/queue": "0.0.0-alpha.23",
    "@workflow/errors": "4.0.1-beta.1",
    "@workflow/world": "4.0.1-beta.1",
    "workflow": "4.0.1-beta.1",
    "ulid": "^3.0.1",
    "zod": "^4.1.11"
  }
}
EOF

# Install dependencies with npm (flat structure, no Docker needed!)
echo "   Installing dependencies with npm (flat structure)..."
cd cdk.out/lambda-bundle
npm install --production --no-package-lock --legacy-peer-deps --quiet

# Clean up unnecessary packages to reduce size
echo "   Cleaning up unnecessary packages..."
# Remove build-time only packages
rm -rf node_modules/typescript node_modules/@types
rm -rf node_modules/esbuild node_modules/@esbuild
rm -rf node_modules/@swc node_modules/@img
rm -rf node_modules/.bin

# Remove AWS SDK (already available in Lambda runtime)
rm -rf node_modules/@aws-sdk node_modules/@smithy node_modules/@aws-crypto

# Remove Next.js packages (not needed in Lambda)
rm -rf node_modules/next node_modules/@next
rm -rf node_modules/react node_modules/react-dom
rm -rf node_modules/@babel node_modules/webpack
rm -rf node_modules/postcss node_modules/tailwindcss

# Remove other large unnecessary packages
rm -rf node_modules/date-fns node_modules/lodash
rm -rf node_modules/.cache

# ============================================================================
# STEP 3: Bundle aws-workflow package AFTER npm install (so it doesn't get removed)
# ============================================================================
echo "📦 Step 3/3: Bundling aws-workflow package..."
mkdir -p node_modules/aws-workflow
cd ../../

# Use esbuild to bundle dist/world/index.js with all @workflow dependencies inlined
npx esbuild dist/world/index.js \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile=cdk.out/lambda-bundle/node_modules/aws-workflow/index.js \
  --external:@aws-sdk/* \
  --external:ulid \
  --external:ms \
  --external:zod

# Create package.json for aws-workflow
cat > cdk.out/lambda-bundle/node_modules/aws-workflow/package.json << 'EOF'
{
  "name": "aws-workflow",
  "type": "commonjs",
  "main": "index.js"
}
EOF

cd cdk.out/lambda-bundle
echo "   Final bundle size: $(du -sh . | cut -f1)"
echo "   node_modules size: $(du -sh node_modules | cut -f1)"

cd ../..

echo "   ✓ Lambda bundle ready ($(du -sh cdk.out/lambda-bundle | cut -f1))"
echo ""

echo "✅ Build complete!"
echo "   • Lambda Bundle: cdk.out/lambda-bundle/ ($(du -sh cdk.out/lambda-bundle | cut -f1))"
echo "   • Ready to deploy with: cdk deploy (no Docker required!)"
echo ""

