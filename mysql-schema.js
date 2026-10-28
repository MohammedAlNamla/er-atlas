// MySQL / MariaDB readers: the same schema shape pg-schema.js returns, read from information_schema.
// MySQL has no table oid, so a table's id is "<database>.<table>". Every reader takes any client
// whose query() resolves to mysql2's [rows] (or { rows }), so tests can hand them a fake one.
import { fingerprint } from './planner.js';

const rowsOf = result => Array.isArray(result) ? result[0] : result.rows;
const run = async (db, sql, params = []) => rowsOf(await db.query(sql, params));
const ident = value => `\`${String(value).replaceAll('`', '``')}\``;
const RULES = { CASCADE: 'c', 'SET NULL': 'n', RESTRICT: 'r', 'NO ACTION': 'a', 'SET DEFAULT': 'd' };
const STRINGY = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);

// MySQL 8.0.19+ dropped integer display widths; MariaDB and older MySQL still print them.
// Normalising keeps one schema's fingerprint stable across servers. tinyint(1) is Laravel's boolean, so it stays.
export function mysqlType(columnType) {
  const type = String(columnType || '').toLowerCase();
  if (/^tinyint\(1\)/.test(type)) return type;
  return type.replace(/^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1');
}

// MariaDB quotes string defaults and spells a missing default as the word NULL; MySQL 8 does neither.
// Both end up as the SQL literal a reader would write: 'active', 0, CURRENT_TIMESTAMP, or no default.
export function mysqlDefault(value, dataType) {
  if (value === null || value === undefined || value === 'NULL') return null;
  const text = String(value);
  if (!STRINGY.has(String(dataType).toLowerCase()) || /^'.*'$/s.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

export const MYSQL_TABLES_SQL = `
    SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_COMMENT AS description, TABLE_ROWS AS approx_rows
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME`;
export const MYSQL_COLUMNS_SQL = `
    SELECT TABLE_NAME AS table_name, ORDINAL_POSITION AS number, COLUMN_NAME AS name, COLUMN_TYPE AS column_type,
           DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS default_value, EXTRA AS extra,
           COLUMN_COMMENT AS description
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION`;
export const MYSQL_INDEXES_SQL = `
    SELECT TABLE_NAME AS table_name, INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS column_name
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;
export const MYSQL_FOREIGN_KEYS_SQL = `
    SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name,
           k.REFERENCED_TABLE_SCHEMA AS target_schema, k.REFERENCED_TABLE_NAME AS target_table, k.REFERENCED_COLUMN_NAME AS target_column,
           r.DELETE_RULE AS on_delete, r.UPDATE_RULE AS on_update
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`;
// CHECK constraints exist from MySQL 8.0.16 / MariaDB 10.2; older servers just have none.
export const MYSQL_CHECKS_SQL = `
    SELECT tc.TABLE_NAME AS table_name, cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS definition
    FROM information_schema.CHECK_CONSTRAINTS cc
    JOIN information_schema.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_TYPE = 'CHECK'
    WHERE cc.CONSTRAINT_SCHEMA = DATABASE()
    ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME`;

export async function readMysqlSchema(db, { database = '', source = '' } = {}) {
  const tableRows = await run(db, MYSQL_TABLES_SQL);
  const columnRows = await run(db, MYSQL_COLUMNS_SQL);
  const indexRows = await run(db, MYSQL_INDEXES_SQL);
  const keyRows = await run(db, MYSQL_FOREIGN_KEYS_SQL);
  const checkRows = await run(db, MYSQL_CHECKS_SQL).catch(() => []);
  const tables = tableRows.map(t => ({
    id: `${t.schema_name}.${t.table_name}`, schema: t.schema_name, name: t.table_name,
    description: t.description || '', approxRows: Number(t.approx_rows) || 0, columns: [], indexes: [], indexNames: [], partialIndexes: [], checks: []
  }));
  const byName = new Map(tables.map(t => [t.name, t]));
  const schemaName = tables[0]?.schema || database;
  for (const c of columnRows) {
    const table = byName.get(c.table_name);
    if (!table) continue;
    const extra = String(c.extra || '').toLowerCase();
    table.columns.push({
      number: Number(c.number), name: c.name, type: mysqlType(c.column_type), nullable: c.is_nullable === 'YES',
      default: mysqlDefault(c.default_value, c.data_type), description: c.description || '', primary: false, unique: false, foreign: false,
      ...(extra.includes('auto_increment') ? { autoIncrement: true } : {}),
      ...(String(c.data_type).toLowerCase() === 'enum' ? { enum: true } : {})
    });
  }
  // STATISTICS lists one row per indexed column; PRIMARY and UNIQUE indexes are the keys.
  const indexes = new Map();
  for (const row of indexRows) {
    const key = `${row.table_name}\u0000${row.name}`;
    if (!indexes.has(key)) indexes.set(key, { table: byName.get(row.table_name), name: row.name, unique: Number(row.non_unique) === 0, columns: [] });
    indexes.get(key).columns.push(row.column_name);
  }
  for (const index of indexes.values()) {
    const { table, columns } = index;
    if (!table || !columns.length || !columns.every(Boolean)) continue; // functional (expression) indexes have no column
    // The primary key is an index too (as in PostgreSQL's pg_index), so FK coverage checks see it.
    if (index.name === 'PRIMARY') for (const name of columns) { const col = table.columns.find(c => c.name === name); if (col) col.primary = true; }
    else if (index.unique) {
      (table.uniqueKeys ||= []).push(columns);
      if (columns.length === 1) { const col = table.columns.find(c => c.name === columns[0]); if (col) col.unique = true; }
    }
    table.indexes.push(columns);
    table.indexNames.push(index.name);
  }
  for (const row of checkRows) {
    const table = byName.get(row.table_name);
    // MariaDB's json is longtext plus an implicit json_valid(col) check: show the declared type, not the trick.
    const json = /^json_valid\(`?([^`)]+)`?\)$/i.exec(String(row.definition || '').trim())?.[1];
    const jsonColumn = json && table?.columns.find(c => c.name === json && /text$/.test(c.type));
    if (jsonColumn) { jsonColumn.type = 'json'; continue; }
    // The catalog gives only the clause, so the columns are the ones it names.
    const mentions = name => new RegExp(`(^|[^\\w])\`?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?([^\\w]|$)`).test(row.definition || '');
    if (table) table.checks.push({ name: row.name, definition: row.definition || '', columns: table.columns.filter(c => mentions(c.name)).map(c => c.name) });
  }
  const relations = [], foreign = new Map();
  for (const row of keyRows) {
    if (row.target_schema !== schemaName) continue; // a key into another database cannot be drawn here
    const key = `${row.table_name}\u0000${row.name}`;
    if (!foreign.has(key)) foreign.set(key, { ...row, pairs: [] });
    foreign.get(key).pairs.push({ source: row.column_name, target: row.target_column });
  }
  for (const key of foreign.values()) {
    const from = byName.get(key.table_name), to = byName.get(key.target_table);
    if (!from || !to) continue;
    const pairs = key.pairs.filter(pair => from.columns.some(c => c.name === pair.source) && to.columns.some(c => c.name === pair.target));
    for (const pair of pairs) from.columns.find(c => c.name === pair.source).foreign = true;
    if (pairs.length) relations.push({ id: `${from.id}.${key.name}`, name: key.name, source: from.id, target: to.id, pairs,
      onDelete: RULES[key.on_delete] || 'a', onUpdate: RULES[key.on_update] || 'a', kind: 'actual' });
  }
  const result = { database: database || schemaName, source, engine: 'mysql', tables, relations, readOnly: true };
  return { ...result, fingerprint: fingerprint(result) };
}

export const MYSQL_DATABASES_SQL = `
    SELECT s.SCHEMA_NAME AS name, SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS size
    FROM information_schema.SCHEMATA s
    LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
    WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    GROUP BY s.SCHEMA_NAME
    ORDER BY s.SCHEMA_NAME`;
export async function listMysqlDatabases(db) {
  return (await run(db, MYSQL_DATABASES_SQL)).map(row => ({ name: row.name, owner: '', canConnect: true,
    size: row.size == null ? null : Number(row.size), description: '' }));
}

// The values polymorphic *_type columns hold. The column is confirmed in the catalog first (the
// client only names "<db>.<table>" and a column), read in a read-only transaction under a 3s cap,
// and sampled on very large tables. MariaDB and MySQL spell the time cap differently.
export const MYSQL_MORPH_COLUMN_SQL = `
    SELECT TABLE_NAME AS table_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) = ? AND COLUMN_NAME = ?`;
export async function readMysqlMorphTypes(pool, candidates) {
  const result = [];
  const connection = await pool.getConnection();
  try {
    const version = String((await run(connection, 'SELECT VERSION() AS version'))[0]?.version || '');
    const capped = sql => /mariadb/i.test(version) ? `SET STATEMENT max_statement_time = 3 FOR ${sql}` : sql.replace(/^SELECT /, 'SELECT /*+ MAX_EXECUTION_TIME(3000) */ ');
    for (const { tableId, column } of candidates.slice(0, 40)) {
      if (typeof tableId !== 'string' || typeof column !== 'string' || !/_type$/.test(column)) continue;
      const found = (await run(connection, MYSQL_MORPH_COLUMN_SQL, [tableId, column]))[0];
      if (!found) continue;
      const from = ident(found.table_name), col = ident(column);
      let values, partial = false;
      await connection.query('START TRANSACTION READ ONLY');
      try { values = await run(connection, capped(`SELECT DISTINCT ${col} AS value FROM ${from} WHERE ${col} IS NOT NULL LIMIT 50`)); }
      catch {
        partial = true;
        try { values = await run(connection, capped(`SELECT DISTINCT value FROM (SELECT ${col} AS value FROM ${from} WHERE ${col} IS NOT NULL LIMIT 100000) sample LIMIT 50`)); }
        catch { values = []; }
      } finally { await connection.query('COMMIT').catch(() => {}); }
      result.push({ tableId, column, values: values.map(row => row.value == null ? '' : String(row.value)).filter(Boolean), partial });
    }
  } finally { connection.release(); }
  return result;
}
