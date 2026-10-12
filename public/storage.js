// Workspaces, drafts and layouts live in a JSON file next to the server so they
// survive a full browser, a quota error, or a different browser. localStorage is
// kept as a fast mirror and as the fallback when the server cannot be reached.
const PREFIX = 'eratlas.';
const cache = new Map();
const pending = { set: new Set(), remove: new Set() };
let timer = null, serverAvailable = false;

function mirror(action) { try { action(localStorage); } catch { /* quota exceeded or storage blocked */ } }

async function flush() {
  timer = null;
  if (!serverAvailable || (!pending.set.size && !pending.remove.size)) return;
  const body = { set: Object.fromEntries([...pending.set].map(key => [key, cache.get(key)])), remove: [...pending.remove] };
  pending.set.clear(); pending.remove.clear();
  try {
    const response = await fetch('/api/store', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error();
  } catch {
    // Re-queue so the next write retries; local mirror still holds the data.
    for (const [key, value] of Object.entries(body.set)) if (cache.get(key) === value) pending.set.add(key);
    for (const key of body.remove) if (!cache.has(key)) pending.remove.add(key);
  }
}
function schedule() { if (!timer) timer = setTimeout(flush, 350); }
window.addEventListener('pagehide', () => {
  if (!serverAvailable || (!pending.set.size && !pending.remove.size)) return;
  const body = JSON.stringify({ set: Object.fromEntries([...pending.set].map(key => [key, cache.get(key)])), remove: [...pending.remove] });
  fetch('/api/store', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 }).catch(() => {});
});

export const store = {
  getItem: key => cache.has(key) ? cache.get(key) : null,
  setItem(key, value) {
    value = String(value);
    cache.set(key, value); mirror(storage => storage.setItem(key, value));
    pending.remove.delete(key); pending.set.add(key); schedule();
  },
  removeItem(key) {
    cache.delete(key); mirror(storage => storage.removeItem(key));
    pending.set.delete(key); pending.remove.add(key); schedule();
  },
  keys: (prefix = '') => [...cache.keys()].filter(key => key.startsWith(prefix))
};

// Merge order: the server file wins; keys that only exist in this browser (older
// versions of the app) are uploaded once so nothing is lost on upgrade.
export async function initStore() {
  let remote = null;
  try {
    const response = await fetch('/api/store');
    if (response.ok) remote = (await response.json()).items || {};
  } catch { /* offline: use the browser copy only */ }
  serverAvailable = remote !== null;
  mirror(storage => { for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(PREFIX)) cache.set(key, storage.getItem(key)); } });
  for (const [key, value] of Object.entries(remote || {})) cache.set(key, value);
  for (const [key, value] of [...cache]) if (serverAvailable && !(key in remote) && value != null) pending.set.add(key);
  if (pending.set.size) schedule();
  return serverAvailable;
}
