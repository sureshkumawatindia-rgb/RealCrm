# Decisions Required

## Status (2026-09-24)

These questions are answered by the decision log in [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 9. The original questions are kept below for context.

| # | Question | Answer |
|---|---|---|
| 1 | Account vs Customer | D3: one Contact per phone number; legacy Accounts merge into `Contact.company`; "Account Champions" stays the team page (Phase 2) |
| 2 | Pricing, currency, tax | D1/D2: INR in paise, tax-exclusive prices, CGST+SGST or IGST by place of supply (Phase 5) |
| 3 | Inventory | D7: informational; optional "reduce stock on Dispatched" |
| 4 | Organization fields | D14: `gstin`, `stateCode`, `postalCode`, `size`, `foundedYear` — **done in Phase 1** (migration 001) |
| 5 | Email uniqueness | D3: the phone number is the unique key per organization; email is optional |
| 6 | Pipeline statuses | D4 + D13: one lead pipeline New → Contacted → Quote Sent → Negotiation → Won / Lost |
| 7 | Quotation lifecycle | D6: Draft → Sent → Viewed → Accepted / Rejected / Expired, revisions, FY numbering |
| 8 | Ticket SLA | Basic CRUD with atomic numbers first (Phase 2); SLA later |
| 9 | Document storage | Local `uploads/` behind a storage interface; S3/R2-compatible later |
| 10 | Agent permissions | D17: agents see assigned records; `view_all` per module — **roles and permissions done in Phase 1** |
| 11 | Duplicate customers | Dedupe by phone and source reference |
| 12 | Simulated features | Real, job-backed automation in Phase 6; AI as an opt-in add-on in Phase 10 |

## Original questions

The following unresolved product decisions have been identified during the Phase 0 audit and must be confirmed or resolved.

### 1. Account vs Customer
- **Observation:** There is a visible legacy `accounts.html` form, but active code uses "account" mostly as a deal display field or company alias. 
- **Decision:** Should `Account` be retained as a distinct model (e.g. B2B Account with many Customers/Contacts), merged entirely into `Customer`, or removed?

### 2. Pricing, Currency, and Tax
- **Observation:** The frontend handles pricing casually. It has a mix of tax-inclusive and exclusive logic (`value`, `gstAmount`).
- **Decision:** 
  - What is the default currency? (e.g., USD, INR).
  - Are product base prices tax-exclusive or tax-inclusive?
  - What is the specific GST/tax jurisdiction requirements?
  - Are discounts flat amounts or percentages?

### 3. Product Inventory
- **Observation:** `quantityInStock` exists but is only a display number. It does not decrease when deals are WON or quotations are made.
- **Decision:** Should the backend implement strict transactional inventory reservations, or is stock purely informational?

### 4. Organization Details Schema
- **Observation:** Frontend uses `gst`, `size`, `pincode` in one place and `taxId`, `employees`, `zip` in another.
- **Decision:** Standardize on `taxId`, `employees`, and `postalCode`?

### 5. Customer Email Uniqueness
- **Observation:** `email` is required on the frontend form.
- **Decision:** Should `email` be strictly unique per organization? (Can multiple contacts share an email?)

### 6. Pipeline Statuses
- **Observation:** Exact stages are fluid in the frontend (`New|Contacted|Qualified|Proposal|Negotiation|Won|Lost`).
- **Decision:** What is the canonical, strict list of Lead statuses and Deal stages? What are the allowed transitions?

### 7. Quotation Lifecycle
- **Observation:** Quotations are currently generated directly from lead selections with no distinct Quotation page.
- **Decision:** Are quotations a financial commitment? Should they require approval workflows?

### 8. Ticket SLA and Automation
- **Observation:** Ticket properties (SLA, replies) exist conceptually but are not implemented.
- **Decision:** Should the backend just implement basic CRUD for now, or build out an SLA engine immediately?

### 9. Document Storage Provider
- **Observation:** Documents use local Base64/Object URLs.
- **Decision:** Which object storage provider will be used in production? (AWS S3, Google Cloud Storage, Cloudinary)?

### 10. Agent Permissions & Record Scope
- **Observation:** Roles include `owner`, `admin`, `agent`, `viewer`, but they are never enforced.
- **Decision:** Can an `agent` view ALL records in the organization, or ONLY records assigned to them?

### 11. Customer Duplicate Policy
- **Observation:** Conversion could create duplicate customers if clicked multiple times concurrently or if the name matches slightly differently.
- **Decision:** What defines a duplicate customer? (e.g. Exact email match? Exact phone match?). Currently, the algorithm states to use an "approved deterministic source key" for conversion.

### 12. "Simulated" Features
- **Observation:** Workflows, sequences, and AI insights are simulated on the frontend.
- **Decision:** Should the backend APIs for Phase 7 (Workflows) actually integrate with an email provider (like SendGrid), or remain configuration-only for now? Should AI Insights actually call an LLM (like Gemini) or remain deterministic?
