// Checks that need only the schema (and, for IX05/IX06, live statistics): schema design, data
// integrity and the index checks that do not read code. Each follows its section in
// review/skills/<skill>.md; the comments name the playbook rule a branch implements.
import { sizeOf, isFrameworkTable, covered, indexesRead, makeFinding, HUGE, LARGE } from './util.js';

const DAY = 86400000;
const morphNames = table => new Set(table.columns.map(c => /^(.+)_type$/.exec(c.name)?.[1]).filter(name => name && table.columns.some(c => c.name === `${name}_id`)));
const lengthOf = type => Number(/\((\d+)\)/.exec(String(type))?.[1]) || null;
const relationText = (ctx, relation) => `${ctx.byId.get(relation.source)?.name}.(${relation.pairs.map(p => p.source).join(', ')}) → ${ctx.byId.get(relation.target)?.name}.(${relation.pairs.map(p => p.target).join(', ')})`;
const schemaEvidence = text => ({ kind: 'schema', text });
// A join table: few columns, at least two foreign keys to different tables.
function isPivot(ctx, table) {
  const targets = new Set(ctx.relations.filter(r => r.source === table.id).map(r => r.target));
  return targets.size >= 2 && table.columns.length <= 5;
}
const statsAgeDays = stats => stats?.resetAt ? (Date.now() - Date.parse(stats.resetAt)) / DAY : null;
const quote = (ctx, name) => ctx.engine === 'mysql' ? `\`${name}\`` : `"${name}"`;
const sqlTable = (ctx, table) => ctx.engine === 'mysql' ? quote(ctx, table.name) : `${quote(ctx, table.schema)}.${quote(ctx, table.name)}`;

// Integer widths, narrowest first; MySQL adds tinyint/mediumint and the unsigned flag.
const INT_RANK = { tinyint: 0, smallint: 1, mediumint: 2, integer: 3, bigint: 4 };

export const schemaChecks = {
  // SD01: a table with columns but no primary key.
  SD01(ctx) {
    return ctx.tables.filter(table => table.columns.length && !table.columns.some(c => c.primary) && !isFrameworkTable(table)).map(table => {
      const notNull = key => key.every(name => ctx.column(table, name)?.nullable === false);
      const alternate = [...(table.uniqueKeys || []), ...table.columns.filter(c => c.unique).map(c => [c.name])].find(notNull);
      const pivot = isPivot(ctx, table), size = sizeOf(table);
      const writes = ctx.stats?.tables?.[table.id] ? (ctx.stats.tables[table.id].updates || 0) + (ctx.stats.tables[table.id].deletes || 0) : 0;
      const severity = alternate ? 'info' : size.large && writes > 0 ? 'error' : 'warning';
      return makeFinding('SD01', table, { severity, confidence: ctx.newTables.has(table.id) ? 'low' : pivot ? 'medium' : 'high',
        detail: alternate ? `لا مفتاح أساسي، لكن (${alternate.join(', ')}) فريد وكل أعمدته NOT NULL فيصلح هوية للصف.` : pivot ? 'جدول وسيط بلا مفتاح أساسي؛ اجعل عمودي الربط مفتاحًا أساسيًا مركبًا.' : 'لا يوجد عمود يحدد الصف بشكل فريد.',
        evidence: [schemaEvidence(`${table.name}: ${table.columns.length} أعمدة، لا PRIMARY KEY`)] });
    });
  },
  // SD02: a table with no columns.
  SD02(ctx) {
    return ctx.tables.filter(table => !table.columns.length).map(table => makeFinding('SD02', table, {
      detail: ctx.newTables.has(table.id) ? 'جدول أضفته المسودة ولم تُضف إليه أعمدة بعد: أكمله قبل التسليم.' : 'جدول قائم بلا أعمدة، غالبًا بقايا.',
      evidence: [schemaEvidence(`${table.name}: 0 أعمدة`)] }));
  },
  // SD03: the foreign key's type differs from the key it references.
  SD03(ctx) {
    const findings = [];
    for (const relation of ctx.relations) {
      const source = ctx.byId.get(relation.source), target = ctx.byId.get(relation.target);
      if (!source || !target) continue;
      for (const pair of relation.pairs) {
        const from = ctx.column(source, pair.source), to = ctx.column(target, pair.target);
        if (!from || !to) continue;
        const a = ctx.type(from), b = ctx.type(to);
        if (a === b) {
          const [fromLength, toLength] = [lengthOf(from.type), lengthOf(to.type)];
          if (!(a === 'varchar' && fromLength && toLength && fromLength < toLength)) continue;
        }
        const text = new Set(['varchar', 'text']);
        if (text.has(a) && text.has(b)) continue; // binary compatible
        const [aBase, bBase] = [a.replace(/ unsigned$/, ''), b.replace(/ unsigned$/, '')];
        const sameSign = a.endsWith(' unsigned') === b.endsWith(' unsigned');
        // Wider source (bigint → integer) still joins; narrower or incomparable does not hold every value.
        const wider = sameSign && aBase in INT_RANK && bBase in INT_RANK && INT_RANK[aBase] > INT_RANK[bBase];
        findings.push(makeFinding('SD03', source, { column: pair.source, key: relation.id, severity: wider ? 'warning' : 'error',
          detail: `${source.name}.${pair.source} من النوع ${from.type} يشير إلى ${target.name}.${pair.target} من النوع ${to.type}.${ctx.engine === 'mysql' && !sameSign ? ' في MySQL لا يقبل مفتاح أجنبي اختلاف unsigned.' : ''}`,
          evidence: [schemaEvidence(`${relationText(ctx, relation)}: ${from.type} ≠ ${to.type}`)] }));
      }
    }
    return findings;
  },
  // SD04: the same constraint twice between the same tables and columns.
  SD04(ctx) {
    const seen = new Map(), findings = [];
    for (const relation of ctx.relations) {
      const signature = `${relation.source}|${relation.target}|${relation.pairs.map(p => `${p.source}>${p.target}`).sort().join(',')}`;
      const first = seen.get(signature);
      if (!first) { seen.set(signature, relation); continue; }
      const source = ctx.byId.get(relation.source);
      const conflicting = (first.onDelete || 'a') !== (relation.onDelete || 'a') || (first.onUpdate || 'a') !== (relation.onUpdate || 'a');
      const proposed = relation.kind && relation.kind !== 'actual';
      findings.push(makeFinding('SD04', source, { key: relation.id, severity: conflicting ? 'error' : 'warning',
        detail: proposed ? `المسودة تضيف قيدًا موجود أصلًا (${first.name}).` : `القيدان ${first.name} و${relation.name} على الأعمدة نفسها${conflicting ? ' بإجراءات حذف/تحديث مختلفة' : ''}.`,
        evidence: [schemaEvidence(relationText(ctx, relation))] }));
    }
    return findings;
  },
  // SD05: a table no relation touches.
  SD05(ctx) {
    if (ctx.tables.length < 2) return [];
    const linked = new Set(ctx.relations.flatMap(r => [r.source, r.target]));
    const standalone = /^(settings|configs?|options|countries|currencies|languages|locales|translations)$/;
    return ctx.tables.filter(table => !linked.has(table.id) && !isFrameworkTable(table) && !standalone.test(table.name) && table.columns.length).flatMap(table => {
      if (morphNames(table).size) return []; // linked only through polymorphic columns
      // A *_id column that matches an existing table is DR05's finding, not this one.
      if (table.columns.some(c => /^(.+)_id$/.test(c.name) && targetForStem(ctx, c.name.slice(0, -3)))) return [];
      const linky = table.columns.some(c => /_(id|uuid)$/.test(c.name));
      return [makeFinding('SD05', table, { confidence: linky ? 'medium' : 'low', detail: 'لا يشير إلى أي جدول ولا يشير إليه أحد.', evidence: [schemaEvidence(`${table.name}: 0 علاقات`)] })];
    });
  },
  // DI01: money in a binary floating type.
  DI01(ctx) {
    const money = /(^|_)(price|amount|total|subtotal|cost|fee|fees|balance|salary|wage|tax|vat|discount|refund|credit|debit|paid|payment|charge|commission|revenue|budget|cash|money)(_|$)/;
    const measure = /(rate|ratio|percent|percentage|pct|weight|lat|lng|latitude|longitude|score|distance|quantity|qty|count|duration)/;
    return ctx.tables.flatMap(table => table.columns.filter(c => ['real', 'double precision'].includes(ctx.type(c)) && money.test(c.name) && !measure.test(c.name)).map(column => {
      const estimate = /^(estimated|avg)_/.test(column.name);
      const generic = /^(value|total)$/.test(column.name) && !table.columns.some(c => c !== column && money.test(c.name));
      const fixType = ctx.engine === 'mysql' ? 'decimal(14,2)' : 'numeric(14,2)';
      return makeFinding('DI01', table, { column: column.name, severity: estimate ? 'warning' : 'error', confidence: generic ? 'medium' : 'high',
        detail: `${table.name}.${column.name} من النوع ${column.type}، والأنواع العشرية التقريبية لا تمثل المبالغ بدقة.`,
        evidence: [schemaEvidence(`${table.name}.${column.name} ${column.type}`)],
        fix: { sql: ctx.engine === 'mysql' ? `ALTER TABLE ${sqlTable(ctx, table)} MODIFY COLUMN ${quote(ctx, column.name)} ${fixType}${column.nullable ? ' NULL' : ' NOT NULL'};` : `ALTER TABLE ${sqlTable(ctx, table)} ALTER COLUMN ${quote(ctx, column.name)} TYPE ${fixType};` } });
    }));
  },
  // DI02: a free-text status column nothing constrains.
  DI02(ctx) {
    const name = /^(status|state|type|kind|stage|phase|role|level|priority|gender|channel|source|mode|category)$|_(status|state|type|kind|stage|phase|role|level|priority|mode)$/;
    const freeText = /^(mime_type|content_type|media_type|file_type|token_type|user_agent|source_url)$/;
    const enums = ctx.facts?.migrationEnums || [];
    return ctx.tables.filter(table => !isFrameworkTable(table) && table.name !== 'notifications').flatMap(table => {
      const morph = morphNames(table);
      return table.columns.filter(c => ['text', 'varchar', 'char'].includes(ctx.type(c)) && name.test(c.name) && !freeText.test(c.name) && !c.foreign && !c.enum
        && !morph.has(c.name.replace(/_type$/, ''))
        && !(table.checks || []).some(check => new RegExp(`\\b${c.name}\\b`).test(check.definition || ''))
        && !enums.some(e => e.table === table.name && e.column === c.name)).map(column => {
        const model = ctx.facts?.models.find(m => m.tableId === table.id);
        const cast = model?.casts?.entries.find(entry => entry.name === column.name && entry.kind === 'class');
        const checksRead = Array.isArray(table.checks);
        let confidence = checksRead ? 'high' : 'low';
        if (cast) confidence = confidence === 'high' ? 'medium' : 'low';
        const severity = sizeOf(table).large && /^(status|state)$/.test(column.name) ? 'warning' : 'info';
        return makeFinding('DI02', table, { column: column.name, severity, confidence,
          detail: `${table.name}.${column.name} نص حر؛ أي قيمة مكتوبة خطأً تُقبل.${cast ? ` الموديل يحوّله إلى ${cast.value.split('\\').at(-1)} لكن القاعدة لا تتحقق.` : ''}`,
          evidence: [schemaEvidence(`${table.name}.${column.name} ${column.type}، بلا CHECK`), ...(cast && model ? [{ kind: 'code', file: model.file, line: model.casts.line, text: model.casts.text }] : [])] });
      });
    });
  },
  // DI03: ON DELETE/UPDATE SET NULL on a column that cannot be null.
  DI03(ctx) {
    return ctx.relations.filter(r => r.onDelete === 'n' || r.onUpdate === 'n').flatMap(relation => {
      const source = ctx.byId.get(relation.source);
      return relation.pairs.filter(p => ctx.column(source, p.source)?.nullable === false).map(pair => makeFinding('DI03', source, { column: pair.source, key: relation.id,
        detail: `${relation.name || 'القيد'} يفرّغ ${source.name}.${pair.source} عند ${relation.onDelete === 'n' ? 'الحذف' : 'التحديث'}، لكن العمود NOT NULL فستفشل العملية.`,
        evidence: [schemaEvidence(`${relationText(ctx, relation)} ON ${relation.onDelete === 'n' ? 'DELETE' : 'UPDATE'} SET NULL؛ ${pair.source} NOT NULL`)] }));
    });
  },
  // DI04: ON DELETE CASCADE into a large table.
  DI04(ctx) {
    return ctx.relations.filter(r => r.onDelete === 'c').flatMap(relation => {
      const child = ctx.byId.get(relation.source), parent = ctx.byId.get(relation.target);
      const size = sizeOf(child);
      if (!child || !parent || !size.large || isPivot(ctx, child) || isFrameworkTable(child) || isFrameworkTable(parent)) return [];
      const parentRows = sizeOf(parent).rows;
      const unindexed = indexesRead(child) && !covered(ctx.keysOf(child), relation.pairs.map(p => p.source));
      // The cascade path upward: parents that themselves cascade from another table.
      const path = [child.name, parent.name];
      for (let at = parent, guard = 0; guard < 5; guard++) {
        const up = ctx.relations.find(r => r.source === at.id && r.onDelete === 'c');
        if (!up) break;
        at = ctx.byId.get(up.target); if (!at || path.includes(at.name)) break; path.push(at.name);
      }
      let severity = unindexed ? 'error' : 'warning';
      if (!unindexed && parentRows && size.rows / parentRows <= 100) severity = 'info';
      const softDeleted = ctx.facts?.models.some(m => m.tableId === parent.id && m.softDeletes);
      return [makeFinding('DI04', child, { key: relation.id, severity, confidence: softDeleted ? 'medium' : 'high',
        detail: `حذف صف من ${parent.name} يحذف صفوف ${child.name} (≈ ${size.rows.toLocaleString('en-US')} صف) في المعاملة نفسها${unindexed ? '، والعمود بلا فهرس' : ''}. المسار: ${path.reverse().join(' → ')}.`,
        evidence: [schemaEvidence(`${relationText(ctx, relation)} ON DELETE CASCADE`)] })];
    });
  },
  // DI05: a nullable boolean with no default.
  DI05(ctx) {
    const security = /^(is_admin|is_active|is_blocked|is_verified|is_staff|is_banned)$/;
    return ctx.tables.filter(table => !isFrameworkTable(table)).flatMap(table => table.columns.filter(c =>
      (ctx.type(c) === 'boolean' || /^tinyint\(1\)/.test(String(c.type))) && c.nullable && (!c.default || /^null$/i.test(c.default))).map(column => {
      const nulls = ctx.stats?.nullFraction?.[table.id]?.[column.name];
      const usesNull = (ctx.facts?.queries || []).some(q => /^(whereNull|whereNotNull|orWhereNull)$/.test(q.method) && q.column === column.name);
      return makeFinding('DI05', table, { column: column.name, severity: security.test(column.name) ? 'warning' : 'info',
        confidence: usesNull ? 'low' : nulls > 0 ? 'high' : 'medium',
        detail: `${table.name}.${column.name} يقبل ثلاث حالات: true وfalse وNULL.${nulls > 0 ? ` ${Math.round(nulls * 100)}% من صفوفه NULL الآن.` : ''}`,
        evidence: [schemaEvidence(`${table.name}.${column.name} ${column.type} NULL، بلا DEFAULT`)] });
    }));
  },
  // DI06: event times stored without a time zone (one finding per table).
  DI06(ctx) {
    const standard = /^(created_at|updated_at|deleted_at|email_verified_at)$/;
    // PostgreSQL: timestamp without time zone. MySQL: DATETIME (TIMESTAMP is stored in UTC and converted).
    const naive = column => ctx.engine === 'mysql' ? /^datetime/.test(String(column.type)) : ctx.type(column) === 'timestamp';
    return ctx.tables.filter(table => !isFrameworkTable(table) && !table.columns.some(c => /^(timezone|time_zone|tz)$/.test(c.name))).flatMap(table => {
      const columns = table.columns.filter(naive);
      if (!columns.length) return [];
      return [makeFinding('DI06', table, { confidence: columns.every(c => standard.test(c.name)) ? 'low' : 'medium',
        detail: `${columns.map(c => c.name).join('، ')}: ${ctx.engine === 'mysql' ? 'DATETIME لا يحفظ المنطقة الزمنية' : 'timestamp بلا منطقة زمنية'}، فمعنى القيمة يعتمد على إعداد من كتبها.`,
        evidence: [schemaEvidence(`${table.name}: ${columns.map(c => `${c.name} ${c.type}`).join(', ')}`)] })];
    });
  },
  // DI07: ON DELETE/UPDATE SET DEFAULT on a NOT NULL column with no default.
  DI07(ctx) {
    return ctx.relations.filter(r => r.onDelete === 'd' || r.onUpdate === 'd').flatMap(relation => {
      const source = ctx.byId.get(relation.source);
      // InnoDB does not support SET DEFAULT at all (MySQL note), so there every such key is the finding.
      if (ctx.engine === 'mysql') return [makeFinding('DI07', source, { column: relation.pairs[0]?.source, key: relation.id,
        detail: `${relation.name || 'القيد'} يستخدم SET DEFAULT، وInnoDB لا يدعمه؛ استبدله بـ SET NULL أو RESTRICT.`,
        evidence: [schemaEvidence(`${relationText(ctx, relation)} SET DEFAULT`)] })];
      return relation.pairs.filter(p => { const c = ctx.column(source, p.source); return c && c.nullable === false && (c.default === null || c.default === undefined || c.default === ''); })
        .map(pair => makeFinding('DI07', source, { column: pair.source, key: relation.id,
          detail: `${relation.name || 'القيد'} يضع القيمة الافتراضية في ${source.name}.${pair.source}، ولا قيمة افتراضية للعمود وهو NOT NULL.`,
          evidence: [schemaEvidence(`${relationText(ctx, relation)} SET DEFAULT؛ ${pair.source} NOT NULL بلا DEFAULT`)] }));
    });
  },
  // IX01: a foreign key no index or key can serve.
  IX01(ctx) {
    return ctx.relations.flatMap(relation => {
      const source = ctx.byId.get(relation.source), target = ctx.byId.get(relation.target);
      if (!source || !target || !indexesRead(source)) return [];
      const columns = relation.pairs.map(p => p.source);
      if (covered(ctx.keysOf(source), columns)) return [];
      if (source.id === target.id && columns.every(name => ctx.column(source, name)?.primary)) return [];
      const size = sizeOf(source), reference = /^(countries|currencies|languages|locales)$/.test(target.name);
      let severity = 'warning';
      if (size.large && ['c', 'n'].includes(relation.onDelete)) severity = 'error';
      if (size.known && size.small) severity = 'info';
      if (size.known && size.rows < 1000 && reference) severity = 'info';
      const name = `${source.name}_${columns.join('_')}_index`.slice(0, 63);
      return [makeFinding('IX01', source, { column: columns.length === 1 ? columns[0] : null, key: relation.id, severity,
        confidence: !size.known || (source.partialIndexes || []).length ? 'medium' : 'high',
        detail: `لا فهرس يبدأ بـ (${columns.join(', ')})؛ حذف صف من ${target.name} أو تحميل ${source.name} المرتبطة يمسح الجدول كاملًا.`,
        evidence: [schemaEvidence(relationText(ctx, relation))],
        fix: { operation: { type: 'addIndex', tableId: source.id, index: { name, columns, unique: false, concurrently: size.large && !ctx.newTables.has(source.id) } } } })];
    });
  },
  // IX04: an index whose columns are a leading prefix of another, in the same order.
  IX04(ctx) {
    const findings = [];
    for (const table of ctx.tables.filter(indexesRead)) {
      const indexes = table.indexes.map((columns, index) => ({ columns, name: table.indexNames?.[index] || '' }));
      const primary = table.columns.filter(c => c.primary).sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(c => c.name);
      const constraints = [primary, ...(table.uniqueKeys || []), ...table.columns.filter(c => c.unique).map(c => [c.name])].filter(key => key.length);
      const backs = index => constraints.some(key => key.length === index.columns.length && key.every((name, i) => name === index.columns[i]));
      indexes.forEach((a, i) => {
        if (backs(a)) return;
        const b = indexes.find((other, j) => j !== i && a.columns.length <= other.columns.length && a.columns.every((name, k) => name === other.columns[k])
          && (a.columns.length < other.columns.length || backs(other) || j < i));
        if (!b) return;
        const exact = a.columns.length === b.columns.length;
        const io = ctx.stats?.tables?.[table.id];
        const busy = io && (io.inserts || 0) + (io.updates || 0) > 1000000;
        const drop = a.name ? (ctx.engine === 'mysql' ? `ALTER TABLE ${sqlTable(ctx, table)} DROP INDEX ${quote(ctx, a.name)};` : `DROP INDEX CONCURRENTLY ${quote(ctx, table.schema)}.${quote(ctx, a.name)};`) : '';
        findings.push(makeFinding('IX04', table, { key: a.name || a.columns.join(','), severity: sizeOf(table).large && busy ? 'warning' : 'info', confidence: exact ? 'high' : 'medium',
          detail: `الفهرس ${a.name || ''} (${a.columns.join(', ')}) ${exact ? 'يطابق' : 'بادئة لـ'} ${b.name || 'فهرس آخر'} (${b.columns.join(', ')}).`,
          evidence: [schemaEvidence(`${table.name}: (${a.columns.join(', ')}) ⊂ (${b.columns.join(', ')})`)], ...(drop ? { fix: { sql: drop } } : {}) }));
      });
    }
    return findings;
  },
  // IX05: an index never used since the statistics were reset.
  IX05(ctx) {
    const age = statsAgeDays(ctx.stats);
    return (ctx.stats.indexes || []).filter(index => index.scans === 0 && !index.unique && !index.primary && !index.exclusion).flatMap(index => {
      const table = ctx.byId.get(index.tableId);
      if (!table || sizeOf(table).small) return [];
      // An index serving a foreign key is used when target rows are deleted, which may not have happened yet.
      if (ctx.relations.some(r => r.source === table.id && covered([index.columns], r.pairs.map(p => p.source)))) return [];
      const confidence = age == null ? 'medium' : age < 7 ? 'low' : age > 30 ? 'high' : 'medium';
      const severity = sizeOf(table).large && (index.sizeBytes || 0) > 100 * 1024 ** 2 && age > 90 ? 'warning' : 'info';
      return [makeFinding('IX05', table, { key: index.name, severity, confidence,
        detail: `${index.name} (${index.columns.join(', ')}) لم يُقرأ منذ ${age == null ? 'آخر تصفير للإحصاءات' : `${Math.round(age)} يومًا`}${index.sizeBytes ? ` ويشغل ${(index.sizeBytes / 1024 ** 2).toFixed(1)} MB` : ''}.`,
        evidence: [{ kind: 'stats', text: `${table.name}.${index.name}: scans = 0` }] })];
    });
  },
  // IX06: a large table read mostly by full scans.
  IX06(ctx) {
    const age = statsAgeDays(ctx.stats);
    return ctx.tables.flatMap(table => {
      const s = ctx.stats.tables?.[table.id];
      if (!s || s.seqScan == null || s.seqTupRead == null || !(s.liveRows >= LARGE) || !s.lastAnalyze) return [];
      const perScan = s.seqTupRead / (s.seqScan || 1);
      if (!(s.seqScan > (s.idxScan || 0) && s.seqScan >= 100 && perScan >= 10000)) return [];
      const severity = s.liveRows >= HUGE && perScan >= s.liveRows / 2 ? 'error' : 'warning';
      return [makeFinding('IX06', table, { severity, confidence: age != null && age < 7 ? 'low' : 'medium',
        detail: `${s.seqScan.toLocaleString('en-US')} مسحًا كاملًا مقابل ${(s.idxScan || 0).toLocaleString('en-US')} عبر الفهارس، بمتوسط ${Math.round(perScan).toLocaleString('en-US')} صف لكل مسح.`,
        evidence: [{ kind: 'stats', text: `${table.name}: seq_scan ${s.seqScan}, idx_scan ${s.idxScan || 0}, rows ${s.liveRows}` }] })];
    });
  }
};

// The table a *_id stem points at: the stem pluralized, preferring the same schema (shared with DR05).
export function targetForStem(ctx, stem) {
  const irregular = { person: 'people', child: 'children' };
  const names = [stem, `${stem}s`, `${stem}es`, ...(stem.endsWith('y') ? [`${stem.slice(0, -1)}ies`] : []), ...(irregular[stem] ? [irregular[stem]] : [])];
  for (const name of names) {
    const table = ctx.byName.get(name);
    if (table && table.columns.filter(c => c.primary).length === 1) return table;
  }
  return null;
}
