# Security review before launch (Phase 1 of the 100 phases, D113)

Reviewed on 2026-11-03, against the code on `main` (`0d79304`) plus this phase's fixes. The question
for each area: can one company, a stranger on the internet or a webhook sender reach what it
should not? An outside penetration test comes later (phase 94).

## What was checked, and the result

| Area | What was checked | Result |
| --- | --- | --- |
| One company, its own data | All 189 lookups by id (`findById`) and every update or delete by a request's id. Every id taken from a request body that names another record (owners, assignees, sections, products, templates, segments, forms, members). The cross-company tests, old (`acceptance.test.js` and others) and new (`securityReview.test.js`): calls, WhatsApp forms, Instagram and Messenger accounts, call logs, chats, projects. | Scoped everywhere. **One gap fixed:** a project task's assignee was not checked when the task was changed. One lookup was tightened (payment links). |
| Signing in and sessions | Session and refresh cookies (`httpOnly`, `SameSite=Strict`, `Secure` in production, only on the auth paths); a revoked session stops at once; rate limits on every sign-in, code, 2-step and platform-admin step, counted in MongoDB across servers; one-time codes hashed, compared in constant time, 5 tries; the QR sign-in needs its secret; test login codes and SMS can never run in production. | Sound; nothing to fix. |
| Roles | Every settings area (WhatsApp, payments, integrations, API keys, Instagram and Messenger, SMS, calling) is for owners and admins; every route file signs the person in, except the public pages that are public on purpose (plans, the seller's details, enquiry forms, quotation links). | Sound. |
| Input | Joi on every write that has a body (unknown fields dropped; the body replaced by the checked one); MongoDB operator keys refused; body size limits. | Sound. |
| Files | Size and count limits on every upload; logos served with a sandbox Content-Security-Policy and `nosniff`; chat files and documents only as downloads, sandboxed. | **Gap fixed:** the logo upload took any number of form fields, and any upload problem other than the size became a 500. Now one file, few fields, 400 `UPLOAD_ERROR`. |
| Webhooks in | HMAC-SHA256 with a constant-time compare: WhatsApp, Meta's app webhook (with Instagram and Messenger), Razorpay, Cashfree, the plans' Razorpay, Facebook Lead Ads. IndiaMART, Google Ads lead forms, telephony and SMS cannot sign: a long random key in the address, masked in the logs. | Sound. |
| Calls out | Workflow webhooks, outbound webhooks and Teams: https only, no user name in the address, private and local networks refused after the DNS lookup, no redirects, 10-second timeout. A DNS-rebinding trick would still need a valid certificate for the attacker's own name on the private machine, so https stops it. | Sound. |
| Logs and errors | Request logs keep paths only (no query strings), webhook keys masked; unexpected errors answer with a generic message; no tokens or customers' numbers in log lines. | Sound. |
| Public pages | The quotation page and the website button escape every value. | Sound. |
| Packages | `npm audit` of the server's packages: 1 critical (`proxy-addr`: IP spoofing through an IPv4-mapped IPv6 trusted subnet), 4 high (`body-parser`, `multer`, `joi`, `brace-expansion`) and 10 moderate. | **Fixed** by updating within the allowed versions (`package-lock.json` only). Left: 5 moderate in the file-matching libraries inside Google's API client (`gaxios` → `rimraf` → `glob` → `minimatch`), which never see a user's input; they go when Google's client updates. |

## Fixed in this phase

1. **Project tasks:** a task's assignee must be an active member of the same company when the
   task is changed, as when it is made (`projectService.updateTask`; 400 `INVALID_MEMBER`).
2. **Payment links:** the list for an order or quotation reads that order or quotation within the
   company only (no data could leak before: the links were filtered by company; now the lookup is
   too).
3. **Logo upload:** one file, at most 5 small form fields; any upload problem answers 400
   (`FILE_TOO_LARGE` or `UPLOAD_ERROR`), not 500.
4. **Packages:** the critical and high advisories updated away (`npm audit fix`, no major
   versions).

Tests: `securityReview.test.js` holds 14 cross-company probes on the newer modules, plus one test
for each fix. Every pull of `main` runs them on GitHub.

## Phase 3: page headers (BUG-002, D115)

The 100-point audit found that the CRM pages had no security headers: they are served before
`helmet()`, because helmet's script rules would block the pages' inline scripts and Google
sign-in. Since Phase 3 (`backend/src/app.js`, `pageHeaders`) every page, the "page not found"
page and the icon get their own:

- `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'` and
  `X-Frame-Options: DENY`: no other site can show a CRM page inside a frame (clickjacking).
- `X-Content-Type-Options: nosniff`: the browser never guesses a file into a script.
- `Referrer-Policy: strict-origin-when-cross-origin`: links to other sites take only the address.
- `Strict-Transport-Security` (production): the browser always comes back over https.

`securityReview.test.js` checks them. Still to do: move the inline scripts into files, then add
`script-src` (with `accounts.google.com` and `connect.facebook.net`) to the policy.

## Next

- Phase 2 adds end-to-end browser tests for the ten flows that must never break.
- Phase 94 is the outside penetration test and certification readiness.
- Run `npm audit --omit=dev` in `backend/` before each release. A new critical or high advisory
  is fixed before the release goes out.
