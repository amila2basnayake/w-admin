// Caller identification and verification. Three ideas, kept apart on purpose:
//   candidate  — who we THINK is calling (caller-ID match, or the caller's own say-so). Grants nothing.
//   tier 1     — verified enough for their own account data: OTP, or two knowledge factors that match
//                the candidate's CRM row (postcode, customer number, ABN, date of birth, email).
//   tier 2     — verified for trading: OTP (a possession factor). Knowledge alone never unlocks orders.
// Voice biometrics are deliberately absent (spoofable). The model never sees the OTP or the answers on
// file — only match/no-match verdicts — and phone lookups only ever return a candidate id + name.
import crypto from 'node:crypto';
import { query } from '../db';
import { isAdvisorEnabled } from '../data-db';
import { voiceConfig } from './config';
import { nsn9, maskNumber, digitsOf, normalizeDigits } from './phone';
import * as store from './store';

const STAFF_TYPE_NUMBERS = [1, 2, 3]; // mirrors src/staff.ts (kept private there)

export interface Candidate {
  uid: number;
  accountId: number | null;
  displayName: string;
  firstName: string | null;
  /** How the candidate was nominated. */
  by: 'caller_id' | 'self' | 'request' | 'test_map';
}

const CLIENT_COLS = `wu.id, wu.registry_user AS account_id, wu.first_name, wu.last_name, wu.company_name`;
const CLIENT_FILTER = `COALESCE(wu.banned,false) = false AND COALESCE(wut.type_number, 0) NOT IN (${STAFF_TYPE_NUMBERS.join(',')})`;

function display(r: any): string {
  const person = [r.first_name, r.last_name].map((s: any) => String(s ?? '').trim()).filter(Boolean).join(' ');
  return person || String(r.company_name ?? '').trim() || `client ${r.id}`;
}

async function toCandidate(row: any, by: Candidate['by']): Promise<Candidate | null> {
  // The per-client AI Advisor kill switch applies to the phone channel too.
  if ((await isAdvisorEnabled(Number(row.id))) !== 'enabled') return null;
  return {
    uid: Number(row.id), accountId: row.account_id == null ? null : Number(row.account_id),
    displayName: display(row), firstName: row.first_name ? String(row.first_name).trim() : null, by,
  };
}

/** Load a specific uid as a candidate (outbound requests name the client). */
export async function candidateByUid(uid: number, by: Candidate['by'] = 'request'): Promise<Candidate | null> {
  const r = await query(
    `SELECT ${CLIENT_COLS} FROM waterfind_user wu LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
      WHERE wu.id = $1 AND ${CLIENT_FILTER}`, [uid]);
  return r.rows[0] ? toCandidate(r.rows[0], by) : null;
}

/**
 * Caller-ID lookup. Exactly one active, non-staff, advisor-enabled client whose mobile / home /
 * business number ends in the same national significant number → candidate. Zero or several → null
 * (the agent asks the caller to identify themselves). Dev override map first.
 */
export async function candidateByPhone(fromNumber: string | null | undefined): Promise<Candidate | null> {
  if (!fromNumber) return null;
  const testUid = voiceConfig.testCallers.get(normalizeDigits(fromNumber)) ?? voiceConfig.testCallers.get(digitsOf(fromNumber));
  if (testUid) return candidateByUid(testUid, 'test_map');
  const tail = nsn9(fromNumber);
  if (!tail) return null;
  const r = await query(
    `SELECT ${CLIENT_COLS} FROM waterfind_user wu LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
      WHERE ${CLIENT_FILTER}
        AND (right(regexp_replace(COALESCE(wu.company_mobile,''), '\\D', '', 'g'), 9) = $1
          OR right(regexp_replace(COALESCE(wu.homephone,''), '\\D', '', 'g'), 9) = $1
          OR right(regexp_replace(COALESCE(wu.businessphone,''), '\\D', '', 'g'), 9) = $1)
      LIMIT 3`, [tail]);
  if (r.rows.length !== 1) return null;
  return toCandidate(r.rows[0], 'caller_id');
}

export interface IdentifyArgs {
  name?: string | null;             // person or company name as spoken
  customer_number?: string | null;  // CRN
  email?: string | null;
  abn?: string | null;
  postcode?: string | null;
}

/**
 * Self-identification: a name plus at least one identifier must all match ONE client. Returns the
 * candidate, or a reason the agent can act on. Never reveals which part failed, and never lists matches.
 */
export async function identifyBySelf(args: IdentifyArgs): Promise<{ candidate: Candidate | null; reason: 'ok' | 'need_identifier' | 'not_found' | 'ambiguous' }> {
  const name = String(args.name ?? '').trim();
  const crn = String(args.customer_number ?? '').replace(/\D/g, '');
  const email = String(args.email ?? '').trim().toLowerCase();
  const abn = String(args.abn ?? '').replace(/\D/g, '');
  const postcode = String(args.postcode ?? '').replace(/\D/g, '');
  const idents: string[] = [];
  const params: any[] = [];
  if (crn) { params.push(Number(crn)); idents.push(`wu.crn = $${params.length}`); }
  if (email) { params.push(email); idents.push(`lower(wu.email) = $${params.length}`); }
  if (abn) { params.push(abn); idents.push(`regexp_replace(COALESCE(wu.abn::text,''), '\\D', '', 'g') = $${params.length}`); }
  if (postcode) { params.push(postcode); idents.push(`regexp_replace(COALESCE(wu.postcode::text,''), '\\D', '', 'g') = $${params.length}`); }
  if (!idents.length || (!name && !crn && !email)) return { candidate: null, reason: 'need_identifier' };
  const cond: string[] = [CLIENT_FILTER, `(${idents.join(' AND ')})`];
  if (name) {
    // Every spoken name token must appear somewhere in first/last/company (STT is loose on spelling,
    // so tokens shorter than 3 chars are ignored).
    const tokens = name.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length >= 3);
    for (const t of tokens) {
      params.push(`%${t}%`);
      cond.push(`lower(COALESCE(wu.first_name,'') || ' ' || COALESCE(wu.last_name,'') || ' ' || COALESCE(wu.company_name,'')) LIKE $${params.length}`);
    }
  }
  const r = await query(
    `SELECT ${CLIENT_COLS} FROM waterfind_user wu LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
      WHERE ${cond.join(' AND ')} LIMIT 3`, params);
  if (r.rows.length === 0) return { candidate: null, reason: 'not_found' };
  if (r.rows.length > 1) return { candidate: null, reason: 'ambiguous' };
  const c = await toCandidate(r.rows[0], 'self');
  return c ? { candidate: c, reason: 'ok' } : { candidate: null, reason: 'not_found' };
}

// ---- knowledge factors ---------------------------------------------------------------------

export interface KnowledgeAnswers {
  postcode?: string | null;
  customer_number?: string | null;
  abn?: string | null;
  date_of_birth?: string | null;   // any of "1970-05-14", "14/05/1970", "14 May 1970"
  email?: string | null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** Parse a spoken/typed date into YYYY-MM-DD; null when unparseable. */
export function parseSpokenDate(s: string | null | undefined): string | null {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\s+(\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 4)] ?? MONTHS[m[2].slice(0, 3)];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 4)] ?? MONTHS[m[1].slice(0, 3)];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Compare the caller's answers with the candidate's row. Returns how many supplied factors matched
 * and how many were checked; the caller of this function decides the threshold (2 for tier 1).
 * Nothing about the stored values leaks back.
 */
export async function checkKnowledge(uid: number, a: KnowledgeAnswers): Promise<{ matched: number; checked: number; matchedFactors: string[] }> {
  const r = await query(
    `SELECT regexp_replace(COALESCE(postcode::text,''), '\\D', '', 'g') AS postcode, crn, regexp_replace(COALESCE(abn::text,''), '\\D', '', 'g') AS abn,
            to_char(dob, 'YYYY-MM-DD') AS dob, lower(COALESCE(email,'')) AS email
       FROM waterfind_user WHERE id = $1`, [uid]);
  const row = r.rows[0];
  if (!row) return { matched: 0, checked: 0, matchedFactors: [] };
  let matched = 0, checked = 0;
  const hits: string[] = [];
  const cmp = (label: string, given: string | null | undefined, onFile: string | null | undefined, norm: (s: string) => string) => {
    const g = norm(String(given ?? ''));
    if (!g) return;
    checked++;
    const f = norm(String(onFile ?? ''));
    if (f && g === f) { matched++; hits.push(label); }
  };
  cmp('postcode', a.postcode, row.postcode, (s) => s.replace(/\D/g, ''));
  cmp('customer_number', a.customer_number, row.crn == null ? '' : String(row.crn), (s) => s.replace(/\D/g, ''));
  cmp('abn', a.abn, row.abn, (s) => s.replace(/\D/g, ''));
  cmp('date_of_birth', parseSpokenDate(a.date_of_birth), row.dob, (s) => s.trim());
  cmp('email', a.email, row.email, (s) => s.trim().toLowerCase());
  return { matched, checked, matchedFactors: hits };
}

// ---- OTP -----------------------------------------------------------------------------------

/** sha256 over pepper:call:code (pepper from AIADVISOR_VOICE_OTP_PEPPER; empty pepper = the legacy call:code form). */
function hashCode(code: string, callId: number, pepper = voiceConfig.otpPepper): string {
  return crypto.createHash('sha256').update(pepper ? `${pepper}:${callId}:${code}` : `${callId}:${code}`).digest('hex');
}

export interface OtpDestination { channel: 'sms' | 'email'; to: string }

/** Where a code can go for this client: mobile first, else email. Masked in every log line. */
export async function otpDestinations(uid: number): Promise<OtpDestination[]> {
  const r = await query(`SELECT company_mobile, homephone, businessphone, email FROM waterfind_user WHERE id=$1`, [uid]);
  const row = r.rows[0];
  if (!row) return [];
  const out: OtpDestination[] = [];
  const mob = normalizeDigits(row.company_mobile);
  // 61 4xx… is a mobile; the sanitised dev DB's 0400000000 becomes 61400000000 (still "a mobile").
  if (mob && /^614\d{8}$/.test(mob)) out.push({ channel: 'sms', to: '+' + mob });
  const email = String(row.email ?? '').trim();
  if (email && email.includes('@')) out.push({ channel: 'email', to: email });
  return out;
}

export interface OtpSendResult { ok: boolean; channel?: 'sms' | 'email'; sentToMasked?: string; reason?: string; devCode?: string }

/**
 * Generate + deliver a code. Transport: 'console' (DEV ONLY — the code is printed to the sidecar log so a
 * tester can read it; delivers only while voiceConfig.otpDevConsole is on) or 'webhook' (POST
 * {channel,to,code,ttl_seconds} to Waterfind's SMS/email gateway with a bearer secret). FAIL CLOSED: a
 * webhook transport with no URL, a non-2xx/unreachable gateway, or a console transport without the dev
 * flag all return transport_failed — the code is never recorded as sent. The clear code is never
 * persisted and never returned to the model.
 */
export async function sendOtp(callId: number, uid: number, prefer: 'sms' | 'email' | null = null, cfg = voiceConfig): Promise<OtpSendResult> {
  const sends = await store.countOtpSends(callId);
  if (sends >= cfg.otpMaxSendsPerCall) return { ok: false, reason: 'too_many_sends' };
  // Cross-call: someone repeatedly naming a client must not be able to bombard their phone.
  if ((await store.countOtpSendsForClient(uid, 60)) >= cfg.otpMaxSendsPerClientHour) return { ok: false, reason: 'too_many_sends' };
  const dests = await otpDestinations(uid);
  if (!dests.length) return { ok: false, reason: 'no_destination' };
  const dest = (prefer && dests.find((d) => d.channel === prefer)) || dests[0];
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const masked = dest.channel === 'sms' ? maskNumber(dest.to) : dest.to.replace(/^(.).*(@.*)$/, '$1…$2');
  let delivered = false;
  if (cfg.otpTransport === 'webhook') {
    if (!cfg.otpWebhookUrl) {
      console.error(`[voice] OTP webhook transport selected but AIADVISOR_VOICE_OTP_WEBHOOK_URL is unset — code NOT sent (call ${callId})`);
    } else {
      try {
        const res = await fetch(cfg.otpWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cfg.otpWebhookSecret ? { Authorization: `Bearer ${cfg.otpWebhookSecret}` } : {}) },
          body: JSON.stringify({ channel: dest.channel, to: dest.to, code, ttl_seconds: cfg.otpTtlSeconds, purpose: 'waterfind-voice-verification' }),
        });
        delivered = res.ok;
        if (!res.ok) console.error(`[voice] OTP webhook ${res.status} for call ${callId}`);
      } catch (e: any) {
        console.error(`[voice] OTP webhook failed for call ${callId}:`, e?.message ?? e);
      }
    }
  } else if (cfg.otpDevConsole) {
    // Dev/console transport. This line is the "SMS" — deliberately loud so a tester finds it.
    console.log(`[voice] OTP for call ${callId} → ${dest.channel} ${masked}: ${code}  (console transport; expires in ${cfg.otpTtlSeconds}s)`);
    delivered = true;
  } else {
    console.error(`[voice] OTP console transport is disabled outside dev (AIADVISOR_VOICE_OTP_DEV) — code NOT sent (call ${callId})`);
  }
  if (!delivered) return { ok: false, reason: 'transport_failed', channel: dest.channel, sentToMasked: masked };
  await store.insertOtp(callId, uid, hashCode(code, callId), cfg.otpTransport, masked, cfg.otpTtlSeconds);
  const result: OtpSendResult = { ok: true, channel: dest.channel, sentToMasked: masked };
  if (cfg.otpTransport === 'console') result.devCode = code; // for the offline/protocol tests only
  return result;
}

export type OtpCheck = 'verified' | 'wrong' | 'expired' | 'locked' | 'none';

/** Check a spoken code against the latest OTP for this call. Attempts are counted on the row. */
export async function checkOtp(callId: number, clientUid: number, spoken: string | null | undefined): Promise<OtpCheck> {
  const otp = await store.latestOtp(callId, clientUid);   // bound to THIS candidate; consumed codes never re-verify
  if (!otp) return 'none';
  if (new Date(otp.expires_at).getTime() < Date.now()) return 'expired';
  if (otp.attempts >= voiceConfig.otpMaxAttempts) return 'locked';
  const code = String(spoken ?? '').replace(/\D/g, '');
  const attempts = await store.bumpOtpAttempt(otp.id);
  if (code.length === 6 && crypto.timingSafeEqual(Buffer.from(hashCode(code, callId)), Buffer.from(otp.code_hash))) {
    await store.markOtpVerified(otp.id);
    return 'verified';
  }
  return attempts >= voiceConfig.otpMaxAttempts ? 'locked' : 'wrong';
}
