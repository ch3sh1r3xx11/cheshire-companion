'use strict';
// Things the cat does on its own, without being asked.
//
// Detection is always CODE, never the model: an alert like "the server died"
// must work precisely when the server running the model is down. The cat only
// voices a ready-made, deterministic verdict in its own words.

const fs = require('node:fs');
const path = require('node:path');

// ── vision: glances at stats endpoints and speaks up when something is off ──
// Optional. Point config.vision at JSON stats endpoints (see README) or leave
// them empty and the cat stays quiet.
const VISION = { INTERVAL_MS: 15_000, CONFIRM_TICKS: 2, SAY_MS: 9000, DISK_HOT: 90, RAM_HOT: 92 };

async function getJson(url) {
  if (!url) return undefined; // not configured ≠ down
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// sev: 3 on fire, 2 deal with it, 1 fyi
function analyze(lap, srv, v) {
  const out = new Map();
  if (srv === null) out.set('server-down', { sev: 2, text: v.serverDown });
  else if (srv) {
    const t = srv.thermal || {};
    const temp = Math.round(Number(t.package_temp) || 0);
    if (temp >= (Number(t.threshold) || 80)) out.set('server-hot', { sev: 3, text: v.serverHot(temp) });
    const disk = srv.disk && srv.disk.root;
    if (disk && disk.percent >= VISION.DISK_HOT) out.set('server-disk', { sev: 2, text: v.serverDisk(disk.percent) });
    const ram = srv.memory && srv.memory.ram;
    if (ram && ram.percent >= VISION.RAM_HOT) out.set('server-ram', { sev: 1, text: v.serverRam(ram.percent) });
  }
  if (lap) {
    if (lap.disk && lap.disk.percent >= VISION.DISK_HOT) out.set('laptop-disk', { sev: 2, text: v.laptopDisk(lap.disk.percent) });
    if (lap.ram && lap.ram.percent >= VISION.RAM_HOT) out.set('laptop-ram', { sev: 1, text: v.laptopRam(lap.ram.percent) });
    for (const p of Array.isArray(lap.ports) ? lap.ports : []) {
      const why = v.ports[p.port];
      if (why) out.set('port-' + p.port, { sev: 3, text: v.port(p.port, String(p.process || ''), why) });
    }
  }
  return out;
}

function startVision({ config, persona, speak }) {
  const { laptopStatsUrl, serverStatsUrl } = config.vision;
  if (!laptopStatsUrl && !serverStatsUrl) return () => {};
  const streak = {};
  const announced = new Set();

  // Speak only a NEW alert confirmed over several glances (no network blips),
  // one per tick, highest severity first. An alert re-arms once it clears.
  async function tick() {
    const [lap, srv] = await Promise.all([getJson(laptopStatsUrl), getJson(serverStatsUrl)]);
    const found = analyze(lap, srv, persona().vision);
    for (const k of found.keys()) streak[k] = (streak[k] || 0) + 1;
    for (const k of Object.keys(streak)) if (!found.has(k)) { delete streak[k]; announced.delete(k); }
    let pick = null;
    for (const [k, a] of found) {
      if (streak[k] >= VISION.CONFIRM_TICKS && !announced.has(k) && (!pick || a.sev > pick.sev)) pick = { k, ...a };
    }
    if (pick) { announced.add(pick.k); speak(pick.text, VISION.SAY_MS); }
  }
  tick();
  const timer = setInterval(tick, VISION.INTERVAL_MS);
  return () => clearInterval(timer);
}

// ── agenda: reminds you of YOUR commitments ──
// agenda.md in userData:  "17:00 text" → at that time, once a day
//                         "- text"     → loose, nags at 2 random hours a day
// The hours come from a date-seeded RNG: stable within a day, new every day.
const NUDGE = { TICK_MS: 60_000, WINDOW_MIN: 20, LOOSE_POOL: [9, 11, 13, 15, 17, 19, 21], LOOSE_PER_DAY: 2, SAY_MS: 11_000 };

const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function looseHours(dateKey) {
  let seed = Number(dateKey.replace(/-/g, ''));
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pool = [...NUDGE.LOOSE_POOL];
  const out = [];
  for (let i = 0; i < NUDGE.LOOSE_PER_DAY && pool.length; i++) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

function parseAgenda(text) {
  const timed = [];
  const loose = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const m = l.match(/^-?\s*(\d{1,2}):(\d{2})\s+(.+)$/);
    if (m) timed.push({ h: +m[1], m: +m[2], text: m[3].trim() });
    else loose.push(l.replace(/^-\s*/, '').trim());
  }
  return { timed, loose };
}

function createDailyState(file) {
  const read = () => {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.date === todayKey() && Array.isArray(s.done)) return s;
    } catch { /* new day, clean slate */ }
    return { date: todayKey(), done: [] };
  };
  return {
    has: (key) => read().done.includes(key),
    mark: (key) => {
      const s = read();
      if (!s.done.includes(key)) s.done.push(key);
      try { fs.writeFileSync(file, JSON.stringify(s)); } catch (e) { console.error('[agenda] state:', e.message); }
    },
    date: () => read().date,
  };
}

const pickLine = (lines, text) => lines[Math.floor(Math.random() * lines.length)](text);

function startAgenda({ agendaFile, state, persona, speak }) {
  try { if (!fs.existsSync(agendaFile)) fs.writeFileSync(agendaFile, persona().agenda.template, 'utf8'); } catch { /* read-only disk: no agenda */ }

  function tick() {
    let text;
    try { text = fs.readFileSync(agendaFile, 'utf8'); } catch { return; }
    const { timed, loose } = parseAgenda(text);
    const a = persona().agenda;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    for (const t of timed) {
      const at = t.h * 60 + t.m;
      const key = `t|${t.h}:${t.m}|${t.text}`;
      if (nowMin >= at && nowMin < at + NUDGE.WINDOW_MIN && !state.has(key)) {
        state.mark(key);
        speak(pickLine(a.timed, t.text), NUDGE.SAY_MS);
        return; // one nudge per tick — the cat should not nag
      }
    }
    if (!loose.length || now.getMinutes() > 5 || !looseHours(state.date()).includes(now.getHours())) return;
    const key = `l|${now.getHours()}`;
    if (state.has(key)) return;
    state.mark(key);
    const idx = (Number(state.date().replace(/-/g, '')) + now.getHours()) % loose.length;
    speak(pickLine(a.loose, loose[idx]), NUDGE.SAY_MS);
  }
  tick();
  const timer = setInterval(tick, NUDGE.TICK_MS);
  return () => clearInterval(timer);
}

// ── canvas: a shared notebook, turn by turn ──
// You write in your editor under "## you ·", the cat appends "## cat · HH:MM"
// and leaves a fresh "## you ·" at the bottom. It only answers when there is
// text under the LAST "## you ·", so its own write never triggers another turn.
// Read once a day (at start-up) or on demand — a slow local model can take
// minutes over a long document.
function createCanvas({ file, persona, oneShot, speak, operator }) {
  let busy = false;

  const ensure = () => {
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${persona().canvas.you}\n`, 'utf8');
      }
    } catch (e) { console.error('[canvas] create:', e.message); }
  };

  // Everything above the first "---" is a cheat sheet for you, not content.
  const stripHeader = (t) => { const i = t.indexOf('\n---'); return i === -1 ? t : t.slice(i + 4); };

  function pending(text) {
    const you = persona().canvas.you.replace(/\s*·\s*$/, '');
    const idx = Math.max(text.lastIndexOf(you), text.lastIndexOf('## ty'), text.lastIndexOf('## you'));
    if (idx === -1) return text.replace(/^#[^\n]*\n?/, '').trim() || null;
    const after = text.slice(idx);
    const nl = after.indexOf('\n');
    return (nl === -1 ? '' : after.slice(nl + 1)).trim() || null;
  }

  async function check() {
    if (busy) return;
    let doc;
    try { doc = stripHeader(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!pending(doc)) return;
    busy = true;
    const p = persona();
    try {
      const reply = (await oneShot(p.canvasPrompt(doc.slice(-8000), operator))).trim();
      if (!reply) throw new Error('empty reply');
      const stamp = new Date().toTimeString().slice(0, 5);
      const cur = fs.readFileSync(file, 'utf8').replace(/\s*$/, '');
      fs.writeFileSync(file, `${cur}\n\n${p.canvas.cat} ${stamp}\n${reply}\n\n${p.canvas.you}\n`, 'utf8');
      speak(p.lines.canvasWritten, 7000);
    } catch (e) {
      console.error('[canvas]', e.message);
      speak(p.lines.canvasFailed, 7000);
    } finally {
      busy = false;
    }
  }

  return { ensure, check };
}

module.exports = { analyze, parseAgenda, looseHours, startVision, startAgenda, createDailyState, createCanvas };
