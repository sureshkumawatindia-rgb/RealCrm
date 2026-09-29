const { stateCodeFor, stateName } = require('../constants/gst');
const { supplyFor, priceLine, priceDocument, roundDiv } = require('../utils/gst');

// Phase 5 money math: pure functions, no database.
const intra = supplyFor({ sellerStateCode: '08', buyerState: 'Rajasthan' });
const inter = supplyFor({ sellerStateCode: '08', buyerGstin: '24AAACB1234C1Z5' });

describe('GST state codes', () => {
  it('reads codes, names and the usual other spellings', () => {
    expect(stateCodeFor('08')).toBe('08');
    expect(stateCodeFor('8')).toBe('08');
    expect(stateCodeFor('Rajasthan ')).toBe('08');
    expect(stateCodeFor('orissa')).toBe('21');
    expect(stateCodeFor('New Delhi')).toBe('07');
    expect(stateCodeFor('Jammu & Kashmir')).toBe('01');
    expect(stateCodeFor('25')).toBe('26'); // Daman and Diu merged into 26 in 2020
    expect(stateCodeFor('Narnia')).toBe('');
    expect(stateName('37')).toBe('Andhra Pradesh');
  });
});

describe('Place of supply', () => {
  it('same state → CGST + SGST; another state (from the GSTIN first) → IGST', () => {
    expect(intra).toMatchObject({ sellerStateCode: '08', placeOfSupplyCode: '08', interState: false, taxLabel: 'SGST', warnings: [] });
    expect(inter).toMatchObject({ placeOfSupplyCode: '24', placeOfSupply: 'Gujarat', interState: true });
    // The GSTIN wins over a typed state; an explicit place of supply wins over both.
    expect(supplyFor({ sellerStateCode: '08', buyerGstin: '08AAACB1234C1Z5', buyerState: 'Gujarat' }).interState).toBe(false);
    expect(supplyFor({ sellerStateCode: '08', buyerGstin: '08AAACB1234C1Z5', placeOfSupplyCode: '27' }).placeOfSupplyCode).toBe('27');
  });

  it('charges UTGST instead of SGST inside a Union Territory without a legislature', () => {
    expect(supplyFor({ sellerStateCode: '04', buyerState: 'Chandigarh' }).taxLabel).toBe('UTGST');
    expect(supplyFor({ sellerStateCode: '07', buyerState: 'Delhi' }).taxLabel).toBe('SGST'); // Delhi has a legislature
    expect(supplyFor({ sellerStateCode: '04', buyerState: 'Punjab' })).toMatchObject({ interState: true, taxLabel: 'SGST' });
  });

  it('assumes the seller\'s state for an unknown customer (D30), and warns', () => {
    const unknown = supplyFor({ sellerStateCode: '08' });
    expect(unknown).toMatchObject({ placeOfSupplyCode: '08', interState: false, stateAssumed: true });
    expect(unknown.warnings.map((w) => w.code)).toEqual(['BUYER_STATE_ASSUMED']);
    const noSeller = supplyFor({ buyerState: 'Gujarat' });
    expect(noSeller.interState).toBe(false);
    expect(noSeller.warnings.map((w) => w.code)).toEqual(['SELLER_STATE_UNKNOWN']);
  });

  it('treats a customer abroad as inter-state', () => {
    expect(supplyFor({ sellerStateCode: '08', placeOfSupplyCode: '99' })).toMatchObject({ interState: true, placeOfSupply: 'Other Country' });
  });
});

describe('Lines', () => {
  it('intra-state: half the rate as CGST and half as SGST', () => {
    expect(priceLine({ quantity: 10, unitPricePaise: 25000, gstRatePct: 5 }, intra)).toMatchObject({
      subtotalPaise: 250000, discountPaise: 0, taxablePaise: 250000, cgstPaise: 6250, sgstPaise: 6250, igstPaise: 0, taxPaise: 12500, totalPaise: 262500,
    });
  });

  it('inter-state: the full rate as IGST', () => {
    expect(priceLine({ quantity: 10, unitPricePaise: 25000, gstRatePct: 5 }, inter)).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 12500, totalPaise: 262500 });
  });

  it('takes the discount (% or flat) before GST, never below zero', () => {
    const percent = priceLine({ quantity: 3, unitPricePaise: 10050, discountType: 'percent', discountValue: 10, gstRatePct: 18 }, intra);
    expect(percent).toMatchObject({ subtotalPaise: 30150, discountPaise: 3015, taxablePaise: 27135, cgstPaise: 2442, sgstPaise: 2442, totalPaise: 32019 });
    const flat = priceLine({ quantity: 1, unitPricePaise: 100000, discountType: 'amount', discountValue: 15000, gstRatePct: 18 }, inter);
    expect(flat).toMatchObject({ taxablePaise: 85000, igstPaise: 15300, totalPaise: 100300 });
    expect(priceLine({ quantity: 1, unitPricePaise: 100, discountValue: 500, gstRatePct: 5 }, intra)).toMatchObject({ discountPaise: 100, totalPaise: 0 });
    expect(priceLine({ quantity: 1, unitPricePaise: 100, discountType: 'percent', discountValue: 150 }, intra)).toMatchObject({ discountValue: 100, totalPaise: 0 });
  });

  it('rounds each tax to the paisa, half up', () => {
    // 10 paise at 5%: IGST 0.5 → 1 paisa; CGST 0.25 → 0.
    expect(priceLine({ quantity: 1, unitPricePaise: 10, gstRatePct: 5 }, inter).igstPaise).toBe(1);
    expect(priceLine({ quantity: 1, unitPricePaise: 10, gstRatePct: 5 }, intra).cgstPaise).toBe(0);
    // 1.01 at 5% intra: CGST 2.525 paise → 3, SGST 3.
    expect(priceLine({ quantity: 1, unitPricePaise: 101, gstRatePct: 5 }, intra)).toMatchObject({ cgstPaise: 3, sgstPaise: 3, taxPaise: 6 });
    // Fractional quantities: 2.5 kg × ₹199.99 = ₹499.975 → ₹499.98.
    expect(priceLine({ quantity: 2.5, unitPricePaise: 19999 }, intra).subtotalPaise).toBe(49998);
    // Rates such as 0.25% (rough diamonds) and big amounts stay exact.
    const big = priceLine({ quantity: 1000000, unitPricePaise: 9999999, gstRatePct: 18 }, inter);
    expect(big.subtotalPaise).toBe(9999999000000);
    expect(big.igstPaise).toBe(1799999820000);
    expect(priceLine({ quantity: 3, unitPricePaise: 12345, gstRatePct: 0.25 }, inter).igstPaise).toBe(93); // 92.5875 → 93
    expect(roundDiv(5, 2)).toBe(3);
  });

  it('zero-rated supplies and 0% items charge no GST', () => {
    const lut = supplyFor({ sellerStateCode: '08', placeOfSupplyCode: '99', zeroRated: true });
    expect(priceLine({ quantity: 2, unitPricePaise: 50000, gstRatePct: 18 }, lut)).toMatchObject({ gstRatePct: 18, igstPaise: 0, taxPaise: 0, totalPaise: 100000 });
    expect(priceLine({ quantity: 2, unitPricePaise: 50000, gstRatePct: 0 }, intra)).toMatchObject({ taxPaise: 0, totalPaise: 100000 });
  });
});

describe('Documents', () => {
  const items = [
    { name: 'Cumin', quantity: 10, unitPricePaise: 25000, gstRatePct: 5 },
    { name: 'Steel rack', quantity: 1, unitPricePaise: 899950, discountType: 'percent', discountValue: 5, gstRatePct: 18 },
    { name: 'Rice (exempt)', quantity: 3, unitPricePaise: 4999, gstRatePct: 0 },
  ];

  it('adds the lines, groups the tax by rate and rounds the total to the rupee', () => {
    const { items: lines, totals } = priceDocument(items, intra);
    expect(lines.map((l) => l.name)).toEqual(['Cumin', 'Steel rack', 'Rice (exempt)']);
    expect(totals).toMatchObject({
      subtotalPaise: 250000 + 899950 + 14997,
      discountPaise: 44998,
      taxablePaise: 250000 + 854952 + 14997,
      cgstPaise: 6250 + 76946, sgstPaise: 6250 + 76946, igstPaise: 0,
    });
    const exact = totals.taxablePaise + totals.taxPaise; // ₹11,199.49 + ₹1,663.92 = ₹12,863.41
    expect(exact).toBe(1286341);
    expect(totals).toMatchObject({ roundOffPaise: -41, grandTotalPaise: 1286300 });
    expect(totals.byRate).toEqual([
      { ratePct: 0, taxablePaise: 14997, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0 },
      { ratePct: 5, taxablePaise: 250000, cgstPaise: 6250, sgstPaise: 6250, igstPaise: 0, taxPaise: 12500 },
      { ratePct: 18, taxablePaise: 854952, cgstPaise: 76946, sgstPaise: 76946, igstPaise: 0, taxPaise: 153892 },
    ]);
  });

  it('rounds down below 50 paise, up from 50, and can keep the exact total', () => {
    const at = (paise, options) => priceDocument([{ quantity: 1, unitPricePaise: paise }], intra, options).totals;
    expect(at(1179949)).toMatchObject({ roundOffPaise: -49, grandTotalPaise: 1179900 });
    expect(at(1179950)).toMatchObject({ roundOffPaise: 50, grandTotalPaise: 1180000 });
    expect(at(1179950, { roundOff: false })).toMatchObject({ roundOffPaise: 0, grandTotalPaise: 1179950 });
  });

  it('inter-state documents carry only IGST', () => {
    const { totals } = priceDocument(items, inter, { roundOff: false });
    expect(totals).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 12500 + 153891, roundOffPaise: 0 });
  });
});
