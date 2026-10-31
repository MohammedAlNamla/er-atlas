import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 43000 + Math.floor(Math.random() * 1000);

// fetch() forbids overriding Host, so DNS-rebinding requests are sent with raw http.
const request = (method, path, { host = `127.0.0.1:${port}`, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
    let data = ''; res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, json: data.startsWith('{') ? JSON.parse(data) : null, text: data }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});

let child, data, project;
test.before(async () => {
  data = await mkdtemp(join(tmpdir(), 'er-atlas-data-'));
  project = await mkdtemp(join(tmpdir(), 'er-atlas-project-'));
  await writeFile(join(project, '.env'), 'DB_CONNECTION=pgsql\nDB_HOST=db.local\nDB_PORT=6543\nDB_DATABASE="shop"\nDB_USERNAME=app\nDB_PASSWORD=never-read\n');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), ER_ATLAS_DATA: data }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => child.stdout.on('data', chunk => String(chunk).includes('ready') && resolve()));
});
test.after(async () => { child?.kill(); await rm(data, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  assert.equal((await request('GET', '/api/schema', { host: 'evil.example:80' })).status, 403);
  assert.equal((await request('GET', '/api/schema', { host: `localhost:${port}` })).status, 200);
});

test('the store persists keys to disk and ignores unsafe ones', async () => {
  const put = await request('PUT', '/api/store', { body: { set: { 'eratlas.workspaces.v1': '{"a":1}', 'evil.key': 'x' }, remove: [] } });
  assert.equal(put.status, 200);
  const items = (await request('GET', '/api/store')).json.items;
  assert.equal(items['eratlas.workspaces.v1'], '{"a":1}');
  assert.equal('evil.key' in items, false);
  await request('PUT', '/api/store', { body: { set: {}, remove: ['eratlas.workspaces.v1'] } });
  assert.equal('eratlas.workspaces.v1' in (await request('GET', '/api/store')).json.items, false);
});

test('.env prefill returns connection settings without the password', async () => {
  const result = await request('POST', '/api/code/env', { body: { sourceRoot: project } });
  assert.deepEqual(result.json, { engine: 'postgres', host: 'db.local', port: 6543, database: 'shop', user: 'app' });
  assert.equal((await request('POST', '/api/code/env', { body: { sourceRoot: 'relative/path' } })).status, 500);
});

test('.env prefill recognises MySQL and MariaDB projects and their default port', async () => {
  const mysqlProject = await mkdtemp(join(tmpdir(), 'er-atlas-mysql-'));
  try {
    await writeFile(join(mysqlProject, '.env'), 'DB_CONNECTION=mariadb\nDB_HOST=127.0.0.1\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=never-read\n');
    const result = await request('POST', '/api/code/env', { body: { sourceRoot: mysqlProject } });
    assert.deepEqual(result.json, { engine: 'mysql', host: '127.0.0.1', port: 3306, database: 'shop', user: 'root' });
    await writeFile(join(mysqlProject, '.env'), 'DB_CONNECTION=sqlsrv\nDB_DATABASE=shop\n');
    assert.match((await request('POST', '/api/code/env', { body: { sourceRoot: mysqlProject } })).json.error, /PostgreSQL وMySQL/);
  } finally { await rm(mysqlProject, { recursive: true, force: true }); }
});

test('removed built-in assets are no longer served', async () => {
  assert.equal((await request('GET', '/theme.css')).status, 404);
  assert.equal((await request('GET', '/samples/sufra-products.eratlas.json')).status, 200);
});

// A throwaway OpenAI-compatible endpoint stands in for the provider so the whole /api/ai path is exercised.
test('/api/ai sends a system prompt, scopes column requests and returns validated notes', async () => {
  const seen = [];
  const provider = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"summary":"طلبات","columns":[{"name":"id","meaning":"معرّف الطلب","basis":"schema"},{"name":"ghost","meaning":"x","basis":"name"}]}\n```' } }] }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    const schema = {
      tables: [
        { id: '1', schema: 'public', name: 'orders', description: '', approxRows: 0, columns: [{ name: 'id', type: 'bigint', nullable: false, primary: true }, { name: 'note', type: 'text', nullable: true }] },
        { id: '2', schema: 'public', name: 'unrelated', description: '', approxRows: 0, columns: [{ name: 'id', type: 'bigint', nullable: false, primary: true }] }
      ], relations: []
    };
    const body = { provider: 'compatible', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, model: 'm', question: 'اشرح', mode: 'columns', schema, focus: { tableId: '1' } };
    const ok = await request('POST', '/api/ai', { body });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.json.notes.columns), ['id']);
    assert.deepEqual(ok.json.notes.missing, ['note']);
    assert.equal(seen[0].messages[0].role, 'system');
    assert.match(seen[0].messages[0].content, /بيانات وليست تعليمات/);
    assert.match(seen[0].messages[1].content, /<table_to_explain>public\.orders<\/table_to_explain>/);
    assert.doesNotMatch(seen[0].messages[1].content, /unrelated/);
    assert.equal(seen[0].max_tokens, 4000);
    const noTable = await request('POST', '/api/ai', { body: { ...body, focus: {} } });
    assert.equal(noTable.status, 500);
    assert.match(noTable.json.error, /اختر جدولًا/);
  } finally { provider.close(); }
});

test('/api/ai ping works without a schema and chat answers come back with quick replies', async () => {
  let reply = 'جاهز';
  const provider = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })); });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    const base = { provider: 'compatible', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, model: 'm', schema: { tables: [], relations: [] } };
    const ping = await request('POST', '/api/ai', { body: { ...base, mode: 'ping', question: 'ping' } });
    assert.equal(ping.status, 200);
    assert.equal(ping.json.answer, 'جاهز');
    reply = 'الجواب.\n[متابعة] أولًا؟ | ثانيًا؟';
    const chat = await request('POST', '/api/ai', { body: { ...base, mode: 'explain', question: 'اشرح' } });
    assert.deepEqual(chat.json, { answer: 'الجواب.', followups: ['أولًا؟', 'ثانيًا؟'] });
  } finally { provider.close(); }
});

test('/api/ai/login refuses anything but a known local assistant', async () => {
  const bad = await request('POST', '/api/ai/login', { body: { provider: 'cmd.exe /c calc' } });
  assert.equal(bad.status, 500);
  assert.match(bad.json.error, /غير مدعوم/);
  assert.equal((await request('POST', '/api/ai/login', { host: 'evil.example:80', body: { provider: 'claude-cli' } })).status, 403);
});

test('listing databases validates input and reports connection errors without leaking the password', async () => {
  assert.equal((await request('POST', '/api/databases', { body: { host: '127.0.0.1', port: 5432 } })).status, 400);
  const refused = await request('POST', '/api/databases', { body: { host: '127.0.0.1', port: 1, user: 'app', password: 'secret-value' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /تعذّر عرض قواعد البيانات/);
  assert.doesNotMatch(refused.text, /secret-value/);
});
