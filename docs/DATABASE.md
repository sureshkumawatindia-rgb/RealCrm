# Database Schema

MongoDB (Atlas replica set). Business collections carry `organizationId`, `createdAt`, `updatedAt` and, where soft delete applies, `deletedAt`. The full target model for later phases is in [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 5.

## 1. Implemented (Phase 1)

| Collection | Key fields | Indexes |
|---|---|---|
| `users` | `googleId`, `email`, `name`, `picture`, `organizationId` (last active organization), `lastLoginAt`, `disabledAt` | unique `googleId` |
| `organizations` | `name`, `logoUrl`, `ownerId`, `industry`, `size`, `foundedYear`, `website`, `email`, `phone`, `gstin`, `stateCode`, `address`, `city`, `state`, `country`, `postalCode`, `description` | — |
| `organizationmembers` | `organizationId`, `userId`, `role` (owner/admin/agent/viewer), `modules[]`, `permissions[]`, `status`, `displayName`, `mobile`, `assignable`, `invitedById`, `deletedAt` | unique `(organizationId, userId)`; `userId`; `(organizationId, deletedAt, role)` |
| `invites` | `organizationId`, `email`, `role`, `modules[]`, `permissions[]`, `tokenHash`, `status` (pending/accepted/revoked), `expiresAt`, `invitedById`, `acceptedAt`, `acceptedByUserId` | unique `(organizationId, email)`; unique sparse `tokenHash`; `(email, status)` |
| `sessions` | `userId`, `organizationId`, `familyId`, `tokenHash`, `expiresAt`, `revokedAt`, `revokedReason`, `userAgent`, `ip` | unique `tokenHash`; `familyId`; `(userId, organizationId)`; TTL on `expiresAt` |
| `auditlogs` | `organizationId`, `actorUserId`, `action`, `entityType`, `entityId`, `changes` (redacted), `requestId`, `ip`, `userAgent`, `createdAt` | `(organizationId, createdAt -1)`; `(organizationId, entityType, entityId, createdAt -1)` |
| `idempotencyrecords` | `organizationId`, `userId`, `operation`, `key`, `requestHash`, `statusCode`, `body`, `expiresAt` | unique `(organizationId, userId, operation, key)`; TTL on `expiresAt` |
| `counters` | `organizationId`, `name`, `seq` | unique `(organizationId, name)` |
| `migrations` | `name`, `appliedAt` | unique `name` |
| `gmailconnections` | `userId`, `organizationId`, `emailAddress`, encrypted tokens, `tokenExpiry`, `historyId`, `scopes` | unique `userId`; `organizationId` |
| `oauthstates` | `state`, `userId`, `organizationId`, `returnUrl`, `expiresAt` | unique `state`; TTL on `expiresAt` |

Only hashes of refresh tokens and invite tokens are stored. Gmail tokens are encrypted (see `utils/secretBox.js`).

## 1b. Implemented (Phase 2, sales core)

| Collection | Key fields | Indexes |
|---|---|---|
| `contacts` | `name`, `email`, `phone`, `phoneE164`, `company`, `gstin`, `stateCode`, `state`, `city`, `address`, `tags[]`, `source`, `ownerId`, `lifecycle` (lead/customer), `status`, `productIds[]`, `notes`, `consent.marketing`, `becameCustomerAt`, `legacyIds[]`, `deletedAt` | unique `(organizationId, phoneE164)` when set; `(organizationId, deletedAt, lifecycle, createdAt -1)`; `(organizationId, ownerId, lifecycle)`; `(organizationId, email)`; `(organizationId, tags)`; `(organizationId, legacyIds)` |
| `products` | `name`, `sku`, `category`, `description`, `unit`, `hsnSac`, `pricePaise`, `gstRatePct`, `moq`, `stockQty`, `images[]`, `active`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, active, category)`; `(organizationId, name)`; `(organizationId, legacyIds)` |
| `leads` | `contactId`, `title`, `stage`, `probability`, `lostReason`, `source`, `sourceRef`, `productId`, `quantity`, `expectedValuePaise`, `expectedCloseDate`, `followUpAt`, `ownerId`, `notes`, `noteEntries[]`, `stageChangedAt`, `convertedAt`, `lastActivityAt`, `version`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, stage, createdAt -1)`; `(organizationId, ownerId, stage)`; `(organizationId, followUpAt)`; `(organizationId, contactId)`; unique `(organizationId, source, sourceRef)` when set; `(organizationId, legacyIds)` |
| `leadactivities` | `leadId`, `contactId`, `type`, `text`, `actorUserId`, `actorName`, `meta`, `legacyIds[]`, `createdAt` | `(organizationId, leadId, createdAt -1)`; `(organizationId, legacyIds)` |
| `quotations` | `number`, `financialYear`, `leadId`, `contactId`, `ownerId`, `status`, `quotationDate`, `validUntil`, `items[]` (product snapshot, paise), `totals`, `legacyNumber`, `legacyIds[]`, `deletedAt` | unique `(organizationId, number)`; `(organizationId, leadId, status)`; `(organizationId, contactId, createdAt -1)` |
| `imports` | `dryRun`, `status`, `report`, `error`, `createdById` | `(organizationId, createdAt -1)` |

Counters used: `quotation:<financial year>`.

## 2. Data migrations

| Migration | What it does |
|---|---|
| `001-organization-field-names` | `gst → gstin` (uppercased), `pincode → postalCode`, `founded → foundedYear` (only real years; other text stays in `founded`), derives `stateCode` from the GSTIN. |

## 3. Planned (Phase 2 onwards)

Contacts, leads (the single pipeline, decision D13), lead activities, products, tasks, calendar events, tickets, notes, documents, campaigns, workflows, sequences, imports; then WhatsApp, lead sources, quotations, orders, payments, broadcasts and SaaS collections. Every index is prefixed with `organizationId`; money is stored as integer paise.
