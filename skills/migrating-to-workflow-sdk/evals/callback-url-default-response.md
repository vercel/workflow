# callback-url-default-response

## Prompt

Migrate the following Step Functions workflow to the Workflow SDK.

```json
{
  "StartAt": "WaitForVerification",
  "States": {
    "WaitForVerification": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
      "End": true
    }
  }
}
```

The external vendor needs a callback URL. A default HTTP 202 response is fine. Do not add a custom callback route.

## Must include

- `"use workflow"`
- `createWebhook()`
- `webhook.url`

## Must not include

- `resumeHook`
- `respondWith: 'manual'`
- `RequestWithResponse`
- invented callback route

## Expected excerpt

```ts
using verification = createWebhook();
await sendVerificationRequest(documentId, verification.url);
const request = await verification;
const payload = await request.json();
```
