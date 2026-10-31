// The deterministic database review. Every check in review/catalog.js is implemented here (or in
// review/checks/*) exactly as its playbook's "Detect" and "Not a finding when" sections say, so a
// finding can be traced to the rule that produced it and re-run with the same result. The AI layer
// (review/ai-review.js) only ranks and explains these findings; it never replaces them.
import { CHECKS } from './catalog.js';
import { schemaChecks } from './checks/schema.js';
import { codeChecks } from './checks/code.js';
import { draftChecks } from './checks/draft.js';
import { reviewContext, reviewSettings, indexesRead } from './checks/util.js';

// Checks whose verdict depends on knowing a table's indexes.
const INDEX_CHECKS = new Set(['IX01', 'IX02', 'IX03', 'IX04']);

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };
const sortFindings = (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]
  || String(a.tableId).localeCompare(String(b.tableId)) || a.id.localeCompare(b.id);

// Runs every check whose inputs are present; the others are reported as skipped with the reason,
// so the UI can say what a fuller review would add. A project's settings switch checks off and set
// their severity; the playbook's own severity stays on the finding as defaultSeverity.
export function runReview(input) {
  const settings = reviewSettings(input.settings);
  const ctx = reviewContext({ ...input, settings });
  const disabled = new Set(settings.disabled);
  const available = { schema: true, code: Boolean(ctx.facts), stats: Boolean(ctx.stats), draft: ctx.operations.length > 0 };
  const implementations = { ...schemaChecks, ...codeChecks, ...draftChecks };
  const findings = [], ran = [], skipped = [];
  for (const check of CHECKS) {
    if (disabled.has(check.id)) { skipped.push({ check: check.id, reason: 'disabled' }); continue; }
    const missing = check.needs.find(need => !available[need]);
    if (missing) { skipped.push({ check: check.id, reason: `no ${missing}` }); continue; }
    if (INDEX_CHECKS.has(check.id) && !ctx.tables.some(indexesRead)) { skipped.push({ check: check.id, reason: 'no indexes' }); continue; }
    const run = implementations[check.id];
    if (!run) { skipped.push({ check: check.id, reason: 'not implemented' }); continue; }
    ran.push(check.id);
    findings.push(...run(ctx));
  }
  const seen = new Set();
  const unique = findings.filter(finding => !seen.has(finding.id) && seen.add(finding.id)).map(finding => {
    const chosen = settings.severity[finding.check];
    return chosen && chosen !== finding.severity ? { ...finding, severity: chosen, defaultSeverity: finding.severity } : finding;
  });
  return { engine: ctx.engine, findings: unique.sort(sortFindings), coverage: { ran, skipped }, settings };
}
