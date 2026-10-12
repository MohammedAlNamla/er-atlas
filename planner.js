import { createHash } from 'node:crypto';
import { applyOperation } from './public/model.js';

const q = value => `"${String(value).replaceAll('"', '""')}"`;
const tableSql = table => `${q(table.schema)}.${q(table.name)}`;
const typePattern = /^(?:smallint|integer|bigint|boolean|text|uuid|date|time(?: without time zone)?|timestamp(?: with(?:out)? time zone)?|timestamptz|numeric(?:\(\d{1,3}(?:,\s*\d{1,3})?\))?|decimal(?:\(\d{1,3}(?:,\s*\d{1,3})?\))?|varchar(?:\(\d{1,5}\))?|character varying(?:\(\d{1,5}\))?|char(?:\(\d{1,5}\))?|double precision|real|jsonb?|bytea|inet|citext)$/i;
function safeType(value) {
  const type = String(value || '').trim();
  if (!typePattern.test(type)) throw new Error(`نوع عمود غير مدعوم: ${type}`);
  return type;
}
function safeDefault(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^(?:-?\d+(?:\.\d+)?|true|false|null|now\(\)|gen_random_uuid\(\)|current_timestamp|current_date)$/i.test(text)) return text;
  if (/^'(?:[^']|'')*'$/.test(text)) return text;
  throw new Error('القيمة الافتراضية يجب أن تكون قيمة ثابتة أو now() أو gen_random_uuid()');
}
function getTable(schema, id) {
  const table = schema.tables.find(item => item.id === id);
  if (!table) throw new Error('الجدول غير موجود في المخطط الحالي');
  return table;
}
function getRelation(schema, id) {
  const relation = schema.relations.find(item => item.id === id);
  if (!relation) throw new Error('العلاقة غير موجودة في المخطط الحالي');
  return relation;
}
export function fingerprint(schema) {
  const data = {
    tables: schema.tables.map(t => [t.id, t.schema, t.name, t.columns.map(c => [c.name, c.type, c.nullable, c.default, c.primary, c.unique])]),
    relations: schema.relations.map(r => [r.id, r.name, r.source, r.target, r.pairs])
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function planChanges(base, operations) {
  if (!Array.isArray(operations) || operations.length > 200) throw new Error('عدد التغييرات غير صالح');
  let schema = structuredClone(base);
  const statements = [];
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') throw new Error('تغيير غير صالح');
    const next = applyOperation(schema, operation);
    switch (operation.type) {
      case 'addTable': {
        const table = getTable(next, operation.id);
        statements.push(`CREATE TABLE ${tableSql(table)} ();`);
        break;
      }
      case 'renameTable': {
        const table = getTable(schema, operation.tableId);
        statements.push(`ALTER TABLE ${tableSql(table)} RENAME TO ${q(operation.name)};`);
        break;
      }
      case 'addColumn': {
        const table = getTable(schema, operation.tableId), column = operation.column;
        const defaultSql = safeDefault(column.default);
        statements.push(`ALTER TABLE ${tableSql(table)} ADD COLUMN ${q(column.name)} ${safeType(column.type)}${defaultSql ? ` DEFAULT ${defaultSql}` : ''}${column.nullable ? '' : ' NOT NULL'};`);
        if (column.primary) statements.push(`ALTER TABLE ${tableSql(table)} ADD PRIMARY KEY (${q(column.name)});`);
        break;
      }
      case 'updateColumn': {
        const table = getTable(schema, operation.tableId);
        const before = table.columns.find(c => c.name === operation.columnName), after = next.tables.find(t => t.id === table.id).columns.find(c => c.name === operation.patch.name);
        if (!before || !after) throw new Error('العمود غير موجود');
        const name = operation.patch.name || before.name;
        if (name !== before.name) statements.push(`ALTER TABLE ${tableSql(table)} RENAME COLUMN ${q(before.name)} TO ${q(name)};`);
        if (after.type !== before.type) statements.push(`ALTER TABLE ${tableSql(table)} ALTER COLUMN ${q(name)} TYPE ${safeType(after.type)};`);
        if (after.nullable !== before.nullable) statements.push(`ALTER TABLE ${tableSql(table)} ALTER COLUMN ${q(name)} ${after.nullable ? 'DROP' : 'SET'} NOT NULL;`);
        if (after.default !== before.default) {
          const defaultSql = safeDefault(after.default);
          statements.push(`ALTER TABLE ${tableSql(table)} ALTER COLUMN ${q(name)} ${defaultSql ? `SET DEFAULT ${defaultSql}` : 'DROP DEFAULT'};`);
        }
        break;
      }
      case 'dropColumn': {
        const table = getTable(schema, operation.tableId);
        for (const relation of schema.relations.filter(r => r.pairs.some(p =>
          (r.source === table.id && p.source === operation.columnName) || (r.target === table.id && p.target === operation.columnName)))) {
          const source = getTable(schema, relation.source);
          statements.push(`ALTER TABLE ${tableSql(source)} DROP CONSTRAINT ${q(relation.name)};`);
        }
        statements.push(`ALTER TABLE ${tableSql(table)} DROP COLUMN ${q(operation.columnName)};`);
        break;
      }
      case 'addRelation': {
        const relation = operation.relation, source = getTable(schema, relation.source), target = getTable(schema, relation.target);
        statements.push(`ALTER TABLE ${tableSql(source)} ADD CONSTRAINT ${q(relation.name)} FOREIGN KEY (${relation.pairs.map(p => q(p.source)).join(', ')}) REFERENCES ${tableSql(target)} (${relation.pairs.map(p => q(p.target)).join(', ')});`);
        break;
      }
      case 'dropRelation': {
        const relation = getRelation(schema, operation.relationId), source = getTable(schema, relation.source);
        statements.push(`ALTER TABLE ${tableSql(source)} DROP CONSTRAINT ${q(relation.name)};`);
        break;
      }
      default: throw new Error('تغيير غير مدعوم');
    }
    schema = next;
  }
  return { statements, sql: statements.join('\n'), count: operations.length, baseFingerprint: fingerprint(base) };
}
