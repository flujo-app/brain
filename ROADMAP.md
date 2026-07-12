# Roadmap: from visualization to a living mind

Where `brain` is going: today it *renders* a FLUJO workspace; the goal is a
self-contained product where a user **creates a brain, gives it a life goal,
and watches it evolve** — learning behaviours, acquiring skills, and lighting
up as it thinks.

The good news, verified against the FLUJO codebase (v3.13): **everything below
is buildable against FLUJO's existing API surface.** No FLUJO changes are
required for phases 1–2, and only optional ones later.

## What FLUJO already gives us

| Need | FLUJO surface |
| --- | --- |
| Docker | `Dockerfile` + `docker-compose.yml`, published image `ghcr.io/mario-andreschak/flujo:latest`, data in named volumes (`flujo-db`, `flujo-mcp-servers`), healthcheck on `GET /api/cwd`, port 4200 |
| Behaviour CRUD | `GET/POST /api/flow`, `GET/PUT/DELETE /api/flow/{id}`, plus `POST /api/flow/generate` (LLM-generates a flow!) |
| Skill CRUD | `GET/POST /api/mcp/servers`, `PUT/DELETE /api/mcp/servers/{name}` (PUT drives live connect/disconnect), `GET /api/mcp-registry` + `/spotlight` for discovering installable servers; the Docker image bundles git/python/uv so servers install at runtime |
| Run a behaviour | `POST /v1/chat/completions` with `model: "flow-<name>"` (OpenAI-compatible, supports `stream`, `conversation_id`, `requireApproval`) — or webhooks / planned executions |
| **Watch it think** | `GET /v1/chat/conversations/{id}/events` — **SSE stream** with `run:start` (flowId), `node:enter` / `node:exit` (nodeId, name, type), `subflow:start/done` (with depth), `tool:call/progress/result`, `model:start/delta/end`, `handoff`, `run:done`. Resumable via `Last-Event-ID`. |
| Execution snapshot | `GET /v1/chat/conversations/{id}` → `status` (`running`/`awaiting_tool_approval`/…) and `currentNodeId` |
| Auth | **None.** FLUJO binds to 127.0.0.1 by default and its git API is RCE-equivalent — every phase below must keep FLUJO off the public network and front it with our own layer. |

## Phase 0 — visual foundation ✅ (this iteration)

Curved, depth-faded synapses; fog; focus mode that clears the stage;
label collision handling; layered nebulae; FLUJO-consistent node colours;
**2D map view** alongside the 3D orbit.

Backlog, nice-to-have: edge bundling for hub-heavy webs, label
level-of-detail in overview, a `?view=2d` deep link, optional orthographic
camera for the 2D mode.

## Phase 1 — ship as Docker ✅

Done: `docker-compose.yml` at the repo root (flujo from
`ghcr.io/mario-andreschak/flujo:latest` + brain built from the local
`Dockerfile`), nginx serving the static build and reverse-proxying
`/flujo/*` → `flujo:4200` with SSE-safe settings (`deploy/nginx.conf`).
Both ports bind to 127.0.0.1 only. FLUJO keeps its own port because its
Next.js editor can't live behind a sub-path proxy.

The loader resolves its base URL at boot — explicit override
(`?flujo=<url>`, `window.__FLUJO_URL__`, `VITE_FLUJO_URL`) → same-origin
`/flujo` (vite dev proxy locally, nginx in Docker) → direct
`localhost:4200`. Same-origin matters: FLUJO's `/v1` conversation + SSE
endpoints send **no CORS headers** (verified), so the execution watcher only
works through the proxy path.

`docker compose up` → brain at `http://localhost:8080`, FLUJO editor at
`http://localhost:4200`. (Image build still to be smoke-tested on a machine
with Docker running — see [docs/test-plan.md](docs/test-plan.md).)

## Phase 2 — execution awareness (the camera follows the thought) ✅

Done, no backend needed. `src/data/execution.ts` polls
`GET /v1/chat/conversations` for `status: running`, subscribes to each run's
SSE stream (`?fromSeq` resume so reconnects don't replay visuals), and keeps
a per-conversation **depth stack** so a subflow child's events — which FLUJO
forwards on the parent's channel with `depth+1` — light the right neuron.

Event → visual mapping (in `Brain.handleExecution`):
- `run:start` / `node:enter` / `tool:call` → the behaviour's star wakes:
  whiter, brighter, swollen, pulsing (an `aBoost` channel in the star shader).
- `subflow:start` → the subflow axon flashes and, with the **follow** toggle
  on, the camera flies to the called behaviour.
- `node:enter` in a focused behaviour → that node's ring lights white.
- `run:done` → afterglow decays over ~2s.
- A "now thinking" strip (bottom centre) names the running behaviour, its
  current node / tool, and the number of concurrent runs.

Dev hook: `__brainSim({kind:'run-start', …})` in the console simulates
events without spending model tokens.

Still open from the original sketch: token usage in the strip (`usage`
events) and elapsed time.

## Phase 3 — brains as instances ✅ (Docker path untested until deploy)

Done: the **brain-manager** (`manager/`, Node + Express + dockerode) is now
the single server — it serves the UI, the lobby API (`/api/brains` CRUD with
JSON-file registry), reverse-proxies each brain under `/brains/{id}/flujo/*`
(SSE-safe), and hosts the brain-stem MCP endpoints. `docker compose up` runs
manager + default FLUJO + Ollama on the fixed `brain-net` network; created
brains become sibling FLUJO containers (named volumes, no published ports,
reachable only through the manager proxy).

The **lobby** (`lobby.html`) lists brains (status, life goal, model), grows
new ones (Ollama pull / BYO-key / existing model / adopt-instance modes,
heartbeat cron, optional first wake), opens them (`?flujo=/brains/{id}/flujo`
— the viewer's URL override does the rest), and forgets them (container
removed, volumes kept unless purged).

Verified on the dev machine end-to-end in **adopt mode** against a live
FLUJO (create → provision → open → viewer live through the per-brain proxy →
delete → workspace clean). The dockerode container path is written but needs
its first run on a Docker host — see docs/test-plan.md.

## Phase 4 — the mind loop: the brain-stem ✅ (first live run pending)

Implemented in `manager/src/brainstem.ts` + `provision.ts` and verified
end-to-end against a live FLUJO: the manager registers itself as a remote
streamable MCP server (URL-token auth — 401 without it), FLUJO connects and
lists all seven tools, tool calls round-trip through FLUJO, and the
guardrails hold (perform/forget of the brain-stem itself is refused). The
brain-stem flow is created from the template below and renders in the viewer
with its tool belt shown connected. Heartbeat = FLUJO planned execution
(cron), created at birth. Still pending: the first *real* wake driven by a
model (validate tool-calling quality per model — the learning journey).

**Decided design: the meta-agent is a FLUJO flow, not a separate agent
loop.** Each brain gets a **brain-stem** — a root flow whose start prompt is
the life goal and whose single process node is bound to the model the user
picked at creation (pulled into Ollama and registered in that brain's FLUJO
instance). Its tools come from an MCP server that **brain itself hosts**
(TypeScript MCP SDK, Streamable HTTP) and registers into FLUJO as a remote
server (`transport: 'streamable'`, `serverUrl` → brain-manager, auth via
`headers`). The tools are just friendly verbs over FLUJO's own REST API:

| Tool | FLUJO call |
| --- | --- |
| `list_behaviours` | `GET /api/flow` (names + descriptions) |
| `learn_behaviour` | `POST /api/flow/generate` — takes `{description, modelId}`, so it builds with the brain's own model |
| `perform_behaviour` | `POST /v1/chat/completions`, `model: "flow-<name>"` — **ephemeral** calls, no permanent subflow wiring |
| `forget_behaviour` | `DELETE /api/flow/{id}` |
| `list_skills` | `GET /api/mcp/servers` + `GET /api/mcp-registry` (owned + installable) |
| `learn_skill` | `POST /api/mcp/servers` (install from registry, connect) |
| `forget_skill` | `DELETE /api/mcp/servers/{name}` |

Why this shape wins:
- **The mind is visible for free.** The brain-stem runs inside FLUJO's
  engine, so Phase 2's SSE watcher already animates its thinking — it's a
  neuron like any other (render it as the literal stem/core of the brain).
- **No second agent runtime.** FLUJO already does the tool loop,
  multi-provider models, conversation persistence, approval gates
  (`requireApproval` → the brain can *ask permission* in the HUD), cancel,
  usage accounting.
- **One choke point for safety.** Every self-modification passes through
  brain's MCP server, which enforces policy FLUJO doesn't have.

Guardrails the MCP server must implement:
- the brain-stem cannot `forget_` or overwrite **itself**;
- recursion cap: `perform_behaviour` refuses to (transitively) invoke the
  brain-stem, and carries a depth/turn budget;
- spend cap per wake cycle (watch `usage` events, `POST .../cancel` on breach);
- destructive verbs (`forget_*`) optionally require HUD approval.

Lifecycle when the user creates a brain (all REST, orchestrated by the
brain-manager): provision FLUJO instance (Phase 3) → `ollama pull` the chosen
model → `POST /api/model` → register the brain-stem MCP server → create the
brain-stem flow (life goal as start prompt, model bound, tools enabled) →
kick the first run. Autonomy afterwards: a **planned execution** (FLUJO's
scheduler) wakes the brain-stem on a heartbeat.

Open items to validate early: tool-calling reliability of small local models
(default to a tool-capable Ollama model, ~8B+; allow non-Ollama providers as
an escape hatch), and `/api/flow/generate` output quality when driven by the
brain's own small model.

## Phase 5 — evolution & polish

- **Birth/death animations** — the poller already diffs by hash; make the
  diff granular (added/removed neurons, synapses) and animate transitions
  instead of rebuilding the scene.
- **Memory of growth** — a timeline scrubber ("this brain at day 3"),
  backed by periodic `GET /api/backup` snapshots.
- **Approval gate in the HUD** — `run:awaiting_approval` +
  `POST .../respond` means the brain can literally *ask permission* before
  using a tool, from inside the visualization.
- **Multi-brain constellation** — the lobby as a meta-view: each brain a
  distant galaxy, sized by behaviour count, glowing when active.

## Sequencing

Phases 1 and 2 are independent of each other and both land on the current
static-site architecture — do them first (2 before 3/4 so every later
feature is *visible*). Phase 3 introduces the first real backend; Phase 4
builds on 3. Phase 5 is continuous polish once 2 exists.
