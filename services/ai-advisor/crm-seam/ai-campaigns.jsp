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
    // Call Campaigns host page — the tool behind "Call Campaigns" (jsp/admin/ai-campaigns-home.jsp
    // embeds this page; staff can also open it directly at /ai-campaigns.html).
    //
    // Mints the SAME short-lived HMAC bearer token as ai-advisor.jsp / ai-curator.jsp. The sidecar's
    // /voice/campaigns routes then apply the authoritative gate: a fresh lookup in the database of the
    // staff usertype AND one of the voice-admin CRM roles (BROKER / SU — the broker-assist rule,
    // services/ai-advisor/src/staff.ts), fail-closed. This page only decides whether to bother
    // rendering: definitive CLIENT accounts (isUserDirect) are refused outright.

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

    // ---- token-refresh mode: /ai-campaigns.html?token=1 -> JSON only ---------
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
    long assetV = 0L;
    try { assetV = new java.io.File(application.getRealPath("/jsp/userhome/app/ai-campaigns.js")).lastModified(); } catch (Exception e) {}
%>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Call Campaigns</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/jsp/style/font-awesome-4.3.0/css/font-awesome.min.css" />
    <link rel="stylesheet" href="/jsp/userhome/app/ai-campaigns.css?v=<%= assetV %>" />
</head>
<body>
<% if (!loggedIn) { %>
    <div class="wfk-gate">
        <i class="fa fa-lock"></i>
        <h2>Please log in</h2>
        <p>Your session has expired. Please <a href="/logout.html" target="_top">log in</a> again.</p>
    </div>
<% } else if (!maybeStaff) { %>
    <div class="wfk-gate">
        <i class="fa fa-lock"></i>
        <h2>Staff only</h2>
        <p>Call Campaigns is an internal Waterfind tool.</p>
    </div>
<% } else if (!configured || token == null) { %>
    <div class="wfk-gate">
        <i class="fa fa-exclamation-triangle"></i>
        <h2>Call Campaigns unavailable</h2>
        <p>The advisor service is not configured on this server.</p>
    </div>
<% } else { %>
    <div id="wfk-root"></div>
    <script>
        window.WFCAMP = {
            token:    <%= "\"" + token + "\"" %>,
            baseUrl:  <%= "\"" + jsonEscape(baseUrl) + "\"" %>,
            userId:   <%= uid %>,
            userName: <%= "\"" + jsonEscape(uname) + "\"" %>,
            tokenTtl: <%= ttl %>,
            refreshUrl: "/ai-campaigns.html?token=1"
        };
    </script>
    <script src="/jsp/userhome/app/ai-campaigns.js?v=<%= assetV %>"></script>
<% } %>
</body>
</html>
