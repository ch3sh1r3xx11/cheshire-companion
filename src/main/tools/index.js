'use strict';
// The cat's hands: files, a collared terminal and (optionally) the carousel
// generator. Three layers keep them in check:
//   1. a fixed list of tools — nothing else can be called,
//   2. the guard — commands and paths are validated before anything runs,
//   3. consent in a NATIVE dialog raised by this process. Windows render text
//      that came from the model, so they are untrusted by definition; a button
//      inside the chat could be spoofed, a system dialog cannot.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const { ALLOWED_COMMANDS, checkCommand, isInside, resolveExecutable } = require('./guard');
const carousels = require('./carousels');

const MAX_RESULT_CHARS = 30_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_PATH_LENGTH = 1024;
const COMMAND_TIMEOUT_MS = 30_000;

// These never raise a dialog: listing only reads names inside the allowed area
// and is meant to be a reflex ("check before saying you don't have it");
// the carousel tools talk to one fixed localhost API, and a series of five
// would otherwise ask five times about the same thing.
const NO_CONFIRM = new Set(['list_files', 'carousel_brief', 'carousel_render']);
const PATH_TOOLS = new Set(['read_file', 'write_file', 'list_files']);

function declarations({ carouselsEnabled }) {
  const decl = [
    {
      name: 'read_file',
      description: 'Read a text file. Give an absolute path. Files in your home are read without asking; anything outside opens a dialog for the operator. Never invent the contents of a file you did not receive.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file.' } }, required: ['path'] },
    },
    {
      name: 'write_file',
      description: 'Write text to a file, overwriting it. The operator approves every write; writes outside your home need an extra approval. Never use it on your memory file.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    {
      name: 'list_files',
      description: 'List a folder (names and sizes). Without a path it lists YOUR HOME. Call it before claiming something does not exist — read_file needs a path, and this is where you get it.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute folder path. Omit to see your home.' } } },
    },
    {
      name: 'run_command',
      description: `Run ONE plain Windows command and return its output. It starts in YOUR HOME. The collar allows only: ${ALLOWED_COMMANDS.join(', ')}. No shells, interpreters, deleting or downloads; no &&, |, >, % or ^. git is limited to status, log, diff, show, add, commit, init, branch, ls-files. mkdir/copy/move/ren only inside your home. Do not try to work around it — tell the operator what you are missing.`,
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ];
  if (carouselsEnabled) decl.push(...carousels.declarations);
  return decl;
}

function createToolbox({ config, persona, dialogs }) {
  const home = () => config.homeDir;
  const memoryPath = () => path.join(config.homeDir, config.memoryFile);
  const carouselsEnabled = Boolean(config.carousels.url);
  // "Allow this folder" lives in memory only. A permission that survives a
  // restart is, a month later, a permission nobody remembers granting.
  const sessionGrants = new Set();

  const allowedRoots = () => [home(), ...sessionGrants];
  const isAllowedPath = (abs) => isInside(abs, allowedRoots());

  async function resolvePath(raw, name) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) throw new Error('missing path');
    if (p.length > MAX_PATH_LENGTH) throw new Error('path too long');
    const abs = path.resolve(home(), p);
    if (isAllowedPath(abs)) return { abs, asked: false };

    const folder = path.dirname(abs);
    const answer = await dialogs.askOutside(abs, folder, name); // 'deny' | 'once' | 'folder'
    if (answer === 'deny') throw new Error(persona().dialogs.deniedPath(abs));
    if (answer === 'folder') sessionGrants.add(folder);
    return { abs, asked: true };
  }

  function runCommand(line) {
    fs.mkdirSync(home(), { recursive: true });
    const cmd = checkCommand(line, { cwd: home(), isAllowedPath });
    const opts = { cwd: home(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'buffer' };

    let file, args, decode;
    if (cmd.kind === 'builtin') {
      // /d skips AutoRun hooks, /u makes builtins emit UTF-16 (no mangled
      // accents), /s /c runs exactly the validated line.
      file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      args = ['/d', '/u', '/s', '/c', `"${cmd.line}"`];
      opts.windowsVerbatimArguments = true;
      decode = (b) => b.toString('utf16le');
    } else {
      file = resolveExecutable(cmd.program);
      if (!file) throw new Error(`${cmd.program} was not found on PATH`);
      args = cmd.args;
      decode = (b) => b.toString('utf8');
    }

    return new Promise((resolve) => {
      execFile(file, args, opts, (err, stdout, stderr) => {
        let out = '';
        if (stdout && stdout.length) out += decode(stdout).trim() + '\n';
        if (stderr && stderr.length) out += 'STDERR:\n' + decode(stderr).trim() + '\n';
        if (err && err.killed) out += `ERROR: timed out after ${COMMAND_TIMEOUT_MS / 1000}s\n`;
        else if (err && !stderr.length) out += `ERROR: ${err.message}\n`;
        resolve(out.trim() || '(no output)');
      });
    });
  }

  function listDir(abs) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && !e.name.startsWith('~$'))
      .map((e) => {
        if (e.isDirectory()) return `${e.name}/`;
        try { return `${e.name} (${fs.statSync(path.join(abs, e.name)).size} B)`; } catch { return e.name; }
      })
      .sort();
    return `${abs}\n${entries.length ? entries.join('\n') : '(empty)'}`;
  }

  // Read only the head of big files: readFileSync would freeze the whole main
  // process (IPC, the local API, the cat) and a multi-GB file would crash it.
  function readHead(abs) {
    const size = fs.statSync(abs).size;
    if (size <= MAX_RESULT_CHARS * 4) return fs.readFileSync(abs, 'utf8');
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_RESULT_CHARS);
      const n = fs.readSync(fd, buf, 0, MAX_RESULT_CHARS, 0);
      return buf.subarray(0, n).toString('utf8') + '\n... [FILE TRUNCATED] ...';
    } finally { fs.closeSync(fd); }
  }

  function writeFile(abs, content) {
    if (isInside(abs, [memoryPath()])) throw new Error('the memory file is written by MEM: lines only');
    const text = String(content ?? '');
    if (Buffer.byteLength(text) > MAX_WRITE_BYTES) throw new Error('content too large');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    return 'File written.';
  }

  /**
   * Run one tool call from the model.
   * @param {string} name
   * @param {object} args
   * @param {{ onAwaitingConsent?: () => void }} hooks
   * @returns {Promise<string>} text result for the model (errors included)
   */
  async function execute(name, args, hooks = {}) {
    const P = persona();
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    let result;
    try {
      const known = declarations({ carouselsEnabled }).some((d) => d.name === name);
      if (!known) throw new Error(`unknown tool: ${name}`);
      // Validate the command BEFORE the dialog: an obviously forbidden command
      // should bounce immediately instead of asking you to deny it.
      if (name === 'run_command') checkCommand(a.command, { cwd: home(), isAllowedPath });

      let target = null;
      let asked = false;
      if (PATH_TOOLS.has(name)) {
        const raw = name === 'list_files' && !a.path ? home() : a.path;
        ({ abs: target, asked } = await resolvePath(raw, name));
      }

      // Reads inside the home are silent: the cat only keeps its own notes
      // there. Clicking "allow" to let it read its own notes teaches you to
      // click without reading. Outside the home, the path dialog already asked.
      const needsConsent = !NO_CONFIRM.has(name) && !asked && name !== 'read_file';
      if (needsConsent) {
        if (hooks.onAwaitingConsent) hooks.onAwaitingConsent();
        const ok = await dialogs.confirm(name, a);
        if (!ok) return P.lines.denied;
      }

      switch (name) {
        case 'list_files': result = listDir(target); break;
        case 'read_file': result = readHead(target); break;
        case 'write_file': result = writeFile(target, a.content); break;
        case 'run_command': result = await runCommand(a.command); break;
        default: result = await carousels.run(name, a, config.carousels, launchDetached);
      }
    } catch (err) {
      result = P.lines.toolError(err.message);
    }
    return result.length > MAX_RESULT_CHARS ? result.slice(0, MAX_RESULT_CHARS) + '\n... [OUTPUT TRUNCATED] ...' : result;
  }

  return {
    execute,
    declarations: () => declarations({ carouselsEnabled }),
    names: () => declarations({ carouselsEnabled }).map((d) => d.name),
    carouselsEnabled,
  };
}

// .bat launchers (from config.json only — never from a window) start detached
// and return immediately.
function launchDetached(batPath) {
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  spawn(cmd, ['/d', '/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

module.exports = { createToolbox, launchDetached };
