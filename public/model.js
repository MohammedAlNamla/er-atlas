export const clone = value => structuredClone(value);

function tableById(schema, id) {
  const table = schema.tables.find(item => item.id === id);
  if (!table) throw new Error('الجدول لم يعد موجودًا');
  return table;
}

function columnByName(table, name) {
  const column = table.columns.find(item => item.name === name);
  if (!column) throw new Error('العمود لم يعد موجودًا');
  return column;
}

function validName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) throw new Error('استخدم أحرفًا إنجليزية وأرقامًا وشرطة سفلية في الاسم');
}

function refreshForeignFlags(schema) {
  for (const table of schema.tables) for (const column of table.columns) column.foreign = false;
  for (const relation of schema.relations) {
    const table = schema.tables.find(item => item.id === relation.source);
    for (const pair of relation.pairs) {
      const column = table?.columns.find(item => item.name === pair.source);
      if (column) column.foreign = true;
    }
  }
}

export function applyOperation(schema, operation) {
  const next = clone(schema);
  switch (operation.type) {
    case 'addTable': {
      validName(operation.name); validName(operation.schema);
      if (next.tables.some(table => table.schema === operation.schema && table.name === operation.name)) throw new Error('اسم الجدول مستخدم');
      next.tables.push({ id: operation.id, schema: operation.schema, name: operation.name, description: '', approxRows: 0, columns: [], kind: 'proposed' });
      break;
    }
    case 'renameTable': {
      validName(operation.name);
      const table = tableById(next, operation.tableId);
      if (next.tables.some(item => item.id !== table.id && item.schema === table.schema && item.name === operation.name)) throw new Error('اسم الجدول مستخدم');
      table.name = operation.name;
      break;
    }
    case 'addColumn': {
      const table = tableById(next, operation.tableId);
      validName(operation.column.name);
      if (table.columns.some(column => column.name === operation.column.name)) throw new Error('اسم العمود مستخدم');
      table.columns.push({ number: Math.max(0, ...table.columns.map(column => column.number || 0)) + 1,
        name: operation.column.name, type: operation.column.type, nullable: operation.column.primary ? false : operation.column.nullable,
        default: operation.column.default || null, description: '', primary: Boolean(operation.column.primary), unique: false, foreign: false, kind: 'proposed' });
      break;
    }
    case 'updateColumn': {
      const table = tableById(next, operation.tableId);
      const column = columnByName(table, operation.columnName);
      if (operation.patch.name && operation.patch.name !== column.name) {
        validName(operation.patch.name);
        if (table.columns.some(item => item !== column && item.name === operation.patch.name)) throw new Error('اسم العمود مستخدم');
        for (const relation of next.relations) {
          for (const pair of relation.pairs) {
            if (relation.source === table.id && pair.source === column.name) pair.source = operation.patch.name;
            if (relation.target === table.id && pair.target === column.name) pair.target = operation.patch.name;
          }
        }
      }
      Object.assign(column, operation.patch);
      break;
    }
    case 'dropColumn': {
      const table = tableById(next, operation.tableId);
      columnByName(table, operation.columnName);
      table.columns = table.columns.filter(column => column.name !== operation.columnName);
      next.relations = next.relations.filter(relation => !relation.pairs.some(pair =>
        (relation.source === table.id && pair.source === operation.columnName) ||
        (relation.target === table.id && pair.target === operation.columnName)));
      break;
    }
    case 'addRelation': {
      const relation = operation.relation;
      const source = tableById(next, relation.source);
      const target = tableById(next, relation.target);
      if (!relation.pairs?.length) throw new Error('اختر الأعمدة المرتبطة');
      for (const pair of relation.pairs) { columnByName(source, pair.source); columnByName(target, pair.target); }
      if (next.relations.some(item => item.source === relation.source && item.target === relation.target &&
        JSON.stringify(item.pairs) === JSON.stringify(relation.pairs))) throw new Error('هذه العلاقة موجودة');
      next.relations.push({ ...clone(relation), kind: 'proposed' });
      break;
    }
    case 'dropRelation': {
      if (!next.relations.some(item => item.id === operation.relationId)) throw new Error('العلاقة لم تعد موجودة');
      next.relations = next.relations.filter(item => item.id !== operation.relationId);
      break;
    }
    case 'dropTable': {
      tableById(next, operation.tableId);
      next.tables = next.tables.filter(table => table.id !== operation.tableId);
      next.relations = next.relations.filter(relation => relation.source !== operation.tableId && relation.target !== operation.tableId);
      break;
    }
    default: throw new Error('نوع تغيير غير معروف');
  }
  refreshForeignFlags(next);
  return next;
}

export function replay(base, operations) {
  return operations.reduce((schema, operation) => applyOperation(schema, operation), clone(base));
}

export function describeOperation(operation, schema) {
  const name = id => schema.tables.find(table => table.id === id)?.name || 'جدول';
  switch (operation.type) {
    case 'addTable': return `إضافة جدول ${operation.name}`;
    case 'renameTable': return `تسمية جدول ${name(operation.tableId)} إلى ${operation.name}`;
    case 'addColumn': return `إضافة ${operation.column.name} إلى ${name(operation.tableId)}`;
    case 'updateColumn': return `تعديل ${name(operation.tableId)}.${operation.columnName}`;
    case 'dropColumn': return `حذف ${name(operation.tableId)}.${operation.columnName}`;
    case 'addRelation': return `ربط ${name(operation.relation.source)} مع ${name(operation.relation.target)}`;
    case 'dropRelation': {
      const relation = schema.relations.find(item => item.id === operation.relationId);
      return relation ? `حذف علاقة ${name(relation.source)}.${relation.pairs.map(pair => pair.source).join(', ')} → ${name(relation.target)}` : 'حذف علاقة';
    }
    case 'dropTable': return `حذف جدول ${name(operation.tableId)}`;
    default: return 'تغيير';
  }
}
