# Data trust: a customer's data on request, privacy settings, the restore drill

Phase 8 of the 100 phases (D120), 2026-11-08. A customer can get a copy of everything the CRM
keeps about them, or have it erased; the company has its privacy settings and a register of the
requests it answered; and the platform's weekly backup is put back and counted by itself every four
weeks, with the result on the platform admin page.

## What India's DPDP Act asks (in short)

Under the Digital Personal Data Protection Act, 2023 each company using the CRM is the **data
fiduciary** for its customers' data, and agreem360 is its **data processor**. The parts this phase
helps with:

| The Act | What it asks | In the CRM |
|---|---|---|
| s. 11 | A customer may ask for a summary of their data, and who else it was shared with | Download their data (section 1) |
| s. 12 | A customer may ask for their data to be corrected or erased, unless a law asks to keep it | Editing as always; Erase their data (section 2) |
| s. 8(7) | Erase data once its purpose is over, unless a law asks to keep it | Tax records kept 8 years, then made anonymous by themselves |
| s. 8(9) | Publish who answers questions about the data | Privacy settings (section 3) |
| s. 5 | Give notice when asking consent | Privacy notice link under the website form |
| s. 13; DPDP Rules 2025, rule 14(3) | Answer grievances within a reasonable time, not more than 90 days | The register shows when each request was asked and answered (section 4) |

The DPDP Rules were notified on 13–14 November 2025. The core duties (rules 3 and 5–16) apply 18
months later, around 13 May 2027 — check the date in the official gazette. **This is not legal
advice**: confirm what applies to your business with your lawyer or CA.

## 1. A copy of a customer's data

- **Where:** Customer 360 → **Customer's data** → **Download their data**; for a customer deleted
  earlier (their data is still kept): Settings → Data & Privacy → **A customer asked about their
  data**, find them by name, mobile number or email.
- **Who:** owners and admins, or only owners (section 3). Agents never see it.
- **The file:** "Easy to read" — one page that opens on any phone or computer and prints well, in
  the language of the person who makes it (Hindi or English) — or JSON for another system. Asked
  on: the day the customer asked (today or earlier; it goes in the register).
- **In it:** their details and the company's own fields; their choices (WhatsApp offers and its
  history, SMS); how they reached the company (first touch, ads and website visits, enquiries from
  lead sources); enquiries; quotations; orders; tax invoices; payments and payment links; support
  requests; tasks and meetings about them; notes; calls; every chat message (photos, voice notes and
  files named); SMS; emails; files; broadcasts and follow-ups; linked projects and records; and
  **who else handled the data**: agreem360, WhatsApp / Instagram / Messenger (Meta), the payment
  gateway, MSG91, Exotel, Gmail or Outlook, the AI assistant (Anthropic), Meta's Conversions API,
  Google Sheets, Calendar or Drive, and the company's own webhooks — only those used for this
  customer. Records the company deleted but still keeps are in it, marked "deleted". Nobody else's
  data, and never storage keys or secrets.
- **Who to ask:** the privacy contact (section 3) at the top of the file, and the privacy notice link.

## 2. Erasing a customer's data

**Customer 360 → Customer's data → Erase their data** (or from the Settings search for a deleted
customer). It first shows what will happen, with counts, warns about orders not delivered, money
still due, open leads and open payment links, and asks for the customer's name to be typed. It
cannot be undone.

| What happens | To what |
|---|---|
| **Erased for good** | Chats and every message, with their photos and files; notes (on the customer, their chats and tickets, their leads' notes); files linked to them or their leads; SMS; emails; consent history; lead history; open tasks; coming meetings (removed from Google Calendar and Outlook too); messages set to go later; website-button visits; the private-number entry; the team's bell notes about them; dialer list entries; and, right after, the 60-day copies of WhatsApp's webhooks and the 30-day copies of outgoing webhooks that held their messages or details |
| **Kept without their name, number or details**, so sales numbers and reports stay right | Leads (titled "Erased customer"), quotations and their earlier revisions, orders, payment links (open ones are cancelled at the gateway), support tickets, done tasks and past meetings, calls (only direction, duration and outcome stay), broadcast deliveries, ad touches (the campaign stays), follow-up sequences (stopped), automation runs, enquiries (their source id stays, so IndiaMART does not bring the same enquiry back) |
| **Kept as the law asks** | Tax invoices, credit notes and payment receipts, exactly as issued, for 8 years after the end of their financial year (GST: 72 months after the annual return's due date; the Companies Act: 8 years; income tax: 6 years after the assessment year — the longest). A daily job then makes them anonymous too |

- **The customer** stays only as "an erased customer": deleted, no name, number, email, address,
  tags, notes or own fields. An old link to them says "This customer's data was erased on …"; their
  quotation's public link stops opening; searches never find them.
- **Anyone merged into them earlier** (D100) is the same person and is erased too.
- **Projects and records** linked to them stay (they are the company's work): check that their
  names do not mention the customer — the preview lists them.
- **Outside the CRM:** WhatsApp on the team's phones, Google Sheets, Tally, Excel files, email
  inboxes and papers are the company's to clean. A file imported again that still has their number
  brings them back. If they write on WhatsApp again later, they are a new customer (they came back
  themselves).
- **The team's phones** drop every copy of the Inbox they kept for working offline (Phase 7) the
  next time each opens the CRM online; the Inbox fills them again from the network.
- **Connected systems** are told: the webhook event `contact.erased` sends only
  `{ "contact": { "id": "…" }, "erasedAt": "…" }`, so Zapier, Make or the company's own system can
  erase its copy.
- **The register and the audit log** keep that it was done, by whom and when — never the name.
- **Backups:** the platform's weekly copies keep the data until they age out (`BACKUP_KEEP_WEEKS`,
  8 weeks). Each erasure is noted in the backup bucket (`erasures/…`, ids only), so a restore of an
  older backup erases those customers again (section 5).

## 3. The company's privacy settings

Settings → Data & Privacy → **Privacy settings** (owners and admins):

| Setting | What it does |
|---|---|
| Who answers questions about data (name, email, phone) | Shown at the top of every customer data file and at the foot of quotation pages. Left empty, the company's own email and phone are shown |
| Your privacy notice (link) | Linked under the website enquiry form, on quotation pages and in every data file |
| Keep chats on team phones for working without internet | Phase 7's copies of the Inbox on phones (on by default). Off: phones keep no copies, and each phone deletes the ones it kept the next time it opens the CRM |
| Who can download or erase a customer's data | Owners and admins (default), or only owners. Only an owner can change it |

## 4. The register of requests

Settings → Data & Privacy → **Requests answered**: when the customer asked, when it was done, what
(a copy of their data, or erased), the customer (an erased customer's name is never kept — not even
on their earlier copies), who did it, and how many days it took. Answer within 90 days.

## 5. The restore drill (platform admin page → Backups)

The weekly encrypted copy of the database on R2 (F4a) is only worth something if it can be put
back. The **Backups** tab shows:

- the last backup (its day and size) and the next one (Sunday 2:30 am India time);
- the last restore drill (Passed or Failed, with its problems) and the next one;
- every drill: when, which backup, how many collections and records were counted, how long it took,
  who started it, and how many customers were erased since that backup;
- every backup kept, complete or not;
- warnings: backups not set up, the bucket not reachable, no complete backup, the newest older
  than 8 days, the last drill failed, no drill in 5 weeks.

**A drill:** the newest complete backup goes into a separate, empty database next to the CRM's own
(`<database>_drill`); each file's SHA-256 is checked against the manifest, read line by line (never
a whole collection in memory, so a small server copes), and each collection is counted against the
manifest; then that database is dropped. It runs by itself every 4 weeks (Sunday 4:30 am, after
the backup), or from **Run the restore drill now** (one at a time; written in the audit log). A
failed drill goes to Sentry (F3) as well. From the server's shell: `node scripts/backup.js drill`.

- The Atlas database user must be able to create and drop that database (Atlas's usual "Read and
  write to any database" can).
- During a drill the cluster holds a second copy for a few minutes: keep room for it (the free M0
  tier has 512 MB).
- **A real restore** (a disaster): section S of `docs/FOUNDATION_SETUP_STEPS.md`; once the CRM's
  `MONGO_URI` points at the restored database, run
  `node scripts/backup.js reapply-erasures <day of the backup>` so customers erased since then are
  erased again.

## API

| | |
|---|---|
| `POST /api/v1/contacts/:id/privacy/export` | `{ format: "html" \| "json", language: "en" \| "hi", askedAt: "YYYY-MM-DD" }` → the file |
| `GET /api/v1/contacts/:id/privacy/erase-preview` | What erasing would do: counts, `keptUntil`, warnings, linked projects and records |
| `POST /api/v1/contacts/:id/privacy/erase` | `{ confirmName, askedAt, language }` → `{ erasedAt, counts, keptUntil }`; an erased customer answers 410 `ERASED` afterwards |
| `GET`, `PUT /api/v1/organization/privacy` | The privacy settings (owners and admins; `requestsBy` by an owner) |
| `GET /api/v1/organization/privacy/requests` | The register, newest first, paged |
| `GET /api/v1/organization/privacy/customers?q=` | The customer a request is about, deleted ones too (at most 20) |
| `GET /api/v1/platform/backups`, `POST /api/v1/platform/backups/drill` | The Backups tab (the platform's admins) |

## Tests

`src/tests/dataTrust.test.js` (7: the file in Hindi and JSON, erasing with the three kinds, the day
asked, the tax years, a deleted and a merged customer, the settings on public pages),
`src/tests/backupDrill.test.js` (5: line-by-line reading, the drill, a changed file, erasures noted
and put back, the platform page), and `e2e/privacy.spec.js` (4, in Hindi, with a stand-in R2 in
`e2e/server.js` so the platform page's drill really runs).

## What you do (the owner)

1. **Write a privacy notice** on your website (what data you take, why, for how long, who it goes
   to, how customers ask for a copy or erasure, and who to contact), and put its link in Settings →
   Data & Privacy.
2. **Name the person** who answers questions about data in the same place.
3. **Tell your team**: when a customer asks for their data or to delete it, an owner or admin
   uses Customer's data on their page, within 90 days.
4. **Platform:** once `R2_BACKUP_BUCKET` is set (docs/FOUNDATION_SETUP_STEPS.md), open the Backups
   tab after the first Sunday and run the drill once by hand.
