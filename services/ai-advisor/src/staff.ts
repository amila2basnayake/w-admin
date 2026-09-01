import { query } from './db';

/**
 * Shared staff verification: is this uid a WATERFIND STAFF ACCOUNT, looked up FRESH from the
 * database. Extracted from the curator (f51e0de; now trainer/auth.ts) so the trainer and the broker-assist surface
 * gate on the exact same definition of "staff".
 *
 * Staff means waterfind_user_type.type_number in {USER_BROKER (1), USER_SALES (2), USER_ADMIN (3)}.
 * The token's own `ut` claim is deliberately not consulted: the minting JSP collapses usertype to
 * 4 values and its catch-all bucket holds ~3,400 accounts (client subtypes, external state water
 * authorities, press) alongside the 34 actual brokers — the DB usertype is the authority, the
 * token only establishes WHO is calling. The list EXCLUDES USER_AUTHORITY (4) and
 * USER_AUTHORITY_OFFICER (7) and every client type (0, 5, 6).
 *
 * Fail-closed: a DB failure denies rather than admits (throws StaffLookupFailed -> map to 503).
 */

const STAFF_TYPE_NUMBERS = [1, 2, 3];

export class StaffLookupFailed extends Error {
  constructor(msg = 'staff status cannot be verified right now') { super(msg); }
}

/** True iff the uid is a staff account. Throws StaffLookupFailed if it cannot be determined. */
export async function isStaff(uid: number): Promise<boolean> {
  let rows: any[];
  try {
    const r = await query(
      `SELECT wut.type_number
         FROM waterfind_user wu
         LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
        WHERE wu.id = $1`,
      [uid],
    );
    rows = r.rows;
  } catch (e) {
    console.error(`staff lookup failed for uid=${uid}; denying (fail-closed)`, e);
    throw new StaffLookupFailed();
  }
  if (!rows.length) return false;                       // unknown account
  return STAFF_TYPE_NUMBERS.includes(Number(rows[0].type_number));
}

/**
 * The CRM's fine-grained role ids held by a user (public.user_role.role_id via user_role_map) —
 * the same table WaterfindDelegate.hasAccess(roleId, userId) reads, looked up FRESH per call so
 * a role granted or removed in the CRM bites on the next request (the CRM's own session copy,
 * UserCredentialsDto.roleIds, is minted once at login and goes stale; this does not).
 *
 * Role ids are upper-case strings such as "SU", "SALES_MANAGER", "AI_TRAINER". Fail-closed like
 * isStaff: a DB failure throws StaffLookupFailed rather than returning an empty list.
 */
export async function crmRoleIds(uid: number): Promise<string[]> {
  try {
    const r = await query(
      `SELECT DISTINCT r.role_id
         FROM user_role_map m
         JOIN user_role r ON r.id = m.user_role
        WHERE m.waterfind_user = $1`,
      [uid],
    );
    return r.rows.map((row: any) => String(row.role_id ?? '').trim().toUpperCase()).filter(Boolean);
  } catch (e) {
    console.error(`CRM role lookup failed for uid=${uid}; denying (fail-closed)`, e);
    throw new StaffLookupFailed('role membership cannot be verified right now');
  }
}

/** True iff the uid holds the given CRM role id. Throws StaffLookupFailed if it cannot be determined. */
export async function hasCrmRole(uid: number, roleId: string): Promise<boolean> {
  const want = roleId.trim().toUpperCase();
  if (!want) return false;
  return (await crmRoleIds(uid)).includes(want);
}

/**
 * THE one definition of "may this uid use a staff tool" — every staff surface in the sidecar
 * (broker-assist + call notes, AI Trainer, voice admin) goes through here so the rule cannot drift
 * between them:
 *
 *   staff usertype (isStaff)  AND  at least one of the surface's CRM roles (hasCrmRole)
 *
 * both looked up fresh from the database, fail-closed. Which roles a surface demands is policy
 * (config), not code: the assist surface mirrors the CRM's own recording/client-page gate
 * (BROKER or SU — DownloadPhoneRecordingAction.java), the trainer its AI_TRAINER role.
 *
 * `roles` empty = usertype only. That is deliberately allowed (replicas whose DB carries no role
 * assignments) but it is a policy widening, so callers log it loudly at boot — see config.ts.
 *
 * Resolves to a reason string on denial (for logs/tests), null when admitted. Throws
 * StaffLookupFailed when the answer cannot be determined.
 */
export type StaffDenial = 'not-staff' | 'missing-role';

export async function staffAccessDenial(uid: number, roles: readonly string[]): Promise<StaffDenial | null> {
  if (!(await isStaff(uid))) return 'not-staff';
  const want = roles.map((r) => r.trim().toUpperCase()).filter(Boolean);
  if (!want.length) return null;
  const held = await crmRoleIds(uid);
  return want.some((r) => held.includes(r)) ? null : 'missing-role';
}

/** Convenience: true iff staffAccessDenial() is null. */
export async function hasStaffAccess(uid: number, roles: readonly string[]): Promise<boolean> {
  return (await staffAccessDenial(uid, roles)) === null;
}

