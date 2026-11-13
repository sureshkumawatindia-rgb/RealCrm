# CRM types: one CRM, set up for each kind of business

Decided with the owner on 2026-11-09 (D122, D123); Trader added on 2026-11-11 (D124), Manufacturer on 2026-11-11 (D126), Pest Control's AMC visits template on 2026-11-11 (D127), Real Estate on 2026-11-11 (D128), Education / Coaching on 2026-11-11 (D129), Clinic / Hospital on 2026-11-11 (D130), Travel Agency on 2026-11-11 (D131), Insurance / Loan Agent on 2026-11-11 (D132), Salon / Spa on 2026-11-11 (D133), Gym / Fitness on 2026-11-11 (D134), Interior / Construction on 2026-11-11 (D135), Solar Installer on 2026-11-11 (D136), AC / Appliance Repair on 2026-11-11 (D137), Home Cleaning on 2026-11-11 (D138), Car Dealer / Service Centre on 2026-11-11 (D139), Digital Marketing Agency on 2026-11-11 (D140), Event / Wedding Planner on 2026-11-11 (D142; D141 is the go-live on agreem360.com), Transport / Logistics on 2026-11-13 (D143), CA / Legal Services on 2026-11-13 (D144) — all 20 built.

There is **one CRM**. No separate product is built for any category. A company chooses its **CRM Type** on the company form (and can change it in Settings → Company), and the CRM that already exists is set up for that kind of work. Every category follows the same pattern as Pest Control.

- Every company is **Business** until it chooses, and Business is the CRM exactly as it was.
- Owners and admins can change the type.
- Choosing a type only adds what the company does not have yet. The company's own stages, quick replies, terms, products, fields, records and project templates stay, and choosing it again adds nothing twice.
- Going back to Business brings the words and the menu back. What was added stays (nothing is deleted).
- A type joins the dropdown in its own phase.

## What a category can change

| Part of the CRM | How |
| --- | --- |
| Sales stages | Business kit, only if the company has not changed its stages |
| WhatsApp quick replies | Business kit, only shortcuts that are still free |
| Quotation terms | Business kit, only if the company has none |
| Extra fields on a customer or an enquiry | Custom fields (by label, in English or Hindi; never one the CRM has built in) |
| Products list | Products, price ₹0 for the company to fill in |
| Own kinds of record | Custom objects, under "Your records". A record has its own customer link, so none asks for the customer again |
| Project templates | Projects: a won enquiry becomes a project with these steps in one click |
| Pages in the menu | Hidden pages; can be switched back on in Settings → Team & Access |
| Names everywhere | Word list in `js/app.js`, English and Hindi |

Built in already, so never added: a customer's GSTIN, city and address; an enquiry's quantity and closing date; an order's transporter, LR number and vehicle.

## The categories built so far

### Pest Control (D123)

- **Stages:** New enquiry → Site inspection → Quotation sent → Treatment booked.
- **Quick replies:** `/details`, `/inspection`, `/precautions`, `/visit`, `/done`, `/amc`, `/renewal`, `/payment`, `/thanks`.
- **Terms:** warranty, re-service, payment, AMC visits; valid 15 days.
- **Enquiry fields:** Pest type (list column), Property type, Area (sq ft), Inspection date.
- **Treatments:** 9, including the AMC; SAC 998531, GST 18%.
- **AMC contracts:** start and end date, visits in a year, next service date, amount, status. The customer is the record's own link.
- **Project template "AMC: 4 visits a year" (D127):** on a won AMC job, Projects → "Start the project" gives the whole year in one click: a visit task on days 0, 90, 180 and 270, a WhatsApp reminder task two days before visits 2 to 4 (`/visit`), and the renewal on day 335 (`/renewal`). 5 milestones, 8 tasks, 365 days. "Start a project by itself when a deal is won" stays off, because it would start one for one-off treatments too.
- **Menu:** everything stays, Projects included (it carries the AMC visits).
- **Words:** Leads → Enquiries, Deals → Jobs, Products → Treatments. Hindi uses ट्रीटमेंट rather than सर्विस because the Hindi texts treat प्रोडक्ट as masculine (नया प्रोडक्ट, जुड़ गया), and ट्रीटमेंट fits them while सर्विस would not.

### Trader / Wholesaler (D124)

- **Stages, quick replies, terms:** the existing trader kit (New enquiry → Rate shared → Quotation sent → Negotiation; `/rate`, `/followup`, `/moq`, `/payment`, `/dispatch`, `/thanks`; ex-godown, valid 7 days). It stays in "Ready settings" for a Business company too.
- **Customer fields:** Customer type (list column), Credit limit (₹), Credit days, Area or route.
- **Enquiry fields:** Delivery city, Needed by.
- **Transporters:** phone, cities served, freight rate.
- **Products:** none; what a trader sells is their own.
- **Menu:** Projects hidden.
- **Words:** Leads → Enquiries.

### Manufacturer (D126)

- **Stages, quick replies, terms:** the existing manufacturer kit (New enquiry → Requirement understood → Sample sent → Quotation sent → Waiting for PO; `/catalogue`, `/sample`, `/moq`, `/leadtime`, `/payment`, `/dispatch`, `/thanks`; ex-works, valid 15 days). It stays in "Ready settings" too.
- **Customer fields:** Customer type (distributor, dealer, OEM or brand, exporter …; list column), Credit limit (₹), Credit days.
- **Enquiry fields:** Size or specification, Sample status (list column), Needed by.
- **Transporters:** as for a trader.
- **Project template "Production order":** Order confirmed → Raw material ready (day 5) → Production done (day 15) → Quality checked and packed (day 18) → Dispatched (day 21), with 5 tasks. "Start a project by itself when a deal is won" stays the owner's choice.
- **Products:** none.
- **Menu:** everything stays, Projects included.
- **Words:** Leads → Enquiries.

### Real Estate (D128)

For property dealers and builders.

- **Stages:** New enquiry → Requirement understood → Site visit fixed → Site visit done → Price shared → Negotiation (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/property`, `/visit`, `/followup`, `/documents`, `/payment`, `/thanks`.
- **Terms:** price until booking, GST, stamp duty and registration extra, booking amount, payment plan, approved plans, brokerage when the deal is final; valid 7 days.
- **Customer field:** Customer type (buyer, tenant, owner or landlord, investor, builder, channel partner; list column).
- **Enquiry fields:** Requirement (buy, rent, sell, give on rent), Property type, BHK, Budget (₹), Preferred location, Site visit date, and **Property**, a link to one of the company's Properties. List columns: Requirement, BHK, Budget.
- **Properties** (under "Your records"): Sale or rent, Property type, BHK, Area (sq ft), Price (₹), Location, Status (available, on hold, booked, sold or rented). The record's own customer is the owner or landlord. List columns: Price, Location, Status.
- **Products:** none added, and the Products page stays: a quotation line can be a name and a price, and a builder can list units there.
- **Menu:** Projects hidden. In real estate a "project" is the builder's housing project, not the CRM's after-sale projects.
- **Words:** Leads → Enquiries.

### Education / Coaching (D129)

For coaching institutes, tuition and training classes.

- **Stages:** New enquiry → Counselling done → Demo class → Fees shared → Ready to join (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/course`, `/demo`, `/fees`, `/reminder`, `/batch`, `/documents`, `/thanks`.
- **Terms:** fees for the course and duration, admission on the first instalment, due dates and late fee, a pro-rata refund for a student who leaves midway, batch timings, the institute's rules; valid 7 days.
- **Enquiry fields:** Student name, Class or qualification (list column), School or college, Preferred batch time (list column), Enquiry by (student or parent), Demo class date, and **Batch**, a link to one of the company's Batches. The course is the enquiry's built-in "interested course".
- **Batches** (under "Your records"): Course, Start date, Timings, Teacher, Total seats, Seats filled, Status (open for admission, full, running, finished). List columns: Start date, Timings, Status.
- **Project template "Admission: fees in 3 instalments":** on a won admission, Projects → "Start the project" gives the first instalment and documents (day 0), the timetable (day 1), a `/reminder` three days before the second and third instalments (days 30 and 60), and the feedback on day 90. 4 milestones, 7 tasks.
- **Courses:** the Products list, named Courses; none added.
- **Menu:** everything stays, Projects included.
- **Words:** Leads → Enquiries, Deals → Admissions, Products → Courses. In Hindi Deals stay डील: the Hindi texts treat डील as feminine (डील हटा दी) and एडमिशन is masculine, so changing it would break their grammar; प्रोडक्ट → कोर्स and लीड → पूछताछ fit.

### Clinic / Hospital (D130)

For clinics (dental, eye, skin, physiotherapy …) and small hospitals. It is for enquiries, appointments, follow-ups and packages, not a medical record: no diagnosis or history fields (the less health data a CRM keeps, the better).

- **Stages:** New enquiry → Appointment booked → Consulted → Treatment advised → Follow-up (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/appointment`, `/reminder`, `/location`, `/reports`, `/followup`, `/estimate`, `/review`.
- **Terms (a treatment estimate):** the final bill follows the treatment given, medicines and tests extra, payment at each visit unless a package, GST only where the law requires it (for example cosmetic treatments); valid 15 days.
- **Treatments:** Consultation and Follow-up consultation, price ₹0, GST 0% (health care by a clinic or a doctor is exempt; a cosmetic treatment's rate is set on that treatment).
- **Enquiry fields:** Patient name, Department (list column), **Doctor** (a link to one of the company's Doctors), Appointment date (list column), Visit type (first visit, follow-up, procedure; list column).
- **Doctors** (under "Your records"): Speciality, OPD days and timings, Consultation fee (₹), Phone.
- **Project template "Treatment: 6 weekly sessions":** on a won case, a task for each weekly session, a `/reminder` the day before sessions 2 to 6, and a `/review` request the day after the last. 7 milestones, 12 tasks, 36 days.
- **Menu:** everything stays.
- **Words:** Customers → Patients (ग्राहक → मरीज़, and ग्राहकों → मरीज़ों), Leads → Enquiries, Deals → Cases (English only, as for an institute), Products → Treatments.

### Travel Agency (D131)

For holiday, pilgrimage, group and business travel agencies.

- **Stages:** New enquiry → Requirement understood → Itinerary sent → Negotiation → Advance awaited (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/itinerary`, `/documents`, `/advance`, `/balance`, `/visa`, `/departure`, `/feedback`.
- **Terms:** per-person prices on sharing, booking on the advance and the balance before the trip, fares that change until booked, cancellation charges, what is not included, ID/passport/visa; valid 3 days (travel prices change fast).
- **Enquiry fields:** Destination, Travel date, Nights, Adults, Children, Budget (₹), Hotel category, Trip type (family, honeymoon, group, pilgrimage, business, adventure), Departure city. List columns: Destination, Travel date, Budget.
- **Suppliers** (under "Your records"): Supplier type (hotel, transport, guide, tickets, local agent), City, Phone, Rates and notes.
- **Packages:** the Products list, named Packages; none added.
- **Menu:** Projects hidden. No project template: a project's tasks can only fall after its start, and a trip's work falls before the departure.
- **Words:** Leads → Enquiries, Deals → Trips, Products → Packages — in Hindi too (डील → ट्रिप, both feminine; प्रोडक्ट → पैकेज, both masculine).

### Insurance / Loan Agent (D132)

For insurance agents and POSPs, and loan DSAs.

- **Stages:** New enquiry → Need understood → Options shared → Documents collected → Application submitted (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/options`, `/documents`, `/submitted`, `/approved`, `/renewal`, `/referral`.
- **Terms:** premiums and rates as the insurer or bank gives them, subject to their approval and terms, read the wording before signing, true and complete details, premiums and loan charges paid to the insurer or bank directly; valid 7 days.
- **Products:** Term, Health, Life and Motor insurance; Home, Personal, Business and Car loans and Loan against property — price ₹0 and no GST here, as the insurer or the bank bills the client. An enquiry's "interested product" and the reports by product work at once.
- **Client fields:** Date of birth, Occupation (list column).
- **Enquiry fields:** Cover or loan amount (₹), Monthly income (₹), Insurer or bank, Application number.
- **Policies** (under "Your records"; the record's customer is the policy holder): Policy type, Insurer, Policy number, Premium (₹), Premium frequency, Renewal date, Status. List columns: Premium, Renewal date, Status.
- **Project template "Policy: a year to the renewal":** on a won case, the policy copy and thanks (day 0), a check call (day 15), `/renewal` reminders on days 335 and 358, and the renewal on day 365.
- **Menu:** everything stays.
- **Words:** Customers → Clients, Leads → Enquiries, Deals → Cases (Clients and Cases in English only). Products keep their name: "Plans" would be mixed up with the CRM's own subscription plans.

### Salon / Spa (D133)

For beauty and unisex salons, spas, makeup artists and nail studios.

- **Stages:** New enquiry → Services and rates shared → Package quoted → Booking fixed (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/menu`, `/booking`, `/reminder`, `/bridal`, `/rebook`, `/birthday`, `/review`.
- **Terms:** per-service prices plus GST, arrive on time, 3 hours to cancel or move, package sittings within their validity, an advance for bridal and events, tell us about allergies; valid 7 days.
- **Services:** Haircut, Hair colour, Hair spa, Facial, Clean-up, Waxing, Threading, Manicure, Pedicure, Body massage, Bridal makeup — price ₹0 for the salon to fill in, SAC 9997, **GST 5%** (beauty and well-being services: 5% without input tax credit since 22 September 2025, 56th GST Council; 18% before).
- **Client fields:** Birthday (list column; for the `/birthday` offer), Preferred stylist, Allergies or skin notes.
- **Enquiry fields:** Appointment date (list column), Stylist (list column), Occasion (regular, wedding, party, festival).
- **Project template "Package: 6 monthly sittings":** on a won booking, a task for each monthly sitting, a `/reminder` the day before sittings 2 to 6, and a renewal offer with a `/review` request after the last. 7 milestones, 12 tasks, 151 days.
- **Menu:** everything stays.
- **Words:** Customers → Clients (English only), Leads → Enquiries, Deals → Bookings (बुकिंग in Hindi too: feminine like डील), Products → Services (English only: सर्विस is feminine, प्रोडक्ट masculine).

### Gym / Fitness (D134)

For gyms, yoga centres, Zumba and fitness studios.

- **Stages:** New enquiry → Trial booked → Trial done → Package shared → Ready to join (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/trial`, `/packages`, `/welcome`, `/renewal`, `/missed`, `/referral`, `/review`.
- **Terms:** fees for the package and period plus GST, the membership is for the named member, refunds and pauses per the membership policy, tell us about medical conditions or injuries, gym timings, personal training within validity; valid 7 days.
- **Packages:** Monthly, Quarterly, Half-yearly and Yearly membership, Personal training, Group classes — price ₹0, SAC 9997, **GST 5%** (fitness and yoga centres: 5% without input tax credit since 22 September 2025).
- **Customer fields:** Birthday, Fitness goal (list column), Injuries or health notes (for the trainer's care only).
- **Enquiry fields:** Trial date, Preferred time (both list columns).
- **Memberships** (under "Your records"; the record's customer is the member): Package, Start date, End date, Amount paid (₹), Personal trainer, Status. List columns: Package, End date, Status.
- **Project template "Membership: 3 months":** on a won deal, the welcome (day 0), a first-week check-in (day 7), progress checks on days 30 and 60, `/renewal` reminders on days 80 and 87, and the renewal on day 90.
- **Menu:** everything stays.
- **Words:** Leads → Enquiries, Products → Packages (पैकेज in Hindi too). Customers keep their name: "members" would be mixed up with the team's members.

### Interior / Construction (D135)

For interior designers and construction contractors: home interiors, modular kitchens, renovation and civil work.

- **Stages:** New enquiry → Site visit and measurement → Design shared → Quotation sent → Negotiation (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/visit`, `/design`, `/quote`, `/payment`, `/update`, `/handover`, `/review`.
- **Terms:** rates per unit with the final bill on the measured quantity, GST extra, payments by stage, design changes change cost and time, materials and brands as quoted, the site ready for work, warranty per makers and as agreed on workmanship; valid 15 days.
- **Client field:** Client type (home owner, business, builder, architect or designer; list column).
- **Enquiry fields:** Work needed (full home interior, modular kitchen, wardrobes, renovation, civil, painting, office or shop), Property type, Rooms or BHK, Area (sq ft), Budget (₹), Site address, Site visit date, Start by, Referred by. List columns: Work needed, Budget, Site visit date.
- **Vendors** (under "Your records"): Trade (carpenter, electrician, plumber, painter, mason, fabricator, material supplier), Phone, Rates and notes.
- **Project template "Interior project: 45 days":** Design sign-off (day 7) → Material ordered (14) → Carpentry and civil work (35) → Painting and finishing (42) → Handover (45), with 10 tasks: the payment at each stage (`/payment`), photo updates (`/update`), the snag check, the handover (`/handover`) and a review (`/review`).
- **Products:** none; a rate list (BOQ) is each firm's own.
- **Menu:** everything stays; Projects carries the execution.
- **Words:** Customers → Clients (English only), Leads → Enquiries. Deals keep their name: "projects" is the CRM's own Projects page.

### Solar Installer (D136)

For rooftop solar installers serving homes, housing societies and businesses.

- **Stages:** New enquiry → Site survey done → Quotation sent → Documents and subsidy → Advance awaited (its own kit, only with this CRM type).
- **Quick replies:** `/details` (asks for the electricity bill), `/survey`, `/quote`, `/subsidy` (PM Surya Ghar documents), `/install`, `/netmeter`, `/cleaning`, `/review`.
- **Terms:** price for the size and makes, payment at booking, material and commissioning, the subsidy paid by the government under the scheme, net metering per the electricity board, warranties per makers and as agreed on workmanship, a shadow-free strong roof; valid 15 days.
- **Enquiry fields:** Category (home, society, commercial, industrial, agriculture), Monthly bill (₹), Sanctioned load (kW), System size (kW), System type (on-grid, off-grid, hybrid), Roof type, Shadow-free roof area (sq ft), Electricity board, Consumer number, Subsidy (applied, approved, received, not eligible). List columns: Category, Monthly bill, System size.
- **Installations** (under "Your records"; the record's customer is the owner): System size (kW), Commissioned on, Net meter installed on, Panel warranty till, AMC till, Status — for warranty, cleaning and AMC.
- **Project template "Rooftop solar: 30 days":** Documents and subsidy registration (day 3) → Material delivered (10) → Structure and panels (15) → Electrical work and commissioning (18) → Net metering (30), with 10 tasks: the payments, `/install`, `/netmeter`, the subsidy claim and a `/review`.
- **Products:** none: a turnkey system's GST is split between goods and services (the 70:30 rule), which one rate on a product cannot hold.
- **Menu:** everything stays.
- **Words:** Leads → Enquiries.

### AC / Appliance Repair (D137)

For AC service and installation, and washing machine, refrigerator, RO and geyser repair.

- **Stages:** New request → Technician assigned → Visit done → Estimate shared → Approved, parts awaited (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/visit`, `/estimate`, `/parts`, `/done`, `/amc`, `/service`, `/review`.
- **Terms:** the visit charge (adjusted when the repair goes ahead), estimates after inspection, parts warranty per makers and repair warranty per the bill, old parts returned on request, gas and installation material as used, GST extra; valid 7 days.
- **Services:** Visit charge, AC service, gas refilling, installation and uninstallation, washing machine, refrigerator, RO and geyser repair, AC AMC — price ₹0, SAC heading 9987, **GST 18%** (repair and maintenance, unchanged on 22 September 2025).
- **Enquiry fields:** Appliance (list column), Brand, Problem, Service type (repair, service, installation, uninstallation, gas refilling; list column), Visit date (list column), Technician, Under warranty (a tick box).
- **AMC contracts** (under "Your records"): Appliance, Units, Start date, End date, Services in a year, Next service date, Contract amount (₹), Status. A company that is also pest control keeps one AMC contracts kind with both sets of fields.
- **Project template "AMC: 3 services a year":** services on days 0, 120 and 240, a `/service` reminder two days before services 2 and 3, the renewal offer (`/amc`) on day 335 and the renewal on day 365.
- **Menu:** everything stays.
- **Words:** Leads → Enquiries, Deals → Jobs (जॉब in Hindi too), Products → Services (English only).

### Home Cleaning (D138)

For home and office cleaning: deep cleaning, kitchens, bathrooms, sofas, carpets, water tanks.

- **Stages:** New enquiry → Requirement understood → Rate shared → Slot booked (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/rate`, `/booking`, `/prepare` (keep valuables away, water and power on), `/reminder`, `/done`, `/repeat`, `/review`.
- **Terms:** charges as quoted plus GST, our equipment and materials with the customer's water and power, valuables away, old stains may stay, 12 hours to change or cancel, payment when done; valid 7 days.
- **Services:** full home deep cleaning, kitchen, bathroom, sofa, carpet, mattress, water tank, office, after-construction cleaning, sanitisation — price ₹0, SAC heading 9985, **GST 18%** (cleaning services, unchanged on 22 September 2025).
- **Enquiry fields:** Property type, BHK or area (list column), Cleaning date (list column), Preferred time (list column), Pets at home (a tick box).
- **Project template "Monthly cleaning: 6 visits":** for a regular contract, a task for each monthly visit, a `/reminder` the day before visits 2 to 6, and a renewal offer (`/repeat`) after the last. 7 milestones, 12 tasks, 151 days.
- **Menu:** everything stays.
- **Words:** Leads → Enquiries, Deals → Bookings (बुकिंग in Hindi too), Products → Services (English only).

### Car Dealer / Service Centre (D139)

For car and two-wheeler dealers, new and used, and their workshops.

- **Stages:** New enquiry → Test drive done → Quotation sent → Finance and exchange → Ready to book (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/testdrive`, `/quote` (on-road price), `/finance` (EMI and documents), `/booking`, `/delivery`, `/service`, `/insurance`.
- **Terms:** ex-showroom prices with insurance, registration and accessories as shown, the price on the invoice date, the booking amount adjusted and refunds per the booking policy, delivery per the maker's supply, loans per the bank, the maker's warranty; valid 7 days.
- **Workshop services:** General service, Oil and filter change, Wheel alignment and balancing, Car wash and polish, Car AC service, Denting and painting — heading 9987, **GST 18%**. Vehicles for sale are not added: their GST depends on the vehicle since 22 September 2025.
- **Enquiry fields:** Enquiry for (new, used, service, insurance, accessories), Model, Variant or colour, Fuel, Test drive date, Exchange vehicle, Finance needed (a tick box), Registration number. List columns: Enquiry for, Model, Test drive date.
- **Vehicles** (under "Your records"; the record's customer is the owner): Registration number, Model, Purchase date, Last service date, Next service due, Insurance ends, Kilometres — for service and insurance reminders.
- **Project template "New vehicle: first year":** the delivery, a first-week call, the first and second services with `/service` reminders, and the insurance renewal (`/insurance`) with the third service on day 365.
- **Menu:** everything stays.
- **Words:** Leads → Enquiries, Deals → Bookings (बुकिंग in Hindi too). Products keep their name: they are the workshop's services and the accessories.

### Digital Marketing Agency (D140)

For agencies doing SEO, social media, Google and Meta ads, websites and branding.

- **Stages:** New enquiry → Discovery call done → Proposal sent → Negotiation → Agreement and advance (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/call`, `/proposal`, `/onboarding` (brand files and accesses), `/report` (the monthly report), `/invoice`, `/renewal`, `/review`.
- **Terms:** a monthly fee for the scope plus GST, ad spend paid by the client to the platforms, work after the advance and onboarding, no promised number of leads or sales, extra work quoted separately, 30 days' notice, the client owns their accounts and data; valid 15 days.
- **Services:** SEO, Social media management, Google Ads management, Meta ads management, Website design, Logo and branding, Content writing, Video editing — price ₹0, heading 9983, **GST 18%**.
- **Client fields:** Industry (list column), Website.
- **Enquiry fields:** Monthly budget (₹), Goal (more leads, more sales, brand, traffic, app installs; both list columns), Website or social link, Call date, Competitors.
- **Retainers** (under "Your records"; the record's customer is the client): Services, Monthly fee (₹), Start date, Renewal date, Account manager, Status.
- **Project template "Client onboarding: first month":** kick-off and accesses (day 0), audit (3), strategy and content calendar approved (7), campaigns live (10), a mid-month check (20), the first report (`/report`) and the next invoice (`/invoice`) on day 30.
- **Menu:** everything stays.
- **Words:** Customers → Clients, Products → Services (both English only), Leads → Enquiries.

### Event / Wedding Planner (D142)

For wedding planners and event managers: weddings, engagements, birthdays, corporate events.

- **Stages:** New enquiry → Requirement understood → Meeting or venue visit → Proposal sent → Negotiation (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/meeting`, `/proposal`, `/advance`, `/checklist`, `/payment`, `/eventday`, `/thanks`.
- **Terms:** the quote for the date, venue, guests and items, booking on the advance, vendor and venue terms, amounts paid to vendors not refundable on cancellation, extras at actuals, permissions per local rules, GST extra; valid 7 days.
- **Packages:** Full wedding planning, Event management, Decoration, Photography and video, Sound, lights and DJ, Mehendi and haldi set-up, Birthday party package — price ₹0, **GST 18%**, the SAC left for the planner. Catering is left out: its GST depends on how and where it is served.
- **Enquiry fields:** Occasion (wedding, engagement, reception, birthday, anniversary, corporate, religious), Event date, Guests, Budget (₹), City, Venue, Functions. List columns: Occasion, Event date, Budget.
- **Vendors** (under "Your records"): Category (venue, caterer, decorator, photographer, DJ and sound, makeup, mehendi, band or dhol, transport), City, Phone, Rates and notes.
- **Project template "Wedding: 60 days of planning":** Booking → Venue and vendors locked (day 14) → Decor and menu final (30) → Guests and logistics (45) → Event day (60) → Settlement (62), with 10 tasks incl. the second payment, the checklist, the rehearsal and the review.
- **Menu:** everything stays.
- **Words:** Customers → Clients (English only), Leads → Enquiries, Deals → Bookings (बुकिंग), Products → Packages (पैकेज). Not "Events": the Calendar's events are something else.

### Transport / Logistics (D143)

For fleet owners, goods transport agencies and brokers, and packers and movers.

- **Stages:** New enquiry → Load details taken → Rate shared → Negotiation → Vehicle arranged (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/rate`, `/vehicle`, `/loaded` (LR/bilty), `/tracking`, `/delivered` (POD), `/payment` (freight), `/thanks`.
- **Terms:** the rate for the route, vehicle and weight with detention, loading and tolls extra, declared goods and no hazardous goods, owner's risk unless insured, advance at loading and balance on delivery, delivery times as estimates, GST as it applies to goods transport; valid 3 days.
- **Enquiry fields:** From, To, Goods, Weight (tonnes), Load type (full, part, shifting), Vehicle needed (pickup to trailer), Loading date, LR number. List columns: From, To, Loading date.
- **Vehicles** (the company's own fleet): Registration number, Vehicle type, Capacity, Driver, Driver phone, Insurance ends, Permit and fitness end, Status (available, on a trip, in repair). Shared by name with the Car Dealer type, so a company with both keeps one Vehicles kind.
- **Transporters** (the ones it hires): as for a trader.
- **Services:** none added: a goods transport agency's GST depends on its option and on who pays (reverse or forward charge).
- **Menu:** Projects hidden (a load is booked, moved and delivered in days).
- **Words:** Leads → Enquiries, Deals → Bookings (बुकिंग in Hindi too), Products → Services (English only).

### CA / Legal Services (D144)

For chartered accountants, tax consultants, GST practitioners, company secretaries and lawyers.

- **Stages:** New enquiry → Consultation done → Documents received → Fee quoted → Engagement letter sent (its own kit, only with this CRM type).
- **Quick replies:** `/details`, `/meeting`, `/documents`, `/fee`, `/itr` (return due date), `/gst` (GST return reminder), `/filed` (acknowledgement), `/invoice`. None asks for a review: the professions' own rules (ICAI, the Bar Council) restrict soliciting work.
- **Terms:** the fee for the work described with government fees and penalties at actuals, GST extra, work after documents and any advance, due dates depending on documents in time, the client answerable for the information, recurring work billed monthly or quarterly; valid 15 days.
- **Services:** Income tax return filing, GST registration, GST return filing, TDS return filing, Bookkeeping, Company or LLP registration, Tax audit, Tax notice reply — heading 9982, **GST 18%**. An advocate's legal services are not added: their GST works differently (reverse charge for a business, exempt for an individual).
- **Client field:** Client type (individual, proprietor, partnership or LLP, company, trust or society).
- **Enquiry fields:** Work area (income tax, GST, company or LLP, audit, accounting, legal matter), Due date, Financial or assessment year, Documents received (a tick box).
- **Compliances** (under "Your records"; the record's customer is the client): Filing (GST, TDS, income tax, ROC, audit), How often, Next due date, Handled by, Status (pending, filed, late).
- **Project template "GST returns: 3 months":** started on the 1st of a month, each month gives the bills (`/gst`) on day 3, GSTR-1 by the 11th and GSTR-3B by the 20th (`/filed`).
- **Menu:** everything stays.
- **Words:** Customers → Clients, Deals → Cases, Products → Services (all English only), Leads → Enquiries.

The words change in every text of the CRM except `{placeholders}`, HTML tags, and the names other companies give their own screens (Facebook "Lead Ads", IndiaMART "Lead Manager", Google's "lead form").

## Adding a category

1. `backend/src/constants/crmTypes.js`: the id in `CRM_TYPE_IDS`, its file in `CRM_TYPE_SETUPS`.
2. `backend/src/constants/crmTypeSetups/<name>.js`: its `products`, `fields` (each with its `object`: `contact` or `lead`), `records`, `projectTemplates` (optional) and `hiddenModules`. A field can link to one of the type's own records with `type: 'lookup', lookupRecord: <index in records>` (records are made first; with no room for the record, the link field is left out). Parts several types use are in `shared.js`. Its ready settings (stages, quick replies, terms) are `KITS[<id>]` in `businessKits.js`, under the same id as the type: a new kit is written in the type's file with `crmTypeOnly: true` (like Pest Control), an existing one is used as it is (like Trader and Manufacturer). Before adding a field, check the customer, the enquiry and the record already lack it.
3. `<option>` on `company.html` and `Settings.html`; `crmType.<id>` in both i18n files; the option texts in `backend/e2e/crmtype.spec.js`.
4. Its words in `CRM_TYPE_WORDS` in `crm/frontend/js/app.js` (a Hindi word can be `[word, its plural before को, की …]`, as ग्राहक: [मरीज़, मरीज़ों]). A danda (।) after a word counts as punctuation, not a letter. Run the words over `en.json` and `hi.json` first and read what changes; add any other company's screen name to `CRM_WORDS_KEEP`.

## The 20 phases

| Phase | CRM type | State |
| --- | --- | --- |
| 1 | Business (and the CRM Type dropdown) | Built |
| 2 | Pest Control | Built |
| 3 | Trader / Wholesaler | Built |
| 4 | Manufacturer | Built |
| 5 | Real Estate | Built |
| 6 | Education / Coaching | Built |
| 7 | Clinic / Hospital | Built |
| 8 | Travel Agency | Built |
| 9 | Insurance / Loan Agent | Built |
| 10 | Salon / Spa | Built |
| 11 | Gym / Fitness | Built |
| 12 | Interior / Construction | Built |
| 13 | Solar Installer | Built |
| 14 | AC / Appliance Repair | Built |
| 15 | Home Cleaning | Built |
| 16 | Car Dealer / Service Centre | Built |
| 17 | Digital Marketing Agency | Built |
| 18 | Event / Wedding Planner | Built |
| 19 | Transport / Logistics | Built |
| 20 | CA / Legal Services | Built |

## AMC visits for Pest Control

On 2026-11-09 the owner chose to set up only what exists, with no new feature for AMC visits. On 2026-11-11 it turned out the existing Projects feature gives them in one click, and the owner said yes ("Haan, template jodo"): Projects is no longer hidden for Pest Control, and the "AMC: 4 visits a year" template is added (D127). A company that chose Pest Control before D127 has Projects hidden and no template: switch Projects on in Settings → Team & Access, and choose Business, save, then Pest Control, save, to add the template.
