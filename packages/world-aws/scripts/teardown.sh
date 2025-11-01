#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
REGION=${AWS_REGION:-us-east-1}
STACK_NAME="WorkflowStack"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      REGION="$2"
      shift 2
      ;;
    --stack-name)
      STACK_NAME="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --region REGION        AWS region (default: us-east-1)"
      echo "  --stack-name NAME      CloudFormation stack name (default: WorkflowStack)"
      echo "  -h, --help             Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run with --help for usage information"
      exit 1
      ;;
  esac
done

export AWS_REGION=$REGION

# Try to load defaults from .env.aws if present (matches bootstrap/deploy output)
if [ -f ".env.aws" ]; then
  if [ -z "$STACK_NAME" ]; then
    DETECTED_STACK_NAME=$(grep "^AWS_WORKFLOW_STACK_NAME=" .env.aws | cut -d'=' -f2)
    if [ -n "$DETECTED_STACK_NAME" ]; then STACK_NAME="$DETECTED_STACK_NAME"; fi
  fi
  if [ -z "$REGION" ] || [ -z "$AWS_REGION" ]; then
    DETECTED_REGION=$(grep "^AWS_REGION=" .env.aws | cut -d'=' -f2)
    if [ -n "$DETECTED_REGION" ]; then REGION="$DETECTED_REGION"; AWS_REGION="$DETECTED_REGION"; export AWS_REGION; fi
  fi
fi

echo -e "${RED}╔════════════════════════════════════════╗${NC}"
echo -e "${RED}║  AWS Workflow Teardown Script         ║${NC}"
echo -e "${RED}╚════════════════════════════════════════╝${NC}"
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}✗ AWS CLI is not installed${NC}"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}✗ AWS credentials not configured${NC}"
    echo "  Please run: aws configure"
    exit 1
fi

AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo -e "${YELLOW}⚠️  WARNING: This will DELETE all AWS resources:${NC}"
echo ""
echo "  Region: ${REGION}"
echo "  Stack: ${STACK_NAME}"
echo ""
echo "  • DynamoDB Tables:"
echo "    - workflow_runs"
echo "    - workflow_steps"
echo "    - workflow_events"
echo "    - workflow_hooks"
echo "    - workflow_stream_chunks"
echo ""
echo "  • SQS Queues:"
echo "    - workflow-flows"
echo "    - workflow-steps"
echo "    - workflow-dlq"
echo ""
echo "  • S3 Bucket:"
echo "    - workflow-streams-${AWS_ACCOUNT}-${REGION}"
echo ""
echo "  • Lambda Function:"
echo "    - workflow-worker (and its layer)"
echo ""
echo "  • CloudFormation Stack:"
echo "    - ${STACK_NAME}"
echo ""
echo -e "${RED}🗑️  All workflow runs, steps, and data will be PERMANENTLY DELETED!${NC}"
echo ""

read -p "Are you absolutely sure you want to continue? (type 'yes' to confirm) " -r
echo
if [[ $REPLY != "yes" ]]; then
    echo -e "${BLUE}Teardown cancelled${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}🗑️  Destroying AWS resources...${NC}"

# Helper to read CloudFormation outputs safely
get_stack_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text 2>/dev/null || echo ""
}

# Purge SQS queues first (to avoid Lambda invocations during deletion)
echo -e "${BLUE}1/5 Purging SQS queues...${NC}"
WORKFLOW_QUEUE_URL=$(get_stack_output "WorkflowQueueUrl")
STEP_QUEUE_URL=$(get_stack_output "StepQueueUrl")

if [ -n "$WORKFLOW_QUEUE_URL" ]; then
  echo "  Purging: workflow queue"
  aws sqs purge-queue --queue-url "$WORKFLOW_QUEUE_URL" --region $REGION 2>/dev/null || true
fi
if [ -n "$STEP_QUEUE_URL" ]; then
  echo "  Purging: step queue"
  aws sqs purge-queue --queue-url "$STEP_QUEUE_URL" --region $REGION 2>/dev/null || true
fi

# Fallback to default names if outputs missing
if [ -z "$WORKFLOW_QUEUE_URL" ] || [ -z "$STEP_QUEUE_URL" ]; then
  for queue in workflow-flows workflow-steps; do
      QUEUE_URL=$(aws sqs get-queue-url --queue-name $queue --region $REGION --output text 2>/dev/null || echo "")
      if [ -n "$QUEUE_URL" ]; then
          echo "  Purging: $queue"
          aws sqs purge-queue --queue-url "$QUEUE_URL" --region $REGION 2>/dev/null || true
      fi
  done
fi

# Empty S3 bucket (required before deletion)
echo -e "${BLUE}2/5 Emptying S3 bucket...${NC}"
# Resolve bucket name from stack outputs if possible
BUCKET_NAME=$(get_stack_output "StreamBucketName")
if [ -z "$BUCKET_NAME" ]; then
  BUCKET_NAME="workflow-streams-${AWS_ACCOUNT}-${REGION}"
fi

# Only proceed if bucket exists
if aws s3api head-bucket --bucket "$BUCKET_NAME" --region $REGION 2>/dev/null; then
  echo "  Emptying: $BUCKET_NAME"
  VERSIONING_STATUS=$(aws s3api get-bucket-versioning --bucket "$BUCKET_NAME" --region $REGION --query 'Status' --output text 2>/dev/null || echo "")
  if [ "$VERSIONING_STATUS" = "Enabled" ] || [ "$VERSIONING_STATUS" = "Suspended" ]; then
    # Delete all object versions
    while true; do
      DELETE_VERSIONS_JSON=$(aws s3api list-object-versions \
        --bucket "$BUCKET_NAME" \
        --region $REGION \
        --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}, Quiet: true}' \
        --output json)
      if echo "$DELETE_VERSIONS_JSON" | grep -q '"Objects": \[\]'; then break; fi
      aws s3api delete-objects --bucket "$BUCKET_NAME" --region $REGION --delete "$DELETE_VERSIONS_JSON" >/dev/null 2>&1 || true
    done
    # Delete all delete markers
    while true; do
      DELETE_MARKERS_JSON=$(aws s3api list-object-versions \
        --bucket "$BUCKET_NAME" \
        --region $REGION \
        --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}, Quiet: true}' \
        --output json)
      if echo "$DELETE_MARKERS_JSON" | grep -q '"Objects": \[\]'; then break; fi
      aws s3api delete-objects --bucket "$BUCKET_NAME" --region $REGION --delete "$DELETE_MARKERS_JSON" >/dev/null 2>&1 || true
    done
  fi
  # Remove any remaining current objects (non-versioned or after version cleanup)
  aws s3 rm "s3://${BUCKET_NAME}" --recursive --region $REGION >/dev/null 2>&1 || true
fi

# Delete CloudFormation stack
echo -e "${BLUE}3/5 Deleting CloudFormation stack...${NC}"
STACK_EXISTS=false
if aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION &>/dev/null; then
  STACK_EXISTS=true
fi

if [ "$STACK_EXISTS" = true ]; then
  echo "  Deleting: $STACK_NAME"
  aws cloudformation delete-stack --stack-name $STACK_NAME --region $REGION
  echo "  Waiting for stack deletion (this may take a few minutes)..."
  if aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME --region $REGION; then
    STACK_EXISTS=false
  else
    echo -e "${YELLOW}⚠️  Stack deletion did not complete. Attempting cleanup and retry...${NC}"
  fi
else
  echo "  Stack not found (may have been deleted manually)"
fi

# Clean up any orphaned resources (in case CDK deletion failed)
echo -e "${BLUE}4/5 Cleaning up any orphaned resources...${NC}"

# Resolve resource identifiers from stack outputs when available
WORKER_FUNCTION_ARN=$(get_stack_output "WorkerFunctionArn")
if [ -n "$WORKER_FUNCTION_ARN" ]; then
  WORKER_FUNCTION_NAME=${WORKER_FUNCTION_ARN##*:function:}
else
  WORKER_FUNCTION_NAME="workflow-worker"
fi

# Delete Lambda function if it still exists
if aws lambda get-function --function-name "$WORKER_FUNCTION_NAME" --region $REGION &>/dev/null; then
    echo "  Deleting orphaned Lambda: $WORKER_FUNCTION_NAME"
    aws lambda delete-function --function-name "$WORKER_FUNCTION_NAME" --region $REGION || true
fi

# Delete CloudWatch log group for the Lambda if it exists
LOG_GROUP_NAME="/aws/lambda/${WORKER_FUNCTION_NAME}"
if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP_NAME" --region $REGION --query 'logGroups[?logGroupName==`'$LOG_GROUP_NAME'`]' --output text 2>/dev/null | grep -q "$LOG_GROUP_NAME"; then
  echo "  Deleting orphaned log group: $LOG_GROUP_NAME"
  aws logs delete-log-group --log-group-name "$LOG_GROUP_NAME" --region $REGION || true
fi

# Delete DynamoDB tables if they still exist (prefer names from outputs)
for output_key in RunsTableName StepsTableName EventsTableName HooksTableName StreamsTableName; do
  TBL=$(get_stack_output "$output_key")
  if [ -n "$TBL" ] && aws dynamodb describe-table --table-name "$TBL" --region $REGION &>/dev/null; then
    echo "  Deleting orphaned table: $TBL"
    aws dynamodb delete-table --table-name "$TBL" --region $REGION || true
  fi
done
# Fallback to default table names
for table in workflow_runs workflow_steps workflow_events workflow_hooks workflow_stream_chunks; do
  if aws dynamodb describe-table --table-name $table --region $REGION &>/dev/null; then
      echo "  Deleting orphaned table: $table"
      aws dynamodb delete-table --table-name $table --region $REGION || true
  fi
done

# Delete SQS queues if they still exist (prefer URLs from outputs)
for QURL in "$WORKFLOW_QUEUE_URL" "$STEP_QUEUE_URL"; do
  if [ -n "$QURL" ]; then
    echo "  Deleting orphaned queue: $QURL"
    aws sqs delete-queue --queue-url "$QURL" --region $REGION || true
  fi
done
# Also attempt by well-known names and DLQ
for queue in workflow-flows workflow-steps workflow-dlq; do
  QUEUE_URL=$(aws sqs get-queue-url --queue-name $queue --region $REGION --output text 2>/dev/null || echo "")
  if [ -n "$QUEUE_URL" ]; then
      echo "  Deleting orphaned queue: $queue"
      aws sqs delete-queue --queue-url "$QUEUE_URL" --region $REGION || true
  fi
done

# If stack still exists, try to delete the S3 bucket itself after emptying
if aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION &>/dev/null; then
  if aws s3api head-bucket --bucket "$BUCKET_NAME" --region $REGION 2>/dev/null; then
    echo "  Deleting orphaned bucket: $BUCKET_NAME"
    aws s3api delete-bucket --bucket "$BUCKET_NAME" --region $REGION 2>/dev/null || true
  fi
fi

# Clean up local artifacts
echo -e "${BLUE}5/5 Cleaning up local artifacts...${NC}"
rm -f .env.aws
rm -rf cdk.out

echo ""
if ! aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION &>/dev/null; then
  echo -e "${BLUE}✅ Teardown complete!${NC}"
  echo ""
  echo "All AWS resources have been deleted."
  echo ""
else
  echo -e "${YELLOW}⚠️  Stack still present or deletion in progress: $STACK_NAME${NC}"
  echo "Recent stack events:"
  aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION --max-items 20 2>/dev/null || true
  echo ""
  echo -e "${RED}Some resources could not be deleted automatically. Please inspect the CloudFormation stack in the AWS Console for details.${NC}"
  exit 1
fi

