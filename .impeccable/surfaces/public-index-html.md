---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# Surface brief: ER Atlas workbench (public/index.html)

Mode: Operate. Redesign of the whole shell; the user pinned the direction with a reference screenshot (an Excalidraw-style infinite-canvas workbench) plus two constraints: a matched white and black theme pair, and the new ER Atlas logo mark.

Audience and job: one developer exploring and editing a PostgreSQL/Laravel schema for hours, usually in dim light, mostly on a laptop, sometimes on a phone. Task: find a table, read its relations, stage a change.

## Direction contract

THESIS: The canvas is the product. All chrome floats over a full-bleed map as small pills and one tool strip, so nothing competes with the tables; it refuses the header-bar plus toolbar plus bottom-palette scaffold.

OWN-WORLD: Near-black ink (#0E0E11 dark canvas, #0F1117 ink on white) and neutral grays, one violet taken from the logo's connection star (#7B4BF0, lighter #9A73FF in dark) used only for the primary action, selection and focus. Pills are 1px-outlined surfaces with 12px radius and soft offset shadows; the active tool is a violet-tinted fill. Type: Noto Sans Arabic for Arabic UI, Roboto Mono only for identifiers, types and shortcut keys. Table nodes are outlined cards with a 3px topic band.

STORY: The user lands on a quiet map, understands where everything is in one glance (menu top-start, tools top-center, AI and drafts top-end, zoom bottom-start, counts bottom-end), and every action stays one click or one shortcut away.

FIRST VIEWPORT: Full-bleed dotted canvas. Top-start: logo pill, workspace pill, menu pill. Top-center: one tool strip (map/tables segmented, select, table, relation, arrange, search) with a quiet context row beneath (topic, view). Top-end: drafts chip and the single violet AI button. Bottom-start: zoom pill and undo/redo pill. Bottom-end: counts and help. The inspector slides in on the start side under the menu.

FORM: Floating-chrome canvas workbench (the reference's own topology), position 1 of the user's pin; seed key: pinned-by-user (no roll).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
