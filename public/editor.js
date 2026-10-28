// The draft: staging, undo and redo, the change editor, the context menu, the AI handoff.
import { applyOperation, replay, describeOperation } from './model.js';
import { store } from './storage.js';
import { icon, button as uiButton, notice, openDialog } from './ui.js';
import { $, state, sprite, storageKey, el, headerIcon, confirmAction, showToast, engineOf, engineLabel } from './core.js';
import { renderEmptyWorkspace } from './workspaces.js';
import { renderTopics, renderView, updateViewCounts, locateTable } from './views.js';
import { buildFocusPositions, buildTopicPositions, layoutTables, savePositions, arrangeTables } from './layout.js';
import { renderNodes, fitView, selectTable, selectRelation } from './canvas.js';
import { renderDetails, openExpandedTable, confirmDropTable } from './inspector.js';
import { buildGroups } from './groups.js';
import { answerNodes } from './chat.js';
import { askAi } from './ai.js';
import { updateLintCount, renderLint } from './sheets.js';
function svgIcon(name) { return icon(name); }
function actionButton(label, handler, extra = '', iconName = '') {
  const button = el('button', `inline-action ${extra}`);
  if (iconName) button.append(svgIcon(iconName));
  const caption = el('span', '', label); button.append(caption);
  if (extra.includes('icon-only')) { button.title = label; button.setAttribute('aria-label', label); caption.className = 'sr-only'; }
  button.type = 'button'; button.addEventListener('click', handler);
  return button;
}
export function closeContextMenu() { $('contextMenu').hidden = true; }
function beginLink(tableId, columnName = null) {
  state.linkMode = false; state.linkSource = null;
  openEditor('addRelation', { source: tableId, sourceColumn: columnName });
}
export function showContextMenu(event) {
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
    item('فهرس على هذا العمود', 'search', () => openEditor('addIndex', { tableId, columns: [column.name] }));
    item('إضافة طلب حذف للمسودة', 'trash', () => stage({ type: 'dropColumn', tableId, columnName: column.name }), true);
  } else if (table) {
    item('عرض التفاصيل', 'inspect', () => selectTable(tableId));
    item('تغيير اسم الجدول', 'edit', () => openEditor('renameTable', { tableId }));
    item('إضافة عمود', 'plus', () => openEditor('addColumn', { tableId }));
    item('إنشاء علاقة', 'link', () => beginLink(tableId));
    item('إضافة فهرس', 'search', () => openEditor('addIndex', { tableId }));
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
export function draftKey() { return `${storageKey()}.draft${state.workspaceId !== 'legacy' && state.base.fingerprint ? `.${state.base.fingerprint}` : ''}`; }
export function saveDraft() { store.setItem(draftKey(), JSON.stringify({ operations: state.operations, cursor: state.cursor })); }
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
export const isDraftTable = table => Boolean(state.draftMarks?.has('tables', table.id));
export const isDraftRelation = relation => Boolean(state.draftMarks?.has('relations', relation.id));
export const isDraftColumn = (table, column) => Boolean(state.draftMarks?.has('columns', table.id, column.name));
export function refreshDraft({ fit = false } = {}) {
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
export function stage(operation) {
  try {
    applyOperation(state.schema, operation);
    state.operations = state.operations.slice(0, state.cursor);
    state.operations.push(operation); state.cursor++;
    saveDraft(); if (operation.type === 'addTable') savePositions(); refreshDraft(); showToast('أضيف التغيير إلى المسودة');
  } catch (error) { showToast(error.message); throw error; }
}
export function stepDraft(delta) {
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
export function openEditor(kind, context = {}) {
  state.editContext = { kind, ...context };
  const fields = $('editFields'); fields.replaceChildren(); $('editError').hidden = true;
  const table = state.schema.tables.find(t => t.id === context.tableId);
  const column = table?.columns.find(c => c.name === context.columnName);
  const titles = { addTable: 'جدول جديد', renameTable: 'تغيير اسم الجدول', addColumn: 'إضافة عمود', editColumn: 'تعديل العمود', addRelation: 'إضافة علاقة', addIndex: 'إضافة فهرس' };
  $('editTitle').textContent = titles[kind];
  headerIcon($('editTitle').parentElement, { addTable: 'table', renameTable: 'edit', addColumn: 'plus', editColumn: 'edit', addRelation: 'relation', addIndex: 'search' }[kind]);
  $('editDescription').textContent = kind === 'addTable' ? 'أضف تعريف الجدول إلى المسودة ثم جهّز أعمدته.' : kind === 'renameTable' ? 'سيبقى الجدول مرتبطًا بمواضيعه وعلاقاته.' : kind === 'addRelation' ? 'عمود المفتاح الأجنبي يشير إلى عمود المفتاح الأساسي في الجدول الهدف.' : kind === 'addIndex' ? `فهرس يسرّع البحث والترتيب في ${table.name}. ترتيب الأعمدة مهم: يخدم الفهرس أول عمود فيه وحده أيضًا.` : `تعديل أعمدة ${table.name} ضمن المسودة.`;
  $('editDialog').style.setProperty('--modal-width', `${kind === 'addRelation' ? 560 : kind === 'renameTable' ? 440 : 520}px`);
  // On MySQL the schema is the database itself, so a new table starts there rather than in public.
  const mysql = engineOf(state.schema) === 'mysql';
  if (kind === 'addTable') fields.append(field('name', 'اسم الجدول', '', 'text', { required: true }), field('schema', mysql ? 'قاعدة البيانات' : 'Schema', mysql ? state.schema.tables[0]?.schema || state.schema.database : 'public', 'text', { required: true }));
  if (kind === 'renameTable') {
    const current = field('currentName', 'الاسم الحالي', table.name); current.classList.add('full'); current.querySelector('input').disabled = true;
    const name = field('name', 'الاسم الجديد', table.name, 'text', { required: true }); name.classList.add('full'); fields.append(current, name);
  }
  if (kind === 'addColumn' || kind === 'editColumn') {
    const defaultField = field('default', 'القيمة الافتراضية · SQL', column?.default || '', 'text', { placeholder: mysql ? "مثال: CURRENT_TIMESTAMP أو 'active'" : "مثال: now() أو 'active'" }); defaultField.classList.add('full');
    defaultField.append(el('p', 'field-hint', 'اتركه فارغًا إن لم توجد قيمة افتراضية.'));
    fields.append(field('type', `النوع ${engineLabel(state.schema)}`, column?.type || (mysql ? 'varchar(255)' : 'text'), 'text', { required: true }), field('name', 'اسم العمود', column?.name || '', 'text', { required: true }), defaultField, field('nullable', 'يسمح بقيمة فارغة', column?.nullable ?? true, 'checkbox'));
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
  if (kind === 'addIndex') {
    // Columns are taken in the order you tick them: the first one leads the index.
    const chosen = [...(context.columns || [])], list = el('div', 'index-columns full'), order = el('p', 'field-hint full'), big = (table.approxRows || 0) >= 100000;
    const nameField = field('name', 'اسم الفهرس', '', 'text', { required: true }); nameField.classList.add('full');
    const nameInput = nameField.querySelector('input'); let nameEdited = false;
    nameInput.addEventListener('input', () => { nameEdited = true; });
    const sync = () => {
      if (!nameEdited) nameInput.value = chosen.length ? `${table.name}_${chosen.join('_')}_${fields.querySelector('[name="unique"]')?.checked ? 'unique' : 'index'}` : '';
      order.textContent = chosen.length ? `الترتيب: ${chosen.join('، ')}` : 'اختر عمودًا واحدًا على الأقل؛ ترتيب اختيارك هو ترتيب الفهرس.';
      for (const box of list.querySelectorAll('input')) box.closest('.index-column').dataset.order = chosen.includes(box.value) ? String(chosen.indexOf(box.value) + 1) : '';
    };
    for (const item of table.columns) {
      const label = el('label', 'choice index-column'), box = el('input'), copy = el('span'), name = el('strong', '', item.name); name.dir = 'ltr';
      box.type = 'checkbox'; box.value = item.name; box.checked = chosen.includes(item.name);
      box.addEventListener('change', () => { if (box.checked) chosen.push(item.name); else chosen.splice(chosen.indexOf(item.name), 1); sync(); });
      copy.append(name, el('small', '', `${item.type}${item.primary ? ' · PK' : item.foreign ? ' · FK' : ''}`)); label.append(box, copy); list.append(label);
    }
    const columnsField = el('input'); columnsField.type = 'hidden'; columnsField.name = 'columns';
    fields.append(el('h3', 'full', 'الأعمدة'), list, order, nameField, columnsField, field('unique', 'فهرس فريد (UNIQUE)', false, 'checkbox'), field('concurrently', mysql ? 'إنشاء دون قفل الجدول (LOCK=NONE)' : 'إنشاء دون إيقاف الكتابة (CONCURRENTLY)', big, 'checkbox'));
    fields.querySelector('[name="unique"]').closest('label').querySelector('small').textContent = 'يمنع تكرار القيمة نفسها في هذه الأعمدة.';
    fields.querySelector('[name="concurrently"]').closest('label').querySelector('small').textContent = big ? `مستحسن: في الجدول ≈ ${table.approxRows.toLocaleString('en-US')} صف، والإنشاء العادي يوقف الكتابة حتى ينتهي.` : mysql ? 'يبني الفهرس والجدول متاح للكتابة؛ مفيد للجداول الكبيرة.' : 'يُنفّذ خارج transaction؛ مفيد للجداول الكبيرة.';
    fields.querySelector('[name="unique"]').addEventListener('change', sync);
    state.indexColumns = chosen; sync();
  }
  if (kind === 'renameTable') fields.firstElementChild.classList.add('full');
  $('editSubmit').textContent = kind === 'addTable' ? 'إنشاء في المسودة' : kind === 'renameTable' ? 'حفظ الاسم' : kind === 'addRelation' || kind === 'addIndex' ? 'إضافة إلى المسودة' : 'حفظ في المسودة';
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
    if (kind === 'addTable') sql = mysql ? `CREATE TABLE ${read('schema')}.${read('name')} (\n  -- MySQL: الأعمدة التي تضيفها في المسودة تُكتب هنا\n);` : `CREATE TABLE ${read('schema')}.${read('name')} ();`;
    if (kind === 'renameTable') sql = `ALTER TABLE ${table.schema}.${table.name}\nRENAME TO ${mysql ? `${table.schema}.` : ''}${read('name')};`;
    if (kind === 'addColumn') sql = `ALTER TABLE ${table.schema}.${table.name}\nADD COLUMN ${read('name')} ${read('type')}${values.has('nullable') ? '' : ' NOT NULL'}${values.get('default') ? ` DEFAULT ${values.get('default')}` : ''}${values.has('primary') ? ' PRIMARY KEY' : ''};`;
    if (kind === 'editColumn') {
      const target = `ALTER TABLE ${table.schema}.${table.name}`;
      const statements = column.name !== read('name') ? [`${target} RENAME COLUMN ${column.name} TO ${read('name')};`] : [];
      const retyped = column.type !== read('type'), renulled = column.nullable !== values.has('nullable'), redefaulted = (column.default || '') !== String(values.get('default') || '');
      // MySQL changes type or nullability with one MODIFY that restates the whole column.
      if (mysql && (retyped || renulled)) statements.push(`${target} MODIFY COLUMN ${read('name')} ${read('type')}${values.has('nullable') ? ' NULL' : ' NOT NULL'}${values.get('default') ? ` DEFAULT ${values.get('default')}` : ''};`);
      if (!mysql && retyped) statements.push(`${target} ALTER COLUMN ${read('name')} TYPE ${read('type')};`);
      if (!mysql && renulled) statements.push(`${target} ALTER COLUMN ${read('name')} ${values.has('nullable') ? 'DROP' : 'SET'} NOT NULL;`);
      if (redefaulted && !(mysql && (retyped || renulled))) statements.push(`${target} ALTER COLUMN ${read('name')} ${values.get('default') ? `SET DEFAULT ${values.get('default')}` : 'DROP DEFAULT'};`);
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
    if (kind === 'addIndex') {
      const columns = state.indexColumns || [];
      $('editSubmit').disabled = !columns.length;
      sql = mysql
        ? `CREATE ${values.has('unique') ? 'UNIQUE ' : ''}INDEX ${read('name')}\nON ${table.schema}.${table.name} (${columns.join(', ') || '…'})${values.has('concurrently') ? ' ALGORITHM=INPLACE LOCK=NONE' : ''};`
        : `CREATE ${values.has('unique') ? 'UNIQUE ' : ''}INDEX ${values.has('concurrently') ? 'CONCURRENTLY ' : ''}${read('name')}\nON ${table.schema}.${table.name} (${columns.join(', ') || '…'});`;
    }
    $('editPreview').replaceChildren(el('div', 'code-label', 'معاينة التعريف · يُراجع SQL النهائي من المسودة'), el('pre', '', sql));
  };
  if (kind !== 'addRelation' && kind !== 'addIndex') $('editSubmit').disabled = false;
  fields.oninput = preview; fields.onchange = preview; preview();
  openDialog($('editDialog')); fields.querySelector('[name="name"]:not(:disabled),input:not(:disabled),select:not(:disabled)')?.focus();
}
export function chooseLinkColumn(tableId, columnName) {
  if (!state.linkSource) { state.linkSource = { tableId, columnName }; showToast('اختر الآن العمود الهدف'); }
  else {
    openEditor('addRelation', { source: state.linkSource.tableId, sourceColumn: state.linkSource.columnName, target: tableId, targetColumn: columnName });
    state.linkSource = null; state.linkMode = false; $('linkModeButton').setAttribute('aria-pressed', 'false');
  }
}
function buildHandoffPrompt(plan) {
  const operations = state.operations.slice(0, state.cursor);
  const summary = operations.map((operation, index) => `${index + 1}. ${describeOperation(operation, state.schema)}`).join('\n');
  const mysql = engineOf(state.base) === 'mysql';
  return `مهمة تعديل مخطط ${engineLabel(state.base)} من ER Atlas

قواعد التنفيذ:
- افحص المخطط الحالي أولًا وتأكد أن بصمته أو بنيته تطابق المخطط المرجعي.
${mysql ? '- MySQL ينفّذ كل أمر DDL في transaction مستقلة ولا يتراجع عنه: نفّذ الأوامر بالترتيب واحدًا واحدًا، وخذ نسخة احتياطية قبل البدء.' : '- نفّذ التغييرات بالترتيب داخل transaction واحدة، عدا CREATE INDEX CONCURRENTLY فيُنفّذ بعدها منفصلًا لأنه لا يعمل داخل transaction.'}
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
export function submitEdit(event) {
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
    case 'addIndex': operation = { type: 'addIndex', tableId: context.tableId, index: { name: value('name'), columns: [...(state.indexColumns || [])], unique: data.has('unique'), concurrently: data.has('concurrently') } }; break;
    case 'addRelation': operation = { type: 'addRelation', relation: { id: `draft:${crypto.randomUUID()}`, name: `${(state.schema.tables.find(item => item.id === value('source'))?.name || 'table')}_${value('sourceColumn')}_foreign`, source: value('source'), target: value('target'), pairs: [{ source: value('sourceColumn'), target: value('targetColumn') }], onDelete: value('onDelete') || 'a' } }; break;
  }
  try {
    if (operation.type === 'addTable' && context.position) state.positions.set(operation.id, context.position);
    stage(operation); $('editDialog').close(); if (operation.type === 'addTable') selectTable(operation.id);
  }
  catch (error) { $('editError').textContent = error.message; $('editError').hidden = false; }
}
export async function reviewDraft() {
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
}
export async function sendPlanToAi() {
  if (!state.plan) return;
  const button = $('sendToAiButton'); button.disabled = true; $('planError').hidden = true;
  $('handoffResult').hidden = false; $('handoffResult').textContent = 'AI يراجع متغيرات المسودة ويجهز خطة التعديل...';
  try {
    $('handoffResult').replaceChildren(...answerNodes(await askAi('migration', state.handoffPrompt)));
  } catch (error) { $('handoffResult').hidden = true; $('planError').textContent = `${error.message} — يمكنك نسخ الـPrompt وإرساله إلى وكيل AI آخر.`; $('planError').hidden = false; }
  finally { button.disabled = false; }
}
