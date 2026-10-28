// Workspaces: the switcher, loading a schema into one, and moving them in and out of files.
import { applyOperation, replay, clone } from './model.js';
import { store } from './storage.js';
import { buildExport, parseExport, recoverOperations } from './workspace-io.js';
import { normalizeTopics } from './topics.js';
import { icon } from './ui.js';
import { $, state, activeWorkspace, blankSchema, saveWorkspaces, storageKey, el, confirmAction, showToast, slug } from './core.js';
import { scheduleFitChrome } from './chrome.js';
import { renderTopics, renderView } from './views.js';
import { buildTopicPositions, aiLayoutKey, loadPositions, normalizeAiLayout } from './layout.js';
import { renderNodes, fitView } from './canvas.js';
import { readColumnNotesStore } from './notes.js';
import { draftKey, saveDraft, refreshDraft } from './editor.js';
import { buildGroups, topicKey, syncCodeSource } from './groups.js';
import { renderAiMessages } from './chat.js';
import { openConnectionDialog } from './connect.js';
const LEGACY_SUFRA_ID = 'sufra-products-2026-09-27';
export function closeWorkspaceMenu({ focus = false } = {}) {
  $('workspaceMenu').hidden = true;
  $('workspaceSwitchButton').setAttribute('aria-expanded', 'false');
  if (focus) $('workspaceSwitchButton').focus();
}
export function toggleWorkspaceMenu() {
  const opening = $('workspaceMenu').hidden;
  $('workspaceMenu').hidden = !opening;
  $('workspaceSwitchButton').setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  filterWorkspaces('');
  const active = $('workspaceTabs').querySelector('.workspace-option.active');
  active?.scrollIntoView({ block: 'nearest' });
  ($('workspaceFilterWrap').hidden ? active : $('workspaceFilter'))?.focus();
}
// Arabic counts: the noun is plural from 3 to 10 and singular otherwise.
const workspaceCountLabel = n => n === 1 ? 'مساحة واحدة' : n === 2 ? 'مساحتان' : n >= 3 && n <= 10 ? `${n} مساحات` : `${n} مساحة`;
// Long lists get a filter; it matches names and the kind line under them.
const FILTER_FROM = 7;
function filterWorkspaces(query) {
  $('workspaceFilter').value = query;
  const needle = query.trim().toLowerCase();
  let shown = 0;
  for (const option of $('workspaceTabs').children) {
    option.hidden = Boolean(needle) && !option.textContent.toLowerCase().includes(needle);
    if (!option.hidden) shown++;
  }
  $('workspaceFilterEmpty').hidden = shown > 0;
}
export function bindWorkspaceMenu() {
  $('workspaceFilter').addEventListener('input', event => filterWorkspaces(event.target.value));
  $('workspaceFilter').addEventListener('keydown', event => {
    const first = [...$('workspaceTabs').children].find(option => !option.hidden);
    if (event.key === 'ArrowDown') { event.preventDefault(); first?.focus(); }
    if (event.key === 'Enter' && first) { event.preventDefault(); first.click(); }
  });
  // Arrow keys walk the visible options; from the top one, ArrowUp returns to the filter.
  $('workspaceTabs').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...$('workspaceTabs').children].filter(option => !option.hidden);
    const index = options.indexOf(document.activeElement);
    event.preventDefault();
    if (event.key === 'ArrowUp' && index <= 0 && !$('workspaceFilterWrap').hidden) { $('workspaceFilter').focus(); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    options[next]?.focus();
  });
}
export function renderWorkspaces() {
  const tabs = $('workspaceTabs'); tabs.replaceChildren();
  $('workspaceCurrentName').textContent = activeWorkspace()?.name || 'مساحة العمل';
  $('workspaceStatus').style.filter = state.connectionLive ? '' : 'grayscale(1)';
  $('workspaceSwitchButton').title = state.connectionLive ? 'اتصال PostgreSQL نشط' : 'مخطط محفوظ على الجهاز';
  $('workspaceMenuCount').textContent = workspaceCountLabel(state.workspaces.length);
  $('workspaceFilterWrap').hidden = state.workspaces.length < FILTER_FROM;
  for (const workspace of state.workspaces) {
    const button = el('button', `workspace-option${workspace.id === state.workspaceId ? ' active' : ''}`);
    button.type = 'button';
    button.title = workspace.name;
    button.dataset.kind = workspace.kind || 'database';
    if (workspace.id === state.workspaceId) button.setAttribute('aria-current', 'page');
    const mark = icon(workspace.kind === 'ideas' ? 'ai' : workspace.kind === 'demo' ? 'table' : 'database'); mark.classList.add('workspace-option-icon');
    const copy = el('span', 'workspace-option-copy');
    const tableTotal = workspace.schema?.tables?.length || 0;
    const description = workspace.kind === 'ideas'
      ? (tableTotal ? `${tableTotal} جدول · أفكار ومخطط حر` : 'أفكار ومخطط حر')
      : workspace.kind === 'demo'
        ? 'الخريطة النموذجية'
        : `${tableTotal} جدول · PostgreSQL`;
    copy.append(el('strong', '', workspace.name), el('small', '', description));
    button.append(mark, copy);
    if (workspace.id === state.workspaceId) { const check = icon('check'); check.classList.add('workspace-option-check'); button.append(check); }
    button.addEventListener('click', async () => { closeWorkspaceMenu({ focus: true }); await activateWorkspace(workspace.id); });
    tabs.append(button);
  }
  if (!$('workspaceMenu').hidden) filterWorkspaces($('workspaceFilter').value);
  scheduleFitChrome();
}
export function renderEmptyWorkspace() {
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
export async function activateWorkspace(id, { initial = false, live = false } = {}) {
  const next = state.workspaces.find(item => item.id === id);
  if (!next || (!initial && id === state.workspaceId)) return;
  if (!initial && state.connectionLive) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
  if (!initial && activeWorkspace()) activeWorkspace().topic = state.topic;
  state.workspaceId = id; state.connectionLive = live;
  state.viewMode = ['map', 'tables', 'topics', 'focus'].includes(next.viewMode) ? next.viewMode : 'map';
  state.focusTable = next.focusTable || null; state.focusPositions = null; state.topicPositions = null;
  state.aiController?.abort(); state.aiPending = null; state.aiFailed = null; state.aiMessages = [];
  state.linkMode = false; state.linkSource = null; state.plan = null; state.handoffPrompt = '';
  $('linkModeButton').setAttribute('aria-pressed', 'false');
  state.scale = 1; state.x = 0; state.y = 0;
  $('changesPanel').close(); $('searchInput').value = ''; $('searchCount').hidden = true; state.searchIndex = -1;
  state.aiController?.abort(); state.layoutController?.abort(); state.arrangement = null;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  setSchema(next.schema || blankSchema(next.name), next.kind !== 'database');
  if (next.topic && state.groups.some(group => group.id === next.topic) && state.viewMode === 'topics') {
    state.topic = next.topic; buildTopicPositions(); renderTopics(); renderView(); renderNodes(); requestAnimationFrame(() => fitView(true));
  }
  try { const messages = JSON.parse(store.getItem(`${storageKey()}.conversation`) || '[]'); if (Array.isArray(messages)) state.aiMessages = messages.filter(m => ['user','assistant'].includes(m.role) && typeof m.content === 'string').slice(-30); } catch { /* old chat ignored */ }
  renderAiMessages(); renderWorkspaces(); renderEmptyWorkspace(); saveWorkspaces();
  syncCodeSource();
}
export function openWorkspaceDialog(edit = false) {
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
export function sampleSchema() {
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
export function setSchema(schema, demo = false) {
  state.columnNotesCache = null;
  state.linkMode = false; state.linkSource = null;
  $('selectionModeButton').setAttribute('aria-pressed', 'true');
  state.base = clone(schema); state.schema = clone(schema); state.demo = demo; state.topic = 'all';
  state.operations = []; state.cursor = 0; state.customGroups = null; state.aiLayout = null;
  try {
    const draft = JSON.parse(store.getItem(draftKey()) || '{}');
    if (Array.isArray(draft.operations)) {
      const cursor = Math.max(0, Math.min(draft.operations.length, Number(draft.cursor) || 0));
      replay(state.base, draft.operations.slice(0, cursor));
      state.operations = draft.operations; state.cursor = cursor;
    }
  } catch { showToast('تعذّر تحميل المسودة السابقة'); }
  try {
    const groups = JSON.parse(store.getItem(topicKey()) || 'null');
    if (Array.isArray(groups)) state.customGroups = normalizeTopics(groups, replay(state.base, state.operations.slice(0, state.cursor)).tables.map(table => table.id));
  } catch { /* invalid topic settings */ }
  try {
    const savedLayout = JSON.parse(store.getItem(aiLayoutKey()) || 'null');
    if (savedLayout) state.aiLayout = normalizeAiLayout(savedLayout);
  } catch { /* invalid saved AI layout is ignored */ }
  state.selectedTable = null; state.selectedRelation = null; state.hoveredTable = null;
  $('details').hidden = true;
  const kind = activeWorkspace()?.kind;
  if (kind === 'ideas') {
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
  if (kind === 'ideas') {
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
  offerStaleDraft();
}
// A draft is keyed by the schema fingerprint, so a database change used to hide it silently.
function offerStaleDraft() {
  if (state.operations.length || state.demo || !state.base.fingerprint) return;
  const current = draftKey(), workspaceId = state.workspaceId;
  const stale = store.keys(`${storageKey()}.draft.`).filter(key => key !== current).map(key => {
    try { return { key, ...JSON.parse(store.getItem(key)) }; } catch { return null; }
  }).filter(item => Array.isArray(item?.operations) && item.operations.length);
  if (!stale.length) return;
  const newest = stale.at(-1);
  const { kept, skipped } = recoverOperations(state.base, newest.operations.slice(0, Number.isInteger(newest.cursor) ? newest.cursor : newest.operations.length), applyOperation);
  const message = kept.length
    ? `تغيّرت بنية القاعدة بعد حفظ هذه المسودة. يمكن إعادة تطبيق ${kept.length} تغيير${skipped ? ` وسيُتجاوز ${skipped} لم يعد ينطبق` : ''}.`
    : 'تغيّرت بنية القاعدة ولم يعد أي تغيير من هذه المسودة ينطبق على المخطط الحالي.';
  confirmAction('مسودة من نسخة سابقة للمخطط', `${newest.operations.length} تغييرات محفوظة`, message, () => {
    if (workspaceId !== state.workspaceId) return;
    if (kept.length) { state.operations = kept; state.cursor = kept.length; saveDraft(); refreshDraft(); showToast(`استُعيدت ${kept.length} تغييرات في المسودة`); }
    for (const item of stale) store.removeItem(item.key);
  }, kept.length ? 'استعادة المسودة' : 'تجاهل المسودة', false, kept.length ? 'يمكن إلغاء أي تغيير بعد الاستعادة من مراجعة المسودة.' : 'ستُحذف المسودة القديمة من هذا الجهاز.');
}
export function exportWorkspace() {
  closeWorkspaceMenu();
  const workspace = activeWorkspace();
  const topics = state.groups.slice(1).map(group => ({ id: group.id, label: group.label, color: group.color, ids: [...group.ids], ...(group.reason ? { reason: group.reason } : {}) }));
  const file = buildExport({ name: workspace.name, kind: workspace.kind, schema: clone(state.base), topics, positions: Object.fromEntries(state.positions), operations: state.operations, cursor: state.cursor, columnNotes: readColumnNotesStore() });
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
  link.href = url; link.download = `${slug(workspace.name)}.eratlas.json`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast('صُدّرت المساحة. الملف لا يحتوي كلمات مرور ولا مسارات الكود.');
}
export function importWorkspace() {
  closeWorkspaceMenu();
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      const data = parseExport(await file.text());
      const id = crypto.randomUUID(), prefix = `eratlas.v4.ws.${id}`;
      store.setItem(prefix, JSON.stringify(data.positions));
      if (data.topics.length) store.setItem(`${prefix}.topics`, JSON.stringify(data.topics));
      if (Object.keys(data.columnNotes).length) store.setItem(`${prefix}.columnNotes`, JSON.stringify(data.columnNotes));
      if (data.operations.length) store.setItem(`${prefix}.draft${data.schema.fingerprint ? `.${data.schema.fingerprint}` : ''}`, JSON.stringify({ operations: data.operations, cursor: data.cursor }));
      state.workspaces.push({ id, name: data.name, kind: data.kind, schema: data.schema, topic: 'all', connection: null });
      await activateWorkspace(id);
      showToast(`استُوردت مساحة «${data.name}» (${data.schema.tables.length} جدول)`);
    } catch (error) { showToast(error.message); }
  });
  input.click();
}
export function deleteWorkspace() {
  closeWorkspaceMenu();
  const workspace = activeWorkspace();
  if (state.workspaces.length < 2) { showToast('لا يمكن حذف آخر مساحة عمل. أنشئ مساحة أخرى أولًا.'); return; }
  const prefix = storageKey();
  confirmAction('حذف مساحة العمل؟', workspace.name, 'ستُحذف الخريطة والمواضيع والمسودة ومحادثة AI لهذه المساحة من هذا الجهاز. لا تتغير قاعدة البيانات.', () => {
    for (const key of store.keys(prefix)) if (key === prefix || key.startsWith(`${prefix}.`)) store.removeItem(key);
    state.workspaces = state.workspaces.filter(item => item.id !== workspace.id);
    activateWorkspace(state.workspaces[0].id).then(() => showToast('حُذفت مساحة العمل'));
  }, 'حذف المساحة', true, 'لا يمكن التراجع عن حذف مساحة العمل. صدّرها أولًا إن كنت تريد نسخة.');
}
// Workspaces created by earlier versions had their topics hard-coded in the app;
// copy them into the saved topics once so removing that code loses nothing.
export async function migrateLegacySufra() {
  const key = `eratlas.v4.ws.${LEGACY_SUFRA_ID}.topics`;
  if (!state.workspaces.some(item => item.id === LEGACY_SUFRA_ID) || store.getItem(key)) return;
  try {
    const sample = parseExport(await (await fetch('/samples/sufra-products.eratlas.json')).text());
    store.setItem(key, JSON.stringify(sample.topics));
  } catch { /* topics fall back to automatic grouping */ }
}
export function sameConnection(saved, live) {
  if (!live) return false;
  return saved?.source && live.source ? saved.source === live.source : saved?.database === live.database;
}
export async function submitWorkspace(event) {
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
}
