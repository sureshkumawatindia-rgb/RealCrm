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

## IndiaMART

1. In IndiaMART Seller Panel → Lead Manager → **Import/Export Leads** → CRM Integration, generate the **CRM API key** (IndiaMART emails it). A paid seller account is needed.
2. Settings → Lead sources → **Connect IndiaMART**, paste the key, choose the kinds of leads (direct enquiries, buy-leads, phone calls, WhatsApp enquiries; catalogue views are off by default) → **Connect**.
3. Within a minute the first pull brings the last 24 hours of leads. After that the CRM pulls every 5 minutes; IndiaMART blocks keys that are called more often, so the CRM never does (also not with **Pull now**).
4. Optional, for leads the moment they arrive: in Lead Manager → Import/Export Leads → **Push API**, enter the address shown on the IndiaMART card. IndiaMART only pushes to a public **https** address, so this works once the CRM runs on a server with HTTPS (or through a tunnel while testing). A lead that arrives by push and by pull is taken once.

Good to know:

- An IndiaMART key **expires after 7 days without use**. The CRM uses it every 5 minutes while the source is active; if IndiaMART refuses the key, the card says "Needs attention" and pulling stops until you press **New key** and paste a fresh one.
- If the CRM was switched off for more than 7 days, IndiaMART only gives the last 7 days; the card says so.
- IndiaMART calls unknown buyers "IndiaMART Buyer"; the CRM uses the company name instead when there is one.

## Facebook (and Instagram) Lead Ads

1. You need a Meta developer app (the WhatsApp app works), your **Page ID**, a **long-lived Page access token** with leads_retrieval, pages_manage_metadata, pages_show_list, pages_read_engagement and ads_management, and the app's **App secret** (App settings → Basic).
2. Settings → Lead sources → **Facebook Lead Ads**: paste them → Connect. The CRM checks the token and subscribes the Page to new leads.
3. In the Meta app → **Webhooks** → choose **Page** → paste the **Callback URL** and **Verify token** from the card → verify → subscribe to the **leadgen** field. Like WhatsApp, Meta only calls a public **https** address.
4. If leads do not arrive: Meta Business Suite → Leads Access Manager must allow the app to read leads. When the token expires or loses a permission, the card says "Needs attention": press **New token**.

## Google Ads lead forms

1. Settings → Lead sources → **Google Ads lead form**. The card shows a **Webhook URL** and a **Key**.
2. In Google Ads → the lead form asset → Lead delivery → **Webhook integration**: paste both, then **Send test data**. The test appears under *Recent* as "Google Ads test data (not added to Leads)"; real leads become leads.

## JustDial and TradeIndia

Neither publishes a developer page. Settings → Lead sources → **JustDial** (or **TradeIndia**) gives a lead address; send it to your JustDial account manager (TradeIndia support contact) and ask them to push your leads to it. Any format is accepted. After the first lead, open *Recent*: if it says "refused", its raw data is shown so the format can be added. (TradeIndia's "My Inquiry API" pull needs the parameters from your own account page; tell us when you have them.)

## Testing without a real source

In development, *Try it: receive a test lead* pretends an enquiry arrived from IndiaMART, a website, JustDial and so on.

## Who gets a lead, and the instant WhatsApp reply

These run for every new enquiry (and for a customer's first WhatsApp message). Set them up in **Settings → Lead rules** (owners and admins); the API is in docs/API.md.

- **Assignment rules** give a new lead to someone: the first rule that fits the enquiry's source, product, state and city; either in turns (round-robin) among the people you pick, or always one person. With "respect working hours" a lead outside your hours goes to a fallback person. The lead's timeline says who got it and why.
- **Auto-reply rules** send an approved WhatsApp template within seconds, filled in with the customer's name, the product and so on. Repeat enquiries, enquiries older than an hour (for example what IndiaMART's first pull brings from the last 24 hours) and customers without a mobile number get no auto-reply; the lead says why.
- **Working hours**: default Monday–Saturday 10:00–19:00 India time.

Start with the suggestions on the screen: "give every new lead in turns to everyone who can take leads" and "greet every new enquiry with your approved template". The preview shows the WhatsApp message with the values it will use. In **Leads**, the Owner column shows who got each lead; the notes button (Notes and history) shows why, and whether the auto-reply went out.

To try it: *Try it: receive a test lead* (Settings → Lead sources, development only) with source IndiaMART and, if a rule looks at the state, a state such as Rajasthan. The lead appears in the owner's Inbox with the auto-reply within a second or two. IndiaMART leads that are pulled arrive within about 5 minutes of the enquiry (IndiaMART allows one pull every 5 minutes); the push address brings them at once.

## Still to check with real accounts

IndiaMART (your CRM API key), Facebook Lead Ads (a Page and the Meta app) and Google Ads lead forms work against test stand-ins; each needs one check with the real account. TradeIndia's pull waits for the parameters from your account page.
