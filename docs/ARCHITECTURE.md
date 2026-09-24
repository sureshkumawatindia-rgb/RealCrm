# Backend Architecture

## 1. Overview
The backend will be built as a Modular Monolith using Node.js, Express.js, and MongoDB with Mongoose. 

## 2. Directory Structure

```text
backend/
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/              # Environment, database, logger config
│   ├── routes/              # Express routes (v1 API)
│   ├── controllers/         # HTTP request/response handlers
│   ├── validators/          # Request DTO and query schemas (e.g. Joi or Zod)
│   ├── services/            # Core business logic and transactions
│   ├── repositories/        # Mongoose queries and data access
│   ├── models/              # Mongoose schemas and indexes
│   ├── middleware/          # Auth, RBAC, tenant scope, errors, rate limiting
│   ├── policies/            # Record-level authorization policies
│   ├── integrations/        # 3rd party like Google Auth, Object Storage
│   ├── jobs/                # Background tasks (e.g., imports)
│   ├── utils/               # Pagination, money math, normalization
│   ├── constants/           # Enums, statuses, roles, error codes
│   └── tests/               # Unit, integration, security tests
├── scripts/                 # Migration and seed scripts
├── docs/                    # Architecture, API, DB documentation
├── .env.example
├── package.json
└── README.md
```

## 3. Data Flow

**Request Flow:** `Route` → `Middleware (Auth/Tenant/RBAC/Validate)` → `Controller` → `Service` → `Repository` → `Model` → `MongoDB`

- **Controllers** are thin. They parse the request, call the Service, and send the response.
- **Services** are fat. They hold business rules, transaction boundaries, and orchestrate repositories.
- **Repositories** handle Mongoose queries, projections, and ensure tenant isolation (`organizationId` is always appended).

## 4. Multi-Tenant Architecture
Every authenticated request goes through the `tenant` middleware:
1. Extract User from token.
2. Find `OrganizationMember` record for the user.
3. Attach `organizationId` and `role` to `req.tenant`.
4. Repositories automatically apply `{ organizationId: req.tenant.organizationId }` to every query.

## 5. Security & Idempotency
- **Idempotency:** Critical mutations (`POST /convert`, `POST /deals`) use an `Idempotency-Key` header.
- **Security:** Helmet, CORS, Rate Limiting, JSON limits. 
- **Soft Delete:** `deletedAt` is used instead of hard deletes for all business records.
