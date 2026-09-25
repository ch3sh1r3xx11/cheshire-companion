'use strict';
// The chat window is a view. It sends what you type and renders events from
// the main process. Everything from the model is rendered as TEXT — never
// HTML — so nothing the model says (or reads from a file) can become code.
(() => {
  const api = window.cheshire;
  const MAX_SIDE_PX = 1280;      // enough to read text on a screenshot
  const MAX_DOM_MESSAGES = 120;  // the cat runs for weeks; keep the DOM bounded
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const closeBtn = document.getElementById('close');
  const attachment = document.getElementById('attachment');

  let state = null;
  let pendingImage = null;          // { mime, data, url }
  const thinking = new Map();       // event id → bubble waiting for a reply

  // ── rendering ──
  function scrollDown() { requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; }); }

  function addMessage(kind, extraClass = '') {
    const wrap = document.createElement('div');
    wrap.className = `msg ${kind} ${extraClass}`.trim();
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.append(bubble);
    messages.append(wrap);
    while (messages.children.length > MAX_DOM_MESSAGES) messages.firstChild.remove();
    scrollDown();
    return bubble;
  }

  // Text with "CMD: ..." lines turned into click-to-copy buttons.
  function fillReply(bubble, text, withCommands) {
    bubble.replaceChildren();
    const lines = String(text).split('\n');
    let buffer = [];
    const flush = () => { if (buffer.length) { bubble.append(document.createTextNode(buffer.join('\n'))); buffer = []; } };
    for (const line of lines) {
      const m = withCommands && line.match(/^\s*CMD:\s*(.+)$/i);
      if (!m) { buffer.push(line); continue; }
      flush();
      const cmd = m[1].trim();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmd-block';
      btn.textContent = `> ${cmd}`;
      btn.title = state ? state.ui.chat.copy : '';
      btn.addEventListener('click', () => {
        api.copy(cmd);
        btn.textContent = state ? state.lines.copied : 'OK';
        setTimeout(() => { btn.textContent = `> ${cmd}`; }, 1000);
      });
      bubble.append(btn);
    }
    flush();
  }

  function botSays(text, extraClass) {
    fillReply(addMessage('bot', extraClass), text, false);
  }

  function imageEl(src) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.alt = '';
    img.src = src;
    return img;
  }

  // ── events from main ──
  api.onEvent((ev) => {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'user': {
        const bubble = addMessage('user', ev.origin === 'term' ? 'from-term' : '');
        if (ev.image && IMAGE_TYPES.includes(ev.image.mime)) bubble.append(imageEl(`data:${ev.image.mime};base64,${ev.image.data}`));
        // From the terminal we only show a marker — you have the question in
        // front of you in the console.
        bubble.append(document.createTextNode(ev.origin === 'term' ? (state ? state.lines.fromTerminal : 'terminal') : String(ev.text)));
        break;
      }
      case 'thinking': {
        const bubble = addMessage('bot');
        const span = document.createElement('span');
        span.className = 'thinking';
        span.textContent = ev.text;
        bubble.append(span);
        thinking.set(ev.id, bubble);
        break;
      }
      case 'status': {
        const anchor = thinking.get(ev.id);
        const wrap = document.createElement('div');
        wrap.className = 'msg bot status';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = ev.text;
        wrap.append(bubble);
        if (anchor) anchor.parentNode.before(wrap); else messages.append(wrap);
        scrollDown();
        break;
      }
      case 'reply':
      case 'error': {
        const bubble = thinking.get(ev.id) || addMessage('bot');
        thinking.delete(ev.id);
        if (ev.type === 'error') bubble.parentNode.classList.add('error');
        fillReply(bubble, ev.text, ev.type === 'reply');
        scrollDown();
        break;
      }
      case 'notice':
        botSays(ev.text);
        break;
      default:
    }
  });

  // Restored conversation: plain text, no clickable commands — a command from
  // before a restart should not be one click away from running out of context.
  async function restoreHistory() {
    const past = await api.history();
    if (!Array.isArray(past) || !past.length || messages.children.length) return;
    for (const m of past) {
      const bubble = addMessage(m.role === 'user' ? 'user' : 'bot');
      bubble.textContent = m.content;
    }
    const divider = document.createElement('div');
    divider.className = 'divider';
    divider.textContent = state ? state.lines.restoredDivider : '—';
    messages.append(divider);
    scrollDown();
  }

  // ── sending ──
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const text = input.value.trim();
    if (!text && !pendingImage) return;
    input.value = '';
    const image = pendingImage ? { mime: pendingImage.mime, data: pendingImage.data } : null;
    pendingImage = null;
    renderAttachment();
    api.send(text, image);
  });

  // ── closing: first click arms, second click closes (or ESC) ──
  let armed = false;
  closeBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      closeBtn.textContent = state ? state.ui.chat.closeConfirm : '?';
      setTimeout(() => { armed = false; closeBtn.textContent = '✕'; }, 2500);
      return;
    }
    armed = false;
    closeBtn.textContent = '✕';
    api.hide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.hide(); });
  window.addEventListener('focus', () => input.focus());

  // ── images: paste or drop ──
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });
  }

  // A Windows screenshot can be 2500 px wide and ~3 MB; every extra pixel is
  // cost and latency, and 1280 px is plenty to read text.
  function downscale(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE_PX / Math.max(img.width, img.height));
        if (scale === 1) return resolve(dataUrl);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function attach(dataUrl) {
    if (state && !state.modelHasVision) { botSays(state.lines.noVision); return; }
    const small = await downscale(dataUrl);
    const m = /^data:([^;]+);base64,(.*)$/.exec(small);
    if (!m || !IMAGE_TYPES.includes(m[1])) { botSays(state ? state.lines.notImage : 'no.'); return; }
    if (m[2].length > 8 * 1024 * 1024) { botSays(state ? state.lines.imageTooBig : 'too big.'); return; }
    pendingImage = { mime: m[1], data: m[2], url: small };
    renderAttachment();
    input.focus();
  }

  function renderAttachment() {
    if (!pendingImage) { attachment.hidden = true; return; }
    document.getElementById('attachment-img').src = pendingImage.url;
    const kb = Math.round(pendingImage.data.length * 0.75 / 1024);
    document.getElementById('attachment-info').textContent = state ? state.lines.imageReady.replace('{kb}', String(kb)) : `${kb} kB`;
    attachment.hidden = false;
  }
  document.getElementById('attachment-remove').addEventListener('click', () => { pendingImage = null; renderAttachment(); });

  // Paste: the page's clipboard first (images copied from a browser/explorer),
  // then the system clipboard — Print Screen and Win+Shift+S only land there.
  document.addEventListener('paste', async (e) => {
    const item = e.clipboardData && [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      attach(await fileToDataUrl(item.getAsFile()));
      return;
    }
    const sys = await api.readClipboardImage();
    if (sys) {
      e.preventDefault();
      attach(`data:${sys.mime};base64,${sys.data}`);
    }
  });

  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { botSays(state ? state.lines.notImage : 'no.'); return; }
    attach(await fileToDataUrl(file));
  });

  // ── layout signals from main ──
  api.onSide((side) => { if (side === 'left' || side === 'right') document.body.dataset.catSide = side; });
  api.onMode((mode) => { if (mode === 'chat' || mode === 'term') document.body.dataset.mode = mode; });

  // ── state: language strings ──
  function applyState(next) {
    if (!next) return;
    state = next;
    const c = state.ui.chat;
    document.documentElement.lang = state.settings.language;
    input.placeholder = c.placeholder;
    closeBtn.title = c.close;
    closeBtn.setAttribute('aria-label', c.close);
    document.querySelector('.drag-handle').title = c.move;
    document.getElementById('attachment-remove').title = c.unpin;
  }
  api.onState(applyState);
  api.getState().then((s) => { applyState(s); restoreHistory(); });
})();
