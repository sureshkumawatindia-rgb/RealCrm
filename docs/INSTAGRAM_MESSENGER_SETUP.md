# Instagram and Messenger in the inbox (G8, D112)

Messages to a company's **Facebook Page** (Messenger) and to the **Instagram professional account
linked to that Page** come into the same team inbox as WhatsApp. Teammates answer them with text:

- within **24 hours** of the customer's last message (a normal reply);
- after that, a **person** may still answer for up to **7 days**. The CRM sends these replies with
  Meta's `HUMAN_AGENT` tag, which Meta grants in App Review.

A new customer becomes a contact and a lead, with the source **Instagram** or **Messenger**.
Photos, videos and files they send are copied into the CRM. Messages the business sends from
Meta's own apps (Meta Business Suite, the Instagram app) also show in the chat.

The FAQ bot, auto-replies, workflows and the CSAT question answer on WhatsApp only. Templates,
files, products, forms and calls are WhatsApp's too: Instagram and Messenger chats take text from
the CRM.

Checked against Meta's documentation on 2026-11-02:
- [Messenger Platform: send messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)
- [Messenger Platform: webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
- [Instagram Messaging: get started](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started)
- [Instagram Messaging: webhooks](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks)

## A. The platform's Meta app (once, by you)

This uses the same Meta app as "Connect WhatsApp" (`docs/WHATSAPP_SETUP.md` part A). That app
already has `META_APP_ID`, `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN`.

1. **Add the products.** In the App Dashboard, add **Messenger** and **Instagram** messaging
   (Messenger API for Instagram) to the app.
2. **Create a Facebook Login for Business configuration.** Go to **Facebook Login for Business →
   Configurations → Create configuration**.
   - Choose the token type **User access token**.
   - Give it these permissions: `pages_show_list`, `pages_messaging`, `pages_manage_metadata`,
     `instagram_basic` and `instagram_manage_messages`.
   - Copy the **Configuration ID**.
3. **Set up the webhooks.** Use the same callback URL as WhatsApp,
   `https://app.yourdomain/api/v1/webhooks/meta`, with the same verify token
   (`META_WEBHOOK_VERIFY_TOKEN`). Then subscribe two objects:

   | Object | Webhook fields |
   | --- | --- |
   | **Page** | `messages`, `messaging_postbacks`, `message_echoes`, `message_reads`, `message_deliveries` |
   | **Instagram** | `messages`, `messaging_postbacks`, `messaging_seen` |

   When a company connects, the CRM subscribes each of its Pages to the app by itself
   (`POST /{page-id}/subscribed_apps`).
4. **Add the configuration to the server.** In Render → the service → **Environment**, add
   `META_SOCIAL_CONFIG_ID=<the Configuration ID>` and save; the service restarts. On your own
   computer, edit `backend/.env` instead, following the numbered steps you were given.
   Never paste the value into a chat.
5. **App Review.** Request **Advanced Access** for these permissions, each with a short
   explanation of what the CRM does with it:
   - `pages_show_list`
   - `pages_messaging`
   - `pages_manage_metadata`
   - `instagram_basic`
   - `instagram_manage_messages`

   Also request the **Human Agent** feature, so teammates can answer after 24 hours.

   Meta also needs screen recordings of three things:
   - a Page being connected in Settings → WhatsApp → Instagram and Messenger;
   - a message from Instagram and one from Messenger arriving in the Inbox;
   - a reply going back.

   Until Meta approves the app, only people with a role on the app (and on the Page) can test it.

Without these steps the **Connect Instagram and Messenger** button stays hidden. Settings then
says that connecting is not set up on this server yet.

## B. Each company (in the CRM)

1. Their Instagram account must be a **professional (business) account linked to their Facebook
   Page**. In the Instagram app, turn on **Allow access to messages**: Settings → Messages and
   story replies → Message controls → Connected tools.
2. An owner or admin goes to **Settings → WhatsApp → Instagram and Messenger → Connect Instagram
   and Messenger**. In Meta's popup, they choose the Pages, and the Instagram accounts linked to
   them. They need to be able to manage those Pages.
3. Each Page appears twice: its **Messenger**, and its **Instagram** account, if one is linked.
   To try it, send the Page a message from Messenger or send a DM to the Instagram account; it
   shows up in the Inbox within seconds.
4. **Disconnect** stops new messages and replies for that account. Its chats stay in the Inbox.
   The Page is unsubscribed once neither of its accounts is connected.

## Meta's rules the CRM follows

- **The customer writes first.** A business cannot start an Instagram or Messenger chat.
- **The reply window.** A reply goes within 24 hours of the customer's last message. After that,
  only a person may answer, for up to 7 days, with `HUMAN_AGENT`. Such replies must not carry
  offers or promotions.
- **When the window closes.** After 7 days nothing can be sent until the customer writes again.
  The Inbox shows this in place of the composer.
- **Ticks.** "Delivered" and "read" come from Messenger's delivery and read webhooks, and from
  Instagram's "seen" webhook.
- **Echoes.** What the business sent from Meta's own apps comes back as an echo and is added to
  the chat. The CRM's own replies are recognised and never added twice.

## Developer test tools (DEV_TOOLS=on, never in production)

- **Settings → WhatsApp → Instagram and Messenger → Add a test Page** adds a test Page with a
  Messenger and an Instagram account (`test_shop`).
- `POST /api/v1/dev/simulate/social-inbound` pretends Meta sent a webhook. Its body:

  ```
  { channel: instagram|messenger, from?, name?, username?, event: message|echo|read, type: text|image, text? }
  ```

  - `message`: a customer's message.
  - `echo`: a message sent from Meta's apps.
  - `read`: the customer saw our messages.
