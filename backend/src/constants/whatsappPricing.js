// What Meta charges per delivered template message to Indian numbers, before 18% GST — for the
// broadcast cost estimate only; Meta's invoice is what counts (D37). Meta's own rate card is an
// interactive page; these are the rates published for October 2026. Update them here when
// Meta changes its prices (usually quarterly).
const WHATSAPP_RATES = Object.freeze({
  market: 'India',
  currency: 'INR',
  asOf: '2026-10',
  gstPct: 18,
  // paise per delivered message (fractions of a paisa are real: ₹0.8631 = 86.31 paise)
  perMessagePaise: Object.freeze({ MARKETING: 86.31, UTILITY: 11.5, AUTHENTICATION: 11.5 }),
});

// recipients × the category's rate, rounded up to the paisa; GST separately.
function estimateCost(recipients, category) {
  const rate = WHATSAPP_RATES.perMessagePaise[String(category || '').toUpperCase()] ?? WHATSAPP_RATES.perMessagePaise.MARKETING;
  const paise = Math.ceil(recipients * rate);
  const gstPaise = Math.ceil((paise * WHATSAPP_RATES.gstPct) / 100);
  return { recipients, perMessagePaise: rate, paise, gstPaise, totalPaise: paise + gstPaise, currency: WHATSAPP_RATES.currency, asOf: WHATSAPP_RATES.asOf };
}

module.exports = { WHATSAPP_RATES, estimateCost };
