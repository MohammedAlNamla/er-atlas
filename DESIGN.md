---
name: ER Atlas — Quiet Atlas
description: A light, readable workspace for exploring real database structure.
colors:
  primary: "#7864c8"
  primary-deep: "#5d4bb1"
  primary-hover: "#51409e"
  paper: "#fcfbfd"
  surface: "#ffffff"
  ink: "#292635"
  muted: "#696477"
  line: "#e6e2ed"
  context: "#faf8fe"
  selected: "#f2eefb"
  node-border: "#ded8eb"
  wire: "#9288af"
  danger: "#ac3b50"
  success: "#207a59"
typography:
  headline:
    fontFamily: "Noto Sans Arabic, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "36px"
  title:
    fontFamily: "Noto Sans Arabic, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: "26px"
  body:
    fontFamily: "Noto Sans Arabic, sans-serif"
    fontSize: "14px"
    lineHeight: "24px"
  label:
    fontFamily: "Noto Sans Arabic, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "22px"
  field:
    fontFamily: "Roboto Mono, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  type:
    fontFamily: "Roboto Mono, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "Noto Sans Arabic, sans-serif"
    fontSize: "12px"
    lineHeight: "20px"
rounded:
  compact: "4px"
  control: "6px"
  surface: "8px"
  overlay: "10px"
  dialog: "12px"
spacing:
  tight: "4px"
  compact: "8px"
  inset: "12px"
  comfortable: "16px"
  section: "20px"
  outer: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.surface}"
    padding: "8px 14px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.surface}"
    padding: "8px 14px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.surface}"
    padding: "8px 14px"
    height: "40px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.surface}"
    padding: "10px 12px"
    height: "44px"
  chip:
    backgroundColor: "{colors.context}"
    textColor: "{colors.primary-deep}"
    rounded: "{rounded.compact}"
    padding: "2px 6px"
  schema-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    width: "320px"
  canvas-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    padding: "0 12px"
---

# Design System: ER Atlas — Quiet Atlas

## Overview

**Creative North Star: "Quiet Atlas"**

Quiet Atlas makes database structure comfortable to read. The canvas is near-white paper with a fine dotted field; tables are white, clearly separated surfaces. Purple carries actions and selection while restrained neutral wires preserve the surrounding structure.

Arabic controls share the workspace with English database identifiers. Keep ER Atlas's supplied connected-node mark, purple identity and local font assets. The chosen direction favors readable rows, two grouped navigation levels and small bottom tools. Actual schema data supplies the content and topology.

**Key Characteristics:**
- Readable table surfaces on a light dotted canvas.
- Arabic interface type paired with monospaced fields and SQL.
- Purple actions and lavender state surfaces.
- Thin separators, modest corners and restrained overlay depth.
- Compact navigation around a pannable data canvas.

This document merges the approved direction with the shipped stylesheet: public/atlas.css (tokens first, then layout, components and the final surface; every color is a token with a light and a dark value, dark following the system unless data-theme pins it); ui.js owns matching node geometry. It records implementation evidence. Formal measured-comp state was not established before implementation, so this document does not certify a formal comp gate.

## Colors

A quiet paper-and-ink palette leaves purple available for interaction and relationship emphasis. The frontmatter owns exact token values; the existing CSS names the purple primitives teal and teal-deep.

### Primary
- **Atlas Purple:** selected node outlines, focus, active tab underlines and accent controls.
- **Deep Atlas Purple:** primary actions, active labels and emphasized text.
- **Pressed Purple:** primary action hover.

### Neutral
- **Paper:** the diagram and catalog canvas.
- **White Surface:** table cards, navigation, menus, fields and dialogs.
- **Ink:** names, controls and primary reading.
- **Muted Ink:** field types, supporting labels and unrelated table names.
- **Fine Line:** navigation dividers, field outlines and separators.
- **Quiet Context:** table headers and neutral hover surfaces.
- **Lavender Selection:** selected tools, choices and column emphasis.
- **Table Outline:** the resting schema-node boundary.
- **Context Wire:** neutral relationships that remain visible around selection.

Danger and success colors communicate actual destructive actions and status notices; they are semantic exceptions to the single purple identity.

**The Context Stays Visible Rule.** Keep unrelated nodes readable and unrelated wires present when a table or relationship receives emphasis.

## Typography

**Interface Font:** Noto Sans Arabic with sans-serif fallback.  
**Identifier/SQL Font:** Roboto Mono with monospace fallback.

Arabic controls and proportional table titles remain easy to scan. Monospaced field names, types, SQL and numerical readouts communicate structure without turning every title into code.

### Hierarchy
- **Headline:** catalog and alternate-view headings.
- **Title:** proportional schema-node names.
- **Body:** interface copy and desktop navigation.
- **Label:** dialog actions and supporting controls.
- **Field:** column names.
- **Type:** column types and code-oriented fields.
- **Caption:** expansion actions and supporting metadata.

The brand uses a larger interface title (22px, bold); dialog headings use a middle size (21px/32px), dropping to 20px on narrow screens. Compact chips use 11px text. Bottom tool labels use 10px text with icons and accessible names; they supplement the action symbol.

**The Two Reading Voices Rule.** Use proportional interface type for navigation and schema-node titles; reserve monospace for field-level structure, code and numerical readouts.

## Layout

The application fills the viewport (100dvh). A desktop identity/search/action header (78px) sits above a workspace toolbar (62px). Both use white surfaces, thin bottom rules and comfortable outer insets. Header search expands between the identity and utility groups; desktop header controls are 44–46px tall.

Schema nodes retain a fixed width; their title band (48px), field rows (40px) and full-table footer (40px) share geometry between CSS and JavaScript. Six preview rows produce a bordered node height of 330px. Preview selection prioritizes primary and foreign keys, then fills available slots while preserving source column order. The complete table view contains every column.

The bottom editing strip is centered on desktop, with zoom controls at the left and counts at the right. The camera fit calculation reserves 88px of viewport height for bottom tools. The entry camera favors readable scale; a separate whole-diagram fit may zoom out further. Saved coordinates determine layout.

At 880px and below, the header becomes 64px and the toolbar 56px; search opens an additional row. At 600px and below, tools reduce to accessible icon controls, workspace labels truncate, the catalog condenses and overlays stay bounded to the viewport. At 360px and below, switchers and utilities narrow again. Table nodes preserve readable geometry within a pannable canvas rather than squeezing every field into the viewport. Narrow overlays and menus use explicit viewport gutters.

## Elevation & Depth

Tables are flat at rest and on hover. Header tint, fine dividers, outlines and inset selection convey structure. Overlay surfaces receive soft depth; the bottom editing strip receives a faint ambient lift. Dialog backdrops use a translucent ink layer without blur.

### Shadow Vocabulary
- **Dialog depth:** the shared shadow token; separates modal surfaces from the diagram.
- **Popover depth:** a lighter, shorter shadow shared by menus and the contextual inspector.
- **Tool-strip lift:** a faint shadow under the bottom editing palette.
- **Selection inset:** an inner purple outline on selected nodes and focused fields.

Exact shadows and focus treatments live in the sidecar extensions and component snippets.

**The Topic Band Rule.** Each table header carries a 3px band in its topic color (an inset shadow, so node geometry is unchanged). Below 42% zoom columns hide and each table becomes a labelled tile with an 8px band.

**The Flat Tables Rule.** Table cards use separators and state outlines for hierarchy; reserve ambient elevation for tools and overlays.

## Shapes

Use restrained corners: compact badges and small icon controls, standard fields and table surfaces, slightly softer menus and dialogs. Active view tabs keep square edges and use a thin underline. Table cards clip their tinted header and field dividers to one continuous outline. Reuse the supplied SVG logo and icon assets; the selection pointer follows the documented supplied/Tabler provenance.

## Components

### Buttons
Quiet, legible controls with clear state changes. Primary actions use deep purple with white text and darken on hover. Secondary actions use white with a fine border, becoming context-tinted on hover. Ghost controls remove the border and fill. Shared dialog actions use the frontmatter size; the main add-table action is taller (44px), with a desktop label and narrow-screen accessible icon treatment. Buttons retain a purple focus-visible outline (2px, offset 3px); disabled actions reduce opacity.

### Inputs / Fields
White fields with thin outlines and standard corners. Focus changes the border and adds a purple inset stroke. The header search uses a context-tinted wrapper and a wrapper-level focus treatment. English/code inputs remain left-to-right and monospaced. Placeholder and explanatory copy use muted ink.

### Navigation
Two grouped rows separate global workspace controls from canvas navigation. Map/table controls use an underline to show the current view. Topics use a bounded label and neutral outline; their menu uses lavender selected rows. AI and overflow utilities remain compact. Narrow navigation preserves accessible names when visible labels are hidden.

### Chips
Small context-tinted tags carry counts, topics and draft state. They supplement the table or inspector content. Do not turn them into prominent navigation surfaces.

### Schema Nodes
A tinted proportional title band, monospaced column list and full-table action form one readable surface. Key icons identify actual primary/foreign fields. Selection adds a purple border and inset outline; neighboring tables receive a softer outline. Other tables keep full opacity with quieter titles. A single click selects without covering the canvas; double-click or Enter opens inspection. The footer opens all columns in a modal.

### Relationships
Neutral directional wires retain surrounding context. Selection and incident relationships receive stronger purple strokes; unrelated wires remain at opacity 0.55. Direction arrows follow the foreign-key relationship; multiplicity labels appear only when schema primary/unique-key evidence supports them. Composite relationships receive one multiplicity annotation, not one per column pair. SVG and canvas rendering share annotations and emphasis. Hidden-preview endpoints attach to the footer region while relationship details retain exact field names.

### Overlays
Menus and the inspector share white surfaces, fine outlines and restrained soft shadows. Standard dialogs use bounded widths and viewport height, a light ink backdrop, separated headers/footers and scrollable content. The inspector is a contextual side surface; the expansion dialog preserves the full field list.

## Do's and Don'ts

### Do:
- **Do** preserve the connected-node mark, purple identity and local Noto Sans Arabic / Roboto Mono fonts.
- **Do** keep table geometry and relationship endpoints synchronized between styles and shared measurements.
- **Do** prioritize real keys in compact previews and retain every column in the complete table view.
- **Do** keep the context visible around selection and reserve bottom space for canvas tools.
- **Do** bound narrow-screen overlays, preserve accessible action names and allow canvas panning.

### Don't:
- **Don't** invent schema relationships or cardinality to reproduce an illustration.
- **Don't** shrink table rows or default the entry camera to unreadable whole-diagram scale.
- **Don't** reset saved coordinates to imitate the approved composition.
- **Don't** add decorative gradients or ambient shadows to resting table cards.
- **Don't** replace supplied vector assets with decorative text glyphs.
