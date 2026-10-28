import { createHash } from 'node:crypto';
import { planStatements } from './public/dialect.js';

// The SQL lives in public/dialect.js so the browser previews exactly what the server plans.
export function fingerprint(schema) {
  const data = {
    tables: schema.tables.map(t => [t.id, t.schema, t.name, t.columns.map(c => [c.name, c.type, c.nullable, c.default, c.primary, c.unique])]),
    relations: schema.relations.map(r => [r.id, r.name, r.source, r.target, r.pairs])
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function planChanges(base, operations) {
  const statements = planStatements(base, operations);
  return { statements, sql: statements.join('\n'), count: operations.length, baseFingerprint: fingerprint(base) };
}
