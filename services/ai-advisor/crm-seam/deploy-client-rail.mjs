// Deploy the Client Rail + call-note prefill CRM-side files into BOTH CRM trees from the
// reference copies here:
//   node services/ai-advisor/crm-seam/deploy-client-rail.mjs      (run from the repo root)
// Replaces the embed block at the end of user-reg-details.body.jsp, inserts/refreshes the Add
// Comment prefill script in registry-add-comment.jsp, and copies ai-client-advisor.jsp/.js/.css.
// Idempotent. (JSPs hot-compile on the next hit — no Resin restart.)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const CRM = 'crm/waterfind.com.au';
const trees = ['webapp', 'build-dev/waterfind'];
const embed = readFileSync('services/ai-advisor/crm-seam/ai-client-advisor-embed.jspf', 'utf8');
const prefill = readFileSync('services/ai-advisor/crm-seam/registry-add-comment-prefill.jspf', 'utf8');
for (const t of trees) {
  // 1) embed block replace
  const bp = `${CRM}/${t}/jsp/admin/registry/segments/user-reg-details.body.jsp`;
  let b = readFileSync(bp, 'utf8');
  const s = b.indexOf('<%-- ================= AI Advisor client rail (broker-assist)');
  const eMark = '<%-- =============== end AI Advisor client rail (broker-assist) =============== --%>';
  const e = b.indexOf(eMark);
  if (s < 0 || e < 0) throw new Error('embed markers not found in ' + bp);
  b = b.slice(0, s) + embed.replace(/\r?\n$/, '') + b.slice(e + eMark.length);
  writeFileSync(bp, b);
  // 2) prefill insert after the Escape-key script (idempotent: replaced in place when present)
  const cp = `${CRM}/${t}/jsp/admin/registry/registry-add-comment.jsp`;
  let c = readFileSync(cp, 'utf8');
  const anchor = "document.getElementById('note').onkeydown = function(e) {return handled_keydown(e || window.event, this.id);};";
  const ai = c.indexOf(anchor);
  if (ai < 0) throw new Error('anchor not found in ' + cp);
  const closeIdx = c.indexOf('</script>', ai) + '</script>'.length;
  const startMark = '<%-- ============ AI Advisor call-note prefill';
  const endMark = '<%-- ========== end AI Advisor call-note prefill ========== --%>';
  const ps = c.indexOf(startMark), pe = c.indexOf(endMark);
  if (ps >= 0 && pe >= 0) c = c.slice(0, ps) + prefill.replace(/\r?\n$/, '') + c.slice(pe + endMark.length);
  else c = c.slice(0, closeIdx) + '\n' + prefill.replace(/\r?\n$/, '') + c.slice(closeIdx);
  writeFileSync(cp, c);
  // 3) host page + static assets
  for (const f of ['ai-client-advisor.jsp', 'ai-client-advisor.js', 'ai-client-advisor.css']) copyFileSync(`services/ai-advisor/crm-seam/${f}`, `${CRM}/${t}/jsp/userhome/app/${f}`);
  console.log('deployed to', t);
}
