import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LINT_RULES, lintSchema, normalizeType } from '../public/lint.js';

const col = (name, type, extra = {}) => ({ name, type, nullable: true, default: null, description: '', primary: false, unique: false, foreign: false, ...extra });
const pk = (type = 'bigint') => col('id', type, { number: 1, nullable: false, primary: true });
const table = (id, columns, extra = {}) => ({ id, schema: 'public', name: id, description: '', approxRows: 0, columns, ...extra });
const rel = (id, source, target, pairs, extra = {}) => ({ id, name: id, source, target, pairs: pairs.map(([s, t]) => ({ source: s, target: t })), onDelete: 'a', kind: 'actual', ...extra });
const byRule = (findings, rule) => findings.filter(f => f.rule === rule);

test('normalizeType folds aliases, lengths and time zones', () => {
  assert.equal(normalizeType('character varying(255)'), normalizeType('varchar(80)'));
  assert.equal(normalizeType('VARCHAR'), 'varchar');
  assert.notEqual(normalizeType('integer'), normalizeType('bigint'));
  assert.equal(normalizeType('int4'), 'integer');
  assert.equal(normalizeType('serial'), 'integer');
  assert.equal(normalizeType('bigserial'), 'bigint');
  assert.equal(normalizeType('int2'), 'smallint');
  assert.equal(normalizeType('character(2)'), normalizeType('char(3)'));
  assert.equal(normalizeType('timestamp(0) with time zone'), 'timestamptz');
  assert.equal(normalizeType('timestamptz'), 'timestamptz');
  assert.equal(normalizeType('timestamp(0) without time zone'), 'timestamp');
  assert.equal(normalizeType('timestamp(6)'), 'timestamp');
  assert.equal(normalizeType('numeric(14,3)'), normalizeType('decimal'));
  assert.equal(normalizeType(' text '), 'text');
});

test('rule metadata covers every rule with an Arabic label', () => {
  assert.equal(LINT_RULES.length, 8);
  for (const rule of LINT_RULES) {
    assert.match(rule.severity, /^(error|warning|info)$/);
    assert.match(rule.label, /[؀-ۿ]/);
  }
});

test('flags tables without a primary key and empty draft tables', () => {
  const findings = lintSchema({ tables: [table('logs', [col('message', 'text')]), table('draft', [], { kind: 'proposed' })], relations: [] });
  assert.deepEqual(byRule(findings, 'no-primary-key').map(f => f.tableId), ['logs']);
  assert.deepEqual(byRule(findings, 'empty-table').map(f => f.tableId), ['draft']);
  assert.equal(byRule(findings, 'no-primary-key').find(f => f.tableId === 'draft'), undefined);
  assert.equal(findings[0].id, 'empty-table:draft');
});

test('suggests a relation for an unlinked *_id column', () => {
  const schema = { tables: [table('users', [pk()]), table('posts', [pk(), col('user_id', 'bigint', { number: 2 })])], relations: [] };
  const [finding] = byRule(lintSchema(schema), 'missing-foreign-key');
  assert.equal(finding.id, 'missing-foreign-key:posts:user_id');
  assert.equal(finding.severity, 'warning');
  assert.equal(finding.columnName, 'user_id');
  assert.match(finding.detail, /users\.id/);
  assert.deepEqual(finding.fix, { type: 'addRelation', relation: { id: null, name: 'posts_user_id_foreign', source: 'posts', target: 'users', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'a' } });
});

test('missing-foreign-key handles y→ies, irregulars, schemas and linked columns', () => {
  const schema = { tables: [
    table('categories', [pk()]), table('people', [pk('uuid')]), table('children', [pk()]),
    table('accounts', [pk()], { schema: 'other' }), table('accounts_main', [pk()]),
    { ...table('accounts', [pk()]), id: 'public.accounts' },
    table('items', [pk(), col('category_id', 'bigint'), col('person_id', 'uuid'), col('child_id', 'integer'), col('account_id', 'bigint'), col('owner_id', 'bigint'), col('link_id', 'bigint', { foreign: true })]),
    table('links', [pk()])
  ], relations: [] };
  const findings = byRule(lintSchema(schema), 'missing-foreign-key');
  const fix = name => findings.find(f => f.columnName === name)?.fix?.relation;
  assert.equal(fix('category_id').target, 'categories');
  assert.equal(fix('person_id').target, 'people');
  assert.equal(fix('account_id').target, 'public.accounts');
  const child = findings.find(f => f.columnName === 'child_id');
  assert.equal(child.fix, undefined, 'integer vs bigint is not offered as a fix');
  assert.match(child.detail, /integer/);
  assert.equal(findings.some(f => f.columnName === 'owner_id' || f.columnName === 'link_id'), false);

  const linked = { tables: [table('users', [pk()]), table('posts', [pk(), col('user_id', 'bigint')])], relations: [rel('fk', 'posts', 'users', [['user_id', 'id']])] };
  assert.equal(byRule(lintSchema(linked), 'missing-foreign-key').length, 0);
  const composite = { tables: [table('users', [pk(), col('org', 'bigint', { primary: true })]), table('posts', [pk(), col('user_id', 'bigint')])], relations: [] };
  assert.equal(byRule(lintSchema(composite), 'missing-foreign-key').length, 0);
});

test('fk-type-mismatch and set-null-not-null are errors', () => {
  const schema = { tables: [
    table('users', [pk('uuid')]),
    table('posts', [pk(), col('user_id', 'bigint', { nullable: false }), col('editor_id', 'uuid', { nullable: false })])
  ], relations: [
    rel('posts_user', 'posts', 'users', [['user_id', 'id']]),
    rel('posts_editor', 'posts', 'users', [['editor_id', 'id']], { onDelete: 'n' })
  ] };
  const findings = lintSchema(schema);
  const mismatch = byRule(findings, 'fk-type-mismatch');
  assert.deepEqual(mismatch.map(f => [f.relationId, f.columnName, f.severity]), [['posts_user', 'user_id', 'error']]);
  const setNull = byRule(findings, 'set-null-not-null');
  assert.deepEqual(setNull.map(f => [f.relationId, f.columnName, f.severity]), [['posts_editor', 'editor_id', 'error']]);
  const nullable = structuredClone(schema);
  nullable.tables[1].columns[2].nullable = true;
  assert.equal(byRule(lintSchema(nullable), 'set-null-not-null').length, 0);
  const varchars = { tables: [table('a', [col('code', 'character varying(255)', { primary: true })]), table('b', [pk(), col('a_code', 'varchar(80)')])], relations: [rel('r', 'b', 'a', [['a_code', 'code']])] };
  assert.equal(byRule(lintSchema(varchars), 'fk-type-mismatch').length, 0);
});

test('fk-without-index runs only when indexes were read', () => {
  const make = (indexes, extra = {}) => ({ tables: [
    table('orders', [pk()], { indexes: [] }),
    table('lines', [col('order_id', 'bigint', { primary: true }), col('line', 'integer', { primary: true }), col('product_id', 'bigint'), col('tax_id', 'bigint')], { indexes, ...extra }),
    table('products', [pk()], { indexes: [] }), table('taxes', [pk()], { indexes: [] })
  ], relations: [
    rel('lines_order', 'lines', 'orders', [['order_id', 'id']]),
    rel('lines_product', 'lines', 'products', [['product_id', 'id']]),
    rel('lines_tax', 'lines', 'taxes', [['tax_id', 'id']])
  ] });
  assert.equal(byRule(lintSchema(make(undefined)), 'fk-without-index').length, 0);
  const missing = byRule(lintSchema(make([['line', 'product_id']])), 'fk-without-index');
  assert.deepEqual(missing.map(f => f.relationId), ['lines_product', 'lines_tax']);
  assert.equal(missing[0].severity, 'info');
  assert.match(missing[0].detail, /products/);
  const covered = byRule(lintSchema(make([['product_id', 'line']], { uniqueKeys: [['tax_id']] })), 'fk-without-index');
  assert.equal(covered.length, 0);
});

test('duplicate relations and isolated tables', () => {
  const schema = { tables: [table('users', [pk()]), table('posts', [pk(), col('user_id', 'bigint')]), table('settings', [pk()])], relations: [
    rel('a', 'posts', 'users', [['user_id', 'id']]),
    rel('b', 'posts', 'users', [['user_id', 'id']], { kind: 'proposed' })
  ] };
  const findings = lintSchema(schema);
  assert.deepEqual(byRule(findings, 'duplicate-relation').map(f => f.relationId), ['b']);
  assert.deepEqual(byRule(findings, 'isolated-table').map(f => f.tableId), ['settings']);
  assert.equal(byRule(lintSchema({ tables: [table('solo', [pk()])], relations: [] }), 'isolated-table').length, 0);
});

test('findings sort by severity, then table name, and ids are unique', () => {
  const schema = { tables: [
    table('zeta', [col('note', 'text')]), table('alpha', [col('note', 'text')]),
    table('users', [pk('uuid')]), table('posts', [pk(), col('user_id', 'bigint')])
  ], relations: [rel('posts_user', 'posts', 'users', [['user_id', 'id']])] };
  const findings = lintSchema(schema);
  assert.deepEqual(findings.map(f => `${f.severity}:${f.tableId}:${f.rule}`), [
    'error:posts:fk-type-mismatch',
    'warning:alpha:no-primary-key', 'warning:zeta:no-primary-key',
    'info:alpha:isolated-table', 'info:zeta:isolated-table'
  ]);
  assert.equal(new Set(findings.map(f => f.id)).size, findings.length);
  for (const f of findings) assert.ok(f.title && f.detail);
});

test('tolerates odd input and the bundled samples', async () => {
  assert.deepEqual(lintSchema(null), []);
  assert.deepEqual(lintSchema({ tables: [table('t', undefined)], relations: [rel('r', 't', 'missing', [['a', 'b']])] }).map(f => f.rule), ['empty-table']);
  for (const name of ['sufra-products', 'sufra-supply']) {
    const file = JSON.parse(await readFile(new URL(`../public/samples/${name}.eratlas.json`, import.meta.url), 'utf8'));
    const findings = lintSchema(file.schema);
    assert.ok(Array.isArray(findings));
    assert.equal(new Set(findings.map(f => f.id)).size, findings.length);
  }
});
