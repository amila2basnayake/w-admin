<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"
    trimDirectiveWhitespaces="true"
    import="com.waterfind.dto.user.UserCredentialsDto,
            com.waterfind.server.ServiceRequest,
            java.io.File,
            java.io.FileInputStream,
            java.util.Properties,
            java.util.UUID,
            javax.crypto.Mac,
            javax.crypto.spec.SecretKeySpec,
            javax.xml.bind.DatatypeConverter"%>
<%!
    // AI Trainer host page — the tool behind "AI Trainer Home" (jsp/admin/ai-trainer-home.jsp
    // embeds this page; staff can also open it directly).
    //
    // Mints the SAME short-lived HMAC bearer token as ai-advisor.jsp — the sidecar's /trainer
    // routes then apply the authoritative gate: a fresh lookup in the database of BOTH the staff
    // usertype (broker/sales/admin) AND the AI_TRAINER CRM role (user_role_map), fail-closed (see
    // services/ai-advisor/src/trainer/auth.ts). This page only decides whether to bother rendering:
    // definitive CLIENT accounts (isUserDirect) are refused outright; for the rest, the sidecar's DB
    // check is what admits or denies, and the SPA shows a role-specific gate when it is refused.

    private static Properties AI_PROPS;
    private static synchronized Properties props() {
        if (AI_PROPS == null) {
            Properties p = new Properties();
            File f = new File(System.getProperty("user.home"), ".waterfind-ai-advisor.properties");
            FileInputStream in = null;
            try { in = new FileInputStream(f); p.load(in); }
            catch (Exception e) { /* fail closed: p stays empty -> no secret -> refuse to mint */ }
            finally { if (in != null) try { in.close(); } catch (Exception ig) {} }
            AI_PROPS = p;
        }
        return AI_PROPS;
    }

    private static String b64url(byte[] bytes) {
        String s = DatatypeConverter.printBase64Binary(bytes);
        s = s.replace('+', '-').replace('/', '_');
        int pad = s.indexOf('=');
        return pad >= 0 ? s.substring(0, pad) : s;
    }
    private static String jsonEscape(String v) {
        if (v == null) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n");  break;
                case '\r': b.append("\\r");  break;
                case '\t': b.append("\\t");  break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }
    // Mint "<base64url(json)>.<base64url(hmacSha256(secret, body))>" — MUST match the sidecar verifier.
    private static String mintToken(String secret, long uid, String name, int ut, long ttlSeconds) throws Exception {
        long now = System.currentTimeMillis() / 1000L;
        String nonce = UUID.randomUUID().toString().replace("-", "");
        String json = "{\"uid\":" + uid
            + ",\"name\":\"" + jsonEscape(name) + "\""
            + ",\"ut\":" + ut
            + ",\"iat\":" + now
            + ",\"exp\":" + (now + ttlSeconds)
            + ",\"nonce\":\"" + nonce + "\"}";
        String body = b64url(json.getBytes("UTF-8"));
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes("UTF-8"), "HmacSHA256"));
        String sig = b64url(mac.doFinal(body.getBytes("US-ASCII")));
        return body + "." + sig;
    }
%>
<%
    // ---- identity (fail closed; same session source as ai-advisor.jsp) -----
    UserCredentialsDto creds = null;
    try { creds = (UserCredentialsDto) session.getAttribute("waterfind_user_credentials"); } catch (Exception e) { creds = null; }
    if (creds == null) { try { creds = ServiceRequest.getServiceRequest().getUserCredentials(); } catch (Exception e) { creds = null; } }
    boolean loggedIn = (creds != null && creds.getUserId() != null);
    // Definitive client accounts never get a shell. Everyone else is resolved by the sidecar's DB
    // usertype check (the `ut` catch-all cannot distinguish broker staff from broker clients).
    boolean maybeStaff = loggedIn && !creds.isUserDirect();

    Properties p = props();
    String secret  = p.getProperty("wf.ai.secret");
    String baseUrl = p.getProperty("wf.ai.base-url", "http://localhost:3100");
    long   ttl     = Long.parseLong(p.getProperty("wf.ai.token-ttl", "1800"));
    boolean configured = (secret != null && secret.length() >= 16);

    String token = null;
    long   uid   = 0L;
    String uname = "";
    if (maybeStaff && configured) {
        uid = creds.getUserId().longValue();
        uname = creds.getSpokenName();
        if (uname == null || uname.trim().length() == 0) uname = creds.getUsername();
        int ut = creds.isAdmin() ? 3 : (creds.isSales() ? 2 : (creds.isUserDirect() ? 0 : 1));
        try { token = mintToken(secret, uid, uname, ut, ttl); } catch (Exception e) { token = null; }
    }

    // ---- token-refresh mode: /ai-curator.html?token=1 -> JSON only ---------
    if ("1".equals(request.getParameter("token"))) {
        out.clearBuffer();
        response.setContentType("application/json; charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        if (token != null) {
            long exp = (System.currentTimeMillis() / 1000L) + ttl;
            out.print("{\"token\":\"" + token + "\",\"exp\":" + exp + "}");
        } else {
            response.setStatus(401);
            out.print("{\"error\":\"not authenticated\"}");
        }
        return;
    }
%>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Trainer</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/jsp/style/font-awesome-4.3.0/css/font-awesome.min.css" />
    <%-- ?v= is the deployed file's mtime, so a redeploy busts the browser cache on the next page
         load (the speech engine ai-voice.js and this page's script must always be the same build). --%>
    <%
        long assetV = 0L;
        try { assetV = new java.io.File(application.getRealPath("/jsp/userhome/app/ai-curator.js")).lastModified(); } catch (Exception e) {}
        try { assetV = Math.max(assetV, new java.io.File(application.getRealPath("/jsp/userhome/app/ai-voice.js")).lastModified()); } catch (Exception e) {}
    %>
    <link rel="stylesheet" href="/jsp/userhome/app/ai-voice.css?v=<%= assetV %>" />
    <link rel="stylesheet" href="/jsp/userhome/app/ai-curator.css?v=<%= assetV %>" />
</head>
<body>
<% if (!loggedIn) { %>
    <div class="wft-gate">
        <i class="fa fa-lock"></i>
        <h2>Please log in</h2>
        <p>Your session has expired. Please <a href="/logout.html">log in</a> again.</p>
    </div>
<% } else if (!maybeStaff) { %>
    <div class="wft-gate">
        <i class="fa fa-lock"></i>
        <h2>Staff only</h2>
        <p>The AI Trainer is an internal Waterfind tool.</p>
    </div>
<% } else if (!configured || token == null) { %>
    <div class="wft-gate">
        <i class="fa fa-exclamation-triangle"></i>
        <h2>AI Trainer unavailable</h2>
        <p>The advisor service is not configured on this server.</p>
    </div>
<% } else { %>
    <div id="wfc-root"></div>
    <script>
        window.WFCUR = {
            token:    <%= "\"" + token + "\"" %>,
            baseUrl:  <%= "\"" + jsonEscape(baseUrl) + "\"" %>,
            userId:   <%= uid %>,
            userName: <%= "\"" + jsonEscape(uname) + "\"" %>,
            tokenTtl: <%= ttl %>,
            refreshUrl: "/ai-curator.html?token=1"
        };
    </script>
    <script src="/jsp/userhome/app/ai-voice.js?v=<%= assetV %>"></script>
    <script src="/jsp/userhome/app/ai-curator.js?v=<%= assetV %>"></script>
<% } %>
</body>
</html>
