import type { Response, NextFunction } from 'express';
import { config } from '../config';
import { staffAccessDenial, StaffLookupFailed } from '../staff';
import type { AuthedRequest } from '../auth';

/**
 * AI Trainer access control: a WATERFIND STAFF ACCOUNT that HOLDS THE "AI TRAINER" CRM ROLE, both
 * verified server-side against the database on every request. No sidecar roster.
 *
 *  1. Staff usertype — waterfind_user_type.type_number in {USER_BROKER (1), USER_SALES (2),
 *     USER_ADMIN (3)}. The token's own `ut` claim is deliberately not consulted: the minting JSP
 *     collapses usertype to 4 values and its catch-all bucket holds ~3,400 client/authority/press
 *     accounts alongside the 34 actual brokers.
 *  2. The CRM role config.trainerRoleId (default AI_TRAINER) in public.user_role_map — the same
 *     grant the CRM's "AI Trainer Home" screen is gated on, administered through the CRM's own role
 *     screens. The CRM is the roster; the sidecar only reads it. TRAINER_ROLE_ID= (empty) drops
 *     check 2 — for replicas without role data, never for production.
 *
 * Fail-closed throughout: a DB failure denies rather than admits. This surface writes what ~15,000
 * clients are told; the failure mode of a lookup blip must be "nobody can edit", never "anybody can".
 */

export interface TrainerIdentity {
  userId: number;
  /** display name from the token, for the ledger's activity feed */
  name?: string;
  /** The CRM role that admitted this caller; null when the role check is switched off. */
  role?: string | null;
}

export class TrainerDenied extends Error {
  constructor(msg: string, readonly status = 403) { super(msg); }
}

export type TrainerRefusal = 'not-staff' | 'no-role';

/** The CRM roles the trainer demands: [AI_TRAINER] normally; [] = any staff account (see the boot warning). */
export const TRAINER_ROLES: readonly string[] = config.trainerRoleId ? [config.trainerRoleId] : [];

// TRAINER_ROLE_ID= (blank) is allowed — replicas whose DB carries no role assignments — but it
// widens "who can rewrite what 15,000 clients are told" from one named role to every broker, sales
// and admin account. Say so where it cannot be missed, once, at boot.
if (config.trainerEnabled && !TRAINER_ROLES.length) {
  console.warn('\n'
    + '*** WARNING: TRAINER_ROLE_ID is blank — the AI Trainer admits ANY Waterfind staff account (broker / sales /\n'
    + '*** admin usertype), not only holders of the AI Trainer role. Acceptable on a replica with no role data;\n'
    + '*** never in production. Set TRAINER_ROLE_ID=AI_TRAINER (the default) to restore the role check.\n');
}

export async function resolveTrainer(uid: number): Promise<TrainerIdentity | TrainerRefusal> {
  try {
    // The shared staff rule (staff.ts): staff usertype AND one of the surface's roles, fresh, fail-closed.
    const denial = await staffAccessDenial(uid, TRAINER_ROLES);
    if (denial === 'not-staff') return 'not-staff';
    if (denial === 'missing-role') return 'no-role';
    return { userId: uid, role: TRAINER_ROLES[0] ?? null };
  } catch (e) {
    if (!(e instanceof StaffLookupFailed)) console.error('trainer access lookup unexpected error', e);
    throw new TrainerDenied('trainer access cannot be verified right now', 503);
  }
}

export interface TrainerRequest extends AuthedRequest {
  trainer?: TrainerIdentity;
}

/** Express guard: requires a Waterfind staff account holding the trainer role. Attaches `req.trainer`. */
export function requireTrainer() {
  return async (req: TrainerRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!config.trainerEnabled) {
      res.status(404).json({ error: 'not found' });   // feature off: do not advertise the surface
      return;
    }
    if (!req.userId) { res.status(401).json({ error: 'missing bearer token' }); return; }
    let outcome: TrainerIdentity | TrainerRefusal;
    try {
      outcome = await resolveTrainer(req.userId);
    } catch (e) {
      const status = e instanceof TrainerDenied ? e.status : 503;
      res.status(status).json({ error: (e as Error).message });
      return;
    }
    if (outcome === 'not-staff') { res.status(403).json({ error: 'staff only', reason: outcome }); return; }
    if (outcome === 'no-role') {
      res.status(403).json({
        error: `the ${roleLabel(config.trainerRoleId)} role is required`,
        reason: outcome, role: config.trainerRoleId,
      });
      return;
    }
    req.trainer = { ...outcome, name: req.userName };
    next();
  };
}

/** "AI_TRAINER" -> "AI Trainer" (matches how the CRM prints user_role.role_name). */
export function roleLabel(roleId: string): string {
  return roleId.split('_').filter(Boolean)
    .map((w) => (w === 'AI' || w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ');
}
