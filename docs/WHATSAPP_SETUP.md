# Connecting WhatsApp (Cloud API)

The CRM talks to WhatsApp through Meta's **WhatsApp Cloud API**. You need a Meta developer app, a WhatsApp Business Account and a phone number that is **not** active in the WhatsApp or WhatsApp Business app. Meta's own guides: [Get started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started), [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/).

Business verification, display-name approval and message templates can take days, so start early.

## 1. In Meta

1. [developers.facebook.com](https://developers.facebook.com) → My Apps → **Create app** → type **Business** → add the **WhatsApp** product.
2. WhatsApp → **API Setup**: note the **Phone number ID** and the **WhatsApp Business Account ID**. Meta gives a free test number to start with; add your real number here later.
3. A **permanent access token**: Business Settings → Users → **System users** → add one (Admin) → *Generate new token* for your app with the permissions `whatsapp_business_messaging` and `whatsapp_business_management`. (The 24-hour token on the API Setup page works for a quick test only.)
4. App settings → **Basic** → **App secret** (click *Show*).

Keep the token and the app secret private: paste them only into the CRM.

## 2. In the CRM

Settings → **WhatsApp** (owners and admins) → *Connect a number*: paste the Phone number ID, the Business Account ID, the access token and the app secret → **Connect Number**. The CRM asks Meta about the number; "Connected" means the token works.

The number's card then shows a **Callback URL** and a **Verify token**.

## 3. Let Meta reach the CRM (webhook)

Meta only calls a **public HTTPS** address with a valid certificate. While the CRM runs on your computer (`http://127.0.0.1:3000`), use a tunnel:

```
cloudflared tunnel --url http://127.0.0.1:3000
```

It prints an address like `https://random-words.trycloudflare.com` (it changes every run; a named Cloudflare tunnel with your own domain keeps it fixed). Your callback URL is that address + the path shown in the CRM, e.g. `https://random-words.trycloudflare.com/api/v1/webhooks/whatsapp/<key>`.

In the Meta app → WhatsApp → **Configuration** → Webhook → *Edit*: paste the callback URL and the verify token → *Verify and save*. Then under *Webhook fields* **subscribe to `messages`** and **`message_template_status_update`** (so template approvals and rejections show up in the CRM). If several of your numbers use the same Meta app, one callback URL is enough: messages for your other connected numbers are sorted to the right number.

## 4. Check it

Send a WhatsApp message from your own phone to the business number. In the CRM the number's card shows "last message from WhatsApp …", and the sender appears under Customers/Leads (a new number becomes a WhatsApp lead).

## 5. Templates, files and the click-to-chat link

- **Templates** (Settings → WhatsApp → *Message templates*) need the number's **WhatsApp Business Account ID** and a token with `whatsapp_business_management`. *Sync from Meta* brings the templates you made in WhatsApp Manager; *New template* submits one for Meta's review. Only approved templates can be sent — they are the only messages allowed when the customer has not written for 24 hours, and for writing first (Customer 360 → WhatsApp → *Message on WhatsApp*).
- **Files**: photos (JPG/PNG up to 5 MB), videos and audio (16 MB) and documents (PDF, Word, Excel, PowerPoint, TXT up to 100 MB) can be sent from the Inbox inside the 24-hour window. Received files are copied into the CRM's private document folder (`DOCUMENT_DIR`) at once, because WhatsApp keeps them only 7 days.
- **Click-to-chat**: Settings → WhatsApp shows a `wa.me` link (optionally with a message already typed) and a QR code to print; customers who use it land in the Inbox.

### Sending quotations

Quotations → *Send on WhatsApp* sends the quotation PDF into the customer's chat. While the customer has written in the last 24 hours it goes as a document with a message (the online link included). After that WhatsApp allows only an approved template: make one in WhatsApp Manager with a **Document** header (Meta allows only PDFs there) and a body such as "Namaste {{1}}, please find our quotation {{2}} for {{3}} attached." (category *Utility*), wait for approval, then *Sync from Meta*. The CRM attaches the PDF to the header and fills {{1}} {{2}} {{3}} with the customer's name, the number and the total (you can change them before sending). A template without a document header can also be used; then only its text goes.

### The FAQ bot

Sales Automation → **FAQ bot** (owners and admins) answers customers on WhatsApp with text, reply buttons (up to 3) or a list (up to 10 options) while nobody from the team has the chat. Nothing extra is needed in Meta: these are ordinary messages inside the 24-hour window (the customer has just written), so no template approval. When a customer asks for a person, the bot stops in that chat until a teammate turns it on again (the chip in the Inbox) or closes the chat.

### The WhatsApp catalog (products and orders)

Customers can see your products inside WhatsApp, add them to a cart and send the cart to you; the CRM turns it into an order. (Meta renames its menus from time to time; if a name below differs, look for the nearest one.)

1. **In Meta:** open Commerce Manager (business.facebook.com/commerce), create a catalog of type *E-commerce* (you can leave it empty: the CRM fills it), then in WhatsApp Manager → your account → *Catalog* connect that catalog to your WhatsApp Business Account. In Business Settings → System users, give your system user access to the catalog (*Manage catalog*). Copy the **catalog ID** (Commerce Manager shows it under the catalog's name).
2. **In the CRM:** Settings → WhatsApp → your number → **Connect catalog**, paste the catalog ID, keep "Show the shop button" and "Customers can send a cart" ticked, and press *Check and connect*.
3. **Products:** on the Products page open a product, add a **Photo link (https)** (a photo on your website or any public https address), optionally an SKU, tick **Show in the WhatsApp catalog** and save. The CRM sends them at once, every day, and when you press **Sync now**. Prices go to WhatsApp **with GST** (decision D43). A product without a photo or price shows "Needs attention".
4. **In a chat:** the store button next to the template button sends one product or a list (up to 30). Customers who send a cart get a thank-you message, and the order appears under Orders (stage Received) with a note under your bell.

The catalog comes with the Growth plan (the trial has it).

## Login codes on WhatsApp (the platform's own number)

Logging in on a new browser needs Google, the person's mobile number and a 6-digit code on WhatsApp (D58; or a QR code scanned with a phone that is already logged in). Until the codes can be sent, the CRM logs in with Google alone. The codes come from **one WhatsApp number of the platform** (yours, not a company's):

Only sending is needed (no webhook). Meta allows **Authentication** templates only to a **verified business** (checked 2026-10-08: Meta business verification, and a messaging limit that verification unlocks), so start with step 1 — it can take a few days.

1. **Verify the business.** [business.facebook.com](https://business.facebook.com) → create the business portfolio if there is none → Settings → **Business info** / Security centre → **Start verification**. Meta asks for the legal name, address, phone and a document such as the GST certificate or Udyam registration, and confirms by email, phone or a domain. Wait for "Verified".
2. **The app and the number.** As in section 1 above: a Meta developer app (type Business) with the WhatsApp product. Under WhatsApp → API Setup → **Add phone number**: a number that is **not** on the WhatsApp or WhatsApp Business app (a new SIM is easiest), the display name (e.g. "YELLOW CRM") and the category; confirm with the SMS code. Note its **Phone number ID**. The free test number on that page is fine for a first try with up to 5 numbers you add under "To", but Meta may refuse an authentication template until the business is verified.
3. **A permanent token.** Business Settings → Users → **System users** → add one (Admin) → *Add assets*: the app and the WhatsApp account (full control) → *Generate new token* for the app, expiry **Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it once and keep it private.
4. **The template.** [WhatsApp Manager](https://business.facebook.com/wa/manage/message-templates/) → **Message templates** → *Create template* → category **Authentication** → name `crm_login_code`, language **English** → code delivery **Copy code** → optionally the security line and "expires in 5 minutes" → *Submit*. Meta writes the text itself ("<code> is your verification code."). Wait for **Active**.
5. **Tell the CRM.** Add to `backend/.env` (and, on Render, under the service's *Environment*):
   ```
   OTP_PROVIDER=whatsapp
   WHATSAPP_OTP_PHONE_NUMBER_ID=<the Phone number ID>
   WHATSAPP_OTP_ACCESS_TOKEN=<the permanent token>
   WHATSAPP_OTP_TEMPLATE=crm_login_code
   WHATSAPP_OTP_LANGUAGE=en
   ```
   Restart the backend (stop-crm, then start-crm; or `rs` in its terminal).
6. **Check.** Log out, open the login page: Google → your mobile number → *Get a code on WhatsApp*. The code arrives from the platform's number with a *Copy code* button. If it does not, the login page shows Meta's reason outside production, and the backend log always has it ("WhatsApp login code not sent: …"). Common ones: the template is not approved yet or its name/language differ; the token has expired or lacks `whatsapp_business_messaging`; on the test number the recipient is not in the "To" list.

Meta charges a small fee for each authentication message (see Meta's pricing page for India). Codes last 5 minutes, work once, allow 5 tries, and at most 3 can be asked for a number in 15 minutes. In development (`OTP_PROVIDER=mock`, the default) nothing is sent and the code is shown on the screen. `LOGIN_WHATSAPP_CODE=off` makes Google alone enough again.

## Without a Meta account

In development, Settings → WhatsApp → **Add a test number instead**, then **Receive Test Message** pretends a customer wrote (a text, or a sample photo, document or voice note). On a test number, **Connect catalog** accepts any digits as the catalog ID, so you can try products and carts (the API simulator can send a cart: `type: "order"`). A test number has five sample templates (one, `quotation_pdf`, with a document header for quotations) and approves new ones at once. Nothing is sent to WhatsApp. Test numbers and the simulator are switched off on a production server (`NODE_ENV=production`).

## Settings (backend/.env)

| Key | Default | Meaning |
|---|---|---|
| `WHATSAPP_GRAPH_VERSION` | `v26.0` | Graph API version ([versions](https://developers.facebook.com/docs/graph-api/changelog/versions/)); update when Meta retires it. |
| `WHATSAPP_GRAPH_URL` | `https://graph.facebook.com` | Only changed for tests. |
| `RATE_LIMIT_WEBHOOK_PER_MINUTE` | `1200` | Requests per minute per address on the webhook URLs. |
| `PUBLIC_URL` | `http://127.0.0.1:3000` | Used to show the callback URL; set it to your HTTPS address on a server. |
