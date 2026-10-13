import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordChecks, passwordStrength } from '../lib/password-rules.mjs';

const failing = (p, e) => passwordChecks(p, e).filter(c => !c.ok).map(c => c.id);

test('the checklist flags what the server would refuse', () => {
  assert.deepEqual(failing('Short-1a'), ['length']);
  assert.deepEqual(failing('alllowercaseletters'), ['mix']);
  assert.deepEqual(failing('Jane.Doe-River-9', 'jane.doe@gmail.com'), ['email']);
  assert.deepEqual(failing('Qwerty-Lane-88'), ['runs']);
  assert.deepEqual(failing('Moon-aaaa-Field-7'), ['runs']);
  assert.deepEqual(failing(''), ['length', 'mix', 'runs']);
});

test('strong passwords pass, longer ones rate higher', () => {
  assert.deepEqual(failing('Velvet-Harbor-73x'), []);
  assert.equal(passwordStrength('Velvet-Harbor-73x'), 'strong');
  assert.equal(passwordStrength('Copper-Lant8q'), 'fair');
  assert.equal(passwordStrength('weak'), 'weak');
});
