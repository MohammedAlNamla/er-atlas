// Checks on the draft itself: what each staged operation would do to the database as read (base),
// before anyone runs it. Sizes come from the base tables; a table the draft creates is never at risk.
import { sizeOf, makeFinding, HUGE, LARGE, SMALL } from './util.js';
import { normalizeType } from '../../public/lint.js';

const empty = value => value === null || value === undefined || value === '';
const draftEvidence = (operation, text) => ({ kind: 'draft', text: text || `${operation.type}` });
// Lock-heavy work grows with the table: none under 10k rows, info to 100k, warning above, error from 10M.
function bySize(size) {
  if (!size.known || size.rows < SMALL) return null;
  return size.rows >= HUGE ? 'error' : size.rows >= LARGE ? 'warning' : 'info';
}
// Type changes PostgreSQL makes without rewriting the table (from migration-safety MS03).
function rewriteFree(before, after) {
  const from = String(before).toLowerCase().trim(), to = String(after).toLowerCase().trim();
  if (normalizeType(from) === normalizeType(to) && !/\(/.test(from) && !/\(/.test(to)) return true; // alias only
  const varchar = /^(?:varchar|character varying)(?:\((\d+)\))?$/, numeric = /^(?:numeric|decimal)(?:\((\d+)(?:,\s*(\d+))?\))?$/;
  const [a, b] = [varchar.exec(from), varchar.exec(to)];
  if (a && b) return !b[1] || (a[1] && Number(b[1]) >= Number(a[1]));
  if (a && to === 'text') return true;
  if (from === 'text' && b && !b[1]) return true;
  const [n, m] = [numeric.exec(from), numeric.exec(to)];
  if (n && m) return !m[1] || (n[1] && Number(m[1]) >= Number(n[1]) && (n[2] || '0') === (m[2] || '0'));
  return false;
}

export const draftChecks = {
  // MS01: NOT NULL column with no default added to a table that has rows.
  MS01(ctx) {
    return ctx.operations.filter(op => op.type === 'addColumn' && !ctx.newTables.has(op.tableId) && op.column?.nullable === false && empty(op.column.default)
      && !/^(small|big)?serial$/i.test(String(op.column.type))).flatMap(op => {
      const table = ctx.base.tables.find(t => t.id === op.tableId);
      if (!table) return [];
      const size = sizeOf(table);
      return [makeFinding('MS01', table, { column: op.column.name, confidence: size.known ? 'high' : 'medium',
        detail: `إضافة ${op.column.name} ‏NOT NULL بلا قيمة افتراضية تفشل إذا كان في ${table.name} صف واحد${size.known ? ` (≈ ${size.rows.toLocaleString('en-US')} صف)` : ''}. أضفه nullable، عبّئه، ثم اجعله NOT NULL، أو أعطه قيمة افتراضية.`,
        evidence: [draftEvidence(op, `addColumn ${table.name}.${op.column.name} ${op.column.type} NOT NULL`)] })];
    });
  },
  // MS02: making an existing column NOT NULL on a table with data.
  MS02(ctx) {
    return ctx.operations.filter(op => op.type === 'updateColumn' && op.patch?.nullable === false && !ctx.newTables.has(op.tableId)).flatMap(op => {
      const table = ctx.base.tables.find(t => t.id === op.tableId), column = table?.columns.find(c => c.name === op.columnName);
      if (!table || !column?.nullable) return [];
      if ((table.checks || []).some(check => new RegExp(`\\b${column.name}\\b\\s+IS NOT NULL`, 'i').test(check.definition || ''))) return []; // a validated CHECK skips the scan
      const size = sizeOf(table), nulls = ctx.stats?.nullFraction?.[table.id]?.[column.name];
      const severity = nulls > 0 ? 'error' : size.known && size.small ? 'info' : 'warning';
      return [makeFinding('MS02', table, { column: column.name, severity, confidence: nulls > 0 || size.large ? 'high' : size.known ? 'medium' : 'low',
        detail: `جعل ${table.name}.${column.name} NOT NULL يفحص كل الصفوف تحت قفل${nulls > 0 ? `، و${Math.round(nulls * 100)}% منها NULL الآن فستفشل العملية` : ''}.`,
        evidence: [draftEvidence(op, `updateColumn ${table.name}.${column.name} → NOT NULL`)] })];
    });
  },
  // MS03: a type change that rewrites a large table.
  MS03(ctx) {
    return ctx.operations.filter(op => op.type === 'updateColumn' && op.patch?.type && !ctx.newTables.has(op.tableId)).flatMap(op => {
      const table = ctx.base.tables.find(t => t.id === op.tableId), column = table?.columns.find(c => c.name === op.columnName);
      if (!table || !column || column.type === op.patch.type || rewriteFree(column.type, op.patch.type)) return [];
      let severity = bySize(sizeOf(table));
      if (!severity) return [];
      const referenced = column.primary && ctx.base.relations.some(r => r.target === table.id && r.pairs.some(p => p.target === column.name));
      if (referenced) severity = 'error';
      return [makeFinding('MS03', table, { column: column.name, severity, confidence: 'high',
        detail: `${column.type} → ${op.patch.type} يعيد كتابة ${table.name} كاملًا تحت قفل يمنع القراءة والكتابة${referenced ? '، والمفاتيح الأجنبية التي تشير إلى العمود تحتاج التغيير نفسه' : ''}.`,
        evidence: [draftEvidence(op, `updateColumn ${table.name}.${column.name}: ${column.type} → ${op.patch.type}`)] })];
    });
  },
  // MS04: dropping or renaming something the code still uses.
  MS04(ctx) {
    const live = item => item && !String(item.file).startsWith('database/migrations/');
    const findings = [];
    for (const op of ctx.operations) {
      if (ctx.newTables.has(op.tableId)) continue;
      const table = ctx.base.tables.find(t => t.id === op.tableId);
      if (!table) continue;
      const models = ctx.facts.models.filter(m => m.tableId === table.id && !m.abstract);
      if (op.type === 'dropTable' || op.type === 'renameTable') {
        // Renaming to the name a model without $table already expects fixes the mapping instead of breaking it.
        if (op.type === 'renameTable' && models.every(m => !m.explicitTable && m.table === op.name) && models.length) continue;
        const refs = [...models.map(m => ({ file: m.file, line: m.line, text: m.explicitTable ? `protected $table = '${m.explicitTable}';` : `class ${m.class.split('\\').at(-1)}` })),
          ...ctx.facts.queries.filter(q => q.receiver?.root?.kind === 'table' && q.receiver.root.name === table.name).map(q => ({ file: q.file, line: q.line, text: q.text })),
          ...(live(ctx.facts.mentions?.[table.id]) ? [ctx.facts.mentions[table.id]] : [])].filter(live);
        if (refs.length) findings.push(makeFinding('MS04', table, { key: op.type, confidence: models.some(m => m.explicitTable) ? 'high' : 'medium',
          detail: `${op.type === 'dropTable' ? 'حذف' : `تسمية ${table.name} إلى ${op.name}`} يكسر ${refs.length} موضعًا في الكود ما زال يستخدم ${table.name}.`,
          evidence: [draftEvidence(op, `${op.type} ${table.name}`), ...refs.slice(0, 4).map(ref => ({ kind: 'code', ...ref }))] }));
        continue;
      }
      const renamed = op.type === 'updateColumn' && op.patch?.name && op.patch.name !== op.columnName;
      if (op.type !== 'dropColumn' && !renamed) continue;
      const name = op.columnName;
      const lists = models.flatMap(m => ['fillable', 'guarded', 'hidden', 'visible', 'dates'].filter(key => m[key]?.names.includes(name)).map(key => ({ ...m[key], file: m.file, key }))
        .concat(m.casts?.entries.some(e => e.name === name) ? [{ ...m.casts, file: m.file, key: 'casts' }] : []));
      const queries = ctx.facts.queries.filter(q => (q.column === name || q.column === `${table.name}.${name}`) && live(q)
        && (q.receiver?.root?.kind === 'table' ? q.receiver.root.name === table.name : models.some(m => m.class === q.receiver?.root?.name)));
      const refs = [...queries, ...lists].filter(live);
      if (!refs.length) continue;
      const onlyLists = !queries.length && lists.every(item => ['hidden', 'visible'].includes(item.key));
      findings.push(makeFinding('MS04', table, { column: name, key: op.type, severity: onlyLists ? 'info' : 'error', confidence: 'high',
        detail: `${op.type === 'dropColumn' ? 'حذف' : `تسمية إلى ${op.patch.name}`} ${table.name}.${name} يكسر ${refs.length} موضعًا في الكود.`,
        evidence: [draftEvidence(op, `${op.type} ${table.name}.${name}`), ...refs.slice(0, 4).map(ref => ({ kind: 'code', file: ref.file, line: ref.line, text: ref.text }))] }));
    }
    return findings;
  },
  // MS05: an index built with a write lock on a large table.
  MS05(ctx) {
    return ctx.operations.filter(op => op.type === 'addIndex' && !op.index?.concurrently && !ctx.newTables.has(op.tableId)).flatMap(op => {
      const table = ctx.base.tables.find(t => t.id === op.tableId), severity = table && bySize(sizeOf(table));
      if (!severity) return [];
      const mysql = ctx.engine === 'mysql';
      return [makeFinding('MS05', table, { key: op.index.name, severity, confidence: 'high',
        title: mysql ? 'إنشاء فهرس على جدول كبير دون LOCK=NONE' : undefined,
        detail: `${op.index.name} على ${table.name} (≈ ${sizeOf(table).rows.toLocaleString('en-US')} صف) يمنع الكتابة حتى ينتهي البناء؛ فعّل «${mysql ? 'دون قفل الجدول (LOCK=NONE)' : 'CONCURRENTLY'}» في الفهرس.${op.index.unique ? ' الفهرس فريد: البناء يفشل إن وُجدت قيم مكررة.' : ''}`,
        evidence: [draftEvidence(op, `addIndex ${op.index.name} ON ${table.name} (${op.index.columns.join(', ')})`)] })];
    });
  },
  // MS06: a new foreign key validated against every row of a large table at once.
  MS06(ctx) {
    return ctx.operations.filter(op => op.type === 'addRelation' && !ctx.newTables.has(op.relation?.source)).flatMap(op => {
      const table = ctx.base.tables.find(t => t.id === op.relation.source), severity = table && bySize(sizeOf(table));
      if (!severity) return [];
      return [makeFinding('MS06', table, { key: op.relation.name, severity, confidence: 'high',
        detail: `إضافة ${op.relation.name} تتحقق من كل صفوف ${table.name} دفعة واحدة تحت قفل. ${ctx.engine === 'mysql' ? 'في MySQL أضفه في نافذة صيانة أو بأداة online schema change.' : 'أضفه بـ NOT VALID ثم VALIDATE CONSTRAINT في خطوة منفصلة.'}`,
        evidence: [draftEvidence(op, `addRelation ${op.relation.name} ON ${table.name}`)] })];
    });
  },
  // MS07: a new column whose default is volatile, so every existing row is rewritten.
  MS07(ctx) {
    const volatile = /(gen_random_uuid|uuid_generate_v[14]|clock_timestamp|timeofday|random|nextval|uuid)\s*\(/i;
    return ctx.operations.filter(op => op.type === 'addColumn' && !ctx.newTables.has(op.tableId)
      && (volatile.test(String(op.column?.default || '')) || /^(small|big)?serial$/i.test(String(op.column?.type)))).flatMap(op => {
      const table = ctx.base.tables.find(t => t.id === op.tableId), severity = table && bySize(sizeOf(table));
      if (!severity) return [];
      return [makeFinding('MS07', table, { column: op.column.name, severity, confidence: 'high',
        detail: `القيمة الافتراضية ${op.column.default || op.column.type} تُحسب لكل صف، فتُعاد كتابة ${table.name} كاملًا. أضف العمود بلا قيمة، عبّئه على دفعات، ثم ضع القيمة الافتراضية.`,
        evidence: [draftEvidence(op, `addColumn ${table.name}.${op.column.name} DEFAULT ${op.column.default || op.column.type}`)] })];
    });
  }
};
