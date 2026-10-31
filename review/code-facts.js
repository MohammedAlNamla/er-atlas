// Review facts from one parsed PHP file: Eloquent models (mapping, mass-assignment and
// serialisation lists, casts, traits, relations), literal-column query usages with a symbolic
// receiver, raw SQL calls with the shape of their SQL argument, and project-wide signals
// (hashing, encryption, request()->all() mass assignment). code-context.js calls this with its
// own AST and helpers; mergeReviewFacts turns the per-file results into `code.facts`.
const SKIP = new Set(['loc', 'leadingComments', 'trailingComments', 'comments', 'errors']);
const textName = node => typeof node === 'string' ? node : node?.name || '';
const tail = name => String(name || '').split('\\').at(-1);
const MODEL_BASES = new Set(['Illuminate\\Database\\Eloquent\\Model', 'Illuminate\\Foundation\\Auth\\User', 'Illuminate\\Database\\Eloquent\\Relations\\Pivot', 'Illuminate\\Database\\Eloquent\\Relations\\MorphPivot']);
const PIVOT_BASES = new Set(['Illuminate\\Database\\Eloquent\\Relations\\Pivot', 'Illuminate\\Database\\Eloquent\\Relations\\MorphPivot']);
const RELATIONS = new Set(['belongsTo', 'hasMany', 'hasOne', 'belongsToMany', 'morphTo', 'morphMany', 'morphOne', 'morphToMany', 'morphedByMany', 'hasManyThrough', 'hasOneThrough']);
const LISTS = ['fillable', 'guarded', 'hidden', 'visible', 'appends', 'dates'];
const COLUMN_FIRST = new Set(['where', 'orWhere', 'whereIn', 'orWhereIn', 'whereNotIn', 'orWhereNotIn', 'whereBetween', 'orWhereBetween', 'whereNotBetween', 'whereNull', 'orWhereNull', 'whereNotNull', 'orWhereNotNull', 'firstWhere', 'orderBy', 'orderByDesc', 'latest', 'oldest']);
// where* builder methods that are not dynamic "whereColumn" finders.
const BUILDER_WHERE = new Set(['whereRaw', 'orWhereRaw', 'whereColumn', 'orWhereColumn', 'whereHas', 'orWhereHas', 'whereDoesntHave', 'orWhereDoesntHave', 'whereExists', 'orWhereExists', 'whereNotExists', 'whereNot', 'orWhereNot', 'whereKey', 'whereKeyNot', 'whereDate', 'orWhereDate', 'whereMonth', 'whereDay', 'whereYear', 'whereTime', 'whereJsonContains', 'whereJsonDoesntContain', 'whereJsonLength', 'whereJsonContainsKey', 'whereFullText', 'orWhereFullText', 'whereRelation', 'orWhereRelation', 'whereMorphRelation', 'whereBelongsTo', 'whereMorphedTo', 'whereNotMorphedTo', 'whereIntegerInRaw', 'whereIntegerNotInRaw', 'whereLike', 'orWhereLike', 'whereNotLike', 'whereAny', 'whereAll', 'whereNone', 'whereNested', 'whereSub', 'whereAttachedTo', 'whereNullSafe', 'whereValueBetween', 'withWhereHas', 'whereHasMorph', 'whereDoesntHaveMorph']);
const DB_RAW = new Set(['raw', 'select', 'selectOne', 'selectResultSets', 'scalar', 'insert', 'update', 'delete', 'statement', 'affectingStatement', 'unprepared', 'cursor']);
const BUILDER_RAW = new Set(['whereRaw', 'orWhereRaw', 'havingRaw', 'orHavingRaw', 'orderByRaw', 'selectRaw', 'groupByRaw', 'fromRaw', 'joinRaw', 'updateRaw']);
const COLUMN_SINKS = new Set(['orderBy', 'orderByDesc', 'groupBy', 'latest', 'oldest', 'where', 'orWhere', 'select']);
const MASS_ASSIGN = new Set(['create', 'fill', 'update', 'forceFill', 'forceCreate', 'firstOrCreate', 'updateOrCreate', 'firstOrNew', 'make', 'insert']);

function visit(node, ctx, enter) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) visit(child, ctx, enter); return; }
  const next = node.kind ? enter(node, ctx) || ctx : ctx;
  for (const [key, value] of Object.entries(node)) if (!SKIP.has(key)) visit(value, next, enter);
}
function each(node, fn) { visit(node, null, child => { fn(child); }); }
const literalString = node => node?.kind === 'string' || node?.kind === 'nowdoc' ? node.value : null;
const classRef = (node, resolve) => node?.kind === 'staticlookup' && textName(node.offset) === 'class' && node.what?.kind === 'name' ? resolve(node.what) : null;

function arrayItems(node, resolve) {
  if (node?.kind !== 'array') return null;
  return node.items.filter(item => item?.kind === 'entry').map(item => {
    const key = literalString(item.key), value = item.value;
    const text = literalString(value), ref = classRef(value, resolve);
    return { key, value: text ?? ref, valueKind: text != null ? 'string' : ref ? 'class' : value?.kind || 'other' };
  });
}

// The method name of a call, and its receiver expression.
function callParts(call) {
  const what = call.what;
  if (what?.kind === 'staticlookup') return { name: textName(what.offset), receiver: what.what, isStatic: true };
  if (['propertylookup', 'nullsafepropertylookup'].includes(what?.kind)) return { name: textName(what.offset), receiver: what.what, isStatic: false };
  return { name: what?.kind === 'name' ? textName(what) : '', receiver: null, isStatic: false };
}

export function collectReviewFacts(ast, code, file, { lookup, resolveName, importsFor, plural, snake }) {
  const lines = code.split(/\r?\n/);
  const lineText = line => (lines[line - 1] || '').trim().slice(0, 200);
  const at = node => ({ file, line: node.loc.start.line, text: lineText(node.loc.start.line) });
  const result = { classes: [], queries: [], rawSql: [], massAssign: [], unguard: [], migrationEnums: [], migrationTables: [], mentions: {}, hashing: false, encryption: false };
  const inApp = !file.startsWith('database/');

  const classInfo = (node, ctx) => {
    const resolve = name => resolveName(name, ctx.namespace, ctx.imports);
    const name = `${ctx.namespace ? `${ctx.namespace}\\` : ''}${textName(node.name)}`;
    const info = { name, kind: node.kind, file, line: node.loc.start.line, abstract: Boolean(node.isAbstract), extends: node.extends ? resolve(node.extends) : null,
      extendsRaw: node.extends ? textName(node.extends) : null, traits: [], table: null, connection: null, constants: {}, timestamps: null, casts: null, methods: [], relations: [], propertyTypes: {} };
    for (const list of LISTS) info[list] = null;
    for (const member of node.body || []) {
      if (member.kind === 'traituse') info.traits.push(...member.traits.map(resolve));
      if (member.kind === 'classconstant') for (const constant of member.constants || []) {
        const key = textName(constant.name);
        if (['CREATED_AT', 'UPDATED_AT', 'DELETED_AT'].includes(key)) info.constants[key] = literalString(constant.value) ?? (constant.value?.kind === 'nullkeyword' ? null : undefined);
      }
      if (member.kind === 'propertystatement') for (const property of member.properties || []) {
        const key = textName(property.name), line = property.loc.start.line;
        if (property.type?.kind === 'name') info.propertyTypes[key] = resolve(property.type);
        if (key === 'table' && literalString(property.value)) info.table = { name: literalString(property.value), line };
        if (key === 'connection' && literalString(property.value)) info.connection = literalString(property.value);
        if (key === 'timestamps' && property.value?.kind === 'boolean') info.timestamps = property.value.value;
        if (LISTS.includes(key)) { const items = arrayItems(property.value, resolve); if (items) info[key] = { names: items.map(item => item.value).filter(v => typeof v === 'string'), line, text: lineText(line) }; }
        if (key === 'casts') { const items = arrayItems(property.value, resolve); if (items) info.casts = { entries: items.filter(item => item.key).map(item => ({ name: item.key, value: item.value, kind: item.valueKind })), line, text: lineText(line) }; }
      }
      if (member.kind !== 'method') continue;
      const method = textName(member.name);
      info.methods.push(method);
      if (method === '__construct') for (const param of member.arguments || []) {
        if (param.flags && param.type?.kind === 'name') info.propertyTypes[textName(param.name)] = resolve(param.type);
      }
      if (method === 'casts') each(member.body, child => {
        if (child.kind !== 'return' || info.casts) return;
        const items = arrayItems(child.expr, resolve);
        if (items) info.casts = { entries: items.filter(item => item.key).map(item => ({ name: item.key, value: item.value, kind: item.valueKind })), line: child.loc.start.line, text: lineText(child.loc.start.line) };
      });
      const params = new Map((member.arguments || []).filter(p => p.type?.kind === 'name').map(p => [textName(p.name), resolve(p.type)]));
      each(member.body, child => {
        if (method === '__construct' && child.kind === 'assign' && child.left?.kind === 'propertylookup' && child.left.what?.kind === 'variable' && child.left.what.name === 'this') {
          const prop = textName(child.left.offset), right = child.right;
          if (right?.kind === 'variable' && params.has(right.name)) info.propertyTypes[prop] = params.get(right.name);
          if (right?.kind === 'new' && right.what?.kind === 'name') info.propertyTypes[prop] = resolve(right.what);
          if (right?.kind === 'call' && ['app', 'resolve'].includes(textName(right.what)) && classRef(right.arguments[0], resolve)) info.propertyTypes[prop] = classRef(right.arguments[0], resolve);
        }
        if (child.kind !== 'call') return;
        const { name: type, receiver } = callParts(child);
        if (!RELATIONS.has(type) || receiver?.kind !== 'variable' || receiver.name !== 'this') return;
        const args = [], named = {};
        for (const arg of child.arguments || []) {
          if (arg.kind === 'namedargument') named[arg.name] = literalString(arg.value) ?? classRef(arg.value, resolve);
          else args.push(literalString(arg) ?? classRef(arg, resolve));
        }
        info.relations.push({ method, type, target: classRef(child.arguments?.[0], resolve) || (named.related ?? null), args, named, ...at(child) });
      });
    }
    if (!info.table) {
      const base = textName(node.name);
      const pivot = PIVOT_BASES.has(info.extends);
      info.conventionTable = pivot ? snake(base) : plural(snake(base));
    }
    const tableName = info.table?.name || info.conventionTable;
    info.tableName = tableName;
    info.tableId = lookup(tableName);
    return info;
  };

  // Assignments to a local variable inside the enclosing function, for one-level data flow.
  const assignments = (fn, name) => {
    const found = [];
    if (fn) each(fn.body || fn, child => { if (child.kind === 'assign' && child.left?.kind === 'variable' && child.left.name === name) found.push(child); });
    return found;
  };
  const isRequest = (expr, ctx, seen = new Set()) => {
    let hit = false;
    each(expr, child => {
      if (hit) return;
      if (child.kind === 'variable' && ['request', '_GET', '_POST', '_REQUEST', '_COOKIE'].includes(child.name)) hit = true;
      if (child.kind === 'call') {
        const { name } = callParts(child);
        if (name === 'request' || name === 'input' || (name === 'query' && child.arguments.length)) hit = true;
      }
      if (child.kind === 'variable' && typeof child.name === 'string' && !seen.has(child.name) && child.name !== 'this') {
        seen.add(child.name);
        if (assignments(ctx.fn, child.name).some(assign => assign.right !== expr && isRequest(assign.right, ctx, seen))) hit = true;
      }
    });
    return hit;
  };
  // What an interpolated value is: request input, a class constant/getTable(), a numeric cast/intval, $this->prop, or other.
  const shapeOf = (expr, ctx, depth = 0) => {
    if (!expr) return { shape: 'none', parts: [] };
    if (literalString(expr) != null || expr.kind === 'number') return { shape: 'literal', parts: [] };
    const dynamic = [];
    const leaves = node => {
      if (!node) return;
      if (literalString(node) != null || node.kind === 'number') return;
      if (node.kind === 'encapsed') { for (const part of node.value) if (part.kind === 'encapsedpart' && part.expression?.kind !== 'string') dynamic.push(part.expression); return; }
      if (node.kind === 'bin' && node.type === '.') { leaves(node.left); leaves(node.right); return; }
      if (node.kind === 'encapsedpart') { leaves(node.expression); return; }
      dynamic.push(node);
    };
    if (expr.kind === 'encapsed' || (expr.kind === 'bin' && expr.type === '.')) {
      leaves(expr);
      if (!dynamic.length) return { shape: 'literal', parts: [] };
      return { shape: expr.kind === 'encapsed' ? 'interpolated' : 'concatenated', parts: dynamic };
    }
    if (expr.kind === 'call' && ['sprintf', 'implode', 'join', 'vsprintf'].includes(textName(expr.what))) {
      const values = expr.arguments.slice(1).filter(arg => literalString(arg) == null && arg.kind !== 'number');
      return values.length ? { shape: 'concatenated', parts: values } : { shape: 'literal', parts: [] };
    }
    if (expr.kind === 'variable' && typeof expr.name === 'string' && depth < 2) {
      const found = assignments(ctx.fn, expr.name).filter(assign => assign.loc.start.offset < expr.loc.start.offset);
      if (!found.length) return { shape: 'unknown', parts: [] };
      const shapes = found.map(assign => assign.operator === '.=' ? { ...shapeOf({ kind: 'bin', type: '.', left: { kind: 'string', value: '' }, right: assign.right }, ctx, depth + 1) } : shapeOf(assign.right, ctx, depth + 1));
      const unsafe = shapes.filter(s => ['interpolated', 'concatenated'].includes(s.shape));
      if (unsafe.length) return { shape: unsafe[0].shape, parts: unsafe.flatMap(s => s.parts), via: expr.name };
      return shapes.every(s => s.shape === 'literal') ? { shape: 'literal', parts: [] } : { shape: 'unknown', parts: [] };
    }
    return { shape: 'unknown', parts: [] };
  };
  const partKind = (node, ctx) => {
    if (isRequest(node, ctx)) return 'request';
    if (node?.kind === 'staticlookup' && ['selfreference', 'staticreference', 'name'].includes(node.what?.kind) && textName(node.offset) !== 'class') return 'constant';
    if (node?.kind === 'call' && ['getTable', 'getKeyName', 'getQualifiedKeyName'].includes(callParts(node).name)) return 'constant';
    if (node?.kind === 'cast' && ['int', 'integer', 'float', 'double', 'bool', 'boolean'].includes(node.type)) return 'cast';
    if (node?.kind === 'call' && ['intval', 'floatval', 'boolval', 'abs'].includes(textName(node.what))) return 'cast';
    if (node?.kind === 'propertylookup' && node.what?.kind === 'variable' && node.what.name === 'this') return 'property';
    return 'other';
  };

  // Walk a builder chain down to its root: returns { root, path: [method names before the call] }.
  const receiverOf = (call, ctx) => {
    const path = [];
    let node = callParts(call).isStatic ? { kind: 'call', what: { ...call.what, offset: { kind: 'identifier', name: '' } }, arguments: call.arguments } : callParts(call).receiver, root = null;
    while (node) {
      if (node.kind === 'call') {
        const parts = callParts(node);
        if (parts.isStatic) {
          const owner = parts.receiver;
          if (owner?.kind === 'name') {
            const cls = resolveName(owner, ctx.namespace, ctx.imports);
            if (isDbFacade(owner, cls, ctx) && parts.name === 'table' && literalString(node.arguments[0])) root = { kind: 'table', name: literalString(node.arguments[0]), via: 'table' };
            else root = { kind: 'class', name: cls, via: 'static' };
          } else if (['selfreference', 'staticreference'].includes(owner?.kind) && ctx.cls) root = { kind: 'class', name: ctx.cls.name, via: 'static' };
          if (root && root.kind === 'class' && parts.name) path.unshift(parts.name);
          break;
        }
        path.unshift(parts.name);
        node = parts.receiver;
        continue;
      }
      if (node.kind === 'variable') {
        if (node.name === 'this' && ctx.cls) root = { kind: 'class', name: ctx.cls.name, via: 'this' };
        else if (ctx.params?.has(node.name)) root = { kind: 'class', name: ctx.params.get(node.name), via: 'param' };
        else if (ctx.scopeParam && node.name === ctx.scopeParam && ctx.cls) root = { kind: 'class', name: ctx.cls.name, via: 'scope' };
        break;
      }
      if (node.kind === 'propertylookup' && node.what?.kind === 'variable' && node.what.name === 'this' && ctx.cls) {
        const type = ctx.cls.propertyTypes[textName(node.offset)];
        if (type) root = { kind: 'class', name: type, via: 'property' };
        break;
      }
      break;
    }
    return root ? { root, path, chain: chainKey(call) } : null;
  };
  const chainKey = call => {
    let node = call;
    for (;;) {
      const receiver = callParts(node).receiver;
      if (receiver?.kind !== 'call') break;
      node = receiver;
    }
    return `${file}:${node.loc.start.offset}`;
  };
  const isDbFacade = (owner, cls, ctx) => cls === 'Illuminate\\Support\\Facades\\DB' || (textName(owner) === 'DB' && !ctx.imports.has('DB'));

  const enter = (node, ctx) => {
    if (node.kind === 'namespace') return { ...ctx, namespace: textName(node.name), imports: importsFor(node.children) };
    if (['class', 'trait'].includes(node.kind) && node.name) {
      const cls = classInfo(node, ctx);
      result.classes.push(cls);
      return { ...ctx, cls };
    }
    if (['method', 'function', 'closure', 'arrowfunc'].includes(node.kind)) {
      const params = new Map(node.kind === 'arrowfunc' || node.kind === 'closure' ? ctx.params || [] : []);
      for (const param of node.arguments || []) {
        if (param.type?.kind === 'name') params.set(textName(param.name), resolveName(param.type, ctx.namespace, ctx.imports));
        else params.delete(textName(param.name));
      }
      const name = node.kind === 'method' ? textName(node.name) : ctx.method;
      const scopeParam = node.kind === 'method' && /^scope[A-Z]/.test(name) ? textName(node.arguments?.[0]?.name) : ctx.scopeParam;
      return { ...ctx, params, method: name, scopeParam: node.kind === 'method' ? scopeParam : ctx.scopeParam, fn: node.kind === 'arrowfunc' ? ctx.fn || node : node };
    }
    if (node.kind === 'string' && inApp) {
      for (const token of String(node.value).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        const id = lookup(token);
        if (id && !result.mentions[id]) result.mentions[id] = { file, line: node.loc.start.line, text: lineText(node.loc.start.line) };
      }
    }
    if (node.kind !== 'call') return;
    const { name, receiver, isStatic } = callParts(node);
    if (!receiver && ['bcrypt', 'password_hash'].includes(name)) result.hashing = true;
    if (!receiver && ['encrypt', 'encryptString'].includes(name)) result.encryption = true;
    const owner = isStatic && receiver?.kind === 'name' ? resolveName(receiver, ctx.namespace, ctx.imports) : '';
    if (isStatic && (owner === 'Illuminate\\Support\\Facades\\Hash' || textName(receiver) === 'Hash') && name === 'make') result.hashing = true;
    if (isStatic && (owner === 'Illuminate\\Support\\Facades\\Crypt' || textName(receiver) === 'Crypt') && /^encrypt/.test(name)) result.encryption = true;
    if (name === 'unguard' && isStatic) result.unguard.push(at(node));
    // Migration enum columns create a CHECK constraint in PostgreSQL.
    if (file.startsWith('database/migrations/') && name === 'enum' && literalString(node.arguments[0])) {
      let table = null;
      for (const scope of ctx.schemaTables || []) table = scope;
      if (table) result.migrationEnums.push({ table, column: literalString(node.arguments[0]), ...at(node) });
    }
    if (file.startsWith('database/migrations/') && isStatic && ['create', 'table'].includes(name) && literalString(node.arguments[0])) {
      if (name === 'create') result.migrationTables.push({ table: literalString(node.arguments[0]), ...at(node) });
      return { ...ctx, schemaTables: [literalString(node.arguments[0])] };
    }
    if (MASS_ASSIGN.has(name) && node.arguments.some(arg => arg.kind === 'call' && ['all', 'input', 'post'].includes(callParts(arg).name) && !arg.arguments.length && isRequest(arg, ctx))) result.massAssign.push({ method: name, receiver: receiverOf(node, ctx), ...at(node) });
    // Raw SQL entry points.
    const dbStatic = isStatic && receiver?.kind === 'name' && isDbFacade(receiver, owner, ctx);
    if ((dbStatic && DB_RAW.has(name)) || (!dbStatic && BUILDER_RAW.has(name))) {
      const sql = node.arguments[0]?.kind === 'namedargument' ? node.arguments[0].value : node.arguments[0];
      const shape = shapeOf(sql, ctx);
      const parts = shape.parts.map(part => partKind(part, ctx));
      result.rawSql.push({ kind: 'sql', method: dbStatic ? `DB::${name}` : name, shape: shape.shape, bindings: node.arguments.length > 1, parts: [...new Set(parts)],
        requestDerived: parts.includes('request'), via: shape.via || null, ...at(node) });
    }
    if (!dbStatic && COLUMN_SINKS.has(name) && node.arguments[0] && literalString(node.arguments[0]) == null && node.arguments[0].kind !== 'array' && node.arguments[0].kind !== 'closure' && node.arguments[0].kind !== 'arrowfunc') {
      const arg = node.arguments[0];
      const variable = arg.kind === 'variable' ? arg.name : null;
      const guarded = variable && ctx.fn && (() => { let hit = false; each(ctx.fn.body || ctx.fn, child => {
        if (child.kind === 'call' && ['in_array', 'array_key_exists', 'abort_unless', 'abort_if'].includes(textName(child.what)) && JSON.stringify(child.arguments, (k, v) => SKIP.has(k) ? undefined : v).includes(`"name":"${variable}"`)) hit = true;
        if (child.kind === 'match') hit = true;
        if (child.kind === 'string' && /(^|\|)in:/.test(child.value)) hit = true;
        if (child.kind === 'call' && callParts(child).name === 'in' && textName(callParts(child).receiver) === 'Rule') hit = true;
      }); return hit; })();
      if (!guarded && isRequest(arg, ctx)) result.rawSql.push({ kind: 'column', method: name, shape: 'request-column', bindings: false, parts: ['request'], requestDerived: true, via: variable, ...at(node) });
    }
    // Literal column usages for index checks.
    const dynamic = /^(?:or)?[wW]here([A-Z]\w*)$/.exec(name);
    const columns = [];
    if (COLUMN_FIRST.has(name)) {
      const first = node.arguments[0];
      if (literalString(first) != null) columns.push(literalString(first));
      else if (!first && ['latest', 'oldest'].includes(name)) columns.push('created_at');
      else if (first?.kind === 'array' && ['where', 'orWhere', 'firstWhere'].includes(name)) for (const item of first.items || []) if (literalString(item?.key) != null) columns.push(literalString(item.key));
    } else if (dynamic && !BUILDER_WHERE.has(name) && !BUILDER_RAW.has(name) && !/^(?:or)?[wW]here(?:Not)?(?:In|Null|Between|Raw)$/.test(name)) columns.push(snake(dynamic[1]));
    if (!columns.length) return;
    const op = literalString(node.arguments[1]), pattern = node.arguments[2];
    const startsWild = literalString(pattern)?.startsWith('%') || (pattern?.kind === 'encapsed' && literalString(pattern.value[0]?.expression)?.startsWith('%'));
    const like = /^(not )?i?like$/i.test(op || '') && Boolean(startsWild);
    const target = receiverOf(node, ctx);
    for (const column of columns) {
      if (!/^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)?$/.test(column)) continue;
      result.queries.push({ method: name, column, like, receiver: target, ...at(node) });
    }
  };
  const imports = importsFor(ast.children);
  visit(ast.children, { namespace: '', imports, cls: null, params: new Map() }, enter);
  return result;
}

// Merges per-file facts into code.facts: models with inherited traits/relations resolved, traits,
// queries, raw SQL and project signals.
export function mergeReviewFacts(files) {
  const classes = new Map();
  for (const fact of files) for (const cls of fact.classes) classes.set(cls.name, cls);
  const isModel = (cls, seen = new Set()) => {
    if (!cls || cls.kind !== 'class' || seen.has(cls.name)) return false;
    seen.add(cls.name);
    if (MODEL_BASES.has(cls.extends) || ['Model', 'Authenticatable', 'Pivot', 'MorphPivot'].includes(cls.extendsRaw)) return true;
    return isModel(classes.get(cls.extends), seen);
  };
  const lineage = cls => { const chain = []; for (let c = cls; c && !chain.includes(c); c = classes.get(c.extends)) chain.push(c); return chain; };
  const models = [...classes.values()].filter(cls => isModel(cls)).map(cls => {
    const chain = lineage(cls);
    const traitNames = [...new Set(chain.flatMap(c => c.traits))];
    const traitInfos = traitNames.map(name => classes.get(name)).filter(Boolean);
    const traitRelations = traitInfos.flatMap(t => t.relations);
    const inherited = key => chain.map(c => c[key]).find(v => v != null) ?? null;
    return { class: cls.name, file: cls.file, line: cls.line, abstract: cls.abstract, extends: cls.extends,
      table: cls.tableName, tableId: cls.tableId, explicitTable: cls.table, connection: inherited('connection'), timestamps: inherited('timestamps') ?? true,
      constants: Object.assign({}, ...chain.map(c => c.constants).reverse()),
      traits: traitNames, softDeletes: traitNames.some(name => tail(name) === 'SoftDeletes'),
      fillable: cls.fillable, guarded: cls.guarded, hidden: inherited('hidden'), visible: inherited('visible'), appends: cls.appends, dates: cls.dates, casts: cls.casts,
      methods: [...new Set([...chain.flatMap(c => c.methods), ...traitInfos.flatMap(t => t.methods)])],
      relations: [...cls.relations, ...traitRelations, ...chain.slice(1).flatMap(c => c.relations)] };
  });
  const mentions = {};
  for (const fact of files) for (const [id, where] of Object.entries(fact.mentions)) mentions[id] ||= where;
  return { models, queries: files.flatMap(f => f.queries), rawSql: files.flatMap(f => f.rawSql), massAssign: files.flatMap(f => f.massAssign),
    unguard: files.flatMap(f => f.unguard), migrationEnums: files.flatMap(f => f.migrationEnums), migrationTables: files.flatMap(f => f.migrationTables), mentions,
    resources: [...classes.values()].filter(cls => ['JsonResource', 'ResourceCollection'].includes(tail(cls.extends))).map(cls => ({ class: cls.name, file: cls.file, line: cls.line })),
    hashing: files.some(f => f.hashing), encryption: files.some(f => f.encryption) };
}
