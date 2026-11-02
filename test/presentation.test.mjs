import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMotion } from '../app/presentation.mjs';

test('system reduced motion limits full feedback without overriding off', () => {
  assert.equal(effectiveMotion('full', false), 'full');
  assert.equal(effectiveMotion('full', true), 'reduced');
  assert.equal(effectiveMotion('reduced', false), 'reduced');
  assert.equal(effectiveMotion('off', true), 'off');
  assert.equal(effectiveMotion('unexpected', false), 'full');
});
