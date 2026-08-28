'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { findFleetRoot } = require('./util');
const { stripJsonc } = require('./jsonc');

// Built-in defaults so the gate is safe even if the policy file is missing.
const DEFAULTS = {
  maxFleet: 6,
  a2aPairs: [],
  protectedAgents: [],
  maxBatch: 2,
  allowedRegions: ['eastus2'],
  defaultRegion: 'eastus2',
  maxMonthlyBudgetUsd: 150,
  budgetName: 'fleet-monthly',
};

function resolvePolicyPath(explicit) {
  // An explicit path or $AEGIS_POLICY is the operator STATING which file is canonical. Two
  // policy files exist in this fleet -- the hosted plane's live copy and the workstation
  // checkout -- so answering from a different one than the operator named is a wrong answer,
  // not a fallback. A named path that does not exist FAILS here; only implicit discovery
  // (fleet root, then the lib-relative checkout) is allowed to fall through.
  const named = explicit ? path.resolve(explicit)
    : (process.env.AEGIS_POLICY ? path.resolve(process.env.AEGIS_POLICY) : null);
  if (named) {
    if (!fs.existsSync(named)) {
      throw new Error(`policy file not found: ${named} (named by ${explicit ? 'an explicit path' : '$AEGIS_POLICY'}) -- fix the path or unset it; refusing to answer from a different policy file`);
    }
    return named;
  }
  const tries = [];
  const root = findFleetRoot();
  if (root) tries.push(path.join(root, 'provision', 'aegis.policy.jsonc'));
  tries.push(path.resolve(__dirname, '..', 'aegis.policy.jsonc')); // …/provision/lib -> …/provision
  for (const p of tries) if (fs.existsSync(p)) return p;
  return null;
}

function loadPolicy(explicit, resolve = resolvePolicyPath) {
  const p = resolve(explicit);
  if (!p) return { ...DEFAULTS, source: '(built-in defaults)' };
  let raw;
  try { raw = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8'))); }
  catch (e) { throw new Error(`aegis.policy.jsonc is invalid (${e.message})`); }
  return { ...DEFAULTS, ...raw, source: p };
}

// The protection read WITH its provenance. A caller that takes a destructive action on
// "policy says this agent is not protected" has to be able to tell that claim apart from
// "no policy file spoke at all": decommission deletes the fleet-protect lock -- the last
// structure between an operator error and an RG delete -- as an orphan on the strength of
// it, and built-in defaults carry an empty protectedAgents list that reads exactly like a
// policy saying no. ok is true only when a real file backed the answer.
function readProtection(explicit) {
  let pol;
  try { pol = loadPolicy(explicit); }
  catch (e) { return { ok: false, resolved: false, source: null, protectedAgents: null, error: e.message }; }
  const resolved = pol.source !== '(built-in defaults)';
  return {
    ok: resolved,
    resolved,
    source: resolved ? pol.source : null,
    protectedAgents: Array.isArray(pol.protectedAgents) ? pol.protectedAgents : [],
    error: resolved ? null : 'no policy file resolved (built-in defaults answered)',
  };
}

// Fail-closed provisioning gate.
//   currentFleet: names already registered in aegis.config.json
//   names:        agent name(s) being provisioned this request
//   region:       target Azure region
// Returns { ok, errors }. Re-provisioning an already-registered agent does not
// count against maxFleet (it's an update, not a new agent).
function checkProvision(policy, { currentFleet = [], names = [], region } = {}) {
  const errors = [];
  const inFleet = new Set(currentFleet);
  const netNew = names.filter((n) => !inFleet.has(n));

  if (names.length > policy.maxBatch) {
    errors.push(`batch of ${names.length} exceeds maxBatch=${policy.maxBatch} — request ${policy.maxBatch} or fewer at a time`);
  }
  const projected = currentFleet.length + netNew.length;
  if (projected > policy.maxFleet) {
    errors.push(`would bring the fleet to ${projected}, over maxFleet=${policy.maxFleet} (${currentFleet.length} registered + ${netNew.length} new)`);
  }
  if (region && Array.isArray(policy.allowedRegions) && !policy.allowedRegions.includes(region)) {
    errors.push(`region "${region}" is not in allowedRegions [${policy.allowedRegions.join(', ')}]`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Attested policy mutation. The policy file is the reviewable governance
// artifact, so `set` performs a GUARDED value swap that preserves every comment
// (never a JSON round-trip): the exact `"<key>": <old>` token must match once.
// The attestation phrase must equal the canonical sentence verbatim; anything
// else refuses, mutates nothing, and the refusal is still LEDGERED. Every
// attempt appends {ts, actor, deployerObjectId, action, key, from, to, phrase,
// outcome} to provision/policy-audit.jsonl — append-only attestation evidence.
const { spawnSync } = require('node:child_process');
// Node >=20.12 (CVE-2024-27980) forbids spawning .cmd without a shell (EINVAL),
// and args-array+shell triggers DEP0190 -- so on Windows we build ONE command
// string (every value charset-gated) and run it with shell:true.
const runAz = (azArgs) => {
  const r2 = process.platform === 'win32'
    ? spawnSync('az ' + azArgs.map((a) => '"' + a + '"').join(' '), { shell: true, encoding: 'utf8', timeout: 45000 })
    : spawnSync('az', azArgs, { encoding: 'utf8', timeout: 45000 });
  const out = (r2.stdout || '').trim();
  const errLines = ((r2.stderr || '') + (r2.error ? String(r2.error) : '')).split('\n').map(s => s.trim()).filter(Boolean);
  const err = (errLines.find(l => !l.startsWith('WARNING')) || errLines[0] || 'no output').slice(0, 200);
  return { status: r2.status, out, err };
};

const SETTABLE = {
  maxFleet:       { file: 'maxFleet',            kind: 'int' },
  maxBatch:       { file: 'maxBatch',            kind: 'int' },
  budget:         { file: 'maxMonthlyBudgetUsd', kind: 'int' },
  allowedRegions: { file: 'allowedRegions',      kind: 'list' },   // comma-separated full replacement
  defaultRegion:  { file: 'defaultRegion',       kind: 'str', re: /^[a-z0-9]{3,30}$/ },
  budgetName:     { file: 'budgetName',          kind: 'str', re: /^[A-Za-z0-9_-]{1,63}$/ },
  protectedAgents:{ file: 'protectedAgents',     kind: 'list', itemRe: /^[a-z][a-z0-9-]{1,23}$/, itemDesc: 'agent names', allowEmpty: true },   // `none` clears
  // Agent-to-agent relay allowlist. Each item is a DIRECTED pair "from>to": permitting
  // from>to does NOT permit to>from, because the two directions are different
  // grants. Empty (the default) means no relay is possible at all -- the capability is
  // off until an operator attests a specific pair, rather than on with a way to switch
  // it off. `none` clears.
  a2aPairs:       { file: 'a2aPairs',            kind: 'list', itemRe: /^[a-z][a-z0-9-]{1,23}>[a-z][a-z0-9-]{1,23}$/, itemDesc: 'directed pairs like from>to', allowEmpty: true },
};

// Keys that USED to live here and no longer do. A retired key must not read as an unknown
// key: an operator who reaches for the old name gets told where it went, because silently
// refusing an allowlist edit is how an allowlist ends up stale and nobody notices.
const RETIRED = {
  telegramChatIds:
    'telegramChatIds now lives in the plane\'s aegis.config.json, not in policy.\n' +
    '  It is a per-installation identifier and this file is committed, so publishing it here\n' +
    '  would put a chat id in git. The allowlist semantics are unchanged: empty means the\n' +
    '  Telegram lane ignores everyone, and an unknown chat is ignored silently and logged once.\n' +
    '  Edit "telegramChatIds" in aegis.config.json on the plane and restart the unit.',
};

// Parse + shape-validate; throws with the ledgerable reason on bad input.
// Read the lock back rather than trusting the mutation's exit code. `az lock delete` on a
// lock that does not exist exits 0, so a delete that deleted nothing still reported "ok:
// unlocked rg-<n>" and the ledger recorded an unlock that never happened. The same weakness
// applied to "ok: locked". true = present, false = absent, null = could not tell (reported as
// unverified, never as success).
function lockPresent(name) {
  const r = runAz(['lock', 'list', '-g', 'rg-' + name, '--query', "[?name=='fleet-protect'].name", '-o', 'tsv']);
  if (r.status !== 0) return null;
  return /fleet-protect/.test(r.out);
}

// Coherence between the policy file and the structure it is mirrored into. protectedAgents is
// the gate; the CanNotDelete lock is the structural layer. They can diverge silently -- a lock
// was deleted by the control plane while the policy still named the agent, and nothing surfaced
// it for eight days. `policy show` now asks Azure instead of assuming.
function lockCoherence(protectedAgents) {
  const names = Array.isArray(protectedAgents) ? protectedAgents : [];
  if (!names.length) return ['  lock mirror: nothing protected, nothing to mirror'];
  const out = [];
  for (const n of names) {
    const seen = lockPresent(n);
    out.push(seen === true ? `    ${n}: lock present`
      : seen === false ? `    ${n}: DIVERGED -- policy protects it, rg-${n} has no fleet-protect lock`
      : `    ${n}: unreadable -- could not query locks on rg-${n}`);
  }
  return ['  lock mirror (policy vs azure):', ...out];
}

function coerce(key, spec, value) {
  if (spec.kind === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer (got "${value}")`);
    return n;
  }
  if (spec.kind === 'str') {
    const s = String(value || '').trim();
    if (!spec.re.test(s)) throw new Error(`${key} "${s}" fails ${spec.re}`);
    return s;
  }
  if (spec.allowEmpty && String(value || '').trim().toLowerCase() === 'none') return [];
  const itemRe = spec.itemRe || /^[a-z0-9]{3,30}$/;
  const itemDesc = spec.itemDesc || 'azure region names';
  const list = [...new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!list.length || list.some((s) => !itemRe.test(s))) {
    throw new Error(`${key} must be a comma-separated list of ${itemDesc} (got "${value}"${spec.allowEmpty ? ', or `none` to clear' : ''})`);
  }
  return list;
}

// Coherence gates across keys -- fail closed with the exact fix named.
function crossCheck(fileKey, next, pol) {
  if (fileKey === 'maxBatch' && next > pol.maxFleet) {
    throw new Error(`maxBatch ${next} would exceed maxFleet ${pol.maxFleet} -- raise maxFleet first`);
  }
  if (fileKey === 'maxFleet' && pol.maxBatch > next) {
    throw new Error(`maxFleet ${next} would drop below maxBatch ${pol.maxBatch} -- lower maxBatch first`);
  }
  if (fileKey === 'allowedRegions' && !next.includes(pol.defaultRegion)) {
    throw new Error(`allowedRegions [${next.join(', ')}] would exclude defaultRegion "${pol.defaultRegion}" -- change defaultRegion first or include it`);
  }
  if (fileKey === 'defaultRegion' && !pol.allowedRegions.includes(next)) {
    throw new Error(`defaultRegion "${next}" is not in allowedRegions [${pol.allowedRegions.join(', ')}] -- add it to allowedRegions first`);
  }
}

function attestPhrase(key, value) {
  return `I approve setting ${key} to ${value}`;
}

function auditPath(policyPath) {
  return path.join(path.dirname(policyPath), 'policy-audit.jsonl');
}

function ledger(policyPath, entry) {
  const rec = {
    ts: new Date().toISOString(),
    actor: (require('node:os').userInfo().username || 'unknown'),
    deployerObjectId: require('./util').deployerObjectId(),
    ...entry,
  };
  fs.appendFileSync(auditPath(policyPath), JSON.stringify(rec) + '\n');
  return rec;
}

function showPolicy(explicit) {
  const pol = loadPolicy(explicit);
  const lines = [`policy source: ${pol.source}`];
  for (const k of Object.keys(DEFAULTS)) lines.push(`  ${k}: ${JSON.stringify(pol[k])}`);
  for (const l of lockCoherence(pol.protectedAgents)) lines.push(l);
  const ap = pol.source.endsWith('.jsonc') ? auditPath(pol.source) : null;
  if (ap && fs.existsSync(ap)) {
    const tail = fs.readFileSync(ap, 'utf8').trim().split('\n').slice(-3);
    lines.push(`  recent attested actions (${path.basename(ap)}):`);
    for (const t of tail) lines.push(`    ${t}`);
  }
  return lines.join('\n');
}


// A control whose second, structural layer did not land is NOT ok. The policy write is
// the gate and lands first; the Azure mirror (the CanNotDelete lock on rg-<n>; the Cost
// Management budget object) is best-effort. When the mirror fails the control is only
// half-applied, so the ledger's verdict is DERIVED from the sync line, never asserted:
// `incomplete` -- not `failed`, because the gate is real and enforcing, and not `ok`,
// because the structure the gate is mirrored into is missing. Live: an unprotect
// ledgered ok with syncOutcome AuthorizationFailed and left an agent's RG holding a
// fleet-protect lock no policy entry explained; on the panel that failure was invisible.
function syncVerdict(syncOutcome) {
  if (!syncOutcome) return 'ok';
  const why = String(syncOutcome).replace(/^failed:\s*/, '');   // the budget lane already says failed; don't stutter
  return /^ok\b/.test(String(syncOutcome)) ? 'ok' : 'incomplete: policy applied, azure sync failed -- ' + why;
}

// Single-name protection ceremony: `I approve protecting <name>` / `I approve
// unprotecting <name>` -- short, order-free, one agent per attestation. The
// generic `set protectedAgents` grammar remains for bulk edits / `none`.
// Same guarantees as setPolicy: comment-preserving token swap, re-read verify,
// every attempt ledgered, Azure CanNotDelete lock synced best-effort.
function setProtection({ name, on, attest, explicit }) {
  const verb = on ? 'protect' : 'unprotect';
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(String(name || ''))) throw new Error(`policy ${verb}: invalid agent name`);
  const p = resolvePolicyPath(explicit);
  if (!p) throw new Error(`policy ${verb}: no aegis.policy.jsonc found -- the gate file must exist to be edited`);
  const pol = loadPolicy(p);
  const before = Array.isArray(pol.protectedAgents) ? pol.protectedAgents : [];
  const required = `I approve ${on ? 'protecting' : 'unprotecting'} ${name}`;
  if ((attest || '').trim() !== required) {
    ledger(p, { action: 'policy.' + verb, key: 'protectedAgents', name, from: before, phrase: attest || '', outcome: 'refused: attestation mismatch' });
    throw new Error(`policy ${verb} REFUSED -- attestation must read exactly:\n  --attest "${required}"`);
  }
  const has = before.includes(name);
  if (on === has) {
    const rec = ledger(p, { action: 'policy.' + verb, key: 'protectedAgents', name, from: before, to: before, phrase: attest, outcome: 'ok (no-op: already ' + (on ? 'protected' : 'unprotected') + ')' });
    return { path: p, from: before, to: before, ledgered: rec.ts, noop: true };
  }
  const next = on ? before.concat([name]) : before.filter((n) => n !== name);
  const src2 = fs.readFileSync(p, 'utf8');
  const token = `"protectedAgents": ${JSON.stringify(before)}`;
  const hits = src2.split(token).length - 1;
  if (hits !== 1) throw new Error(`policy ${verb} aborted: expected exactly one \`${token}\` in ${p}, found ${hits} -- edit by hand`);
  fs.writeFileSync(p, src2.replace(token, `"protectedAgents": ${JSON.stringify(next)}`));
  const after = loadPolicy(p).protectedAgents;
  if (JSON.stringify(after) !== JSON.stringify(next)) throw new Error(`policy ${verb} verification failed: re-read protectedAgents=${JSON.stringify(after)}`);
  const r = on
    ? runAz(['lock', 'create', '--name', 'fleet-protect', '-g', 'rg-' + name, '--lock-type', 'CanNotDelete', '-o', 'none'])
    : runAz(['lock', 'delete', '--name', 'fleet-protect', '-g', 'rg-' + name]);
  const syncOutcome = r.status === 0 ? `ok: ${on ? 'locked' : 'unlocked'} rg-${name}` : `${on ? 'lock' : 'unlock'} rg-${name} failed: ${r.err}`;
  const outcome = syncVerdict(syncOutcome);
  const rec = ledger(p, { action: 'policy.' + verb, key: 'protectedAgents', name, from: before, to: next, phrase: attest, outcome, syncOutcome });
  return { path: p, from: before, to: next, ledgered: rec.ts, syncOutcome, outcome };
}

function setPolicy({ key, value, attest, explicit }) {
  if (RETIRED[key]) throw new Error(`policy set: "${key}" is no longer a policy key.\n  ${RETIRED[key]}`);
  const spec = SETTABLE[key];
  if (!spec) throw new Error(`policy set: unknown key "${key}" -- settable: ${Object.keys(SETTABLE).join(', ')}`);
  const p = resolvePolicyPath(explicit);
  if (!p) throw new Error('policy set: no aegis.policy.jsonc found -- the gate file must exist to be edited');
  const pol = loadPolicy(p);
  const before = pol[spec.file];
  let next;
  try { next = coerce(key, spec, value); }
  catch (e) {
    ledger(p, { action: 'policy.set', key: spec.file, from: before, to: String(value), phrase: attest || '', outcome: 'refused: ' + e.message });
    throw new Error('policy set REFUSED -- ' + e.message);
  }
  const required = attestPhrase(key, String(value).trim());
  if ((attest || '').trim() !== required) {
    ledger(p, { action: 'policy.set', key: spec.file, from: before, to: next, phrase: attest || '', outcome: 'refused: attestation mismatch' });
    throw new Error(`policy set REFUSED -- attestation must read exactly:\n  --attest "${required}"`);
  }
  try { crossCheck(spec.file, next, pol); }
  catch (e) {
    ledger(p, { action: 'policy.set', key: spec.file, from: before, to: next, phrase: attest, outcome: 'refused: ' + e.message });
    throw new Error('policy set REFUSED -- ' + e.message);
  }
  const src2 = fs.readFileSync(p, 'utf8');
  const token = `"${spec.file}": ${JSON.stringify(before)}`;
  const hits = src2.split(token).length - 1;
  // A key the file has never carried (added to DEFAULTS after the file was written, e.g. a
  // newer allowlist) is inserted once, before the closing brace, at its default value; the
  // guarded replace below then proceeds exactly as for a key that was already present.
  // Any other count is still an abort: the file is edited only through this gate.
  let src3 = src2;
  if (hits === 0 && !new RegExp(`"${spec.file}"\\s*:`).test(src2) && JSON.stringify(before) === JSON.stringify(DEFAULTS[spec.file])) {
    const close = src2.lastIndexOf('}');
    if (close < 0) throw new Error(`policy set aborted: ${p} has no closing brace -- edit by hand`);
    const head = src2.slice(0, close).replace(/\s+$/, '');
    src3 = head + (head.endsWith('{') ? '' : (head.endsWith(',') ? '' : ',')) + `\n  ${token}\n` + src2.slice(close);
  }
  const hits3 = src3.split(token).length - 1;
  if (hits3 !== 1) throw new Error(`policy set aborted: expected exactly one \`${token}\` in ${p}, found ${hits3} -- edit by hand`);
  fs.writeFileSync(p, src3.replace(token, `"${spec.file}": ${JSON.stringify(next)}`));
  const after = loadPolicy(p)[spec.file];
  if (JSON.stringify(after) !== JSON.stringify(next)) throw new Error(`policy set verification failed: re-read ${spec.file}=${JSON.stringify(after)}`);
  // Azure budget-object sync (2nd step of the budget control): the GATE mutation
  // above is the enforcement and always lands; syncing the Cost Management budget
  // object is best-effort, FAIL-LOUD-NON-BLOCKING -- its outcome rides the ledger.
  let syncOutcome;
  // Azure resource-lock sync (2nd, structural layer of the protection control):
  // the CLI refusal in decommission is the gate and always lands; the CanNotDelete
  // lock on each protected rg-<name> is best-effort, FAIL-LOUD-NON-BLOCKING.
  if (spec.file === 'protectedAgents') {
    const prev = Array.isArray(before) ? before : [];
    const added = next.filter((n) => !prev.includes(n));
    const removed = prev.filter((n) => !next.includes(n));
    const notes = [];
    for (const n of added) {
      const r = runAz(['lock', 'create', '--name', 'fleet-protect', '-g', 'rg-' + n, '--lock-type', 'CanNotDelete', '-o', 'none']);
      if (r.status !== 0) { notes.push(`lock rg-${n} failed: ${r.err}`); continue; }
      const seen = lockPresent(n);
      notes.push(seen === true ? `locked rg-${n}` : seen === false
        ? `lock rg-${n} failed: az reported success but no fleet-protect lock is present`
        : `lock rg-${n} unverified: could not read the lock back`);
    }
    for (const n of removed) {
      const r = runAz(['lock', 'delete', '--name', 'fleet-protect', '-g', 'rg-' + n]);
      if (r.status !== 0) { notes.push(`unlock rg-${n} failed: ${r.err}`); continue; }
      const seen = lockPresent(n);
      notes.push(seen === false ? `unlocked rg-${n}` : seen === true
        ? `unlock rg-${n} failed: az reported success but the lock is still present`
        : `unlock rg-${n} unverified: could not read the lock back`);
    }
    if (notes.length) syncOutcome = (notes.some((n) => /failed/.test(n)) ? '' : 'ok: ') + notes.join('; ');
  }
  if (spec.file === 'maxMonthlyBudgetUsd') {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(pol.budgetName)) {
      syncOutcome = 'failed: budgetName in policy file fails safe charset [A-Za-z0-9_-]';
    } else {
      // ONE idempotent ARM PUT (create-or-update) on the budgets resource -- the
      // legacy `az consumption budget` group speaks a retired filter schema (400s
      // at subscription scope). az rest substitutes {subscriptionId} itself; the
      // JSON body rides a temp file so no shell quoting is involved on Windows.
      const now = new Date();
      const startD = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`;
      const endD = `${now.getUTCFullYear() + 5}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`;
      const body = { properties: { category: 'Cost', amount: next, timeGrain: 'Monthly', timePeriod: { startDate: startD, endDate: endD } } };
      const os2 = require('node:os');
      const tmp = path.join(os2.tmpdir(), 'aegis-budget-' + process.pid + '.json');
      let put;
      try {
        fs.writeFileSync(tmp, JSON.stringify(body));
        put = runAz(['rest', '--method', 'put',
          '--url', 'https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.Consumption/budgets/' + pol.budgetName + '?api-version=2021-10-01',
          '--headers', 'Content-Type=application/json', '--body', '@' + tmp,
          '--query', 'properties.amount', '-o', 'tsv']);
      } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
      syncOutcome = (put.status === 0 && put.out)
        ? `ok: ${pol.budgetName} amount=${put.out} (ARM put, monthly from ${startD.slice(0, 10)})`
        : `failed: ${put.err}`;
    }
  }
  const outcome = syncVerdict(syncOutcome);
  const rec = ledger(p, { action: 'policy.set', key: spec.file, from: before, to: next, phrase: attest, outcome, ...(syncOutcome ? { syncOutcome } : {}) });
  return { path: p, key: spec.file, from: before, to: next, ledgered: rec.ts, syncOutcome, outcome };
}

module.exports = { RETIRED, DEFAULTS, resolvePolicyPath, loadPolicy, readProtection, checkProvision, showPolicy, setPolicy, setProtection, attestPhrase, ledger, syncVerdict };
