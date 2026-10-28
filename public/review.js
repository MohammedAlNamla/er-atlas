// The database review sheet: the deterministic engine's findings (schema, code, live statistics,
// draft), each traced to its check and playbook, with one-click draft fixes and an optional AI pass.
import { button as uiButton, notice, tabs as uiTabs, modalHeader, modalFooter, openDialog } from './ui.js';
import { $, state, activeWorkspace, el, sprite, headerIcon, copyText, showToast, slug } from './core.js';
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

const review = { result: null, ai: null, pending: false, aiPending: false, error: '', filter: 'all', skill: 'all', open: new Set(), guides: new Map(), controller: null };
const sourceRoot = () => (activeWorkspace()?.sourceRoot || $('topicSourceRoot')?.value || '').trim();
const tableName = id => state.schema.tables.find(table => table.id === id)?.name || id;

export async function runDatabaseReview() {
  syncCodeSource();
  review.pending = true; review.error = ''; review.ai = null; renderReview();
  try {
    const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      schema: state.schema, base: state.base, operations: state.operations.slice(0, state.cursor), sourceRoot: sourceRoot(), stats: state.connectionLive }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذّرت المراجعة');
    review.result = data; review.workspaceId = state.workspaceId;
  } catch (error) { review.error = error.message; }
  finally { review.pending = false; renderReview(); }
}

async function runAiReview() {
  if (!review.result?.findings || review.aiPending) return;
  const findings = review.result.findings;
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
  if (rank !== undefined) meta.prepend(el('span', 'review-rank', `#${rank + 1}`));
  card.append(head, meta, el('p', 'review-detail', finding.detail));
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
  card.append(actions, details);
  return card;
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
  const findings = data ? orderedFindings() : [];
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
    if (!findings.length) body.append(notice('لا توجد ملاحظات', 'كل الفحوص التي توفرت مدخلاتها نجحت. أكمل المدخلات الناقصة أعلاه لفحص أعمق.', 'success'));
    else {
      const filter = counts[review.filter] ? review.filter : 'all';
      body.append(uiTabs([['all', `الكل ${findings.length}`], ...Object.keys(SEVERITY).filter(key => counts[key]).map(key => [key, `${SEVERITY_PLURAL[key]} ${counts[key]}`])], filter, value => { review.filter = value; renderReview(); }));
      const skills = [...new Set(findings.map(item => item.skill))];
      const chips = el('div', 'review-skills');
      for (const id of ['all', ...skills]) {
        const chip = uiButton(id === 'all' ? 'كل التخصصات' : `${SKILL_TITLES[id] || id} ${findings.filter(item => item.skill === id).length}`, () => { review.skill = id; renderReview(); }, `review-skill${(review.skill === id || (id === 'all' && !skills.includes(review.skill))) ? ' active' : ''}`);
        chips.append(chip);
      }
      body.append(chips);
      const list = el('ol', 'review-list'), priority = new Map((review.ai?.order || []).map((item, index) => [item.id, index]));
      for (const finding of findings.filter(item => (filter === 'all' || item.severity === filter) && (!skills.includes(review.skill) || item.skill === review.skill))) list.append(findingCard(finding, priority.get(finding.id)));
      body.append(list);
      if (review.ai?.dropped?.length) body.append(el('p', 'field-hint', `حُذفت ${review.ai.dropped.length} إضافات من AI لأنها بلا دليل يمكن التحقق منه.`));
    }
  }
  const fixable = findings.filter(item => item.fix?.operation);
  const actions = [];
  if (fixable.length > 1) actions.push(uiButton(`أضف كل الإصلاحات (${fixable.length})`, () => stageFixes(fixable), 'primary-button'));
  actions.push(uiButton(data ? 'أعد الفحص' : 'ابدأ المراجعة', runDatabaseReview, fixable.length > 1 || !data ? (data ? 'secondary-button' : 'primary-button') : 'secondary-button'));
  if (data && findings.length) {
    actions.push(review.aiPending ? uiButton('إيقاف مراجعة AI', () => review.controller?.abort(), 'secondary-button') : uiButton(review.ai?.summary ? 'أعد مراجعة AI' : 'راجع بالـAI', runAiReview, 'secondary-button'));
    actions.push(uiButton('تنزيل التقرير', downloadReport, 'ghost-button'));
  }
  root.append(body, modalFooter(actions, review.aiPending ? 'المراجع يقرأ الأدلة ويرتّب النتائج…' : 'الإصلاحات تُضاف إلى المسودة فقط، ولا يُكتب شيء في قاعدة البيانات.'));
}

function downloadReport() {
  const findings = orderedFindings(), lines = [`# مراجعة قاعدة ${state.schema.database || ''}`, '', `${new Date().toLocaleString('ar')}`, ''];
  if (review.ai?.summary) lines.push('## الخلاصة', '', review.ai.summary, '', ...(review.ai.plan?.length ? ['## خطة الإصلاح', '', ...review.ai.plan.map((step, index) => `${index + 1}. ${step}`), ''] : []));
  for (const finding of findings) {
    lines.push(`## ${finding.check} · ${finding.title}`, '', `- الخطورة: ${SEVERITY[finding.severity]} · ${CONFIDENCE[finding.confidence] || ''}${finding.source === 'ai' ? ' · إضافة AI' : ''}`, `- الموقع: \`${tableName(finding.tableId)}${finding.columnName ? `.${finding.columnName}` : ''}\``, '', finding.detail, '');
    for (const item of finding.evidence || []) lines.push(`- ${item.file ? `\`${item.file}:${item.line}\` ` : ''}\`${item.text}\``);
    if (finding.fix?.sql) lines.push('', '```sql', finding.fix.sql, '```');
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
