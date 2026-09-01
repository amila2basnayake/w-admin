// Thin Retell REST client (fetch; no SDK dependency) + webhook signature verification. Everything the
// voice module needs from Retell's API lives here so the rest of the module is testable with a stub.
import crypto from 'node:crypto';
import { voiceConfig } from './config';
import type { RetellCall } from './protocol';

export class RetellError extends Error {
  constructor(public status: number, msg: string, public body?: unknown) { super(msg); this.name = 'RetellError'; }
}

async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return apiAt<T>(voiceConfig.retellBase, method, path, body);
}
async function apiAt<T = any>(base: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const key = voiceConfig.retellApiKey;
  if (!key) throw new RetellError(0, 'RETELL_API_KEY is not set');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new RetellError(res.status, `Retell ${method} ${path} → ${res.status}`, json);
  return json as T;
}

export const retell = {
  getCall: (callId: string) => api<RetellCall>('GET', `/v2/get-call/${encodeURIComponent(callId)}`),

  createPhoneCall: (input: {
    from_number: string; to_number: string; override_agent_id?: string;
    metadata?: Record<string, unknown>; retell_llm_dynamic_variables?: Record<string, string>;
  }) => api<RetellCall>('POST', '/v2/create-phone-call', input),

  createWebCall: (input: { agent_id: string; metadata?: Record<string, unknown>; retell_llm_dynamic_variables?: Record<string, string> }) =>
    api<RetellCall & { access_token: string }>('POST', '/v2/create-web-call', input),

  createAgent: (body: Record<string, unknown>) => api<{ agent_id: string; version?: number }>('POST', '/create-agent', body),
  updateAgent: (agentId: string, body: Record<string, unknown>) =>
    api<{ agent_id: string; version?: number }>('PATCH', `/update-agent/${encodeURIComponent(agentId)}`, body),
  getAgent: (agentId: string) => api<any>('GET', `/get-agent/${encodeURIComponent(agentId)}`),
  listAgents: () => api<any[]>('GET', '/list-agents'),
  listVoices: () => api<any[]>('GET', '/list-voices'),
  listPhoneNumbers: () => api<any[]>('GET', '/list-phone-numbers'),
  updatePhoneNumber: (number: string, body: Record<string, unknown>) =>
    api<any>('PATCH', `/update-phone-number/${encodeURIComponent(number)}`, body),
  /** Bring-your-own-carrier: register a number that lives on a SIP trunk (Twilio/Telnyx/...) with Retell.
   *  Inbound: the carrier's origination URI must already point at sip:sip.retellai.com. Outbound: Retell
   *  dials the trunk's termination URI with the given credentials. */
  importPhoneNumber: (body: {
    phone_number: string; termination_uri: string; sip_trunk_auth_username?: string; sip_trunk_auth_password?: string;
    nickname?: string; inbound_agents?: AgentWeight[]; outbound_agents?: AgentWeight[];
  }) => api<any>('POST', '/import-phone-number', body),
};

/** The same client against another Retell base URL — the web reader may talk to the real Retell
 *  while the phone channel is pointed at a local fake (campaign demos), or vice versa. */
export function retellAt(base: string) {
  const b = base.replace(/\/$/, '');
  return {
    getCall: (callId: string) => apiAt<RetellCall>(b, 'GET', `/v2/get-call/${encodeURIComponent(callId)}`),
    createWebCall: (input: { agent_id: string; metadata?: Record<string, unknown>; retell_llm_dynamic_variables?: Record<string, string> }) =>
      apiAt<RetellCall & { access_token: string }>(b, 'POST', '/v2/create-web-call', input),
    createAgent: (body: Record<string, unknown>) => apiAt<{ agent_id: string; version?: number }>(b, 'POST', '/create-agent', body),
    updateAgent: (agentId: string, body: Record<string, unknown>) =>
      apiAt<{ agent_id: string; version?: number }>(b, 'PATCH', `/update-agent/${encodeURIComponent(agentId)}`, body),
  };
}

/** Retell binds a number to agents by weight (A/B splits); we always bind one agent at weight 1. */
export interface AgentWeight { agent_id: string; agent_version?: number; weight: number }

/**
 * Verify Retell's `x-retell-signature: v=<ms>,d=<hex>` — HMAC-SHA256 with the API key over
 * `<raw body><timestamp>`, rejecting stale timestamps (default 5 min). Mirrors Retell.verify() in
 * their SDK so we do not need the dependency. Constant-time compare.
 */
export function verifyRetellSignature(rawBody: string | Buffer, signature: string | undefined, apiKey = voiceConfig.retellWebhookKey, toleranceMs = 5 * 60_000, now = Date.now()): boolean {
  if (!apiKey || !signature) return false;
  const m = /^v=(\d+),d=([0-9a-f]+)$/i.exec(signature.trim());
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > toleranceMs) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const expected = crypto.createHmac('sha256', apiKey).update(body + String(ts), 'utf8').digest('hex');
  const got = m[2].toLowerCase();
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
}

/** Test helper: produce a valid signature the way Retell does. */
export function signRetellBody(rawBody: string, apiKey: string, ts = Date.now()): string {
  const d = crypto.createHmac('sha256', apiKey).update(rawBody + String(ts), 'utf8').digest('hex');
  return `v=${ts},d=${d}`;
}
