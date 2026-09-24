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

## 2. Data migrations

| Migration | What it does |
|---|---|
| `001-organization-field-names` | `gst → gstin` (uppercased), `pincode → postalCode`, `founded → foundedYear` (only real years; other text stays in `founded`), derives `stateCode` from the GSTIN. |

## 3. Planned (Phase 2 onwards)

Contacts, leads (the single pipeline, decision D13), lead activities, products, tasks, calendar events, tickets, notes, documents, campaigns, workflows, sequences, imports; then WhatsApp, lead sources, quotations, orders, payments, broadcasts and SaaS collections. Every index is prefixed with `organizationId`; money is stored as integer paise.
