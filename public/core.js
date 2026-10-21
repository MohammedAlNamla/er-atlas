// Shared state and the small DOM helpers every module uses: elements, icons, toast, confirmation.
import { store } from './storage.js';
import { button as uiButton, notice, modalHeader, modalFooter, openDialog } from './ui.js';
export const $ = id => document.getElementById(id);
export const state = {
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
export const WORKSPACES_KEY = 'eratlas.workspaces.v1';
export const activeWorkspace = () => state.workspaces.find(item => item.id === state.workspaceId);
export const blankSchema = name => ({ database: name, tables: [], relations: [], readOnly: true });
export function saveWorkspaces() {
  store.setItem(WORKSPACES_KEY, JSON.stringify({ activeId: state.workspaceId, items: state.workspaces }));
}
export const SVG_NS = 'http://www.w3.org/2000/svg';
export function sprite(name, className = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg'), use = document.createElementNS(SVG_NS, 'use');
  svg.setAttribute('class', className); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', `#i-${name}`);
  svg.append(use); return svg;
}
export function storageKey() {
  if (state.workspaceId && state.workspaceId !== 'legacy') return `eratlas.v4.ws.${state.workspaceId}`;
  const signature = state.base.tables.map(t => `${t.schema}.${t.name}`).sort().join('|');
  return `eratlas.v4.${state.demo ? 'demo' : 'db'}.${state.base.database}.${signature}`;
}
export function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
// Long identifiers wrap after a dot or underscore, never in the middle of a word.
export function breakableTitle(header) {
  const heading = header.querySelector('h2'), text = heading.textContent;
  heading.replaceChildren(...text.split(/(?<=[._])/).flatMap(part => [document.createTextNode(part), document.createElement('wbr')]));
  heading.classList.add('identifier-title'); heading.dir = 'ltr';
  return header;
}
// Every modal header opens with a quiet icon tile that names the kind of task.
export const DIALOG_ICONS = { connectDialog: 'database', workspaceDialog: 'arrange', planDialog: 'sparkle', changesPanel: 'draft', topicsDialog: 'arrange', codeDialog: 'code', aiSettingsDialog: 'key', arrangeDialog: 'arrange' };
export function headerIcon(header, name, tone = '') {
  header.querySelector(':scope > .modal-icon')?.remove();
  if (!name) return header;
  const tile = el('span', `modal-icon${tone ? ` ${tone}` : ''}`); tile.setAttribute('aria-hidden', 'true'); tile.append(sprite(name));
  header.prepend(tile); return header;
}
export function confirmAction(title, description, message, apply, label = 'حذف من المسودة', danger = true, detail = 'يمكن التراجع عن هذا التغيير من مراجعة المسودة.') {
  const dialog = $('confirmationDialog'), root = $('confirmationContent'); root.replaceChildren();
  const workspaceId = state.workspaceId;
  root.append(headerIcon(modalHeader(title, description, () => dialog.close(), 'confirmationTitle'), danger ? 'trash' : 'info', danger ? 'danger' : ''));
  const body = el('div', 'modal-body'); body.append(notice(message, detail, 'warning')); root.append(body);
  root.append(modalFooter([
    uiButton(label, () => { if (workspaceId !== state.workspaceId) { dialog.close(); return; } apply(); dialog.close(); }, danger ? 'primary-button danger' : 'primary-button'),
    uiButton('إلغاء', () => dialog.close())
  ])); openDialog(dialog);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast('تم النسخ'); } catch { showToast('تعذّر النسخ. حدد النص وانسخه يدويًا.'); }
}
// The toast is a manual popover, so it lives in the top layer; showing it again lifts it above
// any dialog opened since, instead of hiding behind the modal that triggered it.
export function showToast(message) {
  const toast = $('toast'); toast.textContent = message;
  try { if (toast.matches(':popover-open')) toast.hidePopover(); toast.showPopover(); } catch { /* no popover support: it stays in the page */ }
  toast.classList.remove('show'); void toast.offsetWidth; toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    state.toastTimer = setTimeout(() => { try { toast.hidePopover(); } catch { /* already hidden */ } }, 240);
  }, 2700);
}
export function slug(name) { return String(name).trim().replace(/[^\w\u0600-\u06FF-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace'; }
