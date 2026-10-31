import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPhpFacts, buildCodeContext, groundTopicSuggestions } from '../code-context.js';

// The modules expect a browser; give them just enough page before they load.
globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { getElementById: () => ({}) };
const { buildMorphRelations, morphCandidates, resolveMorphType } = await import('../public/morphs.js');
const { attachLinkedTables } = await import('../public/topics.js');

const column = (name, extra = {}) => ({ name, type: 'bigint', nullable: false, primary: false, ...extra });
const table = (name, columns) => ({ id: name, name, schema: 'public', columns: [column('id', { primary: true }), ...columns.map(item => column(item))] });
const schema = { tables: [
  table('orders', ['status']), table('invoices', ['total']), table('posts', ['title']), table('tags', ['label']),
  table('events', ['eventable_type', 'eventable_id', 'action']), table('taggables', ['tag_id', 'taggable_type', 'taggable_id'])
], relations: [] };

const sources = [
  ['app/Models/Order.php', '<?php namespace App\\Models; class Order { public function events() { return $this->morphMany(Event::class, \'eventable\'); } }'],
  ['app/Models/Invoice.php', '<?php namespace App\\Models; class Invoice { public function lastEvent() { return $this->morphOne(Event::class, \'eventable\'); } }'],
  ['app/Models/Event.php', '<?php namespace App\\Models; class Event { public function eventable() { return $this->morphTo(); } }'],
  ['app/Models/Post.php', '<?php namespace App\\Models; class Post { public function tags() { return $this->morphToMany(Tag::class, \'taggable\'); } }'],
  ['app/Models/Tag.php', '<?php namespace App\\Models; class Tag {}'],
  ['app/Providers/AppServiceProvider.php', '<?php namespace App\\Providers; use Illuminate\\Database\\Eloquent\\Relations\\Relation; use App\\Models\\Order; class AppServiceProvider { public function boot() { Relation::enforceMorphMap([\'order\' => Order::class]); } }'],
  ['app/Services/Orders/OrderService.php', '<?php namespace App\\Services\\Orders; use App\\Models\\Order; class OrderService { public function show(Order $order) { return $order; } }'],
  ['app/Services/Blog/PostService.php', '<?php namespace App\\Services\\Blog; use App\\Models\\Post; class PostService { public function show(Post $post) { return $post; } }'],
];
const context = () => buildCodeContext(sources.map(([file, code]) => extractPhpFacts(code, file, schema.tables)), schema.tables);

test('code analysis names each morph table, its owners, the morph map and the model tables', () => {
  const result = context();
  const events = result.morphs.find(entry => entry.tableId === 'events' && entry.name === 'eventable');
  assert.deepEqual(new Set(events.ownerTableIds), new Set(['orders', 'invoices']));
  assert.ok(events.evidence.some(item => item.syntax.includes("morphMany(Event, 'eventable')")));
  assert.ok(events.evidence.some(item => item.syntax.includes('morphTo')), 'morphTo is read, named after its method');
  assert.deepEqual(result.morphs.find(entry => entry.tableId === 'taggables').ownerTableIds, ['posts']);
  assert.deepEqual(result.morphMap, { order: 'orders' });
  assert.equal(result.modelTables['App\\Models\\Invoice'], 'invoices');
});

test('a service that uses the owner model now reaches its morph table, so the topic includes it', () => {
  const result = context();
  assert.ok(result.modules.find(module => module.id === 'Orders').tableIds.includes('events'));
  assert.ok(result.modules.find(module => module.id === 'Blog').tableIds.includes('taggables'));
  const topics = JSON.parse(groundTopicSuggestions(JSON.stringify([
    { name: 'الطلبات', tableIds: ['orders'], sourceFiles: ['app/Services/Orders/OrderService.php'] }
  ]), result, schema.tables));
  assert.ok(topics[0].tableIds.includes('events'));
  assert.ok(!topics.at(-1).tableIds.includes('events'), 'events no longer waits in the review bucket');
});

test('columns, code and live values become dotted relations; unknown types are dropped', () => {
  assert.deepEqual(morphCandidates(schema).map(item => `${item.tableId}.${item.name}`), ['events.eventable', 'taggables.taggable']);
  const analysis = context();
  const fromCode = buildMorphRelations(schema, analysis);
  assert.deepEqual(fromCode.filter(item => item.source === 'events').map(item => item.target).sort(), ['invoices', 'orders']);
  assert.ok(fromCode.every(item => item.kind === 'morph' && item.pairs[0].target === 'id'));
  assert.equal(fromCode.find(item => item.source === 'events').pairs[0].source, 'eventable_id');
  const live = { columns: [{ tableId: 'events', column: 'eventable_type', values: ['order', 'App\\Models\\Post', 'App\\Models\\Ghost'] }] };
  const withData = buildMorphRelations(schema, analysis, live);
  assert.deepEqual(withData.find(item => item.target === 'orders').via.sort(), ['code', 'data']);
  assert.ok(withData.some(item => item.source === 'events' && item.target === 'posts'), 'a class name resolves by Eloquent convention');
  assert.equal(resolveMorphType('App\\Models\\Ghost', analysis, new Map(schema.tables.map(item => [item.name, item.id]))), null);
});

test('morph tables join their owners topics and leave the catch-all; curated topics keep orphans only', () => {
  const links = [{ source: 'events', target: 'orders' }, { source: 'events', target: 'invoices' }];
  const groups = attachLinkedTables([
    { id: 'all', ids: new Set(['orders', 'invoices', 'events']) },
    { id: 'sales', label: 'المبيعات', ids: new Set(['orders']) },
    { id: 'billing', label: 'الفوترة', ids: new Set(['invoices']) },
    { id: 'other', label: 'جداول أخرى', ids: new Set(['events']) }
  ], links);
  assert.ok(groups.find(group => group.id === 'sales').ids.has('events'));
  assert.ok(groups.find(group => group.id === 'billing').ids.has('events'));
  assert.ok(!groups.some(group => group.id === 'other'), 'an emptied catch-all topic disappears');
  const curated = attachLinkedTables([
    { id: 'all', ids: new Set() }, { id: 'sales', label: 'المبيعات', ids: new Set(['orders']) }, { id: 'audit', label: 'السجل', ids: new Set(['events']) }
  ], links, { onlyOrphans: true });
  assert.ok(!curated.find(group => group.id === 'sales').ids.has('events'), 'a table the user placed is not copied around');
});

test('live type reading checks the catalog, quotes identifiers and samples when the full scan times out', async () => {
  const { readMorphTypes, MORPH_COLUMN_SQL } = await import('../pg-schema.js');
  const sent = [];
  const client = {
    async query(sql, params) {
      sent.push(sql);
      if (sql === MORPH_COLUMN_SQL) return { rows: params[0] === '42' ? [{ schema_name: 'app', table_name: 'we"ird' }] : [] };
      if (sql.startsWith('SELECT DISTINCT "eventable_type"')) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      if (sql.startsWith('SELECT DISTINCT value')) return { rows: [{ value: 'order' }, { value: null }] };
      return { rows: [] };
    },
    release() { sent.push('release'); }
  };
  const result = await readMorphTypes({ connect: async () => client }, [
    { tableId: '42', column: 'eventable_type' }, { tableId: '42', column: 'password' }, { tableId: '7', column: 'x_type' }
  ]);
  assert.deepEqual(result, [{ tableId: '42', column: 'eventable_type', values: ['order'], partial: true }]);
  assert.ok(sent.some(sql => sql.includes('FROM "app"."we""ird"')), 'identifiers come from the catalog and are quoted');
  assert.ok(!sent.some(sql => sql.includes('password')), 'only *_type columns are read');
  assert.ok(sent.filter(sql => sql === 'BEGIN READ ONLY').length === 2 && sent.at(-1) === 'release');
});
