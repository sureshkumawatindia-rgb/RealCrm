# Migration Strategy

## 0. Server data migrations (in place since Phase 1)

`backend/src/migrations/` holds data migrations that run once, in order, when the server starts (after connecting to MongoDB). Each one is recorded in the `migrations` collection and must be idempotent, so a crash halfway is safe. Current list: `001-organization-field-names` (see [DATABASE.md](DATABASE.md)).

Browser data (localStorage) is per address: data entered on VS Code Live Server (`127.0.0.1:5501`) is not visible at `127.0.0.1:3000`. The server importer reads the browser it runs in, so run it on the address where the data was entered.

## 0b. Status of the importer (Phase 2)

Settings → Data & Privacy → **Move my browser data to server** (owners/admins) calls `POST /imports/localstorage`, first as a preview, then for real after confirmation.

| Browser key | Moves to | Since |
|---|---|---|
| `crm_products` | products (price → paise, gst → rate, quantity → stock) | Phase 2 checkpoint A |
| `crm_customers` | contacts, lifecycle customer | A |
| `crm_accounts` | contacts (company = account name) | A |
| `crm_leads` | leads + contacts (status mapped: In Progress → Contacted) | A |
| `crm_deals` | leads (D13; Qualified/Proposal → Quote Sent; timeline notes → activities) | A |
| `crm_lead_activities` | lead activities | A |
| `crm_quotations` | quotations (new FY numbers, old number kept as `legacyNumber`, totals recomputed) | A |
| `crm_tasks` | tasks (assignee matched to a team member by name, else the name is kept; related customer/lead/deal matched by name) | B |
| `crm_deal_tasks` | tasks with origin `deal_followup` (text → title, done → Done) | B |
| `crm_calendar_events` | calendar events (an end time before the start is dropped) | B |
| `crm_tickets` | tickets (old number kept when free, else a new number with the old one in `legacyNumber`; customer matched to a contact by name; the counter moves past the old numbers) and their `notes` → ticket notes | C |
| `crm_customer_notes` | contact notes (keyed by the old customer id, or by the server contact id for notes added after checkpoint A) | C |
| `crm_ticket_seq` | not needed (numbers come from the server counter) | C |
| `crm_documents` | documents: base64 files → private storage (same size limit and blocked types as uploads), links → `linkUrl` (`https://` added when missing; other schemes rejected); unknown owners → the person running the import | D |
| `crm_campaigns` | campaigns (budget → paise, an end day before the start is dropped, unknown owners → the person running the import) and their `notes` → campaign notes | E |
| `crm_workflows` | workflows (unknown trigger → rejected; unknown actions left out and reported; old `runsCount` kept as history) | E |
| `crm_sequences` | sequences (steps with an unknown type or a day outside 0–365 left out and reported; old `enrolledCount` kept) | E |
| `crm_agents` | pending invites (Account Champions): "View" only → viewer, otherwise agent, "Delete" → delete on their pages, never admin; name, mobile and role → `displayName`, `mobile`, `title`. No link is made: they join by signing in with Google using that email within 7 days (or the owner sends a new link). Teammates without an email are skipped and reported; current, disabled or removed members and existing invites are left alone. | F |

Every imported record keeps its old id in `legacyIds`, so the import can be run again after each checkpoint: it only adds what is new. Since checkpoint C, tasks, events, tickets, notes, documents, campaigns, workflows and sequences that were deleted on the server are not imported again. Products, contacts and leads deleted on the server still come back on a new run (to fix in checkpoint G).

## 1. Overview
The current CRM operates entirely on `localStorage`. A one-time migration API will allow users to upload their `localStorage` state to the new backend.

## 2. Migration API
`POST /api/v1/imports/localstorage`

**Payload:** A JSON object matching the `localStorage` dump (e.g. `crm_customers`, `crm_leads`, `crm_company`).

## 3. Rules & Transformations
1. **ID Generation:** All string IDs (`c_abc123`) will be converted to MongoDB `ObjectIds`.
2. **Relationships:** 
   - Since legacy items rely on strings (e.g., `product: "Pro Plan"`), the importer will attempt to resolve them by name against the newly created Products during import.
   - Any unresolved relationships will be reported in the Import Report and set to null.
3. **Field Mapping:**
   - `price` → `basePrice`
   - `quantity` → `quantityInStock`
   - `gst` → `gstPercentage`
   - `pincode` → `postalCode`
4. **Tenant Scoping:** All imported records will be attached to the current user's `organizationId`.
5. **No Client Auth Import:** `crm_session` and `crm_user` will NOT be imported.
6. **Validation:** Records failing strict backend validation will be skipped and added to a rejected rows report.

## 4. Result
The API returns a summary report:
```json
{
  "success": true,
  "data": {
    "customersImported": 50,
    "leadsImported": 120,
    "rejectedRows": [...],
    "unresolvedRelationships": [...]
  }
}
```
