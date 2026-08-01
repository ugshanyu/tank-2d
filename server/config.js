// Server environment surface. ALL process.env access lives here so the rest of
// the server is env-free. Ported from the tilt-royale direct-mode reference.

const env = process.env;
const bool = (v) => v === '1' || v === 'true' || v === 'yes';

export const PORT = Number(env.PORT || 8080);
export const NODE_ENV = env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';

// Usion platform integration (direct mode). The game server never talks to the
// backend except to fetch the JWKS public keys used to verify access tokens.
// Must equal the `id` of this game's row in the Usion registry AND the client's
// SERVICE_ID. The token's audience is derived from it (`usion-game-service:<id>`)
// and its service_id claim is checked against it, so a mismatch rejects every
// real token — which reaches the player only as an endless "reconnecting".
export const SERVICE_ID = env.SERVICE_ID || 'tank2d';
export const API_URL = (env.API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
export const JWKS_URL = env.JWKS_URL || `${API_URL}/.well-known/jwks.json`;

// Dev-only auth bypass: accept `dev:<user_id>:<room_id>` tokens so a laptop can
// play without the platform minting a real RS256 token. NEVER in production.
export const DEV_ALLOW_UNSIGNED = bool(env.DEV_ALLOW_UNSIGNED || '');

// Fill empty slots with bots so a solo launch is still a real 2v2. Set BOTS=0
// to run a bot-free server (the deterministic half of the smoke test does).
export const BOTS_ENABLED = (env.BOTS ?? '1') !== '0';

// Optional browser-origin allowlist (comma-separated). Unset = allow all.
export const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// A production box with the unsigned bypass on would let anyone connect as
// anyone. Fail loud, fail early rather than log-and-continue.
if (DEV_ALLOW_UNSIGNED && IS_PROD) {
  console.error(
    '[CONFIG] FATAL: DEV_ALLOW_UNSIGNED is set while NODE_ENV=production. ' +
    'This disables authentication for real users. Unset it (or run with ' +
    'NODE_ENV=development for local work). Exiting.'
  );
  process.exit(1);
}
