// The map canvas: table cards, emphasis and search, camera, selection.
import { icon, button as uiButton, NODE_WIDTH, previewColumns, nodeHeight as measureNode, fitCamera } from './ui.js';
import { $, state, el } from './core.js';
import { chooseFocusTable } from './views.js';
import { graphPosition, visibleTables, visibleRelations, allRelations, nodeExpanded, nodeHeight } from './layout.js';
import { edgeRefs, renderEdges, updateEdgeEmphasis, drawCanvasEdges } from './edges.js';
import { openRelationDetails, renderDetails, openExpandedTable } from './inspector.js';
import { columnTitle } from './notes.js';
import { showContextMenu, isDraftTable, isDraftColumn, chooseLinkColumn } from './editor.js';
import { groupForTable } from './groups.js';
import { renderAiMessages } from './chat.js';
import { updateAiSettings } from './ai.js';
let involvedColumns = new Map();
function indexInvolvedColumns() {
  const index = new Map();
  const add = (tableId, column) => { if (!index.has(tableId)) index.set(tableId, new Set()); index.get(tableId).add(column); };
  for (const relation of allRelations()) for (const pair of relation.pairs) { add(relation.source, pair.source); add(relation.target, pair.target); }
  return index;
}
// Largest title that fits the zoomed-out tile: words wrap only after underscores, so the
// longest word decides the width and the line count decides the height.
export function columnsLabel(count) {
  return count === 0 ? 'بلا أعمدة' : count === 1 ? 'عمود واحد' : count === 2 ? 'عمودان' : count <= 10 ? `${count} أعمدة` : `${count} عمودًا`;
}
function overviewNameSize(table) {
  const words = table.name.split(/(?<=_)/), height = measureNode(table);
  for (let size = 44; size > 22; size -= 2) {
    const perLine = Math.floor(256 / (size * .6));
    if (words.some(word => word.length > perLine)) continue;
    let lines = 1, used = 0;
    for (const word of words) { if (used && used + word.length > perLine) { lines++; used = 0; } used += word.length; }
    if (lines <= 3 && lines * size * 1.2 + 58 + 28 <= height) return size;
  }
  return 22;
}
function makeNode(table) {
  const card = el('article', `table-node${isDraftTable(table) ? ' proposed' : ''}`);
  card.dataset.table = table.id;
  const pos = graphPosition(table.id);
  card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`;
  card.style.setProperty('--node-color', groupForTable(table).color);
  card.style.setProperty('--name-size', `${overviewNameSize(table)}px`);
  const head = el('div', 'node-head');
  const title = el('div', 'node-title'), name = el('div', 'node-name'); name.title = table.name;
  for (const part of table.name.split(/(?<=_)/)) name.append(document.createTextNode(part), document.createElement('wbr'));
  const meta = el('div', 'node-meta'); meta.append(el('span', 'node-schema', `${table.schema} · `), el('span', 'node-meta-count', columnsLabel(table.columns.length)));
  title.append(name, meta);
  const more = uiButton('', event => { event.stopPropagation(); showContextMenu(event); }, 'node-more');
  more.append(icon('more')); more.setAttribute('aria-label', `إجراءات جدول ${table.name}`);
  more.addEventListener('pointerdown', event => event.stopPropagation());
  head.append(title, ...(isDraftTable(table) ? [el('span', 'node-draft', 'مسودة')] : []), more);
  head.addEventListener('pointerdown', event => startDrag(event, table.id, card));
  const columns = el('div', 'node-columns');
  const involved = involvedColumns.get(table.id) || new Set();
  for (const column of previewColumns(table, nodeExpanded(table))) {
    const row = el('div', `column${involved.has(column.name) ? ' has-line' : ''}${column.primary ? ' pk' : ''}${isDraftColumn(table, column) ? ' proposed' : ''}`);
    row.dataset.column = column.name;
    row.title = columnTitle(table, column);
    const badge = el('span', `col-key ${column.primary ? 'pk' : column.foreign ? 'fk' : 'none'}`, column.primary ? 'PK' : column.foreign ? 'FK' : '');
    const nullable = el('span', 'col-null', column.nullable ? '?' : ''); if (column.nullable) nullable.title = 'nullable';
    row.append(badge, el('span', 'col-name', column.name), el('span', 'col-type', column.type), nullable);
    row.addEventListener('click', event => {
      if (!state.linkMode) return;
      event.stopPropagation();
      chooseLinkColumn(table.id, column.name);
    });
    columns.append(row);
  }
  card.append(head, columns);
  const footer = uiButton('', event => {
    event.stopPropagation();
    openExpandedTable(table.id);
  }, 'node-expand');
  footer.setAttribute('aria-label', `عرض كل أعمدة ${table.name}`);
  footer.setAttribute('aria-haspopup', 'dialog');
  // Say what the footer adds: the hidden columns, or the full view when every column already shows.
  const hidden = table.columns.length - previewColumns(table, nodeExpanded(table)).length;
  footer.append(icon('chevron'), el('span', '', hidden ? `عرض كل الأعمدة (+${hidden})` : 'عرض الجدول'));
  footer.addEventListener('pointerdown', event => event.stopPropagation());
  card.append(footer);
  card.tabIndex = 0; card.setAttribute('aria-label', `جدول ${table.name}`);
  card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectTable(table.id); } });
  card.addEventListener('click', event => {
    if (performance.now() < state.suppressClickUntil) return;
    selectTable(table.id, { inspect: false });
  });
  card.addEventListener('dblclick', () => selectTable(table.id));
  card.title = 'انقر للتحديد، وانقر مرتين أو اضغط Enter لعرض التفاصيل';
  card.addEventListener('mouseenter', () => {
    state.hoveredTable = table.id;
    updateEmphasis();
  });
  card.addEventListener('mouseleave', () => {
    if (state.hoveredTable === table.id) {
      state.hoveredTable = null;
      updateEmphasis();
    }
  });
  return card;
}

export function renderNodes() {
  const container = $('nodes');
  const tables = visibleTables();
  involvedColumns = indexInvolvedColumns();
  $('viewport').classList.toggle('canvas-edges', tables.length > 35);
  container.replaceChildren(...tables.map(makeNode));
  state.edgeRoutes = null;
  renderEdges();
  updateEmphasis();
  scheduleView();
}
export function searchMatches(search) {
  return new Set(state.schema.tables.filter(table =>
    table.name.toLowerCase().includes(search) || table.schema.toLowerCase().includes(search) ||
    table.columns.some(column => column.name.toLowerCase().includes(search))
  ).map(table => table.id));
}

export function rankedSearch(term) {
  if (!term) return [];
  const ids = searchMatches(term), rank = table => { const name = table.name.toLowerCase(); return name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : 3; };
  return state.schema.tables.filter(table => ids.has(table.id)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
export function updateSearchCount() {
  const output = $('searchCount'), term = $('searchInput').value.trim().toLowerCase();
  output.hidden = !term; if (!term) return;
  const total = rankedSearch(term).length;
  output.textContent = !total ? 'لا نتائج' : state.searchIndex >= 0 ? `${Math.min(state.searchIndex + 1, total)}/${total}` : String(total);
  output.classList.toggle('none', !total);
  output.title = total ? 'Enter للتالي · Shift+Enter للسابق' : '';
}
export function updateEmphasis() {
  const scopeKey = `${state.selectedTable}|${state.selectedRelation}|${state.viewMode}|${state.topic}|${state.focusTable}`;
  if (scopeKey !== state.aiScopeKey) { state.aiScopeKey = scopeKey; state.aiWide = false; updateAiSettings(); if ($('aiDialog').open && !state.aiMessages.length && !state.aiController) renderAiMessages(); }
  const active = state.groups.find(group => group.id === state.topic)?.ids;
  const search = $('searchInput').value.trim().toLowerCase();
  const matches = search ? searchMatches(search) : null;
  const focusTable = state.hoveredTable || state.selectedTable;
  const neighbors = new Set();
  if (focusTable) {
    for (const relation of allRelations()) {
      if (relation.source === focusTable) neighbors.add(relation.target);
      if (relation.target === focusTable) neighbors.add(relation.source);
    }
  }
  for (const card of $('nodes').children) {
    const id = card.dataset.table;
    const unrelated = focusTable && id !== focusTable && !neighbors.has(id);
    const dim = (state.topic !== 'all' && !active.has(id)) || (matches && !matches.has(id)) || unrelated;
    card.classList.toggle('dimmed', Boolean(dim && state.selectedTable !== id));
    card.classList.toggle('selected', state.selectedTable === id);
    card.classList.toggle('neighbor', Boolean(focusTable && neighbors.has(id)));
  }
  updateEdgeEmphasis();
}

function updateVisible() {
  const viewport = $('viewport');
  const margin = 350 / state.scale;
  const visible = { left: -state.x / state.scale - margin, top: -state.y / state.scale - margin,
    right: (viewport.clientWidth - state.x) / state.scale + margin,
    bottom: (viewport.clientHeight - state.y) / state.scale + margin };
  const overlaps = box => box && box.left <= visible.right && box.right >= visible.left && box.top <= visible.bottom && box.bottom >= visible.top;
  const byId = new Map(state.schema.tables.map(table => [table.id, table]));
  for (const card of $('nodes').children) {
    const table = byId.get(card.dataset.table), pos = graphPosition(card.dataset.table);
    if (!table || !pos) continue;
    const show = overlaps({ left: pos.x, right: pos.x + NODE_WIDTH, top: pos.y, bottom: pos.y + nodeHeight(table) });
    if (card._visible !== show) { card._visible = show; card.classList.toggle('offscreen', !show); }
  }
  for (const refs of edgeRefs.values()) for (const ref of refs) {
    const show = !ref.bounds || overlaps(ref.bounds);
    if (ref._visible !== show) {
      ref._visible = show;
      ref.line.classList.toggle('offscreen', !show);
      ref.hit.classList.toggle('offscreen', !show);
      for (const label of Object.values(ref.labels || {})) label.classList.toggle('offscreen', !show);
    }
  }
}
export function scheduleView() {
  if (!state.schema) return;
  if (state.viewFrame) return;
  state.viewFrame = requestAnimationFrame(() => {
    state.viewFrame = null;
    const overview = state.scale < .42;
    $('viewport').classList.toggle('overview', overview);
    if (overview !== Boolean(state.overviewMode)) { state.overviewMode = overview; state.edgeRoutes = null; renderEdges(); }
    $('world').style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    $('zoomLabel').textContent = `${Math.round(state.scale * 100)}%`;
    updateVisible();
    drawCanvasEdges();
  });
}

export function transform() {
  scheduleView();
}

export function fitView(focusTopic = false, { overview = false } = {}) {
  const viewport = $('viewport');
  const ids = focusTopic && state.viewMode === 'map' ? state.groups.find(group => group.id === state.topic)?.ids : null;
  const tables = ids ? state.schema.tables.filter(table => ids.has(table.id)) : visibleTables();
  if (!tables.length) { state.scale = 1; state.x = 0; state.y = 0; transform(); return; }
  const minX = Math.min(...tables.map(table => graphPosition(table.id).x));
  const minY = Math.min(...tables.map(table => graphPosition(table.id).y));
  const maxX = Math.max(...tables.map(table => graphPosition(table.id).x + NODE_WIDTH));
  const maxY = Math.max(...tables.map(table => graphPosition(table.id).y + nodeHeight(table)));
  const idsInView = new Set(tables.map(table => table.id));
  const degree = new Map(tables.map(table => [table.id, 0]));
  for (const relation of visibleRelations()) {
    if (idsInView.has(relation.source)) degree.set(relation.source, degree.get(relation.source) + 1);
    if (idsInView.has(relation.target)) degree.set(relation.target, degree.get(relation.target) + 1);
  }
  const centerTable = tables.find(table => table.id === (state.selectedTable || state.focusTable)) || [...tables].sort((a, b) => degree.get(b.id) - degree.get(a.id))[0];
  const point = graphPosition(centerTable.id);
  Object.assign(state, fitCamera({ width: maxX - minX, height: maxY - minY, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } },
    { width: viewport.clientWidth, height: Math.max(160, viewport.clientHeight - 88) }, { overview, center: { x: point.x + NODE_WIDTH / 2, y: point.y + nodeHeight(centerTable) / 2 } }));
  transform();
}
export function centerTable(id) {
  const viewport = $('viewport');
  const table = state.schema.tables.find(item => item.id === id); if (!table) return;
  const point = graphPosition(id);
  state.scale = 1;
    const panelWidth = !$('details').hidden && viewport.clientWidth > 800 ? $('details').offsetWidth : 0;
  state.x = (viewport.clientWidth - panelWidth) / 2 - (point.x + NODE_WIDTH / 2);
  state.y = viewport.clientHeight / 2 - (point.y + nodeHeight(table) / 2);
  transform();
}

export function zoom(factor, clientX, clientY) {
  const rect = $('viewport').getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const next = Math.max(.15, Math.min(2, state.scale * factor));
  const ratio = next / state.scale;
  state.x = px - (px - state.x) * ratio;
  state.y = py - (py - state.y) * ratio;
  state.scale = next;
  transform();
}

function startDrag(event, id, card) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  card.querySelector('.node-head').setPointerCapture(event.pointerId);
  const origin = graphPosition(id);
  state.drag = { type: 'node', id, card, startX: event.clientX, startY: event.clientY,
    originX: origin.x, originY: origin.y, moved: false };
}

export function selectTable(id, { inspect = true } = {}) {
  if (state.viewMode === 'focus' && state.focusTable !== id) chooseFocusTable(id);
  state.selectedTable = id; state.selectedRelation = null;
  updateEmphasis();
  if (inspect || !$('details').hidden) renderDetails();
}

export function selectRelation(id) {
  state.selectedRelation = id; state.selectedTable = null;
  updateEmphasis(); $('details').hidden = true; openRelationDetails(id);
}
