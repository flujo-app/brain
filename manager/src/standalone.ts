/**
 * Standalone (no-Docker) launcher: same manager, friendlier defaults —
 * UI + API on :8080 like the Docker bundle. All env vars still win.
 * The front door decides lobby vs. single-brain viewer at request time.
 */
process.env.PORT ??= '8080';
// Ollama's standard local install (ollama.com) listens here — lets the
// wizard's "on my computer" path work in standalone without configuration.
process.env.OLLAMA_URL ??= 'http://localhost:11434';
// No FLUJO on the default URL? Start one from the npm package (spawnFlujo.ts)
// so a bare machine gets a working single-brain setup. The Docker bundle
// never sets this — its compose file ships a FLUJO service.
process.env.FLUJO_AUTOSTART ??= '1';
await import('./index.js');
