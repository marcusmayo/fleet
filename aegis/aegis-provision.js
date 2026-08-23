// aegis-provision.js — REFERENCE STUB (not production).
// The thin provisioning endpoint Aegis exposes so the frontend "Add agent" and
// "Decommission" buttons map onto the SAME Bicep deploy/decommission you run by
// hand. The button is a wrapper over the identical `az deployment` call — no
// second code path, so the CLI walkthrough IS the ground truth.
//
//   POST   /agents        { name, profile }  ->  scripts/deploy.sh <profile> <name>
//   DELETE /agents/:name                     ->  scripts/decommission.sh <name> --yes
//
// Runs on the Aegis host, bound to loopback, reached only through the tunnel.
// Authenticates to Azure via a LEAST-PRIVILEGE service principal (Contributor
// scoped to the fleet subscription — NOT Owner, NOT tenant-wide). Per-agent
// secrets (Cloudflare token, SSH pubkey) come from a vault, never the request body.

const express = require('express');
const { execFile } = require('child_process');
const app = express();
app.use(express.json());

const FLEET_DIR = process.env.FLEET_DIR || '/opt/fleet';
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;          // deterministic; blocks injection
const PROFILES = ['castor', 'keel'];

// --- auth gate: require the same Aegis operator session the webchat uses ---
app.use((req, res, next) => {
  // verifyAegisSession(req) should confirm the operator session established at the edge.
  // Left as a hook: wire to your existing webchat auth middleware.
  if (!verifyAegisSession(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

function run(script, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile('bash', [script, ...args], {
      cwd: FLEET_DIR,
      env: { ...process.env, ...extraEnv },
      timeout: 15 * 60 * 1000,
    }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

// Stand up a new agent (what the frontend "Add agent" button calls).
app.post('/agents', async (req, res) => {
  const { name, profile } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid agent name' });
  if (!PROFILES.includes(profile)) return res.status(400).json({ error: 'profile must be castor|keel' });
  try {
    const env = await vaultEnvForAgent(name);      // { CF_TUNNEL_TOKEN, SSH_PUBKEY, SSH_CIDR? }
    const log = await run('scripts/deploy.sh', [profile, name], env);
    // TODO: append { name, profile, endpoint, intakeKey } to the Aegis registry here.
    res.json({ status: 'provisioning', name, profile, log: tail(log) });
  } catch (e) {
    res.status(500).json({ status: 'error', name, error: e.message });
  }
});

// Decommission an agent (what the frontend "Decommission" button calls).
app.delete('/agents/:name', async (req, res) => {
  const name = req.params.name;
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  try {
    // Deregister FIRST so routing + intake stop before teardown.
    // deregisterFromRegistry(name);
    const log = await run('scripts/decommission.sh', [name, '--yes'], { FLEET_YES: '1' });
    res.json({ status: 'decommissioned', name, log: tail(log) });
  } catch (e) {
    res.status(500).json({ status: 'error', name, error: e.message });
  }
});

const tail = (s, n = 2000) => String(s).slice(-n);

// --- hooks you implement against your own setup ---
function verifyAegisSession(_req) { return true; }              // replace with real auth
async function vaultEnvForAgent(_name) { return {}; }           // replace with Key Vault lookup

app.listen(7070, '127.0.0.1', () => console.log('aegis-provision on 127.0.0.1:7070 (reachable only via the tunnel)'));
