import express, { type Response } from 'express';
import cors from 'cors';
import { config } from './config';
import { requireAuth, type AuthedRequest } from './auth';
import { runAdvisor } from './advisor';
import { resolveCallerContext, isAdvisorEnabled } from './data-db';
import { WF_TOOL_NAMES } from './data-tools';
import { outlookFreshness } from './climate-outlook';
import { startRefreshScheduler, refreshStatus } from './refresh-scheduler';
import { startKbRefreshScheduler, kbRefreshStatus } from './trainer/refresh/scheduler';
import {
  NotFound,
  listConversations, createConversation, getOwnedConversation,
  renameConversation, setArchived, deleteConversation, setSessionId,
  listMessages, addMessage, deactivateFrom, searchConversations,
  getSettings, putSettings, type Message,
  getAssistConversation, listAssistConversations, createAssistConversation,
  renameAssistConversation, deleteAssistConversation, listAssistMessages,
  listClientOwnConversations, listClientOwnMessages,
} from './conversations';
import { staffAccessDenial, StaffLookupFailed } from './staff';
import {
  listProjects, createProject, getOwnedProject, updateProject, deleteProject,
  assignConversationProject, projectForConversation,
} from './projects';
import {
  listOrders, confirmPendingOrder, cancelPendingOrder, reconcileUnknownOrders, getOwnedPendingOrder,
  listEscalations, confirmEscalation, declineEscalation, cancelEscalation,
  sessionEpoch, bumpSessionEpoch, ScopeViolation, type PendingOrder, type Escalation,
} from './brokerage';
import {
  validateUpload, insertAttachment, getOwnedAttachment, sweepUnboundAttachments,
  assertUnboundHeadroom, claimAttachments, bindAttachments, attachmentsForMessages,
  loadAttachmentData, attachmentBlocks, publicMeta,
  BadAttachment, selectPromptEmbeds,
  type AttachmentMeta, type AttachmentRow, type PromptBlock,
} from './attachments';
import { insertFeedback } from './feedback';
import { questionsFor } from './default-questions';
import { titleConversationAsync } from './titler';
import { trainerRouter } from './trainer/routes';
import { transcribeAudio, transcribeEnabled, TranscribeError } from './transcribe';
import { attachTranscribeStream } from './transcribe-stream';
import { StreamRedactor, redactFinal } from './output-guard';
import { synthesizeSpeech, ttsEnabled, ttsInfo, TtsError } from './tts';
import { recordSpend } from './spend';
import { startRetentionSweep as startCallNoteRetentionSweep } from './call-notes/jobs';
import { startAutoCallNotes } from './call-notes/auto';
import { callNotesRouter } from './call-notes/routes';
import { mountVoiceRoutes, startVoice, stopVoice, readerRouter, readerInfo, readerEnabled } from './voice';

const app = express();
app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'X-Filename'] }));
const jsonParser = express.json({ limit: '256kb' });
// Uploads and audio clips are raw bodies — keep the JSON parser away even if a client mislabels one.
const RAW_BODY_POSTS = new Set(['/attachments', '/transcribe', '/trainer/uploads', '/voice/webhooks/retell']);
// The trainer router parses its own JSON (larger limit; long library documents) — skip it here.
app.use((req, res, next) => ((req.method === 'POST' && RAW_BODY_POSTS.has(req.path)) || req.path.startsWith('/trainer/') ? next() : jsonParser(req, res, next)));

// ---- helpers ---------------------------------------------------------------

function pid(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFound('bad id');
  return n;
}

function deriveTitle(seed: string): string {
  const s = (seed || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'New chat';
  if (s.length <= 48) return s;
  // Cut on a word boundary so the sidebar shows whole words, not a mid-word ellipsis.
  const cut = s.slice(0, 48);
  const sp = cut.lastIndexOf(' ');
  return (sp > 24 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—–-]+$/, '') + '…';
}

function formatFreshPrompt(messages: Message[]): string {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
  const lines = ['Here is our conversation so far. Continue as the advisor and respond to the FINAL user message.\n'];
  for (const m of messages) {
    if (m.role === 'system') lines.push(`[System note — authoritative order event]: ${m.content}`);
    else lines.push(`${m.role === 'assistant' ? 'Advisor' : 'User'}: ${m.content}`);
  }
  return lines.join('\n\n');
}

function attachmentIdsOf(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Content for one turn's new user message: attachment blocks first, then the text. */
function turnContent(message: string, atts: AttachmentRow[]): string | PromptBlock[] {
  if (!atts.length) return message;
  return [
    ...atts.flatMap((a) => attachmentBlocks(a, a.data)),
    { type: 'text' as const, text: message || '(The user attached the file(s) above without any accompanying text.)' },
  ];
}

/**
 * Fresh-session prompt (first turn / edit / regenerate / post-order rebuild). Falls back to the
 * plain string transcript when no active message has attachments. The CURRENT turn's attachments
 * are always embedded in full; OLDER history is re-embedded newest-first within a byte budget and
 * whatever doesn't fit becomes a named placeholder — and only the embedded attachments' bytes are
 * ever loaded from the DB. (messages is oldest -> newest, so the last entry is the current turn.)
 */
async function formatFreshPromptContent(userId: number, messages: Message[]): Promise<string | PromptBlock[]> {
  const attMap = await attachmentsForMessages(messages.map((m) => m.id), userId);
  if (attMap.size === 0) return formatFreshPrompt(messages);

  const embed = selectPromptEmbeds(messages.map((m) => attMap.get(m.id) ?? []));
  const data = await loadAttachmentData([...embed], userId);
  const blocksFor = (atts: AttachmentMeta[]) =>
    atts.flatMap((a) => attachmentBlocks(a, data.get(a.id) ?? null));

  if (messages.length === 1 && messages[0].role === 'user') {
    const atts = attMap.get(messages[0].id) ?? [];
    return [
      ...blocksFor(atts),
      { type: 'text' as const, text: messages[0].content || '(The user attached the file(s) above without any accompanying text.)' },
    ];
  }

  const blocks: PromptBlock[] = [];
  let buf: string[] = ['Here is our conversation so far. Continue as the advisor and respond to the FINAL user message.'];
  const flush = () => { if (buf.length) { blocks.push({ type: 'text', text: buf.join('\n\n') }); buf = []; } };
  for (const m of messages) {
    if (m.role === 'system') { buf.push(`[System note — authoritative order event]: ${m.content}`); continue; }
    buf.push(`${m.role === 'assistant' ? 'Advisor' : 'User'}: ${m.content}`);
    const atts = attMap.get(m.id) ?? [];
    if (atts.length) {
      buf.push(`(attached to the user message above:)`);
      flush();
      blocks.push(...blocksFor(atts));
    }
  }
  flush();
  return blocks;
}

// simple async wrapper for JSON routes -> maps NotFound to 404
function jh(fn: (req: AuthedRequest, res: Response) => Promise<void>) {
  return (req: AuthedRequest, res: Response) => {
    fn(req, res).catch((e) => {
      if (e instanceof NotFound) res.status(404).json({ error: 'not found' });
      else if (e instanceof BadAttachment) res.status(400).json({ error: e.message });
      else if (e instanceof TranscribeError) res.status(e.status).json({ error: e.message });
      else if (e instanceof TtsError) res.status(e.status).json({ error: e.message });
      else { console.error('route error:', e); res.status(500).json({ error: 'internal error' }); }
    });
  };
}

function sse(res: Response, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// per-user in-flight cap
const inflight = new Map<number, number>();
function acquire(userId: number): boolean {
  const n = inflight.get(userId) ?? 0;
  if (n >= config.maxConcurrencyPerUser) return false;
  inflight.set(userId, n + 1);
  return true;
}
function release(userId: number) {
  const n = inflight.get(userId) ?? 1;
  if (n <= 1) inflight.delete(userId); else inflight.set(userId, n - 1);
}

// One turn per conversation at a time. Two concurrent turns would resume the same SDK session and
// interleave — the user-visible symptom is "the agent ran twice". 409 the second request instead.
const activeConvTurns = new Set<number>();
function acquireConv(convId: number, res: Response): boolean {
  if (activeConvTurns.has(convId)) {
    res.status(409).json({ error: 'turn_in_progress', message: 'A reply is already being generated for this conversation.' });
    return false;
  }
  activeConvTurns.add(convId);
  return true;
}

/** Stream one advisor turn to the client and persist the assistant message.
 *  `onSettled` fires the moment the turn's outcome is final (response ended) — BEFORE the SDK
 *  generator's teardown, which can take seconds. Callers release the per-user and per-conversation
 *  locks there, so a follow-up sent right after `done` is not 409'd by a lock held through teardown. */
/** Broker-assist turn context: the chatting user is verified staff; data scope is the client. */
interface AssistTurn { clientUid: number; clientName: string; staffUid: number; staffName: string; }

async function pumpTurn(
  res: Response,
  userId: number,
  convId: number,
  opts: {
    prompt: string | PromptBlock[]; resumeSessionId: string | null;
    titleSeed?: string; userMessageId?: number;
    /** Present on /assist turns: reframes the prompt and scopes the data tools to the client. */
    assist?: AssistTurn;
  },
  onSettled?: () => void,
) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.turnTimeoutMs);
  res.on('close', () => ac.abort());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  (res as any).flushHeaders?.();

  if (opts.userMessageId) sse(res, { type: 'user', messageId: opts.userMessageId });

  let assistantText = '';
  let sessionId: string | null = opts.resumeSessionId;
  let costUsd: number | undefined;
  const redactor = new StreamRedactor();  // strips internal ids / secret values from the stream
  // H16: an order event landing mid-turn nulls the conversation's session id (so the NEXT turn
  // rebuilds context and sees the authoritative "[order event]" note) and bumps its epoch. If the
  // epoch moved during this turn, this turn's session id is stale — writing it back would resume
  // a context WITHOUT the order event — so the session writes below are skipped in that case.
  const sessionEpochAtStart = sessionEpoch(convId);

  try {
    let combinedCi: string | null = null;
    let caller;
    if (opts.assist) {
      // Assist turns ground on the CLIENT's account, and MUST NOT degrade to an ungrounded chat:
      // a generic answer presented on a client's CRM page would read as client-specific advice.
      // Fail the turn instead (caught below -> SSE error). No custom instructions either — the
      // broker's personal chat preferences have no business steering advice about a client.
      caller = await resolveCallerContext(opts.assist.clientUid);
    } else {
      const settings = await getSettings(userId);
      // Project instructions ride in the same UNTRUSTED user-preferences frame as the global custom
      // instructions (see advisor.ts userPreferencesBlock) — user-entered text never gains authority
      // by being project-scoped.
      // No fail-open here: silently dropping project instructions (which may carry
      // compliance framing) is worse than failing the turn on a DB error.
      const project = await projectForConversation(convId, userId);
      const projectCi = project?.instructions?.trim()
        ? `For this conversation's project "${project.name.replace(/\s+/g, ' ').trim()}":\n${project.instructions.trim()}`
        : null;
      combinedCi = [settings.custom_instructions?.trim() || null, projectCi]
        .filter(Boolean).join('\n\n') || null;
      // Resolve the caller's account/premium from their uid so the advisor's data tools are scoped.
      caller = await resolveCallerContext(userId).catch((e) => {
        console.warn(`[advisor] caller-context resolve failed for uid ${userId}:`, e?.message ?? e);
        return null;
      });
    }
    for await (const ev of runAdvisor({
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      customInstructions: combinedCi,
      caller,
      conversationId: convId,
      assist: opts.assist
        ? { staffUid: opts.assist.staffUid, staffName: opts.assist.staffName, clientName: opts.assist.clientName }
        : null,
      abortController: ac,
    })) {
      switch (ev.type) {
        case 'session': sessionId = ev.sessionId; sse(res, { type: 'session' }); break;
        case 'delta': {
          assistantText += ev.text;
          const safe = redactor.push(ev.text);
          if (safe) sse(res, { type: 'delta', text: safe });
          break;
        }
        case 'tool': sse(res, ev); break;
        case 'done': {
          redactor.flush();  // discard held tail; the authoritative done text below is fully redacted
          const text = redactFinal(ev.text && ev.text.length ? ev.text : assistantText);
          sessionId = ev.sessionId ?? sessionId;
          costUsd = ev.costUsd;
          const aMsg = await addMessage(convId, 'assistant', text, { meta: { costUsd } });
          void recordSpend({ source: opts.assist ? 'assist' : 'chat', vendor: 'anthropic', model: config.model, costUsd, ref: `message:${aMsg.id}`, userId });
          if (sessionEpoch(convId) === sessionEpochAtStart) await setSessionId(convId, sessionId);
          let title: string | undefined;
          const conv = opts.assist
            ? await getAssistConversation(convId, opts.assist.clientUid)
            : await getOwnedConversation(convId, userId);
          if ((!conv.title || conv.title === 'New chat') && opts.titleSeed) {
            title = deriveTitle(opts.titleSeed);
            if (opts.assist) await renameAssistConversation(convId, opts.assist.clientUid, title);
            else await renameConversation(convId, userId, title);
            // Haiku titler (async, fire-and-forget): replaces the truncation title with a short
            // distinctive name once it lands; a manual rename in the meantime wins.
            titleConversationAsync(convId, title, opts.titleSeed);
          }
          sse(res, { type: 'done', conversationId: convId, messageId: aMsg.id, text, title });
          res.end();
          onSettled?.();
          return;
        }
        case 'error': sse(res, ev); res.end(); onSettled?.(); return;
      }
    }
    // stream ended without an explicit done (e.g. aborted) — persist whatever we streamed
    if (!res.writableEnded) {
      if (assistantText.trim()) {
        const safeText = redactFinal(assistantText);
        const aMsg = await addMessage(convId, 'assistant', safeText, { meta: { aborted: true } });
        if (sessionEpoch(convId) === sessionEpochAtStart) await setSessionId(convId, sessionId);
        sse(res, { type: 'done', conversationId: convId, messageId: aMsg.id, text: safeText, aborted: true });
      } else {
        sse(res, { type: 'done', text: '', aborted: true });
      }
      res.end();
    }
  } catch (e: any) {
    if (!res.writableEnded) { sse(res, { type: 'error', message: e?.message ?? 'stream failed' }); res.end(); }
  } finally {
    clearTimeout(timer);
    onSettled?.();
  }
}

// ---- health (no auth) ------------------------------------------------------

// Health reports what THIS PROCESS actually has loaded, not just that it is up. `npm start` runs
// without a watcher, so a long-lived sidecar keeps serving the modules it imported at boot: after
// adding a tool or editing the persona, :3100 answers happily with the OLD code and the only
// symptom is "the new thing isn't working". started_at + tool_count + the climate snapshot's issue
// date make that diagnosable in one curl instead of a debugging session.
const STARTED_AT = new Date().toISOString();
app.get('/health', (_req, res) => {
  const fresh = outlookFreshness();
  res.json({
    ok: true,
    service: 'waterfind-ai-advisor',
    started_at: STARTED_AT,
    tool_count: WF_TOOL_NAMES.length,
    // Which reader every chat surface is using (a stale sidecar with the old provider shows here).
    speech: { transcribe: transcribeEnabled(), tts: ttsInfo(), reader: readerInfo() },
    has_climate_outlook: (WF_TOOL_NAMES as readonly string[]).includes('get_climate_outlook'),
    climate_outlook: fresh.available
      ? { issue_date: fresh.issue_date, snapshot_as_at: fresh.snapshot_as_at, superseded: fresh.superseded }
      : { available: false },
    auto_refresh: refreshStatus(),
    kb_refresh: kbRefreshStatus(),
  });
});

// everything below requires a valid CRM-minted token
// Voice calls (Retell): /voice/* carries its OWN auth (Retell webhook signature, outbound bearer secret,
// or a staff token) — Retell cannot present a CRM-minted token, so it mounts BEFORE requireAuth.
mountVoiceRoutes(app);

app.use(requireAuth);

// AI Trainer (staff-only) mounts HERE — after authentication, but BEFORE the client-facing
// advisor kill switch below. Staff maintenance must not be coupled to `waterfind_user.ai_advisor`:
// a client having the advisor switched off is no reason a staff member cannot fix the knowledge
// base. Its own guard (requireTrainer) verifies staff usertype + the AI Trainer role from the DB,
// fail-closed.
app.use('/trainer', trainerRouter);

// ---- broker-assist surface (staff chatting ABOUT a client, from the CRM client page) ---------
// Mounted like the trainer: after authentication, BEFORE the client-facing advisor kill switch —
// the per-client `ai_advisor` flag governs the CLIENT's own access, not a broker's staff tooling
// about that client (a broker may well consult the advisor precisely about an account whose chat
// is switched off). Admission needs BOTH:
//   1. an `act` claim in the signed token — only the staff-gated client-page JSP mints those; and
//   2. a FRESH staff lookup in the DB for the calling uid (fail-closed): staff usertype AND one of
//      config.assistRoles (default BROKER or SU — the CRM's own gate on client recordings), via the
//      shared staff.ts staffAccessDenial, the same rule every staff surface here uses.

interface AssistRequest extends AuthedRequest { assistClientUid?: number; assistClientName?: string; }

/** Read-aloud synthesis shared by every chat surface (see the /tts block below for the contract). */
const ttsHandler = jh(async (req: AuthedRequest, res) => {
  const text = String(req.body?.text ?? '');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let out: Awaited<ReturnType<typeof synthesizeSpeech>>;
  try { out = await synthesizeSpeech(text, { signal: ac.signal, userId: req.userId }); }
  catch (e: any) { if (e?.name === 'AbortError') return; throw e; }   // the browser went away mid-synthesis
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(out.audio);
});

function requireAssist(req: AssistRequest, res: Response, next: () => void): void {
  if (!config.assistEnabled) { res.status(404).json({ error: 'not found' }); return; } // do not advertise
  if (!req.actForUserId) { res.status(403).json({ error: 'not an assist token' }); return; }
  staffAccessDenial(req.userId!, config.assistRoles).then((denial) => {
    if (denial) { res.status(403).json({ error: denial === 'not-staff' ? 'staff only' : 'role required' }); return; }
    req.assistClientUid = req.actForUserId;
    req.assistClientName = req.actForName || 'the client';
    next();
  }, (e) => {
    const status = e instanceof StaffLookupFailed ? 503 : 500;
    res.status(status).json({ error: 'staff status cannot be verified right now' });
  });
}

function assistTurnCtx(req: AssistRequest): AssistTurn {
  return {
    clientUid: req.assistClientUid!,
    clientName: req.assistClientName!,
    staffUid: req.userId!,
    staffName: req.userName || 'a Waterfind staff member',
  };
}

app.use('/assist', requireAssist);

// Call-note prefill for the CRM's Add Comment popup (GET /assist/call-note/prefill) — same
// admission as everything else on this surface; see call-notes/routes.ts.
app.use('/assist', callNotesRouter);

app.get('/assist/me', (req: AssistRequest, res) => res.json({
  userId: req.userId, name: req.userName,
  clientUid: req.assistClientUid, clientName: req.assistClientName,
  // Same capability flags as the client surface's /me: the rail hides its mic / voice controls
  // when speech is unconfigured.
  transcribe: transcribeEnabled(),
  tts: ttsEnabled() || readerEnabled(),   // some reader can speak (OpenAI, or the Retell web reader)
  reader: readerInfo().mode,
}));

// Read-aloud for the rail — identical synthesis to POST /tts, admitted by requireAssist above
// (the client kill switch below must not gate a broker's staff tooling).
app.post('/assist/tts', ttsHandler);
// The Retell web reader's sessions for the rail (same admission).
app.use('/assist/reader', readerRouter);

// Empty-chat suggestions for the broker surface (edited in the AI Trainer's Questions tab).
app.get('/assist/default-questions', jh(async (_req: AssistRequest, res) => {
  res.json({ questions: await questionsFor('broker') });
}));

app.get('/assist/conversations', jh(async (req: AssistRequest, res) => {
  const list = await listAssistConversations(req.assistClientUid!);
  res.json(list.map((c) => ({
    id: c.id, title: c.title, created_at: c.created_at, updated_at: c.updated_at,
    staff_name: c.assist_staff_name, mine: c.user_id === req.userId,
  })));
}));

app.post('/assist/conversations', jh(async (req: AssistRequest, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title : 'New chat';
  const c = await createAssistConversation(req.userId!, req.userName || '', req.assistClientUid!, title);
  res.json({ id: c.id, title: c.title, created_at: c.created_at, updated_at: c.updated_at, staff_name: c.assist_staff_name, mine: true });
}));

app.get('/assist/conversations/:id/messages', jh(async (req: AssistRequest, res) => {
  res.json(await listAssistMessages(pid(req.params.id), req.assistClientUid!));
}));

// ---- the client's OWN advisor chats, browsed read-only by staff ------------
// GET only — there is deliberately no route that writes into, renames or deletes a client's own
// thread from the assist surface. Transcript reads are logged (assist_transcript_access): client
// chats carry holdings and personal circumstances, and this is an audited broker.

app.get('/assist/client-chats', jh(async (req: AssistRequest, res) => {
  const list = await listClientOwnConversations(req.assistClientUid!);
  res.json(list.map((c) => ({
    id: c.id, title: c.title, created_at: c.created_at, updated_at: c.updated_at,
    message_count: c.message_count,
  })));
}));

app.get('/assist/client-chats/:id/messages', jh(async (req: AssistRequest, res) => {
  res.json(await listClientOwnMessages(pid(req.params.id), req.assistClientUid!, req.userId!));
}));

app.patch('/assist/conversations/:id', jh(async (req: AssistRequest, res) => {
  const id = pid(req.params.id);
  if (typeof req.body?.title === 'string' && req.body.title.trim()) {
    await renameAssistConversation(id, req.assistClientUid!, req.body.title);
  }
  res.json({ ok: true });
}));

app.delete('/assist/conversations/:id', jh(async (req: AssistRequest, res) => {
  await deleteAssistConversation(pid(req.params.id), req.assistClientUid!, req.userId!);
  res.json({ ok: true });
}));

app.post('/assist/conversations/:id/chat', (req: AssistRequest, res) => {
  const userId = req.userId!;
  if (!acquire(userId)) { res.status(429).json({ error: 'too many concurrent requests' }); return; }
  let convLock: number | null = null;
  let settled = false;
  const settle = () => { if (settled) return; settled = true; release(userId); if (convLock != null) activeConvTurns.delete(convLock); };
  (async () => {
    const id = pid(req.params.id);
    if (!acquireConv(id, res)) return;
    convLock = id;
    const conv = await getAssistConversation(id, req.assistClientUid!);
    const message = String(req.body?.message ?? '').trim();
    if (!message) { res.status(400).json({ error: 'empty message' }); return; }
    // meta.staff labels the turn in the shared per-client history ("Chris asked …").
    const userMsg = await addMessage(id, 'user', message, { meta: { staff: req.userName || null } });
    const resume = conv.sdk_session_id;
    const prompt = resume ? message : formatFreshPrompt(await listAssistMessages(id, req.assistClientUid!));
    await pumpTurn(res, userId, id,
      { prompt, resumeSessionId: resume, titleSeed: message, userMessageId: userMsg.id, assist: assistTurnCtx(req) },
      settle);
  })().catch((e) => {
    if (e instanceof NotFound) { if (!res.headersSent) res.status(404).json({ error: 'not found' }); }
    else if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }).finally(settle);
});

// ---- broker-assist brokerage: the broker confirms / declines orders staged for the client ------
// Same pending_order rows and the same confirmPendingOrder() as the client's own chat — ctx is the
// CLIENT, so scope, re-validation and placement are identical. What differs is WHO clicks: verified
// staff, recorded on the row, in the CRM trade-file note and on the broker task. Only orders staged
// from THIS client's assist file are reachable here: a card pending in the client's own chat stays
// the client's to confirm (staff can see it via get_my_ai_orders, not action it).

async function assistOrder(req: AssistRequest, id: number): Promise<PendingOrder> {
  const po = await getOwnedPendingOrder(id, req.assistClientUid!);
  if (po.conversation_id == null) throw new NotFound('order not found');
  await getAssistConversation(po.conversation_id, req.assistClientUid!); // NotFound unless an assist chat about this client
  return po;
}

/** Assist twin of recordConversationEvent: the chokepoint is (conversation, client), not the clicker. */
async function recordAssistOrderEvent(req: AssistRequest, po: PendingOrder, event: string): Promise<void> {
  if (!po.conversation_id) return;
  try {
    bumpSessionEpoch(po.conversation_id);
    await getAssistConversation(po.conversation_id, req.assistClientUid!);
    await addMessage(po.conversation_id, 'system', event,
      { meta: { pendingOrderId: po.id, status: po.status, staff: req.userName || null } });
    await setSessionId(po.conversation_id, null);
  } catch (e) {
    console.warn('[brokerage/assist] could not record conversation event:', (e as any)?.message ?? e);
  }
}

app.get('/assist/orders', jh(async (req: AssistRequest, res) => {
  const conversationId = Number(req.query.conversation_id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) { res.status(400).json({ error: 'conversation_id required' }); return; }
  await getAssistConversation(conversationId, req.assistClientUid!);
  const statuses = typeof req.query.status === 'string' && req.query.status
    ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  await reconcileUnknownOrders(req.assistClientUid!);
  res.json(await listOrders(req.assistClientUid!, conversationId, statuses));
}));

app.post('/assist/orders/:id/confirm', jh(async (req: AssistRequest, res) => {
  const id = pid(req.params.id);
  await assistOrder(req, id);
  const tcAccepted = req.body?.tc_accepted === true;
  const ctx = await resolveCallerContext(req.assistClientUid!);
  const staff = { staffUid: req.userId!, staffName: req.userName || 'Waterfind staff' };
  let po: PendingOrder;
  try {
    po = await confirmPendingOrder(ctx, id, tcAccepted, staff);
  } catch (e) {
    if (e instanceof ScopeViolation) { res.status(400).json({ error: e.message }); return; }
    throw e;
  }
  const event = orderOutcomeEvent(po, staff.staffName, true);
  if (event) await recordAssistOrderEvent(req, po, event);
  res.json(po);
}));

app.post('/assist/orders/:id/cancel', jh(async (req: AssistRequest, res) => {
  const id = pid(req.params.id);
  await assistOrder(req, id);
  const po = await cancelPendingOrder(req.assistClientUid!, id);
  if (po.status === 'cancelled') {
    await recordAssistOrderEvent(req, po,
      `[order event] ${req.userName || 'Waterfind staff'} DECLINED the proposed ${describeOrder(po)} — it was not placed.`);
  }
  res.json(po);
}));

// ... and the caller's per-client AI Advisor flag still ON: a broker disabling a client must
// also invalidate this client's already-minted tokens, not just stop the CRM minting new ones.
// The flag is a compliance kill switch and fails CLOSED: 'disabled' -> 403, and 'unknown' (the
// entitlement could not be verified) -> 503, never an implicit allow.
app.use((req: AuthedRequest, res, next) => {
  isAdvisorEnabled(req.userId!).then((verdict) => {
    if (verdict === 'enabled') return next();
    if (verdict === 'disabled') {
      return res.status(403).json({
        error: 'advisor_disabled',
        message: 'AI Advisor access is not enabled on your account. Reach out to your broker for access.',
      });
    }
    // 'unknown': the lookup failed, so we cannot confirm entitlement — refuse rather than allow.
    res.status(503).json({
      error: 'advisor_unavailable',
      message: 'AI Advisor is temporarily unavailable. Please try again shortly.',
    });
  }, next);
});

// ---- conversations CRUD ----------------------------------------------------

app.get('/conversations', jh(async (req, res) => {
  const includeArchived = req.query.archived === 'true';
  res.json(await listConversations(req.userId!, includeArchived));
}));

app.post('/conversations', jh(async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : 'New chat';
  const rawPid = req.body != null && 'project_id' in req.body ? req.body.project_id : null;
  if (rawPid !== null && !(Number.isInteger(rawPid) && rawPid > 0)) { res.status(400).json({ error: 'bad project_id' }); return; }
  if (rawPid) await getOwnedProject(rawPid, req.userId!); // NotFound -> 404
  res.json(await createConversation(req.userId!, title, rawPid));
}));

app.get('/conversations/:id/messages', jh(async (req, res) => {
  res.json(await listMessages(pid(req.params.id), req.userId!));
}));

app.patch('/conversations/:id', jh(async (req, res) => {
  const id = pid(req.params.id);
  // Validate everything BEFORE mutating anything, so a 404/400 never means "partially applied".
  const hasProject = req.body != null && 'project_id' in req.body;
  if (hasProject) {
    const raw = req.body.project_id;
    if (raw !== null && !(Number.isInteger(raw) && raw > 0)) { res.status(400).json({ error: 'bad project_id' }); return; }
    if (raw !== null) await getOwnedProject(raw, req.userId!); // NotFound -> 404
  }
  if (typeof req.body?.title === 'string') await renameConversation(id, req.userId!, req.body.title);
  if (typeof req.body?.archived === 'boolean') await setArchived(id, req.userId!, req.body.archived);
  if (hasProject) await assignConversationProject(id, req.userId!, req.body.project_id);
  res.json(await getOwnedConversation(id, req.userId!));
}));

app.delete('/conversations/:id', jh(async (req, res) => {
  await deleteConversation(pid(req.params.id), req.userId!);
  res.json({ ok: true });
}));

// ---- projects (ChatGPT-style conversation folders) --------------------------

app.get('/projects', jh(async (req, res) => {
  res.json(await listProjects(req.userId!));
}));

app.post('/projects', jh(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.slice(0, 4000) : null;
  res.json(await createProject(req.userId!, name, instructions));
}));

app.patch('/projects/:id', jh(async (req, res) => {
  const id = pid(req.params.id);
  const patch: { name?: string; instructions?: string | null } = {};
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.replace(/\s+/g, ' ').trim();
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    patch.name = name;
  }
  if (req.body && 'instructions' in req.body) {
    patch.instructions = typeof req.body.instructions === 'string' && req.body.instructions.trim()
      ? req.body.instructions.slice(0, 4000) : null;
  }
  res.json(await updateProject(id, req.userId!, patch));
}));

// Deletes the folder only — its chats survive ungrouped (the UI's confirm says so).
app.delete('/projects/:id', jh(async (req, res) => {
  await deleteProject(pid(req.params.id), req.userId!);
  res.json({ ok: true });
}));

app.get('/search', jh(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  res.json(q ? await searchConversations(req.userId!, q) : []);
}));

app.get('/conversations/:id/export', jh(async (req, res) => {
  const id = pid(req.params.id);
  const conv = await getOwnedConversation(id, req.userId!);
  const msgs = await listMessages(id, req.userId!);
  const format = req.query.format === 'json' ? 'json' : 'md';
  const safe = (conv.title || 'conversation').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 50);
  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
    res.json({ title: conv.title, created_at: conv.created_at, messages: msgs.map((m) => ({ role: m.role, content: m.content, created_at: m.created_at, attachments: m.meta?.attachments ?? undefined })) });
  } else {
    const md = [`# ${conv.title}`, '', ...msgs.map((m) => {
      const atts = m.meta?.attachments?.length
        ? `\n_Attachments: ${m.meta.attachments.map((a: any) => a.filename).join(', ')}_\n` : '';
      return `**${m.role === 'assistant' ? 'Advisor' : 'You'}:**\n\n${m.content}\n${atts}`;
    })].join('\n');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.md"`);
    res.send(md);
  }
}));

// ---- attachments -------------------------------------------------------------
// Upload is a raw body (the UI always sends application/octet-stream); the extension in
// ?filename= plus magic-byte sniffing decide the type. Bytes live in ai_advisor.attachment.

app.post('/attachments', express.raw({ type: () => true, limit: '11mb' }), jh(async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const v = validateUpload(String(req.query.filename ?? ''), buf); // throws BadAttachment -> 400
  await assertUnboundHeadroom(req.userId!);
  const meta = await insertAttachment(req.userId!, v, buf);
  sweepUnboundAttachments().catch(() => {});
  res.json(publicMeta(meta));
}));

app.get('/attachments/:id', jh(async (req, res) => {
  const a = await getOwnedAttachment(pid(req.params.id), req.userId!);
  // Headers only take latin-1: ASCII-fold the plain filename, carry the real one via RFC 5987.
  const ascii = a.filename.replace(/"/g, '').replace(/[^\x20-\x7e]/g, '_');
  const disp = a.kind === 'image' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', a.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(a.data);
}));

// Empty-chat suggestions for the client's own advisor tab (edited in the AI Trainer's Questions tab).
app.get('/default-questions', jh(async (_req, res) => {
  res.json({ questions: await questionsFor('client') });
}));

// ---- settings --------------------------------------------------------------

app.get('/settings', jh(async (req, res) => { res.json(await getSettings(req.userId!)); }));
app.put('/settings', jh(async (req, res) => {
  const theme = req.body?.theme === 'dark' ? 'dark' : 'light';
  const ci = typeof req.body?.custom_instructions === 'string' ? req.body.custom_instructions.slice(0, 4000) : null;
  await putSettings(req.userId!, theme, ci);
  res.json(await getSettings(req.userId!));
}));

// ---- feedback (beta programme) ---------------------------------------------

app.post('/feedback', jh(async (req, res) => {
  const kind = req.body?.kind === 'inaccuracy' ? 'inaccuracy' : 'general';
  const body = typeof req.body?.body === 'string' && req.body.body.trim() ? req.body.body.trim() : null;
  const conversationId = Number.isInteger(req.body?.conversation_id) && req.body.conversation_id > 0
    ? req.body.conversation_id : null;
  const messageId = Number.isInteger(req.body?.message_id) && req.body.message_id > 0
    ? req.body.message_id : null;
  if (kind === 'inaccuracy' && messageId == null) { res.status(400).json({ error: 'message_id required' }); return; }
  if (kind === 'general' && !body) { res.status(400).json({ error: 'feedback text required' }); return; }
  const id = await insertFeedback(req.userId!, { kind, body, conversationId, messageId });
  res.json({ id, ok: true });
}));

app.get('/me', (req: AuthedRequest, res) => res.json({
  userId: req.userId, name: req.userName, userType: req.userType,
  // Capability flags let the UI hide surfaces it can't use (mic button when STT is unconfigured,
  // the speaker/voice-mode controls when TTS is unconfigured).
  transcribe: transcribeEnabled(),
  tts: ttsEnabled() || readerEnabled(),   // some reader can speak (OpenAI, or the Retell web reader)
  // Which reader speaks the replies: 'retell' (the phone channel's voice, via a Retell web call)
  // or 'openai' (POST /tts). Flipped by AIADVISOR_WEB_READER on the sidecar; the browser follows.
  reader: readerInfo().mode,
}));

// ---- dictation: speech-to-text for the composer -----------------------------
// Raw audio body (the browser sends the MediaRecorder blob as application/octet-stream or
// audio/webm). Forwarded to OpenAI server-side so the key never reaches the client. Returns the
// transcript for the user to review in the textarea before sending — no message is created here.

app.post('/transcribe', express.raw({ type: () => true, limit: config.transcribeMaxBytes }), jh(async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const text = await transcribeAudio(buf, req.header('content-type') ?? '');
  res.json({ text });
}));

// ---- voice: text-to-speech for spoken replies -------------------------------
// JSON body {text}: an assistant message's markdown. Stripped to speech-friendly text server-side
// (charts/tables become "see the chart/table on screen") and synthesised via OpenAI — the key
// never reaches the client, same posture as /transcribe. Returns the audio bytes for playback. The one handler serves the
// client surface here (behind the kill switch), the broker rail at /assist/tts and the AI Trainer at
// /trainer/tts — each behind its own admission.

app.post('/tts', ttsHandler);
// The Retell web reader's sessions for the client surface (behind the kill switch like /tts).
app.use('/reader', readerRouter);

// ---- brokerage: pending-order confirm flow ----------------------------------
// The AI can only PREPARE orders (agent tools). Execution happens exclusively here, driven
// by the human's click in the chat UI with their own bearer token.

/** Record the authoritative outcome in the chat and force a fresh SDK session so the model sees it.
 *  Bumps the conversation's session epoch FIRST (H16): a turn already streaming when this event
 *  lands will see the epoch change in its done handler and skip its own (stale) session write, so
 *  the session stays nulled and the next turn takes the fresh-prompt path — which includes this
 *  event — instead of resuming a context that never saw it. */
async function recordConversationEvent(
  userId: number, conversationId: number | null, event: string, meta: Record<string, unknown>,
): Promise<void> {
  if (!conversationId) return;
  try {
    bumpSessionEpoch(conversationId);
    await getOwnedConversation(conversationId, userId);
    await addMessage(conversationId, 'system', event, { meta });
    await setSessionId(conversationId, null);
  } catch (e) {
    console.warn('[brokerage] could not record conversation event:', (e as any)?.message ?? e);
  }
}

async function recordOrderEvent(userId: number, po: PendingOrder, event: string): Promise<void> {
  await recordConversationEvent(userId, po.conversation_id, event, { pendingOrderId: po.id, status: po.status });
}

function describeOrder(po: PendingOrder): string {
  if (po.side === 'WITHDRAW') return `withdrawal of order #${po.target_order_id}`;
  return `${po.side} ${po.volume_ml} ML ${po.is_permanent ? 'entitlement' : 'allocation'} `
    + `@ $${po.price_per_ml}/ML in ${po.region_name ?? `region ${po.region_id}`}`;
}

/** H6: audit-trail failures are surfaced, never silent — but they never fail the trade. The
 *  remedy differs by reader: the client is told to raise it with their broker; on the assist rail
 *  the broker IS the reader, so they are told to record it themselves. */
function orderAuditNote(po: PendingOrder, assist: boolean): string {
  if (po.note_written === false && po.broker_notified === false) {
    return assist
      ? ' AUDIT: the CRM trade-file note could not be written AND the automatic broker task failed — record this trade on the client file manually.'
      : ' AUDIT: the CRM trade-file note could not be written AND the automatic broker task failed — '
        + 'advise the client to mention this trade to their broker so it is recorded on their file.';
  }
  if (po.note_written === false) {
    return assist
      ? ' AUDIT: the CRM trade-file note could not be written — record this trade on the client file manually.'
      : ' AUDIT: the CRM trade-file note could not be written — the broker has been asked to record it manually.';
  }
  if (po.broker_notified === false) {
    return assist
      ? ' AUDIT: the automatic broker follow-up task could not be raised — action the contract preparation for this order yourself.'
      : ' AUDIT: the automatic broker follow-up task could not be raised — advise the client to '
        + 'contact their broker directly about this order.';
  }
  return '';
}

/** The authoritative "[order event]" line after a Confirm click, or null when nothing final
 *  happened (already decided / raced / expired). `who` is the clicker: "The user" on the client's
 *  own chat, the staff member's name on the assist rail (where the order is the client's). */
function orderOutcomeEvent(po: PendingOrder, who: string, assist: boolean): string | null {
  const onAccount = assist ? " on the client's account" : '';
  if (po.status === 'placed') {
    const clearedNote = po.side !== 'WITHDRAW' && (po.cleared_trades ?? 0) > 0
      ? ` It auto-cleared ${po.cleared_trades} trade(s) immediately.` : '';
    const auditNote = orderAuditNote(po, assist);
    return po.side === 'WITHDRAW'
      ? `[order event] ${who} confirmed and order #${po.target_order_id} was WITHDRAWN from the market${onAccount}.${auditNote}`
      : `[order event] ${who} confirmed and the ${describeOrder(po)} was PLACED on the market${onAccount} as order #${po.crm_order_id}.${clearedNote}${auditNote}`;
  }
  if (po.status === 'failed') {
    return `[order event] ${who} confirmed the ${describeOrder(po)} but placement FAILED: ${po.error}`;
  }
  if (po.status === 'unknown') {
    // B1: honest ambiguity — the seam gave no definitive outcome; the order MAY be live.
    return `[order event] ${who} confirmed the ${describeOrder(po)} but the placement outcome is UNCONFIRMED — ` +
      `the trading system did not respond in time. The order MAY OR MAY NOT be live on the market. Do NOT ` +
      `tell the user it failed, do NOT prepare it again, and refuse requests to retry it; it will be ` +
      `reconciled against the order book automatically and the final outcome reported here.`;
  }
  return null;
}

app.get('/orders', jh(async (req, res) => {
  const conversationId = req.query.conversation_id ? Number(req.query.conversation_id) : undefined;
  const statuses = typeof req.query.status === 'string' && req.query.status
    ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  // B1: every listing pass first tries to resolve UNCONFIRMED placements against the CRM order
  // book (the UI polls this on conversation render, so stuck orders resolve without user action).
  await reconcileUnknownOrders(req.userId!);
  res.json(await listOrders(req.userId!, conversationId, statuses));
}));

app.post('/orders/:id/confirm', jh(async (req, res) => {
  const id = pid(req.params.id);
  const tcAccepted = req.body?.tc_accepted === true;
  const ctx = await resolveCallerContext(req.userId!);
  let po: PendingOrder;
  try {
    po = await confirmPendingOrder(ctx, id, tcAccepted);
  } catch (e) {
    if (e instanceof ScopeViolation) { res.status(400).json({ error: e.message }); return; }
    throw e;
  }
  const event = orderOutcomeEvent(po, 'The user', false);
  if (event) await recordOrderEvent(req.userId!, po, event);
  res.json(po);
}));

app.post('/orders/:id/cancel', jh(async (req, res) => {
  const id = pid(req.params.id);
  const po = await cancelPendingOrder(req.userId!, id);
  if (po.status === 'cancelled') {
    await recordOrderEvent(req.userId!, po,
      `[order event] The user DECLINED the proposed ${describeOrder(po)} — it was not placed.`);
  }
  res.json(po);
}));

// ---- escalations: confirm-before-send flow ----------------------------------
// Mirrors the pending-order flow: the AI can only PREPARE an escalation; the CRM follow-up task
// is raised exclusively here, by the human's Confirm click on the in-chat card. Every decision is
// recorded as a system note (with a session-epoch bump) so the next turn knows what happened.

function escPub(e: Escalation) {
  return {
    id: e.id, conversation_id: e.conversation_id, reason: e.reason, summary: e.summary,
    status: e.status, broker_name: e.broker_name, crm_broker_action_id: e.crm_broker_action_id,
    created_at: e.created_at, decided_at: e.decided_at, cancelled_at: e.cancelled_at,
  };
}

app.get('/escalations', jh(async (req, res) => {
  const conversationId = req.query.conversation_id ? Number(req.query.conversation_id) : undefined;
  const statuses = typeof req.query.status === 'string' && req.query.status
    ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  res.json((await listEscalations(req.userId!, conversationId, statuses)).map(escPub));
}));

app.post('/escalations/:id/confirm', jh(async (req, res) => {
  const id = pid(req.params.id);
  const ctx = await resolveCallerContext(req.userId!);
  let r;
  try {
    r = await confirmEscalation(ctx, id);
  } catch (e) {
    if (e instanceof ScopeViolation) { res.status(400).json({ error: e.message }); return; }
    throw e;
  }
  const esc = r.escalation;
  if (r.crmBrokerActionId != null) {
    // Only an assigned servicing tag routes the task to a specific broker's calendar/daily queue.
    const routed = r.broker.source === 'assigned-tag';
    const named = r.broker.active ? r.broker.brokerName : null;
    const forWhom = routed && named
      ? `for servicing broker ${named}`
      : `for the Waterfind broking team${named ? ` (servicing contact on file: ${named})` : ''}`;
    await recordConversationEvent(req.userId!, esc.conversation_id,
      `[escalation] The client CONFIRMED the escalation to a human broker. A follow-up task was raised ` +
      `on the client's CRM account ${forWhom} (broker_action #${r.crmBrokerActionId}). Reason: ${esc.reason}.`,
      { escalationId: esc.id, status: esc.status, crmBrokerActionId: r.crmBrokerActionId });
  } else {
    // H4: do NOT claim a task was raised when it wasn't — no broker has been notified.
    await recordConversationEvent(req.userId!, esc.conversation_id,
      `[escalation] The client CONFIRMED the escalation, but the follow-up task could NOT be raised on ` +
      `the client's CRM account — no broker has been notified. Tell the client to contact their broker ` +
      `or the Waterfind office directly; do NOT say a broker will follow up. Reason: ${esc.reason}.`,
      { escalationId: esc.id, status: esc.status, crmBrokerActionId: null });
  }
  res.json({
    ...escPub(esc),
    crm_task_raised: r.crmBrokerActionId != null,
    broker: (r.broker.active ? r.broker.brokerName : null) ?? 'the Waterfind broking team',
    routed_to_named_broker: r.broker.source === 'assigned-tag' && r.broker.active,
  });
}));

app.post('/escalations/:id/decline', jh(async (req, res) => {
  const id = pid(req.params.id);
  const esc = await declineEscalation(req.userId!, id);
  if (esc.status === 'declined') {
    await recordConversationEvent(req.userId!, esc.conversation_id,
      `[escalation] The client chose NOT to send the escalation to the team — nothing was sent and ` +
      `no broker was notified. Do not re-raise it unless the client asks again.`,
      { escalationId: esc.id, status: esc.status });
  }
  res.json(escPub(esc));
}));

app.post('/escalations/:id/cancel', jh(async (req, res) => {
  const id = pid(req.params.id);
  let r;
  try {
    r = await cancelEscalation(req.userId!, id);
  } catch (e) {
    if (e instanceof ScopeViolation) { res.status(400).json({ error: e.message }); return; }
    throw e;
  }
  const esc = r.escalation;
  await recordConversationEvent(req.userId!, esc.conversation_id,
    `[escalation] The client CANCELLED the escalation (de-escalated). ` +
    (!r.hadTask
      ? 'No CRM task had been raised, so the team was never notified.'
      : r.taskClosed
        ? 'The follow-up task on their CRM account was closed with a cancellation note.'
        : 'The follow-up task had already been actioned or could not be closed — the team may still ' +
          'reach out; if they do, the client can simply say it is no longer needed.'),
    { escalationId: esc.id, status: esc.status, taskClosed: r.taskClosed });
  res.json({ ...escPub(esc), crm_task_closed: r.taskClosed });
}));

// ---- streaming turns (SSE) -------------------------------------------------

app.post('/conversations/:id/chat', (req: AuthedRequest, res) => {
  const userId = req.userId!;
  if (!acquire(userId)) { res.status(429).json({ error: 'too many concurrent requests' }); return; }
  let convLock: number | null = null;
  let settled = false;
  const settle = () => { if (settled) return; settled = true; release(userId); if (convLock != null) activeConvTurns.delete(convLock); };
  (async () => {
    const id = pid(req.params.id);
    if (!acquireConv(id, res)) return;
    convLock = id;
    const conv = await getOwnedConversation(id, userId);
    const message = String(req.body?.message ?? '').trim();
    const attIds = attachmentIdsOf(req.body?.attachment_ids);
    if (!message && !attIds.length) { res.status(400).json({ error: 'empty message' }); return; }
    const atts = await claimAttachments(attIds, userId, id);
    const userMsg = await addMessage(id, 'user', message,
      atts.length ? { meta: { attachments: atts.map(publicMeta) } } : {});
    await bindAttachments(attIds, userId, id, userMsg.id);
    const resume = conv.sdk_session_id;
    const prompt = resume
      ? turnContent(message, atts)
      : await formatFreshPromptContent(userId, await listMessages(id, userId));
    const titleSeed = message || (atts[0] ? atts[0].filename : undefined);
    await pumpTurn(res, userId, id, { prompt, resumeSessionId: resume, titleSeed, userMessageId: userMsg.id }, settle);
  })().catch((e) => {
    if (e instanceof NotFound) { if (!res.headersSent) res.status(404).json({ error: 'not found' }); }
    else if (e instanceof BadAttachment) { if (!res.headersSent) res.status(400).json({ error: e.message }); }
    else if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }).finally(settle);
});

app.post('/conversations/:id/regenerate', (req: AuthedRequest, res) => {
  const userId = req.userId!;
  if (!acquire(userId)) { res.status(429).json({ error: 'too many concurrent requests' }); return; }
  let convLock: number | null = null;
  let settled = false;
  const settle = () => { if (settled) return; settled = true; release(userId); if (convLock != null) activeConvTurns.delete(convLock); };
  (async () => {
    const id = pid(req.params.id);
    if (!acquireConv(id, res)) return;
    convLock = id;
    await getOwnedConversation(id, userId);
    const msgs = await listMessages(id, userId);
    let lastA = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { lastA = i; break; }
    if (lastA === -1) { res.status(400).json({ error: 'nothing to regenerate' }); return; }
    await deactivateFrom(id, userId, msgs[lastA].id);
    await setSessionId(id, null); // branch -> fresh session (review M4)
    const remaining = msgs.slice(0, lastA);
    const lastUser = [...remaining].reverse().find((m) => m.role === 'user');
    await pumpTurn(res, userId, id, { prompt: await formatFreshPromptContent(userId, remaining), resumeSessionId: null, titleSeed: lastUser?.content }, settle);
  })().catch((e) => {
    if (e instanceof NotFound) { if (!res.headersSent) res.status(404).json({ error: 'not found' }); }
    else if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }).finally(settle);
});

app.post('/conversations/:id/messages/:messageId/edit', (req: AuthedRequest, res) => {
  const userId = req.userId!;
  if (!acquire(userId)) { res.status(429).json({ error: 'too many concurrent requests' }); return; }
  let convLock: number | null = null;
  let settled = false;
  const settle = () => { if (settled) return; settled = true; release(userId); if (convLock != null) activeConvTurns.delete(convLock); };
  (async () => {
    const id = pid(req.params.id);
    const messageId = pid(req.params.messageId);
    if (!acquireConv(id, res)) return;
    convLock = id;
    await getOwnedConversation(id, userId);
    const content = String(req.body?.content ?? '').trim();
    const attIds = attachmentIdsOf(req.body?.attachment_ids);
    if (!content && !attIds.length) { res.status(400).json({ error: 'empty message' }); return; }
    const msgs = await listMessages(id, userId);
    const target = msgs.find((m) => m.id === messageId);
    if (!target || target.role !== 'user') { res.status(400).json({ error: 'can only edit a user message' }); return; }
    const atts = await claimAttachments(attIds, userId, id); // may re-use this conversation's own
    await deactivateFrom(id, userId, target.id);
    const newUser = await addMessage(id, 'user', content, {
      parentId: target.parent_id,
      ...(atts.length ? { meta: { attachments: atts.map(publicMeta) } } : {}),
    });
    await bindAttachments(attIds, userId, id, newUser.id);
    await setSessionId(id, null); // branch -> fresh session (review M4)
    const active = await listMessages(id, userId);
    await pumpTurn(res, userId, id, { prompt: await formatFreshPromptContent(userId, active), resumeSessionId: null, titleSeed: content, userMessageId: newUser.id }, settle);
  })().catch((e) => {
    if (e instanceof NotFound) { if (!res.headersSent) res.status(404).json({ error: 'not found' }); }
    else if (e instanceof BadAttachment) { if (!res.headersSent) res.status(400).json({ error: e.message }); }
    else if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }).finally(settle);
});

// Friendly body-parser errors (e.g. an over-limit raw upload) instead of Express's HTML 413.
app.use((err: any, _req: AuthedRequest, res: Response, next: (e?: any) => void) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') { res.status(413).json({ error: 'file too large' }); return; }
  if (err?.status === 400 && err?.type) { res.status(400).json({ error: 'malformed request body' }); return; }
  next(err);
});

// Terminal handler: anything a router forwarded with next(err) (voice, trainer, call notes) becomes a
// JSON 500. Without this Express's finalhandler renders an HTML page that includes the stack trace
// whenever NODE_ENV is unset — file paths and SQL to the caller.
app.use((err: any, _req: AuthedRequest, res: Response, _next: (e?: any) => void) => {
  console.error('unhandled route error:', err);
  if (res.headersSent) { try { res.end(); } catch { /* already gone */ } return; }
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'internal error' : String(err?.message || 'request failed') });
});

const httpServer = app.listen(config.port, () => {
  console.log(`waterfind-ai-advisor listening on :${config.port}`);
  console.log(`CORS origins: ${config.corsOrigins.join(', ')}`);
  console.log(`model=${config.model}  anthropicKey=${config.anthropicApiKey ? 'env' : 'host Claude Code creds'}`);
  const tts = ttsInfo();
  console.log(`speech: dictation=${transcribeEnabled() ? 'on' : 'off'}  read-aloud=${tts.enabled ? `${tts.provider} ${tts.model} voice=${tts.voice}` : 'off'}`);
  // Keeps knowledge/data/*.json current without anyone remembering to run a script.
  startRefreshScheduler();
  // Re-verifies documents/notes whose best_by has passed (ledgered, emailed to trainer role holders).
  startKbRefreshScheduler();
  // Call-note transcript retention (no-op unless AIADVISOR_CALL_NOTE_RETENTION_DAYS > 0).
  startCallNoteRetentionSweep();
  startAutoCallNotes();
  // Phone channel (Retell websocket + outbound jobs); no-op unless AIADVISOR_VOICE_ENABLED=1.
  startVoice(httpServer);
  // Live dictation websocket (browser mic -> OpenAI realtime transcription); closes immediately
  // with a clear error when no OpenAI key is configured.
  attachTranscribeStream(httpServer);
  if (!config.assistRoles.length) console.warn('ASSIST_ROLES is empty — the broker-assist surface admits ANY staff usertype (role check off)');
});

// Graceful shutdown: stop taking connections, close the Retell websocket server + background jobs,
// then exit. Without this a SIGTERM drops live voice calls mid-turn and can leave a trainer write
// between its rename and its ledger insert.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  try { stopVoice(); } catch (e) { console.error('stopVoice failed', e); }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason); });
