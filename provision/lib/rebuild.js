'use strict';
// fleetctl rebuild <contract> -- the rebuild lane, promoted from the shape that was hand-run
// three times before this existed. Each hand-run was a fresh chance to forget a step; the steps
// that matter are the ones that REFUSE, and a script only refuses if someone remembers to paste
// the refusal in.
//
// The sequence, on the agent VM through the guest agent (no SSH -- these VMs are deny-all inbound):
//   1. restore tracked files the build regenerates, so a pull cannot conflict on them
//   2. show the identity overlay, because a rebuild that loses it renames the agent silently
//   3. git pull --ff-only, then ASSERT the HEAD when one was named (--head)
//   4. build the image (verify-core runs inside it, so vendored drift fails here)
//   5. bootstrap: gateway config, compose up, gateway restart if it predates its config, smoke
//   6. read back what the rebuild was for: containers, the agent's own name, liveliness
//
// Everything is printed. Nothing is inferred from an exit code alone.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { c, runCapture } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');

// The payload is built from single-quoted lines joined with \n and shipped as @file: bash $vars,
// double quotes and {{.Names}} all survive, because PowerShell never interpolates it and az never
// parses it as an argument.
function rebuildScript({ profile, head }) {
  const L = [
    '#!/bin/bash',
    'set -o pipefail',
    'AD=/home/agentadmin/agent',
    '[ -d "$AD/scaffold" ] && AD="$AD/scaffold"',
    'REPO=/home/agentadmin/agent',
    `WANT=${head || ''}`,
    `PROFILE=${profile}`,
    'echo "=== 1. repo state ==="',
    'git config --system --add safe.directory "$REPO" 2>/dev/null || true',
    'cd "$REPO" || { echo "FATAL: no repo at $REPO"; exit 1; }',
    'git status --porcelain | head -20',
    'DIRTY="$(git status --porcelain | grep \'^ M\' | awk \'{print $2}\')"',
    'if [ -n "$DIRTY" ]; then echo "restoring tracked files from HEAD:"; echo "$DIRTY" | sed \'s/^/  /\'; echo "$DIRTY" | xargs -r git checkout HEAD --; fi',
    'echo "=== 2. identity overlay ==="',
    'if [ -f "$AD/system/agent.local.yaml" ]; then cat "$AD/system/agent.local.yaml" | sed \'s/^/  /\'; else echo "NOTE: no overlay -- the agent falls back to the profile default name"; fi',
    'echo "=== 3. pull ==="',
    'git pull --ff-only 2>&1 | tail -3',
    'HEAD="$(git rev-parse --short HEAD)"',
    'echo "HEAD now: $HEAD"',
    'if [ -n "$WANT" ]; then case "$HEAD" in "$WANT"*) echo "HEAD matches $WANT" ;; *) echo "FATAL: HEAD $HEAD != $WANT -- refusing to build something other than what was asked for"; exit 1;; esac; fi',
    'echo "=== 4. build (verify-core runs inside) ==="',
    'cd "$AD" || exit 1',
    'timeout 45m bash ./infra/scripts/build-image.sh 2>&1 | tail -12',
    'BRC=$?',
    '[ "$BRC" = 0 ] || { echo "FATAL: image build failed (rc=$BRC)"; exit 1; }',
    // The agent's own tests, run against the image just built and BEFORE it is brought up.
    // A throwaway container with no network, so a failure leaves the PREVIOUS image serving
    // rather than promoting a broken one and finding out afterwards. Running from the image
    // means the tests see what was actually assembled: vendored core, tools, node_modules.
    'echo "=== 4b. agent tests (fresh image, nothing serving yet) ==="',
    'if sudo docker run --rm --entrypoint sh "${PROFILE}:latest" -c "[ -f /app/scripts/run-tests.js ]"; then',
    '  TLOG=$(mktemp)',
    '  sudo docker run --rm --network none "${PROFILE}:latest" node /app/scripts/run-tests.js /app > "$TLOG" 2>&1',
    '  TRC=$?',
    '  tail -30 "$TLOG"; rm -f "$TLOG"',
    '  [ "$TRC" = 0 ] || { echo "FATAL: agent tests failed (rc=$TRC) -- the previous image is still serving"; exit 1; }',
    'else',
    '  echo "NO TEST GATE: /app/scripts/run-tests.js absent from the image -- this agent has not adopted the test lane; rebuild continues"',
    'fi',
    'echo "=== 5. bootstrap ==="',
    'sudo -u agentadmin bash "$AD/infra/scripts/bootstrap.sh" 2>&1 | tail -20',
    'echo "=== 6. read back ==="',
    'echo "committer identity: $(git -C "$REPO" config user.name || echo MISSING) <$(git -C "$REPO" config user.email || echo MISSING)>"',
    'sudo docker ps --format \'{{.Names}}  {{.Status}}  {{.Image}}\' | grep -E "^${PROFILE}-" || echo "NONE RUNNING"',
    'sudo docker exec "${PROFILE}-webchat" node -e \'try{const a=require("/app/scripts/auth");console.log("agent name: "+(a.readAgentName?a.readAgentName("/app"):"(no readAgentName)"))}catch(e){console.log("(auth not loadable: "+e.message+")")}\' 2>&1 | head -3',
    'curl -s -o /dev/null -w \'local health: %{http_code}\\n\' http://127.0.0.1:8443/health/liveliness 2>/dev/null || echo "local probe failed (the real check is fleetctl check --live)"',
    'echo "=== rebuild complete: ${PROFILE} at $HEAD ==="',
  ];
  return L.join('\n') + '\n';
}

function runRebuild(file, opts = {}) {
  const res = loadContract(file);
  if (!res.ok) { console.log(c.red(`rebuild: ${(res.errors || []).join('; ')}`)); return 2; }
  const d = derive(res.value);
  const name = d.register.name;
  const rg = d.azure.resourceGroup;
  const vm = d.azure.vmName;
  const head = (opts.head || '').trim();
  if (head && !/^[0-9a-f]{7,40}$/i.test(head)) { console.log(c.red('rebuild: --head must be a git sha')); return 2; }

  console.log(c.cyan(`rebuild ${name}  (${d.azure.profile})`));
  console.log(c.dim(`  ${rg} / ${vm}  ${head ? '-> HEAD must start ' + head : '-> whatever the branch pulls (pass --head <sha> to assert one)'}`));
  if (!opts.go) {
    console.log(c.yellow('\nPlan only. This RESTARTS the agent: the image is rebuilt and the containers are recreated,'));
    console.log(c.yellow('so the agent is unreachable for a few minutes and any in-flight turn is lost.'));
    console.log(c.yellow(`  To run it:  fleetctl rebuild ${file}${head ? ' --head ' + head : ''} --go`));
    return 0;
  }
  const tmp = path.join(os.tmpdir(), 'fleet-rebuild-' + name + '-' + process.pid + '.sh');
  try {
    fs.writeFileSync(tmp, rebuildScript({ profile: d.azure.profile, head }));
    console.log(c.dim('  running on the VM through the guest agent (no SSH); the image build is the long part…'));
    const r = runCapture('az', ['vm', 'run-command', 'invoke', '-g', rg, '-n', vm,
      '--command-id', 'RunShellScript', '--scripts', '@' + tmp, '-o', 'json']);
    if (!r.ok) { console.log(c.red('rebuild FAILED to run: ' + (r.stderr || '').split('\n')[0])); return 1; }
    let msg = '';
    try { msg = (JSON.parse(r.stdout || '{}').value || [])[0].message || ''; } catch { msg = r.stdout || ''; }
    console.log(msg);
    if (/FATAL:/.test(msg)) { console.log(c.red(`\nrebuild ${name} INCOMPLETE — the VM refused a step above; nothing after it ran.`)); return 1; }
    console.log(c.green(`\nrebuild ${name} complete — verify the front door with: fleetctl check ${file} --live`));
    return 0;
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

module.exports = { runRebuild, rebuildScript };
