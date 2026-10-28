// Shared vocabulary of the review checks: table sizes, framework tables, severity steps, key
// coverage and the finding record. The thresholds are the playbooks' own.
import { checkById } from '../catalog.js';
import { normalizeType } from '../../public/lint.js';

// Size classes from the playbooks. approxRows of 0 is "unknown or empty": statistics may not be collected.
export const SMALL = 10000, LARGE = 100000, HUGE = 10000000;
export function sizeOf(table) {
  const rows = Number(table?.approxRows);
  if (!Number.isFinite(rows) || rows <= 0) return { rows: null, known: false, small: false, large: false, huge: false };
  return { rows, known: true, small: rows < SMALL, large: rows >= LARGE, huge: rows >= HUGE };
}

// Laravel and common package tables: designed the way they are, and not the project's to change.
const FRAMEWORK = /^(migrations|jobs|job_batches|failed_jobs|sessions|cache|cache_locks|password_reset_tokens|password_resets|personal_access_tokens|notifications|telescope_.*|pulse_.*|oauth_.*|permissions|roles|model_has_.*|role_has_permissions|activity_log|media)$/;
export const isFrameworkTable = table => FRAMEWORK.test(table?.name || '');
// Index checks only judge tables whose indexes were read: a saved or imported schema may carry none,
// and "no index" would then be a claim about the reader, not the database (as lint's fk-without-index).
export const indexesRead = table => Array.isArray(table?.indexes);

const STEPS = ['error', 'warning', 'info'];
// Moves a severity up (-1) or down (+1) a step, never past error or info.
export const shift = (severity, by) => STEPS[Math.max(0, Math.min(2, STEPS.indexOf(severity) + by))];

// What every check gets: the schema as it would be after the draft, the base as read, code facts,
// statistics, the draft operations, and shared lookups.
export function reviewContext({ schema, base = schema, code = null, stats = null, operations = [] }) {
  const tables = schema.tables || [], relations = schema.relations || [];
  const byId = new Map(tables.map(table => [table.id, table]));
  const byName = new Map();
  for (const table of tables) byName.set(table.name, byName.has(table.name) ? null : table);
  const newTables = new Set(operations.filter(op => op?.type === 'addTable').map(op => op.id));
  const engine = schema.engine === 'mysql' || base?.engine === 'mysql' ? 'mysql' : 'postgres';
  return { schema, base, code, facts: code?.facts || null, stats, operations, tables, relations, byId, byName, newTables, engine,
    column: (table, name) => table?.columns.find(column => column.name === name) || null,
    type: column => normalizeType(column?.type),
    // Keys that can serve a lookup on these columns: plain indexes, the primary key in column order,
    // unique keys and single unique columns (the same candidates as lint's fk-without-index).
    keysOf: table => [
      ...(table.indexes || []),
      table.columns.filter(column => column.primary).sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(column => column.name),
      ...(table.uniqueKeys || []),
      ...table.columns.filter(column => column.unique).map(column => [column.name])
    ].filter(key => key?.length) };
}

// A prefix of some key covers these columns, in any order within the prefix.
export function covered(keys, columns) {
  const wanted = new Set(columns);
  return keys.some(key => key.length >= wanted.size && key.slice(0, wanted.size).every(name => wanted.has(name)));
}

export function makeFinding(checkId, table, { column = null, key = '', severity, confidence = 'high', title, detail, evidence = [], fix } = {}) {
  const check = checkById.get(checkId);
  if (!check) throw new Error(`unknown check ${checkId}`);
  return { id: `${checkId}:${table?.id ?? '-'}:${column ?? ''}${key ? `:${key}` : ''}`, check: checkId, skill: check.skill,
    severity: severity || check.severity, confidence, tableId: table?.id ?? null, ...(column ? { columnName: column } : {}),
    title: title || check.title, detail: detail || '', evidence, source: 'engine', ...(fix ? { fix } : {}) };
}

