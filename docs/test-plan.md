# Test plan — Docker bundle (run on a machine with Docker)

Development happens on a machine without Docker, so the container path ships
untested. This is the checklist for the first machine that has Docker running.

**Prerequisites**

- [ ] Docker Engine / Desktop running, compose v2 (`docker compose version`)
- [ ] Ports 8080 and 4200 free

## Bundle

- [ ] `docker compose build` succeeds (multi-stage: npm ci → vite build)
- [ ] `docker compose up -d` → containers healthy (`docker compose ps`;
      flujo healthcheck hits `/api/cwd`)
- [ ] http://localhost:8080 loads the brain; badge shows **● live from FLUJO**
      (requires at least one flow in the FLUJO instance — create one at :4200)
- [ ] The brain resolved FLUJO via the proxy: DevTools → Network shows
      requests to `/flujo/api/...` (NOT `localhost:4200`)
- [ ] http://localhost:4200 opens FLUJO's own editor
- [ ] **Localhost-only binding**: from another device on the LAN,
      `http://<machine-ip>:8080` and `:4200` are refused
- [ ] **Persistence**: create a flow in FLUJO → `docker compose down` →
      `up -d` → flow still exists (named volumes)
- [ ] **SSE through nginx**: run any flow in FLUJO's chat while watching the
      brain at :8080 — the neuron wakes within ~4 s and the activity strip
      updates per node, not in one burst at the end (checks `proxy_buffering off`)

## Brain-manager (once Phase 3 lands in the compose file)

- [ ] Lobby lists the default brain; creating a brain provisions a fresh
      FLUJO container + volumes (visible in `docker ps` / `docker volume ls`)
- [ ] The new brain's FLUJO is reachable only through the manager proxy
      (`/brains/<id>/flujo/...`), not via a published port
- [ ] Ollama model pull streams progress during creation; the brain-stem flow
      exists in the new instance and its first run animates in the viewer
- [ ] Deleting a brain stops the container; volumes removed only with the
      explicit "forget everything" option

Everything else (visuals, live execution, dev mode) is developed and
verified on the dev machine against a local FLUJO — no need to re-test here.
