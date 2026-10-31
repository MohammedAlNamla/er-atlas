import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSkills, checkGuide, forEngine } from '../review/skills.js';
import { buildReviewPrompt } from '../review/ai-review.js';
import { CHECKS } from '../review/catalog.js';
import { runReview } from '../review/engine.js';

test('every playbook has MySQL judging rules and every check a MySQL note', async () => {
  const skills = await loadSkills({ fresh: true });
  for (const skill of skills.values()) {
    assert.ok(skill.judgeMysql.length > 50, `${skill.id} has MySQL rules`);
    assert.match(skill.appliesTo, /MySQL 8\.0\+/);
  }
  for (const check of CHECKS) {
    const markdown = [...skills.values()].map(skill => skill.checks.get(check.id)).find(Boolean)?.markdown || '';
    assert.match(markdown, /^- \*\*MySQL:\*\* \S/m, `${check.id} has a MySQL note`);
  }
});

test('a guide reads in its engine: no MySQL note for PostgreSQL, the note first for MySQL', async () => {
  const skills = await loadSkills();
  const pg = checkGuide(skills, 'IX01'), mysql = checkGuide(skills, 'IX01', 'mysql');
  assert.doesNotMatch(pg.markdown, /\*\*MySQL:\*\*|على MySQL/);
  assert.match(mysql.markdown, /^\*\*على MySQL \/ MariaDB:\*\* InnoDB ينشئ الفهرس تلقائيًا/);
  assert.equal(mysql.markdown.match(/InnoDB ينشئ الفهرس تلقائيًا/g).length, 1, 'the note moves, it is not repeated');
  assert.equal(forEngine('- **Severity:** x\n- **References:** y', 'mysql'), '- **Severity:** x\n- **References:** y', 'no note, nothing changes');
});

test('the AI brief and playbooks follow the schema engine', async () => {
  const skills = await loadSkills();
  const findings = [{ id: 'DI07:a:x', check: 'DI07', skill: 'data-integrity', severity: 'error', confidence: 'high', tableId: 'a', title: 't', detail: 'd', evidence: [] }];
  const schema = { tables: [{ id: 'a', schema: 'shop', name: 'a', columns: [{ name: 'x', type: 'int', nullable: false }] }], relations: [] };
  const mysql = buildReviewPrompt({ schema: { ...schema, engine: 'mysql' }, findings, skills });
  assert.match(mysql, /مراجع قواعد بيانات MySQL \/ MariaDB/);
  assert.match(mysql, /How to judge on MySQL \(AI\)/);
  assert.match(mysql, /InnoDB لا يدعم `SET DEFAULT`/);
  const pg = buildReviewPrompt({ schema, findings, skills });
  assert.match(pg, /مراجع قواعد بيانات PostgreSQL/);
  assert.doesNotMatch(pg, /\*\*MySQL:\*\*|على MySQL \/ MariaDB/);
});

test('engine verdicts follow MySQL behaviour where the notes say it differs', () => {
  const col = (name, type, extra = {}) => ({ name, type, nullable: false, default: null, primary: false, unique: false, foreign: false, ...extra });
  const schema = { engine: 'mysql', relations: [
    { id: 'r', name: 'items_order_id_foreign', source: 'shop.items', target: 'shop.orders', pairs: [{ source: 'order_id', target: 'id' }], onDelete: 'd', kind: 'actual' }
  ], tables: [
    { id: 'shop.orders', schema: 'shop', name: 'orders', approxRows: 2000000, indexes: [['id']], columns: [col('id', 'bigint unsigned', { primary: true }), col('code', 'varchar(40)'), col('title', 'varchar(50)')] },
    { id: 'shop.items', schema: 'shop', name: 'items', approxRows: 500, indexes: [['id'], ['order_id']], columns: [col('id', 'bigint unsigned', { primary: true }), col('order_id', 'bigint unsigned', { foreign: true, default: '0' })] }
  ] };
  const operations = [
    { type: 'addColumn', tableId: 'shop.orders', column: { name: 'currency', type: 'char(3)', nullable: false, default: null } },
    { type: 'addIndex', tableId: 'shop.orders', index: { name: 'orders_code_index', columns: ['code'] } },
    { type: 'updateColumn', tableId: 'shop.orders', columnName: 'code', patch: { type: 'varchar(60)' } },
    { type: 'updateColumn', tableId: 'shop.orders', columnName: 'title', patch: { type: 'varchar(80)' } }
  ];
  const { findings } = runReview({ schema, base: schema, operations });
  const get = (check, column) => findings.find(f => f.check === check && (column === undefined || f.columnName === column));
  assert.equal(get('DI07').severity, 'error', 'InnoDB rejects SET DEFAULT even with a default');
  assert.equal(get('MS01', 'currency').severity, 'warning');
  assert.match(get('MS01', 'currency').detail, /بصمت/);
  assert.equal(get('MS05').severity, 'info', 'InnoDB builds indexes with writes allowed');
  assert.ok(!get('MS03', 'code'), 'varchar(40) → varchar(60) stays under 256 bytes: in place');
  assert.ok(get('MS03', 'title'), 'varchar(50) → varchar(80) crosses 255 bytes in utf8mb4: rebuild');
  // The same draft on PostgreSQL keeps the PostgreSQL verdicts.
  const pg = runReview({ schema: { ...schema, engine: undefined }, base: { ...schema, engine: undefined }, operations }).findings;
  assert.equal(pg.find(f => f.check === 'MS01').severity, 'error');
  assert.equal(pg.find(f => f.check === 'MS05').severity, 'warning');
  assert.ok(!pg.find(f => f.check === 'DI07'), 'a NOT NULL column with a default is fine on PostgreSQL');
});
