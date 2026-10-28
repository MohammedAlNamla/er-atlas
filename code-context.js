import Parser from 'php-parser';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const parser = new Parser({ parser: { version: '8.3' }, ast: { withPositions: true } });
const cache = new Map();
const textName = node => typeof node === 'string' ? node : node?.name || '';
const tail = name => name.split('\\').at(-1);
const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const irregular = { person: 'people', child: 'children', man: 'men', woman: 'women', mouse: 'mice', goose: 'geese', foot: 'feet', tooth: 'teeth', ox: 'oxen', criterion: 'criteria', analysis: 'analyses', datum: 'data', leaf: 'leaves', life: 'lives' };
const uncountable = new Set(['equipment', 'information', 'rice', 'money', 'species', 'series', 'fish', 'sheep', 'news']);
// Laravel pluralizes only the last word of the snake_case model name.
const plural = name => {
  const cut = name.lastIndexOf('_') + 1, head = name.slice(0, cut), word = name.slice(cut);
  if (uncountable.has(word)) return name;
  if (irregular[word]) return head + irregular[word];
  return head + (/[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`);
};

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visitor); return; }
  if (node.kind && visitor(node) === false) return;
  for (const [key, value] of Object.entries(node)) if (!['loc', 'leadingComments', 'trailingComments', 'comments', 'errors'].includes(key)) walk(value, visitor);
}

function tableLookup(tables) {
  const names = new Map();
  for (const table of tables) {
    names.set(`${table.schema}.${table.name}`, table.id);
    if (names.has(table.name)) names.set(table.name, null); else names.set(table.name, table.id);
  }
  return name => names.get(name) || null;
}

function importsFor(nodes) {
  const imports = new Map();
  for (const node of nodes) if (node.kind === 'usegroup') for (const item of node.items || []) {
    const name = `${node.name ? `${node.name}\\` : ''}${item.name}`;
    imports.set(textName(item.alias) || tail(name), name);
  }
  return imports;
}

function resolveName(node, namespace, imports) {
  const name = textName(node).replace(/^\\/, '');
  if (!name) return '';
  if (node?.resolution === 'fqn' || textName(node).startsWith('\\')) return name;
  const parts = name.split('\\');
  return imports.has(parts[0]) ? [imports.get(parts[0]), ...parts.slice(1)].join('\\') : `${namespace ? `${namespace}\\` : ''}${name}`;
}

function callName(call) {
  const what = call.what;
  if (what?.kind === 'staticlookup') return `${textName(what.what)}::${textName(what.offset)}`;
  if (['propertylookup', 'nullsafepropertylookup'].includes(what?.kind)) return textName(what.offset);
  return textName(what);
}

function facadeCall(call, namespace, imports) {
  if (call.what?.kind !== 'staticlookup') return callName(call);
  const name = resolveName(call.what.what, namespace, imports);
  for (const facade of ['DB', 'Schema', 'Route']) if (name === `Illuminate\\Support\\Facades\\${facade}` || textName(call.what.what) === facade && !imports.has(facade)) return `${facade}::${textName(call.what.offset)}`;
  return callName(call);
}

function modelArgument(node, namespace, imports) {
  return node?.kind === 'staticlookup' && textName(node.offset) === 'class' ? resolveName(node.what, namespace, imports) : null;
}

export { plural as laravelPlural };
export function extractPhpFacts(code, file, tables) {
  const ast = parser.parseCode(code, file);
  const lookup = tableLookup(tables), symbols = [], migrations = [], routes = [];
  const inspect = (nodes, namespace = '') => {
    const imports = importsFor(nodes);
    for (const node of nodes) {
      if (node.kind === 'namespace') { inspect(node.children, textName(node.name)); continue; }
      if (['class', 'trait', 'interface'].includes(node.kind) && node.name) {
        const name = `${namespace ? `${namespace}\\` : ''}${textName(node.name)}`;
        const symbol = { name, file, line: node.loc.start.line, kind: node.kind, dependencies: new Set(), directTables: new Set(), methods: [], relations: [], storeScoped: false, tableId: null, tableMapping: null };
        if (file.startsWith('app/Models/')) {
          let explicit;
          walk(node.body, child => {
            if (child.kind === 'property' && textName(child.name) === 'table' && child.value?.kind === 'string') explicit = child.value.value;
          });
          const defaultName = plural(snake(textName(node.name)));
          symbol.tableId = lookup(explicit || defaultName);
          if (symbol.tableId) symbol.tableMapping = explicit ? `$table = '${explicit}'` : `Eloquent convention: ${textName(node.name)} → ${defaultName}`;
        }
        let method = '';
        walk(node, child => {
          if (child.kind === 'usegroup') return false;
          if (child.kind === 'name') symbol.dependencies.add(resolveName(child, namespace, imports));
          if (child.kind === 'method') { method = textName(child.name); symbol.methods.push({ name: method, line: child.loc.start.line }); }
          if (child.kind === 'traituse' && child.traits.some(trait => tail(resolveName(trait, namespace, imports)) === 'HasStoreScope')) symbol.storeScoped = true;
          if (child.kind !== 'call') return;
          const call = facadeCall(child, namespace, imports);
          if (/^(?:DB|Schema)::(?:table|create)$/.test(call) && child.arguments[0]?.kind === 'string') {
            const tableId = lookup(child.arguments[0].value);
            if (tableId) symbol.directTables.add(tableId);
          }
          if (['belongsTo', 'hasMany', 'hasOne', 'belongsToMany', 'morphTo', 'morphMany', 'morphOne', 'morphToMany', 'morphedByMany', 'hasManyThrough', 'hasOneThrough'].includes(call)) {
            const targets = child.arguments.map(arg => modelArgument(arg, namespace, imports)).filter(Boolean);
            const keys = child.arguments.filter(arg => arg.kind === 'string').map(arg => arg.value).filter(key => /^[\w.]+$/.test(key));
            // morphTo() takes its morph name from the method that returns it (eventable() → eventable_type/_id).
            if (call === 'morphTo' && !keys.length && method) keys.push(snake(method));
            symbol.relations.push({ method: call, targets, line: child.loc.start.line, keys });
          }
        });
        symbol.dependencies.delete(name);
        if (node.extends) symbol.dependencies.delete(resolveName(node.extends, namespace, imports));
        symbol.dependencies = [...symbol.dependencies].filter(dep => dep.startsWith('App\\'));
        symbol.directTables = [...symbol.directTables];
        symbols.push(symbol);
      }
    }
    if (file.startsWith('database/migrations/')) walk(nodes, node => {
      if (node.kind !== 'call' || !['Schema::create', 'Schema::table'].includes(facadeCall(node, namespace, imports)) || node.arguments[0]?.kind !== 'string') return;
      const tableId = lookup(node.arguments[0].value);
      if (!tableId) return;
      const columns = [], targets = new Set();
      walk(node.arguments[1], child => {
        if (child.kind !== 'call') return;
        const method = callName(child), column = child.arguments[0]?.kind === 'string' ? child.arguments[0].value : null;
        if (column && ['foreignId', 'foreignUuid', 'foreign', 'morphs', 'nullableMorphs', 'uuidMorphs'].includes(method)) columns.push({ method, name: column });
        if (method === 'constrained' && column && lookup(column)) targets.add(lookup(column));
      });
      migrations.push({ tableId, file, line: node.loc.start.line, syntax: `${callName(node)}('${node.arguments[0].value}')`, columns, targetTableIds: [...targets] });
    });
    if (file.startsWith('routes/')) walk(nodes, node => {
      if (node.kind !== 'call' || !/^Route::(?:get|post|put|patch|delete|apiResource|resource|any|match)$/.test(facadeCall(node, namespace, imports))) return;
      const controllers = [];
      walk(node.arguments, child => { const target = modelArgument(child, namespace, imports); if (target) controllers.push(target); });
      const endpoint = node.arguments[0]?.kind === 'string' ? node.arguments[0].value.slice(0, 120) : '';
      for (const controller of controllers) routes.push({ controller, file, line: node.loc.start.line, syntax: `${callName(node)}('${endpoint}', ${tail(controller)}::class)` });
    });
  };
  inspect(ast.children);
  // Relation::morphMap / enforceMorphMap: the aliases stored in *_type columns instead of class names.
  const morphMaps = [];
  const scanMorphMaps = (nodes, namespace = '') => {
    const imports = importsFor(nodes);
    for (const node of nodes) {
      if (node.kind === 'namespace') { scanMorphMaps(node.children, textName(node.name)); continue; }
      walk(node, child => {
        if (child.kind !== 'call' || !/::(?:morphMap|enforceMorphMap)$/.test(callName(child)) || child.arguments[0]?.kind !== 'array') return;
        for (const item of child.arguments[0].items || []) {
          const model = modelArgument(item?.value, namespace, imports);
          if (item?.key?.kind === 'string' && model) morphMaps.push({ alias: item.key.value, model, file, line: item.loc?.start.line || child.loc.start.line });
        }
      });
    }
  };
  scanMorphMaps(ast.children);
  return { symbols, migrations, routes, morphMaps };
}

function moduleFor(file) {
  const parts = file.split('/');
  if (parts[1] === 'Services' && parts.length > 3) return parts[2];
  if (parts[1] === 'Http' && parts[2] === 'Controllers') {
    const remaining = parts.slice(3, -1).filter(part => !['Api', 'V1', 'V2', 'Partner', 'Client', 'Mobile', 'Admin'].includes(part));
    return remaining[0] || null;
  }
  return null;
}

export function buildCodeContext(facts, tables, stats = {}) {
  const symbols = new Map(facts.flatMap(fact => fact.symbols).map(symbol => [symbol.name, symbol]));
  const lookup = tableLookup(tables), storeId = lookup('stores');
  const migrations = facts.flatMap(fact => fact.migrations), routes = facts.flatMap(fact => fact.routes);
  const modelSupport = new Map(), tableEvidence = new Map(tables.map(table => [table.id, []]));
  const evidence = (tableId, item) => { const items = tableEvidence.get(tableId); if (items && !items.some(existing => existing.file === item.file && existing.line === item.line)) items.push(item); };
  for (const migration of migrations) evidence(migration.tableId, { file: migration.file, line: migration.line, syntax: migration.syntax });
  // Polymorphic links have no foreign key, so the code is the only record of who owns a morph table.
  const morphs = new Map();
  const morph = (tableId, name, ownerId, item) => {
    if (!tableId || !name) return;
    const key = `${tableId}|${name}`;
    if (!morphs.has(key)) morphs.set(key, { tableId, name, ownerTableIds: new Set(), evidence: [] });
    const entry = morphs.get(key);
    if (ownerId && ownerId !== tableId) entry.ownerTableIds.add(ownerId);
    if (item && !entry.evidence.some(existing => existing.file === item.file && existing.line === item.line)) entry.evidence.push(item);
  };
  // morphToMany/morphedByMany keep the link in a pivot: an explicit table argument, else the plural of the morph name.
  const morphPivot = keys => lookup(keys[1] || '') || lookup(plural(keys[0] || ''));
  for (const migration of migrations) for (const column of migration.columns) if (/morphs$/i.test(column.method)) morph(migration.tableId, column.name, null, null);
  for (const model of symbols.values()) if (model.tableId) {
    evidence(model.tableId, { file: model.file, line: model.line, syntax: model.tableMapping });
    const related = [model, ...model.dependencies.map(dep => symbols.get(dep)).filter(symbol => symbol?.kind === 'trait')];
    const support = new Set();
    for (const symbol of related) {
      if (storeId && symbol.storeScoped) support.add(storeId);
      for (const relation of symbol.relations) {
        const targetIds = relation.targets.map(target => symbols.get(target)?.tableId).filter(Boolean);
        for (const id of targetIds) if (id === storeId) support.add(id);
        if (['belongsToMany', 'morphToMany'].includes(relation.method)) for (const key of relation.keys) if (lookup(key)) support.add(lookup(key));
        const item = { file: symbol.file, line: relation.line, syntax: `${tail(model.name)}::${relation.method}(${[...relation.targets.map(tail), ...relation.keys.map(key => `'${key}'`)].join(', ')})` };
        if (['morphMany', 'morphOne'].includes(relation.method)) for (const id of targetIds) { morph(id, relation.keys[0], model.tableId, item); support.add(id); }
        if (relation.method === 'morphToMany') { const pivot = morphPivot(relation.keys); if (pivot) { morph(pivot, relation.keys[0], model.tableId, item); support.add(pivot); } }
        if (relation.method === 'morphedByMany') { const pivot = morphPivot(relation.keys); if (pivot) { for (const id of targetIds) morph(pivot, relation.keys[0], id, item); support.add(pivot); } }
        if (relation.method === 'morphTo') morph(model.tableId, relation.keys[0], null, item);
        if (targetIds.length) evidence(model.tableId, { file: symbol.file, line: relation.line, syntax: `${tail(model.name)}::${relation.method}(${relation.targets.map(tail).join(', ')})`, relatedTableIds: targetIds });
      }
    }
    modelSupport.set(model.name, support);
  }
  const resolveTables = (name, visited = new Set()) => {
    if (visited.has(name)) return new Set();
    visited.add(name);
    const symbol = symbols.get(name);
    if (!symbol) return new Set();
    if (symbol.file.startsWith('app/Models/') && symbol.kind === 'class') return new Set([symbol.tableId, ...(modelSupport.get(name) || [])].filter(Boolean));
    const result = new Set(symbol.directTables);
    for (const dependency of symbol.dependencies) for (const id of resolveTables(dependency, visited)) result.add(id);
    return result;
  };
  const modules = new Map();
  for (const symbol of symbols.values()) {
    const moduleId = moduleFor(symbol.file);
    if (!moduleId) continue;
    const ids = resolveTables(symbol.name);
    if (!ids.size) continue;
    if (!modules.has(moduleId)) modules.set(moduleId, { id: moduleId, tableIds: new Set(), sources: [] });
    const module = modules.get(moduleId);
    for (const id of ids) module.tableIds.add(id);
    const source = { file: symbol.file, line: symbol.line, symbol: tail(symbol.name), methods: symbol.methods.filter(method => method.name !== '__construct').slice(0, 10), tableIds: [...ids] };
    const route = routes.find(route => route.controller === symbol.name);
    if (route) source.route = { file: route.file, line: route.line, syntax: route.syntax };
    module.sources.push(source);
  }
  const moduleList = [...modules.values()].sort((a, b) => a.id.localeCompare(b.id)).map(module => ({ ...module, tableIds: [...module.tableIds], sources: module.sources.sort((a, b) => (a.file.startsWith('app/Services/') ? 0 : 1) - (b.file.startsWith('app/Services/') ? 0 : 1)) }));
  const matched = new Set([...tableEvidence].filter(([, items]) => items.length).map(([id]) => id));
  // What a *_type column may hold: a morphMap alias or a model class name, each resolved to its table.
  const morphMap = Object.fromEntries(facts.flatMap(fact => fact.morphMaps || []).map(entry => [entry.alias, symbols.get(entry.model)?.tableId]).filter(([, id]) => id));
  const modelTables = Object.fromEntries([...symbols.values()].filter(symbol => symbol.tableId && symbol.kind === 'class').map(symbol => [symbol.name, symbol.tableId]));
  return { language: 'PHP / Laravel', analysis: 'AST: model mappings, Eloquent relations, constructor types, service/repository references, migrations and routes', ...stats,
    morphs: [...morphs.values()].map(entry => ({ ...entry, ownerTableIds: [...entry.ownerTableIds] })), morphMap, modelTables,
    matchedTableIds: [...matched], unmatchedTableIds: tables.map(table => table.id).filter(id => !matched.has(id)),
    sharedTableIds: tables.filter(table => moduleList.filter(module => module.tableIds.includes(table.id)).length > 1).map(table => table.id),
    modules: moduleList,
    tables: tables.filter(table => matched.has(table.id)).map(table => ({ tableId: table.id, evidence: tableEvidence.get(table.id) })) };
}

async function sourceFiles(root) {
  const files = [], skipped = [];
  const scan = async directory => {
    const canonicalDirectory = await realpath(directory).catch(() => null);
    if (!canonicalDirectory) return;
    if (!canonicalDirectory.startsWith(`${root}${sep}`)) { skipped.push(relative(root, directory)); return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) { skipped.push(relative(root, join(directory, entry.name))); continue; }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && entry.name.endsWith('.php')) {
        if (files.length >= 4000) throw new Error('المشروع كبير جدًا. اختر مجلد API أصغر لتحليل المواضيع.');
        const info = await stat(path);
        if (info.size > 1500000) { skipped.push(relative(root, path)); continue; }
        const canonical = await realpath(path);
        if (!canonical.startsWith(`${root}${sep}`)) { skipped.push(relative(root, path)); continue; }
        files.push({ path: canonical, file: relative(root, canonical).split(sep).join('/'), size: info.size, mtime: info.mtimeMs });
      }
    }
  };
  for (const directory of ['app', 'database/migrations', 'routes']) await scan(join(root, directory));
  return { files, skipped };
}

export async function analyzeSource(sourceRoot, tables) {
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot) || sourceRoot.length > 1000) throw new Error('حدد المسار الكامل لمشروع Laravel على الجهاز');
  const root = await realpath(resolve(sourceRoot)).catch(() => { throw new Error('مجلد الكود غير موجود على الجهاز'); });
  const { files, skipped } = await sourceFiles(root);
  if (!files.length) throw new Error('لم أجد ملفات PHP داخل app أو database/migrations أو routes. اختر مجلد مشروع Laravel.');
  if (files.reduce((sum, file) => sum + file.size, 0) > 40000000) throw new Error('ملفات الكود أكبر من حد التحليل. اختر مشروع API أصغر.');
  const signature = createHash('sha256').update(JSON.stringify({ root, files: files.map(file => [file.file, file.size, file.mtime]), tables: tables.map(table => [table.id, table.schema, table.name]) })).digest('hex');
  if (cache.has(signature)) return cache.get(signature);
  const facts = [], failures = [];
  for (const file of files) {
    try { facts.push(extractPhpFacts(await readFile(file.path, 'utf8'), file.file, tables)); }
    catch { failures.push(file.file); }
  }
  const result = buildCodeContext(facts, tables, { sourceRoot: root, project: basename(root), scannedFiles: files.length, parsedFiles: facts.length, skippedFiles: skipped, failedFiles: failures, signature });
  if (!result.matchedTableIds.length) throw new Error('الكود لا يطابق أي جدول في المخطط الحالي. اختر مشروع الكود الصحيح.');
  if (cache.size >= 4) cache.clear();
  cache.set(signature, result);
  return result;
}

export function compactCodeContext(context) {
  const selectSources = sources => {
    const covered = new Set(), selected = [], candidates = [...sources];
    while (candidates.length && selected.length < 4) {
      candidates.sort((a, b) => b.tableIds.filter(id => !covered.has(id)).length - a.tableIds.filter(id => !covered.has(id)).length);
      const source = candidates.shift(); selected.push(source); source.tableIds.forEach(id => covered.add(id));
    }
    return selected.map(source => ({ ...source, methods: source.methods.slice(0, 6) }));
  };
  return { language: context.language, analysis: context.analysis, project: context.project, parsedFiles: context.parsedFiles, matchedTableIds: context.matchedTableIds,
    unmatchedTableIds: context.unmatchedTableIds, sharedTableIds: context.sharedTableIds,
    morphs: (context.morphs || []).filter(entry => entry.ownerTableIds.length).map(({ tableId, name, ownerTableIds }) => ({ tableId, name, ownerTableIds })),
    modules: context.modules.map(module => ({ ...module, sources: selectSources(module.sources), omittedSources: Math.max(0, module.sources.length - 4) })),
    tables: context.tables.map(table => ({ tableId: table.tableId, evidence: [...table.evidence].sort((a, b) => Number(a.syntax.startsWith('Schema::')) - Number(b.syntax.startsWith('Schema::'))).slice(0, 4) })) };
}

// A polymorphic table (events, comments, media) belongs wherever one of its owners is.
export function attachMorphTables(topics, morphs = [], key = 'ids') {
  for (const entry of morphs) for (const topic of topics) {
    const ids = topic[key], has = id => ids instanceof Set ? ids.has(id) : ids.includes(id);
    if (has(entry.tableId) || !entry.ownerTableIds.some(has)) continue;
    if (ids instanceof Set) ids.add(entry.tableId); else ids.push(entry.tableId);
  }
  return topics;
}

export function groundTopicSuggestions(answer, context, tables) {
  const parsed = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  const rows = Array.isArray(parsed) ? parsed : parsed?.topics;
  if (!Array.isArray(rows) || !rows.length) throw new Error('لم يرجع المساعد مواضيع صالحة من الكود');
  const sources = new Map(context.modules.flatMap(module => module.sources.map(source => [source.file, { ...source, moduleId: module.id }])));
  const validIds = new Set(tables.map(table => table.id));
  const result = rows.slice(0, 20).filter(row => row && typeof row.name === 'string' && Array.isArray(row.tableIds)).map(row => {
    const files = [...new Set(Array.isArray(row.sourceFiles) ? row.sourceFiles : [])].filter(file => sources.has(file)).slice(0, 8);
    if (!files.length) throw new Error(`الموضوع «${row.name.slice(0, 50)}» بلا مصدر كود متحقق. أعد الاقتراح.`);
    const evidence = files.map(file => sources.get(file));
    const supported = new Set(evidence.flatMap(source => source.tableIds));
    return { name: row.name.trim().slice(0, 50) || 'موضوع من الكود', tableIds: [...supported].filter(id => validIds.has(id)),
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 400) : 'مبني على استخدام الجداول في الخدمات والمسارات الموضحة أدناه.',
      moduleIds: [...new Set(evidence.map(source => source.moduleId))],
      evidence: evidence.map(({ file, line, symbol }) => ({ file, line, symbol })) };
  }).filter(row => row.tableIds.length);
  if (!result.length) throw new Error('لم يرجع المساعد مواضيع تحتوي جداول موثقة في الكود');
  attachMorphTables(result, context.morphs, 'tableIds');
  const covered = new Set(result.flatMap(row => row.tableIds));
  const remaining = tables.map(table => table.id).filter(id => !covered.has(id));
  if (remaining.length) result.push({ name: 'جداول تحتاج مراجعة', tableIds: remaining, reason: 'لم يتوفر استخدام كافٍ لهذه الجداول ضمن مصادر المواضيع المختارة؛ بقيت متاحة للمراجعة اليدوية.', moduleIds: [], evidence: [] });
  return JSON.stringify(result);
}
