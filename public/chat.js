// The AI conversation.
import { store } from './storage.js';
import { button as uiButton, codeBlock, openDialog } from './ui.js';
import { $, state, activeWorkspace, SVG_NS, sprite, storageKey, el, copyText, showToast } from './core.js';
import { closeHeaderMenus } from './chrome.js';
import { visibleTables, visibleRelations } from './layout.js';
import { providerShort, providerState, updateAiSettings, askAi } from './ai.js';
// What a question will actually send: the selection wins, then the open topic or focus, then everything.
export function aiScope(wide = state.aiWide) {
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
export function answerNodes(text) {
  return String(text).split(/```(?:[^\n]*)\n?([\s\S]*?)```/g).flatMap((part, index) => !part.trim() ? []
    : [index % 2 ? codeBlock(part.trim(), /\b(?:CREATE|ALTER|SELECT|INSERT|UPDATE|DELETE|BEGIN|DROP|COMMENT)\b/i.test(part) ? 'SQL' : 'AI') : richText(part.trim())]);
}
// ---- Chat: a dialogue, not a report. The thread keeps turns; the composer stays pinned.
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
export function renderAiMessages() {
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
export function autosizeComposer() {
  const input = $('aiQuestion'); input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
  $('askAiButton').disabled = !input.value.trim();
}
function setComposerBusy(busy) { $('askAiButton').hidden = busy; $('stopAiButton').hidden = !busy; }
export async function sendAiQuestion(raw) {
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
export function saveAiMessages() { store.setItem(`${storageKey()}.conversation`, JSON.stringify(state.aiMessages)); }
export function openAiConversation() {
  closeHeaderMenus(); updateAiSettings(); renderAiMessages(); openDialog($('aiDialog')); autosizeComposer(); $('aiQuestion').focus();
}
