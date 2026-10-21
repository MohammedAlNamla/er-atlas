import test from 'node:test';
import assert from 'node:assert/strict';
import { readSchema, listDatabases, DATABASES_SQL } from '../pg-schema.js';

// A fake client answers each catalog query by the table it reads.
const fakeClient = answers => ({ query: async sql => ({ rows: answers.find(([pattern]) => pattern.test(sql))?.[1] || [] }) });
const catalog = fakeClient([
  [/pg_index i/, [
    { table_id: '2', key_columns: [2], key_count: 1 },          // plain index on orders.user_id
    { table_id: '2', key_columns: [2, 3], key_count: 1 },       // INCLUDE (total) is not a key column
    { table_id: '1', key_columns: [1], key_count: 1 },          // the primary key's own index
    { table_id: '2', key_columns: [9], key_count: 1 }           // a column we did not read is skipped
  ]],
  [/pg_constraint con/, [
    { id: '10', name: 'users_pkey', type: 'p', source_table: '1', source_columns: [1] },
    { id: '11', name: 'orders_pkey', type: 'p', source_table: '2', source_columns: [1] },
    { id: '12', name: 'orders_user_id_foreign', type: 'f', source_table: '2', target_table: '1', source_columns: [2], target_columns: [1], on_delete: 'c', on_update: 'a' }
  ]],
  [/pg_attribute a/, [
    { table_id: '1', number: 1, name: 'id', data_type: 'bigint', nullable: false, default_value: null, description: null },
    { table_id: '2', number: 1, name: 'id', data_type: 'bigint', nullable: false, default_value: null, description: null },
    { table_id: '2', number: 2, name: 'user_id', data_type: 'bigint', nullable: true, default_value: null, description: 'المالك' },
    { table_id: '2', number: 3, name: 'total', data_type: 'numeric(12,2)', nullable: false, default_value: '0', description: null }
  ]],
  [/pg_class c\s+JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\s+LEFT JOIN pg_catalog.pg_stat_user_tables/, [
    { id: '1', schema_name: 'public', table_name: 'users', description: null, approx_rows: '12' },
    { id: '2', schema_name: 'public', table_name: 'orders', description: 'الطلبات', approx_rows: '40' }
  ]]
]);

test('readSchema maps tables, keys, relations and plain indexes', async () => {
  const schema = await readSchema(catalog, { database: 'shop', source: 'localhost:5432/shop' });
  assert.equal(schema.database, 'shop');
  assert.equal(schema.source, 'localhost:5432/shop');
  assert.match(schema.fingerprint, /^[a-f0-9]{64}$/);
  const orders = schema.tables.find(table => table.name === 'orders');
  assert.deepEqual(orders.indexes, [['user_id'], ['user_id']]);
  assert.deepEqual(schema.tables.find(table => table.name === 'users').indexes, [['id']]);
  assert.equal(orders.columns.find(column => column.name === 'user_id').foreign, true);
  assert.equal(orders.columns.find(column => column.name === 'id').primary, true);
  assert.deepEqual(schema.relations.map(relation => [relation.name, relation.onDelete, relation.pairs]), [['orders_user_id_foreign', 'c', [{ source: 'user_id', target: 'id' }]]]);
  assert.equal(orders.approxRows, 40);
});

test('listDatabases reads names, owners, sizes and connect rights', async () => {
  let seen = '';
  const client = { query: async sql => { seen = sql; return { rows: [
    { name: 'shop', owner: 'app', can_connect: true, size: '8421376', description: null },
    { name: 'archive', owner: 'postgres', can_connect: false, size: null, description: 'old data' }
  ] }; } };
  const databases = await listDatabases(client);
  assert.equal(seen, DATABASES_SQL);
  assert.match(DATABASES_SQL, /NOT d\.datistemplate/);
  assert.deepEqual(databases, [
    { name: 'shop', owner: 'app', canConnect: true, size: 8421376, description: '' },
    { name: 'archive', owner: 'postgres', canConnect: false, size: null, description: 'old data' }
  ]);
});
