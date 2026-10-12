// Portable workspace files (.eratlas.json): schema, topics, table positions and
// the draft. Machine-specific data (source path, code analysis, connection) is left out.
export const FORMAT = 'eratlas.workspace';
export const VERSION = 1;
const LIMITS = { tables: 3000, columns: 1500, relations: 8000, operations: 200, bytes: 30000000 };

const text = (value, label, max = 300) => {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`ملف غير صالح: ${label}`);
  return value;
};

export function validateSchema(schema) {
  if (!schema || !Array.isArray(schema.tables) || !Array.isArray(schema.relations)) throw new Error('ملف غير صالح: المخطط ناقص');
  if (schema.tables.length > LIMITS.tables || schema.relations.length > LIMITS.relations) throw new Error('المخطط كبير جدًا للاستيراد');
  const ids = new Set();
  const tables = schema.tables.map(table => {
    const id = text(table?.id, 'معرّف الجدول');
    if (ids.has(id)) throw new Error('ملف غير صالح: معرّف جدول مكرر');
    ids.add(id);
    if (!Array.isArray(table.columns) || table.columns.length > LIMITS.columns) throw new Error('ملف غير صالح: أعمدة الجدول');
    return {
      id, schema: text(table.schema ?? 'public', 'schema', 100), name: text(table.name, 'اسم الجدول', 200),
      description: typeof table.description === 'string' ? table.description.slice(0, 1000) : '',
      approxRows: Number.isFinite(table.approxRows) ? table.approxRows : 0,
      ...(table.kind === 'proposed' ? { kind: 'proposed' } : {}),
      ...(Array.isArray(table.uniqueKeys) ? { uniqueKeys: table.uniqueKeys.filter(key => Array.isArray(key) && key.every(name => typeof name === 'string')) } : {}),
      columns: table.columns.map((column, index) => ({
        number: Number.isInteger(column?.number) ? column.number : index + 1,
        name: text(column?.name, 'اسم العمود', 200), type: text(column?.type, 'نوع العمود', 120),
        nullable: column.nullable !== false, default: typeof column.default === 'string' ? column.default.slice(0, 500) : null,
        description: typeof column.description === 'string' ? column.description.slice(0, 1000) : '',
        primary: column.primary === true, unique: column.unique === true, foreign: column.foreign === true,
        ...(column.kind === 'proposed' ? { kind: 'proposed' } : {})
      }))
    };
  });
  const relations = schema.relations.map(relation => {
    const id = text(relation?.id, 'معرّف العلاقة');
    if (!ids.has(relation.source) || !ids.has(relation.target)) throw new Error('ملف غير صالح: علاقة تشير إلى جدول غير موجود');
    if (!Array.isArray(relation.pairs) || !relation.pairs.length || relation.pairs.some(pair => typeof pair?.source !== 'string' || typeof pair?.target !== 'string')) throw new Error('ملف غير صالح: أعمدة العلاقة');
    return { id, name: text(relation.name ?? id, 'اسم العلاقة'), source: relation.source, target: relation.target,
      pairs: relation.pairs.map(pair => ({ source: pair.source, target: pair.target })),
      onDelete: typeof relation.onDelete === 'string' ? relation.onDelete.slice(0, 1) : 'a',
      ...(typeof relation.onUpdate === 'string' ? { onUpdate: relation.onUpdate.slice(0, 1) } : {}),
      kind: relation.kind === 'proposed' ? 'proposed' : 'actual' };
  });
  return { database: typeof schema.database === 'string' ? schema.database.slice(0, 200) : 'مخطط مستورد', tables, relations, readOnly: true,
    ...(typeof schema.fingerprint === 'string' ? { fingerprint: schema.fingerprint } : {}) };
}

export function buildExport({ name, kind, schema, topics = [], positions = {}, operations = [], cursor = 0 }) {
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), name, kind, schema, topics, positions, operations, cursor };
}

export function parseExport(source) {
  if (source.length > LIMITS.bytes) throw new Error('الملف كبير جدًا');
  let data;
  try { data = JSON.parse(source); } catch { throw new Error('الملف ليس JSON صالحًا'); }
  if (data?.format !== FORMAT) throw new Error('هذا ليس ملف مساحة عمل من ER Atlas');
  if (data.version > VERSION) throw new Error('الملف من إصدار أحدث من التطبيق. حدّث ER Atlas أولًا.');
  const schema = validateSchema(data.schema);
  const operations = Array.isArray(data.operations) ? data.operations.filter(item => item && typeof item.type === 'string').slice(0, LIMITS.operations) : [];
  const positions = {};
  for (const [id, point] of Object.entries(data.positions && typeof data.positions === 'object' ? data.positions : {})) {
    if (schema.tables.some(table => table.id === id) && Number.isFinite(point?.x) && Number.isFinite(point?.y)) positions[id] = { x: point.x, y: point.y };
  }
  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 80) : schema.database,
    kind: ['database', 'ideas', 'demo'].includes(data.kind) ? data.kind : 'ideas',
    schema, topics: Array.isArray(data.topics) ? data.topics : [], positions, operations,
    cursor: Math.max(0, Math.min(operations.length, Number(data.cursor) || 0))
  };
}

// Replays what still applies after the database changed; reports what no longer does.
export function recoverOperations(base, operations, apply) {
  let schema = structuredClone(base);
  const kept = []; let skipped = 0;
  for (const operation of operations) {
    try { schema = apply(schema, operation); kept.push(operation); } catch { skipped++; }
  }
  return { kept, skipped };
}
