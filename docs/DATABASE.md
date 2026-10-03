# Database Schema

MongoDB (Atlas replica set). Business collections carry `organizationId`, `createdAt`, `updatedAt` and, where soft delete applies, `deletedAt`. The full target model for later phases is in [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 5.

## 1. Implemented (Phase 1)

| Collection | Key fields | Indexes |
|---|---|---|
| `users` | `googleId`, `email`, `name`, `picture`, `organizationId` (last active organization), `lastLoginAt`, `disabledAt` | unique `googleId` |
| `organizations` | `name`, `logoUrl`, `ownerId`, `industry`, `size`, `foundedYear`, `website`, `email`, `phone`, `gstin`, `stateCode`, `address`, `city`, `state`, `country`, `postalCode`, `description` | — |
| `organizationmembers` | `organizationId`, `userId`, `role` (owner/admin/agent/viewer), `modules[]`, `permissions[]`, `status`, `displayName`, `mobile`, `title`, `assignable`, `invitedById`, `deletedAt` | unique `(organizationId, userId)`; `userId`; `(organizationId, deletedAt, role)` |
| `invites` | `organizationId`, `email`, `role`, `modules[]`, `permissions[]`, `displayName`, `mobile`, `title` (copied to the membership on accept), `tokenHash` (none for invites made by the importer; they are accepted at Google sign-in), `status` (pending/accepted/revoked), `expiresAt`, `invitedById`, `acceptedAt`, `acceptedByUserId` | unique `(organizationId, email)`; unique sparse `tokenHash`; `(email, status)` |
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
| `quotations` | Phase 5 shape (`schemaVersion` 2): `type` (Quotation/Estimate/Proforma Invoice), `number`, `financialYear`, `revision`, `leadId`, `contactId`, `ownerId`, `status`, `quotationDate`, `validUntil`, `billTo` and `seller` (copied details), `supply` { sellerStateCode, placeOfSupplyCode, interState, zeroRated, taxLabel SGST/UTGST, stateAssumed }, `placeOfSupplyCode` (chosen by hand), `roundOff`, `items[]` { product, name, hsnSac, unit, quantity, unitPricePaise, discountType, discountValue, subtotal/discount/taxable, gstRatePct, cgst/sgst/igst, tax, total — paise }, `totals` { … roundOffPaise, grandTotalPaise, byRate[] }, `terms`, `notes`, `revisions[]` (earlier versions), `sentAt`, `sentVia`, `viewedAt`, `viewCount`, `acceptedAt`, `rejectedAt`, `rejectedReason`, `expiredAt`, `orderId`, `legacyNumber`, `legacyIds[]`, `deletedAt` | unique `(organizationId, number)`; `(organizationId, leadId, status)`; `(organizationId, contactId, createdAt -1)`; `(organizationId, status, validUntil)` |
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

## 1g. Implemented (Phase 3, WhatsApp)

| Collection | Key fields | Indexes |
|---|---|---|
| `whatsappaccounts` | `name`, `provider` (meta/mock), `phoneNumberId`, `activePhoneNumberId` (set while connected), `wabaId`, `displayPhone`, `verifiedName`, `qualityRating`, `accessTokenEnc`, `accessTokenLast4`, `appSecretEnc`, `verifyTokenEnc` (all encrypted with secretBox), `webhookKey`, `status`, `statusMessage`, `lastWebhookAt`, `isDefault`, `deletedAt` | unique sparse `activePhoneNumberId` (a number belongs to one organization); unique `webhookKey`; `(organizationId, deletedAt, isDefault)` |
| `conversations` | `contactId`, `whatsappAccountId`, `assigneeId`, `status` (open/pending/closed), `lastInboundAt` (24-hour window), `lastMessageAt`, `lastMessagePreview`, `lastMessageDirection`, `unreadCount`, `tags[]` | unique `(organizationId, contactId, whatsappAccountId)`; `(organizationId, assigneeId, status, lastMessageAt -1)`; `(organizationId, status, lastMessageAt -1)` |
| `messages` | `conversationId`, `contactId`, `whatsappAccountId`, `direction` (in/out), `type`, `text`, `media` { providerMediaId, mimeType, sha256, fileName, sizeBytes, storageKey, voice }, `location`, `reply` (button/list), `reaction`, `template`, `replyToProviderMessageId`, `providerMessageId` (wamid), `status` (received/queued/sent/delivered/read/failed) + `sentAt/deliveredAt/readAt/failedAt`, `error`, `pricing`, `providerTimestamp`, `sentByMemberId` | unique sparse `providerMessageId` (global); `(organizationId, conversationId, createdAt -1)` |
| `quickreplies` | `shortcut` (lowercase), `title`, `body`, `createdByMemberId` | unique `(organizationId, shortcut)` |
| `messagetemplates` | `whatsappAccountId`, `providerTemplateId` (Meta's id, `hsm_id`), `name`, `language`, `category`, `status` (Meta's value: APPROVED, PENDING, REJECTED, PAUSED …), `parameterFormat` (POSITIONAL/NAMED), `components` (Meta's HEADER/BODY/FOOTER/BUTTONS list), `rejectedReason`, `qualityScore`, `lastSyncedAt`, `createdById` | unique `(organizationId, whatsappAccountId, name, language)`; `(organizationId, providerTemplateId)` |
| `inboundevents` | `provider`, `eventId` (`message:<wamid>` / `status:<wamid>:<status>` / `template:<id>:<event>:<time>`), `kind` (message/status/template_status), `organizationId`, `sourceId` (the WhatsApp account), `payload`, `status` (received/processed/ignored/failed), `attempts`, `error`, `processedAt` | unique `(provider, eventId)`; `(status, createdAt)`; TTL 60 days |

Internal notes on chats are `notes` with `parentType: "conversation"`. Files of messages (received and sent) are in the private document storage; `messages.media.storageKey` points to them (`sha256` is the stored file's hash). A received message keeps `media.providerMediaId` until its file is stored.

## 1h. Implemented (Phase 4, lead sources)

| Collection | Key fields | Indexes |
|---|---|---|
| `jobs` | `name`, `data`, `organizationId`, `uniqueKey`, `liveKey` (set while queued/running), `runAt`, `repeatEveryMs`, `status` (queued/running/done/failed), `attempts`, `maxAttempts`, `lockedBy`, `lockUntil`, `lastRunAt`, `lastError`, `finishedAt` | `(status, runAt)`; unique sparse `liveKey`; `(organizationId, name, createdAt -1)`; TTL on `finishedAt` (7 days) |
| `leadsourceconnections` | `type` (website/indiamart/facebook/googleads/justdial/tradeindia), `name`, `status`, `statusMessage`, `publicKey` (website forms), `webhookKey` (push URLs), `credentialsEnc` (secretBox), `credentialsHint`, `settings`, `cursor`, `lastPolledAt`, `lastLeadAt`, `lastError`, `lastErrorAt`, `stats` { received, created, attached, duplicate, rejected }, `deletedAt` | unique sparse `publicKey`; unique sparse `webhookKey`; `(organizationId, deletedAt, type)` |
| `leadintakes` | `source`, `sourceRef`, `connectionId`, `contactId`, `leadId`, `outcome` (processing/created/attached/rejected/failed), `reason`, `summary`, `raw` (≤ 20 KB), `receivedAt`, `processedAt` | unique `(organizationId, source, sourceRef)` (dedupe); `(organizationId, connectionId, createdAt -1)` |

| `assignmentrules` | `name`, `active`, `priority`, `conditions` { sources[], productIds[], states[], cities[] }, `strategy` (round_robin/specific), `memberIds[]`, `respectWorkingHours`, `fallbackMemberId`, `rrCounter` (atomic turn), `stats` { assigned, lastAssignedAt } | `(organizationId, active, priority)` |
| `assignmenthistories` | `entityType` (Lead), `entityId`, `contactId`, `fromMemberId`, `toMemberId`, `ruleId`, `reason` | `(organizationId, entityType, entityId, createdAt -1)`; `(organizationId, toMemberId, createdAt -1)` |
| `autoreplyrules` | `name`, `active`, `priority`, `sources[]`, `onlyNewContacts`, `maxAgeMinutes`, `delaySeconds`, `templateId`, `variables` { header, body, buttons }, `stats` { sent, failed, skipped, lastSentAt } | `(organizationId, active, priority)` |

`organizations.businessHours` { timezone, days[], start, end } (default Mon–Sat 10:00–19:00 Asia/Kolkata). `messages.automation` { kind, ruleId } marks messages the CRM sent itself (auto-replies).

Leads from a source have `source` and `sourceRef` (unique per source); a repeat enquiry added to an open lead is a `leadactivities` entry of type "Enquiry".

`organizations.billing` { bank { accountName, accountNumber, ifsc, bankName, branch }, upiId, terms, validityDays, prefixes { quotation, estimate, proforma, order }, roundOff, reduceStockOnDispatch } (Phase 5).

`orders` (Phase 5): `number`, `financialYear`, `quotationId` (unique when set), `quotationNumber`, `leadId`, `contactId`, `ownerId`, `stage` (Received, Processing, Dispatched, Delivered, Payment Collected, Cancelled), `orderDate`, `billTo`, `seller`, `supply`, `items[]`, `totals` (copied from the quotation; shared schemas in `models/schemas/documentParts.js`), `dispatch` { transporter, lrNumber, vehicleNumber, dispatchedAt, expectedDeliveryDate }, `deliveredAt`, `paidAt`, `cancelledAt`, `cancelReason`, `notes`, `stockReduced`, `stockMoves[]` { productId, quantity }, `history[]` { stage, from, at, byUserId, byName, note, notified }, `deletedAt`. Indexes: unique `(organizationId, number)`; `(organizationId, stage, createdAt -1)`; `(organizationId, contactId, createdAt -1)`.

Counters used: `quotation:<financial year>`, `estimate:<financial year>`, `proforma:<financial year>`, `order:<financial year>`, `ticket`.

## 2. Data migrations

| Migration | What it does |
|---|---|
| `001-organization-field-names` | `gst → gstin` (uppercased), `pincode → postalCode`, `founded → foundedYear` (only real years; other text stays in `founded`), derives `stateCode` from the GSTIN. |
| `002-quotations-v2` | Phase 2 quotations get the Phase 5 shape: each line's tax split into CGST + SGST or IGST (organization vs customer state), taxable values, the rate summary, customer and seller details, type Quotation, revision 0; no round-off, so no amount changes. Only documents without `schemaVersion: 2`. |

## 3. Planned (Phase 2 onwards)

WhatsApp, lead sources, orders, payments, broadcasts and SaaS collections. Every index is prefixed with `organizationId`; money is stored as integer paise.
