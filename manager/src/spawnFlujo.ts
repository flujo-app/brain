/**
 * Standalone fallback for the DEFAULT FLUJO instance: when nothing answers on
 * FLUJO_DEFAULT_URL and that URL points at this machine, start one from the
 * published npm package (`npx -y flujo-ai`) so `npm run standalone` yields a
 * working single-brain setup on a bare machine — no Docker, no manual FLUJO.
 *
 * Scope: only the default instance. Managed (per-brain) instances stay
 * Docker-provisioned; adopted instances are, by definition, already running.
 * Opt-out with FLUJO_AUTOSTART=0; only the standalone launcher opts in at all
 * (the Docker bundle brings its own FLUJO service).
 *
 * The child's data lands in manager/data/default-flujo (next to brains.json),
 * NOT in ~/.flujo — a user's own FLUJO install must never be mixed up with
 * the brain's. First start can take minutes: npx downloads the package.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'default-flujo');

/** How long to wait for the spawned instance to answer (cold npx downloads). */
const STARTUP_TIMEOUT_MS = 5 * 60_000;
const PROBE_INTERVAL_MS = 2_000;

let child: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;

const isLocalUrl = (url: string) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/flow`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

function killChildOnExit(): void {
  const kill = () => {
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
  };
  process.once('exit', kill);
  process.once('SIGINT', () => {
    kill();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    kill();
    process.exit(143);
  });
}

/**
 * Make sure a FLUJO answers on `url`, spawning one when possible. Resolves
 * true once reachable. Concurrent callers share one attempt; a failed or
 * exited child clears the latch so a later call can try again.
 */
export function ensureDefaultFlujo(url: string): Promise<boolean> {
  starting ??= start(url).then(
    (ok) => {
      if (!ok) starting = null;
      return ok;
    },
    () => {
      starting = null;
      return false;
    },
  );
  return starting;
}

async function start(url: string): Promise<boolean> {
  if (await reachable(url)) {
    console.log(`default FLUJO already running at ${url}`);
    return true;
  }
  if (process.env.FLUJO_AUTOSTART === '0') return false;
  if (!isLocalUrl(url)) {
    console.log(`default FLUJO at ${url} is unreachable and remote — not starting one (autostart only handles localhost).`);
    return false;
  }

  const port = new URL(url).port || '4200';
  console.log(`default FLUJO is not running — starting one via "npx -y flujo-ai" at http://localhost:${port} (first run downloads the package, this can take minutes)`);
  console.log(`  data dir: ${DATA_DIR}`);

  const args = ['-y', 'flujo-ai', '--no-open', '--port', port];
  const opts = {
    env: { ...process.env, FLUJO_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
  };
  // npx is npx.cmd on Windows and .cmd files only run through a shell; a
  // single command string avoids Node's DEP0190 warning about shell+args.
  // Every piece is a constant except `port`, which URL parsing keeps numeric.
  const proc: ChildProcess =
    process.platform === 'win32'
      ? spawn(['npx', ...args].join(' '), { ...opts, shell: true })
      : spawn('npx', args, opts);
  child = proc;
  killChildOnExit();

  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach((l) => console.log(`  [flujo] ${l}`));
  proc.stdout?.on('data', prefix);
  proc.stderr?.on('data', prefix);

  let exited = false;
  proc.on('exit', (code) => {
    exited = true;
    child = null;
    starting = null; // allow a later retry
    console.error(`spawned FLUJO exited (code ${code ?? 'signal'})`);
  });
  proc.on('error', (err) => {
    exited = true;
    child = null;
    starting = null;
    console.error(`could not start FLUJO via npx: ${err.message}`);
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    if (await reachable(url)) {
      console.log(`default FLUJO is up at ${url}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  if (!exited) console.error(`spawned FLUJO did not answer on ${url} within ${STARTUP_TIMEOUT_MS / 60000} minutes — leaving it running, the front door will pick it up if it finishes.`);
  return false;
}
