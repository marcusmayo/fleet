'use strict';
// The rebuild lane, and two things the provisioning path was saying that were not true.
//
// derive said the Key Vault was castor-only while vm.bicep has created one for every profile
// since the vault became the first-boot secret path -- so `plan` hid a vault and an identity it
// was about to create. A plan that under-reports what it builds is worse than no plan.
//
// vm.bicep also built a per-agent storage account, blob service, container and role assignment
// for every castor agent, and nothing ever wrote to them: agents back up to the FLEET store,
// whose name arrives in .provision-flags. Provisioning built a second, empty, billable store.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { derive } = require('../lib/derive');
const { rebuildScript } = require('../lib/rebuild');

const BICEP = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bicep', 'modules', 'vm.bicep'), 'utf8');
const base = { name: 'probe', domain: 'example.com', profile: 'keel', region: 'northcentralus', sshCidr: '', repoUrl: 'https://example.com/r', repoRef: '' };

test('every profile gets a vault in the plan, because every profile gets one in the template', () => {
  assert.strictEqual(derive({ ...base, profile: 'keel' }).azure.wantsVault, true);
  assert.strictEqual(derive({ ...base, profile: 'castor' }).azure.wantsVault, true);
  assert.match(BICEP, /var wantsVault = true/);
});

test('the per-agent backup account is gone from the template, not merely disabled', () => {
  assert.ok(!/wantsBackup/.test(BICEP), 'no wantsBackup flag');
  assert.ok(!/saName/.test(BICEP), 'no storage-account name derivation');
  assert.ok(!/backupsContainer|blobService|backupStorage/.test(BICEP), 'no per-agent storage resources');
  assert.ok(!/roleStorageBlobContributor/.test(BICEP), 'and no role constant left behind for it');
});

test('the template still creates the vault, the identity and the secrets-user assignment', () => {
  assert.match(BICEP, /Microsoft\.KeyVault\/vaults/);
  assert.match(BICEP, /userAssignedIdentities/);
  assert.match(BICEP, /raKvSecretsUser/);
});

test('rebuild asserts the named HEAD and refuses anything else', () => {
  const s = rebuildScript({ profile: 'castor', head: 'abc1234' });
  assert.match(s, /WANT=abc1234/);
  assert.match(s, /refusing to build something other than what was asked for/);
  assert.match(s, /exit 1/);
});

test('rebuild without --head asserts nothing rather than pretending to', () => {
  const s = rebuildScript({ profile: 'keel', head: '' });
  assert.match(s, /^WANT=$/m, 'empty means no assertion');
  assert.match(s, /if \[ -n "\$WANT" \]/, 'and the check is skipped, not faked');
});

test('rebuild restores tracked dirt, shows the overlay, builds, bootstraps and reads back', () => {
  const s = rebuildScript({ profile: 'castor', head: '' });
  for (const step of ['git checkout HEAD --', 'agent.local.yaml', 'build-image.sh', 'bootstrap.sh', 'readAgentName', 'liveliness']) {
    assert.ok(s.includes(step), 'missing step: ' + step);
  }
  assert.ok(s.indexOf('build-image.sh') < s.indexOf('bootstrap.sh'), 'build before bootstrap');
  assert.ok(s.indexOf('git pull') < s.indexOf('build-image.sh'), 'pull before build');
});

test('the payload carries no character that az --scripts would eat', () => {
  const s = rebuildScript({ profile: 'castor', head: 'abc1234' });
  assert.ok(!s.includes('`'), 'no backticks');
  // it ships as @file precisely so these are safe -- assert they are actually present, since a
  // payload rewritten to avoid them would be a sign someone inlined it into --scripts again
  assert.ok(s.includes('{{.Names}}'), 'docker format strings survive the @file path');
  assert.ok(s.includes('"$AD/scaffold"'), 'double quotes survive it too');
});

// The agent test gate. The point is not that tests run -- it is WHEN: against the freshly
// built image, with nothing serving yet, so a failing suite leaves the previous image up
// instead of promoting a broken one and discovering it from the front door afterwards.
test('rebuild: the agent test gate runs on the fresh image, BEFORE bootstrap', () => {
  const s = rebuildScript({ profile: 'keel', head: '' });
  assert.match(s, /4b\. agent tests/);
  assert.match(s, /run-tests\.js/);
  assert.match(s, /FATAL: agent tests failed/);
  // ordering is the whole guarantee
  const gate = s.indexOf('4b. agent tests');
  const boot = s.indexOf('5. bootstrap');
  const build = s.indexOf('4. build');
  assert.ok(build > -1 && gate > build, 'gate must come after the build');
  assert.ok(boot > -1 && gate < boot, 'gate must come BEFORE bootstrap or it is not a gate');
});

test('rebuild: an image without the runner says so loudly and does not silently pass', () => {
  const s = rebuildScript({ profile: 'castor', head: '' });
  assert.match(s, /NO TEST GATE/);
  assert.match(s, /has not adopted the test lane/);
  // the skip path must not be reachable by accident: it is guarded on the file existing
  assert.match(s, /\[ -f \/app\/scripts\/run-tests\.js \]/);
});

test('rebuild: the test container is offline, so a suite cannot pass by reaching the network', () => {
  const s = rebuildScript({ profile: 'keel', head: '' });
  assert.match(s, /docker run --rm --network none/);
});
