'use strict';
// User settings: what the right-click menu changes. Stored as JSON in userData.
//
// Every key has a validator. Values coming from a window are untrusted, so the
// menu can only set keys marked `fromUi`, and only to values that validate.
// Secrets never live here — the Gemini key comes from the environment only.

const fs = require('node:fs');

const LANGUAGES = ['pl', 'en'];
const TEMPER_LEVELS = [0, 1, 2, 3];

const SCHEMA = {
  color: { fromUi: true, def: '#3ddbd9', valid: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) },
  facing: { fromUi: true, def: 'left', valid: (v) => v === 'left' || v === 'right' },
  model: { fromUi: true, def: 'gemini-3.1-flash-lite', valid: (v) => typeof v === 'string' && v.length <= 200 && /^[\w.:/@-]+$/.test(v) },
  // How often the cat bites: 0 sheathed, 1 blunt, 2 sharp (default), 3 unsheathed.
  temper: { fromUi: true, def: 2, valid: (v) => TEMPER_LEVELS.includes(v) },
  language: { fromUi: true, def: 'en', valid: (v) => LANGUAGES.includes(v) },
  autostart: { fromUi: true, def: false, valid: (v) => typeof v === 'boolean' },
};

function defaults(locale = 'en') {
  const out = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.def]));
  out.language = String(locale).toLowerCase().startsWith('pl') ? 'pl' : 'en';
  return out;
}

// Older versions stored other key names (and, once, the API key). Map what we
// understand, drop everything else.
function migrate(raw) {
  const s = { ...raw };
  if (s.temper === undefined && s.pazur !== undefined) s.temper = s.pazur;
  if (s.model === 'antigravity') s.model = 'gemini-3.1-flash-lite';
  return s;
}

function sanitize(raw, base) {
  const out = { ...base };
  const src = migrate(raw && typeof raw === 'object' ? raw : {});
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (spec.valid(src[key])) out[key] = src[key];
  }
  return out;
}

function createSettingsStore({ file, locale, onChange = () => {} }) {
  let current = defaults(locale);

  function load() {
    try {
      current = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')), defaults(locale));
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[settings] unreadable, using defaults:', e.message);
      current = defaults(locale);
    }
    return current;
  }

  function save() {
    try { fs.writeFileSync(file, JSON.stringify(current, null, 2)); } catch (e) { console.error('[settings] save failed:', e.message); }
  }

  // Returns true when the value was accepted.
  function setFromUi(key, value) {
    const spec = Object.prototype.hasOwnProperty.call(SCHEMA, key) ? SCHEMA[key] : null;
    if (!spec || !spec.fromUi || !spec.valid(value)) return false;
    if (current[key] === value) return true;
    current = { ...current, [key]: value };
    save();
    onChange(current, key);
    return true;
  }

  return { load, save, setFromUi, get: () => current };
}

module.exports = { SCHEMA, LANGUAGES, TEMPER_LEVELS, defaults, sanitize, createSettingsStore };
