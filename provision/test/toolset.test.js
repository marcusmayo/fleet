'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../../core/toolset');

function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

test('toolset: a tool reached only through another tool is in the closure', () => {
  const root = mk({
    'tools/a.py': 'from _helper import x\n',
    'tools/_helper.py': 'import pathlib\n',
    'system/skills.yaml': 'skills:\n  - args: [tools/a.py]\n',
  });
  const s = scan(root);
  assert.deepStrictEqual(s.closure, ['_helper', 'a']);
  assert.deepStrictEqual(s.missing, []);
});

test('toolset: a tool reached from handler code counts, not just from skills.yaml', () => {
  const root = mk({
    'tools/h.py': 'import pathlib\n',
    'webchat/server.js': "execFileSync('python3', ['tools/h.py'], {});\n",
    'system/skills.yaml': 'skills: []\n',
  });
  const s = scan(root);
  assert.deepStrictEqual(s.fromHandlers, ['h']);
  assert.ok(s.closure.includes('h'));
});

test('toolset: a reached tool that is absent from the repo is MISSING, not silently fine', () => {
  const root = mk({ 'system/skills.yaml': 'skills:\n  - args: [tools/ghost.py]\n' });
  const s = scan(root);
  assert.deepStrictEqual(s.missing, ['ghost']);
  assert.strictEqual(s.ok, false);
});

test('toolset: no declaration is reported as not-adopted, never as an empty declaration', () => {
  const root = mk({ 'tools/a.py': 'import pathlib\n', 'system/skills.yaml': 'skills: []\n' });
  assert.strictEqual(scan(root).declared, null);
});

test('toolset: a declaration that omits a reached tool is flagged undeclared', () => {
  const root = mk({
    'tools/a.py': 'import pathlib\n',
    'tools/b.py': 'import pathlib\n',
    'system/skills.yaml': 'skills:\n  - args: [tools/a.py]\n  - args: [tools/b.py]\n',
    'system/toolset.yaml': 'tools:\n  - a\n',
  });
  const s = scan(root);
  assert.deepStrictEqual(s.undeclared, ['b']);
  assert.strictEqual(s.ok, false);
});

test('toolset: stdlib imports are not reported as packages that must ship', () => {
  const root = mk({
    'tools/a.py': 'import pathlib\nimport glob\nimport traceback\nimport openpyxl\n',
    'system/skills.yaml': 'skills:\n  - args: [tools/a.py]\n',
  });
  assert.deepStrictEqual(scan(root).external, ['openpyxl']);
});

// --- the declaration is an INVENTORY, not a subset of what happens to be reached -------------
test('toolset: a tool carried in the repo but absent from the declaration is a fault', () => {
  const root = mk({
    'tools/a.py': '', 'tools/orphan.py': '',
    'system/skills.yaml': 'skills:\n  - route: /x\n    args: [tools/a.py]\n',
    'system/toolset.yaml': 'tools:\n  - a\n',
  });
  const s = scan(root);
  assert.deepEqual(s.undeclared, [], 'everything reached is declared');
  assert.deepEqual(s.carriedUndeclared, ['orphan'], 'the carried orphan is the fault');
  assert.equal(s.ok, false, 'an unlisted tool in the image must not pass');
});

test('toolset: a declaration naming a tool the repo does not have is a fault', () => {
  const root = mk({
    'tools/a.py': '',
    'system/skills.yaml': 'skills:\n  - route: /x\n    args: [tools/a.py]\n',
    'system/toolset.yaml': 'tools:\n  - a\n  - ghost\n',
  });
  const s = scan(root);
  assert.deepEqual(s.declaredMissing, ['ghost'], 'a declaration that names an absent tool is a lie');
  assert.equal(s.ok, false);
});

test('toolset: a complete declaration passes, unreached tools included', () => {
  const root = mk({
    'tools/a.py': '', 'tools/spare.py': '',
    'system/skills.yaml': 'skills:\n  - route: /x\n    args: [tools/a.py]\n',
    'system/toolset.yaml': 'tools:\n  - a\n  - spare\n',
  });
  const s = scan(root);
  assert.deepEqual(s.unreached, ['spare'], 'still reported as carried-but-unreached');
  assert.equal(s.ok, true, 'declared and present in both directions');
});

test('toolset: an empty declaration is a real statement, and holds only while nothing is carried', () => {
  const empty = scan(mk({ 'system/toolset.yaml': 'tools: []\n' }));
  assert.equal(empty.adopted, true, 'an empty list is adoption, not absence');
  assert.equal(empty.ok, true);
  const later = scan(mk({ 'tools/new.py': '', 'system/toolset.yaml': 'tools: []\n' }));
  assert.deepEqual(later.carriedUndeclared, ['new'], 'a tool dropped in later must be declared');
  assert.equal(later.ok, false);
});
