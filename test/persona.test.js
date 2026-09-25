'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PERSONAS } = require('../src/persona');

// Walk an object and list every key path with the type found there.
function shape(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) out.push(...shape(v, key + '.'));
    else out.push(`${key}:${Array.isArray(v) ? 'array' : v instanceof RegExp ? 'regexp' : typeof v}`);
  }
  return out.sort();
}

test('every language defines the same keys with the same types', () => {
  const [base, ...rest] = Object.values(PERSONAS);
  for (const p of rest) assert.deepEqual(shape(p), shape(base), `persona ${p.code} differs from ${base.code}`);
});

test('system prompt carries the home paths and tools', () => {
  for (const p of Object.values(PERSONAS)) {
    const s = p.system({ operator: 'Ada', home: 'C:\\Cat', memoryFile: 'memory.md', canvasFile: 'canvas.md', tools: ['read_file'] });
    assert.match(s, /C:\\Cat/);
    assert.match(s, /memory\.md/);
    assert.match(s, /read_file/);
    assert.match(s, /Ada/);
  }
});

test('few-shot examples alternate user/assistant', () => {
  for (const p of Object.values(PERSONAS)) {
    p.examples.forEach((m, i) => assert.equal(m.role, i % 2 ? 'assistant' : 'user'));
  }
});
