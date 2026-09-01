// Voice calls (Retell) configuration. Everything is off unless AIADVISOR_VOICE_ENABLED=1; the outbound
// DIALER is a second, separate kill switch (AIADVISOR_VOICE_OUTBOUND_ENABLED) because placing calls
// has a legal basis to confirm first (Spam Act / DNC Register) — see docs/design/voice-calls-design.md.
import { config } from '../config';
import { parseVoiceLanguages, baseLang } from './languages';

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
function flag(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return v !== '0' && v.toLowerCase() !== 'false';
}
function str(name: string, def = ''): string { return (process.env[name] ?? def).trim(); }

/** "HH:MM-HH:MM" → minutes since midnight. */
function parseHours(s: string): { start: number; end: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return { start: 9 * 60, end: 20 * 60 };
  return { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] };
}

/** "+15551234567:12345,+61400111222:678" → Map(digits → uid). Dev-only caller-ID overrides: the
 *  local DB is sanitised (every mobile is 0400000000), so demos need a way to nominate a candidate. */
function parseTestCallers(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of s.split(',')) {
    const [num, uid] = part.split(':').map((x) => x?.trim());
    const digits = (num ?? '').replace(/\D/g, '');
    const n = Number(uid);
    if (digits && Number.isInteger(n) && n > 0) out.set(digits, n);
  }
  return out;
}

export const voiceConfig = {
  enabled: flag('AIADVISOR_VOICE_ENABLED', false),
  retellApiKey: str('RETELL_API_KEY') || undefined,
  /** Retell signs webhooks with ONE specific key on the account (the one with the "webhook" badge in the
   *  dashboard) — not necessarily the key used for API calls. Set it here when they differ. */
  retellWebhookKey: str('RETELL_WEBHOOK_KEY') || str('RETELL_API_KEY') || undefined,
  /** Retell's documented alternative to signature verification: their webhook egress IP(s). DEFAULT EMPTY =
   *  signature only. When set, an UNSIGNED webhook is accepted if its real source IP (the socket peer, or
   *  the last X-Forwarded-For hop when the peer is the loopback tunnel) is listed; a PRESENT-but-invalid
   *  signature is rejected regardless of IP. See routes.ts. */
  webhookTrustedIps: str('AIADVISOR_VOICE_WEBHOOK_TRUSTED_IPS', '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Largest raw webhook body accepted (Retell's call_ended carries the full transcript). */
  webhookMaxBodyBytes: int('AIADVISOR_VOICE_WEBHOOK_MAX_BODY_BYTES', 2 * 1024 * 1024),
  retellBase: str('RETELL_API_BASE', 'https://api.retellai.com').replace(/\/$/, ''),
  /** Public https origin Retell reaches us on (the tunnel), e.g. https://water.underthetable.lol.
   *  The Custom-LLM websocket URL and webhook URL are derived from it. */
  publicBase: str('AIADVISOR_VOICE_PUBLIC_BASE').replace(/\/$/, ''),
  /** Path prefix under which the sidecar is exposed publicly (empty when it is the origin root). */
  publicPrefix: str('AIADVISOR_VOICE_PUBLIC_PREFIX').replace(/\/$/, ''),
  /** Secret path segment on the websocket URL — Retell cannot sign the WS handshake, so the URL is
   *  the shared secret; the call id is additionally validated against Retell on connect. */
  wsToken: str('AIADVISOR_VOICE_WS_TOKEN'),
  inboundAgentId: str('AIADVISOR_VOICE_INBOUND_AGENT_ID') || undefined,
  outboundAgentId: str('AIADVISOR_VOICE_OUTBOUND_AGENT_ID') || undefined,
  /** Retell voice id. Stock voice until Waterfind's cloned voice exists; then just this value changes. */
  // Noah (en-AU): the Australian ElevenLabs voice both live agents run on. (The earlier default,
  // 11labs-Adrian, is American — a `voice:setup` run with that default would have re-voiced the phone.)
  voiceId: str('AIADVISOR_VOICE_VOICE_ID', '11labs-Noah'),
  agentName: str('AIADVISOR_VOICE_AGENT_NAME', 'Waterfind Advisor'),
  /** Retell locales the agents listen for (`voice:setup` sends the list as the agent's `language`) and the
   *  languages a call may be detected as (languages.ts). English is always present and first; the default
   *  is English only. Needs a multilingual voice (the ElevenLabs ones are). The caller's language is
   *  per-call session state inferred from their speech — never stored against a client. */
  languages: parseVoiceLanguages(str('AIADVISOR_VOICE_LANGUAGES', 'en-AU')),
  get languageBases(): string[] { return [...new Set(this.languages.map(baseLang))]; },

  /** Model backend: 'api' = Messages API (needs ANTHROPIC_API_KEY; fast), 'sdk' = Claude Agent SDK on the
   *  host's Claude Code credentials (slower per turn), 'auto' = api when a key exists, else sdk. */
  backend: (str('AIADVISOR_VOICE_BACKEND', 'auto') as 'auto' | 'api' | 'sdk'),
  model: str('AIADVISOR_VOICE_MODEL', 'claude-sonnet-5'),
  sdkModel: str('AIADVISOR_VOICE_SDK_MODEL', 'sonnet'),
  maxTokens: int('AIADVISOR_VOICE_MAX_TOKENS', 400),
  maxToolRounds: int('AIADVISOR_VOICE_MAX_TOOL_ROUNDS', 6),
  turnTimeoutMs: int('AIADVISOR_VOICE_TURN_TIMEOUT_MS', 25_000),
  /** Speak a short filler when a tool call starts (the DB round-trip + second model call is a
   *  noticeable pause on a phone). Off = silence. */
  fillerEnabled: flag('AIADVISOR_VOICE_FILLER', true),
  /** Tool results are truncated to this many chars in the model context (phone answers are short;
   *  the full JSON of a holdings query is not needed twice). */
  toolResultMaxChars: int('AIADVISOR_VOICE_TOOL_RESULT_MAX_CHARS', 6000),
  historyMaxTurns: int('AIADVISOR_VOICE_HISTORY_MAX_TURNS', 40),
  personaFile: str('AIADVISOR_VOICE_PERSONA_FILE') || undefined,

  // Identity / OTP
  otpTransport: (str('AIADVISOR_VOICE_OTP_TRANSPORT', 'console') as 'console' | 'webhook'),
  /** The 'console' transport (code printed to the sidecar log) is a DEV convenience: it only delivers when
   *  this flag is on (default: on outside NODE_ENV=production). Off → console sends fail closed
   *  (transport_failed), so a production box can never "send" a code to nowhere and claim it did. */
  otpDevConsole: flag('AIADVISOR_VOICE_OTP_DEV', process.env.NODE_ENV !== 'production'),
  otpWebhookUrl: str('AIADVISOR_VOICE_OTP_WEBHOOK_URL') || undefined,
  otpWebhookSecret: str('AIADVISOR_VOICE_OTP_WEBHOOK_SECRET') || undefined,
  /** Server-side pepper mixed into the OTP hash (sha256(pepper:call:code)). Empty = unpeppered (a DB
   *  read alone then suffices to brute-force a 6-digit code offline) — warned at startup. */
  otpPepper: str('AIADVISOR_VOICE_OTP_PEPPER'),
  otpTtlSeconds: int('AIADVISOR_VOICE_OTP_TTL_SECONDS', 300),
  otpMaxAttempts: int('AIADVISOR_VOICE_OTP_MAX_ATTEMPTS', 3),
  otpMaxSendsPerCall: int('AIADVISOR_VOICE_OTP_MAX_SENDS', 3),
  otpMaxSendsPerClientHour: int('AIADVISOR_VOICE_OTP_MAX_SENDS_PER_CLIENT_HOUR', 6),
  /** Knowledge-factor (verify_caller_details) attempts: per call, and per client per hour across calls. */
  knowledgeMaxAttemptsPerCall: int('AIADVISOR_VOICE_KNOWLEDGE_MAX_ATTEMPTS', 3),
  knowledgeMaxAttemptsPerClientHour: int('AIADVISOR_VOICE_KNOWLEDGE_MAX_ATTEMPTS_PER_CLIENT_HOUR', 6),
  /** Per-tool wall clock inside a turn (a hung CRM seam must not silence the line). */
  toolTimeoutMs: int('AIADVISOR_VOICE_TOOL_TIMEOUT_MS', 20_000),
  testCallers: parseTestCallers(str('AIADVISOR_VOICE_TEST_CALLERS')),

  // Transfer / hand-off
  transferEnabled: flag('AIADVISOR_VOICE_TRANSFER_ENABLED', true),
  transferNumber: str('AIADVISOR_VOICE_TRANSFER_NUMBER') || undefined,   // broker-desk fallback (E.164)
  /** Prefer the assigned broker's business number from the CRM as the transfer target. */
  transferToAssignedBroker: flag('AIADVISOR_VOICE_TRANSFER_TO_BROKER', true),

  // Outbound
  outboundEnabled: flag('AIADVISOR_VOICE_OUTBOUND_ENABLED', false),   // the DIALER kill switch
  fromNumber: str('AIADVISOR_VOICE_FROM_NUMBER') || undefined,        // E.164 caller-ID (blocked until a number exists)
  /** The carrier SIP trunk the number lives on (Retell sells no AU numbers; ours is a Twilio AU mobile on an
   *  Elastic SIP trunk). Only `voice:setup -- --import` reads these; the sidecar never dials SIP itself. */
  sipTerminationUri: str('AIADVISOR_VOICE_SIP_TERMINATION_URI') || undefined,   // e.g. waterfind.pstn.sydney.twilio.com
  sipUsername: str('AIADVISOR_VOICE_SIP_USERNAME') || undefined,
  sipPassword: str('AIADVISOR_VOICE_SIP_PASSWORD') || undefined,
  outboundWebhookSecret: str('AIADVISOR_VOICE_OUTBOUND_WEBHOOK_SECRET') || undefined,
  outboundOnOrder: flag('AIADVISOR_VOICE_OUTBOUND_ON_ORDER', false),  // integrated trigger: order placed → confirmation call
  outboundPollMs: int('AIADVISOR_VOICE_OUTBOUND_POLL_MS', 30_000),
  outboundDailyCapPerClient: int('AIADVISOR_VOICE_OUTBOUND_DAILY_CAP', 2),
  outboundMaxAttempts: int('AIADVISOR_VOICE_OUTBOUND_MAX_ATTEMPTS', 2),
  /** Destination country codes the dialer may call. AU (61) always; extra codes via env, e.g. "64,1". */
  outboundAllowedCountryCodes: ['61', ...str('AIADVISOR_VOICE_OUTBOUND_COUNTRY_CODES').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean)],
  /** Extra numbers an outbound payload may name as "call back on" (E.164). The from/transfer numbers
   *  and the company phone are always allowed; anything else in a payload is rejected. */
  callbackNumberAllowlist: str('AIADVISOR_VOICE_CALLBACK_NUMBERS').split(',').map((s) => s.trim()).filter(Boolean),
  /** Call campaigns (the CRM "Call Campaigns" page): default calls-in-flight per campaign, and how often
   *  the feeder paces the next members of a running campaign into the outbound queue. */
  campaignMaxConcurrent: int('AIADVISOR_VOICE_CAMPAIGN_MAX_CONCURRENT', 3),
  campaignPollMs: int('AIADVISOR_VOICE_CAMPAIGN_POLL_MS', 15_000),
  callingHours: parseHours(str('AIADVISOR_VOICE_CALL_HOURS', '09:00-20:00')),
  callingWeekdaysOnly: flag('AIADVISOR_VOICE_CALL_WEEKDAYS_ONLY', false),
  timezone: str('AIADVISOR_VOICE_TZ', 'Australia/Sydney'),
  /** Retell voicemail message for outbound calls (no account data, ever). */
  voicemailMessage: str('AIADVISOR_VOICE_VOICEMAIL_MESSAGE',
    'Hello, this is the Waterfind assistant. Sorry we missed you. Please call Waterfind on 1800 890 285 when convenient. Goodbye.'),

  // Demo (browser web-calls; no phone number needed)
  demoEnabled: flag('AIADVISOR_VOICE_DEMO', false),
  demoKey: str('AIADVISOR_VOICE_DEMO_KEY') || undefined,

  retentionDays: int('AIADVISOR_VOICE_RETENTION_DAYS', 0),
  /** Where the persona/prompt says "Waterfind's number" for callbacks. */
  companyPhoneSpoken: str('AIADVISOR_VOICE_COMPANY_PHONE', '1800 890 285'),

  get llmWebsocketUrl(): string | null {
    if (!this.publicBase || !this.wsToken) return null;
    const wss = this.publicBase.replace(/^http/, 'ws');
    return `${wss}${this.publicPrefix}/voice/llm/${this.wsToken}`;
  },
  get webhookUrl(): string | null {
    if (!this.publicBase) return null;
    return `${this.publicBase}${this.publicPrefix}/voice/webhooks/retell`;
  },
  /** Reads through to the main config so the voice module has one import for shared values. */
  get anthropicApiKey() { return config.anthropicApiKey; },
  get effectiveBackend(): 'api' | 'sdk' {
    if (this.backend === 'api' || this.backend === 'sdk') return this.backend;
    return this.anthropicApiKey ? 'api' : 'sdk';
  },
};

export type VoiceConfig = typeof voiceConfig;

/** Capability summary for /voice/health and the demo page (no secrets). */
export function voiceCapabilities() {
  return {
    enabled: voiceConfig.enabled,
    retell_key: !!voiceConfig.retellApiKey,
    // The websocket URL embeds the shared secret — never published; only ws_configured is. The webhook
    // URL names the public origin: also kept off the (unauthenticated) health surface.
    ws_configured: !!voiceConfig.llmWebsocketUrl,
    webhook_configured: !!voiceConfig.webhookUrl,
    webhook_signature_key: !!voiceConfig.retellWebhookKey,
    webhook_trusted_ips: voiceConfig.webhookTrustedIps.length,
    inbound_agent: !!voiceConfig.inboundAgentId,
    outbound_agent: !!voiceConfig.outboundAgentId,
    outbound_dialer: voiceConfig.outboundEnabled && !!voiceConfig.fromNumber,
    from_number: !!voiceConfig.fromNumber,
    transfer: voiceConfig.transferEnabled && (voiceConfig.transferToAssignedBroker || !!voiceConfig.transferNumber),
    otp_transport: voiceConfig.otpTransport,
    backend: voiceConfig.effectiveBackend,
    model: voiceConfig.effectiveBackend === 'api' ? voiceConfig.model : voiceConfig.sdkModel,
    voice_id: voiceConfig.voiceId,
    languages: voiceConfig.languages,
    demo: voiceConfig.demoEnabled,
  };
}
