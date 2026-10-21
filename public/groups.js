// Topics: automatic grouping, the topic editor, AI suggestions and the code source behind them.
import { store } from './storage.js';
import { parseTopicSuggestions as readTopicSuggestions, topicColors } from './topics.js';
import { button as uiButton, notice, codeBlock, dataTable, modalHeader, modalFooter, openDialog } from './ui.js';
import { $, state, activeWorkspace, saveWorkspaces, storageKey, el, headerIcon, confirmAction, showToast } from './core.js';
import { closeHeaderMenus } from './chrome.js';
import { renderTopics, renderView, updateViewCounts } from './views.js';
import { buildTopicPositions } from './layout.js';
import { renderNodes } from './canvas.js';
import { sourceEvidence } from './inspector.js';
import { updateAiSettings, askAi } from './ai.js';
const groupDefinitions = [
  { id: 'inventory', label: 'المخزون', color: '#6551C7', test: /product|stock|inventor|warehouse|location|batch|category|categor|variant|sku|مخزون|منتج|مستودع/i },
  { id: 'orders', label: 'الطلبات والمبيعات', color: '#C67966', test: /order|sale|cart|checkout|customer|client|invoice|payment|refund|طلب|عميل|فاتورة|دفع/i },
  { id: 'purchases', label: 'المشتريات والموردون', color: '#A38BCD', test: /purchase|supplier|vendor|shipment|receiv|procure|مورد|شراء|توريد/i },
  { id: 'access', label: 'المستخدمون والصلاحيات', color: '#7864C8', test: /user|role|permission|auth|session|account|profile|team|member|مستخدم|صلاحية/i },
  { id: 'messages', label: 'الرسائل والإشعارات', color: '#C98A9B', test: /message|notification|email|sms|alert|رسالة|إشعار/i }
];
function topicIds(table) {
  const name = `${table.schema} ${table.name}`;
  const matches = groupDefinitions.filter(group => group.test.test(name)).map(group => group.id);
  return matches.length ? matches : ['other'];
}

export function buildGroups() {
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

export function groupForTable(table) {
  return state.groups.find(group => group.id !== 'all' && group.ids.has(table.id)) || state.groups[0];
}
export function topicKey() { return `${storageKey()}.topics`; }
function saveTopics() {
  state.customGroups = state.groups.slice(1).map(group => ({ id: group.id, label: group.label, color: group.color, ids: [...group.ids],
    ...(group.reason ? { reason: group.reason } : {}), ...(group.moduleIds ? { moduleIds: group.moduleIds } : {}), ...(group.evidence ? { evidence: group.evidence } : {}) }));
  store.setItem(topicKey(), JSON.stringify(state.customGroups));
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
export function renderTopicEditor() {
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
export function refreshTopics() {
  saveTopics(); buildTopicPositions(); renderTopics(); renderView(); renderNodes(); updateViewCounts();
  for (const member of $('topicEditor').querySelectorAll('.topic-member')) {
    const shared = state.groups.slice(1).filter(group => group.ids.has(member.dataset.tableId)).length > 1;
    const badge = member.querySelector('.topic-shared-label');
    if (shared && !badge) member.append(el('small', 'topic-shared-label', 'مشترك'));
    else if (!shared) badge?.remove();
    member.title = shared ? 'يظهر هذا الجدول في أكثر من موضوع' : '';
  }
}
export let defaultSourceRoot = '';
export function syncCodeSource() {
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
export function saveCodeSource() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const path = $('topicSourceRoot').value.trim();
  if (workspace.sourceRoot !== path) { workspace.sourceRoot = path; delete workspace.codeAnalysis; }
  saveWorkspaces();
}
export async function loadCodeSettings() {
  try {
    const response = await fetch('/api/code/settings');
    if (!response.ok) throw new Error();
    defaultSourceRoot = (await response.json()).defaultSourceRoot || '';
    syncCodeSource();
  } catch { $('topicSourceSummary').textContent = 'تعذّر تحميل مسار الكود. أدخله يدويًا ثم اضغط «تحليل الكود».'; }
}
export async function analyzeTopicCode() {
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
function parseTopicSuggestions(answer) {
  return readTopicSuggestions(answer, state.schema.tables.map(table => table.id)).map(group => ({ ...group, ids: new Set(group.ids) }));
}
export function openCodeDialog() {
  closeHeaderMenus(); syncCodeSource(); updateAiSettings(); openDialog($('codeDialog'));
}
export async function suggestTopics() {
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
}
