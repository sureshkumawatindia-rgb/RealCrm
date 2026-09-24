# API

All API routes are under `/api/v1`. CRM API requests use `Authorization: Bearer <Google ID token>` from the existing login flow.

## Gmail OAuth

The Gmail integration uses a separate Google OAuth authorization-code flow. The browser never receives or stores Gmail access or refresh tokens.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/gmail/connect` | CRM bearer token | Creates a user-bound OAuth state and returns the Google authorization URL. |
| `GET` | `/gmail/oauth/callback` | Google redirect only | Exchanges the code, calls Gmail `users.getProfile`, stores the encrypted connection, and redirects to Settings. |
| `GET` | `/gmail/connection` | CRM bearer token | Returns connected status and Gmail address. |
| `GET` | `/gmail/profile` | CRM bearer token | Fetches the connected account profile from Gmail. |
| `GET` | `/gmail/messages` | CRM bearer token | Fetches recent Gmail message metadata. |

Required backend environment variables:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://localhost:5500/api/v1/gmail/oauth/callback
FRONTEND_URL=http://127.0.0.1:5500/crm/frontend
GMAIL_TOKEN_ENCRYPTION_KEY
```

In Google Cloud Console, enable the Gmail API and add the exact value of `GOOGLE_REDIRECT_URI` to the OAuth client's authorized redirect URIs. The Gmail scope requested is `https://www.googleapis.com/auth/gmail.readonly`.
# API Map

All endpoints are prefixed with `/api/v1` and require an `Authorization: Bearer <token>` header (except public auth routes).

## 1. Authentication
- `POST /auth/google`: Login/Register via Google ID Token
- `POST /auth/refresh`: Rotate refresh tokens
- `POST /auth/logout`: Revoke tokens
- `GET /auth/me`: Get current user and organization memberships

## 2. Organization & Members
- `GET /organization`: Get company profile
- `PATCH /organization`: Update company profile (Owner/Admin only)
- `GET /members`: List members
- `POST /members`: Invite/Add member
- `PATCH /members/:id`: Change role/permissions
- `DELETE /members/:id`: Remove member

## 3. CRM Core (Standard CRUD)
For `customers`, `leads`, `products`, `deals`:
- `GET /<resource>`: List with pagination, sort, filtering (`q`)
- `POST /<resource>`: Create
- `GET /<resource>/:id`: Get by ID
- `PATCH /<resource>/:id`: Update (partial)
- `DELETE /<resource>/:id`: Soft delete

## 4. Specific Business Operations
- `POST /leads/:id/activities`: Add lead activity note
- `POST /leads/:id/convert`: Convert Lead to Customer (Idempotent, Transactional)
- `POST /leads/:id/quotations`: Generate Quotation
- `POST /deals/:id/stage`: Update Deal stage (Optimistic concurrency)
- `POST /deals/:id/convert`: Convert Deal to Customer (Idempotent, Transactional)
- `GET /deals/pipeline`: Kanban view grouped by stage
- `POST /tickets/:id/notes`: Add note to ticket
- `POST /documents/upload`: Get upload URL
- `GET /documents/:id/download`: Get signed download URL

## 5. Exports / Imports
- `POST /imports/localstorage`: Migrate localStorage JSON payload
- `GET /imports/:id`: Import status/report
- `GET /exports/crm`: Export tenant data

## Response Format
```json
{
  "success": true,
  "data": {},
  "message": "Resource retrieved"
}
```
