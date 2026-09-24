# Database Schema Plan

All core business collections include:
- `_id`: ObjectId
- `organizationId`: ObjectId
- `createdAt`: Date
- `updatedAt`: Date
- `deletedAt`: Date | null

## 1. Auth & Tenant
- **Users:** `email`, `name`, `pictureUrl`, `googleSubject`, `lastLoginAt`, `disabledAt`.
- **Organizations:** `name`, `taxId`, `employees`, `website`, etc.
- **OrganizationMembers:** `organizationId`, `userId`, `role` (owner|admin|agent|viewer).

## 2. CRM Core
- **Customers:** `name`, `email`, `phone`, `company`, `address`, `status`, `ownerId`.
- **Leads:** `name`, `email`, `productId`, `quantity`, `status`, `convertedCustomerId`, `ownerId`.
- **Deals:** `name`, `accountId`, `contactId`, `value`, `currency`, `stage`, `ownerId`, `probability`, `version`.
- **Products:** `name`, `category`, `basePrice` (Decimal128), `quantityInStock`, `gstPercentage`, `active`.
- **Quotations:** `number`, `leadId`, `status`, `subtotal`, `taxTotal`, `grandTotal`, `items` (embedded array of product snapshots).

## 3. Work Management
- **Tasks:** `title`, `assigneeId`, `dueDate`, `priority`, `status`, `relatedType`, `relatedId`.
- **CalendarEvents:** `title`, `startAt`, `endAt`, `assigneeId`.
- **Tickets:** `number` (Atomic counter), `subject`, `customerId`, `status`, `priority`.

## 4. Shared
- **Documents:** `name`, `category`, `storageKey`, `linkUrl`, `mimeType`, `sizeBytes`.
- **AuditLogs:** `organizationId`, `actorId`, `action`, `entityType`, `entityId`, `before`, `after`.
- **IdempotencyRecords:** `organizationId`, `userId`, `operation`, `idempotencyKey`, `response`.

## 5. Indexes
Every collection will have a compound index on `{ organizationId: 1, deletedAt: 1, createdAt: -1 }`.
