// Verifies the Claude Agent SDK can run the advisor with whatever credentials the host has.
// Usage: npm run smoke:agent
import { runAdvisor } from '../advisor';

async function main() {
  const ac = new AbortController();
  const question =
    'In one or two sentences, what is the difference between a water allocation and a water entitlement in the Australian water market?';
  let streamed = '';
  for await (const ev of runAdvisor({ prompt: question, abortController: ac })) {
    if (ev.type === 'session') console.error(`[session] id=${ev.sessionId} apiKeySource=${ev.apiKeySource} model=${ev.model}`);
    else if (ev.type === 'delta') { process.stdout.write(ev.text); streamed += ev.text; }
    else if (ev.type === 'tool') console.error(`\n[tool] ${ev.name}`);
    else if (ev.type === 'done') { console.error(`\n[done] chars=${(ev.text || streamed).length} costUsd=${ev.costUsd ?? 'n/a'}`); process.exit(0); }
    else if (ev.type === 'error') { console.error(`\n[ERROR] ${ev.message}`); process.exit(2); }
  }
  process.exit(0);
}

main().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
