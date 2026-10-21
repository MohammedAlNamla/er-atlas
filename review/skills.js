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
  let judge = '';
  const checks = new Map();
  for (const section of sections.slice(1)) {
    const heading = section.slice(0, section.indexOf('\n') === -1 ? section.length : section.indexOf('\n'));
    const content = section.slice(heading.length).trim();
    if (heading === '## How to judge (AI)') judge = content;
    const check = CHECK_HEADING.exec(heading);
    if (check) checks.set(check[1], { id: check[1], title: check[2].trim(), markdown: content });
  }
  return { id: meta.id, title: meta.title, version: Number(meta.version) || 1, appliesTo: meta.applies_to || '', intro, judge, checks };
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

// The part of a playbook a reader needs for one check: the skill's judging rules plus the check section.
export function checkGuide(skills, checkId) {
  for (const skill of skills.values()) {
    const check = skill.checks.get(checkId);
    if (check) return { skill: skill.id, skillTitle: skill.title, title: check.title, markdown: check.markdown };
  }
  return null;
}
