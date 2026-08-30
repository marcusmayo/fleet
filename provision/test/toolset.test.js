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
