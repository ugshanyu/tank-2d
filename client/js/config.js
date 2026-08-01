// Client configuration.
//
// Inside the Usion host (the normal case) the game server URL and the access
// token BOTH come from the backend via the SDK (Usion.game direct-mode access),
// so nothing here is used. The values below are the STANDALONE/DEV fallback for
// opening the client directly in a browser (localhost, or the Vercel URL for a
// quick smoke test) — they only connect if the server is running with
// DEV_ALLOW_UNSIGNED=1 (never in production).

export const SERVICE_ID = 'tank';

// Railway game server, used only for standalone/dev connects. Updated at deploy.
export const DEV_SERVER_URL = 'wss://tank2d-production.up.railway.app/ws';

export function devServerUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'ws://localhost:8080/ws';
  }
  return DEV_SERVER_URL;
}

export function devRoomId() {
  return (new URLSearchParams(location.search).get('room') || 'arena')
    .replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'arena';
}
