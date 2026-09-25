'use strict';
// Two kinds of remembering.
//
// Memory (memory.md in the cat's home): condensed, lasting facts. They are
// injected into the SYSTEM PROMPT, not the dialogue — a small model treats the
// system prompt as instructions and actually uses them, while a fact buried in
// 25 messages of chat gets lost. The file keeps dates for you; the model gets
// bare sentences, because dates and labels are noise that can drown the fact.
//
// Chat log (userData): the last N messages, so quitting, restarting or a
// Windows reboot does not wipe the conversation. Plain text on disk — it is
// everything you wrote to the cat. Images are not stored.

const fs = require('node:fs');
const path = require('node:path');

const MEMORY_MAX_LINES = 40;
const FACT_MAX_CHARS = 300;
const LOG_KEEP = 60;
const LOG_MAX_CHARS = 8000;

function createMemory(file) {
  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return ''; }
    // Everything above the first "---" is a human header, not facts.
    const cut = raw.indexOf('\n---');
    const body = cut === -1 ? raw : raw.slice(cut + 4);
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(/^-\s*/, '').trim())
      .filter(Boolean)
      .slice(-MEMORY_MAX_LINES)
      .join('\n');
  }

  function append(fact) {
    const clean = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, FACT_MAX_CHARS);
    if (!clean) return false;
    if (read().toLowerCase().includes(clean.toLowerCase())) return false; // no duplicates
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `- [${stamp}] ${clean}\n`, 'utf8');
      return true;
    } catch (e) {
      console.error('[memory] append failed:', e.message);
      return false;
    }
  }

  return { read, append, file };
}

function createChatLog(file) {
  const valid = (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';

  function read() {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(arr) ? arr.filter(valid).map(({ role, content }) => ({ role, content })) : [];
    } catch { return []; }
  }

  // Written after EVERY message, without debounce: quit and restart kill the
  // process at once, and a debounce would eat exactly the last exchange.
  function write(messages) {
    const clean = messages.filter(valid).slice(-LOG_KEEP).map(({ role, content }) => ({ role, content: content.slice(0, LOG_MAX_CHARS) }));
    try { fs.writeFileSync(file, JSON.stringify(clean)); } catch (e) { console.error('[chat-log] write failed:', e.message); }
  }

  return { read, write };
}

module.exports = { createMemory, createChatLog };
