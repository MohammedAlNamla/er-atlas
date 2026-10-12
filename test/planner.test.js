import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, replay } from '../public/model.js';
import { planChanges } from '../planner.js';

const base = {
  database: 'test', readOnly: true,
  tables: [{ id: '1', schema: 'public', name: 'users', columns: [
    { number: 1, name: 'id', type: 'uuid', nullable: false, default: null, primary: true, unique: false, foreign: false }
  ] }], relations: []
};

test('draft operations replay without changing the baseline', () => {
  const operations = [
    { type: 'addTable', id: 'draft:notes', schema: 'public', name: 'notes' },
    { type: 'addColumn', tableId: 'draft:notes', column: { name: 'id', type: 'uuid', nullable: true, primary: true } },
    { type: 'addColumn', tableId: 'draft:notes', column: { name: 'user_id', type: 'uuid', nullable: false, primary: false } },
    { type: 'addRelation', relation: { id: 'draft:fk', name: 'fk_notes_user', source: 'draft:notes', target: '1', pairs: [{ source: 'user_id', target: 'id' }] } }
  ];
  const result = replay(base, operations);
  assert.equal(base.tables.length, 1);
  assert.equal(result.tables.length, 2);
  assert.equal(result.tables[1].columns[0].nullable, false);
  assert.equal(result.tables[1].columns[1].foreign, true);
});

test('planner emits ordered, quoted PostgreSQL statements', () => {
  const operations = [
    { type: 'addTable', id: 'draft:audit', schema: 'public', name: 'audit_log' },
    { type: 'addColumn', tableId: 'draft:audit', column: { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', primary: false } }
  ];
  const plan = planChanges(base, operations);
  assert.match(plan.sql, /CREATE TABLE "public"\."audit_log"/);
  assert.match(plan.sql, /ADD COLUMN "created_at" timestamptz DEFAULT now\(\) NOT NULL/);
  assert.equal(plan.count, 2);
});

test('planner rejects unsafe types and defaults', () => {
  assert.throws(() => planChanges(base, [{ type: 'addColumn', tableId: '1', column: { name: 'bad', type: 'text; DROP TABLE users', nullable: true } }]), /غير مدعوم/);
  assert.throws(() => planChanges(base, [{ type: 'addColumn', tableId: '1', column: { name: 'bad', type: 'text', nullable: true, default: 'danger()' } }]), /القيمة الافتراضية/);
});

test('column rename keeps relationship endpoints aligned', () => {
  const withRelation = applyOperation(base, { type: 'addRelation', relation: { id: 'r', name: 'self', source: '1', target: '1', pairs: [{ source: 'id', target: 'id' }] } });
  const changed = applyOperation(withRelation, { type: 'updateColumn', tableId: '1', columnName: 'id', patch: { name: 'user_id' } });
  assert.deepEqual(changed.relations[0].pairs[0], { source: 'user_id', target: 'user_id' });
});

const orders = {
  database: 'test', readOnly: true,
  tables: [
    { id: 'o', schema: 'public', name: 'orders', columns: [
      { number: 1, name: 'id', type: 'bigint', nullable: false, default: null, primary: true, unique: false, foreign: false },
      { number: 2, name: 'user_id', type: 'bigint', nullable: true, default: null, primary: false, unique: false, foreign: false }
    ] },
    { id: 'u', schema: 'public', name: 'users', columns: [
      { number: 1, name: 'id', type: 'bigint', nullable: false, default: null, primary: true, unique: false, foreign: false }
    ] }
  ], relations: []
};
const relation = onDelete => ({ id: 'r', name: 'orders_user_id_foreign', source: 'o', target: 'u', pairs: [{ source: 'user_id', target: 'id' }], onDelete });

test('relation SQL keeps the chosen ON DELETE action', () => {
  assert.match(planChanges(orders, [{ type: 'addRelation', relation: relation('c') }]).sql, /REFERENCES "public"\."users" \("id"\) ON DELETE CASCADE;$/);
  assert.match(planChanges(orders, [{ type: 'addRelation', relation: relation('n') }]).sql, /ON DELETE SET NULL;$/);
  assert.doesNotMatch(planChanges(orders, [{ type: 'addRelation', relation: relation('a') }]).sql, /ON DELETE/);
  assert.throws(() => planChanges(orders, [{ type: 'addRelation', relation: relation('x; DROP') }]), /إجراء الحذف/);
});

test('column patches without a name still resolve the column', () => {
  const plan = planChanges(orders, [{ type: 'updateColumn', tableId: 'o', columnName: 'user_id', patch: { nullable: false } }]);
  assert.equal(plan.sql, 'ALTER TABLE "public"."orders" ALTER COLUMN "user_id" SET NOT NULL;');
});

test('type changes carry a USING cast and Laravel-style types are accepted', () => {
  const plan = planChanges(orders, [{ type: 'updateColumn', tableId: 'o', columnName: 'user_id', patch: { type: 'integer' } }]);
  assert.match(plan.sql, /TYPE integer USING "user_id"::integer;/);
  for (const type of ['timestamp(0) without time zone', 'timestamptz(3)', 'bigserial', 'text[]', 'varchar(255)']) {
    assert.doesNotThrow(() => planChanges(orders, [{ type: 'addColumn', tableId: 'o', column: { name: 'extra', type, nullable: true } }]), type);
  }
});
