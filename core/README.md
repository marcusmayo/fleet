# fleet-core (shared agent core)

Canonical shared source for the agent fleet (Castor / Keel profiles), living in
`fleet/core/` and vendored into each agent repo with build-time hash checks.
**Edit shared code here, once.**

## Why vendored (not fetched)

Each agent repo stays a self-contained, hermetically buildable unit -- Aegis can
clone-and-deploy any agent with zero build-time network dependency. Shared files are
committed *in* each agent; a SHA256 manifest carried in a `.fleet-core-version` stamp
plus an in-build `verify-core.sh` guarantee a vendored copy can never silently drift.

## Layout (fleet/core/)

    *.js                  modules that vendor into each agent's scripts/ dir
      model-routing.js      tier resolver + slug selection + gateway-config gen
      capability.js         capability-registry reader (requireCapability)
      audit-log.js  health-check.js  notify.js  redact.js  redaction-gate.js  scan-tree.js
    manifest.sha256       SHA256 of each scripts-dest module (drift gate) -- GENERATED, never hand-edited
    gate/                 modules that vendor into each agent's gate/ dir (egress / Can't-Shouldn't)
      ask.js  audit.js  gate.js  redact.js  tripwire.js
      manifest.sha256       SHA256 of each gate-dest module
    sync-core.sh          vendor both destinations into an agent repo
    verify-core.sh        build-time: fail if a vendored copy != the manifest in its stamp
    README.md             this file

## The rule (propagation is deliberate)

Change a shared module **only in core/ here**, then propagate:

    # 1. regenerate the manifests (they are derived from core/, never edited by hand):
    ( cd provision && npm run manifest )      # or: core/sync-core.sh regenerates them itself
    ( cd provision && npm test )              # fails while core/ and a manifest disagree
    git add core/<changed> core/manifest.sha256 core/gate/manifest.sha256 && git commit -m "core: <what>" && git push

    # 2. sync into each agent repo (from a fleet checkout):
    ./core/sync-core.sh ~/castor                    scripts gate
    ./core/sync-core.sh ~/keel scripts          gate

    #    (sync-core REFUSES to vendor from a stale manifest -- it regenerates it and asks for the commit first,
    #     so a stamp always names a commit whose manifest is true)

    # 3. in each agent repo: commit the vendored files + .fleet-core-version, rebuild --no-cache.
    #    Every file sync-core touched must be committed -- a stamp whose manifest names a module the
    #    commit left behind fails the next image build (this is how a fresh VM once sat at 502).

## Build-time verification (in each agent Dockerfile)

    COPY gate/ /app/gate/
    RUN  bash /app/gate/verify-core.sh /app/gate
    COPY scripts/ /app/scripts/
    RUN  bash /app/scripts/verify-core.sh /app/scripts

## Currently vendored by

| Profile | scripts dest     | gate dest     |
|---------|------------------|---------------|
| castor  | scripts | gate |
| keel    | scripts          | gate          |
