<%@ page language="java" import="java.util.*, com.waterfind.core.*, com.waterfind.server.*, com.waterfind.business.user.UserRoles" %>
<%
	// AI Trainer Home - the home screen for staff who hold the AI Trainer role. It hosts the
	// AI Trainer (maintenance of the AI Water Advisor's knowledge base: documents, notes, uploads, history).
	//
	// Same skeleton as marketing-home.jsp / ceo-home.jsp: CRM chrome, the manager home-page tab
	// strip, a normal_header band, then the page body. The body is the AI Trainer app
	// (/ai-curator.html, the same seam page as the client-portal advisor tabs) in an iframe sized to
	// the viewport. Access: the struts action admits staff (sales/admin), and this page then renders
	// the tool only for the AI_TRAINER role - read fresh via hasAccess(), the same call the tab strip
	// makes, so a role granted mid-session bites on the next page load. The advisor sidecar re-checks
	// staff usertype AND the role from the database on every request, fail-closed, so the page gate
	// is a courtesy, not the security boundary.
	WaterfindDelegate wfDelegate = com.waterfind.Waterfind.getWaterfindDelegate();
	Long loggedInUserId = wfDelegate.getLoggedInUserId();
	boolean isAiTrainer = loggedInUserId != null && wfDelegate.hasAccess(UserRoles.ROLE_AI_TRAINER, loggedInUserId);
%>
<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">

<%@ taglib uri="/WEB-INF/tld/struts-bean.tld" prefix="bean" %>
<%@ taglib uri="/WEB-INF/tld/struts-html.tld" prefix="html" %>
<%@ taglib uri="/WEB-INF/tld/struts-logic.tld" prefix="logic" %>
<%@ taglib uri="/WEB-INF/tld/waterfind.tld" prefix="waterfind" %>

<html>
    <head>
        <title>
            Waterfind :: AI Trainer : Home
        </title>
        <!-- include the derived style from styleRef.jsp -->
        <jsp:include page="/jsp/styleRef.jsp">
        	<jsp:param name="gxt-colour" value="blue" />
        </jsp:include>

        <script language="javascript1.2" type="text/javascript" src="/jsp/js/dtree.js"></script>

        <link href="/jsp/style/main.css" rel="stylesheet" type="text/css" />

        <style type="text/css">
        	#ai-trainer-frame {
        		display: block;
        		width: 100%;
        		border: 1px solid #c9d4cc;
        		background: #f4f6f4;
        		min-height: 560px;
        	}
        	#ai-trainer-intro {
        		font-size: 11px;
        		color: #666666;
        		padding: 4px 0 8px 0;
        	}
        	#ai-trainer-intro a { color: #0093d0; }
        	#ai-trainer-noaccess {
        		border: 1px solid #c9d4cc;
        		background: #ffffff;
        		padding: 18px 20px;
        		margin: 6px 0 24px 0;
        		line-height: 1.5;
        	}
        	#ai-trainer-noaccess h3 { margin: 0 0 6px 0; }
        </style>
	</head>
	<body>
		<div id="wrapper">
        <jsp:include page="/jsp/waterfindHeaderRef.jsp"/>
	        <div id="content">
	            <%@include file="/jsp/waterMarket-menu.jsp" %>
	            <div id="market_section">

	            	<jsp:include page="/jsp/common/manager-homepage-links.jsp"/>

	                <div class="normal_header">AI Trainer Home</div>

					<input type="hidden" id="isAiTrainerPage" name="isAiTrainerPage" value="true"/>

	                <hr/>
<%
	if(isAiTrainer)
	{
%>
	                <div id="ai-trainer-intro">
	                	AI Trainer &mdash; keep the AI Water Advisor's knowledge base correct: its documents, the notes staff write for it, uploaded material, and a full change history with undo and restore. Work through the assistant or directly.
	                	&nbsp;<a href="/ai-curator.html" target="_blank">Open in its own window</a>
	                </div>

	                <iframe id="ai-trainer-frame" name="ai-trainer-frame" src="/ai-curator.html" frameborder="0"
	                	allow="microphone" title="AI Trainer"></iframe>

	                <script type="text/javascript">
	                	// Size the trainer to the rest of the viewport so its own panes scroll, not the page.
	                	(function () {
	                		function size() {
	                			var f = document.getElementById('ai-trainer-frame');
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
	                <div id="ai-trainer-noaccess">
	                	<h3 class="green">AI Trainer role required</h3>
	                	This home page is for staff who hold the <b>AI Trainer</b> role. A superuser can add it to your
	                	account: <i>Manage User Roles</i>, or the <i>Roles</i> button on your staff record.
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
