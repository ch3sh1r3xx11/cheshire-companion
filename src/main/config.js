'use strict';
// Machine-specific configuration: where the cat lives, which servers it talks
// to, what it may launch. Read from `config.json` in userData (see
// config.example.json). Unlike settings, the windows can never change it.
//
// Everything optional. With no config at all the cat runs on Gemini (key from
// .env), lives in ~/Documents/Cheshire, and the LAN integrations stay off.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  operatorName: '',
  homeDir: '',
  memoryFile: 'memory.md',
  canvasFile: 'canvas.md',
  personaExtra: '',
  apiPort: 5599,
  ollama: { url: 'http://127.0.0.1:11434', hiddenModels: [] },
  gemini: { models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] },
  launchers: {},
  vision: { laptopStatsUrl: '', serverStatsUrl: '' },
  carousels: { url: '', launcher: '' },
};

const str = (v, d = '') => (typeof v === 'string' ? v : d);
const httpUrl = (v) => {
  if (typeof v !== 'string' || !v) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.replace(/\/$/, '') : '';
  } catch { return ''; }
};
// A file name inside the home, never a path that walks out of it.
const fileName = (v, d) => (typeof v === 'string' && v && path.basename(v) === v ? v : d);

function normalize(raw, { documentsDir }) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const extra = Array.isArray(c.personaExtra) ? c.personaExtra.filter((l) => typeof l === 'string').join('\n') : str(c.personaExtra);

  const launchers = {};
  for (const [id, l] of Object.entries(c.launchers || {})) {
    if (!/^[\w-]{1,40}$/.test(id) || !l || typeof l.path !== 'string' || !path.isAbsolute(l.path)) continue;
    const match = {};
    for (const lang of ['pl', 'en']) {
      try { if (l.match && l.match[lang]) match[lang] = new RegExp(l.match[lang], 'i'); } catch { /* bad regex: skip language */ }
    }
    launchers[id] = { path: l.path, match, reply: l.reply && typeof l.reply === 'object' ? l.reply : {} };
  }

  const port = Number.isInteger(c.apiPort) && c.apiPort > 1024 && c.apiPort < 65536 ? c.apiPort : DEFAULTS.apiPort;
  const hidden = Array.isArray(c.ollama && c.ollama.hiddenModels) ? c.ollama.hiddenModels.filter((s) => typeof s === 'string') : [];
  const geminiModels = Array.isArray(c.gemini && c.gemini.models)
    ? c.gemini.models.filter((m) => typeof m === 'string' && /^[\w.-]+$/.test(m))
    : DEFAULTS.gemini.models;

  return {
    operatorName: str(c.operatorName).slice(0, 60),
    homeDir: typeof c.homeDir === 'string' && path.isAbsolute(c.homeDir) ? path.normalize(c.homeDir) : path.join(documentsDir, 'Cheshire'),
    memoryFile: fileName(c.memoryFile, DEFAULTS.memoryFile),
    canvasFile: fileName(c.canvasFile, DEFAULTS.canvasFile),
    personaExtra: extra.slice(0, 8000),
    apiPort: port,
    ollama: { url: httpUrl(c.ollama && c.ollama.url) || DEFAULTS.ollama.url, hiddenModels: hidden },
    gemini: { models: geminiModels.length ? geminiModels : DEFAULTS.gemini.models },
    launchers,
    vision: {
      laptopStatsUrl: httpUrl(c.vision && c.vision.laptopStatsUrl),
      serverStatsUrl: httpUrl(c.vision && c.vision.serverStatsUrl),
    },
    carousels: {
      url: httpUrl(c.carousels && c.carousels.url),
      launcher: c.carousels && typeof c.carousels.launcher === 'string' && path.isAbsolute(c.carousels.launcher) ? c.carousels.launcher : '',
    },
  };
}

function loadConfig({ file, documentsDir }) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[config] ${file} is not valid JSON, using defaults:`, e.message);
  }
  return normalize(raw, { documentsDir });
}

module.exports = { DEFAULTS, loadConfig, normalize };
