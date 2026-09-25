'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createToolbox } = require('../src/main/tools');
const { persona } = require('../src/persona');
const { normalize } = require('../src/main/config');

function setup({ consent = true, outside = 'deny' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-tools-'));
  const config = normalize({ homeDir: home }, { documentsDir: os.tmpdir() });
  const asked = [];
  const dialogs = {
    confirm: async (name) => { asked.push(['confirm', name]); return consent; },
    askOutside: async (abs) => { asked.push(['outside', abs]); return outside; },
  };
  const tools = createToolbox({ config, persona: () => persona('en'), dialogs });
  return { home, tools, asked };
}

test('files: silent inside the home, consent for writes, memory is protected', async () => {
  const { home, tools, asked } = setup();
  assert.equal(await tools.execute('write_file', { path: path.join(home, 'notes', 'a.md'), content: 'zażółć' }), 'File written.');
  assert.deepEqual(asked, [['confirm', 'write_file']]);
  assert.equal(await tools.execute('read_file', { path: 'notes/a.md' }), 'zażółć');
  assert.match(await tools.execute('list_files', {}), /notes\//);
  assert.equal(asked.length, 1, 'reads and listing inside the home ask nothing');
  assert.match(await tools.execute('write_file', { path: 'memory.md', content: 'x' }), /memory file/);
});

test('files outside the home go through the outside dialog', async () => {
  const { tools, asked } = setup({ outside: 'deny' });
  const target = path.join(os.tmpdir(), 'somewhere-else.txt');
  assert.match(await tools.execute('read_file', { path: target }), /did not let you/);
  assert.equal(asked[0][0], 'outside');
});

test('denied consent is reported as the operator’s decision', async () => {
  const { tools } = setup({ consent: false });
  assert.match(await tools.execute('run_command', { command: 'ver' }), /DENY/);
});

test('unknown tools and forbidden commands never reach a dialog', async () => {
  const { tools, asked } = setup();
  assert.match(await tools.execute('delete_everything', {}), /unknown tool/);
  assert.match(await tools.execute('run_command', { command: 'powershell -c calc' }), /outside the collar/);
  assert.match(await tools.execute('run_command', { command: 'dir & calc' }), /not allowed/);
  assert.equal(asked.length, 0);
});

test('commands actually run (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { home, tools } = setup();
  fs.writeFileSync(path.join(home, 'zażółć.txt'), 'x');
  assert.match(await tools.execute('run_command', { command: 'dir /b' }), /zażółć\.txt/, 'builtins decode UTF-16 output');
  assert.match(await tools.execute('run_command', { command: 'echo gęślą jaźń' }), /gęślą jaźń/);
  assert.ok((await tools.execute('run_command', { command: 'whoami' })).length > 2);
  assert.ok(fs.existsSync(path.join(home)), 'home exists');
  await tools.execute('run_command', { command: 'mkdir sub' });
  assert.ok(fs.existsSync(path.join(home, 'sub')));
});
