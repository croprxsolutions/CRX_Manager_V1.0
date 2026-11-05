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
  field-border: "#d1d5db"
  danger: "#dc2626"
  danger-hover: "#b91c1c"
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

The brand is fixed. In November 2026 the owner approved deepening the green for readability (from #28A26A to the current crx-green) while keeping everything else. New screens extend this system; they never restyle it. Any visual change beyond what a task needs requires the owner's approval.

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
- **Field Green Bright** (crx-green-on-dark, #28A26A, the original brand green): green text, icons, markers, borders and focus rings that sit on a dark surface (the sidebar, the dark dispatch and field screens, the driver delivery view, the dark panel of the sign-in pages). It reads at 4.2:1 on Charcoal and 4.5-6.2:1 on the slate and gray dark screens, where crx-green would fall to 2.5-3.4:1. On Charcoal, or on a green-tinted dark fill, it clears the 3:1 bar for icons, markers and large or bold text but not 4.5:1 for small text; small labels there stay white or light gray. Green buttons with white text stay crx-green even on dark screens.
- **Green Wash** (crx-green-light): background behind green text, such as the active tab's count bubble (4.75:1).
- **Green Mist** (crx-green-tint): faint selected-row or highlighted-panel wash.

### Neutral
- **Harvest Cream** (cream): the page background behind everything, including the top bar and phone bottom nav (translucent with blur).
- **Cream Shadow** (cream-dark): table header rows (at 50%), the workspace link bar's bottom border and hover fill.
- **Charcoal** (nav-dark): primary text colour and the desktop sidebar background. Despite the name, it is the body text colour app-wide.
- **Charcoal Lift** (nav-dark-hover): sidebar hover surface.
- **Slate Ink** (secondary): secondary text, labels, inactive tabs, ghost buttons.
- **Hairline** (border-gray): default border on every element (pinned Tailwind 3 gray-200), card and table borders.
- **Field Edge** (field-border): input and secondary-button borders (gray-300).

### Status (Tailwind stock, not brand)
Badges and toasts use fixed Tailwind 3 pairs: emerald for success/paid/completed, amber for warning/pending, red for error/overdue/voided, blue for info/sent/scheduled, orange for expired, gray for draft/default. Badges are `100` fill, `800` text and a `200` inset ring; toasts are a `50` fill with a `200` border and a `500` icon. Map statuses through `statusToBadgeVariant` in `src/components/ui/Badge.tsx`, using status values from `.claude/schema-registry.json`.
- **Danger Red** (danger / danger-hover): destructive buttons only.

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
- **Section title** (Barlow 600, 1.125rem): card headers (`CardHeader`) and modal titles.
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
- **Large / extra large** (`shadow-lg`, `shadow-xl`): toasts and modal panels, over a 40% black, lightly blurred backdrop.

## Shapes

Gently rounded, never sharp and never bubbly. Buttons, inputs, toasts and icon buttons use 0.5rem corners; cards and desktop modals use 0.75rem; badges, count bubbles and workspace link pills are fully round. Borders are 1px hairlines.

## Components

All shared pieces live in `src/components/ui/` and `src/components/layout/`. Use them before writing new markup.

### Buttons (`Button`)
- **Variants:** primary (crx-green, white text, small shadow), secondary (white with a gray border), ghost (text only, gray hover fill), danger (red-600). Sizes sm, md (default) and lg.
- **States:** colour transitions over 150ms; disabled is 50% opacity; `loading` swaps the icon for a spinner. Pass `showChevron` only on a button that goes to another page or the next step; Save and other in-place actions never show the › arrow.

### Status badges (`Badge`)
Fully round pills, 0.75rem medium text, capitalised. Pick the variant via `statusToBadgeVariant`; never colour a status ad hoc.

### Cards (`Card`, `CardHeader`)
White, 0.75rem corners, hairline border, card shadow, 1.25rem padding (turn off with `padding={false}` for tables). `CardHeader` gives a section title with an optional accent word and a right-aligned action.

### Inputs (`Input`, `Select`, `Combobox`, `SearchableSelect`)
White, 1px Field Edge border, 0.5rem corners, Slate Ink label above. Focus: crx-green border plus a 2px crx-green ring at 20%. Error: red-500 border and red-600 helper text. Required fields show a red-600 asterisk. Placeholders are gray-500.

### Tabs (`Tabs`)
Underline tabs: Inter 500 at 0.875rem, a 2px crx-green underline and green text on the active tab, Slate Ink otherwise, optional count bubble (solid crx-green with white text when active). Arrow-key navigation, scrolls horizontally on phones. Pages keep the active tab in the `?tab=` URL parameter.

### Workspace link bar (`WorkspaceTabs`)
A row of round pills under the top bar that link between sibling pages of one workspace. Active pill is solid crx-green with white text; inactive pills fill Cream Shadow on hover. Use this to move between pages and `Tabs` to switch views within one page.

### Navigation (`Sidebar`, `TopBar`, `MobileBottomNav`)
Sidebar: charcoal, gray-400 items that turn white on hover, active item marked by a 3px crx-green-on-dark bar on its left edge and a crx-green-on-dark icon. Top bar: translucent cream with blur, page title with accent. Bottom nav (phones): icons over short labels, active item in crx-green.

### Tables (`DataTable`, `EditableDataTable`, `MobileCardList`)
Header row on Cream Shadow at 50% with Slate Ink medium labels and Lucide sort arrows; 0.875rem body. On phones, show records as `MobileCardList` cards instead of wide tables.

### Feedback (`Toast`, `ConfirmModal`, `Modal`, `EmptyState`, `Skeleton`)
Use toasts for results and errors, `ConfirmModal` for every confirmation, `Modal` for forms, `EmptyState` for empty or failed lists, and `Skeleton` for loading. Never use the browser's `window.confirm` or `alert`.

### App-wide layout style (Style D, compact and bold)
Chosen 2026-11-02. Label-left rows, a Save per sub-part, Cream Shadow section bands with a green icon tile, a sticky `SectionJumpBar`, and on phones a Charcoal header with labelled steps and a pinned 56px main button. The full rules are in `docs/workflows/UI_PATTERNS.md` ("Style D").

## Do's and Don'ts

### Do:
- **Do** use the crx-green tokens for every brand or primary-action colour, and `CRX_GREEN` in PDFs.
- **Do** use the shared components (`Button`, `Card`, `Badge`, `Tabs`, `Input`, `PageHeader`, `Modal`, `ConfirmModal`, toasts, `EmptyState`) before writing new markup.
- **Do** style with Tailwind classes and named tokens, and use Lucide icons only.
- **Do** wrap phone-edited screens in `.phone-touch` and give every phone control a 44px target.
- **Do** keep the light theme: cream page, white surfaces, Charcoal text.

### Don't:
- **Don't** use raw `green-*` or `emerald-*` classes for brand meaning, and don't copy them from older screens (see the drift list below).
- **Don't** type hex colour codes in components or pages; add or reuse a token in `src/index.css` instead.
- **Don't** hand-roll tab buttons; use `Tabs` (views in a page) or `WorkspaceTabs` (links between pages).
- **Don't** use `window.confirm`, `window.alert`, another icon set, or another styling system.
- **Don't** add a dark theme, new brand colours, or restyle existing screens without the owner's approval.

### Known drift (do not copy; fix only when a task touches it)
- About 57 files use raw Tailwind `green-*` / `emerald-*` classes where crx-green is meant.
- About a dozen component and page files type hex colours directly, mostly maps and charts.
- Three tab mechanisms coexist: `Tabs`, the `WorkspaceTabs` link bar, and hand-rolled tab buttons on about seven pages.
- Map layers (Mapbox paint in `src/components/map/` and `src/components/fields/ImportPreviewMap.tsx`) need literal hex colours. They sit on dark satellite imagery, so they repeat crx-green-on-dark (#28A26A), not crx-green, and must change with that token.
- The Dispatch Board and the driver delivery view are full dark screens (slate/gray), an exception to the light theme kept for outdoor and in-cab use. Field View moved to style D (a dark header over a light list) on 2026-11-04.
- The phone bottom nav uses 10px labels; don't use text that small elsewhere.
