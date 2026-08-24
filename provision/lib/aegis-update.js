'use strict';
// aegis-update.js — self-update of the hosted control plane, as an attested act.
//
// The plane runs from two git checkouts (aegis.js from the aegis repo, fleetctl from the fleet
// repo) and a systemd unit. Updating it means moving both checkouts to their pushed HEADs and
// restarting the unit -- which changes the code that executes every other attested lane, so it
// is itself attested and ledgered with the before/after commits of both repos. Nothing is
// typed: the plane is found by its contract (rg-<name> / <name>-vm), the pulls run as the
// service user (so ownership stays theirs), fast-forward only (a diverged checkout refuses
// rather than merges), and the restart is verified from the unit's own state and banner.
// Plan mode reads local vs remote heads on the VM and moves nothing.
const { c: col, which } = require('./util');
const { loadAegisContract } = require('./aegis-contract');
const { resolvePolicyPath, ledger } = require('./policy');
const { runOnVm, stdoutOf } = require('./vmrun');

const ADMIN = 'aegisadmin';
function attestSentence(name) { return 'I approve updating the control plane ' + name; }

// Pure: the two scripts. Exported for tests.
function planScript() {
  return ['#!/bin/bash', 'set -uo pipefail', 'U=' + ADMIN,
    'for R in aegis agent-fleet-iac; do D=/home/$U/$R;',
    '  sudo -u $U -H git -C "$D" fetch -q origin 2>/dev/null || { echo "$R fetch-failed"; continue; }',
    '  L=$(sudo -u $U -H git -C "$D" rev-parse --short HEAD); B=$(sudo -u $U -H git -C "$D" rev-parse --abbrev-ref HEAD); RM=$(sudo -u $U -H git -C "$D" rev-parse --short "origin/$B" 2>/dev/null || echo unknown);',
    // tracked changes only: the ledger and backups are untracked by design and never block a pull
    '  DIRTY=$(sudo -u $U -H git -C "$D" status --porcelain --untracked-files=no 2>/dev/null | wc -l);',
    '  echo "$R local=$L remote=$RM branch=$B dirty=$DIRTY"; done',
    'echo "unit=$(systemctl is-active aegis)"',
    // git can only say what is on disk. A plane that pulled and never restarted is clean,
    // current and active by every git measure while running months-old lanes, so ask the only
    // thing that knows what it booted: the process itself, over loopback (the edge is the
    // door, so there is no auth here). Unread is reported as unread, never as "no skew".
    'R=$(curl -s --max-time 5 http://127.0.0.1:7070/api/plane 2>/dev/null || true)',
    'if [ -n "$R" ]; then',
    '  S=$(printf "%s" "$R" | grep -o "\\"skewed\\":[a-z]*" | head -1 | cut -d: -f2)',
    '  D=$(printf "%s" "$R" | grep -o "\\"skewDetail\\":\\[[^]]*\\]" | head -1 | cut -d: -f2-)',
    '  echo "plane skewed=${S:-unknown} detail=${D:-none}"',
    'else',
    '  echo "plane skewed=unread detail=none"',
    'fi',
  ].join('\n') + '\n';
}
function goScript() {
  return ['#!/bin/bash', 'set -uo pipefail', 'U=' + ADMIN, 'FAIL=0',
    'for R in aegis agent-fleet-iac; do D=/home/$U/$R;',
    '  B=$(sudo -u $U -H git -C "$D" rev-parse --short HEAD);',
    '  if sudo -u $U -H git -C "$D" pull --ff-only -q 2>&1 | tail -n 1; then A=$(sudo -u $U -H git -C "$D" rev-parse --short HEAD); echo "$R before=$B after=$A"; else echo "$R pull-failed before=$B"; FAIL=1; fi; done',
    '[ "$FAIL" = 0 ] || { echo "ABORT: a pull failed (diverged checkout?) -- unit NOT restarted"; exit 1; }',
    'systemctl restart aegis; sleep 4',
    'echo "unit=$(systemctl is-active aegis)"',
    'journalctl -u aegis -n 5 --no-pager -o cat | grep -m1 "Aegis on" || echo "banner-missing"',
  ].join('\n') + '\n';
}
// Pure: parse "repo local=x remote=y branch=b dirty=n" lines. Exported for tests.
function parseHeads(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(aegis|agent-fleet-iac) local=(\S+) remote=(\S+) branch=(\S+) dirty=(\d+)/);
    if (m) out[m[1]] = { local: m[2], remote: m[3], branch: m[4], dirty: Number(m[5]), pending: m[2] !== m[3] };
    const f = line.match(/^(aegis|agent-fleet-iac) fetch-failed/);
    if (f) out[f[1]] = { local: '?', remote: '?', branch: '?', dirty: 0, pending: null, error: 'fetch failed' };
  }
  const u = String(text || '').match(/^unit=(\S+)/m);
  if (u) out.unit = u[1];
  const p = String(text || '').match(/^plane skewed=(\S+) detail=(.*)$/m);
  if (p) {
    let detail = [];
    try { const j = JSON.parse(p[2]); if (Array.isArray(j)) detail = j.map(String); } catch { /* not an array -- say nothing rather than guess */ }
    out.plane = { skewed: p[1] === 'true', unread: p[1] !== 'true' && p[1] !== 'false', detail };
  }
  return out;
}
function parseGo(text) {
  const out = { repos: {}, aborted: /ABORT:/.test(text) };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(aegis|agent-fleet-iac) before=(\S+) after=(\S+)/); if (m) out.repos[m[1]] = { before: m[2], after: m[3] };
    const p = line.match(/^(aegis|agent-fleet-iac) pull-failed before=(\S+)/); if (p) out.repos[p[1]] = { before: p[2], after: null, error: 'pull failed' };
  }
  const u = String(text || '').match(/^unit=(\S+)/m); out.unit = u ? u[1] : null;
  const b = String(text || '').match(/^Aegis on .*$/m); out.banner = b ? b[0] : null;
  return out;
}

async function runAegisUpdate(file, opts = {}) {
  console.log(col.cyan('aegis update' + (opts.go ? ' --go' : ' (plan)') + '  ' + file));
  const res = loadAegisContract(file);
  if (!res.ok) { console.log(col.red('\nContract INVALID:')); for (const e of res.errors) console.log('  - ' + e); return 1; }
  const v = res.value;
  const required = attestSentence(v.name);
  if (!which('az')) { console.log(col.red('\naz not found')); return 2; }
  const pr = runOnVm(v.resourceGroup, v.vmName, planScript(), 'aegis-plan');
  const heads = pr.ok ? parseHeads(stdoutOf(pr.msg)) : {};
  console.log(col.bold('\nCONTROL PLANE update — ' + v.name));
  console.log('  host            ' + v.resourceGroup + ' / ' + v.vmName + (pr.ok ? '' : col.red('   (unreachable: ' + pr.err + ')')));
  for (const r of ['aegis', 'agent-fleet-iac']) {
    const h = heads[r];
    console.log('  ' + r.padEnd(16) + (!h ? col.red('unread') : h.error ? col.red(h.error) : (h.pending ? col.yellow('update pending  ' + h.local + ' -> ' + h.remote) : col.green('current  ' + h.local)) + col.dim('   ' + h.branch + (h.dirty ? '   DIRTY: ' + h.dirty + ' local change(s) — a pull may refuse' : ''))));
  }
  console.log('  unit            ' + (heads.unit === 'active' ? col.green('active') : col.red(heads.unit || 'unknown')));
  const pl = heads.plane;
  console.log('  running code    ' + (!pl || pl.unread ? col.dim('unread — the plane did not answer on loopback')
    : pl.skewed ? col.red('STALE — ' + (pl.detail.join('; ') || 'the process is older than the checkout'))
    : col.green('matches the checkouts')));
  console.log('  attestation     ' + col.dim(required));
  console.log(col.dim('  --go pulls both checkouts fast-forward-only as ' + ADMIN + ' and restarts the unit — including when there was nothing to pull, which is how a STALE plane is recovered; a failed pull restarts nothing'));
  if (!opts.go) { console.log(col.yellow('\nplan only — nothing changed. Re-run with --go --attest "' + required + '" to update.')); return 0; }

  const policyPath = resolvePolicyPath();
  const base = { action: 'aegis.update', key: v.name, host: v.vmName, before: { aegis: heads.aegis && heads.aegis.local, fleet: heads['agent-fleet-iac'] && heads['agent-fleet-iac'].local } };
  const led = (extra) => { try { return policyPath ? ledger(policyPath, { ...base, ...extra }) : null; } catch { return null; } };
  if ((opts.attest || '').trim() !== required) {
    led({ phrase: opts.attest || '', outcome: 'refused: attestation mismatch' });
    console.log(col.red('\naegis update --go REFUSED — attestation must read exactly:')); console.log('  ' + required); return 3;
  }
  if (!pr.ok) { led({ phrase: opts.attest, outcome: 'refused: host unreachable: ' + pr.err }); console.log(col.red('\nREFUSED — host unreachable: ' + pr.err)); return 2; }
  const gr = runOnVm(v.resourceGroup, v.vmName, goScript(), 'aegis-update');
  const g = parseGo(stdoutOf(gr.msg));
  if (!gr.ok || g.aborted) {
    led({ phrase: opts.attest, after: g.repos, outcome: 'failed: ' + (g.aborted ? 'a pull failed; unit not restarted' : gr.err) });
    console.log(col.red('\nupdate FAILED (ledgered): ' + (g.aborted ? 'a pull failed (diverged checkout?) — the unit was NOT restarted' : gr.err)));
    console.log(stdoutOf(gr.msg)); return 1;
  }
  const rec = led({ phrase: opts.attest, after: { aegis: g.repos.aegis && g.repos.aegis.after, fleet: g.repos['agent-fleet-iac'] && g.repos['agent-fleet-iac'].after }, unit: g.unit, outcome: g.unit === 'active' ? 'ok' : 'ok (unit ' + g.unit + ' — investigate)' });
  console.log(col.green('\nupdated ' + v.name + ': aegis ' + (g.repos.aegis ? g.repos.aegis.before + ' -> ' + g.repos.aegis.after : '?') + ', fleet ' + (g.repos['agent-fleet-iac'] ? g.repos['agent-fleet-iac'].before + ' -> ' + g.repos['agent-fleet-iac'].after : '?') + ', unit ' + g.unit) + col.dim('  (ledgered ' + (rec ? 'ok' : 'NO') + ')'));
  if (g.banner) console.log(col.dim('  ' + g.banner));
  return g.unit === 'active' ? 0 : 1;
}

module.exports = { runAegisUpdate, attestSentence, planScript, goScript, parseHeads, parseGo };
