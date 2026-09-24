# Migration Strategy

## 1. Overview
The current CRM operates entirely on `localStorage`. A one-time migration API will allow users to upload their `localStorage` state to the new backend.

## 2. Migration API
`POST /api/v1/imports/localstorage`

**Payload:** A JSON object matching the `localStorage` dump (e.g. `crm_customers`, `crm_leads`, `crm_company`).

## 3. Rules & Transformations
1. **ID Generation:** All string IDs (`c_abc123`) will be converted to MongoDB `ObjectIds`.
2. **Relationships:** 
   - Since legacy items rely on strings (e.g., `product: "Pro Plan"`), the importer will attempt to resolve them by name against the newly created Products during import.
   - Any unresolved relationships will be reported in the Import Report and set to null.
3. **Field Mapping:**
   - `price` → `basePrice`
   - `quantity` → `quantityInStock`
   - `gst` → `gstPercentage`
   - `pincode` → `postalCode`
4. **Tenant Scoping:** All imported records will be attached to the current user's `organizationId`.
5. **No Client Auth Import:** `crm_session` and `crm_user` will NOT be imported.
6. **Validation:** Records failing strict backend validation will be skipped and added to a rejected rows report.

## 4. Result
The API returns a summary report:
```json
{
  "success": true,
  "data": {
    "customersImported": 50,
    "leadsImported": 120,
    "rejectedRows": [...],
    "unresolvedRelationships": [...]
  }
}
```
