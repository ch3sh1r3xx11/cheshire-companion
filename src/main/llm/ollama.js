'use strict';
// Ollama (local or LAN). Small local models get a short history and no tools —
// they drown facts from the system prompt in dialogue noise and fumble tool
// calls, so the agent treats them as "chat only".

const TIMEOUT_MS = 120_000; // an old CPU with a 3B model can take its time

async function chat(baseUrl, model, messages) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: false,
      options: { temperature: 0.6, repeat_penalty: 1.15, num_ctx: 16384 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = await res.json();
  return String((data.message && data.message.content) || '').trim();
}

async function listModels(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data.models) ? data.models : [])
    .filter((m) => m && typeof m.name === 'string')
    .map((m) => ({ id: m.name, size: Number(m.size) || 0 }))
    .sort((a, b) => a.size - b.size);
}

module.exports = { chat, listModels };
