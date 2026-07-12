import Docker from 'dockerode';

/**
 * Provisions FLUJO instances as sibling containers via the Docker socket.
 * NOTE: developed on a machine without Docker — exercised for the first time
 * by docs/test-plan.md on a Docker host. The manager runs fine without
 * Docker; only managed-brain creation requires it.
 */

const FLUJO_IMAGE = process.env.FLUJO_IMAGE ?? 'ghcr.io/mario-andreschak/flujo:latest';
const NETWORK = process.env.DOCKER_NETWORK ?? 'brain-net';

let docker: Docker | null = null;

export async function dockerAvailable(): Promise<boolean> {
  try {
    docker ??= new Docker();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export interface ProvisionedContainer {
  containerId: string;
  /** URL of the instance as seen from the manager (same Docker network). */
  flujoUrl: string;
  /** Host loopback port that publishes the instance's own editor UI. */
  editorPort: number;
}

/**
 * `editorPorts` are candidate host ports, tried in order — FLUJO's Next.js
 * editor can't live behind a sub-path proxy, so every brain's editor gets its
 * own 127.0.0.1-bound port (same model as the default instance's :4200).
 */
export async function createFlujoContainer(brainId: string, editorPorts: number[]): Promise<ProvisionedContainer> {
  if (!(await dockerAvailable())) {
    throw new Error('Docker is not available — cannot provision a managed brain (adopt an external FLUJO instead).');
  }
  const name = `brain-flujo-${brainId}`;
  let lastErr: Error | null = null;
  for (const port of editorPorts) {
    const container = await docker!.createContainer({
      name,
      Image: FLUJO_IMAGE,
      Labels: { 'ai.brain.id': brainId },
      ExposedPorts: { '4200/tcp': {} },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        // Named volumes so a brain's memories survive container replacement.
        Binds: [`brain-${brainId}-db:/app/db`, `brain-${brainId}-mcp:/app/mcp-servers`],
        NetworkMode: NETWORK,
        // Loopback only — same security posture as every other published port.
        PortBindings: { '4200/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
      },
    });
    try {
      await container.start();
      return { containerId: container.id, flujoUrl: `http://${name}:4200`, editorPort: port };
    } catch (err) {
      lastErr = err as Error;
      // The name must be free before the next attempt.
      await container.remove({ force: true }).catch(() => undefined);
      // Only a taken port is retryable — anything else is a real failure.
      if (!/port|address|bind|allocated/i.test(lastErr.message)) throw lastErr;
    }
  }
  throw lastErr ?? new Error('No free editor port found for the FLUJO container.');
}

export async function removeFlujoContainer(containerId: string, brainId: string, purge: boolean): Promise<void> {
  if (!(await dockerAvailable())) throw new Error('Docker is not available.');
  const container = docker!.getContainer(containerId);
  try {
    await container.stop({ t: 10 });
  } catch {
    // Already stopped.
  }
  await container.remove();
  if (purge) {
    for (const v of [`brain-${brainId}-db`, `brain-${brainId}-mcp`]) {
      try {
        await docker!.getVolume(v).remove();
      } catch {
        // Volume busy or already gone — leave it; better than data loss on error.
      }
    }
  }
}
