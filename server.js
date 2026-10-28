import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { extname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Pool } from 'pg';
import { createPool as createMysqlPool } from 'mysql2/promise';
import { planChanges } from './planner.js';
import { readSchema, listDatabases, readMorphTypes } from './pg-schema.js';
import { readMysqlSchema, listMysqlDatabases, readMysqlMorphTypes } from './mysql-schema.js';
import { askLocal, cliStatus, localProviders, openLoginTerminal } from './local-ai.js';
import { analyzeSource, compactCodeContext, groundTopicSuggestions } from './code-context.js';
import { MODES, SYSTEM_PROMPT, TOKEN_LIMITS, buildPrompt, extractJson, readColumnNotes, splitFollowups } from './ai-prompts.js';
import { loadSkills, checkGuide } from './review/skills.js';
import { buildReviewPrompt, readReviewAnswer } from './review/ai-review.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = Number(process.env.PORT || 4317);
const sourceSettings = await readFile(new URL('./source-projects.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => ({}));
let pool = null;
// 'postgres' or 'mysql': which reader the open pool belongs to.
let engine = 'postgres';
let databaseLabel = '';
let connectionId = '';
const dataFile = join(process.env.ER_ATLAS_DATA || fileURLToPath(new URL('./data', import.meta.url)), 'store.json');
let storeCache = null, storeQueue = Promise.resolve();
const storeKeyPattern = /^eratlas\.[\w.:-]{1,300}$/;

async function loadStore() {
  if (storeCache) return storeCache;
  try { storeCache = JSON.parse(await readFile(dataFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.error(`Could not read ${dataFile}: ${error.message}`); storeCache = {}; }
  return storeCache;
}
function updateStore({ set = {}, remove = [] }) {
  const run = async () => {
    const items = await loadStore();
    for (const [key, value] of Object.entries(set)) if (storeKeyPattern.test(key) && typeof value === 'string') items[key] = value;
    for (const key of remove) if (storeKeyPattern.test(key)) delete items[key];
    await mkdir(join(dataFile, '..'), { recursive: true });
    const temporary = `${dataFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(items));
    await rename(temporary, dataFile);
  };
  storeQueue = storeQueue.then(run, run);
  return storeQueue;
}

// Reads only the non-secret database settings from a Laravel project's .env.
async function readEnvConnection(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot) || sourceRoot.length > 1000) throw new Error('حدد المسار الكامل لمشروع Laravel');
  const text = await readFile(join(resolve(sourceRoot), '.env'), 'utf8').catch(() => { throw new Error('لم أجد ملف .env في مجلد المشروع'); });
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(DB_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const engine = /^(?:mysql|mariadb)/i.test(values.DB_CONNECTION || '') ? 'mysql' : 'postgres';
  if (values.DB_CONNECTION && engine === 'postgres' && !/^(?:pgsql|postgres)/i.test(values.DB_CONNECTION)) throw new Error(`قاعدة المشروع من نوع ${values.DB_CONNECTION}، والمدعوم PostgreSQL وMySQL`);
  if (!values.DB_DATABASE) throw new Error('لا يحتوي .env على DB_DATABASE');
  return { engine, host: values.DB_HOST || 'localhost', port: Number(values.DB_PORT) || (engine === 'mysql' ? 3306 : 5432), database: values.DB_DATABASE, user: values.DB_USERNAME || '' };
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };
const paths = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/model.js': 'model.js',
  '/topics.js': 'topics.js',
  '/router.js': 'router.js',
  '/route-worker.js': 'route-worker.js',
  '/atlas.css': 'atlas.css',
  '/ui.js': 'ui.js',
  '/favicon.svg': 'favicon.svg',
  '/storage.js': 'storage.js',
  '/workspace-io.js': 'workspace-io.js',
  '/lint.js': 'lint.js',
  '/exporters.js': 'exporters.js',
  '/core.js': 'core.js',
  '/chrome.js': 'chrome.js',
  '/workspaces.js': 'workspaces.js',
  '/morphs.js': 'morphs.js',
  '/dialect.js': 'dialect.js',
  '/views.js': 'views.js',
  '/layout.js': 'layout.js',
  '/canvas.js': 'canvas.js',
  '/edges.js': 'edges.js',
  '/inspector.js': 'inspector.js',
  '/notes.js': 'notes.js',
  '/editor.js': 'editor.js',
  '/groups.js': 'groups.js',
  '/chat.js': 'chat.js',
  '/ai.js': 'ai.js',
  '/sheets.js': 'sheets.js',
  '/commands.js': 'commands.js',
  '/connect.js': 'connect.js',
  '/review.js': 'review.js'
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 2000000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('الطلب كبير جدًا');
  }
  return JSON.parse(data || '{}');
}

const getSchema = db => (engine === 'mysql' ? readMysqlSchema : readSchema)(db, { database: databaseLabel, source: connectionId });
// Every connection is read-only, short-lived on failure, and never keeps the password beyond the pool.
function connectionSettings(body) {
  if (body.engine === 'mysql') return mysqlSettings(body);
  return {
    engine: 'postgres', host: String(body.host || 'localhost').trim(), port: Number(body.port || 5432),
    database: String(body.database || '').trim(), user: String(body.user || '').trim(),
    password: String(body.password || ''), ssl: body.ssl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 7000, query_timeout: 10000, max: 1, idleTimeoutMillis: 30000,
    options: '-c default_transaction_read_only=on'
  };
}
function mysqlSettings(body) {
  return {
    engine: 'mysql', host: String(body.host || 'localhost').trim(), port: Number(body.port || 3306),
    database: String(body.database || '').trim(), user: String(body.user || '').trim(),
    password: String(body.password || ''), ssl: body.ssl ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 7000, connectionLimit: 1, maxIdle: 1, idleTimeout: 30000, multipleStatements: false,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true
  };
}
// A MySQL session has no read-only default; each pooled connection sets it before its first query.
function openMysql({ engine: _, ...settings }) {
  const next = createMysqlPool(settings);
  next.pool.on('connection', connection => connection.query('SET SESSION TRANSACTION READ ONLY'));
  return next;
}
const openPool = settings => settings.engine === 'mysql' ? openMysql(settings) : new Pool((({ engine: _, ...rest }) => rest)(settings));

async function askProvider(body, signal) {
  signal?.throwIfAborted();
  const { provider, model, key, endpoint, question, schema } = body;
  const mode = MODES.includes(body.mode) ? body.mode : 'explain';
  const local = localProviders.includes(provider);
  if (!local && !['openai', 'anthropic', 'gemini', 'compatible'].includes(provider)) throw new Error('خدمة AI غير مدعومة');
  if ((!local && !model) || !question || !Array.isArray(schema?.tables) || !Array.isArray(schema?.relations)) throw new Error('اختر النموذج واكتب السؤال');
  if (model && (typeof model !== 'string' || model.length > 160 || !/^[\w.\-:/]+$/.test(model))) throw new Error('اسم النموذج غير صالح');
  if (!local && provider !== 'compatible' && !key) throw new Error('أدخل مفتاح API');
  const codeContext = mode === 'topics' ? await analyzeSource(body.sourceRoot, schema.tables) : null;
  const codeText = codeContext ? JSON.stringify(compactCodeContext(codeContext)) : '';
  // The review mode is guided by our playbooks and may only cite findings and evidence we send.
  const review = mode === 'review' ? { findings: (Array.isArray(body.review?.findings) ? body.review.findings : []).slice(0, 200), evidence: (Array.isArray(body.review?.evidence) ? body.review.evidence : []).slice(0, 200) } : null;
  const { prompt } = review ? { prompt: buildReviewPrompt({ schema, findings: review.findings, evidence: review.evidence, skills: await loadSkills(), question }) }
    : buildPrompt({ mode, question, schema, history: mode === 'explain' || mode === 'ideas' ? body.history : [], focus: body.focus, evidence: body.evidence, codeText });
  if (prompt.length > 190000) throw new Error('ملخص الكود كبير جدًا. اختر مخططًا أصغر لتحليل المواضيع.');
  const maxTokens = TOKEN_LIMITS[mode];
  const finish = answer => {
    if (review) return { answer, review: readReviewAnswer(answer, { schema, ...review }, extractJson) };
    if (mode === 'columns') {
      const table = schema.tables.find(item => item.id === body.focus?.tableId);
      return { answer, notes: readColumnNotes(answer, table) };
    }
    if (mode === 'explain' || mode === 'ideas') return splitFollowups(answer);
    return { answer: codeContext ? groundTopicSuggestions(answer, codeContext, schema.tables) : answer,
      ...(codeContext ? { sourceAnalysis: sourceSummary(codeContext) } : {}) };
  };
  if (local) return finish((await askLocal({ provider, model, prompt: `${SYSTEM_PROMPT}\n${prompt}`, signal })).answer);
  let url, headers = { 'Content-Type': 'application/json' }, payload;
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/responses'; headers.Authorization = `Bearer ${key}`;
    payload = { model, instructions: SYSTEM_PROMPT, input: prompt, max_output_tokens: maxTokens };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    payload = { model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] };
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers['x-goog-api-key'] = key;
    payload = { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } };
  } else {
    const base = new URL(String(endpoint || ''));
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('رابط AI غير صالح');
    url = `${base.href.replace(/\/$/, '')}/chat/completions`;
    if (key) headers.Authorization = `Bearer ${key}`;
    payload = { model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }], max_tokens: maxTokens };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`AI: استجابة غير صالحة من الخدمة (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(data.error?.message || (typeof data.error === 'string' ? data.error : '') || `AI: HTTP ${response.status}`);
  const answer = provider === 'openai' ? data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n')
    : provider === 'anthropic' ? data.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')
    : provider === 'gemini' ? data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n')
    : data.choices?.[0]?.message?.content;
  if (!answer) throw new Error('لم يرجع النموذج إجابة نصية');
  return finish(answer);
}

function sourceSummary(context) {
  return { sourceRoot: context.sourceRoot, project: context.project, scannedFiles: context.scannedFiles, parsedFiles: context.parsedFiles,
    matchedTables: context.matchedTableIds.length, unmatchedTableIds: context.unmatchedTableIds, moduleCount: context.modules.length,
    failedFiles: context.failedFiles, skippedFiles: context.skippedFiles, signature: context.signature,
    tables: context.tables, modules: context.modules, morphs: context.morphs, morphMap: context.morphMap, modelTables: context.modelTables };
}

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'مضيف الطلب غير مسموح' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: 'مصدر الطلب غير مسموح' });
    if (req.method === 'POST' && req.url === '/api/connect') {
      const settings = connectionSettings(await readJson(req));
      if (!settings.database || !settings.user || !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) return send(res, 400, { error: 'أدخل اسم القاعدة والمستخدم والمنفذ الصحيح' });
      const next = openPool(settings);
      next.on('error', error => {
        console.error(`Database connection lost: ${error.message}`);
        if (pool === next) { pool = null; databaseLabel = ''; connectionId = ''; }
      });
      const previous = pool, previousEngine = engine;
      try {
        await next.query('SELECT 1');
        pool = next; engine = settings.engine;
        databaseLabel = settings.database;
        connectionId = `${settings.engine === 'mysql' ? 'mysql://' : ''}${settings.host}:${settings.port}/${settings.database}`;
        const schema = await getSchema(pool);
        previous?.end().catch(() => {});
        return send(res, 200, schema);
      } catch (error) {
        if (pool === next) { pool = previous; engine = previousEngine; }
        await next.end().catch(() => {});
        return send(res, 400, { error: `تعذّر الاتصال: ${error.message}` });
      }
    }
    if (req.method === 'POST' && req.url === '/api/review') {
      // Deterministic review: the schema as shown (draft applied), the base as read, the code and live statistics.
      const body = await readJson(req, 20000000), schema = body.schema, base = body.base || schema;
      if (!Array.isArray(schema?.tables) || !Array.isArray(schema?.relations)) return send(res, 400, { error: 'لا يوجد مخطط للمراجعة' });
      const { runReview } = await import('./review/engine.js');
      let code = null, codeError = '';
      if (body.sourceRoot) { try { code = await analyzeSource(body.sourceRoot, base.tables); } catch (error) { codeError = error.message; } }
      let stats = null, statsError = '';
      if (body.stats) {
        if (!pool || !base.source || base.source !== connectionId) statsError = 'الإحصاءات الحية تحتاج اتصالًا مباشرًا بالقاعدة نفسها.';
        else { try { stats = engine === 'mysql' ? await (await import('./mysql-schema.js')).readMysqlStats(pool) : await (await import('./pg-schema.js')).readStats(pool); } catch (error) { statsError = error.message; } }
      }
      const result = runReview({ schema, base, code, stats, operations: Array.isArray(body.operations) ? body.operations : [] });
      return send(res, 200, { ...result, inputs: { code: code ? { project: code.project, scannedFiles: code.scannedFiles, parsedFiles: code.parsedFiles } : null, codeError, stats: Boolean(stats), statsError } });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/review/guide?')) {
      const guide = checkGuide(await loadSkills(), new URL(req.url, 'http://local').searchParams.get('check'));
      return guide ? send(res, 200, guide) : send(res, 404, { error: 'لا يوجد دليل لهذا الفحص بعد' });
    }
    if (req.method === 'POST' && req.url === '/api/databases') {
      const settings = connectionSettings(await readJson(req));
      if (!settings.user || !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) return send(res, 400, { error: 'أدخل المستخدم والمنفذ الصحيح' });
      if (settings.engine === 'mysql') {
        // MySQL can log in without choosing a database, so one probe lists them all.
        const probe = openMysql({ ...settings, database: undefined });
        try { return send(res, 200, { databases: await listMysqlDatabases(probe), via: '' }); }
        catch (error) { return send(res, 400, { error: `تعذّر عرض قواعد البيانات: ${error.message}` }); }
        finally { await probe.end().catch(() => {}); }
      }
      // pg_database is shared, so any database the login can open will list them all: try the typed one, then the defaults.
      let lastError;
      for (const database of [...new Set([settings.database, 'postgres', 'template1'].filter(Boolean))]) {
        const probe = new Pool({ ...settings, database });
        probe.on('error', () => {});
        try { return send(res, 200, { databases: await listDatabases(probe), via: database }); }
        catch (error) { lastError = error; if (error.code !== '3D000') break; }
        finally { await probe.end().catch(() => {}); }
      }
      return send(res, 400, { error: `تعذّر عرض قواعد البيانات: ${lastError?.message || 'خطأ غير معروف'}` });
    }
    if (req.method === 'POST' && req.url === '/api/morph-types') {
      const body = await readJson(req);
      if (!pool || body.source !== connectionId) return send(res, 409, { error: 'قراءة الأنواع تحتاج اتصالًا مباشرًا بالقاعدة نفسها.' });
      return send(res, 200, { columns: await (engine === 'mysql' ? readMysqlMorphTypes : readMorphTypes)(pool, Array.isArray(body.candidates) ? body.candidates : []) });
    }
    if (req.method === 'GET' && req.url === '/api/schema') {
      if (!pool) return send(res, 200, { connected: false });
      return send(res, 200, await getSchema(pool));
    }
    if (req.method === 'GET' && req.url === '/api/store') return send(res, 200, { items: await loadStore() });
    if (req.method === 'PUT' && req.url === '/api/store') {
      await updateStore(await readJson(req, 60000000));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/code/env') {
      return send(res, 200, await readEnvConnection((await readJson(req)).sourceRoot));
    }
    if (req.method === 'POST' && req.url === '/api/disconnect') {
      const previous = pool;
      pool = null;
      databaseLabel = '';
      connectionId = '';
      await previous?.end().catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/plan') {
      const body = await readJson(req);
      const base = pool ? await getSchema(pool) : body.demoSchema;
      if (!base?.tables || !base?.relations) return send(res, 400, { error: 'لا توجد خريطة لعرض SQL' });
      if (pool && body.baseFingerprint !== base.fingerprint) return send(res, 409, { error: 'تغيرت بنية قاعدة البيانات. حدّث الخريطة قبل المراجعة.' });
      return send(res, 200, planChanges(base, body.operations));
    }
    if (req.method === 'POST' && req.url === '/api/ai') {
      const body = await readJson(req);
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', cancel);
      try {
        const result = await askProvider(body, controller.signal);
        if (!res.destroyed) return send(res, 200, result);
        return;
      } finally { res.removeListener('close', cancel); }
    }
    if (req.method === 'POST' && req.url === '/api/ai/login') {
      return send(res, 200, await openLoginTerminal((await readJson(req)).provider));
    }
    if (req.method === 'GET' && req.url === '/api/ai/local-status') {
      return send(res, 200, { providers: await Promise.all(localProviders.map(provider => cliStatus(provider, { fresh: true }))) });
    }
    if (req.method === 'GET' && req.url === '/api/code/settings') {
      return send(res, 200, { defaultSourceRoot: process.env.ER_ATLAS_SOURCE_ROOT || sourceSettings.defaultSourceRoot || '' });
    }
    if (req.method === 'POST' && req.url === '/api/code/analyze') {
      const body = await readJson(req);
      if (!Array.isArray(body.tables) || !body.tables.length) return send(res, 400, { error: 'لا توجد جداول لتحليل مواضيعها' });
      const context = await analyzeSource(body.sourceRoot, body.tables);
      return send(res, 200, sourceSummary(context));
    }
    const asset = /^\/(?:assets\/(?:figma|fonts)|samples)\/[A-Za-z0-9_.-]+\.(?:svg|ttf|woff2|css|json)$/.test(req.url);
    if (req.method !== 'GET' || (!Object.hasOwn(paths, req.url) && !asset)) return send(res, 404, { error: 'غير موجود' });
    const file = join(root, asset ? req.url.slice(1) : paths[req.url]);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch (error) {
    if (res.destroyed) return;
    send(res, 500, { error: error.message || 'حدث خطأ غير متوقع' });
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`ER Atlas is ready at ${url}`);
  if (process.argv.includes('--open') && process.platform === 'win32') execFile('cmd.exe', ['/c', 'start', '', url]);
});
