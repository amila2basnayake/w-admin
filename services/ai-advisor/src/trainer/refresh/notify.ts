import { query } from '../../db';
import { config } from '../../config';
import type { RefreshOutcome } from './policy';

/**
 * Who hears about a refresh run, and what they are told.
 *
 * Recipients = every Waterfind STAFF account (usertype broker/sales/admin — same definition as
 * staff.ts) holding the trainer CRM role, with a usable email address. The CRM's role screens are
 * the roster; nothing here is a second list to maintain. KB_REFRESH_NOTIFY_TO replaces the list
 * (dev, or a replica whose DB has no role data); KB_REFRESH_NOTIFY_EXTRA appends.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function refreshRecipients(): Promise<string[]> {
  if (config.kbRefreshNotifyTo.length) return dedupe(config.kbRefreshNotifyTo.filter((e) => EMAIL_RE.test(e)));
  let fromRole: string[] = [];
  if (config.trainerRoleId) {
    try {
      const r = await query<{ email: string | null }>(
        `SELECT DISTINCT wu.email
           FROM waterfind_user wu
           JOIN user_role_map m ON m.waterfind_user = wu.id
           JOIN user_role ur ON ur.id = m.user_role
           LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
          WHERE ur.role_id = $1 AND wut.type_number IN (1, 2, 3)`,
        [config.trainerRoleId]);
      fromRole = r.rows.map((row) => String(row.email ?? '').trim()).filter((e) => EMAIL_RE.test(e));
    } catch (e) {
      console.error('[kb-refresh] trainer-role recipient lookup failed', e);
    }
  }
  return dedupe([...fromRole, ...config.kbRefreshNotifyExtra.filter((e) => EMAIL_RE.test(e))]);
}

function dedupe(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

// --- the digest ----------------------------------------------------------------------------------

export interface DigestItem {
  outcome: RefreshOutcome;
  kind: 'doc' | 'note';
  docId: string;
  title: string;
  detail: string;
  sources: string[];
  eventId?: number | null;
  nextBestBy?: string | null;
}

export interface Digest { subject: string; text: string }

const LABEL: Record<RefreshOutcome, string> = {
  deleted: 'REMOVED — deleted from the knowledge base',
  created: 'ADDED — new document created',
  updated: 'UPDATED — content changed',
  confirmed: 'CONFIRMED — still current',
  flagged: 'NEEDS ATTENTION — could not be verified',
  error: 'ERRORS — the check itself failed',
};

/**
 * One plain-text email per run. Updated items lead (they are what changed what clients are told),
 * then flagged, confirmed, errors. Every applied change carries its change number so anyone can
 * undo it from AI Trainer Home -> History.
 */
export function renderDigest(items: DigestItem[], opts: { today: string; deferred?: number } = { today: '' }): Digest {
  const by = (o: RefreshOutcome) => items.filter((i) => i.outcome === o);
  const removed = by('deleted'), added = by('created');
  const updated = by('updated'), confirmed = by('confirmed'), flagged = by('flagged'), errors = by('error');
  const parts: string[] = [];
  const counts = [
    removed.length && `${removed.length} removed`,
    added.length && `${added.length} added`,
    updated.length && `${updated.length} updated`,
    confirmed.length && `${confirmed.length} confirmed`,
    flagged.length && `${flagged.length} need attention`,
    errors.length && `${errors.length} failed`,
  ].filter(Boolean).join(', ');
  const subject = `AI Advisor knowledge refresh: ${counts || 'nothing processed'}`;

  parts.push(
    `The AI Advisor's automatic knowledge refresh ran${opts.today ? ` on ${opts.today}` : ''}. Items whose`
    + ` best-by date had passed were re-verified against their sources. Every change below is numbered`
    + ` and can be undone from AI Trainer Home -> History.`);

  for (const [group, label] of [[removed, LABEL.deleted], [added, LABEL.created], [updated, LABEL.updated], [flagged, LABEL.flagged], [confirmed, LABEL.confirmed], [errors, LABEL.error]] as const) {
    if (!group.length) continue;
    parts.push('', `${label} (${group.length})`, '-'.repeat(Math.min(60, label.length + 6)));
    for (const i of group) {
      const head = `- ${i.title || i.docId} [${i.kind === 'note' ? 'note' : 'document'} ${i.docId}]`
        + (i.eventId ? ` — change #${i.eventId}` : '');
      parts.push(head);
      if (i.detail) parts.push(`  ${i.detail}`);
      if (i.sources.length) parts.push(`  Checked: ${i.sources.join(', ')}`);
      if (i.nextBestBy) parts.push(`  Next check: ${i.nextBestBy}`);
    }
  }
  if (opts.deferred) {
    parts.push('', `${opts.deferred} more item${opts.deferred === 1 ? ' is' : 's are'} due and will be processed on the next pass.`);
  }
  return { subject, text: parts.join('\n') + '\n' };
}
