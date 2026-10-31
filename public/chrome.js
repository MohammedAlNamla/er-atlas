// The top chrome: theme, header menus, the density steps that keep its zones apart, the search toggle.
import { store } from './storage.js';
import { $, state, showToast } from './core.js';
import { updateEdgeEmphasis } from './edges.js';
const THEME_KEY = 'eratlas.theme';
const THEME_LABELS = { auto: 'تلقائي', light: 'فاتح', dark: 'ليلي' };
// Canvas edges are painted in JS, so they read the same CSS tokens as the DOM does.
let themeColors = null;
function readThemeColors() {
  const fallback = { wire: '#9288af', focus: '#6d58c6', trace: '#5d45c3', selected: '#6551c7', proposed: '#8164d2', morph: '#2b8a80', label: '#5f5674', halo: '#fcfbfd' };
  if (typeof getComputedStyle !== 'function' || typeof document.documentElement?.nodeType !== 'number') return fallback;
  const style = getComputedStyle(document.documentElement), read = (name, value) => style.getPropertyValue(name).trim() || value;
  return { wire: read('--wire', fallback.wire), focus: read('--wire-focus', fallback.focus), trace: read('--wire-trace', fallback.trace),
    selected: read('--wire-selected', fallback.selected), proposed: read('--wire-proposed', fallback.proposed), morph: read('--wire-morph', fallback.morph), label: read('--wire-label', fallback.label), halo: read('--paper', fallback.halo) };
}
export const edgeColors = () => themeColors ||= readThemeColors();
export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else root.removeAttribute('data-theme');
  const label = $('themeLabel'); if (label) label.textContent = THEME_LABELS[mode] || THEME_LABELS.auto;
  themeColors = null;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--paper').trim() || '#fcfbfd');
  if (state.schema) updateEdgeEmphasis();
}
export function currentTheme() { const saved = store.getItem(THEME_KEY); return saved === 'light' || saved === 'dark' ? saved : 'auto'; }
export function cycleTheme() {
  const order = ['auto', 'light', 'dark'], next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  store.setItem(THEME_KEY, next); applyTheme(next);
  showToast(`المظهر: ${THEME_LABELS[next]}`);
}
export function closeHeaderMenus() {
  for (const [trigger, menu] of [['toolsButton', 'toolsMenu'], ['aiMenuButton', 'aiMenu'], ['topicSwitchButton', 'topics']]) {
    $(menu).hidden = true; $(trigger).setAttribute('aria-expanded', 'false');
  }
}
// The three top zones float independently, so a long workspace name used to slide the
// tool strip over the menu. Step the density up one class at a time until they clear;
// d4 (phones) drops the logo pill so the workspace and drafts pills never collide.
function fitChrome() {
  const chrome = document.querySelector('.chrome'); if (!chrome) return;
  chrome.classList.remove('vc'); fitChromeDensity(chrome);
  // On a phone the strip can still overflow its own row: the view tabs then take a line of their own.
  const toolbar = chrome.querySelector('.toolbar');
  if (chrome.classList.contains('d3') && toolbar.scrollWidth > toolbar.clientWidth + 1) chrome.classList.add('vc');
}
function fitChromeDensity(chrome) {
  const [start, center, end] = ['.chrome-start', '.chrome-center', '.chrome-end'].map(selector => chrome.querySelector(selector));
  chrome.classList.remove('d1', 'd2', 'd3', 'd4'); center.style.removeProperty('translate');
  for (let level = 1; level <= 4; level++) {
    const box = center.getBoundingClientRect(), grow = level === 1 ? 36 : 0; // the inline search widens 72px on focus
    const [a, b] = [start, end].map(zone => zone.getBoundingClientRect()).sort((x, y) => x.left - y.left);
    if (level === 4 && a.right + 12 <= b.left) return; // the strip has its own row; only the sides must clear
    if (level < 4 && box.width + grow * 2 + 24 <= b.left - a.right) {
      // Centered on the screen when it fits; otherwise centered in the free gap between the side zones.
      if (box.left - grow - 12 < a.right || box.right + grow + 12 > b.left) center.style.translate = `${Math.round((a.right + b.left - box.left - box.right) / 2)}px 0`;
      return;
    }
    chrome.classList.add(`d${level}`);
  }
}
let chromeFrame = null;
export const scheduleFitChrome = () => { if (!chromeFrame) chromeFrame = requestAnimationFrame(() => { chromeFrame = null; fitChrome(); }); };
export function setNavbarSearch(open, { focus = false } = {}) {
  document.querySelector('.chrome').classList.toggle('search-open', open);
  $('searchToggleButton').setAttribute('aria-expanded', String(open));
  $('searchToggleButton').setAttribute('aria-label', open ? 'إغلاق البحث' : 'فتح البحث');
  if (focus) (open ? $('searchInput') : $('searchToggleButton')).focus();
}
