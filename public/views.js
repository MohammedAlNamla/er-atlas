// The four ways to read the schema (map, tables, topics, focus) and the topic switcher.
import { icon, button as uiButton } from './ui.js';
import { $, state, activeWorkspace, saveWorkspaces, el } from './core.js';
import { closeHeaderMenus, scheduleFitChrome } from './chrome.js';
import { visibleTables, visibleRelations, buildFocusPositions, buildTopicPositions } from './layout.js';
import { renderNodes, fitView, centerTable, selectTable } from './canvas.js';
export function renderTopics() {
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

// One segmented control carries the four ways to read the schema; the row beneath only
// appears when the view has a context of its own (an open topic, a focused table).
function renderViewTabs() {
  for (const button of $('viewTabs').querySelectorAll('.seg')) {
    const active = button.dataset.view === state.viewMode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
  document.querySelector('.chrome').dataset.view = state.viewMode;
}
function renderTopicOverview(overlay) {
  const heading = el('div', 'view-overlay-heading');
  heading.append(el('h2', '', 'مواضيع قاعدة البيانات'),
    el('p', '', 'اختر موضوعًا لعرض جداوله وعلاقاته بوضوح.'));
  const grid = el('div', 'topic-overview-grid');
  for (const group of state.groups.filter(item => item.id !== 'all' && item.ids.size)) {
    const members = state.schema.tables.filter(table => group.ids.has(table.id));
    const relationships = state.schema.relations.filter(relation => group.ids.has(relation.source) && group.ids.has(relation.target)).length;
    const button = el('button', 'topic-overview-card'); button.type = 'button';
    button.style.setProperty('--topic-color', group.color);
    const top = el('span', 'topic-overview-top');
    top.append(icon('table'), el('span', 'topic-overview-count', String(members.length)));
    const names = el('span', 'topic-overview-tables'); names.dir = 'ltr';
    for (const table of members.slice(0, 5)) names.append(el('span', 'topic-overview-table', table.name));
    if (members.length > 5) names.append(el('span', 'topic-overview-table more', `+${members.length - 5}`));
    button.append(top, el('strong', '', group.label), names,
      el('span', 'topic-overview-meta', `${relationships} علاقة داخلية`));
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
  heading.append(el('h2', '', 'اختر جدولًا'), el('p', '', 'اعرض الجدول وأعمدته وعلاقاته المباشرة.'));
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
export function renderView() {
  renderViewTabs();
  const catalog = state.viewMode === 'tables' && state.schema.tables.length > 0;
  const topicOverview = state.viewMode === 'topics' && state.topic === 'all' && state.schema.tables.length > 0;
  const focusPicker = state.viewMode === 'focus' && !state.focusTable && state.schema.tables.length > 0;
  const overlay = $('viewOverlay'); overlay.replaceChildren();
  overlay.hidden = !catalog && !topicOverview && !focusPicker;
  $('map').classList.toggle('show-view-overlay', !overlay.hidden);
  if (topicOverview) renderTopicOverview(overlay);
  if (focusPicker) renderFocusPicker(overlay);
  if (catalog) renderTableCatalog(overlay);
  document.querySelector('.topic-switcher').hidden = state.viewMode !== 'topics' || topicOverview;
  $('backTopicsButton').hidden = state.viewMode !== 'topics' || topicOverview;
  $('chooseFocusButton').hidden = state.viewMode !== 'focus' || focusPicker;
  $('topicManageButton').hidden = false;
  $('arrangeButton').hidden = !overlay.hidden;
  $('aiArrangeButton').disabled = !visibleTables().length;
  $('arrangeWithAiButton').disabled = !visibleTables().length;
  updateViewCounts(); scheduleFitChrome();
}
function renderTableCatalog(overlay) {
  const heading = el('div', 'catalog-heading');
  const copy = el('div'); copy.append(el('h2', '', 'الجداول'), el('p', '', 'اختر جدولًا لعرض أعمدته وعلاقاته على الخريطة.'));
  const tools = el('div', 'catalog-tools');
  const search = el('input', 'catalog-search'); search.type = 'search'; search.placeholder = 'ابحث باسم جدول أو عمود…'; search.setAttribute('aria-label', 'البحث في قائمة الجداول');
  const sort = el('select', 'catalog-sort'); sort.setAttribute('aria-label', 'ترتيب الجداول');
  for (const [value, label] of [['name', 'الاسم'], ['relations', 'الأكثر ارتباطًا'], ['columns', 'الأكثر أعمدة']]) { const option = el('option', '', label); option.value = value; sort.append(option); }
  tools.append(search, sort); heading.append(copy, tools);
  const total = el('p', 'catalog-total'); total.setAttribute('role', 'status');
  const list = el('div', 'table-catalog');
  const empty = el('p', 'catalog-empty', 'لا يوجد جدول مطابق. جرّب اسمًا آخر.'); empty.hidden = true;
  const info = new Map(state.schema.tables.map(table => [table.id, {
    relations: state.schema.relations.filter(relation => relation.source === table.id || relation.target === table.id).length,
    topics: state.groups.filter(group => group.id !== 'all' && group.ids.has(table.id)),
    haystack: `${table.schema}.${table.name} ${table.columns.map(column => column.name).join(' ')}`.toLowerCase()
  }]));
  const makeRow = table => {
    const row = uiButton('', () => { setViewMode('map'); selectTable(table.id); centerTable(table.id); }, 'catalog-row');
    const name = el('span', 'catalog-name'); const label = el('strong', '', table.name); label.dir = 'ltr'; name.append(icon('table'), label);
    const { relations, topics } = info.get(table.id);
    const chips = el('span', 'catalog-topics');
    if (!topics.length) chips.append(el('span', 'catalog-topic none', table.schema));
    for (const group of topics.slice(0, 2)) { const chip = el('span', 'catalog-topic', group.label); chip.style.setProperty('--topic-color', group.color); chips.append(chip); }
    if (topics.length > 2) chips.append(el('span', 'catalog-topic none', `+${topics.length - 2}`));
    chips.title = topics.map(group => group.label).join('، ');
    row.append(name, el('span', 'catalog-count', `${table.columns.length} أعمدة`), el('span', 'catalog-count', `${relations} علاقات`), chips, icon('chevron'));
    return row;
  };
  const paint = () => {
    const term = search.value.trim().toLowerCase();
    const by = { name: (a, b) => a.name.localeCompare(b.name), relations: (a, b) => info.get(b.id).relations - info.get(a.id).relations || a.name.localeCompare(b.name),
      columns: (a, b) => b.columns.length - a.columns.length || a.name.localeCompare(b.name) }[sort.value];
    const items = state.schema.tables.filter(table => info.get(table.id).haystack.includes(term)).sort(by);
    list.replaceChildren(...items.map(makeRow));
    empty.hidden = items.length > 0;
    total.textContent = term ? `${items.length} من ${state.schema.tables.length} جدول` : `${state.schema.tables.length} جدول`;
  };
  search.addEventListener('input', paint); sort.addEventListener('change', paint); paint();
  overlay.append(heading, total, list, empty);
}
export function updateViewCounts() {
  const overview = state.viewMode === 'topics' && state.topic === 'all';
  const tables = overview ? state.schema.tables : visibleTables();
  const ids = new Set(tables.map(table => table.id));
  const relations = overview ? state.schema.relations : visibleRelations().filter(relation => ids.has(relation.source) && ids.has(relation.target));
  $('tableCount').textContent = `${tables.length} جدول`;
  $('relationCount').textContent = `${relations.length} علاقة`;
}
export function setViewMode(mode) {
  if (state.viewMode === mode) return;
  const selected = state.selectedTable;
  state.viewMode = mode; state.topic = 'all'; state.selectedTable = null; state.selectedRelation = null;
  state.hoveredTable = null; $('details').hidden = true;
  if (mode === 'focus') state.focusTable = selected || state.focusTable || activeWorkspace().focusTable || null;
  buildFocusPositions(); buildTopicPositions();
  activeWorkspace().viewMode = mode; activeWorkspace().topic = 'all'; saveWorkspaces();
  renderTopics(); renderView(); renderNodes(); fitView(false);
}
export function chooseFocusTable(id) {
  if (!state.schema.tables.some(table => table.id === id)) return;
  state.focusTable = id; activeWorkspace().focusTable = id; state.selectedTable = null;
  state.selectedRelation = null; state.hoveredTable = null;
  buildFocusPositions(); saveWorkspaces();
  renderView(); renderNodes(); fitView(false);
}
// Bring a table into view from anywhere: leave full-page views, select it and center it.
export function locateTable(id) {
  if (!state.schema.tables.some(table => table.id === id)) return;
  if (state.viewMode === 'tables' || (state.viewMode === 'topics' && !visibleTables().some(table => table.id === id))) setViewMode('map');
  if (state.viewMode === 'focus') chooseFocusTable(id);
  selectTable(id); centerTable(id);
}
