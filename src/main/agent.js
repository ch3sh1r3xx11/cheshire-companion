'use strict';
// The conversation lives here, in the main process — not in a window.
//
// Both entrances (the chat window and the terminal `ask`) go through send(),
// so there is one history, one memory and one personality. Windows only
// display events; they never see the API key, never touch the network and
// never execute tools.

const gemini = require('./llm/gemini');
const ollama = require('./llm/ollama');

// How much history the model sees depends on the model, and it matters:
//  • small local models: 3 exchanges. Longer history does not improve their
//    memory, it drowns the system prompt in dialogue noise.
//  • Gemini: ~20 exchanges. With a million-token window, 3 exchanges is not
//    thrift but amnesia — the cat forgot things said four messages ago.
const KEEP_LOCAL = 6;
const KEEP_CLOUD = 40;
const KEEP_IMAGES = 2;       // screenshots outweigh the rest of the conversation
const MAX_TOOL_STEPS = 8;    // hard brake: the model must not loop on tools

// "(fact in parentheses)" is saved to memory and removed from what the model sees.
const PARENS = /\(([^)]{3,})\)/g;

function createAgent({ config, getSettings, persona, memory, chatLog, toolbox, emit, launch }) {
  let history = chatLog.read();
  let seq = 0;
  let queue = Promise.resolve();

  const isCloud = () => gemini.isCloudModel(getSettings().model);
  const P = () => persona();

  function systemPrompt() {
    const p = P();
    const s = getSettings();
    const parts = [p.system({
      operator: config.operatorName,
      home: config.homeDir,
      memoryFile: config.memoryFile,
      canvasFile: config.canvasFile,
      tools: toolbox.names(),
    })];
    if (toolbox.carouselsEnabled) parts.push(p.carouselsPrompt);
    if (p.temper[s.temper]) parts.push(p.temper[s.temper]);
    if (config.personaExtra) parts.push(config.personaExtra);
    const facts = memory.read();
    if (facts) parts.push(`${p.memoryHeader(config.operatorName)}\n${facts}`);
    return parts.join('\n\n');
  }

  function trim() {
    const keep = isCloud() ? KEEP_CLOUD : KEEP_LOCAL;
    if (history.length > keep) history = history.slice(-keep);
    history.filter((m) => m.image).slice(0, -KEEP_IMAGES).forEach((m) => { delete m.image; });
  }

  function persist() { chatLog.write(history); }

  function pushAssistant(text) {
    history.push({ role: 'assistant', content: text });
    persist();
  }

  // A reply produced by code, not the model (saved facts, launched apps).
  function quickReply(text) {
    pushAssistant(text);
    emit({ type: 'reply', id: ++seq, text, cmd: null });
    return text;
  }

  function tryRemember(text) {
    const m = text.match(P().remember);
    if (!m || !m[2].trim()) return null;
    memory.append(m[2].trim());
    return quickReply(P().lines.remembered);
  }

  function tryLaunch(text) {
    const p = P();
    if (!p.launchVerb.test(text)) return null;
    for (const [id, l] of Object.entries(config.launchers)) {
      const re = l.match[p.code];
      if (re && re.test(text)) {
        launch(l.path);
        return quickReply(l.reply[p.code] || p.lines.launched(id));
      }
    }
    return null;
  }

  async function askGemini(id) {
    const s = getSettings();
    const contents = gemini.toContents([...P().examples, ...history]);
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      tools: [{ functionDeclarations: toolbox.declarations() }],
      generationConfig: { temperature: 0.6 },
    };
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const data = await gemini.generate(s.model, body);
      const cand = data.candidates && data.candidates[0];
      if (!cand) throw new Error(P().lines.modelEmpty);
      // Gemini may return several parts at once (text + calls, or two calls).
      const parts = (cand.content && cand.content.parts) || [];
      const calls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n').trim();
      if (!calls.length) return text;

      contents.push({ role: 'model', parts }); // the whole model turn, not one piece
      for (const { functionCall: call } of calls) {
        emit({ type: 'status', id, text: P().lines.toolStatus[call.name] || call.name });
        const result = await toolbox.execute(call.name, call.args, {
          onAwaitingConsent: () => emit({ type: 'status', id, text: P().lines.awaitingApproval }),
        });
        contents.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: { result } } }] });
      }
    }
    return P().lines.tooManySteps(MAX_TOOL_STEPS);
  }

  async function askOllama() {
    const messages = [{ role: 'system', content: systemPrompt() }, ...P().examples, ...history];
    try {
      return await ollama.chat(config.ollama.url, getSettings().model, messages);
    } catch (e) {
      throw new Error(P().lines.ollamaDown + ` (${e.message})`, { cause: e });
    }
  }

  async function askModel() {
    const id = ++seq;
    emit({ type: 'thinking', id, text: P().lines.thinking });
    try {
      if (isCloud() && !gemini.hasKey()) {
        const text = P().lines.noKey;
        emit({ type: 'reply', id, text, cmd: null });
        return text;
      }
      let raw = isCloud() ? await askGemini(id) : await askOllama();

      // The model decided something is worth remembering → memory file.
      // The MEM: line is a note, not speech, so it is cut from the reply.
      const mem = raw.match(/^\s*MEM:\s*(.+)$/im);
      if (mem) {
        memory.append(mem[1].trim());
        raw = raw.replace(/^\s*MEM:\s*.+$/gim, '').trim();
      }
      pushAssistant(raw);
      const cmd = raw.match(/^\s*CMD:\s*(.+)$/im);
      emit({ type: 'reply', id, text: raw, cmd: cmd ? cmd[1].trim() : null });
      return raw;
    } catch (e) {
      const text = e.code === 'NO_KEY' ? P().lines.noKey : P().lines.error(e.message);
      emit({ type: 'error', id, text });
      return null;
    }
  }

  async function handle(text, { origin = 'chat', image = null } = {}) {
    const p = P();
    const input = String(text || '').slice(0, 20_000);

    const facts = [...input.matchAll(PARENS)].map((m) => m[1].trim()).filter(Boolean);
    facts.forEach((f) => memory.append(f));
    const clean = input.replace(PARENS, ' ').replace(/\s{2,}/g, ' ').trim();

    const forModel = clean || input.trim() || (image ? p.lines.imageOnly : '');
    if (!forModel) return null;

    if (image && !isCloud()) {
      emit({ type: 'notice', text: p.lines.noVision });
      return p.lines.noVision;
    }

    emit({ type: 'user', origin, text: forModel, image });
    history.push(image ? { role: 'user', content: forModel, image } : { role: 'user', content: forModel });
    trim();
    persist(); // your words survive even if the cat dies before answering

    // With an image go straight to the model: the shortcuts only read text.
    if (image) return askModel();
    if (facts.length && !clean) return quickReply(p.lines.parensSaved);
    return tryRemember(forModel) || tryLaunch(forModel) || askModel();
  }

  // One message at a time: the chat and the terminal must not interleave
  // their turns in the shared history.
  function send(text, opts) {
    const run = queue.then(() => handle(text, opts));
    queue = run.catch(() => {});
    return run;
  }

  // A separate thread of work (the canvas): same soul and memory, but it does
  // not go into the chat history.
  async function oneShot(prompt) {
    const system = systemPrompt();
    if (isCloud()) {
      const data = await gemini.generate(getSettings().model, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6 },
      });
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      return parts.filter((x) => typeof x.text === 'string').map((x) => x.text).join('\n').trim();
    }
    return ollama.chat(config.ollama.url, getSettings().model, [{ role: 'system', content: system }, { role: 'user', content: prompt }]);
  }

  return {
    send,
    oneShot,
    history: () => history.map(({ role, content }) => ({ role, content })),
  };
}

module.exports = { createAgent };
