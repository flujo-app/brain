# Technical documentation

Everything the [README](../readme.md) shows off, explained precisely. For where the project is going, see [ROADMAP.md](../ROADMAP.md).

- [Visual language](#visual-language)
- [Sections (galaxies) and layout](#sections-galaxies-and-layout)
- [Interaction reference](#interaction-reference)
- [Data pipeline: live only](#data-pipeline-live-only)
- [How brain maps FLUJO → neurons](#how-brain-maps-flujo--neurons)
- [Execution watcher](#execution-watcher)
- [Brains, the lobby, and the manager](#brains-the-lobby-and-the-manager)
- [The brain-stem: MCP tools and guardrails](#the-brain-stem-mcp-tools-and-guardrails)
- [Docker architecture](#docker-architecture)
- [Security model](#security-model)
- [Development](#development)

## Visual language

Each neuron is one flow. Its **size** scales with how many nodes the flow has, and its **colour** is the model provider it leans on:

| colour | provider |
| --- | --- |
| 🟠 amber | Claude (subscription / Anthropic) |
| 🟢 green | OpenRouter |
| 🔵 cyan | Ollama (local) |
| 🟣 violet | Gemini / Google |
| 🩶 grey | dormant flow (nodes but no wiring) |

Neurons are wired by three kinds of **synapse**, each derived from the real flow definitions:

| synapse | meaning |
| --- | --- |
| 🟡 **subflow call** | one flow runs another as a Subflow node — a directed axon, always pulsing source → target |
| 🟦 **shared MCP server** | two flows bind the same MCP server (shared tooling) |
| 🟪 **shared model** | two flows use the same model |

Within a galaxy each flow is a bright **core star** (sized by node count) surrounded by faint satellite stars — its own internal nodes (`start`/`process`/`mcp`/`subflow`/`finish`). Node and synapse colours follow FLUJO's own editor palette (amber subflows, blue abilities, green finish…), so the focused view reads like the flow you built.

**MCP server state:** every MCP server a flow binds is shown with a status dot — 🟢 connected, 🔴 disconnected, ⚪ disabled. Satellite stars of `mcp` nodes whose server is down or disabled break from their galaxy's hue so problems are visible from orbit.

## Sections (galaxies) and layout

Flows are organised into spatially separated **brain sections** — galaxies — each with its own hue, faint nebula, and floating label. The **`sections by`** dropdown regroups them:

- **provider** — one galaxy per model provider (Claude, OpenRouter, Ollama, …)
- **folder** — one galaxy per FLUJO dashboard folder
- **model** — one galaxy per model

A two-level force layout places the galaxy centres apart, then lays out each flow within its galaxy — subflow ties pull hardest, cross-galaxy ties barely pull, so the sections stay distinct while shared-resource synapses still stretch between them.

## Interaction reference

- **Drag** to orbit, **scroll** to zoom (the brain gently auto-rotates until you touch it).
- **Hover** a neuron to see its name and light up its immediate connections.
- **Click** a neuron to zoom into it: the camera flies in, the flow's internal nodes get labels (start / process / mcp / subflow / finish) and wiring, and the side panel shows its MCP servers and connections in collapsible groups.
- **`view`** dropdown switches between the WebGL **3D orbit** and a true **2D map** rendered with the Canvas 2D API (pan & zoom, sections laid out on a disc) — no GPU shaders, built for modest hardware. The choice is remembered; machines without WebGL or with few cores start in 2D automatically.
- **Search** to spotlight flows by name.
- **Deep link** with `?focus=<flow name>` to open the brain zoomed into a flow.
- Toggle any **synapse type** in the legend.
- Click empty space to reset.

## Data pipeline: live only

brain talks to a **running FLUJO instance** (`GET /api/flow`, `/api/model`, `/api/mcp/servers` + per-server status). It finds FLUJO by trying, in order:

1. an explicit override — `?flujo=<url>` query param, `window.__FLUJO_URL__`, or `VITE_FLUJO_URL`
2. the same-origin `/flujo` proxy path (vite dev proxy locally, nginx in the Docker bundle)
3. `http://localhost:4200` directly

Everything is fetched at runtime and held in memory only — nothing is persisted, and a page reload starts from scratch. If FLUJO isn't running yet, the brain waits and boots itself the moment FLUJO becomes reachable.

Same-origin matters: FLUJO's `/v1` conversation + SSE endpoints send **no CORS headers**, so the execution watcher only works through the proxy path or same origin.

**Live refresh:** the brain polls FLUJO every few seconds and rebuilds itself when anything changes — new or edited flows, newly installed MCP servers, or a server's connection state flipping. The poller diffs by hash.

## How brain maps FLUJO → neurons

FLUJO flows are graphs of typed nodes (`start`, `process`, `mcp`, `subflow`, `finish`) connected by edges. brain distils each flow into a neuron, reading:

- **process** nodes → the models/providers the flow uses (`boundModel`)
- **mcp** nodes → the MCP servers it binds (`boundServer`)
- **subflow** nodes → the flows it calls (`subflowId`)

…then wires neuron-to-neuron synapses from the shared/called resources. See [`src/types.ts`](../src/types.ts) for the full model.

## Execution watcher

Implemented in `src/data/execution.ts`, no backend needed. It polls `GET /v1/chat/conversations` for `status: running`, subscribes to each run's SSE stream (`GET /v1/chat/conversations/{id}/events`, with `?fromSeq` resume so reconnects don't replay visuals), and keeps a per-conversation **depth stack** so a subflow child's events — which FLUJO forwards on the parent's channel with `depth+1` — light the right neuron.

Event → visual mapping (in `Brain.handleExecution`):

| event | visual |
| --- | --- |
| `run:start` / `node:enter` / `tool:call` | the behaviour's star wakes: whiter, brighter, swollen, pulsing (an `aBoost` channel in the star shader) |
| `subflow:start` | the subflow axon flashes; with **follow** on, the camera flies to the called behaviour |
| `node:enter` in a focused behaviour | that node's ring lights white |
| `run:done` | afterglow decays over ~2s |

A "now thinking" strip (bottom centre) names the running behaviour, its current node / tool, and the number of concurrent runs.

Dev hook: `__brainSim({kind:'run-start', …})` in the console simulates events without spending model tokens.

## Brains, the lobby, and the manager

The **brain-manager** (`manager/`, Node + Express + dockerode) is the single server:

- serves the built UI (lobby + viewer)
- hosts the lobby API — `/api/brains` CRUD backed by a JSON-file registry
- reverse-proxies each brain under `/brains/{id}/flujo/*` with SSE-safe settings
- hosts the brain-stem MCP endpoints

The **lobby** (`lobby.html`) lists brains (status, life goal, model), grows new ones, opens them (`?flujo=/brains/{id}/flujo` — the viewer's URL override does the rest), and forgets them (container removed, volumes kept unless purged).

The wizard supports four creation modes:

| mode | what happens |
| --- | --- |
| **On my computer** | model pulled into the bundled Ollama, fresh FLUJO container provisioned |
| **In my network** | points at an Ollama you run on another machine you own |
| **Online (BYO key)** | Anthropic / OpenAI / OpenRouter / Requesty / Gemini — curated model list, key stored encrypted by FLUJO |
| **Adopt instance** | wraps an already-running FLUJO as a brain (no container provisioned) |

Birth lifecycle (all REST, orchestrated by the manager): provision FLUJO instance → pull/register the model (`POST /api/model`) → register the brain-stem MCP server → create the brain-stem flow (life goal as start prompt, model bound, tools enabled) → create the heartbeat (FLUJO planned execution, cron) → optional first wake.

Run the manager locally: `cd manager && npm install && npm run dev` (port 8090; the vite dev server proxies `/api` and `/brains` to it).

## The brain-stem: MCP tools and guardrails

The meta-agent is **a FLUJO flow, not a separate agent loop**. Each brain gets a **brain-stem** — a root flow whose start prompt is the life goal and whose single process node is bound to the chosen model. Its tools come from an MCP server that **brain itself hosts** (TypeScript MCP SDK, Streamable HTTP), registered into FLUJO as a remote server (`transport: 'streamable'`, URL-token auth — 401 without the token). The tools are friendly verbs over FLUJO's own REST API:

| Tool | FLUJO call |
| --- | --- |
| `list_behaviours` | `GET /api/flow` (names + descriptions) |
| `learn_behaviour` | `POST /api/flow/generate` — takes `{description, modelId}`, so it builds with the brain's own model |
| `perform_behaviour` | `POST /v1/chat/completions`, `model: "flow-<name>"` — ephemeral calls, no permanent subflow wiring |
| `forget_behaviour` | `DELETE /api/flow/{id}` |
| `list_skills` | `GET /api/mcp/servers` + `GET /api/mcp-registry` (owned + installable) |
| `learn_skill` | `POST /api/mcp/servers` (install from registry, connect) |
| `forget_skill` | `DELETE /api/mcp/servers/{name}` |

Why this shape:

- **The mind is visible for free.** The brain-stem runs inside FLUJO's engine, so the execution watcher already animates its thinking — it's a neuron like any other.
- **No second agent runtime.** FLUJO already does the tool loop, multi-provider models, conversation persistence, approval gates (`requireApproval`), cancel, and usage accounting.
- **One choke point for safety.** Every self-modification passes through brain's MCP server, which enforces policy FLUJO doesn't have.

Guardrails enforced by the MCP server:

- the brain-stem cannot `forget_` or overwrite **itself**
- recursion cap: `perform_behaviour` refuses to (transitively) invoke the brain-stem, and carries a depth/turn budget
- spend cap per wake cycle (watch `usage` events, `POST .../cancel` on breach)
- destructive verbs (`forget_*`) can require HUD approval

Autonomy comes from a **heartbeat**: a FLUJO planned execution (cron) created at birth wakes the brain-stem on schedule.

## Docker architecture

`docker compose up` at the repo root brings up three services on the fixed `brain-net` network:

| service | image | ports | role |
| --- | --- | --- | --- |
| **brain** | built from local `Dockerfile` (nginx + manager) | `127.0.0.1:8080` | lobby + viewer + manager; holds the Docker socket to provision brains |
| **flujo** | `ghcr.io/mario-andreschak/flujo:latest` | `127.0.0.1:4200` | default FLUJO instance (editor keeps its own port — Next.js can't live behind a sub-path proxy) |
| **ollama** | `ollama/ollama` | none | local models (GPU passthrough commented in the compose file) |

nginx serves the static build and reverse-proxies `/flujo/*` → `flujo:4200` with SSE-safe settings (`deploy/nginx.conf`).

**Per-brain isolation:** created brains become sibling FLUJO containers spawned via dockerode on `brain-net`. Each gets its own named volumes (`flujo-db`, `flujo-mcp-servers` equivalents per instance) and **no published ports** — reachable only through the manager's `/brains/{id}/flujo` proxy. Deleting a brain removes its container; volumes are kept unless purged.

Persistent volumes: `flujo-db`, `flujo-mcp-servers` (default instance), `brain-data` (manager registry), `ollama` (model cache), plus per-brain volumes.

To use a Claude subscription inside the default FLUJO container, set `CLAUDE_CODE_OAUTH_TOKEN` (generate with `claude setup-token`) — see the commented block in `docker-compose.yml`.

## Security model

- **FLUJO has no authentication layer**, and its git API executes frontend-supplied commands (RCE-equivalent). It must never face a network.
- All published ports bind to **`127.0.0.1` only**.
- Spawned brain instances publish **no ports at all**; the manager proxy is the only path in.
- The brain container mounts the **Docker socket**, which makes it root-equivalent on the host.
- The brain-stem MCP endpoint requires a URL token (401 without it).

Do not expose this stack beyond localhost without your own authenticating reverse proxy in front of everything.

## Development

```bash
npm install
npm run dev      # vite dev server
npm run build    # typecheck and build to dist/
npm run preview  # serve the production build
```

Built with [Three.js](https://threejs.org/), TypeScript, and Vite. The viewer itself is a static site (deployable to GitHub Pages; `vite.config.ts` defaults to a relative base) — the manager is only needed for the lobby/brains features.

The test plan for the Docker path is in [test-plan.md](test-plan.md).
