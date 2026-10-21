import test from 'node:test';
import assert from 'node:assert/strict';

// The modules expect a browser; give them just enough page before they load.
let elements = new Map();
globalThis.window ??= { addEventListener() {} };
globalThis.document = { getElementById(id) {
  if (!elements.has(id)) elements.set(id, { clientWidth: 1400, clientHeight: 800 });
  return elements.get(id);
} };
globalThis.requestAnimationFrame = callback => callback();
const { state } = await import('../public/core.js');
const { store } = await import('../public/storage.js');
const layout = await import('../public/layout.js');
const initialState = structuredClone(state), defaultHooks = { ...layout.hooks };
const snapshot = positions => JSON.stringify(Object.fromEntries(positions));

function harness(mode = 'map') {
  const saved = new Map(), messages = [];
  elements = new Map();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, structuredClone(initialState));
  Object.assign(store, { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) });
  Object.assign(layout.hooks, defaultHooks, { renderNodes: () => {}, fitView: () => {}, showToast: message => messages.push(message), renderArrangement: () => {} });
  const { arrangeTables, arrangeWithAi, applyArrangement, captureArrangement, buildTopicPositions, buildFocusPositions, layoutTables, nodeHeight } = layout;
  const api = { state, arrangeTables, arrangeWithAi, applyArrangement, captureArrangement, buildTopicPositions, buildFocusPositions, layoutTables, nodeHeight,
    setAsk: callback => { layout.hooks.askAi = callback; } };
  api.state.schema = { tables: ['store', 'meal', 'recipe', 'item', 'order', 'payment'].map((id, index) => ({
    id, name: id, columns: Array.from({ length: 2 + index * 4 }, () => ({ name: 'id' }))
  })), relations: [
    { source: 'meal', target: 'store' }, { source: 'recipe', target: 'meal' },
    { source: 'recipe', target: 'item' }, { source: 'order', target: 'store' }
  ] };
  api.state.workspaceId = 'layout-test';
  api.state.viewMode = mode;
  api.state.topic = mode === 'topics' ? 'recipes' : 'all';
  api.state.focusTable = mode === 'focus' ? 'meal' : null;
  api.state.groups = [
    { id: 'recipes', ids: new Set(['meal', 'recipe', 'item', 'store']) },
    { id: 'orders', ids: new Set(['order', 'store']) }
  ];
  api.state.positions = api.layoutTables();
  api.buildTopicPositions(); api.buildFocusPositions();
  return { ...api, saved, elements, messages };
}

function assertSeparated(api, positions) {
  const tables = api.state.schema.tables.filter(table => positions.has(table.id));
  for (const [index, table] of tables.entries()) {
    const a = positions.get(table.id);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    for (const other of tables.slice(index + 1)) {
      const b = positions.get(other.id);
      assert.ok(a.x + 320 <= b.x || b.x + 320 <= a.x || a.y + api.nodeHeight(table) <= b.y || b.y + api.nodeHeight(other) <= a.y,
        `${table.id} overlaps ${other.id}`);
    }
  }
}

for (const mode of ['map', 'topics', 'focus']) {
  test(`ordinary arrangement resets dragged ${mode} tables without moving another view`, () => {
    const api = harness(mode);
    const field = mode === 'map' ? 'positions' : `${mode === 'topics' ? 'topic' : 'focus'}Positions`;
    const initial = snapshot(api.state[field]);
    const global = snapshot(api.state.positions);
    const id = api.state[field].keys().next().value;
    api.state[field].set(id, { x: 9000, y: 9000 });
    const key = `eratlas.v4.ws.layout-test.${mode === 'topics' ? 'topicLayout.recipes' : 'focusLayout.meal'}`;
    if (mode !== 'map') api.saved.set(key, snapshot(api.state[field]));
    api.arrangeTables();
    assert.equal(snapshot(api.state[field]), initial);
    if (mode !== 'map') assert.equal(snapshot(api.state.positions), global);
    assertSeparated(api, api.state[field]);
  });

  test(`AI proposal waits for approval, then moves visible ${mode} tables and persists only that scope`, async () => {
    const api = harness(mode);
    const field = mode === 'map' ? 'positions' : `${mode === 'topics' ? 'topic' : 'focus'}Positions`;
    const ids = [...api.state[field].keys()];
    const global = snapshot(api.state.positions);
    api.state[field].set(ids[0], { x: 9000, y: 9000 });
    api.saved.set('eratlas.v4.ws.layout-test.topicLayout.orders', 'unrelated-topic');
    api.setAsk(async (operation, question, schema) => {
      assert.equal(operation, 'layout');
      assert.deepEqual(schema.tables.map(table => table.id).sort(), [...ids].sort());
      assert.ok(schema.relations.every(relation => ids.includes(relation.source) && ids.includes(relation.target)));
      return JSON.stringify({ zones: [{ name: 'first', tableIds: ids.slice(0, 2) }, { name: 'second', tableIds: ids.slice(2) }] });
    });
    await api.arrangeWithAi();
    assert.equal(api.state[field].get(ids[0]).x, 9000);
    assert.equal(api.saved.size, 1);
    assert.ok(api.state.arrangement.proposed);
    assert.equal(api.applyArrangement(), true);
    assert.notEqual(api.state[field].get(ids[0]).x, 9000);
    assertSeparated(api, api.state[field]);
    assert.equal(api.saved.get('eratlas.v4.ws.layout-test.topicLayout.orders'), 'unrelated-topic');
    if (mode !== 'map') {
      assert.equal(snapshot(api.state.positions), global);
      const arranged = snapshot(api.state[field]);
      if (mode === 'topics') api.buildTopicPositions(); else api.buildFocusPositions();
      assert.equal(snapshot(api.state[field]), arranged);
    } else assert.equal(api.saved.get('eratlas.v4.ws.layout-test'), snapshot(api.state.positions));
    assert.match(api.messages.at(-1), /تم تطبيق/);
  });
}

test('a result returned after changing workspace cannot overwrite table positions', async () => {
  const api = harness('topics');
  const initial = snapshot(api.state.topicPositions);
  api.setAsk(async () => {
    api.state.workspaceId = 'other-workspace';
    return JSON.stringify({ zones: [{ tableIds: ['meal', 'recipe'] }] });
  });
  await api.arrangeWithAi();
  assert.equal(snapshot(api.state.topicPositions), initial);
  assert.match(api.state.arrangement.error, /تغيرت المساحة/);
  assert.equal(api.applyArrangement(), false);
  assert.equal(api.saved.size, 0);
});

test('invalid AI table IDs cannot report a successful arrangement', async () => {
  const api = harness();
  const initial = snapshot(api.state.positions);
  api.setAsk(async () => JSON.stringify({ zones: [{ tableIds: ['invented'] }] }));
  await api.arrangeWithAi();
  assert.equal(snapshot(api.state.positions), initial);
  assert.match(api.state.arrangement.error, /جدول صالح/);
  assert.equal(api.applyArrangement(), false);
});

test('changing the view after preview prevents applying an outdated proposal', async () => {
  const api = harness();
  const initial = snapshot(api.state.positions);
  api.setAsk(async () => JSON.stringify({ zones: [{ tableIds: ['store', 'meal'] }] }));
  await api.arrangeWithAi();
  api.state.viewMode = 'focus';
  assert.equal(api.applyArrangement(), false);
  assert.equal(snapshot(api.state.positions), initial);
  assert.equal(api.saved.size, 0);
});

test('canceling AI preserves positions and produces no applicable proposal', async () => {
  const api = harness();
  const initial = snapshot(api.state.positions);
  api.setAsk(async () => { api.state.layoutController.abort(); return JSON.stringify({ zones: [{ tableIds: ['store'] }] }); });
  await api.arrangeWithAi();
  assert.equal(api.applyArrangement(), false);
  assert.equal(snapshot(api.state.positions), initial);
  assert.equal(api.saved.size, 0);
});

test('a temporary preview can be applied without persisting layout', () => {
  const api = harness();
  api.state.arrangement = api.captureArrangement();
  api.elements.set('persistArrangement', { checked: false });
  assert.equal(api.applyArrangement(), true);
  assert.equal(api.saved.size, 0);
});
