const { stateCodeFor, stateName, isUnionTerritory } = require('../constants/gst');
const { stateCodeFromGstin } = require('./gstin');

// Quotation money math (Phase 5). Amounts are integer paise; product prices exclude GST.
// Each line: quantity × price → minus its discount (% or flat) = taxable value → GST on the
// taxable value, rounded to the paisa per line. Same state as the seller: CGST + SGST (UTGST
// in Union Territories without a legislature), half the rate each; another state or abroad:
// IGST. Zero-rated supplies (exports, SEZ under LUT) charge no GST.

// Integer division rounding half up (BigInt: no floating-point surprises on large amounts).
function roundDiv(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return Number((2n * n + d) / (2n * d));
}
const basisPoints = (pct) => Math.round((Number(pct) || 0) * 100); // 18 → 1800, 0.25 → 25
const milli = (quantity) => Math.round((Number(quantity) || 0) * 1000); // quantities to 3 decimals

// Where the supply goes and which taxes apply. An unknown customer state counts as the
// seller's own state (D30), with a warning; an unknown seller state is a warning too.
function supplyFor({ sellerStateCode = '', buyerGstin = '', buyerStateCode = '', buyerState = '', placeOfSupplyCode = '', zeroRated = false } = {}) {
  const seller = stateCodeFor(sellerStateCode);
  const warnings = [];
  let place = stateCodeFor(placeOfSupplyCode) || stateCodeFromGstin(buyerGstin) || stateCodeFor(buyerStateCode) || stateCodeFor(buyerState);
  let stateAssumed = false;
  if (!seller) warnings.push({ code: 'SELLER_STATE_UNKNOWN', message: 'Add your GSTIN or state in Settings → Company, so the right GST is charged.' });
  if (!place) {
    place = seller;
    stateAssumed = true;
    warnings.push({ code: 'BUYER_STATE_ASSUMED', message: 'The customer\'s state is not known, so your own state is assumed (CGST + SGST). Add their state or GSTIN if they are elsewhere.' });
  }
  const interState = Boolean(seller && place && seller !== place);
  return {
    sellerStateCode: seller,
    placeOfSupplyCode: place,
    placeOfSupply: stateName(place),
    interState,
    zeroRated: Boolean(zeroRated),
    taxLabel: !interState && isUnionTerritory(seller) ? 'UTGST' : 'SGST',
    stateAssumed,
    warnings,
  };
}

// One line. input: { quantity, unitPricePaise, discountType ('amount' | 'percent'),
// discountValue (paise, or a percentage), gstRatePct }.
function priceLine(input, supply) {
  const quantity = Math.max(milli(input.quantity), 0) / 1000;
  const unitPricePaise = Math.max(Math.round(Number(input.unitPricePaise) || 0), 0);
  const subtotalPaise = roundDiv(milli(quantity) * unitPricePaise, 1000);
  const discountType = input.discountType === 'percent' ? 'percent' : 'amount';
  const discountValue = discountType === 'percent'
    ? Math.min(Math.max(Number(input.discountValue) || 0, 0), 100)
    : Math.max(Math.round(Number(input.discountValue) || 0), 0);
  const wanted = discountType === 'percent' ? roundDiv(subtotalPaise * basisPoints(discountValue), 10000) : discountValue;
  const discountPaise = Math.min(wanted, subtotalPaise);
  const taxablePaise = subtotalPaise - discountPaise;
  const gstRatePct = Math.min(Math.max(Number(input.gstRatePct) || 0, 0), 100);
  const charged = supply.zeroRated ? 0 : basisPoints(gstRatePct);
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  if (supply.interState) igstPaise = roundDiv(taxablePaise * charged, 10000);
  else {
    cgstPaise = roundDiv(taxablePaise * charged, 20000);
    sgstPaise = cgstPaise;
  }
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  return {
    quantity, unitPricePaise, discountType, discountValue, subtotalPaise, discountPaise, taxablePaise,
    gstRatePct, cgstPaise, sgstPaise, igstPaise, taxPaise, totalPaise: taxablePaise + taxPaise,
  };
}

// The whole document. roundOff: the grand total to the nearest rupee, shown as its own line.
function priceDocument(items, supply, { roundOff = true } = {}) {
  const lines = items.map((item) => ({ ...item, ...priceLine(item, supply) }));
  const sum = (field, list = lines) => list.reduce((total, line) => total + line[field], 0);
  const rates = [...new Set(lines.map((line) => line.gstRatePct))].sort((a, b) => a - b);
  const byRate = rates.map((ratePct) => {
    const group = lines.filter((line) => line.gstRatePct === ratePct);
    return {
      ratePct, taxablePaise: sum('taxablePaise', group), cgstPaise: sum('cgstPaise', group),
      sgstPaise: sum('sgstPaise', group), igstPaise: sum('igstPaise', group), taxPaise: sum('taxPaise', group),
    };
  });
  const exact = sum('totalPaise');
  const grandTotalPaise = roundOff ? roundDiv(exact, 100) * 100 : exact;
  return {
    items: lines,
    totals: {
      subtotalPaise: sum('subtotalPaise'), discountPaise: sum('discountPaise'), taxablePaise: sum('taxablePaise'),
      cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise'), taxPaise: sum('taxPaise'),
      roundOffPaise: grandTotalPaise - exact, grandTotalPaise, byRate,
    },
  };
}

module.exports = { roundDiv, supplyFor, priceLine, priceDocument };
