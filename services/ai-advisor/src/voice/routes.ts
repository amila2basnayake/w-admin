// HTTP surface of the voice module (mounted at /voice by index.ts):
//   POST /voice/webhooks/retell      Retell call events (signature-verified, raw body)
//   POST /voice/outbound             agnostic trigger: queue an outbound call (outbound bearer secret ONLY)
//   GET  /voice/outbound[?status=]   queue listing;  POST /voice/outbound/:id/cancel, /dial-now   (staff token)
//   /voice/campaigns/*               call campaigns — brief + call list, fed into the queue (staff token; campaign-routes.ts)
//   GET  /voice/calls, /voice/calls/:id   call log + audit events (staff token)
//   GET/POST/DELETE /voice/suppression    suppression list (staff token)
//   GET  /voice/health               capabilities (no secrets) — the ONLY route that answers when voice is off
//   GET  /voice/demo, POST /voice/demo/web-call   browser web-call demo (gated)
// "Staff token" = a CRM-minted token whose uid is staff AND holds one of config.assistRoles (BROKER/SU),
// looked up fresh (staff.ts hasStaffAccess) — the same rule as the broker-assist surface. The outbound
// webhook secret is for machines: it can ONLY queue outbound calls, nothing else.
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { verifyToken } from '../auth';
import { hasStaffAccess, StaffLookupFailed } from '../staff';
import { config } from '../config';
import { voiceConfig, voiceCapabilities } from './config';
import { verifyRetellSignature, retell } from './retell';
import { handleRetellEvent } from './webhooks';
import { requestOutboundCall, OutboundError, dialDue } from './outbound';
import { normalizeDigits } from './phone';
import { isOutboundFlow } from './flows';
import * as store from './store';
import { sessionCount } from './session';
import { campaignRouter } from './campaign-routes';

const here = dirname(fileURLToPath(import.meta.url));

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m ? m[1].trim() : null;
}
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Voice admin: a CRM-minted STAFF token (staff usertype + one of config.assistRoles, fresh from the DB).
 *  The outbound webhook secret is deliberately NOT accepted here. Fail closed. */
async function requireVoiceAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tok = bearer(req);
  if (!tok) { res.status(401).json({ error: 'missing bearer token' }); return; }
  let uid: number;
  let name = '';
  try { const c = verifyToken(tok); uid = c.uid; name = c.name; } catch { res.status(401).json({ error: 'invalid token' }); return; }
  try {
    if (await hasStaffAccess(uid, config.assistRoles)) { (req as any).staffUid = uid; (req as any).staffName = name; return next(); }
    res.status(403).json({ error: 'staff only' });
  } catch (e) {
    if (e instanceof StaffLookupFailed) { res.status(503).json({ error: e.message }); return; }
    throw e;
  }
}

/** The outbound trigger endpoint accepts ONLY the webhook secret (external systems, not people). */
function requireOutboundSecret(req: Request, res: Response, next: NextFunction): void {
  const tok = bearer(req);
  if (!voiceConfig.outboundWebhookSecret) { res.status(503).json({ error: 'outbound webhook secret not configured' }); return; }
  if (!tok || !safeEq(tok, voiceConfig.outboundWebhookSecret)) { res.status(401).json({ error: 'invalid token' }); return; }
  next();
}

const jh = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export const voiceRouter = Router();

const STARTED_AT = new Date().toISOString();
voiceRouter.get('/health', (_req, res) => {
  res.json({ ...voiceCapabilities(), live_sessions: sessionCount(), started_at: STARTED_AT });
});

// Everything else is gated on the voice kill switch: with AIADVISOR_VOICE_ENABLED off the module does
// not exist (404), whatever credentials are presented. (The router is mounted unconditionally so that
// /voice/health can explain WHY voice is off.)
voiceRouter.use((req, res, next) => {
  if (!voiceConfig.enabled) { res.status(404).json({ error: 'voice calls are not enabled on this sidecar' }); return; }
  next();
});

/** The request's real source IP. X-Forwarded-For is honoured ONLY when the socket peer is the loopback
 *  (the Caddy tunnel on this box), and then only its LAST hop (what Caddy appended for the actual peer,
 *  never a client-supplied first value). Any other peer: the socket address itself. */
export function webhookSourceIp(req: Pick<Request, 'header' | 'socket'>): string {
  const sock = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  const loopback = sock === '127.0.0.1' || sock === '::1' || sock === 'localhost';
  if (!loopback) return sock;
  const xff = String(req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1].replace(/^::ffff:/, '') : sock;
}

/**
 * Webhook admission policy (pure; tested offline):
 *  - a valid signature (HMAC-SHA256 with the account's webhook-badge key) admits;
 *  - a PRESENT but invalid signature rejects, whatever the source IP (a trusted IP cannot launder a
 *    forged header);
 *  - with no signature header, the request is admitted only if its real source IP is in the
 *    (default-empty) trusted list.
 */
export function webhookAdmission(input: { sigHeader: string | undefined; sigOk: boolean; srcIp: string; trustedIps: readonly string[] }): { ok: boolean; how: 'signature' | 'trusted_ip' | null; why?: string } {
  if (input.sigOk) return { ok: true, how: 'signature' };
  if (input.sigHeader) return { ok: false, how: null, why: 'signature present but invalid' };
  if (input.trustedIps.includes(input.srcIp)) return { ok: true, how: 'trusted_ip' };
  return { ok: false, how: null, why: `no signature and source ${input.srcIp || '?'} not trusted` };
}

// ---- Retell webhooks ----
// The raw body is read HERE (express.raw, capped), so the route does not depend on server.ts keeping its
// JSON parser off this path: if an upstream parser already consumed the stream (e.g. a trailing-slash
// variant), req.body is not a Buffer and the request is refused rather than hung.
voiceRouter.post('/webhooks/retell', express.raw({ type: () => true, limit: voiceConfig.webhookMaxBodyBytes }), jh(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'raw body required' }); return; }
  const raw: Buffer = req.body;
  if (process.env.AIADVISOR_VOICE_WEBHOOK_DEBUG === '1') {
    // Debug capture (dev only): raw body + signature header, to validate the verifier against real traffic.
    try { appendFileSync('webhook-capture.log', JSON.stringify({ at: new Date().toISOString(), sig: req.header('x-retell-signature'), headers: req.headers, body: raw.toString('utf8') }) + String.fromCharCode(10)); } catch {}
  }
  const sigHeader = req.header('x-retell-signature');
  const srcIp = webhookSourceIp(req);
  const admission = webhookAdmission({ sigHeader, sigOk: verifyRetellSignature(raw, sigHeader), srcIp, trustedIps: voiceConfig.webhookTrustedIps });
  if (!admission.ok) {
    console.warn(`[voice] webhook rejected: ${admission.why} (${raw.length} bytes)`);
    res.status(401).json({ error: 'bad signature' });
    return;
  }
  if (admission.how === 'trusted_ip') console.warn(`[voice] webhook accepted by trusted source IP ${srcIp} without a signature (set RETELL_WEBHOOK_KEY to the badge key)`);
  let ev: any;
  try { ev = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'bad json' }); return; }
  console.log(`[voice] webhook ${ev?.event ?? '?'} for ${ev?.call?.call_id ?? '?'}`);
  // Ack fast; process inline (cheap) but never let a processing error turn into a retry storm.
  try { await handleRetellEvent(ev); } catch (e: any) { console.error('[voice] webhook handling failed:', e?.message ?? e); }
  res.status(204).end();
}));
// Body-size / parse errors from the raw reader above: a terse 413/400 rather than the default HTML + stack.
voiceRouter.use('/webhooks/retell', (err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.too.large') { console.warn(`[voice] webhook rejected: body over ${voiceConfig.webhookMaxBodyBytes} bytes`); res.status(413).json({ error: 'body too large' }); return; }
  if (err?.status && err.status < 500) { res.status(err.status).json({ error: 'bad request' }); return; }
  next(err);
});

// ---- Call campaigns (the CRM "Call Campaigns" page; staff token) ----
voiceRouter.use('/campaigns', campaignRouter(requireVoiceAdmin));

// ---- Outbound trigger (agnostic webhook) ----
voiceRouter.post('/outbound', requireOutboundSecret, jh(async (req, res) => {
  const b = req.body ?? {};
  try {
    const { request, created } = await requestOutboundCall({
      flow: b.flow, client_uid: b.client_uid ?? null, to_number: b.to_number ?? null, payload: b.payload ?? {},
      idempotency_key: b.idempotency_key ?? null, consent_basis: b.consent_basis ?? null, scheduled_for: b.scheduled_for ?? null,
      source: 'webhook', source_ref: b.source_ref ?? null,
    });
    res.status(created ? 201 : 200).json({ request: pubRequest(request), created,
      dialer: voiceConfig.outboundEnabled && !!voiceConfig.fromNumber ? 'armed' : 'disabled (queued only)' });
  } catch (e: any) {
    if (e instanceof OutboundError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
}));

function pubRequest(r: store.OutboundRequestRow) {
  return { id: r.id, idempotency_key: r.idempotency_key, flow: r.flow, client_uid: r.client_uid, to_number: '…' + normalizeDigits(r.to_number).slice(-3),
    status: r.status, status_detail: r.status_detail, scheduled_for: r.scheduled_for, attempts: r.attempts, retell_call_id: r.retell_call_id,
    source: r.source, source_ref: r.source_ref, consent_basis: r.consent_basis, created_at: r.created_at, updated_at: r.updated_at };
}

voiceRouter.get('/outbound', requireVoiceAdmin, jh(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status as store.OutboundStatus : undefined;
  res.json((await store.listOutbound(status)).map(pubRequest));
}));
voiceRouter.post('/outbound/:id/cancel', requireVoiceAdmin, jh(async (req, res) => {
  const id = Number(req.params.id);
  const r = await store.getOutbound(id);
  if (!r) { res.status(404).json({ error: 'not found' }); return; }
  if (r.status !== 'queued') { res.status(409).json({ error: `request is ${r.status}` }); return; }
  await store.setOutboundStatus(id, 'cancelled', 'cancelled via API');
  res.json({ ok: true });
}));
/** Manual dialer tick (ops/testing) — the guards still apply. */
voiceRouter.post('/outbound/dial-now', requireVoiceAdmin, jh(async (_req, res) => {
  res.json({ results: await dialDue() });
}));

// ---- Call log ----
function pubCall(c: store.VoiceCallRow) {
  return { id: c.id, retell_call_id: c.retell_call_id, direction: c.direction, flow: c.flow, from_number: c.from_number ? '…' + normalizeDigits(c.from_number).slice(-3) : null,
    to_number: c.to_number ? '…' + normalizeDigits(c.to_number).slice(-3) : null, client_uid: c.client_uid, identified_by: c.identified_by, auth_level: c.auth_level,
    status: c.status, outcome: c.outcome, disconnection_reason: c.disconnection_reason, started_at: c.started_at, ended_at: c.ended_at,
    duration_seconds: c.duration_seconds, summary: c.summary, recording_url: c.recording_url, cost_usd: c.cost_usd, outbound_request_id: c.outbound_request_id };
}
voiceRouter.get('/calls', requireVoiceAdmin, jh(async (req, res) => {
  const clientUid = req.query.client_uid ? Number(req.query.client_uid) : null;
  if (clientUid !== null && !Number.isInteger(clientUid)) { res.status(400).json({ error: 'client_uid must be an integer' }); return; }
  const limit = req.query.limit && Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50;
  res.json((await store.listCalls({ clientUid, limit })).map(pubCall));
}));
voiceRouter.get('/calls/:id', requireVoiceAdmin, jh(async (req, res) => {
  const c = await store.getCallById(Number(req.params.id));
  if (!c) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ ...pubCall(c), transcript: c.transcript, events: await store.listCallEvents(c.id) });
}));

// ---- Suppression list ----
voiceRouter.get('/suppression', requireVoiceAdmin, jh(async (_req, res) => { res.json(await store.listSuppressions()); }));
voiceRouter.post('/suppression', requireVoiceAdmin, jh(async (req, res) => {
  const digits = normalizeDigits(req.body?.number);
  if (!digits) { res.status(400).json({ error: 'number is required' }); return; }
  const reason = ['opt_out', 'dnc_register', 'staff', 'manual'].includes(req.body?.reason) ? req.body.reason : 'manual';
  const staffUid = (req as any).staffUid ?? null;
  await store.addSuppression(digits, reason, staffUid ? `staff:${staffUid}` : 'api', staffUid);
  res.status(201).json({ ok: true, phone_digits: digits, reason });
}));
voiceRouter.delete('/suppression/:number', requireVoiceAdmin, jh(async (req, res) => {
  const digits = normalizeDigits(req.params.number);
  res.json({ removed: await store.removeSuppression(digits) });
}));

// ---- Demo: browser web-calls (no phone number needed) ----
function demoAllowed(req: Request): boolean {
  if (!voiceConfig.demoEnabled) return false;
  if (!voiceConfig.demoKey) return false;   // DEMO=1 without a key is a misconfiguration, not an open door
  // Key in the POST body or a bearer header only — never a query string (logged by every proxy on the path).
  const k = String(req.body?.key ?? bearer(req) ?? '');
  return !!k && safeEq(k, voiceConfig.demoKey);
}
voiceRouter.get('/demo', (req, res) => {
  if (!voiceConfig.demoEnabled) { res.status(404).end(); return; }
  // The page carries the configured demo key itself — whoever can reach the page can start a call.
  const html = readFileSync(join(here, '..', '..', 'voice-demo', 'index.html'), 'utf8')
    .replace('__DEMO_KEY__', JSON.stringify(voiceConfig.demoKey ?? ''));
  res.type('html').send(html);
});
voiceRouter.post('/demo/web-call', jh(async (req, res) => {
  if (!demoAllowed(req)) { res.status(voiceConfig.demoEnabled ? (voiceConfig.demoKey ? 401 : 503) : 404).json({ error: voiceConfig.demoEnabled && !voiceConfig.demoKey ? 'set AIADVISOR_VOICE_DEMO_KEY' : 'demo not available' }); return; }
  const kind = String(req.body?.kind ?? 'inbound');
  const clientUid = req.body?.client_uid ? Number(req.body.client_uid) : null;
  const metadata: Record<string, unknown> = { demo: true };
  let agentId: string | undefined;
  if (kind === 'inbound') { agentId = voiceConfig.inboundAgentId; if (clientUid) metadata.client_uid = clientUid; }
  else if (isOutboundFlow(kind)) {
    agentId = voiceConfig.outboundAgentId ?? voiceConfig.inboundAgentId;
    metadata.flow = kind; if (clientUid) metadata.client_uid = clientUid;
    metadata.payload = req.body?.payload ?? {};
  } else { res.status(400).json({ error: 'kind must be inbound or an outbound flow' }); return; }
  if (!agentId) { res.status(503).json({ error: 'no Retell agent configured — run npm run voice:setup' }); return; }
  const call = await retell.createWebCall({ agent_id: agentId, metadata });
  res.json({ access_token: call.access_token, call_id: call.call_id, agent_id: agentId, kind });
}));
