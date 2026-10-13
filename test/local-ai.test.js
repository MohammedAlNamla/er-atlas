import test from 'node:test';
import assert from 'node:assert/strict';
import { cliEnvironment, parseCliAnswer, findCli, run, loginScript, loginEnvironment } from '../local-ai.js';

test('Codex JSONL extracts only completed assistant messages', () => {
  const events = [{ type: 'thread.started' }, { type: 'item.completed', item: { type: 'reasoning', text: 'private' } }, { type: 'item.completed', item: { type: 'agent_message', text: '[{"name":"المبيعات","tableIds":["1"]}]' } }, { type: 'turn.completed' }];
  assert.equal(parseCliAnswer('codex-cli', events.map(event => JSON.stringify(event)).join('\r\n')), '[{"name":"المبيعات","tableIds":["1"]}]');
  assert.throws(() => parseCliAnswer('codex-cli', '{"type":"turn.failed"}'), /Codex/);
  assert.throws(() => parseCliAnswer('codex-cli', '{"type":"turn.completed"}'), /نصية/);
});

test('Claude JSON envelope reports model errors and missing answers', () => {
  assert.equal(parseCliAnswer('claude-cli', '{"result":"إجابة"}'), 'إجابة');
  assert.throws(() => parseCliAnswer('claude-cli', '{"is_error":true,"result":"error"}'), /Claude/);
  assert.throws(() => parseCliAnswer('claude-cli', '{}'), /نصية/);
});

test('local assistants do not inherit API billing keys or provider overrides', () => {
  const source = { PATH: 'bin', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', OPENAI_BASE_URL: 'https://example.com', ANTHROPIC_BASE_URL: 'https://example.com', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CODEX_HOME: 'auth-home' };
  assert.deepEqual(cliEnvironment(source), { PATH: 'bin', CODEX_HOME: 'auth-home' });
  assert.equal(source.OPENAI_API_KEY, 'secret');
});

test('executable selection rejects arbitrary process names', async () => {
  await assert.rejects(findCli('powershell'), /غير مدعوم/);
});

test('canceling a request terminates its child process and rejects with AbortError', async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeout: 10000 });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('the sign-in terminal runs one fixed command and quotes the executable path', () => {
  const exe = String.raw`C:\Users\Ali Khan\.local\bin\claude.exe`;
  const claude = loginScript({ command: exe, prefix: [] }, 'claude-cli', 'win32');
  assert.equal(claude.extension, 'cmd');
  assert.ok(claude.content.includes(`"${exe}" "auth" "login"\r\n`));
  const script = String.raw`C:\codex\bin\codex.js`;
  const codex = loginScript({ command: String.raw`C:\node.exe`, prefix: [script] }, 'codex-cli', 'win32');
  assert.ok(codex.content.includes(String.raw`"C:\node.exe" "${script}" "login"`));
  const mac = loginScript({ command: "/Users/o'neil/bin/claude", prefix: [] }, 'claude-cli', 'darwin');
  assert.ok(mac.content.includes(String.raw`'/Users/o'\''neil/bin/claude' 'auth' 'login'`));
  assert.throws(() => loginScript({ command: 'C:\\a"b\\claude.exe', prefix: [] }, 'claude-cli', 'win32'), /رموزًا/);
});

test('the sign-in terminal does not inherit session credentials from the host app', () => {
  const env = loginEnvironment({ PATH: 'bin', ANTHROPIC_BASE_URL: 'x', CLAUDE_CODE_OAUTH_SCOPES: 'x', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDECODE: '1', AI_AGENT: 'x', HOME: 'h' });
  assert.deepEqual(env, { PATH: 'bin', HOME: 'h' });
});
