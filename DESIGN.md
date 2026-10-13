---
name: ER Atlas
description: A full-bleed schema map with all chrome floating over it as small outlined pills, in a matched white and black theme pair with one violet.
colors:
  accent: "#7b4bf0"
  accent-deep: "#5b2fd4"
  accent-hover: "#4c25b8"
  on-accent: "#ffffff"
  paper: "#f6f6f8"
  surface: "#ffffff"
  ink: "#0f1117"
  muted: "#626675"
  faint: "#686c7a"
  line: "#e3e3e8"
  grid: "#d6d6de"
  context: "#f3f3f6"
  selected: "#f0eaff"
  selection: "#e2d6ff"
  proposed-soft: "#f6f2ff"
  node-border: "#d9d9e0"
  outline-strong: "#b5a2ee"
  outline-mid: "#cdbff5"
  divider-soft: "#efeff3"
  wire: "#8e8ea0"
  wire-focus: "#6d46e0"
  wire-trace: "#5b2fd4"
  wire-selected: "#6a3ee6"
  wire-proposed: "#8b63f5"
  wire-label: "#4a4d5c"
  danger: "#c2334d"
  danger-bg: "#fff1f3"
  success: "#177a55"
  success-bg: "#ecf7f1"
  warning-ink: "#885e25"
  warning-bg: "#fff5e6"
  code-bg: "#14151c"
  code-ink: "#ececf4"
typography:
  heading:
    fontFamily: "Noto Sans Arabic, system-ui, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "36px"
  title:
    fontFamily: "Noto Sans Arabic, system-ui, Segoe UI, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: "28px"
  body:
    fontFamily: "Noto Sans Arabic, system-ui, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "24px"
  label:
    fontFamily: "Noto Sans Arabic, system-ui, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "1"
  node-name:
    fontFamily: "Noto Sans Arabic, system-ui, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: "24px"
  identifier:
    fontFamily: "Roboto Mono, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: "20px"
  shortcut-key:
    fontFamily: "Roboto Mono, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "1"
rounded:
  chip: "4px"
  input: "8px"
  button: "9px"
  node: "10px"
  pill: "12px"
  inspector: "14px"
  dialog: "16px"
  round: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  chrome-inset: "16px"
components:
  pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "3px"
    height: "44px"
  pill-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "0 12px"
    height: "36px"
  pill-button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.button}"
  pill-button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  tool:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.button}"
    size: "40px"
  tool-pressed:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.accent-deep}"
  segment-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "7px"
    height: "30px"
  search-field:
    backgroundColor: "{colors.context}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    height: "36px"
    width: "176px"
  table-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.node}"
    width: "320px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
  inspector:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.inspector}"
    width: "360px"
---

# Design System: ER Atlas

## Overview

**Creative North Star: "The Quiet Map"**

The canvas is the product. A full-bleed dotted map fills the viewport, and every piece of chrome floats over it as a small outlined pill: no header bar, no toolbar band, no bottom palette. The interface is Arabic-first and right-to-left, so "start" is the right edge. Near-black ink and neutral grays carry everything; one violet, taken from the logo's connection star, appears only where the user acts, selects or focuses.

Light and dark are a matched pair, not a theme and its inversion. Both are built from the same roles, and the dark canvas (#0e0e11) is as deliberately tuned as the white one. The system follows the OS by default and can be pinned to light or dark by the user; the pin is applied by an inline script before first paint so dark never flashes light.

Density is calm and workmanlike: a developer reads relations for hours. Table cards are outlined, flat and uniform, so the topic band, the wires and the selection are the only things that change.

**Key Characteristics:**
- Full-bleed dotted canvas; chrome is pills and one tool strip only.
- Flat outlined surfaces with one soft pill shadow; no hard offset shadows.
- One violet, reserved for primary action, selection and focus.
- Noto Sans Arabic for UI, Roboto Mono only for identifiers, types and shortcut keys.
- Topic color appears as information (a 3px band), never as decoration.

## Colors

Near-black ink and cool neutral grays with a single violet. Values below are light; dark counterparts are in `public/atlas.css` and the sidecar.

### Primary
- **Connection Violet** (accent, #7b4bf0; dark #9a73ff): primary button fill, the badge on the drafts chip, selected-node border and ring, focus outline, search focus border, relation-endpoint dots.
- **Deep Violet** (accent-deep, #5b2fd4; dark #b9a0ff): text and icon color on violet-tinted fills (active tool, expanded pill, active tab, notices, change numbers). Also the primary text-link color.
- **Pressed Violet** (accent-hover, #4c25b8; dark #cdb9ff): hover and expanded state of the primary button.

### Neutral
- **Canvas Paper** (paper, #f6f6f8; dark #0e0e11): the map background and full-page views.
- **Surface** (surface, #ffffff; dark #1a1a20): pills, nodes, popovers, inspector, dialogs.
- **Ink** (ink, #0f1117; dark #f1f1f5): primary text, logo mark, toast background.
- **Muted** (muted, #626675) and **Faint** (faint, #686c7a): secondary text; faint is for placeholders and shortcut hints.
- **Hairline** (line, #e3e3e8) and **Node Border** (node-border, #d9d9e0): 1px outlines for pills and cards.
- **Context Gray** (context, #f3f3f6): hover fill, node header recess, segmented-control track, search field.
- **Selected Tint** (selected, #f0eaff; dark #2d2552): the violet-tinted fill for active tool, active row, hovered menu item.
- **Dot Grid** (grid, #d6d6de): the canvas dots.

### Status
- **Danger** (#c2334d), **Success** (#177a55), **Warning ink** (#885e25), each with a soft background tint. Used only for notices and destructive actions.

### Wires
- **Wire** (#8e8ea0) is the default relation color; **focus**, **trace**, **selected** and **proposed** wires step through violets (#6d46e0, #5b2fd4, #6a3ee6, #8b63f5). The canvas edge renderer and the SVG edges read the same tokens.

### Named Rules
**The One Violet Rule.** Violet is for the primary action, selection and focus. There is no second accent; topic colors are data, not accent.
**The Context Stays Rule.** Selecting a table or relation emphasizes it, but surrounding tables and wires stay visible (dimmed wires keep 55% opacity).

## Typography

**UI Font:** Noto Sans Arabic (with system-ui, Segoe UI, sans-serif)
**Identifier Font:** Roboto Mono (with monospace)

**Character:** Arabic reads as the first language and mono marks what is literal. Anything the user could paste into SQL or code (table names in the inspector, column names, types, shortcut keys, counts) is mono; everything the interface says is Noto Sans Arabic.

### Hierarchy
- **Heading** (700, 24px, 36px): full-page view titles and empty-workspace title (26px).
- **Title** (700, 18px, 28px): dialog section titles, topic cards.
- **Body** (400, 14px, 24px): default text, inputs, menu items (13px in popovers).
- **Label** (600, 13px, 1): pill buttons (14px), segmented control, context row (500, 13px).
- **Node name** (650, 16px, 24px): table header; scales to 36px in the zoomed-out overview tile.
- **Identifier** (400, 13.5px, 20px mono): column names; types are 13px mono in muted; inspector titles 700 16px mono.
- **Shortcut key** (500, 11px mono, muted): the hint under each tool icon.

### Named Rules
**The Literal Is Mono Rule.** Roboto Mono is for identifiers, types, counts and shortcut keys only. Never set interface prose in it.

## Layout

A fixed full-viewport shell: `.map-area` fills the screen and a pointer-transparent chrome layer sits above it in five zones, inset 16px from the edges (12px under 520px). In RTL, start is the right edge.
- **Top-start:** logo pill, workspace pill, menu pill.
- **Top-center:** the tool strip (map/tables segmented control, select, table, relation, arrange, search) with a quiet context row beneath (topic, view).
- **Top-end:** drafts chip and the single violet AI button.
- **Bottom-start:** zoom pill and undo/redo pill (kept left-to-right so numeric controls keep their order).
- **Bottom-end:** counts pill and help button.
- **Inspector:** a 360px panel on the start side under the menu (top and bottom 76px); full-page views pad 408px on that side while it is open.
- **Full-page views** (catalog, topic overview, focus picker) fill the map area and clear the chrome (128px top padding).

Spacing runs on a 4/8/12/16/24 rhythm; pill internals are 2-3px padding with 8px gaps. Responsive: under 1180px the wordmark is hidden and search collapses into a toggle; under 900px button labels hide, the tool strip drops to 68px and scrolls horizontally, shortcut hints hide, and the inspector becomes a bottom sheet; under 520px history and counts are hidden.

Table geometry is shared with `public/ui.js`: nodes are 320px wide with a 1px border, so measured positions of wires and anchors hold. Do not change node borders, heights or paddings in CSS without updating ui.js.

## Elevation & Depth

Flat with one soft lift. Surfaces are separated by 1px outlines and tone (paper, surface, context), not by shadow. Floating chrome carries a faint pill shadow; popovers and the inspector a slightly larger soft one; dialogs the largest. All shadows are blurred and ambient; there are no hard offset shadows.

### Shadow Vocabulary
- **Pill** (`--pill-shadow`: `0 1px 2px rgb(15 17 23 / .08)`; dark pinned adds `0 8px 24px rgb(0 0 0 / .35)`): every chrome pill.
- **Popover and inspector** (`0 4px 14px rgb(shadow / .14)`, inspector `.12`): menus hanging from pills, the inspector.
- **Dialog** (`0 8px 28px rgb(shadow / .22)`): modals, over a scrim of 35% ink (60% black in dark).
- **Selection ring** (`0 0 0 2px accent at 35%` plus the violet 1px border): the selected table node.

### Named Rules
**The Outline First Rule.** A boundary is a 1px outline before it is a shadow. Nodes carry no resting shadow at all.

## Shapes

Soft but disciplined corners, nested by size: pills 12px (`pill`), buttons and tools inside pills 9px, table nodes 10px, inspector 14px, dialogs 16px, inputs and cards 8px, chips 4px, topic counts and the toast fully round. Segmented-control segments are 7px inside a 9px track. Pills and nodes are always 1px outlined. The logo mark (brand/logo-mark.svg, single ink fill, currentColor in use) and the favicon are the only brand marks; icons are 20px stroked SVGs (1.75 stroke, round caps).

## Components

### Pill
A 44px-tall, 1px-outlined surface at 12px radius with 3px padding, holding buttons or tools. Every floating control is a pill. The context row and counts use a lighter 36px pill.

### Pill button
- **Default:** 36px high, 9px radius, 600 14px label, transparent on the pill; hover fills Context Gray; press scales to .97.
- **Primary:** Connection Violet fill, on-accent text, hover to Pressed Violet. One per screen (the AI button).
- **Icon-only:** 36px square. **Expanded:** Selected Tint with Deep Violet text.

### Segmented control
Context Gray track (9px radius, 3px padding); the active segment is a surface chip with a hairline shadow and ink text; inactive segments are muted. Used for map/tables.

### Tool button
40px square, muted icon, 9px radius. Pressed state is Selected Tint with Deep Violet icon. A mono 11px shortcut key sits under the icon (icon lifts 6px to make room). Disabled is 35% opacity.

### Search field
Context Gray, 36px, 176px wide, expanding to 248px with a violet border and surface fill on focus; carries a mono key hint. Hidden when the catalog view brings its own search.

### Zoom and counts
The zoom pill is mono, tabular, left-to-right. The counts pill is quiet muted text on a surface pill.

### Popovers
Hang 8px below their pill, 12px radius, surface with hairline and soft shadow, 44px rows at 8px radius, hover in Selected Tint. They grow away from the nearest screen edge (pop-in 160ms ease-out, scale from .96).

### Inspector panel
360px, 14px radius, slides in on the start side (panel-in 200ms). Header, scrolling body that fades out at the bottom, footer. Chips and key cells inside are muted, not violet.

### Table node
Outlined surface card, 320px, 10px radius, 1px node-border. The header (48px) carries a 3px topic-color band as an inset shadow so geometry is unchanged. Hover darkens the border to a soft violet; selected is a violet border with a 2px ring; neighbors use the mid outline; dimmed nodes drop to line-color border and muted name. Proposed nodes are dashed. Columns are 40px mono rows with 1px soft dividers and 5px relation dots. Below 42% zoom each node becomes a labelled tile: columns hide, the name grows to 36px and the topic band thickens to 8px.

### Edges
SVG edges and the canvas renderer read the wire tokens: 1.6px at 75% opacity by default, trace 2.25px, selected 2.5px, proposed dashed 6/6. Cardinality labels are mono 600 13px with a paper halo.

### Catalog and topic overview
The catalog is a sortable list on a surface band: 64px grid rows (name mono 500, counts, topic chips with their color dot). Topic cards are 12px-radius cards with a 4px topic band across the top, a pill count tinted from the topic color, and the first tables as mono chips; hover lifts 2px.

### Dialogs
16px radius, hairline and soft shadow, header/body/footer with 24px padding, 40px buttons at 8px radius (primary violet, secondary outlined, ghost), underline tabs in violet, notices as tinted blocks. Width is set per dialog by `--modal-width`.

### Motion
Pop-in 160ms and panel-in 200ms use cubic-bezier(.23, 1, .32, 1); dialogs fade in 180ms ease-out; hover and color transitions are 150ms. Press scales to .97. Under `prefers-reduced-motion` animations are removed and press scale is off.

### Theme
Light is `:root`; dark applies under `prefers-color-scheme: dark` unless `data-theme="light"` is pinned, and `data-theme="dark"` pins dark. The pin is stored as `eratlas.theme` and applied by an inline head script before the stylesheet.

## Do's and Don'ts

### Do:
- **Do** use violet only for the primary action, selection and focus.
- **Do** keep context visible around the selection: dim, never hide, neighboring tables and wires.
- **Do** keep table geometry synchronized between CSS and `public/ui.js` (320px width, 1px border, header and row heights).
- **Do** carry topic identity as a 3px inset band on the table header; it is information, not decoration.
- **Do** put every new floating control in a pill, in the zone its role belongs to.
- **Do** set identifiers, types, counts and shortcut keys in Roboto Mono and everything else in Noto Sans Arabic.
- **Do** design every new color token as a light and dark pair, in all three theme blocks.

### Don't:
- **Don't** add a second accent color.
- **Don't** add a header bar, a toolbar band or a bottom palette.
- **Don't** add kickers or eyebrow labels above headings.
- **Don't** use gradient text.
- **Don't** give nodes a resting shadow or use hard offset shadows.
- **Don't** thicken the node border above 1px or change node header and row heights in CSS alone.
