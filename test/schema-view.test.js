import test from 'node:test';
import assert from 'node:assert/strict';
import { previewColumns, nodeHeight, columnOffset, fitCamera, relationCardinality } from '../public/ui.js';

const table = { columns: Array.from({ length: 12 }, (_, i) => ({ name: `column_${i}`, primary: i === 0, foreign: i === 9 })) };
test('collapsed schema nodes retain keys in source order without losing columns on expansion', () => {
  assert.deepEqual(previewColumns(table).map(column => column.name), ['column_0', 'column_1', 'column_2', 'column_3', 'column_4', 'column_5', 'column_6', 'column_9']);
  assert.equal(previewColumns(table, true).length, 12);
  assert.equal(nodeHeight(table), 342);
  assert.equal(nodeHeight(table, true), 470);
});
test('relationship anchors agree with compact, hidden and expanded column geometry', () => {
  assert.equal(columnOffset(table, 'column_9'), 292);
  assert.equal(columnOffset(table, 'column_11'), 324);
  assert.equal(columnOffset(table, 'column_11', true), 420);
});

test('cardinality uses complete keys and omits ambiguous composite uniqueness', () => {
  const relation = { kind: 'actual', pairs: [{ source: 'owner_id', target: 'id' }] };
  const target = { columns: [{ name: 'id', primary: true }] };
  const source = { columns: [{ name: 'id', primary: true }, { name: 'owner_id', unique: false }] };
  assert.deepEqual(relationCardinality(relation, source, target), { source: '*', target: '1' });
  source.columns[1].unique = true;
  assert.deepEqual(relationCardinality(relation, source, target), { source: null, target: '1' });
  source.uniqueKeys = [['owner_id']];
  assert.equal(relationCardinality(relation, source, target).source, '1');
  target.columns.push({ name: 'tenant_id', primary: true });
  assert.equal(relationCardinality(relation, source, target).target, null);
  relation.pairs.push({ source: 'tenant_id', target: 'tenant_id' });
  assert.equal(relationCardinality(relation, source, target).target, '1');
});
test('entry camera stays readable while explicit overview fits the whole diagram', () => {
  const bounds = { width: 4000, height: 3000, center: { x: 2000, y: 1500 } };
  const viewport = { width: 1440, height: 900 };
  const center = { x: 400, y: 350 };
  const camera = fitCamera(bounds, viewport, { center });
  assert.equal(camera.scale, .9);
  assert.equal(camera.x + center.x * camera.scale, 720);
  const overview = fitCamera(bounds, viewport, { overview: true, center });
  assert.ok(overview.scale < .3);
  assert.equal(overview.x + bounds.center.x * overview.scale, 720);
});

test('a readable diagram centers its bounds within the reserved toolbar safe area', () => {
  const bounds = { width: 1200, height: 780, center: { x: 600, y: 390 } };
  const viewport = { width: 1440, height: 796 };
  const camera = fitCamera(bounds, viewport, { center: { x: 600, y: 100 } });
  assert.equal(camera.scale, .9);
  assert.equal(camera.y + bounds.center.y * camera.scale, viewport.height / 2);
  assert.ok(camera.y + bounds.height * camera.scale < viewport.height);
});
