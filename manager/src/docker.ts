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
}

export async function createFlujoContainer(brainId: string): Promise<ProvisionedContainer> {
  if (!(await dockerAvailable())) {
    throw new Error('Docker is not available — cannot provision a managed brain (adopt an external FLUJO instead).');
  }
  const name = `brain-flujo-${brainId}`;
  const container = await docker!.createContainer({
    name,
    Image: FLUJO_IMAGE,
    Labels: { 'ai.brain.id': brainId },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      // Named volumes so a brain's memories survive container replacement.
      Binds: [`brain-${brainId}-db:/app/db`, `brain-${brainId}-mcp:/app/mcp-servers`],
      NetworkMode: NETWORK,
    },
  });
  await container.start();
  return { containerId: container.id, flujoUrl: `http://${name}:4200` };
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
