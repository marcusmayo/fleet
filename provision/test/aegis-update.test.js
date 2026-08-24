'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { attestSentence, planScript, goScript, parseHeads, parseGo } = require('../lib/aegis-update');

test('aegis update: attestation sentence names the plane', () => {
  assert.strictEqual(attestSentence('aegis'), 'I approve updating the control plane aegis');
});
test('aegis update: plan script only fetches and reads (no pull, no restart)', () => {
  const s = planScript();
  assert.match(s, /git -C "\$D" fetch -q origin/); assert.match(s, /rev-parse --short HEAD/); assert.match(s, /systemctl is-active aegis/);
  assert.ok(!/pull/.test(s)); assert.ok(!/systemctl restart/.test(s));
});
test('aegis update: go script pulls fast-forward-only as the service user and refuses to restart after a failed pull', () => {
  const s = goScript();
  assert.match(s, /sudo -u \$U -H git -C "\$D" pull --ff-only/); assert.match(s, /ABORT: a pull failed/); assert.match(s, /systemctl restart aegis/);
  assert.ok(s.indexOf('ABORT: a pull failed') < s.indexOf('systemctl restart aegis'), 'abort gate precedes the restart');
});
test('aegis update: parseHeads reads pending/current/fetch-failed and the unit', () => {
  const h = parseHeads('aegis local=1111111 remote=2222222 branch=main dirty=0\nagent-fleet-iac local=3333333 remote=3333333 branch=main dirty=2\nunit=active\n');
  assert.strictEqual(h.aegis.pending, true); assert.strictEqual(h['agent-fleet-iac'].pending, false); assert.strictEqual(h['agent-fleet-iac'].dirty, 2); assert.strictEqual(h.unit, 'active');
  assert.strictEqual(parseHeads('aegis fetch-failed\n').aegis.error, 'fetch failed');
});
test('aegis update: the plan asks the plane what it is RUNNING, and unread is never read as current', () => {
  assert.match(planScript(), /api\/plane/);
  assert.match(planScript(), /plane skewed=/);
  const head = 'aegis local=1111111 remote=1111111 branch=main dirty=0\nunit=active\n';
  const cur = parseHeads(head + 'plane skewed=false detail=[]\n').plane;
  assert.deepStrictEqual(cur, { skewed: false, unread: false, detail: [] });
  const stale = parseHeads(head + 'plane skewed=true detail=["aegis: running aaaaaaa, checkout bbbbbbb"]\n').plane;
  assert.strictEqual(stale.skewed, true); assert.strictEqual(stale.unread, false);
  assert.deepStrictEqual(stale.detail, ['aegis: running aaaaaaa, checkout bbbbbbb']);
  // a plane that does not answer is UNREAD, never "no skew" -- silence is not evidence
  const unread = parseHeads(head + 'plane skewed=unread detail=none\n').plane;
  assert.strictEqual(unread.unread, true); assert.strictEqual(unread.skewed, false);
  // and a checkout-clean plan must still be able to say the running code is stale
  assert.strictEqual(parseHeads(head + 'plane skewed=true detail=none\n').aegis.pending, false);
});
test('aegis update: parseGo reads before/after, a failed pull, the abort, unit and banner', () => {
  const g = parseGo('aegis before=1111111 after=2222222\nagent-fleet-iac before=3333333 after=3333333\nunit=active\nAegis on http://127.0.0.1:7070  agents: bosun\n');
  assert.deepStrictEqual(g.repos.aegis, { before: '1111111', after: '2222222' }); assert.strictEqual(g.unit, 'active'); assert.match(g.banner, /^Aegis on/); assert.strictEqual(g.aborted, false);
  const bad = parseGo('fatal: Not possible to fast-forward, aborting.\naegis pull-failed before=1111111\nABORT: a pull failed (diverged checkout?) -- unit NOT restarted\n');
  assert.strictEqual(bad.aborted, true); assert.strictEqual(bad.repos.aegis.error, 'pull failed'); assert.strictEqual(bad.unit, null);
});
