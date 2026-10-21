// Relation wires: routing, crow's-foot ends, SVG or canvas painting, hit testing.
import { routeConnections } from './router.js';
import { NODE_WIDTH, columnOffset, relationCardinality } from './ui.js';
import { $, state } from './core.js';
import { edgeColors } from './chrome.js';
import { graphPosition, visibleTables, visibleRelations, nodeExpanded, nodeHeight } from './layout.js';
import { searchMatches, scheduleView, selectRelation } from './canvas.js';
import { isDraftRelation } from './editor.js';
export const edgeRefs = new Map();
function anchor(table, columnName, side, end) {
  const pos = graphPosition(table.id), slot = end ? state.overviewSlots?.get(end) : undefined;
  return {
    x: pos.x + (side === 'right' ? NODE_WIDTH : 0),
    y: pos.y + (slot !== undefined ? slot : columnOffset(table, columnName, nodeExpanded(table)))
  };
}

// Overview scale hides the rows, so a wire anchored to its column would end at a random
// height. Instead each tile's wires share its middle band, ordered by where the other
// table sits so they leave without crossing each other.
function overviewSlots(relations, byId) {
  const center = table => graphPosition(table.id).y + nodeHeight(table) / 2;
  const ends = new Map();
  const add = (id, end, other) => { if (!ends.has(id)) ends.set(id, []); ends.get(id).push({ end, other }); };
  for (const relation of relations) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    add(source.id, `${relation.id}:0:s`, center(target));
    add(target.id, `${relation.id}:0:t`, center(source));
  }
  const slots = new Map();
  for (const [id, list] of ends) {
    const height = nodeHeight(byId.get(id));
    list.sort((a, b) => a.other - b.other);
    const step = list.length > 1 ? Math.min(26, (height - 48) / (list.length - 1)) : 0;
    list.forEach((item, index) => slots.set(item.end, height / 2 + (index - (list.length - 1) / 2) * step));
  }
  return slots;
}

function routingBoxes() {
  return visibleTables().map(table => {
    const position = graphPosition(table.id);
    return { id: table.id, left: position.x, right: position.x + NODE_WIDTH,
      top: position.y, bottom: position.y + nodeHeight(table) };
  });
}

function routingConnection(source, target, pair, lane, key) {
  return { key, sourceId: source.id, targetId: target.id, lane,
    source: { left: anchor(source, pair.source, 'left', `${key}:s`), right: anchor(source, pair.source, 'right', `${key}:s`) },
    target: { left: anchor(target, pair.target, 'left', `${key}:t`), right: anchor(target, pair.target, 'right', `${key}:t`) } };
}

function edgePath(sourceTable, targetTable, pair, lane = 0, key = '') {
  const s = key && `${key}:s`, t = key && `${key}:t`;
  const sourcePos = graphPosition(sourceTable.id);
  const targetPos = graphPosition(targetTable.id);
  if (sourceTable.id === targetTable.id) {
    const a = anchor(sourceTable, pair.source, 'right', s);
    const b = anchor(targetTable, pair.target, 'right', t);
    const loop = 80 + Math.abs(a.y - b.y) * .25 + Math.abs(lane);
    return { d: `M ${a.x} ${a.y} C ${a.x + loop} ${a.y - 25}, ${b.x + loop} ${b.y + 25}, ${b.x} ${b.y}`, a, b };
  }
  if (Math.abs(sourcePos.x - targetPos.x) < NODE_WIDTH * .6) {
    const useRight = sourcePos.x > 180 && lane > 0;
    const side = useRight ? 'right' : 'left';
    const a = anchor(sourceTable, pair.source, side, s);
    const b = anchor(targetTable, pair.target, side, t);
    const outerX = side === 'left' ? Math.min(a.x, b.x) - 92 - Math.abs(lane) : Math.max(a.x, b.x) + 92 + Math.abs(lane);
    return { d: `M ${a.x} ${a.y} L ${outerX} ${a.y} C ${outerX + lane * .15} ${a.y}, ${outerX + lane * .15} ${b.y}, ${outerX} ${b.y} L ${b.x} ${b.y}`, a, b };
  }
  const sourceSide = sourcePos.x + NODE_WIDTH / 2 < targetPos.x + NODE_WIDTH / 2 ? 'right' : 'left';
  const targetSide = sourceSide === 'right' ? 'left' : 'right';
  const a = anchor(sourceTable, pair.source, sourceSide, s);
  const b = anchor(targetTable, pair.target, targetSide, t);
  const direction = sourceSide === 'right' ? 1 : -1;
  const sourceStub = a.x + 32 * direction, targetStub = b.x - 32 * direction;
  const center = (sourceStub + targetStub) / 2 + lane;
  return { d: `M ${a.x} ${a.y} L ${sourceStub} ${a.y} C ${center} ${a.y}, ${center} ${b.y}, ${targetStub} ${b.y} L ${b.x} ${b.y}`, a, b };
}

function syncEdgeAnnotations(ref, path) {
  const a = path.points?.[0] || path.a, b = path.points?.at(-1) || path.b;
  if (!a || !b) return;
  const sourceSide = Math.abs(a.x - graphPosition(ref.source.id).x) < 1 ? -1 : 1;
  const targetSide = Math.abs(b.x - graphPosition(ref.target.id).x) < 1 ? -1 : 1;
  ref.arrow = { x: b.x, y: b.y, direction: -targetSide };
  ref.ends = { start: { x: a.x, y: a.y, dir: sourceSide }, end: { x: b.x, y: b.y, dir: targetSide } };
  ref.annotations = [];
  for (const [side, point, outward] of [['source', a, sourceSide], ['target', b, targetSide]]) {
    const label = ref.labels?.[side];
    if (!label) continue;
    const annotation = { x: point.x + outward * 18, y: point.y - 10, text: label.textContent };
    label.setAttribute('x', annotation.x);
    label.setAttribute('y', annotation.y);
    ref.annotations.push(annotation);
  }
}

const ER_MARKERS = {
  many: [['path', { d: 'M 6 10 L 20 3 M 6 10 L 20 10 M 6 10 L 20 17' }]],
  one: [['path', { d: 'M 13 3 L 13 17' }]],
  'one-only': [['path', { d: 'M 9 3 L 9 17 M 14 3 L 14 17' }]],
  'zero-one': [['circle', { cx: 6, cy: 10, r: 3.5, class: 'er-hole' }], ['path', { d: 'M 14 3 L 14 17' }]]
};
// Ends follow schema evidence only: many/one at the FK side when uniqueness is known,
// exactly-one or zero-or-one at the referenced key depending on FK nullability.
function relationEnds(relation, source, target) {
  // Schema-sourced and imported relations carry real uniqueness; only draft additions stay cautious.
  const cardinality = relationCardinality(isDraftRelation(relation) ? relation : { ...relation, kind: 'actual' }, source, target);
  const optional = relation.pairs.some(pair => source.columns.find(column => column.name === pair.source)?.nullable);
  return { start: cardinality.source === '1' ? 'one' : cardinality.source === '*' ? 'many' : '', end: cardinality.target === '1' ? (optional ? 'zero-one' : 'one-only') : '' };
}
function drawErEnd(context, point, kind) {
  const k = state.overviewMode ? 1.8 : 1, at = distance => point.x + point.dir * distance * k;
  context.beginPath();
  const h = 7 * k;
  if (kind === 'many') { context.moveTo(at(14), point.y); context.lineTo(at(0), point.y - h); context.moveTo(at(14), point.y); context.lineTo(at(0), point.y + h); }
  if (kind === 'one') { context.moveTo(at(7), point.y - h); context.lineTo(at(7), point.y + h); }
  if (kind === 'one-only') for (const distance of [6, 11]) { context.moveTo(at(distance), point.y - h); context.lineTo(at(distance), point.y + h); }
  if (kind === 'zero-one') { context.moveTo(at(6), point.y - h); context.lineTo(at(6), point.y + h); }
  context.stroke();
  if (kind === 'zero-one') { context.beginPath(); context.arc(at(14), point.y, 3.5 * k, 0, Math.PI * 2); context.fillStyle = edgeColors().halo; context.fill(); context.stroke(); }
}
export function renderEdges() {
  const generation = ++state.routeGeneration;
  const svg = $('edges');
  const canvasMode = visibleTables().length > 35, overview = Boolean(state.overviewMode), markerScale = overview ? 1.8 : 1;
  svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  // Crow's-foot ends. Each marker is drawn with the table edge at x=20 and grows outward;
  // auto-start-reverse lets the same shape serve the start (FK) and end (PK) of a wire.
  const defs = document.createElementNS(ns, 'defs');
  for (const [id, parts] of Object.entries(ER_MARKERS)) {
    const marker = document.createElementNS(ns, 'marker');
    for (const [key, value] of Object.entries({ id: `er-${id}`, viewBox: '0 0 20 20', refX: 20, refY: 10, markerWidth: 20 * markerScale, markerHeight: 20 * markerScale, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' })) marker.setAttribute(key, value);
    for (const [tag, attrs] of parts) {
      const shape = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
      shape.setAttribute('stroke', 'context-stroke'); shape.setAttribute('stroke-width', '1.6'); shape.setAttribute('stroke-linecap', 'round');
      if (tag === 'path') shape.setAttribute('fill', 'none');
      marker.append(shape);
    }
    defs.append(marker);
  }
  svg.append(defs);
  edgeRefs.clear();
  const byId = new Map(visibleTables().map(table => [table.id, table]));
  state.overviewSlots = overview ? overviewSlots(visibleRelations(), byId) : null;
  const laneKeyFor = (source, target) => {
    const sourceColumn = Math.round(graphPosition(source.id).x / (NODE_WIDTH + 172));
    const targetColumn = Math.round(graphPosition(target.id).x / (NODE_WIDTH + 172));
    return `${Math.min(sourceColumn, targetColumn)}:${Math.max(sourceColumn, targetColumn)}`;
  };
  const laneTotals = new Map();
  for (const relation of visibleRelations()) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    const key = laneKeyFor(source, target);
    laneTotals.set(key, (laneTotals.get(key) || 0) + (overview ? 1 : relation.pairs.length));
  }
  const lanes = new Map();
  const connections = [];
  for (const relation of visibleRelations()) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    relation.pairs.forEach((pair, index) => {
      if (overview && index > 0) return;
      const laneKey = laneKeyFor(source, target);
      const laneIndex = lanes.get(laneKey) || 0; lanes.set(laneKey, laneIndex + 1);
      const laneTotal = laneTotals.get(laneKey) || 1;
      const lane = laneTotal === 1 ? 0 : (laneIndex - (laneTotal - 1) / 2) * Math.min(20, 120 / laneTotal);
      const key = `${relation.id}:${index}`;
      connections.push({ relation, source, target, pair, lane, key,
        input: routingConnection(source, target, pair, lane, key) });
    });
  }
  if (!state.edgeRoutes && visibleTables().length <= 35) {
    state.edgeRoutes = routeConnections(connections.map(item => item.input), routingBoxes());
  } else if (!state.edgeRoutes && connections.length) {
    if (!state.routeWorker) {
      state.routeWorker = new Worker('/route-worker.js', { type: 'module' });
      state.routeWorker.onmessage = event => {
        if (event.data.generation !== state.routeGeneration) return;
        state.edgeRoutes = new Map(event.data.routes);
        for (const refs of edgeRefs.values()) for (const ref of refs) {
          const route = state.edgeRoutes.get(ref.key);
          if (!route) continue;
          ref.bounds = route.bounds;
          ref.line.setAttribute('d', route.d);
          ref.hit.setAttribute('d', route.d);
          ref.canvasPath = new Path2D(route.d);
          syncEdgeAnnotations(ref, route);
        }
        scheduleView();
      };
      state.routeWorker.onerror = () => { state.routeWorker?.terminate(); state.routeWorker = null; };
    }
    state.routeWorker.postMessage({ generation, connections: connections.map(item => item.input), boxes: routingBoxes() });
  }
  for (const item of connections) {
      const { relation, source, target, pair, lane, key } = item;
      const path = state.edgeRoutes?.get(key) || edgePath(source, target, pair, lane, key);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', path.d);
      line.setAttribute('class', `edge${isDraftRelation(relation) ? ' proposed' : ''}`);
      const ends = relationEnds(relation, source, target);
      if (ends.start) line.setAttribute('marker-start', `url(#er-${ends.start})`);
      if (ends.end) line.setAttribute('marker-end', `url(#er-${ends.end})`);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', path.d); hit.setAttribute('class', 'edge hit');
      hit.dataset.relation = relation.id;
      hit.addEventListener('click', event => { event.stopPropagation(); selectRelation(relation.id); });
      hit.addEventListener('mouseenter', () => line.classList.add('hover'));
      hit.addEventListener('mouseleave', () => line.classList.remove('hover'));
      const labels = {};
      if (!canvasMode) svg.append(line, ...Object.values(labels), hit);
      if (!edgeRefs.has(relation.id)) edgeRefs.set(relation.id, []);
      const ref = { line, hit, source, target, pair, lane, key, labels, markers: ends,
        bounds: path.bounds, canvasPath: new Path2D(path.d) };
      syncEdgeAnnotations(ref, path);
      edgeRefs.get(relation.id).push(ref);
  }
  updateEdgeEmphasis();
  scheduleView();
}

export function updateEdgesForTable(id) {
  for (const relation of visibleRelations()) {
    if (relation.source !== id && relation.target !== id) continue;
    for (const ref of edgeRefs.get(relation.id) || []) {
      const path = edgePath(ref.source, ref.target, ref.pair, ref.lane, ref.key);
      ref.bounds = { left: Math.min(path.a.x, path.b.x) - 120, right: Math.max(path.a.x, path.b.x) + 120,
        top: Math.min(path.a.y, path.b.y) - 120, bottom: Math.max(path.a.y, path.b.y) + 120 };
      ref.line.setAttribute('d', path.d); ref.hit.setAttribute('d', path.d);
      ref.canvasPath = new Path2D(path.d);
      syncEdgeAnnotations(ref, path);
    }
  }
  scheduleView();
}

export function updateEdgeEmphasis() {
  const active = state.groups.find(group => group.id === state.topic)?.ids;
  const search = $('searchInput').value.trim().toLowerCase();
  const matches = search ? searchMatches(search) : null;
  const focusTable = state.hoveredTable || state.selectedTable;
  for (const [relationId, refs] of edgeRefs) {
    for (const ref of refs) {
      const incident = Boolean(focusTable && (ref.source.id === focusTable || ref.target.id === focusTable));
      const dimmed = (state.topic !== 'all' && !(active.has(ref.source.id) && active.has(ref.target.id))) ||
        (matches && !(matches.has(ref.source.id) && matches.has(ref.target.id))) || (focusTable && !incident);
      const focused = state.topic !== 'all' && active.has(ref.source.id) && active.has(ref.target.id);
      const selected = state.selectedRelation === relationId || state.selectedTable === ref.source.id || state.selectedTable === ref.target.id;
      ref.line.classList.toggle('focused', Boolean(focused));
      ref.line.classList.toggle('trace', incident);
      ref.line.classList.toggle('selected', Boolean(selected));
      ref.line.classList.toggle('dimmed', Boolean(dimmed && !selected));
      const proposed = ref.line.classList.contains('proposed');
      ref.canvasStyle = {
        stroke: selected ? edgeColors().selected : incident ? edgeColors().trace : focused ? edgeColors().focus : proposed ? edgeColors().proposed : edgeColors().wire,
        opacity: dimmed && !selected ? .28 : selected || incident ? 1 : proposed ? .88 : focused ? .8 : .75,
        width: selected ? 2.5 : incident ? 2.25 : focused ? 1.7 : 1.6,
        proposed
      };
    }
  }
  scheduleView();
}
export function drawCanvasEdges() {
  const canvas = $('edgeCanvas');
  if (!$('viewport').classList.contains('canvas-edges')) return;
  const viewport = $('viewport'), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(viewport.clientWidth * dpr));
  const height = Math.max(1, Math.round(viewport.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(dpr * state.scale, 0, 0, dpr * state.scale, dpr * state.x, dpr * state.y);
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (const refs of edgeRefs.values()) for (const ref of refs) {
    if (ref._visible === false || !ref.canvasPath || !ref.canvasStyle) continue;
    context.strokeStyle = ref.canvasStyle.stroke;
    context.globalAlpha = ref.canvasStyle.opacity;
    context.lineWidth = Math.max(ref.canvasStyle.width, 1.2 / state.scale);
    context.setLineDash(ref.canvasStyle.proposed ? [6, 6] : []);
    context.stroke(ref.canvasPath);
    context.setLineDash([]);
    if (ref.ends) for (const end of ['start', 'end']) if (ref.markers?.[end]) drawErEnd(context, ref.ends[end], ref.markers[end]);
    context.font = '600 13px "Roboto Mono", monospace';
    context.textAlign = 'center';
    context.fillStyle = edgeColors().label;
    context.strokeStyle = edgeColors().halo; context.lineWidth = 4;
    context.globalAlpha = 1;
    for (const annotation of ref.annotations || []) {
      context.strokeText(annotation.text, annotation.x, annotation.y);
      context.fillText(annotation.text, annotation.x, annotation.y);
    }
  }
  context.globalAlpha = 1;
}

export function canvasRelationAt(clientX, clientY) {
  if (!$('viewport').classList.contains('canvas-edges')) return null;
  const rect = $('viewport').getBoundingClientRect();
  const x = (clientX - rect.left - state.x) / state.scale;
  const y = (clientY - rect.top - state.y) / state.scale;
  const context = $('edgeCanvas').getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.lineWidth = 10 / state.scale;
  for (const [relationId, refs] of [...edgeRefs].reverse()) {
    for (const ref of [...refs].reverse()) {
      if (ref._visible !== false && ref.canvasPath && context.isPointInStroke(ref.canvasPath, x, y)) return relationId;
    }
  }
  return null;
}
