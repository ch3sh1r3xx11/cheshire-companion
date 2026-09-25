'use strict';
// Optional integration with a local Instagram-carousel generator (a separate
// app exposing an HTTP API on localhost). Enabled only when config.json sets
// `carousels.url`; without it the tools are not even offered to the model.

const fs = require('node:fs');

const TIMEOUT_MS = 300_000; // a series renders slide by slide; it takes minutes
const START_ATTEMPTS = 30;  // 30 × 2 s: the generator can take a minute to boot
const START_INTERVAL_MS = 2000;
const MAX_ITEMS = 20;

const declarations = [
  {
    name: 'carousel_brief',
    description: 'Fetch the carousel JSON format instructions and the list of available backgrounds from the generator. ALWAYS call this first, before writing any carousel.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'carousel_render',
    description: 'Render carousels to folders with PNGs, the JSON and a caption file. Pass finished JSONs written per carousel_brief. Returns the output folder — give it to the operator. Rendering a series takes minutes; do not call it twice.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Carousels to render.',
          items: {
            type: 'object',
            properties: {
              json: { type: 'string', description: 'The whole carousel as JSON text.' },
              folderName: { type: 'string', description: "Folder name, e.g. 'carousel_01_habits'." },
            },
            required: ['json'],
          },
        },
      },
      required: ['items'],
    },
  },
];

async function api(base, method, route, body, timeoutMs = TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(new URL(route, base + '/'), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'the carousel generator did not answer in time' : 'the carousel generator is not running', { cause: e });
  }
  try { return await res.json(); } catch { throw new Error(`the generator returned HTTP ${res.status} without JSON`); }
}

async function alive(base) {
  try { return Boolean((await api(base, 'GET', 'health', null, 3000)).ok); } catch { return false; }
}

// The cat boots the generator itself instead of sending you to click a .bat.
async function ensureRunning(cfg, launch) {
  if (await alive(cfg.url)) return;
  if (!cfg.launcher || !fs.existsSync(cfg.launcher)) throw new Error('the carousel generator is not running and no launcher is configured');
  launch(cfg.launcher);
  for (let i = 0; i < START_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, START_INTERVAL_MS));
    if (await alive(cfg.url)) return;
  }
  throw new Error('started the generator, but it did not come up within a minute');
}

async function run(name, args, cfg, launch) {
  await ensureRunning(cfg, launch);
  if (name === 'carousel_brief') {
    // Only background ids: the full profile carries previews as data: URIs.
    const [meta, profile] = await Promise.all([api(cfg.url, 'GET', 'meta-prompt'), api(cfg.url, 'GET', 'profile')]);
    const text = (meta && meta.payload && typeof meta.payload.text === 'string') ? meta.payload.text : '';
    const backgrounds = ((profile && profile.backgrounds) || []).map((b) => `${b.id} — ${b.etykieta || b.label || ''}`);
    return ['FORMAT INSTRUCTIONS (follow them exactly):', text, '', `AVAILABLE BACKGROUNDS ("carousel_background"): ${backgrounds.join(' | ')}`, 'Alternate backgrounds in a series.'].join('\n');
  }
  const items = (Array.isArray(args.items) ? args.items : [])
    .filter((i) => i && typeof i.json === 'string')
    .slice(0, MAX_ITEMS)
    .map((i) => ({ json: i.json, folderName: typeof i.folderName === 'string' ? i.folderName.replace(/[^\w.-]/g, '_').slice(0, 80) : undefined }));
  if (!items.length) throw new Error('no carousels to render');
  const out = await api(cfg.url, 'POST', 'batch', { items });
  if (out && out.error) throw new Error(String(out.error));
  return `Rendered: ${out.count}\nFolder: ${out.batchRoot}\nSubfolders:\n${(out.folders || []).join('\n')}`;
}

module.exports = { declarations, run };
