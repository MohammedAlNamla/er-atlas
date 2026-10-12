import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/atlas.css', import.meta.url), 'utf8');
const light = /^:root \{\n([\s\S]*?)\n\}/m.exec(css)?.[1] || '';
const dark = /^:root\[data-theme="dark"\] \{\n([\s\S]*?)\n\}/m.exec(css)?.[1] || '';
const tokenNames = block => [...block.matchAll(/^\s*(--[\w-]+):/gm)].map(match => match[1]);

test('every light token has a dark counterpart (and the system-dark block mirrors it)', () => {
  const lightNames = tokenNames(light).filter(name => name !== '--mono' && name !== '--shadow');
  assert.ok(lightNames.length > 30, 'token block found');
  for (const name of lightNames) assert.ok(tokenNames(dark).includes(name), `${name} missing from the dark theme`);
  const system = /@media \(prefers-color-scheme: dark\) \{\n\s*:root:not\(\[data-theme="light"\]\) \{\n([\s\S]*?)\n  \}\n\}/.exec(css)?.[1] || '';
  assert.deepEqual(tokenNames(system), tokenNames(dark));
});

test('component rules use tokens, not literal colors', () => {
  const body = css.slice(css.indexOf('.figma-icon img'));
  const literals = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g)].map(match => match[0]);
  assert.deepEqual(literals, [], 'literal colors would not follow the theme');
});

test('the page loads one stylesheet and pins the theme before first paint', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal([...html.matchAll(/rel="stylesheet"/g)].length, 2); // fonts + atlas
  assert.match(html, /href="\/atlas\.css"/);
  assert.ok(html.indexOf('eratlas.theme') < html.indexOf('/atlas.css'));
});
