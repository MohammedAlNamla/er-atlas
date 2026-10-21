const CLEARANCE = 12;
const STUB = 24;
const CORNER = 8;

const round = value => Math.round(value * 10) / 10;
const range = (a, b) => [Math.min(a, b), Math.max(a, b)];
function boundsOf(points) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.x > right) right = point.x;
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }
  return { left, right, top, bottom };
}
const boundsOverlap = (a, b) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

function simplify(points) {
  const result = [];
  for (const point of points) {
    if (result.length && result.at(-1).x === point.x && result.at(-1).y === point.y) continue;
    result.push(point);
    while (result.length > 2) {
      const [a, b, c] = result.slice(-3);
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) result.splice(-2, 1);
      else break;
    }
  }
  return result;
}

function pathData(points) {
  if (!points.length) return '';
  let d = `M ${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1], current = points[i], next = points[i + 1];
    const before = Math.hypot(current.x - previous.x, current.y - previous.y);
    const after = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.min(CORNER, before / 2, after / 2);
    if (radius < 1) { d += ` L ${round(current.x)} ${round(current.y)}`; continue; }
    const enter = { x: current.x - Math.sign(current.x - previous.x) * radius, y: current.y - Math.sign(current.y - previous.y) * radius };
    const leave = { x: current.x + Math.sign(next.x - current.x) * radius, y: current.y + Math.sign(next.y - current.y) * radius };
    d += ` L ${round(enter.x)} ${round(enter.y)} Q ${round(current.x)} ${round(current.y)} ${round(leave.x)} ${round(leave.y)}`;
  }
  const last = points.at(-1);
  return `${d} L ${round(last.x)} ${round(last.y)}`;
}

function intersects(segmentA, segmentB, box) {
  if (segmentA.x === segmentB.x) {
    const [top, bottom] = range(segmentA.y, segmentB.y);
    return segmentA.x > box.left && segmentA.x < box.right && bottom > box.top && top < box.bottom;
  }
  const [left, right] = range(segmentA.x, segmentB.x);
  return segmentA.y > box.top && segmentA.y < box.bottom && right > box.left && left < box.right;
}

function traffic(points, reserved) {
  let crossings = 0, overlap = 0;
  const bounds = boundsOf(points);
  const nearby = reserved.filter(route => boundsOverlap(bounds, route.bounds));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (const route of nearby) {
      for (let j = 1; j < route.points.length; j++) {
      const c = route.points[j - 1], d = route.points[j];
      const aHorizontal = a.y === b.y, cHorizontal = c.y === d.y;
      if (aHorizontal !== cHorizontal) {
        const h1 = aHorizontal ? a : c, h2 = aHorizontal ? b : d;
        const v1 = aHorizontal ? c : a, v2 = aHorizontal ? d : b;
        const [x1, x2] = range(h1.x, h2.x), [y1, y2] = range(v1.y, v2.y);
        if (v1.x > x1 + 2 && v1.x < x2 - 2 && h1.y > y1 + 2 && h1.y < y2 - 2) crossings++;
      } else if (aHorizontal && a.y === c.y) {
        const [a1, a2] = range(a.x, b.x), [c1, c2] = range(c.x, d.x);
        overlap += Math.max(0, Math.min(a2, c2) - Math.max(a1, c1));
      } else if (!aHorizontal && a.x === c.x) {
        const [a1, a2] = range(a.y, b.y), [c1, c2] = range(c.y, d.y);
        overlap += Math.max(0, Math.min(a2, c2) - Math.max(a1, c1));
      }
      }
    }
  }
  return { crossings, overlap };
}

function score(points, connection, boxes, reserved, sidePenalty) {
  let hits = 0, length = 0;
  const bounds = boundsOf(points);
  const nearbyBoxes = boxes.filter(box => boundsOverlap(bounds, box));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    for (const box of nearbyBoxes) {
      if ((i === 1 && box.id === connection.sourceId) || (i === points.length - 1 && box.id === connection.targetId)) continue;
      if (intersects(a, b, box)) hits++;
    }
  }
  const { crossings, overlap } = reserved.length ? traffic(points, reserved) : { crossings: 0, overlap: 0 };
  return { hits, crossings, value: hits * 100000 + crossings * 130 + overlap * 3 + length + (points.length - 2) * 14 + sidePenalty };
}

function ordered(values, center, limit, includeExtremes = false) {
  const unique = [...new Set(values.map(round))].filter(Number.isFinite);
  unique.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  const chosen = unique.slice(0, limit);
  if (includeExtremes && unique.length > limit) chosen.push(Math.min(...unique), Math.max(...unique));
  return [...new Set(chosen)];
}

function evaluate(points, connection, boxes, reserved, penalty, current) {
  const distinct = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  if (distinct.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return current;
  const result = score(distinct, connection, boxes, reserved, penalty);
  if (!current || result.value < current.score.value) return { points: simplify(distinct), score: result };
  return current;
}

function candidates(connection, boxes, reserved) {
  const sourceBox = boxes.find(box => box.id === connection.sourceId);
  const targetBox = boxes.find(box => box.id === connection.targetId);
  if (!sourceBox || !targetBox) return null;
  let best = null;
  const variants = [];
  const sideChoices = connection.sourceId === connection.targetId ? [['right', 'right'], ['left', 'left']]
    : [['right', 'left'], ['left', 'right'], ['right', 'right'], ['left', 'left']];
  for (const [sourceSide, targetSide] of sideChoices) {
    const a = connection.source[sourceSide], b = connection.target[targetSide];
    const sDir = sourceSide === 'right' ? 1 : -1, tDir = targetSide === 'right' ? 1 : -1;
    const s = { x: a.x + sDir * STUB, y: a.y }, t = { x: b.x + tDir * STUB, y: b.y };
    const sourceCenter = (sourceBox.left + sourceBox.right) / 2;
    const targetCenter = (targetBox.left + targetBox.right) / 2;
    const preferredSource = sourceCenter <= targetCenter ? 'right' : 'left';
    const preferredTarget = preferredSource === 'right' ? 'left' : 'right';
    const aligned = Math.abs(sourceCenter - targetCenter) < (sourceBox.right - sourceBox.left) * .65;
    const penalty = aligned ? sourceSide === targetSide ? 0 : 55 : (sourceSide !== preferredSource ? 45 : 0) + (targetSide !== preferredTarget ? 45 : 0);
    if (connection.sourceId === connection.targetId) {
      const outer = sourceSide === 'right' ? Math.max(sourceBox.right + 52, a.x + 52 + Math.abs(connection.lane || 0)) : Math.min(sourceBox.left - 52, a.x - 52 - Math.abs(connection.lane || 0));
      best = evaluate([a, { x: outer, y: a.y }, { x: outer, y: b.y }, b], connection, boxes, reserved, penalty, best);
      continue;
    }
    const centerX = (s.x + t.x) / 2 + (connection.lane || 0);
    const relevant = boxes.filter(box => box.right >= Math.min(s.x, t.x) - 260 && box.left <= Math.max(s.x, t.x) + 260 && box.bottom >= Math.min(s.y, t.y) - 220 && box.top <= Math.max(s.y, t.y) + 220);
    const xs = ordered([s.x, t.x, centerX, centerX - 26, centerX + 26,
      ...relevant.flatMap(box => [box.left - 3, box.right + 3])], centerX, 11, true);
    let localBest = null;
    for (const x of xs) localBest = evaluate([a, s, { x, y: s.y }, { x, y: t.y }, t, b], connection, boxes, reserved, penalty, localBest);
    if (localBest) {
      variants.push({ a, b, s, t, sDir, tDir, relevant, penalty, score: localBest.score.value });
      if (!best || localBest.score.value < best.score.value) best = localBest;
    }
  }
  if (connection.sourceId === connection.targetId || (best?.score.hits === 0 && best.score.crossings <= 1)) return best;
  variants.sort((a, b) => a.score - b.score);
  for (const { a, b, s, t, sDir, tDir, relevant, penalty } of variants.slice(0, 2)) {
    const outwardX = (base, dir) => ordered([base, base + dir * 42,
      ...relevant.flatMap(box => [box.left - 3, box.right + 3]).filter(x => (x - base) * dir >= 0 && Math.abs(x - base) < 160)], base, 3);
    const sourceXs = outwardX(s.x, sDir), targetXs = outwardX(t.x, tDir);
    const centerY = (s.y + t.y) / 2;
    const ys = ordered([centerY + (connection.lane || 0), Math.min(s.y, t.y, ...relevant.map(box => box.top)) - 24, Math.max(s.y, t.y, ...relevant.map(box => box.bottom)) + 24,
      ...relevant.flatMap(box => [box.top - 3, box.bottom + 3])], centerY, 5, true);
    for (const sx of sourceXs) for (const tx of targetXs) for (const y of ys) {
      best = evaluate([a, s, { x: sx, y: s.y }, { x: sx, y }, { x: tx, y }, { x: tx, y: t.y }, t, b], connection, boxes, reserved, penalty + 18, best);
    }
  }
  return best;
}

export function routeConnection(connection, obstacles, reserved = []) {
  const boxes = obstacles.map(box => ({ id: box.id, left: box.left - CLEARANCE, right: box.right + CLEARANCE,
    top: box.top - CLEARANCE, bottom: box.bottom + CLEARANCE }));
  const best = candidates(connection, boxes, reserved);
  if (!best) return null;
  return { points: best.points, bounds: boundsOf(best.points), d: pathData(best.points), hits: best.score.hits, crossings: best.score.crossings };
}

export function routeConnections(connections, obstacles) {
  const routes = new Map(), reserved = [];
  const sorted = [...connections].sort((a, b) => {
    const distance = item => Math.abs(item.source.right.x - item.target.left.x) + Math.abs(item.source.right.y - item.target.left.y);
    return distance(a) - distance(b) || String(a.key).localeCompare(String(b.key));
  });
  for (const connection of sorted) {
    const corridor = { left: Math.min(connection.source.left.x, connection.target.left.x) - 180,
      right: Math.max(connection.source.right.x, connection.target.right.x) + 180,
      top: Math.min(connection.source.left.y, connection.target.left.y) - 180,
      bottom: Math.max(connection.source.left.y, connection.target.left.y) + 180 };
    const nearbyRoutes = reserved.filter(route => boundsOverlap(route.bounds, corridor)).slice(-12);
    const route = routeConnection(connection, obstacles, nearbyRoutes);
    if (!route) continue;
    routes.set(connection.key, route);
    reserved.push(route);
  }
  return routes;
}
