// Deploy the Call Campaigns CRM-side files into BOTH CRM trees from the reference copies here:
//   node services/ai-advisor/crm-seam/deploy-campaigns.mjs      (run from the repo root)
// Copies ai-campaigns.jsp/.js/.css (jsp/userhome/app) and ai-campaigns-home.jsp (jsp/admin), adds the
// two struts actions when missing, and adds the "Call Campaigns" tab to the manager home-page strip
// when missing. Idempotent; keeps each CRM file's own line endings (the SVN checkout is CRLF). JSPs
// hot-compile on the next hit; the struts actions need a Resin restart the first time.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const CRM = 'crm/waterfind.com.au';
const trees = ['webapp', 'build-dev/waterfind'];
const SEAM = 'services/ai-advisor/crm-seam';

/** Edit a CRM text file with LF-normalised content; write back in its original EOL style. Returns true if changed. */
function patchFile(path, fn) {
  const raw = readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  const lf = raw.replace(/\r\n/g, '\n');
  const out = fn(lf);
  if (out === lf) return false;
  writeFileSync(path, crlf ? out.replace(/\n/g, '\r\n') : out);
  return true;
}

const HOME_ACTION = `
        <!-- Call Campaigns (staff home page; the tool renders for BROKER / SU role holders and the advisor
             sidecar re-verifies staff usertype + role from the DB on every request, fail-closed) -->
        <action
            path="/ai-campaigns-home"
            type="com.waterfind.user.CheckSalesAdminLoggedInAction">
            <forward name="success" path="/jsp/admin/ai-campaigns-home.jsp"/>
            <forward name="failure" path="/login.html?nextPage=/ai-campaigns-home.html"/>
        </action>
`;
const TOOL_ACTION = `		<!-- Call Campaigns tool (staff-only; the sidecar verifies staff usertype + BROKER/SU role from the DB, fail-closed) -->
		<action path="/ai-campaigns" forward="/jsp/userhome/app/ai-campaigns.jsp"/>
`;

for (const t of trees) {
  // 1) static assets + host pages
  for (const f of ['ai-campaigns.jsp', 'ai-campaigns.js', 'ai-campaigns.css']) copyFileSync(`${SEAM}/${f}`, `${CRM}/${t}/jsp/userhome/app/${f}`);
  copyFileSync(`${SEAM}/ai-campaigns-home.jsp`, `${CRM}/${t}/jsp/admin/ai-campaigns-home.jsp`);

  // 2) struts actions (insert once, next to the AI Trainer ones)
  const strutsChanged = patchFile(`${CRM}/${t}/WEB-INF/struts-config.xml`, (s) => {
    if (!s.includes('path="/ai-campaigns-home"')) {
      const anchor = s.indexOf('path="/ai-trainer-home"');
      if (anchor < 0) throw new Error('ai-trainer-home action not found in struts-config.xml');
      const end = s.indexOf('</action>', anchor) + '</action>'.length;
      s = s.slice(0, end) + '\n' + HOME_ACTION + s.slice(end);
    }
    if (!s.includes('path="/ai-campaigns"')) {
      const anchor = s.indexOf('<action path="/ai-curator"');
      if (anchor < 0) throw new Error('ai-curator forward not found in struts-config.xml');
      const end = s.indexOf('\n', anchor) + 1;
      s = s.slice(0, end) + TOOL_ACTION + s.slice(end);
    }
    return s;
  });

  // 3) the manager home-page tab strip
  patchFile(`${CRM}/${t}/jsp/common/manager-homepage-links.jsp`, (l) => {
    if (l.includes('ai-campaigns-home')) return l;
    const before = l;
    l = l.replace(
      `	} else if(servletPath.indexOf("ai-trainer") != -1) {\n		pageIndex = 7;\n	}`,
      `	} else if(servletPath.indexOf("ai-trainer") != -1) {\n		pageIndex = 7;\n	} else if(servletPath.indexOf("ai-campaigns") != -1) {\n		pageIndex = 8;\n	}`);
    l = l.replace(
      `	boolean showAiTrainer = wfDelegate.hasAccess(UserRoles.ROLE_AI_TRAINER, loggedInUserId);\n`,
      `	boolean showAiTrainer = wfDelegate.hasAccess(UserRoles.ROLE_AI_TRAINER, loggedInUserId);\n	// Call Campaigns: outbound AI Advisor calls to a list of clients — brokers (BROKER) and superusers (SU).\n	boolean showCallCampaigns = wfDelegate.hasAccess(UserRoles.ROLE_BROKER, loggedInUserId) || wfDelegate.hasAccess(UserRoles.ROLE_SUPERUSER, loggedInUserId);\n`);
    l = l.replace(
      `showMarketingTeam || showCeo || showAiTrainer)`,
      `showMarketingTeam || showCeo || showAiTrainer || showCallCampaigns)`);
    l = l.replace(
      `				href="/ai-trainer-home.html">AI Trainer Home</a> &nbsp;\n		</td>\n		<%\n			}\n`,
      `				href="/ai-trainer-home.html">AI Trainer Home</a> &nbsp;\n		</td>\n		<%\n			}\n\n			if(showCallCampaigns)\n			{\n		%>\n		<td>\n			<a <%=pageIndex==8 ? selectedStyle : "" %>\n				href="/ai-campaigns-home.html">Call Campaigns</a> &nbsp;\n		</td>\n		<%\n			}\n`);
    if (l === before || !l.includes('showCallCampaigns)') || !l.includes('pageIndex = 8') || !l.includes('pageIndex==8')) throw new Error('could not patch manager-homepage-links.jsp (anchors not found)');
    return l;
  });
  console.log('deployed to', t, strutsChanged ? '(struts-config changed — restart Resin)' : '');
}
