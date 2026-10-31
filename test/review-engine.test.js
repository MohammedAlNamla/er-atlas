import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runReview } from '../review/engine.js';
import { analyzeSource } from '../code-context.js';
import { CHECKS } from '../review/catalog.js';

// A shop schema that mirrors test/fixtures/laravel-review, with known problems planted per check.
const col = (name, type, extra = {}) => ({ name, type, nullable: false, default: null, primary: false, unique: false, foreign: false, ...extra });
const pk = (name = 'id', type = 'bigint') => col(name, type, { primary: true, number: 1 });
const relation = (id, source, target, pairs, extra = {}) => ({ id, name: id, source, target, pairs: pairs.map(([s, t]) => ({ source: s, target: t })), onDelete: 'a', kind: 'actual', ...extra });
export function shopSchema() {
  const tables = [
    { id: 'users', schema: 'public', name: 'users', approxRows: 50000, columns: [pk(), col('name', 'character varying(255)'), col('email', 'character varying(255)', { unique: true }),
      col('password', 'character varying(255)'), col('is_admin', 'boolean', { nullable: true }), col('remember_token', 'character varying(100)', { nullable: true }),
      col('api_token', 'character varying(80)', { nullable: true }), col('created_at', 'timestamp without time zone', { nullable: true }), col('updated_at', 'timestamp without time zone', { nullable: true })],
      indexes: [['id'], ['email']], uniqueKeys: [['email']], checks: [] },
    { id: 'orders', schema: 'public', name: 'orders', approxRows: 500000, columns: [pk(), col('user_id', 'bigint', { foreign: true }), col('coupon_id', 'bigint', { nullable: true }),
      col('status', 'character varying(20)'), col('channel', 'character varying(10)'), col('total', 'double precision'), col('reference', 'character varying(40)'),
      col('placed_at', 'timestamp without time zone'), col('notes', 'text', { nullable: true }), col('deleted_at', 'timestamp without time zone', { nullable: true }),
      col('created_at', 'timestamp without time zone', { nullable: true }), col('updated_at', 'timestamp without time zone', { nullable: true })],
      indexes: [['id']], checks: [] },
    { id: 'order_items', schema: 'public', name: 'order_items', approxRows: 2000000, columns: [col('order_id', 'bigint', { primary: true, number: 1, foreign: true }),
      col('product_id', 'bigint', { primary: true, number: 2, foreign: true }), col('quantity', 'integer'), col('unit_price', 'real')],
      indexes: [['order_id', 'product_id'], ['order_id']], indexNames: ['order_items_pkey', 'order_items_order_id_index'], checks: [] },
    { id: 'products', schema: 'public', name: 'products', approxRows: 20000, columns: [pk(), col('name', 'text'), col('sku', 'character varying(64)'), col('price', 'numeric(12,2)'),
      col('secret_note', 'text', { nullable: true }), col('deleted_at', 'timestamp without time zone', { nullable: true }), col('created_at', 'timestamp without time zone', { nullable: true }), col('updated_at', 'timestamp without time zone', { nullable: true })],
      indexes: [['id']], checks: [] },
    { id: 'coupons', schema: 'public', name: 'coupons', approxRows: 100, columns: [pk(), col('code', 'character varying(20)'), col('discount', 'numeric(5,2)'),
      col('created_at', 'timestamp without time zone', { nullable: true }), col('updated_at', 'timestamp without time zone', { nullable: true })], indexes: [['id']], checks: [] },
    { id: 'settings', schema: 'public', name: 'settings', approxRows: 50, columns: [col('key', 'character varying(64)'), col('value', 'text')], indexes: [], checks: [] },
    { id: 'audit_logs', schema: 'public', name: 'audit_logs', approxRows: 300000, columns: [pk(), col('user_id', 'bigint', { nullable: true }), col('message', 'text')], indexes: [['id']], checks: [] },
    { id: 'customers', schema: 'public', name: 'customers', approxRows: 8000, columns: [pk(), col('national_id', 'character varying(20)'), col('card_cvv', 'character varying(4)', { nullable: true }), col('card_last4', 'character(4)', { nullable: true })], indexes: [['id']], checks: [] },
    { id: 'scratch_notes', schema: 'public', name: 'scratch_notes', approxRows: 10, columns: [pk(), col('note', 'text')], indexes: [['id']], checks: [] },
    { id: 'draftless', schema: 'public', name: 'draftless', approxRows: 0, columns: [], indexes: [], checks: [] }
  ];
  const relations = [
    relation('orders_user_id_foreign', 'orders', 'users', [['user_id', 'id']], { onDelete: 'c' }),
    relation('order_items_order_id_foreign', 'order_items', 'orders', [['order_id', 'id']], { onDelete: 'c' }),
    relation('order_items_product_id_foreign', 'order_items', 'products', [['product_id', 'id']], { onDelete: 'n' }),
    relation('order_items_product_id_again', 'order_items', 'products', [['product_id', 'id']], { onDelete: 'r' })
  ];
  return { database: 'shop', tables, relations, readOnly: true };
}
const fixture = join(process.cwd(), 'test', 'fixtures', 'laravel-review');
const ids = findings => new Set(findings.map(finding => finding.check));
const find = (findings, check, table, column) => findings.find(f => f.check === check && f.tableId === table && (column === undefined || f.columnName === column));

test('every catalog check has an implementation, and only missing inputs skip one', () => {
  const { coverage } = runReview({ schema: shopSchema() });
  assert.deepEqual(coverage.skipped.filter(item => item.reason === 'not implemented'), []);
  assert.equal(coverage.ran.length + coverage.skipped.length, CHECKS.length);
  assert.ok(coverage.skipped.every(item => ['no code', 'no stats', 'no draft'].includes(item.reason)));
});

test('schema checks find what was planted and leave the exceptions alone', () => {
  const { findings } = runReview({ schema: shopSchema() });
  // SD01 / SD02 / SD04 / SD05
  assert.ok(find(findings, 'SD01', 'settings'));
  assert.ok(find(findings, 'SD02', 'draftless'));
  assert.equal(find(findings, 'SD04', 'order_items').severity, 'error', 'duplicate keys with different ON DELETE');
  assert.ok(find(findings, 'SD05', 'scratch_notes'));
  assert.ok(!find(findings, 'SD05', 'settings'), 'settings tables stand alone by design');
  assert.ok(!find(findings, 'SD05', 'audit_logs'), 'a *_id matching a table is DR05, not SD05');
  // DI01: money in floating point; DI03: SET NULL on a NOT NULL key; DI04: cascade into a big unindexed table
  assert.equal(find(findings, 'DI01', 'orders', 'total').severity, 'error');
  assert.ok(find(findings, 'DI01', 'order_items', 'unit_price').fix.sql.includes('numeric(14,2)'));
  assert.ok(find(findings, 'DI03', 'order_items', 'product_id'));
  assert.equal(find(findings, 'DI04', 'orders').severity, 'error');
  assert.ok(!find(findings, 'DI04', 'order_items'), 'composite-key join rows cascade by design');
  // DI05 security flag, DI06 one finding per table and low confidence for Laravel's own timestamps
  assert.equal(find(findings, 'DI05', 'users', 'is_admin').severity, 'warning');
  assert.equal(findings.filter(f => f.check === 'DI06' && f.tableId === 'orders').length, 1);
  assert.equal(find(findings, 'DI06', 'users').confidence, 'low');
  // IX01: uncovered FKs (error when large and cascading), covered ones and the PK prefix are fine
  assert.equal(find(findings, 'IX01', 'orders', 'user_id').severity, 'error');
  assert.deepEqual(find(findings, 'IX01', 'orders', 'user_id').fix.operation.index.columns, ['user_id']);
  assert.ok(find(findings, 'IX01', 'order_items', 'product_id'));
  assert.ok(!find(findings, 'IX01', 'order_items', 'order_id'), 'the primary key starts with order_id');
  // IX04: the single-column index is a prefix of the primary key
  const ix04 = find(findings, 'IX04', 'order_items');
  assert.equal(ix04.confidence, 'medium');
  assert.match(ix04.fix.sql, /DROP INDEX CONCURRENTLY "public"\."order_items_order_id_index"/);
  // DR05 and SEC05 run from the schema alone
  assert.equal(find(findings, 'DR05', 'audit_logs', 'user_id').severity, 'info', 'log tables keep ids after the parent is gone');
  assert.equal(find(findings, 'SEC05', 'customers', 'card_cvv').severity, 'error');
  assert.equal(find(findings, 'SEC05', 'customers', 'national_id').severity, 'warning');
  assert.ok(!find(findings, 'SEC05', 'customers', 'card_last4'));
  // Every finding traces to its check and carries evidence.
  assert.ok(findings.every(f => f.skill && f.evidence.length && f.source === 'engine'));
});

test('code checks read the Laravel project: security, drift and query indexes', async () => {
  const schema = shopSchema();
  const code = await analyzeSource(fixture, schema.tables);
  const { findings, coverage } = runReview({ schema, code });
  assert.ok(!coverage.skipped.some(item => item.reason === 'no code'));
  // SEC01: interpolated request input is an error; bound parameters and class constants are not findings
  const sec01 = findings.filter(f => f.check === 'SEC01');
  assert.ok(sec01.some(f => f.severity === 'error' && f.evidence[0].text.includes("{$request->input('q')}")));
  assert.ok(sec01.some(f => f.evidence[0].text.includes('orderBy($request->input')), 'a request-derived column name');
  assert.ok(!sec01.some(f => f.evidence[0].text.includes("whereRaw('total > ?'")));
  assert.ok(!sec01.some(f => f.evidence[0].text.includes('self::PAGE')));
  assert.ok(!sec01.some(f => f.evidence[0].file.startsWith('database/')), 'migrations are history, not attack surface');
  // SEC02: $guarded = [] with the whole request passed to create()
  assert.equal(find(findings, 'SEC02', 'orders').severity, 'error');
  assert.ok(findings.some(f => f.check === 'SEC02' && f.detail.includes('is_admin')));
  // SEC03/SEC04: api_token is neither hashed nor hidden; password is cast hashed and hidden; an encrypted cast clears secret_note
  assert.ok(find(findings, 'SEC04', 'users', 'api_token'));
  assert.ok(!find(findings, 'SEC04', 'users', 'password'));
  assert.ok(!find(findings, 'SEC03', 'users', 'password'));
  assert.ok(!find(findings, 'SEC03', 'products', 'secret_note'));
  // DR01: Order::coupon() has no FK behind it, and its fix is a staged relation
  const dr01 = find(findings, 'DR01', 'orders', 'coupon_id');
  assert.equal(dr01.fix.operation.relation.target, 'coupons');
  assert.ok(!find(findings, 'DR05', 'orders', 'coupon_id'), 'DR01 owns a column with an Eloquent relation');
  // DR02: models whose tables are missing; DR03: an unused table; DR04: a $fillable column that does not exist
  assert.ok(findings.some(f => f.check === 'DR02' && f.title.includes('legacy_things')));
  assert.equal(findings.find(f => f.check === 'DR02' && f.title.includes('ReportArchive')).confidence, 'low', 'another connection');
  assert.ok(find(findings, 'DR03', 'scratch_notes'));
  assert.ok(!find(findings, 'DR03', 'orders'));
  assert.ok(find(findings, 'DR04', 'users', 'nickname'));
  assert.ok(!find(findings, 'DR04', 'users', 'display_name'), '$appends with an accessor');
  assert.ok(!findings.some(f => f.check === 'DR04' && f.columnName === 'orders'), 'hiding a relation is fine');
  // IX02: where('sku') and orderBy('placed_at') lack an index; in-memory collection filters do not count
  assert.ok(find(findings, 'IX02', 'products', 'sku'));
  assert.ok(find(findings, 'IX02', 'orders', 'placed_at'));
  assert.ok(!find(findings, 'IX02', 'orders', 'notes'));
  assert.ok(!find(findings, 'IX02', 'users', 'email'), 'email has a unique index');
  // IX03: Order uses SoftDeletes on a large table with no deleted_at index
  assert.ok(find(findings, 'IX03', 'orders', 'deleted_at'));
  // DI02: the migration's ->enum('channel') constrains it; status is cast to a PHP enum (lower confidence)
  assert.ok(!find(findings, 'DI02', 'orders', 'channel'));
  assert.equal(find(findings, 'DI02', 'orders', 'status').confidence, 'medium');
});

test('statistics checks need real numbers and never call a constraint index unused', () => {
  const schema = shopSchema();
  const stats = {
    resetAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    tables: { orders: { seqScan: 5000, seqTupRead: 5000 * 400000, idxScan: 100, liveRows: 500000, lastAnalyze: '2026-10-01T00:00:00Z' } },
    indexes: [
      { tableId: 'order_items', name: 'order_items_pkey', columns: ['order_id', 'product_id'], scans: 0, unique: true, primary: true },
      { tableId: 'order_items', name: 'order_items_order_id_index', columns: ['order_id'], scans: 0, unique: false, primary: false, sizeBytes: 1024 },
      { tableId: 'audit_logs', name: 'audit_logs_message_index', columns: ['message'], scans: 0, unique: false, primary: false },
      { tableId: 'audit_logs', name: 'audit_logs_unknown', columns: ['message'], scans: null, unique: false, primary: false }
    ],
    nullFraction: {}
  };
  const { findings } = runReview({ schema, stats });
  assert.equal(find(findings, 'IX06', 'orders').severity, 'warning');
  const unused = findings.filter(f => f.check === 'IX05').map(f => f.id);
  assert.deepEqual(unused, ['IX05:audit_logs::audit_logs_message_index'], 'primary keys, FK-serving indexes and unmeasured (null) scans are not findings');
  assert.equal(find(findings, 'IX05', 'audit_logs').confidence, 'high');
});

test('draft checks judge each operation against the database as read', async () => {
  const schema = shopSchema();
  const code = await analyzeSource(fixture, schema.tables);
  const operations = [
    { type: 'addColumn', tableId: 'orders', column: { name: 'currency', type: 'char(3)', nullable: false, default: null } },
    { type: 'addColumn', tableId: 'orders', column: { name: 'token', type: 'uuid', nullable: true, default: 'gen_random_uuid()' } },
    { type: 'updateColumn', tableId: 'orders', columnName: 'notes', patch: { nullable: false } },
    { type: 'updateColumn', tableId: 'orders', columnName: 'reference', patch: { type: 'character varying(80)' } },
    { type: 'updateColumn', tableId: 'order_items', columnName: 'quantity', patch: { type: 'bigint' } },
    { type: 'addIndex', tableId: 'order_items', index: { name: 'order_items_quantity_index', columns: ['quantity'], unique: false } },
    { type: 'addRelation', relation: { id: 'r1', name: 'orders_coupon_id_foreign', source: 'orders', target: 'coupons', pairs: [{ source: 'coupon_id', target: 'id' }], onDelete: 'n' } },
    { type: 'dropColumn', tableId: 'orders', columnName: 'placed_at' },
    { type: 'addTable', id: 'draft:t', schema: 'public', name: 'tags' },
    { type: 'addColumn', tableId: 'draft:t', column: { name: 'label', type: 'text', nullable: false } }
  ];
  const { findings } = runReview({ schema, base: schema, code, operations });
  assert.equal(find(findings, 'MS01', 'orders', 'currency').severity, 'error');
  assert.ok(!findings.some(f => f.check === 'MS01' && f.columnName === 'label'), 'a new table has no rows');
  assert.ok(find(findings, 'MS02', 'orders', 'notes'));
  assert.ok(!find(findings, 'MS03', 'orders', 'reference'), 'widening a varchar does not rewrite');
  assert.equal(find(findings, 'MS03', 'order_items', 'quantity').severity, 'warning');
  assert.equal(find(findings, 'MS05', 'order_items').severity, 'warning');
  assert.equal(find(findings, 'MS06', 'orders').severity, 'warning');
  assert.ok(find(findings, 'MS07', 'orders', 'token'));
  const ms04 = find(findings, 'MS04', 'orders', 'placed_at');
  assert.equal(ms04.severity, 'error');
  assert.ok(ms04.evidence.some(item => item.text?.includes("orderBy('placed_at'")));
});

test('MySQL: DATETIME is the naive type, and draft advice speaks MySQL', () => {
  const schema = { ...shopSchema(), engine: 'mysql' };
  schema.tables = schema.tables.map(t => t.id !== 'orders' ? t : { ...t, columns: t.columns.map(c => c.name === 'placed_at' ? { ...c, type: 'datetime' } : c.name.endsWith('_at') ? { ...c, type: 'timestamp' } : c) });
  const { findings } = runReview({ schema, operations: [{ type: 'addIndex', tableId: 'order_items', index: { name: 'i', columns: ['quantity'] } }] });
  assert.match(find(findings, 'DI06', 'orders').detail, /^placed_at:/);
  assert.match(find(findings, 'MS05', 'order_items').title, /LOCK=NONE/);
  assert.match(find(findings, 'DI01', 'orders', 'total').fix.sql, /MODIFY COLUMN `total` decimal\(14,2\)/);
});

test('a schema saved without index data skips the index checks instead of flagging every key', () => {
  const schema = shopSchema();
  schema.tables = schema.tables.map(({ indexes, indexNames, ...table }) => table);
  const { findings, coverage } = runReview({ schema });
  assert.ok(!findings.some(f => ['IX01', 'IX04'].includes(f.check)));
  assert.deepEqual(coverage.skipped.filter(item => item.reason === 'no indexes').map(item => item.check), ['IX01', 'IX04']);
  assert.notEqual(find(findings, 'DI04', 'orders').severity, 'error', 'unknown indexes do not escalate a cascade');
});

test('exported workspaces keep indexes, checks and the engine through an import', async () => {
  const { parseExport, buildExport } = await import('../public/workspace-io.js');
  const schema = { ...shopSchema(), engine: 'mysql' };
  schema.tables[0].checks = [{ name: 'users_email_check', definition: "email <> ''", columns: ['email'] }];
  schema.tables[0].columns[0].autoIncrement = true;
  const back = parseExport(JSON.stringify(buildExport({ name: 'shop', kind: 'database', schema, topics: [], positions: {}, operations: [], cursor: 0 }))).schema;
  assert.equal(back.engine, 'mysql');
  assert.deepEqual(back.tables.find(t => t.id === 'order_items').indexes, [['order_id', 'product_id'], ['order_id']]);
  assert.deepEqual(back.tables.find(t => t.id === 'order_items').indexNames, ['order_items_pkey', 'order_items_order_id_index']);
  assert.equal(back.tables[0].checks[0].definition, "email <> ''");
  assert.equal(back.tables[0].columns[0].autoIncrement, true);
});

test('project settings switch checks off, set severities and move the size limits', async () => {
  const { reviewSettings } = await import('../review/checks/util.js');
  const base = runReview({ schema: shopSchema() });
  const tuned = runReview({ schema: shopSchema(), settings: { disabled: ['DI06', 'SD05'], severity: { DI01: 'warning' }, limits: { small: 10, large: 1000000, huge: 50000000 } } });
  assert.ok(!tuned.findings.some(f => ['DI06', 'SD05'].includes(f.check)));
  assert.deepEqual(tuned.coverage.skipped.filter(item => item.reason === 'disabled').map(item => item.check), ['SD05', 'DI06']);
  const money = find(tuned.findings, 'DI01', 'orders', 'total');
  assert.equal(money.severity, 'warning');
  assert.equal(money.defaultSeverity, 'error', 'the playbook severity stays visible');
  // orders (500k rows) is no longer "large" once large starts at 1M: the cascade into it is not reported.
  assert.ok(find(base.findings, 'DI04', 'orders'));
  assert.ok(!find(tuned.findings, 'DI04', 'orders'));
  // Unknown checks, severities and out-of-order limits are dropped rather than trusted.
  assert.deepEqual(reviewSettings({ disabled: ['XX99', 'SD01'], severity: { SD01: 'fatal', SD02: 'info' }, limits: { small: 500, large: 100, huge: 1 } }),
    { disabled: ['SD01'], severity: { SD02: 'info' }, limits: { small: 10000, large: 100000, huge: 10000000 } });
});

test('evidence quotes a model\'s explicit $table by name and line', async () => {
  const schema = shopSchema();
  const { findings } = runReview({ schema, code: await analyzeSource(fixture, schema.tables) });
  const legacy = findings.find(f => f.check === 'DR02' && f.title.includes('legacy_things'));
  assert.equal(legacy.evidence[0].text, "protected $table = 'legacy_things';");
  assert.ok(!findings.some(f => f.evidence.some(item => String(item.text).includes('[object Object]'))));
});
