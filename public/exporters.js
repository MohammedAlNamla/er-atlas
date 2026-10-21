export const EXPORT_FORMATS = [
  { id: 'mermaid', label: 'Mermaid', fileExtension: 'mmd', mime: 'text/plain' },
  { id: 'dbml', label: 'DBML', fileExtension: 'dbml', mime: 'text/plain' },
  { id: 'sql', label: 'SQL', fileExtension: 'sql', mime: 'application/sql' },
  { id: 'laravel', label: 'Laravel migration', fileExtension: 'php', mime: 'application/x-php', draft: true }
];

const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sameSet = (a, b) => a.length === b.length && a.every(name => b.includes(name));
const deleteWords = { r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

function sortedTables(schema) {
  return [...(schema.tables || [])].sort((a, b) => cmp(a.schema, b.schema) || cmp(a.name, b.name) || cmp(String(a.id), String(b.id)));
}
function sortedRelations(schema) {
  const byId = new Map((schema.tables || []).map(table => [table.id, table]));
  return (schema.relations || []).filter(r => byId.has(r.source) && byId.has(r.target) && r.pairs?.length)
    .map(relation => ({ relation, source: byId.get(relation.source), target: byId.get(relation.target) }))
    .sort((a, b) => cmp(a.source.name, b.source.name) || cmp(a.source.schema, b.source.schema) || cmp(a.relation.name || '', b.relation.name || '') || cmp(String(a.relation.id), String(b.relation.id)));
}
const primaryOf = table => table.columns.filter(column => column.primary).map(column => column.name);
const uniqueKeysOf = table => (table.uniqueKeys || []).filter(key => key?.length);
const coveredUnique = (table, name) => uniqueKeysOf(table).some(key => key.length === 1 && key[0] === name);
function isOneToOne(source, names) {
  const primary = primaryOf(source);
  if (primary.length && sameSet(primary, names)) return true;
  if (uniqueKeysOf(source).some(key => sameSet(key, names))) return true;
  return names.length === 1 && Boolean(source.columns.find(column => column.name === names[0])?.unique);
}
function plainIndexes(table) {
  const keys = [primaryOf(table), ...uniqueKeysOf(table), ...table.columns.filter(c => c.unique).map(c => [c.name])];
  const seen = new Set();
  return (table.indexes || []).filter(index => {
    const id = index.join('\u0000');
    if (!index.length || seen.has(id) || keys.some(key => key.length && key.length === index.length && key.every((n, i) => n === index[i]))) return false;
    seen.add(id);
    return true;
  });
}

export function parseDefault(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim(), cast = '(?:::[A-Za-z_][\\w ]*(?:\\(\\d+(?:,\\s*\\d+)?\\))?(?:\\[\\])?)*';
  let match = text.match(new RegExp(`^'((?:[^']|'')*)'${cast}$`));
  if (match) return { kind: 'string', value: match[1].replaceAll("''", "'") };
  match = text.match(new RegExp(`^\\(?(-?\\d+(?:\\.\\d+)?)\\)?${cast}$`));
  if (match) return { kind: 'number', value: match[1] };
  if (/^(true|false)$/i.test(text)) return { kind: 'boolean', value: text.toLowerCase() };
  if (new RegExp(`^null${cast}$`, 'i').test(text)) return { kind: 'null', value: 'null' };
  return { kind: 'expression', value: text };
}

// Mermaid
const mermaidWord = value => {
  const word = String(value ?? '').replace(/\[\]/g, '_array').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return !word ? 'unknown' : /^[0-9]/.test(word) ? `t_${word}` : word;
};
const mermaidText = value => oneLine(value).replaceAll('"', '');

export function toMermaid(schema) {
  const tables = sortedTables(schema), relations = sortedRelations(schema), names = new Map(), used = new Set();
  for (const table of tables) {
    const base = table.schema && table.schema !== 'public' ? `${mermaidWord(table.schema)}__${mermaidWord(table.name)}` : mermaidWord(table.name);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name); names.set(table.id, name);
  }
  const foreign = new Set(relations.flatMap(({ relation }) => relation.pairs.map(pair => `${relation.source}\u0000${pair.source}`)));
  const lines = ['erDiagram'];
  for (const table of tables) {
    if (!table.columns.length) { lines.push(`  ${names.get(table.id)}`); continue; }
    lines.push(`  ${names.get(table.id)} {`);
    for (const column of table.columns) {
      const keys = [column.primary && 'PK', (column.foreign || foreign.has(`${table.id}\u0000${column.name}`)) && 'FK',
        (column.unique || coveredUnique(table, column.name)) && 'UK'].filter(Boolean);
      const note = mermaidText(column.description);
      lines.push(`    ${mermaidWord(column.type)} ${mermaidWord(column.name)}${keys.length ? ` ${keys.join(', ')}` : ''}${note ? ` "${note}"` : ''}`);
    }
    lines.push('  }');
  }
  for (const { relation, source } of relations) {
    const sourceColumns = relation.pairs.map(pair => source.columns.find(column => column.name === pair.source));
    const parent = sourceColumns.some(column => column?.nullable) ? '|o' : '||';
    const child = isOneToOne(source, relation.pairs.map(pair => pair.source)) ? 'o|' : 'o{';
    lines.push(`  ${names.get(relation.target)} ${parent}--${child} ${names.get(relation.source)} : "${mermaidText(relation.name) || 'fk'}"`);
  }
  return `${lines.join('\n')}\n`;
}

// DBML
const dbmlName = value => ident.test(String(value)) ? String(value) : `"${String(value).replaceAll('"', '\\"')}"`;
const dbmlString = value => `'${oneLine(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const dbmlTable = table => `${dbmlName(table.schema || 'public')}.${dbmlName(table.name)}`;
const dbmlType = type => ident.test(String(type)) ? String(type) : `"${String(type).replaceAll('"', '\\"')}"`;
const dbmlColumns = names => names.length === 1 ? dbmlName(names[0]) : `(${names.map(dbmlName).join(', ')})`;
function dbmlDefault(raw) {
  const value = parseDefault(raw);
  if (!value) return null;
  if (value.kind === 'string') return dbmlString(value.value);
  if (value.kind === 'expression') return `\`${value.value.replaceAll('`', "'")}\``;
  return value.value;
}

export function toDbml(schema) {
  const lines = [`// ER Atlas · ${oneLine(schema.database) || 'schema'}`];
  for (const table of sortedTables(schema)) {
    const primary = primaryOf(table);
    lines.push('', `Table ${dbmlTable(table)} {`);
    for (const column of table.columns) {
      const settings = [];
      if (column.primary && primary.length === 1) settings.push('pk');
      else if (!column.nullable) settings.push('not null');
      if (column.unique && !coveredUnique(table, column.name)) settings.push('unique');
      const value = dbmlDefault(column.default);
      if (value !== null) settings.push(`default: ${value}`);
      if (oneLine(column.description)) settings.push(`note: ${dbmlString(column.description)}`);
      lines.push(`  ${dbmlName(column.name)} ${dbmlType(column.type)}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
    const indexes = [
      ...(primary.length > 1 ? [`(${primary.map(dbmlName).join(', ')}) [pk]`] : []),
      ...uniqueKeysOf(table).map(key => `${dbmlColumns(key)} [unique]`),
      ...plainIndexes(table).map(dbmlColumns)
    ];
    if (indexes.length) lines.push('', '  indexes {', ...indexes.map(index => `    ${index}`), '  }');
    if (oneLine(table.description)) lines.push('', `  Note: ${dbmlString(table.description)}`);
    lines.push('}');
  }
  const refs = sortedRelations(schema).map(({ relation, source, target }) => {
    const settings = [];
    if (deleteWords[relation.onDelete]) settings.push(`delete: ${deleteWords[relation.onDelete].toLowerCase()}`);
    if (deleteWords[relation.onUpdate]) settings.push(`update: ${deleteWords[relation.onUpdate].toLowerCase()}`);
    const side = (table, names) => `${dbmlTable(table)}.${dbmlColumns(names)}`;
    return `Ref${relation.name ? ` ${dbmlName(relation.name)}` : ''}: ${side(source, relation.pairs.map(p => p.source))} > ${side(target, relation.pairs.map(p => p.target))}${settings.length ? ` [${settings.join(', ')}]` : ''}`;
  });
  if (refs.length) lines.push('', ...refs);
  return `${lines.join('\n')}\n`;
}

// PostgreSQL DDL
const sqlName = value => `"${String(value).replaceAll('"', '""')}"`;
const sqlTable = table => `${sqlName(table.schema || 'public')}.${sqlName(table.name)}`;
const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;
const sqlList = names => names.map(sqlName).join(', ');

export function toSqlDdl(schema) {
  const out = [`-- ER Atlas · ${oneLine(schema.database) || 'schema'}`], comments = [], indexes = [];
  for (const table of sortedTables(schema)) {
    const primary = primaryOf(table);
    const items = table.columns.map(column => {
      let line = `  ${sqlName(column.name)} ${column.type}`;
      if (column.default !== null && column.default !== undefined && column.default !== '') line += ` DEFAULT ${column.default}`;
      if (column.primary && primary.length === 1) line += ' PRIMARY KEY';
      else if (!column.nullable) line += ' NOT NULL';
      if (column.unique && !coveredUnique(table, column.name)) line += ' UNIQUE';
      return line;
    });
    if (primary.length > 1) items.push(`  PRIMARY KEY (${sqlList(primary)})`);
    for (const key of uniqueKeysOf(table)) items.push(`  UNIQUE (${sqlList(key)})`);
    out.push('', items.length ? `CREATE TABLE ${sqlTable(table)} (\n${items.join(',\n')}\n);` : `CREATE TABLE ${sqlTable(table)} ();`);
    if (oneLine(table.description)) comments.push(`COMMENT ON TABLE ${sqlTable(table)} IS ${sqlString(table.description)};`);
    for (const column of table.columns) {
      if (oneLine(column.description)) comments.push(`COMMENT ON COLUMN ${sqlTable(table)}.${sqlName(column.name)} IS ${sqlString(column.description)};`);
    }
    for (const index of plainIndexes(table)) indexes.push(`CREATE INDEX ON ${sqlTable(table)} (${sqlList(index)});`);
  }
  if (indexes.length) out.push('', ...indexes);
  if (comments.length) out.push('', ...comments);
  const keys = sortedRelations(schema).map(({ relation, source, target }) =>
    `ALTER TABLE ${sqlTable(source)} ADD ${relation.name ? `CONSTRAINT ${sqlName(relation.name)} ` : ''}FOREIGN KEY (${sqlList(relation.pairs.map(p => p.source))}) REFERENCES ${sqlTable(target)} (${sqlList(relation.pairs.map(p => p.target))})` +
    `${deleteWords[relation.onDelete] ? ` ON DELETE ${deleteWords[relation.onDelete]}` : ''}${deleteWords[relation.onUpdate] ? ` ON UPDATE ${deleteWords[relation.onUpdate]}` : ''};`);
  if (keys.length) out.push('', ...keys);
  return `${out.join('\n')}\n`;
}

// Laravel migration
const php = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const phpList = names => names.length === 1 ? php(names[0]) : `[${names.map(php).join(', ')}]`;
const laravelTable = table => table.schema && table.schema !== 'public' ? `${table.schema}.${table.name}` : table.name;
const snake = value => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const currentDefault = /^(?:now\(\)|current_timestamp(?:\(\d\))?)(?:::[\w ]+)?$/i;

function columnMethod(column, opts) {
  const type = oneLine(column.type).toLowerCase(), name = php(column.name);
  let m;
  if (/\[\]$/.test(type)) return null;
  if (!opts.change && column.name === 'id' && column.primary && /^(bigint|int8|bigserial)$/.test(type)) return { code: '$table->id()', keyed: true };
  if (!opts.change && column.primary && (m = type.match(/^(small|big)?serial$/))) return { code: `$table->${m[1] || ''}${m[1] ? 'I' : 'i'}ncrements(${name})`, keyed: true };
  if ((m = type.match(/^(small|big)?serial$/))) return { code: `$table->${{ small: 'smallInteger', big: 'bigInteger' }[m[1]] || 'integer'}(${name})`, note: type };
  if (/^(bigint|int8)$/.test(type)) return { code: `$table->bigInteger(${name})` };
  if (/^(integer|int|int4)$/.test(type)) return { code: `$table->integer(${name})` };
  if (/^(smallint|int2)$/.test(type)) return { code: `$table->smallInteger(${name})` };
  if (type === 'uuid') return { code: `$table->uuid(${name})` };
  if ((m = type.match(/^(?:varchar|character varying)(?:\((\d+)\))?$/))) return { code: `$table->string(${name}${m[1] ? `, ${m[1]}` : ''})` };
  if ((m = type.match(/^(?:char|character|bpchar)(?:\((\d+)\))?$/))) return { code: `$table->char(${name}${m[1] ? `, ${m[1]}` : ''})` };
  if (type === 'text') return { code: `$table->text(${name})` };
  if (/^(boolean|bool)$/.test(type)) return { code: `$table->boolean(${name})` };
  if ((m = type.match(/^(?:timestamptz(?:\((\d)\))?|timestamp(?:\((\d)\))? with time zone)$/))) return { code: `$table->timestampTz(${name}${m[1] || m[2] ? `, ${m[1] || m[2]}` : ''})` };
  if ((m = type.match(/^timestamp(?:\((\d)\))?(?: without time zone)?$/))) return { code: `$table->timestamp(${name}${m[1] ? `, ${m[1]}` : ''})` };
  if (type === 'date') return { code: `$table->date(${name})` };
  if ((m = type.match(/^(?:timetz(?:\((\d)\))?|time(?:\((\d)\))? with time zone)$/))) return { code: `$table->timeTz(${name}${m[1] || m[2] ? `, ${m[1] || m[2]}` : ''})` };
  if ((m = type.match(/^time(?:\((\d)\))?(?: without time zone)?$/))) return { code: `$table->time(${name}${m[1] ? `, ${m[1]}` : ''})` };
  if ((m = type.match(/^(?:numeric|decimal)(?:\((\d+)(?:,\s*(\d+))?\))?$/))) return { code: `$table->decimal(${name}${m[1] ? `, ${m[1]}, ${m[2] || 0}` : ''})` };
  if (type === 'jsonb') return { code: `$table->jsonb(${name})` };
  if (type === 'json') return { code: `$table->json(${name})` };
  if (/^(double precision|float8)$/.test(type)) return { code: `$table->double(${name})` };
  if (/^(real|float4)$/.test(type)) return { code: `$table->float(${name})` };
  if (type === 'bytea') return { code: `$table->binary(${name})` };
  if (type === 'inet') return { code: `$table->ipAddress(${name})` };
  if (type === 'macaddr') return { code: `$table->macAddress(${name})` };
  return null;
}

function columnLine(column, ctx, opts = {}) {
  const method = columnMethod(column, opts);
  if (!method) return `// TODO: نوع غير مدعوم في Laravel: ${oneLine(column.type)} للعمود ${oneLine(column.name)}`;
  let code = method.code;
  if (column.nullable && !method.keyed) code += '->nullable()';
  const value = method.keyed ? null : parseDefault(column.default);
  if (value?.kind === 'string') code += `->default(${php(value.value)})`;
  else if (value?.kind === 'number' || value?.kind === 'boolean') code += `->default(${value.value})`;
  else if (value?.kind === 'expression' && currentDefault.test(value.value)) code += '->useCurrent()';
  else if (value?.kind === 'expression') { ctx.usesDb = true; code += `->default(DB::raw(${php(value.value)}))`; }
  if (!opts.change && column.primary && !method.keyed && opts.inlinePrimary !== false) code += '->primary()';
  if (!opts.change && column.unique) code += '->unique()';
  if (oneLine(column.description)) code += `->comment(${php(oneLine(column.description))})`;
  return `${code}${opts.change ? '->change()' : ''};${method.note ? ` // ${method.note}` : ''}`;
}

const actionCalls = {
  delete: { c: '->cascadeOnDelete()', n: '->nullOnDelete()', r: '->restrictOnDelete()', d: "->onDelete('set default')" },
  update: { c: '->cascadeOnUpdate()', n: "->onUpdate('set null')", r: '->restrictOnUpdate()', d: "->onUpdate('set default')" }
};
function foreignLine(relation, target) {
  return `$table->foreign(${phpList(relation.pairs.map(p => p.source))}${relation.name ? `, ${php(relation.name)}` : ''})` +
    `->references(${phpList(relation.pairs.map(p => p.target))})->on(${php(laravelTable(target))})` +
    `${actionCalls.delete[relation.onDelete] || ''}${actionCalls.update[relation.onUpdate] || ''};`;
}
const dropForeignLine = relation => `$table->dropForeign(${relation.name ? php(relation.name) : `[${relation.pairs.map(p => php(p.source)).join(', ')}]`});`;
const touches = (relation, id) => relation.source === id || relation.target === id;

function track(work, op) {
  const table = id => work.tables.find(item => item.id === id);
  switch (op.type) {
    case 'addTable': work.tables.push({ id: op.id, schema: op.schema || 'public', name: op.name, description: '', approxRows: 0, columns: [], kind: 'proposed' }); break;
    case 'renameTable': table(op.tableId).name = op.name; break;
    case 'addColumn': {
      const c = op.column;
      table(op.tableId).columns.push({ name: c.name, type: c.type, nullable: c.primary ? false : Boolean(c.nullable), default: c.default || null,
        description: c.description || '', primary: Boolean(c.primary), unique: Boolean(c.unique), foreign: false, kind: 'proposed' });
      break;
    }
    case 'updateColumn': {
      const column = table(op.tableId).columns.find(c => c.name === op.columnName);
      if (op.patch.name && op.patch.name !== column.name) {
        for (const relation of work.relations) for (const pair of relation.pairs) {
          if (relation.source === op.tableId && pair.source === column.name) pair.source = op.patch.name;
          if (relation.target === op.tableId && pair.target === column.name) pair.target = op.patch.name;
        }
      }
      Object.assign(column, op.patch);
      break;
    }
    case 'dropColumn': {
      const t = table(op.tableId);
      t.columns = t.columns.filter(c => c.name !== op.columnName);
      work.relations = work.relations.filter(r => !r.pairs.some(p => (r.source === t.id && p.source === op.columnName) || (r.target === t.id && p.target === op.columnName)));
      break;
    }
    case 'addRelation': work.relations.push({ ...structuredClone(op.relation), kind: 'proposed' }); break;
    case 'dropRelation': work.relations = work.relations.filter(r => r.id !== op.relationId); break;
    case 'addIndex': (table(op.tableId).draftIndexes ||= []).push({ ...op.index }); break;
    case 'dropTable':
      work.tables = work.tables.filter(t => t.id !== op.tableId);
      work.relations = work.relations.filter(r => !touches(r, op.tableId));
      break;
  }
}

function opTableId(work, op) {
  if (op.type === 'addTable') return op.id;
  if (op.type === 'addRelation') return op.relation?.source;
  if (op.type === 'dropRelation') return work.relations.find(r => r.id === op.relationId)?.source;
  return op.tableId;
}
function opProblem(work, op) {
  const table = id => work.tables.find(t => t.id === id);
  const t = table(opTableId(work, op));
  switch (op.type) {
    case 'addTable': return null;
    case 'addRelation': return !t || !table(op.relation.target) ? 'جدول العلاقة غير موجود' : null;
    case 'dropRelation': return !t ? 'العلاقة غير موجودة' : null;
    case 'renameTable': case 'dropTable': case 'addColumn': return !t ? 'الجدول غير موجود' : null;
    case 'addIndex': return !t ? 'الجدول غير موجود' : !(op.index?.columns || []).every(name => t.columns.some(c => c.name === name)) ? 'عمود الفهرس غير موجود' : null;
    case 'updateColumn': case 'dropColumn': return !t ? 'الجدول غير موجود' : !t.columns.some(c => c.name === op.columnName) ? 'العمود غير موجود' : null;
    default: return 'نوع تغيير غير معروف';
  }
}

function migrationName(base, operations) {
  const work = structuredClone(base), names = new Map();
  let created = false, dropped = false;
  for (const op of operations) {
    if (opProblem(work, op)) continue;
    const id = opTableId(work, op);
    if (!names.has(id)) names.set(id, op.type === 'addTable' ? op.name : work.tables.find(t => t.id === id).name);
    if (op.type === 'addTable') created = true;
    if (op.type === 'dropTable') dropped = true;
    track(work, op);
  }
  if (names.size !== 1) return 'er_atlas_changes';
  const name = snake([...names.values()][0]);
  return `${created ? 'create' : dropped ? 'drop' : 'update'}_${name}_table`;
}

function renderBlocks(blocks, pad) {
  if (!blocks.length) return [`${pad}// لا توجد تغييرات`];
  return blocks.flatMap((block, index) => {
    const lines = index ? [''] : [];
    if (!block.closure) return [...lines, ...block.lines.map(line => pad + line)];
    const body = block.lines.map(line => typeof line === 'function' ? line() : line).flat();
    return [...lines, `${pad}Schema::${block.closure}(${php(block.table)}, function (Blueprint $table) {`, ...body.map(line => `${pad}    ${line}`), `${pad}});`];
  });
}

export function toLaravelMigration(base, operations = [], { date = '2026_01_01_000000', name } = {}) {
  const work = structuredClone(base || { tables: [], relations: [] });
  work.tables ||= []; work.relations ||= [];
  const ctx = { usesDb: false }, up = [], down = [], created = new Set();
  let current = null;
  const raw = (...lines) => { current = null; up.push({ lines }); };
  const block = (table, { create = false, fold = false, fresh = false } = {}) => {
    if (fresh || !current || current.tableId !== table.id || !(fold || current.closure === 'table')) {
      current = { closure: create ? 'create' : 'table', tableId: table.id, table: laravelTable(table), lines: [], primaries: [] };
      up.push(current);
    }
    return current;
  };
  const undo = (table, lines, flags = {}) => down.push({ closure: 'table', tableId: table.id, table: laravelTable(table), lines, ...flags });
  const undoRaw = (...lines) => down.push({ lines });
  const find = id => work.tables.find(t => t.id === id);

  for (const op of operations) {
    const problem = opProblem(work, op);
    if (problem) { raw(`// تخطّي تغيير ${oneLine(op?.type)}: ${problem}`); continue; }
    const table = find(opTableId(work, op));
    switch (op.type) {
      case 'addTable': {
        created.add(op.id);
        const fresh = { id: op.id, schema: op.schema || 'public', name: op.name };
        block(fresh, { create: true, fresh: true });
        undoRaw(`Schema::dropIfExists(${php(laravelTable(fresh))});`);
        break;
      }
      case 'renameTable': {
        const before = laravelTable(table), after = laravelTable({ ...table, name: op.name });
        raw(`Schema::rename(${php(before)}, ${php(after)});`);
        undoRaw(`Schema::rename(${php(after)}, ${php(before)});`);
        break;
      }
      case 'addColumn': {
        const target = block(table, { fold: true });
        const column = { name: op.column.name, type: op.column.type, nullable: op.column.primary ? false : Boolean(op.column.nullable),
          default: op.column.default || null, primary: Boolean(op.column.primary), unique: Boolean(op.column.unique), description: op.column.description || '' };
        if (target.closure === 'create' && column.primary) {
          target.primaries.push(column.name);
          const group = target;
          group.lines.push(() => columnLine(column, ctx, { inlinePrimary: group.primaries.length < 2 }));
          if (group.primaries.length === 2) group.lines.push(() => `$table->primary(${phpList(group.primaries)});`);
        } else {
          target.lines.push(columnLine(column, ctx));
        }
        if (!created.has(table.id)) undo(table, [`$table->dropColumn(${php(column.name)});`]);
        break;
      }
      case 'updateColumn': {
        const before = { ...table.columns.find(c => c.name === op.columnName) };
        const after = { ...before, ...op.patch };
        const renamed = after.name !== before.name;
        const changed = ['type', 'nullable', 'default'].some(key => (after[key] ?? null) !== (before[key] ?? null));
        if (renamed) {
          const target = block(table);
          target.lines.push(`$table->renameColumn(${php(before.name)}, ${php(after.name)});`);
          target.renamed = true;
        }
        if (changed) block(table, { fresh: Boolean(current?.renamed) }).lines.push(columnLine(after, ctx, { change: true }));
        if (!created.has(table.id)) {
          if (renamed) undo(table, [`$table->renameColumn(${php(after.name)}, ${php(before.name)});`], { renamed: true });
          if (changed) undo(table, [columnLine({ ...before, name: after.name }, ctx, { change: true })], { changed: true });
        }
        break;
      }
      case 'dropColumn': {
        const column = table.columns.find(c => c.name === op.columnName);
        const using = work.relations.filter(r => r.pairs.some(p => (r.source === table.id && p.source === column.name) || (r.target === table.id && p.target === column.name)));
        for (const relation of using.filter(r => r.source !== table.id)) block(find(relation.source)).lines.push(dropForeignLine(relation));
        const target = block(table);
        for (const relation of using.filter(r => r.source === table.id)) target.lines.push(dropForeignLine(relation));
        target.lines.push(`$table->dropColumn(${php(column.name)});`);
        if (!created.has(table.id)) undoRaw(`// يدوي: أعد إنشاء العمود ${table.name}.${column.name} (${oneLine(column.type)})${using.length ? ` وقيود ${using.map(r => r.name || 'fk').join('، ')}` : ''} يدويًا`);
        break;
      }
      case 'addRelation': {
        const relation = op.relation, target = find(relation.target);
        block(table, { fold: true }).lines.push(foreignLine(relation, target));
        if (!created.has(table.id)) undo(table, [dropForeignLine(relation)]);
        break;
      }
      case 'dropRelation': {
        const relation = work.relations.find(r => r.id === op.relationId);
        block(table).lines.push(dropForeignLine(relation));
        if (!created.has(table.id)) undo(table, [foreignLine(relation, find(relation.target))]);
        break;
      }
      case 'addIndex': {
        const index = op.index;
        block(table, { fold: true }).lines.push(`$table->${index.unique ? 'unique' : 'index'}(${phpList(index.columns)}, ${php(index.name)});`);
        if (!created.has(table.id)) undo(table, [`$table->drop${index.unique ? 'Unique' : 'Index'}(${php(index.name)});`]);
        break;
      }
      case 'dropTable': {
        for (const relation of work.relations.filter(r => r.target === table.id && r.source !== table.id)) block(find(relation.source)).lines.push(dropForeignLine(relation));
        raw(`Schema::dropIfExists(${php(laravelTable(table))});`);
        if (!created.has(table.id)) undoRaw(`// يدوي: أعد إنشاء الجدول ${laravelTable(table)} وعلاقاته يدويًا`);
        break;
      }
    }
    track(work, op);
  }

  const downBlocks = [];
  let last = null;
  for (const entry of down.reverse()) {
    if (!entry.closure) { downBlocks.push(entry); last = null; continue; }
    if (!last || last.tableId !== entry.tableId || (entry.changed && last.renamed)) { last = { ...entry, lines: [...entry.lines] }; downBlocks.push(last); }
    else { last.lines.push(...entry.lines); last.renamed ||= entry.renamed; }
  }
  const upLines = renderBlocks(up, '        '), downLines = renderBlocks(downBlocks, '        ');
  const code = ['<?php', '', 'use Illuminate\\Database\\Migrations\\Migration;', 'use Illuminate\\Database\\Schema\\Blueprint;',
    ...(ctx.usesDb ? ['use Illuminate\\Support\\Facades\\DB;'] : []), 'use Illuminate\\Support\\Facades\\Schema;', '',
    'return new class extends Migration', '{', '    public function up(): void', '    {', ...upLines, '    }', '',
    '    public function down(): void', '    {', ...downLines, '    }', '};', ''].join('\n');
  return { fileName: `${date}_${snake(name) || migrationName(base || { tables: [], relations: [] }, operations)}.php`, code };
}

export function exportSchema(formatId, schema, operations = [], options = {}) {
  if (formatId === 'mermaid') return toMermaid(schema);
  if (formatId === 'dbml') return toDbml(schema);
  if (formatId === 'sql') return toSqlDdl(schema);
  if (formatId === 'laravel') return toLaravelMigration(schema, operations, options).code;
  throw new Error('صيغة تصدير غير معروفة');
}
