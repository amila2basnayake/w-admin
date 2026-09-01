<%@ page language="java" import="java.util.*, com.waterfind.core.*, com.waterfind.server.*, com.waterfind.business.user.UserRoles" %>
<%
	// Call Campaigns - the CRM home page for outbound AI Advisor call campaigns: build a call list,
	// write the brief, launch, and watch the outcomes land.
	//
	// Same skeleton as ai-trainer-home.jsp / marketing-home.jsp: CRM chrome, the manager home-page tab
	// strip, a normal_header band, then the tool (/ai-campaigns.html) in an iframe sized to the
	// viewport. Access: the struts action admits staff (sales/admin); this page renders the tool for
	// holders of the BROKER or SU role - read fresh via hasAccess(), the same rule the sidecar applies
	// (staff usertype AND one of ASSIST_ROLES, default BROKER,SU) to every /voice/campaigns request,
	// fail-closed. The page gate is a courtesy; the sidecar is the security boundary.
	WaterfindDelegate wfDelegate = com.waterfind.Waterfind.getWaterfindDelegate();
	Long loggedInUserId = wfDelegate.getLoggedInUserId();
	boolean canCampaign = loggedInUserId != null
		&& (wfDelegate.hasAccess(UserRoles.ROLE_BROKER, loggedInUserId) || wfDelegate.hasAccess(UserRoles.ROLE_SUPERUSER, loggedInUserId));
%>
<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">

<%@ taglib uri="/WEB-INF/tld/struts-bean.tld" prefix="bean" %>
<%@ taglib uri="/WEB-INF/tld/struts-html.tld" prefix="html" %>
<%@ taglib uri="/WEB-INF/tld/struts-logic.tld" prefix="logic" %>
<%@ taglib uri="/WEB-INF/tld/waterfind.tld" prefix="waterfind" %>

<html>
    <head>
        <title>
            Waterfind :: Call Campaigns
        </title>
        <!-- include the derived style from styleRef.jsp -->
        <jsp:include page="/jsp/styleRef.jsp">
        	<jsp:param name="gxt-colour" value="blue" />
        </jsp:include>

        <script language="javascript1.2" type="text/javascript" src="/jsp/js/dtree.js"></script>

        <link href="/jsp/style/main.css" rel="stylesheet" type="text/css" />

        <style type="text/css">
        	#ai-campaigns-frame {
        		display: block;
        		width: 100%;
        		border: 1px solid #c9d4cc;
        		background: #f4f6f4;
        		min-height: 560px;
        	}
        	#ai-campaigns-intro {
        		font-size: 11px;
        		color: #666666;
        		padding: 4px 0 8px 0;
        		text-align: right;
        	}
        	#ai-campaigns-intro a { color: #0093d0; }
        	#ai-campaigns-noaccess {
        		border: 1px solid #c9d4cc;
        		background: #ffffff;
        		padding: 18px 20px;
        		margin: 6px 0 24px 0;
        		line-height: 1.5;
        	}
        	#ai-campaigns-noaccess h3 { margin: 0 0 6px 0; }
        </style>
	</head>
	<body>
		<div id="wrapper">
        <jsp:include page="/jsp/waterfindHeaderRef.jsp"/>
	        <div id="content">
	            <%@include file="/jsp/waterMarket-menu.jsp" %>
	            <div id="market_section">

	            	<jsp:include page="/jsp/common/manager-homepage-links.jsp"/>

	                <div class="normal_header">Call Campaigns</div>

					<input type="hidden" id="isAiCampaignsPage" name="isAiCampaignsPage" value="true"/>

	                <hr/>
<%
	if(canCampaign)
	{
%>
	                <div id="ai-campaigns-intro">
	                	<a href="/ai-campaigns.html" target="_blank">Open in its own window</a>
	                </div>

	                <iframe id="ai-campaigns-frame" name="ai-campaigns-frame" src="/ai-campaigns.html" frameborder="0"
	                	title="Call Campaigns"></iframe>

	                <script type="text/javascript">
	                	// Size the tool to the rest of the viewport so its own panes scroll, not the page.
	                	(function () {
	                		function size() {
	                			var f = document.getElementById('ai-campaigns-frame');
	                			if (!f) return;
	                			var top = 0, e = f;
	                			while (e) { top += e.offsetTop || 0; e = e.offsetParent; }
	                			var vh = window.innerHeight || document.documentElement.clientHeight || 800;
	                			var h = vh - top - 28;
	                			f.style.height = Math.max(560, h) + 'px';
	                		}
	                		size();
	                		if (window.addEventListener) {
	                			window.addEventListener('resize', size, false);
	                			window.addEventListener('load', size, false);
	                		} else if (window.attachEvent) {
	                			window.attachEvent('onresize', size);
	                			window.attachEvent('onload', size);
	                		}
	                	})();
	                </script>
<%
	}
	else
	{
%>
	                <div id="ai-campaigns-noaccess">
	                	<h3 class="green">Broker role required</h3>
	                	Call Campaigns is for staff who hold the <b>Broker</b> or <b>Superuser</b> role. A superuser can add it to
	                	your account: <i>Manage User Roles</i>, or the <i>Roles</i> button on your staff record.
	                </div>
<%
	}
%>
	            </div>
			</div>
			<jsp:include page="/jsp/waterfindFooterRef.jsp"/>
		</div>
	</body>
</html>
