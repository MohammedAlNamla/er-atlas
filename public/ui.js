export function element(tag, className = "", text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const SVG_NS = "http://www.w3.org/2000/svg";
const icons = {
  pointer: "pointer", fit: "fit", minus: "minus", plus: "plus", add: "plus", arrange: "arrange",
  link: "relation", table: "table", tableWhite: "table", inspect: "table", key: "key", more: "more",
  chevron: "chevron", source: "code", search: "search", tools: "edit", edit: "edit", ai: "sparkle",
  close: "close", trash: "trash", info: "info", check: "check", database: "database",
};
export function icon(name) {
  const slot = element("span", `figma-icon icon-${name}`);
  slot.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG_NS, "svg"), use = document.createElementNS(SVG_NS, "use");
  svg.setAttribute("class", "i");
  svg.setAttribute("focusable", "false");
  svg.style.cssText = "width:100%;height:100%";
  use.setAttribute("href", `#i-${(Object.hasOwn(icons, name) && icons[name]) || "table"}`);
  svg.append(use);
  slot.append(svg);
  return slot;
}
export function hydrateIcons(root = document) {
  root
    .querySelectorAll("[data-icon]")
    .forEach((slot) => slot.replaceChildren(icon(slot.dataset.icon)));
}
export function button(label, handler, variant = "secondary-button") {
  const node = element("button", variant, label);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}
export function notice(title, text = "", kind = "") {
  const node = element("div", `notice ${kind}`),
    copy = element("div", "notice-copy");
  copy.append(element("strong", "", title));
  if (text) copy.append(element("p", "", text));
  node.append(icon(kind === "success" ? "check" : "info"), copy);
  return node;
}
export function codeBlock(code, title = "SQL") {
  const node = element("div", "code-block");
  node.dir = "ltr";
  node.append(element("div", "code-label", title), element("pre", "", code));
  return node;
}
export function tabs(entries, selected, change) {
  const nav = element("div", "ui-tabs");
  nav.setAttribute("role", "tablist");
  entries.forEach(([id, label]) => {
    const tab = button(
      label,
      () => change(id),
      `ui-tab${id === selected ? " active" : ""}`,
    );
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(id === selected));
    tab.tabIndex = id === selected ? 0 : -1;
    nav.append(tab);
  });
  nav.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = [...nav.children].indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + entries.length) %
            entries.length;
    const scope = nav.closest('dialog, #details') || nav.parentElement;
    change(entries[next][0]);
    scope
      .querySelector(`.ui-tabs [role="tab"][aria-selected="true"]`)
      ?.focus();
  });
  return nav;
}
export function dataTable(headers, rows, className = "") {
  const wrap = element("div", `data-table-wrap ${className}`),
    table = element("table", "data-table");
  const head = element("thead"),
    tr = element("tr");
  headers.forEach((label) => {
    const cell = element("th", "", label);
    cell.scope = "col";
    tr.append(cell);
  });
  head.append(tr);
  table.append(head);
  const body = element("tbody");
  rows.forEach((row) => {
    const tr = element("tr");
    row.forEach((value) => {
      const cell = element("td");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? "—";
      tr.append(cell);
    });
    body.append(tr);
  });
  table.append(body);
  wrap.append(table);
  return wrap;
}
export function modalHeader(title, description, close, titleId) {
  const header = element("div", "modal-header"),
    exit = button("", close, "dialog-close");
  exit.setAttribute("aria-label", "إغلاق");
  exit.append(icon("close"));
  const heading = element("h2", "", title);
  if (titleId) heading.id = titleId;
  header.append(exit, heading, element("p", "", description));
  return header;
}
export function modalFooter(actions, hint = "") {
  const footer = element("div", "modal-footer");
  if (hint) footer.append(element("p", "", hint));
  const row = element("div", "footer-actions");
  row.append(...actions);
  footer.append(row);
  return footer;
}
export function openDialog(dialog) {
  dialog.hidden = false;
  if (!dialog.open) dialog.showModal();
}
export function initOverlays() {
  hydrateIcons();
  document.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close]");
    if (close) document.getElementById(close.dataset.close)?.close();
  });
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("pointerdown", (event) => {
      dialog.dataset.backdropDown = String(
        event.target === dialog && outside(event, dialog),
      );
    });
    dialog.addEventListener("click", (event) => {
      if (
        dialog.dataset.backdropDown === "true" &&
        event.target === dialog &&
        outside(event, dialog)
      )
        dialog.close();
    });
  }
}
function outside(event, node) {
  const rect = node.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}
export function renderMiniMap(
  host,
  tables,
  relations,
  positions,
  width = 320,
  nodeHeight = () => 160,
) {
  host.replaceChildren();
  if (!tables.length) {
    host.append(element("p", "", "لا توجد جداول في هذا النطاق"));
    return;
  }
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  const bounds = tables.map((table) => ({
    table,
    point: positions.get(table.id) || { x: 0, y: 0 },
  }));
  const left = Math.min(...bounds.map((b) => b.point.x)) - 40,
    top = Math.min(...bounds.map((b) => b.point.y)) - 40;
  const right = Math.max(...bounds.map((b) => b.point.x + width)) + 40,
    bottom =
      Math.max(...bounds.map((b) => b.point.y + nodeHeight(b.table))) + 40;
  svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `معاينة ترتيب ${tables.length} جداول`);
  const centers = new Map(
    bounds.map((b) => [
      b.table.id,
      { x: b.point.x + width / 2, y: b.point.y + nodeHeight(b.table) / 2 },
    ]),
  );
  for (const relation of relations) {
    const a = centers.get(relation.source),
      b = centers.get(relation.target);
    if (!a || !b) continue;
    const line = document.createElementNS(ns, "path");
    line.setAttribute(
      "d",
      `M${a.x},${a.y} H${(a.x + b.x) / 2} V${b.y} H${b.x}`,
    );
    line.setAttribute("class", "mini-edge");
    svg.append(line);
  }
  for (const { table, point } of bounds) {
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", point.x);
    rect.setAttribute("y", point.y);
    rect.setAttribute("width", width);
    rect.setAttribute("height", nodeHeight(table));
    rect.setAttribute("rx", "12");
    rect.setAttribute("class", "mini-node");
    svg.append(rect);
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", point.x + 16);
    text.setAttribute("y", point.y + 34);
    text.textContent = table.name;
    text.setAttribute("class", "mini-name");
    svg.append(text);
  }
  host.append(svg);
}


// Shared geometry keeps collapsed rows and relationship endpoints in agreement.
export const NODE_WIDTH = 300;
export const HEADER_HEIGHT = 52;
export const ROW_HEIGHT = 32;
export const FOOTER_HEIGHT = 32;
export const PREVIEW_LIMIT = 8;

export function previewColumns(table, expanded = false) {
  if (expanded || table.columns.length <= PREVIEW_LIMIT) return table.columns;
  const selected = new Set(table.columns.filter(column => column.primary || column.foreign).slice(0, PREVIEW_LIMIT));
  for (const column of table.columns) {
    if (selected.size >= PREVIEW_LIMIT) break;
    selected.add(column);
  }
  return table.columns.filter(column => selected.has(column));
}

export function nodeHeight(table, expanded = false) {
  return HEADER_HEIGHT + previewColumns(table, expanded).length * ROW_HEIGHT + FOOTER_HEIGHT + 2;
}

export function columnOffset(table, columnName, expanded = false) {
  const columns = previewColumns(table, expanded);
  const index = columns.findIndex(column => column.name === columnName);
  // Hidden columns attach to the expansion row; the relation details retain exact names.
  return index < 0
    ? HEADER_HEIGHT + columns.length * ROW_HEIGHT + FOOTER_HEIGHT / 2
    : HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export function fitCamera(bounds, viewport, { overview = false, center } = {}) {
  const fitScale = Math.max(.18, Math.min(1, viewport.width / (bounds.width + 120), viewport.height / (bounds.height + 120)));
  const scale = overview ? fitScale : Math.max(viewport.width < 600 ? .85 : .9, fitScale);
  const fitsAtReadableScale = (bounds.width + 40) * scale <= viewport.width && (bounds.height + 40) * scale <= viewport.height;
  const focus = !overview && !fitsAtReadableScale && center ? center : bounds.center;
  return { scale, x: viewport.width / 2 - focus.x * scale, y: viewport.height / 2 - focus.y * scale };
}

// Column-level unique flags can describe a composite constraint. Never infer
// one-to-one from an individual flag when the constraint itself is unavailable.
export function relationCardinality(relation, source, target) {
  const names = side => relation.pairs.map(pair => pair[side]);
  const unique = (table, columns) => {
    const primary = table.columns.filter(column => column.primary).map(column => column.name);
    return [primary, ...(table.uniqueKeys || [])].some(key => key.length && key.every(name => columns.includes(name)));
  };
  const sourceNames = names('source'), targetNames = names('target');
  const targetOne = unique(target, targetNames);
  const sourceColumns = sourceNames.map(name => source.columns.find(column => column.name === name));
  return {
    source: unique(source, sourceNames) ? '1' : relation.kind === 'actual' && targetOne && sourceColumns.every(column => column && column.unique === false) ? '*' : null,
    target: targetOne ? '1' : null
  };
}

