// Server URL resolution:
//   1. ?server=wss://... query override (handy for testing any environment)
//   2. localhost dev -> local server
//   3. production Railway URL (set after `railway domain`)
export const PROD_SERVER_URL = 'wss://tank-production-5873.up.railway.app';

export function serverUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'ws://localhost:8080';
  }
  return PROD_SERVER_URL;
}

export function roomId() {
  return (new URLSearchParams(location.search).get('room') || 'arena')
    .replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'arena';
}
