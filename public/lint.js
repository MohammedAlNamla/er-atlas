// Local schema lint: deterministic checks over the schema/draft shape, no network and no AI.
export const LINT_RULES = [
  { id: 'fk-type-mismatch', severity: 'error', label: 'نوع المفتاح الأجنبي لا يطابق الهدف' },
  { id: 'set-null-not-null', severity: 'error', label: 'SET NULL على عمود إلزامي' },
  { id: 'no-primary-key', severity: 'warning', label: 'جدول بلا مفتاح أساسي' },
  { id: 'empty-table', severity: 'warning', label: 'جدول بلا أعمدة' },
  { id: 'missing-foreign-key', severity: 'warning', label: 'عمود ربط بلا علاقة' },
  { id: 'duplicate-relation', severity: 'warning', label: 'علاقة مكررة' },
  { id: 'fk-without-index', severity: 'info', label: 'مفتاح أجنبي بلا فهرس' },
  { id: 'isolated-table', severity: 'info', label: 'جدول معزول' }
];
const ruleById = new Map(LINT_RULES.map(rule => [rule.id, rule]));
const severityRank = { error: 0, warning: 1, info: 2 };
const aliases = {
  int: 'integer', int4: 'integer', serial: 'integer', serial4: 'integer',
  int8: 'bigint', bigserial: 'bigint', serial8: 'bigint',
  int2: 'smallint', smallserial: 'smallint', serial2: 'smallint',
  'character varying': 'varchar', character: 'char', bpchar: 'char',
  decimal: 'numeric', bool: 'boolean', float8: 'double precision', float: 'double precision', float4: 'real',
  'timestamp without time zone': 'timestamp', 'time without time zone': 'time', 'time with time zone': 'timetz'
};
const irregular = { person: 'people', child: 'children' };

export function normalizeType(type) {
  let text = String(type ?? '').toLowerCase().trim();
  const array = /(\[\])+$/.exec(text)?.[0] || '';
  text = text.slice(0, text.length - array.length).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (/^timestamp\b.*\bwith time zone$/.test(text) || text === 'timestamptz') text = 'timestamptz';
  return (aliases[text] || text) + array;
}
const compatible = (a, b) => !a || !b || normalizeType(a) === normalizeType(b);

function pluralCandidates(stem) {
  const names = [stem, `${stem}s`, `${stem}es`];
  if (stem.endsWith('y')) names.push(`${stem.slice(0, -1)}ies`);
  if (irregular[stem]) names.push(irregular[stem]);
  return names;
}
const label = table => table?.name || table?.id || '؟';
const list = names => names.join(', ');

export function lintSchema(schema) {
  const tables = Array.isArray(schema?.tables) ? schema.tables : [];
  const relations = Array.isArray(schema?.relations) ? schema.relations : [];
  const byId = new Map(tables.map(t => [t.id, t]));
  const byName = new Map();
  for (const t of tables) byName.set(t.name, [...(byName.get(t.name) || []), t]);
  const columnOf = (table, name) => table?.columns?.find(c => c.name === name);
  const findings = [];
  const add = (rule, table, fields) => findings.push({
    id: [rule, table.id, fields.relationId, fields.columnName].filter(v => v != null && v !== '').join(':'),
    rule, severity: ruleById.get(rule).severity, tableId: table.id, ...fields
  });

  for (const table of tables) {
    const columns = table.columns || [];
    if (!columns.length) {
      add('empty-table', table, { title: `${label(table)} بلا أعمدة`, detail: 'الجدول لا يحتوي أي عمود بعد؛ أضف المفتاح الأساسي والأعمدة قبل اعتماده.' });
      continue;
    }
    if (!columns.some(c => c.primary)) add('no-primary-key', table, { title: `${label(table)} بلا مفتاح أساسي`, detail: 'بدون مفتاح أساسي لا يمكن تمييز الصفوف بثقة، ولا تستطيع الجداول الأخرى الإشارة إليه بعلاقة.' });
    const linked = new Set(relations.filter(r => r.source === table.id).flatMap(r => (r.pairs || []).map(p => p.source)));
    for (const column of columns) {
      const match = /^(.+)_id$/.exec(column.name || '');
      if (!match || column.primary || column.foreign || linked.has(column.name)) continue;
      const found = pluralCandidates(match[1]).flatMap(name => byName.get(name) || []);
      const target = found.find(t => t.schema === table.schema) || found[0];
      const keys = (target?.columns || []).filter(c => c.primary);
      if (keys.length !== 1) continue;
      const key = keys[0], ref = `${label(target)}.${key.name}`;
      const title = `${label(table)}.${column.name} بلا علاقة`;
      if (!compatible(column.type, key.type)) {
        add('missing-foreign-key', table, { columnName: column.name, title, detail: `يبدو أن العمود يشير إلى ${ref} بلا علاقة تحميه، لكن نوعه ${column.type} لا يطابق ${key.type} فوحّد النوعين قبل إضافة العلاقة.` });
        continue;
      }
      add('missing-foreign-key', table, {
        columnName: column.name, title,
        detail: `يبدو أن العمود يشير إلى ${ref} لكن لا توجد علاقة تحميه، فقد تبقى فيه قيم لا يقابلها أي صف.`,
        fix: { type: 'addRelation', relation: { id: null, name: `${table.name}_${column.name}_foreign`, source: table.id, target: target.id, pairs: [{ source: column.name, target: key.name }], onDelete: 'a' } }
      });
    }
  }

  const seen = new Map();
  for (const relation of relations) {
    const from = byId.get(relation.source), to = byId.get(relation.target);
    if (!from || !to) continue;
    const pairs = relation.pairs || [];
    const name = relation.name || relation.id;
    for (const pair of pairs) {
      const source = columnOf(from, pair.source), target = columnOf(to, pair.target);
      if (!source || !target || compatible(source.type, target.type)) continue;
      add('fk-type-mismatch', from, {
        relationId: relation.id, columnName: pair.source,
        title: `نوع ${label(from)}.${pair.source} لا يطابق ${label(to)}.${pair.target}`,
        detail: `العمود من نوع ${source.type} والهدف من نوع ${target.type}؛ اختلاف النوعين قد يمنع إنشاء القيد أو يفرض تحويلًا عند كل ربط.`
      });
    }
    const required = pairs.filter(p => columnOf(from, p.source)?.nullable === false).map(p => p.source);
    if (relation.onDelete === 'n' && required.length) add('set-null-not-null', from, {
      relationId: relation.id, columnName: required[0],
      title: `SET NULL على عمود إلزامي في ${label(from)}`,
      detail: `العلاقة ${name} تضع NULL في ${list(required)} عند حذف الصف في ${label(to)}، لكن العمود لا يقبل NULL فسيفشل الحذف.`
    });
    if (Array.isArray(from.indexes) && pairs.length) {
      const wanted = new Set(pairs.map(p => p.source));
      const primary = [...(from.columns || [])].filter(c => c.primary).sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(c => c.name);
      const keys = [...from.indexes, primary, ...(from.uniqueKeys || []), ...(from.columns || []).filter(c => c.unique).map(c => [c.name])];
      const covered = keys.some(key => Array.isArray(key) && key.length >= wanted.size && key.slice(0, wanted.size).every(c => wanted.has(c)));
      if (!covered) add('fk-without-index', from, {
        relationId: relation.id, columnName: pairs[0].source,
        title: `${label(from)}.${list([...wanted])} بلا فهرس`,
        detail: `لا يوجد فهرس يبدأ بـ ${list([...wanted])}، فكل حذف أو تعديل في ${label(to)} وكل ربط معه يمسح جدول ${label(from)} كاملًا.`
      });
    }
    const signature = [relation.source, relation.target, ...pairs.map(p => `${p.source}>${p.target}`).sort()].join('|');
    const first = seen.get(signature);
    if (!first) { seen.set(signature, relation); continue; }
    add('duplicate-relation', from, {
      relationId: relation.id,
      title: `${name} تكرر ${first.name || first.id}`,
      detail: `العلاقتان تربطان الأعمدة نفسها بين ${label(from)} و${label(to)}، فيُفحص القيد مرتين دون فائدة.`
    });
  }

  if (tables.length >= 2) {
    const connected = new Set(relations.flatMap(r => [r.source, r.target]));
    for (const table of tables) if (!connected.has(table.id)) add('isolated-table', table, {
      title: `${label(table)} غير مرتبط بأي جدول`,
      detail: 'لا يشير هذا الجدول إلى غيره ولا يشير إليه أي جدول؛ تأكد أن هذا مقصود أو أضف العلاقة الناقصة.'
    });
  }

  const order = new Map(LINT_RULES.map((rule, index) => [rule.id, index]));
  const nameOf = id => String(byId.get(id)?.name ?? id);
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]
    || cmp(nameOf(a.tableId), nameOf(b.tableId)) || order.get(a.rule) - order.get(b.rule) || cmp(a.id, b.id));
}
