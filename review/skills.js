// Review playbooks (review/skills/*.md): one per skill, parsed into their parts so the UI can show
// a check's reasoning and the AI reviewer gets exactly the judging rules it needs.
import { readFile } from 'node:fs/promises';
import { SKILLS } from './catalog.js';

const CHECK_HEADING = /^## ([A-Z]{2,3}\d{2}) · (.+)$/;

export function parseSkill(text) {
  const source = String(text).replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(source);
  const meta = Object.fromEntries((front?.[1] || '').split('\n').map(line => /^([\w_]+):\s*(.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2].trim()]));
  const body = front ? source.slice(front[0].length) : source;
  const sections = body.split(/^(?=## )/m);
  const intro = sections[0].trim().replace(/^# .*\n?/, '').trim();
  let judge = '', judgeMysql = '';
  const checks = new Map();
  for (const section of sections.slice(1)) {
    const heading = section.slice(0, section.indexOf('\n') === -1 ? section.length : section.indexOf('\n'));
    const content = section.slice(heading.length).trim();
    if (heading === '## How to judge (AI)') judge = content;
    if (heading === '## How to judge on MySQL (AI)') judgeMysql = content;
    const check = CHECK_HEADING.exec(heading);
    if (check) checks.set(check[1], { id: check[1], title: check[2].trim(), markdown: content });
  }
  return { id: meta.id, title: meta.title, version: Number(meta.version) || 1, appliesTo: meta.applies_to || '', intro, judge, judgeMysql, checks };
}

let cache = null;
// Missing playbooks are not fatal: the engine still runs, the UI just has less to explain.
export async function loadSkills({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const loaded = new Map();
  for (const skill of SKILLS) {
    try { loaded.set(skill.id, parseSkill(await readFile(new URL(`./skills/${skill.id}.md`, import.meta.url), 'utf8'))); }
    catch { /* playbook not written yet */ }
  }
  return (cache = loaded);
}

// A check section for one engine. The "- **MySQL:**" field says where MySQL/MariaDB differ: PostgreSQL
// readers do not need it; MySQL readers get it first, since it can overturn the rest of the section.
const MYSQL_FIELD = /^- \*\*MySQL:\*\*[ \t]*(.*)\n?/m;
export function forEngine(markdown, engine = 'postgres') {
  const note = MYSQL_FIELD.exec(markdown)?.[1]?.trim();
  const rest = markdown.replace(MYSQL_FIELD, '');
  return engine === 'mysql' && note ? `**على MySQL / MariaDB:** ${note}\n\n${rest}` : rest;
}

// The part of a playbook a reader needs for one check, in the engine's own terms.
export function checkGuide(skills, checkId, engine = 'postgres') {
  for (const skill of skills.values()) {
    const check = skill.checks.get(checkId);
    if (check) return { skill: skill.id, skillTitle: skill.title, title: check.title, engine: engine === 'mysql' ? 'mysql' : 'postgres', markdown: forEngine(check.markdown, engine) };
  }
  return null;
}
