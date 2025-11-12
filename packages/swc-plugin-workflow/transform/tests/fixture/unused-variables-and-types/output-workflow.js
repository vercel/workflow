/**__internal_workflows{"steps":{"input.js":{"sendRecipientEmail":{"stepId":"step//input.js//sendRecipientEmail"}}}}*/;
export const sendRecipientEmail = async ({ recipientEmail, cardImage, cardText, rsvpReplies })=>globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//sendRecipientEmail")({
        recipientEmail,
        cardImage,
        cardText,
        rsvpReplies
    });
export function normalFunction() {
    return 'this stays because it is exported';
}
Object.defineProperty(sendRecipientEmail, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//sendRecipientEmail",
    writable: false,
    enumerable: false,
    configurable: false
});
