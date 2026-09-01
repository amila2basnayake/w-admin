<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"
    trimDirectiveWhitespaces="true"
    import="com.waterfind.Waterfind,
            com.waterfind.server.ServiceRequest,
            com.waterfind.dto.user.UserCredentialsDto,
            java.io.File,
            java.io.FileInputStream,
            java.util.Properties,
            java.util.UUID,
            javax.crypto.Mac,
            javax.crypto.spec.SecretKeySpec,
            javax.xml.bind.DatatypeConverter"%>
<%!
    // Broker-assist rail host page (staff-only). Loaded in the 400px rail iframe on the CRM
    // client page (user-reg-details.body.jsp) as /ai-client-advisor.html?clientId=<waterfind_user.id>.
    //
    // Mints the SAME short-lived HMAC bearer token as ai-advisor.jsp, PLUS a signed `act` claim
    // binding the token to the viewed client — the sidecar's /assist routes only admit tokens
    // carrying `act`, and re-verify the CALLER's staff usertype fresh from the database
    // (fail-closed; see services/ai-advisor/src/staff.ts). This page only decides whether to
    // bother rendering: definitive CLIENT accounts (isUserDirect) are refused outright, and the
    // clientId must resolve to a real account before any token is minted. The URL parameter is
    // never the scoping mechanism — only the signed claim is.

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
    private static String htmlEscape(String v) {
        if (v == null) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            switch (c) {
                case '&':  b.append("&amp;");  break;
                case '<':  b.append("&lt;");   break;
                case '>':  b.append("&gt;");   break;
                case '"':  b.append("&quot;"); break;
                case '\'': b.append("&#39;");  break;
                default:   b.append(c);
            }
        }
        return b.toString();
    }
    // Mint "<base64url(json)>.<base64url(hmacSha256(secret, body))>" — MUST match the sidecar
    // verifier (src/auth.ts), including the optional act/actName claims.
    private static String mintAssistToken(String secret, long uid, String name, int ut,
                                          long ttlSeconds, long actUid, String actName) throws Exception {
        long now = System.currentTimeMillis() / 1000L;
        String nonce = UUID.randomUUID().toString().replace("-", "");
        String json = "{\"uid\":" + uid
            + ",\"name\":\"" + jsonEscape(name) + "\""
            + ",\"ut\":" + ut
            + ",\"iat\":" + now
            + ",\"exp\":" + (now + ttlSeconds)
            + ",\"nonce\":\"" + nonce + "\""
            + ",\"act\":" + actUid
            + ",\"actName\":\"" + jsonEscape(actName) + "\"}";
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

    // ---- target client (from ?clientId=, resolved server-side) -------------
    long clientId = 0L;
    try { clientId = Long.parseLong(request.getParameter("clientId")); } catch (Exception e) { clientId = 0L; }
    String clientName = null;
    String clientUsername = null;
    if (maybeStaff && clientId > 0) {
        try {
            // Bare-forward JSP: the filter ran ServiceRequest.prepare() but nothing seeded the
            // user — seed it from the session before calling through the delegate (same pattern
            // as ai-advisor.jsp).
            ServiceRequest.getServiceRequest().setLoggedInUserId(creds.getUserId());
            ServiceRequest.getServiceRequest().setUserCredentials(creds);
            UserCredentialsDto target = Waterfind.getWaterfindDelegate().getUserCredentials(Long.valueOf(clientId));
            if (target != null) {
                clientName = target.getSpokenName();
                if (clientName == null || clientName.trim().length() == 0) clientName = target.getUsername();
                clientUsername = target.getUsername();
            }
        } catch (Throwable t) { clientName = null; }
    }

    Properties p = props();
    String secret  = p.getProperty("wf.ai.secret");
    String baseUrl = p.getProperty("wf.ai.base-url", "http://localhost:3100");
    long   ttl     = Long.parseLong(p.getProperty("wf.ai.token-ttl", "1800"));
    boolean configured = (secret != null && secret.length() >= 16);

    String token = null;
    long   uid   = 0L;
    String uname = "";
    if (maybeStaff && configured && clientName != null) {
        uid = creds.getUserId().longValue();
        uname = creds.getSpokenName();
        if (uname == null || uname.trim().length() == 0) uname = creds.getUsername();
        int ut = creds.isAdmin() ? 3 : (creds.isSales() ? 2 : (creds.isUserDirect() ? 0 : 1));
        try { token = mintAssistToken(secret, uid, uname, ut, ttl, clientId, clientName); } catch (Exception e) { token = null; }
    }

    // ---- token-refresh mode: /ai-client-advisor.html?token=1&clientId=N ----
    // Also what the Add Comment popup's prefill script calls (registry-add-comment-prefill.jspf):
    // it has no other way to learn the sidecar base URL, so `base` rides along with the token.
    if ("1".equals(request.getParameter("token"))) {
        out.clearBuffer();
        response.setContentType("application/json; charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        if (token != null) {
            long exp = (System.currentTimeMillis() / 1000L) + ttl;
            out.print("{\"token\":\"" + token + "\",\"exp\":" + exp + ",\"base\":\"" + jsonEscape(baseUrl) + "\"}");
        } else {
            response.setStatus(401);
            out.print("{\"error\":\"not authenticated\"}");
        }
        return;
    }

    boolean popout = "1".equals(request.getParameter("popout"));
%>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor — <%= htmlEscape(clientName != null ? clientName : "client") %></title>
    <link rel="stylesheet" href="/jsp/style/font-awesome-4.3.0/css/font-awesome.min.css" />
    <%-- ?v= is the deployed file's mtime, so a redeploy busts the browser cache on the next page
         load — without it, brokers keep running the previous panel until a hard refresh. --%>
    <%
        long assetV = 0L;
        try { assetV = new java.io.File(application.getRealPath("/jsp/userhome/app/ai-client-advisor.js")).lastModified(); } catch (Exception e) {}
        try { assetV = Math.max(assetV, new java.io.File(application.getRealPath("/jsp/userhome/app/ai-voice.js")).lastModified()); } catch (Exception e) {}
    %>
    <link rel="stylesheet" href="/jsp/userhome/app/ai-voice.css?v=<%= assetV %>" />
    <link rel="stylesheet" href="/jsp/userhome/app/ai-client-advisor.css?v=<%= assetV %>" />
</head>
<body>
<% if (!loggedIn) { %>
    <div class="wfai-gate">
        <i class="fa fa-lock"></i>
        <h2>Please log in</h2>
        <p>Your session has expired. Please <a href="/logout.html" target="_top">log in</a> again.</p>
    </div>
<% } else if (!maybeStaff) { %>
    <div class="wfai-gate">
        <i class="fa fa-lock"></i>
        <h2>Staff only</h2>
        <p>The client advisor panel is an internal Waterfind tool.</p>
    </div>
<% } else if (clientId <= 0 || clientName == null) { %>
    <div class="wfai-gate">
        <i class="fa fa-exclamation-triangle"></i>
        <h2>Unknown client</h2>
        <p>This panel must be opened from a client's CRM page.</p>
    </div>
<% } else if (!configured || token == null) { %>
    <div class="wfai-gate">
        <i class="fa fa-exclamation-triangle"></i>
        <h2>Advisor unavailable</h2>
        <p>The AI advisor service is not configured on this server. Please contact support.</p>
    </div>
<% } else { %>
    <div id="wfaic-root"></div>
    <script>
        window.WFAIC = {
            token:      <%= "\"" + token + "\"" %>,
            baseUrl:    <%= "\"" + jsonEscape(baseUrl) + "\"" %>,
            clientId:   <%= clientId %>,
            clientName: <%= "\"" + jsonEscape(clientName) + "\"" %>,
            clientMeta: <%= "\"" + jsonEscape("Client #" + clientId + (clientUsername != null ? " · " + clientUsername : "")) + "\"" %>,
            staffName:  <%= "\"" + jsonEscape(uname) + "\"" %>,
            tokenTtl:   <%= ttl %>,
            refreshUrl: "/ai-client-advisor.html?token=1&clientId=<%= clientId %>",
            popout:     <%= popout ? "true" : "false" %>
        };
    </script>
    <script src="/jsp/userhome/app/ai-voice.js?v=<%= assetV %>"></script>
    <script src="/jsp/userhome/app/ai-client-advisor.js?v=<%= assetV %>"></script>
<% } %>
</body>
</html>
