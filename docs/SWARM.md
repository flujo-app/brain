# Brain Observatory

`swarm.html` is the multipage FACTORY viewer built with the normal Vite build.
Brain Online embeds it under `/viewer/` from the upstream Brain image and supplies
authenticated observations. Its normal Brain viewer links to `/factory/swarm`
when hosted at `/viewer/`; standalone hosts link to `./swarm.html`.

The component accepts public v1 snapshots from an explicit operator source
registry. It does not discover factories, receive credentials, execute work,
or infer authority links between sources. All identities include the registry
source and factory. The read-only index preserves every recorded cell, task,
effect, evidence digest and local parent relationship while rendering a bounded
subset. Search, breadcrumbs and 128-child pages navigate the complete index.

## Hosting

Embedded hosts pass `?embed=1&channel=<16..128 character channel>` and exchange
same-origin `brain-swarm/1` messages with the exact parent/frame:

- viewer → parent: `ready` or `select` with the channel and a selection naming
  sourceId, factoryId, kind and id;
- parent → viewer: `observe` with channel, increasing integer sequence and model;
- parent → viewer: `ping`; viewer repeats `ready`.

The model has schemaVersion 1, scope `operator-source-registry`, commands false,
observedAt and at most 32 sources. Each source has id, label, factoryId,
observed/stale/unavailable status, a public canonical FACTORY snapshot or null,
and optional metadata events. Hash links also name the exact factory; changing
the authority behind a registry alias clears its former selection.
`model.ts` positively allowlists these facts; private extensions are dropped
and unsupported execution capability is rejected.
Never put a bearer credential in a URL, iframe message or client environment.

A standalone deployment must supply its own authenticated same-origin JSON bridge
at `/api/factory/swarm` (or the `source` parameter's same-origin absolute path).
The Brain manager does not automatically expose credentialed FACTORY reads.
Standalone polling uses same-origin credentials, no-store reads and a five-second
delay after each observation. An unavailable bridge shows an empty/unavailable
world; there is no real-data-to-fixture fallback.

`swarm.html?preview=1&cells=10000` explicitly generates a 10,000-cell design
fixture. Normal preview defaults to 54 cells across three independent sources.
The fixture label remains visible. Brain Online has its own explicit preview
host and uses the same upstream renderer.

## Scale and rendering

The full index uses iterative hierarchy layout, deterministic positions and
scoped keys. It handles deep chains and wide parents without recursion or a
force simulation. Visible nodes are capped at 600, labels at 24, and navigation
lists/search results are bounded. Ancestor/sibling context and child pages keep
hidden records reachable. A source overview has no cross-source authority edges.

The WebGL renderer batches node points and delegation/reference lines, disposes
replaced geometry, suspends hidden documents, renders idle views only on demand,
and caps evidenced activity at 30 frames/second. Reduced motion disables pulse
and animated camera flight. Context loss switches to the 2D renderer, which
uses the same index and scoped selection. Rendering diagnostics report CPU
submission time separately from draw-call and frame counts; they do not prove
GPU timing or physical worker health.

The Observatory design and first UI implementation were completed by Claude Opus
through a normal local FLUJO subscription-agent conversation at Medium effort
with Bash. The integration pass added camera fitting around visible instruments,
responsive reframing, measured label collision bounds, live reduced-motion
changes and a trailing diagnostics update when on-demand rendering settles.

Fresh observations do not establish worker activity. A cell needs an active
controller, ready lifecycle, recent heartbeat, an unexpired running lease and
no owned unknown outcome. Completed/cancelled operations do not animate as
running work. Unknown external outcomes keep their cell's uncertainty marker
after task completion or retirement, until an observed resolution replaces them.
Pause, effect drain and worker quiescence remain separate facts.
The selected inspector preserves task, candidate and review digests and states
that quiescence is unverified.

## Development and verification

Run `npm ci`, `npm run build` and `npm run test:swarm`. Tests use the actual model
and preview modules and cover duplicate record IDs across authorities, complete
10,000-deep/wide navigation, stable layout, stale/lease/terminal activity gates,
positive allowlists and missing-source behavior. Copy the built `dist` artifact
to the consumer's ignored viewer directory for local integration; keep source
in this repository. Qualify desktop/mobile composition and 3D/2D navigation in
the browser against the built artifact before publishing the Brain image.

The 2026-10-03 fixture qualification reached `cell-3333` in a 10,000-cell world
in both modes and preserved its source/factory identity after actual WebGL
context loss. The world had 10,003 indexed nodes; its overview drew 18 nodes and
the selected neighborhood drew 10, with two GPU draw calls in 3D and no GL calls
in 2D. Desktop, 615-pixel and 390-pixel layouts were checked. Reduced motion
stopped an already-running renderer; 2D settled without an animation loop.
These are fixture/navigation checks, not live FACTORY health evidence. The
read-only observer was still offline at the last 2026-10-03 qualification check;
its owner must restore and qualify it before a fresh live witness is recorded.
