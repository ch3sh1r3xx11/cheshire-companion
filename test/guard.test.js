'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkCommand, isInside, tokenize, GuardError } = require('../src/main/tools/guard');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-home-'));
const ctx = { cwd: home, isAllowedPath: (abs) => isInside(abs, [home]) };
const rejects = (line, code) => assert.throws(() => checkCommand(line, ctx), (e) => e instanceof GuardError && (!code || e.code === code), line);

test('tokenize keeps quoted paths together', () => {
  assert.deepEqual(tokenize('dir "C:\\Program Files (x86)" /b'), ['dir', 'C:\\Program Files (x86)', '/b']);
  assert.deepEqual(tokenize('echo ""'), ['echo', '']);
});

test('allows plain whitelisted commands', () => {
  assert.equal(checkCommand('dir', ctx).kind, 'builtin');
  assert.equal(checkCommand('git status', ctx).kind, 'exe');
  assert.equal(checkCommand('WHOAMI.EXE', ctx).program, 'whoami');
  assert.equal(checkCommand('findstr /i todo notes.md', ctx).program, 'findstr');
});

test('rejects anything outside the whitelist', () => {
  for (const c of ['powershell -c calc', 'cmd /c dir', 'python -c 1', 'node -e 1', 'del x', 'rmdir /s x', 'curl http://x', 'reg add x']) {
    rejects(c, 'not-allowed');
  }
});

test('rejects shell operators, redirection and expansion', () => {
  for (const c of [
    'git --version && del /s /q C:\\', 'dir | more', 'dir & calc', 'dir; calc',
    'echo x > C:\\evil.bat', 'type < x', 'echo ^& calc', 'echo %USERPROFILE%',
    'echo !x!', 'dir (x)', 'dir\ncalc', 'echo `x`',
  ]) {
    rejects(c);
  }
});

test('rejects programs given by path', () => {
  rejects('.\\git.exe status', 'path-program');
  rejects('C:\\Windows\\System32\\whoami.exe', 'path-program');
});

test('rejects unbalanced quotes', () => rejects('dir "C:\\x', 'unbalanced-quotes'));

test('mutating commands stay inside the home', () => {
  assert.ok(checkCommand('mkdir notes', ctx));
  assert.ok(checkCommand(`copy a.md "${path.join(home, 'b.md')}"`, ctx));
  rejects('copy a.md C:\\Windows\\a.md', 'outside-home');
  rejects('move a.md ..\\a.md', 'outside-home');
  rejects('mkdir C:\\evil', 'outside-home');
});

test('git is limited to safe subcommands and options', () => {
  assert.ok(checkCommand('git log --oneline -5', ctx));
  assert.ok(checkCommand('git commit -m "update memory"', ctx));
  rejects('git -c core.pager=calc log', 'git');
  rejects('git config alias.x !calc', 'forbidden-char');
  rejects('git config user.name x', 'git');
  rejects('git clone https://example.com/x', 'git');
  rejects('git diff --output=C:\\evil.txt', 'git');
  rejects('git diff --ext-diff', 'git');
  rejects('git', 'git');
});

test('isInside handles prefixes, case and traversal', () => {
  assert.ok(isInside(path.join(home, 'a', 'b.md'), [home]));
  assert.ok(isInside(home, [home]));
  assert.ok(!isInside(home + '-evil', [home]));
  assert.ok(!isInside(path.join(home, '..', 'x'), [home]));
  if (process.platform === 'win32') assert.ok(isInside(path.join(home.toUpperCase(), 'x'), [home]));
});

test('isInside sees through junctions/symlinks', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-outside-'));
  const link = path.join(home, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('cannot create junctions here');
    return;
  }
  assert.ok(!isInside(path.join(link, 'secret.txt'), [home]));
});
