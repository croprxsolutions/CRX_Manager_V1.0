# UI Patterns

Reference for how the CRX Manager frontend is built. Follow these patterns for consistency.

---

## Adding a New Page

Follow `.claude/skills/new-page/SKILL.md` — it is the maintained step-by-step source. In short:

1. **Create the page component** in `src/pages/` as a `default` export (required for lazy loading).
2. **Add the lazy import** in `src/appPages.tsx`, the shared page list:

   ```typescript
   const MyNewPage = lazy(() => import('./pages/MyNewPage'));
   ```

3. **Add one page entry to `APP_PAGES`** in `src/appPages.tsx` (REQUIRED). The router
   (`src/App.tsx`) builds its `createBrowserRouter` routes from it, each behind
   `ProtectedRoute` with the page's roles, and `PAGE_PERMISSIONS` in
   `src/lib/pagePermissions.ts` is derived from it, so never add either by hand. Suspense is
   centralized in `RouteShell` (do not add a per-route `<Suspense>`). Paths are relative, and
   the first route is the page's own address:

   ```tsx
   {
     key: 'my-new-page', label: 'My New Page', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
     routes: [{ path: 'my-new-page', element: <MyNewPage /> }],
   },
   ```

4. **Add the sidebar link** in `src/components/layout/Sidebar.tsx`, in the right role tree
   (`officeNavigation`, `applicatorNavigation`, or `driverNavigation`). Its `path` must be a
   page address from `src/appPages.tsx` (a type error otherwise), and which roles see it comes
   from that page's `roles`.
5. **Re-record the route baseline** (`UPDATE_ROUTE_BASELINE=1 npx vitest run src/routeBaseline.test.tsx`)
   and check that the diff of `src/routeBaseline.json` shows only the new page's own rows (routes,
   sidebar link, permission entry), and nothing about any other page.
6. **Document it** in `docs/reference/pages-routes.md`, then open the page and verify it.

---

## Existing Pages

Before creating a new page, check that it doesn't already exist: `docs/reference/pages-routes.md`
lists every route and page, and `src/pages/` is the ground truth.

---

## Data Fetching Pattern

CRX Manager uses `useState` + `useEffect` for data fetching (not React Query or SWR).

### Reading data
```typescript
const [customers, setCustomers] = useState<Customer[]>([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  async function loadCustomers() {
    // Name the columns you need; avoid select('*') + `as` casts (untyped DB access).
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name, assigned_tier')
      .eq('is_active', true) // customers are deactivated with is_active = false; there is no deleted_at column
      .order('farm_name');

    if (error) {
      // Lint forbids console.error; report through Sentry (src/lib/sentry) and a toast.
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_customers' } });
      toast('error', 'Failed to load customers');
    } else {
      setCustomers(data || []);
    }
    setLoading(false);
  }
  loadCustomers();
}, []);
```

### Choosing a record (pickers)
A list read stops at 1,000 rows (the PostgREST cap), so never fill a picker from a one-shot list read.
- **One record to choose:** use a database search box. `CustomerSearchPicker`
  (`src/components/customers/`), `FieldSearchPicker` (`src/components/fields/`), `ProductSearchPicker`
  (`src/components/products/`), `OrderSearchPicker` (`src/components/orders/`), `JobSearchPicker`
  (`src/components/jobs/`) or `PurchaseOrderSearchPicker` (`src/components/purchase-orders/`), all built on
  `src/components/ui/RecordSearchPicker.tsx`.
  - Pass the old list's status filter (`statuses`). Order and job searches also match the customer's name.
  - Label a record read by id with `src/lib/recordLabels.ts`, so it reads the same as a pick.
  - Where the save requires a record of the page's customer (a blend ticket's job), pass `customerId`.
  - The page keeps the chosen id and its label. It does not look the record up in a loaded list.
  - Pass `select` with any extra columns the page needs from the pick, e.g. `assigned_tier` for pricing.
  - A saved record's label comes from the record's own join or a by-id read. A failed or missing by-id read
    blocks pricing and saving; it never falls back to a default. A read used only for a label (the saved id
    is sent unchanged) may show a "could not be loaded" label instead.
  - Records not to offer go in `excludeIds`, which filters in the database.
  - Keep the old list's active rule: `activeOnly={false}` where inactive customers were offered.
  - When a field picker's `customerId` changes, clear a chosen field that belongs to another customer.
- **The page uses the whole list** (tier pricing, a catalog modal with local search, names on printed
  sheets): read it completely with `fetchAllRows` (`src/lib/pagedRead.ts`). On failure, clear the list,
  show an error, and disable the actions that depend on it.
- For a new kind of record, add a thin wrapper beside the existing ones. Quote search text with
  `ilikeOrPattern` (`src/lib/recordSearch.ts`) so commas, brackets, `%` and `_` stay literal.

### Writing data (always use checkMutationResult)
```typescript
async function updateCustomer(id: string, updates: Partial<Customer>) {
  const result = await supabase
    .from('customers')
    .update(updates)
    .eq('id', id)
    .select();

  checkMutationResult(result, 'Update customer');

  // Log the activity (object param — NOT positional args)
  await logActivity({
    event: 'customer_updated',
    description: `Updated ${updates.farm_name}`,
    performedBy: currentUser.id,
    entityType: 'customer',
    entityId: id
  });
}
```

---

## Bulk Import Pattern (3-State Modal)

Used for importing data from CSV files. The pattern has 3 states:

### State 1: File Selection
- User selects a CSV file
- File is read client-side using `FileReader`

### State 2: Validation & Review
- Parse CSV rows
- Validate each row against business rules
- Show a preview table with valid/invalid indicators
- User can fix issues or proceed

### State 3: Results
- Process valid rows (insert into database)
- Show success/failure counts
- Display any errors

### Source files (examples)
- `src/components/products/BulkProductImport.tsx`
- `src/components/customers/BulkCustomerImport.tsx`

### Modal sizing
Use `size="large"` prop on the Modal component for bulk imports.

---

## Bulk Operations Pattern (Row Selection)

For pages with bulk actions (select rows -> perform action):

### Components used
1. `useRowSelection` hook — manages selected row IDs
2. `createCheckboxColumn` — adds a checkbox column to the table
3. `BulkActionBar` — shows action buttons, auto-hides when 0 selected
4. `BulkDeleteConfirmModal` — confirmation dialog for destructive bulk actions

### Smart export fallback
```typescript
// Exports selected rows if any are selected, otherwise exports all filtered rows
const rows = selected.size > 0 ? selectedRows : filtered;
```

### Pages using this pattern
Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets, Orders, Vehicles, Fields, Returns, ApplicationServices, plus the Receiving hub's `ReceivingLogPanel` and `JobMassEditModal` (check `grep -rl useRowSelection src` for the current list)

### Exceptions
- **Invoices and Deliveries** use hand-rolled `Set<string>` selection (pre-existing pattern, kept for stability)
- **InventoryPage** uses `EditableDataTable` (inline editing) — no checkbox column

---

## Styling Rules

### Tailwind CSS only
- No other CSS frameworks (no Bootstrap, no styled-components, no CSS modules)
- All styling uses Tailwind utility classes
- Tailwind 4 (since 2026-10-03). There is no `tailwind.config.js`: theme tokens (brand colours, fonts, `shadow-card`) live in the `@theme` block of `src/index.css`.
- `src/index.css` pins several names to their **Tailwind 3** meaning so the app looked the same after the upgrade: the standard palette uses Tailwind 3's hex values; `shadow-sm`, `shadow`, `rounded-sm`, `rounded`, `blur-sm`, `blur`, `drop-shadow-sm` and `drop-shadow` keep their 3.x sizes; bare `ring` is 3px blue-500/50; borders default to gray-200; hover styles apply on touch devices too; `space-x/y-*` and `divide-*` put the gap or rule before every visible child after the first (Tailwind 3's rule), so a hidden or `display: contents` last child leaves no stray gap. Tailwind 4's documentation describes those names differently — follow the existing pages, not the docs, for these.
- Use `shrink-0`/`grow`, `outline-hidden` (hides the outline but keeps it in high-contrast mode) and opacity modifiers such as `bg-black/50`; the old `flex-shrink-0`, `bg-opacity-*` spellings no longer exist, and `outline-none` now removes the outline outright. Existing `outline-none` uses were left as they are; a forced-colors rule at the end of `src/index.css` keeps their keyboard focus visible in Windows high-contrast mode.
- Arbitrary values use `_` for spaces: `grid-cols-[1fr_100px_100px]`. Tailwind 4 copies commas through literally, so `grid-cols-[1fr,100px,100px]` becomes invalid CSS and is silently dropped.
- Stacked variants read left to right: `file:hover:` styles the file button when the button is hovered; `hover:file:` styles it whenever the whole input is hovered.

### Brand color
- Primary green: `crx-green` (#1A7A50; hover `crx-green-hover` #166340). Deepened from #28A26A on 2026-11-02 (Mason's choice) so white button text and green text on cream pass the 4.5:1 contrast minimum.
- On dark backgrounds (sidebar, Dispatch Board, the style D phone header, the sign-in pages' dark panel), green text, icons, markers, borders and focus rings use `crx-green-on-dark` (#28A26A, the original green); the deep green is too dark to read there. Green buttons with white text stay `bg-crx-green` everywhere.
- Use `bg-crx-green`, `text-crx-green`, `border-crx-green`, etc. Never use Tailwind's stock `green-*` / `emerald-*` for brand meaning; those are only for "success" status colours.
- Name colours by token, never by hex code. Hex codes belong only in `src/index.css` (`@theme`) and `src/lib/pdfTheme.ts` (PDFs). Map libraries that need a literal colour are the one exception: field outlines sit on dark satellite imagery, so they use the on-dark green (#28A26A); keep them in step with that token.
- The full brand rulebook (colours, type, spacing, components) is `DESIGN.md` at the repository root.

### Icons: Lucide React only
```typescript
import { Plus, Edit, Trash2, Search } from 'lucide-react';
```
- Do NOT install other icon packages (no Heroicons, no FontAwesome, no Material Icons)

### Common UI patterns
- Tables: use the shared DataTable/table components
- Modals: use the shared Modal component
- Forms: standard controlled inputs with `useState`
- Loading states: show a spinner or skeleton while `loading === true`
- Error states: show error message in red text
- A list whose read failed: show `LoadFailedState` (from `src/components/ui/EmptyState.tsx`, with Try again), or pass `loadError` and `onRetry` to `DataTable`/`EditableDataTable`. Never let a failed read fall through to the empty "No … found" message.

---

## Component Organization

```
src/
  components/
    ui/           # Shared UI components (Modal, DataTable, BulkActionBar, etc.)
    auth/         # Login, forgot/reset password, role landing, auth guards
    layout/       # AppLayout, sidebar, header
    reports/      # ReportShell, LogbookReport
    deliveries/   # Delivery-specific components
    blendtickets/ # Blend ticket components
    customers/    # Customer-specific components (BulkCustomerImport, etc.)
    products/     # Product-specific components (BulkProductImport, etc.)
    ...           # Other domain folders as needed
  pages/          # Full page components (one per route)
  lib/            # Utility functions (db.ts, activityLogger.ts, idempotency.ts, PDF generators)
  hooks/          # Custom React hooks (useRowSelection, useRealtimeSubscription)
  contexts/       # React contexts (AuthContext, BelowCostApprovalContext)
  types/          # TypeScript interfaces (index.ts)
```

---

## Number Formats

| Entity | Format | Generated by |
|--------|--------|-------------|
| Invoice | `<PREFIX>-YYYY-NNNN` — `CS` chemical sale, `MC` misc charge, `CM` credit memo, `INV` field application and other types | `next_invoice_number(p_invoice_type)`, called inside the invoice-creating RPCs |
| Quote | `Q-YYYY-NNNN` | `generate_quote_number()` RPC — `QuoteBuilder.tsx` calls it and passes the number to `save_quote` in the quote payload |
| Order | `ORD-YYYY-NNNN` | `generate_order_number()` — called inside the order-creating RPCs (for example quote conversion, quote draw-down and quick delivery); `BlendTicketDetail.tsx` calls the RPC itself and passes the editable number in as `p_order_number` |
| Return | `RMA-YYYY-NNNN` | `next_return_number()`, called inside the `create_return` RPC |
| Rebate claim | `RC-YYYY-NNNN` | Per-year counter row inside the `create_rebate_claim()` RPC |
| Cycle count | `CC-YYYY-NNNNN` (5 digits) | `next_cycle_count_number()` RPC |
| PO | `PO-YYYY-NNNN` | `next_po_number()` RPC |
| Job | `JOB-YYYY-NNNN` | `next_job_number()` RPC |
| Application record | `APP-YYYY-NNNN` | `next_application_record_number()` RPC |
| Commission payment | `CP-YYYY-NNNN` | `next_commission_payment_number()` RPC |
| Delivery | `DEL-NNNNN` (no year, 5 digits) | `next_delivery_number()` RPC |

---

## PDF Generation

All PDF generation is client-side using `jspdf` and `jspdf-autotable`:

| PDF | Source file | Notes |
|-----|-----------|-------|
| Invoice | `src/lib/invoicePdf.ts` | 3 layouts |
| Statement | `src/lib/statementPdf.ts` | Dual-mode |
| Year-end summary | `src/lib/yearEndSummaryPdf.ts` | |
| Delivery | `src/lib/deliveryPdf.ts` | Batch support, partial delivery highlighting |
| Receiving | `src/lib/receivingPdf.ts` | CRX green header, condition color-coding |

---

## Realtime Subscriptions

For tables that need live updates:

```typescript
useRealtimeSubscription({
  table: 'team_notes',
  event: '*',
  filter: undefined,
  onInsert: (payload) => { /* handle new row */ },
  onUpdate: (payload) => { /* handle changed row */ },
  onDelete: (payload) => { /* handle removed row */ },
});
```

Currently used for: `team_notes`, `team_note_comments`, `notifications`, `note_activity_log`

---

## Page Layout

Rules for new pages and for any page a screen-cleanup PR touches. Existing pages that break them are not wrong to leave alone; fix them one screen at a time, with Mason's approval of the change list.

### Page header
- Every office page opens with `PageHeader` (`src/components/ui/PageHeader.tsx`): a title, an optional `crx-green` accent word, a one-line subtitle, and the page's actions on the right.
- At most one primary (green) button per header, and it sits rightmost. Other actions are secondary or ghost buttons.
- Detail pages (one quote, one customer) put `Breadcrumbs` above the header so the way back is obvious.
- Below 768px the actions wrap under the title; don't hide them.
- Page sections stack with `space-y-6`; content inside a card with `space-y-4`.

### Tabs or sections?
- **Shared `Tabs` component** (`src/components/ui/Tabs.tsx`, state in `?tab=`): for alternative views of the same subject where people work in one at a time (Open / Paid / Voided invoices). Labels are short nouns; add a count when it helps triage. Six tabs at most.
- **`WorkspaceTabs` link bar** (`src/components/layout/WorkspaceTabs.tsx`): only to join sibling pages that keep their own addresses (Billing, Products, Insights).
- **Stacked sections** (one `Card` with a `CardHeader` per section): when people need to see the groups together, or there are four or fewer short groups. This is the default for editing: Mason prefers one well-organised screen to more tabs or sub-pages (decided 2026-11-02). A long page adds a `SectionJumpBar` (below) rather than splitting into tabs.
- Never hand-roll tab buttons; use `Tabs`. Some pages still do (Compliance, Rebates, A/R Aging, Job Detail, Team Board, Call Lists); move them to `Tabs` when those screens are worked on.
- Never put a second tab row inside a tab. Use a filter or a select for the second level.
- Never split one form's required fields across tabs; people miss the hidden ones.
- When a tab replaces an old standalone page, keep the old address as a redirect (`LegacyTabRedirect`).

### Settings-style pages
- One `PageHeader`, then one `Card` per topic, each with a `CardHeader` title and a one-line description of what the settings affect.
- Each card saves its own fields with its own Save button, which stays disabled until something changes. Don't mix one page-level Save with card-level saves.
- More than five cards: keep them on one page, grouped by topic (for example Company, Users, Billing, Field jobs), with a `SectionJumpBar` under the header. Don't split them into tabs or sub-pages. This replaces the old "use `Tabs`" rule (Mason, 2026-11-02).
- Destructive actions (deactivate a user, reset a password) sit at the end of their card as a `danger` or secondary button and always go through `ConfirmModal`.
- On phones, cards stack full width and every control keeps the 44px tap target (`.phone-touch`).

### Buttons: the › arrow
- The › arrow (`showChevron`) means "this takes you somewhere": another page, or the next step of a wizard or a multi-step flow ("Next: signature", "View Orders").
- Buttons that act where you are never show it: Save, Record payment, Delete, Confirm, or opening a modal.
- "New …" and "Add …" buttons carry a + icon and no arrow, even when they open a new-record page. "Back to …" uses a left arrow, not ›.
- `Button` shows no arrow unless you pass `showChevron`. Hand-built buttons follow the same rule.

### Count bubbles
- A count beside a tab or jump pill is a small round bubble. On the selected tab or pill it is solid `crx-green` with white text (or white with green text when the pill itself is solid green). On the others it is gray-100 with gray-600 text.

### Form errors and placeholders
- Error text and the required asterisk are `red-600`, and an input in error has a `red-500` border. Placeholders are `gray-500`, never lighter (gray-400 fails contrast on white). Keyboard focus shows a full-strength `crx-green` ring. An element with no focus classes of its own gets a 2px `crx-green` outline from `src/index.css` (`crx-green-on-dark` inside the dark backgrounds listed there), never the browser's default.

---

## Controls and feedback

The rules for screens built or redesigned with the kit in `src/components/ui/`. Colours, tokens and the full component list are in `DESIGN.md`. Behaviour is fixed: UI work never changes what a button does, what is saved or when, permissions, totals or rounding.

### Choice lists and dates
- Use `Dropdown` and never a browser `<select>` on any redesigned screen. `size="sm"` is 36px, for dense desktop use only and never on phone screens. It calls `onChange(value)` with the value, not a native change event. The old `Select.tsx` stays for now because its callers read native change events; each screen moves over in its own module round.
- Use `DatePicker` and never `<input type="date">`. Values are plain `'YYYY-MM-DD'` strings (or null) with no JS `Date`. The field shows typeable numeric segments (for example 9/30/2027). Presets such as "Season end" appear as chips in the calendar and as a pill in the field when the value matches.
- Every field keeps a fixed helper line for help, a warning or an error, so nothing below it moves when a message appears.
- Touch targets are 44px below 768px and 40px above (`h-11 md:h-10` and similar). Everything is reachable by keyboard with a visible focus ring.
- There are no field-border or danger tokens in `src/index.css`. Use `border-gray-300` and `red-600` / `red-700`, as `Input.tsx` does. When a state changes a colour, choose the class conditionally (`cond ? 'a' : 'b'`) instead of stacking two colour classes: Tailwind's CSS order decides which wins.

### Actions and menus
- One green button per screen: the next step for the record's status. At most two or three secondary buttons. The rest go in `ActionMenu` (the ⋯ "More actions" menu).
- In `ActionMenu`, danger items go last, after a divider, in red. A disabled item shows its reason as a description (`disabledReason`).
- Header: title, status badge and save status on the left, actions on the right, wrapping cleanly. On a phone the actions move to a sticky bottom bar (primary and secondary) and the ⋯ menu goes in the top bar.

### Help
- `HelpTip` is an info button labelled "More info" that opens on press. Never put it inside another button, link or clickable header. Place it beside the control. For a sortable `DataTable` column, use the column's `headerExtra`.
- No explanatory paragraphs on the page. One short line under a field is fine.

### Status badges
- `Badge` capitalises its label by default. Pass `normalCase` when the label is already written as it should appear ("Closed short").
- Status labels on redesigned screens are "Closed short" and "Fulfilled", not "Closed — Short" or "Fulfilled (Applied)". Stored status values do not change.
- A badge is a soft pill with a word, never colour alone, and never brand green. The status dot arrives with the quote screens (PR 2).

### Confirming, saving and results
- Confirm before costly actions (removing a line with data, declining, cancelling, closing a booking, deleting) with `ConfirmModal`. The title is a question, the message says what changes in numbers, and the button repeats the action ("Remove line", never "OK").
- Every server action shows progress (spinner and "Saving…" on the button) and then a toast that says what happened, including "nothing changed".
- Auto-save screens keep auto-saving and show a status next to the title: "Saving…", "All changes saved · 2:41 pm", "Couldn't save. Retry". Screens with a Save button show "Unsaved changes" until saved.

### Empty, loading, numbers, copy
- Empty state: `EmptyState` with a Lucide icon in a soft green circle, one bold line, one helpful line and the next action. Inline empties ("First time for this customer") use a small muted icon and text.
- Loading: skeleton rows shaped like the content, never a lone spinner in the middle of a page.
- Numbers: Inter with tabular figures, right-aligned in tables. No monospace for money.
- Copy: plain American English, no em dashes, no internal codes.

### Filters, tables, headings, PDFs, checks
- Filters: search, dropdowns and toggle chips. An active chip is green-tinted with a check, never amber. "Clear" appears only when something is filtered, in a reserved spot.
- Tables: priority columns stay at 1024px and wider; below 768px rows become cards. The page never scrolls sideways.
- Headings: the two-tone accent word is for the page title only, not every card title.
- PDFs follow the layout the owner knows from the old billing software: company block left, logo centred with the document name, document details right, a bill-to block where a window envelope shows it, plain grey table headers, totals right, terms and page number in the footer. No full-width colour banners.
- Check at 360, 390, 768, 1024, 1280, 1366, 1440 and 1920px before calling a screen done.

---

## Style D: Compact and Bold

The app-wide look Mason chose on 2026-11-02. It joins packed, label-left rows with bold headings and section icons. Every new screen follows it, and every screen rebuilt in the look-and-feel program moves to it. The mockups (Settings on desktop, a field stop on a phone) are reference pictures, not code. Name every colour by its token; the hex codes below are only there so you can match the mockups.

### Desktop
- **Page title:** a large Barlow Semi Condensed heading (`font-heading`, about 2.25rem, bold) with the light `crx-green` accent word, and one short line under it saying what the page affects.
- **Section bands:** each section (a `Card`) opens with a header band on `cream-dark` (#f0ede6). It holds a 36px square `crx-green` icon tile with a white Lucide icon, a bold Barlow heading (about 1.5rem), and the section's main action on the right.
- **Sub-parts:** a section may hold several sub-parts. Each starts with a Barlow sub-heading (about 1.125rem, semibold) on a hairline divider, with its own Save on the right.
- **Rows:** the label sits on the left in a column about 220px wide, and the field or fields sit beside it. Rows are about 36px tall, with inputs and buttons about 36px high, separated by gray-100 dividers. Below about 640px the label stacks above the field.
- **Saving:** each sub-part saves its own fields. Its Save button stays disabled (gray) until something in that sub-part changes, and a changed sub-part shows an amber "Unsaved" chip by its heading. Warn before leaving a page with unsaved changes. There is never one page-level Save.
- **Jump bar:** a page with more than about three sections gets a sticky `SectionJumpBar` of round pills, one per section. The active pill is solid `crx-green` with white text, and its count bubble is white with green text.
- **People lists:** each name starts with a round dark initials avatar (`nav-dark`, #2e2e2e, with white initials).

### Phone
- **Header:** a dark `nav-dark` (#2e2e2e) band with a back arrow (44px target), the record number in small light-gray text, and a large white Barlow title (about 2rem). A step-by-step flow shows labelled steps under it: a short bar plus a label per step. Done and current steps are `crx-green-on-dark` (#28a26a); later steps are gray. The current step's label is white and bold.
- **Lists:** one white rounded list with gray-100 dividers, not a stack of separate cards. A row that needs attention (short, over, failed) gets an `amber-50` (#fffbeb) fill, a 4px amber-500 left edge, and amber-800 detail text.
- **Quantities:** 48px − and + buttons on `crx-green-light` (#e8f5ee) with a green symbol, around a large bold Barlow number (about 1.75rem) that can also be typed.
- **Main action:** one full-width 56px `crx-green` button pinned to the bottom of the screen, in bold Barlow text. It carries the › arrow only when it moves to the next step.
- **Tap targets:** every control is at least 44px. Wrap phone-edited screens in `.phone-touch`.

### Shared pieces
- `SectionJumpBar` (`src/components/ui/SectionJumpBar.tsx`): the sticky jump pills. Pass `sections` (`id`, `label`, optional `count`). Give each section element the matching `id`. The bar marks the section in view as active.
- Section bands, the label-left row, the phone header and the quantity stepper are built in the screen rebuilds that first need them; move each into `src/components/ui/` the second time it is needed. The section band, sub-part heading with its Save and "Unsaved" chip, and label-left row first live in `src/pages/SettingsPage.tsx` (`SettingsSection`, `SubPart`, `Row`).
- Shared since the field crew screens (Field dashboard, Field stop, Field view): `SectionCard` (`src/components/ui/SectionCard.tsx`, the section band) and `PhoneHeader` (`src/components/ui/PhoneHeader.tsx`, the dark phone header with labelled steps). Use them for new screens; Settings still has its own copy of the band. The quantity stepper and the pinned 56px main button live in `src/pages/FieldStop.tsx` (`MainAction`); move them the second time they are needed. The pinned button sits `3.5rem` above the bottom of the screen on phones so it clears the bottom navigation. `SignatureCanvas` is still a fixed 400px wide and runs past a 375px phone; making it fluid changes the saved signature image's shape (and how the delivery PDF prints it), so it needs its own change with a PDF check.
- Phone lists, shared since the office everyday screens (Invoices, Customer detail, Office Cockpit). Pick one; never leave a list scrolling sideways on a phone:
  - `DataTable` `mobileRow`: pass a row renderer and, below 768px, the table becomes one white rounded list with a "Sort by" select in place of the hidden column headers. Only one layout renders at a time, so tests and long lists see the table unless the screen is phone-width. Example: `src/pages/Invoices.tsx`.
  - `.phone-stack` (`src/index.css`) for a hand-built `<table>`: add the class to the table and `data-label` to every cell after the first. Below 768px each row becomes one entry, the first cell its bold title and each other cell a label-left line; the headings stay readable to screen readers. Example: `src/pages/CustomerDetail.tsx`.
- `PageHeader` `large` gives the Style D page title (about 2.25rem, bold).
- A sub-part's Save turns on when one of its values differs from what was loaded or last saved; `SettingsPage.tsx` keeps one map of saved values and compares each sub-part's keys against it.
