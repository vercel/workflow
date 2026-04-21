# aws-task-token-parallel

## Prompt

Migrate the following Step Functions workflow to the Workflow SDK.

```json
{
  "StartAt": "WaitForApproval",
  "States": {
    "WaitForApproval": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
      "Next": "ParallelWork"
    },
    "ParallelWork": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "ReserveInventory",
          "States": {
            "ReserveInventory": {
              "Type": "Task",
              "End": true
            }
          }
        },
        {
          "StartAt": "ChargePayment",
          "States": {
            "ChargePayment": {
              "Type": "Task",
              "End": true
            }
          }
        }
      ],
      "Next": "WaitOneDay"
    },
    "WaitOneDay": {
      "Type": "Wait",
      "Seconds": 86400,
      "End": true
    }
  }
}
```

## Must include

- `"use workflow"`
- `createHook()` or `createWebhook()`
- `Promise.all`
- `sleep('1d')`
- `"use step"` task functions

## Must not include

- ASL JSON in the final migrated code
- Lambda handler stubs
- task token plumbing
- `States.` error strings unless they are comments about the source

## Expected excerpt

```ts
await Promise.all([
  reserveInventory(orderId),
  chargePayment(orderId),
]);
await sleep('1d');
```
