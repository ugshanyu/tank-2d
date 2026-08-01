// A WebSocket relay that degrades the connection on purpose.
//
// Every other test in this repo runs over 127.0.0.1 at 0 ms RTT and 0% loss —
// exactly the conditions under which prediction, reconciliation, entity
// interpolation, the clock estimator and lag compensation are all mathematically
// no-ops. The four longest comment blocks in the codebase describe bugs found by
// hand on real networks, which is a precise map of where the test gap was.
//
// This sits between a client and the real server and applies one-way latency,
// jitter, loss and reordering in both directions, so those systems can be
// exercised under the conditions they exist for.

import { WebSocketServer, WebSocket } from 'ws';

export function startNetSim({ listenPort, targetPort, latencyMs = 0, jitterMs = 0, loss = 0 }) {
  const wss = new WebSocketServer({ port: listenPort, perMessageDeflate: false });

  // Delay is sampled per PACKET, so packets routinely arrive out of order — which
  // is the whole point: an ordered delay would hide reordering bugs.
  const delayOf = () => Math.max(0, latencyMs + (Math.random() * 2 - 1) * jitterMs);

  wss.on('connection', (client, req) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url}`);
    upstream.binaryType = 'arraybuffer';
    const pending = new Set();
    let open = false;
    const queued = [];

    const pipe = (to, data, isBinary) => {
      if (Math.random() < loss) return;                       // dropped in transit
      const t = setTimeout(() => {
        pending.delete(t);
        if (to.readyState === 1) to.send(data, { binary: isBinary });
      }, delayOf());
      pending.add(t);
    };

    upstream.on('open', () => {
      open = true;
      for (const [d, b] of queued) pipe(upstream, d, b);
      queued.length = 0;
    });
    client.on('message', (d, b) => (open ? pipe(upstream, d, b) : queued.push([d, b])));
    upstream.on('message', (d, b) => pipe(client, d, b));

    const shutdown = () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
      try { client.close(); } catch { /* already gone */ }
      try { upstream.close(); } catch { /* already gone */ }
    };
    client.on('close', shutdown);
    upstream.on('close', shutdown);
    client.on('error', shutdown);
    upstream.on('error', shutdown);
  });

  return {
    port: listenPort,
    close: () => new Promise((r) => wss.close(r)),
  };
}
