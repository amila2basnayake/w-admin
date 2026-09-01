import { config } from './config';

/**
 * Outbound email for staff-facing notifications (currently: the knowledge-refresh digest).
 *
 * Transport comes from config.smtp — the CRM already mails through SendGrid SMTP, and the same
 * host/credentials work here. With NO host configured this runs in 'console' mode: the complete
 * message is logged and the caller records it, so a dev sidecar never needs a mail server and a
 * misconfigured production one fails visibly ('failed'), never silently.
 *
 * nodemailer is imported lazily so a sidecar that never sends mail never loads it.
 */

export interface MailResult {
  status: 'sent' | 'console' | 'failed';
  detail: string;
}

export interface Mail {
  to: string[];
  subject: string;
  /** plain text — staff notification mail, not marketing */
  text: string;
}

export function mailConfigured(): boolean {
  return Boolean(config.smtp.host);
}

export async function sendMail(mail: Mail): Promise<MailResult> {
  if (!mail.to.length) return { status: 'failed', detail: 'no recipients' };
  if (!mailConfigured()) {
    console.log(`[mail] console mode (no AIADVISOR_SMTP_HOST) — would send "${mail.subject}" to ${mail.to.join(', ')}\n${mail.text}`);
    return { status: 'console', detail: 'no SMTP host configured; logged instead' };
  }
  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      ...(config.smtp.user ? { auth: { user: config.smtp.user, pass: config.smtp.password } } : {}),
    });
    const info = await transport.sendMail({
      from: config.smtp.from,
      to: mail.to.join(', '),
      subject: mail.subject,
      text: mail.text,
    });
    return { status: 'sent', detail: String(info.messageId ?? 'sent') };
  } catch (e: any) {
    const detail = String(e?.message ?? e).slice(0, 500);
    console.error(`[mail] send failed ("${mail.subject}" to ${mail.to.join(', ')}): ${detail}`);
    return { status: 'failed', detail };
  }
}
