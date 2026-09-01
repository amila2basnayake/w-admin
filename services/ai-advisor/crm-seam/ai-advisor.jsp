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
    // ---- config (loaded once) ---------------------------------------------
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

    // ---- crypto helpers (Java 7 safe; no java.util.Base64) -----------------
    private static String b64url(byte[] bytes) {
        String s = DatatypeConverter.printBase64Binary(bytes);
        s = s.replace('+', '-').replace('/', '_');
        int pad = s.indexOf('=');
        return pad >= 0 ? s.substring(0, pad) : s;
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
    // ---- identity (fail closed) -------------------------------------------
    // Read from the session (set at login: WaterfindAction.LOGGED_IN_USER_CREDENTIALS_ATTRIBUTE).
    // This page is reached via a bare Struts <forward> (no WaterfindAction), so the ServiceRequest
    // thread-local is NOT seeded here — the session attribute is the reliable source.
    UserCredentialsDto creds = null;
    try { creds = (UserCredentialsDto) session.getAttribute("waterfind_user_credentials"); } catch (Exception e) { creds = null; }
    if (creds == null) { try { creds = ServiceRequest.getServiceRequest().getUserCredentials(); } catch (Exception e) { creds = null; } }
    boolean loggedIn = (creds != null && creds.getUserId() != null);

    // ---- per-client AI Advisor flag (enforced here, not just in the menu) --
    // The session credential is minted at login, so a broker's toggle must bite on the
    // next page load, not the next login: re-read fresh through the delegate. On any
    // delegate failure fall back to the session value (flag is default-ON).
    boolean advisorEnabled = true;
    String brokerName = null, brokerEmail = null, brokerPhone = null;
    if (loggedIn) {
        try { advisorEnabled = creds.isAiAdvisor(); } catch (Throwable t) { advisorEnabled = true; }
        try {
            // Bare-forward JSP: the filter ran ServiceRequest.prepare() but nothing seeded
            // the user — seed it from the session before calling through the delegate.
            ServiceRequest.getServiceRequest().setLoggedInUserId(creds.getUserId());
            ServiceRequest.getServiceRequest().setUserCredentials(creds);
            UserCredentialsDto fresh = Waterfind.getWaterfindDelegate().getUserCredentials(creds.getUserId());
            if (fresh != null) {
                advisorEnabled = fresh.isAiAdvisor();
                brokerName  = fresh.getBrokerName();
                brokerEmail = fresh.getBrokerEmail();
                brokerPhone = fresh.getBrokerPhone();
            }
        } catch (Throwable t) { /* keep the session-derived value */ }
    }

    Properties p = props();
    String secret  = p.getProperty("wf.ai.secret");
    String baseUrl = p.getProperty("wf.ai.base-url", "http://localhost:3100");
    long   ttl     = Long.parseLong(p.getProperty("wf.ai.token-ttl", "1800"));
    boolean configured = (secret != null && secret.length() >= 16);

    String token = null;
    long   uid   = 0L;
    String uname = "";
    if (loggedIn && configured && advisorEnabled) {
        uid = creds.getUserId().longValue();
        uname = creds.getSpokenName();
        if (uname == null || uname.trim().length() == 0) uname = creds.getUsername();
        int ut = creds.isAdmin() ? 3 : (creds.isSales() ? 2 : (creds.isUserDirect() ? 0 : 1));
        try { token = mintToken(secret, uid, uname, ut, ttl); } catch (Exception e) { token = null; }
    }

    // ---- token-refresh mode: /ai-advisor.html?token=1 -> JSON only --------
    if ("1".equals(request.getParameter("token"))) {
        out.clearBuffer();
        response.setContentType("application/json; charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        if (token != null) {
            long exp = (System.currentTimeMillis() / 1000L) + ttl;
            out.print("{\"token\":\"" + token + "\",\"exp\":" + exp + "}");
        } else if (loggedIn && !advisorEnabled) {
            response.setStatus(403);
            out.print("{\"error\":\"advisor access disabled\"}");
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
    <title>AI Water Advisor</title>
    <link rel="stylesheet" href="/jsp/style/font-awesome-4.3.0/css/font-awesome.min.css" />
    <%-- ?v= is the deployed file's mtime, so a redeploy busts the browser cache on the next page
         load (the speech engine ai-voice.js and this page's script must always be the same build). --%>
    <%
        long assetV = 0L;
        try { assetV = new java.io.File(application.getRealPath("/jsp/userhome/app/ai-advisor.js")).lastModified(); } catch (Exception e) {}
        try { assetV = Math.max(assetV, new java.io.File(application.getRealPath("/jsp/userhome/app/ai-voice.js")).lastModified()); } catch (Exception e) {}
    %>
    <link rel="stylesheet" href="/jsp/userhome/app/ai-voice.css?v=<%= assetV %>" />
    <link rel="stylesheet" href="/jsp/userhome/app/ai-advisor.css?v=<%= assetV %>" />
</head>
<body>
<% if (!loggedIn) { %>
    <div class="wfai-gate">
        <i class="fa fa-lock"></i>
        <h2>Please log in</h2>
        <p>Your session has expired. Please <a href="/logout.html">log in</a> again to use the AI Water Advisor.</p>
    </div>
<% } else if (!advisorEnabled) { %>
    <%-- Reach-out-for-access page — same card + activation-request flow as the Premium
         Water Data promo (premium-dashboard-prmo.jsp); unknown pageType routes the email
         to the admin team. No token is minted on this branch. --%>
    <style>
      body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #333; background: #f4f6f4; margin: 0; padding: 0; }
      .content { max-width: 860px; margin: 28px auto; padding: 0 20px; }
      .card { background: #fff; border: 1px solid #dde3dd; border-radius: 8px; overflow: hidden; }
      .card-header { background: #1b3a2d; padding: 18px 24px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .card-header-text h1 { font-size: 18px; font-weight: bold; color: #fff; margin: 0 0 5px 0; }
      .card-header-text p  { font-size: 13px; color: #9cc4b0; margin: 0; line-height: 1.5; }
      .btn-activate { flex-shrink: 0; background: #4caf82; color: #fff; border: none; border-radius: 6px; padding: 9px 18px; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; letter-spacing: 0.2px; text-decoration: none; display: inline-block; transition: background 0.2s; }
      .btn-activate:hover { background: #3a9468; }
      .activation-thankyou { display: inline-block; background: #e6f4eb; color: #2e7d4f; border: 1px solid #b7dcbf; border-radius: 6px; padding: 9px 16px; font-size: 13px; font-weight: 600; }
      .card-body { padding: 24px; }
      .card-desc { line-height: 1.6; margin: 0 0 16px 0; }
      .broker-box { background: #f7faf8; border: 1px solid #e4ede7; border-radius: 6px; padding: 14px 16px; font-size: 13px; line-height: 1.7; }
      .broker-box b { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.7px; color: #888; margin-bottom: 4px; }
    </style>
    <script src="/bootstrap/js/jquery.js"></script>
    <script src="/jsp/js/bootstrap-common.js"></script>
    <div class="content">
      <div class="card">
        <div class="card-header">
          <div class="card-header-text">
            <h1>AI Water Advisor</h1>
            <p>Reach out for access to Waterfind's AI Water Advisor.</p>
          </div>
          <a class="btn-activate"
             href="#"
             data-page-name="AI Advisor"
             data-page-type="ai-advisor"
             data-user-id="<%= creds.getUserId() %>">
            &#9654;&nbsp; Request Access
          </a>
        </div>
        <div class="card-body">
          <p class="card-desc">
            The AI Water Advisor is not currently enabled on your account. To gain access, reach
            out to your broker or click <b>Request Access</b> above and the Waterfind team will be
            in contact with you.
          </p>
          <% if (brokerName != null && brokerName.trim().length() > 0) { %>
          <div class="broker-box">
            <b>Your broker</b>
            <%= htmlEscape(brokerName) %><br/>
            <% if (brokerPhone != null && brokerPhone.trim().length() > 0) { %>Phone: <%= htmlEscape(brokerPhone) %><br/><% } %>
            <% if (brokerEmail != null && brokerEmail.trim().length() > 0) { %>Email: <a href="mailto:<%= htmlEscape(brokerEmail) %>"><%= htmlEscape(brokerEmail) %></a><% } %>
          </div>
          <% } %>
        </div>
      </div>
    </div>
    <script>
    $(document).ready(function() {
        $('.btn-activate').on('click', function(e) {
            e.preventDefault();
            var btn = $(this);
            if (btn.data('submitted')) return;
            btn.data('submitted', true);
            btn.text('Sending...').css('opacity', '0.7');
            sendAjax(
                '/submit-activation-request.html',
                'pageName=' + encodeURIComponent(btn.data('page-name')) +
                '&pageType=' + encodeURIComponent(btn.data('page-type')) +
                '&userId='   + encodeURIComponent(btn.data('user-id')),
                function(data) {
                    if (data && data.Success) {
                        btn.replaceWith('<span class="activation-thankyou">&#10003;&nbsp;' + data.Message + '</span>');
                    } else {
                        btn.css('opacity', '1').text('Request Access');
                        btn.data('submitted', false);
                        alert(data && data.Message ? data.Message : 'Something went wrong. Please try again.');
                    }
                },
                false
            );
        });
    });
    </script>
<% } else if (!configured || token == null) { %>
    <div class="wfai-gate">
        <i class="fa fa-exclamation-triangle"></i>
        <h2>Advisor unavailable</h2>
        <p>The AI advisor service is not configured on this server. Please contact support.</p>
    </div>
<% } else { %>
    <div id="wfai-root"></div>
    <script>
        window.WFAI = {
            token:    <%= "\"" + token + "\"" %>,
            baseUrl:  <%= "\"" + jsonEscape(baseUrl) + "\"" %>,
            userId:   <%= uid %>,
            userName: <%= "\"" + jsonEscape(uname) + "\"" %>,
            tokenTtl: <%= ttl %>,
            refreshUrl: "/ai-advisor.html?token=1"
        };
    </script>
    <script src="/jsp/userhome/app/ai-voice.js?v=<%= assetV %>"></script>
    <script src="/jsp/userhome/app/ai-advisor.js?v=<%= assetV %>"></script>
<% } %>
</body>
</html>
