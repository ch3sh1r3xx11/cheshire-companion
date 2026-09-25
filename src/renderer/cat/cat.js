'use strict';
// The cat window: animation, speech bubble, dragging and the right-click menu.
// It talks to the main process only through window.cheshire (see preload/cat.js).
(() => {
  const api = window.cheshire;
  const ART = window.CAT_ART;
  const SAY_MS = 6000;
  const HOVER_OPEN_MS = 2000; // hover this long and the chat opens
  const COLORS = ['#3ddbd9', '#ec1561', '#a24bd8', '#14b8a6', '#98ff98', '#ff00ff'];

  const catEl = document.getElementById('cat');
  const bubble = document.getElementById('bubble');
  const menu = document.getElementById('menu');

  let state = null;           // { settings, ui, quips, lines, ... } from main
  let menuOpen = false;
  let openList = null;        // which expandable section is open
  let busy = false;           // an animation owns the face right now
  const scripted = () => Boolean(state && state.demo); // demo: no random idle moves

  // ── tiny DOM helper: never innerHTML, text is always textContent ──
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  // ── animation ──
  catEl.textContent = ART.OPEN;
  const setFace = (f) => { catEl.textContent = f; };

  function play(frames) { // [[frame, ms], ...] then back to OPEN
    if (busy) return;
    busy = true;
    let i = 0;
    const next = () => {
      if (i >= frames.length) { setFace(ART.OPEN); busy = false; return; }
      const [f, ms] = frames[i++];
      setFace(f);
      setTimeout(next, ms);
    };
    next();
  }
  const blink = () => play([[ART.BLINK, 130]]);
  const yawn = () => play([[ART.YAWN1, 350], [ART.YAWN2, 1100], [ART.YAWN1, 300]]);
  const smile = () => play([[ART.SMILE1, 200], [ART.SMILE2, 1600]]);
  function phase() {
    if (busy) return;
    busy = true;
    catEl.classList.add('gradient');
    setTimeout(() => { catEl.classList.remove('gradient'); busy = false; }, 1800);
  }

  (function blinkLoop() {
    setTimeout(() => {
      if (!scripted()) { blink(); if (Math.random() < 0.25) setTimeout(blink, 350); } // sometimes a double blink
      blinkLoop();
    }, 2500 + Math.random() * 4500);
  })();
  setInterval(() => { if (!scripted() && Math.random() < 0.45) yawn(); }, 70_000);  // ~every 2.5 min
  setInterval(() => { if (!scripted() && Math.random() < 0.4) smile(); }, 55_000);  // ~every 2 min
  setInterval(() => { if (!scripted() && Math.random() < 0.35) phase(); }, 60_000); // ~every 3 min
  setTimeout(() => { if (!scripted()) yawn(); }, 15_000); // a welcome yawn: proof the animation is alive

  // ── speech ──
  let bubbleTimer = null;
  function say(text, duration = SAY_MS) {
    clearTimeout(bubbleTimer);
    bubble.textContent = text;
    bubble.classList.add('show');
    catEl.classList.add('talking');
    bubbleTimer = setTimeout(() => {
      bubble.classList.remove('show');
      catEl.classList.remove('talking');
    }, duration);
  }
  const randomQuip = () => state && state.quips.length ? state.quips[Math.floor(Math.random() * state.quips.length)] : 'meow.';
  api.onSay(({ text, duration }) => say(String(text), Number(duration) || SAY_MS));
  setInterval(() => { if (!scripted() && Math.random() < 0.15) say(randomQuip()); }, 30_000);

  // `npm run demo`: the main process conducts, the cat performs on cue.
  const DEMO_ACTIONS = { blink, yawn, smile, phase, menuOpen: () => openMenu(), menuClose: () => closeMenu() };
  api.onDemo((step) => {
    if (!step) return;
    if (step.action === 'say') say(String(step.text), Number(step.duration) || SAY_MS);
    else if (DEMO_ACTIONS[step.action]) DEMO_ACTIONS[step.action]();
  });

  // ── hover opens the chat, click says something, drag moves the cat ──
  let hoverTimer = null;
  catEl.addEventListener('mouseenter', () => {
    api.hover(true);
    if (menuOpen) return;
    hoverTimer = setTimeout(api.openChat, HOVER_OPEN_MS);
  });
  catEl.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    // With the menu open the window must keep catching the mouse, otherwise
    // clicks on the menu would fall through to the desktop.
    if (!menuOpen) api.hover(false);
  });

  let downAt = null;
  let dragged = false;
  catEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    downAt = { x: e.screenX, y: e.screenY };
    dragged = false;
    api.dragStart();
  });
  window.addEventListener('mousemove', (e) => {
    if (downAt && (Math.abs(e.screenX - downAt.x) > 5 || Math.abs(e.screenY - downAt.y) > 5)) dragged = true;
  });
  window.addEventListener('mouseup', () => {
    if (!downAt) return;
    api.dragEnd();
    if (!dragged) say(randomQuip());
    downAt = null;
  });

  // ── menu ──
  catEl.addEventListener('contextmenu', (e) => { e.preventDefault(); menuOpen ? closeMenu() : openMenu(); });
  window.addEventListener('mousedown', (e) => {
    if (menuOpen && !menu.contains(e.target) && e.target !== catEl) closeMenu();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) closeMenu(); });

  function openMenu() {
    menuOpen = true;
    clearTimeout(hoverTimer); // don't pop the chat while you're in the menu
    api.hover(true);
    renderMenu();
    menu.hidden = false;
  }
  function closeMenu() {
    menuOpen = false;
    openList = null;
    menu.hidden = true;
    api.hover(false);
  }

  const set = (key, value) => api.setSetting(key, value);
  const toggleList = (name) => { openList = openList === name ? null : name; renderMenu(); };

  function row(label, value, onClick, cls = 'menu-row') {
    return el('div', { class: cls, role: 'menuitem', tabindex: '0', on: { click: onClick } },
      el('span', { text: label }), el('span', { class: 'val', text: value }));
  }

  function listRow(label, hint, active, onClick) {
    return el('div', { class: 'list-row' + (active ? ' active' : ''), on: { click: onClick } },
      el('span', { text: label }), el('span', { class: 'hint', text: hint }));
  }

  let models = null; // cached after the first expansion
  async function loadModels() {
    const r = await api.listModels();
    models = r || { models: [], ollamaDown: true };
    if (openList === 'models') renderMenu();
  }

  function renderMenu() {
    if (!state) return;
    const { settings: s, ui } = state;
    const m = ui.menu;
    menu.replaceChildren();
    menu.append(el('div', { class: 'menu-title', text: m.title }));

    menu.append(row(m.facing, s.facing === 'right' ? m.facingRight : m.facingLeft, () => set('facing', s.facing === 'right' ? 'left' : 'right')));

    menu.append(row(m.temper, ui.temperNames[s.temper], () => toggleList('temper')));
    if (openList === 'temper') {
      menu.append(el('div', { class: 'menu-list' }, ...[0, 1, 2, 3].map((lvl) =>
        listRow(ui.temperNames[lvl], ui.temperHints[lvl], lvl === s.temper, () => { set('temper', lvl); openList = null; }))));
    }

    menu.append(row(m.color, '▾', () => toggleList('colors')));
    if (openList === 'colors') {
      menu.append(el('div', { class: 'swatches' }, ...COLORS.map((hex) => {
        const sw = el('div', { class: 'sw' + (hex === s.color.toLowerCase() ? ' active' : ''), title: ui.colorNames[hex] || hex, on: { click: () => set('color', hex) } });
        sw.style.background = hex;
        return sw;
      })));
    }

    menu.append(row(m.model, s.model.replace(/^hf\.co\/.*\//, '…/'), () => { toggleList('models'); if (openList === 'models' && !models) loadModels(); }));
    if (openList === 'models') {
      const list = el('div', { class: 'menu-list' });
      if (!models) list.append(el('div', { class: 'list-row muted', text: m.loadingModels }));
      else {
        for (const mod of models.models) {
          list.append(listRow(mod.label, mod.needsKey ? m.needsKey : mod.size, mod.id === s.model, () => { set('model', mod.id); openList = null; }));
        }
        if (models.ollamaDown) list.append(el('div', { class: 'list-row warn', text: m.ollamaDown }));
      }
      menu.append(list);
    }

    menu.append(row(m.language, s.language.toUpperCase(), () => set('language', s.language === 'pl' ? 'en' : 'pl')));
    menu.append(row(m.autostart, s.autostart ? m.on : m.off, () => set('autostart', !s.autostart)));
    menu.append(row(m.restart, '⟳', () => { closeMenu(); say(state.lines.restarting, 700); setTimeout(api.restart, 700); }));
    menu.append(row(m.quit, '✕', () => { closeMenu(); say(state.lines.quitting, 700); setTimeout(api.quit, 700); }, 'menu-row danger'));
  }

  // ── state from main: settings + strings for the current language ──
  function applyState(next) {
    if (!next) return;
    state = next;
    const s = state.settings;
    document.documentElement.style.setProperty('--cat', s.color);
    document.documentElement.lang = s.language;
    catEl.classList.toggle('facing-right', s.facing === 'right');
    if (menuOpen) renderMenu();
  }
  api.onState(applyState);
  api.getState().then(applyState);
})();
