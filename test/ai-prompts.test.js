import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildSchemaText, extractJson, readColumnNotes, TOKEN_LIMITS, MODES } from '../ai-prompts.js';

const column = (name, extra = {}) => ({ name, type: 'bigint', nullable: true, default: null, description: '', primary: false, unique: false, foreign: false, ...extra });
const schema = {
  tables: [
    { id: '1', schema: 'public', name: 'orders', description: 'طلبات العملاء', approxRows: 120, columns: [column('id', { primary: true, nullable: false }), column('store_id', { nullable: false, foreign: true }), column('status', { type: 'text', default: "'new'::text", description: 'حالة الطلب' })] },
    { id: '2', schema: 'public', name: 'stores', description: '', approxRows: 0, columns: [column('id', { primary: true, nullable: false }), column('name', { type: 'text' })] },
    { id: '3', schema: 'public', name: 'logs', description: '', approxRows: 0, columns: [column('id', { primary: true, nullable: false })] }
  ],
  relations: [{ id: 'r1', name: 'orders_store_fk', source: '1', target: '2', pairs: [{ source: 'store_id', target: 'id' }], onDelete: 'c', kind: 'actual' }]
};

test('every mode has an output budget', () => {
  for (const mode of MODES) assert.ok(TOKEN_LIMITS[mode] >= 2000, mode);
});

test('schema text carries keys, FK targets, delete action, defaults and comments', () => {
  const { text } = buildSchemaText(schema);
  assert.match(text, /TABLE public\.orders ≈120 rows -- طلبات العملاء/);
  assert.match(text, /store_id bigint FK→public\.stores\.id ON DELETE CASCADE NOT NULL/);
  assert.match(text, /status text DEFAULT 'new'::text -- حالة الطلب/);
  assert.match(text, /REL public\.orders \(store_id→id\) → public\.stores ON DELETE CASCADE/);
});

test('large schemas keep full detail for the focus table and its neighbours only', () => {
  const wide = { ...schema, tables: schema.tables.map(table => table.id === '3' ? { ...table, columns: [...table.columns, ...Array.from({ length: 12 }, (_, index) => column(`field_${index}`))] } : table) };
  const full = buildSchemaText(wide);
  assert.equal(full.trimmed, false);
  const { text, trimmed } = buildSchemaText(wide, { focusTableId: '1', budget: full.text.length - 10 });
  assert.equal(trimmed, true);
  assert.doesNotMatch(text, /field_3/);
  assert.match(text, /store_id bigint FK/);
  assert.match(text, /TABLE public\.logs\n {2}\(13 أعمدة؛ PK: id\)/);
  assert.throws(() => buildSchemaText(schema, { budget: 20 }), /كبير جدًا/);
});

test('prompt wraps data in tags, ignores unknown focus ids and names the selection', () => {
  const { prompt } = buildPrompt({ mode: 'explain', question: 'ما هذا؟', schema, focus: { tableId: '1' }, history: [{ role: 'user', content: 'سابق' }] });
  assert.match(prompt, /<schema format="sql-like">/);
  assert.match(prompt, /الجدول المحدد: public\.orders\./);
  assert.match(prompt, /<history>\nالمستخدم: سابق/);
  const stray = buildPrompt({ mode: 'explain', question: 'x', schema, focus: { tableId: 'nope' } }).prompt;
  assert.doesNotMatch(stray, /الجدول المحدد/);
});

test('layout and topics prompts keep ids; layout adds relation counts', () => {
  const layout = buildPrompt({ mode: 'layout', question: 'رتب', schema }).prompt;
  assert.match(layout, /"id":"1","name":"public\.orders","relations":1/);
  assert.match(layout, /"id":"3","name":"public\.logs","relations":0/);
  assert.match(layout, /"reason"/);
});

test('columns prompt scopes the schema to the table and its neighbours and carries evidence', () => {
  const { prompt } = buildPrompt({ mode: 'columns', question: 'اشرح', schema, focus: { tableId: '1' }, evidence: [{ file: 'app/Models/Order.php', line: 12, syntax: 'belongsTo(Store::class)' }] });
  assert.match(prompt, /<table_to_explain>public\.orders<\/table_to_explain>/);
  assert.match(prompt, /TABLE public\.stores/);
  assert.doesNotMatch(prompt, /public\.logs/);
  assert.match(prompt, /app\/Models\/Order\.php:12 — belongsTo\(Store::class\)/);
  assert.throws(() => buildPrompt({ mode: 'columns', question: 'x', schema, focus: {} }), /اختر جدولًا/);
});

test('JSON extraction tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('تفضل:\n{"a":[1]}\nانتهى'), { a: [1] });
  assert.equal(extractJson('لا شيء'), null);
});

test('column notes keep real columns only, match case-insensitively and report gaps', () => {
  const answer = JSON.stringify({ summary: 'طلبات', columns: [
    { name: 'id', meaning: 'معرّف الطلب', basis: 'schema' },
    { name: 'STORE_ID', meaning: 'المتجر الذي أُنشئ فيه الطلب', basis: 'weird' },
    { name: 'ghost', meaning: 'غير موجود', basis: 'name' },
    { name: 'id', meaning: 'مكرر', basis: 'name' }
  ] });
  const notes = readColumnNotes(answer, schema.tables[0]);
  assert.deepEqual(Object.keys(notes.columns), ['id', 'store_id']);
  assert.equal(notes.columns.id.text, 'معرّف الطلب');
  assert.equal(notes.columns.store_id.basis, 'schema');
  assert.deepEqual(notes.missing, ['status']);
  assert.equal(notes.summary, 'طلبات');
  assert.throws(() => readColumnNotes('نص عادي', schema.tables[0]), /شرحًا صالحًا/);
  assert.throws(() => readColumnNotes('{"columns":[{"name":"x","meaning":"y"}]}', schema.tables[0]), /لأي عمود/);
});
