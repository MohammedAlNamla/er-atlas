// Column notes and the column lists in the inspector that show and edit them.
import { store } from './storage.js';
import { button as uiButton } from './ui.js';
import { $, state, storageKey, el } from './core.js';
import { sourceEvidence, renderDetails } from './inspector.js';
import { openEditor } from './editor.js';
import { askAi } from './ai.js';
// Column notes. A comment in the database always wins; then what you wrote; then what AI explained.
const NOTE_BASIS = { db: 'من قاعدة البيانات', documented: 'من التعليق أو الكود', schema: 'من بنية المخطط', name: 'تخمين من الاسم', user: 'كتبته أنت' };
export function readColumnNotesStore() {
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
export function columnTitle(table, column) {
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
export function columnList(table, { expanded = false, query = '', refresh = refreshColumnViews } = {}) {
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
export function columnNotesBar(table) {
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
    if (skipped.length) state.columnError = `لم يشرح AI ${skipped.length} عمودًا: ${skipped.slice(0, 3).map(name => `⁦${name}\u2069`).join('، ')}${skipped.length > 3 ? '…' : ''}. أعد الشرح أو اكتبه بنفسك.`;
  } catch (error) { if (workspaceId === state.workspaceId && error.name !== 'AbortError') state.columnError = error.message; }
  finally {
    if (state.columnController === controller) { state.columnController = null; state.columnBusy = null; }
    if (workspaceId === state.workspaceId) refreshColumnViews();
  }
}
