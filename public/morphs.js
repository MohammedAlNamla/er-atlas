// Polymorphic relations. A Laravel morph is two columns (<name>_type, <name>_id) and no foreign
// key, so the database alone never says what it points at. The targets come from the code
// analysis (morphMany, morphOne, morphToMany, morphedByMany) and, on a live connection, from the
// class names or morphMap aliases actually stored in the *_type column. They are drawn and
// grouped like relations but never enter the schema, the draft, exports or SQL.
import { state, activeWorkspace, saveWorkspaces } from './core.js';

export function morphCandidates(schema) {
  const found = [];
  for (const table of schema?.tables || []) {
    const names = new Set(table.columns.map(column => column.name));
    for (const column of table.columns) {
      const name = /^(.+)_type$/.exec(column.name)?.[1];
      if (name && names.has(`${name}_id`)) found.push({ tableId: table.id, name, typeColumn: column.name, idColumn: `${name}_id` });
    }
  }
  return found;
}

// Eloquent's default table for a class: snake_case, last word pluralized (Order → orders, OrderItem → order_items).
const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const plural = name => {
  const cut = name.lastIndexOf('_') + 1, head = name.slice(0, cut), word = name.slice(cut);
  const irregular = { person: 'people', child: 'children', man: 'men', woman: 'women' };
  if (irregular[word]) return head + irregular[word];
  return head + (/[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`);
};

export function resolveMorphType(value, analysis, tableByName) {
  const type = String(value || '').replace(/^\\+/, '');
  if (!type) return null;
  return analysis?.morphMap?.[type] || analysis?.modelTables?.[type] || tableByName.get(plural(snake(type.split('\\').at(-1)))) || null;
}

export function buildMorphRelations(schema, analysis = null, live = null) {
  if (!schema?.tables?.length) return [];
  const byId = new Map(schema.tables.map(table => [table.id, table]));
  const tableByName = new Map();
  for (const table of schema.tables) tableByName.set(table.name, tableByName.has(table.name) ? null : table.id);
  const links = new Map();
  const add = (source, name, target, via) => {
    if (!byId.has(source) || !byId.has(target) || !name) return;
    const key = `${source}|${name}|${target}`;
    if (!links.has(key)) links.set(key, { source, name, target, via: new Set() });
    links.get(key).via.add(via);
  };
  for (const entry of analysis?.morphs || []) for (const owner of entry.ownerTableIds || []) add(entry.tableId, entry.name, owner, 'code');
  for (const column of live?.columns || []) {
    const name = column.column.replace(/_type$/, '');
    for (const value of column.values || []) add(column.tableId, name, resolveMorphType(value, analysis, tableByName), 'data');
  }
  return [...links.values()].map(({ source, name, target, via }) => {
    const from = byId.get(source), to = byId.get(target);
    const anchor = [`${name}_id`, `${name}_type`].find(column => from.columns.some(item => item.name === column)) || from.columns[0]?.name;
    const key = to.columns.find(column => column.primary)?.name || (to.columns.some(column => column.name === 'id') ? 'id' : to.columns[0]?.name);
    return { id: `morph:${source}:${name}:${target}`, name, kind: 'morph', morph: name, source, target, via: [...via], pairs: anchor && key ? [{ source: anchor, target: key }] : [] };
  }).filter(relation => relation.pairs.length);
}

let cache = { schema: null, analysis: null, live: null, value: [] };
export function morphRelations() {
  if (!state.schema) return [];
  const workspace = activeWorkspace(), analysis = workspace?.codeAnalysis || null;
  const live = workspace?.morphTypes?.source && workspace.morphTypes.source === state.schema.source ? workspace.morphTypes : null;
  if (cache.schema !== state.schema || cache.analysis !== analysis || cache.live !== live) {
    cache = { schema: state.schema, analysis, live, value: buildMorphRelations(state.schema, analysis, live) };
  }
  return cache.value;
}

// Asks the live database which types each morph column holds. Returns true when the answer
// changed what the map can draw, so the caller re-renders once.
export async function loadMorphTypes() {
  const workspace = activeWorkspace(), schema = state.base || state.schema;
  if (!state.connectionLive || !schema?.source || !workspace) return false;
  const candidates = morphCandidates(schema).map(item => ({ tableId: item.tableId, column: item.typeColumn }));
  if (!candidates.length) return false;
  try {
    const response = await fetch('/api/morph-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: schema.source, candidates }) });
    if (!response.ok || workspace !== activeWorkspace()) return false;
    const { columns } = await response.json();
    workspace.morphTypes = { source: schema.source, columns: Array.isArray(columns) ? columns : [] };
    saveWorkspaces();
    return true;
  } catch { return false; }
}
