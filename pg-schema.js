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
           col_description(a.attrelid, a.attnum) AS description
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY a.attrelid, a.attnum`;
  const constraintsSql = `
    SELECT con.oid::text AS id, con.conname AS name, con.contype AS type,
           con.conrelid::text AS source_table, con.confrelid::text AS target_table,
           con.conkey AS source_columns, con.confkey AS target_columns,
           con.confdeltype AS on_delete, con.confupdtype AS on_update
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype IN ('p','f','u') AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY con.oid`;
  const indexesSql = `
    SELECT i.indrelid::text AS table_id, i.indkey::int2[] AS key_columns, i.indnkeyatts AS key_count
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE i.indexprs IS NULL AND i.indpred IS NULL AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY i.indexrelid`;
  const tableResult = await db.query(tablesSql);
  const columnResult = await db.query(columnsSql);
  const constraintResult = await db.query(constraintsSql);
  const indexResult = await db.query(indexesSql);
  const tables = tableResult.rows.map(t => ({
    id: t.id, schema: t.schema_name, name: t.table_name,
    description: t.description || '', approxRows: Number(t.approx_rows), columns: [], indexes: []
  }));
  const byId = new Map(tables.map(t => [t.id, t]));
  for (const c of columnResult.rows) {
    byId.get(c.table_id)?.columns.push({
      number: c.number, name: c.name, type: c.data_type, nullable: c.nullable,
      default: c.default_value, description: c.description || '', primary: false, unique: false, foreign: false
    });
  }
  for (const con of constraintResult.rows) {
    if (con.type !== 'p' && con.type !== 'u') continue;
    const table = byId.get(con.source_table);
    if (!table) continue;
    const names = (con.source_columns || []).map(number => table.columns.find(c => c.number === number)?.name).filter(Boolean);
    if (con.type === 'u' && names.length) (table.uniqueKeys ||= []).push(names);
    // A column flag is only truthful for single-column keys; composite keys live in uniqueKeys.
    for (const name of names) {
      const col = table.columns.find(c => c.name === name);
      if (col && con.type === 'p') col.primary = true;
      if (col && con.type === 'u' && names.length === 1) col.unique = true;
    }
  }
  for (const index of indexResult.rows) {
    const table = byId.get(index.table_id);
    const keys = (index.key_columns || []).slice(0, Number(index.key_count) || undefined);
    const names = keys.map(number => table?.columns.find(c => c.number === Number(number))?.name);
    if (table && names.length && names.every(Boolean)) table.indexes.push(names);
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
