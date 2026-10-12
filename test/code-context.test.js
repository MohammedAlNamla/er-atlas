import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPhpFacts, buildCodeContext, analyzeSource, groundTopicSuggestions } from '../code-context.js';

const tables = ['stores', 'meals', 'consumption_items', 'inventory_items', 'orders'].map(name => ({ id: name, name, schema: 'public' }));
const sources = [
  ['app/Models/Store/Store.php', '<?php namespace App\\Models\\Store; class Store {}'],
  ['app/Models/Meal/Meal.php', '<?php namespace App\\Models\\Meal; use App\\Models\\Meal\\Traits\\MealRelations; class Meal { use MealRelations; }'],
  ['app/Models/Meal/Traits/MealRelations.php', '<?php namespace App\\Models\\Meal\\Traits; use App\\Models\\Store\\Store; trait MealRelations { public function store() { return $this->belongsTo(Store::class); } }'],
  ['app/Models/ConsumptionItem/ConsumptionItem.php', '<?php namespace App\\Models\\ConsumptionItem; class ConsumptionItem {}'],
  ['app/Models/InventoryItem/InventoryItem.php', '<?php namespace App\\Models\\InventoryItem; class InventoryItem {}'],
  ['app/Models/Order/Order.php', '<?php namespace App\\Models\\Order; class Order {}'],
  ['app/Repositories/RecipeRepository.php', '<?php namespace App\\Repositories; use App\\Models\\ConsumptionItem\\ConsumptionItem; use App\\Models\\InventoryItem\\InventoryItem; class RecipeRepository { public function lines() { return ConsumptionItem::query()->with(InventoryItem::class)->get(); } }'],
  ['app/Services/Inventory/RecipeService.php', '<?php namespace App\\Services\\Inventory; use App\\Repositories\\RecipeRepository; use App\\Models\\Meal\\Meal as Food; class RecipeService { public function __construct(private RecipeRepository $repository) {} public function replaceRecipe(Food $meal) { return $this->repository->lines(); } }'],
  ['app/Services/Menu/MenuService.php', '<?php namespace App\\Services\\Menu; use App\\Models\\Meal\\Meal; class MenuService { public function show(Meal $meal) { return $meal; } }'],
  ['app/Services/Order/CheckoutService.php', '<?php namespace App\\Services\\Order; use App\\Models\\Order\\Order; class CheckoutService { public function place(Order $order) { return $order; } }'],
];
const context = () => buildCodeContext(sources.map(([file, code]) => extractPhpFacts(code, file, tables)), tables);

test('AST follows actual service types, aliases, repositories and tenancy traits across domains', () => {
  const result = context();
  const inventory = result.modules.find(module => module.id === 'Inventory');
  assert.deepEqual(new Set(inventory.tableIds), new Set(['consumption_items', 'inventory_items', 'meals', 'stores']));
  assert.ok(result.modules.find(module => module.id === 'Menu').tableIds.includes('meals'));
  assert.ok(result.sharedTableIds.includes('stores') && result.sharedTableIds.includes('meals'));
  assert.ok(!inventory.tableIds.includes('orders'));
});

test('unmapped model relations and superclass helpers do not pull unrelated domains into a service', () => {
  const facts = sources.map(([file, code]) => extractPhpFacts(code, file, tables));
  facts.push(extractPhpFacts('<?php namespace App\\Models\\NotInSchema; use App\\Models\\Order\\Order; class NotInSchema { public function orders() {return $this->hasMany(Order::class);} }', 'app/Models/NotInSchema/NotInSchema.php', tables));
  facts.push(extractPhpFacts('<?php namespace App\\Services\\Inventory; use App\\Models\\NotInSchema\\NotInSchema; class UnmappedService {public function show(NotInSchema $model) {return $model;} }', 'app/Services/Inventory/UnmappedService.php', tables));
  assert.ok(!buildCodeContext(facts, tables).modules.find(module => module.id === 'Inventory').tableIds.includes('orders'));
});

test('AST reads explicit model tables and aliased migrations without trusting comments or string mentions', () => {
  const facts = extractPhpFacts("<?php namespace App\\Models; class OddName {protected $table='meals'; public function note(){return 'orders and inventory_items';} }", 'app/Models/OddName.php', tables);
  assert.equal(facts.symbols[0].tableId, 'meals');
  assert.deepEqual(facts.symbols[0].directTables, []);
  const migration = extractPhpFacts("<?php use Illuminate\\Support\\Facades\\Schema as Tables; Tables::create('consumption_items', function($table){$table->foreignId('meal_id');});", 'database/migrations/create_recipe.php', tables);
  assert.equal(migration.migrations[0].tableId, 'consumption_items');
  assert.deepEqual(migration.migrations[0].columns, [{method:'foreignId', name:'meal_id'}]);
});

test('grounding restores meal and store dependencies, permits overlap and rejects fabricated provenance', () => {
  const result = context();
  const suggestions = JSON.parse(groundTopicSuggestions(JSON.stringify([
    { name: 'الاستهلاك', tableIds: ['consumption_items', 'orders'], sourceFiles: ['app/Services/Inventory/RecipeService.php'], reason: 'تعديل وصفة الوجبة' },
    { name: 'القائمة', tableIds: ['meals'], sourceFiles: ['app/Services/Menu/MenuService.php'] }
  ]), result, tables));
  assert.ok(suggestions[0].tableIds.includes('meals') && suggestions[0].tableIds.includes('stores'));
  assert.ok(suggestions[1].tableIds.includes('meals') && suggestions[1].tableIds.includes('stores'));
  assert.ok(!suggestions[0].tableIds.includes('orders'));
  assert.equal(suggestions.at(-1).name, 'جداول تحتاج مراجعة');
  assert.throws(() => groundTopicSuggestions('[{"name":"Fake","tableIds":["orders"],"sourceFiles":["invented.php"]}]', result, tables), /مصدر كود/);
});

test('local indexing ignores secret/config files, reports malformed PHP and observes changed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'er-atlas-code-test-'));
  try {
    await mkdir(join(root, 'app', 'Models'), {recursive:true});
    await mkdir(join(root, 'config'));
    await writeFile(join(root, '.env'), 'SECRET=never-send');
    await writeFile(join(root, 'config', 'secret.php'), "<?php $secret='never-send';");
    await writeFile(join(root, 'app', 'Models', 'Meal.php'), "<?php namespace App\\Models; class Meal {protected $table='meals';}");
    await writeFile(join(root, 'app', 'bad.php'), '<?php class { broken');
    const first = await analyzeSource(root, tables);
    assert.equal(first.scannedFiles, 2);
    assert.equal(first.parsedFiles, 1);
    assert.deepEqual(first.failedFiles, ['app/bad.php']);
    assert.ok(!JSON.stringify(first).includes('never-send'));
    await writeFile(join(root, 'app', 'Models', 'Meal.php'), "<?php namespace App\\Models; class Meal {protected $table='inventory_items';}");
    const next = await analyzeSource(root, tables);
    assert.notEqual(next.signature, first.signature);
    assert.ok(next.matchedTableIds.includes('inventory_items'));
  } finally { await rm(root, {recursive:true, force:true}); }
});
