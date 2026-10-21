// The AI layer of the database review. It never replaces the deterministic engine: it reads the
// engine's findings, the playbooks' judging rules and the exact evidence, then ranks, explains
// and may add findings, each of which must cite evidence we sent. Anything else is dropped.
import { CHECKS, checkById } from './catalog.js';
import { buildSchemaText } from '../ai-prompts.js';

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const evidenceKey = item => `${item.file}:${item.line}`;

export const REVIEW_INSTRUCTION = [
  'أنت مراجع قواعد بيانات PostgreSQL وتطبيقات Laravel بخبرة عالية، تعمل داخل ER Atlas.',
  'أمامك: أدلة الخبرة (playbooks) التي كتبناها لكل تخصص، ونتائج محرك فحص محلي حتمي، والأدلة الحرفية من المخطط والكود والإحصاءات.',
  'مهمتك: (1) رتّب النتائج حسب الأثر الفعلي على البيانات والأمان والأداء، (2) اشرح سبب أولوية كل واحدة في جملة، (3) أضف فقط ما فات المحرك بشرط أن تستند كل إضافة إلى دليل موجود حرفيًا في <evidence> أو إلى حقيقة مكتوبة في <schema>، (4) ضع خطة إصلاح قصيرة بالترتيب.',
  'التزم بقواعد "How to judge (AI)" في كل دليل خبرة. لا تخمّن قيمًا وقت التشغيل، ولا تقدّر أزمنة أو نسب تحسن، ولا تخترع ملفات أو أسطرًا أو جداول أو أعمدة.',
  'أي إضافة لا تشير إلى check id موجود في الكتالوج ودليل موجود ستُحذف تلقائيًا. الثقة في إضافاتك medium أو low فقط.',
  'أعد JSON فقط دون أي نص خارجه بالشكل:',
  '{"summary":"فقرة عربية من 2-4 جمل عن حالة القاعدة وأهم المخاطر","order":[{"id":"<finding id حرفيًا>","why":"جملة"}],"extra":[{"check":"IX02","tableId":"<id>","columnName":"<اسم أو فارغ>","title":"عنوان قصير","detail":"جملة واحدة","confidence":"medium","evidence":[{"file":"app/...php","line":12}]}],"plan":["خطوة مرتبة 1","خطوة 2"]}'
].join('\n');

// Which playbook text to send: the judging rules of every skill in play, plus the full section of
// each check that produced a finding (capped so a big review still fits the prompt).
function playbookText(skills, findings, budget = 26000) {
  const usedSkills = new Set(findings.map(finding => finding.skill));
  const usedChecks = [...new Set(findings.map(finding => finding.check))];
  const parts = [];
  for (const skill of skills.values()) {
    if (usedSkills.size && !usedSkills.has(skill.id)) continue;
    parts.push(`### ${skill.id} — ${skill.title}\n${skill.judge}`);
  }
  for (const id of usedChecks) {
    for (const skill of skills.values()) {
      const check = skill.checks.get(id);
      if (check) parts.push(`### ${id} · ${check.title}\n${check.markdown.replace(/```[\s\S]*?```/g, '').trim()}`);
    }
  }
  let text = '';
  for (const part of parts) { if (text.length + part.length > budget) break; text += `${part}\n\n`; }
  return text.trim();
}

function compactFinding(finding) {
  return { id: finding.id, check: finding.check, severity: finding.severity, confidence: finding.confidence, tableId: finding.tableId,
    ...(finding.columnName ? { columnName: finding.columnName } : {}), title: clip(finding.title, 160), detail: clip(finding.detail, 400),
    evidence: (finding.evidence || []).slice(0, 4).map(item => ({ kind: item.kind, text: clip(item.text, 240), ...(item.file ? { file: item.file, line: item.line } : {}) })) };
}

// Code lines the AI may cite: every line behind a finding, then extra facts (queries, raw SQL),
// deduplicated and capped.
export function collectEvidence(findings, extra = [], limit = 120) {
  const seen = new Map();
  for (const item of [...findings.flatMap(finding => finding.evidence || []), ...extra]) {
    if (!item?.file || !Number.isInteger(Number(item.line))) continue;
    const key = evidenceKey(item);
    if (!seen.has(key)) seen.set(key, { file: item.file, line: Number(item.line), text: clip(item.text, 240) });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

export function buildReviewPrompt({ schema, findings, skills, evidence = [], question = '' }) {
  const list = findings.slice(0, 80);
  const { text } = buildSchemaText(schema, { budget: 60000 });
  const parts = [`<task>\n${REVIEW_INSTRUCTION}\n</task>`,
    `<catalog>\n${CHECKS.map(check => `${check.id} ${check.skill} ${check.severity} — ${check.title}`).join('\n')}\n</catalog>`,
    `<playbooks>\n${playbookText(skills, list)}\n</playbooks>`,
    `<schema format="sql-like">\n${text}\n</schema>`,
    `<findings format="json" count="${findings.length}"${findings.length > list.length ? ` shown="${list.length}"` : ''}>\n${JSON.stringify(list.map(compactFinding))}\n</findings>`];
  if (evidence.length) parts.push(`<evidence>\n${evidence.map(item => `${item.file}:${item.line} — ${item.text}`).join('\n')}\n</evidence>`);
  parts.push(`<question>\n${clip(question, 1000) || 'راجع القاعدة ورتّب النتائج وضع خطة الإصلاح.'}\n</question>`);
  return parts.join('\n');
}

const CONFIDENCE = new Set(['medium', 'low']);
// Validates the model's answer against what we sent: unknown ids, checks, tables, columns or
// evidence are dropped, never shown.
export function readReviewAnswer(answer, { schema, findings, evidence }, extractJson) {
  const data = extractJson(answer);
  if (!data || typeof data !== 'object') throw new Error('لم يرجع AI مراجعة صالحة. أعد المحاولة.');
  const known = new Set(findings.map(finding => finding.id)), cited = new Set(evidence.map(evidenceKey));
  const tables = new Map(schema.tables.map(table => [table.id, table]));
  const order = (Array.isArray(data.order) ? data.order : []).filter(item => known.has(item?.id))
    .map(item => ({ id: item.id, why: clip(item.why, 300) })).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const dropped = [];
  const extra = (Array.isArray(data.extra) ? data.extra : []).flatMap((item, index) => {
    const check = checkById.get(item?.check), table = tables.get(item?.tableId);
    const refs = (Array.isArray(item?.evidence) ? item.evidence : []).map(ref => ({ file: String(ref?.file || ''), line: Number(ref?.line) })).filter(ref => cited.has(evidenceKey(ref)));
    const column = item?.columnName ? table?.columns.find(entry => entry.name === item.columnName) : null;
    const problem = !check ? 'فحص غير معروف' : !table ? 'جدول غير موجود' : item?.columnName && !column ? 'عمود غير موجود' : check.needs.includes('code') && !refs.length ? 'بلا دليل من الكود' : '';
    if (problem) { dropped.push({ check: item?.check, reason: problem }); return []; }
    return [{ id: `AI:${check.id}:${table.id}:${column?.name || index}`, check: check.id, skill: check.skill, severity: check.severity,
      confidence: CONFIDENCE.has(item.confidence) ? item.confidence : 'low', tableId: table.id, ...(column ? { columnName: column.name } : {}),
      title: clip(item.title, 160) || check.title, detail: clip(item.detail, 400), source: 'ai',
      evidence: refs.length ? refs.map(ref => ({ kind: 'code', file: ref.file, line: ref.line, text: evidence.find(entry => evidenceKey(entry) === evidenceKey(ref))?.text || '' })) : [{ kind: 'schema', text: `${table.name}${column ? `.${column.name}` : ''}` }] }];
  });
  return { summary: clip(data.summary, 1200), order, extra, plan: (Array.isArray(data.plan) ? data.plan : []).map(step => clip(step, 300)).filter(Boolean).slice(0, 12), dropped };
}
