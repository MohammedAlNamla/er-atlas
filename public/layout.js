// Where tables sit: visible scope, automatic layouts per view, and the arrange dialog.
import { store } from './storage.js';
import { tabs as uiTabs, openDialog, renderMiniMap, NODE_WIDTH, nodeHeight as measureNode } from './ui.js';
import { $, state, storageKey, el, showToast } from './core.js';
import { renderNodes, fitView } from './canvas.js';
import { askAi, providerLabel } from './ai.js';
// Arranging reaches rendering, toasts and AI through these, so tests can run it without a page.
export const hooks = {
  renderNodes: () => renderNodes(), fitView: (...args) => fitView(...args), showToast: message => showToast(message),
  askAi: (...args) => askAi(...args), renderArrangement: () => renderArrangement()
};
export const graphPosition = id => state.focusPositions?.get(id) || state.topicPositions?.get(id) || state.positions.get(id);
export function visibleTables() {
  if (state.viewMode === 'focus') {
    if (!state.focusTable) return [];
    const ids = new Set([state.focusTable]);
    for (const relation of state.schema.relations) {
      if (relation.source === state.focusTable) ids.add(relation.target);
      if (relation.target === state.focusTable) ids.add(relation.source);
    }
    return state.schema.tables.filter(table => ids.has(table.id));
  }
  if (state.viewMode === 'topics' && state.topic === 'all') return [];
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    const ids = state.groups.find(group => group.id === state.topic)?.ids;
    return state.schema.tables.filter(table => ids?.has(table.id));
  }
  return state.schema.tables;
}
export function visibleRelations() {
  if (state.viewMode === 'focus') return state.schema.relations.filter(relation =>
    relation.source === state.focusTable || relation.target === state.focusTable);
  if (state.viewMode === 'topics' && state.topic === 'all') return [];
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    const ids = state.groups.find(group => group.id === state.topic)?.ids;
    return state.schema.relations.filter(relation => ids?.has(relation.source) && ids.has(relation.target));
  }
  return state.schema.relations;
}
export function buildFocusPositions() {
  if (state.viewMode !== 'focus' || !state.focusTable) { state.focusPositions = null; return; }
  const center = state.schema.tables.find(table => table.id === state.focusTable);
  if (!center) { state.focusTable = null; state.focusPositions = null; return; }
  const neighbors = visibleTables().filter(table => table.id !== center.id);
  const sides = [[], []];
  neighbors.sort((a, b) => a.name.localeCompare(b.name));
  neighbors.forEach((table, index) => sides[index % 2].push(table));
  const height = tables => tables.reduce((total, table) => total + nodeHeight(table) + 80, 0);
  const totalHeight = Math.max(nodeHeight(center) + 200, height(sides[0]), height(sides[1]));
  const positions = new Map([[center.id, { x: 520, y: Math.round((totalHeight - nodeHeight(center)) / 2) }]]);
  sides.forEach((tables, side) => {
    let y = Math.round((totalHeight - height(tables)) / 2) + 44;
    for (const table of tables) { positions.set(table.id, { x: side === 0 ? 60 : 980, y }); y += nodeHeight(table) + 80; }
  });
  state.focusPositions = positions;
  try {
    const saved = JSON.parse(store.getItem(`${storageKey()}.focusLayout.${state.focusTable}`) || '{}');
    for (const [id] of positions) {
      const point = saved[id];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) positions.set(id, point);
    }
  } catch { /* ignore invalid saved positions */ }
}
export function buildTopicPositions() {
  if (state.viewMode !== 'topics' || state.topic === 'all') { state.topicPositions = null; return; }
  const group = state.groups.find(item => item.id === state.topic);
  if (!group) { state.topicPositions = null; return; }
  const tables = state.schema.tables.filter(table => group.ids.has(table.id));
  if (!tables.length) { state.topicPositions = new Map(); return; }
  const degree = new Map(tables.map(table => [table.id, 0]));
  for (const relation of state.schema.relations) if (degree.has(relation.source) && degree.has(relation.target)) {
    degree.set(relation.source, degree.get(relation.source) + 1);
    degree.set(relation.target, degree.get(relation.target) + 1);
  }
  tables.sort((a, b) => degree.get(b.id) - degree.get(a.id) || a.name.localeCompare(b.name));
  const columns = Math.max(1, Math.ceil(Math.sqrt(tables.length * 1.4)));
  const rows = Math.ceil(tables.length / columns);
  const cells = Array.from({ length: columns * rows }, (_, index) => ({ col: index % columns, row: Math.floor(index / columns) }));
  cells.sort((a, b) => {
    const distance = cell => Math.abs(cell.col - (columns - 1) / 2) + Math.abs(cell.row - (rows - 1) / 2);
    return distance(a) - distance(b) || a.row - b.row || a.col - b.col;
  });
  const assignments = tables.map((table, index) => ({ table, ...cells[index] }));
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...assignments.filter(item => item.row === row).map(item => nodeHeight(item.table))));
  const rowTops = []; let y = 72;
  for (const height of rowHeights) { rowTops.push(y); y += height + 120; }
  state.topicPositions = new Map(assignments.map(item => [item.table.id,
    { x: 80 + item.col * 440, y: rowTops[item.row] + Math.round((rowHeights[item.row] - nodeHeight(item.table)) / 2) }]));
  try {
    const saved = JSON.parse(store.getItem(`${storageKey()}.topicLayout.${state.topic}`) || '{}');
    for (const table of tables) {
      const point = saved[table.id];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) state.topicPositions.set(table.id, point);
    }
  } catch { /* invalid topic layout is ignored */ }
}
export function nodeExpanded() { return state.linkMode; }
export function nodeHeight(table) { return measureNode(table, nodeExpanded(table)); }
export const snap4 = value => Math.round(value / 4) * 4;
export function layoutTables(schema = state.schema, aiLayout = state.aiLayout) {
  const tables = [...schema.tables];
  if (!tables.length) return new Map();
  const byId = new Map(tables.map(table => [table.id, table]));
  // Heights are fixed for a given render; computing them per pair made large graphs freeze.
  const heights = new Map(tables.map(table => [table.id, nodeHeight(table)]));
  const h = table => heights.get(table.id);
  const links = [];
  const adjacency = new Map(tables.map(table => [table.id, new Map()]));
  for (const relation of schema.relations) {
    if (relation.source === relation.target || !byId.has(relation.source) || !byId.has(relation.target)) continue;
    const weight = Math.max(1, relation.pairs?.length || 1);
    links.push({ source: relation.source, target: relation.target, weight });
    adjacency.get(relation.source).set(relation.target, (adjacency.get(relation.source).get(relation.target) || 0) + weight);
    adjacency.get(relation.target).set(relation.source, (adjacency.get(relation.target).get(relation.source) || 0) + weight);
  }

  // Degree carries most of the score. A short PageRank pass also rewards tables
  // connected to other important tables, which keeps the real schema hubs central.
  const count = tables.length;
  let pageRank = new Map(tables.map(table => [table.id, 1 / count]));
  for (let iteration = 0; iteration < 18; iteration++) {
    const next = new Map(tables.map(table => [table.id, .15 / count]));
    for (const table of tables) {
      const neighbors = adjacency.get(table.id);
      if (!neighbors.size) { next.set(table.id, next.get(table.id) + .85 * pageRank.get(table.id) / count); continue; }
      const totalWeight = [...neighbors.values()].reduce((sum, value) => sum + value, 0);
      for (const [neighbor, weight] of neighbors) next.set(neighbor, next.get(neighbor) + .85 * pageRank.get(table.id) * weight / totalWeight);
    }
    pageRank = next;
  }
  const degrees = new Map(tables.map(table => [table.id, [...adjacency.get(table.id).values()].reduce((sum, value) => sum + value, 0)]));
  const maxDegree = Math.max(1, ...degrees.values());
  const maxRank = Math.max(...pageRank.values());
  const score = id => .76 * degrees.get(id) / maxDegree + .24 * pageRank.get(id) / maxRank;
  const ordered = [...tables].sort((a, b) => score(b.id) - score(a.id) || a.name.localeCompare(b.name));
  const points = new Map();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const aiZones = aiLayout?.zones?.filter(zone => zone.tableIds?.length) || [];
  const zoneByTable = new Map();
  const zoneAnchors = new Map();
  const hasAiZones = aiZones.length > 1;
  if (hasAiZones) {
    aiZones.forEach((zone, index) => zone.tableIds.forEach(id => zoneByTable.set(id, index)));
    const centralIds = new Set(aiLayout.centralTableIds || []);
    const primaryIndex = aiZones.findIndex(zone => zone.tableIds.some(id => centralIds.has(id)));
    const zoneOrder = aiZones.map((zone, index) => ({ zone, index, weight: zone.tableIds.reduce((sum, id) => sum + score(id), 0) }))
      .sort((a, b) => (a.index === primaryIndex ? -1 : b.index === primaryIndex ? 1 : b.weight - a.weight));
    const outerCount = zoneOrder.length - 1;
    zoneOrder.forEach((item, order) => {
      if (order === 0) { zoneAnchors.set(item.index, { x: 0, y: 0 }); return; }
      const angle = -Math.PI / 2 + (order - 1) / outerCount * Math.PI * 2;
      const radius = 1280 + Math.min(4, outerCount) * 110;
      zoneAnchors.set(item.index, { x: Math.cos(angle) * radius * 1.42, y: Math.sin(angle) * radius * .78 });
    });
    for (const zone of aiZones) {
      const index = aiZones.indexOf(zone), anchor = zoneAnchors.get(index);
      zone.tableIds.map(id => byId.get(id)).filter(Boolean).sort((a, b) => score(b.id) - score(a.id) || a.name.localeCompare(b.name))
        .forEach((table, localIndex) => {
          const radius = localIndex ? 285 * Math.sqrt(localIndex) : 0;
          const angle = localIndex * goldenAngle;
          points.set(table.id, { x: anchor.x + Math.cos(angle) * radius * 1.25, y: anchor.y + Math.sin(angle) * radius * .78, vx: 0, vy: 0 });
        });
    }
  }
  ordered.forEach((table, index) => {
    if (points.has(table.id)) return;
    const radius = index ? 345 * Math.sqrt(index) : 0;
    const angle = index * goldenAngle;
    points.set(table.id, { x: Math.cos(angle) * radius * 1.72, y: Math.sin(angle) * radius * .62, vx: 0, vy: 0 });
  });

  const iterations = count > 150 ? 72 : count > 90 ? 92 : 118;
  const preferredLength = count > 110 ? 540 : 470;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cooling = 1 - iteration / iterations;
    const temperature = 8 + 54 * cooling;
    for (const point of points.values()) { point.vx = 0; point.vy = 0; }

    for (let aIndex = 0; aIndex < ordered.length; aIndex++) {
      const a = ordered[aIndex], ap = points.get(a.id);
      for (let bIndex = aIndex + 1; bIndex < ordered.length; bIndex++) {
        const b = ordered[bIndex], bp = points.get(b.id);
        let dx = bp.x - ap.x, dy = bp.y - ap.y;
        if (!dx && !dy) dx = .01;
        if (Math.abs(dx) > 1500 || Math.abs(dy) > 1500) continue;
        const distance2 = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distance2);
        const force = Math.min(54, 185000 / distance2);
        const fx = dx / distance * force, fy = dy / distance * force;
        ap.vx -= fx; ap.vy -= fy; bp.vx += fx; bp.vy += fy;

        const overlapX = (NODE_WIDTH + 96) - Math.abs(dx);
        const overlapY = ((h(a) + h(b)) / 2 + 72) - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = overlapX * .12 * (dx >= 0 ? 1 : -1);
            ap.vx -= push; bp.vx += push;
          } else {
            const push = overlapY * .12 * (dy >= 0 ? 1 : -1);
            ap.vy -= push; bp.vy += push;
          }
        }
      }
    }
    for (const link of links) {
      const a = points.get(link.source), b = points.get(link.target);
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const sameZone = hasAiZones && zoneByTable.get(link.source) === zoneByTable.get(link.target);
      const targetLength = preferredLength * (sameZone ? .92 : hasAiZones ? 1.62 : 1);
      const stretch = (distance - targetLength) * .014 * Math.min(2.2, link.weight);
      const fx = dx / distance * stretch, fy = dy / distance * stretch;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    ordered.forEach((table, index) => {
      const point = points.get(table.id);
      const pull = .003 + score(table.id) * .014;
      const globalPull = hasAiZones ? .34 : 1;
      point.vx -= point.x * pull * .64 * globalPull; point.vy -= point.y * pull * 1.16 * globalPull;
      const anchor = zoneAnchors.get(zoneByTable.get(table.id));
      if (anchor) { point.vx += (anchor.x - point.x) * .009; point.vy += (anchor.y - point.y) * .009; }
      if (index === 0 && !hasAiZones) { point.vx -= point.x * .18; point.vy -= point.y * .18; }
      const length = Math.max(1, Math.hypot(point.vx, point.vy));
      const step = Math.min(temperature, length);
      point.x += point.vx / length * step; point.y += point.vy / length * step;
    });
  }

  // A final collision pass preserves generous whitespace after the graph settles.
  for (let pass = 0; pass < 70; pass++) {
    let moved = false;
    for (let aIndex = 0; aIndex < ordered.length; aIndex++) {
      const a = ordered[aIndex], ap = points.get(a.id);
      for (let bIndex = aIndex + 1; bIndex < ordered.length; bIndex++) {
        const b = ordered[bIndex], bp = points.get(b.id);
        const dx = bp.x - ap.x || .01, dy = bp.y - ap.y || .01;
        const overlapX = NODE_WIDTH + 88 - Math.abs(dx);
        const overlapY = (h(a) + h(b)) / 2 + 64 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        if (overlapX < overlapY) {
          const push = overlapX / 2 + 1, direction = dx >= 0 ? 1 : -1;
          ap.x -= push * direction; bp.x += push * direction;
        } else {
          const push = overlapY / 2 + 1, direction = dy >= 0 ? 1 : -1;
          ap.y -= push * direction; bp.y += push * direction;
        }
      }
    }
    if (!moved) break;
  }
  const minX = Math.min(...ordered.map(table => points.get(table.id).x - NODE_WIDTH / 2));
  const minY = Math.min(...ordered.map(table => points.get(table.id).y - h(table) / 2));
  const result = new Map(ordered.map(table => [table.id, {
    x: Math.round(points.get(table.id).x - NODE_WIDTH / 2 - minX + 110),
    y: Math.round(points.get(table.id).y - h(table) / 2 - minY + 110)
  }]));

  // Match the graph footprint to the actual canvas. Large schemas previously
  // filled the height while wasting most of a wide monitor's horizontal space.
  if (count >= 18) {
    const viewport = $('viewport');
    const viewAspect = viewport?.clientWidth && viewport?.clientHeight ? viewport.clientWidth / viewport.clientHeight : 1.8;
    const left = Math.min(...ordered.map(table => result.get(table.id).x));
    const right = Math.max(...ordered.map(table => result.get(table.id).x + NODE_WIDTH));
    const top = Math.min(...ordered.map(table => result.get(table.id).y));
    const bottom = Math.max(...ordered.map(table => result.get(table.id).y + h(table)));
    const graphWidth = right - left, graphHeight = bottom - top;
    const desiredAspect = Math.max(1.55, Math.min(2.75, viewAspect * .94));
    const desiredWidth = graphHeight * desiredAspect;
    const stretchX = Math.max(1, Math.min(2.8, (desiredWidth - NODE_WIDTH) / Math.max(1, graphWidth - NODE_WIDTH)));
    if (stretchX > 1.03) {
      const centerX = (left + right) / 2;
      for (const table of ordered) {
        const point = result.get(table.id);
        const nodeCenter = point.x + NODE_WIDTH / 2;
        point.x = Math.round(centerX + (nodeCenter - centerX) * stretchX - NODE_WIDTH / 2);
      }
    }
  }
  for (const point of result.values()) { point.x = snap4(point.x); point.y = snap4(point.y); }
  return result;
}
export function aiLayoutKey() { return `${storageKey()}.ai-layout`; }
function saveAiLayout() { store.setItem(aiLayoutKey(), JSON.stringify(state.aiLayout)); }

export function loadPositions() {
  state.positions = layoutTables();
  let saved = {};
  try {
    saved = JSON.parse(store.getItem(storageKey()) || '{}') || {};
    for (const table of state.schema.tables) {
      const point = saved[table.id];
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) state.positions.set(table.id, point);
    }
  } catch { /* invalid old layout is ignored */ }

}

export function savePositions() {
  store.setItem(storageKey(), JSON.stringify(Object.fromEntries(state.positions)));
}
export function arrangeTables() {
  state.hoveredTable = null;
  if (state.viewMode === 'focus' && state.focusTable) {
    store.removeItem(`${storageKey()}.focusLayout.${state.focusTable}`);
    buildFocusPositions(); hooks.renderNodes(); requestAnimationFrame(() => hooks.fitView(false));
    hooks.showToast('أُعيد ترتيب الجدول وعلاقاته'); return;
  }
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    store.removeItem(`${storageKey()}.topicLayout.${state.topic}`);
    buildTopicPositions(); hooks.renderNodes(); requestAnimationFrame(() => hooks.fitView(true));
    hooks.showToast('أُعيد ترتيب جداول الموضوع'); return;
  }
  state.hoveredTable = null; state.positions = layoutTables(); savePositions(); hooks.renderNodes(); requestAnimationFrame(() => hooks.fitView(state.topic !== 'all'));
  hooks.showToast('وُزعت الجداول على كامل مساحة الخريطة حسب قوة الترابط');
}
export function normalizeAiLayout(value, tables = state.schema.tables) {
  const source = Array.isArray(value) ? { zones: value } : value;
  if (!source || !Array.isArray(source.zones)) throw new Error('اقتراح الترتيب من AI غير صالح');
  const validIds = new Set(tables.map(table => table.id));
  const used = new Set();
  const zones = source.zones.slice(0, 10).map((zone, index) => {
    const ids = [...new Set(Array.isArray(zone.tableIds) ? zone.tableIds : [])]
      .filter(id => validIds.has(id) && !used.has(id));
    ids.forEach(id => used.add(id));
    return { name: String(zone.name || `منطقة ${index + 1}`).trim().slice(0, 48), reason: String(zone.reason || '').trim().slice(0, 200), tableIds: ids };
  }).filter(zone => zone.tableIds.length);
  if (!zones.length) throw new Error('لم يحدد AI أي جدول صالح للترتيب');
  const remaining = [...validIds].filter(id => !used.has(id));
  if (remaining.length) zones.push({ name: 'جداول مترابطة أخرى', tableIds: remaining });
  const centralTableIds = [...new Set(Array.isArray(source.centralTableIds) ? source.centralTableIds : [])].filter(id => validIds.has(id));
  return { zones, centralTableIds };
}
function parseAiLayout(answer, tables = state.schema.tables) {
  const cleaned = answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return normalizeAiLayout(JSON.parse(cleaned), tables);
}
export function captureArrangement(mode = 'relations') {
  const tables = visibleTables(), ids = new Set(tables.map(table => table.id));
  const schema = { ...state.schema, tables, relations: visibleRelations().filter(relation => ids.has(relation.source) && ids.has(relation.target)) };
  return { workspaceId: state.workspaceId, viewMode: state.viewMode, topic: state.topic, focusTable: state.focusTable,
    snapshot: JSON.stringify(state.schema), schema, mode, current: new Map(tables.map(table => [table.id, { ...graphPosition(table.id) }])),
    proposed: mode === 'relations' ? layoutTables(schema, null) : null, layout: null, pending: false, error: '', status: '' };
}
function arrangementIsCurrent(proposal) {
  return proposal.workspaceId === state.workspaceId && proposal.snapshot === JSON.stringify(state.schema) && proposal.viewMode === state.viewMode && proposal.topic === state.topic && proposal.focusTable === state.focusTable;
}
export function openArrangement(mode = 'relations') {
  if (!visibleTables().length) { showToast('افتح موضوعًا أو اختر جدولًا قبل الترتيب'); return; }
  state.layoutController?.abort(); state.arrangement = captureArrangement(mode); renderArrangement(); openDialog($('arrangeDialog'));
}
function renderArrangement() {
  const proposal = state.arrangement; if (!proposal) return;
  const modes = uiTabs([['relations', 'حسب الترابط'], ['ai', 'بالـAI']], proposal.mode, mode => {
    if (proposal.pending) return; state.arrangement = captureArrangement(mode); renderArrangement();
  }); modes.id = 'arrangeModes'; $('arrangeModes').replaceWith(modes);
  $('arrangeScope').value = state.viewMode === 'focus' ? `جدول محدد · ${state.schema.tables.find(table => table.id === state.focusTable)?.name || ''}`
    : state.topic === 'all' ? `كل المخطط · ${proposal.schema.tables.length} جدول` : `الموضوع الحالي · ${state.groups.find(group => group.id === state.topic)?.label || ''}`;
  $('arrangeProvider').value = providerLabel();
  renderMiniMap($('currentLayoutPreview'), proposal.schema.tables, proposal.schema.relations, proposal.current, NODE_WIDTH, nodeHeight);
  const preview = $('proposedLayoutPreview');
  if (proposal.proposed) renderMiniMap(preview, proposal.schema.tables, proposal.schema.relations, proposal.proposed, NODE_WIDTH, nodeHeight);
  else if (proposal.pending) {
    const loading = el('div', 'layout-pending'); for (let i = 0; i < 3; i++) loading.append(el('div', 'skeleton')); preview.replaceChildren(loading);
  } else preview.replaceChildren(el('p', 'field-hint', proposal.error ? 'تعذّر إنشاء المعاينة. يمكنك إعادة المحاولة.' : 'اضغط «اقتراح ترتيب» لإنشاء المعاينة.'));
  $('arrangeStatus').className = `notice${proposal.error ? ' error' : ''}`;
  $('arrangeStatus').textContent = proposal.error || proposal.status || `معاينة ${proposal.schema.tables.length} جدول. تتغيّر المواقع فقط؛ تبقى تعريفات الجداول وعلاقاتها كما هي.`;
  const zones = $('arrangeZones'); zones.replaceChildren();
  if (proposal.layout && !proposal.error) {
    const names = new Map(proposal.schema.tables.map(table => [table.id, table.name]));
    for (const zone of proposal.layout.zones) {
      const item = el('li', 'arrange-zone'), head = el('div', 'arrange-zone-head');
      head.append(el('strong', '', zone.name), el('span', 'chip', `${zone.tableIds.length} جدول`));
      item.append(head);
      if (zone.reason) item.append(el('p', 'field-hint', zone.reason));
      item.append(el('p', 'arrange-zone-tables', zone.tableIds.map(id => names.get(id)).filter(Boolean).slice(0, 8).join(' · ') + (zone.tableIds.length > 8 ? ` · +${zone.tableIds.length - 8}` : '')));
      zones.append(item);
    }
    const central = proposal.layout.centralTableIds.map(id => names.get(id)).filter(Boolean);
    if (central.length) zones.append(el('li', 'arrange-central', `الجداول المحورية في المركز: ${central.join(' · ')}`));
  }
  $('arrangeErrorActions').hidden = !proposal.error;
  $('applyArrangementButton').disabled = proposal.pending;
  $('applyArrangementButton').textContent = proposal.pending ? 'جارٍ التحليل…' : proposal.proposed ? 'تطبيق الترتيب' : proposal.error ? 'إعادة المحاولة' : 'اقتراح ترتيب';
  $('stopArrangementButton').hidden = !proposal.pending;
}
export function applyArrangement() {
  const proposal = state.arrangement; if (!proposal?.proposed || proposal.pending) return false;
  if (!arrangementIsCurrent(proposal)) { hooks.showToast('تغيرت المساحة أو طريقة العرض. أعد اقتراح الترتيب.'); return false; }
  const persist = $('persistArrangement').checked !== false;
  if (proposal.viewMode === 'topics') {
    state.topicPositions = proposal.proposed;
    if (persist) store.setItem(`${storageKey()}.topicLayout.${proposal.topic}`, JSON.stringify(Object.fromEntries(proposal.proposed)));
  } else if (proposal.viewMode === 'focus') {
    state.focusPositions = proposal.proposed;
    if (persist) store.setItem(`${storageKey()}.focusLayout.${proposal.focusTable}`, JSON.stringify(Object.fromEntries(proposal.proposed)));
  } else {
    state.aiLayout = proposal.layout; state.positions = proposal.proposed;
    if (persist) { saveAiLayout(); savePositions(); }
  }
  state.hoveredTable = null; hooks.renderNodes(); requestAnimationFrame(() => hooks.fitView(false));
  hooks.showToast('تم تطبيق ترتيب الجداول'); return true;
}
export async function arrangeWithAi() {
  state.arrangement ||= captureArrangement('ai');
  const proposal = state.arrangement;
  if (!proposal.schema.tables.length || proposal.pending) return;
  proposal.mode = 'ai'; proposal.pending = true; proposal.error = ''; proposal.status = 'يجري تحليل الجداول والعلاقات لتحديد المناطق والجداول المحورية…';
  state.layoutController = new AbortController();
  const controller = state.layoutController;
  hooks.renderArrangement();
  try {
    const answer = await hooks.askAi('layout', 'رتّب الجداول المعروضة إلى مناطق مفهومة وقلل الخطوط العابرة بين المناطق.', proposal.schema, controller.signal);
    if (controller.signal.aborted || state.arrangement !== proposal) return;
    if (!arrangementIsCurrent(proposal)) throw new Error('تغيرت المساحة أو طريقة العرض أثناء الترتيب. أعد المحاولة.');
    proposal.layout = parseAiLayout(answer, proposal.schema.tables);
    proposal.proposed = layoutTables(proposal.schema, proposal.layout);
    proposal.status = `اقتراح ${proposal.schema.tables.length} جدول في ${proposal.layout.zones.length} مناطق. راجع المناطق أدناه قبل التطبيق.`;
  } catch (error) {
    proposal.error = error.name === 'AbortError' ? '' : error.message;
    if (error.name === 'AbortError') proposal.status = 'أُوقف الطلب. يمكنك إنشاء اقتراح جديد.';
    proposal.proposed = null;
  } finally {
    proposal.pending = false;
    if (state.arrangement === proposal) hooks.renderArrangement();
    if (state.layoutController === controller) state.layoutController = null;
  }
}
