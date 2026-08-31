'use strict';
const https = require('node:https');
const { c, findFleetRoot } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const cfg = require('./aegisconfig');

// GET https://<host><path> with the Cloudflare Access service-token headers.
// Never throws; resolves { ok, status, body } or { ok:false, error }.
function probe(host, clientId, clientSecret, path = '/health/liveliness') {
  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET',
      hostname: host,
      path,
      timeout: 15000,
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      },
    }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
      r.on('end', () => resolve({ ok: true, status: r.statusCode, body: body.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout after 15s' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

// What the VM itself says when the probe is not 200: cloud-init state, the build log's verdict,
// the retry log, the timers, the marker and the containers -- the read that took a hand-written
// run-command block twice on the day a fresh agent sat at 502. Runs through the guest agent
// (no network path, no SSH), the way every hardened-VM read already works. Pure builder; the
// script is exported for tests and travels as a file, so nothing here meets a shell parser.
function logsScript() {
  return [
    '#!/bin/bash',
    'set +e',
    'echo === cloud-init ===', 'cloud-init status 2>/dev/null | head -n 2',
    'echo === image build: verdict ===', 'grep -n -e BUILT -e "VERIFY FAIL" -e "verify-core OK" -e "BUILD FAILED" -e "returned a non-zero code" /var/log/agent-image-build.log 2>/dev/null | tail -n 6',
    'echo === retry log ===', 'grep -E "bootstrap retry|deferring|healthy|giving up|rebuilding|image build FAILED" /var/log/agent-bootstrap.log 2>/dev/null | tail -n 8',
    'echo === bootstrap: last lines ===', 'tail -n 6 /var/log/agent-bootstrap.log 2>/dev/null',
    'echo === timers ===', 'for u in agent-bootstrap-retry.timer agent-backup.timer agent-intake.timer; do printf "%s: " "$u"; systemctl is-active "$u" 2>/dev/null; done',
    'echo === first-boot marker ===', 'if test -f /run/agent-firstboot; then echo "present (first boot still running or stalled)"; else echo absent; fi',
    'echo === containers ===', 'docker ps -a --format "{{.Names}} {{.Status}}" 2>/dev/null',
    'echo === cloudflared ===', 'systemctl is-active cloudflared 2>/dev/null',
    '',
  ].join('\n');
}

function readVmLogs(d, name) {
  const { runOnVm, stdoutOf } = require('./vmrun');
  const r = runOnVm(d.azure.resourceGroup, d.azure.vmName, logsScript(), 'checklogs');
  if (!r.ok) { console.log(c.red('  --logs: run-command failed: ' + r.err)); console.log(c.dim('  (VM off? az not logged in? the RG gone?)')); return; }
  const body = stdoutOf(r.msg).trim();
  console.log(c.dim('  --logs: what ' + d.azure.vmName + ' says for itself:'));
  for (const line of body.split('\n')) console.log('    ' + line);
}

async function runCheckLive(file, opts = {}) {
  console.log(c.cyan(`check --live  ${file}`));
  const res = loadContract(file);
  if (!res.ok) {
    console.log(c.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  const d = derive(v);
  console.log(c.dim(`  probe: https://${d.cloudflare.fqdn}/health/liveliness  (via Cloudflare Access service token)`));

  const skip = (why) => {
    console.log(c.yellow(`\nSKIPPED live probe: ${why}`));
    return opts.requireLive ? 2 : 0;
  };

  const { path: configPath, exists } = cfg.resolveConfigPath(opts.aegisConfig, findFleetRoot());
  if (!configPath || !exists) return skip('aegis.config.json not found — register the agent first (or set $AEGIS_CONFIG)');

  let data;
  try { data = cfg.load(configPath); }
  catch (e) { console.log(c.red('\n' + e.message)); return 1; }

  const agent = data.agents.find((a) => a && a.name === v.name);
  if (!agent) return skip(`"${v.name}" is not registered in aegis.config.json (run register first)`);
  if (!agent.clientId || !agent.clientSecret) return skip(`"${v.name}" has no service-token credentials in the config`);

  console.log(c.bold('\nProbing…'));
  const r = await probe(d.cloudflare.fqdn, agent.clientId, agent.clientSecret);
  if (!r.ok) {
    console.log(c.red(`\nlive probe FAILED: ${r.error}`));
    console.log(c.dim('  Is the VM running (az vm start)? tunnel up? token valid?'));
    if (opts.logs) readVmLogs(d, v.name);
    return 1;
  }
  if (r.status === 200) {
    console.log(c.green(`\ncheck --live OK — ${d.cloudflare.fqdn} returned HTTP 200 (agent healthy).`));
    return await reportBuild(d, agent, v, opts);
  }
  console.log(c.red(`\ncheck --live: HTTP ${r.status} (expected 200).`));
  if (r.status === 403) console.log(c.dim('  403 = Cloudflare Access rejected the token — verify the Service Auth policy and token validity.'));
  if (r.status === 502 || r.status === 530) console.log(c.dim(`  ${r.status} = tunnel reachable, webchat not answering yet — still building or waiting for its seed; re-run in a few minutes.`));
  const snippet = r.body.replace(/\s+/g, ' ').trim();
  if (snippet) console.log(c.dim('  body: ' + snippet));
  if (opts.logs) readVmLogs(d, v.name);
  else console.log(c.dim('  add --logs to read the VM (cloud-init, build verdict, retry log, timers, containers) through run-command'));
  return 1;
}

// Which commit is the agent ACTUALLY running -- asked of the agent, not inferred from what a
// rebuild was told to build. An agent on an image built before the stamp existed answers
// commit: null, and that is reported as unknown rather than as a match or a mismatch.
//
// --expect <sha> turns the report into a GATE: a mismatch returns non-zero. Prefix comparison in
// both directions, because a stamp is a short sha and an operator may paste a full one. A
// '-dirty' suffix never matches away: it is reported loudly and fails an --expect outright,
// since an image containing uncommitted code is not the commit it names.
async function reportBuild(d, agent, v, opts = {}) {
  const expect = String(opts.expect || '').trim();
  const r = await probe(d.cloudflare.fqdn, agent.clientId, agent.clientSecret, '/build');
  if (!r.ok || r.status !== 200) {
    const why = r.ok ? ('HTTP ' + r.status) : r.error;
    console.log(c.yellow(`  build provenance: UNAVAILABLE (${why}) — rebuild the agent to mount GET /build`));
    if (expect) { console.log(c.red(`  --expect ${expect} cannot be satisfied: the agent cannot state its commit.`)); return 1; }
    return 0;
  }
  let j = null;
  try { j = JSON.parse(r.body); } catch { /* not json */ }
  const commit = j && typeof j.commit === 'string' ? j.commit : null;
  if (!commit) {
    console.log(c.yellow('  build provenance: UNKNOWN — the image carries no build stamp (built before provenance landed)'));
    if (expect) { console.log(c.red(`  --expect ${expect} cannot be satisfied: the image carries no stamp.`)); return 1; }
    return 0;
  }
  const dirty = /-dirty$/.test(commit);
  console.log(`  build provenance: running ${c.bold(commit)}  (${j.profile || '?'} / ${j.name || '?'})`);
  if (dirty) console.log(c.red('  !!!! this image was built from a tree with UNCOMMITTED changes -- it is not the commit it names'));
  if (!expect) return 0;
  const bare = commit.replace(/-dirty$/, '');
  const matches = !dirty && (bare.startsWith(expect) || expect.startsWith(bare));
  if (matches) { console.log(c.green(`  --expect ${expect}: MATCH`)); return 0; }
  console.log(c.red(`  --expect ${expect}: MISMATCH -- the agent is running ${commit}`));
  return 1;
}

module.exports = { runCheckLive, logsScript, reportBuild };
