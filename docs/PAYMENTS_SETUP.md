# Payment links: setting up Razorpay or Cashfree

The CRM makes payment links through **your own** Razorpay or Cashfree account, so the money goes
straight to your bank account. The CRM never sees card or UPI details. This guide shows what to do
in the gateway's dashboard and in the CRM. The dashboards change from time to time, so a menu name
may differ slightly from what is written here.

You can try everything first with the **Test gateway** (Settings → Payments → Connect a gateway →
Test gateway). It needs no keys and moves no money. Its links open a test payment page on the CRM.
It is only available while the CRM runs in development mode.

## 1. Razorpay

1. Sign up at razorpay.com. You can start in **Test Mode** right away. Live payments need Razorpay's
   KYC (business documents and bank account) to be approved.
2. **API keys:** in the Razorpay Dashboard choose Test Mode at the top, then Account & Settings → API
   Keys → Generate Key. Copy the **Key Id** (starts with `rzp_test_`) and the **Key Secret**.
   Razorpay shows the secret only once, so keep it safe.
3. **In the CRM:** Settings → Payments → Connect a gateway → Razorpay. Paste the Key Id and Key
   Secret. For the **webhook secret**, make up a long random phrase (for example 30 letters and
   digits). Then press **Check and save**. The CRM checks the keys with Razorpay before saving.
4. **Webhook:** copy the webhook URL the CRM shows for Razorpay. In Razorpay go to Account & Settings →
   Webhooks → Add New Webhook. Paste the URL and type the **same webhook secret**. Tick these
   events:
   - `payment_link.paid`
   - `payment_link.partially_paid`
   - `payment_link.expired`
   - `payment_link.cancelled`
5. **Going live:** after the KYC is approved, switch the dashboard to Live Mode and generate live
   keys (`rzp_live_…`). In the CRM press **Change keys** on Razorpay, paste them, and add the
   webhook again in Live Mode (test and live webhooks are separate).

Razorpay allows only a limited number of payment links in Test Mode (about 30), so test with a few.

## 2. Cashfree

1. Sign up at cashfree.com (Payment Gateway). The **Test** (sandbox) environment works at once;
   **Production** needs Cashfree's KYC.
2. **API keys:** in the Cashfree Merchant Dashboard pick Test or Production at the top, then
   Developers → API Keys. Copy the **App ID** and the **Secret Key**.
3. **In the CRM:** Settings → Payments → Connect a gateway → Cashfree. Paste them and choose
   **Test (sandbox)** or **Live**. Cashfree signs its webhooks with the Secret Key, so there is no
   separate webhook secret.
4. **Webhook:** copy the URL the CRM shows for Cashfree. In Cashfree go to Developers → Webhooks →
   Add webhook endpoint, paste it, and choose the **Payment Link** events.

## 3. Without a public address

Razorpay and Cashfree can only call a public https address. While the CRM runs on this computer
(`http://127.0.0.1:3000`), their webhooks cannot reach it. Payments still arrive in two ways:

- the CRM asks the gateway about every open link **every 10 minutes**;
- **Check now** on a link (Orders → the order → Payment link) asks at once.

For instant updates, use a tunnel (see section 11 of BIZNUMA_ROADMAP.md) or host the CRM on a public
https domain (decision D18). Then set `PUBLIC_URL` in `backend/.env`, so the webhook URL shown in
Settings → Payments is the public one.

## 4. WhatsApp templates for links and receipts

Inside 24 hours of the customer's last message, the CRM sends the link and the receipt as normal
messages. After that, WhatsApp allows only an approved template. Create two **Utility** templates in
Settings → WhatsApp → Message templates, wait for Meta's approval, then choose them in Settings →
Payments. For example:

- **Payment link**: `Namaste {{1}}, please pay {{2}} for order {{3}} using this secure link: {{4}}`
- **Receipt**: `Namaste {{1}}, we have received your payment of {{2}} for order {{3}}. Payment ID: {{4}}. Thank you!`

The CRM fills them in this order: the customer's name, the amount, the order number, the link (for
the receipt, the payment id). Named variables work too: a name with "name", "amount", "order" or
"link" in it gets that value. Templates with a PDF heading cannot be used here.

## 5. How a payment flows

1. On an order (Orders → the order → **Payment link**), a quotation (**Payment link**) or a chat (the
   Inbox contact panel): enter the amount (what is due is filled in), the days it is valid, and
   whether part payments are allowed. Then **Create link**.
2. **Send on WhatsApp**: a ready message, or the template. You can also **Copy** the link.
3. The customer pays. The payment then:
   - goes on the order (a quotation is marked accepted and its order is made);
   - wins the lead;
   - sends the customer a receipt;
   - adds a note under your bell.
   When the order is paid in full and was already Delivered, it moves to Payment Collected.
4. Cash, cheque or bank transfer: on the order press **Record payment**. If that pays the order in
   full, an unused link of the order is cancelled.
5. **Orders → Payment due** lists every unpaid order, oldest first, with the totals by age.
6. **Reminders:** in Sales Automation, make a workflow with the trigger "An order is still not
   paid after some days" and the step "Send the order's payment link".
