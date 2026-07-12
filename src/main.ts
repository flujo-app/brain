import './style.css';
import { loadBrain, watchBrain } from './data/loader';
import { Brain } from './scene/brain';

async function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  try {
    let { graph, hash } = await loadBrain();
    if (!graph.neurons.length) {
      showMessage('No flows found. Build a flow in FLUJO, then reload.');
      return;
    }
    const brain = new Brain(canvas, graph);

    // Keep the brain in sync with a running FLUJO: new/edited flows, new MCP
    // servers, and connection-state changes appear without a reload — and a
    // snapshot upgrades itself to live the moment FLUJO becomes reachable.
    watchBrain(
      () => hash,
      (data) => {
        hash = data.hash;
        brain.setGraph(data.graph);
      },
    );
  } catch (err) {
    console.error(err);
    showMessage('Could not load flow data. See the console for details.');
  }
}

function showMessage(text: string) {
  const badge = document.getElementById('source-badge');
  if (badge) badge.textContent = text;
}

boot();
