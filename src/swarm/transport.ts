/** Bound streamed bytes before JSON decoding, including multibyte UTF-8. */
export async function readSwarmJson(response: Response, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new Error('Swarm observation has no body');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Swarm observation exceeds its bound');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    return JSON.parse(chunks.join('') + decoder.decode());
  } finally { await reader.cancel().catch(() => undefined); }
}
