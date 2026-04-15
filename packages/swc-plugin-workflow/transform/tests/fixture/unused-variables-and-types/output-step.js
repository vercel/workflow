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
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "sendRecipientEmail",
        configurable: true
    });
})(sendRecipientEmail, "step//./input//sendRecipientEmail");
export function normalFunction() {
    return 'this stays because it is exported';
}
