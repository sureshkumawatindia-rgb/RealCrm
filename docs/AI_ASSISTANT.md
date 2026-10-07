# AI assistant (Phase 10D)

The CRM's optional AI assistant uses Anthropic's **Claude API** with **your (the platform's) API key**. Each company switches it on for itself in **Settings → AI assistant**, and each company has a monthly budget.

## What it does

- **Suggest a reply.** In the Inbox, an agent presses the ✨ button. The assistant writes 1 to 3 drafts for the customer's latest message. The agent picks one, edits it if needed, and sends it. **Nothing is sent by itself.**
  - Model: `claude-sonnet-5-5`, at low effort.
- **Answer by itself.** This is a second switch, and it is off by default. When a customer writes, the assistant answers on WhatsApp **only if all of these are true**:
  - the FAQ bot did not answer the message;
  - no teammate wrote in the chat in the last 30 minutes;
  - the customer's 24-hour window is open;
  - the message is less than 15 minutes old;
  - the company's facts fully answer it.
  - Model: `claude-haiku-4-5` (quick and cheap).
- **Passing a chat to the team.** If the assistant is not sure, or the customer wants to negotiate, complains, or asks about an order, payment or delivery, it does **not** answer. Instead:
  - the chat's owner gets a bell note with the reason (owners and admins, if nobody owns the chat);
  - the assistant stays quiet in that chat for 24 hours.
- **What it knows.** Only the company's own facts:
  - the profile (name, city, website, about);
  - active products with prices and GST, MOQ and description;
  - FAQ answers;
  - the company's own instructions;
  - the last 20 messages of the chat.
  - It is told never to make up prices, stock, discounts, delivery dates or policies. The chat transcript is treated as data, not as instructions.
- **Logging.** Every call is logged: tokens, an estimated cost (from Anthropic's list prices in `backend/src/constants/ai.js`), and the outcome. The page shows this month's figures.

## Set it up (platform owner)

1. Make an API key in the Claude Console (console.anthropic.com → API keys). Set a spending limit on your Anthropic account.
2. In `backend/.env`:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   # Optional:
   AI_MONTHLY_BUDGET_USD=5        # per company per month (estimated from list prices)
   AI_SUGGEST_MODEL=              # default claude-sonnet-5-5
   AI_AUTOREPLY_MODEL=            # default claude-haiku-4-5
   AI_REFUSAL_FALLBACK=default    # on a safety refusal the API retries on another model (Sonnet 5.5); off to disable
   ```

3. Restart the server. Owners and admins can now switch the assistant on in **Settings → AI assistant**, and use **Try it** to see what it would answer. Nothing is sent from Try it.

## Cost

Rough figures for one call with about 4,000 tokens of company facts:

- **Suggestion** on Sonnet 5.5 ($2 / $10 per million tokens in / out, cached facts $0.20): about $0.003–0.01.
- **Answer by itself** on Haiku 4.5 ($1 / $5): about $0.001–0.005.

The company facts are sent with prompt caching, so repeated calls in 5 minutes pay about a tenth for them. A company that reaches its budget is paused until the 1st of the next month.

## Privacy

To write an answer, the customer's recent messages and the company's product list and FAQ are sent to Anthropic. The settings page tells owners and admins this before they switch it on. Under India's DPDP Act, mention it in your privacy notice and your agreement with the companies. Check Anthropic's commercial terms and data retention settings for your account.

## Not yet available

- Each company bringing its own API key.
- Choosing the model per company.
- Answering photos or voice notes (only text messages are answered).
- Sending a template when the 24-hour window is closed.
