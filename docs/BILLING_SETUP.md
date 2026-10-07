# Billing setup: selling the CRM plans (Phase 10)

This guide is for **you, the owner of the CRM platform**. Companies that use the CRM pay you for their plan through **your own Razorpay account** (Razorpay Subscriptions). This is separate from Settings → Payments, where each company connects *its* Razorpay or Cashfree account to collect money from *its* customers ([PAYMENTS_SETUP.md](PAYMENTS_SETUP.md)).

## How it works

- **New companies** get a **30-day free trial** of the Growth plan (D48). Companies that used the CRM before billing existed are **complimentary**: they keep their plan with no end date.
- In **Settings → Plan & usage**, an owner or admin sees the plan, the usage meters and the four plans. **Choose** opens Razorpay's payment page in a new tab (card, UPI or netbanking).
  - Choosing a plan **during the trial** keeps the rest of the trial free: Razorpay only sets up the mandate, and the first charge happens when the trial ends.
  - After that, Razorpay charges every month until the company cancels.
- Each monthly charge creates a **GST tax invoice** from your business: CGST + SGST if the company is in your state, otherwise IGST. The invoice can be downloaded as a PDF from the same page. Invoice numbers are `YC/2026-27/0001`, `0002` and so on, without gaps, restarting each financial year.
- **Upgrades** start at once. **Downgrades** start with the next month (Razorpay cannot switch plans that are paid by UPI or e-mandate; the page then tells the company to cancel and choose again).
- **Cancel plan**: the plan keeps working until the paid month ends, and is not charged again.
- **If a payment fails**, the plan shows **Payment due** and Razorpay retries. If every retry fails, the plan is **halted**.
- **When the trial ends without a plan**, or the plan is halted or ended, the company can still sign in, read everything, reply to customers, receive WhatsApp messages and leads, and record payments. It cannot add users, numbers, contacts, templates, quotations or broadcasts, or use the paid features, until it chooses a plan. Nothing is deleted (D49).
- Owners and admins get bell notes: 7, 3 and 1 days before the trial ends, when it ends, when a plan starts, for each payment, and when a payment fails.

## 1. Try it without Razorpay (development)

With `NODE_ENV=development`, `BILLING_PROVIDER` defaults to `mock`.

1. Choose a plan.
2. A **test checkout page** on this server opens. Use its buttons:
   - **Authorise and pay**
   - **Charge the next month** (a monthly payment; also creates the invoice)
   - **Fail the next charge**: once makes the plan **Payment due**; a second time makes it **halted**.
3. No money moves.

The test gateway never runs in production.

## 2. Razorpay account and keys

1. In the Razorpay Dashboard, make sure **Subscriptions** is enabled for your account. If it is not, ask Razorpay support.
2. Go to **Account & Settings → API Keys** and generate **test** keys first. Live keys come after your account is activated.
3. Put the keys in `backend/.env`, then restart the server:

   ```
   BILLING_PROVIDER=razorpay
   RAZORPAY_BILLING_KEY_ID=rzp_test_...
   RAZORPAY_BILLING_KEY_SECRET=...
   RAZORPAY_BILLING_WEBHOOK_SECRET=<a long random text you choose>
   ```

You don't need to create plans in Razorpay. The CRM creates each plan the first time someone chooses it: monthly, priced at the plan price + 18% GST (₹1,178.82, ₹3,538.82, ₹7,078.82, ₹11,798.82). It remembers each plan's id. If you change a price in `backend/src/constants/plans.js`, a new Razorpay plan is made for new subscriptions.

## 3. Webhook

In Razorpay: **Account & Settings → Webhooks → Add new webhook**.

- **URL:** `https://<your domain>/api/v1/webhooks/billing/razorpay`
- **Secret:** the same text as `RAZORPAY_BILLING_WEBHOOK_SECRET`
- **Events:** `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.updated`, `subscription.paused`, `subscription.resumed`

How the CRM handles webhooks:

- It checks the `X-Razorpay-Signature` of every call and ignores repeats (`X-Razorpay-Event-Id`).
- Webhooks can arrive out of order, so the CRM reads the subscription's current state from Razorpay before it changes anything.
- Without a public https address (the CRM on this computer), webhooks cannot arrive. The CRM still asks Razorpay **every 6 hours**, and when someone presses **Check now**, for each subscription's state and paid invoices. Payments are found either way.

## 4. Your GST invoice details

These go on every invoice. Set them before the first real payment:

```
BILLING_SELLER_NAME=Your Company Pvt Ltd
BILLING_SELLER_GSTIN=08ABCDE1234F1Z5
BILLING_SELLER_ADDRESS=Full address with PIN code
BILLING_SELLER_EMAIL=billing@yourdomain.in
BILLING_SAC=998315
BILLING_INVOICE_PREFIX=YC
```

- **State:** the state comes from the first two digits of your GSTIN.
- **Place of supply:** the company's state, taken from its GSTIN or the state in its profile; if neither is known, your state.
- **SAC:** `998315` is a common choice for SaaS. **Confirm the SAC and the invoice format with your CA** before you go live.

## 5. Go live

1. Switch the keys to **live** (`rzp_live_...`).
2. Add the webhook in **live** mode too.
3. Restart the server.

Test and live keys have separate plans, which the CRM creates on its own.

## 6. Turn online payment off

Set `BILLING_PROVIDER=off`. This is the default in production until you configure Razorpay. The plan page then says "write to `BILLING_SELLER_EMAIL`" instead of showing Choose buttons.

## Not yet available

- A platform-admin screen, to comp a company, extend a trial or change a plan by hand. Phase 10F adds a small command for this.
- Emailing invoices. Invoices are downloaded from Settings → Plan & usage.
