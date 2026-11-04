# AgWorks AgOS deep dive (gap-filling pass)

Scope: supplements agworks.md. Public material only. Headline: the brochure and agworks.net/agos carry identical marketing text (no extra workflow detail); no sub-pages exist; no videos, job postings, conference talks or release notes beyond the iOS version list were findable. Several fetches failed (see Gaps).

## 1. What the brochure and agworks.net product pages say

### Takeaway
The brochure (2-page-spread, 11 pages, InDesign; PDF metadata timestamp Sept 2022) is the same copy as agworks.net/agos, plus a few extra details (SmartGun blurb, Stratum, DevWorks, AgWorks Consulting). agworks.net has NO separate sub-pages for Operations, Scale Interface, Smart Gun, Mix Plant Manager, Compliance, Grower Access, etc.; they are sections of one page.

### Cited Findings
- Brochure URL: agworks.net/s/AgWorks_Marketing_Brochure.pdf redirects (302) to a Squarespace static file; the site is therefore a Squarespace site. Page links found on agworks.net/agos: only /agos, the brochure, and an external Stratum link at mcgregortechnologies.com/stratum. - [agworks.net/agos](https://www.agworks.net/agos), [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Brochure sections (text extracted with pdftotext): AgOS Operations, Crop Planning, Mapping, Schedule, SmartGun, Scouting, Compliance, Grower Access, "Interface Partners"; Analytics (HighQ DSS, Stratum); Consulting (AgWorks Consulting Services) and Custom Development (DevWorks). - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Operations wording: "unifies crop plans, work orders, related logistics, product sales, inventory adjustments, and location transfers with real-time inventory forecasting and compliance documentation"; connected Scale Interface, Schedule and Smart Gun tools give control over "batch and shipment management, efficient fleet management, ... scheduled orders out in the field which virtually eliminates inventory shrink". Also: current product positions help "quick and accurate purchase and sell decisions". - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- SmartGun blurb (not on agos page): "Handles applications and deliveries on mobile devices... real time work order management with a robust notification and compliance system built in." - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Crop Planning: shows input costs and agronomic variables affecting profitability; works offline; historical data. Mapping: orders can be created from current or historical agronomic data; geo-referenced field boundaries drawn manually or imported from shapefiles. Scouting: offline use with auto sync when connectivity returns; on-the-spot recommendations "immediately added to a field application order". - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Compliance: tracking and placarding, historical event logging for EPA/DOT issues, crop injury claims and seed performance issues; tank inspections; repackaging/shipping requirements; "tracks field activity events which allows for automatic creation of applicator log books". - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Grower Access: "historical timeline of field and business information... visual representation of the crop season"; includes contract/booking information, pre-invoices, delivery tickets, work orders, farm maps, split information, compliance information. - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf), [agos](https://www.agworks.net/agos)
- Stratum (data cleaning): web-based, accepts any data file type, multi-year storage, flexible export, "Connects to AgOS, FieldReveal and HighQ" (Rx writing and analysis). - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Brochure says the McGregor Company is "of Colfax, Washington". AgWorks Consulting Services offers SOP writing, custom development and "thousands of integration projects" oversight. - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- "Mix Plant Manager" does NOT appear on agworks.net/agos or in the brochure; the term appears only in the third-party SourceForge text already noted in agworks.md. Likewise "Scale Interface" is only a named tool inside Operations. - [agos](https://www.agworks.net/agos)

### Inferences
- Scale/blend/mix-plant detail is only described via marketing phrases, so no screen- or step-level workflow can be derived (inferred).

### Gaps
- Screenshots in brochure not viewed (PDF has about 8 embedded images; not rendered).
- Wayback Machine fetches are blocked in this environment, so older, more detailed pages could not be checked.

## 2. App Store / Google Play listings

### Takeaway
Only AgOS In The Field's iOS version history was retrievable. Listing text is minimal.

### Cited Findings
- AgOS In The Field: description opens with mobile work order access for applicators and delivery drivers to manage batches, blend quantities, compliance details, field notes; iPad design; free; 102.6 MB; iOS/iPadOS 15+; 4 ratings avg 5.0; no data collected. Versions: 1.0 (2025-02-19), 1.1 (2025-03-25, fixes/enhancements incl. load list), 1.2 (2025-04-01, changed how applied acres are saved), 1.3 (2025-04-16, fixed multi-bin orders), 1.4 (2025-04-22, fixed landmarks on tablets). - [App Store](https://apps.apple.com/us/app/agos-in-the-field/id6504048464)
- Per search snippets of other storefronts: AgOS Smart Gun lets applicators complete, manage and edit work orders, access mobile field boundaries, generate customer notifications, automate applicator logbooks, with offline mode; AgOS Mobile (v4.0 listing) is for growers and retailers, covering farm/field operations and production metrics on field performance. - [Smart Gun listing](https://apps.apple.com/uy/app/agos-smart-gun/id965961267), [AgOS Mobile listing](https://apps.apple.com/lk/app/agos-mobile/id1412875530) (search snippets only; direct fetch returned 404)
- A myagworks.com "mobile applications" page appeared in search results but its relevance to AgWorks Software is unclear (it describes an insurance-agent app). - [myagworks.com](https://myagworks.com/products/mobile-applications/) (different company, likely unrelated)

### Inferences
- "Customer notifications" in Smart Gun suggests applicators trigger grower notices from the work order (inferred). "Applied acres saved at completion" suggests the work order records planned vs applied acres (inferred).

### Gaps
- Screenshots described in words: not available (listing exposed no descriptions). Google Play description/what's new for AgOS Mobile v2: fetch returned truncated page. Smart Gun and AgOS Mobile version histories: 404 on fetch.

## 3. Accounting / ERP integration

### Takeaway
No evidence that AgOS has its own GL. Evidence points to integration with external accounting; the only named system is iRely i21 (directory listings only); a 2015 press release says integration points exist to "most popular ag retail accounting systems" without naming them.

### Cited Findings
- AgOS "has integration points to most popular ag retail accounting systems"; systems not named. 27 retail customers' states; AgWorks "wholly owned subsidiary" of McGregor. - [AgNewsWire](https://agnewswire.com/?p=3087)
- SourceForge lists iRely i21 as a current AgOS Operations integration, and i21's page lists AgOS Operations; no technical documentation of data direction/method exists in search results. - [SourceForge integrations](https://www.sourceforge.net/software/product/AgOS-Operations/integrations)
- Third-party listing says AgWorks has no public API and estimates ERP/scale integrations at $3,000-$15,000 (unverified estimate). - [SoftwareFinder](https://softwarefinder.com/agriculture-software/agworks)
- No iRely or AgWorks press release on a partnership was found. - searches run

### Inferences
- Pre-invoice in Grower Access (a "pre"-invoice) suggests AgOS produces a draft billing document that the accounting system finalizes (inferred, weak).

### Gaps
- Direction of sync, what transmits (invoice, inventory, payments), whether McGregor itself uses i21: not found.

## 4. Job postings, talks, podcasts, videos

### Takeaway
Nothing found.

### Cited Findings
- Searches for AgWorks/McGregor job postings, Vimeo/YouTube videos, conference talks returned only directory listings and unrelated Agvance/Trimble/Agworld material. - searches run
- CropLife articles that might discuss AgWorks ("Plant Automation Takes Traceability To The Next Level", "Software connectivity reaches beyond fertilizer blending") exist but returned HTTP 403. - [CropLife 1](https://www.croplife.com/iron/software/plant-automation-takes-traceability-to-the-next-level/), [CropLife 2](https://www.croplife.com/smart-tech/software/software-connectivity-reaches-beyond-fertilizer-blending/) (unread)

### Gaps
- LinkedIn, InfoAg, ARA material and job postings: not reachable via search tool. Suggest manual reading of the two CropLife articles.

## 5. How pre-invoices, contracts/bookings, splits, delivery tickets and work orders relate

### Takeaway
Only the list of six items exposed to growers is public; relationships between them are not documented.

### Cited Findings
- Grower Access exposes "contract/booking information, pre-invoices, delivery tickets, work orders, farm maps, split information". - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)
- Operations "unifies crop plans, work orders, related logistics, product sales" ; Scouting recommendations and Mapping data can create a field application order. - [brochure](https://static1.squarespace.com/static/6272e33bbeab9b5aa538b1f9/t/63347787728aff7fc282694b/1664382856911/AgWorks_Marketing_Brochure.pdf)

### Inferences
- Plausible chain (inferred only): booking/contract -> crop plan -> work order (product + application) -> load list/batch -> delivery ticket -> pre-invoice -> accounting invoice. "Split" likely means splitting a charge across payers/landlords or products across fields (inferred, ambiguous).

### Gaps
- Definition of split, whether pre-invoice is editable, how bookings draw down against delivery: no public source.
