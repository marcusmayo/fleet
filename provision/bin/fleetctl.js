#!/usr/bin/env node
'use strict';
const { runCheck } = require('../lib/check');
const { runPlan } = require('../lib/plan');
const { runRegister, runDeregister } = require('../lib/register');
const { runSetSecrets } = require('../lib/secrets');
const { runCheckLive } = require('../lib/live');
const { runUp } = require('../lib/up');
const { runDecommission } = require('../lib/decommission');
const { c } = require('../lib/util');

const HELP = `fleetctl — agent-fleet provisioning

Usage:
  fleetctl check    <contract.agent.jsonc> [--contract-only] [--live [--logs] [--expect <sha>]] [--aegis-config <path>]
  fleetctl plan     <contract.agent.jsonc> [--require-whatif]
  fleetctl up       <contract.agent.jsonc> [--go] [--aegis-config <path>]
  fleetctl register <contract.agent.jsonc> [--aegis-config <path>]
  fleetctl deregister <name | contract.agent.jsonc> [--aegis-config <path>]
  fleetctl decommission <contract.agent.jsonc> [--go] [--aegis-config <path>] [--policy <path>]
  fleetctl policy   [show] | set <key> <value> --attest "I approve setting <key> to <value>"
  fleetctl policy   protect <name> | unprotect <name>  --attest "I approve <verb>ing <name>"
  fleetctl set-secrets <agent>
  fleetctl backup   init | list <agent> | snapshot <agent>
  fleetctl backup   ls <container> [--prefix <p>] | get <container> <blob> [--out <path>]
  fleetctl backup   put <container> <file> [--as <blob>] | rehydrate <container> <blob> [--priority High|Standard]
  fleetctl intake   put <agent> <file...> | list <agent>
  fleetctl rebuild  <contract.agent.jsonc> [--head <sha>] [--go]
  fleetctl aegis    plan <contract> | up <contract> --go --attest "<sentence>"
  fleetctl aegis    grant <contract> vault|contributor|backups [--go --attest "<sentence>"]
  fleetctl aegis    update <contract> [--go --attest "<sentence>"]
  fleetctl enroll   <agent> [--go --attest "<sentence>"] [--domain=<d>] [--plane=<label>] [--aegis-config <path>]
  fleetctl discover [--json] [--plane=<label>] [--aegis-config <path>]
  fleetctl migrate  <from> <to> [--scope=knowledge,claude,...] [--blob=<snapshot>] [--overwrite] [--go --attest "<sentence>"]
  fleetctl resize   <contract> --size=<Standard_...> [--go --attest "<sentence>"]
  fleetctl restore  <agent> [--blob <name>] [--clean --attest "I approve a clean restore of <agent>"]
  fleetctl --help

Commands:
  check     Validate the contract, then preflight the environment (az login,
            CF_API_TOKEN, SSH key, bicepparam, deployer id for castor).
            --contract-only   validate the file only; skip environment preflight.
            --live            skip env preflight; instead probe the deployed agent's
                              /health/liveliness through the tunnel (HTTP 200) using
                              the service token stored in aegis.config.json.
            --require-live    exit non-zero if the live probe can't run (for CI).
            --expect <sha>    with --live: FAIL unless the agent reports running that commit
            --logs            with --live: when the probe is not 200, read the VM itself
                              through run-command (cloud-init state, image-build verdict,
                              retry log, timers, first-boot marker, containers) and print it,
                              so the CLI says why, not just what.

  plan      Validate the contract and preview every Azure + Cloudflare + register
            resource it will create, then run \`az deployment sub what-if\` (read-only).
            --require-whatif  exit non-zero if the what-if cannot be run (for CI).

  up        Bring up a new agent end to end. Default prints the full ordered plan
            (cheap/reversible steps first, the billable VM last) and changes nothing.
            --go   execute: Cloudflare front door (cloudflare-provision.ps1) -> service
                   token + Service Auth policy (CF API) -> register -> deploy.sh (VM).
                   Needs \$CF_API_TOKEN, \$CF_ACCOUNT_ID, \$CF_OPERATOR_EMAIL, an SSH key,
                   and pwsh + bash + az. Fails fast; the secret is never printed.
                   Aborts if rg-<name> already exists (cloud-init is immutable on a
                   live VM) — decommission first for a rebuild, or pass --update for
                   an intentional in-place update that does not change cloud-init.
                   Plan and --go both run the repo gate: the agent repo at the contract's
                   ref is cloned and its vendored fleet-core hashed against its stamps, the
                   same check the image build runs; --go refuses a repo that would fail it
                   (provision/lib/repogate.js).

  register  Add/update the agent's entry in aegis.config.json (idempotent per name;
            refuses if that file is not gitignored). Service-token credentials come
            from \$AEGIS_CLIENT_ID + \$AEGIS_CLIENT_SECRET (or from \`up\`, in-process) —
            never from CLI flags. The secret is written to the config, never printed.

  deregister  Remove an agent's entry from aegis.config.json (by name or contract) so
            Aegis self-updates on decommission. Idempotent; never touches other agents.

  policy    Show or change the fleet governance gate (provision/aegis.policy.jsonc).
            show prints current caps + the last attested actions. set mutates ONE
            value in place (comments preserved), verifies the re-read, and appends
            the attempt -- approved or refused -- to provision/policy-audit.jsonl.
            Keys: maxFleet maxBatch budget allowedRegions defaultRegion budgetName.
            show --json prints the machine-readable policy (Aegis reads this).
            protect/unprotect <name> use the short per-agent grammar
            (I approve protecting <name> / I approve unprotecting <name>) and
            sync the Azure CanNotDelete lock; set protectedAgents stays for bulk/none.
            Cross-checks fail closed (batch<=fleet; defaultRegion must stay inside
            allowedRegions). Attestation must read exactly: I approve setting <key> to <value>

  set-secrets  Seed an agent's Key Vault with the bootstrap secrets its profile
            fetches at first boot (keel: anthropic-api-key + openrouter-api-key;
            castor: model-api-key + vision-api-key + anthropic-api-key). Keys are read
            from \$ANTHROPIC_API_KEY + \$OPENROUTER_API_KEY in the environment (never
            passed as args). App-TOTP is gone (edge-only auth) — nothing to enroll.
            Requires az + Secrets Officer on the vault.

  backup    Fleet backup store (rg-fleet-backups; one container per agent; nightly
            timer on each fleet-provisioned VM pushes state + volumes via MSI).
            init      create/refresh the store, 14-day retention, deployer data role.
            list      show an agent's backup blobs (newest last).
            snapshot  force a push now (az vm run-command; VM must be running).
            Decommission --go banks a final snapshot as surface 0 automatically.

  resize    Change an agent VM's size in place (name, region, identity, front door, volumes and
            chains all unchanged): capacity-gated, attested, deallocate->resize->start->read back,
            records vmSize in the contract so a rebuild deploys the size the agent runs
            (provision/lib/resize.js). A region move is decommission + up + restore, not a resize.
  migrate   Move an agent's durable data to another agent, mediated by the control plane:
            fresh snapshot of <from>, copied unchanged into <to>'s backup container, and
            <to> extracts ONLY the scoped volumes with the profile prefix translated, using
            its own identity. Same profile: everything but logs. Cross profile: knowledge by
            default, claude opt-in, state and logs never. Add-only by default: files the target
            already has are kept and reported; --overwrite replaces them under a different
            attestation sentence. Ledgered with the source chain's head hash (cross-anchor);
            chains themselves never move (provision/lib/migrate.js).
  enroll    Adopt an already-provisioned agent into THIS control plane with its OWN
            service token (<plane>-<agent>; plane = $AEGIS_PLANE, else hostname), so an
            agent's audit chain can tell one control plane from another. Identity comes
            from the agent RG's tags, the token from Cloudflare, the secret goes straight
            into the (gitignored) registry and is never printed. Attested per agent,
            ledgered, idempotent (see provision/lib/enroll.js).
  discover  What Azure holds against what THIS plane's registry holds; changes nothing.
            registered (both), unenrolled (in Azure -- app=agent-fleet tags -- and not
            in this registry: an enroll away), gone (in this registry, no RG: a
            registry-only decommission away). Two planes, two registries, one Azure:
            the read that lets each plane see the other's work. --json for the panel.
  aegis     Provision the CONTROL PLANE (not an agent). Its own contract and lane, so
            fleet caps and decommission cannot reach it. Budget gate applies; maxFleet
            and allowedRegions do not (see provision/lib/aegis-up.js). 'grant' gives its
            identity the two rights the template deliberately withholds -- Key Vault read
            and subscription Contributor -- each an attested, ledgered act, no other role
            expressible (see provision/lib/aegis-grant.js). 'update' moves the hosted plane's
            two checkouts to their pushed heads (fast-forward only) and restarts the unit --
            attested and ledgered with before/after commits (provision/lib/aegis-update.js).
  restore   Pull a backup onto a (re)provisioned agent and restart its containers
            (az vm run-command; VM must be running). Default = newest blob.

  --aegis-config <path>   Path to aegis.config.json (else \$AEGIS_CONFIG, \$AEGIS_DIR,
                          or <fleet-parent>/aegis/aegis.config.json).

check/plan make no changes. register writes only to the local (gitignored) config.`;

// Flags that take a SPACE-separated value. A flag missing from this set silently becomes a
// bare flag and its value is read as a positional -- which is how `backup get --out <path>`
// downloaded to the working directory while reporting success. Add the flag here the same
// commit it is introduced, or --policy=x works and --policy x does not.
const VALUED = new Set(['--aegis-config', '--policy', '--out', '--as', '--prefix', '--priority', '--tier', '--blob', '--head', '--attest', '--expect']);

function parseArgs(rest) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (VALUED.has(a)) opts[a.slice(2)] = rest[++i];
      else flags.add(a);
    } else {
      positional.push(a);
    }
  }
  return { flags, opts, file: positional[0] };
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  const cmd = args[0];
  const { flags, opts, file } = parseArgs(args.slice(1));
  const aegisConfig = opts['aegis-config'];

  if (cmd === 'check') {
    if (!file) { console.error(c.red('check: missing <contract.agent.jsonc>')); return 2; }
    if (flags.has('--live')) return runCheckLive(file, { aegisConfig, requireLive: flags.has('--require-live'), logs: flags.has('--logs'), expect: opts.expect });
    return runCheck(file, { contractOnly: flags.has('--contract-only') });
  }
  if (cmd === 'plan') {
    if (!file) { console.error(c.red('plan: missing <contract.agent.jsonc>')); return 2; }
    return runPlan(file, { requireWhatif: flags.has('--require-whatif') });
  }
  if (cmd === 'resize') {
    if (!file) { console.error(c.red('resize: missing <contract>')); return 2; }
    const { runResize } = require('../lib/resize');
    const ai = args.indexOf('--attest');
    return runResize(file, { go: flags.has('--go'), attest: ai > -1 ? args[ai + 1] : '', size: opts.size });
  }
  if (cmd === 'migrate') {
    const to = args.slice(1).filter((a) => !a.startsWith('--'))[1];
    if (!file || !to) { console.error(c.red('migrate: usage — fleetctl migrate <from> <to> [--scope=a,b] [--blob=<name>] [--go --attest "..."]')); return 2; }
    const { runMigrate } = require('../lib/migrate');
    const ai = args.indexOf('--attest');
    return runMigrate(file, to, { go: flags.has('--go'), attest: ai > -1 ? args[ai + 1] : '', scope: opts.scope, blob: opts.blob, overwrite: flags.has('--overwrite') });
  }
  if (cmd === 'discover') {
    const { runDiscover } = require('../lib/discover');
    return runDiscover({ aegisConfig, json: flags.has('--json'), plane: opts.plane });
  }
  if (cmd === 'enroll') {
    if (!file) { console.error(c.red('enroll: missing <agent>')); return 2; }
    const { runEnroll } = require('../lib/enroll');
    const ai = args.indexOf('--attest');
    return runEnroll(file, { go: flags.has('--go'), attest: ai > -1 ? args[ai + 1] : '', aegisConfig, domain: opts.domain, plane: opts.plane });
  }
  if (cmd === 'register') {
    if (!file) { console.error(c.red('register: missing <contract.agent.jsonc>')); return 2; }
    return runRegister(file, { aegisConfig });
  }
  if (cmd === 'deregister') {
    if (!file) { console.error(c.red('deregister: missing <name-or-contract>')); return 2; }
    return runDeregister(file, { aegisConfig });
  }
  if (cmd === 'set-secrets') {
    if (!file) { console.error(c.red('set-secrets: missing <agent>')); return 2; }
    return runSetSecrets(file);
  }
  // Intake: drop files into an agent's own container; its timer stages them within 5 minutes.
  // Runs where every fleetctl command runs -- on the Aegis host (this workstation, or the hosted
  // plane). Agents never run fleetctl; they are tunnel-only. From any other machine, use the
  // panel's upload, which stages over the same authenticated path.
  // Rebuild an agent onto its repo HEAD. Was a hand-run sequence three times; the steps that
  // matter are the ones that refuse, and a paste-by-hand sequence only refuses if the operator
  // remembers to paste the refusal in.
  if (cmd === 'rebuild') {
    if (!file) { console.error(c.red('rebuild: missing <contract.agent.jsonc>')); return 2; }
    return require('../lib/rebuild').runRebuild(file, { go: flags.has('--go'), head: opts['head'] });
  }

  if (cmd === 'intake') {
    const bk = require('../lib/backup');
    const sub = args[1];
    if (sub === 'put' && args[2] && args[3]) return bk.runIntakePut(args[2], args.slice(3).filter((a) => !a.startsWith('--')));
    if (sub === 'list' && args[2]) return bk.runIntakeList(args[2]);
    console.error(c.red('intake: usage — fleetctl intake put <agent> <file...> | intake list <agent>'));
    console.error(c.dim('  files land in <agent>/intake/ and the agent sweeps them into staging; Process is still yours'));
    return 2;
  }

  if (cmd === 'backup') {
    const sub = args[1];
    const bk = require('../lib/backup');
    if (sub === 'init') { const { loadPolicy } = require('../lib/policy'); let pol = null; try { pol = loadPolicy(); } catch { /* defaults */ } return bk.runBackupInit(pol); }
    if (sub === 'list' && args[2]) return bk.runBackupList(args[2]);
    if (sub === 'snapshot' && args[2]) return bk.runBackupSnapshot(args[2]);
    if (sub === 'ls' && args[2]) return bk.runBackupLs(args[2], { prefix: opts['prefix'] });
    if (sub === 'get' && args[2] && args[3]) return bk.runBackupGet(args[2], args[3], { out: opts['out'] });
    if (sub === 'put' && args[2] && args[3]) return bk.runBackupPut(args[2], args[3], { as: opts['as'] });
    if (sub === 'rehydrate' && args[2] && args[3]) return bk.runRehydrate(args[2], args[3], { priority: opts['priority'], tier: opts['tier'] });
    console.error(c.red('backup: usage — fleetctl backup init | list <agent> | snapshot <agent>'));
    console.error(c.red('              | ls <container> [--prefix <p>] | get <container> <blob> [--out <path>]'));
    console.error(c.red('              | put <container> <file> [--as <blob>] | rehydrate <container> <blob> [--priority High|Standard] [--tier Hot|Cool]'));
    console.error(c.dim('  containers: <agent> (spare parts, 14d) · records (notebook, never deleted) · ledgers (receipts, never deleted)'));
    return 2;
  }
  // Control plane. A SEPARATE lane from `up` -- see provision/lib/aegis-up.js for which
  // policy gates apply and why. Keeping it out of `up` is what stops maxFleet, the fleet
  // registry, and `decommission` from ever applying to the thing that operates them.
  if (cmd === 'aegis') {
    const sub = args[1];
    const contractFile = args[2];
    const { runAegisUp } = require('../lib/aegis-up');
    const ai = args.indexOf('--attest');
    if (sub === 'plan' && contractFile) return runAegisUp(contractFile, { go: false });
    if (sub === 'up' && contractFile) {
      return runAegisUp(contractFile, { go: flags.has('--go'), attest: ai > -1 ? args[ai + 1] : '' });
    }
    // Post-apply privilege: two verbs, each its own attested + ledgered act (aegis-grant.js).
    if (sub === 'grant' && contractFile) {
      const { runAegisGrant } = require('../lib/aegis-grant');
      return runAegisGrant(contractFile, args[3], { go: flags.has('--go'), attest: ai > -1 ? args[ai + 1] : '' });
    }
    // Self-update of the hosted plane: pull both checkouts ff-only, restart, ledger before/after.
    if (sub === 'update' && contractFile) {
      const { runAegisUpdate } = require('../lib/aegis-update');
      return runAegisUpdate(contractFile, { go: flags.has('--go'), attest: ai > -1 ? args[ai + 1] : '' });
    }
    console.error(c.red('aegis: usage — fleetctl aegis plan <aegis.contract.jsonc>'));
    console.error(c.red('              fleetctl aegis up    <aegis.contract.jsonc> [--go --attest "<sentence>"]'));
    console.error(c.red('              fleetctl aegis grant <aegis.contract.jsonc> vault|contributor|backups [--go --attest "<sentence>"]'));
    console.error(c.red('              fleetctl aegis update <aegis.contract.jsonc> [--go --attest "<sentence>"]'));
    return 2;
  }
  if (cmd === 'restore') {
    const agent = args[1];
    if (!agent) { console.error(c.red('restore: missing <agent>')); return 2; }
    const bi = args.indexOf('--blob');
    return require('../lib/backup').runRestore(agent, { blob: bi > -1 ? args[bi + 1] : undefined, clean: flags.has('--clean'), attest: opts['attest'] });
  }
  if (cmd === 'up') {
    if (!file) { console.error(c.red('up: missing <contract.agent.jsonc>')); return 2; }
    return runUp(file, { go: flags.has('--go'), update: flags.has('--update'), aegisConfig });
  }
  if (cmd === 'decommission') {
    if (!file) { console.error(c.red('decommission: missing <contract.agent.jsonc>')); return 2; }
    return runDecommission(file, { go: flags.has('--go'), aegisConfig, policy: opts['policy'] });
  }

  if (cmd === 'policy') {
    const { showPolicy, setPolicy, setProtection } = require('../lib/policy');
    if (args[1] === 'protect' || args[1] === 'unprotect') {
      const name = args[2];
      const ai = args.indexOf('--attest');
      const attest = ai > -1 ? args[ai + 1] : '';
      if (!name) { console.error(c.red(`policy ${args[1]}: missing <name>`)); return 2; }
      try {
        const r = setProtection({ name, on: args[1] === 'protect', attest });
        console.log(c.green(`policy: protectedAgents ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`) + c.dim(`  (${r.path}; ledgered ${r.ledgered})`) + (r.noop ? c.dim('  [no-op]') : '') + (r.syncOutcome ? '\n' + (r.syncOutcome.startsWith('ok') ? c.green('azure sync ' + r.syncOutcome) : c.red('azure sync ' + r.syncOutcome)) : ''));
        if (String(r.outcome || '').startsWith('incomplete')) {
          console.error(c.red(`policy ${args[1]} INCOMPLETE -- the policy gate applied and is enforcing; the Azure mirror did not. Ledgered: ${r.outcome}`));
          return 1;
        }
        return 0;
      } catch (e) { console.error(c.red(e.message)); return 3; }
    }
    if ((args[1] === 'show' || !args[1] || args[1] === '--json') && args.includes('--json')) {
      const { loadPolicy } = require('../lib/policy');
      let pol; try { pol = loadPolicy(); } catch (e) { console.error(c.red('policy --json: ' + e.message)); return 2; }
      console.log(JSON.stringify(pol)); return 0;
    }
    const rest = args.slice(1);
    const sub = rest[0];
    if (!sub || sub === 'show') { console.log(showPolicy()); return 0; }
    if (sub === 'set') {
      const ai = rest.indexOf('--attest');
      const attest = ai >= 0 ? (rest[ai + 1] || '') : '';
      const pos = rest.slice(1).filter((a, i, arr) => a !== '--attest' && arr[i - 1] !== '--attest');
      try {
        const r = setPolicy({ key: pos[0], value: pos[1], attest });
        console.log(c.green(`policy: ${r.key} ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`) + c.dim(`  (${r.path}; ledgered ${r.ledgered})`) + (r.syncOutcome ? '\n' + (r.syncOutcome.startsWith('ok') ? c.green('azure sync ' + r.syncOutcome) : c.red('azure sync ' + r.syncOutcome)) : ''));
        if (String(r.outcome || '').startsWith('incomplete')) {
          console.error(c.red(`policy set ${r.key} INCOMPLETE -- the policy gate applied and is enforcing; the Azure mirror did not. Ledgered: ${r.outcome}`));
          return 1;
        }
        return 0;
      } catch (e) { console.error(c.red(String(e.message || e))); return 2; }
    }
    console.error(c.red(`policy: unknown subcommand "${sub}" — use: policy show | policy set <key> <value> --attest "..." (keys: maxFleet maxBatch budget allowedRegions defaultRegion budgetName protectedAgents a2aPairs telegramChatIds)`));
    return 2;
  }

  console.error(c.red(`unknown command "${cmd}"`) + '\n');
  console.error(HELP);
  return 2;
}

Promise.resolve(main(process.argv)).then((code) => process.exit(code)).catch((e) => {
  console.error(c.red('fatal: ' + (e && e.message ? e.message : e)));
  process.exit(1);
});
