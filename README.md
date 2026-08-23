# Agent Fleet — Bicep IaC + Walkthrough Runbook

![fleetctl plan — the read-only preview of everything `up` would create](docs/hero.png)

Stand up a **Castor-profile VM** and a **Keel-profile VM**, add a second agent **through the
frontend**, then **decommission it** — testing each for functionality. A **shared core** vendored
into each agent, one Bicep module, per-agent isolation, Cloudflare-Tunnel transport.

> **How to use this:** I authored *and* locally validated these templates (Bicep compiles with
> zero diagnostics; shell + Node + cloud-init syntax-checked — see **Validation record** at the
> bottom). I can't deploy to *your* Azure from my side, so the steps below are yours to run. Every
> command is copy-paste, with the expected output and a ✅ check after it. Substitute your own agent
> name for each `<...-name>` placeholder.

---

## What you'll stand up

| Agent | Profile | Role | Resource group |
|---|---|---|---|
| `<castor-name>` | `castor` | multi-interface assistant | `rg-<castor-name>` |
| `<keel-name>` | `keel` | portfolio-management engine | `rg-<keel-name>` |
| `<extra-name>` | `castor` | added **via the frontend**, then decommissioned | `rg-<extra-name>` |

**One shared core, two distinct images.** Both profiles vendor the **same fleet-core modules** — a
deterministic shared core (`fleet/core/`) that's byte-hash-verified at build time, so a
drifted copy fails the build. But each profile is *its own image*: `castor` adds its intake / vision
/ notification surface, `keel` its portfolio engine. Only the shared core is identical across
profiles; the profile-specific code, the Dockerfile, and the `agentProfile` parameter differ. Each
agent is its own resource group (a clean bulkhead: decommission = delete the group). No public IP by
default; the webchat rides an outbound-only Cloudflare Tunnel.

---

## Shared core (fleet-core)

`fleet/core/` is the single source for code shared across profiles — the model router
(`model-routing.js`), the capability-registry reader (`capability.js`), the egress / Can't-Shouldn't
gate (`gate/*.js`), plus audit, redaction, notify, health, and scan modules. Each agent repo
**vendors** these (it never fetches at build), so it stays hermetically buildable. A SHA256 manifest
carried in a `.fleet-core-version` stamp, plus an in-build `verify-core.sh` per destination,
guarantee the vendored copy matches canonical — a drifted module fails the agent's build loud.

Propagate a change deliberately:

```bash
# 1. edit a module in core/ (or core/gate/), refresh the affected manifest, commit + push:
( cd core && sha256sum *.js ) > core/manifest.sha256
( cd core/gate && sha256sum *.js ) > core/gate/manifest.sha256
git add core/<changed> && git commit -m "core: <what>" && git push

# 2. sync into each agent repo (from a fleet checkout):
./core/sync-core.sh ~/castor                    scaffold/scripts scaffold/gate
./core/sync-core.sh ~/keel scripts          gate

# 3. in each agent repo: commit the vendored files + .fleet-core-version, rebuild --no-cache.
```

A new agent Aegis spins up inherits whatever core was last synced into the agent-repo templates. See
`core/README.md` for the full module list and the per-profile destinations.

---

## Prerequisites (your side)

- An **Azure subscription** + the **`az` CLI** (`az version`), logged in.
- A **Cloudflare account** with a domain on Cloudflare and **Zero Trust** enabled (free tier is fine).
- A **model API key** (Anthropic, or an OpenRouter key if you front it with LiteLLM).
- An **SSH keypair** (we create one below).
- This bundle unzipped locally; run all commands from its root.

```
fleet/
├── core/                             # shared modules vendored into each agent (model-routing, capability, gate/…)
│   ├── *.js   manifest.sha256        # scripts-dest modules + drift manifest
│   ├── gate/*.js  gate/manifest.sha256
│   ├── sync-core.sh   verify-core.sh
│   └── README.md
├── bicep/
│   ├── main.bicep                    # subscription-scoped: RG + VM module
│   ├── modules/vm.bicep              # network + compute (no public IP unless SSH_CIDR set)
│   ├── cloud-init/agent-cloudflared.yaml
│   └── params/{castor,keel}.bicepparam
├── scripts/{deploy,decommission,smoke-test}.sh
├── aegis/aegis-provision.js          # the frontend "Add/Decommission" endpoint (stub)
└── README.md                         # this runbook
```

---

## Part 0 — one-time setup

```bash
az login
az account set --subscription "<YOUR-SUBSCRIPTION-ID>"

# SSH key for bootstrap (skip if you already have one)
ssh-keygen -t ed25519 -f ~/.ssh/agentfleet -N ""
export SSH_PUBKEY="$(cat ~/.ssh/agentfleet.pub)"
export AZ_LOCATION="eastus2"

# First-run convenience: open SSH from *only* your current IP.
# (Leave SSH_CIDR unset for the hardened, no-public-IP path — see Security notes.)
export SSH_CIDR="$(curl -s https://api.ipify.org)/32"

# Optional: reproducible pinned build. Point REPO_URL at your fork and REPO_REF at
# the exact commit/branch/tag to build. Leave REPO_REF unset to build default-branch HEAD.
export REPO_URL="https://github.com/marcusmayo/keel.git"
export REPO_REF=""   # e.g. a commit SHA, or "feature/ado-normalizer"
```

**Cloudflare tunnel — once per agent** (repeat per agent name you deploy). In the Zero Trust
dashboard → **Networks → Tunnels → Create tunnel** (name it after the agent), then:

1. Copy the **tunnel token** (a long `eyJ…` string) — you'll `export CF_TUNNEL_TOKEN=…` per agent.
2. **Public hostname:** `<agent-name>.<yourdomain>` → service `http://localhost:8443` (the webchat).
3. **Access → Applications → Add self-hosted app** for that hostname, policy = *your email only*
   (Cloudflare Access is the sole authenticator; the app has no login of its own). To require a second factor, add an
   **authenticator/MFA method** in the app's **MFA** settings.
4. *(Hardened path only)* add a second hostname `ssh-<agent-name>.<yourdomain>` → `ssh://localhost:22`
   and an Access app, so you can bootstrap without any public IP.

> ✅ **Check:** `az account show -o table` prints your subscription, and you have a tunnel token
> per agent.

---

## Bringing up a new agent — the `fleetctl` path

`provision/fleetctl` collapses the manual provisioning below (Parts 1–2) into one
contract-driven command. Each agent is described by a committed, secret-free contract
at `agents/<name>.agent.jsonc`; the CLI validates it and drives the **same** Bicep +
Cloudflare steps you'd run by hand — one ground truth, not a second code path. Node ≥ 18,
zero runtime dependencies. Run everything from the repo root.

### Step 1 — write the contract

`agents/<name>.agent.jsonc` (template: `agents/example.agent.jsonc`):

```jsonc
{
  "contract": 1,            // compat floor; the CLI fails closed on an unknown major
  "name": "atlas-01",       // ^[a-z][a-z0-9-]{1,23}$  ->  rg-<name>, <name>-vm, <name>.<domain>
  "profile": "keel",        // castor | keel
  "domain": "keel-pm.com",  // optional (default keel-pm.com)
  "sshCidr": "",            // "" = hardened (no public IP, tunnel-only); else "1.2.3.4/32"
  "repoRef": ""             // "" = default-branch HEAD; else a pinned commit/branch/tag
}
```

### Step 2 — set the environment (once per session)

```powershell
$env:CF_API_TOKEN      = "<Cloudflare API token: Zero Trust + DNS edit>"
$env:CF_ACCOUNT_ID     = "<Cloudflare account id>"
$env:CF_OPERATOR_EMAIL = "<your operator email>"        # the human one-time-PIN allow policy
$env:SSH_PUBKEY        = Get-Content "$HOME\.ssh\keel_t2.pub" -Raw
$env:AEGIS_CONFIG      = "<path-to-your-aegis-repo>\aegis.config.json"
az login    # if not already
```

Also required on PATH: `pwsh` (or `powershell`), `bash`, `az`.

### Step 3 — preview, then execute

`up` with no flag prints the full ordered plan and **changes nothing** — cheap,
reversible steps first, the billable VM last. Read it, then add `--go`:

```powershell
node .\provision\bin\fleetctl.js up .\agents\atlas-01.agent.jsonc          # plan (no changes)
node .\provision\bin\fleetctl.js up .\agents\atlas-01.agent.jsonc --go      # execute
```

`--go` runs, fail-fast, in this order:

1. **Cloudflare front door** — `scripts/cloudflare-provision.ps1`: creates/reuses the named
   tunnel, the DNS record `<name>.<domain>`, the self-hosted Access app, and the
   `<name>-operator` (email) policy. The tunnel token is captured for step 5 (written to a
   temp file via `-TokenOutFile`, then deleted).
2. **Service token** — `POST /accounts/{acct}/access/service_tokens` mints `aegis-<name>`. Its
   `client_id`/`client_secret` are held in memory; the secret is written **only** to
   `aegis.config.json` (step 4) and is never printed.
3. **Service Auth policy** — finds the app by hostname and adds a policy with
   `decision: non_identity` including that service token, so Aegis reaches the agent
   non-interactively. (The action must be *Service Auth* / `non_identity`, **not** Allow, or
   Cloudflare prompts for an interactive login.)
4. **Register** — upserts `{ name, profile, host, clientId, clientSecret }` into
   `aegis.config.json` (idempotent by name; **refuses** if that file isn't gitignored).
5. **Deploy the VM (billable)** — `scripts/deploy.sh <profile> <name>`:
   `az deployment sub create` → `rg-<name>` + `<name>-vm` (+ per-agent Key Vault, managed
   identity, and blob backup for the `castor` profile). Last on purpose: a failure in
   steps 1–4 never leaves an orphaned, billable VM.

### Step 4 — finish and verify

cloud-init builds and **brands** the image (the webchat shows `<name>`, not the repo default)
over ~4–8 minutes. Then inject runtime secrets and confirm health:

```powershell
.\scripts\ssh-open.ps1 -AgentName atlas-01      # temp SSH rule for your IP (NSG is deny-all)
# ssh in (command is printed); on the VM run:  bash infra/scripts/bootstrap.sh    (model keys)
.\scripts\ssh-close.ps1 -AgentName atlas-01     # back to zero-inbound

node .\provision\bin\fleetctl.js check .\agents\atlas-01.agent.jsonc --live   # expect HTTP 200
```

`check --live` reads the agent's service token from `aegis.config.json` and probes
`https://<name>.<domain>/health/liveliness` through the tunnel. A 200 means the agent is up
and Aegis can reach it. Start Aegis (`node aegis.js`) to see it in the console.

### CLI command summary

| command | what it does | changes anything? |
| --- | --- | --- |
| `check <contract>` | validate contract + preflight env (az, CF token, SSH key, bicepparam) | no |
| `check <contract> --live` | probe the deployed agent's `/health/liveliness` (HTTP 200) | no |
| `plan <contract>` | preview every Azure + Cloudflare + register resource, then `az … what-if` | no |
| `up <contract>` | print the full runbook above | no |
| `up <contract> --go` | execute the runbook | **yes** — CF resources, a service token, a VM |
| `register <contract>` | upsert the agent into `aegis.config.json` (`$AEGIS_CLIENT_ID`/`_SECRET`) | writes local config |

The fully manual, step-by-step equivalent (for debugging or first-run understanding) is
Parts 1–5 below.

### Happy path — a fresh agent, start to finish

This is the validated end-to-end sequence (run from the repo root, Windows PowerShell).

1. **One-time environment** (per shell session). `up` needs these; it aborts loudly if any
   is missing or still holds an angle-bracket placeholder:
   ```powershell
   $sec = Read-Host "Cloudflare API token" -AsSecureString
   $env:CF_API_TOKEN      = [System.Net.NetworkCredential]::new('', $sec).Password
   $env:CF_ACCOUNT_ID     = "<your Cloudflare account id>"
   $env:CF_OPERATOR_EMAIL = "<your operator email>"
   $env:SSH_PUBKEY        = Get-Content "$HOME\.ssh\keel_t2.pub" -Raw
   $env:AEGIS_CONFIG      = "<path-to-your-aegis-repo>\aegis.config.json"
   az login
   ```
   The **Cloudflare API token** must carry all five permissions or a step will 403:
   Account · *Cloudflare Tunnel* · Edit; Account · *Access: Apps and Policies* · Edit;
   Account · *Access: Service Tokens* · Edit; Account · *Access: Organizations, Identity
   Providers, and Groups* · Edit; Zone · *DNS* · Edit (zone = your domain).
   Also on PATH: `powershell`, **Git Bash** (`up` uses it, not WSL), and `az`.

2. **Contract.** `agents/<name>.agent.jsonc` (see Step 1 earlier). Use `sshCidr: ""` for a
   hardened, tunnel-only agent, or `"<your-ip>/32"` if you want to bootstrap over temp SSH.
   For a throwaway you don't want committed, name it `<name>.local.jsonc` (gitignored).

3. **Provision.** Preview, then execute:
   ```powershell
   node .\provision\bin\fleetctl.js up .\agents\<name>.agent.jsonc          # plan (no changes)
   node .\provision\bin\fleetctl.js up .\agents\<name>.agent.jsonc --go      # execute
   ```

4. **Finish (runtime secrets).** cloud-init builds + brands the image (~4–8 min). Then:
   ```powershell
   .\scripts\ssh-open.ps1 -AgentName <name>      # prints the ssh command (temp NSG rule for your IP)
   ```
   On the VM — **wait for cloud-init to finish first**, then bootstrap from the repo dir:
   ```bash
   cloud-init status                             # expect: status: done
   tail -n 3 /var/log/agent-image-build.log      # expect: BUILT <profile>:<sha>
   grep agent_name ~/agent/system/agent.yaml     # expect: agent_name: "<name>"  (brand)
   cd ~/agent && bash infra/scripts/bootstrap.sh # fetches the model keys; starts the stack
   sudo docker ps                                # expect the webchat container Up
   exit
   ```
   ```powershell
   .\scripts\ssh-close.ps1 -AgentName <name>     # back to zero inbound
   ```

5. **Verify + see it in Aegis.**
   ```powershell
   node .\provision\bin\fleetctl.js check .\agents\<name>.agent.jsonc --live   # expect HTTP 200
   ```
   Open `https://<name>.<domain>` (one-time PIN to your email) — the brand reads **<name>**.
   In Aegis, click **Refresh fleet** (re-reads `aegis.config.json` live) and the agent appears.

6. **Decommission** (deletes the Azure resource group and everything in it):
   ```powershell
   az group delete --name rg-<name> --yes        # blocks until deleted; verify: az group exists -n rg-<name>
   ```
   Then in Cloudflare delete the service token `aegis-<name>`, the Access app `<name>`, the
   tunnel `<name>`, and the `<name>` DNS record; and remove the `<name>` entry from
   `aegis.config.json` (Refresh fleet to update the panel).

### Keel vs Castor

The profile is a single contract field — `"profile": "keel"` or `"profile": "castor"` — and
the same `up` runbook drives both. What differs:

| | Keel | Castor |
| --- | --- | --- |
| default build repo | `keel` | `castor` |
| Azure extras | VM only | + per-agent **Key Vault**, user-assigned **managed identity**, blob **backup** (the `wantsVault` branch in `vm.bicep`) |
| deployer object id | not needed | resolved (`az ad signed-in-user show`) for the Key Vault Secrets Officer grant |
| bootstrap secrets | Anthropic key | model/vision keys (LiteLLM/OpenRouter) |

So a Castor agent is just `up .\agents\<name>.agent.jsonc --go` with `profile: castor`; the
extra vault/identity resources and the `castor.bicepparam` selection happen automatically.

### Operational notes (learned the hard way)

- **A VM's cloud-init (`customData`) is immutable.** You cannot "redeploy over" an existing
  agent VM to change its cloud-init — `up` aborts if `rg-<name>` already exists. To rebuild,
  `az group delete --name rg-<name> --yes`, wait for `az group exists` to print `false`, then
  re-run. `--update` is only for in-place changes that don't touch cloud-init.
- **Empty ≠ absent for env vars.** `up` passes the *resolved* `REPO_URL` explicitly; a
  present-but-empty value would make the bicepparam skip its default and cloud-init run
  `git clone ''`. `@minLength(1)` on `repoUrl` now fails such a deploy at submit time.
- **Don't type raw `bash scripts/...` at the PowerShell prompt** — on Windows `bash` resolves
  to the System32 WSL launcher, which fails if no distro is installed. `up` calls Git Bash
  directly; for one-off `.sh` runs use `& "C:\Program Files\Git\bin\bash.exe" <script>`, or the
  `az`/PowerShell equivalent (e.g. `az group delete` instead of `decommission.sh`).
- **A 502 at `<name>.<domain>` means the tunnel is up but nothing is listening on 8443 yet** —
  cloud-init/build not finished, or bootstrap not run. A dead tunnel gives 530 instead.
- **`build-image.sh` and cloud-init:** the build script defaults `NOCACHE` to empty
  (`${NOCACHE:-}`) so it runs under cloud-init's `set -u`; pass `NOCACHE=--no-cache` only for a
  manual no-cache rebuild.

### Roadmap — Aegis-driven provisioning (next)

Today provisioning runs from the workstation CLI; Aegis only relays to live agents. The next
milestone is driving the whole lifecycle — provision (Keel/Castor), refresh, and decommission —
**from the Aegis panel**, with in-browser prompts for the minimum required inputs, a
fire-and-forget spinner with loud failure, and agents that come up fully configured from
vault-stored secrets (no interactive SSH bootstrap). That moves the Cloudflare token and Azure
credential onto the Aegis host (the deferred "approach-B" seam), so it's scoped as its own build.

---

## Part 1 — stand up your **Castor-profile agent**

```bash
export CF_TUNNEL_TOKEN="<castor tunnel token>"
scripts/deploy.sh castor <castor-name>
```

Expected (trimmed):

```
>> Deploying agent '<castor-name>' (profile: castor) to eastus2
>> SSH bootstrap open from: 203.0.113.5/32 (public IP created)
{
  "rg": "rg-<castor-name>",
  "profile": "castor",
  "publicIp": true,
  "privateIp": "10.30.0.4"
}
>> Provisioned. cloud-init is now building the image on the VM (~4-8 min).
```

> ✅ **Check:** `az group show -n rg-<castor-name> -o table` shows `Succeeded`.

**Set the operator secrets in the agent's Key Vault** — Castor's bootstrap fetches these at
runtime via managed identity, so they never touch the template or disk:

```bash
# Validated wrapper: prompts (no echo) and rejects a placeholder or wrong key
# before it reaches the vault (model-api-key must be sk-or-*, vision-api-key sk-ant-*).
bash scripts/set-secrets.sh rg-<castor-name>
```

**Bootstrap** — non-interactive: it fetches the secrets above via managed identity, generates
seeds the egress config, and brings the stack up:

```bash
# public-IP path:
PUBIP=$(az vm list-ip-addresses -g rg-<castor-name> --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)
ssh -i ~/.ssh/agentfleet agentadmin@"$PUBIP"
# --- OR hardened path (no public IP): cloudflared access ssh --hostname ssh-<castor-name>.<domain>

# on the VM:
cd ~/agent
tail -n 5 -f /var/log/agent-image-build.log     # wait for "BUILT castor:<sha>", then Ctrl-C
./infra/scripts/bootstrap.sh                     # MI-fetches the model keys and brings the stack up
```

Expected tail of bootstrap: `publishing webchat on 127.0.0.1:8443` → smoke test → `bootstrap complete`.

**Test it:**

```bash
# on the VM:
~/agent/scripts/smoke-test.sh
```

Then from your **phone or laptop browser**: open `https://<castor-name>.<yourdomain>` → Cloudflare
Access login → the webchat loads. There is no second prompt: the edge is the factor.

> ✅ **Checklist:** RG `Succeeded` · image built · `bootstrap complete` · webchat reachable
> at its Cloudflare hostname · Access login appears · smoke test all PASS.

---

## Part 2 — stand up your **Keel-profile agent**

Same flow, different profile and its own tunnel token:

```bash
export CF_TUNNEL_TOKEN="<keel tunnel token>"
scripts/deploy.sh keel <keel-name>
```

Expected: `"rg": "rg-<keel-name>", "profile": "keel"`. Bootstrap identically (public-IP or hardened),
then open `https://<keel-name>.<yourdomain>`.

**What differs from the Castor agent:** the **shared core is identical**, but the image is the Keel
build (`agentProfile=keel` written to `.provision-flags`, Keel's own Dockerfile and profile code).
The Keel profile is the portfolio engine — try a portfolio skill in the webchat (e.g. ask it to
score an item with WSJF/RICE, or normalize a small backlog). The Castor profile is where you'd
instead enable the Telegram/email interfaces and the drafting skill set. Both profiles ship the same
capability registry, so the same optional integrations are available to toggle on either.

> ✅ **Checklist:** RG `Succeeded` · profile shows `keel` · webchat reachable · a
> portfolio/scoring skill responds · smoke test all PASS.

---

## Part 3 — add a second **Castor** agent **through the frontend**

The frontend "Add agent" button calls the Aegis provisioning endpoint (`aegis/aegis-provision.js`),
which is a thin wrapper over the **same** `deploy.sh`. On the Aegis host (with the least-privilege
service principal logged in and per-agent secrets in the vault):

```bash
# what the frontend button does under the hood:
curl -X POST http://127.0.0.1:7070/agents \
  -H 'content-type: application/json' \
  -d '{"name":"<extra-name>","profile":"castor"}'
# -> { "status": "provisioning", "name": "<extra-name>", "profile": "castor", "log": "...rg-<extra-name>..." }
```

Because the endpoint just shells out to `deploy.sh castor <extra-name>`, the CLI equivalent is
identical (use this if you're testing before wiring the endpoint):

```bash
export CF_TUNNEL_TOKEN="<extra tunnel token>"
scripts/deploy.sh castor <extra-name>
```

Bootstrap + test exactly as in Part 1, at `https://<extra-name>.<yourdomain>`.

> ✅ **Checklist:** provision call returns `provisioning` · `rg-<extra-name>` `Succeeded` ·
> webchat reachable · smoke test all PASS · and note it did **not** touch your other agents.

---

## Part 4 — decommission the added agent

Frontend "Decommission" button → `DELETE`, which wraps `decommission.sh … --yes`:

```bash
curl -X DELETE http://127.0.0.1:7070/agents/<extra-name>
# -> { "status": "decommissioned", "name": "<extra-name>", "log": "...deleted..." }
```

CLI equivalent (interactive confirm):

```bash
scripts/decommission.sh <extra-name>        # type "<extra-name>" to confirm
```

**Verify it's gone:**

```bash
az group show -n rg-<extra-name> -o table   # expect: (ResourceGroupNotFound)
```

Then the manual offboarding the script reminds you of: delete the agent's **Cloudflare tunnel +
Access app**, revoke its **model key**, and remove its **Aegis registry entry**.

> ✅ **Checklist:** `az group show` returns *NotFound* · your other agents still reachable
> (isolation held) · Cloudflare tunnel/key revoked.

---

## Part 5 — functionality test matrix (per VM)

| Check | How | Pass = |
|---|---|---|
| Provisioned | `az group show -n rg-<name>` | `Succeeded` |
| Image built | on VM: `grep -cE 'BUILT (keel\|castor\|atlas):' /var/log/agent-image-build.log` | ≥ 1 |
| Shared core intact | on VM: `bash scripts/verify-core.sh scripts && bash gate/verify-core.sh gate` | both `verify-core OK` |
| Container healthy | on VM: `curl -fsS http://127.0.0.1:8443/health/liveliness -o /dev/null && echo ok` | `ok` (HTTP 200) |
| Webchat reachable | browser: `https://<name>.<domain>` (after Access) | page loads |
| MFA enforced | Cloudflare Access MFA (the app has no login) | Access prompt appears |
| Redaction gate | on VM: `node gate/ask.js "email me at test@example.com"` then check `logs/audit.jsonl` | entity tokenized, audit entry appended |
| State writable | on VM: `scripts/smoke-test.sh` | `state volume writable` PASS |
| Isolation | after teardown of the added agent, the others still answer | all reachable |

`scripts/smoke-test.sh` bundles the HTTP + container + state checks; run it on each VM.

---

## Cost & full cleanup

Each VM is a **Standard_D2s_v3** (~$70-90/mo if left on; far less for a short test). Tear the whole
fleet down when done:

```bash
scripts/decommission.sh <castor-name>
scripts/decommission.sh <keel-name>
# (the added agent already gone)
```

---

## Security notes

- **Hardened path (recommended for real use):** leave `SSH_CIDR` unset → **no public IP at all**;
  the NSG denies every inbound rule and you bootstrap via `cloudflared access ssh`. The `SSH_CIDR`
  option exists only to make first-run lifecycle testing frictionless.
- **Secrets:** the tunnel token is the only secret in `customData` and is scrubbed from cloud logs
  after install. Runtime secrets (the model keys) are injected over SSH by `bootstrap.sh`, never in
  the template. Production upgrade: pull all three from **Key Vault** via managed identity.
- **Shared-core integrity:** every agent's build fails loud if a vendored core module drifts from the
  fleet-core manifest, so the egress gate and redaction logic can't silently diverge between agents.
- **Frontend provisioning:** `aegis-provision.js` binds to loopback (reachable only through the
  tunnel), requires the Aegis operator session, validates `name`/`profile` against strict allow-lists
  (no shell injection), and authenticates to Azure with a **least-privilege service principal**
  (Contributor scoped to the fleet subscription — not Owner, not tenant-wide).
- **Data boundary:** each agent processes only owner-authored derivative content; the per-agent
  redaction gate tokenizes entities before any model call.

---

## Validation record (done in-sandbox before handoff)

| Artifact | Tool | Result |
|---|---|---|
| `bicep/main.bicep` (+ vm module) | `bicep build` v0.45.15 | compiles, **0 warnings / 0 errors** |
| `params/castor.bicepparam` | `bicep build-params` | OK |
| `params/keel.bicepparam` | `bicep build-params` | OK |
| `scripts/*.sh` | `bash -n` | all OK |
| `core/sync-core.sh` + `core/verify-core.sh` | `bash -n` + round-trip vendor/verify | OK |
| `aegis/aegis-provision.js` | `node --check` | OK |
| `cloud-init/agent-cloudflared.yaml` | `yaml.safe_load` | OK |

**Not validated here (needs your accounts):** a live `az deployment` (subscription auth), the
Cloudflare tunnel/Access setup, and end-to-end webchat over the tunnel. Those are the steps in Parts
0–4 for you to run — or we can do them together in a guided session where you paste outputs back and
I troubleshoot.
