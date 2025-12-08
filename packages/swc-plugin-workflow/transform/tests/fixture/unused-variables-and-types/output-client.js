import { Resend } from 'resend';
import { generatePostcardEmailTemplate } from '@/lib/template';
/**__internal_workflows{"steps":{"input.js":{"sendRecipientEmail":{"stepId":"step//input.js//sendRecipientEmail"}}}}*/;
const resend = new Resend(process.env.RESEND_API_KEY);
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
