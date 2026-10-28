// The table inspector, the expanded table sheet and relation details.
import { button as uiButton, notice, codeBlock, tabs as uiTabs, modalHeader, modalFooter, openDialog } from './ui.js';
import { $, state, activeWorkspace, el, breakableTitle, headerIcon, confirmAction } from './core.js';
import { setViewMode, chooseFocusTable } from './views.js';
import { updateEmphasis, selectRelation } from './canvas.js';
import { columnList, columnNotesBar } from './notes.js';
import { isDraftTable, isDraftRelation, stage, openEditor } from './editor.js';
import { openCodeDialog } from './groups.js';
import { allRelations } from './layout.js';
function openMorphDetails(relation, from, to) {
  const dialog = $('relationshipDialog'), root = $('relationshipContent'); root.replaceChildren();
  root.append(headerIcon(modalHeader('علاقة متعددة الأشكال', 'ربط polymorphic بلا مفتاح أجنبي: العمودان معًا يحددان الصف المرتبط.', () => dialog.close(), 'relationshipTitle'), 'relation'));
  const body = el('div', 'modal-body');
  body.append(el('h3', '', 'أعمدة الربط'), el('div', 'relation-identifier', `${from.name}.${relation.morph}_type\n${from.name}.${relation.morph}_id`),
    el('h3', '', 'الجدول المرتبط'), el('div', 'relation-identifier referenced', `${to.name}.${relation.pairs[0].target}`));
  const tags = el('div', 'chip-row');
  if (relation.via.includes('code')) tags.append(el('span', 'chip', 'من الكود'));
  if (relation.via.includes('data')) tags.append(el('span', 'chip', 'من البيانات الحية'));
  for (const topic of state.groups.filter(topic => topic.id !== 'all' && topic.ids.has(from.id) && topic.ids.has(to.id))) tags.append(el('span', 'chip', topic.label));
  body.append(tags);
  const sources = (activeWorkspace()?.codeAnalysis?.morphs || []).find(entry => entry.tableId === from.id && entry.name === relation.morph)?.evidence || [];
  for (const source of sources.slice(0, 4)) body.append(codeBlock(source.syntax || '', `${source.file}:${source.line}`));
  body.append(el('p', 'field-hint', 'لا تُضاف هذه العلاقة إلى المسودة أو SQL: قاعدة البيانات لا تفرضها، والخريطة تعرضها لتوضيح من يملك الجدول.'));
  root.append(body, modalFooter([uiButton('إظهار على الخريطة', () => { dialog.close(); setViewMode('focus'); chooseFocusTable(from.id); }), uiButton('إغلاق', () => dialog.close())]));
  openDialog(dialog);
}
export function openRelationDetails(id) {
  const relation = allRelations().find(item => item.id === id); if (!relation) return;
  const from = state.schema.tables.find(table => table.id === relation.source), to = state.schema.tables.find(table => table.id === relation.target);
  if (relation.kind === 'morph') { openMorphDetails(relation, from, to); return; }
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
export function sourceEvidence(tableId) {
  const analysis = activeWorkspace()?.codeAnalysis;
  return analysis?.tables?.find(table => table.tableId === tableId)?.evidence || [];
}
function closeInspector() {
  state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis();
}
function relationCards(table) {
  const section = el('div', 'table-relations');
  const relevant = allRelations().filter(relation => relation.source === table.id || relation.target === table.id);
  if (!relevant.length) section.append(notice('لا توجد علاقات لهذا الجدول', 'يمكنك إضافة علاقة إلى المسودة.'));
  for (const relation of relevant) {
    const from = state.schema.tables.find(item => item.id === relation.source), to = state.schema.tables.find(item => item.id === relation.target);
    const card = uiButton('', () => { $('tableDialog').close(); selectRelation(relation.id); }, 'relation-card');
    const morph = relation.kind === 'morph';
    card.append(el('strong', '', `${from?.name} → ${to?.name}`), el('small', '', morph ? `${relation.morph}_type · ${relation.morph}_id` : relation.pairs.map(pair => `${pair.source} → ${pair.target}`).join(' · ')),
      el('small', '', morph ? 'متعددة الأشكال · بلا مفتاح أجنبي' : relation.source === table.id ? 'مفتاح أجنبي من هذا الجدول' : 'علاقة واردة إلى هذا الجدول'));
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
export function renderDetails() {
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
export function openExpandedTable(id) {
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
export function confirmDropTable(tableId) {
  const table = state.schema.tables.find(item => item.id === tableId); if (!table) return;
  const linked = state.schema.relations.filter(relation => relation.source === tableId || relation.target === tableId).length;
  const rows = table.approxRows > 0 ? ` يحتوي الجدول ≈ ${table.approxRows.toLocaleString('en-US')} صف ستُفقد عند التنفيذ.` : '';
  confirmAction('حذف الجدول في المسودة؟', `${table.schema}.${table.name}`,
    `سيُسجل حذف الجدول${linked === 1 ? ' مع علاقته' : linked ? ` مع علاقاته (${linked})` : ''} ضمن المسودة.${rows}`,
    () => { closeInspector(); stage({ type: 'dropTable', tableId }); }, 'حذف الجدول');
}
