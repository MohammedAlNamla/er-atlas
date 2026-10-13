import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExport, parseExport, validateSchema, recoverOperations } from '../public/workspace-io.js';
import { applyOperation } from '../public/model.js';
import { laravelPlural } from '../code-context.js';

const schema = () => ({
  database: 'shop', tables: [
    { id: 'a', schema: 'public', name: 'orders', columns: [{ name: 'id', type: 'bigint', primary: true, nullable: false }, { name: 'user_id', type: 'bigint' }] },
    { id: 'b', schema: 'public', name: 'users', columns: [{ name: 'id', type: 'bigint', primary: true, nullable: false }] }
  ],
  relations: [{ id: 'r', name: 'orders_user_id_foreign', source: 'a', target: 'b', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'c' }]
});

test('workspace files round-trip and drop unknown fields', () => {
  const file = buildExport({ name: 'Shop', kind: 'database', schema: { ...schema(), secret: 'x' }, topics: [{ id: 't', label: 'T', ids: ['a'] }], positions: { a: { x: 1, y: 2 }, ghost: { x: 0, y: 0 } } });
  const parsed = parseExport(JSON.stringify(file));
  assert.equal(parsed.name, 'Shop');
  assert.equal(parsed.schema.relations[0].onDelete, 'c');
  assert.equal('secret' in parsed.schema, false);
  assert.deepEqual(Object.keys(parsed.positions), ['a']);
});

test('imports reject foreign files, broken references and newer versions', () => {
  assert.throws(() => parseExport('not json'), /JSON/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'other' })), /ليس ملف مساحة/);
  assert.throws(() => parseExport(JSON.stringify({ ...buildExport({ name: 'x', kind: 'ideas', schema: schema() }), version: 99 })), /أحدث/);
  const broken = schema(); broken.relations[0].target = 'missing';
  assert.throws(() => validateSchema(broken), /جدول غير موجود/);
  const duplicate = schema(); duplicate.tables[1].id = 'a';
  assert.throws(() => validateSchema(duplicate), /مكرر/);
});

test('the bundled Sufra sample is a valid workspace file', () => {
  const parsed = parseExport(readFileSync(new URL('../public/samples/sufra-products.eratlas.json', import.meta.url), 'utf8'));
  assert.equal(parsed.schema.tables.length, 15);
  assert.equal(parsed.topics.length, 5);
});

test('draft recovery keeps operations that still apply and counts the rest', () => {
  const operations = [
    { type: 'addColumn', tableId: 'b', column: { name: 'email', type: 'text', nullable: true } },
    { type: 'dropColumn', tableId: 'a', columnName: 'removed_in_database' },
    { type: 'addColumn', tableId: 'gone', column: { name: 'x', type: 'text', nullable: true } }
  ];
  const { kept, skipped } = recoverOperations(schema(), operations, applyOperation);
  assert.equal(kept.length, 1);
  assert.equal(skipped, 2);
});

test('Eloquent table names follow Laravel pluralization', () => {
  assert.equal(laravelPlural('person'), 'people');
  assert.equal(laravelPlural('order_item'), 'order_items');
  assert.equal(laravelPlural('store_child'), 'store_children');
  assert.equal(laravelPlural('category'), 'categories');
  assert.equal(laravelPlural('status'), 'statuses');
  assert.equal(laravelPlural('equipment'), 'equipment');
});

test('column notes travel with the file and only for columns that exist', () => {
  const notes = {
    a: { summary: 'الطلبات', columns: { user_id: { text: 'صاحب الطلب', basis: 'schema' }, ghost: { text: 'لا وجود له', basis: 'name' }, id: { text: '  ', basis: 'user' } } },
    nope: { summary: 'جدول غير موجود', columns: {} }
  };
  const parsed = parseExport(JSON.stringify(buildExport({ name: 'Shop', kind: 'database', schema: schema(), columnNotes: notes })));
  assert.deepEqual(parsed.columnNotes, { a: { summary: 'الطلبات', columns: { user_id: { text: 'صاحب الطلب', basis: 'schema' } } } });
  assert.deepEqual(parseExport(JSON.stringify(buildExport({ name: 'Shop', kind: 'database', schema: schema() }))).columnNotes, {});
});
