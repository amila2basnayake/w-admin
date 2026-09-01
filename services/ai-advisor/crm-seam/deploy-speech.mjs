// Deploy the speech-enabled chat surfaces into BOTH CRM trees from the reference copies here:
//   node services/ai-advisor/crm-seam/deploy-speech.mjs      (run from the repo root)
// Copies the shared speech engine (ai-voice.js/.css) plus every page that loads it — the client
// AI Advisor tab, the AI Trainer, the broker Client Rail — and the AI Trainer Home page (its iframe
// carries allow="microphone"). Idempotent. JSPs hot-compile on the next hit — no Resin restart.
// The Client Rail's embed block + Add Comment prefill are deploy-client-rail.mjs (unchanged here).
import { copyFileSync, statSync } from 'node:fs';
const CRM = 'crm/waterfind.com.au';
const SEAM = 'services/ai-advisor/crm-seam';
const trees = ['webapp', 'build-dev/waterfind'];
const APP = [
  'ai-voice.js', 'ai-voice.css',
  'ai-advisor.jsp', 'ai-advisor.js', 'ai-advisor.css',
  'ai-curator.jsp', 'ai-curator.js', 'ai-curator.css',
  'ai-client-advisor.jsp', 'ai-client-advisor.js', 'ai-client-advisor.css',
];
const ADMIN = ['ai-trainer-home.jsp'];
for (const t of trees) {
  for (const f of APP) copyFileSync(`${SEAM}/${f}`, `${CRM}/${t}/jsp/userhome/app/${f}`);
  for (const f of ADMIN) copyFileSync(`${SEAM}/${f}`, `${CRM}/${t}/jsp/admin/${f}`);
  const v = statSync(`${CRM}/${t}/jsp/userhome/app/ai-voice.js`).mtimeMs;
  console.log(`deployed to ${t}  (${APP.length + ADMIN.length} files; asset version ${Math.round(v)})`);
}
