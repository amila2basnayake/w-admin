/**
 * Create a Retell web call for the phone agent from the CLI (the browser demo page does the same via
 * POST /voice/demo/web-call). Prints the access token + call id.
 *   npm run voice:web-call -- [inbound|order_confirmation|…] [client_uid]
 */
import { voiceConfig } from '../voice/config';
import { retell } from '../voice/retell';
import { isOutboundFlow } from '../voice/flows';

async function main() {
  const [kind = 'inbound', uid] = process.argv.slice(2);
  const metadata: Record<string, unknown> = { demo: true };
  let agentId = voiceConfig.inboundAgentId;
  if (isOutboundFlow(kind)) { agentId = voiceConfig.outboundAgentId ?? voiceConfig.inboundAgentId; metadata.flow = kind; }
  if (uid) metadata.client_uid = Number(uid);
  if (!agentId) throw new Error('no agent configured — run npm run voice:setup');
  const call = await retell.createWebCall({ agent_id: agentId, metadata });
  console.log(JSON.stringify({ call_id: call.call_id, access_token: call.access_token, agent_id: agentId, kind }, null, 2));
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
