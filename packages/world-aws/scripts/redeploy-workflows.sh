#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

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

# Default values
REGION=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      REGION="$2"
      shift 2
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Usage: $0 [--region REGION]"
      exit 1
      ;;
  esac
done

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Redeploy Workflows to Lambda         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}✗ AWS CLI is not installed${NC}"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}✗ AWS credentials not configured${NC}"
    exit 1
fi

# Determine region
if [ -n "$REGION" ]; then
  AWS_REGION="$REGION"
elif [ -n "$AWS_REGION" ]; then
  AWS_REGION="$AWS_REGION"
else
  AWS_REGION=$(aws configure get region || echo "us-east-1")
fi
echo -e "${GREEN}✓ AWS Region: $AWS_REGION${NC}"
echo ""

# Check if Next.js project directory exists
if [ ! -d "$PROJECT_ROOT" ]; then
    echo -e "${RED}✗ Next.js project directory not found: $PROJECT_ROOT${NC}"
    echo "  This script must be run from the aws-workflow directory"
    exit 1
fi

# Build everything (Next.js + Lambda packages)
echo -e "${BLUE}📦 Building Lambda packages...${NC}"
bash "$PACKAGE_ROOT/scripts/build.sh"

# Deploy with CDK (using pre-built bundle)
echo -e "${BLUE}🚀 Deploying to Lambda with CDK...${NC}"
echo ""

# Use npx to run CDK (works even if CDK not globally installed)
cd "$PACKAGE_ROOT"
npx cdk deploy \
    --region $AWS_REGION \
    --require-approval never \
    --outputs-file cdk.out/outputs.json

echo ""
echo -e "${BLUE}⏳ Waiting for Lambda update to complete...${NC}"
# Note: Lambda is deployed in us-east-1 (from CDK stack)
aws lambda wait function-updated \
    --region us-east-1 \
    --function-name workflow-worker

echo ""
echo -e "${GREEN}✅ Workflow redeploy complete!${NC}"
echo ""
echo -e "${YELLOW}📝 Note:${NC} Lambda may take a few seconds to start using the new code."
echo "         Old containers will be phased out automatically."
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  • Test your workflows by triggering them from your Next.js app"
echo "  • Check Lambda logs: aws logs tail /aws/lambda/workflow-worker --since 5m --region $AWS_REGION"
echo ""

