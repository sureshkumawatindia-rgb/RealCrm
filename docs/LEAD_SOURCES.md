# Lead sources

Settings → **Lead sources** (owners and admins). Every enquiry becomes a contact and a lead:

- the same mobile number is never added twice (numbers without a country code are Indian, +91);
- the same enquiry from a source is taken only once;
- if the person already has an open lead, the new enquiry is added to that lead (see "Enquiry" in its activity) and its follow-up moves to today;
- each source shows counters and its latest enquiries with what became of them.

## Website form

1. Settings → Lead sources → **New website form**.
2. Copy the code it shows and paste it into your website where the form should appear:

   ```html
   <div data-yellow-crm-form="<your form key>"></div>
   <script src="https://<your CRM address>/api/v1/public/forms/<your form key>/embed.js" async></script>
   ```

   The form asks for name and mobile number, plus the fields you tick under *Form options* (email, company, city, product, requirement). Changes reach websites within 5 minutes.
3. A website builder that does not allow scripts can use the plain HTML form shown under "Website without JavaScript?".
4. *Preview* shows the real form inside the CRM; sending it creates a real enquiry.

Protection: at most `RATE_LIMIT_FORM_PER_MINUTE` enquiries per minute from one address (default 10), a hidden field that catches bots, and optionally a list of websites allowed to use the form. *Pause* refuses enquiries until you resume.

The CRM must be reachable from the internet for a real website to send enquiries (on a server with HTTPS, or through a tunnel while testing; see WHATSAPP_SETUP.md section 3). `PUBLIC_URL` in backend/.env must be that public address, because the embed code points to it.

## Testing without a real source

In development, *Try it: receive a test lead* pretends an enquiry arrived from IndiaMART, a website, JustDial and so on.

## Coming next

IndiaMART (4B), Facebook Lead Ads, Google Ads lead forms and JustDial/TradeIndia (4C), then auto-replies and assignment rules (4D).
