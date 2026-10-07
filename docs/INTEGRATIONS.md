# Integrations: public API, webhooks, Zapier, Make, Meta Conversions API (Phase 10C)

Owners and admins set these up in **Settings → API & webhooks**.

- **Public API and webhooks:** Growth plan and above.
- **Meta Conversions API:** Pro plan and above.

## 1. Public REST API

- **Base address:** `https://<your CRM domain>/api/public/v1`
- **Sign-in:** an API key from Settings → API & webhooks → **New API key**.
  - Give the key a name and tick what it may do.
  - The key looks like `ycrm_1a2b3c4d5e_…`. It is shown **once**, and the CRM keeps only a hash of it.
  - Send it on every request as `Authorization: Bearer <key>`, or as the header `X-API-Key: <key>`.
- **Who the key acts as:** the owner or admin who made it, for the whole company.
- **When a key stops working:**
  - when you revoke it;
  - when its maker is no longer an owner or admin;
  - when the plan has no API: `403 PLAN_LIMIT` (or `SUBSCRIPTION_INACTIVE` while the plan is not active).
- **Rate limit:** 120 requests a minute per key (`RATE_LIMIT_PUBLIC_API_PER_MINUTE`). Over that: `429 RATE_LIMITED`.

### Data format

- **Answers:** `{ "success": true, "data": …, "pagination"?: { page, limit, total, totalPages, hasNextPage } }`.
- **Errors:** `{ "success": false, "code": "…", "message": "…" }`.
- **Money:** amounts are in **paise** (₹1 = 100).
- **Times:** ISO 8601 in UTC.
- **Lists:**
  - `?page=1&limit=20` (at most 100), newest first.
  - `?updatedSince=<ISO time>` returns only records changed after that time, oldest first. Use it to poll for changes.

### Permissions (scopes)

| Scope | Allows |
|---|---|
| `contacts:read` | Read customers |
| `contacts:write` | Add and change customers |
| `leads:read` | Read leads |
| `leads:write` | Add leads and change their stage |
| `quotations:read` | Read quotations |
| `orders:read` | Read orders and their payments |
| `products:read` | Read products |
| `messages:write` | Send approved WhatsApp templates |

A call outside the key's scopes gets `403 SCOPE_MISSING`. A missing, wrong or revoked key gets `401 API_KEY_INVALID`.

### Endpoints

| Method | Path | Scope | What |
|---|---|---|---|
| GET | `/me` | any | The company and the key's scopes |
| GET | `/contacts` | contacts:read | `?search=` (name, company, email, phone), `?phone=`, `?email=`, `?updatedSince=` |
| GET | `/contacts/:id` | contacts:read | One customer |
| POST | `/contacts` | contacts:write | `{ name, phone?, email?, company?, gstin?, city?, state?, address?, tags?, lifecycle?, marketingConsent?, notes? }` → 201. `409` if the phone already belongs to a customer; `403 PLAN_LIMIT` at the plan's contact limit |
| PATCH | `/contacts/:id` | contacts:write | The same fields |
| GET | `/leads` | leads:read | `?stage=`, `?source=`, `?updatedSince=` |
| GET | `/leads/:id` | leads:read | One lead with its customer |
| POST | `/leads` | leads:write | An enquiry: `{ contact: { name?, phone?, email?, company?, city?, state? }, title? or product?, quantity?, message?, externalId? }`. See the notes below the table. |
| POST | `/leads/:id/stage` | leads:write | `{ stage: New / Contacted / Quote Sent / Negotiation / Won / Lost, lostReason? }` |
| GET | `/quotations`, `/quotations/:id` | quotations:read | `?status=`, `?contactId=`; lines, GST and totals |
| GET | `/orders`, `/orders/:id` | orders:read | `?stage=`, `?contactId=`; with `paymentStatus`, `amountPaidPaise`, `duePaise` and `payments` |
| GET | `/products` | products:read | `?active=true` |
| POST | `/messages` | messages:write | An approved WhatsApp template from the company's default number. See the notes below the table. |

**How `POST /leads` works.** It is handled like a lead source:

- A mobile number or an email is required.
- If the customer already has an open lead, the enquiry is added to it (`outcome: attached`).
- Otherwise a new lead is made with source `API` (`outcome: created`, 201).
- Sending the same `externalId` again does nothing (`outcome: duplicate`).
- Assignment and auto-reply rules run as for any enquiry.
- API leads are never stopped by the plan's contact limit.

**How `POST /messages` works.**

- Body:
  - the customer: `contactId`, **or** `phone` (with an optional `name`);
  - `template: { name, language? }`;
  - `variables: { header?: { name: value }, body?: { "1": value } or { name: value }, buttons?: { "0": link end } }`.
- A new number becomes a customer.
- Refused when the customer has opted out (`OPTED_OUT`), when there is no WhatsApp number (`NO_WHATSAPP_NUMBER`), and for an unknown or unapproved template (`TEMPLATE_NOT_FOUND` / `TEMPLATE_NOT_SENDABLE`).

### Example

```bash
curl -H "Authorization: Bearer ycrm_1a2b3c4d5e_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  "https://crm.example.in/api/public/v1/leads?stage=Won&limit=50"
```

## 2. Outbound webhooks

**Settings → API & webhooks → Add a webhook.** Give an **https** address and tick the events. The address must be public: addresses on this server's own network are refused. The webhook's **secret** (`whsec_…`) is shown once.

### Events

| Event | When | `data` |
|---|---|---|
| `lead.created` | A lead is made (any source) | `lead` (with `contact`) |
| `lead.stage_changed` | A lead moves stage | `lead`, `from`, `to` |
| `contact.created` | A customer is added (by hand, the API, WhatsApp, a lead source; not CSV imports) | `contact` |
| `message.received` | A customer writes on WhatsApp | `message { id, type, text, at }`, `conversationId`, `contact` |
| `quotation.status_changed` | Sent, viewed, accepted, rejected or expired | `quotation`, `from`, `to` |
| `order.created` | An order is made (from a quotation or the WhatsApp catalog) | `order` |
| `order.stage_changed` | An order moves stage | `order`, `from`, `to` |
| `payment.received` | A payment is recorded (link or by hand) | `amountPaise`, `orderId`, `leadId`, `order`, `contact` |

The `data` objects use the same shapes as the public API.

### Each call

Each call is a `POST` with JSON `{ "id": "evt_…", "type": "lead.created", "createdAt": "…", "data": { … } }` and these headers:

- `X-CRM-Event`: the event name.
- `X-CRM-Event-Id`: the same as `id`, and the same for every attempt. Ignore an id you have already handled.
- `X-CRM-Delivery`: this delivery's id.
- `X-CRM-Signature`: `sha256=` + the hex HMAC-SHA256 of the **raw body**, keyed with the webhook's secret.

Check the signature before you trust the body, for example in Node.js:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', process.env.CRM_WEBHOOK_SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-crm-signature'] || ''));
```

### Answers, retries and the delivery log

- Answer with a **2xx within 10 seconds**.
- Anything else is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours: 8 attempts in all.
- After **25 failed deliveries in a row**, the webhook is switched off. Owners and admins get a note under the bell; switch it on again after the fix.
- The **Delivery log** keeps 30 days: each call's result and tries, and **Send again** for failed ones.
- **Send a test** sends a `ping` event.
- **New secret** replaces the secret at once.

## 3. Zapier

**When something happens in the CRM** (trigger):

1. Make a Zap with the trigger **Webhooks by Zapier → Catch Hook**, and copy its address.
2. In the CRM, **Add a webhook** with that address and the events you want.
3. Press **Send a test** so Zapier sees a sample, then use the `data` fields in the next steps.

**To do something in the CRM** (action):

1. Use **Webhooks by Zapier → Custom Request** (or POST).
2. Set the URL, for example `https://<your CRM>/api/public/v1/leads`, and the method `POST`.
3. Add the header `Authorization: Bearer <API key>`, and the JSON body as above.

**Polling instead of webhooks:** use **Webhooks by Zapier → Retrieve Poll** on `GET /api/public/v1/contacts?limit=50` with the same header. Zapier keeps track of the ids it has seen.

## 4. Make (Integromat)

**Trigger:**

1. Add a **Webhooks → Custom webhook** module and copy its address.
2. Add a webhook with that address in the CRM.
3. Press **Send a test**, so Make learns the data structure.

**Action:**

1. Add an **HTTP → Make a request** module.
2. Set the URL, for example `…/api/public/v1/messages`, the method POST, and the header `Authorization: Bearer <API key>`.
3. Set the body type to Raw / JSON.

## 5. Meta Conversions API (for Lead Ads)

The CRM tells Meta how your Facebook and Instagram **Lead Ads** leads move: New, Contacted, Quote Sent, Negotiation, Won, Lost. Meta can then show your ads to people like the leads who become customers ("conversion leads" optimisation).

### Set it up in Meta and the CRM

1. In **Meta Events Manager**, create a **dataset** (pixel) or pick one, and note its **ID**.
2. In the dataset, go to **Settings → Conversions API → Generate access token**.
3. In the CRM, open **Settings → API & webhooks → Meta Conversions API**, paste the ID and the token, and press **Check and save**. The CRM checks the token with Meta and stores it encrypted; it is never shown again.
4. To test:
   1. In Events Manager, open **Test events** and copy the **test event code**.
   2. Enter it in the CRM and press **Send a test event**.
   3. While the code is set, events go to Test events only. **Clear it** to go live.
5. In Ads Manager, set the Lead Ads campaign's optimisation to **conversion leads** once Meta has enough events. Meta's own guide gives the numbers it needs.

### What is sent

- **Which events:** an event when a lead is created and each time it changes stage. Only the stages you tick are sent, and only events from the last 7 days (Meta refuses older ones).
- **Each event:**
  - `event_name` is the stage;
  - `action_source` is `system_generated`;
  - `custom_data` is `{ event_source: "crm", lead_event_source: "YELLOW CRM" }`.
- **How Meta matches the lead:**
  - Meta's lead id, for leads from Lead Ads (Settings → Lead sources → Facebook);
  - the customer's phone and email, as SHA-256 hashes (never in plain text).
- **Leads from other sources** (IndiaMART, WhatsApp, …) go only if you tick **Leads from every source**. They are matched by the hashed phone and email.
- **Counts:** the page shows how many events were sent, skipped and failed, and the last problem Meta reported.

## Not yet available

- A Zapier or Make app listing (use the webhook and HTTP modules above).
- OAuth for third-party apps (API keys only).
