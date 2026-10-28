// Connecting to PostgreSQL or MySQL/MariaDB and browsing the databases on a server.
import { $, state, activeWorkspace, saveWorkspaces, sprite, el, showToast } from './core.js';
import { renderWorkspaces, sampleSchema, setSchema } from './workspaces.js';
import { defaultSourceRoot } from './groups.js';
// ---- Database browser: list what this login can open on the server, pick one, connect.
function connectPayload() {
  const form = new FormData($('connectForm')), payload = Object.fromEntries(form.entries());
  payload.ssl = form.has('ssl'); return payload;
}
// The engine tab decides the driver; a port or user still at the other engine's default follows it.
const ENGINE_DEFAULTS = { postgres: { port: '5432', user: 'postgres' }, mysql: { port: '3306', user: 'root' } };
export function setConnectEngine(engine) {
  const next = engine === 'mysql' ? 'mysql' : 'postgres', form = $('connectForm'), field = name => form.elements.namedItem(name);
  const previous = field('engine').value === 'mysql' ? 'mysql' : 'postgres';
  field('engine').value = next;
  for (const tab of $('engineTabs').querySelectorAll('[data-engine]')) {
    const active = tab.dataset.engine === next;
    tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  }
  if (previous !== next && (!field('port').value || field('port').value === ENGINE_DEFAULTS[previous].port)) field('port').value = ENGINE_DEFAULTS[next].port;
  field('user').placeholder = ENGINE_DEFAULTS[next].user;
  if (previous !== next) resetDatabaseList();
}
export function bindEngineTabs() {
  const tabs = $('engineTabs');
  tabs.addEventListener('click', event => { const tab = event.target.closest('[data-engine]'); if (tab) setConnectEngine(tab.dataset.engine); });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = $('connectForm').elements.namedItem('engine').value === 'mysql' ? 'postgres' : 'mysql';
    setConnectEngine(event.key === 'Home' ? 'postgres' : event.key === 'End' ? 'mysql' : next);
    tabs.querySelector('[aria-selected="true"]').focus();
  });
}
const formatBytes = bytes => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(bytes < 1024 ** 2 * 10 ? 1 : 0)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export function resetDatabaseList(hint = 'أدخل المستخدم وكلمة المرور، ثم «استعرض» لاختيار قاعدة من الخادم.') {
  state.databases = null; state.databaseFilter = '';
  $('databaseList').hidden = true; $('databaseList').replaceChildren(); $('databaseHint').textContent = hint;
}
export function renderDatabaseList() {
  const list = $('databaseList'), current = $('connectDatabase').value.trim(), filter = (state.databaseFilter || '').toLowerCase();
  list.replaceChildren(); list.hidden = !state.databases?.length; if (list.hidden) return;
  const shown = state.databases.filter(item => !filter || item.name.toLowerCase().includes(filter));
  for (const item of shown) {
    const option = el('button', 'database-option'); option.type = 'button'; option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(item.name === current)); option.disabled = !item.canConnect;
    const name = el('span', 'database-name', item.name); name.dir = 'ltr';
    const meta = [item.size != null ? `\u2068${formatBytes(item.size)}\u2069` : '', item.owner && `المالك ${item.owner}`, !item.canConnect && 'لا صلاحية اتصال'].filter(Boolean).join(' · ');
    option.append(sprite('database', 'i i-small'), name, el('span', 'database-meta', meta));
    if (item.description) option.title = item.description;
    option.addEventListener('click', () => {
      // A second click on the chosen database connects straight away.
      if ($('connectDatabase').value.trim() === item.name) { $('connectForm').requestSubmit(); return; }
      $('connectDatabase').value = item.name; state.databaseFilter = ''; renderDatabaseList();
      $('databaseHint').textContent = `اخترت ${item.name}. اضغط «اتصال وعرض الخريطة» أو انقرها مرة أخرى.`;
      list.querySelector('[aria-selected="true"]')?.focus();
    });
    list.append(option);
  }
  if (!shown.length) list.append(el('p', 'database-empty', 'لا توجد قاعدة بهذا الاسم على الخادم. يمكنك الاتصال بالاسم المكتوب مباشرة.'));
}
export async function browseDatabases() {
  const payload = connectPayload(), button = $('browseDatabasesButton'), label = button.querySelector('span');
  $('connectError').hidden = true;
  if (!payload.user.trim()) { $('connectForm').elements.namedItem('user').focus(); $('connectError').textContent = 'أدخل اسم المستخدم أولًا لعرض قواعد البيانات.'; $('connectError').hidden = false; return; }
  button.disabled = true; label.textContent = 'جارٍ القراءة…';
  try {
    const response = await fetch('/api/databases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذّر عرض قواعد البيانات');
    state.databases = data.databases; state.databaseFilter = ''; renderDatabaseList();
    const open = data.databases.filter(item => item.canConnect).length;
    $('databaseHint').textContent = data.databases.length ? `${data.databases.length} قاعدة على ${payload.host}:${payload.port}${open < data.databases.length ? `، ${open} منها متاحة لهذا المستخدم` : ''}. اختر واحدة.` : 'لا توجد قواعد يمكن فتحها بهذا المستخدم.';
    ($('databaseList').querySelector('[aria-selected="true"]') || $('databaseList').querySelector('.database-option:not(:disabled)'))?.focus();
  } catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
  finally { button.disabled = false; label.textContent = state.databases ? 'تحديث القائمة' : 'استعرض'; }
}
export function openConnectionDialog() {
  resetDatabaseList();
  $('browseDatabasesButton').querySelector('span').textContent = 'استعرض';
  const settings = activeWorkspace()?.connection;
  setConnectEngine(settings?.engine || 'postgres');
  if (settings) {
    const form = $('connectForm');
    for (const key of ['host', 'port', 'database', 'user']) if (settings[key] != null) form.elements.namedItem(key).value = settings[key];
    form.elements.namedItem('ssl').checked = Boolean(settings.ssl);
  }
  $('connectForm').elements.namedItem('password').value = '';
  $('connectError').hidden = true;
  $('connectDialog').showModal();
}
export async function fillFromEnv() {
  $('connectError').hidden = true;
  try {
    const response = await fetch('/api/code/env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceRoot: activeWorkspace()?.sourceRoot || defaultSourceRoot }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذّرت القراءة من .env');
    const form = $('connectForm');
    setConnectEngine(data.engine);
    for (const key of ['host', 'port', 'database', 'user']) form.elements.namedItem(key).value = data[key];
    form.elements.namedItem('password').focus();
    showToast('عُبّئت البيانات من .env. أدخل كلمة المرور.');
  } catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
}
export async function openDemo() {
  if (state.connectionLive) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
  const workspace = activeWorkspace(); workspace.kind = 'demo'; workspace.connection = null;
  state.connectionLive = false;
  setSchema(sampleSchema(), true); $('connectDialog').close(); showToast('تم فتح الخريطة النموذجية');
  saveWorkspaces(); renderWorkspaces();
}
export async function refreshSchema() {
  if (!state.connectionLive) { openConnectionDialog(); showToast('أعد الاتصال لتحديث المخطط من قاعدة البيانات'); return; }
  try {
    const response = await fetch('/api/schema'); const data = await response.json();
    if (!response.ok || !data.tables) throw new Error(data.error || 'لا يوجد اتصال حالي');
    setSchema(data, false); saveWorkspaces(); showToast('تم تحديث الخريطة');
  } catch (error) { showToast(error.message); }
}
export async function submitConnection(event) {
  event.preventDefault(); $('connectError').hidden = true;
  if (!$('connectDatabase').value.trim()) { browseDatabases(); return; }
  const button = $('submitConnection'); button.disabled = true; button.firstChild.textContent = 'جارٍ الاتصال... ';
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries()); payload.ssl = form.has('ssl');
  try {
    const response = await fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذّر الاتصال');
    const workspace = activeWorkspace(); workspace.kind = 'database';
    workspace.connection = { engine: payload.engine === 'mysql' ? 'mysql' : 'postgres', host: payload.host, port: payload.port, database: payload.database, user: payload.user, ssl: payload.ssl };
    state.connectionLive = true;
    setSchema(result, false); saveWorkspaces(); renderWorkspaces(); $('connectDialog').close(); showToast(`تم قراءة ${result.tables.length} جدولًا`);
  } catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
  finally { button.disabled = false; button.textContent = 'اتصال وعرض الخريطة'; }
}
