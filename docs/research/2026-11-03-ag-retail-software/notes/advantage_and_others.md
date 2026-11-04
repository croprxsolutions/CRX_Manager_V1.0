# "Advantage" (Cultura) ag retail ERP, plus other ag retail software

## Key finding on naming: is there a Cultura product called "Advantage"?

### Takeaway
I found NO public evidence of a Cultura Technologies ERP named "Advantage". The premise appears to be a conflation. The nearest real products are: Agvance (made by SSI, not Cultura), AgVantage Software (a separate vendor, listed in AgGateway), and Cultura's Greenstone "Agris" ERP. Treat everything below as about these, not "Advantage".

### Cited Findings
- Cultura's own site says it is part of Constellation Software and acts as a global acquirer of agri-food software; brand logos shown include Aeros, Agvision, Amic, Core Tech, Extend Ag, Greenstone, Primetics, Solentra, CreditCrop, BIG Consulting. No "Advantage" and no product list. — [Cultura](https://culturatech.com)
- Cultura was formed March 2011 by merging five agri-food software companies owned by Constellation Software; portfolio includes Solentra Global, Greenstone Systems, Proceres. — [search summary citing Cultura/Agworld listings](https://www.agworld.com/nz/ecosystem/ag-retail)
- Cultura's AgGateway profile: a division of Volaris, itself an operating group of Constellation Software; customers include ag cooperatives, ag retailers/service providers, grain and flour millers, grain elevators. Products listed by category: Ag Business Systems, Agronomy, CRM, ERP (order-to-cash, logistics/inventory, procure-to-pay, consolidated financials, contracts), farm management, grain handling, precision ag (prescriptions), transport/logistics, formulation/blending/manufacturing, compliance/regulatory reporting. — [AgGateway: Cultura](https://aggateway.atlassian.net/wiki/spaces/APM/pages/69895092/Cultura+Technologies+LLC)
- Agvance is developed by Software Solutions Integrated (SSI), not Cultura; SSI says 40+ years in ag retail. — [Agvance](https://agvance.net/why-agvance); [SoftwareOne listing](https://marketplace.platform.softwareone.com/vendor/agvance/VND-2925-9120)
- AgVantage Software is a separate vendor of software for ag retailers and cooperatives (eAgvantage mobile product); its AgGateway profile has no parent named. — [AgGateway: AgVantage](https://aggateway.atlassian.net/wiki/spaces/APM/pages/69895044/AgVantage+Software)
- Cultura's ag-retail-relevant ERP is Greenstone's AGRIS (agribusiness ERP/grain accounting; AgroGuide agronomy module for crop planning, field history, margin analysis, GIS). — [Greenstone/AGRIS summary](https://sourceforge.net/software/product/AGRIS)

### Inferences
- (inferred) The user's "Advantage" most likely means Agvance, AgVantage, or Greenstone Agris. Of these, Agvance has by far the most public documentation (a public help center), so it is the best proxy for ag-retail ERP workflow.

### Gaps
- No source confirms any "Advantage" product from Cultura. Ownership link Agvance/AgVantage-to-Cultura: none found. Any Bushel-Cultura merger or sale: none found; Bushel describes itself as independently owned ([Global AgInvesting](https://globalaginvesting.com/bushel-closes-47m-series-c-led-lewis-clark-agrifood-continental-grain/)).

## Company background, ownership, customers, deployment

### Takeaway
Cultura is a Constellation Software (Volaris) roll-up still acquiring (ServiceERP Oct 2024, Agiboo, Core Software). Customers are co-ops, retailers, grain, feed, milling. Agvance (SSI) claims 700+ customers and 25,000+ users, delivered as accessible-anywhere software.

### Cited Findings
- Cultura acquired ServiceERP (inventory/ERP/merchandise mgmt, Europe) in October 2024. — [GlobeNewswire via Manila Times](https://manilatimes.net/2024/10/17/tmt-newswire/globenewswire/cultura-welcomes-serviceerp/1986305)
- Cultura acquired E-Markets in 2013, whose suite covered Grain, Ag Retail, Bio Fuel, Seed, and Cinch (Microsoft Dynamics GP, optionally cloud). — [Farms.com](https://m.farms.com/news/cultura-technologies-acquires-e-markets-inc-66751.aspx); [PrecisionAg](https://www.precisionag.com/technology/data/cultura-technologies-acquires-co-based-e-markets-inc/)
- Other Cultura add-ons: Agiboo BV (commodity trade/risk), Core Software (Ireland). — [PrivSource](https://www.privsource.com/acquisitions/deal/G5SEn4)
- Ag Producers Co-op went live on "CSI Cultura Greenstone Agris" in 2017 with the merger: inventory control, financial posting, procurement/PO workflow, agronomy records, input lot tracking, role-based access. — [AppsRunTheWorld](https://www.appsruntheworld.com/customers-database/customers/view/ag-producers-co-op-united-states)
- Agvance: modules Accounting, Agronomy, Energy, Grain, Grower360; 700+ customers, 25,000+ users; grower mobile app shows balances, unpaid invoices, prepay amounts, field applications, fuel fill-ups, grain positions. — [Agvance](https://agvance.net/why-agvance)

### Inferences
- (inferred) Single-system "accounting + agronomy + energy + grain" is the incumbent pitch; a small chem/fert app competes on scope-narrowness, not breadth.

### Gaps
- Cultura customer counts, pricing, on-prem vs cloud split for Agris: not found. Feed module details: not found.

## Modules and the one-sale flow (booking, prepay, blend, delivery, invoice, payment)

### Takeaway
In Agvance, bookings and prepay precede invoices; delivery, blend and energy tickets are imported into the same invoicing function as direct invoices; booked prices win in the pricing hierarchy.

### Cited Findings
- Bookings record a commitment to buy at product-specific prices or as a lump-sum generic prepay; generic prepay types are set up in A/R setup; prepay-with-interest adds interest when the payment is taken; partial-pay bookings (pay part now, rest later); contract down-payment bookings (percent, per-unit or flat amount, remainder never paid). — [Agvance: Prepay & Bookings](https://helpcenter.agvance.net/home/prepay-bookings)
- Prepay money uses a generic inventory item "Prepaid Product"; a utility updates unpaid booking prices from high/low market price; unapplied cash can be used to prepay a booking; invoices default in booked prices and prepaid dollars; generic prepay applies to invoices automatically per type setup; a generic booking can become product-specific only if not yet invoiced. — [Agvance: Prepay & Bookings](https://helpcenter.agvance.net/home/prepay-bookings)
- Invoices number sequentially per retail location; pricing checks the booking first; delivery/blend/energy tickets import through the same invoicing function; split invoices print a "shared with" section (suppressible); finance charges auto-calc and generate an invoice using an inventory product; paid invoices should not be voided; COD payments cannot be voided or reversed. — [Agvance: Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices)
- Dispatch: SKY Dispatch gives applicators, sales, dispatchers and growers job info via a grower portal. — [Agvance blog](https://agvance.net/post/time-saving-dispatch-technology)

### Inferences
- (inferred) Flow: quote/booking (price lock, prepay) -> order/ticket (delivery/blend/energy) -> invoice (booking price + prepay applied) -> payment/A-R. Invoice is where pricing, prepay relief and posting converge.

### Gaps
- What each step locks or carries forward, and recipe/blend-ticket mechanics, are not documented publicly in anything I could reach. Greenstone Agris blending: nothing found.

## Accounting logic (GL, prepay, rebates, patronage, finance charges)

### Takeaway
Public docs describe mechanics, not journal entries. Public facts: rebate estimates are loaded into product cost; patronage is captured from invoices and grain settlements by category; finance charges post as invoices.

### Cited Findings
- Patronage capture: totals (dollars and quantities) built per patron and category from customer invoices (sales) and grain settlements (purchases) over date ranges; products must belong to departments tied to a patronage category; capture also runs reassignments. — [Agvance: Capturing Patronage Activity](https://helpcenter.agvance.net/home/capturing-patronage-activity)
- Vendor rebates: Agvance guidance is to include an estimated rebate in seed product cost so margins stay reasonable until received. — [Agvance help search results](https://helpcenter.agvance.net/home/updated-articles?start=80) (secondary, from search summary)
- Finance charges generate an invoice and need an inventory product. — [Agvance: Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices)
- Example co-op patronage rate: 3.6% on agronomy purchases (FY2024). — [Innovative Ag Services](https://innovativeag.com/customer/news/2024patronagerates)

### Inferences
- (inferred) Finance charges flowing through the normal invoice path means they hit A/R, revenue and the GL via standard posting, and can be reversed with the same tools.

### Gaps
- GL structure, revenue/COGS/inventory timing, deferred billing, returns/credit memos, GL tie-out, patronage GL/equity posting: not found publicly (the patronage article stops at capture).

## Inventory, screens, praise and complaints

### Takeaway
Little public detail. Cultura lists inventory formulation/blending/manufacturing and container management; Agris is said to track input lots.

### Cited Findings
- Cultura lists inventory container management and formulation/blending/manufacturing. — [AgGateway: Cultura](https://aggateway.atlassian.net/wiki/spaces/APM/pages/69895092/Cultura+Technologies+LLC)
- Agris at Ag Producers Co-op: input lot tracking, role-based access, PO and stock-movement workflow. — [AppsRunTheWorld](https://www.appsruntheworld.com/customers-database/customers/view/ag-producers-co-op-united-states)

### Gaps
- Locations, unit conversions, in-transit, consignment, negative inventory, screen navigation, reviews (TrustRadius page returned 403; I did not bypass it). No credible customer praise/complaint source reached.

## Other ag retail software (separate survey)

### Takeaway
Thin: only partial verification in the limited research budget.

### Cited Findings
- Agvance (SSI): one ERP across accounting, agronomy, energy, grain; Grower360 grower app (balances, prepay, applications); SKY Dispatch with grower portal. Distinctive: growers see the same live ledger-derived data (prepay, unpaid invoices) retailers see. — [Agvance](https://agvance.net/why-agvance); [dispatch](https://agvance.net/post/time-saving-dispatch-technology)
- AgVantage Software: suite for ag retail and co-ops, 35+ years, eAgvantage mobile. — [AgGateway](https://aggateway.atlassian.net/wiki/spaces/APM/pages/69895044/AgVantage+Software)
- Greenstone AGRIS (Cultura): ERP for grain, retail, co-ops; AgroGuide agronomy. — [SourceForge](https://sourceforge.net/software/product/AGRIS)
- TELUS Agriculture: acquired Proagrica (March 2024 per CB Insights) and owns Agrian; Proagrica is data integration/connectivity. — [TELUS](https://www.telus.com/agcg/en/blog-resources/proagrica-joins-telus-agriculture-consumer-goods); [AgroPages](https://news.agropages.com/News/print-49466.htm)
- AgSync: connects sales and operations for retailers; example is rerouting work during weather delays without drivers returning to base. Distinctive for dispatch. — [WinField United](https://winfieldunited.com/news-and-insights/enhance-work-flow-using-agsync)

### Gaps
- Not researched or not found: Ag Data/Merchant Ag, DTN, Bushel (retail features), Greenstone workflow specifics. AgSync ownership/features beyond the above unverified.
