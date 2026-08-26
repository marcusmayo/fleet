'use strict';
// fleet-core skills.js: the request-parameter grammar for spawn entries.
//
// The point of the grammar is that a skill needing an argument no longer has to be a
// handler entry living in one agent's server.js. What is pinned here is the boundary:
// a param may CONTRIBUTE to argv and may never REWRITE it, and a param that reaches
// argv must be constrained -- a spec that forgets is a BOOT failure, not a permissive
// request-time default.
const { test } = require('node:test');
const assert = require('node:assert');
const skills = require('../../core/skills.js');
const { validateParams, resolveParams } = skills;

const req = (query) => ({ query: query || {} });

// ---- boot-time refusals ---------------------------------------------------------

test('skills params: a param that reaches argv MUST declare enum or pattern', () => {
  assert.throws(() => validateParams('/r', [{ name: 'q' }]), /unconstrained pass-through is refused/);
  // constrained either way is fine
  assert.doesNotThrow(() => validateParams('/r', [{ name: 'q', pattern: '^.{1,20}$' }]));
  assert.doesNotThrow(() => validateParams('/r', [{ name: 'a', enum: ['x'] }]));
  // a gate contributes no argv, so it needs no constraint
  assert.doesNotThrow(() => validateParams('/r', [{ name: 'confirm', append: 'none', required: true }]));
});

test('skills params: malformed specs throw at boot with a fixable message', () => {
  assert.throws(() => validateParams('/r', { name: 'q' }), /params must be a list/);
  assert.throws(() => validateParams('/r', [{ enum: ['x'] }]), /param missing name/);
  assert.throws(() => validateParams('/r', [{ name: 'a', enum: ['x'] }, { name: 'a', enum: ['y'] }]), /declared twice/);
  assert.throws(() => validateParams('/r', [{ name: 'a', enumm: ['x'] }]), /unknown key "enumm"/);
  assert.throws(() => validateParams('/r', [{ name: 'a', append: 'exec', enum: ['x'] }]), /append must be value\|flag\|none/);
  assert.throws(() => validateParams('/r', [{ name: 'a', append: 'flag' }]), /needs flag: --something/);
  assert.throws(() => validateParams('/r', [{ name: 'a', append: 'flag', flag: 'commit' }]), /needs flag: --something/);
  assert.throws(() => validateParams('/r', [{ name: 'a', pattern: '([' }]), /not a valid regex/);
  assert.throws(() => validateParams('/r', [{ name: 'a', enum: [] }]), /non-empty list/);
  assert.throws(() => validateParams('/r', [{ name: 'a', enum: ['x'], maxItems: 0, split: true }]), /positive integer/);
  assert.deepStrictEqual(validateParams('/r', undefined), []);
});

// ---- the three real shapes, from keel's handlers ---------------------------------

test('skills params: allow-listed value plus a split list (the /run-merge shape)', () => {
  const spec = validateParams('/run-merge', [
    { name: 'action', required: true, enum: ['accept', 'reject', 'distinct'] },
    { name: 'keys', split: true, pattern: '^[A-Za-z0-9_.:-]{1,64}$', maxItems: 50 },
  ]);
  assert.deepStrictEqual(resolveParams(spec, req({ action: 'accept' })), { ok: true, extra: ['accept'] });
  assert.deepStrictEqual(resolveParams(spec, req({ action: 'reject', keys: 'A-1, B-2  C-3' })),
    { ok: true, extra: ['reject', 'A-1', 'B-2', 'C-3'] });
  // an action outside the list never reaches argv
  assert.strictEqual(resolveParams(spec, req({ action: 'delete' })).ok, false);
  assert.match(resolveParams(spec, req({ action: 'delete' })).output, /must be one of: accept\|reject\|distinct/);
  // required means required
  assert.strictEqual(resolveParams(spec, req({})).ok, false);
  // a key that does not match the pattern refuses the whole call rather than being dropped
  assert.strictEqual(resolveParams(spec, req({ action: 'accept', keys: 'ok-1 $(rm -rf /)' })).ok, false);
  // and the list is bounded
  const many = Array.from({ length: 51 }, (_, i) => 'K-' + i).join(',');
  assert.match(resolveParams(spec, req({ action: 'accept', keys: many })).output, /too many values/);
});

test('skills params: free text is still constrained, and carries its own usage line (the /run-find shape)', () => {
  const spec = validateParams('/run-find', [
    { name: 'q', required: true, pattern: '^.{1,200}$', missingMsg: 'usage: /find <feature or idea>' },
  ]);
  assert.deepStrictEqual(resolveParams(spec, req({ q: 'billing rewrite' })), { ok: true, extra: ['billing rewrite'] });
  assert.strictEqual(resolveParams(spec, req({ q: '   ' })).output, 'usage: /find <feature or idea>');
  assert.strictEqual(resolveParams(spec, req({})).output, 'usage: /find <feature or idea>');
  assert.strictEqual(resolveParams(spec, req({ q: 'x'.repeat(201) })).ok, false);
});

test('skills params: an exact-match gate appends a literal flag (the /run-apply shape)', () => {
  const spec = validateParams('/run-apply', [{ name: 'commit', equals: '1', append: 'flag', flag: '--commit' }]);
  assert.deepStrictEqual(resolveParams(spec, req({ commit: '1' })), { ok: true, extra: ['--commit'] });
  // absent, or anything other than the exact value, is a dry run -- never an error
  assert.deepStrictEqual(resolveParams(spec, req({})), { ok: true, extra: [] });
  assert.deepStrictEqual(resolveParams(spec, req({ commit: 'true' })), { ok: true, extra: [] });
  assert.deepStrictEqual(resolveParams(spec, req({ commit: '0' })), { ok: true, extra: [] });
});

test('skills params: a required gate refuses and contributes nothing to argv (the /run-e2e shape)', () => {
  const spec = validateParams('/run-e2e', [
    { name: 'confirm', required: true, enum: ['1'], append: 'none', missingMsg: 'destructive -- re-send with confirm=1' },
  ]);
  assert.deepStrictEqual(resolveParams(spec, req({ confirm: '1' })), { ok: true, extra: [] });
  assert.strictEqual(resolveParams(spec, req({})).output, 'destructive -- re-send with confirm=1');
  assert.strictEqual(resolveParams(spec, req({ confirm: 'yes' })).ok, false);
});

// ---- the boundary itself ---------------------------------------------------------

test('skills params: values are appended in spec order and never rewrite args', () => {
  const spec = validateParams('/r', [
    { name: 'a', enum: ['A'] }, { name: 'b', enum: ['B'] }, { name: 'c', enum: ['C'] },
  ]);
  // query order is irrelevant; the spec decides argv order
  assert.deepStrictEqual(resolveParams(spec, req({ c: 'C', a: 'A', b: 'B' })).extra, ['A', 'B', 'C']);
});

test('skills params: a refusal yields no argv at all, so no job can be started from a bad call', () => {
  const spec = validateParams('/r', [
    { name: 'ok', enum: ['yes'] },
    { name: 'bad', required: true, enum: ['only'] },
  ]);
  const r = resolveParams(spec, req({ ok: 'yes', bad: 'nope' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.extra, undefined);
});

test('skills params: a NUL byte is refused even where the pattern would allow it', () => {
  const spec = validateParams('/r', [{ name: 'q', pattern: '^[\\s\\S]{1,50}$' }]);
  assert.strictEqual(resolveParams(spec, req({ q: 'a\u0000b' })).ok, false);
});

test('skills params: mountSkills throws at boot on a bad param spec, before serving anything', () => {
  const app = { get() { throw new Error('a route must not be mounted from a bad spec'); } };
  assert.throws(() => skills.mountSkills(app, {
    requireAuth: (q, r, n) => n(), cwd: '/tmp',
    skills: [{ route: '/bad', bin: 'echo', args: [], params: [{ name: 'x' }] }],
  }), /unconstrained pass-through is refused/);
});

// ---- the config/core contract ----------------------------------------------------
// Vendored core and agent config move on separate schedules. The failure this pins is the
// SILENT one: an older core does not know `params`, ignores the key, and spawns the tool
// with no arguments. Declaring the floor turns that into a boot refusal.

test('skills contract: absent means 1, so an untouched agent needs no edit', () => {
  assert.strictEqual(skills.assertContract({ skills: [] }), 1);
  assert.strictEqual(skills.assertContract({}), 1);
});

test('skills contract: a config newer than its core refuses, and the message names the fix', () => {
  const tooNew = { contract: skills.SKILLS_CONTRACT_MAX + 1 };
  assert.throws(() => skills.assertContract(tooNew), (e) => {
    assert.match(e.message, /NEWER than its core/);
    assert.match(e.message, /sync-core\.sh/);
    assert.match(e.message, /do not edit the stamp/);
    return true;
  });
});

test('skills contract: the params grammar is contract 2 and sits inside the ceiling', () => {
  assert.ok(skills.SKILLS_CONTRACT_MAX >= 2);
  assert.strictEqual(skills.assertContract({ contract: 2 }), 2);
});

test('skills contract: a nonsense value is a boot error, never a silent default', () => {
  for (const bad of ['two', 0, -1, 1.5, null, true]) {
    assert.throws(() => skills.assertContract({ contract: bad }),
      /contract must be a positive integer/, 'contract: ' + JSON.stringify(bad));
  }
});

// ---- the job lane reports what a skill ran with -----------------------------------
// persistJob has always written argv to disk. listJobs projected a fixed field set that
// omitted it, so /skill-jobs could say a route ran but never with which arguments. With
// declared params that is the only difference between two calls to the same route.

test('skill jobs: the listing carries the argv the skill ran with', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const dir = path.join(cwd, 'state', 'skill-jobs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'j1.json'), JSON.stringify({
    jobId: 'j1', route: '/run-find', args: ['tools/find.py', 'billing'],
    actor: { src: 'cf-access', id: 'someone@example.com' },
    status: 'done', ok: true, exitCode: 0, timedOut: false,
    startedAt: '2026-08-25T02:00:00.000Z', endedAt: '2026-08-25T02:00:01.000Z', durationMs: 1000,
  }));
  const [row] = skills.listJobs(cwd, 10);
  assert.strictEqual(row.route, '/run-find');
  assert.deepStrictEqual(row.args, ['tools/find.py', 'billing']);
  assert.strictEqual(row.actor.id, 'someone@example.com');
  assert.strictEqual(row.ok, true);
});

test('skill jobs: a record written before argv was projected still reads, as an empty list', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const dir = path.join(cwd, 'state', 'skill-jobs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'j0.json'), JSON.stringify({
    jobId: 'j0', route: '/queue', status: 'done', ok: true, startedAt: '2026-08-25T01:00:00.000Z',
  }));
  const [row] = skills.listJobs(cwd, 10);
  assert.deepStrictEqual(row.args, [], 'absent argv reads as [] rather than undefined');
});

// ---- upload filenames -------------------------------------------------------------
// The sanitiser ended `.slice(0,120)`, which truncates from the tail -- exactly where the
// extension lives. A long "..._transcript.txt" arrived as "..._tr"; intake then refused it
// as an unsupported type and quarantined it. The gate was right. The name was damaged
// before it got there, and the operator had no way to see that from the refusal.

const ops = require('../../core/webchat-ops.js');

test('upload names: a long name keeps its extension so intake can still classify it', () => {
  const long = 'Meeting Transcript - Marketer API 2.0 Kickoff with several attendees, 2026-08-24, full session recording-transcript.txt';
  const out = ops.safeUploadName(long);
  assert.ok(out.length <= ops.NAME_MAX, 'still bounded');
  assert.ok(out.endsWith('.txt'), 'extension survived truncation: ' + out.slice(-20));
});

test('upload names: short names are untouched, and unsafe characters still go', () => {
  assert.strictEqual(ops.safeUploadName('short.txt'), 'short.txt');
  assert.strictEqual(ops.safeUploadName('a b/c.txt'), 'a_b_c.txt');
  assert.strictEqual(ops.safeUploadName('../../etc/passwd'), '.._.._etc_passwd', 'traversal is flattened, not preserved');
});

test('upload names: a long tail after a dot is not treated as an extension', () => {
  const out = ops.safeUploadName('b'.repeat(200) + '.verylongsuffixnotanextension');
  assert.strictEqual(out.length, ops.NAME_MAX);
  assert.ok(!out.includes('.'), 'a 28-char tail is not an extension worth preserving');
});

test('upload names: a leading dot is not an extension', () => {
  assert.strictEqual(ops.safeUploadName('.bashrc'), '.bashrc');
});

test('upload names: the result is always bounded, whatever comes in', () => {
  for (const n of ['x'.repeat(5000), 'y'.repeat(500) + '.txt', '', null, undefined]) {
    assert.ok(ops.safeUploadName(n).length <= ops.NAME_MAX);
  }
});
