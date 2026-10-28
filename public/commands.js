// The shortcuts sheet and the command palette.
const SVG = 'http://www.w3.org/2000/svg';
// A short wire drawn the way the map draws it, so the legend matches what you see.
const WIRE_ENDS = { dash: '', many: 'M30 12 40 5M30 12 40 19', one: 'M30 6v12M35 6v12', 'zero-one': 'M33 6v12', };
function legendWire(kind) {
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 48 24'); svg.setAttribute('class', `legend-wire ${kind}`); svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG, 'path'); line.setAttribute('d', 'M4 12H40'); svg.append(line);
  if (WIRE_ENDS[kind]) { const end = document.createElementNS(SVG, 'path'); end.setAttribute('d', WIRE_ENDS[kind]); svg.append(end); }
  if (kind === 'zero-one') { const ring = document.createElementNS(SVG, 'circle'); ring.setAttribute('cx', '24'); ring.setAttribute('cy', '12'); ring.setAttribute('r', '4'); svg.append(ring); }
  return svg;
}
import { icon, button as uiButton, modalHeader, modalFooter, openDialog } from './ui.js';
import { $, state, el, headerIcon } from './core.js';
import { cycleTheme, closeHeaderMenus } from './chrome.js';
import { openWorkspaceDialog, exportWorkspace, importWorkspace } from './workspaces.js';
import { locateTable } from './views.js';
import { openArrangement } from './layout.js';
import { columnsLabel, rankedSearch, fitView } from './canvas.js';
import { openEditor } from './editor.js';
import { openCodeDialog } from './groups.js';
import { openAiConversation } from './chat.js';
import { openLint, openExport } from './sheets.js';
import { openConnectionDialog } from './connect.js';
const SHORTCUTS = [
  ['الخريطة', [['تحديد', ['V']], ['جدول جديد', ['T']], ['علاقة جديدة', ['R']], ['ترتيب الجداول', ['A']], ['تقريب / تبعيد', ['+', '−']], ['حجم مقروء', ['0']], ['كامل المخطط', ['F']], ['تحريك الخريطة', ['←', '↑', '→', '↓']]]],
  ['البحث والتنقل', [['الخريطة / الجداول / المواضيع / جدول واحد', ['1', '2', '3', '4']], ['البحث في الخريطة', ['/']], ['النتيجة التالية', ['Enter']], ['النتيجة السابقة', ['Shift', 'Enter']], ['مسح البحث', ['Esc']], ['الأوامر والقفز إلى جدول', ['Ctrl', 'K']]]],
  ['المسودة والأدوات', [['تراجع', ['Ctrl', 'Z']], ['إعادة', ['Ctrl', 'Y']], ['مراجعة المسودة', ['D']], ['فحص المخطط', ['L']], ['تصدير المخطط', ['E']], ['إغلاق النافذة أو التحديد', ['Esc']]]]
];
export function openShortcuts() {
  closeHeaderMenus();
  const dialog = $('shortcutsDialog'), root = $('shortcutsContent'); root.replaceChildren();
  root.append(headerIcon(modalHeader('الاختصارات ورموز الخريطة', 'كل ما في الخريطة يُنجز من لوحة المفاتيح، وهذه معاني الرموز على الجداول والخطوط.', () => dialog.close(), 'shortcutsTitle'), 'keyboard'));
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
  const legend = el('section', 'map-legend'), items = el('dl');
  for (const [mark, label, className] of [['PK', 'مفتاح أساسي', 'col-key pk'], ['FK', 'مفتاح أجنبي يشير إلى جدول آخر', 'col-key fk'], ['?', 'العمود يقبل قيمة فارغة (NULL)', 'legend-null'], ['مسودة', 'جدول أو عمود أضفته في المسودة ولم يُنفّذ بعد', 'node-draft'], ['dash', 'علاقة مضافة في المسودة', 'wire'], ['many', 'طرف «كثير» من العلاقة (crow’s foot)', 'wire'], ['one', 'طرف «واحد بالضبط»', 'wire'], ['zero-one', 'طرف «صفر أو واحد»: المفتاح الأجنبي يقبل NULL', 'wire']]) {
    const row = el('div', 'legend-row'), term = el('dt'); term.append(className === 'wire' ? legendWire(mark) : el('span', className, mark)); row.append(term, el('dd', '', label)); items.append(row);
  }
  legend.append(el('h3', '', 'رموز الخريطة'), items);
  body.append(groups, legend);
  root.append(body, modalFooter([uiButton('كل الأوامر', () => { dialog.close(); openQuickActions(); }, 'secondary-button')], 'Ctrl K يفتح لوحة الأوامر من أي مكان.'));
  openDialog(dialog);
}
export function openQuickActions() {
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
export function filterQuickActions(raw) {
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
