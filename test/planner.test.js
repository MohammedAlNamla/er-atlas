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
