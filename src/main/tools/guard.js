'use strict';
// The collar: what the cat may run and where it may touch the disk.
//
// This module is pure (no Electron) so it can be unit-tested. It is a second
// line of defence — every command and every write still goes through a native
// consent dialog — but it must hold on its own, because the model reads files
// and web-ish content and therefore has to be treated as untrusted input.

const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

// ── commands ──────────────────────────────────────────────────────────────
// cmd.exe builtins run through `cmd /d /s /c`, real executables run without
// any shell. Deliberately absent: shells and interpreters (powershell, cmd,
// python, node… — one allowed interpreter defeats the whole list), deletion
// (del, rmdir), system configuration (reg, sc, net, icacls…) and downloads
// (curl, wget, certutil).
const BUILTINS = new Set(['dir', 'type', 'more', 'echo', 'mkdir', 'copy', 'move', 'ren', 'ver']);
const EXECUTABLES = new Set([
  'findstr', 'where', 'tree', 'fc', 'git',
  'tasklist', 'systeminfo', 'hostname', 'whoami', 'ipconfig', 'ping',
]);
// Commands that create or change files: every path argument must stay inside
// the allowed roots (the cat's home + folders the operator granted).
const MUTATING = new Set(['mkdir', 'copy', 'move', 'ren']);

// git can execute arbitrary programs through config, aliases, hooks and
// external diff drivers, so it gets its own, much shorter list.
const GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'add', 'commit', 'init', 'branch', 'ls-files']);
const GIT_FORBIDDEN_ARG = /^(-c$|-C$|--config|--exec-path|--upload-pack|--receive-pack|--output|--ext-diff|--textconv|--git-dir|--work-tree|--template)/i;

const ALLOWED_COMMANDS = [...BUILTINS, ...EXECUTABLES].sort();
const MAX_COMMAND_LENGTH = 2000;

class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

// Split a command line into tokens, honouring double quotes (paths with spaces).
// Anything that cmd.exe would interpret — chaining, pipes, redirection, escapes,
// variable expansion, blocks — is rejected outright instead of being "parsed
// safely": there is no legitimate need for it and every parser is a bypass risk.
function tokenize(line) {
  if (/[\r\n\0`]/.test(line)) throw new GuardError('forbidden-char', 'multi-line or control characters are not allowed');
  if (/[%!]/.test(line)) throw new GuardError('forbidden-char', 'variable expansion (% or !) is not allowed');

  const tokens = [];
  let cur = '';
  let inQuotes = false;
  let hasToken = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; hasToken = true; continue; }
    if (!inQuotes && /[&|<>^();]/.test(ch)) {
      throw new GuardError('forbidden-char', `shell operator "${ch}" is not allowed — one plain command at a time`);
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) tokens.push(cur);
      cur = '';
      hasToken = false;
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (inQuotes) throw new GuardError('unbalanced-quotes', 'unbalanced quotes');
  if (hasToken) tokens.push(cur);
  return tokens;
}

// cmd switches look like "/b", "/s", "/a:-d". Anything else is treated as a path.
const isSwitch = (t) => /^\/[a-z?][a-z0-9:-]*$/i.test(t);

/**
 * Validate a command line.
 * @param {string} line raw command from the model
 * @param {object} opts
 * @param {string} opts.cwd working directory (the cat's home)
 * @param {(abs: string) => boolean} opts.isAllowedPath containment check
 * @returns {{ kind: 'builtin'|'exe', program: string, args: string[], line: string }}
 */
function checkCommand(line, { cwd, isAllowedPath }) {
  const raw = String(line ?? '').trim();
  if (!raw) throw new GuardError('empty', 'empty command');
  if (raw.length > MAX_COMMAND_LENGTH) throw new GuardError('too-long', 'command too long');

  const [first, ...args] = tokenize(raw);
  if (!first) throw new GuardError('empty', 'empty command');
  // Bare names only: "C:\tmp\whoami.exe" or ".\git.exe" would run whatever
  // binary sits there, including one the cat just wrote itself.
  if (/[\\/:]/.test(first)) throw new GuardError('path-program', 'run commands by name, not by path');

  const program = first.toLowerCase().replace(/\.(exe|com)$/, '');
  const isBuiltin = BUILTINS.has(program);
  if (!isBuiltin && !EXECUTABLES.has(program)) {
    throw new GuardError('not-allowed', `"${program}" is outside the collar. Allowed: ${ALLOWED_COMMANDS.join(', ')}`);
  }

  if (program === 'git') checkGit(args);

  if (MUTATING.has(program)) {
    for (const a of args) {
      if (isSwitch(a)) continue;
      const abs = path.resolve(cwd, a);
      if (!isAllowedPath(abs)) {
        throw new GuardError('outside-home', `"${program}" may only change files inside the cat's home: ${abs}`);
      }
    }
  }

  return { kind: isBuiltin ? 'builtin' : 'exe', program, args, line: raw };
}

function checkGit(args) {
  const sub = args.find((a) => !a.startsWith('-'));
  const beforeSub = args.slice(0, args.indexOf(sub));
  if (!sub || beforeSub.length) throw new GuardError('git', 'git: start with a subcommand, no global options');
  if (!GIT_SUBCOMMANDS.has(sub.toLowerCase())) {
    throw new GuardError('git', `git ${sub} is not allowed. Allowed: ${[...GIT_SUBCOMMANDS].join(', ')}`);
  }
  const bad = args.find((a) => GIT_FORBIDDEN_ARG.test(a));
  if (bad) throw new GuardError('git', `git option ${bad} is not allowed`);
}

// ── executables are resolved by us, never by the OS ───────────────────────
// On Windows the default search order starts in the *current directory* —
// which is the cat's home, which the cat can write to. So we walk PATH
// ourselves and skip anything that is not an absolute directory.
function resolveExecutable(name, env = process.env) {
  const exts = IS_WIN ? ['.exe', '.com'] : [''];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

// ── paths ─────────────────────────────────────────────────────────────────
// Resolve symlinks/junctions of the deepest existing ancestor, so a junction
// inside the home pointing at C:\Windows does not count as "inside the home".
function realResolve(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(abs), ...tail.reverse());
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return path.resolve(p);
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
}

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);

function isInside(target, roots) {
  const t = norm(realResolve(target));
  return roots.some((r) => {
    const root = norm(realResolve(r));
    return t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

module.exports = {
  ALLOWED_COMMANDS,
  GuardError,
  checkCommand,
  isInside,
  realResolve,
  resolveExecutable,
  tokenize,
};
