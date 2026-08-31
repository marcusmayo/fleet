'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The REAL handler, sliced out of fleet-core and run against a real filesystem. It cannot be
// required: mountOps closes over a dozen values an agent supplies. Slicing keeps the test honest
// about which bytes it is pinning.
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'webchat-ops.js'), 'utf8');
const CLS = SRC.slice(SRC.indexOf('  function classify(name, movedTo) {'), SRC.indexOf("  app.post('/files/process'"));
const HND = SRC.slice(SRC.indexOf("  app.post('/files/process'"), SRC.indexOf('  // ---- background / inlay'));

function mount({ intakeCmd = null, boom = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  const STAGE_DIR = path.join(root, 'state', 'staged');
  const STAGE_DEST = path.join(root, 'inbox', 'drop');
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STAGE_DIR, 'note.txt'), 'hello');

  const fs2 = boom
    ? new Proxy(fs, { get: (t, k) => (k === 'existsSync'
      ? (p) => { if (String(p).includes('inbox')) throw new Error('classifier blew up'); return t.existsSync(p); }
      : t[k]) })
    : fs;
  const cwd = root, STAGE_DEST_REL = 'inbox/drop', QUARANTINE_REL = null, INTAKE_CMD = intakeCmd, stageYamlErr = null;
  const safeFile = (n) => String(n || '').replace(/[^A-Za-z0-9._-]/g, '');
  const audit = () => {};
  const requireAuth = {};
  let handler = null;
  const app = { post: (r, g, h) => { handler = h; } };
  eval(CLS + HND); // eslint-disable-line no-eval
  return { handler, root, STAGE_DIR, STAGE_DEST };
}

function call(handler, name) {
  const out = { status: 200, body: null, threw: null };
  const res = { status(c) { out.status = c; return this; }, json(o) { out.body = o; return o; } };
  try { handler({ body: { name } }, res); } catch (e) { out.threw = e; }
  return out;
}

test('files/process: a successful move ANSWERS -- it does not throw past the response', () => {
  const m = mount();
  const r = call(m.handler, 'note.txt');
  assert.equal(r.threw, null, 'a throw here becomes an HTML 500 from express, after the file has already moved');
  assert.ok(r.body && r.body.ok === true, 'the handler must answer with its own JSON');
  assert.equal(fs.existsSync(path.join(m.STAGE_DIR, 'note.txt')), false, 'left staging');
  assert.equal(fs.existsSync(path.join(m.STAGE_DEST, 'note.txt')), true, 'landed in the pipeline dir');
});

test('files/process: a classifier that throws AFTER the move still answers, honestly', () => {
  const m = mount({ intakeCmd: 'true', boom: true });
  const r = call(m.handler, 'note.txt');
  assert.equal(r.threw, null, 'the file has moved; nothing past that line may reach express');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.verdict, 'pending', 'moved, verdict unknown -- never reported as a failure');
  assert.match(r.body.message, /classification failed/);
  assert.equal(fs.existsSync(path.join(m.STAGE_DEST, 'note.txt')), true);
});

test('files/process: a file that is not staged is refused BEFORE anything moves', () => {
  const m = mount();
  const r = call(m.handler, 'absent.txt');
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  assert.equal(fs.existsSync(path.join(m.STAGE_DEST, 'absent.txt')), false);
});

test('files/process: the destination path is in scope where the classifier reads it', () => {
  // The defect this pins: `const dst` lived inside the try, so every process threw
  // ReferenceError after the copy and unlink had both completed.
  const body = SRC.slice(SRC.indexOf("  app.post('/files/process'"), SRC.indexOf('  // ---- background / inlay'));
  const declLine = body.split('\n').findIndex((l) => l.includes('const dst = path.join(STAGE_DEST, name)'));
  const tryLine = body.split('\n').findIndex((l) => l.trim() === 'try {');
  assert.ok(declLine >= 0 && tryLine >= 0, 'both lines must exist');
  assert.ok(declLine < tryLine, 'dst must be declared BEFORE the try block, not inside it');
});

// --- staging must never lose a file to a name collision ---------------------------------------
const { uniqueStageName, safeUploadName, NAME_MAX } = require('../../core/webchat-ops');

function stageDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stg-'));
}

test('stage: two long names that sanitise identically are BOTH kept', () => {
  const a = '08-26 Daily Stand-up Meeting_ STM Product Versioning (SI vs GI), Rating Algorithm Updates, Mess LM Task Reassignment, and AI Training-transcript.txt';
  const b = '08-26 Daily Stand-up Meeting_ STM Product Versioning (SI vs GI), Rating Algorithm Updates, Mess LM Task Reassignment, and AI Training-transcript - Copy.txt';
  assert.equal(safeUploadName(a), safeUploadName(b), 'the premise: these collide after sanitising');
  const dir = stageDir();
  const name = safeUploadName(a);
  const one = Buffer.from('first file');
  const two = Buffer.from('a DIFFERENT file that happens to collide');

  const p1 = uniqueStageName(dir, name, one);
  assert.deepEqual(p1, { name, reused: false });
  fs.writeFileSync(path.join(dir, p1.name), one);

  const p2 = uniqueStageName(dir, name, two);
  assert.equal(p2.reused, false);
  assert.notEqual(p2.name, name, 'the second must not take the first name');
  fs.writeFileSync(path.join(dir, p2.name), two);

  assert.equal(fs.readdirSync(dir).length, 2, 'two uploads, two files');
  assert.equal(fs.readFileSync(path.join(dir, p1.name), 'utf8'), 'first file', 'the first was not overwritten');
});

test('stage: re-staging identical bytes is idempotent, not a second copy', () => {
  const dir = stageDir();
  const buf = Buffer.from('same every time');
  const p1 = uniqueStageName(dir, 'note.txt', buf);
  fs.writeFileSync(path.join(dir, p1.name), buf);
  const p2 = uniqueStageName(dir, 'note.txt', buf);
  assert.deepEqual(p2, { name: 'note.txt', reused: true });
  assert.equal(fs.readdirSync(dir).length, 1, 'clicking Stage twice must not multiply files');
});

test('stage: a de-duplicated name keeps the extension and respects NAME_MAX', () => {
  const dir = stageDir();
  const name = safeUploadName('x'.repeat(300) + '.txt');
  assert.equal(name.length, NAME_MAX);
  fs.writeFileSync(path.join(dir, name), Buffer.from('one'));
  const p = uniqueStageName(dir, name, Buffer.from('two'));
  assert.notEqual(p.name, name);
  assert.ok(p.name.endsWith('.txt'), 'the extension survives, or intake cannot type the file');
  assert.ok(p.name.length <= NAME_MAX, 'a de-duplicated name is still ' + NAME_MAX + ' or under');
});

test('stage: a third colliding file finds a third name, and matches an existing duplicate', () => {
  const dir = stageDir();
  const a = Buffer.from('A'), b = Buffer.from('B'), c = Buffer.from('C');
  fs.writeFileSync(path.join(dir, uniqueStageName(dir, 'n.txt', a).name), a);
  const p2 = uniqueStageName(dir, 'n.txt', b); fs.writeFileSync(path.join(dir, p2.name), b);
  const p3 = uniqueStageName(dir, 'n.txt', c); fs.writeFileSync(path.join(dir, p3.name), c);
  assert.equal(new Set(['n.txt', p2.name, p3.name]).size, 3, 'three distinct names');
  assert.deepEqual(uniqueStageName(dir, 'n.txt', b), { name: p2.name, reused: true },
    're-staging B must find the copy it already has, not make a fourth');
});
