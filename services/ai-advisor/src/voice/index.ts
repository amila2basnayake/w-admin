// Voice module entry: mount the HTTP routes, attach the Retell websocket to the HTTP server, and start
// the background jobs (outbound dialer + order trigger, session/retention sweeps). Everything is a
// no-op unless AIADVISOR_VOICE_ENABLED=1, except /voice/health which always answers (so ops can see
// WHY it is off).
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { voiceConfig, voiceCapabilities } from './config';
import { voiceRouter } from './routes';
import { attachVoiceWebSocket } from './ws';
import { attachReaderWebSocket, readerInfo } from './reader';
import { startOutboundJobs, stopOutboundJobs } from './outbound';
import { startCampaignJobs, stopCampaignJobs } from './campaigns';
import { sweepSessions } from './session';
import { validateVoiceToolAllowlists } from './tools';
import * as store from './store';

export { voiceConfig, voiceCapabilities };
export { readerRouter, readerInfo, readerEnabled } from './reader';

/** Mounts /voice. Every route except GET /voice/health answers 404 while voice is disabled (routes.ts). */
export function mountVoiceRoutes(app: Express): void {
  app.use('/voice', voiceRouter);
}

let sweeper: NodeJS.Timeout | null = null;

export function startVoice(server: HttpServer): void {
  if (!voiceConfig.enabled) {
    console.log('[voice] disabled (AIADVISOR_VOICE_ENABLED != 1)');
    return;
  }
  // Fail fast on a code bug: an allowlisted tool name that resolves to nothing would silently vanish
  // from the phone agent.
  validateVoiceToolAllowlists();
  if (voiceConfig.effectiveBackend === 'sdk') console.warn('[voice] no ANTHROPIC_API_KEY — using the Agent SDK backend (host Claude Code credentials; slower per turn). Set a key for the Messages API path.');
  if (!voiceConfig.wsToken) console.warn('[voice] AIADVISOR_VOICE_WS_TOKEN is not set — the Retell websocket endpoint is closed');
  if (voiceConfig.otpTransport === 'console') {
    if (voiceConfig.otpDevConsole) console.warn('[voice] OTP transport is CONSOLE (codes are printed to this log) — dev only; set AIADVISOR_VOICE_OTP_TRANSPORT=webhook for real calls');
    else console.warn('[voice] OTP transport is console but AIADVISOR_VOICE_OTP_DEV is off — every code send will FAIL (transport_failed); set AIADVISOR_VOICE_OTP_TRANSPORT=webhook');
  } else if (!voiceConfig.otpWebhookUrl) {
    console.warn('[voice] OTP transport is webhook but AIADVISOR_VOICE_OTP_WEBHOOK_URL is unset — every code send will FAIL (transport_failed)');
  }
  if (!voiceConfig.otpPepper) console.warn('[voice] AIADVISOR_VOICE_OTP_PEPPER is unset — OTP hashes are unpeppered (set a random secret)');
  if (!voiceConfig.retellWebhookKey && !voiceConfig.webhookTrustedIps.length) console.warn('[voice] no RETELL_WEBHOOK_KEY and no trusted webhook IPs — every Retell webhook will be rejected');
  attachVoiceWebSocket(server);
  // The web reader's own custom-LLM socket (/voice/reader/<token>/<call_id>) — answers only while
  // AIADVISOR_WEB_READER=retell; otherwise the route 404s and the browsers use the OpenAI reader.
  attachReaderWebSocket(server);
  const rd = readerInfo();
  console.log(`[voice] web reader: ${rd.mode}${rd.requested === 'retell' && rd.mode !== 'retell' ? ' (retell requested but not configured — needs a reader agent id, the Retell key, public base + ws token)' : ''}${rd.mode === 'retell' ? ` voice=${rd.voice}` : ''}`);
  startOutboundJobs();
  startCampaignJobs();   // paces running campaigns into the outbound queue (campaigns.ts)
  sweeper = setInterval(async () => {
    sweepSessions();
    try { const n = await store.sweepStaleCalls(); if (n) console.log(`[voice] closed ${n} stale calls (no end webhook)`); }
    catch (e: any) { console.error('[voice] stale-call sweep failed:', e?.message ?? e); }
    try { const n = await store.sweepRetention(); if (n) console.log(`[voice] retention: blanked ${n} transcripts`); }
    catch (e: any) { console.error('[voice] retention sweep failed:', e?.message ?? e); }
  }, 30 * 60_000);
  sweeper.unref?.();
  const caps = voiceCapabilities();
  console.log(`[voice] enabled  ws=${caps.ws_configured ? 'configured' : '(unset)'}  webhook=${caps.webhook_configured ? 'configured' : '(unset)'} (sig_key=${caps.webhook_signature_key ? 'set' : 'UNSET'}, trusted_ips=${caps.webhook_trusted_ips})  backend=${caps.backend} model=${caps.model}  outbound_dialer=${caps.outbound_dialer ? 'ARMED' : 'off'}`);
}

export function stopVoice(): void {
  stopOutboundJobs();
  stopCampaignJobs();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
