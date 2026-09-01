import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

export interface AuthedRequest extends Request {
  userId?: number;
  userName?: string;
  userType?: number;
  /** Broker-assist surface: the CLIENT this staff token is scoped to (signed `act` claim). */
  actForUserId?: number;
  actForName?: string;
}

export interface TokenClaims {
  uid: number;    // CRM waterfind_user.id
  name: string;   // display name
  ut: number;     // usertype
  iat: number;    // issued-at (epoch seconds)
  exp: number;    // expiry (epoch seconds)
  nonce: string;
  /** Optional (broker-assist tokens only): waterfind_user.id of the client being advised.
   *  Minted ONLY by the staff-gated client-page JSP; its presence is what admits a token to the
   *  /assist routes, and the sidecar re-verifies the CALLER's staff usertype from the DB. */
  act?: number;
  /** Display name of the acting-for client (for UI/prompt framing; not used for scoping). */
  actName?: string;
}

function b64urlToBuffer(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Verify a token minted by the CRM JSP: `<base64url(json)>.<base64url(hmacSha256)>`.
 * The signature is verified over the EXACT received body bytes (no JSON re-serialisation),
 * with a constant-time comparison. Throws on any failure.
 */
export function verifyToken(token: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed token');
  const [body, sig] = parts;

  const expected = crypto.createHmac('sha256', config.sharedSecret).update(body).digest();
  const got = b64urlToBuffer(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    throw new Error('bad signature');
  }

  const claims = JSON.parse(b64urlToBuffer(body).toString('utf8')) as TokenClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.uid !== 'number' || !Number.isFinite(claims.uid)) throw new Error('no uid');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token expired');
  // Defence in depth: reject a forged, absurdly long lifetime even if signed.
  const iat = typeof claims.iat === 'number' ? claims.iat : claims.exp;
  if (claims.exp - iat > config.tokenTtl + 60) throw new Error('ttl too long');
  if (claims.act !== undefined
      && (typeof claims.act !== 'number' || !Number.isInteger(claims.act) || claims.act <= 0)) {
    throw new Error('bad act claim');
  }
  return claims;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const hdr = req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  if (!m) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    const claims = verifyToken(m[1]);
    req.userId = claims.uid;
    req.userName = claims.name;
    req.userType = claims.ut;
    if (claims.act) {
      req.actForUserId = claims.act;
      req.actForName = typeof claims.actName === 'string' ? claims.actName : undefined;
    }
    next();
  } catch (e: any) {
    res.status(401).json({ error: 'invalid token', detail: e?.message });
  }
}
