// The schema check and export sheets.
import { lintSchema } from './lint.js';
import { EXPORT_FORMATS, exportSchema, toLaravelMigration } from './exporters.js';
import { button as uiButton, notice, codeBlock, tabs as uiTabs, modalHeader, modalFooter, openDialog } from './ui.js';
import { $, state, activeWorkspace, el, headerIcon, copyText, showToast, slug } from './core.js';
import { closeHeaderMenus } from './chrome.js';
import { locateTable } from './views.js';
import { visibleTables } from './layout.js';
import { stage } from './editor.js';
// ---- Schema check: local rules over the current draft, each finding one click from the map.
const SEVERITY_LABELS = { error: 'أخطاء', warning: 'تحذيرات', info: 'ملاحظات' };
export function updateLintCount() {
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
export function renderLint() {
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
export function openLint() { closeHeaderMenus(); renderLint(); openDialog($('lintDialog')); }
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
export function openExport(format) { closeHeaderMenus(); if (format) state.exportFormat = format; renderExport(); openDialog($('exportDialog')); }
