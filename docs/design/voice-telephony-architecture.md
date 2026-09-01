# Voice telephony architecture — decision memo (Workstream F)

Status: proposal, decision-ready. Scope: Tom Rooney's V1–V3 (inbound calls, outbound engagement,
caller authentication). These are **out of local scope** — they need Waterfind infrastructure,
account, and policy decisions that cannot be made or provisioned in this repo. The in-app half of
Workstream F (spoken replies + hands-free voice mode in the web advisor) is **already built**; this
memo covers the phone channel only.

Companion: the built web voice mode is documented in `services/ai-advisor/README.md` (Voice) and
reuses the same sidecar agent, streaming STT (`/transcribe`, OpenAI gpt-4o-mini-transcribe) and TTS
(`/tts`, OpenAI gpt-4o-mini-tts) this memo would put behind a phone line.

## What V1–V3 mean here

| Ref | Tom's words | Phone-channel meaning |
|---|---|---|
| V1 | Receive inbound customer calls | A Waterfind number answered by the advisor agent, not (only) a person. |
| V2 | Outbound customer engagement | Agent-placed courtesy/notice calls (e.g. allocation announcement, order filled). |
| V3 | Authenticate customers where appropriate | Prove who is on the line before any account-specific data or action. |

## Candidate architecture

Programmable-voice provider (SIP trunk / Twilio-style) bridges a PSTN call to a **media stream** that
the existing sidecar agent drives with streaming STT and TTS. One agent, two front doors (web +
phone); the phone path adds only a telephony bridge and a call-session layer.

```
Caller (PSTN)
  → Provider programmable voice (number, SIP/WebRTC, call recording, DTMF)
    ↔ media stream (bidirectional audio)
      → Telephony bridge (new): streaming STT in, streaming TTS out, barge-in, turn detection
        → AI advisor sidecar (same agent, same tenant-scoped tools, same order-confirm rules)
        → Human handoff: warm transfer to the assigned broker (SIP REFER / dial-out + whisper)
```

Design constraints carried over from the web advisor, unchanged on the phone:
- The agent still only **prepares** orders; execution needs an explicit confirmation. On a call this
  must be a spoken read-back + an affirmative confirmation (and, for anything material, a follow-up
  to the confirm-card path — never a model-only trade). Voice adds no new execution authority.
- Tenant scoping / RLS and the "information, not personal advice" framing are identical to chat.
- STT/TTS keys stay server-side; the provider handles PSTN, not the model keys.

Streaming (not the batch `/transcribe` + `/tts` used by the web page) is required for acceptable
call latency and **barge-in** (caller interrupts the agent). Provider-native STT/TTS or a streaming
model tier is the realistic path; the web endpoints prove the agent wiring but are turn-batched.

## What Waterfind must decide / provision

| Item | Decision needed | Notes |
|---|---|---|
| Provider | Programmable-voice vendor + account | AU presence / data location; SIP or CPaaS; procurement + billing owner. |
| Numbers | Inbound number(s); outbound caller-ID | Local AU numbering; distinct line for the AI vs. the broker desk. |
| Call recording | Record calls? retention period? storage location | AU all-party consent (below); recordings are personal information under the Privacy Act. |
| Consent script | Wording of the recording + AI-disclosure preamble | Must state it is an automated assistant and that the call is recorded, before capture. |
| Hours / overflow | When the AI answers vs. rolls to a human or voicemail | Business-hours policy; after-hours behaviour; queue/callback. |
| Handoff policy | When the AI must transfer, and to whom | Default: the client's assigned broker; fallback: broker desk queue. |
| Authentication bar | Which actions require which factor (see V3) | Read-only market info vs. account data vs. order actions. |
| Outbound consent | Basis for placing outbound calls | Existing-client relationship, DNC rules, opt-out handling. |

## Caller authentication (V3)

Recommendation: **knowledge + one-time-passcode (OTP) factors. Do NOT use voice biometrics.**

| Factor | Recommendation | Rationale |
|---|---|---|
| OTP to the client's registered mobile/email | **Recommend** (primary) | Possession factor; ties the caller to a channel already on file; cheap, revocable. |
| Knowledge (recent trade, account/licence detail, registered identifiers) | **Recommend** (step-up / low-risk) | Good for gating read-only account data; pair with OTP before any action. |
| Voice biometric ("your voice is your password") | **Recommend against** | Voice cloning from a few seconds of audio is now trivial; a spoofable biometric is worse than none because it invites over-trust. At most a **passive fraud signal**, never an auth factor. |
| Human callback to the number on file | Recommend as fallback | For high-value/complex or when OTP is unavailable. |

Tiering: market/general information needs no auth; account-specific data needs OTP (or strong
knowledge); any order or account change needs OTP **and** the same explicit confirmation the chat
path enforces. Failed auth degrades to general information or a warm transfer — never silent denial.

## Human handoff (warm transfer)

Escalation is a durable action, not a dead end. Reuse Workstream D's `escalate_to_broker` mechanism
so the phone and chat channels leave the same record.

| Element | Design |
|---|---|
| Trigger | Out-of-scope request, complex matter, explicit "talk to a person", or failed auth on a sensitive ask. |
| Target | The client's **assigned broker**; fallback to the broker-desk queue. |
| Transfer style | **Warm** — bridge/whisper a short context summary to the broker before connecting the caller (avoid a cold "start over"). SIP REFER or dial-out + conference. |
| Record | Write the escalation record + call summary via the same durable structure Workstream D adds (broker-visible task/note), so follow-up is tracked and the client is told who will call back. |
| Fallback | If no broker is available, capture a callback request against the account and confirm the callback window to the caller. |

## Staged rollout

Outbound, tightly-scripted first (lower risk: known recipient, bounded purpose, no inbound auth
surface); inbound later once auth, recording/consent, and handoff are proven.

| Stage | Scope | Gate to advance |
|---|---|---|
| 0 | Web voice mode (built) + this memo signed off | Provider + number + consent script chosen. |
| 1 | **Outbound courtesy calls** — scripted notices (allocation announced, order filled), opt-out honoured, no account changes on-call | Consent/DNC basis confirmed; recording + retention live; escalation-to-broker works. |
| 2 | **Inbound, read-only** — market/general info, OTP before any account data, no order actions | Auth tiering + warm transfer validated in stage 1/2. |
| 3 | **Inbound, transactional** — order prepare + spoken confirm bridged to the confirm path; step-up auth mandatory | Compliance sign-off on voice order confirmation as a record. |

## Open decisions for Waterfind (asks)

1. Programmable-voice provider + AU account, and who owns procurement/billing.
2. Inbound number(s) and outbound caller-ID; separate AI vs. broker-desk lines.
3. Call-recording policy: record or not, retention, storage location, and the consent/AI-disclosure
   preamble wording (AU all-party consent).
4. Authentication bar per action tier — sign-off that OTP + knowledge (not voice biometrics) is the
   standard.
5. Hours/overflow and handoff policy: when the AI answers, and the broker/queue it transfers to.
6. Legal basis + opt-out handling for outbound calls (existing-client relationship, DNC).
