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
  assert.deepEqual(result.json, { host: 'db.local', port: 6543, database: 'shop', user: 'app' });
  assert.equal((await request('POST', '/api/code/env', { body: { sourceRoot: 'relative/path' } })).status, 500);
});

test('removed built-in assets are no longer served', async () => {
  assert.equal((await request('GET', '/theme.css')).status, 404);
  assert.equal((await request('GET', '/samples/sufra-products.eratlas.json')).status, 200);
});
