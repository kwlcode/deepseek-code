/** Session naming: generation, normalisation and collision handling. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { autoName, normalizeName, uniqueName, MAX_NAME_LENGTH } from '../src/names.js';

test('autoName produces a lowercase word pair', () => {
  for (let i = 0; i < 25; i += 1) {
    assert.match(autoName(), /^[a-z]+-[a-z]+$/);
  }
});

test('normalizeName turns user input into an address-safe slug', () => {
  assert.equal(normalizeName('Front End'), 'front-end');
  assert.equal(normalizeName('  My_Session  '), 'my_session');
  assert.equal(normalizeName('a//b'), 'a-b');
  assert.equal(normalizeName('--draft--'), 'draft');
  assert.equal(normalizeName('Build::Run!'), 'build-run');
  assert.equal(normalizeName('x'.repeat(50)).length, MAX_NAME_LENGTH);
});

test('normalizeName returns null when nothing usable is left', () => {
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName('   '), null);
  assert.equal(normalizeName('///'), null);
  assert.equal(normalizeName(null), null);
  assert.equal(normalizeName(undefined), null);
});

test('uniqueName keeps a free name and variants a taken one', () => {
  assert.equal(uniqueName('main'), 'main');
  assert.equal(uniqueName('main', ['other']), 'main');
  assert.equal(uniqueName('main', ['main']), 'main-2');
  assert.equal(uniqueName('main', ['main', 'main-2']), 'main-3');
});
