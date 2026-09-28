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

## 1c. Implemented (Phase 2, tasks and calendar)

| Collection | Key fields | Indexes |
|---|---|---|
| `tasks` | `title`, `description`, `assigneeId` (member), `assigneeName` (kept only when there is no member, e.g. imported names), `dueDate` (`YYYY-MM-DD` string), `priority`, `status`, `completedAt`, `relatedType`, `relatedId`, `relatedName` (snapshot), `origin` (manual/deal_followup/automation), `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, status, dueDate)`; `(organizationId, assigneeId, status)`; `(organizationId, relatedType, relatedId)`; `(organizationId, origin, createdAt -1)`; `(organizationId, legacyIds)` |
| `calendarevents` | `title`, `type`, `date` (`YYYY-MM-DD` string), `startTime`/`endTime` (`HH:MM` or empty for all day), `timezone` (`Asia/Kolkata`), `assigneeId`, `assigneeName`, `relatedType`, `relatedId`, `relatedName`, `description`, `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, date)`; `(organizationId, assigneeId, date)`; `(organizationId, relatedType, relatedId)`; `(organizationId, legacyIds)` |

Calendar days are stored as strings, not `Date`, so a due date entered in India never moves a day when read in another timezone.

## 1d. Implemented (Phase 2, support tickets and notes)

| Collection | Key fields | Indexes |
|---|---|---|
| `tickets` | `number` (counter `ticket`, from 1001), `legacyNumber` (imported ticket whose old number was taken), `subject`, `description`, `contactId`, `customerName` (snapshot, or the typed name when no contact matched), `category`, `priority`, `status`, `assigneeId`, `assigneeName`, `dueDate` (`YYYY-MM-DD` string), `resolvedAt`, `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | unique `(organizationId, number)` (deleted tickets keep their number); `(organizationId, deletedAt, status, priority, dueDate)`; `(organizationId, assigneeId, status)`; `(organizationId, contactId, createdAt -1)`; `(organizationId, legacyIds)` |
| `notes` | `parentType` (ticket/contact), `parentId`, `text`, `authorUserId`, `authorMemberId`, `authorName` (snapshot; imported notes keep only the old name), `legacyIds[]`, `deletedAt` | `(organizationId, parentType, parentId, createdAt -1)`; `(organizationId, legacyIds)` |

The roadmap planned `dueAt` and a note `body`; the code uses `dueDate` (a calendar day, like tasks) and `text` (like lead activities). Notes on leads stay in `leadactivities`.

## 1e. Implemented (Phase 2, documents)

| Collection | Key fields | Indexes |
|---|---|---|
| `documents` | `name`, `description`, `category`, `ownerId`, `relatedType`, `relatedId`, `relatedName` (snapshot), `tags[]`, `storageKey` (private storage, `<organization id>/<random>`), `fileName`, `mimeType`, `sizeBytes`, `checksum` (SHA-256), `linkUrl`, `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, category, createdAt -1)`; `(organizationId, ownerId, createdAt -1)`; `(organizationId, relatedType, relatedId)`; `(organizationId, legacyIds)` |

The file bytes are not in MongoDB: `src/storage` keeps them on local disk (`DOCUMENT_DIR`). A cloud driver (S3 / Cloudflare R2) only has to provide the same `put`, `open` and `remove`.

## 1f. Implemented (Phase 2, campaigns and automation settings)

| Collection | Key fields | Indexes |
|---|---|---|
| `campaigns` | `name`, `type`, `status`, `startDate`/`endDate` (`YYYY-MM-DD`), `budgetPaise`, `leadsGenerated` (entered by the team until lead sources count it), `audience`, `description`, `ownerId`, `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, status, startDate)`; `(organizationId, ownerId, status)`; `(organizationId, legacyIds)` |
| `workflows` | `name`, `status` (Active/Paused/Draft), `trigger` (allowlist), `actions[]` `{ type (allowlist), detail }`, `ownerId`, `runsCount` (server only), `lastRunAt`, `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, status)`; `(organizationId, ownerId)`; `(organizationId, legacyIds)` |
| `sequences` | `name`, `targetType`, `status`, `steps[]` `{ day 0–365, type, note }`, `ownerId`, `enrolledCount` (server only), `lastEnrolledAt`, `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, status)`; `(organizationId, ownerId)`; `(organizationId, legacyIds)` |

`notes.parentType` now also allows `campaign`. Per-contact `sequenceenrollments` and `automationruns` (roadmap section 5) arrive with the automation engine in Phase 6.

Counters used: `quotation:<financial year>`, `ticket`.

## 2. Data migrations

| Migration | What it does |
|---|---|
| `001-organization-field-names` | `gst → gstin` (uppercased), `pincode → postalCode`, `founded → foundedYear` (only real years; other text stays in `founded`), derives `stateCode` from the GSTIN. |

## 3. Planned (Phase 2 onwards)

Account Champions move to memberships and invites (checkpoint F); then WhatsApp, lead sources, orders, payments, broadcasts and SaaS collections. Every index is prefixed with `organizationId`; money is stored as integer paise.
