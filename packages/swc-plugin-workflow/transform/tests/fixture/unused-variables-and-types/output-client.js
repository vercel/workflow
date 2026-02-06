/**__internal_workflows{"steps":{"step//./input//sendRecipientEmail":{"name":"sendRecipientEmail","source":"input.js"}}}*/;
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
