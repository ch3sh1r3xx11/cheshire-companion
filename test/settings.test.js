'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSettingsStore, sanitize, defaults } = require('../src/main/settings');
const { normalize } = require('../src/main/config');

test('sanitize drops unknown keys, secrets and invalid values', () => {
  const s = sanitize({ color: 'red', facing: 'up', apiKey: 'secret', evil: 1, temper: 3 }, defaults('en'));
  assert.equal(s.color, '#3ddbd9');
  assert.equal(s.facing, 'left');
  assert.equal(s.temper, 3);
  assert.ok(!('apiKey' in s));
  assert.ok(!('evil' in s));
});

test('legacy keys are migrated', () => {
  const s = sanitize({ pazur: 0, model: 'antigravity' }, defaults('pl'));
  assert.equal(s.temper, 0);
  assert.equal(s.model, 'gemini-3.1-flash-lite');
  assert.equal(s.language, 'pl');
});

test('the UI can only set known keys to valid values', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-settings-')), 'settings.json');
  const store = createSettingsStore({ file, locale: 'en' });
  store.load();
  assert.equal(store.setFromUi('apiKey', 'x'), false);
  assert.equal(store.setFromUi('model', 'x; rm -rf'), false);
  assert.equal(store.setFromUi('__proto__', {}), false);
  assert.equal(store.setFromUi('color', '#ffffff'), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).color, '#ffffff');
});

test('config rejects paths that escape and non-http urls', () => {
  const c = normalize({
    memoryFile: '..\\..\\Windows\\win.ini',
    homeDir: 'relative/path',
    ollama: { url: 'file:///etc/passwd' },
    launchers: { ok: { path: 'relative.bat' } },
  }, { documentsDir: path.resolve('/docs') });
  assert.equal(c.memoryFile, 'memory.md');
  assert.equal(c.homeDir, path.join(path.resolve('/docs'), 'Cheshire'));
  assert.equal(c.ollama.url, 'http://127.0.0.1:11434');
  assert.deepEqual(c.launchers, {});
});
