export const topicColors = ['#7864c8', '#347f8b', '#987037', '#ad5675', '#527f49', '#596daf', '#8a618e', '#746C8D'];

export function normalizeTopics(rows, tableIds, { suggested = false } = {}) {
  if (!Array.isArray(rows)) throw new Error('المواضيع ليست قائمة صالحة');
  const validIds = new Set(tableIds), usedIds = new Set();
  const groups = rows.slice(0, suggested ? 21 : 100).filter(row => row && typeof (suggested ? row.name : row.label) === 'string' && Array.isArray(suggested ? row.tableIds : row.ids)).map((row, index) => {
    let id = suggested ? `ai:${crypto.randomUUID()}` : String(row.id || '');
    if (!id || id === 'all' || usedIds.has(id)) id = `custom:${crypto.randomUUID()}`;
    usedIds.add(id);
    return { id, label: (suggested ? row.name : row.label).trim().slice(0, 50) || 'موضوع جديد',
      color: /^#[0-9a-f]{6}$/i.test(row.color || '') ? row.color : topicColors[index % topicColors.length],
      ids: [...new Set((suggested ? row.tableIds : row.ids).filter(id => validIds.has(id)))],
      ...(typeof row.reason === 'string' ? { reason: row.reason.slice(0, 400) } : {}),
      ...(Array.isArray(row.moduleIds) ? { moduleIds: row.moduleIds.filter(id => typeof id === 'string').slice(0, 20) } : {}),
      ...(Array.isArray(row.evidence) ? { evidence: row.evidence.filter(item => item && typeof item.file === 'string' && Number.isInteger(item.line) && item.line > 0).slice(0, 8).map(item => ({ file: item.file.slice(0, 300), line: item.line, symbol: String(item.symbol || '').slice(0, 100) })) } : {}) };
  }).filter(group => !suggested || group.ids.length);
  if (suggested) {
    if (!groups.length) throw new Error('لم يرجع AI مواضيع تحتوي جداول صالحة');
    const covered = new Set(groups.flatMap(group => group.ids));
    const remaining = [...validIds].filter(id => !covered.has(id));
    if (remaining.length) groups.push({ id: `ai:${crypto.randomUUID()}`, label: 'جداول أخرى', color: '#746C8D', ids: remaining });
  }
  return groups;
}

// The catch-all topics a table lands in when nothing placed it.
export const isLeftoverTopic = group => group.id === 'other' || ['جداول أخرى', 'جداول تحتاج مراجعة'].includes(group.label);

// Polymorphic tables (events, comments, media) join each topic that holds one of their owners and
// then leave the catch-all topic. With onlyOrphans, a table some real topic already holds is left
// where the user put it, so curated topics are never rewritten.
export function attachLinkedTables(groups, links, { onlyOrphans = false } = {}) {
  const real = groups.filter(group => group.id !== 'all' && !isLeftoverTopic(group));
  const placed = new Set(), held = new Set(real.flatMap(group => [...group.ids]));
  for (const link of links) {
    if (onlyOrphans && held.has(link.source)) continue;
    for (const group of real) if (group.ids.has(link.target) && !group.ids.has(link.source)) { group.ids.add(link.source); placed.add(link.source); }
  }
  for (const group of groups) if (isLeftoverTopic(group)) for (const id of placed) group.ids.delete(id);
  return groups.filter(group => !isLeftoverTopic(group) || group.ids.size);
}

export function parseTopicSuggestions(answer, tableIds) {
  const cleaned = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  return normalizeTopics(Array.isArray(parsed) ? parsed : parsed?.topics, tableIds, { suggested: true });
}
