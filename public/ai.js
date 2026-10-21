// Connecting an assistant and asking it.
import { store } from './storage.js';
import { button as uiButton } from './ui.js';
import { $, state, sprite, el, copyText, showToast } from './core.js';
import { aiScope, renderAiMessages } from './chat.js';
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
export function providerShort(id = $('aiProvider').value) { return [...LOCAL_PROVIDERS, ...API_PROVIDERS].find(item => item.id === id)?.name || id; }
// tone: ok (ready), warn (one step left), bad (cannot work yet), idle (still checking)
export function providerState(id = $('aiProvider').value) {
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
export function updateAiSettings({ save = false } = {}) {
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
export async function loadLocalAiStatus() {
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
export async function testAiConnection() {
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
export async function askAi(mode, question, schema = state.schema, signal, { focus, evidence } = {}) {
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
export function providerLabel() {
  return { 'codex-cli': 'Codex على الجهاز', 'claude-cli': 'Claude Code على الجهاز', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', compatible: 'خدمة متوافقة' }[$('aiProvider').value] || 'Codex على الجهاز';
}
const defaultModels = { 'codex-cli': '', 'claude-cli': '', openai: 'gpt-5-mini', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-2.5-flash', compatible: 'llama3.2' };
export function restoreAiSettings() {
  try {
    const settings = JSON.parse(store.getItem('eratlas.ai.settings.v1') || 'null');
    if (settings && Object.hasOwn(defaultModels, settings.provider)) {
      $('aiProvider').value = settings.provider; $('aiModel').value = typeof settings.model === 'string' ? settings.model : defaultModels[settings.provider];
      $('aiEndpoint').value = typeof settings.endpoint === 'string' ? settings.endpoint : '';
    }
  } catch {}
}
export function changeProvider() {
  $('aiModel').value = defaultModels[$('aiProvider').value];
  $('aiEndpointWrap').hidden = $('aiProvider').value !== 'compatible';
  if ($('aiProvider').value === 'compatible' && !$('aiEndpoint').value) $('aiEndpoint').value = 'http://127.0.0.1:11434/v1';
  updateAiSettings({ save: true }); if (isLocalProvider()) loadLocalAiStatus();
}
