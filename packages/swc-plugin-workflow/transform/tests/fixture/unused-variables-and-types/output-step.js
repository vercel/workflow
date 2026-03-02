import { registerStepFunction } from "workflow/internal/private";
import { Resend } from 'resend';
import { generatePostcardEmailTemplate } from '@/lib/template';
import { unusedImport } from './unused';
/**__internal_workflows{"steps":{"input.js":{"sendRecipientEmail":{"stepId":"step//./input//sendRecipientEmail"}}}}*/;
const resend = new Resend(process.env.RESEND_API_KEY);
const unusedVariable = 'this should be removed';
function unusedHelper() {
    return 'this should also be removed';
}
const unusedObject = {
    key: 'value',
    nested: {
        data: 'unused'
    }
};
export const sendRecipientEmail = async ({ recipientEmail, cardImage, cardText, rsvpReplies })=>{
    const html = generatePostcardEmailTemplate({
        cardImage,
        cardText,
        rsvpReplies
    });
    await resend.emails.send({
        from: 'postcard@example.com',
        to: recipientEmail,
        subject: 'Your Postcard',
        html
    });
};
export function normalFunction() {
    return 'this stays because it is exported';
}
registerStepFunction("step//./input//sendRecipientEmail", sendRecipientEmail);
