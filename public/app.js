import { applyOperation, replay, describeOperation, clone } from './model.js';
import { routeConnections } from './router.js';
import { sufraProductsSchema, sufraProductTopics } from './sufra-products-schema.js';
import { normalizeTopics, parseTopicSuggestions as readTopicSuggestions, topicColors } from './topics.js';
import { icon, button as uiButton, notice, codeBlock, tabs as uiTabs, dataTable, modalHeader, modalFooter, openDialog, initOverlays, renderMiniMap } from './ui.js';
import { NODE_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, previewColumns, nodeHeight as measureNode, columnOffset, fitCamera, relationCardinality } from './ui.js';
const $ = id => document.getElementById(id);
const state = {
  schema: null, positions: new Map(), scale: 1, x: 0, y: 0,
  topic: 'all', selectedTable: null, selectedRelation: null, demo: true,
  drag: null, groups: [], toastTimer: null, suppressClickUntil: 0,
  base: null, operations: [], cursor: 0, customGroups: null,
  linkMode: false, linkSource: null, editContext: null, plan: null, handoffPrompt: '', hoveredTable: null, aiLayout: null,
  workspaces: [], workspaceId: null, connectionLive: false, aiMessages: [], editingWorkspace: false,
  edgeRoutes: null, edgeFrame: null, viewFrame: null, routeGeneration: 0, routeWorker: null,
  viewMode: 'map', focusTable: null, focusPositions: null, topicPositions: null,
  inspectorTab: 'columns', topicEditorId: null, arrangement: null, arrangementMode: 'relations', aiController: null, layoutController: null
};
const WORKSPACES_KEY = 'eratlas.workspaces.v1';
const SUFRA_PRODUCTS_ID = 'sufra-products-2026-09-27';
const activeWorkspace = () => state.workspaces.find(item => item.id === state.workspaceId);
const blankSchema = name => ({ database: name, tables: [], relations: [], readOnly: true });
function sufraProductsWorkspace() {
  return {
    id: SUFRA_PRODUCTS_ID,
    name: 'Sufra · Products الحالي',
    kind: 'ideas',
    schema: sufraProductsSchema(),
    topic: 'all',
    connection: null
  };
}

function includeProposedDevices(workspace) {
  const snapshot = sufraProductsSchema();
  const schema = workspace.schema || snapshot;
  const deviceTables = new Set(['store_devices', 'users']);
  const existingTables = new Set(schema.tables.map(table => table.id));
  const existingRelations = new Set(schema.relations.map(relation => relation.id));

  for (const table of snapshot.tables) {
    if (deviceTables.has(table.id) && !existingTables.has(table.id)) {
      schema.tables.push(table);
    }
  }

  for (const relation of snapshot.relations) {
    if (relation.source === 'store_devices' && !existingRelations.has(relation.id)) {
      schema.relations.push(relation);
    }
  }

  schema.database = snapshot.database;
  workspace.schema = schema;
}
function saveWorkspaces() {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ activeId: state.workspaceId, items: state.workspaces }));
}
function closeWorkspaceMenu({ focus = false } = {}) {
  $('workspaceMenu').hidden = true;
  $('workspaceSwitchButton').setAttribute('aria-expanded', 'false');
  if (focus) $('workspaceSwitchButton').focus();
}
function toggleWorkspaceMenu() {
  const opening = $('workspaceMenu').hidden;
  $('workspaceMenu').hidden = !opening;
  $('workspaceSwitchButton').setAttribute('aria-expanded', String(opening));
  if (opening) $('workspaceTabs').querySelector('.workspace-option.active')?.focus();
}
function renderWorkspaces() {
  const tabs = $('workspaceTabs'); tabs.replaceChildren();
  $('workspaceCurrentName').textContent = activeWorkspace()?.name || 'مساحة العمل';
  $('workspaceStatus').style.filter = state.connectionLive ? '' : 'grayscale(1)';
  $('workspaceSwitchButton').title = state.connectionLive ? 'اتصال PostgreSQL نشط' : 'مخطط محفوظ على الجهاز';
  $('workspaceMenuCount').textContent = String(state.workspaces.length);
  for (const workspace of state.workspaces) {
    const isSufraProducts = workspace.id === SUFRA_PRODUCTS_ID;
    const button = el('button', `workspace-option${workspace.id === state.workspaceId ? ' active' : ''}`);
    button.type = 'button';
    button.title = isSufraProducts
      ? 'مخطط منتجات Sufra الحالي من الكود'
      : workspace.kind === 'ideas' ? 'مساحة أفكار' : 'خريطة قاعدة بيانات';
    if (workspace.id === state.workspaceId) button.setAttribute('aria-current', 'page');
    const mark = icon(workspace.kind === 'ideas' ? 'ai' : 'table'); mark.classList.add('workspace-option-icon');
    const copy = el('span', 'workspace-option-copy');
    const description = isSufraProducts
      ? `${workspace.schema?.tables?.length || 0} جدول · الحالي + الأجهزة المقترحة`
      : workspace.kind === 'ideas'
        ? 'أفكار ومخطط حر'
        : workspace.kind === 'demo'
          ? 'الخريطة النموذجية'
          : `${workspace.schema?.tables?.length || 0} جدول · PostgreSQL`;
    copy.append(el('strong', '', workspace.name), el('small', '', description));
    button.append(mark, copy);
    if (workspace.id === state.workspaceId) button.append(icon('check'));
    button.addEventListener('click', async () => { closeWorkspaceMenu({ focus: true }); await activateWorkspace(workspace.id); });
    tabs.append(button);
  }
}
function renderEmptyWorkspace() {
  const empty = $('emptyWorkspace'), workspace = activeWorkspace();
  empty.hidden = state.schema.tables.length > 0;
  if (empty.hidden || !workspace) return;
  const ideas = workspace.kind === 'ideas';
  $('emptyWorkspaceKicker').textContent = ideas ? 'IDEAS / CANVAS' : 'DATABASE / MAP';
  $('emptyWorkspaceTitle').textContent = ideas ? `مساحة ${workspace.name}` : `اربط ${workspace.name} بقاعدة بيانات`;
  $('emptyWorkspaceText').textContent = ideas ? 'ابدأ بنقاش فكرة مع AI أو ارسم جدولًا وعلاقاته كمسودة. كل شيء محفوظ داخل هذه المساحة.' : 'اربط PostgreSQL لعرض الجداول والعلاقات، ثم راجعها وأنشئ التعديلات كمسودة مستقلة لهذه المساحة.';
  $('emptyPrimaryButton').textContent = ideas ? '+ ارسم جدولًا' : 'ربط PostgreSQL';
  $('emptyAiButton').hidden = !ideas;
}
function renderAiMessages(status = '', failed = false) {
  const box = $('aiResponse'); box.replaceChildren();
  if (!state.aiMessages.length && !status) {
    box.append(el('h3', '', 'ماذا تريد أن تفهم؟'), el('p', 'ai-empty', activeWorkspace()?.kind === 'ideas' ? 'اكتب فكرتك وابدأ النقاش.' : 'اختر سؤالًا أو اكتب سؤالك مباشرة.'));
    const suggestions = el('div', 'ai-suggestions');
    for (const question of ['اشرح العلاقات بين الجداول الظاهرة', 'لماذا يظهر جدول في أكثر من موضوع؟', 'راجع تصميم المفاتيح الأجنبية']) suggestions.append(uiButton(question, () => { $('aiQuestion').value = question; $('aiQuestion').focus(); }));
    box.append(suggestions, notice('سياق السؤال: المخطط', 'نرسل البنية والعلاقات والمحادثة، دون صفوف البيانات أو كلمة مرور PostgreSQL.'));
  }
  for (const message of state.aiMessages) {
    const bubble = el('div', `ai-message ${message.role}`);
    if (message.role === 'user') bubble.textContent = message.content;
    else for (const [index, part] of message.content.split(/```(?:[^\n]*)\n?([\s\S]*?)```/g).entries()) {
      if (!part.trim()) continue;
      bubble.append(index % 2 ? codeBlock(part.trim(), 'AI') : el('div', '', part.trim()));
    }
    box.append(bubble);
  }
  if (status) box.append(el('div', `ai-message ${failed ? 'error' : 'status'}`, status));
  if (failed) box.append(uiButton('إعدادات المساعد', () => openDialog($('aiSettingsDialog'))), uiButton('إعادة المحاولة', () => $('aiForm').requestSubmit()));
  box.scrollTop = box.scrollHeight;
}
function saveAiMessages() { localStorage.setItem(`${storageKey()}.conversation`, JSON.stringify(state.aiMessages)); }
async function activateWorkspace(id, { initial = false, live = false } = {}) {
  const next = state.workspaces.find(item => item.id === id);
  if (!next || (!initial && id === state.workspaceId)) return;
  if (!initial && state.connectionLive) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
  if (!initial && activeWorkspace()) activeWorkspace().topic = state.topic;
  state.workspaceId = id; state.connectionLive = live;
  state.viewMode = ['map', 'tables', 'topics', 'focus'].includes(next.viewMode) ? next.viewMode : 'map';
  state.focusTable = next.focusTable || null; state.focusPositions = null; state.topicPositions = null;
  state.aiMessages = [];
  state.linkMode = false; state.linkSource = null; state.plan = null; state.handoffPrompt = '';
  $('linkModeButton').setAttribute('aria-pressed', 'false');
  state.scale = 1; state.x = 0; state.y = 0;
  $('changesPanel').close(); $('searchInput').value = '';
  state.aiController?.abort(); state.layoutController?.abort(); state.arrangement = null;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  setSchema(next.schema || blankSchema(next.name), next.kind !== 'database');
  if (next.topic && state.groups.some(group => group.id === next.topic) && state.viewMode === 'topics') {
    state.topic = next.topic; buildTopicPositions(); renderTopics(); renderView(); renderNodes(); requestAnimationFrame(() => fitView(true));
  }
  try { const messages = JSON.parse(localStorage.getItem(`${storageKey()}.conversation`) || '[]'); if (Array.isArray(messages)) state.aiMessages = messages.filter(m => ['user','assistant'].includes(m.role) && typeof m.content === 'string').slice(-30); } catch { /* old chat ignored */ }
  renderAiMessages(); renderWorkspaces(); renderEmptyWorkspace(); saveWorkspaces();
  syncCodeSource();
}
function openWorkspaceDialog(edit = false) {
  closeWorkspaceMenu();
  state.editingWorkspace = edit;
  $('workspaceDialog').style.setProperty('--dialog-width', edit ? '520px' : '640px');
  $('workspaceDialogTitle').textContent = edit ? 'تغيير اسم المساحة' : 'مساحة عمل جديدة';
  $('saveWorkspaceButton').textContent = edit ? 'حفظ الاسم' : 'إنشاء المساحة';
  $('workspaceKinds').hidden = edit;
  $('workspaceName').value = edit ? activeWorkspace().name : '';
  if (!edit) $('workspaceForm').querySelector('input[value="database"]').checked = true;
  $('workspaceDialog').showModal(); $('workspaceName').focus();
}
const edgeRefs = new Map();
const graphPosition = id => state.focusPositions?.get(id) || state.topicPositions?.get(id) || state.positions.get(id);
function visibleTables() {
  if (state.viewMode === 'focus') {
    if (!state.focusTable) return [];
    const ids = new Set([state.focusTable]);
    for (const relation of state.schema.relations) {
      if (relation.source === state.focusTable) ids.add(relation.target);
      if (relation.target === state.focusTable) ids.add(relation.source);
    }
    return state.schema.tables.filter(table => ids.has(table.id));
  }
  if (state.viewMode === 'topics' && state.topic === 'all') return [];
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    const ids = state.groups.find(group => group.id === state.topic)?.ids;
    return state.schema.tables.filter(table => ids?.has(table.id));
  }
  return state.schema.tables;
}
function visibleRelations() {
  if (state.viewMode === 'focus') return state.schema.relations.filter(relation =>
    relation.source === state.focusTable || relation.target === state.focusTable);
  if (state.viewMode === 'topics' && state.topic === 'all') return [];
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    const ids = state.groups.find(group => group.id === state.topic)?.ids;
    return state.schema.relations.filter(relation => ids?.has(relation.source) && ids.has(relation.target));
  }
  return state.schema.relations;
}
function buildFocusPositions() {
  if (state.viewMode !== 'focus' || !state.focusTable) { state.focusPositions = null; return; }
  const center = state.schema.tables.find(table => table.id === state.focusTable);
  if (!center) { state.focusTable = null; state.focusPositions = null; return; }
  const neighbors = visibleTables().filter(table => table.id !== center.id);
  const sides = [[], []];
  neighbors.sort((a, b) => a.name.localeCompare(b.name));
  neighbors.forEach((table, index) => sides[index % 2].push(table));
  const height = tables => tables.reduce((total, table) => total + nodeHeight(table) + 82, 0);
  const totalHeight = Math.max(nodeHeight(center) + 200, height(sides[0]), height(sides[1]));
  const positions = new Map([[center.id, { x: 520, y: Math.round((totalHeight - nodeHeight(center)) / 2) }]]);
  sides.forEach((tables, side) => {
    let y = Math.round((totalHeight - height(tables)) / 2) + 45;
    for (const table of tables) { positions.set(table.id, { x: side === 0 ? 60 : 980, y }); y += nodeHeight(table) + 82; }
  });
  state.focusPositions = positions;
  try {
    const saved = JSON.parse(localStorage.getItem(`${storageKey()}.focusLayout.${state.focusTable}`) || '{}');
    for (const [id] of positions) {
      const point = saved[id];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) positions.set(id, point);
    }
  } catch { /* ignore invalid saved positions */ }
}
function buildTopicPositions() {
  if (state.viewMode !== 'topics' || state.topic === 'all') { state.topicPositions = null; return; }
  const group = state.groups.find(item => item.id === state.topic);
  if (!group) { state.topicPositions = null; return; }
  const tables = state.schema.tables.filter(table => group.ids.has(table.id));
  if (!tables.length) { state.topicPositions = new Map(); return; }
  const degree = new Map(tables.map(table => [table.id, 0]));
  for (const relation of state.schema.relations) if (degree.has(relation.source) && degree.has(relation.target)) {
    degree.set(relation.source, degree.get(relation.source) + 1);
    degree.set(relation.target, degree.get(relation.target) + 1);
  }
  tables.sort((a, b) => degree.get(b.id) - degree.get(a.id) || a.name.localeCompare(b.name));
  const columns = Math.max(1, Math.ceil(Math.sqrt(tables.length * 1.4)));
  const rows = Math.ceil(tables.length / columns);
  const cells = Array.from({ length: columns * rows }, (_, index) => ({ col: index % columns, row: Math.floor(index / columns) }));
  cells.sort((a, b) => {
    const distance = cell => Math.abs(cell.col - (columns - 1) / 2) + Math.abs(cell.row - (rows - 1) / 2);
    return distance(a) - distance(b) || a.row - b.row || a.col - b.col;
  });
  const assignments = tables.map((table, index) => ({ table, ...cells[index] }));
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...assignments.filter(item => item.row === row).map(item => nodeHeight(item.table))));
  const rowTops = []; let y = 70;
  for (const height of rowHeights) { rowTops.push(y); y += height + 120; }
  state.topicPositions = new Map(assignments.map(item => [item.table.id,
    { x: 80 + item.col * 440, y: rowTops[item.row] + Math.round((rowHeights[item.row] - nodeHeight(item.table)) / 2) }]));
  try {
    const saved = JSON.parse(localStorage.getItem(`${storageKey()}.topicLayout.${state.topic}`) || '{}');
    for (const table of tables) {
      const point = saved[table.id];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) state.topicPositions.set(table.id, point);
    }
  } catch { /* invalid topic layout is ignored */ }
}
const groupDefinitions = [
  { id: 'inventory', label: 'المخزون', color: '#6551C7', test: /product|stock|inventor|warehouse|location|batch|category|categor|variant|sku|مخزون|منتج|مستودع/i },
  { id: 'orders', label: 'الطلبات والمبيعات', color: '#C67966', test: /order|sale|cart|checkout|customer|client|invoice|payment|refund|طلب|عميل|فاتورة|دفع/i },
  { id: 'purchases', label: 'المشتريات والموردون', color: '#A38BCD', test: /purchase|supplier|vendor|shipment|receiv|procure|مورد|شراء|توريد/i },
  { id: 'access', label: 'المستخدمون والصلاحيات', color: '#7864C8', test: /user|role|permission|auth|session|account|profile|team|member|مستخدم|صلاحية/i },
  { id: 'messages', label: 'الرسائل والإشعارات', color: '#C98A9B', test: /message|notification|email|sms|alert|رسالة|إشعار/i }
];

function sampleSchema() {
  const t = (id, columns, description = '') => ({ id, schema: 'public', name: id, description, approxRows: 0,
    columns: columns.map((value, index) => {
      const [name, type, flags = ''] = value.split(':');
      return { number: index + 1, name, type, nullable: !flags.includes('!') && !flags.includes('p'), default: null,
        description: '', primary: flags.includes('p'), unique: flags.includes('u'), foreign: flags.includes('f') };
    }) });
  const tables = [
    t('products', ['id:uuid:p', 'sku:varchar:u', 'name:varchar:!', 'category_id:uuid:f', 'price:numeric:!', 'is_active:boolean:!'], 'المنتجات المتاحة للبيع والتخزين'),
    t('categories', ['id:uuid:p', 'name:varchar:!', 'parent_id:uuid:f'], 'تصنيفات المنتجات'),
    t('warehouses', ['id:uuid:p', 'code:varchar:u', 'name:varchar:!', 'city:varchar']),
    t('stock_levels', ['id:uuid:p', 'product_id:uuid:f', 'warehouse_id:uuid:f', 'quantity:integer:!', 'updated_at:timestamptz']),
    t('stock_movements', ['id:uuid:p', 'product_id:uuid:f', 'warehouse_id:uuid:f', 'quantity:integer:!', 'reason:varchar', 'created_at:timestamptz']),
    t('suppliers', ['id:uuid:p', 'name:varchar:!', 'email:varchar', 'phone:varchar']),
    t('purchase_orders', ['id:uuid:p', 'supplier_id:uuid:f', 'created_by:uuid:f', 'status:varchar:!', 'ordered_at:timestamptz']),
    t('purchase_items', ['id:uuid:p', 'purchase_order_id:uuid:f', 'product_id:uuid:f', 'quantity:integer:!', 'unit_cost:numeric:!']),
    t('customers', ['id:uuid:p', 'name:varchar:!', 'email:varchar:u', 'phone:varchar']),
    t('orders', ['id:uuid:p', 'customer_id:uuid:f', 'created_by:uuid:f', 'status:varchar:!', 'total:numeric:!', 'created_at:timestamptz']),
    t('order_items', ['id:uuid:p', 'order_id:uuid:f', 'product_id:uuid:f', 'quantity:integer:!', 'unit_price:numeric:!']),
    t('payments', ['id:uuid:p', 'order_id:uuid:f', 'amount:numeric:!', 'method:varchar:!', 'paid_at:timestamptz']),
    t('users', ['id:uuid:p', 'email:varchar:u', 'name:varchar:!', 'is_active:boolean:!']),
    t('roles', ['id:uuid:p', 'name:varchar:u', 'description:text']),
    t('user_roles', ['user_id:uuid:pf', 'role_id:uuid:pf', 'assigned_at:timestamptz'])
  ];
  const relations = [];
  function r(source, sourceColumn, target, targetColumn = 'id') {
    relations.push({ id: `${source}.${sourceColumn}`, name: `${source}_${sourceColumn}_fkey`, source, target,
      pairs: [{ source: sourceColumn, target: targetColumn }], onDelete: 'a', kind: 'actual' });
  }
  r('products', 'category_id', 'categories'); r('categories', 'parent_id', 'categories');
  r('stock_levels', 'product_id', 'products'); r('stock_levels', 'warehouse_id', 'warehouses');
  r('stock_movements', 'product_id', 'products'); r('stock_movements', 'warehouse_id', 'warehouses');
  r('purchase_orders', 'supplier_id', 'suppliers'); r('purchase_orders', 'created_by', 'users');
  r('purchase_items', 'purchase_order_id', 'purchase_orders'); r('purchase_items', 'product_id', 'products');
  r('orders', 'customer_id', 'customers'); r('orders', 'created_by', 'users');
  r('order_items', 'order_id', 'orders'); r('order_items', 'product_id', 'products');
  r('payments', 'order_id', 'orders'); r('user_roles', 'user_id', 'users'); r('user_roles', 'role_id', 'roles');
  return { database: 'متجر نموذجي', tables, relations, readOnly: true };
}

function topicIds(table) {
  const name = `${table.schema} ${table.name}`;
  const matches = groupDefinitions.filter(group => group.test.test(name)).map(group => group.id);
  return matches.length ? matches : ['other'];
}

function buildGroups() {
  if (state.customGroups) {
    const all = { id: 'all', label: 'الكل', color: '#746C8D', ids: new Set(state.schema.tables.map(t => t.id)) };
    state.groups = [all, ...state.customGroups.map(group => ({ ...group, ids: new Set(group.ids.filter(id => all.ids.has(id))) }))];
    if (!state.groups.some(group => group.id === state.topic)) state.topic = 'all';
    return;
  }
  if (state.workspaceId === SUFRA_PRODUCTS_ID) {
    const allIds = new Set(state.schema.tables.map(table => table.id));
    state.groups = [
      { id: 'all', label: 'الكل', color: '#746C8D', ids: allIds },
      ...sufraProductTopics.map(topic => ({
        ...topic,
        ids: new Set(topic.ids.filter(id => allIds.has(id)))
      }))
    ];
    return;
  }
  const memberships = new Map(state.schema.tables.map(table => [table.id, topicIds(table)]));
  const groups = [{ id: 'all', label: 'الكل', color: '#746C8D', ids: new Set(state.schema.tables.map(table => table.id)) }];
  for (const definition of groupDefinitions) {
    const ids = new Set(state.schema.tables.filter(table => memberships.get(table.id).includes(definition.id)).map(table => table.id));
    if (ids.size) groups.push({ ...definition, ids });
  }
  const otherIds = new Set(state.schema.tables.filter(table => memberships.get(table.id).includes('other')).map(table => table.id));
  if (otherIds.size) groups.push({ id: 'other', label: 'جداول أخرى', color: '#9C96AA', ids: otherIds });
  state.groups = groups;
  if (!groups.some(group => group.id === state.topic)) state.topic = 'all';
}

function groupForTable(table) {
  return state.groups.find(group => group.id !== 'all' && group.ids.has(table.id)) || state.groups[0];
}

function nodeExpanded() { return state.linkMode; }
function nodeHeight(table) { return measureNode(table, nodeExpanded(table)); }
function layoutTables(schema = state.schema, aiLayout = state.aiLayout) {
  const tables = [...schema.tables];
  if (!tables.length) return new Map();
  const byId = new Map(tables.map(table => [table.id, table]));
  const links = [];
  const adjacency = new Map(tables.map(table => [table.id, new Map()]));
  for (const relation of schema.relations) {
    if (relation.source === relation.target || !byId.has(relation.source) || !byId.has(relation.target)) continue;
    const weight = Math.max(1, relation.pairs?.length || 1);
    links.push({ source: relation.source, target: relation.target, weight });
    adjacency.get(relation.source).set(relation.target, (adjacency.get(relation.source).get(relation.target) || 0) + weight);
    adjacency.get(relation.target).set(relation.source, (adjacency.get(relation.target).get(relation.source) || 0) + weight);
  }

  // Degree carries most of the score. A short PageRank pass also rewards tables
  // connected to other important tables, which keeps the real schema hubs central.
  const count = tables.length;
  let pageRank = new Map(tables.map(table => [table.id, 1 / count]));
  for (let iteration = 0; iteration < 18; iteration++) {
    const next = new Map(tables.map(table => [table.id, .15 / count]));
    for (const table of tables) {
      const neighbors = adjacency.get(table.id);
      if (!neighbors.size) { next.set(table.id, next.get(table.id) + .85 * pageRank.get(table.id) / count); continue; }
      const totalWeight = [...neighbors.values()].reduce((sum, value) => sum + value, 0);
      for (const [neighbor, weight] of neighbors) next.set(neighbor, next.get(neighbor) + .85 * pageRank.get(table.id) * weight / totalWeight);
    }
    pageRank = next;
  }
  const degrees = new Map(tables.map(table => [table.id, [...adjacency.get(table.id).values()].reduce((sum, value) => sum + value, 0)]));
  const maxDegree = Math.max(1, ...degrees.values());
  const maxRank = Math.max(...pageRank.values());
  const score = id => .76 * degrees.get(id) / maxDegree + .24 * pageRank.get(id) / maxRank;
  const ordered = [...tables].sort((a, b) => score(b.id) - score(a.id) || a.name.localeCompare(b.name));
  const points = new Map();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const aiZones = aiLayout?.zones?.filter(zone => zone.tableIds?.length) || [];
  const zoneByTable = new Map();
  const zoneAnchors = new Map();
  const hasAiZones = aiZones.length > 1;
  if (hasAiZones) {
    aiZones.forEach((zone, index) => zone.tableIds.forEach(id => zoneByTable.set(id, index)));
    const centralIds = new Set(aiLayout.centralTableIds || []);
    const primaryIndex = aiZones.findIndex(zone => zone.tableIds.some(id => centralIds.has(id)));
    const zoneOrder = aiZones.map((zone, index) => ({ zone, index, weight: zone.tableIds.reduce((sum, id) => sum + score(id), 0) }))
      .sort((a, b) => (a.index === primaryIndex ? -1 : b.index === primaryIndex ? 1 : b.weight - a.weight));
    const outerCount = zoneOrder.length - 1;
    zoneOrder.forEach((item, order) => {
      if (order === 0) { zoneAnchors.set(item.index, { x: 0, y: 0 }); return; }
      const angle = -Math.PI / 2 + (order - 1) / outerCount * Math.PI * 2;
      const radius = 1280 + Math.min(4, outerCount) * 110;
      zoneAnchors.set(item.index, { x: Math.cos(angle) * radius * 1.42, y: Math.sin(angle) * radius * .78 });
    });
    for (const zone of aiZones) {
      const index = aiZones.indexOf(zone), anchor = zoneAnchors.get(index);
      zone.tableIds.map(id => byId.get(id)).filter(Boolean).sort((a, b) => score(b.id) - score(a.id) || a.name.localeCompare(b.name))
        .forEach((table, localIndex) => {
          const radius = localIndex ? 285 * Math.sqrt(localIndex) : 0;
          const angle = localIndex * goldenAngle;
          points.set(table.id, { x: anchor.x + Math.cos(angle) * radius * 1.25, y: anchor.y + Math.sin(angle) * radius * .78, vx: 0, vy: 0 });
        });
    }
  }
  ordered.forEach((table, index) => {
    if (points.has(table.id)) return;
    const radius = index ? 345 * Math.sqrt(index) : 0;
    const angle = index * goldenAngle;
    points.set(table.id, { x: Math.cos(angle) * radius * 1.72, y: Math.sin(angle) * radius * .62, vx: 0, vy: 0 });
  });

  const iterations = count > 150 ? 72 : count > 90 ? 92 : 118;
  const preferredLength = count > 110 ? 540 : 470;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cooling = 1 - iteration / iterations;
    const temperature = 8 + 54 * cooling;
    for (const point of points.values()) { point.vx = 0; point.vy = 0; }

    for (let aIndex = 0; aIndex < ordered.length; aIndex++) {
      const a = ordered[aIndex], ap = points.get(a.id);
      for (let bIndex = aIndex + 1; bIndex < ordered.length; bIndex++) {
        const b = ordered[bIndex], bp = points.get(b.id);
        let dx = bp.x - ap.x, dy = bp.y - ap.y;
        if (!dx && !dy) dx = .01;
        const distance2 = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distance2);
        const force = Math.min(54, 185000 / distance2);
        const fx = dx / distance * force, fy = dy / distance * force;
        ap.vx -= fx; ap.vy -= fy; bp.vx += fx; bp.vy += fy;

        const overlapX = (NODE_WIDTH + 94) - Math.abs(dx);
        const overlapY = ((nodeHeight(a) + nodeHeight(b)) / 2 + 70) - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = overlapX * .12 * (dx >= 0 ? 1 : -1);
            ap.vx -= push; bp.vx += push;
          } else {
            const push = overlapY * .12 * (dy >= 0 ? 1 : -1);
            ap.vy -= push; bp.vy += push;
          }
        }
      }
    }
    for (const link of links) {
      const a = points.get(link.source), b = points.get(link.target);
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const sameZone = hasAiZones && zoneByTable.get(link.source) === zoneByTable.get(link.target);
      const targetLength = preferredLength * (sameZone ? .92 : hasAiZones ? 1.62 : 1);
      const stretch = (distance - targetLength) * .014 * Math.min(2.2, link.weight);
      const fx = dx / distance * stretch, fy = dy / distance * stretch;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    ordered.forEach((table, index) => {
      const point = points.get(table.id);
      const pull = .003 + score(table.id) * .014;
      const globalPull = hasAiZones ? .34 : 1;
      point.vx -= point.x * pull * .64 * globalPull; point.vy -= point.y * pull * 1.16 * globalPull;
      const anchor = zoneAnchors.get(zoneByTable.get(table.id));
      if (anchor) { point.vx += (anchor.x - point.x) * .009; point.vy += (anchor.y - point.y) * .009; }
      if (index === 0 && !hasAiZones) { point.vx -= point.x * .18; point.vy -= point.y * .18; }
      const length = Math.max(1, Math.hypot(point.vx, point.vy));
      const step = Math.min(temperature, length);
      point.x += point.vx / length * step; point.y += point.vy / length * step;
    });
  }

  // A final collision pass preserves generous whitespace after the graph settles.
  for (let pass = 0; pass < 70; pass++) {
    let moved = false;
    for (let aIndex = 0; aIndex < ordered.length; aIndex++) {
      const a = ordered[aIndex], ap = points.get(a.id);
      for (let bIndex = aIndex + 1; bIndex < ordered.length; bIndex++) {
        const b = ordered[bIndex], bp = points.get(b.id);
        const dx = bp.x - ap.x || .01, dy = bp.y - ap.y || .01;
        const overlapX = NODE_WIDTH + 86 - Math.abs(dx);
        const overlapY = (nodeHeight(a) + nodeHeight(b)) / 2 + 62 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        if (overlapX < overlapY) {
          const push = overlapX / 2 + 1, direction = dx >= 0 ? 1 : -1;
          ap.x -= push * direction; bp.x += push * direction;
        } else {
          const push = overlapY / 2 + 1, direction = dy >= 0 ? 1 : -1;
          ap.y -= push * direction; bp.y += push * direction;
        }
      }
    }
    if (!moved) break;
  }
  const minX = Math.min(...ordered.map(table => points.get(table.id).x - NODE_WIDTH / 2));
  const minY = Math.min(...ordered.map(table => points.get(table.id).y - nodeHeight(table) / 2));
  const result = new Map(ordered.map(table => [table.id, {
    x: Math.round(points.get(table.id).x - NODE_WIDTH / 2 - minX + 110),
    y: Math.round(points.get(table.id).y - nodeHeight(table) / 2 - minY + 110)
  }]));

  // Match the graph footprint to the actual canvas. Large schemas previously
  // filled the height while wasting most of a wide monitor's horizontal space.
  if (count >= 18) {
    const viewport = $('viewport');
    const viewAspect = viewport?.clientWidth && viewport?.clientHeight ? viewport.clientWidth / viewport.clientHeight : 1.8;
    const left = Math.min(...ordered.map(table => result.get(table.id).x));
    const right = Math.max(...ordered.map(table => result.get(table.id).x + NODE_WIDTH));
    const top = Math.min(...ordered.map(table => result.get(table.id).y));
    const bottom = Math.max(...ordered.map(table => result.get(table.id).y + nodeHeight(table)));
    const graphWidth = right - left, graphHeight = bottom - top;
    const desiredAspect = Math.max(1.55, Math.min(2.75, viewAspect * .94));
    const desiredWidth = graphHeight * desiredAspect;
    const stretchX = Math.max(1, Math.min(2.8, (desiredWidth - NODE_WIDTH) / Math.max(1, graphWidth - NODE_WIDTH)));
    if (stretchX > 1.03) {
      const centerX = (left + right) / 2;
      for (const table of ordered) {
        const point = result.get(table.id);
        const nodeCenter = point.x + NODE_WIDTH / 2;
        point.x = Math.round(centerX + (nodeCenter - centerX) * stretchX - NODE_WIDTH / 2);
      }
    }
  }
  return result;
}

function storageKey() {
  if (state.workspaceId && state.workspaceId !== 'legacy') return `eratlas.v4.ws.${state.workspaceId}`;
  const signature = state.base.tables.map(t => `${t.schema}.${t.name}`).sort().join('|');
  return `eratlas.v4.${state.demo ? 'demo' : 'db'}.${state.base.database}.${signature}`;
}
function aiLayoutKey() { return `${storageKey()}.ai-layout`; }
function saveAiLayout() { localStorage.setItem(aiLayoutKey(), JSON.stringify(state.aiLayout)); }

function loadPositions() {
  state.positions = layoutTables();
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {};
    for (const table of state.schema.tables) {
      const point = saved[table.id];
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) state.positions.set(table.id, point);
    }
  } catch { /* invalid old layout is ignored */ }

  if (state.workspaceId === SUFRA_PRODUCTS_ID) {
    positionProposedDevices(saved);
  }
}

function positionProposedDevices(saved) {
  const deviceIds = new Set(['store_devices', 'users']);
  const currentTables = state.schema.tables.filter(table => !deviceIds.has(table.id));
  const rightEdge = Math.max(
    0,
    ...currentTables.map(table => state.positions.get(table.id).x + NODE_WIDTH)
  );
  const storePosition = state.positions.get('stores');
  const x = Math.round(rightEdge + 520);
  const y = Math.round(storePosition?.y || 0);

  if (!saved.store_devices) {
    state.positions.set('store_devices', { x, y });
  }

  if (!saved.users) {
    const device = state.schema.tables.find(table => table.id === 'store_devices');
    const devicePosition = state.positions.get('store_devices');
    const gap = device ? nodeHeight(device) + 120 : 680;
    state.positions.set('users', {
      x: devicePosition?.x ?? x,
      y: (devicePosition?.y ?? y) + gap
    });
  }
}

function savePositions() {
  localStorage.setItem(storageKey(), JSON.stringify(Object.fromEntries(state.positions)));
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderTopics() {
  const nav = $('topics');
  nav.replaceChildren();
  $('currentTopicLabel').textContent = state.groups.find(group => group.id === state.topic)?.label || 'كل الجداول';
  for (const group of state.groups) {
    const button = el('button', `topic${state.topic === group.id ? ' active' : ''}`);
    button.type = 'button'; button.dataset.topic = group.id;
    button.style.setProperty('--topic-color', group.color);
    button.setAttribute('aria-pressed', state.topic === group.id ? 'true' : 'false');
    button.append(el('span', 'topic-dot'), el('span', '', group.label), el('span', 'topic-count', String(group.ids.size)));
    button.addEventListener('click', () => {
      closeHeaderMenus();
      if (group.id !== 'all' && state.viewMode !== 'topics') state.viewMode = 'topics';
      activeWorkspace().viewMode = state.viewMode;
      state.topic = group.id; activeWorkspace().topic = group.id; saveWorkspaces();
      buildTopicPositions(); renderTopics(); renderView(); renderNodes(); fitView(group.id !== 'all');
    });
    nav.append(button);
  }
}

const viewChoices = [
  { id: 'map', icon: '▦', label: 'الخريطة', description: 'كل الجداول والعلاقات مباشرة' },
  { id: 'tables', label: 'الجداول', description: 'قائمة الجداول والأعمدة والعلاقات' },
  { id: 'topics', icon: '◫', label: 'حسب المواضيع', description: 'ابدأ بالأقسام ثم افتح جداولها' },
  { id: 'focus', icon: '◎', label: 'جدول محدد', description: 'جدول واحد وعلاقاته المباشرة' }
];
function closeViewMenu() {
  $('viewModeMenu').hidden = true;
  $('viewModeButton').setAttribute('aria-expanded', 'false');
}
function renderViewMenu() {
  const options = $('viewModeOptions'); options.replaceChildren();
  for (const choice of viewChoices) {
    const button = el('button', `view-option${state.viewMode === choice.id ? ' active' : ''}`);
    button.type = 'button'; button.setAttribute('aria-pressed', String(state.viewMode === choice.id));
    button.append(icon(choice.id === 'focus' ? 'fit' : choice.id === 'topics' ? 'arrange' : 'table'));
    const copy = el('span', 'view-option-copy');
    copy.append(el('strong', '', choice.label), el('small', '', choice.description));
    button.append(copy); if (state.viewMode === choice.id) button.append(icon('check'));
    button.addEventListener('click', () => { closeViewMenu(); setViewMode(choice.id); });
    options.append(button);
  }
  $('viewModeLabel').textContent = viewChoices.find(choice => choice.id === state.viewMode).label;
}
function renderTopicOverview(overlay) {
  const heading = el('div', 'view-overlay-heading');
  heading.append(el('span', 'view-overlay-kicker', 'DATABASE / OVERVIEW'),
    el('h2', '', 'مواضيع قاعدة البيانات'),
    el('p', '', 'اختر موضوعًا لعرض جداوله وعلاقاته بوضوح.'));
  const grid = el('div', 'topic-overview-grid');
  for (const group of state.groups.filter(item => item.id !== 'all' && item.ids.size)) {
    const relationships = state.schema.relations.filter(relation => group.ids.has(relation.source) && group.ids.has(relation.target)).length;
    const button = el('button', 'topic-overview-card'); button.type = 'button';
    button.style.setProperty('--topic-color', group.color);
    const top = el('span', 'topic-overview-top');
    top.append(icon('table'), icon('chevron'));
    button.append(top, el('strong', '', group.label),
      el('span', 'topic-overview-meta', `${group.ids.size} جدول · ${relationships} علاقة داخلية`));
    button.addEventListener('click', () => {
      state.topic = group.id; activeWorkspace().topic = group.id; saveWorkspaces();
      buildTopicPositions(); renderTopics(); renderView(); renderNodes(); fitView(true);
    });
    grid.append(button);
  }
  overlay.append(heading, grid);
}
function renderFocusPicker(overlay) {
  const heading = el('div', 'view-overlay-heading');
  heading.append(el('span', 'view-overlay-kicker', 'TABLE / FOCUS'),
    el('h2', '', 'اختر جدولًا'), el('p', '', 'اعرض الجدول وأعمدته وعلاقاته المباشرة.'));
  const search = el('input', 'focus-search'); search.type = 'search';
  search.placeholder = 'ابحث عن اسم جدول...'; search.setAttribute('aria-label', 'ابحث عن جدول للتركيز');
  const list = el('div', 'focus-table-list');
  const tables = [...state.schema.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const table of tables) {
    const button = el('button', 'focus-table-option'); button.type = 'button';
    const mark = icon('table');
    const copy = el('span', 'focus-table-copy');
    copy.append(el('strong', '', table.name), el('small', '', `${table.schema} · ${table.columns.length} عمود`));
    button.append(mark, copy, icon('chevron'));
    button.addEventListener('click', () => chooseFocusTable(table.id));
    list.append(button);
  }
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    tables.forEach((table, index) => { list.children[index].hidden = !`${table.schema}.${table.name}`.toLowerCase().includes(term); });
  });
  overlay.append(heading, search, list);
}
function renderView() {
  renderViewMenu();
  const catalog = state.viewMode === 'tables' && state.schema.tables.length > 0;
  const topicOverview = state.viewMode === 'topics' && state.topic === 'all' && state.schema.tables.length > 0;
  const focusPicker = state.viewMode === 'focus' && !state.focusTable && state.schema.tables.length > 0;
  const overlay = $('viewOverlay'); overlay.replaceChildren();
  overlay.hidden = !catalog && !topicOverview && !focusPicker;
  $('map').classList.toggle('show-view-overlay', !overlay.hidden);
  if (topicOverview) renderTopicOverview(overlay);
  if (focusPicker) renderFocusPicker(overlay);
  if (catalog) renderTableCatalog(overlay);
  for (const [id, selected] of [['mapTabButton', !catalog], ['tablesTabButton', catalog]]) {
    $(id).classList.toggle('active', selected);
    $(id).setAttribute('aria-pressed', String(selected));
  }
  $('backTopicsButton').hidden = state.viewMode !== 'topics' || topicOverview;
  $('chooseFocusButton').hidden = state.viewMode !== 'focus' || focusPicker;
  $('topicManageButton').hidden = false;
  $('arrangeButton').hidden = !overlay.hidden;
  $('aiArrangeButton').disabled = !visibleTables().length;
  $('arrangeWithAiButton').disabled = !visibleTables().length;
  updateViewCounts();
}
function renderTableCatalog(overlay) {
  const heading = el('div', 'catalog-heading');
  const copy = el('div'); copy.append(el('h2', '', 'الجداول'), el('p', '', 'اختر جدولًا لعرض أعمدته وعلاقاته على الخريطة.'));
  heading.append(copy);
  const search = el('input', 'catalog-search'); search.type = 'search'; search.placeholder = 'ابحث باسم جدول أو عمود…'; search.setAttribute('aria-label', 'البحث في قائمة الجداول');
  heading.append(search);
  const list = el('div', 'table-catalog');
  const empty = el('p', 'catalog-empty', 'لا يوجد جدول مطابق. جرّب اسمًا آخر.'); empty.hidden = true;
  const tables = [...state.schema.tables].sort((a, b) => a.name.localeCompare(b.name));
  const rows = tables.map(table => {
    const row = uiButton('', () => {
      setViewMode('map'); selectTable(table.id); centerTable(table.id);
    }, 'catalog-row');
    const name = el('span', 'catalog-name'); name.append(icon('table'), el('strong', '', table.name)); name.dir = 'ltr';
    const relations = state.schema.relations.filter(relation => relation.source === table.id || relation.target === table.id).length;
    const columns = el('span', 'catalog-count', `${table.columns.length} أعمدة`);
    const related = el('span', 'catalog-count', `${relations} علاقات`);
    const topicNames = state.groups.filter(group => group.id !== 'all' && group.ids.has(table.id)).map(group => group.label);
    const topics = el('span', 'catalog-topics', topicNames.join('، ') || table.schema); topics.title = topics.textContent;
    row.append(name, columns, related, topics, icon('chevron')); list.append(row); return row;
  });
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    rows.forEach((row, i) => { row.hidden = !`${tables[i].schema}.${tables[i].name} ${tables[i].columns.map(column => column.name).join(' ')}`.toLowerCase().includes(term); });
    empty.hidden = rows.some(row => !row.hidden);
  });
  overlay.append(heading, list, empty);
}
function updateViewCounts() {
  const overview = state.viewMode === 'topics' && state.topic === 'all';
  const tables = overview ? state.schema.tables : visibleTables();
  const ids = new Set(tables.map(table => table.id));
  const relations = overview ? state.schema.relations : visibleRelations().filter(relation => ids.has(relation.source) && ids.has(relation.target));
  $('tableCount').textContent = `${tables.length} جدول`;
  $('relationCount').textContent = `${relations.length} علاقة`;
}
function setViewMode(mode) {
  if (state.viewMode === mode) return;
  const selected = state.selectedTable;
  state.viewMode = mode; state.topic = 'all'; state.selectedTable = null; state.selectedRelation = null;
  state.hoveredTable = null; $('details').hidden = true;
  if (mode === 'focus') state.focusTable = selected || state.focusTable || activeWorkspace().focusTable || null;
  buildFocusPositions(); buildTopicPositions();
  activeWorkspace().viewMode = mode; activeWorkspace().topic = 'all'; saveWorkspaces();
  renderTopics(); renderView(); renderNodes(); fitView(false);
}
function chooseFocusTable(id) {
  if (!state.schema.tables.some(table => table.id === id)) return;
  state.focusTable = id; activeWorkspace().focusTable = id; state.selectedTable = null;
  state.selectedRelation = null; state.hoveredTable = null;
  buildFocusPositions(); saveWorkspaces();
  renderView(); renderNodes(); fitView(false);
}

function makeNode(table) {
  const card = el('article', `table-node${table.kind === 'proposed' ? ' proposed' : ''}`);
  card.dataset.table = table.id;
  const pos = graphPosition(table.id);
  card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`;
  card.style.setProperty('--node-color', groupForTable(table).color);
  const head = el('div', 'node-head');
  const name = el('div', 'node-name', table.name); name.title = table.name;
  const more = uiButton('', event => { event.stopPropagation(); showContextMenu(event); }, 'node-more');
  more.append(icon('more')); more.setAttribute('aria-label', `إجراءات جدول ${table.name}`);
  more.addEventListener('pointerdown', event => event.stopPropagation());
  head.append(icon('table'), name, more);
  head.addEventListener('pointerdown', event => startDrag(event, table.id, card));
  const columns = el('div', 'node-columns');
  const involved = new Set(state.schema.relations.flatMap(relation => {
    const values = [];
    for (const pair of relation.pairs) {
      if (relation.source === table.id) values.push(pair.source);
      if (relation.target === table.id) values.push(pair.target);
    }
    return values;
  }));
  for (const column of previewColumns(table, nodeExpanded(table))) {
    const row = el('div', `column${involved.has(column.name) ? ' has-line' : ''}${column.kind === 'proposed' ? ' proposed' : ''}`);
    row.dataset.column = column.name;
    row.title = `${column.name} · ${column.type}${column.nullable ? ' · nullable' : ' · not null'}`;
    const left = el('span', 'col-name', column.name);
    const badge = el('span', `col-key${column.foreign && !column.primary ? ' fk' : ''}${!column.primary && !column.foreign ? ' none' : ''}`);
    badge.append(icon(column.primary ? 'key' : 'link')); left.prepend(badge);
    row.append(left, el('span', 'col-type', column.type));
    row.addEventListener('click', event => {
      if (!state.linkMode) return;
      event.stopPropagation();
      chooseLinkColumn(table.id, column.name);
    });
    columns.append(row);
  }
  card.append(head, columns);
  const footer = uiButton('', event => {
    event.stopPropagation();
    openExpandedTable(table.id);
  }, 'node-expand');
  footer.setAttribute('aria-label', `عرض كل أعمدة ${table.name}`);
  footer.setAttribute('aria-haspopup', 'dialog');
  footer.append(icon('chevron'), el('span', '', `عرض كل الأعمدة (${table.columns.length})`));
  footer.addEventListener('pointerdown', event => event.stopPropagation());
  card.append(footer);
  card.tabIndex = 0; card.setAttribute('aria-label', `جدول ${table.name}`);
  card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectTable(table.id); } });
  card.addEventListener('click', event => {
    if (performance.now() < state.suppressClickUntil) return;
    selectTable(table.id, { inspect: false });
  });
  card.addEventListener('dblclick', () => selectTable(table.id));
  card.title = 'انقر للتحديد، وانقر مرتين أو اضغط Enter لعرض التفاصيل';
  card.addEventListener('mouseenter', () => {
    state.hoveredTable = table.id;
    updateEmphasis();
  });
  card.addEventListener('mouseleave', () => {
    if (state.hoveredTable === table.id) {
      state.hoveredTable = null;
      updateEmphasis();
    }
  });
  return card;
}

function renderNodes() {
  const container = $('nodes');
  const tables = visibleTables();
  $('viewport').classList.toggle('canvas-edges', tables.length > 35);
  container.replaceChildren(...tables.map(makeNode));
  state.edgeRoutes = null;
  renderEdges();
  updateEmphasis();
  scheduleView();
}

function anchor(table, columnName, side) {
  const pos = graphPosition(table.id);
  return {
    x: pos.x + (side === 'right' ? NODE_WIDTH : 0),
    y: pos.y + columnOffset(table, columnName, nodeExpanded(table))
  };
}

function routingBoxes() {
  return visibleTables().map(table => {
    const position = graphPosition(table.id);
    return { id: table.id, left: position.x, right: position.x + NODE_WIDTH,
      top: position.y, bottom: position.y + nodeHeight(table) };
  });
}

function routingConnection(source, target, pair, lane, key) {
  return { key, sourceId: source.id, targetId: target.id, lane,
    source: { left: anchor(source, pair.source, 'left'), right: anchor(source, pair.source, 'right') },
    target: { left: anchor(target, pair.target, 'left'), right: anchor(target, pair.target, 'right') } };
}

function edgePath(sourceTable, targetTable, pair, lane = 0) {
  const sourcePos = graphPosition(sourceTable.id);
  const targetPos = graphPosition(targetTable.id);
  if (sourceTable.id === targetTable.id) {
    const a = anchor(sourceTable, pair.source, 'right');
    const b = anchor(targetTable, pair.target, 'right');
    const loop = 82 + Math.abs(a.y - b.y) * .25 + Math.abs(lane);
    return { d: `M ${a.x} ${a.y} C ${a.x + loop} ${a.y - 25}, ${b.x + loop} ${b.y + 25}, ${b.x} ${b.y}`, a, b };
  }
  if (Math.abs(sourcePos.x - targetPos.x) < NODE_WIDTH * .6) {
    const useRight = sourcePos.x > 180 && lane > 0;
    const side = useRight ? 'right' : 'left';
    const a = anchor(sourceTable, pair.source, side);
    const b = anchor(targetTable, pair.target, side);
    const outerX = side === 'left' ? Math.min(a.x, b.x) - 92 - Math.abs(lane) : Math.max(a.x, b.x) + 92 + Math.abs(lane);
    return { d: `M ${a.x} ${a.y} L ${outerX} ${a.y} C ${outerX + lane * .15} ${a.y}, ${outerX + lane * .15} ${b.y}, ${outerX} ${b.y} L ${b.x} ${b.y}`, a, b };
  }
  const sourceSide = sourcePos.x + NODE_WIDTH / 2 < targetPos.x + NODE_WIDTH / 2 ? 'right' : 'left';
  const targetSide = sourceSide === 'right' ? 'left' : 'right';
  const a = anchor(sourceTable, pair.source, sourceSide);
  const b = anchor(targetTable, pair.target, targetSide);
  const direction = sourceSide === 'right' ? 1 : -1;
  const sourceStub = a.x + 34 * direction, targetStub = b.x - 34 * direction;
  const center = (sourceStub + targetStub) / 2 + lane;
  return { d: `M ${a.x} ${a.y} L ${sourceStub} ${a.y} C ${center} ${a.y}, ${center} ${b.y}, ${targetStub} ${b.y} L ${b.x} ${b.y}`, a, b };
}

function syncEdgeAnnotations(ref, path) {
  const a = path.points?.[0] || path.a, b = path.points?.at(-1) || path.b;
  if (!a || !b) return;
  const sourceSide = Math.abs(a.x - graphPosition(ref.source.id).x) < 1 ? -1 : 1;
  const targetSide = Math.abs(b.x - graphPosition(ref.target.id).x) < 1 ? -1 : 1;
  ref.arrow = { x: b.x, y: b.y, direction: -targetSide };
  ref.annotations = [];
  for (const [side, point, outward] of [['source', a, sourceSide], ['target', b, targetSide]]) {
    const label = ref.labels?.[side];
    if (!label) continue;
    const annotation = { x: point.x + outward * 18, y: point.y - 10, text: label.textContent };
    label.setAttribute('x', annotation.x);
    label.setAttribute('y', annotation.y);
    ref.annotations.push(annotation);
  }
}

function renderEdges() {
  const generation = ++state.routeGeneration;
  const svg = $('edges');
  const canvasMode = visibleTables().length > 35;
  svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  const marker = document.createElementNS(ns, 'marker');
  marker.setAttribute('id', 'relation-direction');
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '8'); marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '8'); marker.setAttribute('markerHeight', '8');
  marker.setAttribute('markerUnits', 'userSpaceOnUse'); marker.setAttribute('orient', 'auto');
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M 1 1 L 7 4 L 1 7');
  arrow.setAttribute('fill', 'none'); arrow.setAttribute('stroke', 'context-stroke');
  arrow.setAttribute('stroke-width', '1.5');
  marker.append(arrow); defs.append(marker); svg.append(defs);
  edgeRefs.clear();
  const byId = new Map(visibleTables().map(table => [table.id, table]));
  const laneKeyFor = (source, target) => {
    const sourceColumn = Math.round(graphPosition(source.id).x / (NODE_WIDTH + 170));
    const targetColumn = Math.round(graphPosition(target.id).x / (NODE_WIDTH + 170));
    return `${Math.min(sourceColumn, targetColumn)}:${Math.max(sourceColumn, targetColumn)}`;
  };
  const laneTotals = new Map();
  for (const relation of visibleRelations()) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    const key = laneKeyFor(source, target);
    laneTotals.set(key, (laneTotals.get(key) || 0) + relation.pairs.length);
  }
  const lanes = new Map();
  const connections = [];
  for (const relation of visibleRelations()) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    relation.pairs.forEach((pair, index) => {
      const laneKey = laneKeyFor(source, target);
      const laneIndex = lanes.get(laneKey) || 0; lanes.set(laneKey, laneIndex + 1);
      const laneTotal = laneTotals.get(laneKey) || 1;
      const lane = laneTotal === 1 ? 0 : (laneIndex - (laneTotal - 1) / 2) * Math.min(20, 120 / laneTotal);
      const key = `${relation.id}:${index}`;
      connections.push({ relation, source, target, pair, lane, key,
        input: routingConnection(source, target, pair, lane, key) });
    });
  }
  if (!state.edgeRoutes && visibleTables().length <= 35) {
    state.edgeRoutes = routeConnections(connections.map(item => item.input), routingBoxes());
  } else if (!state.edgeRoutes && connections.length) {
    if (!state.routeWorker) {
      state.routeWorker = new Worker('/route-worker.js', { type: 'module' });
      state.routeWorker.onmessage = event => {
        if (event.data.generation !== state.routeGeneration) return;
        state.edgeRoutes = new Map(event.data.routes);
        for (const refs of edgeRefs.values()) for (const ref of refs) {
          const route = state.edgeRoutes.get(ref.key);
          if (!route) continue;
          ref.bounds = route.bounds;
          ref.line.setAttribute('d', route.d);
          ref.hit.setAttribute('d', route.d);
          ref.canvasPath = new Path2D(route.d);
          syncEdgeAnnotations(ref, route);
        }
        scheduleView();
      };
      state.routeWorker.onerror = () => { state.routeWorker?.terminate(); state.routeWorker = null; };
    }
    state.routeWorker.postMessage({ generation, connections: connections.map(item => item.input), boxes: routingBoxes() });
  }
  for (const item of connections) {
      const { relation, source, target, pair, lane, key } = item;
      const path = state.edgeRoutes?.get(key) || edgePath(source, target, pair, lane);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', path.d);
      line.setAttribute('class', `edge${relation.kind === 'proposed' ? ' proposed' : ''}`);
      line.setAttribute('marker-end', 'url(#relation-direction)');
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', path.d); hit.setAttribute('class', 'edge hit');
      hit.dataset.relation = relation.id;
      hit.addEventListener('click', event => { event.stopPropagation(); selectRelation(relation.id); });
      const labels = {};
      // Composite foreign keys have one multiplicity, not one per column pair.
      if (key.endsWith(':0')) {
        const cardinality = relationCardinality(relation, source, target);
        for (const side of ['source', 'target']) {
          if (!cardinality[side]) continue;
          const label = document.createElementNS(ns, 'text');
          label.setAttribute('class', 'edge-cardinality');
          label.setAttribute('text-anchor', 'middle');
          label.textContent = cardinality[side];
          labels[side] = label;
        }
      }
      if (!canvasMode) svg.append(line, ...Object.values(labels), hit);
      if (!edgeRefs.has(relation.id)) edgeRefs.set(relation.id, []);
      const ref = { line, hit, source, target, pair, lane, key, labels,
        bounds: path.bounds, canvasPath: new Path2D(path.d) };
      syncEdgeAnnotations(ref, path);
      edgeRefs.get(relation.id).push(ref);
  }
  updateEdgeEmphasis();
  scheduleView();
}

function updateEdgesForTable(id) {
  for (const relation of visibleRelations()) {
    if (relation.source !== id && relation.target !== id) continue;
    for (const ref of edgeRefs.get(relation.id) || []) {
      const path = edgePath(ref.source, ref.target, ref.pair, ref.lane);
      ref.bounds = { left: Math.min(path.a.x, path.b.x) - 120, right: Math.max(path.a.x, path.b.x) + 120,
        top: Math.min(path.a.y, path.b.y) - 120, bottom: Math.max(path.a.y, path.b.y) + 120 };
      ref.line.setAttribute('d', path.d); ref.hit.setAttribute('d', path.d);
      ref.canvasPath = new Path2D(path.d);
      syncEdgeAnnotations(ref, path);
    }
  }
  scheduleView();
}

function updateEdgeEmphasis() {
  const active = state.groups.find(group => group.id === state.topic)?.ids;
  const search = $('searchInput').value.trim().toLowerCase();
  const matches = search ? searchMatches(search) : null;
  const focusTable = state.hoveredTable || state.selectedTable;
  for (const [relationId, refs] of edgeRefs) {
    for (const ref of refs) {
      const incident = Boolean(focusTable && (ref.source.id === focusTable || ref.target.id === focusTable));
      const dimmed = (state.topic !== 'all' && !(active.has(ref.source.id) && active.has(ref.target.id))) ||
        (matches && !(matches.has(ref.source.id) && matches.has(ref.target.id))) || (focusTable && !incident);
      const focused = state.topic !== 'all' && active.has(ref.source.id) && active.has(ref.target.id);
      const selected = state.selectedRelation === relationId || state.selectedTable === ref.source.id || state.selectedTable === ref.target.id;
      ref.line.classList.toggle('focused', Boolean(focused));
      ref.line.classList.toggle('trace', incident);
      ref.line.classList.toggle('selected', Boolean(selected));
      ref.line.classList.toggle('dimmed', Boolean(dimmed && !selected));
      const proposed = ref.line.classList.contains('proposed');
      ref.canvasStyle = {
        stroke: selected ? '#6551c7' : incident ? '#5d45c3' : focused ? '#6d58c6' : proposed ? '#8164d2' : '#9288af',
        opacity: dimmed && !selected ? .55 : selected || incident ? 1 : proposed ? .88 : focused ? .8 : .75,
        width: selected ? 2.5 : incident ? 2.25 : focused ? 1.7 : 1.6,
        proposed
      };
    }
  }
  scheduleView();
}

function searchMatches(search) {
  return new Set(state.schema.tables.filter(table =>
    table.name.toLowerCase().includes(search) || table.schema.toLowerCase().includes(search) ||
    table.columns.some(column => column.name.toLowerCase().includes(search))
  ).map(table => table.id));
}

function updateEmphasis() {
  const active = state.groups.find(group => group.id === state.topic)?.ids;
  const search = $('searchInput').value.trim().toLowerCase();
  const matches = search ? searchMatches(search) : null;
  const focusTable = state.hoveredTable || state.selectedTable;
  const neighbors = new Set();
  if (focusTable) {
    for (const relation of state.schema.relations) {
      if (relation.source === focusTable) neighbors.add(relation.target);
      if (relation.target === focusTable) neighbors.add(relation.source);
    }
  }
  for (const card of $('nodes').children) {
    const id = card.dataset.table;
    const unrelated = focusTable && id !== focusTable && !neighbors.has(id);
    const dim = (state.topic !== 'all' && !active.has(id)) || (matches && !matches.has(id)) || unrelated;
    card.classList.toggle('dimmed', Boolean(dim && state.selectedTable !== id));
    card.classList.toggle('selected', state.selectedTable === id);
    card.classList.toggle('neighbor', Boolean(focusTable && neighbors.has(id)));
  }
  updateEdgeEmphasis();
}

function updateVisible() {
  const viewport = $('viewport');
  const margin = 350 / state.scale;
  const visible = { left: -state.x / state.scale - margin, top: -state.y / state.scale - margin,
    right: (viewport.clientWidth - state.x) / state.scale + margin,
    bottom: (viewport.clientHeight - state.y) / state.scale + margin };
  const overlaps = box => box && box.left <= visible.right && box.right >= visible.left && box.top <= visible.bottom && box.bottom >= visible.top;
  const byId = new Map(state.schema.tables.map(table => [table.id, table]));
  for (const card of $('nodes').children) {
    const table = byId.get(card.dataset.table), pos = graphPosition(card.dataset.table);
    if (!table || !pos) continue;
    const show = overlaps({ left: pos.x, right: pos.x + NODE_WIDTH, top: pos.y, bottom: pos.y + nodeHeight(table) });
    if (card._visible !== show) { card._visible = show; card.classList.toggle('offscreen', !show); }
  }
  for (const refs of edgeRefs.values()) for (const ref of refs) {
    const show = !ref.bounds || overlaps(ref.bounds);
    if (ref._visible !== show) {
      ref._visible = show;
      ref.line.classList.toggle('offscreen', !show);
      ref.hit.classList.toggle('offscreen', !show);
      for (const label of Object.values(ref.labels || {})) label.classList.toggle('offscreen', !show);
    }
  }
}

function drawCanvasEdges() {
  const canvas = $('edgeCanvas');
  if (!$('viewport').classList.contains('canvas-edges')) return;
  const viewport = $('viewport'), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(viewport.clientWidth * dpr));
  const height = Math.max(1, Math.round(viewport.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(dpr * state.scale, 0, 0, dpr * state.scale, dpr * state.x, dpr * state.y);
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (const refs of edgeRefs.values()) for (const ref of refs) {
    if (ref._visible === false || !ref.canvasPath || !ref.canvasStyle) continue;
    context.strokeStyle = ref.canvasStyle.stroke;
    context.globalAlpha = ref.canvasStyle.opacity;
    context.lineWidth = Math.max(ref.canvasStyle.width, 1.2 / state.scale);
    context.setLineDash(ref.canvasStyle.proposed ? [6, 6] : []);
    context.stroke(ref.canvasPath);
    context.setLineDash([]);
    if (ref.arrow) {
      const { x, y, direction } = ref.arrow;
      context.beginPath();
      context.moveTo(x - direction * 7, y - 3.5);
      context.lineTo(x - direction, y);
      context.lineTo(x - direction * 7, y + 3.5);
      context.stroke();
    }
    context.font = '600 13px "Roboto Mono", monospace';
    context.textAlign = 'center';
    context.fillStyle = '#5f5674';
    context.strokeStyle = '#fcfbfd'; context.lineWidth = 4;
    context.globalAlpha = 1;
    for (const annotation of ref.annotations || []) {
      context.strokeText(annotation.text, annotation.x, annotation.y);
      context.fillText(annotation.text, annotation.x, annotation.y);
    }
  }
  context.globalAlpha = 1;
}

function canvasRelationAt(clientX, clientY) {
  if (!$('viewport').classList.contains('canvas-edges')) return null;
  const rect = $('viewport').getBoundingClientRect();
  const x = (clientX - rect.left - state.x) / state.scale;
  const y = (clientY - rect.top - state.y) / state.scale;
  const context = $('edgeCanvas').getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.lineWidth = 10 / state.scale;
  for (const [relationId, refs] of [...edgeRefs].reverse()) {
    for (const ref of [...refs].reverse()) {
      if (ref._visible !== false && ref.canvasPath && context.isPointInStroke(ref.canvasPath, x, y)) return relationId;
    }
  }
  return null;
}

function scheduleView() {
  if (!state.schema) return;
  if (state.viewFrame) return;
  state.viewFrame = requestAnimationFrame(() => {
    state.viewFrame = null;
    $('viewport').classList.toggle('overview', visibleTables().length > 35 && state.scale < .42);
    $('world').style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    $('zoomLabel').textContent = `${Math.round(state.scale * 100)}%`;
    updateVisible();
    drawCanvasEdges();
  });
}

function transform() {
  scheduleView();
}

function fitView(focusTopic = false, { overview = false } = {}) {
  const viewport = $('viewport');
  const ids = focusTopic && state.viewMode === 'map' ? state.groups.find(group => group.id === state.topic)?.ids : null;
  const tables = ids ? state.schema.tables.filter(table => ids.has(table.id)) : visibleTables();
  if (!tables.length) { state.scale = 1; state.x = 0; state.y = 0; transform(); return; }
  const minX = Math.min(...tables.map(table => graphPosition(table.id).x));
  const minY = Math.min(...tables.map(table => graphPosition(table.id).y));
  const maxX = Math.max(...tables.map(table => graphPosition(table.id).x + NODE_WIDTH));
  const maxY = Math.max(...tables.map(table => graphPosition(table.id).y + nodeHeight(table)));
  const idsInView = new Set(tables.map(table => table.id));
  const degree = new Map(tables.map(table => [table.id, 0]));
  for (const relation of visibleRelations()) {
    if (idsInView.has(relation.source)) degree.set(relation.source, degree.get(relation.source) + 1);
    if (idsInView.has(relation.target)) degree.set(relation.target, degree.get(relation.target) + 1);
  }
  const centerTable = tables.find(table => table.id === (state.selectedTable || state.focusTable)) || [...tables].sort((a, b) => degree.get(b.id) - degree.get(a.id))[0];
  const point = graphPosition(centerTable.id);
  Object.assign(state, fitCamera({ width: maxX - minX, height: maxY - minY, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } },
    { width: viewport.clientWidth, height: Math.max(160, viewport.clientHeight - 88) }, { overview, center: { x: point.x + NODE_WIDTH / 2, y: point.y + nodeHeight(centerTable) / 2 } }));
  transform();
}
function centerTable(id) {
  const viewport = $('viewport');
  const table = state.schema.tables.find(item => item.id === id); if (!table) return;
  const point = graphPosition(id);
  state.scale = 1;
    const panelWidth = !$('details').hidden && viewport.clientWidth > 800 ? $('details').offsetWidth : 0;
  state.x = (viewport.clientWidth - panelWidth) / 2 - (point.x + NODE_WIDTH / 2);
  state.y = viewport.clientHeight / 2 - (point.y + nodeHeight(table) / 2);
  transform();
}

function zoom(factor, clientX, clientY) {
  const rect = $('viewport').getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const next = Math.max(.15, Math.min(2, state.scale * factor));
  const ratio = next / state.scale;
  state.x = px - (px - state.x) * ratio;
  state.y = py - (py - state.y) * ratio;
  state.scale = next;
  transform();
}

function startDrag(event, id, card) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  card.querySelector('.node-head').setPointerCapture(event.pointerId);
  const origin = graphPosition(id);
  state.drag = { type: 'node', id, card, startX: event.clientX, startY: event.clientY,
    originX: origin.x, originY: origin.y, moved: false };
}

function selectTable(id, { inspect = true } = {}) {
  if (state.viewMode === 'focus' && state.focusTable !== id) chooseFocusTable(id);
  state.selectedTable = id; state.selectedRelation = null;
  updateEmphasis();
  if (inspect || !$('details').hidden) renderDetails();
}

function selectRelation(id) {
  state.selectedRelation = id; state.selectedTable = null;
  updateEmphasis(); $('details').hidden = true; openRelationDetails(id);
}
function openRelationDetails(id) {
  const relation = state.schema.relations.find(item => item.id === id); if (!relation) return;
  const from = state.schema.tables.find(table => table.id === relation.source), to = state.schema.tables.find(table => table.id === relation.target);
  const dialog = $('relationshipDialog'), root = $('relationshipContent'); root.replaceChildren();
  root.append(modalHeader('تفاصيل العلاقة', relation.kind === 'proposed' ? 'علاقة مقترحة ضمن المسودة.' : 'علاقة مفتاح أجنبي في المخطط.', () => dialog.close(), 'relationshipTitle'));
  const body = el('div', 'modal-body');
  body.append(el('h3', '', 'عمود المصدر · Foreign key'), el('div', 'relation-identifier', relation.pairs.map(pair => `${from.name}.${pair.source}`).join('\n')), el('h3', '', 'العمود المشار إليه'), el('div', 'relation-identifier referenced', relation.pairs.map(pair => `${to.name}.${pair.target}`).join('\n')));
  const tags = el('div', 'chip-row');
  const columns = relation.pairs.map(pair => from.columns.find(column => column.name === pair.source)).filter(Boolean);
  if (columns.length) tags.append(el('span', 'chip', [...new Set(columns.map(column => column.type))].join(' / ')));
  for (const topic of state.groups.filter(topic => topic.id !== 'all' && topic.ids.has(from.id) && topic.ids.has(to.id))) tags.append(el('span', 'chip', topic.label));
  body.append(tags);
  const sql = `FOREIGN KEY (${relation.pairs.map(pair => pair.source).join(', ')})\nREFERENCES ${to.schema}.${to.name} (${relation.pairs.map(pair => pair.target).join(', ')})\nON DELETE ${({ a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT' })[relation.onDelete] || 'NO ACTION'}`;
  body.append(codeBlock(sql, relation.name), uiButton('حذف العلاقة من المسودة', () => confirmAction('حذف العلاقة من المسودة؟', `${from.name} → ${to.name}`, 'سيُسجل حذف العلاقة ضمن التغييرات المقترحة.', () => { stage({type:'dropRelation',relationId:id}); dialog.close(); }), 'text-button danger'));
  root.append(body, modalFooter([uiButton('إظهار على الخريطة', () => { dialog.close(); setViewMode('focus'); chooseFocusTable(from.id); }), uiButton('إغلاق', () => dialog.close())]));
  openDialog(dialog);
}

function tableSql(table) {
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const primary = table.columns.filter(column => column.primary);
  const lines = table.columns.map(column => `  ${quote(column.name)} ${column.type}${column.primary && primary.length === 1 ? ' PRIMARY KEY' : ''}${!column.nullable && !(column.primary && primary.length === 1) ? ' NOT NULL' : ''}${column.default ? ` DEFAULT ${column.default}` : ''}${column.unique && !column.primary ? ' UNIQUE' : ''}`);
  if (primary.length > 1) lines.push(`  PRIMARY KEY (${primary.map(column => quote(column.name)).join(', ')})`);
  return `CREATE TABLE ${quote(table.schema)}.${quote(table.name)} (\n${lines.join(',\n')}\n);`;
}
function sourceEvidence(tableId) {
  const analysis = activeWorkspace()?.codeAnalysis;
  return analysis?.tables?.find(table => table.tableId === tableId)?.evidence || [];
}
function closeInspector() {
  state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis();
}
function confirmAction(title, description, message, apply, label = 'حذف من المسودة') {
  const dialog = $('confirmationDialog'), root = $('confirmationContent'); root.replaceChildren();
  const workspaceId = state.workspaceId;
  root.append(modalHeader(title, description, () => dialog.close(), 'confirmationTitle'));
  const body = el('div', 'modal-body'); body.append(notice(message, 'يمكن التراجع عن هذا التغيير من مراجعة المسودة.', 'warning')); root.append(body);
  root.append(modalFooter([
    uiButton(label, () => { if (workspaceId !== state.workspaceId) { dialog.close(); return; } apply(); dialog.close(); }, 'primary-button danger'),
    uiButton('إلغاء', () => dialog.close())
  ])); openDialog(dialog);
}
function columnTable(table, expanded = false, query = '') {
  const rows = table.columns.filter(column => `${column.name} ${column.type}`.toLowerCase().includes(query.toLowerCase())).map(column => {
    const name = uiButton(column.name, () => openEditor('editColumn', { tableId: table.id, columnName: column.name }), 'column-name-action');
    name.title = `تعديل العمود ${column.name}`;
    const key = el('span', 'column-key-cell', column.primary ? 'PK' : column.foreign ? 'FK' : '');
    return expanded ? [name, column.type, key, column.nullable ? 'YES' : 'NO', column.default || '—'] : [name, column.type, key];
  });
  const wrap = dataTable(expanded ? ['COLUMN', 'TYPE', 'KEY', 'NULLABLE', 'DEFAULT'] : ['COLUMN', 'TYPE', 'KEY'], rows);
  if (!rows.length) wrap.append(el('p', 'table-empty', query ? 'لا توجد أعمدة تطابق البحث.' : 'هذا الجدول لا يحتوي أعمدة بعد.'));
  return wrap;
}
function relationCards(table) {
  const section = el('div', 'table-relations');
  const relevant = state.schema.relations.filter(relation => relation.source === table.id || relation.target === table.id);
  if (!relevant.length) section.append(notice('لا توجد علاقات لهذا الجدول', 'يمكنك إضافة علاقة إلى المسودة.'));
  for (const relation of relevant) {
    const from = state.schema.tables.find(item => item.id === relation.source), to = state.schema.tables.find(item => item.id === relation.target);
    const card = uiButton('', () => { $('tableDialog').close(); selectRelation(relation.id); }, 'relation-card');
    card.append(el('strong', '', `${from?.name} → ${to?.name}`), el('small', '', relation.pairs.map(pair => `${pair.source} → ${pair.target}`).join(' · ')), el('small', '', relation.source === table.id ? 'مفتاح أجنبي من هذا الجدول' : 'علاقة واردة إلى هذا الجدول'));
    section.append(card);
  }
  return section;
}
function tableCodeDetails(table, definition = true) {
  const section = el('div', 'table-code-evidence');
  if (definition) section.append(codeBlock(tableSql(table), 'تعريف الجدول · SQL'));
  const sources = sourceEvidence(table.id), groups = state.groups.filter(group => group.id !== 'all' && group.ids.has(table.id));
  section.append(el('h3', '', 'سياق الاستخدام في الكود'));
  if (!sources.length) section.append(notice('لا يوجد مصدر كود محلّل لهذا الجدول', 'حلّل مشروعك لإظهار المسار والسنتاكس الفعلي الذي يستخدم الجدول.'), uiButton('تحليل كود المشروع', openCodeDialog));
  else for (const source of sources) {
    section.append(codeBlock(source.syntax || source.symbol || '', `${source.file}:${source.line}${source.symbol ? ` · ${source.symbol}` : ''}`));
  }
  if (groups.length) {
    const chips = el('div', 'chip-row'); groups.forEach(group => chips.append(el('span', 'chip', group.label))); section.append(chips);
    for (const group of groups.filter(group => group.reason)) section.append(el('p', 'field-hint', group.reason));
  }
  return section;
}
function renderDetails() {
  const root = $('detailsBody'); root.replaceChildren();
  const table = state.schema.tables.find(item => item.id === state.selectedTable);
  $('details').hidden = !table;
  if (!table) return;
  const relevant = state.schema.relations.filter(relation => relation.source === table.id || relation.target === table.id);
  root.append(modalHeader(`${table.schema}.${table.name}`, 'بنية الجدول وعلاقاته في مكان واحد، والخريطة تبقى ظاهرة.', closeInspector));
  const body = el('div', 'modal-body'), chips = el('div', 'chip-row');
  const membership = state.groups.find(group => group.id !== 'all' && group.ids.has(table.id));
  chips.append(el('span', 'chip', `${table.columns.length} أعمدة`), el('span', 'chip', `${relevant.length} علاقات`), el('span', 'chip', table.kind === 'proposed' ? 'مسودة' : membership?.label || table.schema));
  body.append(chips, uiTabs([['details', 'التفاصيل'], ['relations', 'العلاقات'], ['columns', 'الأعمدة']], state.inspectorTab,
    tab => { state.inspectorTab = tab; renderDetails(); }));
  const groups = state.groups.filter(group => group.id !== 'all' && group.ids.has(table.id));
  if (state.inspectorTab === 'columns') {
    body.append(columnTable(table), el('h3', '', 'يظهر في هذه المواضيع'), el('p', 'field-hint', 'عضوية الجدول مستقلة عن تعريفه؛ يمكن مشاركته بين المواضيع.'));
    const memberships = el('div', 'chip-row'); groups.forEach(group => memberships.append(el('span', 'chip', group.label)));
    if (!groups.length) memberships.append(el('p', 'field-hint', 'لم يُضف هذا الجدول إلى موضوع بعد.'));
    body.append(memberships, notice('تعديلات محفوظة في المسودة', 'تعديل المخطط لا يكتب مباشرة إلى قاعدة البيانات.'));
  } else if (state.inspectorTab === 'relations') {
    body.append(relationCards(table), notice('السياق المشترك بين المواضيع', 'قد يظهر الجدول في أكثر من موضوع عندما يخدم وظيفة الكود في كل منها.'));
  } else {
    const fields = el('div', 'read-only-fields');
    for (const [label, value] of [['Schema', table.schema], ['اسم الجدول', table.name]]) { const field = el('label', '', label), input = el('input'); input.value = value; input.disabled = true; input.dir = 'ltr'; field.append(input); fields.append(field); }
    body.append(fields, tableCodeDetails(table));
  }
  const actions = state.inspectorTab === 'columns' ? [uiButton('إضافة عمود', () => openEditor('addColumn', { tableId: table.id }), 'primary-button'), uiButton('عرض موسّع', () => openExpandedTable(table.id))]
    : state.inspectorTab === 'relations' ? [uiButton('إضافة علاقة', () => openEditor('addRelation', { source: table.id }), 'primary-button'), uiButton('إغلاق', closeInspector)]
    : [uiButton('تغيير اسم الجدول', () => openEditor('renameTable', { tableId: table.id })), uiButton('إغلاق', closeInspector)];
  root.append(body, modalFooter(actions));
}
function openExpandedTable(id) {
  const table = state.schema.tables.find(item => item.id === id); if (!table) return;
  const dialog = $('tableDialog'), root = $('expandedTableContent'); root.replaceChildren();
  dialog.dataset.tableId = id;
  root.append(modalHeader(`${table.schema}.${table.name}`, 'عرض موسّع لبنية الجدول. هذه أعمدة المخطط وليست صفوف بيانات.', () => dialog.close(), 'expandedTableTitle'));
  const body = el('div', 'modal-body'), content = el('div', 'expanded-table-tab'); let selected = 'columns';
  const entries = [['details', 'مصادر الكود'], ['sql', 'SQL'], ['relations', 'العلاقات'], ['columns', 'الأعمدة']];
  const show = tab => {
    selected = tab; body.querySelector('.ui-tabs')?.replaceWith(uiTabs(entries, selected, show)); content.replaceChildren();
    if (tab === 'columns') {
      const row = el('div', 'inspector-title-row'), search = el('input'); search.type = 'search'; search.placeholder = 'ابحث في الأعمدة…'; search.setAttribute('aria-label', 'ابحث في أعمدة الجدول');
      row.append(search);
      const list = el('div'); list.append(columnTable(table, true)); search.addEventListener('input', () => list.replaceChildren(columnTable(table, true, search.value)));
      content.append(row, list, notice('تعريف واحد بين المواضيع', 'كل نسخة على الخريطة تشير إلى تعريف الجدول نفسه.'));
    } else content.append(tab === 'relations' ? relationCards(table) : tab === 'sql' ? codeBlock(tableSql(table)) : tableCodeDetails(table, false));
  };
  body.append(uiTabs(entries, selected, show), content); show(selected);
  root.append(body, modalFooter([uiButton('إضافة عمود', () => openEditor('addColumn', { tableId: id }), 'primary-button'), uiButton('إغلاق', () => dialog.close())])); openDialog(dialog);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast('تم النسخ'); } catch { showToast('تعذّر النسخ. حدد النص وانسخه يدويًا.'); }
}
function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2700);
}

function svgIcon(name) { return icon({ plus: 'add', inspect: 'table', edit: 'tools', trash: 'close' }[name] || name); }
function actionButton(label, handler, extra = '', iconName = '') {
  const button = el('button', `inline-action ${extra}`);
  if (iconName) button.append(svgIcon(iconName));
  const caption = el('span', '', label); button.append(caption);
  if (extra.includes('icon-only')) { button.title = label; button.setAttribute('aria-label', label); caption.className = 'sr-only'; }
  button.type = 'button'; button.addEventListener('click', handler);
  return button;
}
function closeContextMenu() { $('contextMenu').hidden = true; }
function beginLink(tableId, columnName = null) {
  state.linkMode = false; state.linkSource = null;
  openEditor('addRelation', { source: tableId, sourceColumn: columnName });
}
function showContextMenu(event) {
  event.preventDefault();
  const menu = $('contextMenu'), mapRect = $('map').getBoundingClientRect();
  const card = event.target.closest?.('.table-node');
  const columnElement = event.target.closest?.('.column');
  const relationId = event.target.dataset?.relation;
  const tableId = card?.dataset.table;
  const table = state.schema.tables.find(item => item.id === tableId);
  const column = table?.columns.find(item => item.name === columnElement?.dataset.column);
  const point = { x: (event.clientX - $('viewport').getBoundingClientRect().left - state.x) / state.scale,
    y: (event.clientY - $('viewport').getBoundingClientRect().top - state.y) / state.scale };
  const items = [];
  const item = (label, iconName, handler, danger = false) => {
    const button = el('button', `context-action${danger ? ' danger' : ''}`); button.type = 'button'; button.setAttribute('role', 'menuitem');
    button.append(svgIcon(iconName), el('span', '', label));
    button.addEventListener('click', () => { closeContextMenu(); handler(); }); items.push(button);
  };
  if (relationId) {
    item('عرض تفاصيل العلاقة', 'inspect', () => selectRelation(relationId));
    item('إضافة طلب حذف للمسودة', 'trash', () => stage({ type: 'dropRelation', relationId }), true);
  } else if (table && column) {
    item(`تعديل ${column.name}`, 'edit', () => openEditor('editColumn', { tableId, columnName: column.name }));
    item('إنشاء علاقة من هذا العمود', 'link', () => beginLink(tableId, column.name));
    item('إضافة طلب حذف للمسودة', 'trash', () => stage({ type: 'dropColumn', tableId, columnName: column.name }), true);
  } else if (table) {
    item('عرض التفاصيل', 'inspect', () => selectTable(tableId));
    item('تغيير اسم الجدول', 'edit', () => openEditor('renameTable', { tableId }));
    item('إضافة عمود', 'plus', () => openEditor('addColumn', { tableId }));
    item('إنشاء علاقة', 'link', () => beginLink(tableId));
  } else {
    item('إنشاء جدول هنا', 'table', () => openEditor('addTable', { position: point }));
    item('إنشاء علاقة', 'link', () => openEditor('addRelation'));
    item('توزيع على كامل الشاشة', 'inspect', arrangeTables);
  }
  menu.replaceChildren(...items); menu.hidden = false;
  const x = event.clientX - mapRect.left, y = event.clientY - mapRect.top;
  requestAnimationFrame(() => {
    menu.style.left = `${Math.max(12, Math.min(x, mapRect.width - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(y, mapRect.height - menu.offsetHeight - 12))}px`;
    menu.querySelector('button')?.focus();
  });
}
function arrangeTables() {
  state.hoveredTable = null;
  if (state.viewMode === 'focus' && state.focusTable) {
    localStorage.removeItem(`${storageKey()}.focusLayout.${state.focusTable}`);
    buildFocusPositions(); renderNodes(); requestAnimationFrame(() => fitView(false));
    showToast('أُعيد ترتيب الجدول وعلاقاته'); return;
  }
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    localStorage.removeItem(`${storageKey()}.topicLayout.${state.topic}`);
    buildTopicPositions(); renderNodes(); requestAnimationFrame(() => fitView(true));
    showToast('أُعيد ترتيب جداول الموضوع'); return;
  }
  state.hoveredTable = null; state.positions = layoutTables(); savePositions(); renderNodes(); requestAnimationFrame(() => fitView(state.topic !== 'all'));
  showToast('وُزعت الجداول على كامل مساحة الخريطة حسب قوة الترابط');
}
function draftKey() { return `${storageKey()}.draft${state.workspaceId !== 'legacy' && state.base.fingerprint ? `.${state.base.fingerprint}` : ''}`; }
function topicKey() { return `${storageKey()}.topics`; }
function saveDraft() { localStorage.setItem(draftKey(), JSON.stringify({ operations: state.operations, cursor: state.cursor })); }
function saveTopics() {
  state.customGroups = state.groups.slice(1).map(group => ({ id: group.id, label: group.label, color: group.color, ids: [...group.ids],
    ...(group.reason ? { reason: group.reason } : {}), ...(group.moduleIds ? { moduleIds: group.moduleIds } : {}), ...(group.evidence ? { evidence: group.evidence } : {}) }));
  localStorage.setItem(topicKey(), JSON.stringify(state.customGroups));
}
function updateDraftView() {
  $('pendingCount').textContent = String(state.cursor);
  updateViewCounts();
  $('undoButton').disabled = state.cursor === 0;
  $('redoButton').disabled = state.cursor === state.operations.length;
  $('reviewButton').disabled = state.cursor === 0;
  $('discardDraftButton').disabled = !state.operations.length;
  $('draftSummary').textContent = `${state.cursor} تغييرات محلية جاهزة للمراجعة والتسليم إلى المساعد.`;
  const list = $('changeList'); list.replaceChildren();
  if (!state.operations.length) list.append(el('p', 'empty-changes', 'لا توجد تغييرات بعد. اختر جدولًا لتعديله.'));
  state.operations.forEach((operation, index) => {
    const row = el('div', `change-item${index >= state.cursor ? ' undone' : ''}`);
    row.append(el('span', 'change-number', String(index + 1)), el('span', '', describeOperation(operation, operation.type === 'renameTable' ? state.base : state.schema)));
    list.append(row);
  });
}
function refreshDraft({ fit = false } = {}) {
  state.schema = replay(state.base, state.operations.slice(0, state.cursor));
  buildGroups();
  for (const [id, point] of layoutTables()) if (!state.positions.has(id)) state.positions.set(id, point);
  for (const id of [...state.positions.keys()]) if (!state.schema.tables.some(t => t.id === id)) state.positions.delete(id);
  if (state.focusTable && !state.schema.tables.some(table => table.id === state.focusTable)) state.focusTable = null;
  buildFocusPositions(); buildTopicPositions();
  renderTopics(); renderView(); renderNodes(); renderDetails(); updateDraftView();
  if ($('tableDialog').open) openExpandedTable($('tableDialog').dataset.tableId);
  renderEmptyWorkspace();
  if (fit) requestAnimationFrame(() => fitView(state.topic !== 'all'));
}
function stage(operation) {
  try {
    applyOperation(state.schema, operation);
    state.operations = state.operations.slice(0, state.cursor);
    state.operations.push(operation); state.cursor++;
    saveDraft(); if (operation.type === 'addTable') savePositions(); refreshDraft(); showToast('أضيف التغيير إلى المسودة');
  } catch (error) { showToast(error.message); throw error; }
}
function stepDraft(delta) {
  state.cursor = Math.max(0, Math.min(state.operations.length, state.cursor + delta));
  saveDraft(); refreshDraft();
}
function field(name, label, value = '', type = 'text', options = {}) {
  const wrapper = el('label', 'edit-field', label), input = el('input');
  input.name = name; input.type = type; input.value = value ?? '';
  if (type === 'checkbox') { input.checked = Boolean(value); input.value = 'yes'; }
  if (options.required) input.required = true;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (type !== 'checkbox') { input.dir = 'ltr'; input.spellcheck = false; }
  if (type === 'checkbox') {
    wrapper.replaceChildren(); const copy = el('span'); copy.append(el('strong', '', label), el('small', '', name === 'primary' ? 'متاح للجداول الجديدة في المسودة.' : 'يسمح بقيمة NULL لهذا العمود.')); wrapper.append(input, copy);
  } else wrapper.append(input);
  return wrapper;
}
function selectField(name, label, values, selected) {
  const wrapper = el('label', 'edit-field', label), select = el('select'); select.name = name; select.setAttribute('aria-label', label);
  values.forEach(([value, caption]) => { const option = el('option', '', caption); option.value = value; select.append(option); });
  if (selected !== undefined) select.value = selected;
  wrapper.append(select); return wrapper;
}
function openEditor(kind, context = {}) {
  state.editContext = { kind, ...context };
  const fields = $('editFields'); fields.replaceChildren(); $('editError').hidden = true;
  const table = state.schema.tables.find(t => t.id === context.tableId);
  const column = table?.columns.find(c => c.name === context.columnName);
  const titles = { addTable: 'جدول جديد', renameTable: 'تغيير اسم الجدول', addColumn: 'إضافة عمود', editColumn: 'تعديل العمود', addRelation: 'إضافة علاقة' };
  $('editTitle').textContent = titles[kind];
  $('editDescription').textContent = kind === 'addTable' ? 'أضف تعريف الجدول إلى المسودة ثم جهّز أعمدته.' : kind === 'renameTable' ? 'سيبقى الجدول مرتبطًا بمواضيعه وعلاقاته.' : kind === 'addRelation' ? 'عمود المفتاح الأجنبي يشير إلى عمود المفتاح الأساسي في الجدول الهدف.' : `تعديل أعمدة ${table.name} ضمن المسودة.`;
  $('editDialog').style.setProperty('--modal-width', `${kind === 'addRelation' ? 800 : kind === 'renameTable' ? 520 : kind === 'addTable' ? 680 : 640}px`);
  if (kind === 'addTable') fields.append(field('name', 'اسم الجدول', '', 'text', { required: true }), field('schema', 'Schema', 'public', 'text', { required: true }));
  if (kind === 'renameTable') {
    const current = field('currentName', 'الاسم الحالي', table.name); current.classList.add('full'); current.querySelector('input').disabled = true;
    const name = field('name', 'الاسم الجديد', table.name, 'text', { required: true }); name.classList.add('full'); fields.append(current, name);
  }
  if (kind === 'addColumn' || kind === 'editColumn') {
    const defaultField = field('default', 'القيمة الافتراضية · SQL', column?.default || '', 'text', { placeholder: "مثال: now() أو 'active'" }); defaultField.classList.add('full');
    defaultField.append(el('p', 'field-hint', 'اتركه فارغًا إن لم توجد قيمة افتراضية.'));
    fields.append(field('type', 'النوع PostgreSQL', column?.type || 'text', 'text', { required: true }), field('name', 'اسم العمود', column?.name || '', 'text', { required: true }), defaultField, field('nullable', 'يسمح بقيمة فارغة', column?.nullable ?? true, 'checkbox'));
    if (kind === 'addColumn' && table.kind === 'proposed') fields.append(field('primary', 'مفتاح أساسي', false, 'checkbox'));
  }
  if (kind === 'addRelation') {
    const choices = state.schema.tables.map(t => [t.id, `${t.schema}.${t.name}`]);
    fields.append(selectField('source', 'الجدول المصدر', choices, context.source), selectField('target', 'الجدول الهدف', choices, context.target),
      selectField('sourceColumn', 'عمود المصدر', [], context.sourceColumn), selectField('targetColumn', 'عمود الهدف', [], context.targetColumn));
    const update = which => {
      const t = state.schema.tables.find(item => item.id === fields.querySelector(`[name="${which}"]`).value);
      const select = fields.querySelector(`[name="${which}Column"]`);
      const old = which === 'source' ? context.sourceColumn : context.targetColumn;
      select.replaceChildren(...(t?.columns || []).map(c => { const option = el('option', '', c.name); option.value = c.name; return option; }));
      if (old) select.value = old;
    };
    fields.querySelector('[name="source"]').addEventListener('change', () => update('source'));
    fields.querySelector('[name="target"]').addEventListener('change', () => update('target'));
    update('source'); update('target');
  }
  if (kind === 'renameTable') fields.firstElementChild.classList.add('full');
  $('editSubmit').textContent = kind === 'addTable' ? 'إنشاء في المسودة' : kind === 'renameTable' ? 'حفظ الاسم' : kind === 'addRelation' ? 'إضافة إلى المسودة' : 'حفظ في المسودة';
  if (kind === 'addTable') {
    const hint = el('p', 'field-hint', 'استخدم اسمًا واضحًا بصيغة snake_case.'); fields.querySelector('[name="name"]').parentElement.append(hint);
    const note = notice('أضف الأعمدة بعد إنشاء الجدول', 'يمكن تحديد المفتاح الأساسي للجداول الجديدة من نافذة إضافة العمود.'); note.classList.add('full'); fields.append(note);
  }
  if (kind === 'addRelation') {
    const advanced = el('details', 'full advanced-options'); advanced.append(el('summary', '', 'خيارات العلاقة المتقدمة'), selectField('onDelete', 'عند حذف السجل المرتبط', [['a', 'NO ACTION'], ['r', 'RESTRICT'], ['c', 'CASCADE'], ['n', 'SET NULL']], 'a')); fields.append(advanced);
    const status = notice('راجع توافق الأعمدة', 'اختر عمودًا أساسيًا أو فريدًا في الجدول الهدف، ثم راجع نوعي العمودين.'); status.classList.add('full'); status.id = 'relationshipCompatibility'; fields.append(status);
  }
  if (kind === 'editColumn') {
    const remove = uiButton('حذف العمود من المسودة', () => confirmAction('حذف العمود من المسودة؟', `${table.name}.${column.name}`, 'سيُسجل حذف العمود والعلاقات المرتبطة به ضمن المسودة.', () => { stage({ type: 'dropColumn', tableId: table.id, columnName: column.name }); $('editDialog').close(); }), 'text-button danger full'); fields.append(remove);
  }
  const preview = () => {
    const values = new FormData($('editForm')), read = name => String(values.get(name) || '…').trim(); let sql;
    if (kind === 'addTable') sql = `CREATE TABLE ${read('schema')}.${read('name')} ();`;
    if (kind === 'renameTable') sql = `ALTER TABLE ${table.schema}.${table.name}\nRENAME TO ${read('name')};`;
    if (kind === 'addColumn') sql = `ALTER TABLE ${table.schema}.${table.name}\nADD COLUMN ${read('name')} ${read('type')}${values.has('nullable') ? '' : ' NOT NULL'}${values.get('default') ? ` DEFAULT ${values.get('default')}` : ''}${values.has('primary') ? ' PRIMARY KEY' : ''};`;
    if (kind === 'editColumn') {
      const target = `ALTER TABLE ${table.schema}.${table.name}`;
      const statements = column.name !== read('name') ? [`${target} RENAME COLUMN ${column.name} TO ${read('name')};`] : [];
      if (column.type !== read('type')) statements.push(`${target} ALTER COLUMN ${read('name')} TYPE ${read('type')};`);
      if (column.nullable !== values.has('nullable')) statements.push(`${target} ALTER COLUMN ${read('name')} ${values.has('nullable') ? 'DROP' : 'SET'} NOT NULL;`);
      if ((column.default || '') !== String(values.get('default') || '')) statements.push(`${target} ALTER COLUMN ${read('name')} ${values.get('default') ? `SET DEFAULT ${values.get('default')}` : 'DROP DEFAULT'};`);
      sql = statements.join('\n') || '-- لا توجد تغييرات على التعريف';
    }
    if (kind === 'addRelation') {
      const source = state.schema.tables.find(table => table.id === read('source')), target = state.schema.tables.find(table => table.id === read('target'));
      const sourceColumn = source?.columns.find(column => column.name === read('sourceColumn')), targetColumn = target?.columns.find(column => column.name === read('targetColumn'));
      const status = $('relationshipCompatibility'), compatible = sourceColumn && targetColumn && sourceColumn.type === targetColumn.type;
      if (status) {
        status.className = `notice full ${compatible ? 'success' : 'warning'}`;
        status.replaceChildren(icon(compatible ? 'check' : 'info'), el('div', 'notice-copy', compatible ? `النوعان متوافقان: ${sourceColumn.type} · ${source.name}.${sourceColumn.name} → ${target.name}.${targetColumn.name}` : 'راجع الأعمدة ونوعيها قبل إضافة العلاقة إلى المسودة.'));
      }
      $('editSubmit').disabled = !sourceColumn || !targetColumn;
      sql = `ALTER TABLE ${source?.schema}.${source?.name}\nADD FOREIGN KEY (${read('sourceColumn')})\nREFERENCES ${target?.schema}.${target?.name} (${read('targetColumn')})\nON DELETE ${({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL' })[read('onDelete')] || 'NO ACTION'};`;
    }
    $('editPreview').replaceChildren(el('div', 'code-label', 'معاينة التعريف · يُراجع SQL النهائي من المسودة'), el('pre', '', sql));
  };
  if (kind !== 'addRelation') $('editSubmit').disabled = false;
  fields.oninput = preview; fields.onchange = preview; preview();
  openDialog($('editDialog')); fields.querySelector('[name="name"]:not(:disabled),input:not(:disabled),select:not(:disabled)')?.focus();
}
function chooseLinkColumn(tableId, columnName) {
  if (!state.linkSource) { state.linkSource = { tableId, columnName }; showToast('اختر الآن العمود الهدف'); }
  else {
    openEditor('addRelation', { source: state.linkSource.tableId, sourceColumn: state.linkSource.columnName, target: tableId, targetColumn: columnName });
    state.linkSource = null; state.linkMode = false; $('linkModeButton').setAttribute('aria-pressed', 'false');
  }
}

function createTopic() {
  const group = { id: `custom:${crypto.randomUUID()}`, label: 'موضوع جديد', color: topicColors[(state.groups.length - 1) % topicColors.length], ids: new Set() };
  openTopicSettings(group, true);
}
function openTopicSettings(group, newlyCreated = false) {
  const dialog = $('topicSettingsDialog'), root = $('topicSettingsContent'); root.replaceChildren();
  const workspaceId = state.workspaceId, selected = new Set(group.ids);
  const cancel = () => dialog.close();
  root.append(modalHeader('إعدادات الموضوع', 'غيّر الاسم والجداول الظاهرة دون تكرار تعريف الجدول.', cancel, 'topicSettingsTitle'));
  const body = el('div', 'modal-body'), nameLabel = el('label', '', 'اسم الموضوع'), name = el('input'); name.value = group.label; name.maxLength = 50; nameLabel.append(name);
  const colorLabel = el('label', '', 'لون الموضوع'), color = el('input'); color.type = 'color'; color.value = group.color; colorLabel.append(color);
  const search = el('input'); search.type = 'search'; search.placeholder = 'ابحث لإضافة جدول…'; search.setAttribute('aria-label', 'ابحث لإضافة جدول');
  const members = el('div', 'topic-settings-members');
  for (const table of state.schema.tables) {
    const label = el('label', 'choice'), check = el('input'); check.type = 'checkbox'; check.checked = selected.has(table.id);
    const copy = el('span'), shared = state.groups.filter(item => item.id !== 'all' && item.id !== group.id && item.ids.has(table.id));
    copy.append(el('strong', '', table.name), el('small', '', shared.length ? `مشترك مع ${shared.map(item => item.label).join('، ')}` : table.description || 'جدول في هذا الموضوع'));
    label.append(check, copy); label.dataset.search = `${table.schema}.${table.name}`.toLowerCase();
    check.addEventListener('change', () => check.checked ? selected.add(table.id) : selected.delete(table.id)); members.append(label);
  }
  search.addEventListener('input', () => { for (const label of members.children) label.hidden = !label.dataset.search.includes(search.value.toLowerCase()); });
  body.append(nameLabel, colorLabel, search, members);
  if (!newlyCreated) body.append(uiButton('حذف الموضوع', () => confirmAction('حذف الموضوع؟', group.label, 'سيُحذف التصنيف فقط. تبقى الجداول في المخطط والمواضيع الأخرى.', () => {
    state.groups = state.groups.filter(item => item.id !== group.id); if (state.topic === group.id) state.topic = 'all';
    refreshTopics(); renderTopicEditor(); dialog.close();
  }, 'حذف الموضوع'), 'ghost-button danger'));
  root.append(body, modalFooter([
    uiButton('تم', () => {
      if (!name.value.trim()) { name.focus(); return; }
      if (workspaceId !== state.workspaceId || (!newlyCreated && !state.groups.includes(group))) { dialog.close(); return; }
      if (newlyCreated) { state.groups.push(group); state.topicEditorId = group.id; }
      group.label = name.value.trim(); group.color = color.value;
      group.ids = new Set([...selected].filter(id => state.schema.tables.some(table => table.id === id)));
      newlyCreated = false; refreshTopics(); renderTopicEditor(); dialog.close();
    }, 'primary-button'), uiButton('إلغاء', cancel)
  ], 'إلغاء عضوية جدول لا يحذفه من المخطط.'));
  openDialog(dialog); name.focus();
}
function renderTopicEditor() {
  const root = $('topicEditor'); root.replaceChildren();
  $('suggestTopicsButton').disabled = !state.schema.tables.length; $('resetTopicsButton').disabled = !state.schema.tables.length;
  const groups = state.groups.filter(group => group.id !== 'all');
  const group = groups.find(group => group.id === state.topicEditorId) || groups.find(group => group.id === state.topic) || groups[0];
  if (group) state.topicEditorId = group.id;
  const split = el('div', 'topic-editor-split'), membership = el('div', 'topic-membership'), rail = el('div', 'topic-rail');
  for (const item of groups) {
    const choice = el('label', 'choice'), radio = el('input'); radio.type = 'radio'; radio.name = 'selectedTopic'; radio.value = item.id; radio.checked = item.id === group?.id;
    const copy = el('span'); copy.append(el('strong', '', item.label), el('small', '', `${item.ids.size} جداول${item.id === group?.id ? ' · محدد' : ''}`)); choice.append(radio, copy);
    radio.addEventListener('change', () => { state.topicEditorId = item.id; renderTopicEditor(); }); rail.append(choice);
  }
  if (group) rail.append(uiButton('إعدادات الموضوع', () => openTopicSettings(group)));
  rail.append(uiButton('موضوع جديد', createTopic, 'ghost-button'));
  if (!group) membership.append(notice('ابدأ تنظيم المواضيع', state.schema.tables.length ? 'أضف موضوعًا واختر جداوله، أو حلّل الكود واقترح تقسيمًا.' : 'أضف جداول إلى المخطط أولًا، ثم اجمعها حسب وظيفتها.'));
  else {
    membership.append(el('h3', '', `جداول موضوع ${group.label}`), el('p', '', 'إضافة الجدول هنا لا تزيله من المواضيع الأخرى.'));
    const search = el('input'); search.type = 'search'; search.placeholder = 'ابحث عن جدول…'; search.setAttribute('aria-label', 'ابحث في جداول الموضوع');
    const list = el('div');
    const update = () => {
      const query = search.value.toLowerCase();
      const tables = state.schema.tables.filter(table => query ? `${table.schema}.${table.name}`.toLowerCase().includes(query) : group.ids.has(table.id));
      const rows = tables.map(table => {
        const context = sourceEvidence(table.id)[0], check = el('input'); check.type = 'checkbox'; check.checked = group.ids.has(table.id); check.setAttribute('aria-label', `عضوية ${table.name} في ${group.label}`);
        check.addEventListener('change', () => { if (check.checked) group.ids.add(table.id); else group.ids.delete(table.id); refreshTopics(); renderTopicEditor(); });
        const shared = groups.filter(item => item.ids.has(table.id)).length > 1;
        const status = el('label', 'topic-member'); status.append(check, el('span', 'chip', check.checked ? shared ? 'مشترك' : 'مضاف' : 'إضافة'));
        const copy = el('span', '', context ? `${context.file}:${context.line} · ${context.syntax || context.symbol || ''}` : table.description || group.reason || 'عضوية مختارة في هذا الموضوع');
        copy.title = copy.textContent;
        return [table.name, copy, status];
      });
      list.replaceChildren(dataTable(['TABLE', 'السياق', 'العضوية'], rows));
      if (!rows.length) list.append(el('p', 'field-hint', query ? 'لا توجد جداول تطابق البحث.' : 'لا توجد جداول مضافة. افتح إعدادات الموضوع لاختيار الجداول.'));
    };
    search.addEventListener('input', update); update(); membership.append(search, list);
  }
  split.append(membership, rail); root.append(split);
}
function openTopicProposal(suggestions, sourceAnalysis, request) {
  const dialog = $('topicProposalDialog'), root = $('topicProposalContent'); root.replaceChildren();
  root.append(modalHeader('راجع اقتراح المواضيع', `${suggestions.length} مواضيع مبنية على استخدام الجداول في الكود.`, () => dialog.close(), 'topicProposalTitle'));
  const body = el('div', 'modal-body');
  for (const group of suggestions) {
    const section = el('section', 'table-code-evidence'); section.append(el('h3', '', group.label), el('p', 'field-hint', group.reason || ''));
    const chips = el('div', 'chip-row'); [...group.ids].forEach(id => chips.append(el('span', 'chip', state.schema.tables.find(table => table.id === id)?.name || id))); section.append(chips);
    for (const source of group.evidence || []) section.append(codeBlock(source.syntax || source.symbol || '', `${source.file}:${source.line}`)); body.append(section);
  }
  root.append(body, modalFooter([
    uiButton('اعتماد الاقتراح', () => {
      if (request.workspaceId !== state.workspaceId || request.schema !== JSON.stringify(state.schema) || request.sourceRoot !== $('topicSourceRoot').value.trim()) { showToast('تغيرت المساحة أو المصدر. أعد الاقتراح.'); dialog.close(); return; }
      state.groups = [state.groups[0], ...suggestions]; state.topicEditorId = suggestions[0]?.id; if (!state.groups.some(group => group.id === state.topic)) state.topic = 'all';
      if (sourceAnalysis) { activeWorkspace().codeAnalysis = sourceAnalysis; saveWorkspaces(); syncCodeSource(); }
      refreshTopics(); renderTopicEditor(); dialog.close(); showToast('تم اعتماد تنظيم المواضيع');
    }, 'primary-button'), uiButton('إلغاء', () => dialog.close())
  ], 'يمكن للجدول أن يظهر في كل موضوع يستخدمه.'));
  openDialog(dialog);
}
function refreshTopics() {
  saveTopics(); buildTopicPositions(); renderTopics(); renderView(); renderNodes(); updateViewCounts();
  for (const member of $('topicEditor').querySelectorAll('.topic-member')) {
    const shared = state.groups.slice(1).filter(group => group.ids.has(member.dataset.tableId)).length > 1;
    const badge = member.querySelector('.topic-shared-label');
    if (shared && !badge) member.append(el('small', 'topic-shared-label', 'مشترك'));
    else if (!shared) badge?.remove();
    member.title = shared ? 'يظهر هذا الجدول في أكثر من موضوع' : '';
  }
}
function updateAiSettings({ save = false } = {}) {
  const provider = $('aiProvider').value, local = ['codex-cli', 'claude-cli'].includes(provider);
  $('aiKeyWrap').hidden = local;
  $('aiKey').disabled = local;
  $('aiEndpointWrap').hidden = provider !== 'compatible';
  $('aiModel').placeholder = local ? 'اتركه فارغًا للنموذج الافتراضي' : 'اسم النموذج';
  $('topicAiProvider').value = local ? provider : 'settings';
  const status = localAiStatuses.find(item => item.provider === provider);
  const message = local ? (status?.message || 'يستخدم تسجيل دخول المساعد على الجهاز، دون مفتاح API.') : 'يستخدم الخدمة المحددة في إعدادات AI.';
  $('aiLocalStatus').textContent = message;
  $('topicAiStatus').textContent = message;
  $('aiContext').textContent = `${state.schema?.tables?.find(table => table.id === state.selectedTable)?.name || state.groups.find(group => group.id === state.topic)?.label || 'المخطط'} · ${providerLabel()}`;
  $('aiFootnote').textContent = local ? 'استخدام تسجيل الدخول على الجهاز · الطلب ضمن حدود الاشتراك.' : 'يستخدم المزوّد المحدد في إعدادات المساعد.';
  renderProviderChoices();
  if (save) localStorage.setItem('eratlas.ai.settings.v1', JSON.stringify({ provider, model: $('aiModel').value.trim(), endpoint: $('aiEndpoint').value.trim() }));
}
let localAiStatuses = [];
let defaultSourceRoot = '';
function syncCodeSource() {
  if (!$('topicSourceRoot')) return;
  const workspace = activeWorkspace();
  $('topicSourceRoot').value = workspace?.sourceRoot ?? defaultSourceRoot;
  const analysis = workspace?.codeAnalysis;
  $('topicSourceSummary').textContent = analysis ? codeSummaryText(analysis) : 'يربط المواضيع باستخدام الجداول في Models وServices وRepositories وRoutes. التحليل المحلي لا يستهلك توكنز.';
  const source = analysis?.modules?.flatMap(module => module.sources || [])[0]?.file;
  $('sourceName').textContent = source || workspace?.sourceRoot?.split(/[\\/]/).filter(Boolean).at(-1) || state.schema?.database || 'مصدر المخطط';
  const results = $('codeResults'); results.replaceChildren();
  if (analysis) {
    const rows = (analysis.tables || []).flatMap(table => table.evidence.slice(0, 3).map(source => [`${source.file}:${source.line}`, source.syntax || source.symbol || table.tableId]));
    results.append(dataTable(['SOURCE', 'الاستخدام'], rows));
  }
}
function codeSummaryText(analysis) {
  const missing = analysis.unmatchedTableIds?.length || 0, failed = analysis.failedFiles?.length || 0, skipped = analysis.skippedFiles?.length || 0;
  return `حُلّل ${analysis.parsedFiles} ملف PHP · طابق ${analysis.matchedTableIds?.length ?? analysis.matchedTables ?? 0} جدول · ${analysis.modules?.length ?? analysis.moduleCount ?? 0} قسم برمجي${missing ? ` · ${missing} جدول بلا تطابق في المصدر` : ''}${failed ? ` · تعذّر تحليل ${failed} ملف` : ''}${skipped ? ` · تُرك ${skipped} ملف خارج التحليل` : ''}.`;
}
function saveCodeSource() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const path = $('topicSourceRoot').value.trim();
  if (workspace.sourceRoot !== path) { workspace.sourceRoot = path; delete workspace.codeAnalysis; }
  saveWorkspaces();
}
async function loadCodeSettings() {
  try {
    const response = await fetch('/api/code/settings');
    if (!response.ok) throw new Error();
    defaultSourceRoot = (await response.json()).defaultSourceRoot || '';
    syncCodeSource();
  } catch { $('topicSourceSummary').textContent = 'تعذّر تحميل مسار الكود. أدخله يدويًا ثم اضغط «تحليل الكود».'; }
}
async function analyzeTopicCode() {
  const button = $('analyzeTopicCodeButton'), workspaceId = state.workspaceId;
  const sourceRoot = $('topicSourceRoot').value.trim(), snapshot = JSON.stringify(state.schema.tables);
  saveCodeSource(); button.disabled = true;
  $('topicSourceSummary').textContent = 'جارٍ تحليل البنية البرمجية للجداول واستخداماتها...';
  try {
    const response = await fetch('/api/code/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRoot, tables: state.schema.tables }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذّر تحليل الكود');
    if (workspaceId !== state.workspaceId || sourceRoot !== $('topicSourceRoot').value.trim() || snapshot !== JSON.stringify(state.schema.tables)) return;
    activeWorkspace().codeAnalysis = data; saveWorkspaces(); syncCodeSource();
  } catch (error) { if (workspaceId === state.workspaceId) $('topicSourceSummary').textContent = error.message; }
  finally { button.disabled = false; }
}
async function loadLocalAiStatus() {
  try {
    const response = await fetch('/api/ai/local-status');
    if (!response.ok) throw new Error();
    localAiStatuses = (await response.json()).providers || [];
    if (!localStorage.getItem('eratlas.ai.settings.v1')) {
      $('aiProvider').value = localAiStatuses.find(item => item.ready)?.provider || 'codex-cli';
    }
    updateAiSettings();
  } catch {
    $('aiLocalStatus').textContent = $('topicAiStatus').textContent = 'تعذّر فحص مساعد الجهاز. أعد تشغيل ER Atlas ثم حدّث الصفحة.';
  }
}
async function askAi(mode, question, schema = state.schema, signal) {
  updateAiSettings({ save: true });
  const response = await fetch('/api/ai', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: $('aiProvider').value, model: $('aiModel').value.trim(),
      endpoint: $('aiEndpoint').value.trim(), key: $('aiKey').value, question, mode, schema,
      ...(mode === 'topics' ? { sourceRoot: $('topicSourceRoot').value.trim() } : {}),
      history: mode === 'explain' || mode === 'ideas' ? state.aiMessages.slice(-12) : [] }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذّر الاتصال بخدمة AI');
  if (mode === 'topics') return data;
  return data.answer;
}
function parseTopicSuggestions(answer) {
  return readTopicSuggestions(answer, state.schema.tables.map(table => table.id)).map(group => ({ ...group, ids: new Set(group.ids) }));
}
function normalizeAiLayout(value, tables = state.schema.tables) {
  const source = Array.isArray(value) ? { zones: value } : value;
  if (!source || !Array.isArray(source.zones)) throw new Error('اقتراح الترتيب من AI غير صالح');
  const validIds = new Set(tables.map(table => table.id));
  const used = new Set();
  const zones = source.zones.slice(0, 10).map((zone, index) => {
    const ids = [...new Set(Array.isArray(zone.tableIds) ? zone.tableIds : [])]
      .filter(id => validIds.has(id) && !used.has(id));
    ids.forEach(id => used.add(id));
    return { name: String(zone.name || `منطقة ${index + 1}`).trim().slice(0, 48), tableIds: ids };
  }).filter(zone => zone.tableIds.length);
  if (!zones.length) throw new Error('لم يحدد AI أي جدول صالح للترتيب');
  const remaining = [...validIds].filter(id => !used.has(id));
  if (remaining.length) zones.push({ name: 'جداول مترابطة أخرى', tableIds: remaining });
  const centralTableIds = [...new Set(Array.isArray(source.centralTableIds) ? source.centralTableIds : [])].filter(id => validIds.has(id));
  return { zones, centralTableIds };
}
function parseAiLayout(answer, tables = state.schema.tables) {
  const cleaned = answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return normalizeAiLayout(JSON.parse(cleaned), tables);
}
function captureArrangement(mode = 'relations') {
  const tables = visibleTables(), ids = new Set(tables.map(table => table.id));
  const schema = { ...state.schema, tables, relations: visibleRelations().filter(relation => ids.has(relation.source) && ids.has(relation.target)) };
  return { workspaceId: state.workspaceId, viewMode: state.viewMode, topic: state.topic, focusTable: state.focusTable,
    snapshot: JSON.stringify(state.schema), schema, mode, current: new Map(tables.map(table => [table.id, { ...graphPosition(table.id) }])),
    proposed: mode === 'relations' ? layoutTables(schema, null) : null, layout: null, pending: false, error: '', status: '' };
}
function arrangementIsCurrent(proposal) {
  return proposal.workspaceId === state.workspaceId && proposal.snapshot === JSON.stringify(state.schema) && proposal.viewMode === state.viewMode && proposal.topic === state.topic && proposal.focusTable === state.focusTable;
}
function openArrangement(mode = 'relations') {
  if (!visibleTables().length) { showToast('افتح موضوعًا أو اختر جدولًا قبل الترتيب'); return; }
  state.layoutController?.abort(); state.arrangement = captureArrangement(mode); renderArrangement(); openDialog($('arrangeDialog'));
}
function renderArrangement() {
  const proposal = state.arrangement; if (!proposal) return;
  const modes = uiTabs([['relations', 'حسب الترابط'], ['ai', 'بالـAI']], proposal.mode, mode => {
    if (proposal.pending) return; state.arrangement = captureArrangement(mode); renderArrangement();
  }); modes.id = 'arrangeModes'; $('arrangeModes').replaceWith(modes);
  $('arrangeScope').value = state.viewMode === 'focus' ? `جدول محدد · ${state.schema.tables.find(table => table.id === state.focusTable)?.name || ''}`
    : state.topic === 'all' ? `كل المخطط · ${proposal.schema.tables.length} جدول` : `الموضوع الحالي · ${state.groups.find(group => group.id === state.topic)?.label || ''}`;
  $('arrangeProvider').value = providerLabel();
  renderMiniMap($('currentLayoutPreview'), proposal.schema.tables, proposal.schema.relations, proposal.current, NODE_WIDTH, nodeHeight);
  const preview = $('proposedLayoutPreview');
  if (proposal.proposed) renderMiniMap(preview, proposal.schema.tables, proposal.schema.relations, proposal.proposed, NODE_WIDTH, nodeHeight);
  else if (proposal.pending) {
    const loading = el('div', 'layout-pending'); for (let i = 0; i < 3; i++) loading.append(el('div', 'skeleton')); preview.replaceChildren(loading);
  } else preview.replaceChildren(el('p', 'field-hint', proposal.error ? 'تعذّر إنشاء المعاينة. يمكنك إعادة المحاولة.' : 'اضغط «اقتراح ترتيب» لإنشاء المعاينة.'));
  $('arrangeStatus').className = `notice${proposal.error ? ' error' : ''}`;
  $('arrangeStatus').textContent = proposal.error || proposal.status || `معاينة ${proposal.schema.tables.length} جدول. تتغيّر المواقع فقط؛ تبقى تعريفات الجداول وعلاقاتها كما هي.`;
  $('arrangeErrorActions').hidden = !proposal.error;
  $('applyArrangementButton').disabled = proposal.pending;
  $('applyArrangementButton').textContent = proposal.pending ? 'جارٍ التحليل…' : proposal.proposed ? 'تطبيق الترتيب' : proposal.error ? 'إعادة المحاولة' : 'اقتراح ترتيب';
  $('stopArrangementButton').hidden = !proposal.pending;
}
function applyArrangement() {
  const proposal = state.arrangement; if (!proposal?.proposed || proposal.pending) return false;
  if (!arrangementIsCurrent(proposal)) { showToast('تغيرت المساحة أو طريقة العرض. أعد اقتراح الترتيب.'); return false; }
  const persist = $('persistArrangement').checked !== false;
  if (proposal.viewMode === 'topics') {
    state.topicPositions = proposal.proposed;
    if (persist) localStorage.setItem(`${storageKey()}.topicLayout.${proposal.topic}`, JSON.stringify(Object.fromEntries(proposal.proposed)));
  } else if (proposal.viewMode === 'focus') {
    state.focusPositions = proposal.proposed;
    if (persist) localStorage.setItem(`${storageKey()}.focusLayout.${proposal.focusTable}`, JSON.stringify(Object.fromEntries(proposal.proposed)));
  } else {
    state.aiLayout = proposal.layout; state.positions = proposal.proposed;
    if (persist) { saveAiLayout(); savePositions(); }
  }
  state.hoveredTable = null; renderNodes(); requestAnimationFrame(() => fitView(false));
  showToast('تم تطبيق ترتيب الجداول'); return true;
}
async function arrangeWithAi() {
  state.arrangement ||= captureArrangement('ai');
  const proposal = state.arrangement;
  if (!proposal.schema.tables.length || proposal.pending) return;
  proposal.mode = 'ai'; proposal.pending = true; proposal.error = ''; proposal.status = 'يجري تحليل الجداول والعلاقات لتحديد المناطق والجداول المحورية…';
  state.layoutController = new AbortController();
  const controller = state.layoutController;
  renderArrangement();
  try {
    const answer = await askAi('layout', 'رتّب الجداول المعروضة إلى مناطق مفهومة وقلل الخطوط العابرة بين المناطق.', proposal.schema, controller.signal);
    if (controller.signal.aborted || state.arrangement !== proposal) return;
    if (!arrangementIsCurrent(proposal)) throw new Error('تغيرت المساحة أو طريقة العرض أثناء الترتيب. أعد المحاولة.');
    proposal.layout = parseAiLayout(answer, proposal.schema.tables);
    proposal.proposed = layoutTables(proposal.schema, proposal.layout);
    proposal.status = `اقتراح ${proposal.schema.tables.length} جدول في ${proposal.layout.zones.length} مناطق: ${proposal.layout.zones.map(zone => zone.name).join(' · ')}`;
  } catch (error) {
    proposal.error = error.name === 'AbortError' ? '' : error.message;
    if (error.name === 'AbortError') proposal.status = 'أُوقف الطلب. يمكنك إنشاء اقتراح جديد.';
    proposal.proposed = null;
  } finally {
    proposal.pending = false;
    if (state.arrangement === proposal) renderArrangement();
    if (state.layoutController === controller) state.layoutController = null;
  }
}
function buildHandoffPrompt(plan) {
  const operations = state.operations.slice(0, state.cursor);
  const summary = operations.map((operation, index) => `${index + 1}. ${describeOperation(operation, state.schema)}`).join('\n');
  return `مهمة تعديل مخطط PostgreSQL من ER Atlas

قواعد التنفيذ:
- افحص المخطط الحالي أولًا وتأكد أن بصمته أو بنيته تطابق المخطط المرجعي.
- نفّذ التغييرات بالترتيب داخل transaction واحدة.
- لا تغيّر أي عنصر غير مذكور في متغيرات المسودة.
- عند فشل أي خطوة نفّذ rollback واشرح السبب.
- افحص أثر DROP وNOT NULL وتغيير النوع قبل التنفيذ.
- إذا لم تكن لديك أداة اتصال بقاعدة البيانات، أعد migration SQL فقط ولا تدّع التنفيذ.

قاعدة البيانات: ${state.base.database}
بصمة المخطط: ${state.base.fingerprint || 'demo'}

ملخص التغييرات:
${summary}

متغيرات المسودة JSON:
${JSON.stringify(operations, null, 2)}

SQL المتوقع من ER Atlas للمقارنة والتحقق:
${plan.sql || '-- لا توجد أوامر'}

بعد الانتهاء أعد تقريرًا يحتوي على: ما نُفذ، ما تعذر، ونتيجة التحقق من العلاقات والأعمدة.`;
}

function setSchema(schema, demo = false) {
  state.linkMode = false; state.linkSource = null;
  $('selectionModeButton').setAttribute('aria-pressed', 'true');
  state.base = clone(schema); state.schema = clone(schema); state.demo = demo; state.topic = 'all';
  state.operations = []; state.cursor = 0; state.customGroups = null; state.aiLayout = null;
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey()) || '{}');
    if (Array.isArray(draft.operations)) {
      const cursor = Math.max(0, Math.min(draft.operations.length, Number(draft.cursor) || 0));
      replay(state.base, draft.operations.slice(0, cursor));
      state.operations = draft.operations; state.cursor = cursor;
    }
  } catch { showToast('تعذّر تحميل المسودة السابقة'); }
  try {
    const groups = JSON.parse(localStorage.getItem(topicKey()) || 'null');
    if (Array.isArray(groups)) state.customGroups = normalizeTopics(groups, replay(state.base, state.operations.slice(0, state.cursor)).tables.map(table => table.id));
  } catch { /* invalid topic settings */ }
  try {
    const savedLayout = JSON.parse(localStorage.getItem(aiLayoutKey()) || 'null');
    if (savedLayout) state.aiLayout = normalizeAiLayout(savedLayout);
  } catch { /* invalid saved AI layout is ignored */ }
  state.selectedTable = null; state.selectedRelation = null; state.hoveredTable = null;
  $('details').hidden = true;
  const kind = activeWorkspace()?.kind;
  if (state.workspaceId === SUFRA_PRODUCTS_ID) {
    $('connectionLabel').textContent = 'لقطة من الكود';
  } else if (kind === 'ideas') {
    $('connectionLabel').textContent = 'مساحة أفكار';
  } else if (state.connectionLive) {
    $('connectionLabel').textContent = schema.database;
  } else if (kind === 'database') {
    $('connectionLabel').textContent = schema.tables.length
      ? 'نسخة محفوظة · ربط'
      : 'ربط PostgreSQL';
  } else {
    $('connectionLabel').textContent = 'وضع التجربة';
  }
  $('connectionButton').classList.toggle('connected', state.connectionLive);
  $('mapTitle').textContent = kind === 'ideas' ? activeWorkspace().name : demo ? 'خريطة نموذجية' : schema.database;
  if (state.workspaceId === SUFRA_PRODUCTS_ID) {
    $('mapSubtitle').textContent =
      'المنتجات · الاشتراكات · المدفوعات · أجهزة التشغيل المقترحة';
  } else if (kind === 'ideas') {
    $('mapSubtitle').textContent = 'فكرة ومخطط في مساحة مستقلة';
  } else if (state.connectionLive) {
    $('mapSubtitle').textContent = 'عرض مباشر لبنية PostgreSQL';
  } else if (kind === 'database') {
    $('mapSubtitle').textContent = schema.tables.length
      ? 'المخطط محفوظ محليًا · أعد الاتصال للتحديث'
      : 'مساحة جاهزة لربط PostgreSQL';
  } else {
    $('mapSubtitle').textContent = 'استكشف العلاقات بين الجداول';
  }
  $('aiDialogTitle').textContent = kind === 'ideas' ? 'ناقش فكرتك مع AI' : 'اسأل عن المخطط';
  $('arrangeWithAiButton').hidden = !schema.tables.length;
  $('aiArrangeButton').disabled = !schema.tables.length;
  activeWorkspace().schema = clone(schema);
  buildGroups();
  loadPositions(); refreshDraft({ fit: true });
}
function openConnectionDialog() {
  const settings = activeWorkspace()?.connection;
  if (settings) {
    const form = $('connectForm');
    for (const key of ['host', 'port', 'database', 'user']) if (settings[key] != null) form.elements.namedItem(key).value = settings[key];
    form.elements.namedItem('ssl').checked = Boolean(settings.ssl);
  }
  $('connectForm').elements.namedItem('password').value = '';
  $('connectError').hidden = true;
  $('connectDialog').showModal();
}

function closeHeaderMenus() {
  for (const [trigger, menu] of [['toolsButton', 'toolsMenu'], ['aiMenuButton', 'aiMenu'], ['topicSwitchButton', 'topics']]) {
    $(menu).hidden = true; $(trigger).setAttribute('aria-expanded', 'false');
  }
}
function setNavbarSearch(open, { focus = false } = {}) {
  document.querySelector('.topbar').classList.toggle('search-open', open);
  $('searchToggleButton').setAttribute('aria-expanded', String(open));
  $('searchToggleButton').setAttribute('aria-label', open ? 'إغلاق البحث' : 'فتح البحث');
  if (focus) (open ? $('searchInput') : $('searchToggleButton')).focus();
}
function providerLabel() {
  return { 'codex-cli': 'Codex على الجهاز', 'claude-cli': 'Claude Code على الجهاز', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', compatible: 'خدمة متوافقة' }[$('aiProvider').value] || 'Codex على الجهاز';
}
function renderProviderChoices() {
  const root = $('localProviderChoices'); if (!root) return; root.replaceChildren();
  for (const [id, label] of [['codex-cli', 'Codex على الجهاز'], ['claude-cli', 'Claude Code على الجهاز']]) {
    const choice = el('label', 'choice'), radio = el('input'); radio.type = 'radio'; radio.name = 'localProvider'; radio.checked = $('aiProvider').value === id;
    const copy = el('span'); copy.append(el('strong', '', label), el('small', '', 'CLI · يستخدم تسجيل الدخول الحالي دون مفتاح'));
    radio.addEventListener('change', () => { $('aiProvider').value = id; $('aiProvider').dispatchEvent(new Event('change')); }); choice.append(radio, copy); root.append(choice);
  }
}
function openAiConversation() {
  closeHeaderMenus(); updateAiSettings(); renderAiMessages(); openDialog($('aiDialog')); $('aiQuestion').focus();
}
function openCodeDialog() {
  closeHeaderMenus(); syncCodeSource(); updateAiSettings(); openDialog($('codeDialog'));
}
function openQuickActions() {
  closeHeaderMenus();
  const commands = [['جدول جديد', () => openEditor('addTable')], ['إضافة علاقة', () => openEditor('addRelation')], ['تنظيم المواضيع', () => $('topicManageButton').click()], ['ترتيب الجداول', () => openArrangement()], ['ترتيب بالـAI', () => openArrangement('ai')], ['اسأل عن المخطط', openAiConversation], ['مراجعة المسودة', () => openDialog($('changesPanel'))], ['اتصال PostgreSQL', openConnectionDialog], ['تحليل كود المشروع', openCodeDialog], ['مساحة عمل جديدة', () => openWorkspaceDialog()], ['إظهار كامل المخطط', () => fitView(false, { overview: true })], ['إعدادات المساعد', () => openDialog($('aiSettingsDialog'))]];
  const root = $('quickActionList'); root.replaceChildren();
  for (const [label, action] of commands) root.append(uiButton(label, () => { $('quickActionsDialog').close(); action(); }, 'quick-command'));
  $('quickSearch').value = ''; openDialog($('quickActionsDialog')); $('quickSearch').focus();
}

function installEvents() {
  initOverlays();
  const viewport = $('viewport');
  $('relationshipDialog').addEventListener('close', () => { state.selectedRelation = null; updateEmphasis(); });
  for (const [trigger, menu] of [['toolsButton', 'toolsMenu'], ['aiMenuButton', 'aiMenu'], ['topicSwitchButton', 'topics']]) {
    $(trigger).addEventListener('click', () => {
      const open = $(menu).hidden; closeHeaderMenus(); closeViewMenu(); closeWorkspaceMenu();
      $(menu).hidden = !open; $(trigger).setAttribute('aria-expanded', String(open));
      if (open) $(menu).querySelector('button')?.focus();
    });
    $(menu).addEventListener('click', event => { if (event.target.closest('button')) closeHeaderMenus(); });
    $(menu).addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return;
      event.preventDefault(); if (event.key === 'Escape') { closeHeaderMenus(); $(trigger).focus(); return; }
      const items = [...$(menu).querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.header-menu,.topic-switcher')) closeHeaderMenus(); });
  $('aiSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('conversationSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('arrangeSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('saveAiSettingsButton').addEventListener('click', () => { updateAiSettings({ save: true }); $('aiSettingsDialog').close(); showToast('حُفظت إعدادات المساعد'); });
  $('codeSourceButton').addEventListener('click', openCodeDialog); $('topicAnalysisButton').addEventListener('click', openCodeDialog);
  $('selectionModeButton').addEventListener('click', () => {
    state.linkMode = false; state.linkSource = null;
    $('selectionModeButton').setAttribute('aria-pressed', 'true'); renderNodes(); showToast('اختر جدولًا أو علاقة لعرض التفاصيل');
  });
  $('quickActionsButton').addEventListener('click', openQuickActions);
  $('quickSearch').addEventListener('input', event => { for (const item of $('quickActionList').children) item.hidden = !item.textContent.includes(event.target.value.trim()); });
  $('applyArrangementButton').addEventListener('click', () => {
    if (!state.arrangement?.proposed) { arrangeWithAi(); return; }
    if (applyArrangement()) $('arrangeDialog').close();
  });
  $('stopArrangementButton').addEventListener('click', () => state.layoutController?.abort());
  $('arrangeDialog').addEventListener('close', () => { state.layoutController?.abort(); });
  $('stopAiButton').addEventListener('click', () => state.aiController?.abort());
  $('discardDraftButton').addEventListener('click', () => confirmAction('تجاهل المسودة؟', `سيُزال ${state.cursor} تغييرات مقترحة من هذه المساحة.`, 'سيعود المخطط إلى التعريف الأصلي. لا تتغير قاعدة البيانات.', () => {
    state.operations = []; state.cursor = 0; saveDraft(); refreshDraft(); showToast('تم تجاهل المسودة');
  }, 'تجاهل المسودة'));
  $('viewModeButton').addEventListener('click', () => {
    const opening = $('viewModeMenu').hidden;
    $('viewModeMenu').hidden = !opening;
    $('viewModeButton').setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.view-switcher')) closeViewMenu(); });
  $('backTopicsButton').addEventListener('click', () => {
    state.topic = 'all'; activeWorkspace().topic = 'all'; saveWorkspaces();
    buildTopicPositions(); renderTopics(); renderView(); renderNodes(); fitView(false);
  });
  $('chooseFocusButton').addEventListener('click', () => {
    state.focusTable = null; state.focusPositions = null;
    renderView(); renderNodes(); fitView(false);
    $('viewOverlay').querySelector('input')?.focus();
  });
  $('workspaceSwitchButton').addEventListener('click', toggleWorkspaceMenu);
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.workspace-switcher')) closeWorkspaceMenu(); });
  $('newWorkspaceButton').addEventListener('click', () => openWorkspaceDialog());
  $('renameWorkspaceButton').addEventListener('click', () => openWorkspaceDialog(true));
  $('closeWorkspaceDialog').addEventListener('click', () => $('workspaceDialog').close());
  $('workspaceForm').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('workspaceName').value.trim(); if (!name) return;
    if (state.editingWorkspace) {
      const workspace = activeWorkspace(); workspace.name = name;
      if (workspace.kind === 'ideas' || !workspace.schema?.tables.length) {
        workspace.schema.database = name; state.base.database = name; state.schema.database = name;
        $('mapTitle').textContent = name; renderEmptyWorkspace();
      }
      saveWorkspaces(); renderWorkspaces(); $('workspaceDialog').close(); return;
    }
    const kind = new FormData(event.currentTarget).get('kind') === 'ideas' ? 'ideas' : 'database';
    const workspace = { id: crypto.randomUUID(), name, kind, schema: blankSchema(name), topic: 'all', connection: null };
    state.workspaces.push(workspace); $('workspaceDialog').close();
    await activateWorkspace(workspace.id);
    if (kind === 'database') openConnectionDialog();
  });
  $('emptyPrimaryButton').addEventListener('click', () => activeWorkspace()?.kind === 'ideas' ? openEditor('addTable') : openConnectionDialog());
  $('emptyAiButton').addEventListener('click', openAiConversation);
  $('addTableButton').addEventListener('click', () => openEditor('addTable'));
  $('mapTabButton').addEventListener('click', () => setViewMode('map'));
  $('tablesTabButton').addEventListener('click', () => setViewMode('tables'));
  $('linkModeButton').addEventListener('click', () => {
    openEditor('addRelation');
  });
  $('changesButton').addEventListener('click', () => openDialog($('changesPanel')));
  $('closeChanges').addEventListener('click', () => $('changesPanel').close());
  $('undoButton').addEventListener('click', () => stepDraft(-1));
  $('redoButton').addEventListener('click', () => stepDraft(1));
  $('closeEditDialog').addEventListener('click', () => $('editDialog').close());
  $('editForm').addEventListener('submit', event => {
    event.preventDefault(); $('editError').hidden = true;
    const data = new FormData(event.currentTarget), context = state.editContext;
    const value = name => String(data.get(name) || '').trim();
    const column = { name: value('name'), type: value('type'), nullable: data.has('nullable'), default: value('default') || null };
    let operation;
    switch (context.kind) {
      case 'addTable': operation = { type: 'addTable', id: `draft:${crypto.randomUUID()}`, schema: value('schema'), name: value('name') }; break;
      case 'renameTable': operation = { type: 'renameTable', tableId: context.tableId, name: value('name') }; break;
      case 'addColumn': operation = { type: 'addColumn', tableId: context.tableId, column: { ...column, primary: data.has('primary') } }; break;
      case 'editColumn': operation = { type: 'updateColumn', tableId: context.tableId, columnName: context.columnName, patch: column }; break;
      case 'addRelation': operation = { type: 'addRelation', relation: { id: `draft:${crypto.randomUUID()}`, name: `fk_${Date.now()}`, source: value('source'), target: value('target'), pairs: [{ source: value('sourceColumn'), target: value('targetColumn') }], onDelete: value('onDelete') || 'a' } }; break;
    }
    try {
      if (operation.type === 'addTable' && context.position) state.positions.set(operation.id, context.position);
      stage(operation); $('editDialog').close(); if (operation.type === 'addTable') selectTable(operation.id);
    }
    catch (error) { $('editError').textContent = error.message; $('editError').hidden = false; }
  });
  $('topicManageButton').addEventListener('click', () => {
    syncCodeSource(); renderTopicEditor(); updateAiSettings(); loadLocalAiStatus(); $('topicsDialog').showModal();
  });
  $('topicSourceRoot').addEventListener('change', () => { saveCodeSource(); syncCodeSource(); });
  $('analyzeTopicCodeButton').addEventListener('click', analyzeTopicCode);
  loadCodeSettings();
  $('closeTopicsDialog').addEventListener('click', () => $('topicsDialog').close());
  $('resetTopicsButton').addEventListener('click', () => {
    state.customGroups = null; localStorage.removeItem(topicKey()); buildGroups();
    refreshTopics(); renderTopicEditor(); showToast('تمت استعادة التقسيم التلقائي');
  });
  $('topicAiProvider').addEventListener('change', () => {
    if ($('topicAiProvider').value === 'settings') {
      openDialog($('aiSettingsDialog'));
      return;
    }
    $('aiProvider').value = $('topicAiProvider').value; $('aiModel').value = '';
    updateAiSettings({ save: true }); loadLocalAiStatus();
  });
  $('aiButton').addEventListener('click', openAiConversation);
  $('aiArrangeButton').addEventListener('click', () => openArrangement('ai'));
  $('closeAiDialog').addEventListener('click', () => $('aiDialog').close());
  const defaultModels = { 'codex-cli': '', 'claude-cli': '', openai: 'gpt-5-mini', anthropic: 'claude-sonnet-4-5', gemini: 'gemini-2.5-flash', compatible: 'llama3.2' };
  try {
    const settings = JSON.parse(localStorage.getItem('eratlas.ai.settings.v1') || 'null');
    if (settings && Object.hasOwn(defaultModels, settings.provider)) {
      $('aiProvider').value = settings.provider; $('aiModel').value = typeof settings.model === 'string' ? settings.model : defaultModels[settings.provider];
      $('aiEndpoint').value = typeof settings.endpoint === 'string' ? settings.endpoint : '';
    }
  } catch {}
  updateAiSettings(); loadLocalAiStatus();
  $('aiProvider').addEventListener('change', () => {
    $('aiModel').value = defaultModels[$('aiProvider').value];
    $('aiEndpointWrap').hidden = $('aiProvider').value !== 'compatible';
    if ($('aiProvider').value === 'compatible' && !$('aiEndpoint').value) $('aiEndpoint').value = 'http://127.0.0.1:11434/v1';
    updateAiSettings({ save: true }); loadLocalAiStatus();
  });
  $('aiModel').addEventListener('change', () => updateAiSettings({ save: true }));
  $('aiEndpoint').addEventListener('change', () => updateAiSettings({ save: true }));
  $('aiForm').addEventListener('submit', async event => {
    if (state.aiController) { event.preventDefault(); return; }
    event.preventDefault(); const button = $('askAiButton'); button.disabled = true;
    const question = $('aiQuestion').value.trim(); if (!question) { button.disabled = false; return; }
    const workspaceId = state.workspaceId, controller = new AbortController(); state.aiController = controller;
    $('aiQuestion').disabled = true;
    $('stopAiButton').hidden = false; button.textContent = 'جارٍ إعداد الإجابة…';
    renderAiMessages('جارٍ إعداد الإجابة...');
    const selected = state.selectedTable ? `الجدول المحدد: ${state.schema.tables.find(t => t.id === state.selectedTable)?.name}. `
      : state.selectedRelation ? `العلاقة المحددة: ${state.schema.relations.find(r => r.id === state.selectedRelation)?.name}. ` : '';
    try {
      const answer = await askAi(activeWorkspace()?.kind === 'ideas' ? 'ideas' : 'explain', `${selected}${question}`, state.schema, controller.signal);
      if (controller.signal.aborted || workspaceId !== state.workspaceId) return;
      state.aiMessages.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      state.aiMessages = state.aiMessages.slice(-30); saveAiMessages(); renderAiMessages(); $('aiQuestion').value = '';
    }
    catch (error) { if (workspaceId === state.workspaceId) renderAiMessages(error.name === 'AbortError' ? 'أُوقف الطلب. يمكنك تعديل السؤال وإرساله مجددًا.' : error.message, error.name !== 'AbortError'); }
    finally { if (state.aiController === controller) state.aiController = null; button.disabled = false; button.textContent = 'إرسال السؤال'; $('stopAiButton').hidden = true; $('aiQuestion').disabled = false; }
  });
  $('arrangeWithAiButton').addEventListener('click', arrangeWithAi);
  $('suggestTopicsButton').addEventListener('click', async () => {
    const button = $('suggestTopicsButton'); button.disabled = true; button.textContent = 'جارٍ الاقتراح...';
    const workspaceId = state.workspaceId, snapshot = JSON.stringify(state.schema);
    saveCodeSource();
    const sourceRoot = $('topicSourceRoot').value.trim();
    $('topicAiStatus').textContent = 'يجري تنظيم المواضيع حسب الكود واستخدام الجداول الفعلي...';
    try {
      const pending = askAi('topics', 'نظّم الجداول حسب سيناريوهات الكود الفعلية مع تكرار الجداول المشتركة حيث تحتاجها المهمة.');
      $('topicAiStatus').textContent = 'يجري تحليل الكود وتنظيم المواضيع حسب استخدام الجداول الفعلي...';
      const data = await pending;
      if (workspaceId !== state.workspaceId || snapshot !== JSON.stringify(state.schema) || sourceRoot !== $('topicSourceRoot').value.trim()) throw new Error('تغيرت المساحة أو الجداول أو مسار الكود أثناء الاقتراح. أعد المحاولة.');
      const suggestions = parseTopicSuggestions(data.answer);
      if (!suggestions.length) throw new Error('لم يرجع AI تبويبات صالحة');
      openTopicProposal(suggestions, data.sourceAnalysis, { workspaceId, schema: snapshot, sourceRoot });
      $('topicAiStatus').textContent = `راجع اقتراح ${suggestions.length} مواضيع قبل اعتماده.`;
    } catch (error) { $('topicAiStatus').textContent = error.message; showToast(error.message); }
    finally { button.disabled = !state.schema.tables.length; button.textContent = 'اقتراح بالـAI'; }
  });
  $('reviewButton').addEventListener('click', async () => {
    const workspaceId = state.workspaceId, draftSnapshot = JSON.stringify(state.operations.slice(0, state.cursor));
    $('planError').hidden = true; $('handoffResult').hidden = true; $('planPrompt').textContent = 'جارٍ تجهيز متغيرات المسودة...';
    $('planSummary').textContent = `${state.cursor} تغييرات محفوظة محليًا — لن يكتب ER Atlas في قاعدة البيانات.`;
    $('sendToAiButton').disabled = true;
    $('planDialog').showModal();
    try {
      const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: state.operations.slice(0, state.cursor), baseFingerprint: state.base.fingerprint,
          demoSchema: !state.connectionLive ? state.base : undefined }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذّر إعداد SQL');
      if (workspaceId !== state.workspaceId || draftSnapshot !== JSON.stringify(state.operations.slice(0, state.cursor))) throw new Error('تغيرت المسودة أثناء المراجعة. جهّز الطلب مرة أخرى.');
      state.plan = result; state.handoffPrompt = buildHandoffPrompt(result); $('planPrompt').textContent = state.handoffPrompt;
      $('sendToAiButton').disabled = !result.statements.length;
    } catch (error) { $('planPrompt').textContent = ''; $('planError').textContent = error.message; $('planError').hidden = false; }
  });
  $('closePlanDialog').addEventListener('click', () => $('planDialog').close());
  $('copyPromptButton').addEventListener('click', async () => {
    await copyText(state.handoffPrompt);
  });
  $('sendToAiButton').addEventListener('click', async () => {
    if (!state.plan) return;
    const button = $('sendToAiButton'); button.disabled = true; $('planError').hidden = true;
    $('handoffResult').hidden = false; $('handoffResult').textContent = 'AI يراجع متغيرات المسودة ويجهز خطة التعديل...';
    try {
      $('handoffResult').textContent = await askAi('migration', state.handoffPrompt);
    } catch (error) { $('handoffResult').hidden = true; $('planError').textContent = `${error.message} — يمكنك نسخ الـPrompt وإرساله إلى وكيل AI آخر.`; $('planError').hidden = false; }
    finally { button.disabled = false; }
  });
  viewport.addEventListener('contextmenu', showContextMenu);
  window.addEventListener('pointerdown', event => { if (!event.target.closest?.('#contextMenu')) closeContextMenu(); }, true);
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.table-node')) return;
    viewport.setPointerCapture(event.pointerId);
    state.drag = { type: 'pan', startX: event.clientX, startY: event.clientY, originX: state.x, originY: state.y, moved: false };
    viewport.classList.add('panning');
  });
  window.addEventListener('pointermove', event => {
    const drag = state.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.type === 'node') {
      if (drag.moved && !drag.routeInvalidated) { state.routeGeneration++; drag.routeInvalidated = true; }
      const point = { x: drag.originX + dx / state.scale, y: drag.originY + dy / state.scale };
      (state.viewMode === 'focus' ? state.focusPositions : state.viewMode === 'topics' ? state.topicPositions : state.positions).set(drag.id, point);
      drag.card.style.left = `${point.x}px`; drag.card.style.top = `${point.y}px`;
      if (!state.edgeFrame) state.edgeFrame = requestAnimationFrame(() => {
        state.edgeFrame = null;
        if (state.drag?.type === 'node') updateEdgesForTable(state.drag.id);
      });
    } else {
      state.x = drag.originX + dx; state.y = drag.originY + dy; transform();
    }
  });
  window.addEventListener('pointerup', () => {
    const drag = state.drag;
    if (!drag) return;
    if (drag.type === 'node') {
      if (state.edgeFrame) { cancelAnimationFrame(state.edgeFrame); state.edgeFrame = null; }
      if (drag.moved) {
        if (state.viewMode === 'map') savePositions();
        if (state.viewMode === 'topics') localStorage.setItem(`${storageKey()}.topicLayout.${state.topic}`, JSON.stringify(Object.fromEntries(state.topicPositions)));
        if (state.viewMode === 'focus') localStorage.setItem(`${storageKey()}.focusLayout.${state.focusTable}`, JSON.stringify(Object.fromEntries(state.focusPositions)));
        state.edgeRoutes = null; renderEdges(); state.suppressClickUntil = performance.now() + 150;
      }
      else selectTable(drag.id, { inspect: false });
    } else if (drag.moved) {
      state.suppressClickUntil = performance.now() + 150;
    }
    viewport.classList.remove('panning');
    state.drag = null;
  });
  viewport.addEventListener('wheel', event => {
    event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
  }, { passive: false });
  viewport.addEventListener('click', event => {
    if (performance.now() < state.suppressClickUntil) return;
    if (!event.target.closest('.table-node')) {
      const relationId = canvasRelationAt(event.clientX, event.clientY);
      if (relationId) { selectRelation(relationId); return; }
    }
    if (event.target === viewport || event.target === $('world') || event.target === $('nodes') || event.target === $('edges')) {
      state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis();
    }
  });
  $('zoomIn').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoom(1.2, r.left + r.width / 2, r.top + r.height / 2); });
  $('zoomOut').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoom(1 / 1.2, r.left + r.width / 2, r.top + r.height / 2); });
  $('fitButton').addEventListener('click', () => fitView(state.topic !== 'all', { overview: true }));
  $('readableViewButton').addEventListener('click', () => fitView(state.topic !== 'all'));
  $('arrangeButton').addEventListener('click', () => openArrangement());
  $('closeDetails').addEventListener('click', () => { state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis(); });
  $('searchInput').addEventListener('input', updateEmphasis);
  $('searchToggleButton').addEventListener('click', () => setNavbarSearch($('searchToggleButton').getAttribute('aria-expanded') !== 'true', { focus: true }));
  $('searchInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const first = searchMatches(event.currentTarget.value.toLowerCase()).values().next().value;
      if (first) {
        if (state.viewMode === 'topics') { setViewMode('focus'); chooseFocusTable(first); selectTable(first); return; }
        selectTable(first);
        if (state.viewMode === 'tables') setViewMode('map');
        selectTable(first); centerTable(first);
      }
    }
  });
  window.addEventListener('keydown', event => {
    const editing = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); openQuickActions(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && (!$('toolsMenu').hidden || !$('aiMenu').hidden || !$('topics').hidden)) { closeHeaderMenus(); return; }
    if (event.key === 'Escape' && !$('workspaceMenu').hidden) { closeWorkspaceMenu({ focus: true }); return; }
    if (event.key === 'Escape' && !$('viewModeMenu').hidden) { closeViewMenu(); $('viewModeButton').focus(); return; }
    if (event.key === '/' && !editing) { event.preventDefault(); setNavbarSearch(true, { focus: true }); }
    if (event.key === 'Escape' && document.querySelector('.topbar.search-open') && matchMedia('(max-width: 880px)').matches) { event.preventDefault(); setNavbarSearch(false, { focus: true }); return; }
    if (event.key === 'Escape' && !$('connectDialog').open) { closeContextMenu(); state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis(); }
  });
  let previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight };
  window.addEventListener('resize', () => {
    if (!state.schema) { previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight }; return; }
    state.x += (viewport.clientWidth - previousViewport.width) / 2;
    state.y += (viewport.clientHeight - previousViewport.height) / 2;
    previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight }; transform();
  });
  $('connectionButton').addEventListener('click', openConnectionDialog);
  $('closeDialog').addEventListener('click', () => $('connectDialog').close());
  $('demoButton').addEventListener('click', async () => {
    if (state.connectionLive) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
    const workspace = activeWorkspace(); workspace.kind = 'demo'; workspace.connection = null;
    state.connectionLive = false;
    setSchema(sampleSchema(), true); $('connectDialog').close(); showToast('تم فتح الخريطة النموذجية');
    saveWorkspaces(); renderWorkspaces();
  });
  $('refreshButton').addEventListener('click', async () => {
    if (!state.connectionLive) { openConnectionDialog(); showToast('أعد الاتصال لتحديث المخطط من PostgreSQL'); return; }
    try {
      const response = await fetch('/api/schema'); const data = await response.json();
      if (!response.ok || !data.tables) throw new Error(data.error || 'لا يوجد اتصال حالي');
      setSchema(data, false); saveWorkspaces(); showToast('تم تحديث الخريطة');
    } catch (error) { showToast(error.message); }
  });
  $('connectForm').addEventListener('submit', async event => {
    event.preventDefault(); $('connectError').hidden = true;
    const button = $('submitConnection'); button.disabled = true; button.firstChild.textContent = 'جارٍ الاتصال... ';
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries()); payload.ssl = form.has('ssl');
    try {
      const response = await fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذّر الاتصال');
      const workspace = activeWorkspace(); workspace.kind = 'database';
      workspace.connection = { host: payload.host, port: payload.port, database: payload.database, user: payload.user, ssl: payload.ssl };
      state.connectionLive = true;
      setSchema(result, false); saveWorkspaces(); renderWorkspaces(); $('connectDialog').close(); showToast(`تم قراءة ${result.tables.length} جدولًا`);
    } catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
    finally { button.disabled = false; button.textContent = 'اتصال وعرض الخريطة'; }
  });
}

async function bootstrap() {
  installEvents();
  let serverSchema = null;
  try {
    const response = await fetch('/api/schema');
    if (response.ok) { const data = await response.json(); if (data.tables) serverSchema = data; }
  } catch { /* app can still open in demo mode */ }
  let registry;
  try { registry = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || 'null'); } catch { registry = null; }
  if (Array.isArray(registry?.items) && registry.items.length) {
    state.workspaces = registry.items.filter(item => item?.id && item?.name && ['database', 'demo', 'ideas'].includes(item.kind));
    if (state.workspaces.length) {
      if (!state.workspaces.some(item => item.id === SUFRA_PRODUCTS_ID)) {
        state.workspaces.push(sufraProductsWorkspace());
      }
      const productsWorkspace = state.workspaces.find(item => item.id === SUFRA_PRODUCTS_ID);
      includeProposedDevices(productsWorkspace);
      const requestedId = location.hash.slice(1);
      const active = state.workspaces.find(item => item.id === requestedId)
        || state.workspaces.find(item => item.id === registry.activeId)
        || state.workspaces[0];
      const live = active.kind === 'database' && Boolean(serverSchema && active.schema?.database === serverSchema.database);
      if (live) active.schema = serverSchema;
      else if (serverSchema) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
      await activateWorkspace(active.id, { initial: true, live });
      return;
    }
  }
  const first = serverSchema || sampleSchema();
  state.workspaces = [
    {
      id: 'legacy',
      name: serverSchema ? first.database : 'التجربة',
      kind: serverSchema ? 'database' : 'demo',
      schema: first,
      topic: 'all',
      connection: null
    },
    sufraProductsWorkspace()
  ];
  const requestedId = location.hash.slice(1);
  const initialId = requestedId === 'legacy' ? 'legacy' : SUFRA_PRODUCTS_ID;
  await activateWorkspace(initialId, {
    initial: true,
    live: Boolean(serverSchema && initialId === 'legacy')
  });
  if (!serverSchema && initialId === 'legacy' && !sessionStorage.getItem('wasla.seen')) {
    sessionStorage.setItem('wasla.seen', '1');
    setTimeout(openConnectionDialog, 450);
  }
}

bootstrap();
