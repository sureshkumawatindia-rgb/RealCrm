# Frontend / Backend Gap Analysis

## A. Existing Frontend Behavior

The application currently operates entirely in the browser using HTML, CSS, and Vanilla JavaScript, relying on `localStorage` for all persistence.
Authentication is simply the presence of `crm_session` and `crm_user` in `localStorage`. 
There is no backend, no real database, and no server-side logic. 
All calculations (such as pricing and GST) and all relationship linkings (like Lead to Customer conversion) happen purely on the client side.

### Modules

1. **Authentication & User (`login.html`, `Settings.html`)**
   - **Current:** Basic `localStorage.setItem('crm_session', ...)`
   - **LocalStorage Keys:** `crm_session`, `crm_user`

2. **Company / Organization (`company.html`, `dashboard.html`)**
   - **Current:** Basic CRUD form that saves a single company profile.
   - **LocalStorage Keys:** `crm_company`
   - **Fields:** name, industry, email, phone, website, etc. Note: The `company.html` uses `gst`, `size`, `pincode`, but `app.js` expects `taxId`, `employees`, `zip`.

3. **Customers (`customers.html`)**
   - **Current:** Simple list with Add/Update/Delete. Client-side search and filtering.
   - **LocalStorage Keys:** `crm_customers`
   - **Fields:** id, name, email, phone, company, address, notes, product, status.

4. **Leads (`leads.html`)**
   - **Current:** CRUD, stage updates, notes, manual value, follow-up date. WON conversion is triggered manually and sometimes creates quotations.
   - **LocalStorage Keys:** `crm_leads`, `crm_lead_activities`

5. **Products (`Products.html`)**
   - **Current:** Inline editing, stock tracking (display only), client-side tax calculations.
   - **LocalStorage Keys:** `crm_products`

6. **Deals (`Deals.html`)**
   - **Current:** Kanban board with drag-and-drop. Client-side filtering. 
   - **LocalStorage Keys:** `crm_deals`, `crm_deal_tasks`

7. **Quotations**
   - **Current:** Generated implicitly from Lead product selections. Totals are trusted from the browser.
   - **LocalStorage Keys:** `crm_quotations`

8. **Tasks & Calendar (`Tasks.html`, `Calendar.html`)**
   - **Current:** Kanban and list views, calendar grid rendering using local time.
   - **LocalStorage Keys:** `crm_tasks`, `crm_calendar_events`

9. **Tickets (`Support.html`)**
   - **Current:** Ticket creation with a local counter starting at 1000.
   - **LocalStorage Keys:** `crm_tickets`, `crm_ticket_seq`

10. **Marketing & Automation (`Marketing.html`, `Sales Automation.html`)**
    - **Current:** Simulated runs and enrollments. Campaigns are stored locally.
    - **LocalStorage Keys:** `crm_campaigns`, `crm_workflows`, `crm_sequences`

11. **Documents (`Documents.html`)**
    - **Current:** Base64 or local object URLs, stored locally.
    - **LocalStorage Keys:** `crm_documents`

## B. Backend Mapping

For every frontend feature, the new data flow will be:
`Frontend` → `API endpoint` → `Controller` → `Service` → `Repository` → `Model` → `MongoDB collection`

- **Auth:** Google OAuth → `/api/v1/auth/google` → `AuthService` → `users` collection.
- **Company:** `/api/v1/organization` → `OrganizationService` → `organizations` collection.
- **Customers:** `/api/v1/customers` → `CustomerService` → `customers` collection.
- **Leads:** `/api/v1/leads` → `LeadService` → `leads` collection.
- **Products:** `/api/v1/products` → `ProductService` → `products` collection.
- **Quotations:** `/api/v1/quotations` → `QuotationService` → `quotations` collection.
- **Deals:** `/api/v1/deals` → `DealService` → `deals` collection.
- **Tasks/Calendar:** `/api/v1/tasks`, `/api/v1/events` → `TaskService`/`CalendarService` → `tasks`/`calendar_events`.
- **Tickets:** `/api/v1/tickets` → `TicketService` → `tickets` collection.
- **Marketing:** `/api/v1/campaigns`, `/api/v1/workflows` → `MarketingService` → `campaigns`, `workflows`.

## C. Problems Discovered

1. **Inconsistent Field Names:** `company.html` uses `gst`, `size`, `pincode`, but shared review code uses `taxId`, `employees`, `zip`. Product calculations use `price` vs `basePrice`.
2. **Broken Relationships:** Most relationships are display-name strings (e.g., `product: "Pro Plan"`). If a product is renamed, the relationship breaks.
3. **Duplicate Logic:** Lead conversion and deal conversion share similarities but are implemented independently on the frontend.
4. **Missing Validation:** The frontend relies on HTML5 validation. The server must strictly validate all inputs.
5. **Client-Trusted Values:** Quotation totals, product taxes, ticket sequences, and quotation numbers are currently fully trusted from the client.
6. **Inconsistent Status Values:** Deal stages and Lead statuses have different possible variations depending on the page and missing hard constraints.
7. **Security Issues:** No authentication, no authorization, no RBAC. Anyone can edit anything in `localStorage`.
8. **Migration Problems:** Existing legacy data needs `ObjectIds` generated and relationships repaired based on string matching.
9. **Concurrency Problems:** Lead/Deal conversion, Ticket Number generation, and Deal drag-and-drop are completely vulnerable to race conditions if ported exactly as-is.
