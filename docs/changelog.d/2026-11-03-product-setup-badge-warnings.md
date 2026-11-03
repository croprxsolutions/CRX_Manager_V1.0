## 2026-11-03 — Product setup badge, near-match warnings and rate help (WP-PM-8b)

Screen-only; no database change. A product missing setup now shows an "Incomplete setup" badge on its page, with the fields still needed, and on its list row. The Products list (desktop and phone) gains a setup filter that shows how many products are incomplete. Complete setup means category, form, inventory unit, container size and unit; a registered pesticide (an EPA number, or category Herbicide, Fungicide or Insecticide) also needs EPA number, signal word, REI and PHI. A blank REI/PHI counts as unknown and a saved 0 as set. RUP is a yes/no that always has a value. Incomplete products are flagged, not blocked, so they can still be saved and priced.

Typing a new Vendor or Manufacturer close to an existing name ("Syngnta") warns "This creates a new manufacturer. Did you mean Syngenta?" with a click to use it. Suggested Rate, Rate Per Acre and Max Label Rate each have one line of help, and Max Label Rate shows read-only with a pointer to Label Review. The help text describes today's fields without promising how rates are calculated, so it stays true after the rate rebuild.

The shared table's search box keeps a minimum width so extra filters wrap instead of squeezing it.
