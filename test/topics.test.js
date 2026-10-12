import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopics, parseTopicSuggestions } from '../public/topics.js';

test('suggestions discard invented IDs, preserve overlap and cover omitted tables', () => {
  const groups = parseTopicSuggestions('```json\n[{"name":"المبيعات","tableIds":["a","a","b","invented"]},{"name":"العملاء","tableIds":["b"]}]\n```', ['a', 'b', 'c']);
  assert.deepEqual(groups.map(group => group.ids), [['a', 'b'], ['b'], ['c']]);
  assert.equal(groups[2].label, 'جداول أخرى');
});

test('invalid or empty AI answers cannot erase existing topics', () => {
  assert.throws(() => parseTopicSuggestions('[]', ['a']), /صالحة/);
  assert.throws(() => parseTopicSuggestions('[{"name":"خطأ","tableIds":["unknown"]}]', ['a']), /صالحة/);
  assert.throws(() => parseTopicSuggestions('not json', ['a']));
});

test('saved topics retain empty groups and repair duplicate IDs and invalid colors', () => {
  const groups = normalizeTopics([{ id: 'all', label: '  موضوع  ', color: 'red', ids: [] }, { id: 'x', label: 'ثانٍ', ids: ['a'] }, { id: 'x', label: 'ثالث', ids: ['bad'] }, null], ['a']);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].label, 'موضوع');
  assert.equal(new Set(groups.map(group => group.id)).size, 3);
  assert.ok(groups.every(group => group.id !== 'all' && /^#[0-9a-f]{6}$/i.test(group.color)));
  assert.deepEqual(groups[2].ids, []);
});

test('suggestions accept a topics object from a structured assistant response', () => {
  assert.deepEqual(parseTopicSuggestions('{"topics":[{"name":"قسم","tableIds":["a"]}]}', ['a'])[0].ids, ['a']);
});

test('code reasons and verified source locations survive saving and loading topics', () => {
  const group = parseTopicSuggestions(JSON.stringify([{name:'الوصفات', tableIds:['a'], reason:'تستخدم خدمة الاستهلاك الوجبة', moduleIds:['Inventory'], evidence:[{file:'app/Services/Inventory/RecipeService.php',line:12,symbol:'RecipeService'}]}]), ['a'])[0];
  const loaded = normalizeTopics([group], ['a'])[0];
  assert.equal(loaded.reason, group.reason);
  assert.deepEqual(loaded.evidence, group.evidence);
  assert.deepEqual(loaded.moduleIds, ['Inventory']);
});
