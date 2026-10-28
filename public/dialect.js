// SQL dialects: how PostgreSQL and MySQL/MariaDB spell the same schema change. The server's planner
// and the browser's previews and exports both read this, so the SQL a user previews is the SQL they get.
import { applyOperation } from './model.js';

const PG_TYPE = /^(?:smallint|integer|bigint|boolean|text|uuid|date|time(?:\(\d\))?(?: with(?:out)? time zone)?|timestamp(?:\(\d\))?(?: with(?:out)? time zone)?|timestamptz(?:\(\d\))?|smallserial|serial|bigserial|numeric(?:\(\d{1,3}(?:,\s*\d{1,3})?\))?|decimal(?:\(\d{1,3}(?:,\s*\d{1,3})?\))?|varchar(?:\(\d{1,5}\))?|character varying(?:\(\d{1,5}\))?|char(?:\(\d{1,5}\))?|double precision|real|jsonb?|bytea|inet|citext)(?:\[\])?$/i;
const MYSQL_LITERAL = "'(?:[^'\\\\]|'')*'";
const MYSQL_TYPE = new RegExp(`^(?:(?:tiny|small|medium|big)?int(?:eger)?(?:\\(\\d{1,3}\\))?(?: unsigned)?|bool(?:ean)?|bit(?:\\(\\d{1,2}\\))?|(?:decimal|numeric|dec)(?:\\(\\d{1,2}(?:,\\s*\\d{1,2})?\\))?(?: unsigned)?|float(?:\\(\\d{1,2}(?:,\\s*\\d{1,2})?\\))?|double(?: precision)?|real|(?:var)?char\\(\\d{1,5}\\)|(?:var)?binary\\(\\d{1,5}\\)|(?:tiny|medium|long)?text|(?:tiny|medium|long)?blob|json|uuid|date|datetime(?:\\([0-6]\\))?|timestamp(?:\\([0-6]\\))?|time(?:\\([0-6]\\))?|year|(?:enum|set)\\(${MYSQL_LITERAL}(?:,\\s*${MYSQL_LITERAL})*\\))$`, 'i');
const PG_DEFAULT = /^(?:-?\d+(?:\.\d+)?|true|false|null|now\(\)|gen_random_uuid\(\)|current_timestamp|current_date)$/i;
const MYSQL_DEFAULT = /^(?:-?\d+(?:\.\d+)?|true|false|null|now\(\)|current_timestamp(?:\(\d?\))?|current_date|uuid\(\)|\(uuid\(\)\))$/i;
const ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export const engineOf = schema => schema?.engine === 'mysql' ? 'mysql' : 'postgres';

export function dialect(engine) {
  const mysql = engine === 'mysql';
  const quote = value => mysql ? `\`${String(value).replaceAll('`', '``')}\`` : `"${String(value).replaceAll('"', '""')}"`;
  const table = item => `${quote(item.schema)}.${quote(item.name)}`;
  const type = value => {
    const text = String(value || '').trim();
    if (!(mysql ? MYSQL_TYPE : PG_TYPE).test(text)) throw new Error(`نوع عمود غير مدعوم في ${mysql ? 'MySQL' : 'PostgreSQL'}: ${text}`);
    return text;
  };
  const defaultValue = value => {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    if ((mysql ? MYSQL_DEFAULT : PG_DEFAULT).test(text) || /^'(?:[^']|'')*'$/.test(text)) return text;
    throw new Error(mysql ? 'القيمة الافتراضية يجب أن تكون قيمة ثابتة أو CURRENT_TIMESTAMP أو (uuid())' : 'القيمة الافتراضية يجب أن تكون قيمة ثابتة أو now() أو gen_random_uuid()');
  };
  const action = (word, code) => {
    if (code === undefined || code === null || code === '' || code === 'a') return '';
    if (!ACTIONS[code]) throw new Error('إجراء الحذف غير مدعوم');
    return ` ${word} ${ACTIONS[code]}`;
  };
  // A MySQL column definition restates everything MODIFY would otherwise drop: nullability, default,
  // auto-increment and comment.
  const definition = (column, { primary = false } = {}) => {
    const fallback = defaultValue(column.default);
    return `${quote(column.name)} ${type(column.type)}${column.nullable ? (mysql ? ' NULL' : '') : ' NOT NULL'}${fallback ? ` DEFAULT ${fallback}` : ''}` +
      `${mysql && column.autoIncrement ? ' AUTO_INCREMENT' : ''}${primary ? ' PRIMARY KEY' : ''}${mysql && column.description ? ` COMMENT '${String(column.description).replaceAll("'", "''")}'` : ''}`;
  };
  return {
    engine: mysql ? 'mysql' : 'postgres', label: mysql ? 'MySQL' : 'PostgreSQL', quote, table, type, defaultValue, definition,
    onDelete: code => action('ON DELETE', code),
    renameTable: (item, name) => `ALTER TABLE ${table(item)} RENAME TO ${mysql ? `${quote(item.schema)}.` : ''}${quote(name)};`,
    dropForeignKey: (item, name) => `ALTER TABLE ${table(item)} ${mysql ? 'DROP FOREIGN KEY' : 'DROP CONSTRAINT'} ${quote(name)};`,
    // MySQL has no CONCURRENTLY; InnoDB builds the index online when asked not to lock.
    createIndex: (item, index) => mysql
      ? `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${table(item)} (${index.columns.map(quote).join(', ')})${index.concurrently ? ' ALGORITHM=INPLACE LOCK=NONE' : ''};`
      : `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.concurrently ? 'CONCURRENTLY ' : ''}${quote(index.name)} ON ${table(item)} (${index.columns.map(quote).join(', ')});`,
    // Spells one column edit: PostgreSQL alters each property; MySQL changes type or nullability with one
    // MODIFY that carries the whole new definition (which also covers a default changed alongside).
    alterColumn(item, before, after) {
      const target = `ALTER TABLE ${table(item)}`, statements = [];
      if (after.name !== before.name) statements.push(`${target} RENAME COLUMN ${quote(before.name)} TO ${quote(after.name)};`);
      if (mysql) {
        if (after.type !== before.type || after.nullable !== before.nullable) statements.push(`${target} MODIFY COLUMN ${definition(after)};`);
        else if (after.default !== before.default) {
          const fallback = defaultValue(after.default);
          statements.push(`${target} ALTER COLUMN ${quote(after.name)} ${fallback ? `SET DEFAULT ${fallback}` : 'DROP DEFAULT'};`);
        }
        return statements;
      }
      if (after.type !== before.type) statements.push(`${target} ALTER COLUMN ${quote(after.name)} TYPE ${type(after.type)} USING ${quote(after.name)}::${type(after.type)};`);
      if (after.nullable !== before.nullable) statements.push(`${target} ALTER COLUMN ${quote(after.name)} ${after.nullable ? 'DROP' : 'SET'} NOT NULL;`);
      if (after.default !== before.default) {
        const fallback = defaultValue(after.default);
        statements.push(`${target} ALTER COLUMN ${quote(after.name)} ${fallback ? `SET DEFAULT ${fallback}` : 'DROP DEFAULT'};`);
      }
      return statements;
    }
  };
}

const getTable = (schema, id) => {
  const table = schema.tables.find(item => item.id === id);
  if (!table) throw new Error('الجدول غير موجود في المخطط الحالي');
  return table;
};
const getRelation = (schema, id) => {
  const relation = schema.relations.find(item => item.id === id);
  if (!relation) throw new Error('العلاقة غير موجودة في المخطط الحالي');
  return relation;
};

// The draft as ordered SQL statements in the base schema's own dialect.
export function planStatements(base, operations) {
  if (!Array.isArray(operations) || operations.length > 200) throw new Error('عدد التغييرات غير صالح');
  const sql = dialect(engineOf(base)), mysql = sql.engine === 'mysql';
  let schema = structuredClone(base);
  const statements = [];
  // MySQL cannot create a table with no columns, so a new table is written with the columns the draft
  // adds to it, and those addColumn steps are not repeated.
  const folded = new Set();
  operations.forEach((operation, index) => {
    if (!operation || typeof operation !== 'object') throw new Error('تغيير غير صالح');
    const next = applyOperation(schema, operation);
    switch (operation.type) {
      case 'addTable': {
        const table = getTable(next, operation.id);
        if (!mysql) { statements.push(`CREATE TABLE ${sql.table(table)} ();`); break; }
        const columns = operations.slice(index + 1).filter(item => item?.type === 'addColumn' && item.tableId === operation.id);
        if (!columns.length) throw new Error(`MySQL لا ينشئ جدولًا بلا أعمدة: أضف عمودًا إلى ${table.name} في المسودة`);
        columns.forEach(item => folded.add(item));
        const primary = columns.filter(item => item.column.primary).map(item => item.column.name);
        const lines = columns.map(item => `  ${sql.definition({ ...item.column, nullable: item.column.primary ? false : item.column.nullable }, { primary: primary.length === 1 && item.column.primary })}`);
        if (primary.length > 1) lines.push(`  PRIMARY KEY (${primary.map(sql.quote).join(', ')})`);
        statements.push(`CREATE TABLE ${sql.table(table)} (\n${lines.join(',\n')}\n);`);
        break;
      }
      case 'renameTable':
        statements.push(sql.renameTable(getTable(schema, operation.tableId), operation.name));
        break;
      case 'addColumn': {
        if (folded.has(operation)) break;
        const table = getTable(schema, operation.tableId), column = operation.column;
        const fallback = sql.defaultValue(column.default);
        statements.push(`ALTER TABLE ${sql.table(table)} ADD COLUMN ${sql.quote(column.name)} ${sql.type(column.type)}${fallback ? ` DEFAULT ${fallback}` : ''}${column.nullable ? '' : ' NOT NULL'};`);
        if (column.primary) statements.push(`ALTER TABLE ${sql.table(table)} ADD PRIMARY KEY (${sql.quote(column.name)});`);
        break;
      }
      case 'updateColumn': {
        const table = getTable(schema, operation.tableId);
        const before = table.columns.find(c => c.name === operation.columnName);
        const name = operation.patch.name || operation.columnName;
        const after = next.tables.find(t => t.id === table.id).columns.find(c => c.name === name);
        if (!before || !after) throw new Error('العمود غير موجود');
        statements.push(...sql.alterColumn(table, before, after));
        break;
      }
      case 'dropColumn': {
        const table = getTable(schema, operation.tableId);
        for (const relation of schema.relations.filter(r => r.pairs.some(p =>
          (r.source === table.id && p.source === operation.columnName) || (r.target === table.id && p.target === operation.columnName)))) {
          statements.push(sql.dropForeignKey(getTable(schema, relation.source), relation.name));
        }
        statements.push(`ALTER TABLE ${sql.table(table)} DROP COLUMN ${sql.quote(operation.columnName)};`);
        break;
      }
      case 'addRelation': {
        const relation = operation.relation, source = getTable(schema, relation.source), target = getTable(schema, relation.target);
        statements.push(`ALTER TABLE ${sql.table(source)} ADD CONSTRAINT ${sql.quote(relation.name)} FOREIGN KEY (${relation.pairs.map(p => sql.quote(p.source)).join(', ')}) REFERENCES ${sql.table(target)} (${relation.pairs.map(p => sql.quote(p.target)).join(', ')})${sql.onDelete(relation.onDelete)};`);
        break;
      }
      case 'dropRelation': {
        const relation = getRelation(schema, operation.relationId);
        statements.push(sql.dropForeignKey(getTable(schema, relation.source), relation.name));
        break;
      }
      case 'addIndex':
        statements.push(sql.createIndex(getTable(schema, operation.tableId), operation.index));
        break;
      case 'dropTable': {
        const table = getTable(schema, operation.tableId);
        // Inbound keys from other tables would block DROP TABLE; drop them explicitly instead of CASCADE.
        for (const relation of schema.relations.filter(r => r.target === table.id && r.source !== table.id)) {
          statements.push(sql.dropForeignKey(getTable(schema, relation.source), relation.name));
        }
        statements.push(`DROP TABLE ${sql.table(table)};`);
        break;
      }
      default: throw new Error('تغيير غير مدعوم');
    }
    schema = next;
  });
  return statements;
}
