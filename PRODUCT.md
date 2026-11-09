# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (installable PWA). Used on desktop, tablet and phone.

## What it is

CRX Manager is Crop RX Solutions' operations and billing app. Crop RX is an agricultural chemical distributor in the US Midwest. The app runs the whole sale: quote, booking (a grower reserves product at a price and draws it down over several orders), order, delivery, invoice and payment, plus inventory, purchasing and spray-field application jobs. From January 2027 it replaces the old billing software (Chem Man) for chemical sales.

## Users and situations

- **Office staff and the owner:** quoting, orders, invoices, payments and reports, mostly at a desk for long sessions.
- **Sales reps:** quotes and bookings for their own growers. Device mix is not confirmed yet, so desktop, tablet and phone are treated as equally important for quoting. *(Inferred; confirm with the owner.)*
- **Drivers and applicators:** deliveries and field jobs on phones, in trucks and fields, often in bright light and with gloves.
- **Growers (customers):** never sign in. They see quotes, invoices and statements as PDFs or email.

## What success looks like

- Staff finish a quote, order or invoice without wondering what a button does or whether their work was saved.
- Every money figure on screen matches the PDF and the invoice to the cent.
- The PDFs look as professional as the Chem Man documents the owner is used to.

## Durable constraints

- **Behaviour is fixed during UI work.** Screen changes never alter what a button does, what gets saved or when, permissions, totals or money rounding. Billing rules belong to the owner.
- **Money is exact.** Never round or recompute money in the presentation layer differently from the stored value.
- **Saving:** screens that save each change immediately keep doing so; they show a clear saving / saved / failed status instead.
- **Accessibility:** WCAG 2.2 AA, 44px touch targets, keyboard reachable.
- **Light theme only.** Brand colours, fonts and logo are recorded in DESIGN.md and are owner-approved.
- **Public repository:** no customer names or real customer data in code, docs, tests or screenshots. Synthetic data only.

## Voice

Plain, short American English a farm office would use. Say what happened and what to do next. No em dashes, no jargon, no internal codes in messages.

## Terminology

Quote, booking (a sent quote the grower has committed to), draw (taking booked product onto an order), tier (price level), planned program, close short, grower, rep.
