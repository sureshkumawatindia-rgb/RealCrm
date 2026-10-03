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

## Without a Meta account

In development, Settings → WhatsApp → **Add a test number instead**, then **Receive Test Message** pretends a customer wrote (a text, or a sample photo, document or voice note). A test number has five sample templates (one, `quotation_pdf`, with a document header for quotations) and approves new ones at once. Nothing is sent to WhatsApp. Test numbers and the simulator are switched off on a production server (`NODE_ENV=production`).

## Settings (backend/.env)

| Key | Default | Meaning |
|---|---|---|
| `WHATSAPP_GRAPH_VERSION` | `v26.0` | Graph API version ([versions](https://developers.facebook.com/docs/graph-api/changelog/versions/)); update when Meta retires it. |
| `WHATSAPP_GRAPH_URL` | `https://graph.facebook.com` | Only changed for tests. |
| `RATE_LIMIT_WEBHOOK_PER_MINUTE` | `1200` | Requests per minute per address on the webhook URLs. |
| `PUBLIC_URL` | `http://127.0.0.1:3000` | Used to show the callback URL; set it to your HTTPS address on a server. |
