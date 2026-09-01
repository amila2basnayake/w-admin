/**
 * Provision (or update) the two Retell agents that front the phone assistant — inbound and outbound —
 * pointing at this sidecar's Custom-LLM websocket and webhook. Idempotent: with agent ids in .env it
 * updates them; without, it creates them and prints the env lines to add.
 *
 *   npm run voice:setup                 # create/update both agents
 *   npm run voice:setup -- --reader     # create/update the WEB READER agent (browser read-aloud in the phone voice)
 *   npm run voice:setup -- --voices     # list Retell voice ids (pick one for AIADVISOR_VOICE_VOICE_ID)
 *   npm run voice:setup -- --numbers    # list phone numbers on the Retell account
 *   npm run voice:setup -- --import +61… # register the carrier (Twilio SIP trunk) number with Retell and bind both agents
 *   npm run voice:setup -- --bind +61… # (re)bind an imported number: inbound → inbound agent, outbound → outbound agent
 *
 * Needs RETELL_API_KEY, AIADVISOR_VOICE_PUBLIC_BASE and AIADVISOR_VOICE_WS_TOKEN in .env; --import also needs
 * AIADVISOR_VOICE_SIP_TERMINATION_URI (+ _USERNAME/_PASSWORD when the trunk uses credential auth).
 */
import { voiceConfig } from '../voice/config';
import { readerConfig } from '../voice/reader';
import { retell, retellAt, RetellError, type AgentWeight } from '../voice/retell';
import { isE164 } from '../voice/phone';
import { retellLanguageField } from '../voice/languages';

/**
 * The web reader agent: the same voice as the phone agents, but it only ever reads what the sidecar
 * hands it — never interrupted, no backchannel, no nudges, and Retell keeps nothing (the text is the
 * client's own chat, already stored by us). See src/voice/reader.ts.
 */
function readerBody(): Record<string, unknown> {
  const ws = readerConfig.websocketUrl;
  if (!ws) throw new Error('AIADVISOR_VOICE_PUBLIC_BASE and AIADVISOR_VOICE_WS_TOKEN must be set (they form the websocket URL)');
  return {
    agent_name: `${voiceConfig.agentName} (web reader)`,
    response_engine: { type: 'custom-llm', llm_websocket_url: ws },
    voice_id: voiceConfig.voiceId,
    language: 'en-AU',
    webhook_url: voiceConfig.webhookUrl,
    enable_backchannel: false,
    interruption_sensitivity: 0,          // "agent would never be interrupted"
    responsiveness: 1,
    reminder_trigger_ms: 600_000,
    reminder_max_count: 1,
    end_call_after_silence_ms: 120_000,   // a reply can pause while the model thinks; only a dead session should time out
    max_call_duration_ms: 10 * 60_000,
    normalize_for_speech: true,
    opt_out_sensitive_data_storage: true,
    allow_user_dtmf: false,
    // No post-call analysis: by default it is a flat 1.5c GPT-4.1 charge per call
    // ("gpt_4_1_text_testing" on the invoice) that dominated short reads (a 16 s read: 2.5c of speech
    // + 1.5c of analysis), and a reader has nothing to analyse. `null` is treated as "default"
    // (measured 2026-08-27: the charge stayed); the nano model with NO analysis fields makes the
    // line disappear entirely (measured: 15.8 s read = 2.53c = the bare per-second rate).
    post_call_analysis_model: 'gpt-4.1-nano',
    post_call_analysis_data: [],
    // Keep only basic attributes of the call at Retell (no transcript/audio of what was read).
    data_storage_setting: 'basic_attributes_only',
  };
}

async function upsertReader(): Promise<string> {
  const existing = readerConfig.agentId;
  const body = readerBody();
  const rt = retellAt(readerConfig.retellBase);   // the reader's Retell (may differ from the phone channel's)
  if (existing) {
    const r = await rt.updateAgent(existing, body);
    console.log(`updated web reader agent ${r.agent_id}${r.version != null ? ` (v${r.version})` : ''}  voice=${voiceConfig.voiceId}`);
    return r.agent_id;
  }
  const r = await rt.createAgent(body);
  console.log(`created web reader agent ${r.agent_id}  voice=${voiceConfig.voiceId}`);
  return r.agent_id;
}

const BOOSTED = [
  'Waterfind', 'megalitre', 'megalitres', 'gigalitre', 'allocation', 'entitlement', 'carryover', 'high security', 'general security',
  'high reliability', 'low reliability', 'water share', 'delivery share', 'Goulburn', 'Murrumbidgee', 'Murray', 'Barmah', 'Campaspe',
  'Loddon', 'Lachlan', 'Macquarie', 'Namoi', 'Gwydir', 'Border Rivers', 'inter-valley transfer', 'trade zone', 'Hume', 'Dartmouth',
  'Menindee', 'Basin Plan', 'MDBA', 'WaterNSW', 'Goulburn-Murray Water', 'SA Water', 'customer number', 'ABN',
];

function common(kind: 'inbound' | 'outbound') {
  const ws = voiceConfig.llmWebsocketUrl;
  if (!ws) throw new Error('AIADVISOR_VOICE_PUBLIC_BASE and AIADVISOR_VOICE_WS_TOKEN must be set (they form the websocket URL)');
  const body: Record<string, unknown> = {
    agent_name: `${voiceConfig.agentName} (${kind})`,
    response_engine: { type: 'custom-llm', llm_websocket_url: ws },
    voice_id: voiceConfig.voiceId,
    // One locale, or the AIADVISOR_VOICE_LANGUAGES list for a multilingual agent (speech recognition then
    // follows whichever of them the caller speaks; the language itself is detected per call in languages.ts).
    language: retellLanguageField(voiceConfig.languages),
    webhook_url: voiceConfig.webhookUrl,
    enable_backchannel: true,
    interruption_sensitivity: 0.7,
    responsiveness: 0.9,
    boosted_keywords: BOOSTED,
    end_call_after_silence_ms: 45_000,
    // Silence handling: after 12 s of no reply we get a reminder_required turn ("are you still there?"), at most twice.
    reminder_trigger_ms: 12_000,
    reminder_max_count: 2,
    max_call_duration_ms: 20 * 60_000,
    normalize_for_speech: true,
    // Transcripts and recordings are what our outcome logging and (later) call notes are built on.
    opt_out_sensitive_data_storage: false,
  };
  if (kind === 'outbound') {
    // Voicemail: a generic message, never account data (the model never speaks to a machine).
    body.voicemail_option = { action: { type: 'static_text', text: voiceConfig.voicemailMessage } };
  }
  return body;
}

async function upsertAgent(kind: 'inbound' | 'outbound'): Promise<string> {
  const existing = kind === 'inbound' ? voiceConfig.inboundAgentId : voiceConfig.outboundAgentId;
  const body = common(kind);
  if (existing) {
    const r = await retell.updateAgent(existing, body);
    console.log(`updated ${kind} agent ${r.agent_id}${r.version != null ? ` (v${r.version})` : ''}`);
    return r.agent_id;
  }
  const r = await retell.createAgent(body);
  console.log(`created ${kind} agent ${r.agent_id}`);
  return r.agent_id;
}

/** Both agents at weight 1 — the shape Retell's phone-number endpoints take (older `inbound_agent_id` fields are gone). */
function agentBindings(): { inbound_agents: AgentWeight[]; outbound_agents: AgentWeight[] } {
  if (!voiceConfig.inboundAgentId || !voiceConfig.outboundAgentId) throw new Error('set both agent ids in .env first (run voice:setup)');
  return {
    inbound_agents: [{ agent_id: voiceConfig.inboundAgentId, weight: 1 }],
    outbound_agents: [{ agent_id: voiceConfig.outboundAgentId, weight: 1 }],
  };
}

/** First agent id of a number's binding, whichever response shape Retell returns. */
function boundAgent(n: any, dir: 'inbound' | 'outbound'): string {
  return n?.[`${dir}_agents`]?.[0]?.agent_id ?? n?.[`${dir}_agent_id`] ?? '-';
}

function numberArg(args: string[], flag: string): string {
  const v = args[args.indexOf(flag) + 1];
  if (!v || !isE164(v)) throw new Error(`${flag} needs an E.164 phone number, e.g. +61412345678`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  if (!voiceConfig.retellApiKey) { console.error('RETELL_API_KEY is not set'); process.exit(2); }
  try {
    if (args.includes('--reader')) {
      const id = await upsertReader();
      console.log('websocket:', String(readerConfig.websocketUrl).replace(/\/voice\/reader\/[^/]+$/, '/voice/reader/<AIADVISOR_VOICE_WS_TOKEN>'));
      if (id !== readerConfig.agentId) {
        console.log('\nAdd to services/ai-advisor/.env and restart the sidecar:');
        console.log(`AIADVISOR_VOICE_READER_AGENT_ID=${id}`);
        console.log('AIADVISOR_WEB_READER=retell      # the switch; remove (or =openai) to revert every surface to the OpenAI reader');
      }
      return;
    }
    if (args.includes('--voices')) {
      const voices = await retell.listVoices();
      for (const v of voices) console.log(`${String(v.voice_id).padEnd(28)} ${String(v.voice_name ?? '').padEnd(18)} ${v.provider ?? ''} ${v.gender ?? ''} ${v.accent ?? ''}`);
      return;
    }
    if (args.includes('--numbers')) {
      const nums = await retell.listPhoneNumbers();
      for (const n of nums) console.log(`${n.phone_number}  inbound→${boundAgent(n, 'inbound')}  outbound→${boundAgent(n, 'outbound')}  ${n.sip_outbound_trunk_config?.termination_uri ?? n.phone_number_type ?? ''}  ${n.nickname ?? ''}`);
      if (!nums.length) console.log('(no numbers on the account — buy one on the carrier, then: npm run voice:setup -- --import +61…; see docs/design/voice-calls-design.md §11)');
      return;
    }
    if (args.includes('--import')) {
      const number = numberArg(args, '--import');
      const termination_uri = voiceConfig.sipTerminationUri;
      if (!termination_uri) throw new Error('AIADVISOR_VOICE_SIP_TERMINATION_URI is not set (the trunk\'s localised termination URI, e.g. waterfind.pstn.sydney.twilio.com)');
      if (/\s/.test(termination_uri)) throw new Error('AIADVISOR_VOICE_SIP_TERMINATION_URI contains whitespace');
      if (!!voiceConfig.sipUsername !== !!voiceConfig.sipPassword) throw new Error('set both AIADVISOR_VOICE_SIP_USERNAME and _PASSWORD, or neither (IP-ACL trunk)');
      const r = await retell.importPhoneNumber({
        phone_number: number,
        termination_uri,
        ...(voiceConfig.sipUsername ? { sip_trunk_auth_username: voiceConfig.sipUsername, sip_trunk_auth_password: voiceConfig.sipPassword } : {}),
        nickname: voiceConfig.agentName,
        ...agentBindings(),
      });
      console.log(`imported ${r.phone_number ?? number} via ${termination_uri}${voiceConfig.sipUsername ? ' (credential auth)' : ' (IP ACL)'}: inbound → ${voiceConfig.inboundAgentId}, outbound → ${voiceConfig.outboundAgentId}`);
      if (voiceConfig.fromNumber !== number) {
        console.log('\nAdd to services/ai-advisor/.env and restart the sidecar:');
        console.log(`AIADVISOR_VOICE_FROM_NUMBER=${number}`);
      }
      return;
    }
    if (args.includes('--bind')) {
      const number = numberArg(args, '--bind');
      await retell.updatePhoneNumber(number, agentBindings());
      console.log(`bound ${number}: inbound → ${voiceConfig.inboundAgentId}, outbound → ${voiceConfig.outboundAgentId}`);
      return;
    }
    const inbound = await upsertAgent('inbound');
    const outbound = await upsertAgent('outbound');
    // The websocket URL embeds the shared secret token — printed redacted.
    console.log('\nwebsocket:', String(voiceConfig.llmWebsocketUrl).replace(/\/voice\/llm\/[^/]+$/, '/voice/llm/<AIADVISOR_VOICE_WS_TOKEN>'));
    console.log('webhook:  ', voiceConfig.webhookUrl);
    if (inbound !== voiceConfig.inboundAgentId || outbound !== voiceConfig.outboundAgentId) {
      console.log('\nAdd to services/ai-advisor/.env and restart the sidecar:');
      console.log(`AIADVISOR_VOICE_INBOUND_AGENT_ID=${inbound}`);
      console.log(`AIADVISOR_VOICE_OUTBOUND_AGENT_ID=${outbound}`);
    }
  } catch (e: any) {
    if (e instanceof RetellError) { console.error(`${e.message}\n${JSON.stringify(e.body, null, 2)}`); process.exit(1); }
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
