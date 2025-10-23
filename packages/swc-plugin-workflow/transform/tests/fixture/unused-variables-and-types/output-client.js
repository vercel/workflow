import { runStep as __private_run_step } from "workflow/api";
/**__internal_workflows{"steps":{"input.js":{"sendRecipientEmail":{"stepId":"step//input.js//sendRecipientEmail"}}}}*/;
export const sendRecipientEmail = async ({ recipientEmail, cardImage, cardText, rsvpReplies })=>__private_run_step("sendRecipientEmail", {
        arguments: [
            {
                recipientEmail,
                cardImage,
                cardText,
                rsvpReplies
            }
        ]
    });
export function normalFunction() {
    return 'this stays because it is exported';
}
