'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TIMELINE } = require('../src/main/demo');
const { PERSONAS } = require('../src/persona');

test('demo fits in 30 s, runs in order and every turn has lines in every language', () => {
  const times = TIMELINE.map(([at]) => at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(times.at(-1) <= 30_000);
  const turns = new Set(TIMELINE.filter(([, s]) => 'turn' in s).map(([, s]) => s.turn));
  for (const p of Object.values(PERSONAS)) {
    for (const t of turns) assert.ok(p.demo.chat[t].user && p.demo.chat[t].reply, `${p.code} turn ${t}`);
    assert.ok(p.demo.quip);
  }
});
