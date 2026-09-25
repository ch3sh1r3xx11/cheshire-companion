'use strict';
// Google Gemini (AI Studio). Runs in the main process only: the key is read
// from the environment, sent in a header (never in the URL, where it would end
// up in logs and error messages) and never reaches a window.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 90_000;

// Friendly names in the menu → the id the API actually serves.
const ALIASES = { 'gemini-3.1-pro': 'gemini-3.1-pro-preview' };

const isCloudModel = (model) => /^gemini/.test(String(model || ''));
const apiKey = () => String(process.env.GEMINI_API_KEY || '').trim();

async function generate(model, body, { signal } = {}) {
  const key = apiKey();
  if (!key) {
    const e = new Error('GEMINI_API_KEY is not set');
    e.code = 'NO_KEY';
    throw e;
  }
  const id = ALIASES[model] || model;
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(TIMEOUT_MS),
  });
  let data;
  try { data = await res.json(); } catch { throw new Error(`Gemini returned HTTP ${res.status} without JSON`); }
  if (!res.ok || data.error) throw new Error((data.error && data.error.message) || `Gemini returned HTTP ${res.status}`);
  return data;
}

// Internal history → Gemini contents. Images go BEFORE the text: Gemini ties a
// question to the image that precedes it, not the one that follows.
function toContents(messages) {
  return messages.map((m) => {
    const parts = [];
    if (m.image) parts.push({ inlineData: { mimeType: m.image.mime, data: m.image.data } });
    parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

module.exports = { generate, toContents, isCloudModel, hasKey: () => Boolean(apiKey()) };
