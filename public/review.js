// The database review sheet: the deterministic engine's findings (schema, code, live statistics,
// draft), each traced to its check and playbook, with one-click draft fixes and an optional AI pass.
import { button as uiButton, notice, tabs as uiTabs, modalHeader, modalFooter, openDialog } from './ui.js';
import { $, state, activeWorkspace, el, sprite, headerIcon, copyText, showToast, slug, storageKey } from './core.js';
import { store } from './storage.js';
import { closeHeaderMenus } from './chrome.js';
import { locateTable } from './views.js';
import { stage } from './editor.js';
import { askAi } from './ai.js';
import { answerNodes } from './chat.js';
import { openCodeDialog, syncCodeSource } from './groups.js';

const SEVERITY = { error: 'خطأ', warning: 'تحذير', info: 'ملاحظة' };
const SEVERITY_PLURAL = { error: 'أخطاء', warning: 'تحذيرات', info: 'ملاحظات' };
const CONFIDENCE = { high: 'ثقة عالية', medium: 'ثقة متوسطة', low: 'ثقة منخفضة' };
const SKILL_TITLES = { 'schema-design': 'تصميم المخطط', 'indexing-performance': 'الفهارس والأداء', 'data-integrity': 'سلامة البيانات', 'laravel-security': 'الأمان', 'code-db-drift': 'تطابق الكود والقاعدة', 'migration-safety': 'أمان المسودة' };

const review = { result: null, ai: null, pending: false, aiPending: false, error: '', filter: 'all', skill: 'all', open: new Set(), guides: new Map(), controller: null,
  view: 'findings', catalog: null, accepting: null, draft: null };

// The team's own rules for this workspace: risks accepted with a reason, checks switched off,
// severities they set, and what "small / large / huge" means for their data. The engine reads all
// but the accepted risks, which only decide where a finding is shown.
const settingsKey = () => `${storageKey()}.review`;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function loadSettings() {
  try {
    const data = JSON.parse(store.getItem(settingsKey()) || '{}');
    return { accepted: object(data.accepted), disabled: Array.isArray(data.disabled) ? data.disabled : [], severity: object(data.severity), limits: object(data.limits) };
  } catch { return { accepted: {}, disabled: [], severity: {}, limits: {} }; }
}
const saveSettings = settings => store.setItem(settingsKey(), JSON.stringify(settings));
const isAccepted = finding => Boolean(loadSettings().accepted[finding.id]);
const sourceRoot = () => (activeWorkspace()?.sourceRoot || $('topicSourceRoot')?.value || '').trim();
const tableName = id => state.schema.tables.find(table => table.id === id)?.name || id;

export async function runDatabaseReview() {
  syncCodeSource();
  review.pending = true; review.error = ''; review.ai = null; renderReview();
  try {
    const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      schema: state.schema, base: state.base, operations: state.operations.slice(0, state.cursor), sourceRoot: sourceRoot(), stats: state.connectionLive,
      settings: (({ disabled, severity, limits }) => ({ disabled, severity, limits }))(loadSettings()) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذّرت المراجعة');
    review.result = data; review.workspaceId = state.workspaceId;
  } catch (error) { review.error = error.message; }
  finally { review.pending = false; renderReview(); }
}

async function runAiReview() {
  if (!review.result?.findings || review.aiPending) return;
  // Accepted risks are settled: the reviewer ranks only what is still open.
  const findings = review.result.findings.filter(finding => !isAccepted(finding));
  const evidence = findings.flatMap(finding => finding.evidence || []).filter(item => item.file && item.line);
  review.aiPending = true; review.controller = new AbortController(); renderReview();
  try {
    const data = await askAi('review', 'راجع القاعدة: رتّب النتائج حسب الأثر الفعلي وضع خطة إصلاح.', state.schema, review.controller.signal, { review: { findings, evidence } });
    review.ai = data.review;
  } catch (error) { if (error.name !== 'AbortError') review.ai = { error: error.message }; }
  finally { review.aiPending = false; review.controller = null; renderReview(); }
}

// Finding order: the AI's priority when present, otherwise the engine's (severity, confidence, table).
function orderedFindings() {
  const findings = [...(review.result?.findings || []), ...(review.ai?.extra || [])];
  const priority = new Map((review.ai?.order || []).map((item, index) => [item.id, index]));
  return priority.size ? [...findings].sort((a, b) => (priority.get(a.id) ?? 1e6) - (priority.get(b.id) ?? 1e6)) : findings;
}

async function toggleGuide(finding, host) {
  const engine = state.schema?.engine === 'mysql' ? 'mysql' : 'postgres', key = `${engine}:${finding.check}`;
  if (!review.guides.has(key)) {
    host.replaceChildren(el('p', 'field-hint', 'أقرأ الدليل…'));
    try {
      const response = await fetch(`/api/review/guide?check=${encodeURIComponent(finding.check)}&engine=${engine}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      review.guides.set(key, data);
    } catch (error) { host.replaceChildren(el('p', 'field-hint error', error.message || 'تعذّر تحميل الدليل')); return; }
  }
  const guide = review.guides.get(key);
  host.replaceChildren(el('p', 'review-guide-title', `${guide.skillTitle} · ${finding.check}`), ...answerNodes(guide.markdown));
}

function evidenceList(finding) {
  const list = el('ul', 'review-evidence');
  for (const item of finding.evidence || []) {
    const row = el('li', `review-evidence-item ${item.kind}`);
    const where = item.file ? el('code', 'review-evidence-where', `${item.file}:${item.line}`) : el('span', 'review-evidence-kind', { schema: 'المخطط', stats: 'إحصاءات حية', draft: 'المسودة', code: 'الكود' }[item.kind] || item.kind);
    if (item.file) where.dir = 'ltr';
    const text = el('code', 'review-evidence-text', item.text || ''); text.dir = 'ltr';
    row.append(where, text); list.append(row);
  }
  return list;
}

function findingCard(finding, rank) {
  const card = el('li', `review-item ${finding.severity}${finding.source === 'ai' ? ' from-ai' : ''}`);
  const head = el('div', 'review-head');
  head.append(el('span', 'review-dot'), el('strong', 'review-title', finding.title));
  const meta = el('div', 'review-meta');
  const check = el('span', 'review-check', finding.check); check.dir = 'ltr';
  meta.append(check, el('span', `review-confidence ${finding.confidence}`, CONFIDENCE[finding.confidence] || ''));
  if (finding.tableId) { const where = el('code', 'review-where', `${tableName(finding.tableId)}${finding.columnName ? `.${finding.columnName}` : ''}`); where.dir = 'ltr'; meta.append(where); }
  if (finding.source === 'ai') meta.append(el('span', 'review-ai-badge', 'إضافة AI'));
  if (finding.defaultSeverity) meta.append(el('span', 'review-override', `خطورة المشروع · الدليل: ${SEVERITY[finding.defaultSeverity]}`));
  if (rank !== undefined) meta.prepend(el('span', 'review-rank', `#${rank + 1}`));
  card.append(head, meta, el('p', 'review-detail', finding.detail));
  const accepted = loadSettings().accepted[finding.id];
  if (accepted) {
    const note = el('p', 'review-accepted');
    note.append(el('strong', '', 'خطر مقبول: '), document.createTextNode(accepted.reason), el('span', 'review-accepted-date', ` · ${new Date(accepted.at).toLocaleDateString('ar')}`));
    card.append(note);
  }
  if (review.accepting === finding.id) card.append(acceptForm(finding));
  const why = review.ai?.order?.find(item => item.id === finding.id)?.why;
  if (why) card.append(el('p', 'review-why', why));
  const details = el('div', 'review-details'); details.hidden = !review.open.has(finding.id);
  const guide = el('div', 'review-guide');
  details.append(evidenceList(finding), guide);
  if (!details.hidden) toggleGuide(finding, guide);
  const actions = el('div', 'review-actions');
  if (finding.tableId && state.schema.tables.some(table => table.id === finding.tableId)) actions.append(uiButton('إظهار على الخريطة', () => { if (innerWidth < 900) $('reviewDialog').close(); locateTable(finding.tableId); }, 'text-button'));
  actions.append(uiButton(details.hidden ? 'الدليل والسبب' : 'إخفاء التفاصيل', () => {
    if (review.open.has(finding.id)) review.open.delete(finding.id); else review.open.add(finding.id);
    renderReview();
  }, 'text-button'));
  if (finding.fix?.operation) actions.append(uiButton(finding.fix.operation.type === 'addIndex' ? 'أضف الفهرس إلى المسودة' : 'أضف العلاقة إلى المسودة', () => stageFixes([finding]), 'text-button strong'));
  else if (finding.fix?.sql) actions.append(uiButton('نسخ SQL الإصلاح', () => copyText(finding.fix.sql), 'text-button'));
  if (accepted) actions.append(uiButton('إلغاء القبول', () => setAccepted(finding, null), 'text-button'));
  else if (review.accepting !== finding.id && finding.source !== 'ai') actions.append(uiButton('قبول الخطر', () => { review.accepting = finding.id; renderReview(); $('reviewContent').querySelector('.review-accept input')?.focus(); }, 'text-button'));
  card.append(actions, details);
  return card;
}

// Accepting a risk needs a reason a teammate can read later; it is kept per workspace.
function acceptForm(finding) {
  const form = el('form', 'review-accept');
  const input = el('input'); input.name = 'reason'; input.required = true; input.maxLength = 300; input.placeholder = 'لماذا هذا مقبول؟ مثل: جدول أرشيف لا يُحذف منه';
  input.setAttribute('aria-label', `سبب قبول ${finding.check}`);
  const save = uiButton('احفظ', () => {}, 'secondary-button'); save.type = 'submit';
  form.append(input, save, uiButton('إلغاء', () => { review.accepting = null; renderReview(); }, 'text-button'));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const reason = input.value.trim();
    if (!reason) { input.focus(); return; }
    setAccepted(finding, reason);
  });
  return form;
}
function setAccepted(finding, reason) {
  const settings = loadSettings();
  if (reason) settings.accepted[finding.id] = { reason, at: new Date().toISOString(), check: finding.check };
  else delete settings.accepted[finding.id];
  saveSettings(settings); review.accepting = null;
  showToast(reason ? 'قُبل الخطر ونُقل إلى «مقبولة»' : 'عادت الملاحظة إلى القائمة');
  renderReview();
}

function stageFixes(findings) {
  let added = 0;
  for (const finding of findings) {
    const operation = structuredClone(finding.fix.operation);
    if (operation.type === 'addRelation') operation.relation.id = `draft:${crypto.randomUUID()}`;
    try { stage(operation); added++; } catch { /* already covered or stale */ }
  }
  if (added) { showToast(added === 1 ? 'أضيف الإصلاح إلى المسودة' : `أضيفت ${added} إصلاحات إلى المسودة`); runDatabaseReview(); }
}

function coverageBar(data) {
  const bar = el('div', 'review-coverage');
  const chip = (ok, label, detail, action) => {
    const item = el('div', `review-input${ok ? ' ok' : ''}`);
    item.append(sprite(ok ? 'check' : 'info', 'i i-small'), el('strong', '', label), el('span', '', detail));
    if (action) item.append(action);
    bar.append(item);
  };
  const skipped = reason => (data.coverage?.skipped || []).filter(item => item.reason === reason).length;
  chip(true, 'المخطط', `${state.schema.tables.length} جدول${skipped('no indexes') ? ' · بلا فهارس مقروءة' : ''}`);
  chip(Boolean(data.inputs?.code), 'الكود', data.inputs?.code ? `${data.inputs.code.project} · ${data.inputs.code.parsedFiles ?? data.inputs.code.scannedFiles} ملف` : `${skipped('no code')} فحصًا ينتظر${data.inputs?.codeError ? ` · ${data.inputs.codeError}` : ''}`,
    data.inputs?.code ? null : uiButton('حدد مجلد المشروع', () => { $('reviewDialog').close(); openCodeDialog(); }, 'text-button'));
  chip(Boolean(data.inputs?.stats), 'الإحصاءات الحية', data.inputs?.stats ? 'من القاعدة المتصلة' : `${skipped('no stats')} فحصًا ينتظر · ${data.inputs?.statsError || 'اتصل بالقاعدة مباشرة'}`);
  chip(state.cursor > 0, 'المسودة', state.cursor ? `${state.cursor} تغييرات تُفحص قبل التنفيذ` : 'لا تغييرات');
  return bar;
}

export function renderReview() {
  const dialog = $('reviewDialog'), root = $('reviewContent'); if (!root) return;
  root.replaceChildren();
  const data = review.workspaceId === state.workspaceId ? review.result : null;
  if (review.view === 'settings') { renderSettings(root, dialog); return; }
  const all = data ? orderedFindings() : [];
  const acceptedIds = loadSettings().accepted;
  const accepted = all.filter(finding => acceptedIds[finding.id]);
  // Accepted risks leave every count, filter and bulk action; they live under their own tab.
  const findings = review.filter === 'accepted' ? accepted : all.filter(finding => !acceptedIds[finding.id]);
  root.append(headerIcon(modalHeader('مراجعة القاعدة', 'فحص حتمي للمخطط والكود والإحصاءات والمسودة وفق أدلة خبرة مكتوبة، مع مراجعة AI اختيارية فوقه.', () => dialog.close(), 'reviewTitle'), 'shield'));
  const body = el('div', 'modal-body');
  if (review.pending) body.append(el('div', 'review-loading', 'أجري الفحوص… قد يستغرق تحليل الكود لحظات في أول مرة.'));
  else if (review.error) body.append(notice('تعذّرت المراجعة', review.error, 'error'));
  else if (!data) body.append(el('p', 'field-hint', 'اضغط «ابدأ المراجعة».'));
  else {
    body.append(coverageBar(data));
    const counts = Object.fromEntries(Object.keys(SEVERITY).map(key => [key, findings.filter(item => item.severity === key).length]));
    if (review.ai?.summary) { const box = el('section', 'review-ai-summary'); box.append(el('h3', '', 'خلاصة المراجع'), el('p', '', review.ai.summary)); if (review.ai.plan?.length) { const plan = el('ol', 'review-plan'); review.ai.plan.forEach(step => plan.append(el('li', '', step))); box.append(el('h3', '', 'خطة الإصلاح'), plan); } body.append(box); }
    if (review.ai?.error) body.append(notice('تعذّرت مراجعة AI', review.ai.error, 'error'));
    const open = all.length - accepted.length;
    if (!open && !accepted.length) body.append(notice('لا توجد ملاحظات', 'كل الفحوص التي توفرت مدخلاتها نجحت. أكمل المدخلات الناقصة أعلاه لفحص أعمق.', 'success'));
    else {
      const filter = review.filter === 'accepted' && accepted.length ? 'accepted' : counts[review.filter] ? review.filter : 'all';
      if (filter !== review.filter) review.filter = filter;
      body.append(uiTabs([['all', `الكل ${open}`], ...Object.keys(SEVERITY).filter(key => counts[key] && filter !== 'accepted').map(key => [key, `${SEVERITY_PLURAL[key]} ${counts[key]}`]),
        ...(accepted.length ? [['accepted', `مقبولة ${accepted.length}`]] : [])], filter, value => { review.filter = value; renderReview(); }));
      if (filter === 'accepted') body.append(el('p', 'field-hint', 'مخاطر قبلها الفريق مع السبب. لا تُحسب في الأعداد ولا تُرسل إلى مراجعة AI، وتعود إن ألغيت قبولها.'));
      if (!open && filter !== 'accepted') body.append(notice('لا ملاحظات مفتوحة', `كل ما وجده الفحص مقبول (${accepted.length}).`, 'success'));
      const skills = [...new Set(findings.map(item => item.skill))];
      const chips = el('div', 'review-skills');
      for (const id of ['all', ...skills]) {
        const chip = uiButton(id === 'all' ? 'كل التخصصات' : `${SKILL_TITLES[id] || id} ${findings.filter(item => item.skill === id).length}`, () => { review.skill = id; renderReview(); }, `review-skill${(review.skill === id || (id === 'all' && !skills.includes(review.skill))) ? ' active' : ''}`);
        chips.append(chip);
      }
      body.append(chips);
      const list = el('ol', 'review-list'), priority = new Map((review.ai?.order || []).map((item, index) => [item.id, index]));
      for (const finding of findings.filter(item => (['all', 'accepted'].includes(filter) || item.severity === filter) && (!skills.includes(review.skill) || item.skill === review.skill))) list.append(findingCard(finding, priority.get(finding.id)));
      body.append(list);
      if (review.ai?.dropped?.length) body.append(el('p', 'field-hint', `حُذفت ${review.ai.dropped.length} إضافات من AI لأنها بلا دليل يمكن التحقق منه.`));
    }
  }
  const fixable = all.filter(item => item.fix?.operation && !acceptedIds[item.id]);
  const actions = [];
  if (fixable.length > 1) actions.push(uiButton(`أضف كل الإصلاحات (${fixable.length})`, () => stageFixes(fixable), 'primary-button'));
  actions.push(uiButton(data ? 'أعد الفحص' : 'ابدأ المراجعة', runDatabaseReview, fixable.length > 1 || !data ? (data ? 'secondary-button' : 'primary-button') : 'secondary-button'));
  if (data && all.length > accepted.length) actions.push(review.aiPending ? uiButton('إيقاف مراجعة AI', () => review.controller?.abort(), 'secondary-button') : uiButton(review.ai?.summary ? 'أعد مراجعة AI' : 'راجع بالـAI', runAiReview, 'secondary-button'));
  if (data && all.length) actions.push(uiButton('تنزيل التقرير', downloadReport, 'ghost-button'));
  actions.push(uiButton('إعدادات الفحص', openSettings, 'ghost-button'));
  root.append(body, modalFooter(actions, review.aiPending ? 'المراجع يقرأ الأدلة ويرتّب النتائج…' : 'الإصلاحات تُضاف إلى المسودة فقط، ولا يُكتب شيء في قاعدة البيانات.'));
}

// ---- Settings: the project's own review rules (which checks run, their severity, size limits).
const DEFAULT_LIMITS = { small: 10000, large: 100000, huge: 10000000 };
async function openSettings() {
  review.view = 'settings'; review.draft = structuredClone(loadSettings()); renderReview();
  if (review.catalog) return;
  try {
    const response = await fetch('/api/review/catalog');
    if (!response.ok) throw new Error();
    review.catalog = await response.json();
  } catch { review.catalog = { error: 'تعذّر تحميل قائمة الفحوص' }; }
  if (review.view === 'settings') renderReview();
}
function renderSettings(root, dialog) {
  const draft = review.draft || loadSettings();
  root.append(headerIcon(modalHeader('إعدادات الفحص', 'قواعد فريقك لهذه المساحة: ما يُفحص، وبأي خطورة، وما الجدول الكبير عندكم.', () => dialog.close(), 'reviewTitle'), 'shield'));
  const body = el('div', 'modal-body review-settings');
  // Size limits move the playbooks' small/large/huge lines for every size-aware check.
  const limits = el('section', 'review-limits');
  limits.append(el('h3', '', 'حجم الجداول'), el('p', 'field-hint', 'تحدد متى يُعدّ الجدول صغيرًا فتُخفض النتائج أو كبيرًا فتُرفع. القيم بعدد الصفوف التقريبي.'));
  const grid = el('div', 'form-grid');
  for (const [key, label] of [['small', 'صغير إذا كان أقل من'], ['large', 'كبير من'], ['huge', 'ضخم من']]) {
    const field = el('label', '', label), input = el('input');
    input.type = 'number'; input.min = '1'; input.step = '1'; input.dir = 'ltr'; input.name = key;
    input.value = String(draft.limits?.[key] ?? DEFAULT_LIMITS[key]);
    input.addEventListener('input', () => { draft.limits = { ...DEFAULT_LIMITS, ...draft.limits, [key]: Number(input.value) }; });
    field.append(input); grid.append(field);
  }
  limits.append(grid); body.append(limits);
  if (!review.catalog) body.append(el('p', 'field-hint', 'أقرأ قائمة الفحوص…'));
  else if (review.catalog.error) body.append(notice('تعذّر التحميل', review.catalog.error, 'error'));
  else for (const skill of review.catalog.skills) {
    const section = el('section', 'review-settings-skill');
    section.append(el('h3', '', skill.title));
    for (const check of review.catalog.checks.filter(item => item.skill === skill.id)) {
      const row = el('div', 'review-setting');
      const toggle = el('label', 'review-setting-toggle'), box = el('input');
      box.type = 'checkbox'; box.checked = !draft.disabled.includes(check.id); box.setAttribute('aria-label', `تفعيل ${check.id}`);
      box.addEventListener('change', () => {
        draft.disabled = box.checked ? draft.disabled.filter(id => id !== check.id) : [...new Set([...draft.disabled, check.id])];
        row.classList.toggle('off', !box.checked);
      });
      const id = el('code', 'review-check', check.id); id.dir = 'ltr';
      toggle.append(box, id, el('span', '', check.title));
      const select = el('select'); select.setAttribute('aria-label', `خطورة ${check.id}`);
      for (const [value, text] of [['', `افتراضي · ${SEVERITY[check.severity]}`], ['error', SEVERITY.error], ['warning', SEVERITY.warning], ['info', SEVERITY.info]]) {
        const option = el('option', '', text); option.value = value; option.selected = (draft.severity[check.id] || '') === value; select.append(option);
      }
      select.addEventListener('change', () => { if (select.value) draft.severity[check.id] = select.value; else delete draft.severity[check.id]; });
      row.classList.toggle('off', !box.checked);
      row.append(toggle, select); section.append(row);
    }
    body.append(section);
  }
  const back = () => { review.view = 'findings'; review.draft = null; renderReview(); };
  root.append(body, modalFooter([
    uiButton('احفظ وأعد الفحص', () => {
      const next = review.draft, l = { ...DEFAULT_LIMITS, ...next.limits };
      if (!(l.small > 0 && l.small < l.large && l.large < l.huge)) { showToast('الحدود يجب أن تتزايد: صغير < كبير < ضخم'); return; }
      saveSettings({ ...loadSettings(), disabled: next.disabled, severity: next.severity, limits: l });
      back(); runDatabaseReview();
    }, 'primary-button'),
    uiButton('استعادة الافتراضي', () => { review.draft = { ...review.draft, disabled: [], severity: {}, limits: { ...DEFAULT_LIMITS } }; renderReview(); }, 'secondary-button'),
    uiButton('رجوع', back, 'ghost-button')
  ], 'المخاطر المقبولة لا تتأثر بهذه الإعدادات.'));
}

function downloadReport() {
  const acceptedIds = loadSettings().accepted;
  const findings = orderedFindings().filter(finding => !acceptedIds[finding.id]), accepted = orderedFindings().filter(finding => acceptedIds[finding.id]);
  const lines = [`# مراجعة قاعدة ${state.schema.database || ''}`, '', `${new Date().toLocaleString('ar')}`, ''];
  if (review.ai?.summary) lines.push('## الخلاصة', '', review.ai.summary, '', ...(review.ai.plan?.length ? ['## خطة الإصلاح', '', ...review.ai.plan.map((step, index) => `${index + 1}. ${step}`), ''] : []));
  for (const finding of findings) {
    lines.push(`## ${finding.check} · ${finding.title}`, '', `- الخطورة: ${SEVERITY[finding.severity]} · ${CONFIDENCE[finding.confidence] || ''}${finding.source === 'ai' ? ' · إضافة AI' : ''}`, `- الموقع: \`${tableName(finding.tableId)}${finding.columnName ? `.${finding.columnName}` : ''}\``, '', finding.detail, '');
    for (const item of finding.evidence || []) lines.push(`- ${item.file ? `\`${item.file}:${item.line}\` ` : ''}\`${item.text}\``);
    if (finding.fix?.sql) lines.push('', '```sql', finding.fix.sql, '```');
    lines.push('');
  }
  if (accepted.length) {
    lines.push('## مخاطر مقبولة', '');
    for (const finding of accepted) lines.push(`- **${finding.check}** · ${finding.title} · \`${tableName(finding.tableId)}${finding.columnName ? `.${finding.columnName}` : ''}\` — ${acceptedIds[finding.id].reason} (${new Date(acceptedIds[finding.id].at).toLocaleDateString('ar')})`);
    lines.push('');
  }
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  link.href = url; link.download = `${slug(activeWorkspace()?.name || 'database')}-review.md`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function openReview() {
  closeHeaderMenus(); renderReview(); openDialog($('reviewDialog'));
  if (!review.pending && (review.workspaceId !== state.workspaceId || !review.result)) runDatabaseReview();
}
