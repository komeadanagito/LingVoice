import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, duration } from '../src/renderer/utils/format';

test('formats video durations consistently', () => {
  assert.equal(duration(0), '0:00');
  assert.equal(duration(125), '2:05');
  assert.equal(duration(3661), '1:01:01');
  assert.equal(duration(-5), '0:00');
});

test('formats transfer sizes and handles invalid values', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1024), '1.0 KB');
  assert.equal(bytes(1024 ** 2), '1.0 MB');
  assert.equal(bytes(-10), '0 B');
  assert.equal(bytes(Number.NaN), '0 B');
});
