'use strict';
// The two windows (the cat and its chat) and everything about where they sit.

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const CAT_W = 420;
const CAT_H = 560; // the cat plus room for the speech bubble above it
// The chat starts wide: at ~320 px the input pushed the close button out of
// view and the only way out was ESC, which nobody knows about.
const CHAT_W = 760;
const CHAT_H = 620;
const CHAT_MIN_W = 420;
const CHAT_MIN_H = 260;

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

// Windows show text that came from a language model, so they get nothing:
// no Node, an isolated context, the Chromium sandbox, and a preload that
// exposes a handful of narrow functions.
const webPreferences = (preload) => ({
  preload: path.join(PRELOAD, preload),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
});

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.error('[windows] save:', e.message); } };

const centerOnSomeScreen = (b, w, h) => screen.getAllDisplays().some(({ bounds: d }) =>
  b.x + w / 2 > d.x && b.x + w / 2 < d.x + d.width && b.y + h / 2 > d.y && b.y + h / 2 < d.y + d.height);

// A saved chat position is only usable if the WHOLE window fits on a connected
// screen; after unplugging a monitor it would otherwise live off-screen.
const fullyOnSomeScreen = (b) => b && Number.isFinite(b.x) && Number.isFinite(b.y) &&
  screen.getAllDisplays().some(({ workArea: w }) => b.x >= w.x && b.y >= w.y && b.x + b.width <= w.x + w.width && b.y + b.height <= w.y + w.height);

// The cat prefers a portrait monitor when one is connected. Recognised by
// shape, not id: Windows display ids change when you replug a cable.
const preferredDisplay = () => screen.getAllDisplays().find((d) => d.bounds.height > d.bounds.width) || screen.getPrimaryDisplay();

function createWindows({ files }) {
  let cat = null;
  let chat = null;

  function defaultCatPos() {
    const wa = preferredDisplay().workArea;
    return { x: wa.x + wa.width - CAT_W - 30, y: wa.y + wa.height - CAT_H - 10 };
  }

  function loadCatPos() {
    const p = readJson(files.catPos);
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) && centerOnSomeScreen(p, CAT_W, CAT_H) ? p : defaultCatPos();
  }

  function saveCatPos() {
    if (!cat || cat.isDestroyed()) return;
    const [x, y] = cat.getPosition();
    writeJson(files.catPos, { x, y });
  }

  function loadChatBounds() {
    const s = readJson(files.chatBounds);
    if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return { width: CHAT_W, height: CHAT_H, x: null, y: null };
    return {
      width: Math.max(CHAT_MIN_W, Math.round(s.width)),
      height: Math.max(CHAT_MIN_H, Math.round(s.height)),
      x: Number.isFinite(s.x) ? Math.round(s.x) : null,
      y: Number.isFinite(s.y) ? Math.round(s.y) : null,
    };
  }

  function saveChatBounds() {
    if (chat && !chat.isDestroyed()) writeJson(files.chatBounds, chat.getBounds());
  }

  let saveTimer = null;
  const saveChatBoundsSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveChatBounds, 400); };

  // The chat sits next to the cat (left, or right if there is no room) and is
  // told which side the cat is on, so the cat's bubbles lean towards the cat.
  // If you placed the chat yourself, it stays put — only the side is updated.
  function placeChatNearCat() {
    if (!chat || chat.isDestroyed() || !cat || cat.isDestroyed()) return;
    const catB = cat.getBounds();
    const chatB = chat.getBounds();
    const sameScreen = screen.getDisplayMatching(chatB).id === screen.getDisplayMatching(catB).id;
    if (fullyOnSomeScreen(chatB) && sameScreen) {
      chat.webContents.send('chat:side', chatB.x < catB.x ? 'right' : 'left');
      return;
    }
    const wa = screen.getDisplayMatching(catB).workArea;
    let x = catB.x - chatB.width - 20;
    let side = 'right';
    if (x < wa.x) { x = catB.x + catB.width + 10; side = 'left'; }
    // Bottom-align with the cat so the chat grows upwards and never slides
    // below a cat parked at the bottom edge of the screen.
    let y = catB.y + catB.height - chatB.height;
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - chatB.width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - chatB.height);
    chat.setPosition(Math.round(x), Math.round(y));
    chat.webContents.send('chat:side', side);
  }

  // The cat starts with the OS, often before Windows has found the monitors;
  // it lands on the laptop screen. When screens appear, put it back.
  function onDisplaysChanged() {
    if (!cat || cat.isDestroyed()) return;
    const now = cat.getBounds();
    const onPreferred = preferredDisplay().id === screen.getDisplayMatching(now).id;
    if (centerOnSomeScreen(now, CAT_W, CAT_H) && onPreferred) return;
    const p = loadCatPos();
    cat.setBounds({ x: p.x, y: p.y, width: CAT_W, height: CAT_H });
    if (chat && !chat.isDestroyed() && chat.isVisible()) placeChatNearCat();
  }

  function create() {
    const pos = loadCatPos();
    cat = new BrowserWindow({
      x: pos.x, y: pos.y, width: CAT_W, height: CAT_H,
      transparent: true, frame: false, resizable: false, show: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: false,
      webPreferences: webPreferences('cat.js'),
    });
    cat.setAlwaysOnTop(true, 'screen-saver');
    cat.setIgnoreMouseEvents(true, { forward: true }); // clicks fall through to the desktop…
    cat.loadFile(path.join(RENDERER, 'cat', 'index.html'));
    cat.once('ready-to-show', () => cat.showInactive());

    const cb = loadChatBounds();
    chat = new BrowserWindow({
      width: cb.width, height: cb.height, minWidth: CHAT_MIN_W, minHeight: CHAT_MIN_H,
      transparent: true, frame: false, resizable: true, show: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: true,
      webPreferences: webPreferences('chat.js'),
    });
    chat.setAlwaysOnTop(true, 'screen-saver');
    chat.loadFile(path.join(RENDERER, 'chat', 'index.html'));
    chat.on('resized', saveChatBoundsSoon);
    chat.on('moved', saveChatBoundsSoon);
    if (fullyOnSomeScreen(cb)) chat.setPosition(cb.x, cb.y);

    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
    screen.on('display-metrics-changed', onDisplaysChanged);
  }

  // ── dragging the cat: follow the cursor until the mouse is released ──
  let dragTimer = null;
  function dragStart() {
    if (!cat || cat.isDestroyed()) return;
    const c0 = screen.getCursorScreenPoint();
    const [wx, wy] = cat.getPosition();
    const off = { dx: c0.x - wx, dy: c0.y - wy };
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!cat || cat.isDestroyed()) return clearInterval(dragTimer);
      const c = screen.getCursorScreenPoint();
      cat.setBounds({ x: Math.round(c.x - off.dx), y: Math.round(c.y - off.dy), width: CAT_W, height: CAT_H });
    }, 16);
  }
  function dragEnd() {
    clearInterval(dragTimer);
    dragTimer = null;
    saveCatPos();
    if (chat && !chat.isDestroyed() && chat.isVisible()) placeChatNearCat();
  }

  function showChat(mode, { focus }) {
    if (!chat || chat.isDestroyed()) return;
    if (cat && !cat.isDestroyed() && !cat.isVisible()) cat.showInactive();
    placeChatNearCat();
    chat.webContents.send('chat:mode', mode);
    // From the terminal the chat shows up WITHOUT stealing focus — you are
    // typing in the console and the keyboard should stay there.
    if (focus) { chat.show(); chat.focus(); } else if (!chat.isVisible()) chat.showInactive();
  }

  function hideChat() {
    if (chat && !chat.isDestroyed()) chat.hide();
    if (cat && !cat.isDestroyed()) cat.setIgnoreMouseEvents(true, { forward: true });
  }

  return {
    create,
    cat: () => cat,
    chat: () => chat,
    showChat,
    hideChat,
    dragStart,
    dragEnd,
    saveAll: () => { saveCatPos(); saveChatBounds(); },
    stop: () => clearInterval(dragTimer),
  };
}

module.exports = { createWindows };
