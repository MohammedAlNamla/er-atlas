import { applyOperation, replay, describeOperation, clone } from './model.js';
import { routeConnections } from './router.js';
import { store, initStore } from './storage.js';
import { buildExport, parseExport, recoverOperations } from './workspace-io.js';
import { lintSchema } from './lint.js';
import { EXPORT_FORMATS, exportSchema, toLaravelMigration } from './exporters.js';
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
  workspaces: [], workspaceId: null, connectionLive: false, aiMessages: [], columnBusy: null, columnError: '', columnController: null, editingWorkspace: false,
  edgeRoutes: null, edgeFrame: null, viewFrame: null, routeGeneration: 0, routeWorker: null,
  viewMode: 'map', focusTable: null, focusPositions: null, topicPositions: null,
  inspectorTab: 'columns', topicEditorId: null, arrangement: null, arrangementMode: 'relations', aiController: null, layoutController: null
};
const WORKSPACES_KEY = 'eratlas.workspaces.v1';
const THEME_KEY = 'eratlas.theme';
const THEME_LABELS = { auto: 'تلقائي', light: 'فاتح', dark: 'ليلي' };
// Canvas edges are painted in JS, so they read the same CSS tokens as the DOM does.
let themeColors = null;
function readThemeColors() {
  const fallback = { wire: '#9288af', focus: '#6d58c6', trace: '#5d45c3', selected: '#6551c7', proposed: '#8164d2', label: '#5f5674', halo: '#fcfbfd' };
  if (typeof getComputedStyle !== 'function' || typeof document.documentElement?.nodeType !== 'number') return fallback;
  const style = getComputedStyle(document.documentElement), read = (name, value) => style.getPropertyValue(name).trim() || value;
  return { wire: read('--wire', fallback.wire), focus: read('--wire-focus', fallback.focus), trace: read('--wire-trace', fallback.trace),
    selected: read('--wire-selected', fallback.selected), proposed: read('--wire-proposed', fallback.proposed), label: read('--wire-label', fallback.label), halo: read('--paper', fallback.halo) };
}
const edgeColors = () => themeColors ||= readThemeColors();
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else root.removeAttribute('data-theme');
  const label = $('themeLabel'); if (label) label.textContent = THEME_LABELS[mode] || THEME_LABELS.auto;
  themeColors = null;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--paper').trim() || '#fcfbfd');
  if (state.schema) updateEdgeEmphasis();
}
function currentTheme() { const saved = store.getItem(THEME_KEY); return saved === 'light' || saved === 'dark' ? saved : 'auto'; }
function cycleTheme() {
  const order = ['auto', 'light', 'dark'], next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  store.setItem(THEME_KEY, next); applyTheme(next);
  showToast(`المظهر: ${THEME_LABELS[next]}`);
}
const LEGACY_SUFRA_ID = 'sufra-products-2026-09-27';
const activeWorkspace = () => state.workspaces.find(item => item.id === state.workspaceId);
const blankSchema = name => ({ database: name, tables: [], relations: [], readOnly: true });
function saveWorkspaces() {
  store.setItem(WORKSPACES_KEY, JSON.stringify({ activeId: state.workspaceId, items: state.workspaces }));
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
    const button = el('button', `workspace-option${workspace.id === state.workspaceId ? ' active' : ''}`);
    button.type = 'button';
    button.title = workspace.kind === 'ideas' ? 'مساحة أفكار' : 'خريطة قاعدة بيانات';
    if (workspace.id === state.workspaceId) button.setAttribute('aria-current', 'page');
    const mark = icon(workspace.kind === 'ideas' ? 'ai' : 'table'); mark.classList.add('workspace-option-icon');
    const copy = el('span', 'workspace-option-copy');
    const tableTotal = workspace.schema?.tables?.length || 0;
    const description = workspace.kind === 'ideas'
      ? (tableTotal ? `${tableTotal} جدول · أفكار ومخطط حر` : 'أفكار ومخطط حر')
      : workspace.kind === 'demo'
        ? 'الخريطة النموذجية'
        : `${tableTotal} جدول · PostgreSQL`;
    copy.append(el('strong', '', workspace.name), el('small', '', description));
    button.append(mark, copy);
    if (workspace.id === state.workspaceId) button.append(icon('check'));
    button.addEventListener('click', async () => { closeWorkspaceMenu({ focus: true }); await activateWorkspace(workspace.id); });
    tabs.append(button);
  }
  scheduleFitChrome();
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
// What a question will actually send: the selection wins, then the open topic or focus, then everything.
function aiScope(wide = state.aiWide) {
  if (!state.schema?.tables) return { kind: 'all', label: 'المخطط', schema: { tables: [], relations: [] }, focus: {} };
  if (wide) return { kind: 'all', label: `كل المخطط · ${state.schema.tables.length} جدول`, schema: state.schema, focus: {}, wide: true };
  const table = state.schema.tables.find(item => item.id === state.selectedTable);
  if (table) return { kind: 'table', table, label: `جدول ${table.name} وجيرانه`, schema: state.schema, focus: { tableId: table.id } };
  const relation = state.schema.relations.find(item => item.id === state.selectedRelation);
  if (relation) return { kind: 'relation', relation, label: `علاقة ${relation.name}`, schema: state.schema, focus: { relationId: relation.id } };
  if (state.viewMode === 'focus' || (state.viewMode === 'topics' && state.topic !== 'all')) {
    const tables = visibleTables();
    const name = state.viewMode === 'focus' ? `جدول ${state.schema.tables.find(item => item.id === state.focusTable)?.name || ''} وجيرانه` : `موضوع ${state.groups.find(group => group.id === state.topic)?.label || ''}`;
    return { kind: 'topic', label: `${name} · ${tables.length} جدول`, schema: { ...state.schema, tables, relations: visibleRelations() }, focus: {} };
  }
  return { kind: 'all', label: `كل المخطط · ${state.schema.tables.length} جدول`, schema: state.schema, focus: {} };
}
function aiSuggestions(scope) {
  if (activeWorkspace()?.kind === 'ideas') return ['ما الجداول التي تحتاجها هذه الفكرة؟', 'ما العلاقات الناقصة في مسودتي؟', 'اقترح أعمدة الجدول الأساسي'];
  if (scope.kind === 'table') return [`اشرح دور ${scope.table.name} وأهم أعمدته`, 'ماذا يحدث للجداول المرتبطة عند حذف صف منه؟', 'هل تصميم مفاتيحه وعلاقاته سليم؟'];
  if (scope.kind === 'relation') return ['اشرح هذه العلاقة بجملة بسيطة', 'ما أثر الحذف والتعديل عبرها؟', 'هل هي واحد-إلى-كثير أم اختيارية؟'];
  if (scope.kind === 'topic') return ['ما وظيفة هذه المجموعة من الجداول؟', 'ما الجدول المحوري هنا ولماذا؟', 'كيف تتدفق البيانات بين هذه الجداول؟'];
  return ['ما الجداول المحورية في هذا المخطط؟', 'اشرح العلاقات الرئيسية بين الجداول', 'راجع تصميم المفاتيح الأجنبية وأثر الحذف'];
}
// Small, safe markdown: headings, bullets, **bold** and `code`. Everything is built with textContent.
function richText(source) {
  const root = el('div', 'rich');
  const inline = (parent, text) => {
    for (const part of text.split(/(\`[^\`]+\`|\*\*[^*]+\*\*)/g)) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(el('code', '', part.slice(1, -1)));
      else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        const inner = part.slice(2, -2);
        parent.append(el('strong', inner === '[مثبت]' ? 'tag-fact' : inner === '[استنتاج]' ? 'tag-guess' : '', inner));
      } else parent.append(document.createTextNode(part));
    }
  };
  let list = null;
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const heading = /^#{1,4}\s+(.*)$/.exec(line), bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { if (!list) { list = el('ul'); root.append(list); } const item = el('li'); inline(item, bullet[1]); list.append(item); continue; }
    list = null;
    const block = el(heading ? 'h4' : 'p'); inline(block, heading ? heading[1] : line); root.append(block);
  }
  return root;
}
function answerNodes(text) {
  return String(text).split(/```(?:[^\n]*)\n?([\s\S]*?)```/g).flatMap((part, index) => !part.trim() ? []
    : [index % 2 ? codeBlock(part.trim(), /\b(?:CREATE|ALTER|SELECT|INSERT|UPDATE|DELETE|BEGIN|DROP|COMMENT)\b/i.test(part) ? 'SQL' : 'AI') : richText(part.trim())]);
}
// ---- Chat: a dialogue, not a report. The thread keeps turns; the composer stays pinned.
const SVG_NS = 'http://www.w3.org/2000/svg';
function sprite(name, className = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg'), use = document.createElementNS(SVG_NS, 'use');
  svg.setAttribute('class', className); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', `#i-${name}`);
  svg.append(use); return svg;
}
function chatButton(label, handler, className = '', iconName = '') {
  const node = uiButton('', handler, className);
  if (iconName) node.append(sprite(iconName, 'i i-small'));
  node.append(el('span', '', label));
  return node;
}
const AI_STAGES = ['أقرأ بنية الجداول…', 'أحلل العلاقات والمفاتيح…', 'أصيغ الإجابة…'];
function aiGenericFollowups() { return ['اشرح أكثر', 'أعطني مثالًا', 'لخّص ذلك في ثلاث نقاط']; }
function chatWho(label = 'المساعد', scope = '') {
  const who = el('div', 'turn-who'); who.append(sprite('sparkle', 'i i-small'), el('strong', '', label));
  if (scope) who.append(el('span', 'turn-scope', scope));
  return who;
}
function chatWelcome(scope) {
  const root = el('div', 'chat-welcome'), mark = el('div', 'welcome-mark');
  const logo = document.createElementNS(SVG_NS, 'svg'), use = document.createElementNS(SVG_NS, 'use');
  logo.setAttribute('class', 'welcome-logo'); logo.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#logo-mark'); logo.append(use); mark.append(logo);
  root.append(mark, el('h3', '', 'اسأل عن مخططك'), el('p', '', activeWorkspace()?.kind === 'ideas' ? 'ناقش فكرتك، وسأقترح جداولها وعلاقاتها خطوة بخطوة.' : 'أشرح لك الجداول والعلاقات، وأراجع التصميم، وأناقشك فيما يخطر لك.'));
  const connection = providerState();
  if (connection.tone === 'warn' || connection.tone === 'bad') {
    const card = el('div', 'connect-card');
    card.append(el('strong', '', 'اربط مساعدًا لتبدأ'), el('p', '', `${providerShort()}: ${connection.text}.`), chatButton('ربط المساعد', () => openDialog($('aiSettingsDialog')), 'primary-button'));
    root.append(card);
  }
  const replies = el('div', 'quick-replies');
  for (const question of aiSuggestions(scope)) replies.append(uiButton(question, () => sendAiQuestion(question), 'quick-reply'));
  root.append(replies);
  return root;
}
function chatTurn(message, { last = false, fresh = false } = {}) {
  const turn = el('div', `turn ${message.role}`);
  if (message.at) turn.title = new Date(message.at).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  if (message.role === 'user') { turn.append(el('div', 'bubble', message.content)); return turn; }
  turn.append(chatWho('المساعد', message.scope || ''));
  const body = el('div', `turn-body${fresh ? ' fresh' : ''}`);
  answerNodes(message.content).forEach((node, index) => { node.style.setProperty('--i', String(Math.min(index, 8))); body.append(node); });
  const actions = el('div', 'turn-actions');
  actions.append(chatButton('نسخ', () => copyText(message.content), 'turn-action', 'copy'));
  if (last) actions.append(chatButton('أعد الإجابة', regenerateAiAnswer, 'turn-action', 'refresh'));
  turn.append(body, actions);
  if (last) {
    const replies = el('div', 'quick-replies inline');
    for (const question of (message.followups?.length ? message.followups : aiGenericFollowups())) replies.append(uiButton(question, () => sendAiQuestion(question), 'quick-reply'));
    turn.append(replies);
  }
  return turn;
}
function renderAiMessages() {
  const box = $('aiResponse'), scope = aiScope(), pending = state.aiPending, failed = state.aiFailed;
  box.replaceChildren();
  $('clearAiButton').hidden = !state.aiMessages.length || Boolean(pending);
  if (!state.aiMessages.length && !pending && !failed) box.append(chatWelcome(scope));
  const lastIndex = state.aiMessages.length - 1;
  state.aiMessages.forEach((message, index) => box.append(chatTurn(message, { last: index === lastIndex && !pending && !failed, fresh: message.at && message.at === state.aiFreshAt })));
  state.aiFreshAt = null;
  if (pending || failed) box.append(chatTurn({ role: 'user', content: (pending || failed).question }));
  state.aiStageEl = null;
  if (pending) {
    const turn = el('div', 'turn assistant pending'), typing = el('div', 'typing');
    typing.append(el('i'), el('i'), el('i')); state.aiStageEl = el('span', 'typing-text');
    const line = el('div', 'typing-line'); line.append(typing, state.aiStageEl);
    turn.append(chatWho(), line); box.append(turn); updateAiStage();
  } else if (failed) {
    const turn = el('div', 'turn assistant failed'), actions = el('div', 'turn-actions');
    actions.append(chatButton('أعد المحاولة', () => sendAiQuestion(failed.question), 'turn-action strong', 'refresh'), chatButton('ربط المساعد', () => openDialog($('aiSettingsDialog')), 'turn-action', 'key'));
    turn.append(chatWho(), el('div', 'turn-error', failed.message), actions); box.append(turn);
  }
  // A new answer is read from its question; a pending or failed turn stays at the end.
  const users = box.querySelectorAll('.turn.user'), lastUser = users[users.length - 1];
  const target = !pending && !failed && state.aiJustAnswered && lastUser ? Math.max(0, lastUser.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12) : box.scrollHeight;
  state.aiJustAnswered = false;
  box.scrollTop = target;
}
function updateAiStage() {
  const target = state.aiStageEl; if (!target?.isConnected || !state.aiPending) return;
  const seconds = Math.floor((Date.now() - state.aiPending.at) / 1000);
  target.textContent = `${AI_STAGES[Math.min(AI_STAGES.length - 1, Math.floor(seconds / 4))]}${seconds >= 6 ? ` · ${seconds} ث` : ''}`;
}
function autosizeComposer() {
  const input = $('aiQuestion'); input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
  $('askAiButton').disabled = !input.value.trim();
}
function setComposerBusy(busy) { $('askAiButton').hidden = busy; $('stopAiButton').hidden = !busy; }
async function sendAiQuestion(raw) {
  if (state.aiController) return;
  const question = String(raw ?? $('aiQuestion').value).trim(); if (!question) return;
  const workspaceId = state.workspaceId, controller = new AbortController(), scope = aiScope();
  state.aiController = controller; state.aiFailed = null; state.aiPending = { question, at: Date.now() };
  $('aiQuestion').value = ''; autosizeComposer(); setComposerBusy(true); renderAiMessages();
  const timer = setInterval(updateAiStage, 1000);
  try {
    const data = await askAi(activeWorkspace()?.kind === 'ideas' ? 'ideas' : 'explain', question, scope.schema, controller.signal, { focus: scope.focus });
    if (workspaceId !== state.workspaceId) return;
    const at = Date.now();
    state.aiMessages.push({ role: 'user', content: question, at: state.aiPending?.at || at }, { role: 'assistant', content: data.answer, at, scope: scope.label, followups: data.followups || [] });
    state.aiMessages = state.aiMessages.slice(-30); saveAiMessages(); state.aiFreshAt = at; state.aiJustAnswered = true;
    if (!$('aiDialog').open) showToast('وصلت إجابة المساعد');
  } catch (error) {
    if (workspaceId !== state.workspaceId) return;
    if (error.name === 'AbortError') $('aiQuestion').value = question;
    else state.aiFailed = { question, message: error.message };
  } finally {
    clearInterval(timer);
    if (state.aiController === controller) { state.aiController = null; state.aiPending = null; }
    if (workspaceId === state.workspaceId) { setComposerBusy(false); autosizeComposer(); renderAiMessages(); if ($('aiDialog').open) $('aiQuestion').focus(); }
  }
}
function regenerateAiAnswer() {
  if (state.aiController) return;
  const index = state.aiMessages.length - 1;
  if (index < 1 || state.aiMessages[index].role !== 'assistant') return;
  const question = state.aiMessages[index - 1].content;
  state.aiMessages = state.aiMessages.slice(0, index - 1); saveAiMessages(); sendAiQuestion(question);
}
function saveAiMessages() { store.setItem(`${storageKey()}.conversation`, JSON.stringify(state.aiMessages)); }
async function activateWorkspace(id, { initial = false, live = false } = {}) {
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
  const height = tables => tables.reduce((total, table) => total + nodeHeight(table) + 80, 0);
  const totalHeight = Math.max(nodeHeight(center) + 200, height(sides[0]), height(sides[1]));
  const positions = new Map([[center.id, { x: 520, y: Math.round((totalHeight - nodeHeight(center)) / 2) }]]);
  sides.forEach((tables, side) => {
    let y = Math.round((totalHeight - height(tables)) / 2) + 44;
    for (const table of tables) { positions.set(table.id, { x: side === 0 ? 60 : 980, y }); y += nodeHeight(table) + 80; }
  });
  state.focusPositions = positions;
  try {
    const saved = JSON.parse(store.getItem(`${storageKey()}.focusLayout.${state.focusTable}`) || '{}');
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
  const rowTops = []; let y = 72;
  for (const height of rowHeights) { rowTops.push(y); y += height + 120; }
  state.topicPositions = new Map(assignments.map(item => [item.table.id,
    { x: 80 + item.col * 440, y: rowTops[item.row] + Math.round((rowHeights[item.row] - nodeHeight(item.table)) / 2) }]));
  try {
    const saved = JSON.parse(store.getItem(`${storageKey()}.topicLayout.${state.topic}`) || '{}');
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
const snap4 = value => Math.round(value / 4) * 4;
function layoutTables(schema = state.schema, aiLayout = state.aiLayout) {
  const tables = [...schema.tables];
  if (!tables.length) return new Map();
  const byId = new Map(tables.map(table => [table.id, table]));
  // Heights are fixed for a given render; computing them per pair made large graphs freeze.
  const heights = new Map(tables.map(table => [table.id, nodeHeight(table)]));
  const h = table => heights.get(table.id);
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
        if (Math.abs(dx) > 1500 || Math.abs(dy) > 1500) continue;
        const distance2 = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distance2);
        const force = Math.min(54, 185000 / distance2);
        const fx = dx / distance * force, fy = dy / distance * force;
        ap.vx -= fx; ap.vy -= fy; bp.vx += fx; bp.vy += fy;

        const overlapX = (NODE_WIDTH + 96) - Math.abs(dx);
        const overlapY = ((h(a) + h(b)) / 2 + 72) - Math.abs(dy);
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
        const overlapX = NODE_WIDTH + 88 - Math.abs(dx);
        const overlapY = (h(a) + h(b)) / 2 + 64 - Math.abs(dy);
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
  const minY = Math.min(...ordered.map(table => points.get(table.id).y - h(table) / 2));
  const result = new Map(ordered.map(table => [table.id, {
    x: Math.round(points.get(table.id).x - NODE_WIDTH / 2 - minX + 110),
    y: Math.round(points.get(table.id).y - h(table) / 2 - minY + 110)
  }]));

  // Match the graph footprint to the actual canvas. Large schemas previously
  // filled the height while wasting most of a wide monitor's horizontal space.
  if (count >= 18) {
    const viewport = $('viewport');
    const viewAspect = viewport?.clientWidth && viewport?.clientHeight ? viewport.clientWidth / viewport.clientHeight : 1.8;
    const left = Math.min(...ordered.map(table => result.get(table.id).x));
    const right = Math.max(...ordered.map(table => result.get(table.id).x + NODE_WIDTH));
    const top = Math.min(...ordered.map(table => result.get(table.id).y));
    const bottom = Math.max(...ordered.map(table => result.get(table.id).y + h(table)));
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
  for (const point of result.values()) { point.x = snap4(point.x); point.y = snap4(point.y); }
  return result;
}

function storageKey() {
  if (state.workspaceId && state.workspaceId !== 'legacy') return `eratlas.v4.ws.${state.workspaceId}`;
  const signature = state.base.tables.map(t => `${t.schema}.${t.name}`).sort().join('|');
  return `eratlas.v4.${state.demo ? 'demo' : 'db'}.${state.base.database}.${signature}`;
}
function aiLayoutKey() { return `${storageKey()}.ai-layout`; }
function saveAiLayout() { store.setItem(aiLayoutKey(), JSON.stringify(state.aiLayout)); }

function loadPositions() {
  state.positions = layoutTables();
  let saved = {};
  try {
    saved = JSON.parse(store.getItem(storageKey()) || '{}') || {};
    for (const table of state.schema.tables) {
      const point = saved[table.id];
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) state.positions.set(table.id, point);
    }
  } catch { /* invalid old layout is ignored */ }

}

function savePositions() {
  store.setItem(storageKey(), JSON.stringify(Object.fromEntries(state.positions)));
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
function renderView() {
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

let involvedColumns = new Map();
function indexInvolvedColumns() {
  const index = new Map();
  const add = (tableId, column) => { if (!index.has(tableId)) index.set(tableId, new Set()); index.get(tableId).add(column); };
  for (const relation of state.schema.relations) for (const pair of relation.pairs) { add(relation.source, pair.source); add(relation.target, pair.target); }
  return index;
}
// Largest title that fits the zoomed-out tile: words wrap only after underscores, so the
// longest word decides the width and the line count decides the height.
function columnsLabel(count) {
  return count === 0 ? 'بلا أعمدة' : count === 1 ? 'عمود واحد' : count === 2 ? 'عمودان' : count <= 10 ? `${count} أعمدة` : `${count} عمودًا`;
}
function overviewNameSize(table) {
  const words = table.name.split(/(?<=_)/), height = measureNode(table);
  for (let size = 44; size > 22; size -= 2) {
    const perLine = Math.floor(256 / (size * .6));
    if (words.some(word => word.length > perLine)) continue;
    let lines = 1, used = 0;
    for (const word of words) { if (used && used + word.length > perLine) { lines++; used = 0; } used += word.length; }
    if (lines <= 3 && lines * size * 1.2 + 58 + 28 <= height) return size;
  }
  return 22;
}
function makeNode(table) {
  const card = el('article', `table-node${isDraftTable(table) ? ' proposed' : ''}`);
  card.dataset.table = table.id;
  const pos = graphPosition(table.id);
  card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`;
  card.style.setProperty('--node-color', groupForTable(table).color);
  card.style.setProperty('--name-size', `${overviewNameSize(table)}px`);
  const head = el('div', 'node-head');
  const title = el('div', 'node-title'), name = el('div', 'node-name'); name.title = table.name;
  for (const part of table.name.split(/(?<=_)/)) name.append(document.createTextNode(part), document.createElement('wbr'));
  const meta = el('div', 'node-meta'); meta.append(el('span', 'node-schema', `${table.schema} · `), el('span', 'node-meta-count', columnsLabel(table.columns.length)));
  title.append(name, meta);
  const more = uiButton('', event => { event.stopPropagation(); showContextMenu(event); }, 'node-more');
  more.append(icon('more')); more.setAttribute('aria-label', `إجراءات جدول ${table.name}`);
  more.addEventListener('pointerdown', event => event.stopPropagation());
  head.append(title, ...(isDraftTable(table) ? [el('span', 'node-draft', 'مسودة')] : []), more);
  head.addEventListener('pointerdown', event => startDrag(event, table.id, card));
  const columns = el('div', 'node-columns');
  const involved = involvedColumns.get(table.id) || new Set();
  for (const column of previewColumns(table, nodeExpanded(table))) {
    const row = el('div', `column${involved.has(column.name) ? ' has-line' : ''}${column.primary ? ' pk' : ''}${isDraftColumn(table, column) ? ' proposed' : ''}`);
    row.dataset.column = column.name;
    row.title = columnTitle(table, column);
    const badge = el('span', `col-key ${column.primary ? 'pk' : column.foreign ? 'fk' : 'none'}`, column.primary ? 'PK' : column.foreign ? 'FK' : '');
    const nullable = el('span', 'col-null', column.nullable ? '?' : ''); if (column.nullable) nullable.title = 'nullable';
    row.append(badge, el('span', 'col-name', column.name), el('span', 'col-type', column.type), nullable);
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
  // Say what the footer adds: the hidden columns, or the full view when every column already shows.
  const hidden = table.columns.length - previewColumns(table, nodeExpanded(table)).length;
  footer.append(icon('chevron'), el('span', '', hidden ? `عرض كل الأعمدة (+${hidden})` : 'عرض الجدول'));
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
  involvedColumns = indexInvolvedColumns();
  $('viewport').classList.toggle('canvas-edges', tables.length > 35);
  container.replaceChildren(...tables.map(makeNode));
  state.edgeRoutes = null;
  renderEdges();
  updateEmphasis();
  scheduleView();
}

function anchor(table, columnName, side, end) {
  const pos = graphPosition(table.id), slot = end ? state.overviewSlots?.get(end) : undefined;
  return {
    x: pos.x + (side === 'right' ? NODE_WIDTH : 0),
    y: pos.y + (slot !== undefined ? slot : columnOffset(table, columnName, nodeExpanded(table)))
  };
}

// Overview scale hides the rows, so a wire anchored to its column would end at a random
// height. Instead each tile's wires share its middle band, ordered by where the other
// table sits so they leave without crossing each other.
function overviewSlots(relations, byId) {
  const center = table => graphPosition(table.id).y + nodeHeight(table) / 2;
  const ends = new Map();
  const add = (id, end, other) => { if (!ends.has(id)) ends.set(id, []); ends.get(id).push({ end, other }); };
  for (const relation of relations) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    add(source.id, `${relation.id}:0:s`, center(target));
    add(target.id, `${relation.id}:0:t`, center(source));
  }
  const slots = new Map();
  for (const [id, list] of ends) {
    const height = nodeHeight(byId.get(id));
    list.sort((a, b) => a.other - b.other);
    const step = list.length > 1 ? Math.min(26, (height - 48) / (list.length - 1)) : 0;
    list.forEach((item, index) => slots.set(item.end, height / 2 + (index - (list.length - 1) / 2) * step));
  }
  return slots;
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
    source: { left: anchor(source, pair.source, 'left', `${key}:s`), right: anchor(source, pair.source, 'right', `${key}:s`) },
    target: { left: anchor(target, pair.target, 'left', `${key}:t`), right: anchor(target, pair.target, 'right', `${key}:t`) } };
}

function edgePath(sourceTable, targetTable, pair, lane = 0, key = '') {
  const s = key && `${key}:s`, t = key && `${key}:t`;
  const sourcePos = graphPosition(sourceTable.id);
  const targetPos = graphPosition(targetTable.id);
  if (sourceTable.id === targetTable.id) {
    const a = anchor(sourceTable, pair.source, 'right', s);
    const b = anchor(targetTable, pair.target, 'right', t);
    const loop = 80 + Math.abs(a.y - b.y) * .25 + Math.abs(lane);
    return { d: `M ${a.x} ${a.y} C ${a.x + loop} ${a.y - 25}, ${b.x + loop} ${b.y + 25}, ${b.x} ${b.y}`, a, b };
  }
  if (Math.abs(sourcePos.x - targetPos.x) < NODE_WIDTH * .6) {
    const useRight = sourcePos.x > 180 && lane > 0;
    const side = useRight ? 'right' : 'left';
    const a = anchor(sourceTable, pair.source, side, s);
    const b = anchor(targetTable, pair.target, side, t);
    const outerX = side === 'left' ? Math.min(a.x, b.x) - 92 - Math.abs(lane) : Math.max(a.x, b.x) + 92 + Math.abs(lane);
    return { d: `M ${a.x} ${a.y} L ${outerX} ${a.y} C ${outerX + lane * .15} ${a.y}, ${outerX + lane * .15} ${b.y}, ${outerX} ${b.y} L ${b.x} ${b.y}`, a, b };
  }
  const sourceSide = sourcePos.x + NODE_WIDTH / 2 < targetPos.x + NODE_WIDTH / 2 ? 'right' : 'left';
  const targetSide = sourceSide === 'right' ? 'left' : 'right';
  const a = anchor(sourceTable, pair.source, sourceSide, s);
  const b = anchor(targetTable, pair.target, targetSide, t);
  const direction = sourceSide === 'right' ? 1 : -1;
  const sourceStub = a.x + 32 * direction, targetStub = b.x - 32 * direction;
  const center = (sourceStub + targetStub) / 2 + lane;
  return { d: `M ${a.x} ${a.y} L ${sourceStub} ${a.y} C ${center} ${a.y}, ${center} ${b.y}, ${targetStub} ${b.y} L ${b.x} ${b.y}`, a, b };
}

function syncEdgeAnnotations(ref, path) {
  const a = path.points?.[0] || path.a, b = path.points?.at(-1) || path.b;
  if (!a || !b) return;
  const sourceSide = Math.abs(a.x - graphPosition(ref.source.id).x) < 1 ? -1 : 1;
  const targetSide = Math.abs(b.x - graphPosition(ref.target.id).x) < 1 ? -1 : 1;
  ref.arrow = { x: b.x, y: b.y, direction: -targetSide };
  ref.ends = { start: { x: a.x, y: a.y, dir: sourceSide }, end: { x: b.x, y: b.y, dir: targetSide } };
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

const ER_MARKERS = {
  many: [['path', { d: 'M 6 10 L 20 3 M 6 10 L 20 10 M 6 10 L 20 17' }]],
  one: [['path', { d: 'M 13 3 L 13 17' }]],
  'one-only': [['path', { d: 'M 9 3 L 9 17 M 14 3 L 14 17' }]],
  'zero-one': [['circle', { cx: 6, cy: 10, r: 3.5, class: 'er-hole' }], ['path', { d: 'M 14 3 L 14 17' }]]
};
// Ends follow schema evidence only: many/one at the FK side when uniqueness is known,
// exactly-one or zero-or-one at the referenced key depending on FK nullability.
function relationEnds(relation, source, target) {
  // Schema-sourced and imported relations carry real uniqueness; only draft additions stay cautious.
  const cardinality = relationCardinality(isDraftRelation(relation) ? relation : { ...relation, kind: 'actual' }, source, target);
  const optional = relation.pairs.some(pair => source.columns.find(column => column.name === pair.source)?.nullable);
  return { start: cardinality.source === '1' ? 'one' : cardinality.source === '*' ? 'many' : '', end: cardinality.target === '1' ? (optional ? 'zero-one' : 'one-only') : '' };
}
function drawErEnd(context, point, kind) {
  const k = state.overviewMode ? 1.8 : 1, at = distance => point.x + point.dir * distance * k;
  context.beginPath();
  const h = 7 * k;
  if (kind === 'many') { context.moveTo(at(14), point.y); context.lineTo(at(0), point.y - h); context.moveTo(at(14), point.y); context.lineTo(at(0), point.y + h); }
  if (kind === 'one') { context.moveTo(at(7), point.y - h); context.lineTo(at(7), point.y + h); }
  if (kind === 'one-only') for (const distance of [6, 11]) { context.moveTo(at(distance), point.y - h); context.lineTo(at(distance), point.y + h); }
  if (kind === 'zero-one') { context.moveTo(at(6), point.y - h); context.lineTo(at(6), point.y + h); }
  context.stroke();
  if (kind === 'zero-one') { context.beginPath(); context.arc(at(14), point.y, 3.5 * k, 0, Math.PI * 2); context.fillStyle = edgeColors().halo; context.fill(); context.stroke(); }
}
function renderEdges() {
  const generation = ++state.routeGeneration;
  const svg = $('edges');
  const canvasMode = visibleTables().length > 35, overview = Boolean(state.overviewMode), markerScale = overview ? 1.8 : 1;
  svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  // Crow's-foot ends. Each marker is drawn with the table edge at x=20 and grows outward;
  // auto-start-reverse lets the same shape serve the start (FK) and end (PK) of a wire.
  const defs = document.createElementNS(ns, 'defs');
  for (const [id, parts] of Object.entries(ER_MARKERS)) {
    const marker = document.createElementNS(ns, 'marker');
    for (const [key, value] of Object.entries({ id: `er-${id}`, viewBox: '0 0 20 20', refX: 20, refY: 10, markerWidth: 20 * markerScale, markerHeight: 20 * markerScale, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' })) marker.setAttribute(key, value);
    for (const [tag, attrs] of parts) {
      const shape = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
      shape.setAttribute('stroke', 'context-stroke'); shape.setAttribute('stroke-width', '1.6'); shape.setAttribute('stroke-linecap', 'round');
      if (tag === 'path') shape.setAttribute('fill', 'none');
      marker.append(shape);
    }
    defs.append(marker);
  }
  svg.append(defs);
  edgeRefs.clear();
  const byId = new Map(visibleTables().map(table => [table.id, table]));
  state.overviewSlots = overview ? overviewSlots(visibleRelations(), byId) : null;
  const laneKeyFor = (source, target) => {
    const sourceColumn = Math.round(graphPosition(source.id).x / (NODE_WIDTH + 172));
    const targetColumn = Math.round(graphPosition(target.id).x / (NODE_WIDTH + 172));
    return `${Math.min(sourceColumn, targetColumn)}:${Math.max(sourceColumn, targetColumn)}`;
  };
  const laneTotals = new Map();
  for (const relation of visibleRelations()) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    const key = laneKeyFor(source, target);
    laneTotals.set(key, (laneTotals.get(key) || 0) + (overview ? 1 : relation.pairs.length));
  }
  const lanes = new Map();
  const connections = [];
  for (const relation of visibleRelations()) {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) continue;
    relation.pairs.forEach((pair, index) => {
      if (overview && index > 0) return;
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
      const path = state.edgeRoutes?.get(key) || edgePath(source, target, pair, lane, key);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', path.d);
      line.setAttribute('class', `edge${isDraftRelation(relation) ? ' proposed' : ''}`);
      const ends = relationEnds(relation, source, target);
      if (ends.start) line.setAttribute('marker-start', `url(#er-${ends.start})`);
      if (ends.end) line.setAttribute('marker-end', `url(#er-${ends.end})`);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', path.d); hit.setAttribute('class', 'edge hit');
      hit.dataset.relation = relation.id;
      hit.addEventListener('click', event => { event.stopPropagation(); selectRelation(relation.id); });
      hit.addEventListener('mouseenter', () => line.classList.add('hover'));
      hit.addEventListener('mouseleave', () => line.classList.remove('hover'));
      const labels = {};
      if (!canvasMode) svg.append(line, ...Object.values(labels), hit);
      if (!edgeRefs.has(relation.id)) edgeRefs.set(relation.id, []);
      const ref = { line, hit, source, target, pair, lane, key, labels, markers: ends,
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
      const path = edgePath(ref.source, ref.target, ref.pair, ref.lane, ref.key);
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
        stroke: selected ? edgeColors().selected : incident ? edgeColors().trace : focused ? edgeColors().focus : proposed ? edgeColors().proposed : edgeColors().wire,
        opacity: dimmed && !selected ? .28 : selected || incident ? 1 : proposed ? .88 : focused ? .8 : .75,
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

function rankedSearch(term) {
  if (!term) return [];
  const ids = searchMatches(term), rank = table => { const name = table.name.toLowerCase(); return name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : 3; };
  return state.schema.tables.filter(table => ids.has(table.id)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
function updateSearchCount() {
  const output = $('searchCount'), term = $('searchInput').value.trim().toLowerCase();
  output.hidden = !term; if (!term) return;
  const total = rankedSearch(term).length;
  output.textContent = !total ? 'لا نتائج' : state.searchIndex >= 0 ? `${Math.min(state.searchIndex + 1, total)}/${total}` : String(total);
  output.classList.toggle('none', !total);
  output.title = total ? 'Enter للتالي · Shift+Enter للسابق' : '';
}
function updateEmphasis() {
  const scopeKey = `${state.selectedTable}|${state.selectedRelation}|${state.viewMode}|${state.topic}|${state.focusTable}`;
  if (scopeKey !== state.aiScopeKey) { state.aiScopeKey = scopeKey; state.aiWide = false; updateAiSettings(); if ($('aiDialog').open && !state.aiMessages.length && !state.aiController) renderAiMessages(); }
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
    if (ref.ends) for (const end of ['start', 'end']) if (ref.markers?.[end]) drawErEnd(context, ref.ends[end], ref.markers[end]);
    context.font = '600 13px "Roboto Mono", monospace';
    context.textAlign = 'center';
    context.fillStyle = edgeColors().label;
    context.strokeStyle = edgeColors().halo; context.lineWidth = 4;
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
    const overview = state.scale < .42;
    $('viewport').classList.toggle('overview', overview);
    if (overview !== Boolean(state.overviewMode)) { state.overviewMode = overview; state.edgeRoutes = null; renderEdges(); }
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
  root.append(headerIcon(modalHeader('تفاصيل العلاقة', isDraftRelation(relation) ? 'علاقة مقترحة ضمن المسودة.' : 'علاقة مفتاح أجنبي في المخطط.', () => dialog.close(), 'relationshipTitle'), 'relation'));
  const body = el('div', 'modal-body');
  body.append(el('h3', '', 'عمود المصدر · Foreign key'), el('div', 'relation-identifier', relation.pairs.map(pair => `${from.name}.${pair.source}`).join('\n')), el('h3', '', 'العمود المشار إليه'), el('div', 'relation-identifier referenced', relation.pairs.map(pair => `${to.name}.${pair.target}`).join('\n')));
  const tags = el('div', 'chip-row');
  const columns = relation.pairs.map(pair => from.columns.find(column => column.name === pair.source)).filter(Boolean);
  if (columns.length) tags.append(el('span', 'chip', [...new Set(columns.map(column => column.type))].join(' / ')));
  for (const topic of state.groups.filter(topic => topic.id !== 'all' && topic.ids.has(from.id) && topic.ids.has(to.id))) tags.append(el('span', 'chip', topic.label));
  body.append(tags);
  const sql = `FOREIGN KEY (${relation.pairs.map(pair => pair.source).join(', ')})\nREFERENCES ${to.schema}.${to.name} (${relation.pairs.map(pair => pair.target).join(', ')})\nON DELETE ${({ a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT' })[relation.onDelete] || 'NO ACTION'}${relation.onUpdate ? `\nON UPDATE ${({ a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT' })[relation.onUpdate] || 'NO ACTION'}` : ''}`;
  body.append(codeBlock(sql, relation.name), uiButton('حذف العلاقة من المسودة', () => confirmAction('حذف العلاقة من المسودة؟', `${from.name} → ${to.name}`, 'سيُسجل حذف العلاقة ضمن التغييرات المقترحة.', () => { stage({type:'dropRelation',relationId:id}); dialog.close(); }), 'text-button danger'));
  root.append(body, modalFooter([uiButton('إظهار على الخريطة', () => { dialog.close(); setViewMode('focus'); chooseFocusTable(from.id); }), uiButton('إغلاق', () => dialog.close())]));
  openDialog(dialog);
}

function tableSql(table) {
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const primary = table.columns.filter(column => column.primary);
  const lines = table.columns.map(column => `  ${quote(column.name)} ${column.type}${column.primary && primary.length === 1 ? ' PRIMARY KEY' : ''}${!column.nullable && !(column.primary && primary.length === 1) ? ' NOT NULL' : ''}${column.default ? ` DEFAULT ${column.default}` : ''}${column.unique && !column.primary ? ' UNIQUE' : ''}`);
  if (primary.length > 1) lines.push(`  PRIMARY KEY (${primary.map(column => quote(column.name)).join(', ')})`);
  for (const key of (table.uniqueKeys || []).filter(key => key.length > 1)) lines.push(`  UNIQUE (${key.map(name => quote(name)).join(', ')})`);
  return `CREATE TABLE ${quote(table.schema)}.${quote(table.name)} (\n${lines.join(',\n')}\n);`;
}
function sourceEvidence(tableId) {
  const analysis = activeWorkspace()?.codeAnalysis;
  return analysis?.tables?.find(table => table.tableId === tableId)?.evidence || [];
}
// Long identifiers wrap after a dot or underscore, never in the middle of a word.
function breakableTitle(header) {
  const heading = header.querySelector('h2'), text = heading.textContent;
  heading.replaceChildren(...text.split(/(?<=[._])/).flatMap(part => [document.createTextNode(part), document.createElement('wbr')]));
  heading.classList.add('identifier-title'); heading.dir = 'ltr';
  return header;
}
// Every modal header opens with a quiet icon tile that names the kind of task.
const DIALOG_ICONS = { connectDialog: 'database', workspaceDialog: 'arrange', planDialog: 'sparkle', changesPanel: 'draft', topicsDialog: 'arrange', codeDialog: 'code', aiSettingsDialog: 'key', arrangeDialog: 'arrange' };
function headerIcon(header, name, tone = '') {
  header.querySelector(':scope > .modal-icon')?.remove();
  if (!name) return header;
  const tile = el('span', `modal-icon${tone ? ` ${tone}` : ''}`); tile.setAttribute('aria-hidden', 'true'); tile.append(sprite(name));
  header.prepend(tile); return header;
}
const SHORTCUTS = [
  ['الخريطة', [['تحديد', ['V']], ['جدول جديد', ['T']], ['علاقة جديدة', ['R']], ['ترتيب الجداول', ['A']], ['تقريب / تبعيد', ['+', '−']], ['حجم مقروء', ['0']], ['كامل المخطط', ['F']], ['تحريك الخريطة', ['←', '↑', '→', '↓']]]],
  ['البحث والتنقل', [['البحث في الخريطة', ['/']], ['النتيجة التالية', ['Enter']], ['النتيجة السابقة', ['Shift', 'Enter']], ['مسح البحث', ['Esc']], ['الأوامر والقفز إلى جدول', ['Ctrl', 'K']]]],
  ['المسودة والأدوات', [['تراجع', ['Ctrl', 'Z']], ['إعادة', ['Ctrl', 'Y']], ['مراجعة المسودة', ['D']], ['فحص المخطط', ['L']], ['تصدير المخطط', ['E']], ['إغلاق النافذة أو التحديد', ['Esc']]]]
];
function openShortcuts() {
  closeHeaderMenus();
  const dialog = $('shortcutsDialog'), root = $('shortcutsContent'); root.replaceChildren();
  root.append(headerIcon(modalHeader('اختصارات لوحة المفاتيح', 'كل ما في الخريطة يُنجز من لوحة المفاتيح أيضًا.', () => dialog.close(), 'shortcutsTitle'), 'keyboard'));
  const body = el('div', 'modal-body'), groups = el('div', 'shortcut-groups');
  for (const [title, rows] of SHORTCUTS) {
    const group = el('section', 'shortcut-group'), list = el('dl');
    for (const [label, keys] of rows) {
      const row = el('div', 'shortcut-row'), combo = el('dd');
      keys.forEach(key => combo.append(el('kbd', '', key)));
      row.append(el('dt', '', label), combo); list.append(row);
    }
    group.append(el('h3', '', title), list); groups.append(group);
  }
  body.append(groups);
  root.append(body, modalFooter([uiButton('كل الأوامر', () => { dialog.close(); openQuickActions(); }, 'secondary-button')], 'Ctrl K يفتح لوحة الأوامر من أي مكان.'));
  openDialog(dialog);
}
function closeInspector() {
  state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis();
}
function confirmAction(title, description, message, apply, label = 'حذف من المسودة', danger = true, detail = 'يمكن التراجع عن هذا التغيير من مراجعة المسودة.') {
  const dialog = $('confirmationDialog'), root = $('confirmationContent'); root.replaceChildren();
  const workspaceId = state.workspaceId;
  root.append(headerIcon(modalHeader(title, description, () => dialog.close(), 'confirmationTitle'), danger ? 'trash' : 'info', danger ? 'danger' : ''));
  const body = el('div', 'modal-body'); body.append(notice(message, detail, 'warning')); root.append(body);
  root.append(modalFooter([
    uiButton(label, () => { if (workspaceId !== state.workspaceId) { dialog.close(); return; } apply(); dialog.close(); }, danger ? 'primary-button danger' : 'primary-button'),
    uiButton('إلغاء', () => dialog.close())
  ])); openDialog(dialog);
}
// Column notes. A comment in the database always wins; then what you wrote; then what AI explained.
const NOTE_BASIS = { db: 'من قاعدة البيانات', documented: 'من التعليق أو الكود', schema: 'من بنية المخطط', name: 'تخمين من الاسم', user: 'كتبته أنت' };
function readColumnNotesStore() {
  if (state.columnNotesCache) return state.columnNotesCache;
  let value = {};
  try {
    const saved = JSON.parse(store.getItem(`${storageKey()}.columnNotes`) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) value = saved;
  } catch { /* unreadable notes are ignored */ }
  return (state.columnNotesCache = value);
}
function writeColumnNotes() { store.setItem(`${storageKey()}.columnNotes`, JSON.stringify(readColumnNotesStore())); }
function columnNote(table, column) {
  if (column.description) return { text: column.description, basis: 'db' };
  return readColumnNotesStore()[table.id]?.columns?.[column.name] || null;
}
function columnTitle(table, column) {
  const note = columnNote(table, column);
  return `${column.name} · ${column.type}${column.nullable ? ' · nullable' : ' · not null'}${note ? `\n${note.text}` : ''}`;
}
function applyColumnTitles(tableId) {
  const table = state.schema.tables.find(item => item.id === tableId); if (!table) return;
  for (const row of document.querySelectorAll(`.table-node[data-table="${CSS.escape(tableId)}"] .column`)) {
    const column = table.columns.find(item => item.name === row.dataset.column);
    if (column) row.title = columnTitle(table, column);
  }
}
function setColumnNote(table, columnName, text, basis = 'user') {
  const entry = (readColumnNotesStore()[table.id] ||= { summary: '', columns: {} });
  entry.columns ||= {};
  const clean = text.trim().slice(0, 240);
  if (clean) entry.columns[columnName] = { text: clean, basis }; else delete entry.columns[columnName];
  writeColumnNotes(); applyColumnTitles(table.id);
}
function clearAiColumnNotes(table) {
  const entry = readColumnNotesStore()[table.id]; if (!entry) return;
  for (const [name, note] of Object.entries(entry.columns || {})) if (note.basis !== 'user') delete entry.columns[name];
  entry.summary = ''; writeColumnNotes(); applyColumnTitles(table.id); state.columnError = ''; refreshColumnViews();
}
function refreshColumnViews() {
  if (!$('details').hidden && state.inspectorTab === 'columns') renderDetails();
  if ($('tableDialog').open) state.redrawColumns?.();
}
function columnNoteLine(table, column, refresh) {
  const note = columnNote(table, column), line = el('div', 'column-note');
  const edit = () => {
    const input = el('input', 'column-note-input'); input.value = note?.text || ''; input.maxLength = 240;
    input.placeholder = 'ماذا يخزّن هذا العمود؟'; input.setAttribute('aria-label', `شرح العمود ${column.name}`);
    let done = false;
    const finish = save => { if (done) return; done = true; if (save) setColumnNote(table, column.name, input.value, 'user'); refresh(); };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    line.replaceChildren(input); input.focus(); input.select();
  };
  if (note?.basis === 'db') line.append(el('span', 'column-note-text', note.text), el('span', 'note-basis db', NOTE_BASIS.db));
  else if (note) {
    const text = uiButton(note.text, edit, 'column-note-text editable'); text.title = 'انقر لتعديل الشرح';
    line.append(text, el('span', `note-basis ${note.basis}`, NOTE_BASIS[note.basis] || ''));
  } else {
    // No note yet: the add control lives in the column's own row, so empty notes take no height.
    const add = uiButton('+ شرح', () => { if (!line.isConnected) add.closest('.column-item')?.append(line); edit(); }, 'column-note-add');
    add.title = 'أضف شرحًا لهذا العمود'; add.setAttribute('aria-label', `أضف شرحًا للعمود ${column.name}`); line.append(add);
  }
  return line;
}
function columnList(table, { expanded = false, query = '', refresh = refreshColumnViews } = {}) {
  const list = el('ul', 'column-list');
  const needle = query.toLowerCase();
  for (const column of table.columns.filter(item => `${item.name} ${item.type}`.toLowerCase().includes(needle))) {
    const item = el('li', 'column-item');
    const name = uiButton(column.name, () => openEditor('editColumn', { tableId: table.id, columnName: column.name }), 'column-name-action');
    name.title = `تعديل العمود ${column.name}`;
    const head = el('div', 'column-item-head'); head.append(name);
    if (column.primary || column.foreign) head.append(el('span', `col-key ${column.primary ? 'pk' : 'fk'}`, column.primary ? 'PK' : 'FK'));
    const type = el('span', 'column-item-type', column.type), note = columnNoteLine(table, column, refresh), add = note.querySelector(':scope > .column-note-add');
    head.append(type);
    if (add && note.children.length === 1) { head.insertBefore(add, type); item.append(head); } else item.append(head, note);
    if (expanded) {
      const facts = el('div', 'column-facts');
      if (column.nullable) facts.append(el('span', 'chip mono', 'NULL'));
      if (column.unique) facts.append(el('span', 'chip mono', 'UNIQUE'));
      if (column.default) facts.append(el('span', 'chip mono', `DEFAULT ${column.default}`));
      if (facts.children.length) item.append(facts);
    }
    list.append(item);
  }
  if (!list.children.length) list.append(el('li', 'table-empty', query ? 'لا توجد أعمدة تطابق البحث.' : 'هذا الجدول لا يحتوي أعمدة بعد.'));
  return list;
}
function columnNotesBar(table) {
  const bar = el('div', 'column-notes-bar'), busy = state.columnBusy === table.id;
  const summary = table.description || readColumnNotesStore()[table.id]?.summary;
  if (summary) bar.append(el('p', 'column-summary', summary));
  const explained = table.columns.filter(column => columnNote(table, column)).length;
  const actions = el('div', 'column-notes-actions');
  const status = el('span', `field-hint${state.columnError && !busy ? ' error' : ''}`, busy ? 'AI يقرأ بنية الجدول وعلاقاته…' : state.columnError || `${explained} من ${table.columns.length} أعمدة لها شرح`);
  status.setAttribute('role', 'status');
  const run = uiButton(busy ? 'إيقاف' : explained ? 'أعد الشرح بالـAI' : 'اشرح الأعمدة بالـAI', () => busy ? state.columnController?.abort() : explainColumns(table.id), 'secondary-button');
  actions.append(status, run);
  if (!busy && Object.values(readColumnNotesStore()[table.id]?.columns || {}).some(note => note.basis !== 'user')) actions.append(uiButton('مسح شروح AI', () => clearAiColumnNotes(table), 'text-button'));
  bar.append(actions);
  return bar;
}
async function explainColumns(tableId) {
  const table = state.schema.tables.find(item => item.id === tableId);
  if (!table || state.columnBusy) return;
  const workspaceId = state.workspaceId, signature = JSON.stringify(table.columns.map(column => [column.name, column.type, column.nullable, column.primary, column.foreign]));
  const controller = new AbortController();
  state.columnController = controller; state.columnBusy = tableId; state.columnError = ''; refreshColumnViews();
  try {
    const relations = state.schema.relations.filter(relation => relation.source === tableId || relation.target === tableId);
    const near = new Set([tableId, ...relations.flatMap(relation => [relation.source, relation.target])]);
    const scoped = { ...state.schema, tables: state.schema.tables.filter(item => near.has(item.id)), relations };
    const data = await askAi('columns', `اشرح أعمدة الجدول ${table.schema}.${table.name}`, scoped, controller.signal, { focus: { tableId }, evidence: sourceEvidence(tableId).slice(0, 8) });
    if (workspaceId !== state.workspaceId) return;
    const current = state.schema.tables.find(item => item.id === tableId);
    if (!current || signature !== JSON.stringify(current.columns.map(column => [column.name, column.type, column.nullable, column.primary, column.foreign]))) throw new Error('تغيرت أعمدة الجدول أثناء الشرح. أعد المحاولة.');
    const entry = (readColumnNotesStore()[tableId] ||= { summary: '', columns: {} });
    entry.columns ||= {}; entry.summary = data.notes.summary || entry.summary || ''; entry.at = Date.now();
    for (const [name, note] of Object.entries(data.notes.columns)) if (entry.columns[name]?.basis !== 'user') entry.columns[name] = note;
    writeColumnNotes(); applyColumnTitles(tableId);
    const skipped = data.notes.missing.filter(name => !current.columns.find(column => column.name === name)?.description);
    if (skipped.length) state.columnError = `لم يشرح AI ${skipped.length} عمودًا: ${skipped.slice(0, 3).map(name => `⁦${name}⁩`).join('، ')}${skipped.length > 3 ? '…' : ''}. أعد الشرح أو اكتبه بنفسك.`;
  } catch (error) { if (workspaceId === state.workspaceId && error.name !== 'AbortError') state.columnError = error.message; }
  finally {
    if (state.columnController === controller) { state.columnController = null; state.columnBusy = null; }
    if (workspaceId === state.workspaceId) refreshColumnViews();
  }
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
  root.append(headerIcon(breakableTitle(modalHeader(`${table.schema}.${table.name}`, '', closeInspector)), 'table'));
  const body = el('div', 'modal-body'), chips = el('div', 'chip-row');
  const membership = state.groups.find(group => group.id !== 'all' && group.ids.has(table.id));
  chips.append(el('span', 'chip', `${table.columns.length} أعمدة`), el('span', 'chip', `${relevant.length} علاقات`), ...(table.approxRows > 0 ? [el('span', 'chip', `≈ ${table.approxRows.toLocaleString('en-US')} صف`)] : []), el('span', 'chip', isDraftTable(table) ? 'مسودة' : membership?.label || table.schema));
  body.append(chips, uiTabs([['details', 'التفاصيل'], ['relations', 'العلاقات'], ['columns', 'الأعمدة']], state.inspectorTab,
    tab => { state.inspectorTab = tab; renderDetails(); }));
  const groups = state.groups.filter(group => group.id !== 'all' && group.ids.has(table.id));
  if (state.inspectorTab === 'columns') {
    body.append(columnNotesBar(table), columnList(table, { refresh: renderDetails }), el('h3', '', 'يظهر في هذه المواضيع'), el('p', 'field-hint', 'عضوية الجدول مستقلة عن تعريفه؛ يمكن مشاركته بين المواضيع.'));
    const memberships = el('div', 'chip-row'); groups.forEach(group => memberships.append(el('span', 'chip', group.label)));
    if (!groups.length) memberships.append(el('p', 'field-hint', 'لم يُضف هذا الجدول إلى موضوع بعد.'));
    body.append(memberships, notice('تعديلات محفوظة في المسودة', 'تعديل المخطط لا يكتب مباشرة إلى قاعدة البيانات.'));
  } else if (state.inspectorTab === 'relations') {
    body.append(relationCards(table), notice('السياق المشترك بين المواضيع', 'قد يظهر الجدول في أكثر من موضوع عندما يخدم وظيفة الكود في كل منها.'));
  } else {
    const fields = el('div', 'read-only-fields');
    for (const [label, value] of [['Schema', table.schema], ['اسم الجدول', table.name]]) { const field = el('label', '', label), input = el('input'); input.value = value; input.disabled = true; input.dir = 'ltr'; field.append(input); fields.append(field); }
    body.append(fields, tableCodeDetails(table), uiButton('حذف الجدول في المسودة', () => confirmDropTable(table.id), 'text-button danger'));
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
  root.append(headerIcon(breakableTitle(modalHeader(`${table.schema}.${table.name}`, 'عرض موسّع لبنية الجدول. هذه أعمدة المخطط وليست صفوف بيانات.', () => dialog.close(), 'expandedTableTitle')), 'table'));
  const body = el('div', 'modal-body'), content = el('div', 'expanded-table-tab'); let selected = 'columns';
  const entries = [['details', 'مصادر الكود'], ['sql', 'SQL'], ['relations', 'العلاقات'], ['columns', 'الأعمدة']];
  const show = tab => {
    selected = tab; body.querySelector('.ui-tabs')?.replaceWith(uiTabs(entries, selected, show)); content.replaceChildren();
    if (tab === 'columns') {
      const row = el('div', 'inspector-title-row'), search = el('input'); search.type = 'search'; search.placeholder = 'ابحث في الأعمدة…'; search.setAttribute('aria-label', 'ابحث في أعمدة الجدول');
      row.append(search);
      const bar = el('div'), list = el('div');
      const draw = () => { bar.replaceChildren(columnNotesBar(table)); list.replaceChildren(columnList(table, { expanded: true, query: search.value, refresh: draw })); };
      search.addEventListener('input', draw); draw(); state.redrawColumns = draw;
      content.append(bar, row, list, notice('تعريف واحد بين المواضيع', 'كل نسخة على الخريطة تشير إلى تعريف الجدول نفسه.'));
    } else state.redrawColumns = null, content.append(tab === 'relations' ? relationCards(table) : tab === 'sql' ? codeBlock(tableSql(table)) : tableCodeDetails(table, false));
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

function svgIcon(name) { return icon(name); }
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
    item('حذف الجدول في المسودة', 'trash', () => confirmDropTable(tableId), true);
  } else {
    item('إنشاء جدول هنا', 'table', () => openEditor('addTable', { position: point }));
    item('إنشاء علاقة', 'link', () => openEditor('addRelation'));
    item('توزيع على كامل الشاشة', 'fit', arrangeTables);
  }
  menu.replaceChildren(...items); menu.hidden = false;
  const x = event.clientX - mapRect.left, y = event.clientY - mapRect.top;
  requestAnimationFrame(() => {
    menu.style.left = `${Math.max(12, Math.min(x, mapRect.width - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(y, mapRect.height - menu.offsetHeight - 12))}px`;
    menu.querySelector('button')?.focus();
  });
}
function confirmDropTable(tableId) {
  const table = state.schema.tables.find(item => item.id === tableId); if (!table) return;
  const linked = state.schema.relations.filter(relation => relation.source === tableId || relation.target === tableId).length;
  const rows = table.approxRows > 0 ? ` يحتوي الجدول ≈ ${table.approxRows.toLocaleString('en-US')} صف ستُفقد عند التنفيذ.` : '';
  confirmAction('حذف الجدول في المسودة؟', `${table.schema}.${table.name}`,
    `سيُسجل حذف الجدول${linked === 1 ? ' مع علاقته' : linked ? ` مع علاقاته (${linked})` : ''} ضمن المسودة.${rows}`,
    () => { closeInspector(); stage({ type: 'dropTable', tableId }); }, 'حذف الجدول');
}
function arrangeTables() {
  state.hoveredTable = null;
  if (state.viewMode === 'focus' && state.focusTable) {
    store.removeItem(`${storageKey()}.focusLayout.${state.focusTable}`);
    buildFocusPositions(); renderNodes(); requestAnimationFrame(() => fitView(false));
    showToast('أُعيد ترتيب الجدول وعلاقاته'); return;
  }
  if (state.viewMode === 'topics' && state.topic !== 'all') {
    store.removeItem(`${storageKey()}.topicLayout.${state.topic}`);
    buildTopicPositions(); renderNodes(); requestAnimationFrame(() => fitView(true));
    showToast('أُعيد ترتيب جداول الموضوع'); return;
  }
  state.hoveredTable = null; state.positions = layoutTables(); savePositions(); renderNodes(); requestAnimationFrame(() => fitView(state.topic !== 'all'));
  showToast('وُزعت الجداول على كامل مساحة الخريطة حسب قوة الترابط');
}
function draftKey() { return `${storageKey()}.draft${state.workspaceId !== 'legacy' && state.base.fingerprint ? `.${state.base.fingerprint}` : ''}`; }
function topicKey() { return `${storageKey()}.topics`; }
function saveDraft() { store.setItem(draftKey(), JSON.stringify({ operations: state.operations, cursor: state.cursor })); }
function saveTopics() {
  state.customGroups = state.groups.slice(1).map(group => ({ id: group.id, label: group.label, color: group.color, ids: [...group.ids],
    ...(group.reason ? { reason: group.reason } : {}), ...(group.moduleIds ? { moduleIds: group.moduleIds } : {}), ...(group.evidence ? { evidence: group.evidence } : {}) }));
  store.setItem(topicKey(), JSON.stringify(state.customGroups));
}
function updateDraftView() {
  $('pendingCount').textContent = String(state.cursor);
  $('changesButton').dataset.pending = String(state.cursor);
  updateViewCounts();
  $('undoButton').disabled = $('undoQuick').disabled = state.cursor === 0;
  $('redoButton').disabled = $('redoQuick').disabled = state.cursor === state.operations.length;
  $('reviewButton').disabled = state.cursor === 0;
  $('discardDraftButton').disabled = !state.operations.length;
  $('draftSummary').textContent = state.operations.length ? `${state.cursor} تغييرات محلية جاهزة للمراجعة والتسليم إلى المساعد.` : 'التعديلات تُجمع هنا قبل أن تصل إلى قاعدة البيانات.';
  $('changesPanel').classList.toggle('is-empty', !state.operations.length);
  const list = $('changeList'); list.replaceChildren();
  if (!state.operations.length) {
    const empty = el('div', 'empty-state'), mark = el('span', 'empty-state-icon'); mark.append(sprite('draft'));
    empty.append(mark, el('strong', '', 'لا توجد تغييرات بعد'), el('p', '', 'أضف جدولًا أو عدّل عمودًا من الخريطة أو من قائمة الجدول. كل تعديل يظهر هنا ويمكن التراجع عنه.'));
    list.append(empty);
  }
  // Each change is described against the schema just before it, so drops still name what they removed.
  let before = state.base;
  state.operations.forEach((operation, index) => {
    const tableId = operationTableId(operation, before), label = describeOperation(operation, before);
    try { before = applyOperation(before, operation); } catch { /* a stale step stays listed */ }
    const live = index < state.cursor && state.schema.tables.some(table => table.id === tableId);
    const row = live ? uiButton('', () => { $('changesPanel').close(); locateTable(tableId); }, `change-item`) : el('div', `change-item${index >= state.cursor ? ' undone' : ''}`);
    if (live) row.title = 'إظهار على الخريطة';
    row.append(el('span', 'change-number', String(index + 1)), el('span', 'change-label', label));
    if (index >= state.cursor) row.append(el('small', 'change-state', 'متراجع عنه'));
    list.append(row);
  });
}
function operationTableId(operation, schema) {
  if (operation.type === 'addTable') return operation.id;
  if (operation.type === 'addRelation') return operation.relation.source;
  if (operation.type === 'dropRelation') return schema.relations.find(item => item.id === operation.relationId)?.source;
  return operation.tableId;
}
// Bring a table into view from anywhere: leave full-page views, select it and center it.
function locateTable(id) {
  if (!state.schema.tables.some(table => table.id === id)) return;
  if (state.viewMode === 'tables' || (state.viewMode === 'topics' && !visibleTables().some(table => table.id === id))) setViewMode('map');
  if (state.viewMode === 'focus') chooseFocusTable(id);
  selectTable(id); centerTable(id);
}
// Only what the current draft adds wears the dashed draft look. A schema imported as a proposal
// (every element already marked proposed) reads as a normal map until you change it.
function markDraft() {
  const marks = { tables: new Set(), relations: new Set(), columns: new Set() }, key = (tableId, name) => `${tableId}|${name}`;
  for (const operation of state.operations.slice(0, state.cursor)) {
    if (operation.type === 'addTable') marks.tables.add(operation.id);
    if (operation.type === 'addRelation') marks.relations.add(operation.relation.id);
    if (operation.type === 'addColumn') marks.columns.add(key(operation.tableId, operation.column.name));
    if (operation.type === 'updateColumn' && operation.patch.name && marks.columns.delete(key(operation.tableId, operation.columnName))) marks.columns.add(key(operation.tableId, operation.patch.name));
  }
  state.draftMarks = { has: (kind, id, name) => marks[kind].has(name === undefined ? id : key(id, name)) };
}
const isDraftTable = table => Boolean(state.draftMarks?.has('tables', table.id));
const isDraftRelation = relation => Boolean(state.draftMarks?.has('relations', relation.id));
const isDraftColumn = (table, column) => Boolean(state.draftMarks?.has('columns', table.id, column.name));
function refreshDraft({ fit = false } = {}) {
  state.schema = replay(state.base, state.operations.slice(0, state.cursor)); markDraft();
  buildGroups();
  for (const [id, point] of layoutTables()) if (!state.positions.has(id)) state.positions.set(id, point);
  for (const id of [...state.positions.keys()]) if (!state.schema.tables.some(t => t.id === id)) state.positions.delete(id);
  if (state.focusTable && !state.schema.tables.some(table => table.id === state.focusTable)) state.focusTable = null;
  buildFocusPositions(); buildTopicPositions();
  renderTopics(); renderView(); renderNodes(); renderDetails(); updateDraftView();
  if ($('tableDialog').open) openExpandedTable($('tableDialog').dataset.tableId);
  renderEmptyWorkspace();
  if ($('lintDialog').open) renderLint(); else updateLintCount();
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
  const cursor = Math.max(0, Math.min(state.operations.length, state.cursor + delta));
  if (cursor === state.cursor) return;
  // Say which change moved, described against the schema just before it.
  const index = delta < 0 ? cursor : state.cursor, label = describeOperation(state.operations[index], replay(state.base, state.operations.slice(0, index)));
  state.cursor = cursor; saveDraft(); refreshDraft();
  showToast(`${delta < 0 ? 'تراجع' : 'إعادة'}: ${label}`);
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
  headerIcon($('editTitle').parentElement, { addTable: 'table', renameTable: 'edit', addColumn: 'plus', editColumn: 'edit', addRelation: 'relation' }[kind]);
  $('editDescription').textContent = kind === 'addTable' ? 'أضف تعريف الجدول إلى المسودة ثم جهّز أعمدته.' : kind === 'renameTable' ? 'سيبقى الجدول مرتبطًا بمواضيعه وعلاقاته.' : kind === 'addRelation' ? 'عمود المفتاح الأجنبي يشير إلى عمود المفتاح الأساسي في الجدول الهدف.' : `تعديل أعمدة ${table.name} ضمن المسودة.`;
  $('editDialog').style.setProperty('--modal-width', `${kind === 'addRelation' ? 560 : kind === 'renameTable' ? 440 : 520}px`);
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
    fields.append(selectField('source', 'الجدول المصدر', choices, context.source), selectField('target', 'الجدول الهدف', choices, context.target ?? choices.find(([id]) => id !== (context.source ?? choices[0]?.[0]))?.[0]),
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
      const status = $('relationshipCompatibility'), targetIsKey = Boolean(targetColumn && (targetColumn.primary || targetColumn.unique || (target.uniqueKeys || []).some(key => key.length === 1 && key[0] === targetColumn.name)));
      const selfSame = Boolean(sourceColumn && targetColumn && source.id === target.id && sourceColumn.name === targetColumn.name);
      const compatible = sourceColumn && targetColumn && sourceColumn.type === targetColumn.type && targetIsKey && !selfSame;
      if (status) {
        status.className = `notice full ${compatible ? 'success' : 'warning'}`;
        status.replaceChildren(icon(compatible ? 'check' : 'info'), el('div', 'notice-copy', compatible ? `النوعان متوافقان: ${sourceColumn.type} · ${source.name}.${sourceColumn.name} → ${target.name}.${targetColumn.name}` : selfSame ? 'العمود يشير إلى نفسه. اختر جدولًا أو عمودًا مختلفًا للهدف.' : sourceColumn && targetColumn && !targetIsKey ? `العمود ${target.name}.${targetColumn.name} ليس مفتاحًا أساسيًا أو فريدًا؛ سيرفض PostgreSQL هذه العلاقة.` : 'راجع الأعمدة ونوعيها قبل إضافة العلاقة إلى المسودة.'));
      }
      $('editSubmit').disabled = !sourceColumn || !targetColumn || selfSame;
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
  root.append(headerIcon(modalHeader('إعدادات الموضوع', 'غيّر الاسم والجداول الظاهرة دون تكرار تعريف الجدول.', cancel, 'topicSettingsTitle'), 'edit'));
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
  root.append(headerIcon(modalHeader('راجع اقتراح المواضيع', `${suggestions.length} مواضيع مبنية على استخدام الجداول في الكود.`, () => dialog.close(), 'topicProposalTitle'), 'sparkle', 'accent'));
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
// ---- Schema check: local rules over the current draft, each finding one click from the map.
const SEVERITY_LABELS = { error: 'أخطاء', warning: 'تحذيرات', info: 'ملاحظات' };
function updateLintCount() {
  const findings = lintSchema(state.schema), serious = findings.filter(item => item.severity !== 'info').length;
  $('lintCount').hidden = !serious; $('lintCount').textContent = String(serious);
  const errors = findings.some(item => item.severity === 'error');
  $('lintCount').classList.toggle('error', errors);
  // Only real errors earn a dot on the closed menu; warnings wait inside it.
  $('toolsButton').classList.toggle('has-alert', errors);
  $('toolsButton').title = errors ? 'القائمة الرئيسية · فحص المخطط وجد أخطاء' : 'القائمة الرئيسية';
  return findings;
}
function stageLintFixes(findings) {
  let added = 0;
  for (const finding of findings) {
    try { stage({ ...finding.fix, relation: { ...finding.fix.relation, id: `draft:${crypto.randomUUID()}` } }); added++; } catch { /* already linked or stale */ }
  }
  if (added) showToast(added === 1 ? 'أضيفت العلاقة إلى المسودة' : `أضيفت ${added} علاقات إلى المسودة`);
}
function renderLint() {
  const dialog = $('lintDialog'), root = $('lintContent'); root.replaceChildren();
  const findings = updateLintCount(), filter = state.lintFilter && findings.some(item => item.severity === state.lintFilter) ? state.lintFilter : 'all';
  const counts = Object.fromEntries(Object.keys(SEVERITY_LABELS).map(severity => [severity, findings.filter(item => item.severity === severity).length]));
  root.append(headerIcon(modalHeader('فحص المخطط', findings.length ? `${findings.length} ملاحظة على ${state.schema.tables.length} جدول. الفحص محلي ولا يرسل شيئًا.` : 'فحص محلي للمفاتيح والعلاقات والأنواع، دون AI ودون اتصال.', () => dialog.close(), 'lintTitle'), 'check'));
  const body = el('div', 'modal-body');
  if (!findings.length) body.append(notice(state.schema.tables.length ? 'لا توجد ملاحظات' : 'لا توجد جداول بعد', state.schema.tables.length ? 'المفاتيح والعلاقات والأنواع متسقة في المخطط الحالي ومسودته.' : 'أضف جداول أو اربط قاعدة بيانات ثم أعد الفحص.', 'success'));
  else {
    body.append(uiTabs([['all', `الكل ${findings.length}`], ...Object.entries(SEVERITY_LABELS).filter(([severity]) => counts[severity]).map(([severity, label]) => [severity, `${label} ${counts[severity]}`])],
      filter, value => { state.lintFilter = value; renderLint(); }));
    const list = el('ul', 'lint-list'), byId = new Map(state.schema.tables.map(table => [table.id, table]));
    for (const finding of findings.filter(item => filter === 'all' || item.severity === filter)) {
      const item = el('li', `lint-item ${finding.severity}`), head = el('div', 'lint-head');
      const where = el('code', 'lint-where', `${byId.get(finding.tableId)?.name || ''}${finding.columnName ? `.${finding.columnName}` : ''}`); where.dir = 'ltr';
      head.append(el('span', 'lint-dot'), el('strong', '', finding.title));
      if (!finding.title.includes(where.textContent)) head.append(where);
      const actions = el('div', 'lint-actions');
      if (byId.has(finding.tableId)) actions.append(uiButton('إظهار على الخريطة', () => { if (innerWidth < 900) dialog.close(); locateTable(finding.tableId); }, 'text-button'));
      if (finding.fix) actions.append(uiButton('أضف العلاقة إلى المسودة', () => stageLintFixes([finding]), 'text-button strong'));
      item.append(head, el('p', '', finding.detail), actions); list.append(item);
    }
    body.append(list);
  }
  const fixable = findings.filter(item => item.fix);
  root.append(body, modalFooter([
    ...(fixable.length > 1 ? [uiButton(`أضف كل العلاقات المقترحة (${fixable.length})`, () => stageLintFixes(fixable), 'primary-button')] : []),
    uiButton('إغلاق', () => dialog.close())
  ], 'الإصلاحات تُضاف إلى المسودة فقط، ويمكن التراجع عنها.'));
}
function openLint() { closeHeaderMenus(); renderLint(); openDialog($('lintDialog')); }
// ---- Export: the schema (with its draft) as text other tools read, or the draft as a Laravel migration.
function renderExport() {
  const dialog = $('exportDialog'), root = $('exportContent'); root.replaceChildren();
  const format = EXPORT_FORMATS.find(item => item.id === state.exportFormat) || EXPORT_FORMATS[0];
  const partial = visibleTables().length > 0 && visibleTables().length < state.schema.tables.length, scoped = partial && state.exportScope === 'visible';
  const ids = new Set(visibleTables().map(table => table.id));
  const schema = scoped ? { ...state.schema, tables: state.schema.tables.filter(table => ids.has(table.id)), relations: state.schema.relations.filter(relation => ids.has(relation.source) && ids.has(relation.target)) } : state.schema;
  const operations = state.operations.slice(0, state.cursor);
  root.append(headerIcon(modalHeader('تصدير المخطط', 'انسخ المخطط إلى أدوات التوثيق، أو حوّل المسودة إلى migration جاهز للمراجعة.', () => dialog.close(), 'exportTitle'), 'download'));
  const body = el('div', 'modal-body');
  body.append(uiTabs(EXPORT_FORMATS.map(item => [item.id, item.label]), format.id, value => { state.exportFormat = value; renderExport(); }));
  let text = '', fileName = `${slug(activeWorkspace()?.name || state.schema.database)}.${format.fileExtension}`;
  if (format.draft) {
    if (!operations.length) body.append(notice('المسودة فارغة', 'أضف تعديلات إلى المسودة أولًا؛ يتحول كل تعديل إلى خطوة في migration بصيغة Laravel.'));
    else {
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14), migration = toLaravelMigration(state.base, operations, { date: `${stamp.slice(0, 4)}_${stamp.slice(4, 6)}_${stamp.slice(6, 8)}_${stamp.slice(8)}` });
      text = migration.code; fileName = migration.fileName;
      body.append(el('p', 'field-hint', `${operations.length} تغييرات من المسودة. راجع الملف قبل تشغيله؛ لا يكتب ER Atlas في قاعدة البيانات.`));
    }
  } else {
    if (partial) {
      const scope = el('div', 'export-scope');
      for (const [value, label] of [['all', `كل المخطط · ${state.schema.tables.length} جدول`], ['visible', `الظاهر الآن · ${ids.size} جدول`]]) {
        const option = el('label', 'choice'), radio = el('input'); radio.type = 'radio'; radio.name = 'exportScope'; radio.value = value; radio.checked = (scoped ? 'visible' : 'all') === value;
        radio.addEventListener('change', () => { state.exportScope = value; renderExport(); });
        option.append(radio, el('span', '', label)); scope.append(option);
      }
      body.append(scope);
    }
    text = exportSchema(format.id, schema, operations);
    if (operations.length) body.append(el('p', 'field-hint', 'يشمل تغييرات المسودة الحالية.'));
  }
  if (text) body.append(codeBlock(text, fileName));
  root.append(body, modalFooter([
    uiButton('تنزيل الملف', () => downloadText(text, fileName, format.mime), 'primary-button'),
    uiButton('نسخ', () => copyText(text))
  ].map(button => { button.disabled = !text; return button; })));
}
function downloadText(text, fileName, type = 'text/plain') {
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function openExport(format) { closeHeaderMenus(); if (format) state.exportFormat = format; renderExport(); openDialog($('exportDialog')); }
// ---- Connecting an assistant: pick a card, see its state, done.
const LOCAL_PROVIDERS = [
  { id: 'claude-cli', name: 'Claude Code', login: 'claude auth login' },
  { id: 'codex-cli', name: 'Codex', login: 'codex login' }
];
const API_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', note: 'Claude عبر API' },
  { id: 'openai', name: 'OpenAI', note: 'GPT عبر API' },
  { id: 'gemini', name: 'Google Gemini', note: 'Gemini عبر API' },
  { id: 'compatible', name: 'خدمة أخرى', note: 'Ollama وكل ما يتوافق مع OpenAI' }
];
const MODEL_SUGGESTIONS = { 'claude-cli': ['sonnet', 'opus', 'haiku'], 'codex-cli': [], anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], openai: ['gpt-5-mini', 'gpt-5'], gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'], compatible: ['llama3.2'] };
let localAiStatuses = [];
let localAiFailed = false;
function isLocalProvider(id = $('aiProvider').value) { return id === 'claude-cli' || id === 'codex-cli'; }
function providerShort(id = $('aiProvider').value) { return [...LOCAL_PROVIDERS, ...API_PROVIDERS].find(item => item.id === id)?.name || id; }
// tone: ok (ready), warn (one step left), bad (cannot work yet), idle (still checking)
function providerState(id = $('aiProvider').value) {
  if (isLocalProvider(id)) {
    const status = localAiStatuses.find(item => item.provider === id);
    if (!status) return localAiFailed ? { tone: 'bad', text: 'تعذّر فحص الجهاز' } : { tone: 'idle', text: 'أفحص الجهاز…' };
    if (status.ready) return { tone: 'ok', text: 'جاهز · يستخدم اشتراكك' };
    return status.installed ? { tone: 'warn', text: 'الطرفية لم تسجّل الدخول بعد' } : { tone: 'bad', text: 'غير مثبّت على هذا الجهاز' };
  }
  if (id === 'compatible') return $('aiEndpoint').value.trim() ? { tone: 'ok', text: 'جاهز' } : { tone: 'warn', text: 'أدخل رابط الخدمة' };
  return $('aiKey').value ? { tone: 'ok', text: 'المفتاح جاهز' } : { tone: 'warn', text: 'أدخل مفتاح API' };
}
function selectProvider(id) {
  $('aiProvider').value = id; $('aiProvider').dispatchEvent(new Event('change'));
  if (!isLocalProvider(id)) requestAnimationFrame(() => (id === 'compatible' && !$('aiEndpoint').value.trim() ? $('aiEndpoint') : $('aiKey').value ? $('aiModel') : $('aiKey')).focus());
}
function providerCard(provider, { local }) {
  const selected = $('aiProvider').value === provider.id, info = providerState(provider.id);
  const card = el('div', `provider-card${selected ? ' selected' : ''}`);
  card.setAttribute('role', 'radio'); card.setAttribute('aria-checked', String(selected)); card.tabIndex = 0;
  const tile = el('span', 'provider-tile'); tile.append(sprite(local ? 'terminal' : 'key'));
  const copy = el('span', 'provider-copy'); copy.append(el('strong', '', provider.name));
  if (local) {
    const line = el('span', `provider-status ${info.tone}`); line.append(el('i', 'dot'), el('span', '', info.text)); copy.append(line);
    if (info.tone === 'warn') {
      const app = provider.name.split(' ')[0];
      const login = uiButton('', event => { event.stopPropagation(); startCliLogin(provider, login); }, 'login-button');
      login.append(sprite('terminal', 'i i-small'), el('span', '', 'افتح الطرفية وسجّل الدخول'));
      const command = uiButton('', event => { event.stopPropagation(); copyText(provider.login); }, 'copy-command');
      command.append(el('code', '', provider.login), sprite('copy', 'i i-small')); command.title = 'أو انسخ الأمر ونفّذه بنفسك';
      copy.append(el('small', '', `دخولك في تطبيق ${app} منفصل عن الطرفية. سنفتح نافذة طرفية ينفَّذ فيها الأمر مباشرة، وتسجّل بحسابك في المتصفح.`), login, command);
    } else if (info.tone === 'bad' && localAiStatuses.length) copy.append(el('small', '', 'ثبّته ثم اضغط «إعادة الفحص».'));
  } else copy.append(el('small', '', provider.note));
  const radio = el('span', 'provider-radio'); radio.append(sprite('check', 'i i-small'));
  card.append(tile, copy, radio);
  card.addEventListener('click', () => selectProvider(provider.id));
  card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectProvider(provider.id); } });
  return card;
}
function renderProviderChoices() {
  const local = $('localProviderChoices'), api = $('apiProviderChoices'); if (!local || !api) return;
  local.replaceChildren(...LOCAL_PROVIDERS.map(provider => providerCard(provider, { local: true })));
  api.replaceChildren(...API_PROVIDERS.map(provider => providerCard(provider, { local: false })));
}
function updateScopeChip() {
  const current = aiScope(), narrow = aiScope(false), canNarrow = narrow.kind !== 'all';
  $('aiContext').textContent = current.label;
  $('aiScopeChip').disabled = !canNarrow;
  $('aiScopeAction').textContent = !canNarrow ? '' : state.aiWide ? 'عودة إلى التحديد' : 'كل المخطط';
}
function updateAiSettings({ save = false } = {}) {
  const provider = $('aiProvider').value, local = isLocalProvider(provider), info = providerState(provider);
  $('aiApiFields').hidden = local;
  $('aiEndpointWrap').hidden = provider !== 'compatible';
  $('aiKey').disabled = local;
  $('aiKeyWrap').firstChild.textContent = provider === 'compatible' ? 'مفتاح API (اختياري)' : 'مفتاح API';
  $('aiModel').placeholder = local ? 'تلقائي' : MODEL_SUGGESTIONS[provider]?.[0] || 'اسم النموذج';
  $('aiModelLabel').replaceChildren(document.createTextNode('النموذج '), ...(local || provider === 'compatible' ? [el('small', '', 'اختياري')] : []));
  $('aiModelList').replaceChildren(...(MODEL_SUGGESTIONS[provider] || []).map(name => { const option = el('option'); option.value = name; return option; }));
  $('aiProviderName').textContent = providerShort(provider);
  $('aiProviderDot').className = `dot ${info.tone}`;
  $('topicAiName').textContent = `${providerShort(provider)} · ${info.text}`;
  $('topicAiStatus').textContent = info.tone === 'ok' ? '' : `${providerShort(provider)}: ${info.text}.`;
  updateScopeChip();
  renderProviderChoices();
  if (save) store.setItem('eratlas.ai.settings.v1', JSON.stringify({ provider, model: $('aiModel').value.trim(), endpoint: $('aiEndpoint').value.trim() }));
}
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
    localAiStatuses = (await response.json()).providers || []; localAiFailed = false;
    if (!store.getItem('eratlas.ai.settings.v1')) {
      const ready = localAiStatuses.find(item => item.ready);
      if (ready) $('aiProvider').value = ready.provider;
    }
  } catch { localAiFailed = true; }
  updateAiSettings();
  if ($('aiDialog').open && !state.aiController && !state.aiMessages.length) renderAiMessages();
}
function showAiTest(text, kind = '') {
  const result = $('aiTestResult'); result.hidden = false; result.className = `notice ${kind}`.trim(); result.textContent = text;
}
// Opens a real terminal with the sign-in command already running, then waits for the CLI to report ready.
async function startCliLogin(provider, trigger) {
  if (trigger) trigger.disabled = true;
  try {
    const response = await fetch('/api/ai/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: provider.id }) });
    const data = await response.json();
    if (response.status === 404) throw new Error('الخادم يعمل بنسخة أقدم من الصفحة. أعد تشغيل ER Atlas ثم حدّث الصفحة');
    if (!response.ok) throw new Error(data.error || 'تعذّر فتح الطرفية');
    showAiTest(`فُتحت نافذة طرفية تنفّذ ${provider.login}. أكمل الدخول في المتصفح؛ أتحقق تلقائيًا وستصبح البطاقة «جاهز».`);
    clearInterval(state.aiLoginPoll);
    const started = Date.now();
    state.aiLoginPoll = setInterval(async () => {
      if (Date.now() - started > 240000 || !$('aiSettingsDialog').open) { clearInterval(state.aiLoginPoll); return; }
      await loadLocalAiStatus();
      if (providerState(provider.id).tone === 'ok') { clearInterval(state.aiLoginPoll); showAiTest(`${provider.name} جاهز على جهازك.`, 'success'); showToast(`${provider.name} جاهز`); }
    }, 3000);
  } catch (error) { showAiTest(`${error.message}. انسخ الأمر ونفّذه في الطرفية: ${provider.login}`, 'error'); }
  finally { if (trigger?.isConnected) trigger.disabled = false; }
}
async function testAiConnection() {
  const button = $('testAiButton'), provider = $('aiProvider').value, show = showAiTest;
  button.disabled = true; show('أختبر الاتصال…');
  try {
    if (isLocalProvider(provider)) {
      await loadLocalAiStatus();
      const info = providerState(provider), status = localAiStatuses.find(item => item.provider === provider);
      show(info.tone === 'ok' ? `${providerShort(provider)} جاهز على جهازك.` : status?.message || info.text, info.tone === 'ok' ? 'success' : 'error');
    } else {
      const started = performance.now();
      await askAi('ping', 'ping', { tables: [], relations: [] });
      show(`اتصل ${providerShort(provider)} بنجاح خلال ${Math.max(1, Math.round((performance.now() - started) / 1000))} ث.`, 'success');
    }
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
}
async function askAi(mode, question, schema = state.schema, signal, { focus, evidence } = {}) {
  updateAiSettings({ save: true });
  const response = await fetch('/api/ai', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: $('aiProvider').value, model: $('aiModel').value.trim(),
      endpoint: $('aiEndpoint').value.trim(), key: $('aiKey').value, question, mode, schema, focus, evidence,
      ...(mode === 'topics' ? { sourceRoot: $('topicSourceRoot').value.trim() } : {}),
      history: mode === 'explain' || mode === 'ideas' ? state.aiMessages.slice(-12) : [] }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذّر الاتصال بخدمة AI');
  if (['topics', 'columns', 'explain', 'ideas'].includes(mode)) return data;
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
    return { name: String(zone.name || `منطقة ${index + 1}`).trim().slice(0, 48), reason: String(zone.reason || '').trim().slice(0, 200), tableIds: ids };
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
  const zones = $('arrangeZones'); zones.replaceChildren();
  if (proposal.layout && !proposal.error) {
    const names = new Map(proposal.schema.tables.map(table => [table.id, table.name]));
    for (const zone of proposal.layout.zones) {
      const item = el('li', 'arrange-zone'), head = el('div', 'arrange-zone-head');
      head.append(el('strong', '', zone.name), el('span', 'chip', `${zone.tableIds.length} جدول`));
      item.append(head);
      if (zone.reason) item.append(el('p', 'field-hint', zone.reason));
      item.append(el('p', 'arrange-zone-tables', zone.tableIds.map(id => names.get(id)).filter(Boolean).slice(0, 8).join(' · ') + (zone.tableIds.length > 8 ? ` · +${zone.tableIds.length - 8}` : '')));
      zones.append(item);
    }
    const central = proposal.layout.centralTableIds.map(id => names.get(id)).filter(Boolean);
    if (central.length) zones.append(el('li', 'arrange-central', `الجداول المحورية في المركز: ${central.join(' · ')}`));
  }
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
    if (persist) store.setItem(`${storageKey()}.topicLayout.${proposal.topic}`, JSON.stringify(Object.fromEntries(proposal.proposed)));
  } else if (proposal.viewMode === 'focus') {
    state.focusPositions = proposal.proposed;
    if (persist) store.setItem(`${storageKey()}.focusLayout.${proposal.focusTable}`, JSON.stringify(Object.fromEntries(proposal.proposed)));
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
    proposal.status = `اقتراح ${proposal.schema.tables.length} جدول في ${proposal.layout.zones.length} مناطق. راجع المناطق أدناه قبل التطبيق.`;
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
function slug(name) { return String(name).trim().replace(/[^\w\u0600-\u06FF-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace'; }
function exportWorkspace() {
  closeWorkspaceMenu();
  const workspace = activeWorkspace();
  const topics = state.groups.slice(1).map(group => ({ id: group.id, label: group.label, color: group.color, ids: [...group.ids], ...(group.reason ? { reason: group.reason } : {}) }));
  const file = buildExport({ name: workspace.name, kind: workspace.kind, schema: clone(state.base), topics, positions: Object.fromEntries(state.positions), operations: state.operations, cursor: state.cursor, columnNotes: readColumnNotesStore() });
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
  link.href = url; link.download = `${slug(workspace.name)}.eratlas.json`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast('صُدّرت المساحة. الملف لا يحتوي كلمات مرور ولا مسارات الكود.');
}
function importWorkspace() {
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
function deleteWorkspace() {
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
// The three top zones float independently, so a long workspace name used to slide the
// tool strip over the menu. Step the density up one class at a time until they clear;
// d4 (phones) drops the logo pill so the workspace and drafts pills never collide.
function fitChrome() {
  const chrome = document.querySelector('.chrome'); if (!chrome) return;
  const [start, center, end] = ['.chrome-start', '.chrome-center', '.chrome-end'].map(selector => chrome.querySelector(selector));
  chrome.classList.remove('d1', 'd2', 'd3', 'd4'); center.style.removeProperty('translate');
  for (let level = 1; level <= 4; level++) {
    const box = center.getBoundingClientRect(), grow = level === 1 ? 36 : 0; // the inline search widens 72px on focus
    const [a, b] = [start, end].map(zone => zone.getBoundingClientRect()).sort((x, y) => x.left - y.left);
    if (level === 4 && a.right + 12 <= b.left) return; // the strip has its own row; only the sides must clear
    if (level < 4 && box.width + grow * 2 + 24 <= b.left - a.right) {
      // Centered on the screen when it fits; otherwise centered in the free gap between the side zones.
      if (box.left - grow - 12 < a.right || box.right + grow + 12 > b.left) center.style.translate = `${Math.round((a.right + b.left - box.left - box.right) / 2)}px 0`;
      return;
    }
    chrome.classList.add(`d${level}`);
  }
}
let chromeFrame = null;
const scheduleFitChrome = () => { if (!chromeFrame) chromeFrame = requestAnimationFrame(() => { chromeFrame = null; fitChrome(); }); };
function setNavbarSearch(open, { focus = false } = {}) {
  document.querySelector('.chrome').classList.toggle('search-open', open);
  $('searchToggleButton').setAttribute('aria-expanded', String(open));
  $('searchToggleButton').setAttribute('aria-label', open ? 'إغلاق البحث' : 'فتح البحث');
  if (focus) (open ? $('searchInput') : $('searchToggleButton')).focus();
}
function providerLabel() {
  return { 'codex-cli': 'Codex على الجهاز', 'claude-cli': 'Claude Code على الجهاز', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', compatible: 'خدمة متوافقة' }[$('aiProvider').value] || 'Codex على الجهاز';
}
function openAiConversation() {
  closeHeaderMenus(); updateAiSettings(); renderAiMessages(); openDialog($('aiDialog')); autosizeComposer(); $('aiQuestion').focus();
}
function openCodeDialog() {
  closeHeaderMenus(); syncCodeSource(); updateAiSettings(); openDialog($('codeDialog'));
}
function openQuickActions() {
  closeHeaderMenus();
  const hints = { 'جدول جديد': 'T', 'إضافة علاقة': 'R', 'ترتيب الجداول': 'A', 'إظهار كامل المخطط': 'F', 'فحص المخطط': 'L', 'تصدير المخطط (Mermaid · DBML · SQL)': 'E', 'مراجعة المسودة': 'D', 'اختصارات لوحة المفاتيح': '?' };
  const commands = [['جدول جديد', () => openEditor('addTable')], ['إضافة علاقة', () => openEditor('addRelation')], ['فحص المخطط', openLint], ['تصدير المخطط (Mermaid · DBML · SQL)', () => openExport()], ['تحويل المسودة إلى Laravel migration', () => openExport('laravel')], ['تنظيم المواضيع', () => $('topicManageButton').click()], ['ترتيب الجداول', () => openArrangement()], ['ترتيب بالـAI', () => openArrangement('ai')], ['اسأل عن المخطط', openAiConversation], ['مراجعة المسودة', () => openDialog($('changesPanel'))], ['اتصال PostgreSQL', openConnectionDialog], ['تحديث المخطط من القاعدة', () => $('refreshButton').click()], ['تحليل كود المشروع', openCodeDialog], ['مساحة عمل جديدة', () => openWorkspaceDialog()], ['تبديل المظهر (تلقائي / فاتح / ليلي)', cycleTheme], ['تصدير المساحة الحالية', exportWorkspace], ['استيراد مساحة من ملف', importWorkspace], ['إظهار كامل المخطط', () => fitView(false, { overview: true })], ['إعدادات المساعد', () => openDialog($('aiSettingsDialog'))], ['اختصارات لوحة المفاتيح', openShortcuts]];
  const root = $('quickActionList'); root.replaceChildren();
  for (const [label, action] of commands) {
    const command = uiButton(label, () => { $('quickActionsDialog').close(); action(); }, 'quick-command'); command.dataset.label = label.toLowerCase();
    if (hints[label]) command.append(el('kbd', '', hints[label]));
    root.append(command);
  }
  root.append(Object.assign(el('div', 'quick-tables'), { id: 'quickTables' }));
  $('quickSearch').value = ''; openDialog($('quickActionsDialog')); $('quickSearch').focus();
}
// The palette doubles as "go to table": typing a name lists matching tables under the commands.
function filterQuickActions(raw) {
  const term = raw.trim().toLowerCase();
  for (const item of $('quickActionList').querySelectorAll('.quick-command:not(.table-command)')) item.hidden = !item.dataset.label.includes(term);
  const host = $('quickTables'); if (!host) return;
  const tables = term && state.schema ? rankedSearch(term).slice(0, 8) : [];
  host.replaceChildren(...(tables.length ? [el('p', 'quick-group', 'الجداول')] : []), ...tables.map(table => {
    const command = uiButton('', () => { $('quickActionsDialog').close(); locateTable(table.id); }, 'quick-command table-command');
    const name = el('span', 'quick-table-name', table.name); name.dir = 'ltr';
    command.append(icon('table'), name, el('small', '', `${table.schema} · ${columnsLabel(table.columns.length)}`));
    return command;
  }));
}

function installEvents() {
  initOverlays();
  for (const [id, name] of Object.entries(DIALOG_ICONS)) { const header = $(id)?.querySelector('.modal-header'); if (header) headerIcon(header, name); }
  document.fonts?.ready.then(scheduleFitChrome);
  const viewport = $('viewport');
  $('relationshipDialog').addEventListener('close', () => { state.selectedRelation = null; updateEmphasis(); });
  for (const [trigger, menu] of [['toolsButton', 'toolsMenu'], ['aiMenuButton', 'aiMenu'], ['topicSwitchButton', 'topics']]) {
    $(trigger).addEventListener('click', () => {
      const open = $(menu).hidden; closeHeaderMenus(); closeWorkspaceMenu();
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
  $('aiProviderChip').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('arrangeSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('saveAiSettingsButton').addEventListener('click', () => { updateAiSettings({ save: true }); $('aiSettingsDialog').close(); });
  $('codeSourceButton').addEventListener('click', openCodeDialog); $('topicAnalysisButton').addEventListener('click', openCodeDialog);
  $('selectionModeButton').addEventListener('click', () => {
    state.linkMode = false; state.linkSource = null;
    $('selectionModeButton').setAttribute('aria-pressed', 'true'); renderNodes(); showToast('اختر جدولًا أو علاقة لعرض التفاصيل');
  });
  $('quickActionsButton').addEventListener('click', openQuickActions);
  $('lintButton').addEventListener('click', openLint);
  $('exportButton').addEventListener('click', () => openExport());
  $('themeButton').addEventListener('click', cycleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentTheme() === 'auto') applyTheme('auto'); });
  $('quickSearch').addEventListener('input', event => filterQuickActions(event.target.value));
  const visibleCommands = () => [...$('quickActionList').querySelectorAll('.quick-command')].filter(item => !item.hidden);
  $('quickSearch').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); visibleCommands()[0]?.click(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); visibleCommands()[0]?.focus(); }
  });
  $('quickActionList').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const items = visibleCommands(), index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowUp' && index <= 0) $('quickSearch').focus();
    else items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
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
  $('exportWorkspaceButton').addEventListener('click', exportWorkspace);
  $('importWorkspaceButton').addEventListener('click', importWorkspace);
  $('deleteWorkspaceButton').addEventListener('click', deleteWorkspace);
  $('envConnectionButton').addEventListener('click', async () => {
    $('connectError').hidden = true;
    try {
      const response = await fetch('/api/code/env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceRoot: activeWorkspace()?.sourceRoot || defaultSourceRoot }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'تعذّرت القراءة من .env');
      const form = $('connectForm');
      for (const key of ['host', 'port', 'database', 'user']) form.elements.namedItem(key).value = data[key];
      form.elements.namedItem('password').focus();
      showToast('عُبّئت البيانات من .env. أدخل كلمة المرور.');
    } catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
  });
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
  $('viewTabs').addEventListener('click', event => { const view = event.target.closest('.seg')?.dataset.view; if (view) setViewMode(view); });
  $('linkModeButton').addEventListener('click', () => {
    openEditor('addRelation');
  });
  $('changesButton').addEventListener('click', () => openDialog($('changesPanel')));
  $('closeChanges').addEventListener('click', () => $('changesPanel').close());
  $('undoButton').addEventListener('click', () => stepDraft(-1));
  $('undoQuick').addEventListener('click', () => stepDraft(-1));
  $('redoQuick').addEventListener('click', () => stepDraft(1));
  $('helpButton').addEventListener('click', openShortcuts);
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
      case 'addRelation': operation = { type: 'addRelation', relation: { id: `draft:${crypto.randomUUID()}`, name: `${(state.schema.tables.find(item => item.id === value('source'))?.name || 'table')}_${value('sourceColumn')}_foreign`, source: value('source'), target: value('target'), pairs: [{ source: value('sourceColumn'), target: value('targetColumn') }], onDelete: value('onDelete') || 'a' } }; break;
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
    state.customGroups = null; store.removeItem(topicKey()); buildGroups();
    refreshTopics(); renderTopicEditor(); showToast('تمت استعادة التقسيم التلقائي');
  });
  $('topicAiSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('aiButton').addEventListener('click', openAiConversation);
  $('aiArrangeButton').addEventListener('click', () => openArrangement('ai'));
  $('closeAiDialog').addEventListener('click', () => $('aiDialog').close());
  $('clearAiButton').addEventListener('click', () => {
    if (state.aiController || !state.aiMessages.length) return;
    state.aiMessages = []; saveAiMessages(); renderAiMessages(); $('aiQuestion').focus();
  });
  const defaultModels = { 'codex-cli': '', 'claude-cli': '', openai: 'gpt-5-mini', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-2.5-flash', compatible: 'llama3.2' };
  try {
    const settings = JSON.parse(store.getItem('eratlas.ai.settings.v1') || 'null');
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
    updateAiSettings({ save: true }); if (isLocalProvider()) loadLocalAiStatus();
  });
  $('aiModel').addEventListener('change', () => updateAiSettings({ save: true }));
  $('aiEndpoint').addEventListener('change', () => updateAiSettings({ save: true }));
  $('aiForm').addEventListener('submit', event => { event.preventDefault(); sendAiQuestion(); });
  $('aiQuestion').addEventListener('input', autosizeComposer);
  $('aiQuestion').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.aiController) sendAiQuestion(); }
  });
  $('aiScopeChip').addEventListener('click', () => {
    state.aiWide = !state.aiWide; updateAiSettings();
    if (!state.aiMessages.length && !state.aiController) renderAiMessages();
  });
  $('aiKey').addEventListener('input', () => updateAiSettings());
  $('aiEndpoint').addEventListener('input', () => updateAiSettings());
  $('recheckAiButton').addEventListener('click', async event => {
    const trigger = event.currentTarget; trigger.disabled = true; trigger.textContent = 'أفحص…';
    await loadLocalAiStatus(); trigger.disabled = false; trigger.textContent = 'إعادة الفحص';
  });
  $('testAiButton').addEventListener('click', testAiConnection);
  $('aiSettingsDialog').addEventListener('close', () => { updateAiSettings({ save: true }); if ($('aiDialog').open && !state.aiController) renderAiMessages(); });
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
      $('handoffResult').replaceChildren(...answerNodes(await askAi('migration', state.handoffPrompt)));
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
      const point = { x: snap4(drag.originX + dx / state.scale), y: snap4(drag.originY + dy / state.scale) };
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
        if (state.viewMode === 'topics') store.setItem(`${storageKey()}.topicLayout.${state.topic}`, JSON.stringify(Object.fromEntries(state.topicPositions)));
        if (state.viewMode === 'focus') store.setItem(`${storageKey()}.focusLayout.${state.focusTable}`, JSON.stringify(Object.fromEntries(state.focusPositions)));
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
    event.preventDefault();
    // Pinch gestures arrive with ctrlKey; a mouse wheel reports whole, large steps. Anything else is a trackpad scroll.
    const mouseWheel = event.deltaMode !== 0 || (event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50);
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * .01), event.clientX, event.clientY);
    else if (mouseWheel && !event.shiftKey) zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
    else if (event.shiftKey && !event.deltaX) { state.x -= event.deltaY; transform(); }
    else { state.x -= event.deltaX; state.y -= event.deltaY; transform(); }
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
  $('searchInput').addEventListener('input', () => { state.searchIndex = -1; updateEmphasis(); updateSearchCount(); });
  $('searchToggleButton').addEventListener('click', () => setNavbarSearch($('searchToggleButton').getAttribute('aria-expanded') !== 'true', { focus: true }));
  $('searchInput').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.currentTarget.value) { event.preventDefault(); event.stopPropagation(); event.currentTarget.value = ''; state.searchIndex = -1; updateEmphasis(); updateSearchCount(); return; }
    if (event.key !== 'Enter') return;
    // Enter walks the matches, Shift+Enter walks back; best name matches come first.
    const matches = rankedSearch(event.currentTarget.value.trim().toLowerCase()); if (!matches.length) return;
    state.searchIndex = ((state.searchIndex ?? -1) + (event.shiftKey ? -1 : 1) + matches.length) % matches.length;
    locateTable(matches[state.searchIndex].id); updateSearchCount(); event.currentTarget.focus();
  });
  window.addEventListener('keydown', event => {
    const editing = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); openQuickActions(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (!editing && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); stepDraft(event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1); return;
    }
    if (!editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const rect = viewport.getBoundingClientRect(), step = event.shiftKey ? 240 : 80;
      const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
      if (pan && !document.activeElement?.closest?.('.table-node,button,[role="menuitem"],.header-menu')) { event.preventDefault(); state.x += pan[0]; state.y += pan[1]; transform(); return; }
      if (['+', '='].includes(event.key)) { zoom(1.2, rect.left + rect.width / 2, rect.top + rect.height / 2); return; }
      if (['-', '_'].includes(event.key)) { zoom(1 / 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2); return; }
      if (event.key === '0') { fitView(state.topic !== 'all'); return; }
      const tool = { v: 'selectionModeButton', t: 'addTableButton', r: 'linkModeButton', a: 'arrangeButton' }[event.key.toLowerCase()];
      if (tool && !$(tool).hidden && !$(tool).disabled) { event.preventDefault(); $(tool).click(); return; }
      if (event.key === '?') { event.preventDefault(); openShortcuts(); return; }
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); openLint(); return; }
      if (event.key.toLowerCase() === 'e') { event.preventDefault(); openExport(); return; }
      if (event.key.toLowerCase() === 'd') { event.preventDefault(); openDialog($('changesPanel')); return; }
      if (event.key.toLowerCase() === 'f') { fitView(state.topic !== 'all', { overview: true }); return; }
    }
    if (event.key === 'Escape' && (!$('toolsMenu').hidden || !$('aiMenu').hidden || !$('topics').hidden)) { closeHeaderMenus(); return; }
    if (event.key === 'Escape' && !$('workspaceMenu').hidden) { closeWorkspaceMenu({ focus: true }); return; }
    if (event.key === '/' && !editing) { event.preventDefault(); setNavbarSearch(true, { focus: true }); }
    if (event.key === 'Escape' && document.querySelector('.chrome.d1.search-open')) { event.preventDefault(); setNavbarSearch(false, { focus: true }); return; }
    if (event.key === 'Escape' && !$('connectDialog').open) { closeContextMenu(); state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis(); }
  });
  let previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight };
  window.addEventListener('resize', () => {
    scheduleFitChrome();
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

// Workspaces created by earlier versions had their topics hard-coded in the app;
// copy them into the saved topics once so removing that code loses nothing.
async function migrateLegacySufra() {
  const key = `eratlas.v4.ws.${LEGACY_SUFRA_ID}.topics`;
  if (!state.workspaces.some(item => item.id === LEGACY_SUFRA_ID) || store.getItem(key)) return;
  try {
    const sample = parseExport(await (await fetch('/samples/sufra-products.eratlas.json')).text());
    store.setItem(key, JSON.stringify(sample.topics));
  } catch { /* topics fall back to automatic grouping */ }
}
function sameConnection(saved, live) {
  if (!live) return false;
  return saved?.source && live.source ? saved.source === live.source : saved?.database === live.database;
}

async function bootstrap() {
  await initStore();
  applyTheme(currentTheme());
  installEvents();
  let serverSchema = null;
  try {
    const response = await fetch('/api/schema');
    if (response.ok) { const data = await response.json(); if (data.tables) serverSchema = data; }
  } catch { /* app can still open in demo mode */ }
  let registry;
  try { registry = JSON.parse(store.getItem(WORKSPACES_KEY) || 'null'); } catch { registry = null; }
  if (Array.isArray(registry?.items) && registry.items.length) {
    state.workspaces = registry.items.filter(item => item?.id && item?.name && ['database', 'demo', 'ideas'].includes(item.kind));
    if (state.workspaces.length) {
      await migrateLegacySufra();
      const requestedId = location.hash.slice(1);
      const active = state.workspaces.find(item => item.id === requestedId)
        || state.workspaces.find(item => item.id === registry.activeId)
        || state.workspaces[0];
      const live = active.kind === 'database' && sameConnection(active.schema, serverSchema);
      if (live) active.schema = serverSchema;
      else if (serverSchema) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
      await activateWorkspace(active.id, { initial: true, live });
      return;
    }
  }
  const first = serverSchema || sampleSchema();
  state.workspaces = [{ id: 'legacy', name: serverSchema ? first.database : 'التجربة', kind: serverSchema ? 'database' : 'demo', schema: first, topic: 'all', connection: null }];
  await activateWorkspace('legacy', { initial: true, live: Boolean(serverSchema) });
  if (!serverSchema && !sessionStorage.getItem('eratlas.seen')) {
    sessionStorage.setItem('eratlas.seen', '1');
    setTimeout(openConnectionDialog, 450);
  }
}

bootstrap();
