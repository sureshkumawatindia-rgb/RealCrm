# Speed at scale: a big company's CRM answers within a second (Phase 3, D115)

Phase 3 of the 100 phases (`HUNDRED_PHASES_PLAN.md`). The goal: a company with 20,000 contacts,
50,000 leads and 2 lakh WhatsApp messages gets its Inbox, lists, search and reports within a
second. It also fixes three findings of the 100-point audit: BUG-001 (lists stopped at 5,000),
BUG-002 (page security headers) and BUG-003 ("Won this month").

## What changed

**Customers and Leads list their records from the server** (BUG-001). Before, each page loaded
the whole collection into the browser, 100 records per request, one request after another, and
stopped at 5,000. With 6,002 customers, the page showed 5,000 and its search could not find
customer number 5,500. Nobody was told.

Now these two lists work like this:

- The server sends 100 rows at a time, newest first. **Show more** adds the next 100.
- The line under the table says how many match, e.g. "Showing 100 of 6,002".
- Search, stage, score (hot/warm/cold), status and the company's own fields are all filtered on
  the server, so every record can be found. Search waits for a short pause in typing.
- **Select all** ticks every row that matches the search and filters, up to 5,000 (the bulk
  actions' limit). Above that, it says "Select the first 5,000 of 6,002".
- A link to one lead (`leads.html?open=<id>`) opens it even when it is not in the first 100.

**Counts come from the server, not from the loaded records.** One call, `GET /leads/summary`,
counts every lead the member may see:

- leads by stage, with their value;
- leads by product;
- open leads by owner;
- won this month.

It is used by:

- the Leads page's product panel;
- the Products page;
- the dashboard (pipeline bars, products, team workload, and the fallback cards);
- the Deals cards;
- Reports' "Leads by product".

The dashboard also asks for the five newest leads and the number of customers instead of
loading every lead and contact.

**"Won this month" counts by the day the deal was won** (BUG-003). Before, it counted by the
expected close date. A deal won today with a close date next month showed as 0.

**Customer 360 opens any customer.** It asks the server for the customer and the customer's own
leads. Its customer picker searches all customers on the server. Before, it loaded every contact
and lead, so a customer older than the newest 5,000 opened the picker instead.

**Other pages load faster and say when they hold only part of a list.** The Calendar, Tasks,
Documents, Support and Deals pages still keep a copy of their lists, at most 5,000 newest per
list.

- The pages after the first are now asked for six at a time instead of one after another. 5,000
  records load in about 1 second instead of 2 on this computer.
- When a list is longer than that, the page says so: "This page shows the newest 5,000 of your
  6,002 customers and contacts. To see or find any of them, open the Customers or Leads list."
  The note is in Hindi too.

**Lighter report queries.**

- The dashboard, the overview report and AI Insights add up open leads by stage in the database
  instead of loading every open lead.
- AI Insights works out each win chance once per kind of lead (stage, source, value band)
  instead of once per lead. It looks up customer names only for the ten rows it shows. It no
  longer runs a second whole overview report.
- The reply-time scan reads chats in the order of the chat-messages index, so it no longer
  sorts every message in memory.

**Page security headers** (BUG-002). The CRM pages are still served before `helmet()`, because
helmet's script rules would block their inline scripts and Google sign-in. They now get their own
headers:

- `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security` in production

No other site can show a CRM page inside a frame. A full script policy waits until the inline
scripts are moved into files (see `SECURITY_REVIEW.md`).

## The measurements

`npm run bench:scale` in `backend/` (`scripts/scale-benchmark.js`) builds the company in an
in-memory MongoDB on the computer it runs on. The company has:

- 20,000 contacts;
- 50,000 leads;
- 10,000 chats with 2 lakh messages;
- 5,000 tasks, 5,000 quotations and 2,000 orders.

It then times each screen's call 15 times. It never reads `backend/.env` and never touches a real
database. The numbers are from a Windows laptop. A hosting server answers at a similar speed plus
the network.

| Screen's call | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| Customers list, first 100 | 15 / 20 ms | 15 / 27 ms |
| Customers search by name | 47 / 253 ms | 39 / 190 ms |
| Leads list, first 100 | 91 / 175 ms | 92 / 191 ms |
| Leads list, page 300 | 109 / 126 ms | 108 / 137 ms |
| Leads search | 166 / 404 ms | 171 / 412 ms |
| Leads summary (new) | — | 88 / 98 ms |
| "Select all" ids (new) | — | 17 / 33 ms |
| Inbox list | 20 / 45 ms | 20 / 44 ms |
| Inbox search | 43 / 83 ms | 43 / 86 ms |
| Chat messages (newest 50) | 8 / 13 ms | 9 / 12 ms |
| Search box | 198 / 243 ms | 201 / 265 ms |
| **Dashboard numbers** | **638 / 811 ms** | **137 / 194 ms** |
| **Report: overview, 30 days** | **695 / 750 ms** | **170 / 217 ms** |
| **Report: overview, whole year** | **1,225 / 1,671 ms** | **586 / 651 ms** |
| **AI Insights** | **2,955 / 4,164 ms** | **459 / 475 ms** |
| Page copy of 5,000 records | 1,998 ms (one by one) | 954 ms (six at once) |

The other reports (trend, sources, agents, quotations, payments) were 6–106 ms before and stay
there.

Before Phase 3, the Customers and Leads pages had to load their whole list before showing
anything: up to 50 requests, and still only 5,000 records. Now the first screen needs one
request of about 15–190 ms.

## What is left

- The pickers that link a task, event, document or ticket to a customer or lead still choose
  from the page's copy (the newest 5,000). A picker that searches the server is a later phase.
- The Deals list view and its board filters work on the newest 5,000 deals. Its cards and the
  board's columns come from the server.
- `GET /leads?q=` looks for leads through at most 1,000 matching contacts. A search as broad as
  "a" in a company with 20,000 contacts can miss leads of the rest. Search with a name, phone or
  company.
