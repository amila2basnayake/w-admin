// Offline unit tests for the fresh-session prompt embed-budget invariant (bug H13).
//
// Invariant under test: the CURRENT turn (the newest/last message — the one being answered) always
// has ALL its attachments embedded, regardless of the byte budget; the budget trims OLDER history
// only. So any message that passed upload validation (<= MAX_MESSAGE_BINARY_BYTES binary +
// MAX_MESSAGE_TEXT_BYTES text) can always be shown whole on its own turn and can never be reduced
// to an un-actionable "please re-attach" placeholder.
//   npx tsx test-embed-budget.ts
import {
  selectPromptEmbeds,
  MAX_MESSAGE_BINARY_BYTES, MAX_MESSAGE_TEXT_BYTES, PROMPT_EMBED_BUDGET_BYTES,
  type AttachmentMeta, type AttachmentKind,
} from './src/attachments';

let ok = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { ok++; }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const MB = 1024 * 1024;
const KB = 1024;

let nextId = 1;
/** Minimal AttachmentMeta — only id / size_bytes / kind matter to the budget walk. */
function att(sizeBytes: number, kind: AttachmentKind = 'pdf', id = nextId++): AttachmentMeta {
  return {
    id, user_id: 1, conversation_id: 1, message_id: 1,
    filename: `f${id}`, mime: kind === 'text' ? 'text/plain' : 'application/pdf',
    kind, size_bytes: sizeBytes, created_at: '2026-06-01T00:00:00Z',
  };
}
const ids = (s: Set<number>) => [...s].sort((a, b) => a - b);
const eq = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// 0. Constant consistency: the budget is at least one full validated message (the off-by-1MB gap
//    that caused H13 — 15 MB budget vs 16 MB per-message binary cap — must be gone).
check('budget >= one full message (binary + text caps)',
  PROMPT_EMBED_BUDGET_BYTES >= MAX_MESSAGE_BINARY_BYTES + MAX_MESSAGE_TEXT_BYTES,
  `budget=${PROMPT_EMBED_BUDGET_BYTES} caps=${MAX_MESSAGE_BINARY_BYTES + MAX_MESSAGE_TEXT_BYTES}`);

// 1. H13 REGRESSION: a first turn (single message) whose combined binary is the max per-message
//    16 MB — larger than the OLD 15 MB budget — still embeds ALL attachments (no placeholder).
{
  const a = att(8 * MB), b = att(8 * MB); // 16 MB combined == MAX_MESSAGE_BINARY_BYTES
  const embed = selectPromptEmbeds([[a, b]]);
  check('single first turn: full 16 MB message fully embedded', eq(ids(embed), [a.id, b.id]), JSON.stringify(ids(embed)));
}

// 2. A maxed-out validated message (16 MB binary + 512 KB text) embeds whole on its own turn.
{
  const bin1 = att(10 * MB), bin2 = att(6 * MB), txt = att(512 * KB, 'text');
  const embed = selectPromptEmbeds([[bin1, bin2, txt]]);
  check('current turn: max binary + max text all embedded', eq(ids(embed), ids(new Set([bin1.id, bin2.id, txt.id]))));
}

// 3. Older history OVER budget is trimmed newest-first, but the current turn is untouched.
{
  const old0 = att(12 * MB, 'pdf');   // oldest
  const old1 = att(12 * MB, 'pdf');   // newer of the two old messages
  const cur = att(10 * MB, 'pdf');    // current turn
  const embed = selectPromptEmbeds([[old0], [old1], [cur]]);
  // budget 16.5 MB over older history, newest-first: old1 (12 MB) fits, old0 (12 MB) does NOT.
  check('current always embedded even with over-budget history', embed.has(cur.id));
  check('older history trimmed newest-first: old1 kept', embed.has(old1.id));
  check('older history trimmed newest-first: old0 dropped', !embed.has(old0.id));
}

// 4. Current turn is EXEMPT from the budget: it does not consume the older-history budget, so a
//    maxed-out current message plus a large older message can both embed.
{
  const cur = att(MAX_MESSAGE_BINARY_BYTES + MAX_MESSAGE_TEXT_BYTES, 'pdf'); // full 16.5 MB current
  const old0 = att(10 * MB, 'pdf');
  const embed = selectPromptEmbeds([[old0], [cur]]);
  check('current exempt: maxed current embedded', embed.has(cur.id));
  check('current exempt: budget for older history not reduced by current', embed.has(old0.id));
}

// 5. Mixed binary + text share ONE older-history byte budget; arithmetic is exact at the edge.
{
  const oldBig = att(MAX_MESSAGE_BINARY_BYTES + 1, 'pdf'); // 16 MB + 1 byte (older, oldest)
  const oldTxt = att(512 * KB, 'text');                   // 512 KB (older, newer)
  const cur = att(1 * KB, 'text');
  const embed = selectPromptEmbeds([[oldBig], [oldTxt], [cur]]);
  // newest-first over history: oldTxt 512 KB fits (budget -> 16 MB), oldBig 16 MB+1 > 16 MB dropped.
  check('mixed budget: text history within budget kept', embed.has(oldTxt.id));
  check('mixed budget: 1-byte-over binary history dropped', !embed.has(oldBig.id));
  check('mixed budget: current still embedded', embed.has(cur.id));
}

// 6. Older item exactly AT the remaining budget is kept (<= boundary).
{
  const oldExact = att(PROMPT_EMBED_BUDGET_BYTES, 'pdf');
  const cur = att(1 * KB, 'text');
  const embed = selectPromptEmbeds([[oldExact], [cur]]);
  check('older item exactly at budget is kept', embed.has(oldExact.id) && embed.has(cur.id));
}

// 7. Degenerate shapes: empty input, and messages with no attachments, don't throw.
{
  check('empty conversation -> empty set', ids(selectPromptEmbeds([])).length === 0);
  const cur = att(5 * MB);
  const embed = selectPromptEmbeds([[], [], [cur]]); // gaps before the current turn
  check('empty older messages tolerated; current embedded', eq(ids(embed), [cur.id]));
}

// 8. When the current turn carries NO attachments, only budgeted older history is embedded (the
//    exemption applies to whatever the last message is — here it contributes nothing).
{
  const old0 = att(5 * MB), old1 = att(5 * MB);
  const embed = selectPromptEmbeds([[old0], [old1], []]);
  check('current turn without attachments: older history embedded within budget',
    eq(ids(embed), ids(new Set([old0.id, old1.id]))));
}

console.log(fail === 0 ? `\nPASS — ${ok} checks ok, 0 failed` : `\nFAIL — ${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
