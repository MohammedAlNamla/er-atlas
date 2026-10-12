import test from 'node:test';
import assert from 'node:assert/strict';
import { routeConnection, routeConnections } from '../public/router.js';

const box = (id, left, top, width = 100, height = 100) => ({ id, left, right: left + width, top, bottom: top + height });
const anchors = (left, right, y) => ({ left: { x: left, y }, right: { x: right, y } });
const line = (key, sourceId, targetId, source, target, lane = 0) => ({ key, sourceId, targetId, source, target, lane });

test('relationship routes around a table and stays attached to its columns', () => {
  const obstacles = [box('from', 0, 0), box('between', 220, -20, 110, 140), box('to', 460, 0)];
  const connection = line('one', 'from', 'to', anchors(0, 100, 50), anchors(460, 560, 50));
  const route = routeConnection(connection, obstacles);
  assert.ok(route);
  assert.equal(route.hits, 0);
  assert.deepEqual(route.points[0], { x: 100, y: 50 });
  assert.deepEqual(route.points.at(-1), { x: 460, y: 50 });
  assert.ok(route.points.some(point => point.y < -32 || point.y > 132));
});

test('parallel relationships receive distinct, deterministic paths', () => {
  const obstacles = [box('from', 0, 0), box('to', 400, 0)];
  const first = line('a', 'from', 'to', anchors(0, 100, 40), anchors(400, 500, 40), -16);
  const second = line('b', 'from', 'to', anchors(0, 100, 70), anchors(400, 500, 70), 16);
  const routes = routeConnections([first, second], obstacles);
  assert.equal(routes.size, 2);
  assert.equal(routes.get('a').hits, 0);
  assert.equal(routes.get('b').hits, 0);
  assert.notEqual(routes.get('a').d, routes.get('b').d);
  assert.equal(routes.get('a').d, routeConnections([first, second], obstacles).get('a').d);
});

test('moving an obstacle changes the chosen route', () => {
  const connection = line('one', 'from', 'to', anchors(0, 100, 50), anchors(460, 560, 50));
  const base = [box('from', 0, 0), box('to', 460, 0)];
  const clear = routeConnection(connection, base);
  const blocked = routeConnection(connection, [...base, box('between', 210, -40, 120, 180)]);
  assert.equal(clear.hits, 0);
  assert.equal(blocked.hits, 0);
  assert.notEqual(clear.d, blocked.d);
});
