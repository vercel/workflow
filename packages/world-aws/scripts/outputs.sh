#!/bin/bash

# Script to extract CloudFormation outputs and format as environment variables

set -e

STACK_NAME=${1:-WorkflowStack}
AWS_REGION=${AWS_REGION:-$(aws configure get region || echo "us-east-1")}

# Check if stack exists
if ! aws cloudformation describe-stacks --stack-name $STACK_NAME --region $AWS_REGION &>/dev/null; then
    echo "Error: Stack '$STACK_NAME' not found in region $AWS_REGION"
    echo "Run 'pnpm bootstrap' first to deploy the infrastructure"
    exit 1
fi

# Get outputs as key-value pairs
OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
    --output text)

# Print environment variables
echo "# AWS Workflow Environment Variables"
echo "# Generated: $(date)"
echo "# Stack: $STACK_NAME"
echo "# Region: $AWS_REGION"
echo ""
echo "WORKFLOW_TARGET_WORLD=aws-workflow"
echo ""

# Parse and format outputs
while IFS=$'\t' read -r key value; do
    case "$key" in
        *QueueUrl*)
            # Queue URLs
            if [[ "$key" == *"Workflow"* ]]; then
                echo "WORKFLOW_AWS_WORKFLOW_QUEUE_URL=$value"
            elif [[ "$key" == *"Step"* ]]; then
                echo "WORKFLOW_AWS_STEP_QUEUE_URL=$value"
            fi
            ;;
        *TableName*)
            # DynamoDB tables
            if [[ "$value" == *"_runs" ]]; then
                echo "WORKFLOW_AWS_RUNS_TABLE=$value"
            elif [[ "$value" == *"_steps" ]]; then
                echo "WORKFLOW_AWS_STEPS_TABLE=$value"
            elif [[ "$value" == *"_events" ]]; then
                echo "WORKFLOW_AWS_EVENTS_TABLE=$value"
            elif [[ "$value" == *"_hooks" ]]; then
                echo "WORKFLOW_AWS_HOOKS_TABLE=$value"
            elif [[ "$value" == *"chunks" ]]; then
                echo "WORKFLOW_AWS_STREAMS_TABLE=$value"
            fi
            ;;
        *BucketName*)
            # S3 bucket
            echo "WORKFLOW_AWS_STREAM_BUCKET=$value"
            ;;
        *FunctionName*)
            # Lambda function (for reference)
            echo "# Lambda Function: $value"
            ;;
    esac
done <<< "$OUTPUTS"

echo ""
echo "# Add your AWS credentials (for local development only):"
echo "# AWS_ACCESS_KEY_ID=your-access-key-id"
echo "# AWS_SECRET_ACCESS_KEY=your-secret-access-key"
echo "# AWS_REGION=$AWS_REGION"

