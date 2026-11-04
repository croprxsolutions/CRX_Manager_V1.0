# AgWorks (AgOS) - ag retail software

Scope note: only public marketing and listings were reachable. AgWorks publishes no public help center, manuals, release notes or demo videos that I could find. Several fetches (CropLife, TrustRadius) returned 403 and are cited only through search-result snippets. Most of the end-to-end flow, accounting and inventory questions are NOT answerable from public material (see Gaps).

## 1. Who makes it, history, ownership, size, customers, deployment, pricing

### Takeaway
AgWorks Software, LLC (Davenport, Iowa) is a small ag-retail software shop, a division of The McGregor Company since 2012. It sells AgOS (operations/agronomy), HighQ (decision support) and Stratum (data processing). Pricing is quote-only; third-party figures are unverified estimates.

### Cited Findings
- Company is AgWorks Software, LLC, 5129 Utica Ridge Road, Davenport, Iowa; listed as a division of The McGregor Company (founded 1882), which bought it in early 2012. Flagship is AgOS "The Unified Agronomy Solution"; other products HighQ (DSS) and Stratum (data cleaning/processing, linked to a McGregor Technologies site); DevWorks is a custom development arm. - [agworks.net](https://www.agworks.net)
- Timeline: founded 1992 in Preston, Iowa, by Martin Ag to provide real-time inventory for agronomy retail; McGregor acquired 2012; HighQ acquired from Willard Agri-Service in 2014; AgOS Mobile released 2018 (connects retailers to growers); FieldReveal relationship since 2019, McGregor part-owner of FieldReveal since 2021; Stratum in development. - [agworks.net/about](https://www.agworks.net/about)
- McGregor became the fifth owner of FieldReveal (others: Agtegra, Landus, Central Valley Ag, WinField United). - [agworks.net/news](https://www.agworks.net/news/agworks-and-fieldreveal-joining-forces)
- The company says its staff has 100+ combined years in ag retail ownership/operations. No customers are named on the site; partner logos (Yara, Case IH, John Deere) are partners, not customers. - [about](https://www.agworks.net/about)
- Smart Gun (ruggedized handheld for custom applicators) was released roughly a decade before 2009; a 2009 article describes a three-year traceability pilot with Mid America CropLife Association and a "Warehouse Gun" handheld linking office and warehouse. (Old info.) - [Cotton Grower 2009](https://www.cottongrower.com/?p=22309)
- Trade snippets: customers in "27 states" (undated), about 17 employees (directory estimate, unverified), CDMS alliance for crop-protection compliance data. - [search summary: PrecisionAg CDMS](https://www.precisionag.com/market-watch/agworks-announces-cdms-alliance/), [directory](https://leadiq.com/c/agworks-software-llc/5a1da7852300005e009b14ef/employee-directory)
- Pricing: "Custom/quote"; third-party estimate $200-$600 per user per month plus implementation $2,000-$30,000+, integrations $3,000-$15,000, annual support $1,200-$6,000. Estimates by a listing site, not AgWorks. - [SoftwareFinder](https://softwarefinder.com/agriculture-software/agworks)
- Deployment: AgWorks site states nothing. SoftwareFinder says offline-capable with hybrid/on-premise components; SourceForge lists Windows, iPhone, iPad, Android. - [SoftwareFinder](https://softwarefinder.com/agriculture-software/agworks), [SourceForge](https://sourceforge.net/software/product/AgOS-Operations/)

### Inferences
- Small vendor (inferred ~10-50 staff) with a captive owner who is itself an ag retailer; product likely shaped by McGregor's own operations (inferred).
- Desktop Windows core plus mobile apps, hybrid architecture (inferred from "Windows" + offline claims).

### Gaps
- Customer count, revenue, current headcount, confirmed hosting model: not found.

## 2. Modules and how they connect

### Takeaway
AgOS is one integrated platform: Operations (orders, inventory, blending, logistics), Crop Planning, Mapping, Scouting, Compliance, Grower Access, plus field apps. The central object appears to be the work order, fed from planning/mapping/scouting and feeding compliance logbooks and grower visibility.

### Cited Findings
- Operations: real-time inventory across locations; unifies crop plans, work orders, logistics, product sales, inventory adjustments, location transfers; inventory forecasting; compliance documentation. Scale Interface, Schedule and Smart Gun tools handle batch/shipment, fleet and scheduled field orders. - [agworks.net/agos](https://www.agworks.net/agos)
- Smart Gun captures order details during applicators' routine and automates logbook creation. - [agworks.net/agos](https://www.agworks.net/agos)
- Mapping: geo-referenced field boundaries, drawn or imported from shapefiles; orders can be created from current/historical agronomic data. - [agos](https://www.agworks.net/agos)
- Scouting: location-specific weed/insect/disease observations; recommendations can be added directly to a field application order; offline collection with auto sync (per listing). - [agos](https://www.agworks.net/agos), [SoftwareFinder](https://softwarefinder.com/agriculture-software/agworks)
- Compliance: placarding, EPA/DOT history, asset tracking, tank inspections, repackaging/shipping requirements, auto-created applicator logbooks from field events. - [agos](https://www.agworks.net/agos)
- Grower Access: customer-facing timeline of contracts/bookings, pre-invoices, delivery tickets, work orders, farm maps, split information, compliance info. Note "split information" and "pre-invoices" imply split billing and pre-invoice concepts exist. - [agos](https://www.agworks.net/agos)
- Mix Plant Manager (per SourceForge marketing text): connects orders to automated blending plant controls to avoid re-entering application info; NH3 tanks, custom-application tender loads and chemical shuttles reduce inventory as they ship. Vendor-influenced copy. - [SourceForge search summary](https://sourceforge.net/software/product/AgOS-Operations/)
- Mobile: "AgOS In The Field" (iPad, iOS 15+, release 1.0 Feb 2025, updates through 1.4 Apr 2025) gives applicators/drivers work orders, batches, blend quantities, compliance details, field notes, load list, multi-bin orders, applied acres. Related apps: AgOS In The Field+, AgOS Mobile v2, AgWorks Smart Gun. - [App Store](https://apps.apple.com/us/app/agos-in-the-field/id6504048464)
- AgOS Mobile v2 (Google Play) described as building work orders in the field, picking products such as blends and setting rates (via search snippet only). - [Google Play](https://play.google.com/store/apps/details?id=net.agworks.agosmobile.v2&hl=en_US)
- Partners: FieldReveal (zone-based variable rate), CDMS (crop protection label/compliance data), HighQ (profit-per-acre DSS). - [PrecisionAg](https://www.precisionag.com/market-watch/agworks-fieldreveal-form-partnership-to-bring-together-precision-ag-tools/)

### Inferences
- Work order is the hub: planning/scouting/mapping create it, blend/scale/mix plant fulfill it, Smart Gun/mobile closes it, compliance logbook falls out of it (inferred from the connections above).
- Product sales, bookings and contracts exist but are not documented as separate modules publicly.

### Gaps
- No public screens, module list for quoting/prepay/contracts/AR/finance charges/rebates.

## 3. End-to-end sale flow (quote -> payment)

### Takeaway
Not documented publicly. Only fragments: work order to batch/blend to load list to field application with logbook; pre-invoice and delivery ticket visible to grower.

### Cited Findings
- Grower portal exposes bookings/contracts, pre-invoices, delivery tickets, work orders, splits - [agos](https://www.agworks.net/agos); the order chain is therefore at least booking/contract -> work order -> delivery ticket -> pre-invoice (inferred ordering).
- Mobile app handles batches, blend quantities, load list, applied acres saved at completion (app release notes show "applied acres" handling and multi-bin orders) - [App Store](https://apps.apple.com/us/app/agos-in-the-field/id6504048464)

### Gaps
- What is created/locked/carried at each step: no public source.

## 4. Accounting logic

### Takeaway
Unclear. AgWorks site does not mention accounting; SourceForge lists "built-in accounting" as a supported feature yet also lists iRely i21 as the integration, a contradiction.

### Cited Findings
- SourceForge lists built-in accounting, CRM, inventory, order processing, barcoding/RFID as supported, and iRely i21 as an integration; also marks contract management unsupported while text says growers can access contracts in real time (internal contradiction). - [SourceForge](https://sourceforge.net/software/product/AgOS-Operations/)
- iRely i21 is an ag ERP with accounting that bills by delivery, contract and fixation (generic i21 description, not the AgOS handoff). - [SourceForge integrations](https://www.sourceforge.net/software/product/AgOS-Operations/integrations)
- Another source states a Willard partnership included integration points to popular ag retail accounting systems (via search summary). - [AgNewsWire](https://agnewswire.com/?p=3087)

### Inferences
- Likely AgOS does operations and hands invoices/inventory to a separate accounting/ERP rather than being the GL (inferred, weakly). Revenue/COGS timing, prepay, splits, credit memos, finance charges: unknown.

### Gaps
- All specific accounting rules: not public.

## 5. Inventory

### Cited Findings
- Real-time inventory across locations, salespeople and regions; transfers and adjustments; forecasting; NH3 tanks, tender loads and shuttles decrement as they ship. - [agos](https://www.agworks.net/agos), [SourceForge](https://sourceforge.net/software/product/AgOS-Operations/)
- Scale interface claimed to "virtually eliminate" inventory shrink. - [agos](https://www.agworks.net/agos)
- Original 1992 purpose was real-time inventory for agronomy retail. - [about](https://www.agworks.net/about)

### Gaps
- Unit conversions, blends-as-recipes detail, lot tracking: not public.

## 6. Screen and navigation patterns

### Cited Findings
- No public demo videos or screenshots found (search for YouTube demo returned only Agvance/AGRIS material, which is NOT AgWorks). Site has a 3-minute intro video referenced on the FieldReveal news post, not examined. - [news post](https://www.agworks.net/news/agworks-and-fieldreveal-joining-forces)
- Field-to-office: mobile apps and Smart Gun sync work orders and applied results; scouting syncs after offline collection. - [SoftwareFinder](https://softwarefinder.com/agriculture-software/agworks), [App Store](https://apps.apple.com/us/app/agos-in-the-field/id6504048464)

### Gaps
- Layout/navigation of the desktop app: unknown. Suggest asking the owner to describe the demo he saw.

## 7. Customer praise and complaints

### Cited Findings
- No independent reviews found: TrustRadius, G2 (AgOS Scouting/Mapping), SourceForge, SoftwareReview show none. App Store shows 4 ratings at 5.0. - [G2](https://www.g2.com/products/agos-scouting/reviews), [App Store](https://apps.apple.com/us/app/agos-in-the-field/id6504048464)
- Third-party listing cons: no public API docs, limited report customization, training needed. Pros: reduced shrink, offline use, automated logbooks. Unverified; the same page contradicts itself on API and integrations. - [SoftwareFinder](https://softwarefinder.com/agriculture-software/agworks)

### Gaps
- Real customer sentiment: none public.

## Overall reliability note
Company facts (history, modules, apps) come from agworks.net and App Store and are reliable. Pricing, headcount, features such as accounting come from low-quality directory listings. Do not confuse with Agvance/AGRIS help-center material.
