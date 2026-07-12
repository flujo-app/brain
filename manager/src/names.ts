/**
 * Friendly auto-names for brains — the user only describes a life goal;
 * the name is just a handle for the lobby orbit and container labels.
 */

const ADJECTIVES = [
  'curious', 'quiet', 'bright', 'gentle', 'restless', 'luminous',
  'wandering', 'patient', 'vivid', 'tender', 'bold', 'dreaming',
  'silent', 'eager', 'mellow', 'wild', 'drifting', 'humming',
  'waking', 'starlit', 'amber', 'velvet', 'misty', 'radiant',
];

const NOUNS = [
  'nebula', 'synapse', 'ember', 'comet', 'tide', 'aurora',
  'spark', 'lumen', 'orbit', 'dawn', 'echo', 'drift',
  'quasar', 'pulse', 'glow', 'nova', 'axon', 'halo',
  'meridian', 'zephyr', 'cinder', 'prism', 'murmur', 'atlas',
];

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** A unique adjective-noun name not present in `taken` (576 combinations). */
export function generateBrainName(taken: ReadonlySet<string>): string {
  for (let i = 0; i < 50; i++) {
    const name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  // Crowded registry — fall back to a numbered handle.
  let n = 2;
  while (taken.has(`brain-${n}`)) n++;
  return `brain-${n}`;
}
