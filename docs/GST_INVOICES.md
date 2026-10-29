# GST tax invoices, credit notes and receipts (D101)

What the CRM makes from an order, which GST rules it follows, and what it does not do yet.
The rules below were read on **2026-10-28**. GST law changes by notification, so check anything
that matters with your CA, and read the GST portal again before relying on a limit.

## What you get

| Document | Made when | Number | Changed later? |
| --- | --- | --- | --- |
| **Tax invoice** | "Make tax invoice" on the order, or by itself when the order is moved to Dispatched (Settings → Billing → "Make the tax invoice by itself when an order is dispatched", off by default). An accepted quotation has "Order + tax invoice". | `INV/26-27/0001` | Never. A mistake is put right with a credit note. |
| **Credit note** | An owner or admin takes back the whole invoice or part of its lines (a quantity returned, or an amount off a line's price). | `CN/26-27/0001` | Never. |
| **Payment receipt** | Every payment on an order: a payment link paid, or a payment entered by hand. | `RCPT/26-27/0001` | A payment removed by mistake leaves its receipt **cancelled**, never deleted. |

- One live invoice per order. After the invoice is taken back in full by credit notes, the order
  can be invoiced again (a new number).
- The numbers run without gaps: the counter moves in the same database transaction as the
  document, so a failed attempt uses no number. Each kind counts from 0001 again on 1 April.
- The prefix (1 to 4 letters or digits) is changed in Settings → Billing → Numbers. The year is
  written short (`26-27`) so a number stays within GST's 16 characters up to 99,999 a year; a
  number that would pass 16 characters is refused with a message to use a shorter prefix.
- The PDFs use the layout of the quotation PDF: logo, the seller's name, address and GSTIN, the
  customer, the place of supply, the items with HSN/SAC, the GST by rate, the amount in words,
  the bank details, a UPI QR for the balance due, and "For <company> / Authorised signatory".
  The invoice also shows the amount paid on the order and the balance due.
- Send on WhatsApp from the order: inside the 24-hour window as a document with a message;
  outside it only an approved template (one with a **Document** header carries the PDF).
- Reports → Payments → "Invoiced vs collected": tax invoices less credit notes (by their dates)
  next to the payments received, per day, week or month, with the GST on the invoices.

## CGST Rule 46: what a tax invoice shows

| Rule 46 | On the CRM's invoice |
| --- | --- |
| (a) the supplier's name, address and GSTIN | From Settings → Company. The CRM refuses to make an invoice without your GSTIN and address. |
| (b) a consecutive serial number, at most 16 characters (letters, digits, `-` and `/`), unique in a financial year | `INV/26-27/0001` (see above). |
| (c) the date | The day it is made. |
| (d) the recipient's name, address and GSTIN, if registered | Checked in the "Make tax invoice" window (they can be put right there, before the invoice is made). |
| (e) a recipient without a GSTIN, taxable value ₹50,000 or more: name, address, delivery address, and the state's name and code | The CRM asks for the address and state first. The state is printed with its code, e.g. "Maharashtra (27)". |
| (f) HSN code of goods or SAC of services | From the product. A B2B invoice with a line without a code gets a warning. How many digits you must print depends on your turnover (Notification 78/2020-Central Tax: 4 digits up to ₹5 crore, 6 above, for B2B) — not re-checked on 2026-10-28; ask your CA. |
| (g) description, (h) quantity with unit, (i)–(k) value, discount, taxable value | The items table. |
| (l)–(m) the rate and amount of central, state / union territory and integrated tax | The GST % on every line, CGST + SGST (or UTGST) or IGST in the totals, and the GST by rate. |
| (n) place of supply, with the state's name for supplies between states | "Place of supply: Delhi (07)". |
| (o) the delivery address, where different from the place of supply | Not printed separately: the CRM bills and delivers to the same address. If you deliver elsewhere, write it in the order notes and talk to your CA. |
| (p) whether tax is payable on reverse charge | "Reverse charge: No" (the CRM does not make reverse-charge invoices). |
| (q) signature or digital signature | "For <company> / Authorised signatory": sign the printed copy, or use a digital signature. |

Rule 48 (copies for goods): the PDF is marked "ORIGINAL FOR RECIPIENT". Print a duplicate for the
transporter and a triplicate for yourself if you need paper copies.

Exports and supplies to an SEZ under a letter of undertaking: the zero-rated note is printed and
no GST is charged (as on quotations).

## CGST Rule 53(1A) and section 34: credit notes

A credit note shows "CREDIT NOTE", its own number and date, the recipient, **the original
invoice's number and date**, the taxable value, the tax rate and amount, and the signature line.
The reason is printed under "Reason".

- **The whole invoice:** everything still on it, to the paisa — the last credit note also takes
  the invoice's round-off, so the credit notes always add up to the invoice's total exactly.
- **Some lines:** a quantity (goods returned, at what is left of the line's value per unit) or an
  amount off the line's taxable value (a price corrected). GST is taken back at the line's rate,
  split as on the invoice (CGST + SGST, or IGST). A line can never give back more than is left on
  it, and partial credit notes can never pass the invoice's total.
- **Time limit (section 34(2)):** the GST on a credit note can be reduced in your returns only
  until **30 November after the end of the invoice's financial year** (or the date you file the
  annual return, if earlier). The CRM still makes a later credit note but warns that the GST can
  no longer be reduced.
- What the customer owes on the order drops by each credit note (the order's due, the "Payment due"
  list, a new payment link and the reports follow it).
- A debit note (to charge more after the invoice) is not made yet: make a new order and invoice
  for the difference, or ask your CA.

## Receipts

A receipt says who paid, how much (in words too), for which order and invoice, how (UPI, bank
transfer, cash …), the reference, and what the order still owes after that payment. It is a
payment acknowledgement, **not a GST document**. Money received **before** the supply (an
advance) may need a GST "receipt voucher" (CGST Rule 50) — especially for services, where GST is
due on advances. The CRM does not make receipt vouchers yet: ask your CA.

## Not done: e-invoice (IRN) and e-way bill

**E-invoicing is compulsory** for a business whose aggregate turnover in any financial year from
2017-18 is **more than ₹5 crore** (Notification 10/2023-Central Tax, from 1 August 2023). Read on
2026-10-28 through secondary sources, because the CBIC site did not open; check the GST portal or
einvoice1.gst.gov.in before relying on it. Below ₹5 crore the CRM's invoice is enough.

How it would be added later (a decision for then, not built now):

1. Pick a GST Suvidha Provider (GSP) or the IRP's direct API, and store its credentials in
   Settings → Integrations (per company), never in the code.
2. When an invoice is made, send its JSON (schema INV-01: seller, buyer, items with HSN, values,
   tax split — the CRM already keeps all of these on the invoice) to the IRP.
3. Save what comes back on the invoice: the IRN, the acknowledgement number and date, and the
   signed QR code; print the QR and the IRN on the PDF.
4. Cancelling: an IRN can be cancelled only within 24 hours; after that, a credit note (which
   gets its own IRN).
5. Credit notes get an IRN too; invoices to customers without a GSTIN (B2C) do not.

**E-way bill:** not made. One is generally needed to move goods worth more than ₹50,000 in a
consignment (CGST Rule 138; some states set other limits within the state; not re-checked on
2026-10-28). Make it on
ewaybillgst.gov.in; the order's transporter, LR number and vehicle number are there to copy.

**Composition scheme:** a business under composition must not charge GST and issues a "bill of
supply" instead of a tax invoice. The CRM's tax invoice is for regular registered businesses;
a bill of supply is not made yet.

## For developers

- Models: `TaxInvoice` (`kind` invoice / credit_note, never edited after it is made except
  `status`, `credited[]` and `creditedPaise` of an invoice, and `sentAt`) and `PaymentReceipt`.
  See `docs/DATABASE.md`.
- `services/invoiceService.js`: numbering, invoices, credit notes (`creditLine` is the per-line
  money), receipts, sending. `services/invoicePdf.js`: the PDFs, on `renderDocumentPdf` in
  `services/quotationPdf.js`.
- Hooks in `services/orderService.js`: `recordPayment` issues the receipt in its transaction;
  `removeManualPayment` cancels it; a move to Dispatched (or later) makes the invoice when
  `billing.invoiceOnDispatch` is on and the order never had one.
- Endpoints: `docs/API.md` → "Tax invoices, credit notes and receipts".
- Tests: `src/tests/taxInvoices.test.js` (money within the state and between states, round-off,
  credit notes in part and in full, numbering under load, receipts, invoice on dispatch, PDFs,
  WhatsApp, the report).
