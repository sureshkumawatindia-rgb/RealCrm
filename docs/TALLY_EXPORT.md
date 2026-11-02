# Tally export (G5, D109)

The CRM gives your tax invoices, credit notes and receipts to Tally as two files. Owners and admins
download them in **Settings → Billing → Tally** for a period of up to a year.

## What is in the files

**1. Ledgers** (`tally-ledgers-<from>-to-<to>.xml`, Tally's "All Masters")

- Every customer of the period under **Sundry Debtors**, bill-wise on, with the address, state and
  GSTIN from the invoice (registration type Regular with a GSTIN, else Unregistered). The ledger's
  name is the customer's company on the invoice, else the person's name.
- Your own ledgers that the vouchers use, with the names you set (defaults in brackets):
  sales (`Sales`, under Sales Accounts; or one per GST rate: `Sales 5%`, `Sales 18%` …),
  CGST (`Output CGST`), SGST/UTGST (`Output SGST`) and IGST (`Output IGST`) under Duties & Taxes
  as GST Central, State and Integrated Tax, round off (`Round Off`, under Indirect Expenses),
  bank (`Bank`, under Bank Accounts), cash (`Cash`, under Cash-in-Hand) and payment links
  (`Bank`).

**2. Vouchers** (`tally-vouchers-<from>-to-<to>.xml`, Tally's "Vouchers"), in accounting voucher view

| CRM document | Tally voucher | Debit | Credit |
| --- | --- | --- | --- |
| Tax invoice | Sales | the customer (bill-wise: New Ref = the invoice number) | sales, CGST + SGST or IGST, round off |
| Credit note | Credit Note | sales, the GST taken back, round off | the customer (Agst Ref = the invoice) |
| Receipt | Receipt | cash, the bank, or the payment-link ledger | the customer (Agst Ref = its invoice, else On Account) |

Each voucher keeps the CRM's number (INV/26-27/0001 …), the date, the order number as reference, the
customer's GSTIN and place of supply, and balances to the paisa. Receipts of payments that were
removed in the CRM (cancelled) are left out. Each voucher carries the CRM's own id (`REMOTEID`), so
Tally can tell a voucher it already has; still, import each period once.

## Import into Tally

1. Write your ledger names in **Settings → Billing → Tally → Ledger names in your Tally**, exactly
   as they are in your Tally, and save.
2. Pick the period and **Download ledgers**. In TallyPrime: **Import → Masters**, choose the file.
   If Tally asks what to do with masters that exist, choose **Ignore duplicates**. (Tally.ERP 9:
   Gateway of Tally → Import of Data → Masters.)
3. **Download vouchers**. In TallyPrime: **Import → Transactions**, choose the file. (Tally.ERP 9:
   Import of Data → Vouchers.)
4. If Tally asks for the file's encoding, choose **UTF-8**. Tally lists what it imported and any
   errors (TallyPrime: in the import report; Tally.ERP 9: the `Tally.imp` file).

**Before the first import**

- Credit notes need the **Credit Note** voucher type: in Tally.ERP 9, F11 → Accounting Features →
  Use debit/credit notes = Yes.
- With "one sales ledger per GST rate", set each rate's GST details on its sales ledger in Tally once
  (or let your accountant do it), so Tally's GST reports pick the rate.
- Payment-gateway money (payment links) usually reaches the bank after the gateway's fees: name a
  clearing ledger such as `Razorpay` for payment links if your accountant keeps one.
