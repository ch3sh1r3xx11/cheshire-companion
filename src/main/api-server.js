'use strict';
// A tiny HTTP API on 127.0.0.1 for the terminal (`ask`), gestures and scripts.
//
// A firewall does not protect localhost: any web page you open can fire
// requests at it. Three locks keep browsers out:
//   1. Origin present → rejected. Browsers add it to cross-site requests,
//      terminals and scripts never do.
//   2. The X-Cheshire header is required. A page can only send custom headers
//      after a CORS preflight, which we never approve — and an <img> or a form
//      cannot send headers at all.
//   3. Host must be 127.0.0.1/localhost:<port>, which defeats DNS rebinding.

const http = require('node:http');

const MAX_BODY = 8000;
const CLIENT_HEADER = 'x-cheshire';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Oversized bodies are drained and discarded (not cut off mid-stream), so
    // the client gets a clean 413 instead of a reset connection.
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (res.headersSent) return;
  const isText = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(isText ? body : JSON.stringify(body));
}

function isTrusted(req, port) {
  if (req.headers.origin) return false;
  if (!req.headers[CLIENT_HEADER]) return false;
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {(q: string) => Promise<{text: string, cmd: string|null}>} opts.ask
 * @param {Record<string, (params: URLSearchParams) => void>} opts.actions  e.g. show, hide, toggle, say, canvas
 */
function createApiServer({ port, ask, actions }) {
  const server = http.createServer(async (req, res) => {
    if (!isTrusted(req, port)) return send(res, 403, 'forbidden');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = url.pathname.replace(/^\/+|\/+$/g, '');

    try {
      if (route === 'ask') {
        if (req.method !== 'POST') return send(res, 405, 'use POST');
        const raw = await readBody(req);
        let q = '';
        try { q = String(JSON.parse(raw).q || ''); } catch { q = raw; }
        q = q.trim();
        if (!q) return send(res, 400, { error: 'empty question' });
        return send(res, 200, await ask(q));
      }
      const action = Object.prototype.hasOwnProperty.call(actions, route) ? actions[route] : null;
      if (!action) return send(res, 404, 'unknown trick');
      action(url.searchParams);
      return send(res, 200, 'meow');
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  });
  server.requestTimeout = 150_000;
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
    }),
    close: () => server.close(),
  };
}

module.exports = { createApiServer, CLIENT_HEADER };
