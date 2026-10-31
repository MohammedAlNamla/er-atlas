// PostgreSQL catalog readers: the schema of one database, and the databases a login can open.
// They take any client with query(), so tests can hand them a fake one.
import { fingerprint } from './planner.js';

export async function readSchema(db, { database = '', source = '' } = {}) {
  const tablesSql = `
    SELECT c.oid::text AS id, n.nspname AS schema_name, c.relname AS table_name,
           obj_description(c.oid, 'pg_class') AS description,
           COALESCE(s.n_live_tup, 0)::text AS approx_rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY n.nspname, c.relname`;
  const columnsSql = `
    SELECT a.attrelid::text AS table_id, a.attnum AS number, a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
           col_description(a.attrelid, a.attnum) AS description,
           t.typtype = 'e' AS is_enum
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY a.attrelid, a.attnum`;
  const constraintsSql = `
    SELECT con.oid::text AS id, con.conname AS name, con.contype AS type,
           con.conrelid::text AS source_table, con.confrelid::text AS target_table,
           con.conkey AS source_columns, con.confkey AS target_columns,
           con.confdeltype AS on_delete, con.confupdtype AS on_update,
           CASE WHEN con.contype = 'c' THEN pg_catalog.pg_get_constraintdef(con.oid) END AS definition
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype IN ('p','f','u','c') AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY con.oid`;
  const indexesSql = `
    SELECT i.indrelid::text AS table_id, i.indkey::int2[] AS key_columns, i.indnkeyatts AS key_count,
           ic.relname AS name, i.indexprs IS NOT NULL AS has_expressions, pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY i.indexrelid`;
  const tableResult = await db.query(tablesSql);
  const columnResult = await db.query(columnsSql);
  const constraintResult = await db.query(constraintsSql);
  const indexResult = await db.query(indexesSql);
  const tables = tableResult.rows.map(t => ({
    id: t.id, schema: t.schema_name, name: t.table_name,
    description: t.description || '', approxRows: Number(t.approx_rows), columns: [], indexes: [], indexNames: [], partialIndexes: [], checks: []
  }));
  const byId = new Map(tables.map(t => [t.id, t]));
  for (const c of columnResult.rows) {
    byId.get(c.table_id)?.columns.push({
      number: c.number, name: c.name, type: c.data_type, nullable: c.nullable,
      default: c.default_value, description: c.description || '', primary: false, unique: false, foreign: false,
      ...(c.is_enum === true ? { enum: true } : {})
    });
  }
  for (const con of constraintResult.rows) {
    if (!['p', 'u', 'c'].includes(con.type)) continue;
    const table = byId.get(con.source_table);
    if (!table) continue;
    const names = (con.source_columns || []).map(number => table.columns.find(c => c.number === Number(number))?.name).filter(Boolean);
    if (con.type === 'c') { table.checks.push({ name: con.name, definition: con.definition || '', columns: names }); continue; }
    if (con.type === 'u' && names.length) (table.uniqueKeys ||= []).push(names);
    // A column flag is only truthful for single-column keys; composite keys live in uniqueKeys.
    for (const name of names) {
      const col = table.columns.find(c => c.name === name);
      if (col && con.type === 'p') col.primary = true;
      if (col && con.type === 'u' && names.length === 1) col.unique = true;
    }
  }
  // Plain indexes stay arrays of column names (indexNames runs parallel); partial ones are kept
  // apart with their predicate; expression indexes are skipped.
  for (const index of indexResult.rows) {
    const table = byId.get(index.table_id);
    const keys = (index.key_columns || []).slice(0, Number(index.key_count) || undefined);
    const names = keys.map(number => table?.columns.find(c => c.number === Number(number))?.name);
    if (!table || !names.length || !names.every(Boolean) || index.has_expressions === true) continue;
    if (index.predicate) { table.partialIndexes.push({ name: index.name || '', columns: names, predicate: index.predicate }); continue; }
    table.indexes.push(names);
    table.indexNames.push(index.name || '');
  }
  const relations = [];
  for (const con of constraintResult.rows) {
    if (con.type !== 'f' || !byId.has(con.source_table) || !byId.has(con.target_table)) continue;
    const from = byId.get(con.source_table);
    const to = byId.get(con.target_table);
    const pairs = (con.source_columns || []).map((number, index) => {
      const source = from.columns.find(c => c.number === number);
      const target = to.columns.find(c => c.number === con.target_columns?.[index]);
      if (source) source.foreign = true;
      return source && target ? { source: source.name, target: target.name } : null;
    }).filter(Boolean);
    if (pairs.length) relations.push({ id: con.id, name: con.name, source: from.id, target: to.id, pairs, onDelete: con.on_delete, onUpdate: con.on_update, kind: 'actual' });
  }
  const result = { database, source, tables, relations, readOnly: true };
  return { ...result, fingerprint: fingerprint(result) };
}

export const DATABASES_SQL = `
    SELECT d.datname AS name, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
           pg_catalog.has_database_privilege(d.datname, 'CONNECT') AS can_connect,
           CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT') THEN pg_catalog.pg_database_size(d.datname) END AS size,
           pg_catalog.shobj_description(d.oid, 'pg_database') AS description
    FROM pg_catalog.pg_database d
    WHERE d.datallowconn AND NOT d.datistemplate
    ORDER BY d.datname`;
export async function listDatabases(db) {
  const { rows } = await db.query(DATABASES_SQL);
  return rows.map(row => ({ name: row.name, owner: row.owner || '', canConnect: row.can_connect !== false,
    size: row.size == null ? null : Number(row.size), description: row.description || '' }));
}

// Live, read-only usage statistics for the review engine. Counters are cumulative since the last
// statistics reset; pg_stats only shows columns the role may read.
export const STATS_TABLES_SQL = `
    SELECT s.relid::text AS table_id, s.seq_scan, s.seq_tup_read, s.idx_scan, s.n_live_tup, s.n_dead_tup,
           s.n_tup_ins, s.n_tup_upd, s.n_tup_del, COALESCE(s.last_analyze, s.last_autoanalyze) AS last_analyze
    FROM pg_catalog.pg_stat_user_tables s
    ORDER BY s.relid`;
export const STATS_INDEXES_SQL = `
    SELECT s.relid::text AS table_id, s.indexrelname AS name, s.idx_scan AS scans,
           pg_catalog.pg_relation_size(s.indexrelid) AS size_bytes, i.indisunique AS is_unique, i.indisprimary AS is_primary,
           (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL) AS is_partial,
           EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype = 'x') AS is_exclusion,
           ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                 WHERE k.ord <= i.indnkeyatts ORDER BY k.ord)::text[] AS columns
    FROM pg_catalog.pg_stat_user_indexes s
    JOIN pg_catalog.pg_index i ON i.indexrelid = s.indexrelid
    ORDER BY s.relid, s.indexrelname`;
export const STATS_NULLS_SQL = `
    SELECT c.oid::text AS table_id, s.attname::text AS column_name, s.null_frac
    FROM pg_catalog.pg_stats s
    JOIN pg_catalog.pg_namespace n ON n.nspname = s.schemaname
    JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = s.tablename
    WHERE NOT s.inherited AND s.schemaname NOT IN ('pg_catalog','information_schema') AND s.schemaname NOT LIKE 'pg_toast%'`;
export const STATS_RESET_SQL = `
    SELECT stats_reset FROM pg_catalog.pg_stat_database WHERE datname = pg_catalog.current_database()`;
const count = value => value == null ? null : Number(value);
const when = value => value == null ? null : new Date(value).toISOString();
export async function readStats(db) {
  const tableResult = await db.query(STATS_TABLES_SQL);
  const indexResult = await db.query(STATS_INDEXES_SQL);
  const nullResult = await db.query(STATS_NULLS_SQL);
  const resetResult = await db.query(STATS_RESET_SQL);
  const tables = {}, nullFraction = {};
  for (const row of tableResult.rows) tables[row.table_id] = { seqScan: count(row.seq_scan), seqTupRead: count(row.seq_tup_read), idxScan: count(row.idx_scan),
    liveRows: count(row.n_live_tup), deadRows: count(row.n_dead_tup), inserts: count(row.n_tup_ins), updates: count(row.n_tup_upd), deletes: count(row.n_tup_del), lastAnalyze: when(row.last_analyze) };
  const indexes = indexResult.rows.map(row => ({ tableId: row.table_id, name: row.name, columns: Array.isArray(row.columns) ? row.columns : [],
    scans: count(row.scans), sizeBytes: count(row.size_bytes), unique: row.is_unique === true, primary: row.is_primary === true,
    partial: row.is_partial === true, exclusion: row.is_exclusion === true }));
  for (const row of nullResult.rows) (nullFraction[row.table_id] ||= {})[row.column_name] = Number(row.null_frac);
  const reset = resetResult.rows[0]?.stats_reset;
  return { tables, indexes, nullFraction, ...(reset ? { resetAt: when(reset) } : {}) };
}

// What polymorphic *_type columns actually hold. Each column is checked against the catalog
// first (the client only names a table id and a column), read inside a read-only transaction
// with a short timeout, and falls back to a bounded sample on very large tables.
export const MORPH_COLUMN_SQL = `
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.oid::text = $1 AND c.relkind IN ('r', 'p', 'v', 'm')`;
const ident = value => `"${String(value).replaceAll('"', '""')}"`;
export async function readMorphTypes(pool, candidates) {
  const result = [];
  const client = await pool.connect();
  try {
    for (const { tableId, column } of candidates.slice(0, 40)) {
      if (typeof tableId !== 'string' || typeof column !== 'string' || !/_type$/.test(column)) continue;
      const found = (await client.query(MORPH_COLUMN_SQL, [tableId, column])).rows[0];
      if (!found) continue;
      const from = `${ident(found.schema_name)}.${ident(found.table_name)}`, col = ident(column);
      let values, partial = false;
      try {
        await client.query('BEGIN READ ONLY'); await client.query("SET LOCAL statement_timeout = '3s'");
        values = (await client.query(`SELECT DISTINCT ${col}::text AS value FROM ${from} WHERE ${col} IS NOT NULL LIMIT 50`)).rows;
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => {});
        partial = true;
        await client.query('BEGIN READ ONLY'); await client.query("SET LOCAL statement_timeout = '3s'");
        try { values = (await client.query(`SELECT DISTINCT value FROM (SELECT ${col}::text AS value FROM ${from} WHERE ${col} IS NOT NULL LIMIT 100000) sample LIMIT 50`)).rows; }
        catch { values = []; }
        finally { await client.query('COMMIT').catch(() => client.query('ROLLBACK').catch(() => {})); }
      }
      result.push({ tableId, column, values: values.map(row => row.value).filter(Boolean), partial });
    }
  } finally { client.release(); }
  return result;
}
