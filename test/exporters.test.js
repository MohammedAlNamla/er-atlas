import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPORT_FORMATS, toMermaid, toDbml, toSqlDdl, toLaravelMigration } from '../public/exporters.js';

const col = (name, type, extra = {}) => ({ number: 0, name, type, nullable: true, default: null, description: '', primary: false, unique: false, foreign: false, ...extra });
const fixture = {
  database: 'shop',
  tables: [
    { id: 'o', schema: 'public', name: 'orders', description: "Customer's orders", approxRows: 10, columns: [
      col('id', 'bigint', { primary: true, nullable: false, default: "nextval('orders_id_seq'::regclass)" }),
      col('user_id', 'bigint', { foreign: true }),
      col('code', 'character varying(255)', { nullable: false, default: "'new'::character varying", description: 'Public "order" code' }),
      col('tags', 'text[]'),
      col('placed_at', 'timestamp(0) without time zone', { nullable: false, default: 'now()' }),
      col('total', 'numeric(14,3)', { default: '0' })
    ], uniqueKeys: [['user_id', 'code']], indexes: [['id'], ['user_id', 'code'], ['placed_at']] },
    { id: 'u', schema: 'public', name: 'users', description: '', approxRows: 2, columns: [
      col('id', 'bigint', { primary: true, nullable: false }),
      col('email', 'varchar(80)', { nullable: false, unique: true, description: "user's login" }),
      col('active', 'boolean', { nullable: false, default: 'true' })
    ] },
    { id: 'a', schema: 'audit', name: 'events', description: '', approxRows: 0, columns: [
      col('id', 'uuid', { primary: true, nullable: false, default: 'gen_random_uuid()' }),
      col('user_id', 'bigint', { nullable: false, foreign: true })
    ] }
  ],
  relations: [
    { id: 'r1', name: 'orders_user_id_foreign', source: 'o', target: 'u', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'c', kind: 'actual' },
    { id: 'r2', name: 'events_user_id_foreign', source: 'a', target: 'u', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'a', kind: 'actual' }
  ]
};

test('export formats describe every exporter', () => {
  assert.deepEqual(EXPORT_FORMATS.map(format => format.id), ['mermaid', 'dbml', 'sql', 'laravel']);
  for (const format of EXPORT_FORMATS) assert.ok(format.label && format.fileExtension && format.mime);
});

test('mermaid emits sanitized entities, attributes and cardinality', () => {
  const text = toMermaid(fixture);
  assert.match(text, /^erDiagram\n/);
  assert.ok(text.indexOf('audit__events {') < text.indexOf('orders {'));
  assert.ok(text.includes('    bigint id PK\n'));
  assert.ok(text.includes('    character_varying_255 code "Public order code"'));
  assert.ok(text.includes('    text_array tags\n'));
  assert.ok(text.includes('    timestamp_0_without_time_zone placed_at\n'));
  assert.ok(text.includes('    numeric_14_3 total\n'));
  assert.ok(text.includes('    varchar_80 email UK "user\'s login"'));
  assert.ok(text.includes('  users |o--o{ orders : "orders_user_id_foreign"'));
  assert.ok(text.includes('  users ||--o{ audit__events : "events_user_id_foreign"'));
});

test('mermaid marks one-to-one when the foreign key is the primary key', () => {
  const schema = structuredClone(fixture);
  schema.tables.push({ id: 'p', schema: 'public', name: 'profiles', columns: [col('user_id', 'bigint', { primary: true, nullable: false })] });
  schema.relations.push({ id: 'r3', name: 'profiles_user', source: 'p', target: 'u', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'c' });
  assert.ok(toMermaid(schema).includes('users ||--o| profiles : "profiles_user"'));
});

test('dbml quotes types, escapes notes and writes refs', () => {
  const text = toDbml(fixture);
  assert.match(text, /^\/\/ ER Atlas · shop/);
  assert.ok(text.includes('Table public.orders {'));
  assert.ok(text.includes('Table audit.events {'));
  assert.ok(text.includes('  id bigint [pk, default: `nextval(\'orders_id_seq\'::regclass)`]'));
  assert.ok(text.includes(`  code "character varying(255)" [not null, default: 'new', note: 'Public "order" code']`));
  assert.ok(text.includes('  tags "text[]"\n'));
  assert.ok(text.includes('  placed_at "timestamp(0) without time zone" [not null, default: `now()`]'));
  assert.ok(text.includes('  total "numeric(14,3)" [default: 0]'));
  assert.ok(text.includes("  email \"varchar(80)\" [not null, unique, note: 'user\\'s login']"));
  assert.ok(text.includes('  active boolean [not null, default: true]'));
  assert.ok(text.includes('    (user_id, code) [unique]\n    placed_at\n'));
  assert.ok(text.includes("  Note: 'Customer\\'s orders'"));
  assert.ok(text.includes('Ref orders_user_id_foreign: public.orders.user_id > public.users.id [delete: cascade]'));
  assert.ok(text.includes('Ref events_user_id_foreign: audit.events.user_id > public.users.id\n'));
});

test('dbml writes composite refs', () => {
  const schema = structuredClone(fixture);
  schema.relations = [{ id: 'c', name: 'fk_pair', source: 'o', target: 'u', pairs: [{ source: 'user_id', target: 'id' }, { source: 'code', target: 'email' }], onDelete: 'n' }];
  assert.ok(toDbml(schema).includes('Ref fk_pair: public.orders.(user_id, code) > public.users.(id, email) [delete: set null]'));
});

test('sql ddl creates tables, comments and trailing foreign keys', () => {
  const text = toSqlDdl(fixture);
  assert.match(text, /^-- ER Atlas · shop\n/);
  assert.ok(text.indexOf('CREATE TABLE "audit"."events"') < text.indexOf('CREATE TABLE "public"."orders"'));
  assert.ok(text.includes(`  "id" bigint DEFAULT nextval('orders_id_seq'::regclass) PRIMARY KEY,`));
  assert.ok(text.includes(`  "code" character varying(255) DEFAULT 'new'::character varying NOT NULL,`));
  assert.ok(text.includes('  "tags" text[],'));
  assert.ok(text.includes('  "placed_at" timestamp(0) without time zone DEFAULT now() NOT NULL,'));
  assert.ok(text.includes('  UNIQUE ("user_id", "code")\n);'));
  assert.ok(text.includes('  "email" varchar(80) NOT NULL UNIQUE,'));
  assert.ok(text.includes('CREATE INDEX ON "public"."orders" ("placed_at");'));
  assert.ok(text.includes(`COMMENT ON TABLE "public"."orders" IS 'Customer''s orders';`));
  assert.ok(text.includes(`COMMENT ON COLUMN "public"."users"."email" IS 'user''s login';`));
  assert.ok(text.includes('ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE;'));
  assert.ok(text.includes('ALTER TABLE "audit"."events" ADD CONSTRAINT "events_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id");'));
  assert.ok(text.lastIndexOf('CREATE TABLE') < text.indexOf('ALTER TABLE'));
});

test('sql ddl writes composite primary keys and escapes identifiers', () => {
  const text = toSqlDdl({ database: 'x', tables: [{ id: 't', schema: 'public', name: 'odd"name', columns: [
    col('a', 'integer', { primary: true, nullable: false }), col('b', 'integer', { primary: true, nullable: false })] }], relations: [] });
  assert.ok(text.includes('CREATE TABLE "public"."odd""name" ('));
  assert.ok(text.includes('  "a" integer NOT NULL,'));
  assert.ok(text.includes('  PRIMARY KEY ("a", "b")'));
});

const createDraft = [
  { type: 'addTable', id: 'draft:notes', schema: 'public', name: 'notes' },
  { type: 'addColumn', tableId: 'draft:notes', column: { name: 'id', type: 'bigint', nullable: false, primary: true } },
  { type: 'addColumn', tableId: 'draft:notes', column: { name: 'title', type: 'varchar(120)', nullable: false, default: "'Untitled'" } },
  { type: 'addColumn', tableId: 'draft:notes', column: { name: 'user_id', type: 'bigint', nullable: true } },
  { type: 'addColumn', tableId: 'draft:notes', column: { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' } },
  { type: 'addColumn', tableId: 'draft:notes', column: { name: 'tags', type: 'text[]', nullable: true } },
  { type: 'addRelation', relation: { id: 'draft:fk', name: 'notes_user_id_foreign', source: 'draft:notes', target: 'u', pairs: [{ source: 'user_id', target: 'id' }], onDelete: 'n' } }
];

test('laravel folds a new table into one create closure', () => {
  const { fileName, code } = toLaravelMigration(fixture, createDraft, { date: '2026_10_21_120000' });
  assert.equal(fileName, '2026_10_21_120000_create_notes_table.php');
  assert.match(code, /^<\?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;/);
  assert.ok(!code.includes('Facades\\DB'));
  assert.equal(code.match(/Schema::create\(/g).length, 1);
  assert.ok(!code.includes('Schema::table('));
  assert.ok(code.includes([
    "        Schema::create('notes', function (Blueprint $table) {",
    '            $table->id();',
    "            $table->string('title', 120)->default('Untitled');",
    "            $table->bigInteger('user_id')->nullable();",
    "            $table->timestampTz('created_at')->useCurrent();",
    '            // TODO: نوع غير مدعوم في Laravel: text[] للعمود tags',
    "            $table->foreign('user_id', 'notes_user_id_foreign')->references('id')->on('users')->nullOnDelete();",
    '        });'].join('\n')));
  assert.ok(code.includes("    public function down(): void\n    {\n        Schema::dropIfExists('notes');\n    }\n};\n"));
});

test('laravel alters existing tables and keeps down() reversible where it can', () => {
  const ops = [
    { type: 'updateColumn', tableId: 'o', columnName: 'code', patch: { name: 'reference', type: 'varchar(64)', nullable: true } },
    { type: 'dropColumn', tableId: 'o', columnName: 'user_id' },
    { type: 'addColumn', tableId: 'u', column: { name: 'score', type: 'numeric(5,2)', nullable: true, default: 'round(1.5)' } },
    { type: 'dropRelation', relationId: 'r2' },
    { type: 'renameTable', tableId: 'u', name: 'members' }
  ];
  const { fileName, code } = toLaravelMigration(fixture, ops);
  assert.equal(fileName, '2026_01_01_000000_er_atlas_changes.php');
  assert.ok(code.includes('use Illuminate\\Support\\Facades\\DB;'));
  const up = code.slice(code.indexOf('up(): void'), code.indexOf('down(): void'));
  assert.ok(up.includes([
    "        Schema::table('orders', function (Blueprint $table) {",
    "            $table->renameColumn('code', 'reference');",
    '        });',
    '',
    "        Schema::table('orders', function (Blueprint $table) {",
    `            $table->string('reference', 64)->nullable()->default('new')->comment('Public "order" code')->change();`,
    "            $table->dropForeign('orders_user_id_foreign');",
    "            $table->dropColumn('user_id');",
    '        });'].join('\n')));
  assert.ok(up.includes("$table->decimal('score', 5, 2)->nullable()->default(DB::raw('round(1.5)'));"));
  assert.ok(up.includes("Schema::table('audit.events', function (Blueprint $table) {\n            $table->dropForeign('events_user_id_foreign');"));
  assert.ok(up.includes("Schema::rename('users', 'members');"));
  const down = code.slice(code.indexOf('down(): void'));
  const order = ["Schema::rename('members', 'users');", "->references('id')->on('users');", "$table->dropColumn('score');",
    '// يدوي: أعد إنشاء العمود orders.user_id', `$table->string('reference', 255)->default('new')->comment('Public "order" code')->change();`, "$table->renameColumn('reference', 'code');"];
  const at = order.map(line => down.indexOf(line));
  assert.ok(at.every(index => index > 0), at.join());
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(down.includes("$table->foreign('user_id', 'events_user_id_foreign')->references('id')->on('users');"));
});

test('laravel drops tables after their inbound foreign keys', () => {
  const { fileName, code } = toLaravelMigration(fixture, [{ type: 'dropTable', tableId: 'u' }]);
  assert.equal(fileName, '2026_01_01_000000_drop_users_table.php');
  const up = code.slice(0, code.indexOf('down(): void'));
  assert.ok(up.indexOf("$table->dropForeign('events_user_id_foreign');") < up.indexOf("Schema::dropIfExists('users');"));
  assert.ok(up.indexOf("$table->dropForeign('orders_user_id_foreign');") < up.indexOf("Schema::dropIfExists('users');"));
  assert.ok(code.includes('// يدوي: أعد إنشاء الجدول users'));
});

test('laravel escapes literals, honours a name and skips broken operations', () => {
  const { fileName, code } = toLaravelMigration(fixture, [
    { type: 'addColumn', tableId: 'u', column: { name: 'motto', type: 'text', nullable: false, default: "'it''s \\ fine'::text" } },
    { type: 'dropColumn', tableId: 'missing', columnName: 'x' }
  ], { name: 'Add Motto' });
  assert.equal(fileName, '2026_01_01_000000_add_motto.php');
  assert.ok(code.includes("$table->text('motto')->default('it\\'s \\\\ fine');"));
  assert.ok(code.includes('// تخطّي تغيير dropColumn: الجدول غير موجود'));
});

test('exporters are deterministic and ignore input order', () => {
  const shuffled = { ...structuredClone(fixture), tables: [...fixture.tables].reverse(), relations: [...fixture.relations].reverse() };
  for (const fn of [toMermaid, toDbml, toSqlDdl]) assert.equal(fn(shuffled), fn(fixture));
  assert.deepEqual(toLaravelMigration(fixture, createDraft), toLaravelMigration(fixture, createDraft));
  assert.equal(JSON.stringify(fixture.tables.map(t => t.name)), '["orders","users","events"]');
});

test('every exporter handles the bundled samples', () => {
  for (const file of ['sufra-products', 'sufra-supply']) {
    const { schema } = JSON.parse(readFileSync(new URL(`../public/samples/${file}.eratlas.json`, import.meta.url), 'utf8'));
    for (const fn of [toMermaid, toDbml, toSqlDdl]) assert.ok(fn(schema).length > 100);
    const table = [...schema.tables].sort((a, b) => a.name < b.name ? -1 : 1)[0];
    const { code } = toLaravelMigration(schema, [
      ...createDraft.slice(0, 5).map(op => ({ ...op })),
      { type: 'addColumn', tableId: table.id, column: { name: 'note', type: 'text', nullable: true } },
      { type: 'dropTable', tableId: table.id }
    ]);
    assert.match(code, /Schema::dropIfExists/);
  }
});

// Mermaid's erDiagram grammar (v10+): entity blocks of "type name [PK|FK|UK, ...] ["comment"]"
// and relationship lines "A <left>--<right> B : label". Every line we emit must fit one of them.
test('Mermaid output fits the erDiagram grammar for both samples', async () => {
  const { readFile } = await import('node:fs/promises');
  const word = String.raw`[A-Za-z_][A-Za-z0-9_()\[\]-]*`;
  const attribute = new RegExp(String.raw`^ {4}${word} ${word}( (PK|FK|UK)(, ?(PK|FK|UK))*)?( "[^"]*")?$`);
  const relationship = new RegExp(String.raw`^ {2}${word} (\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{) ${word} : "[^"]*"$`);
  const entity = new RegExp(String.raw`^ {2}${word}( \{)?$`);
  for (const file of ['sufra-products', 'sufra-supply']) {
    const { schema } = JSON.parse(await readFile(new URL(`../public/samples/${file}.eratlas.json`, import.meta.url), 'utf8'));
    const lines = toMermaid(schema).split('\n').filter(Boolean);
    assert.equal(lines[0], 'erDiagram');
    for (const line of lines.slice(1)) assert.ok(attribute.test(line) || relationship.test(line) || entity.test(line) || line === '  }', `${file}: ${line}`);
  }
});

test('Laravel migration adds and drops draft indexes', () => {
  const base = { tables: [{ id: 'o', schema: 'public', name: 'orders', columns: [{ name: 'id', type: 'bigint', primary: true }, { name: 'status', type: 'varchar(20)' }, { name: 'created_at', type: 'timestamptz' }] }], relations: [] };
  const { code } = toLaravelMigration(base, [{ type: 'addIndex', tableId: 'o', index: { name: 'orders_status_created_at_index', columns: ['status', 'created_at'], unique: false } }]);
  assert.match(code, /\$table->index\(\['status', 'created_at'\], 'orders_status_created_at_index'\);/);
  assert.match(code, /\$table->dropIndex\('orders_status_created_at_index'\);/);
});
