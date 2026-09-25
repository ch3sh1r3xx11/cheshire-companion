'use strict';
// CHESHIRE Companion — main process entry.
// Run: npm start · Quit: right-click the cat → vanish.

const fs = require('node:fs');
const path = require('node:path');
const { app, clipboard, dialog, ipcMain, session } = require('electron');

const { loadConfig, normalize } = require('./config');
const { createSettingsStore } = require('./settings');
const { persona: personaFor } = require('../persona');
const { createMemory, createChatLog } = require('./memory');
const { createToolbox, launchDetached } = require('./tools');
const { createAgent } = require('./agent');
const { createWindows } = require('./windows');
const { createApiServer } = require('./api-server');
const { startVision, startAgenda, createDailyState, createCanvas } = require('./watchers');
const { runDemo } = require('./demo');
const gemini = require('./llm/gemini');
const ollama = require('./llm/ollama');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;
const CANVAS_START_DELAY_MS = 25_000; // give the chat window time to come up
const WATCHERS_DELAY_MS = 20_000;     // do not panic while the system is still booting

// ── environment ────────────────────────────────────────────────────────────
// The Gemini key lives in .env next to the app (or in the real environment).
try {
  process.loadEnvFile(path.join(app.getAppPath(), '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[env] .env could not be read:', e.message);
}

// Where settings, chat log and config.json live. Pinned explicitly: Electron
// derives it from `productName` ("CHESHIRE Companion"), so renaming the app
// would silently move every user to an empty profile.
// A separate profile for development or a second cat:
//   CHESHIRE_USER_DATA=C:\some\folder npm start
// `npm run demo` gets its own throwaway profile: none of your history,
// memory or config ever shows up in a recording.
const DEMO = process.argv.includes('--demo');
const DEMO_LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '').slice(7);
app.setPath('userData', process.env.CHESHIRE_USER_DATA
  ? path.resolve(process.env.CHESHIRE_USER_DATA)
  : path.join(app.getPath('appData'), DEMO ? 'cheshire-companion-demo' : 'cheshire-companion'));

// ── hardening that must happen before 'ready' ─────────────────────────────
app.enableSandbox();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(main).catch((e) => {
    console.error('[main] fatal:', e);
    app.quit();
  });
}

// No window may navigate anywhere, open new windows or attach webviews.
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

function main() {
  // Camera, microphone, notifications, geolocation… the cat needs none of it.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userData = app.getPath('userData');
  const files = {
    config: path.join(userData, 'config.json'),
    settings: path.join(userData, 'cat-settings.json'),
    catPos: path.join(userData, 'cat-pos.json'),
    chatBounds: path.join(userData, 'cat-chat-size.json'),
    chatLog: path.join(userData, 'cat-chat-log.json'),
    agenda: path.join(userData, 'cat-agenda.md'),
    dailyState: path.join(userData, 'cat-nudge-state.json'),
  };

  // NOT app.getPath('documents'): with OneDrive folder redirection it returns
  // ...\OneDrive\Documents, which is not where anyone's projects live.
  const config = DEMO
    ? normalize({ homeDir: path.join(userData, 'home') }, { documentsDir: userData })
    : loadConfig({ file: files.config, documentsDir: path.join(app.getPath('home'), 'Documents') });
  fs.mkdirSync(config.homeDir, { recursive: true });

  const windows = createWindows({ files });
  const settings = createSettingsStore({ file: files.settings, locale: app.getLocale(), onChange: onSettingsChanged });
  settings.load();
  if (DEMO && DEMO_LANG) settings.setFromUi('language', DEMO_LANG);
  const persona = () => personaFor(settings.get().language);

  const memory = createMemory(path.join(config.homeDir, config.memoryFile));
  const chatLog = createChatLog(files.chatLog);

  // ── consent dialogs: raised here, out of reach of any window ──
  const dialogs = {
    async confirm(toolName, args) {
      const d = persona().dialogs;
      const r = await dialog.showMessageBox({
        type: 'warning',
        buttons: [d.buttons.deny, d.buttons.allow],
        defaultId: 0, cancelId: 0, noLink: true,
        title: d.consentTitle,
        message: d.consentMessage(d.what[toolName] || toolName),
        detail: JSON.stringify(args, null, 2).slice(0, 2000),
      }).catch(() => ({ response: 0 }));
      return r.response === 1;
    },
    async askOutside(abs, folder, toolName) {
      const d = persona().dialogs;
      const r = await dialog.showMessageBox({
        type: 'warning',
        buttons: [d.buttons.deny, d.buttons.allowOnce, d.buttons.allowFolder],
        defaultId: 0, cancelId: 0, noLink: true,
        title: d.outsideTitle,
        message: d.outsideMessage(d.what[toolName] || toolName),
        detail: d.outsideDetail(abs, folder),
      }).catch(() => ({ response: 0 }));
      return ['deny', 'once', 'folder'][r.response] || 'deny';
    },
  };

  const toolbox = createToolbox({ config, persona, dialogs });
  const sendToChat = (channel, payload) => { const w = windows.chat(); if (w && !w.isDestroyed()) w.webContents.send(channel, payload); };
  const agent = createAgent({
    config, persona, memory, chatLog, toolbox,
    getSettings: settings.get,
    emit: (event) => sendToChat('chat:event', event),
    launch: launchDetached,
  });

  // The cat speaks: show it if hidden (without stealing focus) and fill the bubble.
  function speak(text, duration) {
    const w = windows.cat();
    if (!w || w.isDestroyed()) return;
    if (!w.isVisible()) w.showInactive();
    w.webContents.send('cat:say', { text: String(text).slice(0, 400), duration });
  }

  // ── state broadcast: settings + UI strings for the current language ──
  function state() {
    const p = persona();
    const s = settings.get();
    return {
      settings: s,
      ui: p.ui,
      quips: p.quips,
      lines: {
        thinking: p.lines.thinking,
        copied: p.lines.copied,
        restoredDivider: p.lines.restoredDivider,
        fromTerminal: p.lines.fromTerminal,
        notImage: p.lines.notImage,
        imageTooBig: p.lines.imageTooBig,
        noVision: p.lines.noVision,
        imageReady: p.lines.imageReady('{kb}'),
        restarting: p.lines.restarting,
        quitting: p.lines.quitting,
      },
      modelHasVision: gemini.isCloudModel(s.model),
      demo: DEMO,
    };
  }
  function broadcastState() {
    for (const w of [windows.cat(), windows.chat()]) if (w && !w.isDestroyed()) w.webContents.send('state', state());
  }
  function onSettingsChanged(_s, key) {
    if (key === 'autostart' && !DEMO) applyAutostart();
    broadcastState();
  }

  // ── autostart ──
  // PITFALL: Electron quotes each ARG itself (since v35-ish) but still writes
  // the executable PATH bare. In a folder with a space ("…\My Projects\…")
  // Windows cut the command at the space and the cat never woke up. So: quote
  // the path ourselves, leave the args alone (quoting them too gives "\"…\"").
  function applyAutostart() {
    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(settings.get().autostart),
        path: `"${process.execPath}"`,
        args: app.isPackaged ? [] : [path.resolve(app.getAppPath())],
      });
    } catch (e) {
      console.error('[autostart]', e.message);
    }
  }

  // ── IPC: every handler checks WHICH window is talking ──
  const from = (getWin) => (e) => { const w = getWin(); return Boolean(w && !w.isDestroyed() && e.sender === w.webContents); };
  const fromCat = from(windows.cat);
  const fromChat = from(windows.chat);
  const fromAny = (e) => fromCat(e) || fromChat(e);
  const on = (channel, guard, fn) => ipcMain.on(channel, (e, ...args) => { if (guard(e)) fn(...args); });
  const handle = (channel, guard, fn) => ipcMain.handle(channel, (e, ...args) => (guard(e) ? fn(...args) : null));

  handle('state:get', fromAny, () => state());
  handle('settings:set', fromCat, (key, value) => settings.setFromUi(key, value));
  handle('models:list', fromCat, async () => {
    const cloud = config.gemini.models.map((id) => ({ id, label: id, size: '∞', cloud: true, needsKey: !gemini.hasKey() }));
    try {
      const hidden = config.ollama.hiddenModels.map((s) => s.toLowerCase());
      const local = (await ollama.listModels(config.ollama.url))
        // Hidden models stay usable (set them in cat-settings.json), they just
        // do not show up in the menu — or in your screenshots.
        .filter((m) => m.id === settings.get().model || !hidden.some((h) => m.id.toLowerCase().includes(h)))
        .map((m) => ({ id: m.id, label: m.id.replace(/^hf\.co\/.*\//, '…/'), size: `${(m.size / 1073741824).toFixed(1)}G` }));
      return { models: [...cloud, ...local], ollamaDown: false };
    } catch {
      return { models: cloud, ollamaDown: true };
    }
  });
  on('cat:hover', fromCat, (hovering) => {
    const w = windows.cat();
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!hovering, { forward: true });
  });
  on('cat:drag', fromCat, (phase) => (phase === 'start' ? windows.dragStart() : windows.dragEnd()));
  on('chat:open', fromCat, () => windows.showChat('chat', { focus: true }));
  on('app:restart', fromCat, () => { windows.saveAll(); app.relaunch(); app.quit(); });
  on('app:quit', fromCat, () => app.quit());

  on('chat:hide', fromChat, () => windows.hideChat());
  handle('chat:history', fromChat, () => agent.history());
  handle('chat:send', fromChat, (payload) => {
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    let image = null;
    const img = payload && payload.image;
    if (img && IMAGE_TYPES.has(img.mime) && typeof img.data === 'string' && img.data.length <= MAX_IMAGE_BASE64 && /^[A-Za-z0-9+/=]+$/.test(img.data)) {
      image = { mime: img.mime, data: img.data };
    }
    agent.send(text, { origin: 'chat', image });
    return true;
  });
  // Print Screen / Win+Shift+S put a bitmap on the system clipboard that the
  // page's paste event cannot see, so the chat asks for it explicitly.
  handle('clipboard:read-image', fromChat, () => {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    return { mime: 'image/png', data: img.toPNG().toString('base64') };
  });
  on('clipboard:write', fromChat, (text) => { if (typeof text === 'string' && text.length < 10_000) clipboard.writeText(text); });

  windows.create();
  for (const w of [windows.cat(), windows.chat()]) w.webContents.on('did-finish-load', broadcastState);

  if (DEMO) {
    // No autostart, no local API, no watchers: the demo touches nothing on your system.
    const w = windows.chat();
    w.webContents.once('did-finish-load', () => {
      const stop = runDemo({
        persona,
        catAction: (step) => { const c = windows.cat(); if (c && !c.isDestroyed()) c.webContents.send('cat:demo', step); },
        emitChat: (event) => sendToChat('chat:event', event),
        openChat: () => windows.showChat('chat', { focus: false }),
      });
      app.on('will-quit', stop);
    });
    return;
  }
  applyAutostart();

  // ── the cat's own initiative ──
  const daily = createDailyState(files.dailyState);
  const canvas = createCanvas({
    file: path.join(config.homeDir, config.canvasFile),
    persona, speak, operator: config.operatorName,
    oneShot: (prompt) => agent.oneShot(prompt),
  });
  canvas.ensure();

  // ── local API (terminal `ask`, gestures, scripts) ──
  const api = createApiServer({
    port: config.apiPort,
    ask: async (q) => {
      windows.showChat('term', { focus: false });
      const text = (await agent.send(q, { origin: 'term' })) || '';
      const cmd = text.match(/^\s*CMD:\s*(.+)$/im);
      return { text, cmd: cmd ? cmd[1].trim() : null };
    },
    actions: {
      show: () => { const w = windows.cat(); if (w) w.showInactive(); },
      hide: () => { const w = windows.cat(); if (w) w.hide(); windows.hideChat(); },
      toggle: () => {
        const w = windows.cat();
        if (!w) return;
        if (w.isVisible()) { w.hide(); windows.hideChat(); } else w.showInactive();
      },
      say: (params) => speak(params.get('text') || 'meow', 6000),
      canvas: () => canvas.check(),
    },
  });
  api.listen().catch((e) => console.error(`[api] port ${config.apiPort} unavailable, running without the local API:`, e.message));

  // The canvas is read at START-UP, once a day: a "7 am" schedule meant "never"
  // on a machine that sleeps at 7 am.
  setTimeout(() => { if (!daily.has('canvas')) { daily.mark('canvas'); canvas.check(); } }, CANVAS_START_DELAY_MS);

  const stoppers = [];
  setTimeout(() => {
    stoppers.push(startVision({ config, persona, speak }));
    stoppers.push(startAgenda({ agendaFile: files.agenda, state: daily, persona, speak }));
  }, WATCHERS_DELAY_MS);

  app.on('second-instance', () => { const w = windows.cat(); if (w) w.showInactive(); });
  app.on('will-quit', () => { windows.stop(); api.close(); stoppers.forEach((s) => s()); });
  // NOTE: no global "kill the cat" shortcut, on purpose. Ctrl+Alt+anything is
  // AltGr on Polish (and many other) keyboards — typing "ł" and fixing a typo
  // killed the cat mid-sentence. Quit from the menu.
}
