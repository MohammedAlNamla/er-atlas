// Checks that read the analysed Laravel code (code.facts from review/code-facts.js): security,
// code/database drift, and the index checks that need query evidence. DR05 and SEC05 need only the
// schema but belong to these skills; with code present they use it to cut false positives.
import { isFrameworkTable, covered, indexesRead, makeFinding } from './util.js';
import { targetForStem } from './schema.js';

const tail = name => String(name || '').split('\\').at(-1);
const snake = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const studly = name => String(name).split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
const camel = name => { const s = studly(name); return s.charAt(0).toLowerCase() + s.slice(1); };
const singular = name => name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('ses') ? name.slice(0, -2) : name.endsWith('s') ? name.slice(0, -1) : name;
const outsideApp = file => /^database\/(migrations|seeders|factories)\//.test(file || '');
const codeEvidence = item => ({ kind: 'code', file: item.file, line: item.line, text: item.text });
const schemaEvidence = text => ({ kind: 'schema', text });
const castOf = (model, column) => model?.casts?.entries.find(entry => entry.name === column) || null;
const encrypted = cast => cast && /^(hashed|encrypted(:.*)?|.*AsEncrypted(ArrayObject|Collection)|.*Encrypted.*)$/.test(String(cast.value));
// A mutator or Attribute accessor for the column: setFooAttribute() or foo(): Attribute.
const hasMutator = (model, column) => model?.methods.some(name => name === `set${studly(column)}Attribute` || name === camel(column));
const hasAccessor = (model, column) => model?.methods.some(name => name === `get${studly(column)}Attribute` || name === camel(column));
const modelFor = (ctx, table) => ctx.facts.models.find(model => model.tableId === table.id && !model.abstract) || null;
const modelByClass = (ctx, name) => ctx.facts.models.find(model => model.class === name) || null;
// The table a query runs on: a model's table (static call, scope or typed property) or DB::table('name').
function queryTable(ctx, query) {
  const root = query.receiver?.root;
  if (!root) return null;
  if (root.kind === 'class') return ctx.byId.get(modelByClass(ctx, root.name)?.tableId) || null;
  if (root.kind === 'table') return ctx.byName.get(root.name) || null;
  return null;
}
const requestAll = text => /(\$request|request\(\))->(all|input|except)\(\s*(\[|\))/.test(text);

export const codeChecks = {
  // IX02: a column the code filters or sorts by with no index starting with it.
  IX02(ctx) {
    const groups = new Map();
    for (const query of ctx.facts.queries) {
      if (!query.column || !/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(query.column) || outsideApp(query.file)) continue;
      if (/^(whereDate|whereMonth|whereYear|whereDay|whereTime)$/.test(query.method) || query.like) continue; // leading-% LIKE and date casts defeat a btree
      const table = queryTable(ctx, query);
      const name = query.column.includes('.') ? query.column.split('.')[1] : query.column;
      const column = ctx.column(table, name);
      if (!table || !column || column.foreign || ctx.size(table).small || !indexesRead(table)) continue;
      if (covered(ctx.keysOf(table), [name])) continue;
      const key = `${table.id}\u0000${name}`;
      if (!groups.has(key)) groups.set(key, { table, column, queries: [] });
      groups.get(key).queries.push(query);
    }
    return [...groups.values()].map(({ table, column, queries }) => {
      const size = ctx.size(table), direct = queries.some(q => q.receiver?.root?.via === 'static' || q.receiver?.root?.kind === 'table');
      const lowSelectivity = /^(is_|has_)|^(status|state|active|enabled)$/.test(column.name);
      return makeFinding('IX02', table, { column: column.name, severity: lowSelectivity ? 'info' : 'warning',
        confidence: !size.known ? 'low' : size.large && direct ? 'high' : 'medium',
        detail: `${queries.length} موضعًا في الكود يبحث أو يرتّب بـ ${table.name}.${column.name}، ولا فهرس يبدأ به.${lowSelectivity ? ' العمود قليل القيم: الأنفع فهرس مركب يبدأ بعمود أكثر انتقائية.' : ''}`,
        evidence: queries.slice(0, 4).map(codeEvidence),
        fix: { operation: { type: 'addIndex', tableId: table.id, index: { name: `${table.name}_${column.name}_index`.slice(0, 63), columns: [column.name], unique: false, concurrently: size.large } } } });
    });
  },
  // IX03: SoftDeletes with no index serving deleted_at.
  IX03(ctx) {
    return ctx.facts.models.filter(model => model.softDeletes && !model.abstract).flatMap(model => {
      const table = ctx.byId.get(model.tableId);
      const name = model.constants?.DELETED_AT || 'deleted_at';
      if (!table || !ctx.column(table, name) || ctx.size(table).small || !indexesRead(table)) return [];
      if ((table.indexes || []).some(index => index.includes(name)) || (table.partialIndexes || []).some(index => new RegExp(`\\b${name}\\b`).test(index.predicate || ''))) return [];
      const nulls = ctx.stats?.nullFraction?.[table.id]?.[name];
      if (nulls >= 0.9) return []; // few deleted rows: "deleted_at IS NULL" is not selective, an index would not be used
      return [makeFinding('IX03', table, { column: name, severity: ctx.size(table).large && nulls != null && nulls < 0.8 ? 'warning' : 'info',
        confidence: nulls == null ? 'low' : 'medium',
        detail: `كل استعلام على ${tail(model.class)} يضيف ${name} IS NULL، ولا فهرس يذكر ${name}.${nulls != null ? ` ${Math.round((1 - nulls) * 100)}% من الصفوف محذوفة.` : ''}`,
        evidence: [{ kind: 'code', file: model.file, line: model.line, text: `class ${tail(model.class)} … use SoftDeletes` }] })];
    });
  },
  // SEC01: raw SQL built from variables instead of bindings.
  SEC01(ctx) {
    return ctx.facts.rawSql.filter(item => !outsideApp(item.file) && (item.kind === 'column' ? item.requestDerived : item.shape !== 'literal')).flatMap(item => {
      if (item.kind === 'sql' && item.parts.length && item.parts.every(part => part === 'constant')) return []; // class constants only
      const unprepared = /unprepared$/.test(item.method);
      const table = ctx.tables.find(t => new RegExp(`\\b${t.name}\\b`).test(item.text)) || null;
      const severity = item.kind === 'column' ? 'warning' : item.requestDerived || unprepared ? 'error' : 'warning';
      return [makeFinding('SEC01', table, { key: `${item.file}:${item.line}`, severity,
        confidence: item.requestDerived || unprepared ? 'high' : 'medium',
        detail: item.kind === 'column' ? `${item.method} يأخذ اسم العمود من الطلب مباشرة.` : `${item.method} يبني SQL من ${item.requestDerived ? 'مدخل الطلب' : 'متغير'} بدل تمرير القيم كـ bindings.`,
        evidence: [codeEvidence(item)] })];
    });
  },
  // SEC02: mass assignment left open, or privilege columns in $fillable.
  SEC02(ctx) {
    const privilege = /^(is_admin|admin|is_super_?admin|role|role_id|roles|permissions|is_staff|is_verified|verified_at|email_verified_at|approved|is_approved|approved_at|balance|wallet_balance|credits?|points|tenant_id|team_id|owner_id|store_id|account_id|plan|plan_id|subscription_status)$/;
    const findings = [];
    const unguard = ctx.facts.unguard.filter(item => !outsideApp(item.file));
    for (const model of ctx.facts.models.filter(m => !m.abstract)) {
      const table = ctx.byId.get(model.tableId) || null;
      const writes = ctx.facts.massAssign.filter(item => item.receiver?.root?.name === model.class && requestAll(item.text));
      const open = model.guarded && model.guarded.names.length === 0 && !model.fillable;
      const exposed = (model.fillable?.names || []).filter(name => privilege.test(name));
      if (open || unguard.length) findings.push(makeFinding('SEC02', table, { key: model.class, severity: writes.length ? 'error' : 'warning',
        confidence: writes.length ? 'high' : 'medium',
        detail: `${tail(model.class)}: ${open ? '$guarded = [] بلا $fillable' : 'Model::unguard() يلغي الحماية'}؛ ${writes.length ? 'والطلب يُمرر كاملًا إلى create/update.' : 'أي عمود يصل من الطلب يُكتب.'}`,
        evidence: [...(open ? [codeEvidence({ file: model.file, line: model.guarded.line, text: model.guarded.text })] : []), ...unguard.slice(0, 1).map(codeEvidence), ...writes.slice(0, 2).map(codeEvidence)] }));
      if (exposed.length) findings.push(makeFinding('SEC02', table, { key: `${model.class}:fillable`, severity: writes.length ? 'error' : 'warning', confidence: 'medium',
        detail: `${tail(model.class)} يسمح بالإسناد الجماعي لأعمدة صلاحيات: ${exposed.join('، ')}.`,
        evidence: [codeEvidence({ file: model.file, line: model.fillable.line, text: model.fillable.text }), ...writes.slice(0, 2).map(codeEvidence)] }));
    }
    return findings;
  },
  // SEC03: a secret stored with no visible hashing or encryption.
  SEC03(ctx) {
    const secret = /(^|_)(password|passwd|secret|token|api_key|apikey|access_key|secret_key|private_key|client_secret|access_token|refresh_token|otp|pin_code|recovery_codes?)($|_)/;
    const metadata = /_(at|type|id|count|expires_at|hint|length|hash|digest|encrypted)$/;
    const managed = { users: ['remember_token'], personal_access_tokens: ['token'], password_reset_tokens: ['token'], password_resets: ['token'], sessions: ['payload'] };
    return ctx.tables.filter(table => !/^oauth_/.test(table.name)).flatMap(table => table.columns.filter(c => ['text', 'varchar', 'char'].includes(ctx.type(c))
      && secret.test(c.name) && !metadata.test(c.name) && !(managed[table.name] || []).includes(c.name) && !/^two_factor_/.test(c.name)).flatMap(column => {
      const model = modelFor(ctx, table);
      if (encrypted(castOf(model, column.name)) || hasMutator(model, column.name)) return [];
      const projectWide = ctx.facts.hashing || ctx.facts.encryption;
      const critical = /(^|_)(password|passwd|secret|api_key|private_key|client_secret)($|_)/.test(column.name);
      const shortLived = /(^|_)(otp|pin_code|verification_code)($|_)/.test(column.name) && table.columns.some(c => /expires_at$/.test(c.name));
      return [makeFinding('SEC03', table, { column: column.name, severity: shortLived ? 'info' : critical && !projectWide ? 'error' : 'warning',
        confidence: !model ? 'low' : projectWide ? 'medium' : 'high',
        detail: `${table.name}.${column.name} يبدو سرًا، ولا cast ‏hashed/encrypted ولا mutator له${projectWide ? '؛ في المشروع تجزئة أو تشفير لا يمكن ربطه بهذا العمود ثابتًا' : ''}.`,
        evidence: [schemaEvidence(`${table.name}.${column.name} ${column.type}`), ...(model ? [{ kind: 'code', file: model.file, line: model.casts?.line || model.line, text: model.casts?.text || `class ${tail(model.class)}` }] : [])] })];
    }));
  },
  // SEC04: a sensitive column a model would serialise to JSON.
  SEC04(ctx) {
    const sensitive = name => /^(password|remember_token|two_factor_secret|two_factor_recovery_codes|api_token|api_key|secret|client_secret|access_token|refresh_token|otp|pin_code)$/.test(name)
      || (/_(secret|token|password|api_key)$/.test(name) && !/_(at|type|id)$/.test(name));
    return ctx.facts.models.filter(m => !m.abstract && m.tableId).flatMap(model => {
      const table = ctx.byId.get(model.tableId);
      if (!table) return [];
      const hidden = new Set(model.hidden?.names || []), visible = model.visible ? new Set(model.visible.names) : null;
      const resource = ctx.facts.resources.some(r => tail(r.class).startsWith(tail(model.class)));
      return table.columns.filter(c => sensitive(c.name) && !hidden.has(c.name) && (!visible || visible.has(c.name))).map(column => makeFinding('SEC04', table, {
        column: column.name, severity: resource ? 'info' : 'warning', confidence: resource ? 'low' : 'medium',
        detail: `${tail(model.class)} يُظهر ${column.name} عند تحويله إلى JSON؛ أضفه إلى $hidden.`,
        evidence: [{ kind: 'code', file: model.file, line: model.hidden?.line || model.line, text: model.hidden?.text || `class ${tail(model.class)}` }] }));
    });
  },
  // SEC05: sensitive personal data in a plain column.
  SEC05(ctx) {
    const pii = /(^|_)(national_id|nid|ssn|social_security|iqama|passport(_no|_number)?|id_number|identity_number|tax_id|iban|bank_account|account_number|card_number|pan|cvv|cvc|date_of_birth|dob|birth_date|medical|diagnosis|blood_type)($|_)/;
    const masked = /(last4|last_four|_masked|card_brand|iban_country|_hash|_digest|_encrypted|_token)/;
    return ctx.tables.flatMap(table => table.columns.filter(c => pii.test(c.name) && !masked.test(c.name) && ['text', 'varchar', 'char', 'bigint', 'integer'].includes(ctx.type(c))).flatMap(column => {
      const model = ctx.facts ? modelFor(ctx, table) : null;
      if (model && encrypted(castOf(model, column.name))) return [];
      const severity = /(^|_)(cvv|cvc|card_number|pan)($|_)/.test(column.name) ? 'error' : /(national_id|iqama|passport|iban|bank_account|account_number)/.test(column.name) ? 'warning' : 'info';
      return [makeFinding('SEC05', table, { column: column.name, severity, confidence: model ? 'high' : ctx.facts ? 'medium' : 'low',
        detail: `${table.name}.${column.name} بيانات شخصية حساسة مخزنة كقيمة عادية${/cvv|cvc/.test(column.name) ? '؛ تخزين CVV ممنوع بعد التفويض (PCI DSS)' : ''}.`,
        evidence: [schemaEvidence(`${table.name}.${column.name} ${column.type}`)] })];
    }));
  },
  // DR01: an Eloquent relation with no foreign key behind it.
  DR01(ctx) {
    const findings = [];
    const logLike = /(_logs?|^audit|_history|_events|_archives?)$/;
    for (const model of ctx.facts.models.filter(m => !m.abstract && m.tableId)) {
      const own = ctx.byId.get(model.tableId);
      for (const relation of model.relations) {
        if (!['belongsTo', 'hasOne', 'hasMany'].includes(relation.type) || !relation.target) continue;
        const related = modelByClass(ctx, relation.target), other = ctx.byId.get(related?.tableId);
        if (!own || !other || (related.connection || null) !== (model.connection || null)) continue;
        const strings = relation.args.filter(arg => typeof arg === 'string' && !arg.includes('\\'));
        const belongs = relation.type === 'belongsTo';
        const source = belongs ? own : other, target = belongs ? other : own;
        const column = strings[0] || (belongs ? `${snake(relation.method)}_id` : `${snake(tail(model.class))}_id`);
        if (!ctx.column(source, column) || isFrameworkTable(source)) continue;
        if (ctx.relations.some(r => r.source === source.id && r.target === target.id && r.pairs.some(p => p.source === column))) continue;
        const parentModel = belongs ? related : model;
        let severity = ctx.size(source).large && !parentModel?.softDeletes ? 'error' : 'warning';
        if (logLike.test(source.name) || logLike.test(target.name)) severity = 'info';
        findings.push(makeFinding('DR01', source, { column, key: target.id, severity,
          confidence: strings[0] ? 'high' : model.explicitTable || related.explicitTable ? 'high' : 'medium',
          detail: `${tail(model.class)}::${relation.method}() يربط ${source.name}.${column} بـ ${target.name}، ولا مفتاح أجنبي في القاعدة يضمن الربط.`,
          evidence: [codeEvidence(relation)],
          fix: { operation: { type: 'addRelation', relation: { id: `review:${source.id}:${column}`, name: `${source.name}_${column}_foreign`.slice(0, 63), source: source.id, target: target.id,
            pairs: [{ source: column, target: target.columns.find(c => c.primary)?.name || 'id' }], onDelete: 'a' } } } }));
      }
    }
    return findings;
  },
  // DR02: a model whose table does not exist.
  DR02(ctx) {
    return ctx.facts.models.filter(model => !model.abstract && !model.tableId).map(model => {
      const used = ctx.facts.models.some(m => m.relations.some(r => r.target === model.class)) || ctx.facts.queries.some(q => q.receiver?.root?.name === model.class)
        || ctx.facts.massAssign.some(q => q.receiver?.root?.name === model.class);
      const pending = ctx.facts.migrationTables.some(item => item.table === model.table);
      return makeFinding('DR02', null, { key: model.class, severity: used && !pending ? 'error' : 'info',
        confidence: model.connection ? 'low' : model.explicitTable ? 'high' : 'medium',
        title: `${tail(model.class)} يشير إلى جدول غير موجود: ${model.table}`,
        detail: pending ? `migration تنشئ ${model.table} لكنها لم تُنفذ على هذه القاعدة.` : `لا يوجد جدول ${model.table} في المخطط المقروء${model.explicitTable ? ' ($table صريح)' : ' (بالعرف من اسم الصنف)'}.`,
        evidence: [{ kind: 'code', file: model.file, line: model.explicitTable?.line || model.line, text: model.explicitTable ? `protected $table = '${model.explicitTable.name}';` : `class ${tail(model.class)}` }] });
    });
  },
  // DR03: a table no analysed code uses (only a nudge to check).
  DR03(ctx) {
    if ((ctx.code.failedFiles || []).length || (ctx.code.skippedFiles || []).length) return []; // a partial analysis cannot say "unused"
    const evidence = new Map((ctx.code.tables || []).map(entry => [entry.tableId, entry.evidence]));
    const used = id => (evidence.get(id) || []).some(item => !String(item.file).startsWith('database/migrations/'));
    const usedIds = new Set(ctx.tables.filter(t => used(t.id)).map(t => t.id));
    const pivots = new Set(ctx.facts.models.flatMap(m => m.relations.filter(r => /ToMany|edByMany/.test(r.type)).flatMap(r => {
      const explicit = r.args.find(arg => typeof arg === 'string' && !arg.includes('\\'));
      const other = modelByClass(ctx, r.target);
      return explicit ? [explicit] : other ? [[singular(m.table), singular(other.table)].sort().join('_')] : [];
    })));
    return ctx.tables.filter(table => !usedIds.has(table.id) && !isFrameworkTable(table) && !pivots.has(table.name)
      && !ctx.relations.some(r => r.target === table.id && usedIds.has(r.source))
      && !ctx.facts.mentions?.[table.id]).map(table => {
      const s = ctx.stats?.tables?.[table.id];
      const idle = s && !(s.seqScan || 0) && !(s.idxScan || 0) && !(s.inserts || 0) && !(s.updates || 0) && !(s.deletes || 0);
      return makeFinding('DR03', table, { confidence: idle ? 'medium' : 'low',
        detail: `لا موديل ولا DB::table ولا علاقة في الكود المحلَّل تستخدم ${table.name}${idle ? '، والإحصاءات لا تُظهر أي نشاط' : ''}. تحقق قبل حذفه.`,
        evidence: [schemaEvidence(`${table.name}: لا استخدام خارج database/migrations`)] });
    });
  },
  // DR04: a model naming a column its table does not have.
  DR04(ctx) {
    const findings = [];
    for (const model of ctx.facts.models.filter(m => !m.abstract && m.tableId)) {
      const table = ctx.byId.get(model.tableId);
      if (!table) continue;
      const relationNames = new Set(model.relations.map(r => r.method));
      const appends = new Set(model.appends?.names || []);
      const mentions = [
        ...(model.fillable?.names || []).map(name => ({ name, from: 'fillable', item: model.fillable })),
        ...(model.guarded?.names || []).filter(name => name !== '*').map(name => ({ name, from: 'guarded', item: model.guarded })),
        ...(model.casts?.entries || []).map(entry => ({ name: entry.name, from: 'casts', item: model.casts })),
        ...(model.dates?.names || []).map(name => ({ name, from: 'dates', item: model.dates })),
        ...(model.hidden?.names || []).map(name => ({ name, from: 'hidden', item: model.hidden })),
        ...(model.visible?.names || []).map(name => ({ name, from: 'visible', item: model.visible })),
        ...(model.softDeletes ? [{ name: model.constants?.DELETED_AT || 'deleted_at', from: 'softDeletes', item: { file: model.file, line: model.line, text: 'use SoftDeletes' } }] : []),
        ...(model.timestamps !== false ? [model.constants?.CREATED_AT || 'created_at', model.constants?.UPDATED_AT || 'updated_at'].map(name => ({ name, from: 'timestamps', item: { file: model.file, line: model.line, text: `class ${tail(model.class)} (timestamps)` } })) : [])
      ];
      const writes = ctx.facts.massAssign.some(item => item.receiver?.root?.name === model.class);
      for (const mention of mentions) {
        const name = mention.name.split('->')[0];
        if (ctx.column(table, name) || appends.has(name) || hasAccessor(model, name)) continue;
        if (['hidden', 'visible'].includes(mention.from) && relationNames.has(name)) continue; // hiding a loaded relation
        const cast = mention.from === 'casts' ? castOf(model, name) : null;
        const custom = cast?.kind === 'class';
        const severity = ['hidden', 'visible'].includes(mention.from) ? 'info' : ['fillable', 'casts'].includes(mention.from) && writes ? 'error' : 'warning';
        findings.push(makeFinding('DR04', table, { column: name, key: mention.from, severity,
          confidence: custom ? 'low' : model.explicitTable ? 'high' : 'medium',
          detail: `${tail(model.class)} يذكر ${name} في ${mention.from === 'timestamps' ? 'الطوابع الزمنية التلقائية ($timestamps)' : mention.from === 'softDeletes' ? 'SoftDeletes' : `$${mention.from}`}، والعمود غير موجود في ${table.name}.`,
          evidence: [codeEvidence(mention.item)] }));
      }
    }
    return findings;
  },
  // DR05: a *_id column with no foreign key (schema alone; code removes what DR01 covers).
  DR05(ctx) {
    const external = /^(stripe|external|provider|google|facebook|apple|transaction|session|request|trace|correlation|device|github|twitter|paypal|payment_intent)_id$/;
    const logLike = /(_logs?|^audit|_history|_events)$/;
    const findings = [];
    for (const table of ctx.tables.filter(t => !isFrameworkTable(t))) {
      const morph = new Set(table.columns.map(c => /^(.+)_type$/.exec(c.name)?.[1]).filter(Boolean));
      const linked = new Set(ctx.relations.filter(r => r.source === table.id).flatMap(r => r.pairs.map(p => p.source)));
      for (const column of table.columns) {
        const stem = /^(.+)_id$/.exec(column.name)?.[1];
        if (!stem || column.primary || column.foreign || linked.has(column.name) || external.test(column.name) || morph.has(stem) || stem.endsWith('able')) continue;
        const target = targetForStem(ctx, stem);
        if (!target || target.id === table.id && column.primary) continue;
        const key = target.columns.find(c => c.primary);
        if (['varchar', 'text'].includes(ctx.type(column)) && !['varchar', 'text', 'uuid'].includes(ctx.type(key))) continue; // an external string id
        const model = ctx.facts?.models.find(m => m.tableId === table.id);
        if (model?.relations.some(r => r.type === 'belongsTo' && (r.args.includes(column.name) || `${snake(r.method)}_id` === column.name))) continue; // DR01's finding
        const sameType = ctx.type(column) === ctx.type(key);
        findings.push(makeFinding('DR05', table, { column: column.name, severity: logLike.test(table.name) || ctx.size(table).small ? 'info' : 'warning',
          confidence: sameType ? 'high' : 'medium',
          detail: `${table.name}.${column.name} يشبه مرجعًا إلى ${target.name}.${key.name}، ولا مفتاح أجنبي يضمنه.${sameType ? '' : ` النوعان مختلفان (${column.type} / ${key.type}).`}`,
          evidence: [schemaEvidence(`${table.name}.${column.name} ${column.type} → ${target.name}.${key.name} ${key.type}؟`)],
          fix: { operation: { type: 'addRelation', relation: { id: `review:${table.id}:${column.name}`, name: `${table.name}_${column.name}_foreign`.slice(0, 63), source: table.id, target: target.id,
            pairs: [{ source: column.name, target: key.name }], onDelete: column.nullable ? 'n' : 'a' } } } }));
      }
    }
    return findings;
  }
};
