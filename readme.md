# 🧠 brain

**A WebGL brain that renders [FLUJO](https://github.com/mario-andreschak/FLUJO) flows as neurons — and their relationships as synapses.**

Every FLUJO flow becomes a glowing **neuron**. The connections *between* flows become **synapses** with signals pulsing along them, so a whole FLUJO workspace reads at a glance as a living neural network.

Where this is heading — Docker bundle, live execution follow-cam, brains with life goals — lives in [ROADMAP.md](ROADMAP.md).

![brain](docs/preview.png)

## What you're looking at

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

## Sections (galaxies)

Flows are organised into spatially separated **brain sections** — galaxies — each with its own hue, faint nebula, and floating label. Pick how they group from the **`sections by`** dropdown:

- **provider** — one galaxy per model provider (Claude, OpenRouter, Ollama, …)
- **folder** — one galaxy per FLUJO dashboard folder
- **model** — one galaxy per model

A two-level force layout places the galaxy centres apart, then lays out each flow within its galaxy — subflow ties pull hardest, cross-galaxy ties barely pull, so the sections stay distinct while shared-resource synapses still stretch between them.

Within a galaxy each flow is a bright **core star** (sized by node count) surrounded by faint satellite stars — its own internal nodes (`start`/`process`/`mcp`/`subflow`/`finish`).

## Interacting

- **Drag** to orbit, **scroll** to zoom (the brain gently auto-rotates until you touch it).
- **Hover** a neuron to see its name and light up its immediate connections.
- **Click** a neuron to zoom into it: the camera flies in, the flow's internal nodes get labels (start / process / mcp / subflow / finish) and wiring, and the side panel shows its MCP servers and connections in collapsible groups.
- **`view`** dropdown switches between the WebGL **3D orbit** and a true **2D map** rendered with the Canvas 2D API (pan & zoom, sections laid out on a disc) — no GPU shaders, built for modest hardware. The choice is remembered; machines without WebGL or with few cores start in 2D automatically.
- **`sections by`** dropdown regroups the whole brain by provider / folder / model.
- **Search** to spotlight flows by name.
- **Deep link** with `?focus=<flow name>` to open the brain zoomed into a flow.
- Toggle any **synapse type** in the legend.
- Click empty space to reset.

## Live execution: watch it think

While a flow runs in FLUJO, its neuron **wakes up** — brighter, whiter, pulsing. Subflow calls flash along their axon, and with the **follow** toggle on, the camera flies to whatever behaviour is executing right now. Inside a focused behaviour, the currently executing node lights up, and a strip at the bottom names the running behaviour, its current node or tool call, and how many runs are active.

This rides on FLUJO's per-conversation SSE event stream (`node:enter`, `subflow:start`, `tool:call`, …) — no polling of execution state, no FLUJO changes.

## Brains: life goals & the brain-stem

Beyond visualizing one FLUJO workspace, the **lobby** (`/lobby.html`) grows whole *brains*: each brain is its own FLUJO instance with a **life goal** and a **brain-stem** — a root flow bound to the model you pick (local via Ollama, or bring-your-own-key, stored encrypted by FLUJO). The brain-stem thinks with seven tools served by brain itself over MCP (`list/learn/perform/forget` behaviours and skills — friendly verbs over FLUJO's own API, with guardrails so it can't delete or recurse into itself), and a **heartbeat** (FLUJO planned execution) wakes it on a schedule. Everything it does animates live in the viewer. See [ROADMAP.md](ROADMAP.md) for the architecture.

Run the manager locally: `cd manager && npm install && npm run dev` (port 8090; the vite dev server proxies `/api` and `/brains` to it).

## Run with Docker

```bash
docker compose up
```

brings up the brain (lobby + viewer + manager) at **http://localhost:8080**, a default FLUJO instance (editor at http://localhost:4200), and Ollama for local models. Creating a brain provisions a fresh FLUJO container on an internal network, reachable only through the manager. All ports are bound to localhost only — FLUJO has no auth, and the manager holds the Docker socket, so never expose this stack without your own authenticating reverse proxy.

## Data: live only

`brain` talks to a **running FLUJO instance** (`GET /api/flow`, `/api/model`, `/api/mcp/servers` + per-server status). It finds FLUJO by trying, in order: an explicit override (`?flujo=<url>` query param, `window.__FLUJO_URL__`, or `VITE_FLUJO_URL`), the same-origin `/flujo` proxy path (vite dev proxy locally, nginx in the Docker bundle), then `http://localhost:4200` directly. Everything is fetched at runtime and held in memory only — nothing is persisted, and a page reload starts from scratch. If FLUJO isn't running yet, the brain waits and boots itself the moment FLUJO becomes reachable.

**Live refresh:** the brain polls FLUJO every few seconds and rebuilds itself when anything changes — new or edited flows, newly installed MCP servers, or a server's connection state flipping.

**MCP server state:** every MCP server a flow binds is shown with a status dot — 🟢 connected, 🔴 disconnected, ⚪ disabled. Satellite stars of `mcp` nodes whose server is down or disabled break from their galaxy's hue so problems are visible from orbit.

## Develop

```bash
npm install
npm run dev      # vite dev server
npm run build    # typecheck and build to dist/
npm run preview  # serve the production build
```

Built with [Three.js](https://threejs.org/), TypeScript, and Vite. No backend — it's a static site (deployable to GitHub Pages; `vite.config.ts` defaults to a relative base).

## How it maps FLUJO → brain

FLUJO flows are graphs of typed nodes (`start`, `process`, `mcp`, `subflow`, `finish`) connected by edges. Node and synapse colours follow FLUJO's own editor palette (amber subflows, blue abilities, green finish…), so the focused view reads like the flow you built. `brain` distils each flow into a neuron, reading:

- **process** nodes → the models/providers the flow uses (`boundModel`)
- **mcp** nodes → the MCP servers it binds (`boundServer`)
- **subflow** nodes → the flows it calls (`subflowId`)

…then wires neuron-to-neuron synapses from the shared/called resources. See [`src/types.ts`](src/types.ts) for the full model.

## License

MIT
