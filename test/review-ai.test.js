import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill, loadSkills, checkGuide } from '../review/skills.js';
import { buildReviewPrompt, readReviewAnswer, collectEvidence } from '../review/ai-review.js';
import { extractJson } from '../ai-prompts.js';
import { CHECKS, SKILLS } from '../review/catalog.js';

const playbook = `---\r\nid: indexing-performance\r\ntitle: الفهارس والأداء\r\nversion: 2\r\napplies_to: PostgreSQL 12+\r\n---\r\n\r\n# الفهارس والأداء\r\n\r\nمقدمة.\r\n\r\n## How to judge (AI)\r\n1. قاعدة أولى.\r\n\r\n## IX01 · مفتاح أجنبي بلا فهرس\r\n- **Severity:** warning\r\n\r\n## IX02 · عمود بلا فهرس\r\n- **Detect:** ...\r\n`;

test('a playbook parses into meta, judging rules and one section per check', () => {
  const skill = parseSkill(playbook);
  assert.equal(skill.id, 'indexing-performance');
  assert.equal(skill.version, 2);
  assert.equal(skill.intro, 'مقدمة.');
  assert.equal(skill.judge, '1. قاعدة أولى.');
  assert.deepEqual([...skill.checks.keys()], ['IX01', 'IX02']);
  assert.match(skill.checks.get('IX01').markdown, /Severity/);
});

test('every playbook on disk covers exactly its catalog checks, in order', async () => {
  const skills = await loadSkills({ fresh: true });
  for (const skill of skills.values()) {
    const expected = CHECKS.filter(check => check.skill === skill.id).map(check => check.id);
    assert.deepEqual([...skill.checks.keys()], expected, skill.id);
    assert.ok(skill.judge.length > 100, `${skill.id} has judging rules`);
    assert.ok(SKILLS.some(item => item.id === skill.id && item.title === skill.title), `${skill.id} title matches the catalog`);
  }
  if (skills.has('indexing-performance')) assert.equal(checkGuide(skills, 'IX01').skill, 'indexing-performance');
});

const schema = { tables: [
  { id: 'o', schema: 'public', name: 'orders', approxRows: 200000, columns: [{ name: 'id', type: 'bigint', primary: true }, { name: 'status', type: 'varchar(20)' }, { name: 'user_id', type: 'bigint' }] },
  { id: 'u', schema: 'public', name: 'users', columns: [{ name: 'id', type: 'bigint', primary: true }] }
], relations: [] };
const findings = [{ id: 'IX02:o:status', check: 'IX02', skill: 'indexing-performance', severity: 'warning', confidence: 'high', tableId: 'o', columnName: 'status', title: 'status بلا فهرس', detail: '...',
  evidence: [{ kind: 'code', file: 'app/Http/Controllers/OrderController.php', line: 14, text: "Order::where('status', $status)->get();" }] }];

test('the review prompt carries the catalog, playbooks, findings and citable evidence', () => {
  const skills = new Map([['indexing-performance', parseSkill(playbook)]]);
  const evidence = collectEvidence(findings, [{ file: 'app/Http/Controllers/OrderController.php', line: 14, text: 'dup' }, { file: 'app/Models/Order.php', line: 3, text: 'class Order' }]);
  assert.equal(evidence.length, 2);
  const prompt = buildReviewPrompt({ schema, findings, skills, evidence });
  for (const part of ['<catalog>', 'IX02 indexing-performance', '<playbooks>', 'قاعدة أولى', '<findings', '"IX02:o:status"', 'OrderController.php:14', '<schema']) assert.ok(prompt.includes(part), part);
});

test('the AI answer keeps only known findings and evidence-backed additions', () => {
  const evidence = collectEvidence(findings, [{ file: 'app/Models/Order.php', line: 3, text: 'class Order' }]);
  const answer = JSON.stringify({ summary: 'ملخص', plan: ['أضف فهرسًا'],
    order: [{ id: 'IX02:o:status', why: 'يُستدعى في كل طلب' }, { id: 'made-up', why: 'x' }],
    extra: [
      { check: 'IX02', tableId: 'o', columnName: 'user_id', title: 'user_id', detail: 'd', confidence: 'high', evidence: [{ file: 'app/Models/Order.php', line: 3 }] },
      { check: 'IX02', tableId: 'o', columnName: 'user_id', title: 'بلا دليل', detail: 'd', evidence: [{ file: 'app/Fake.php', line: 1 }] },
      { check: 'ZZ99', tableId: 'o', title: 'x' },
      { check: 'DI01', tableId: 'o', columnName: 'missing', title: 'x' },
      { check: 'SD01', tableId: 'u', title: 'schema-only addition', detail: 'd' }
    ] });
  const result = readReviewAnswer(answer, { schema, findings, evidence }, extractJson);
  assert.deepEqual(result.order.map(item => item.id), ['IX02:o:status']);
  assert.deepEqual(result.extra.map(item => [item.check, item.tableId, item.confidence, item.source]), [['IX02', 'o', 'low', 'ai'], ['SD01', 'u', 'low', 'ai']]);
  assert.deepEqual(result.dropped.map(item => item.reason), ['بلا دليل من الكود', 'فحص غير معروف', 'عمود غير موجود']);
  assert.equal(result.plan[0], 'أضف فهرسًا');
  assert.throws(() => readReviewAnswer('not json', { schema, findings, evidence }, extractJson), /مراجعة صالحة/);
});
