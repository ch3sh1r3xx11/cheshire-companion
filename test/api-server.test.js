'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApiServer } = require('../src/main/api-server');

const PORT = 55991;

function request({ path = '/say?text=hi', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('local API accepts scripts and rejects browsers', async (t) => {
  const said = [];
  const api = createApiServer({
    port: PORT,
    ask: async (q) => ({ text: `echo ${q}`, cmd: null }),
    actions: { say: (p) => said.push(p.get('text')) },
  });
  await api.listen();
  t.after(() => api.close());

  const ok = { 'X-Cheshire': '1' };
  assert.equal((await request({ headers: ok })).status, 200);
  assert.deepEqual(said, ['hi']);

  // what an <img src> or a plain link would send: no custom header
  assert.equal((await request()).status, 403);
  // cross-site fetch: Origin is always present
  assert.equal((await request({ headers: { ...ok, Origin: 'https://evil.example' } })).status, 403);
  // DNS rebinding: foreign Host header
  assert.equal((await request({ headers: { ...ok, Host: 'evil.example:55991' } })).status, 403);

  const ask = await request({ path: '/ask', method: 'POST', headers: { ...ok, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'hello' }) });
  assert.equal(ask.status, 200);
  assert.equal(JSON.parse(ask.body).text, 'echo hello');

  assert.equal((await request({ path: '/ask', headers: ok })).status, 405);
  assert.equal((await request({ path: '/nope', headers: ok })).status, 404);
  assert.equal((await request({ path: '/ask', method: 'POST', headers: ok, body: 'x'.repeat(9000) })).status >= 400, true);
});
