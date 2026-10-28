import test from 'node:test';
import assert from 'node:assert/strict';
import { planChanges } from '../planner.js';
import { toSqlDdl, toLaravelMigration } from '../public/exporters.js';
import { normalizeType } from '../public/lint.js';

const column = (name, type, extra = {}) => ({ name, type, nullable: false, default: null, primary: false, unique: false, foreign: false, ...extra });
const mysqlBase = () => ({
  database: 'shop', engine: 'mysql', readOnly: true,
  tables: [
    { id: 'shop.users', schema: 'shop', name: 'users', description: 'People', columns: [
      column('id', 'bigint unsigned', { primary: true, autoIncrement: true }), column('email', 'varchar(255)', { unique: true }),
      column('status', "enum('active','blocked')", { default: "'active'", description: "User's state" })
    ], uniqueKeys: [['email']], indexes: [['id'], ['email']] },
    { id: 'shop.orders', schema: 'shop', name: 'orders', columns: [
      column('id', 'bigint unsigned', { primary: true, autoIncrement: true }), column('user_id', 'bigint unsigned', { foreign: true }),
      column('placed_at', 'datetime', { nullable: true })
    ], indexes: [['id'], ['user_id']] }
  ],
  relations: [{ id: 'shop.orders.orders_user_id_foreign', name: 'orders_user_id_foreign', source: 'shop.orders', target: 'shop.users', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'c', onUpdate: 'a', kind: 'actual' }]
});

test('MySQL plans: backticks, one MODIFY per column change, DROP FOREIGN KEY and online indexes', () => {
  const { statements } = planChanges(mysqlBase(), [
    { type: 'updateColumn', tableId: 'shop.orders', columnName: 'placed_at', patch: { name: 'ordered_at', type: 'datetime(3)', nullable: false, default: 'CURRENT_TIMESTAMP(3)' } },
    { type: 'updateColumn', tableId: 'shop.users', columnName: 'status', patch: { default: "'blocked'" } },
    { type: 'renameTable', tableId: 'shop.orders', name: 'purchases' },
    { type: 'addIndex', tableId: 'shop.users', index: { name: 'users_status_index', columns: ['status'], unique: false, concurrently: true } },
    { type: 'dropRelation', relationId: 'shop.orders.orders_user_id_foreign' }
  ]);
  assert.deepEqual(statements, [
    'ALTER TABLE `shop`.`orders` RENAME COLUMN `placed_at` TO `ordered_at`;',
    'ALTER TABLE `shop`.`orders` MODIFY COLUMN `ordered_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);',
    "ALTER TABLE `shop`.`users` ALTER COLUMN `status` SET DEFAULT 'blocked';",
    'ALTER TABLE `shop`.`orders` RENAME TO `shop`.`purchases`;',
    'CREATE INDEX `users_status_index` ON `shop`.`users` (`status`) ALGORITHM=INPLACE LOCK=NONE;',
    'ALTER TABLE `shop`.`purchases` DROP FOREIGN KEY `orders_user_id_foreign`;'
  ]);
});

test('a MODIFY keeps auto-increment and the comment the column already had', () => {
  const { statements } = planChanges(mysqlBase(), [
    { type: 'updateColumn', tableId: 'shop.users', columnName: 'status', patch: { nullable: true } },
    { type: 'updateColumn', tableId: 'shop.users', columnName: 'id', patch: { type: 'bigint unsigned', nullable: false, name: 'user_id_pk' } }
  ]);
  assert.equal(statements[0], "ALTER TABLE `shop`.`users` MODIFY COLUMN `status` enum('active','blocked') NULL DEFAULT 'active' COMMENT 'User''s state';");
  assert.equal(statements[1], 'ALTER TABLE `shop`.`users` RENAME COLUMN `id` TO `user_id_pk`;', 'a rename alone needs no MODIFY');
});

test('MySQL writes a new table with the columns the draft adds, never an empty CREATE TABLE', () => {
  const add = (name, type, extra = {}) => ({ type: 'addColumn', tableId: 'draft:t', column: { name, type, nullable: false, default: null, primary: false, ...extra } });
  const { statements } = planChanges(mysqlBase(), [
    { type: 'addTable', id: 'draft:t', schema: 'shop', name: 'coupons' },
    add('id', 'bigint unsigned', { primary: true }), add('code', 'varchar(32)'), add('note', 'text', { nullable: true }),
    { type: 'addRelation', relation: { id: 'r1', name: 'coupons_id_fk', source: 'draft:t', target: 'shop.users', pairs: [{ source: 'id', target: 'id' }], onDelete: 'n' } }
  ]);
  assert.deepEqual(statements, [
    'CREATE TABLE `shop`.`coupons` (\n  `id` bigint unsigned NOT NULL PRIMARY KEY,\n  `code` varchar(32) NOT NULL,\n  `note` text NULL\n);',
    'ALTER TABLE `shop`.`coupons` ADD CONSTRAINT `coupons_id_fk` FOREIGN KEY (`id`) REFERENCES `shop`.`users` (`id`) ON DELETE SET NULL;'
  ]);
  assert.throws(() => planChanges(mysqlBase(), [{ type: 'addTable', id: 'draft:x', schema: 'shop', name: 'empty' }]), /بلا أعمدة/);
});

test('each dialect accepts its own types and defaults and names the dialect when it refuses', () => {
  const add = (type, extra = {}) => [{ type: 'addColumn', tableId: 'shop.users', column: { name: 'x', type, nullable: true, default: null, ...extra } }];
  for (const type of ['tinyint(1)', 'int unsigned', 'decimal(10,2) unsigned', 'longtext', 'json', 'datetime(6)', "enum('a','b''c')", 'year', 'varbinary(16)']) assert.doesNotThrow(() => planChanges(mysqlBase(), add(type)), type);
  assert.throws(() => planChanges(mysqlBase(), add('jsonb')), /MySQL: jsonb/);
  assert.throws(() => planChanges(mysqlBase(), add('varchar(10); DROP TABLE users')), /غير مدعوم/);
  assert.doesNotThrow(() => planChanges(mysqlBase(), add('timestamp', { default: 'CURRENT_TIMESTAMP' })));
  assert.throws(() => planChanges(mysqlBase(), add('varchar(10)', { default: 'gen_random_uuid()' })), /CURRENT_TIMESTAMP/);
  const pg = { ...mysqlBase(), engine: undefined, tables: [{ id: '1', schema: 'public', name: 'users', columns: [column('id', 'uuid', { primary: true })] }], relations: [] };
  assert.throws(() => planChanges(pg, [{ type: 'addColumn', tableId: '1', column: { name: 'x', type: 'tinyint(1)', nullable: true } }]), /PostgreSQL: tinyint/);
});

test('MySQL DDL export: inline comments and keys, trailing foreign keys', () => {
  const ddl = toSqlDdl(mysqlBase());
  assert.match(ddl, /CREATE TABLE `users` \(\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `email` varchar\(255\) NOT NULL,\n  `status` enum\('active','blocked'\) NOT NULL DEFAULT 'active' COMMENT 'User''s state',\n  PRIMARY KEY \(`id`\),\n  UNIQUE KEY \(`email`\)\n\) COMMENT='People';/);
  assert.match(ddl, /  KEY \(`user_id`\)/);
  assert.match(ddl, /ALTER TABLE `orders` ADD CONSTRAINT `orders_user_id_foreign` FOREIGN KEY \(`user_id`\) REFERENCES `users` \(`id`\) ON DELETE CASCADE;/);
  assert.doesNotMatch(ddl, /"|COMMENT ON|CREATE INDEX ON/);
});

test('Laravel export reads MySQL types and names tables without the database', () => {
  const { code } = toLaravelMigration(mysqlBase(), [
    { type: 'addColumn', tableId: 'shop.users', column: { name: 'is_admin', type: 'tinyint(1)', nullable: false, default: '0' } },
    { type: 'addColumn', tableId: 'shop.users', column: { name: 'role', type: "enum('admin','staff')", nullable: true, default: null } },
    { type: 'addColumn', tableId: 'shop.orders', column: { name: 'qty', type: 'int unsigned', nullable: false, default: null } },
    { type: 'addColumn', tableId: 'shop.orders', column: { name: 'shipped_at', type: 'datetime', nullable: true, default: null } },
    { type: 'addIndex', tableId: 'shop.orders', index: { name: 'orders_qty_index', columns: ['qty'], unique: false, concurrently: true } }
  ]);
  assert.match(code, /Schema::table\('users'/);
  assert.doesNotMatch(code, /shop\./);
  assert.match(code, /\$table->boolean\('is_admin'\)->default\(0\);/);
  assert.match(code, /\$table->enum\('role', \['admin', 'staff'\]\)->nullable\(\);/);
  assert.match(code, /\$table->unsignedInteger\('qty'\);/);
  assert.match(code, /\$table->dateTime\('shipped_at'\)->nullable\(\);/);
  assert.doesNotMatch(code, /CONCURRENTLY|withinTransaction/);
  assert.match(toLaravelMigration({ ...mysqlBase(), engine: undefined, tables: [{ ...mysqlBase().tables[0], schema: 'shop' }] }, [
    { type: 'addColumn', tableId: 'shop.users', column: { name: 'x', type: 'text', nullable: true } }]).code, /Schema::table\('shop\.users'/, 'PostgreSQL keeps a non-public schema');
});

test('lint compares MySQL types by what the server enforces', () => {
  assert.equal(normalizeType('int(10) unsigned'), normalizeType('integer unsigned'));
  assert.notEqual(normalizeType('bigint unsigned'), normalizeType('bigint'), 'MySQL refuses a signed key to an unsigned column');
  assert.equal(normalizeType('double'), normalizeType('double precision'));
});

// Opt-in: ER_ATLAS_MYSQL_ADMIN=mysql://root@127.0.0.1:3306 runs the planned SQL on a scratch database it creates and drops.
test('planned MySQL statements run on a real server', { skip: !process.env.ER_ATLAS_MYSQL_ADMIN }, async () => {
  const { createConnection } = await import('mysql2/promise');
  const { readMysqlSchema } = await import('../mysql-schema.js');
  const name = `er_atlas_plan_${process.pid}`;
  const admin = await createConnection({ uri: process.env.ER_ATLAS_MYSQL_ADMIN, multipleStatements: false });
  try {
    await admin.query(`CREATE DATABASE \`${name}\``);
    await admin.query(`USE \`${name}\``);
    for (const sql of toSqlDdl({ ...mysqlBase(), tables: mysqlBase().tables.map(t => ({ ...t, schema: name, id: `${name}.${t.name}` })),
      relations: mysqlBase().relations.map(r => ({ ...r, source: `${name}.orders`, target: `${name}.users` })) }).split(';\n').map(s => s.replace(/^--.*$/gm, '').trim()).filter(Boolean)) await admin.query(sql);
    const base = await readMysqlSchema(admin);
    const id = table => `${name}.${table}`;
    const add = (column, type, extra = {}) => ({ type: 'addColumn', tableId: 'draft:c', column: { name: column, type, nullable: false, default: null, primary: false, ...extra } });
    const { statements } = planChanges(base, [
      { type: 'addTable', id: 'draft:c', schema: name, name: 'coupons' }, add('id', 'bigint unsigned', { primary: true }), add('code', 'varchar(32)'),
      { type: 'updateColumn', tableId: id('orders'), columnName: 'placed_at', patch: { name: 'ordered_at', type: 'datetime(3)', nullable: false, default: 'CURRENT_TIMESTAMP(3)' } },
      { type: 'updateColumn', tableId: id('users'), columnName: 'status', patch: { default: "'blocked'" } },
      { type: 'addIndex', tableId: id('users'), index: { name: 'users_status_index', columns: ['status'], unique: false, concurrently: true } },
      { type: 'dropRelation', relationId: base.relations[0].id },
      { type: 'renameTable', tableId: id('orders'), name: 'purchases' }
    ]);
    for (const sql of statements) await admin.query(sql);
    const after = await readMysqlSchema(admin);
    assert.deepEqual(after.tables.map(t => t.name).sort(), ['coupons', 'purchases', 'users']);
    assert.equal(after.relations.length, 0);
    const placed = after.tables.find(t => t.name === 'purchases').columns.find(c => c.name === 'ordered_at');
    assert.equal(placed.type, 'datetime(3)');
    assert.equal(after.tables.find(t => t.name === 'users').columns.find(c => c.name === 'status').default, "'blocked'");
  } finally { await admin.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => {}); await admin.end(); }
});
