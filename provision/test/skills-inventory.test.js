'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { composeSkills } = require('../../core/skills');

// provision/ has no js-yaml on purpose, so these pin PARSED input -- the same boundary
// assertContract was written to respect.
const INV = {
  contract: 2,
  skills: [
    { route: '/run-check-pii', bin: 'node', args: ['scripts/compliance-checks.js', 'pii'], timeout: 15000, record: 'pii-redaction', category: 'Governance' },
    { route: '/run-scan-tree', bin: 'node', args: ['scripts/scan-tree.js', '.'], timeout: 60000, category: 'Governance' },
  ],
};
const mine = (route) => ({ route, bin: 'node', args: ['scripts/x.js'] });

test('inventory: a named route resolves to the shared definition, unmodified', () => {
  const got = composeSkills({ contract: 2, inventory: ['/run-check-pii'], skills: [] }, INV);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], INV.skills[0]);
  assert.equal(got[0], INV.skills[0], 'the profile gets the shared object, not a copy it could diverge from');
});

test('inventory: taken skills come first, then the profile\'s own', () => {
  const got = composeSkills({ contract: 2, inventory: ['/run-scan-tree'], skills: [mine('/run-mine')] }, INV);
  assert.deepEqual(got.map((s) => s.route), ['/run-scan-tree', '/run-mine']);
});

test('inventory: naming a route the inventory does not define THROWS, and says what it offers', () => {
  assert.throws(
    () => composeSkills({ contract: 2, inventory: ['/run-imaginary'], skills: [] }, INV),
    (e) => /does not define/.test(e.message) && /run-check-pii/.test(e.message),
  );
});

test('inventory: a route both taken and defined locally is REFUSED, not silently resolved', () => {
  assert.throws(
    () => composeSkills({ contract: 2, inventory: ['/run-check-pii'], skills: [mine('/run-check-pii')] }, INV),
    /appears twice/,
  );
});

test('inventory: a route defined twice locally is refused too -- this was never checked before', () => {
  assert.throws(
    () => composeSkills({ contract: 2, skills: [mine('/a'), mine('/a')] }, INV),
    /appears twice/,
  );
});

test('inventory: a profile that takes nothing behaves exactly as before, with no inventory present', () => {
  assert.deepEqual(composeSkills({ contract: 2, skills: [mine('/a')] }, null).map((s) => s.route), ['/a']);
  assert.deepEqual(composeSkills({ contract: 2, inventory: [], skills: [mine('/a')] }, null).map((s) => s.route), ['/a']);
});

test('inventory: a non-list inventory key is refused rather than coerced', () => {
  assert.throws(() => composeSkills({ contract: 2, inventory: '/a', skills: [] }, INV), /must be a list/);
});

test('inventory: the inventory carries its own contract, and a newer one is refused', () => {
  assert.throws(
    () => composeSkills({ contract: 2, inventory: ['/run-check-pii'], skills: [] }, { contract: 99, skills: INV.skills }),
    /NEWER than its core/,
  );
});

// The shipped file, read as TEXT -- no parser needed to assert which routes it names.
test('inventory: the shipped fleet-core inventory names exactly the nine that were duplicated', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'skills-inventory.yaml'), 'utf8');
  const routes = [...raw.matchAll(/^\s*-\s*route:\s*(\S+)\s*$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(routes, [
    '/run-audit-verify', '/run-check-auth', '/run-check-backup', '/run-check-net',
    '/run-check-pause', '/run-check-pii', '/run-check-secrets', '/run-check-vuln',
    '/run-scan-tree',
  ]);
});
