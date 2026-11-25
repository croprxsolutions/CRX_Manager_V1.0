## 2026-11-24 - Manufacturer documents on Product Detail

- Product Detail shows each brand's manufacturer specimen label, safety data sheet and supplemental links, alongside the existing EPA registration link. The product page identifies expired supplemental links without opening them.
- Admins can edit links, view their history and open the reported-link list from Products. Staff can report an individual link from Product Detail.
- The optional Brand Links tab edits specimen and SDS links and adds new supplemental links. Edit existing supplemental links on Product Detail. Blank cells leave current links as they are, and workbooks without the tab use their existing setup and rate import paths.
- Migration `20270307070000_preserve_brand_document_reports` keeps unresolved broken-link reports open when only a supplemental label's state or expiration changes.
