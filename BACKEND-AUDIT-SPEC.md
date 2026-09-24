# CRM Backend Audit and Architecture Specification

Status: frontend audit complete; backend implementation intentionally not started.
Source of truth: `crm/frontend` (19 HTML pages, 19 JavaScript files, and 13 CSS files).

## 1. Audit Summary

The application is currently a static, client-only CRM. There are no `fetch`, Axios, XHR, server sessions, database calls, or API contracts. Records are JSON in browser `localStorage`; authentication is the presence of `crm_session`. Shared persistence and pricing helpers live in `crm/frontend/js/app.js`.

Observed product areas:

- Authentication and company setup: `index.html`, `login.html`, `company.html`, `Settings.html`.
- CRM records: customers, leads, accounts, agents, products, deals.
- Work management: tasks, calendar events, deal follow-up tasks.
- Service: tickets and ticket notes.
- Revenue and marketing: quotations, campaigns, workflows, sequences.
- Content: documents and customer/lead notes.
- Read-only aggregation: dashboard, reports, AI insights, customer 360.

The backend must replace browser-wide shared state with tenant-scoped, server-owned records. The frontend does not establish tenant, ownership, permission, currency, tax jurisdiction, inventory, or concurrency semantics.

### Important observed defects to resolve during migration

- `accounts.html` exposes a legacy account CRUD form, but `accounts.js` manages agents and does not wire that form.
- `Marketing.html` uses an inline campaign implementation and does not load `marketing.js`; its status columns differ from the external script.
- `company.html` uses an inline implementation and persists `gst`, `size`, and `pincode`, while shared review code expects `taxId`, `employees`, and `zip`.
- Deals can be cleared on first load by the demo cleanup logic; reset removes its cleanup marker.
- Lead and deal WON conversion is triggered on updates, not consistently on create, and can create quotations on ordinary lead edits.
- Most cross-entity links are display-name strings. Product, agent, customer, and record renames can break relationships.
- There is no pagination or user-controlled sorting. Some views slice a fixed number of client-side records.
- Reports mix selected date ranges with all-time charts; ticket resolution uses creation date.
- Automation `Run Now` and `Enroll` create tasks, but email/notification/status actions are simulations.
- AI Insights are deterministic local heuristics, not an AI integration.

Anything requiring a product choice is marked `⚠️ AMBIGUOUS / NEEDS DECISION` below.

## 2. Current Storage and Data Flow

| Browser key | Backend target | Evidence and behavior |
|---|---|---|
| `crm_session` | server session/refresh-token mechanism | presence-only auth; no expiry |
| `crm_user` | User | Google `sub`, email, name, picture; editable in Settings |
| `crm_company` | Organization/company profile | setup form, dashboard and modal review |
| `crm_customers` | Customer | shared add/update/delete; search and Active/Inactive filter |
| `crm_leads` | Lead | CRUD, stage updates, notes, product, quantity, value, follow-up |
| `crm_accounts` | Account | helper exists; visible legacy UI is unwired |
| `crm_agents` | User membership/agent profile | onboarding wizard, module and global permissions |
| `crm_products` | Product | CRUD, category/stock filters, inline editing |
| `crm_quotations` | Quotation | generated from lead product selections; no quotation page |
| `crm_deals` | Deal | Kanban/table, drag stage, filters, notes and delete |
| `crm_deal_tasks` | DealTask or Task relation | lightweight deal-specific follow-ups |
| `crm_tasks` | Task | CRUD, Kanban/table, filters, drag status |
| `crm_calendar_events` | CalendarEvent | CRUD and month view; tasks/deal dates are overlays |
| `crm_tickets` | Ticket | CRUD, numeric sequence, notes, filters, overdue queue |
| `crm_ticket_seq` | server-side sequence/counter | starts at 1000; must be atomic |
| `crm_campaigns` | Campaign | CRUD, Kanban/table, notes and filters |
| `crm_workflows` | Workflow | CRUD, dynamic actions, run count |
| `crm_sequences` | Sequence | CRUD, dynamic steps, enrollment count |
| `crm_documents` | Document metadata plus object storage | links or base64 files, filters, download/open |
| `crm_lead_activities` | LeadActivity | created for lead events; not materially surfaced everywhere |
| `crm_customer_notes` | CustomerNote | notes keyed by customer ID in Customer 360 |

The migration importer should accept these keys as a one-time source format, validate each row, generate server IDs/timestamps, report rejected rows, and never import a client session token.

## 3. Canonical Entities and Schemas

All schemas include `_id: ObjectId`, `organizationId: ObjectId`, `createdAt`, `updatedAt`, and `deletedAt: Date|null` unless noted. Use Mongoose `timestamps`, `strict` mode, and references rather than names. User-entered free text remains optional where the frontend allows it.

### Organization

Purpose: tenant boundary and company profile. Fields: `name` required string, `industry` optional string, `size` optional enum/string, `foundedYear` optional integer, `logoUrl` optional URL, `website` optional URL, `email` optional email, `phone` optional string, `taxId` optional string, `address`, `city`, `state`, `country`, `postalCode`, `description` optional strings. Unique: normalized name only if product elects it; tax ID unique per organization only when present. `employees` may be integer, but the frontend's `size` and `employees` mismatch is `⚠️ AMBIGUOUS / NEEDS DECISION`.

### User and membership

`User`: `email` required and normalized, `name` required, `pictureUrl`, `googleSubject` unique sparse, `passwordHash` only if password login is approved, `lastLoginAt`, `disabledAt`. `OrganizationMember`: `organizationId`, `userId`, `role` enum `owner|admin|agent|viewer`, `modules` array of known module enums, `permissions` array of explicit permission strings, `createdAt`. Unique compound index `(organizationId,userId)`. The frontend calls members agents; preserve an agent-facing API alias only if needed for compatibility.

### Customer

Fields: `name` required, `email` required by current form and normalized, `phone`, `company`, `address`, `product` legacy display field, `status` enum `Active|Inactive`, `ownerId` optional member reference, `sourceLeadId`, `sourceDealId` sparse references, `notes`. Email uniqueness is `⚠️ AMBIGUOUS / NEEDS DECISION`: enforce per organization only after deciding whether multiple contacts can share an email. Source references are unique sparse where conversion policy permits one customer per source.

### Lead

Fields: `name` required, normalized `email`, `phone`, `company`, `productId` optional Product reference, `quantity` optional positive integer, `status` enum observed in UI: `New|Contacted|Qualified|Proposal|Negotiation|Won|Lost` (exact list must be confirmed), `value` legacy/manual amount, `followUpDate`, `notes`, `convertedCustomerId`, `ownerId`, `version`. Store activity records separately. A lead's submitted value must not be trusted; its authoritative amount must be defined from quotation/deal data. `Won` requires an idempotent conversion operation.

### Product

Fields: `name` required, `category` optional string or Category reference, `basePrice` required non-negative Decimal128, `quantityInStock` optional non-negative integer, `gstPercentage` optional number 0..100, `description`, `active` default true, `createdById`. Accept legacy `price`, `quantity`, `gst` only at migration/API boundary and normalize them. Do not store `gstAmount` or `finalPrice` as authoritative product fields; they are derived from base price and tax policy. `⚠️ AMBIGUOUS / NEEDS DECISION`: whether stock is real inventory or only a display number.

### Deal

Fields: `name` required, `accountId` optional Account reference, `contactId` optional Customer/Contact reference, `leadId` optional Lead reference, `customerId` optional Customer reference, `value` Decimal128, `currency` required after decision, `closeDate`, `stage`, `ownerId`, `probability` 0..100, `notes`, `convertedCustomerId` legacy alias, `version`. Observed stages include `Lead`, `Qualified`, `Proposal`, `Negotiation`, `Won`, and likely `Lost`; exact pipeline is `⚠️ AMBIGUOUS / NEEDS DECISION`. Stage changes must be validated server-side and set or validate probability.

### Account

The visible legacy HTML suggests an account/company contact concept, while active code uses account only as a deal display field. Fields should be `name`, `email`, `phone`, `company`, `status`, `ownerId`, and notes only if the legacy form is confirmed in scope. `⚠️ AMBIGUOUS / NEEDS DECISION`: retain Account as a collection, merge it into Customer, or remove it.

### Quotation and quotation item

`Quotation`: `number` unique per organization and year, `leadId`, optional `dealId`/`customerId`, `status` enum at minimum `Draft` (other lifecycle values are not implemented), `quotationDate`, `validUntil`, `currency`, `subtotal`, `discountTotal`, `taxTotal`, `grandTotal`, `createdById`, `items`. Each item embeds immutable snapshot fields: `productId`, `productName`, `quantity` positive, `unitBasePrice`, `gstPercentage`, `discountAmount`, `taxAmount`, `lineTotal`. Recalculate all totals server-side. Embedding items preserves the price shown at quotation time; references alone would change historical values when products change.

### Task and DealTask

Canonical `Task`: `title` required, `description`, `assigneeId` optional for automation but required for manual creation if retained, `dueDate`, `priority` enum observed `Low|Medium|High`, `status` enum observed `To Do|In Progress|Completed` (confirm exact casing), polymorphic relation `relatedType` and `relatedId`, `createdById`, `completedAt`. Replace `relatedName` with an ID. DealTask should either be migrated into Task with `relatedType=Deal` or retained as a separate embedded lightweight record; consolidation is recommended.

### CalendarEvent

Fields: `title` required, `type`, `startAt`, `endAt`, `timezone`, `assigneeId`, `relatedType`, `relatedId`, `description`, `createdById`. Validate end after start and store instants plus the user's timezone. Tasks and open deal close dates are derived overlays, not duplicate calendar events.

### Ticket

Fields: `number` required unique per organization, generated atomically from a counter, `subject` required, `customerId` optional/required after decision, `category`, `priority`, `status`, `assigneeId`, `dueDate`, `description`, `notes` or separate TicketNote, `resolvedAt`, `createdById`. Current UI uses customer and assignee names; API should return populated summaries while storing IDs. `⚠️ AMBIGUOUS / NEEDS DECISION`: SLA, reply, attachment, and resolution rules are not implemented.

### Campaign, Workflow, Sequence

`Campaign`: `name`, `type`, `status`, `startDate`, `endDate`, `budget`, `leadsGenerated`, `audience`, `ownerId`, `description`, notes. `Workflow`: `name`, `status`, `ownerId`, `trigger`, `actions[]`, `runsCount`. `Sequence`: `name`, `targetType`, `status`, `ownerId`, `steps[]`, `enrolledCount`. Actions and steps are configuration JSON validated against allowlisted discriminated types. Actual email/notification delivery is not present and must not be implied by the API. Counters are derived/atomic, not trusted from clients.

### Document

Fields: `name` required, `category`, `ownerId`, `relatedType`, `relatedId`, `tags[]`, `description`, `storageKey`, `linkUrl`, `mimeType`, `sizeBytes`, `checksum`, `createdById`. Do not store base64 file content in MongoDB for production; use object storage and signed URLs. Validate URL scheme, MIME type, size, and authorization. `⚠️ AMBIGUOUS / NEEDS DECISION`: allowed categories and storage provider.

### Activity, notes, audit log

`LeadActivity`: `leadId`, `type`, `text`, `actorId`, `createdAt`; append-only. `CustomerNote` and `TicketNote`: parent ID, body, author, timestamps. `AuditLog`: organization, actor, action, entity type/ID, before/after or a redacted diff, request ID, IP/user agent, createdAt; append-only and access restricted.

## 4. Relationships and Consistency

- Organization 1-to-many members and every business record. Every query must include `organizationId` from authenticated context.
- Lead optionally references Product and converts to exactly one Customer through `convertedCustomerId`.
- Deal optionally references Lead, Account, Customer/Contact, and owner; a WON Deal links to exactly one Customer.
- Customer has many Deals, Tasks, Events, Tickets, Documents, Notes, and Activities.
- Product is referenced by current records; quotation items embed product snapshots.
- User membership is referenced by owner/assignee fields, never copied as the only relationship.
- Campaign/Workflow/Sequence may target leads/customers and may create Tasks; execution is separate from configuration.

Use ObjectId references for independently queried records. Use embedded item snapshots for quotations and small configuration arrays. Use separate collections for activities, notes, audit logs, and potentially large attachments.

### WON conversion algorithm

Implement `POST /leads/:id/convert` and `POST /deals/:id/convert` as idempotent service operations. In a MongoDB transaction: lock/read the source, verify allowed transition, find the source's existing customer, otherwise create one using a deterministic organization/source unique key, set `convertedCustomerId`, and append an activity/audit event. Repeated requests return the same customer. A unique sparse index on `(organizationId,sourceLeadId)` and `(organizationId,sourceDealId)` prevents duplicates; retry the transaction on transient conflicts. Creating a record initially as WON must call the same service.

## 5. REST API

All endpoints are under `/api/v1`, require an authenticated organization context unless marked public, and use `page`/`limit` with a server maximum of 100. List endpoints support `q`, documented filters, `sort`, and `fields` only from allowlists. Mutations accept `Idempotency-Key` for retriable create/convert operations and `If-Match` or `version` for optimistic concurrency.

### Auth and organization

- `GET /auth/me`: current user and memberships.
- `POST /auth/google`: verify Google ID token server-side, provision/link user, issue access and refresh tokens.
- `POST /auth/refresh`: rotate refresh token and issue access token.
- `POST /auth/logout`: revoke refresh-token family/session.
- `GET/PATCH /organization`: read/update company profile; admin/owner only for writes.
- `GET/POST /members`, `GET/PATCH/DELETE /members/:id`, `POST /members/:id/resend-invite`: member administration; owner/admin authorization.

### Shared CRUD resources

For customers, leads, accounts, products, deals, tasks, events, tickets, campaigns, workflows, sequences, and documents, expose:

`GET /resources`, `POST /resources`, `GET /resources/:id`, `PATCH /resources/:id`, `DELETE /resources/:id`.

Use these resource-specific query contracts:

- Customers: `q` over name/email/company; `status`, `ownerId`.
- Leads: `q` over name/email/company; `status`, `ownerId`, `followUpFrom`, `followUpTo`, `productId`.
- Accounts: `q`, `status`, `ownerId`, pending decision.
- Products: `q` over name/category; `category`, `active`, `stockMin`, `stockMax`.
- Deals: `q` over name/account/contact; `stage`, `ownerId`, `valueMin`, `valueMax`, `closeFrom`, `closeTo`.
- Tasks: `q` over title/description; `status`, `priority`, `assigneeId`, `dueFrom`, `dueTo`, `relatedType`, `relatedId`.
- Events: `from`, `to`, `type`, `assigneeId`, `relatedType`, `relatedId`.
- Tickets: `q` over number/subject/customer; `status`, `priority`, `category`, `assigneeId`, `overdue`.
- Campaigns: `q`, `type`, `status`, `ownerId`, date range.
- Workflows/sequences: `q`, `status`, `ownerId`.
- Documents: `q` over name/tags; `category`, `relatedType`, `relatedId`, `ownerId`.

Additional endpoints:

- `POST /leads/:id/activities`, `GET /leads/:id/activities`, `POST /leads/:id/convert`.
- `POST /deals/:id/convert`, `POST /deals/:id/stage`; stage service validates transition and probability.
- `GET /deals/pipeline` returns grouped, filtered Kanban data.
- `POST /deals/:id/tasks`, `GET /deals/:id/tasks` if DealTask remains separate.
- `POST /leads/:id/quotations`, `GET /quotations`, `GET/PATCH/DELETE /quotations/:id`.
- `POST /tickets/:id/notes`, `GET /tickets/:id/notes`; analogous customer notes endpoints.
- `POST /documents/upload` returns an upload URL; `GET /documents/:id/download` returns an authorized signed URL.
- `POST /workflows/:id/run`, `POST /sequences/:id/enroll`; execution must be idempotent and report whether work is simulated or queued.
- `GET /dashboard/summary`, `GET /reports`, `GET /reports/export`, `GET /insights`, `GET /customers/:id/360`.
- `GET /audit-logs` for authorized admins.
- `POST /imports/localstorage`, `GET /imports/:id`, `GET /exports/crm` for controlled migration/export.

### Mutation validation and authorization

Controllers validate request DTOs; services revalidate business rules. Never accept organization, owner, role, calculated totals, stage probability, or audit actor from the client. A user needs module permission plus record scope: admins/owners can manage organization records, agents can manage assigned/created records according to policy, and viewers are read-only. The exact agent scope is `⚠️ AMBIGUOUS / NEEDS DECISION` because the frontend only presents permissions and never enforces them.

## 6. Response Contracts

Single resource:

```json
{"success":true,"data":{},"message":"Customer retrieved"}
```

List:

```json
{"success":true,"data":[],"pagination":{"page":1,"limit":20,"total":100,"totalPages":5,"hasNextPage":true,"hasPreviousPage":false}}
```

Errors:

```json
{"success":false,"message":"Validation failed","code":"VALIDATION_ERROR","errors":[{"field":"email","code":"INVALID_EMAIL","message":"Enter a valid email"}],"requestId":"..."}
```

Use 400 invalid query/body, 401 missing/expired token, 403 insufficient permission, 404 missing or inaccessible resource, 409 duplicate/state/version conflict, 413 oversized upload, 422 semantically invalid transition, 429 rate limit, and 500 with a generic message. Never expose stack traces, Mongo errors, tokens, or password hashes.

## 7. Pricing, GST, and Inventory

Current product helper calculates `gstAmount = basePrice * gstPercentage / 100` and `finalPrice = basePrice + gstAmount`. Lead value is initially product price times quantity, excluding GST. Quotation totals instead use item quantity, unit price, fixed discount, and item tax; new lead quotation items initialize tax to zero. These are contradictory tax models.

Recommended authoritative model:

1. Product stores base price and tax rate/policy only.
2. Quotation/deal commands send product IDs, quantities, and permitted discounts; the server loads current pricing and calculates line subtotal, tax, and total using Decimal128 or integer minor units.
3. Persist quotation snapshot amounts and calculation version for historical reproducibility.
4. Round using one documented currency policy and reject negative quantity, price, tax, or discount.
5. Never trust `value`, `gstAmount`, `finalPrice`, `subtotal`, `tax`, or `grandTotal` sent by the browser.
6. Do not decrement inventory until an explicit inventory policy and transaction boundary are approved. Current frontend never performs inventory changes.

`⚠️ AMBIGUOUS / NEEDS DECISION`: currency, tax-inclusive versus tax-exclusive entry, GST jurisdiction/components, discount semantics (amount versus percentage), rounding, and whether quotations are financial commitments.

## 8. Search, Indexes, Pagination

Use cursor pagination for large activity/document lists and page/limit for the current UI. Default sort is `createdAt desc`; allowlisted alternatives include name, status, due date, close date, and value. Use projections and `.lean()` for read-only list/summary queries.

Recommended indexes, all prefixed by tenant:

- Every collection: `{organizationId:1, deletedAt:1, createdAt:-1}`.
- Users: unique `{email:1}`; unique sparse `{googleSubject:1}`. Members unique `{organizationId:1,userId:1}`.
- Customers: `{organizationId:1,deletedAt:1,status:1,createdAt:-1}`, `{organizationId:1,emailNormalized:1}` if uniqueness is approved, source unique sparse indexes.
- Leads: `{organizationId:1,deletedAt:1,status:1,createdAt:-1}`, `{organizationId:1,ownerId:1,status:1}`, `{organizationId:1,followUpDate:1}`.
- Products: `{organizationId:1,deletedAt:1,active:1,category:1}`, `{organizationId:1,nameNormalized:1}`.
- Deals: `{organizationId:1,deletedAt:1,stage:1,createdAt:-1}`, `{organizationId:1,ownerId:1,stage:1}`, `{organizationId:1,closeDate:1}`, source unique indexes where applicable.
- Tasks: `{organizationId:1,deletedAt:1,status:1,dueDate:1}`, `{organizationId:1,assigneeId:1,status:1}`.
- Events: `{organizationId:1,startAt:1,endAt:1}`, `{organizationId:1,assigneeId:1,startAt:1}`.
- Tickets: unique `{organizationId:1,number:1}`, `{organizationId:1,status:1,priority:1,dueDate:1}`.
- Documents: `{organizationId:1,relatedType:1,relatedId:1}`, `{organizationId:1,category:1,createdAt:-1}`.
- Activities/notes/audits: `{organizationId:1,parentId:1,createdAt:-1}` and audit `{organizationId:1,entityType:1,entityId:1,createdAt:-1}`.

Do not add Mongo text indexes to every field or index derived totals. Use Atlas Search only when current indexed prefix search is insufficient. Search behavior is name/email/company/subject based on the UI; full-text relevance is `⚠️ AMBIGUOUS / NEEDS DECISION`.

## 9. Architecture

```text
src/
  app.js
  server.js
  config/              environment, database, logger
  routes/              versioned route registration
  controllers/         HTTP translation only
  validators/          request DTO and query schemas
  services/            business rules and transactions
  repositories/        Mongoose queries and projections
  models/              schemas and indexes
  middleware/          auth, RBAC, tenant scope, errors, rate limits
  policies/             record-level authorization
  jobs/                 optional queued automation/import work
  integrations/         Google auth and future email/object storage
  utils/                IDs, pagination, money, normalization
  constants/            statuses, permissions, error codes
  tests/                unit, integration, authorization, contract tests
```

Routes authenticate and validate. Controllers map HTTP to service calls. Services own transitions, conversion, pricing, authorization checks, idempotency, and transactions. Repositories own query composition and indexes. Models define persistence constraints. Jobs are needed for imports, exports, and future automation delivery, but not for ordinary CRUD.

## 10. Authentication and Security

Verify Google ID tokens on the server against issuer, audience, signature, expiry, and nonce. Issue short-lived access tokens and rotating, hashed refresh tokens stored server-side; revoke a token family on logout or reuse detection. Do not accept the frontend's decoded JWT claims as identity. Password login is not present and should not be added without a product decision.

Use Helmet, strict CORS allowlist, JSON/request size limits, rate limits for auth and mutations, schema validation, NoSQL operator sanitization, normalized input, safe URL/MIME handling, structured redacted logs, request IDs, HTTPS, secure cookies or carefully protected token storage, and secret environment variables. Enforce tenant scope in every repository query. Restrict exports/imports and audit-log reads. Object-storage links must be signed and short-lived.

## 11. Frontend-to-Backend Mapping

| Frontend surface/action | API | Service | Collections |
|---|---|---|---|
| Login / logout | `POST /auth/google`, `POST /auth/logout` | AuthService | users, memberships, sessions |
| Company setup/edit | `GET/PATCH /organization` | OrganizationService | organizations |
| Customers CRUD/search | `/customers` | CustomerService | customers |
| Lead CRUD/filter/notes | `/leads`, `/leads/:id/activities` | LeadService | leads, activities |
| Lead status WON | `POST /leads/:id/convert` | ConversionService | leads, customers, audit_logs |
| Product CRUD/pricing | `/products` | ProductService/PricingService | products |
| Lead quotation | `POST /leads/:id/quotations` | QuotationService | quotations, products |
| Deals Kanban/filters | `/deals`, `/deals/pipeline` | DealService | deals |
| Deal drag to stage/WON | `POST /deals/:id/stage`, `POST /deals/:id/convert` | DealService/ConversionService | deals, customers |
| Tasks and deal follow-ups | `/tasks`, `/deals/:id/tasks` | TaskService | tasks |
| Calendar event CRUD | `/events` | CalendarService | calendar_events |
| Support tickets/notes | `/tickets`, `/tickets/:id/notes` | TicketService | tickets, ticket_notes |
| Campaigns | `/campaigns` | CampaignService | campaigns |
| Automation run/enroll | `/workflows/:id/run`, `/sequences/:id/enroll` | AutomationService | workflows, sequences, tasks |
| Documents | `/documents`, upload/download endpoints | DocumentService | documents, object storage |
| Dashboard | `/dashboard/summary` | DashboardQueryService | multiple collections |
| Reports/export | `/reports`, `/reports/export` | ReportingService | multiple collections |
| AI Insights | `/insights` | InsightsQueryService | deals, leads, tickets, tasks |
| Customer 360 | `/customers/:id/360` | Customer360Service | customer and related collections |
| Settings export/import/reset | `/exports/crm`, `/imports/localstorage` | DataTransferService | all tenant collections |

## 12. Business Logic and Auditability

Server rules must cover allowed stage transitions, probability defaults, WON conversion, duplicate prevention, ownership, status changes, task completion timestamps, ticket overdue semantics, event date validity, document access, and financial recalculation. Each important mutation writes an audit event, especially lead stage changes, conversions, product price/stock changes, deal value/stage changes, member changes, imports, exports, and deletes.

Use soft delete by default for business records so historical reports and references survive. Hard deletion is admin-only and should be a retention job after a documented policy. Deletes must not silently orphan references; return validation/conflict errors or retain the reference with a deleted marker.

## 13. Transactions, Concurrency, and Scaling

Transactions are required for lead/deal conversion, quotation number allocation if implemented with a counter, and any future inventory reservation plus deal/quotation update. Atomic updates are sufficient for one-document stage/status edits and `findOneAndUpdate` counters. Use version checks for drag/drop and edits to prevent lost updates. Store an idempotency record keyed by organization/user/key/operation for retriable creates and conversions.

Start stateless with one Mongo replica set, pooled connections, bounded queries, indexes, projections, and aggregation pipelines for dashboards/reports. Add Redis caching only for measured read hotspots. Add a queue later for imports, exports, automation execution, notifications, and document processing. Horizontal API scaling is then straightforward because refresh/session state is in MongoDB or a shared store.

## 14. Must Have, Later, Not Needed Yet

### Must have now

Tenant isolation; server authentication; membership/RBAC; validated CRUD; ObjectId relationships; soft delete; pagination/filtering; server-side pricing; idempotent conversion; atomic ticket/quotation numbering; audit log; consistent errors; migration importer; tests for authorization, transitions, conversion, and pricing.

### Recommended later

Object storage and document scanning; Redis; background jobs and notification providers; Atlas Search; recurring tasks/events; SLA and ticket replies; inventory reservations; richer report definitions; refresh-token session management UI; webhook/event bus; data retention tooling.

### Not needed yet based on this frontend

Microservices; event sourcing; GraphQL; real-time collaboration; an AI model service; payment/invoicing; complex warehouse management; multi-region deployment. These become decisions only when a frontend workflow requires them.

## 15. Migration and Testing

Create an import preview that maps legacy fields (`price` to `basePrice`, `quantity` to `quantityInStock`, `gst` to `gstPercentage`, `pincode` to `postalCode`, display names to IDs), reports ambiguous links, deduplicates only under an approved rule, and preserves original IDs in `legacyId`. Import users without sessions, scope all records to a selected organization, and retain an import report. Do not import demo cleanup behavior or client-generated authority fields.

Tests should include model validation/index tests; auth token verification and refresh rotation; tenant isolation; RBAC and record ownership; CRUD contract tests; search/filter/pagination; stage transition matrix; repeated and concurrent WON conversion; quotation money/tax rounding; atomic sequences; soft deletion; migration fixtures; report date semantics; upload authorization; and security tests for NoSQL injection, oversized input, malformed IDs, and unauthorized exports.

## 16. Decisions Required Before Implementation

1. Organization model and whether one user can belong to multiple organizations.
2. Exact roles, module permissions, and agent record scope.
3. Canonical pipeline statuses and legal transitions, including Lost reasons.
4. Whether Account is real, merged with Customer, or removed.
5. Customer duplicate policy and contact model.
6. Currency, GST jurisdiction, tax-inclusive/exclusive pricing, rounding, discounts, and inventory semantics.
7. Quotation lifecycle and whether it needs PDF, approval, expiry, or conversion to a deal.
8. Ticket SLA, replies, attachments, and resolution-date semantics.
9. Document categories, upload provider, retention, and link policy.
10. Whether automation is configuration-only or must execute external actions.
11. Whether AI Insights remains deterministic reporting or becomes an actual AI integration.
12. Timezone, locale, date-range, and report definitions.
13. Import behavior for duplicate records and unresolved display-name relationships.

Until these decisions are made, the specification above describes observed behavior and conservative backend boundaries; it does not silently turn absent frontend behavior into product requirements.