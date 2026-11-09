---
name: CRX Manager
description: Crop RX Solutions' operations app for quotes, orders, deliveries, invoices, inventory and spray-field jobs. Light theme only.
colors:
  crx-green: "#1a7a50"
  crx-green-hover: "#166340"
  crx-green-on-dark: "#28a26a"
  crx-green-light: "#e8f5ee"
  crx-green-tint: "#f0faf5"
  nav-dark: "#2e2e2e"
  nav-dark-hover: "#3a3a3a"
  secondary: "#4e4e4e"
  cream: "#f9f7f2"
  cream-dark: "#f0ede6"
  white: "#ffffff"
  border-gray: "#e5e7eb"
  field-border: "#d1d5db" # descriptive alias, not a src/index.css token; use border-gray-300
  danger: "#dc2626" # descriptive alias, not a src/index.css token; use red-600
  danger-hover: "#b91c1c" # descriptive alias, not a src/index.css token; use red-700
typography:
  page-title:
    fontFamily: "Barlow Semi Condensed, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
  section-title:
    fontFamily: "Barlow Semi Condensed, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.2
  accent-word:
    fontFamily: "Barlow Semi Condensed, sans-serif"
    fontWeight: 300
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  badge:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  lg: "0.5rem"
  xl: "0.75rem"
  full: "9999px"
spacing:
  page-phone: "1rem"
  page-desktop: "1.5rem"
  card: "1.25rem"
  tap-target: "2.75rem"
components:
  button-primary:
    backgroundColor: "{colors.crx-green}"
    textColor: "{colors.white}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.crx-green-hover}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.nav-dark}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
  button-ghost:
    textColor: "{colors.secondary}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.white}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
  card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.xl}"
    padding: "{spacing.card}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.nav-dark}"
    rounded: "{rounded.lg}"
    padding: "0.625rem 0.75rem"
  tab-active:
    textColor: "{colors.crx-green}"
    typography: "{typography.label}"
  tab-count-active:
    backgroundColor: "{colors.crx-green-light}"
    textColor: "{colors.crx-green}"
    rounded: "{rounded.full}"
  workspace-tab-active:
    backgroundColor: "{colors.crx-green}"
    textColor: "{colors.white}"
    rounded: "{rounded.full}"
  sidebar:
    backgroundColor: "{colors.nav-dark}"
    width: "16rem"
---

# Design System: CRX Manager

Recorded from the shipped code on 2026-11-02. Token sources: the `@theme` block in `src/index.css` (Tailwind 4; there is no `tailwind.config.js`) and `src/lib/pdfTheme.ts` for PDFs. Fonts load from Google Fonts in `index.html`. If this file and those sources disagree, the code wins and this file is stale.

## Overview

**Creative North Star: "The Farm Office Ledger"**

CRX Manager is an operations tool, not a showcase. Office staff work in it all day on desktop; drivers and applicators use it on phones in trucks and fields. Every screen favours scanability and consistency over expression: a warm cream page, white cards with hairline borders, one deep brand green that marks action and the current place, and a condensed heading face that keeps titles compact.

The brand is fixed. In November 2026 the owner approved deepening the green for readability (from #28A26A to the current crx-green) while keeping everything else. New screens extend this system; they never restyle it. Any visual change beyond what a task needs requires the owner's approval (but see the 2026-11-07 note below: free rein on UI work if behaviour does not change).

Owner, 2026-11-07: free rein on UI work; behaviour must not change.

**Key Characteristics:**
- Light theme only: cream page, white surfaces, near-black text.
- One brand green, used for primary actions, active navigation and the heading accent word.
- Status is shown with soft, pill-shaped badges in stock Tailwind hues, never in the brand green.
- Dark charcoal sidebar on desktop; a bottom navigation bar on phones.
- Lucide line icons only.

## Colors

A warm neutral base carrying a single deep green.

### Primary
- **CRX Field Green** (crx-green): the only brand colour. Primary buttons, active tab underline and text, active workspace pill, the sidebar's active marker, focus rings (at 20-30% opacity) and the light accent word in headings. White text on it reads at 5.33:1; it reads at 4.97:1 on the cream page.
- **Field Green Deep** (crx-green-hover): hover and pressed state of green surfaces only.
- **Field Green Bright** (crx-green-on-dark, #28A26A, the original brand green): green text, icons, markers, borders and focus rings that sit on a dark surface (the sidebar, the dark dispatch screens, the dark header band of the style D phone screens such as the field and driver screens, the dark panel of the sign-in pages). It reads at 4.2:1 on Charcoal and 4.5-6.2:1 on the slate and gray dark screens, where crx-green would fall to 2.5-3.4:1. On Charcoal, or on a green-tinted dark fill, it clears the 3:1 bar for icons, markers and large or bold text but not 4.5:1 for small text; small labels there stay white or light gray. Green buttons with white text stay crx-green even on dark screens.
- **Green Wash** (crx-green-light): background behind green text, such as the active tab's count bubble (4.75:1).
- **Green Mist** (crx-green-tint): faint selected-row or highlighted-panel wash.

### Neutral
- **Harvest Cream** (cream): the page background behind everything, including the top bar and phone bottom nav (translucent with blur).
- **Cream Shadow** (cream-dark): table header rows (at 50%), the workspace link bar's bottom border and hover fill.
- **Charcoal** (nav-dark): primary text colour and the desktop sidebar background. Despite the name, it is the body text colour app-wide.
- **Charcoal Lift** (nav-dark-hover): sidebar hover surface.
- **Slate Ink** (secondary): secondary text, labels, inactive tabs, ghost buttons.
- **Hairline** (border-gray): default border on every element (pinned Tailwind 3 gray-200), card and table borders.
- **Field Edge** (gray-300): input and secondary-button borders. There is no `field-border` token in `src/index.css`; use `border-gray-300`, as `Input.tsx` does.

### Status (Tailwind stock, not brand)
Badges and toasts use fixed Tailwind 3 pairs: emerald for success/paid/completed, amber for warning/pending, red for error/overdue/voided, blue for info/sent/scheduled, orange for expired, gray for draft/default. Badges are `100` fill, `800` text and a `200` inset ring; toasts are a white card with a gray hairline border and a 24px round icon chip (success emerald-50 fill with an emerald-700 icon, error red-50/red-700, info sky-50/sky-800, warning amber-50/amber-800). Map statuses through `statusToBadgeVariant` in `src/components/ui/Badge.tsx`, using status values from `.claude/schema-registry.json`.
- **Danger Red** (red-600, hover red-700): destructive buttons, error text and danger menu items (red-700 text in `ActionMenu`). There is no `danger` token in `src/index.css`; use `red-600` / `red-700` as `Input.tsx` does.

### Named Rules
**The One Green Rule.** The brand green is the crx-green token family and nothing else. Never use raw Tailwind `green-*` or `emerald-*` classes to mean "brand" or "primary". Emerald is reserved for the success status colour.

**The Named Token Rule.** Colours come from named tokens. Raw hex values appear only in `src/index.css` and `src/lib/pdfTheme.ts` (plus the pre-render loading screen in `index.html`). PDFs use `CRX_GREEN` from `pdfTheme.ts`, which mirrors crx-green.

**The Dark Surface Rule.** On a dark background, green text, icons and markers use crx-green-on-dark; green fills behind white text stay crx-green. Never put crx-green text on a dark surface.

**The Status Is Not Brand Rule.** A green badge means "done/paid/success", never "this is CRX". Keep status colours on the Badge map so a status looks the same on every screen.

## Typography

**Display Font:** Barlow Semi Condensed (weights 400-700; fallback sans-serif). Every `h1`-`h6` uses it at line-height 1.2.
**Body Font:** Inter (weights 300-700; fallback system-ui, sans-serif), line-height 1.5.

**Character:** a condensed, slightly agricultural-industrial heading face over a neutral, highly legible UI sans. Headings stay compact so long record names fit; body text stays plain.

### Hierarchy
- **Page title** (Barlow 600, 1.5rem): one per page through `PageHeader`; the phone top bar uses 1.125rem rising to 1.25rem on desktop.
- **Section title** (Barlow 600, 1.125rem): card headers (`CardHeader`) and modal titles (`text-xl`, `md:text-2xl`).
- **Accent word** (Barlow 300, crx-green): the second half of a split heading.
- **Body** (Inter 400, 0.875rem): almost all UI text, tables included.
- **Label** (Inter 500, 0.875rem, Slate Ink): form labels, tabs, buttons.
- **Badge / small** (Inter 500, 0.75rem): badges, helper and error text.

The root font size steps up on very large screens (17px at 1920px, 18px at 2560px, 20px at 3200px) in percentages, so a user's own browser font setting is respected.

### Named Rules
**The Split Heading Rule.** Titles may pair a Charcoal semibold word with a light crx-green accent word ("Customer **Detail**"), through `PageHeader`, `SplitHeading`, `CardHeader` or `Modal`'s `accent` prop, all of which use the `.split-heading-accent` class. Use the prop; don't hand-style the accent.

## Layout

- **Desktop shell:** a fixed charcoal sidebar (16rem, collapsible to 4rem) on the left; a sticky translucent cream top bar (3.5rem phone, 4rem desktop) holding the page title; content on the cream page with 1rem padding, 1.5rem from 1024px.
- **Phones (below 768px / 48rem):** the sidebar becomes a slide-in drawer opened from the top bar's menu button, and `MobileBottomNav` is fixed to the bottom with safe-area padding. Page content reserves 4.5rem plus the safe area at the bottom; toasts sit above the bottom nav.
- **Phone touch rule:** wrap phone-edited screens in `.phone-touch`. Below 48rem it gives buttons, links and checkbox labels a 44px (2.75rem) minimum tap target and gives inputs 16px text so iPhones don't zoom.
- **Modals** are full-screen on phones and centred panels (max 32rem, 42rem or 56rem wide; 90vh tall) from 768px.
- **Density:** cards pad 1.25rem; table cells pad 0.75rem by 1rem; gaps are mostly 0.5rem-1rem. This is a dense working app; keep it that way.

## Elevation & Depth

Mostly flat, with soft ambient shadows that separate white surfaces from the cream page. Depth means "this sits above the page", never decoration.

### Shadow Vocabulary
- **Card** (`shadow-card`): resting cards.
- **Card hover** (`shadow-card-hover`): only on cards that are clickable (`Card hover`).
- **Small** (`shadow-sm`, pinned to Tailwind 3): filled buttons.
- **Large / extra large** (`shadow-lg`, `shadow-xl`): toasts and modal panels, over a `bg-black/50` backdrop with no blur.

## Shapes

Gently rounded, never sharp and never bubbly. Buttons, inputs and icon buttons use 0.5rem corners; cards and toasts use 0.75rem (`rounded-xl`); desktop modals use 1rem (`rounded-2xl`); badges, count bubbles and workspace link pills are fully round. Borders are 1px hairlines.

## Components

All shared pieces live in `src/components/ui/` and `src/components/layout/`. Use them before writing new markup.

### Buttons (`Button`)
- **Variants:** primary (crx-green, white text, small shadow), secondary (white with a gray border), ghost (text only, gray hover fill), danger (red-600). Sizes sm, md (default) and lg.
- **States:** colour transitions over 150ms; disabled is 50% opacity; `loading` swaps the icon for a spinner. Pass `showChevron` only on a button that goes to another page or the next step; Save and other in-place actions never show the › arrow.

### Status badges (`Badge`)
Fully round pills, 0.75rem medium text. Pick the variant via `statusToBadgeVariant`; never colour a status ad hoc. A badge is a soft pill with a word, never colour alone; the status dot arrives with the quote screens (PR 2). Labels are capitalised by default; pass `normalCase` when the label is already written as it should appear ("Closed short"). On redesigned screens the labels are "Closed short" and "Fulfilled", not "Closed — Short" or "Fulfilled (Applied)"; the stored status values do not change.

### Cards (`Card`, `CardHeader`)
White, 0.75rem corners, hairline border, card shadow, 1.25rem padding (turn off with `padding={false}` for tables). `CardHeader` gives a section title with an optional accent word and a right-aligned action.

### Inputs (`Input`, `Select`, `Combobox`, `SearchableSelect`)
On redesigned screens, choice lists use `Dropdown` and dates use `DatePicker` (below); the old `Select` stays for now because its callers read native change events, and each screen moves over in its own module round. White, 1px Field Edge border, 0.5rem corners, Slate Ink label above. Focus: crx-green border plus a 2px crx-green ring at 20%. Error: red-500 border and red-600 helper text. Required fields show a red-600 asterisk. Placeholders are gray-500. Each field keeps a fixed helper line (`min-h-5`) for help, a warning or an error, so nothing below it moves when a message appears. When a state changes a colour, choose the class conditionally (`cond ? 'a' : 'b'`) instead of stacking two colour classes: Tailwind's CSS order, not the order in the string, decides which one wins.

### Dropdown (`Dropdown`)
The one choice list, built on React Aria Components. Props: `value` (string or null), `onChange(value)`, `options` (`{ value, label, description?, disabled? }`), `label` or `aria-label`, `placeholder`, `helper`, `error`, `disabled`, `size` (`md` default, `sm`). It gives an `onChange` with the value, not a native change event. Use it on any redesigned screen; never a browser `<select>`. The trigger is 44px below 768px and 40px above (`h-11 md:h-10`). `size="sm"` is 36px and for dense desktop use only, never on phone screens.

### Date picker (`DatePicker`)
The one date field. `value` and `onChange` are plain `'YYYY-MM-DD'` strings (or null), with no JS `Date`; "today" is Chicago time. The field shows React Aria's typeable numeric segments (for example 9/30/2027) and opens a calendar. Pass `presets` (`{ label, value }`, such as "Season end") to show them as chips in the calendar and as a pill in the field when the value matches. Also takes `minValue`, `label` or `aria-label`, `helper`, `error` and `disabled`. Use it for every date; never `<input type="date">`.

### Action menu (`ActionMenu`)
The ⋯ "More actions" menu. Props: `label` (the button's accessible name), `items` (`{ id, label, icon?, onAction, danger?, disabled?, disabledReason?, group? }`) and `trigger` (`'icon'` by default, or `{ text, variant, icon }` for a split-style button). Danger items always sort last, after a divider, in red. A disabled item shows its `disabledReason` as a description under the label. Put the secondary and rare actions here, not extra buttons.

### Switch (`Switch`)
An on/off setting. Props: `label`, `description`, `isSelected`, `onChange(boolean)`, `isDisabled`. Green when on, gray when off, 44px tall.

### Help tips (`HelpTip`)
An info button labelled "More info" that opens on press (and by keyboard). It holds help text, so the page needs no explanatory paragraphs; one short line under a field is fine. Place it beside the control, never inside another button, link or clickable header. For a sortable `DataTable` column, pass it as `headerExtra`, which renders next to the sort button rather than inside it.

### Tabs (`Tabs`)
Underline tabs: Inter 500 at 0.875rem, a 2px crx-green underline and green text on the active tab, Slate Ink otherwise, optional count bubble (solid crx-green with white text when active). Arrow-key navigation, scrolls horizontally on phones. Pages keep the active tab in the `?tab=` URL parameter.

### Workspace link bar (`WorkspaceTabs`)
A row of round pills under the top bar that link between sibling pages of one workspace. Active pill is solid crx-green with white text; inactive pills fill Cream Shadow on hover. Use this to move between pages and `Tabs` to switch views within one page.

### Navigation (`Sidebar`, `TopBar`, `MobileBottomNav`)
Sidebar: charcoal, gray-400 items that turn white on hover, active item marked by a 3px crx-green-on-dark bar on its left edge and a crx-green-on-dark icon. Top bar: translucent cream with blur, page title with accent. Bottom nav (phones): icons over short labels, active item in crx-green.

### Tables (`DataTable`, `EditableDataTable`, `MobileCardList`)
Header row on Cream Shadow at 50% with Slate Ink medium labels and Lucide sort arrows; 0.875rem body. On phones, show records as `MobileCardList` cards instead of wide tables. A column's `headerExtra` holds a `HelpTip` beside the sortable header. Numbers are right-aligned in Inter with tabular figures; never monospace for money.

### Feedback (`Toast`, `ConfirmModal`, `Modal`, `EmptyState`, `Skeleton`)
Use toasts for results and errors, `ConfirmModal` for every confirmation, `Modal` for forms, `EmptyState` for empty or failed lists, and `Skeleton` for loading. Never use the browser's `window.confirm` or `alert`. Every server action shows progress (a spinner and "Saving…" on the button) and then a toast that says what happened, including "nothing changed". `ConfirmModal` titles are a question, the message says what changes in numbers, and the button repeats the action ("Remove line", never "OK"). `EmptyState` is a Lucide icon in a soft green circle, one bold line, one helpful line and the next action; an inline empty ("First time for this customer") is a small muted icon and text. Loading is skeleton rows shaped like the content, never a lone spinner in the middle of a page.

### App-wide layout style (Style D, compact and bold)
Chosen 2026-11-02. Label-left rows, a Save per sub-part, Cream Shadow section bands with a green icon tile, a sticky `SectionJumpBar`, and on phones a Charcoal header with labelled steps and a pinned 56px main button. The full rules are in `docs/workflows/UI_PATTERNS.md` ("Style D").

## Do's and Don'ts

### Do:
- **Do** use the crx-green tokens for every brand or primary-action colour, and `CRX_GREEN` in PDFs.
- **Do** use the shared components (`Button`, `Card`, `Badge`, `Tabs`, `Input`, `PageHeader`, `Modal`, `ConfirmModal`, toasts, `EmptyState`) before writing new markup.
- **Do** style with Tailwind classes and named tokens, and use Lucide icons only.
- **Do** wrap phone-edited screens in `.phone-touch` and give every phone control a 44px target below 768px and 40px on desktop (`h-11 md:h-10`). Every control is reachable by keyboard with a visible focus ring.
- **Do** keep behaviour fixed: UI work never changes what a button does, what is saved or when, permissions, totals or rounding.
- **Do** use `Dropdown` for every choice list and `DatePicker` for every date on a redesigned screen.
- **Do** give each screen one green button, the next step for the record's status, and at most two or three secondary buttons. Everything else goes in the ⋯ `ActionMenu`, with danger items last, after a divider, in red.
- **Do** lay out a record header with the title, status badge and save status on the left and the actions on the right, wrapping cleanly. On a phone, actions move to a sticky bottom bar (primary and secondary) and the ⋯ menu sits in the top bar.
- **Do** put help behind a `HelpTip` beside the control. One short line under a field is fine; no explanatory paragraphs.
- **Do** confirm before costly actions (removing a line with data, declining, cancelling, closing a booking, deleting), and show progress and a result for every server action.
- **Do** keep auto-saving screens auto-saving and show "Saving…", "All changes saved · 2:41 pm" or "Couldn't save. Retry" next to the title. Screens with a Save button show "Unsaved changes" until saved.
- **Do** show skeleton rows while loading and an `EmptyState` (icon, bold line, helpful line, next action) when a list is empty.
- **Do** set numbers in Inter with tabular figures, right-aligned in tables.
- **Do** write plain American English with no em dashes and no internal codes. Status labels read "Closed short" and "Fulfilled".
- **Do** build filters as search, dropdowns and toggle chips. An active chip is green-tinted with a check; "Clear" appears only when something is filtered, in a reserved spot.
- **Do** keep priority table columns at 1024px and wider, turn rows into cards below 768px, and never let the page scroll sideways.
- **Do** make PDFs follow the layout the owner knows from the old billing software: company block left, logo centred with the document name, document details right, a bill-to block where a window envelope shows it, plain grey table headers, totals right, terms and page number in the footer.
- **Do** check every screen at 360, 390, 768, 1024, 1280, 1366, 1440 and 1920px before calling it done.
- **Do** keep the light theme: cream page, white surfaces, Charcoal text.

### Don't:
- **Don't** use raw `green-*` or `emerald-*` classes for brand meaning, and don't copy them from older screens (see the drift list below).
- **Don't** type hex colour codes in components or pages; add or reuse a token in `src/index.css` instead.
- **Don't** hand-roll tab buttons; use `Tabs` (views in a page) or `WorkspaceTabs` (links between pages).
- **Don't** use `window.confirm`, `window.alert`, another icon set, or another styling system.
- **Don't** add a dark theme or new brand colours. Restyling existing screens is covered by the owner's 2026-11-07 note in the Overview (free rein if behaviour does not change).
- **Don't** use a browser `<select>` or `<input type="date">` on a redesigned screen.
- **Don't** put a `HelpTip` inside a button, link or clickable header; place it beside the control, or use `headerExtra` in a `DataTable` column.
- **Don't** stack two colour classes for a state change; pick one with `cond ? 'a' : 'b'`.
- **Don't** use an amber chip for an active filter, brand green for a status badge, or colour alone to show status.
- **Don't** use monospace for money, full-width colour banners on PDFs, or the two-tone accent word on card titles: it is for the page title only.
- **Don't** use a lone spinner in the middle of a page for loading, or "OK" as a confirm button label.

### Known drift (do not copy; fix only when a task touches it)
- About 57 files use raw Tailwind `green-*` / `emerald-*` classes where crx-green is meant.
- About a dozen component and page files type hex colours directly, mostly maps and charts.
- Three tab mechanisms coexist: `Tabs`, the `WorkspaceTabs` link bar, and hand-rolled tab buttons on about seven pages.
- Map layers (Mapbox paint in `src/components/map/` and `src/components/fields/ImportPreviewMap.tsx`) need literal hex colours. They sit on dark satellite imagery, so they repeat crx-green-on-dark (#28A26A), not crx-green, and must change with that token.
- The Dispatch Board is a full dark screen (slate/gray), an exception to the light theme kept for outdoor and in-cab use. Field View and the driver screens (My Deliveries and the driver delivery screen) moved to style D on 2026-11-04: a dark `nav-dark` header band over a light page.
- The phone bottom nav uses 10px labels; don't use text that small elsewhere.
