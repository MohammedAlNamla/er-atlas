import test from 'node:test';
import assert from 'node:assert/strict';
import { readMysqlSchema, listMysqlDatabases, readMysqlMorphTypes, mysqlType, mysqlDefault,
  MYSQL_TABLES_SQL, MYSQL_COLUMNS_SQL, MYSQL_INDEXES_SQL, MYSQL_FOREIGN_KEYS_SQL, MYSQL_CHECKS_SQL, MYSQL_DATABASES_SQL, MYSQL_MORPH_COLUMN_SQL } from '../mysql-schema.js';

// Rows as MariaDB 11 returns them for test/fixtures/mysql-fixture.sql (trimmed to what matters).
const col = (table, number, name, column_type, data_type, extra = {}) => ({ table_name: table, number, name, column_type, data_type, is_nullable: 'NO', default_value: null, extra: '', description: '', ...extra });
const catalog = {
  [MYSQL_TABLES_SQL]: [
    { schema_name: 'shop', table_name: 'users', description: 'People who sign in', approx_rows: '1' },
    { schema_name: 'shop', table_name: 'orders', description: '', approx_rows: '1' },
    { schema_name: 'shop', table_name: 'order_items', description: '', approx_rows: '0' }
  ],
  [MYSQL_COLUMNS_SQL]: [
    col('users', 1, 'id', 'bigint(20) unsigned', 'bigint', { extra: 'auto_increment' }),
    col('users', 2, 'email', 'varchar(255)', 'varchar'),
    col('users', 3, 'is_admin', 'tinyint(1)', 'tinyint', { default_value: '0' }),
    col('users', 4, 'status', "enum('active','blocked')", 'enum', { default_value: "'active'", description: 'Account state' }),
    col('users', 5, 'nickname', 'varchar(32)', 'varchar', { is_nullable: 'YES', default_value: 'NULL' }),
    col('orders', 1, 'id', 'bigint(20) unsigned', 'bigint', { extra: 'auto_increment' }),
    col('orders', 2, 'user_id', 'bigint(20) unsigned', 'bigint'),
    col('orders', 3, 'meta', 'longtext', 'longtext', { is_nullable: 'YES' }),
    col('orders', 4, 'total', 'decimal(12,2)', 'decimal', { default_value: '0.00' }),
    col('order_items', 1, 'order_id', 'bigint(20) unsigned', 'bigint'),
    col('order_items', 2, 'line', 'int(11)', 'int')
  ],
  [MYSQL_INDEXES_SQL]: [
    { table_name: 'users', name: 'PRIMARY', non_unique: 0, seq: 1, column_name: 'id' },
    { table_name: 'users', name: 'users_email_unique', non_unique: 0, seq: 1, column_name: 'email' },
    { table_name: 'orders', name: 'PRIMARY', non_unique: 0, seq: 1, column_name: 'id' },
    { table_name: 'orders', name: 'orders_user_id_index', non_unique: 1, seq: 1, column_name: 'user_id' },
    { table_name: 'orders', name: 'orders_expr', non_unique: 1, seq: 1, column_name: null },
    { table_name: 'order_items', name: 'PRIMARY', non_unique: 0, seq: 1, column_name: 'order_id' },
    { table_name: 'order_items', name: 'PRIMARY', non_unique: 0, seq: 2, column_name: 'line' }
  ],
  [MYSQL_FOREIGN_KEYS_SQL]: [
    { name: 'orders_user_id_foreign', table_name: 'orders', column_name: 'user_id', target_schema: 'shop', target_table: 'users', target_column: 'id', on_delete: 'CASCADE', on_update: 'RESTRICT' },
    { name: 'order_items_order_id_foreign', table_name: 'order_items', column_name: 'order_id', target_schema: 'shop', target_table: 'orders', target_column: 'id', on_delete: 'SET NULL', on_update: 'NO ACTION' },
    { name: 'elsewhere', table_name: 'orders', column_name: 'user_id', target_schema: 'other_db', target_table: 'users', target_column: 'id', on_delete: 'CASCADE', on_update: 'CASCADE' }
  ],
  [MYSQL_CHECKS_SQL]: [
    { table_name: 'orders', name: 'meta', definition: 'json_valid(`meta`)' },
    { table_name: 'orders', name: 'orders_total_positive', definition: '`total` >= 0' }
  ]
};
const fake = { query: async sql => [catalog[sql] ?? []] };

test('MySQL schema reads into the same shape as PostgreSQL, with database-qualified ids', async () => {
  const schema = await readMysqlSchema(fake, { database: 'shop', source: 'mysql://localhost:3306/shop' });
  assert.equal(schema.engine, 'mysql');
  assert.deepEqual(schema.tables.map(table => table.id), ['shop.users', 'shop.orders', 'shop.order_items']);
  const users = schema.tables[0];
  assert.equal(users.description, 'People who sign in');
  assert.deepEqual(users.columns.map(c => c.type), ['bigint unsigned', 'varchar(255)', 'tinyint(1)', "enum('active','blocked')", 'varchar(32)']);
  assert.ok(users.columns[0].primary && users.columns[0].autoIncrement);
  assert.ok(users.columns[1].unique);
  assert.equal(users.columns[3].default, "'active'");
  assert.ok(users.columns[3].enum);
  assert.equal(users.columns[4].default, null, "MariaDB's NULL keyword is no default");
  const orders = schema.tables[1];
  assert.equal(orders.columns.find(c => c.name === 'meta').type, 'json', 'longtext + json_valid() is shown as json');
  assert.deepEqual(orders.checks, [{ name: 'orders_total_positive', definition: '`total` >= 0', columns: ['total'] }]);
  assert.deepEqual(orders.indexes, [['id'], ['user_id']], 'the primary key counts as an index; expression indexes are skipped');
  assert.deepEqual(schema.tables[2].indexes, [['order_id', 'line']]);
  assert.deepEqual(schema.relations.map(r => [r.id, r.source, r.target, r.onDelete, r.onUpdate]), [
    ['shop.orders.orders_user_id_foreign', 'shop.orders', 'shop.users', 'c', 'r'],
    ['shop.order_items.order_items_order_id_foreign', 'shop.order_items', 'shop.orders', 'n', 'a']
  ], 'keys into another database are left out');
  assert.ok(orders.columns.find(c => c.name === 'user_id').foreign);
  assert.match(schema.fingerprint, /^[0-9a-f]+$/);
});

test('types and defaults read the same from MariaDB and MySQL 8', () => {
  assert.equal(mysqlType('int(11)'), 'int');
  assert.equal(mysqlType('bigint(20) unsigned'), 'bigint unsigned');
  assert.equal(mysqlType('tinyint(1)'), 'tinyint(1)');
  assert.equal(mysqlDefault('active', 'varchar'), "'active'", 'MySQL 8 leaves string defaults unquoted');
  assert.equal(mysqlDefault("'it''s'", 'varchar'), "'it''s'");
  assert.equal(mysqlDefault('current_timestamp()', 'timestamp'), 'current_timestamp()');
  assert.equal(mysqlDefault('NULL', 'varchar'), null);
});

test('database listing hides the system schemas server-side and reports sizes', async () => {
  const databases = await listMysqlDatabases({ query: async sql => [sql === MYSQL_DATABASES_SQL ? [{ name: 'shop', size: '16384' }] : []] });
  assert.deepEqual(databases, [{ name: 'shop', owner: '', canConnect: true, size: 16384, description: '' }]);
  assert.match(MYSQL_DATABASES_SQL, /NOT IN \('information_schema', 'mysql', 'performance_schema', 'sys'\)/);
});

test('morph types: catalog-checked, backtick-quoted, capped per server flavour, sampled on timeout', async () => {
  for (const [version, cap] of [['11.3.2-MariaDB', 'SET STATEMENT max_statement_time = 3 FOR SELECT'], ['8.0.36', 'SELECT /*+ MAX_EXECUTION_TIME(3000) */ DISTINCT']]) {
    const sent = [];
    const connection = {
      async query(sql, params) {
        sent.push(sql);
        if (sql.startsWith('SELECT VERSION()')) return [[{ version }]];
        if (sql === MYSQL_MORPH_COLUMN_SQL) return [params[0] === 'shop.events' ? [{ table_name: 'ev`ents' }] : []];
        if (sql.includes('LIMIT 100000')) return [[{ value: 'App\\Models\\Order' }, { value: null }]];
        if (sql.includes('FROM `ev``ents`')) throw Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_TIMEOUT' });
        return [[]];
      },
      release() { sent.push('release'); }
    };
    const result = await readMysqlMorphTypes({ getConnection: async () => connection }, [
      { tableId: 'shop.events', column: 'eventable_type' }, { tableId: 'shop.events', column: 'password' }, { tableId: 'shop.nope', column: 'x_type' }
    ]);
    assert.deepEqual(result, [{ tableId: 'shop.events', column: 'eventable_type', values: ['App\\Models\\Order'], partial: true }]);
    assert.ok(sent.some(sql => sql.startsWith(cap)), `${version} uses its own time cap`);
    assert.ok(sent.includes('START TRANSACTION READ ONLY') && sent.at(-1) === 'release');
    assert.ok(!sent.some(sql => sql.includes('password')));
  }
});

// Runs only against a real server: ER_ATLAS_MYSQL_TEST=mysql://root@127.0.0.1:3306/er_atlas_mysql_test
// after loading test/fixtures/mysql-fixture.sql into that database.
test('reads the fixture database on a real MySQL/MariaDB server', { skip: !process.env.ER_ATLAS_MYSQL_TEST }, async () => {
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({ uri: process.env.ER_ATLAS_MYSQL_TEST, connectionLimit: 1, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  pool.pool.on('connection', connection => connection.query('SET SESSION TRANSACTION READ ONLY'));
  try {
    const schema = await readMysqlSchema(pool);
    const name = schema.tables[0].schema;
    assert.deepEqual(schema.tables.map(table => table.name).sort(), ['events', 'legacy_logs', 'order_items', 'orders', 'products', 'users']);
    assert.equal(schema.relations.length, 3);
    assert.equal(schema.tables.find(table => table.name === 'orders').columns.find(c => c.name === 'meta').type, 'json');
    const morphs = await readMysqlMorphTypes(pool, [{ tableId: `${name}.events`, column: 'eventable_type' }]);
    assert.deepEqual(morphs[0].values.sort(), ['App\\Models\\Order', 'user']);
    await assert.rejects(pool.query('INSERT INTO products (sku) VALUES (?)', ['x']), /read only|READ ONLY|read-only/i);
    const stats = await (await import('../mysql-schema.js')).readMysqlStats(pool);
    assert.equal(stats.tables[`${name}.users`].liveRows >= 0, true);
    if (!stats.usageMeasured) assert.ok(stats.indexes.every(index => index.scans === null));
  } finally { await pool.end(); }
});

test('stats fill only what MySQL measures the same way, and never call an index unused without measuring', async () => {
  const { readMysqlStats, MYSQL_STATS_TABLES_SQL, MYSQL_STATS_IO_SQL, MYSQL_STATS_INDEX_USE_SQL, MYSQL_STATS_UPTIME_SQL, MARIADB_NULLS_SQL } = await import('../mysql-schema.js');
  const rows = enabled => ({
    [MYSQL_STATS_TABLES_SQL]: [{ schema_name: 'shop', table_name: 'orders', live_rows: '120', data_bytes: '16384', index_bytes: '32768' }],
    'SELECT @@performance_schema AS enabled': [{ enabled }],
    [MYSQL_STATS_IO_SQL]: [{ table_name: 'orders', inserts: '7', updates: '3', deletes: '1' }],
    [MYSQL_STATS_INDEX_USE_SQL]: [{ table_name: 'orders', index_name: 'PRIMARY', uses: '40', fetched: '40' }, { table_name: 'orders', index_name: null, uses: '9', fetched: '900' }],
    [MYSQL_STATS_UPTIME_SQL]: [{ uptime: '60' }],
    [MARIADB_NULLS_SQL]: [{ table_name: 'orders', column_name: 'meta', null_frac: '0.25' }],
    [MYSQL_INDEXES_SQL]: [
      { table_name: 'orders', name: 'PRIMARY', non_unique: 0, seq: 1, column_name: 'id' },
      { table_name: 'orders', name: 'orders_user_id_index', non_unique: 1, seq: 1, column_name: 'user_id' }
    ]
  });
  const fakeWith = enabled => ({ query: async sql => { const table = rows(enabled); if (!(sql in table)) throw new Error('no such table'); return [table[sql]]; } });
  const on = await readMysqlStats(fakeWith(1));
  assert.equal(on.usageMeasured, true);
  assert.deepEqual(on.tables['shop.orders'], { seqScan: null, seqTupRead: null, idxScan: null, liveRows: 120, deadRows: null, inserts: 7, updates: 3, deletes: 1, lastAnalyze: null, dataBytes: 16384, indexBytes: 32768 });
  assert.deepEqual(on.indexes.map(index => [index.name, index.primary, index.scans]), [['PRIMARY', true, 40], ['orders_user_id_index', false, 0]]);
  assert.deepEqual(on.nullFraction, { 'shop.orders': { meta: 0.25 } });
  assert.ok(Math.abs(Date.now() - 60000 - Date.parse(on.resetAt)) < 5000, 'counters run since the server started');
  const off = await readMysqlStats(fakeWith(0));
  assert.equal(off.usageMeasured, false);
  assert.deepEqual(off.indexes.map(index => index.scans), [null, null], 'performance_schema off: unknown, not unused');
  assert.equal(off.tables['shop.orders'].inserts, null);
});
