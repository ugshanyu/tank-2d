// Access-token validation for direct-mode connections.
//
// Real tokens are RS256 JWTs minted by the Usion backend
// (POST /games/rooms/{room_id}/access) and verified against the platform JWKS.
// Ported from the tilt-royale / space-craft-direct reference servers, including
// the key-rotation retry: a backend restart can rotate key material under the
// same kid, so a signature failure force-refreshes the JWKS once before failing.
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { DEV_ALLOW_UNSIGNED, IS_PROD } from './config.js';

const jwksCacheByUrl = new Map();
const JWKS_TIMEOUT_MS = Number(process.env.JWKS_TIMEOUT_MS || 15_000);
const JWKS_CACHE_MAX_AGE_MS = Number(process.env.JWKS_CACHE_MAX_AGE_MS || 300_000);
const JWKS_COOLDOWN_MS = Number(process.env.JWKS_COOLDOWN_MS || 1_000);

const DEV_TOKEN_RE = /^dev:([\w-]+):([\w-]+)$/;

function getJWKS(jwksUrl, forceRefresh = false) {
  if (forceRefresh) jwksCacheByUrl.delete(jwksUrl);
  let cached = jwksCacheByUrl.get(jwksUrl);
  if (!cached) {
    cached = createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
    });
    jwksCacheByUrl.set(jwksUrl, cached);
  }
  return cached;
}

function isJwksRetryableError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  return (
    name === 'JWSSignatureVerificationFailed' ||
    name === 'JWKSNoMatchingKey' ||
    msg.includes('signature verification failed') ||
    msg.includes('no applicable key') ||
    msg.includes('no matching key')
  );
}

/**
 * Validate a connection token and return the identity claims.
 *
 * @param {string} token  raw `?token=` query value
 * @param {{ jwksUrl: string, serviceId: string }} opts
 * @returns {Promise<{ sub: string, room_id: string, session_id: string, name: string }>}
 * @throws on any validation failure (caller closes the socket)
 */
export async function validateAccessToken(token, { jwksUrl, serviceId }) {
  if (!token) throw new Error('No token provided');

  // Dev bypass — config.js guarantees this can never be reached in prod (the
  // process refuses to boot), but re-check IS_PROD defensively.
  if (DEV_ALLOW_UNSIGNED && !IS_PROD) {
    const m = DEV_TOKEN_RE.exec(token);
    if (m) {
      const [, userId, roomId] = m;
      console.warn(
        `[AUTH] *** UNSIGNED DEV TOKEN ACCEPTED *** user=${userId} room=${roomId} — ` +
        'never enable DEV_ALLOW_UNSIGNED outside local development'
      );
      return { sub: userId, room_id: roomId, session_id: crypto.randomUUID(), name: userId };
    }
  }

  const verifyOptions = {
    issuer: 'usion-backend',
    audience: `usion-game-service:${serviceId}`,
    algorithms: ['RS256'],
    clockTolerance: 60, // seconds of clock skew tolerated between hosts
  };

  try {
    let verified;
    try {
      verified = await jwtVerify(token, getJWKS(jwksUrl), verifyOptions);
    } catch (err) {
      if (!isJwksRetryableError(err)) throw err;
      verified = await jwtVerify(token, getJWKS(jwksUrl, true), verifyOptions);
    }
    const { payload } = verified;

    if (payload.service_id && payload.service_id !== serviceId) {
      throw new Error(`Token service_id mismatch: ${payload.service_id} != ${serviceId}`);
    }
    if (!Array.isArray(payload.permissions) || !payload.permissions.includes('play')) {
      throw new Error("Token missing 'play' permission");
    }
    if (!payload.room_id) throw new Error('Token missing room_id');
    if (!payload.session_id) throw new Error('Token missing session_id');

    return {
      sub: String(payload.sub),
      room_id: String(payload.room_id),
      session_id: String(payload.session_id),
      // Platform tokens carry no name claim today; the client introduces its
      // Usion display name in the `hello` frame. Fall back to a readable id.
      name: String(payload.name || payload.username || payload.sub),
    };
  } catch (err) {
    if (process.env.AUTH_DIAG === '1') {
      try { console.log('[AUTH] rejected token claims:', decodeJwt(token)); } catch { /* not a JWT */ }
    }
    throw new Error(`Token validation failed: ${err.message}`);
  }
}
