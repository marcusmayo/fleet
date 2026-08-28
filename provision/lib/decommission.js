'use strict';
// Decommission — the reverse of `up`. Discovers every surface an agent occupies
// (Cloudflare tunnel/DNS/app/token, Azure RG, Aegis registry, local contract file)
// and, with --go, tears them down in a safe order. Plan (no --go) is READ-ONLY.
//
// Teardown order matters:
//   1 Aegis deregister + 2 local file : local/safe, do first.
//   3 Azure RG delete (blocking)      : kills the VM + cloudflared connector so the
//                                       tunnel has no live connections to block on.
//   4 Access app delete               : removes its Service-Auth policy, freeing the
//                                       service token (delete-while-referenced 400s).
//   5 service token  6 DNS  7 tunnel  : now unreferenced / connector dead.

const fs = require('node:fs');
const path = require('node:path');
const { c, runCapture, findFleetRoot } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const cf = require('./cfapi');
const cfg = require('./aegisconfig');
const { loadAegisContract } = require('./aegis-contract');
const { runOnVm, stdoutOf } = require('./vmrun');
const { runDeregister } = require('./register');

const env = (n) => (process.env[n] || '').trim();

// Which registry does this plane hold, and is the agent in it? Resolved exactly as up/register/
// deregister/enroll resolve it (explicit flag, $AEGIS_CONFIG, $AEGIS_DIR, the aegis checkout beside
// the fleet root). This lane once read only the flag and the env var, found nothing on a workstation
// that had neither, printed "not registered", skipped the surface and said complete while the
// registry still held the agent. Unresolvable is its own state, reported and counted as a failed
// surface -- never "not registered". Pure read; exported for tests.
// THE HOSTED PLANE'S REGISTRY -----------------------------------------------------------
// resolveConfigPath finds a registry on THIS machine. That was the whole truth when the console
// ran on the workstation; with a hosted plane there are two registries and the local one is not
// the one serving the panel. A teardown that cleaned only the local file printed a tick and left
// the agent listed in the plane -- a resolved-but-wrong registry counted as success, which is
// worse than an unresolved one, because an unresolved one refuses.
//
// The plane is found by its own contract (rg-<n> / <n>-vm) and reached the way every other
// hardened-VM lane reaches it: the Azure guest agent, no network path, no SSH. Absent contract
// = no hosted plane = the surface is genuinely absent, not skipped in ignorance.
const PLANE_REGISTRY = '/home/aegisadmin/aegis/aegis.config.json';
const PLANE_FLEET = '/home/aegisadmin/agent-fleet-iac';

function planeContractPath() {
  const root = findFleetRoot();
  if (!root) return null;
  const p = path.join(root, 'agents', 'aegis.contract.jsonc');
  return fs.existsSync(p) ? p : null;
}

// -> { present: true|false|null, rg, vm, name, err } -- null means could not read, which is
// reported as unreadable and NEVER as absent: "no answer" is not "not there".
function planeState(agentName) {
  const cp = planeContractPath();
  if (!cp) return { present: false, absent: true };
  let v;
  try {
    const res = loadAegisContract(cp);
    if (!res.ok) return { present: null, err: 'plane contract invalid: ' + (res.errors || []).join('; ') };
    v = res.value;
  } catch (e) { return { present: null, err: 'plane contract unreadable: ' + e.message }; }
  const script = ['#!/usr/bin/env bash', 'set -o pipefail',
    'if [ ! -f ' + PLANE_REGISTRY + ' ]; then echo NOREGISTRY; exit 0; fi',
    'sudo -u aegisadmin node -e \'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));' +
      'console.log((c.agents||[]).some(a=>a&&a.name===process.argv[2])?"PRESENT":"ABSENT")}catch(e){console.log("UNREADABLE:"+e.message)}\' ' +
      PLANE_REGISTRY + ' ' + JSON.stringify(agentName),
  ].join('\n') + '\n';
  const r = runOnVm(v.resourceGroup, v.vmName, script, 'plane-registry');
  if (!r.ok) return { present: null, rg: v.resourceGroup, vm: v.vmName, name: v.name, err: 'plane unreachable: ' + r.err };
  const out = stdoutOf(r.msg);
  const base = { rg: v.resourceGroup, vm: v.vmName, name: v.name };
  if (/\bPRESENT\b/.test(out)) return { ...base, present: true };
  if (/\bABSENT\b/.test(out) || /NOREGISTRY/.test(out)) return { ...base, present: false };
  return { ...base, present: null, err: 'plane registry unreadable: ' + out.trim().split('\n').pop() };
}

// Deregister on the plane, then READ THE REGISTRY BACK. An exit code says the command ran; only
// the file says the agent is gone.
function planeDeregister(ps, agentName) {
  const script = ['#!/usr/bin/env bash', 'set -o pipefail',
    'cd ' + PLANE_FLEET + ' || { echo "NOFLEET"; exit 1; }',
    'sudo -u aegisadmin -H node ' + PLANE_FLEET + '/provision/bin/fleetctl.js deregister ' + JSON.stringify(agentName) +
      ' --aegis-config ' + PLANE_REGISTRY + ' 2>&1 | tail -5',
    'echo "--- read back ---"',
    'sudo -u aegisadmin node -e \'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));' +
      'console.log((c.agents||[]).some(a=>a&&a.name===process.argv[2])?"STILL-PRESENT":"GONE")}catch(e){console.log("UNREADABLE:"+e.message)}\' ' +
      PLANE_REGISTRY + ' ' + JSON.stringify(agentName),
  ].join('\n') + '\n';
  const r = runOnVm(ps.rg, ps.vm, script, 'plane-dereg');
  if (!r.ok) throw new Error('plane unreachable: ' + r.err);
  const out = stdoutOf(r.msg);
  if (/\bGONE\b/.test(out)) return;
  if (/STILL-PRESENT/.test(out)) throw new Error('deregister ran but the plane registry still lists the agent');
  throw new Error('could not verify the plane registry after deregister: ' + out.trim().split('\n').pop());
}

// -> { aegisPath, aegisResolved, aegis, aegisError? }
function registryState(aegisConfig, name) {
  const reg = cfg.resolveConfigPath(aegisConfig, findFleetRoot());
  const out = { aegisPath: reg.path, aegisResolved: !!(reg.path && reg.exists), aegis: false };
  if (!out.aegisResolved) return out;
  try {
    const conf = cfg.load(reg.path);
    out.aegis = (conf.agents || []).some((a) => a && a.name === name);
  } catch (e) { out.aegisResolved = false; out.aegisError = e.message; }
  return out;
}

// Every service token that grants access to THIS agent's app is this agent's token, whichever
// control plane minted it: `up` mints aegis-<name>; each plane's `enroll` mints <plane>-<name>.
// A teardown that deleted only aegis-<name> left the plane's token behind as a live, unreferenced
// credential (found on the first enrolled agent decommissioned from a workstation). Selection is
// exact where it can be -- the tokens the app's own Service Auth policies reference -- and by the
// <plane>-<name> naming when the app is already gone (a re-run), guarded so a token that belongs
// to another agent whose name ends the same way is never touched. Pure; exported for tests.
function selectAgentTokens(tokens, appPolicies, name, otherNames = []) {
  const byId = new Map((tokens || []).filter((t) => t && t.id).map((t) => [t.id, t]));
  const out = new Map();
  for (const t of byId.values()) if (t.name === 'aegis-' + name) out.set(t.id, t);
  for (const p of appPolicies || []) {
    for (const inc of (p && p.include) || []) {
      const id = inc && inc.service_token && inc.service_token.token_id;
      if (id && byId.has(id)) out.set(id, byId.get(id));
    }
  }
  const suffix = '-' + name;
  for (const t of byId.values()) {
    if (typeof t.name !== 'string' || !t.name.endsWith(suffix) || t.name.length === suffix.length) continue;
    const belongsToLonger = (otherNames || []).some((o) => o && o !== name && o.length > name.length && t.name.endsWith('-' + o));
    if (!belongsToLonger) out.set(t.id, t);
  }
  return [...out.values()];
}

async function discover(file, d, accountId, cfToken, aegisConfig) {
  const name = d.register.name;
  const fqdn = d.cloudflare.fqdn;
  const domain = fqdn.slice(fqdn.indexOf('.') + 1); // everything after the first label
  const s = { name, fqdn, rgName: d.azure.resourceGroup };

  try {
    s.tunnel = await cf.findTunnelByName(accountId, name, cfToken);
    s.app = await cf.findAppByHostname(accountId, fqdn, cfToken);
    // other registered names, so a <plane>-<other> token is never mistaken for one of ours
    let others = [];
    try { const reg = cfg.resolveConfigPath(aegisConfig, findFleetRoot()); if (reg.path && reg.exists) others = (cfg.load(reg.path).agents || []).map((a) => a && a.name).filter(Boolean); } catch { others = []; }
    const allTokens = await cf.listServiceTokens(accountId, cfToken);
    const appPolicies = s.app ? await cf.listAppPolicies(accountId, s.app.id, cfToken).catch(() => []) : [];
    s.tokens = selectAgentTokens(allTokens, appPolicies, name, others);
    s.token = s.tokens.find((t) => t.name === `aegis-${name}`) || null;   // the lane's own token, for the legacy checks
    s.zoneId = await cf.findZoneIdByName(domain, cfToken);
    s.dns = s.zoneId ? await cf.findDnsRecordByHostname(s.zoneId, fqdn, cfToken) : null;
    // Legacy hand-built agents (pre-fleetctl) also carried an ssh-<name> tunnel hostname
    // (+ sometimes an Access app on it). Modern `up` builds are tunnel-only and never create
    // these, so this discovery is a no-op for fleet-provisioned agents -- but sweeping them
    // here means ONE decommission run leaves zero Cloudflare residue either way.
    s.sshFqdn = 'ssh-' + name + '.' + domain;
    s.appSsh = await cf.findAppByHostname(accountId, s.sshFqdn, cfToken);
    s.dnsSsh = s.zoneId ? await cf.findDnsRecordByHostname(s.zoneId, s.sshFqdn, cfToken) : null;
    // Legacy account-level REUSABLE policies (hand-built era): fleetctl-provisioned apps use
    // INLINE policies that die with the app, but the original agents' reusable policies
    // survive app deletion and keep the service token "in use" (CF 12139). Sweep any that
    // reference this agent's token, plus the agent's <name>-operator allow policy.
    s.policies = [];
    try {
      const all = await cf.listReusablePolicies(accountId, cfToken);
      const ids = (s.tokens || []).map((t) => t.id);
      s.policies = (all || []).filter((p) => ids.some((id) => JSON.stringify(p).includes(id)) || p.name === name + '-operator');
    } catch { /* older accounts / perms: skip quietly */ }
  } catch (e) {
    s.cfErr = e.message;
  }

  const rg = runCapture('az', ['group', 'exists', '-n', s.rgName]);
  s.rg = String(rg.stdout || '').trim() === 'true';

  // Locks on the RG. The protection mirror is one CanNotDelete lock named fleet-protect: when
  // policy says the agent is NOT protected but that lock is still there, it is an orphan of a
  // failed unprotect sync (seen live: an unprotect ledgered ok with syncOutcome AuthorizationFailed
  // left the lock behind, and the RG delete was refused with ScopeLocked while every Cloudflare
  // surface was already gone). Read them here so the plan says so, and --go reconciles the
  // mirror -- policy is the source of truth -- before the RG delete. A lock with any other name
  // is somebody else's decision and refuses the teardown instead.
  s.locks = [];
  if (s.rg) {
    try { const lk = runCapture('az', ['lock', 'list', '-g', s.rgName, '-o', 'json']); const arr = lk.ok ? JSON.parse(lk.stdout || '[]') : []; s.locks = (arr || []).map((l) => ({ name: l.name, level: l.level })).filter((l) => l.name); }
    catch { s.locks = []; }
  }

  // The agent's Key Vault. Its name is deterministic per agent (<name>-kv-<hash>) and soft-delete
  // holds the name for 7 days after the RG goes, so a same-name re-provision (region move,
  // rebuild) collides with a shell that no longer serves anything. Discover it live in the RG
  // (to be soft-deleted by the RG delete) or already soft-deleted (a previous teardown), and
  // PURGE it as the last Azure surface -- purge protection is off by design for exactly this.
  s.vault = null; s.deletedVault = null;
  try {
    if (s.rg) {
      const kv = runCapture('az', ['keyvault', 'list', '-g', s.rgName, '-o', 'json']);
      const list = kv.ok ? JSON.parse(kv.stdout || '[]') : [];
      const hit = (list || []).find((v) => v && typeof v.name === 'string' && v.name.startsWith(name + '-kv-'));
      if (hit) s.vault = { name: hit.name, location: hit.location };
    }
    const dl = runCapture('az', ['keyvault', 'list-deleted', '-o', 'json']);
    const dead = dl.ok ? JSON.parse(dl.stdout || '[]') : [];
    const gone = (dead || []).find((v) => v && typeof v.name === 'string' && v.name.startsWith(name + '-kv-'));
    if (gone) s.deletedVault = { name: gone.name, location: (gone.properties && gone.properties.location) || gone.location || '' };
  } catch { /* unreadable -> not listed; RG delete still proceeds */ }

  Object.assign(s, registryState(aegisConfig, name));
  s.plane = planeState(name);

  s.localFile = fs.existsSync(file) ? file : null;
  return s;
}

// One rule, two consumers: the plan prints this verdict and execute acts on it, so the
// sentence the operator reads before typing --go is the sentence that governs the delete.
// A fleet-protect lock is only an ORPHAN if a real policy file says the agent is not
// protected. Absence of a policy is not a statement that the agent is unprotected, and a
// mirror is not removed on a default.
function lockVerdict(locks, protection) {
  const foreign = (locks || []).filter((l) => l.name !== 'fleet-protect');
  const mirror = (locks || []).filter((l) => l.name === 'fleet-protect');
  if (foreign.length) return { act: 'refuse-foreign', foreign, mirror };
  if (mirror.length && !(protection && protection.ok)) {
    return { act: 'refuse-unjudged', foreign, mirror, why: (protection && protection.error) || 'no policy file resolved' };
  }
  return { act: 'proceed', foreign, mirror, source: (protection && protection.source) || null };
}

function printPlan(s) {
  const del = (extra) => c.yellow('DELETE') + (extra ? c.dim('  ' + extra) : '');
  const gone = (extra) => c.dim((extra ? extra + ' — ' : '') + 'absent');
  const vaultLine = s.vault
    ? del(s.vault.name + ' — soft-deleted by the RG delete, then PURGED so the name is free for a same-name re-provision')
    : s.deletedVault ? del(s.deletedVault.name + ' — already soft-deleted; PURGE') : gone('vault');
  console.log(c.bold(`\nTeardown plan for "${s.name}"  (surfaces present are DELETE; absent are skipped)`));
  console.log(`  1 Aegis registry     ${s.aegisResolved
    ? (s.aegis ? c.yellow('DEREGISTER') + c.dim('  ' + s.aegisPath) : c.dim('not registered  ' + s.aegisPath))
    : c.red('UNRESOLVED') + c.dim('  no aegis.config.json (' + (s.aegisError || 'set $AEGIS_CONFIG or pass --aegis-config') + ') -- counts as a failed surface at --go')}`);
  const pl = s.plane || {};
  console.log(`  1b Plane registry    ${pl.absent
    ? c.dim('no hosted plane (no agents/aegis.contract.jsonc) -- nothing to deregister')
    : pl.present === true ? c.yellow('DEREGISTER') + c.dim('  ' + pl.rg + ' / ' + pl.vm + ':' + PLANE_REGISTRY)
    : pl.present === false ? c.dim('not registered  ' + (pl.vm || 'plane'))
    : c.red('UNREADABLE') + c.dim('  ' + (pl.err || 'could not read the plane registry') + ' -- counts as a failed surface at --go')}`);
  console.log(`  2 local config       ${s.localFile ? del(s.localFile) : gone()}`);
  console.log(`  3 Azure RG           ${s.rg ? del(s.rgName) : gone(s.rgName)}`);
  console.log(`  4 CF Access app      ${s.app ? del(s.app.id) : gone()}`);
  console.log(`  5 CF service tokens  ${(s.tokens && s.tokens.length) ? del(s.tokens.map((t) => `${t.name} ${t.id}`).join(', ')) : gone('none named aegis-' + s.name + ' / <plane>-' + s.name + ', none referenced by the app')}`);
  console.log(`  6 CF DNS (CNAME)     ${s.dns ? del(s.fqdn) : gone(s.fqdn)}`);
  console.log(`  7 CF tunnel          ${s.tunnel ? del(s.tunnel.id) : gone(s.name)}`);
  console.log(`  8 Key Vault (purge)  ${vaultLine}`);
  const lv = lockVerdict(s.locks, s.protection);
  for (const l of (lv.foreign || [])) {
    console.log('  !  RG lock           ' + c.red(l.name + ' (' + l.level + ') — NOT the fleet mirror; the RG delete will be refused until it is removed by whoever set it'));
  }
  for (const l of (lv.mirror || [])) {
    console.log('  !  RG lock           ' + (lv.act === 'proceed'
      ? c.yellow(l.name + ' (' + l.level + ') — policy ' + lv.source + ' says "' + s.name + '" is not protected, so this is an orphan of a failed unprotect sync; --go removes it before the RG delete')
      : lv.act === 'refuse-unjudged'
        ? c.red(l.name + ' (' + l.level + ') — UNJUDGEABLE: ' + lv.why + '. A mirror is only an orphan if a policy file says so, so --go will REFUSE the RG delete rather than remove it on a default')
        : c.red(l.name + ' (' + l.level + ') — the fleet mirror, but a foreign lock above already refuses this teardown')));
  }
  if (s.appSsh || s.dnsSsh || (s.policies && s.policies.length)) {
    console.log(c.dim('  legacy leftovers (hand-built era):'));
    if (s.appSsh) console.log(`  +  CF Access app     ${del(s.sshFqdn)}`);
    if (s.dnsSsh) console.log(`  +  CF DNS (ssh)      ${del(s.sshFqdn)}`);
    for (const p of (s.policies || [])) console.log(`  +  CF reusable policy ${del(`"${p.name}" ${p.id}`)}`);
  }
  if (s.cfErr) console.log(c.red(`  ! Cloudflare query error (CF surfaces may be incomplete): ${s.cfErr}`));
}

async function execute(file, d, accountId, cfToken, aegisConfig, s) {
  const failures = [];
  const ok = (m) => console.log(c.green(`  ✓ ${m}`));
  const skip = (m) => console.log(c.dim(`  – ${m} (already gone)`));
  const fail = (m, e) => { failures.push(m); console.log(c.red(`  ✗ ${m}: ${e && e.message ? e.message : e}`)); };

  // 1. Aegis registry (local, safe first — reuses deregister; file still on disk here)
  if (!s.aegisResolved) fail('Aegis registry', new Error('no aegis.config.json resolved -- set $AEGIS_CONFIG or pass --aegis-config, then re-run to deregister'));
  else if (s.aegis) { try { runDeregister(file, { aegisConfig: s.aegisPath }); ok('Aegis: deregistered from ' + s.aegisPath); } catch (e) { fail('Aegis deregister', e); } }
  else skip('Aegis registry (' + s.aegisPath + ')');
  const pl2 = s.plane || {};
  if (pl2.absent) skip('Plane registry (no hosted plane)');
  else if (pl2.present === null) fail('Plane registry', new Error(pl2.err || 'could not read the plane registry -- re-run when the plane is reachable'));
  else if (pl2.present === true) { try { planeDeregister(pl2, s.name); ok('Plane: deregistered on ' + pl2.vm + ' (registry re-read, agent gone)'); } catch (e) { fail('Plane deregister', e); } }
  else skip('Plane registry (' + (pl2.vm || 'plane') + ')');

  // 2. local contract file
  if (s.localFile) { try { fs.unlinkSync(s.localFile); ok(`local config: deleted ${s.localFile}`); } catch (e) { fail('local config delete', e); } }
  else skip('local config');

  // 3. Azure RG (blocking so the connector dies before the tunnel delete)
  let rgGone = !s.rg;
  if (s.rg) {
    const lv = lockVerdict(s.locks, s.protection);
    const { foreign, mirror } = lv;
    if (lv.act === 'refuse-foreign') {
      fail('Azure RG delete', new Error('refused: lock(s) not set by the fleet: ' + foreign.map((l) => l.name + ' (' + l.level + ')').join(', ') + ' — remove them first (az lock delete) or leave the RG'));
    } else if (lv.act === 'refuse-unjudged') {
      fail('Azure RG delete', new Error('refused: a fleet-protect lock is present and protection cannot be verified (' + lv.why + ') — the mirror is an orphan only if a policy file says the agent is not protected; it is not removed on a default'));
    } else {
      for (const l of mirror) {
        // a NAMED policy file said "not protected" (the gate above and lockVerdict), so this
        // lock is an orphan mirror -- the source rides the line so the ledger says which file
        const lr = runCapture('az', ['lock', 'delete', '--name', l.name, '-g', d.azure.resourceGroup]);
        if (lr.status === 0) ok(`Azure RG lock: removed orphan mirror ${l.name} (policy ${lv.source} says not protected)`);
        else fail(`Azure RG lock delete (${l.name})`, new Error(String(lr.stderr || '').trim() || `az exit ${lr.status}`));
      }
      console.log(c.dim(`  … deleting ${d.azure.resourceGroup} (blocking; a few minutes) …`));
      const r = runCapture('az', ['group', 'delete', '-n', d.azure.resourceGroup, '--yes']);
      if (r.status === 0) { rgGone = true; ok(`Azure RG: deleted ${d.azure.resourceGroup}`); }
      else fail('Azure RG delete', new Error(String(r.stderr || '').trim() || `az exit ${r.status}`));
    }
  } else skip(`Azure RG ${d.azure.resourceGroup}`);

  // 3b. Purge the soft-deleted vault so its deterministic name is free again. Purge is
  // irreversible for the vault's secrets -- they were the agent's own API keys, re-seeded on any
  // re-provision, and this runs inside an already-attested destructive teardown.
  const purgeName = (s.vault && s.vault.name) || (s.deletedVault && s.deletedVault.name) || '';
  const purgeLoc = (s.vault && s.vault.location) || (s.deletedVault && s.deletedVault.location) || d.azure.region || '';
  // a vault that is still live in an RG that did NOT go has nothing to purge yet
  if (purgeName && (rgGone || s.deletedVault)) {
    let purged = false, lastErr = '';
    // the RG delete is blocking, but the deleted-vault record can lag a few seconds
    for (let i = 0; i < 6 && !purged; i++) {
      const pr = runCapture('az', ['keyvault', 'purge', '--name', purgeName, ...(purgeLoc ? ['--location', purgeLoc] : []), '-o', 'none']);
      if (pr.status === 0) purged = true;
      else { lastErr = String(pr.stderr || '').split('\n')[0]; if (/not found|NotFound|does not exist/i.test(lastErr)) { await new Promise((r) => setTimeout(r, 5000)); } else break; }
    }
    if (purged) ok(`Key Vault: purged soft-deleted ${purgeName} (name free for re-provision)`);
    else fail('Key Vault purge', new Error(lastErr || 'purge failed'));
  } else skip('Key Vault purge');

  // 4. CF Access app (removes its policies -> frees the service token)
  if (s.app) { try { await cf.deleteApp(accountId, s.app.id, cfToken); ok('CF Access app: deleted'); } catch (e) { fail('CF Access app delete', e); } }
  else skip('CF Access app');
  if (s.appSsh) { try { await cf.deleteApp(accountId, s.appSsh.id, cfToken); ok('CF Access app (ssh, legacy): deleted'); } catch (e) { fail('CF Access app (ssh) delete', e); } }
  for (const p of (s.policies || [])) {
    try { await cf.deleteReusablePolicy(accountId, p.id, cfToken); ok(`CF reusable policy (legacy): deleted "${p.name}"`); }
    catch (e) { fail(`CF reusable policy delete ("${p.name}")`, e); }
  }

  // 5. CF service token (now unreferenced). CF can return 12139 (token in use) if the
  // just-deleted app's Service-Auth policy hasn't propagated yet -- retry with backoff.
  // A 12139 that survives the retries means a legacy standalone policy/group still
  // references it (hand-built era): remove that reference in the CF dashboard, re-run.
  if (s.tokens && s.tokens.length) {
    for (const t of s.tokens) {
      let done = false, lastErr = null;
      for (let i = 0; i < 3 && !done; i++) {
        if (i) await new Promise((r) => setTimeout(r, 4000));
        try {
          await cf.deleteServiceToken(accountId, t.id, cfToken);
          done = true; ok(`CF service token ${t.name}: deleted` + (i ? ` (retry ${i})` : ''));
        } catch (e) { lastErr = e; }
      }
      if (!done) fail(`CF service token ${t.name} delete (after retries — a legacy policy/group may still reference it; remove it in the CF dashboard, then re-run)`, lastErr);
    }
  }
  else skip('CF service tokens');

  // 6. CF DNS CNAME
  if (s.dns && s.zoneId) { try { await cf.deleteDnsRecord(s.zoneId, s.dns.id, cfToken); ok('CF DNS CNAME: deleted'); } catch (e) { fail('CF DNS delete', e); } }
  else skip('CF DNS CNAME');
  if (s.dnsSsh && s.zoneId) { try { await cf.deleteDnsRecord(s.zoneId, s.dnsSsh.id, cfToken); ok('CF DNS (ssh-' + s.name + ', legacy): deleted'); } catch (e) { fail('CF DNS (ssh) delete', e); } }

  // 7. CF tunnel (connector dead after the RG delete)
  if (s.tunnel) { try { await cf.deleteTunnel(accountId, s.tunnel.id, cfToken); ok('CF tunnel: deleted'); } catch (e) { fail('CF tunnel delete', e); } }
  else skip('CF tunnel');
  return failures;
}

async function runDecommission(file, opts = {}) {
  const accountId = env('CF_ACCOUNT_ID');
  const cfToken = env('CF_API_TOKEN');
  if (!accountId || !cfToken) {
    console.error(c.red('decommission: set CF_ACCOUNT_ID and CF_API_TOKEN (the same token used for up) so CF surfaces can be discovered/deleted.'));
    return 2;
  }
  const res = loadContract(file);
  if (!res.ok) { console.error(c.red(`decommission: ${(res.errors || []).join('; ')}`)); return 2; }
  const v = res.value;
  const d = derive(v);

  const aegisPath = opts.aegisConfig || env('AEGIS_CONFIG'); // up finds it via the env var too
  // Protection gate (Can't layer): a protected agent REFUSES teardown before any
  // discovery or deletion. Unprotect first via the attested policy ceremony.
  const protection = require('./policy').readProtection(opts.policy);
  {
    if (!protection.ok) {
      if (opts.go) {
        console.error(c.red('decommission REFUSED — cannot verify protection: ' + protection.error + ' (fail-closed). Name the canonical policy with $AEGIS_POLICY or --policy, then re-run.'));
        return 3;
      }
      console.log(c.yellow('\nPOLICY UNREADABLE — ' + protection.error + '; --go will REFUSE until a policy file resolves.'));
    }
    if (protection.ok && protection.protectedAgents.includes(d.register.name)) {
      if (!opts.go) {
        console.log(c.yellow(`\nPROTECTED — "${d.register.name}" is in policy protectedAgents; --go will REFUSE until it is removed.`));
      } else {
        console.error(c.red(`\ndecommission REFUSED — "${d.register.name}" is protected by policy (protectedAgents).`));
        console.error(c.yellow('  To proceed, first run the attested unprotect ceremony:'));
        console.error(c.yellow(`    fleetctl policy unprotect ${d.register.name} --attest "I approve unprotecting ${d.register.name}"`));
        console.error(c.dim('  (that set also removes the Azure CanNotDelete lock on rg-' + d.register.name + ')'));
        return 3;
      }
    }
  }
  console.log(c.bold(`\nDecommission "${d.register.name}" (${d.azure.profile}) at ${d.cloudflare.fqdn}`));
  const s = await discover(file, d, accountId, cfToken, aegisPath);
  s.protection = protection;
  printPlan(s);

  const anything = (s.plane && (s.plane.present === true || s.plane.present === null)) || s.aegis || s.localFile || s.rg || s.app || (s.tokens && s.tokens.length) || s.dns || s.tunnel || s.appSsh || s.dnsSsh || (s.policies && s.policies.length);
  if (!anything) { console.log(c.green('\nNothing to decommission — every surface is already absent.')); return 0; }

  if (!opts.go) {
    console.log(c.dim('\nPlan only — nothing deleted.'));
    console.log(c.yellow('  To EXECUTE (DESTRUCTIVE — deletes every DELETE surface above): re-run the SAME command'));
    console.log(c.yellow('  with the --go flag appended at the end, e.g.  fleetctl decommission ' + file + ' --go'));
    console.log(c.dim('  (--go is a flag; the agent is the contract file above, not a word typed after --go.)'));
    return 0;
  }

  console.log(c.red(`\n--go: DESTRUCTIVE — deleting every DELETE surface above for "${d.register.name}".`));
  // Surface 0: bank a final snapshot into the fleet backup store (best-effort,
  // never blocks -- the store outlives the agent, so this IS the undo button).
  require('./backup').finalSnapshot(d.register.name);
  const failures = await execute(file, d, accountId, cfToken, aegisPath, s);
  if (failures && failures.length) {
    // A teardown that could not finish must not read as finished: the panel and the ledger both
    // key off this line, and "complete" over a locked RG left a VM running with no front door.
    console.log(c.red(`\ndecommission ${d.register.name} INCOMPLETE — ${failures.length} surface(s) failed: ${failures.join('; ')}. Re-run after fixing; every surface is idempotent.`));
    return 1;
  }
  console.log(c.green(`\ndecommission ${d.register.name} complete. Refresh fleet in Aegis to drop the card (deregister already updated the config).`));
  return 0;
}

module.exports = { runDecommission, discover, printPlan, registryState, selectAgentTokens, lockVerdict };
