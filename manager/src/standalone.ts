/**
 * Standalone (no-Docker) launcher: same manager, friendlier defaults —
 * UI + API on :8080 like the Docker bundle. All env vars still win.
 * The front door decides lobby vs. single-brain viewer at request time.
 */
process.env.PORT ??= '8080';
await import('./index.js');
