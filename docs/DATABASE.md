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
| `contacts` | `name`, `email`, `phone`, `phoneE164`, `company`, `gstin`, `stateCode`, `state`, `city`, `address`, `tags[]`, `source`, `ownerId`, `lifecycle` (lead/customer), `status`, `productIds[]`, `notes`, `consent` { marketing (unknown/opted_in/opted_out), changedAt, method (manual/import/whatsapp_reply) }, `becameCustomerAt`, `legacyIds[]`, `deletedAt` | unique `(organizationId, phoneE164)` when set; `(organizationId, deletedAt, lifecycle, createdAt -1)`; `(organizationId, ownerId, lifecycle)`; `(organizationId, email)`; `(organizationId, tags)`; `(organizationId, legacyIds)` |
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
| `workflows` | Phase 2 shape (`trigger` text, `actions[]`, `runsCount`); replaced in Phase 6 by migration 003, see section 1i | |
| `sequences` | Phase 2 shape (`targetType`, `steps[]` { day, Email/Call/Task/Wait, note }, `enrolledCount`); replaced in Phase 6B by migration 004, see section 1i | |

`notes.parentType` now also allows `campaign`. `automationruns` and per-contact `sequenceenrollments` arrived in Phase 6 (section 1i).

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

## 1i. Implemented (Phase 6, automation)

| Collection | Key fields | Indexes |
|---|---|---|
| `workflows` | `schemaVersion` 2: `name`, `status` (Active/Paused/Draft), `trigger` { type, params }, `conditions[]` { field, op, value }, `steps[]` { type, params } (checked per type by `validators/automation.js`), `webhookSecret` (made with the first webhook step; never exported), `notes[]`, `ownerId`, `stats` { runs, done, failed, lastRunAt } (server only), `createdById`, `createdByMemberId`, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, status)`; `(organizationId, status, trigger.type)`; `(organizationId, ownerId)`; `(organizationId, legacyIds)` |
| `automationruns` | `workflowId`, `workflowName`, `trigger` (or `manual`), `event` (summary), `subject` { leadId, contactId, conversationId, orderId, quotationId, taskId, label }, `chain[]` (workflows that led here; loop guard), `status` (running/waiting/done/failed/skipped/cancelled), `stepIndex`, `steps[]` { index, type, status done/failed/skipped/waiting, detail, at }, `nextAt`, `dedupeKey`, `error`, `finishedAt` | `(organizationId, createdAt -1)`; `(organizationId, workflowId, createdAt -1)`; `(organizationId, subject.leadId, createdAt -1)`; unique `(workflowId, dedupeKey)` when a key is set (one run per event or per scanned thing) |
| `sequences` | `schemaVersion` 2: `name`, `status`, `steps[]` { day 0–365, type (a workflow action without wait/webhook/sequence), params }, `stopOnReply`, `stopOnClose`, `workingHoursOnly` (all default true), `notes[]`, `ownerId`, `stats` { enrolled (history), active, completed, stopped, failed (recounted), lastEnrolledAt }, `legacyIds[]`, `deletedAt` | `(organizationId, deletedAt, status)`; `(organizationId, ownerId)`; `(organizationId, legacyIds)` |
| `sequenceenrollments` | `sequenceId`, `sequenceName`, `contactId`, `leadId`, `label`, `status` (active/completed/stopped/failed), `enrolledAt`, `enrolledBy` { kind member/workflow, memberId, workflowId, name }, `chain[]` (loop guard), `stepIndex` (next step), `nextAt`, `steps[]` { index, day, type, status done/failed/skipped, detail, at }, `stopReason`, `error`, `finishedAt` | `(organizationId, sequenceId, createdAt -1)`; `(organizationId, contactId, status)`; `(organizationId, leadId, createdAt -1)`; unique `(sequenceId, contactId)` while `status: active` (one active enrollment per customer and sequence) |
| `faqrules` | `name`, `active`, `priority`, `keywords[]`, `answer` { text, options[] { title, description, action rule/handoff, ruleId }, listButton, footer }, `stats` { answered, lastAnsweredAt }, `createdById` | `(organizationId, active, priority)` |
| `botsettings` | one per organization (unique `organizationId`): `enabled`, `greeting` { enabled, answer }, `away` { enabled, answer }, `handoff` { keywords[], text }, `repeatAfterHours` | unique `organizationId` |
| `notifications` | `memberId`, `title`, `body`, `link` (a CRM page), `source` (e.g. `workflow:<id>`), `readAt` | `(organizationId, memberId, createdAt -1)`; `(organizationId, memberId, readAt)`; TTL 90 days on `createdAt` |

`conversations.bot` { handedOffAt, handoffReason, greetedAt, awayAt, lastAnsweredAt } (the FAQ bot in that chat) and `messages.interactive` { kind button/list, listButton, footer, options[] { id, title, description } } (what the bot sent) arrived in Phase 6C.

Jobs (in `jobs`): `automation.event` (one per business event; for a WhatsApp message the FAQ bot answers first), `automation.step` (one per run and step index, `uniqueKey run:<id>:<index>`; a wait step's job has a later `runAt`), `automation.scan` (every 10 minutes), `sequence.step` (one per enrollment and step, `uniqueKey seq:<id>:<index>`, `runAt` = the step's day, moved to the next opening when only working hours are allowed).

## 1j. Implemented (Phase 7, broadcasts and segmentation)

| Collection | Key fields | Indexes |
|---|---|---|
| `broadcasts` | `name`, `status` (draft/scheduled/sending/paused/completed/cancelled/failed), `templateId`, `templateName`, `templateLanguage`, `category`, `whatsappAccountId`, `variables`, `segmentId`, `segmentName`, `scheduledAt`, `startedAt` (counts against the plan's month), `finishedAt`, `waitUntil` (Meta's daily limit), `batches`, `estimate`, `error`, `createdById`, `createdByName` | `(organizationId, createdAt -1)`; `(organizationId, startedAt)` |
| `broadcastrecipients` | `broadcastId`, `contactId`, `name`, `phoneE164`, `status` (pending/sent/delivered/read/replied/failed/skipped), `reason`, `messageId`, `conversationId`, `sentAt`, `deliveredAt`, `readAt`, `repliedAt`, `failedAt` | unique `(broadcastId, contactId)`; `(broadcastId, status)`; `(messageId)` sparse; `(organizationId, contactId, sentAt -1)` |
| `segments` | `name`, `description`, `filters` { tagsAll[], tagsAny[], tagsNone[], states[], cities[], sources[], lifecycles[], ownerIds[], productIds[], productCategories[], leadStages[], consent (not_opted_out/opted_in) }, `createdById` | `(organizationId, name)` |

`organizations.plan` (starter/pro/growth/scale; default growth = the trial, D34; limits in `constants/plans.js`). `whatsappaccounts.messagingLimit` (Meta's TIER_250 … TIER_UNLIMITED). Jobs: `broadcast.start` (fixes the recipients), `broadcast.send` (one batch; `uniqueKey broadcast:send:<id>:<n>`).

Contacts imported from CSV are ordinary `contacts` (source from the file or `Import`, `consent.method: import` when the importer said they agreed).

## 1k. Implemented (Phase 8, payments)

| Collection | Key fields | Indexes |
|---|---|---|
| `paymentconnections` | `provider` (razorpay/cashfree/mock), `name`, `mode` (test/live), `keyId` (not secret), `keySecretEnc`, `keySecretLast4`, `webhookSecretEnc` (secretBox), `webhookKey` (the webhook address), `status` (connected/error), `statusMessage`, `isDefault`, `lastCheckedAt`, `lastWebhookAt`, `createdById`, `deletedAt` | unique `webhookKey`; `(organizationId, deletedAt, isDefault -1)` |
| `paymentlinks` | `connectionId`, `provider`, `mode`, `referenceId` (ours, `ycrm_<24 hex>`), `providerLinkId`, `shortUrl`, `purpose` (order/quotation/amount), `orderId`, `quotationId`, `contactId`, `leadId`, `ownerId` (copied, for agents' scope), `documentNumber`, `description`, `customerName`, `amountPaise`, `amountPaidPaise`, `acceptPartial`, `minPartialPaise`, `status` (created/partially_paid/paid/expired/cancelled), `expiresAt`, `paidAt`, `cancelledAt`, `payments[]` { providerPaymentId, amountPaise, method, paidAt }, `sentMessageId`, `sentAt`, `receipts[]` { providerPaymentId, status, reason, messageId, at }, `lastSyncedAt`, `lastSyncError`, `createdById`, `createdByMemberId` | unique `(provider, providerLinkId)`; unique `referenceId`; `(organizationId, createdAt -1)`; `(organizationId, orderId)`; `(organizationId, quotationId)`; `(organizationId, contactId)`; `(status, lastSyncedAt)` |

`whatsappaccounts.catalog` { catalogId, name, productCount, status, statusMessage, checkedAt, catalogVisible, cartEnabled, lastSyncAt, lastSync { sent, removed, failed, error } } and `products.catalog` { include, retailerId (as last sent to Meta), status pending/synced/error/removed, error, syncedAt } (index `(organizationId, catalog.retailerId)`) arrived in Phase 8C. `messages.interactive.kind` also `product` / `product_list` with `products[]`; `messages.order` { catalogId, text, items[] { retailerId, quantity, itemPricePaise, currency }, orderId } for type `order`. `orders.source` (quotation/catalog) and `orders.catalogOrder` { messageId (unique when set), conversationId, catalogId, text, warnings[] }. Jobs: `catalog.sync` (per number with a catalog, at once and daily, `uniqueKey catalog:<account>`), `catalog.order` (one per cart message).

`orders.payments[]` { source link/manual, amountPaise, method, reference, paidAt, paymentLinkId, provider, providerPaymentId, recordedById, recordedByName } and `orders.amountPaidPaise` (their sum); `paidAt` is set when paid in full. Payment status and the amount due are computed (`orderService.paymentStatusOf` / `duePaise`), not stored, so older orders need no migration. `organizations.payments` { expiryDays, sendReceipt, linkTemplateId, receiptTemplateId }. `inboundevents` also holds gateway events (`provider` razorpay/cashfree/mock, `kind: payment_link`, the parsed event as `payload`). Jobs: `payment.webhook` (one per stored event), `payment.links.sync` (every 10 minutes, 50 open links checked longest ago).

## 1l. Phase 9 (reports)

No new collections: reports are counted from the records when asked (D47). New index `messages (organizationId, createdAt -1)` for the messages of a date range (response times). Range boundaries are 00:00 India time (`utils/reportRange.js`).

## 2. Data migrations

| Migration | What it does |
|---|---|
| `001-organization-field-names` | `gst → gstin` (uppercased), `pincode → postalCode`, `founded → foundedYear` (only real years; other text stays in `founded`), derives `stateCode` from the GSTIN. |
| `004-sequences-v2` | Phase 2 sequences get the Phase 6B shape (`automation/legacy.js`): Call and Task steps → `task.create` on the same day (title from the note, due that day, the lead's owner), Email steps → `notes` (the CRM sends WhatsApp), Wait steps dropped (the days are the waits), `targetType` dropped; Active ones become Paused (D32); `enrolledCount` → `stats.enrolled`. Only documents without `schemaVersion: 2`. |
| `003-workflows-v2` | Phase 2 workflows get the Phase 6 shape (`automation/legacy.js`): "Lead/Deal Created" → `lead.created`, "…Won" and "Customer Added" → `lead.stage_changed` to Won, "…Lost" → to Lost, "Task Overdue" → `task.overdue`; Create Task → `task.create` (due in 1 day, the lead's owner), Notify Agent → `agent.notify`, Update Status → `stage.change` when it names a stage (not Lost); emails, "Add to Sequence" and the rest go to `notes`. Active ones become Paused (D32); `runsCount` → `stats.runs`; the old fields are removed. Only documents without `schemaVersion: 2` (deleted ones too). |
| `002-quotations-v2` | Phase 2 quotations get the Phase 5 shape: each line's tax split into CGST + SGST or IGST (organization vs customer state), taxable values, the rate summary, customer and seller details, type Quotation, revision 0; no round-off, so no amount changes. Only documents without `schemaVersion: 2`. |

## 3. Planned (Phase 2 onwards)

SaaS collections (Phase 10). Every index is prefixed with `organizationId`; money is stored as integer paise.
