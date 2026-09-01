<%@ page language="java" contentType="application/json; charset=UTF-8" pageEncoding="UTF-8"
    trimDirectiveWhitespaces="true"
    import="com.waterfind.Waterfind,
            com.waterfind.server.WaterfindDelegate,
            com.waterfind.server.ServiceRequest,
            com.waterfind.dto.AddOrderListingDetailsDto,
            com.waterfind.dto.PropertyListItemDto,
            com.waterfind.dto.StateBasedFeesDto,
            com.waterfind.dto.WaterfindFeesDto,
            com.waterfind.dto.WaterfindFeesPropertiesDto,
            com.waterfind.dto.user.UserCredentialsDto,
            com.waterfind.dto.user.UserSettingsDto,
            com.waterfind.dto.order.ActiveRegionDto,
            com.waterfind.dto.order.ActiveRegionListDto,
            com.waterfind.dto.order.ActiveTerritoryDto,
            com.waterfind.dto.order.OrderListingRegionCriteriaDto,
            com.waterfind.dto.order.OrderListingSummartDto,
            com.google.gson.Gson,
            com.google.gson.JsonArray,
            com.google.gson.JsonObject,
            com.google.gson.JsonParser,
            java.io.ByteArrayOutputStream,
            java.io.File,
            java.io.FileInputStream,
            java.io.InputStream,
            java.security.MessageDigest,
            java.text.SimpleDateFormat,
            java.util.ArrayList,
            java.util.Calendar,
            java.util.Date,
            java.util.Iterator,
            java.util.LinkedHashMap,
            java.util.List,
            java.util.Map,
            java.util.Properties,
            java.util.concurrent.ConcurrentHashMap,
            javax.crypto.Mac,
            javax.crypto.spec.SecretKeySpec,
            javax.xml.bind.DatatypeConverter"%>
<%!
    /*
     * ai-broker-exec.jsp — SERVER-TO-SERVER order-execution seam for the AI Water Advisor.
     *
     * Called ONLY by the ai-advisor sidecar (services/ai-advisor), never by a browser.
     * Auth: HMAC-SHA256 over the EXACT request body bytes with the dedicated secret
     * `wf.ai.exec-secret` from ${user.home}/.waterfind-ai-advisor.properties, sent as the
     * X-WFAI-Signature header (base64url). Replay is bounded by the body's `iat` freshness
     * window. No CRM session is involved: the acting user is the signed body's clientId,
     * which the sidecar has already authenticated via its own bearer token.
     *
     * Idempotency (B1/H7): every mutating request carries an `idemKey` (the sidecar's
     * pending_order id, inside the HMAC-signed body so it cannot be forged). An
     * application-scoped in-memory map dedupes on (op, clientId, idemKey): a replayed or
     * retried request returns the ORIGINAL response verbatim and never executes twice.
     * The map is cleared by a Resin restart — acceptable because the `iat` freshness
     * window (±180 s) bounds how old a replayable capture can be, and the sidecar never
     * reuses a key for a different order.
     *
     * Response contract (B1): once addNewOrderListing/deleteOrderListing has SUCCEEDED,
     * the response is ALWAYS {"status":"success", ...} — post-placement work (summary
     * lookup, contact note) is isolated and reported via the `summaryOk`/`noteWritten`
     * flags, never as a failure. A {"status":"failed"} response therefore means the
     * operation definitively did NOT happen (safe to retry).
     *
     * Ops:
     *   place    {op:'place', iat, idemKey, clientId, propertyId, quantity, pricePerMl,
     *             isBuy, isPermanent, isListing?, expiry? (dd/MM/yyyy),
     *             regionIds? (the region set the user CONFIRMED on the card — when present
     *             the order is listed into exactly these regions, each of which must be in
     *             the CRM's own tradable enumeration, else the request fails BEFORE
     *             placement; absent = legacy behaviour, all default-selected regions),
     *             deliveryDate? (dd/MM/yyyy — non-null makes it a FORWARD order; must be a
     *             future date within 24 months, refused otherwise; NOTE a temp forward SELL
     *             is listed by the engine into ALL tradable regions for that date),
     *             split?, minSplitQuantity? (ML, required and > 0 when split, <= quantity),
     *             maxSplitParcelSize? (ML, optional cap per fill, 0 = none — split parcels
     *             may clear as several partial trades; a remainder below minSplitQuantity is
     *             auto-cancelled by the engine with a notification)}
     *            -> re-validates the property against the CRM's OWN licence enumeration
     *               (getLicenceListForClient: ownership + approval + spot/perm permission),
     *               caps sell volume at the licence volume, derives the tradable regions the
     *               order wizard would offer (getTradableRegionsForOrder), applies the
     *               property's fee structure, then places via the Spring-proxied
     *               WaterfindDelegate.addNewOrderListing — the real engine (market lock,
     *               auto-clearing, settlement).
     *   withdraw {op:'withdraw', iat, idemKey, clientId, orderListingId, reason?}
     *            -> deleteOrderListing as the client. Ownership of the listing is enforced
     *               by the sidecar (order_listing.owner / property registry check) before it
     *               signs the call; the legacy delete path itself is not ownership-gated.
     *
     * This mirrors action/trade/TestPlaceOrderAction (the wizard-equivalent programmatic
     * path) and doc 08's Part 11 rules: seed ServiceRequest thread-locals, call through
     * the delegate proxy (never the BO).
     */
    private static Properties AI_PROPS;
    private static synchronized Properties props() {
        if (AI_PROPS == null) {
            Properties p = new Properties();
            File f = new File(System.getProperty("user.home"), ".waterfind-ai-advisor.properties");
            FileInputStream in = null;
            try { in = new FileInputStream(f); p.load(in); }
            catch (Exception e) { /* fail closed: empty props -> no secret -> refuse */ }
            finally { if (in != null) try { in.close(); } catch (Exception ig) {} }
            AI_PROPS = p;
        }
        return AI_PROPS;
    }

    private static byte[] readBody(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) { buf.write(chunk, 0, n); }
        return buf.toByteArray();
    }

    private static byte[] b64urlDecode(String s) {
        String t = s.replace('-', '+').replace('_', '/');
        int pad = (4 - (t.length() % 4)) % 4;
        for (int i = 0; i < pad; i++) t += "=";
        return DatatypeConverter.parseBase64Binary(t);
    }

    private static boolean verifySignature(String secret, byte[] body, String sigB64url) {
        if (secret == null || secret.length() < 16 || sigB64url == null) return false;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes("UTF-8"), "HmacSHA256"));
            byte[] expected = mac.doFinal(body);
            byte[] got = b64urlDecode(sigB64url.trim());
            return MessageDigest.isEqual(expected, got);   // constant-time
        } catch (Exception e) {
            return false;
        }
    }

    private static String jsonOut(Map<String, Object> m) {
        return new Gson().toJson(m);
    }

    /*
     * Idempotency map (B1/H7): application-scoped, key = "op:clientId:idemKey", value =
     * "epochSeconds|payload" where payload is the terminal JSON response, or "*" while the
     * original request is still executing. Entries older than IDEM_TTL_SEC are pruned on
     * every request. In-memory by design (no CRM schema): a Resin restart clears it, which
     * the signed body's iat freshness window (±180 s) bounds.
     */
    private static final String IDEM_ATTR = "wfai.idemMap";
    private static final String IDEM_IN_PROGRESS = "*";
    private static final long IDEM_TTL_SEC = 900L;

    @SuppressWarnings("unchecked")
    private static ConcurrentHashMap<String, String> idemMap(ServletContext ctx) {
        synchronized (ctx) {
            ConcurrentHashMap<String, String> m =
                    (ConcurrentHashMap<String, String>) ctx.getAttribute(IDEM_ATTR);
            if (m == null) {
                m = new ConcurrentHashMap<String, String>();
                ctx.setAttribute(IDEM_ATTR, m);
            }
            return m;
        }
    }

    private static void idemPrune(ConcurrentHashMap<String, String> m) {
        long cutoff = (System.currentTimeMillis() / 1000L) - IDEM_TTL_SEC;
        Iterator<Map.Entry<String, String>> it = m.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, String> e = it.next();
            try {
                String v = e.getValue();
                long ts = Long.parseLong(v.substring(0, v.indexOf('|')));
                if (ts < cutoff) it.remove();
            } catch (Exception ex) {
                it.remove(); // malformed entry: drop it
            }
        }
    }

    /** Record the terminal response for this idempotency key and return it for printing. */
    private static String idemDone(ConcurrentHashMap<String, String> m, String key, String json) {
        if (m != null && key != null) {
            m.put(key, (System.currentTimeMillis() / 1000L) + "|" + json);
        }
        return json;
    }

    private static Map<String, Object> fail(String message) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("status", "failed");
        m.put("message", message);
        return m;
    }

    /** Apply the property's buyer fee structure (mirrors AddOrderListingAction stage 1). */
    private static void applyFees(WaterfindDelegate delegate, AddOrderListingDetailsDto dto, String propertyId) {
        StateBasedFeesDto stateFees = delegate.getStateBasedFeesForProperty(propertyId);
        if (stateFees == null) return;
        WaterfindFeesDto fees = dto.isTransferType()
                ? stateFees.getBuyerPermStructure() : stateFees.getBuyerTempStructure();
        if (fees == null) return;
        WaterfindFeesPropertiesDto fp = fees.getFeeStructureProperties();
        if (fp == null) return;
        dto.setFeesInDollar(fp.getWaterfindFee());
        dto.setFeesInPercentage(fp.getRangeOnePercentage());
        dto.setFeesPerML(fp.getRangeOneFeePerML());
        dto.setFeesInclusive(fp.getWaterfindFeeInclusive() != null ? fp.getWaterfindFeeInclusive() : true);
        dto.setChargeFeeRanges(fp.getChargeFeeRanges() != null ? fp.getChargeFeeRanges() : 0);
    }

    /** Regions the order wizard would offer as default-selected (mirrors stage 2).
     *  deliveryDate non-null = FORWARD: the criteria flag flips so the region set (and its
     *  fee loading) matches what the wizard derives for a delivery-dated order. */
    private static List<Long> deriveTradableRegions(WaterfindDelegate delegate, AddOrderListingDetailsDto dto, String propertyId, Date deliveryDate) {
        List<Long> selected = new ArrayList<Long>();
        ActiveRegionListDto regions = delegate.getTradableRegionsForOrder(
                new OrderListingRegionCriteriaDto(
                        dto.isTransferType(), dto.isBuyOrder(), null, propertyId,
                        dto.getQuantity(), dto.getPricePerMl(),
                        deliveryDate != null /* forward */, true /* load fees */, deliveryDate));
        if (regions != null && regions.getTerritories() != null) {
            for (ActiveTerritoryDto terr : regions.getTerritories()) {
                for (ActiveRegionDto reg : terr.getRegions()) {
                    if (reg.isSelected()) selected.add(Long.valueOf(reg.getRegionId()));
                }
            }
        }
        return selected;
    }

    /**
     * Best-effort: record a CRM Contact Note for a just-completed brokerage action, authored by a
     * dedicated "AI Advisor" CRM user. The author id is the SERVER-SIDE property
     * `wf.ai.note-author-id` (read the same way as the exec secret) — never the signed request
     * body, so the sidecar cannot choose who the note is attributed to. If that property is
     * missing/unparsable, or the account cannot be resolved for the acting client, the note is
     * skipped (logged) — a note must NEVER affect the trade outcome, so every failure is caught
     * and swallowed here. The Contact Notes table renders notes UNESCAPED, so the text is kept
     * plain (angle brackets / newlines stripped) and is composed only from server-side values.
     * Returns TRUE only when the note was actually written (H6: the caller reports this back to
     * the sidecar as `noteWritten` so an audit-trail gap is visible, never silent).
     */
    private static boolean writeClientNote(ServletContext ctx, WaterfindDelegate delegate,
            long clientId, long accountId, String note) {
        try {
            if (accountId <= 0L) {
                ctx.log("ai-broker-exec: no accountId supplied; skipping client note for client " + clientId);
                return false;
            }
            String authorRaw = props().getProperty("wf.ai.note-author-id");
            if (authorRaw == null || authorRaw.trim().length() == 0) {
                ctx.log("ai-broker-exec: wf.ai.note-author-id not configured; skipping client note");
                return false;
            }
            long authorId;
            try {
                authorId = Long.parseLong(authorRaw.trim());
            } catch (NumberFormatException nfe) {
                ctx.log("ai-broker-exec: wf.ai.note-author-id is not a number ('" + authorRaw
                        + "'); skipping client note");
                return false;
            }
            String plain = (note == null ? "" : note)
                    .replace('<', '(').replace('>', ')').replace('\r', ' ').replace('\n', ' ').trim();
            if (plain.length() == 0) return false;
            boolean written = delegate.addClientNote(Long.valueOf(authorId),
                    Long.valueOf(clientId), Long.valueOf(accountId), plain);
            if (!written) {
                ctx.log("ai-broker-exec: client note skipped for client " + clientId
                        + " (author/account unresolved, or account " + accountId
                        + " is not this client's own registry account)");
            }
            return written;
        } catch (Exception e) {
            // isolation: a note write must never turn a successful trade into a failure.
            ctx.log("ai-broker-exec: failed to write client note (trade unaffected): " + e.getMessage(), e);
            return false;
        }
    }
%>
<%
    response.setContentType("application/json; charset=UTF-8");
    response.setHeader("Cache-Control", "no-store");

    // ---- transport + signature gate (fail closed) --------------------------
    if (!"POST".equalsIgnoreCase(request.getMethod())) {
        response.setStatus(405);
        out.print(jsonOut(fail("POST only")));
        return;
    }
    String secret = props().getProperty("wf.ai.exec-secret");
    byte[] body = readBody(request.getInputStream());
    String sig = request.getHeader("X-WFAI-Signature");
    if (!verifySignature(secret, body, sig)) {
        response.setStatus(401);
        out.print(jsonOut(fail("bad signature")));
        return;
    }

    JsonObject req;
    try {
        req = new JsonParser().parse(new String(body, "UTF-8")).getAsJsonObject();
    } catch (Exception e) {
        response.setStatus(400);
        out.print(jsonOut(fail("malformed body")));
        return;
    }

    // freshness: signed body must carry a recent iat (epoch seconds)
    long nowSec = System.currentTimeMillis() / 1000L;
    long iat = req.has("iat") ? req.get("iat").getAsLong() : 0L;
    if (Math.abs(nowSec - iat) > 180L) {
        response.setStatus(401);
        out.print(jsonOut(fail("stale request")));
        return;
    }

    String op = req.has("op") ? req.get("op").getAsString() : "";
    long clientId = req.has("clientId") ? req.get("clientId").getAsLong() : 0L;
    if (clientId <= 0L) {
        response.setStatus(400);
        out.print(jsonOut(fail("missing clientId")));
        return;
    }
    // The client's registry account (registry_user id) the sidecar acted on. Used only to attach
    // the post-trade CRM note; it is re-validated server-side against the acting client and never
    // trusted blindly. Absent -> no note is written (never fails the trade).
    long accountId = req.has("accountId") ? req.get("accountId").getAsLong() : 0L;

    // ---- idempotency gate (B1/H7): both ops mutate, both must carry a key -----------------
    // A replayed/retried request with the same key returns the ORIGINAL terminal response and
    // never executes twice; a same-key request while the original is still running is refused
    // WITHOUT executing (definitive "failed" = nothing was placed).
    String idemKeyRaw = req.has("idemKey") ? req.get("idemKey").getAsString() : null;
    if (idemKeyRaw == null || idemKeyRaw.trim().length() == 0) {
        response.setStatus(400);
        out.print(jsonOut(fail("missing idemKey")));
        return;
    }
    String idemKey = op + ":" + clientId + ":" + idemKeyRaw.trim();
    ConcurrentHashMap<String, String> idem = idemMap(application);
    idemPrune(idem);
    String idemPrior = idem.putIfAbsent(idemKey, (nowSec) + "|" + IDEM_IN_PROGRESS);
    if (idemPrior != null) {
        String priorPayload = idemPrior.substring(idemPrior.indexOf('|') + 1);
        if (IDEM_IN_PROGRESS.equals(priorPayload)) {
            out.print(jsonOut(fail("duplicate: a request with this idempotency key is already in progress")));
            return;
        }
        out.print(priorPayload);   // replay: the original result, verbatim — nothing executes
        return;
    }

    // ---- act as the (sidecar-authenticated) client --------------------------
    // Bare-forward JSP: the filter ran ServiceRequest.prepare() but nothing seeded the
    // user — the BO resolves the acting user from this thread-local (doc 08 Part 11).
    ServiceRequest.getServiceRequest().setLoggedInUserId(Long.valueOf(clientId));
    UserCredentialsDto uc = new UserCredentialsDto();
    uc.setUserId(Long.valueOf(clientId));
    uc.setUsername("ai-advisor-exec");
    ServiceRequest.getServiceRequest().setUserCredentials(uc);

    WaterfindDelegate delegate = Waterfind.getWaterfindDelegate();

    try {
        if ("place".equals(op)) {
            String propertyId = req.has("propertyId") ? req.get("propertyId").getAsString() : null;
            String quantity   = req.has("quantity") ? req.get("quantity").getAsString() : null;
            String pricePerMl = req.has("pricePerMl") ? req.get("pricePerMl").getAsString() : null;
            boolean isBuy       = req.has("isBuy") && req.get("isBuy").getAsBoolean();
            boolean isPermanent = req.has("isPermanent") && req.get("isPermanent").getAsBoolean();
            boolean isListing   = req.has("isListing") && req.get("isListing").getAsBoolean();
            String expiry     = req.has("expiry") ? req.get("expiry").getAsString() : null;
            String deliveryDateStr = req.has("deliveryDate") ? req.get("deliveryDate").getAsString() : null;
            boolean split       = req.has("split") && req.get("split").getAsBoolean();
            String minSplitStr  = req.has("minSplitQuantity") ? req.get("minSplitQuantity").getAsString() : null;
            String maxSplitStr  = req.has("maxSplitParcelSize") ? req.get("maxSplitParcelSize").getAsString() : null;

            if (propertyId == null || quantity == null || pricePerMl == null) {
                response.setStatus(400);
                out.print(jsonOut(fail("place requires propertyId, quantity, pricePerMl")));
                return;
            }
            double qty;
            double price;
            try {
                qty = Double.parseDouble(quantity);
                price = Double.parseDouble(pricePerMl);
            } catch (Exception e) {
                response.setStatus(400);
                out.print(jsonOut(fail("quantity/pricePerMl must be numeric")));
                return;
            }
            if (qty <= 0 || price <= 0) {
                response.setStatus(400);
                out.print(jsonOut(fail("quantity and pricePerMl must be positive")));
                return;
            }

            // SCOPE GATE: the property must appear in the CRM's OWN licence enumeration for
            // this client + product (ownership + approval + spot/perm permission flags) —
            // the same list the order wizard offers. Anything else is out of scope.
            List<PropertyListItemDto> licences =
                    delegate.getLicenceListForClient(String.valueOf(clientId), Boolean.valueOf(isPermanent), Boolean.FALSE);
            PropertyListItemDto licence = null;
            if (licences != null) {
                for (PropertyListItemDto li : licences) {
                    if (propertyId.equals(li.getPropertyId())) { licence = li; break; }
                }
            }
            if (licence == null) {
                out.print(jsonOut(fail("SCOPE: property " + propertyId
                        + " is not a licence this client can trade (ownership/permission)")));
                return;
            }
            if (!licence.isApproved()) {
                out.print(jsonOut(fail("SCOPE: property " + propertyId + " is not approved for trading")));
                return;
            }
            // Fail CLOSED on a null/zero licence volume for sells: a licence with no recorded
            // volume cannot cover ANY sell (the old gate silently skipped the check instead).
            if (!isBuy) {
                if (licence.getVolume() == null || licence.getVolume().doubleValue() <= 0) {
                    out.print(idemDone(idem, idemKey, jsonOut(fail("SCOPE: licence " + propertyId
                            + " has no recorded volume - cannot cover a sell of " + quantity + " ML"))));
                    return;
                }
                if (qty > licence.getVolume().doubleValue()) {
                    out.print(idemDone(idem, idemKey, jsonOut(fail("SCOPE: sell volume " + quantity
                            + " ML exceeds the licence volume " + licence.getVolume() + " ML"))));
                    return;
                }
            }

            // SPLIT parcel: min split is required, positive, and within the order volume.
            double minSplit = 0;
            if (split) {
                if (minSplitStr == null || minSplitStr.trim().length() == 0) {
                    response.setStatus(400);
                    out.print(jsonOut(fail("split requires minSplitQuantity")));
                    return;
                }
                try {
                    minSplit = Double.parseDouble(minSplitStr.trim());
                    if (maxSplitStr != null && maxSplitStr.trim().length() > 0) {
                        double maxSplit = Double.parseDouble(maxSplitStr.trim());
                        if (maxSplit != 0 && maxSplit < minSplit) {
                            out.print(jsonOut(fail("SCOPE: maxSplitParcelSize must be 0 or >= minSplitQuantity")));
                            return;
                        }
                    }
                } catch (Exception e) {
                    response.setStatus(400);
                    out.print(jsonOut(fail("minSplitQuantity/maxSplitParcelSize must be numeric")));
                    return;
                }
                if (minSplit <= 0 || minSplit > qty) {
                    out.print(jsonOut(fail("SCOPE: minSplitQuantity must be > 0 and <= quantity")));
                    return;
                }
            }

            AddOrderListingDetailsDto dto = new AddOrderListingDetailsDto();
            dto.setClientId(String.valueOf(clientId));
            dto.setPropertyId(propertyId);
            dto.setQuantity(quantity);
            dto.setPricePerMl(pricePerMl);
            dto.setSplit(split);
            dto.setMinSplitQuantity(split ? minSplitStr.trim() : "0");
            if (split && maxSplitStr != null && maxSplitStr.trim().length() > 0) {
                dto.setMaxSplitParcelSize(maxSplitStr.trim());
            }
            dto.setTransferType(isPermanent);
            dto.setBuyOrder(isBuy);
            dto.setInvitationForOffers(isListing);
            dto.setHasAllocation(false);
            dto.setDualListing(false);
            dto.setSeason("" + Waterfind.getCurrentSeasonStartYear());

            SimpleDateFormat sdf = new SimpleDateFormat("dd/MM/yyyy");
            if (expiry != null && expiry.trim().length() > 0) {
                sdf.setLenient(false);
                sdf.parse(expiry.trim()); // validate format before trusting it
                dto.setExpiry(expiry.trim());
            } else {
                dto.setExpiry(sdf.format(
                        Waterfind.getSeasonEndDate(Waterfind.getCurrentSeasonStartYear()).getTime()));
            }

            // FORWARD: optional delivery date. The engine silently clamps past dates to "now";
            // this seam refuses them instead (fail-closed), and caps the horizon at 24 months.
            Date deliveryDate = null;
            if (deliveryDateStr != null && deliveryDateStr.trim().length() > 0) {
                SimpleDateFormat ddf = new SimpleDateFormat("dd/MM/yyyy");
                ddf.setLenient(false);
                try {
                    deliveryDate = ddf.parse(deliveryDateStr.trim());
                } catch (Exception e) {
                    response.setStatus(400);
                    out.print(jsonOut(fail("deliveryDate must be dd/MM/yyyy")));
                    return;
                }
                Calendar today = Calendar.getInstance();
                today.set(Calendar.HOUR_OF_DAY, 0); today.set(Calendar.MINUTE, 0);
                today.set(Calendar.SECOND, 0); today.set(Calendar.MILLISECOND, 0);
                if (!deliveryDate.after(today.getTime())) {
                    out.print(jsonOut(fail("SCOPE: deliveryDate must be a future date for a forward order")));
                    return;
                }
                Calendar horizon = Calendar.getInstance();
                horizon.add(Calendar.MONTH, 24);
                if (deliveryDate.after(horizon.getTime())) {
                    out.print(jsonOut(fail("SCOPE: deliveryDate is more than 24 months out")));
                    return;
                }
                dto.setDeliveryDate(deliveryDateStr.trim());
            }

            applyFees(delegate, dto, propertyId);

            List<Long> regions = deriveTradableRegions(delegate, dto, propertyId, deliveryDate);
            if (regions.isEmpty() && licence.getRegionId() != null && licence.getRegionId().trim().length() > 0) {
                regions.add(Long.valueOf(licence.getRegionId()));
            }
            if (regions.isEmpty()) {
                out.print(idemDone(idem, idemKey, jsonOut(fail("SCOPE: no tradable regions for licence " + propertyId))));
                return;
            }

            // H5: when the signed body carries regionIds (the region set the user CONFIRMED on
            // the card), the order must be listed into EXACTLY that set. Every confirmed region
            // must be in the CRM's own tradable enumeration — if not, fail BEFORE placement
            // rather than silently place into a different region set. Absent regionIds = the
            // disclosed multi-region case (forward temp sell): keep the CRM-derived set.
            if (req.has("regionIds")) {
                List<Long> confirmed = new ArrayList<Long>();
                JsonArray ra = req.get("regionIds").getAsJsonArray();
                for (int i = 0; i < ra.size(); i++) {
                    confirmed.add(Long.valueOf(ra.get(i).getAsLong()));
                }
                if (confirmed.isEmpty()) {
                    out.print(idemDone(idem, idemKey, jsonOut(fail("SCOPE: regionIds must not be empty"))));
                    return;
                }
                for (int i = 0; i < confirmed.size(); i++) {
                    if (!regions.contains(confirmed.get(i))) {
                        out.print(idemDone(idem, idemKey, jsonOut(fail("SCOPE: confirmed region "
                                + confirmed.get(i) + " is not currently tradable for licence "
                                + propertyId + " - order not placed"))));
                        return;
                    }
                }
                regions = confirmed;
            }
            dto.setSelectedRegions(regions);

            // The real thing: market lock, persistence, auto-clearing, settlement cascade.
            Long orderListingId = delegate.addNewOrderListing(dto);

            // B1: the order is LIVE from this line on. NOTHING below may turn the response into
            // "failed" — every piece of post-placement work is individually isolated and its
            // outcome reported via flags instead.
            int cleared = 0;
            String orderExpiry = dto.getExpiry();
            boolean summaryOk = true;
            try {
                OrderListingSummartDto summary = delegate.getOrderListingSummary(orderListingId);
                if (summary != null) {
                    if (summary.getTradeComponents() != null) cleared = summary.getTradeComponents().size();
                    if (summary.getOrderExpiry() != null) orderExpiry = summary.getOrderExpiry();
                }
            } catch (Exception postEx) {
                summaryOk = false;
                application.log("ai-broker-exec: post-placement summary lookup failed for order "
                        + orderListingId + " (placement unaffected): " + postEx.getMessage());
            }

            // Record the placement on the client's CRM file (best-effort; server-composed plain
            // text; isolated so it can never affect the trade response).
            boolean noteWritten = false;
            try {
                String placeSide = isBuy ? "BUY" : "SELL";
                StringBuilder placeNote = new StringBuilder();
                placeNote.append("AI Advisor: ");
                if (deliveryDate != null) {
                    placeNote.append("FORWARD (delivery ").append(deliveryDateStr.trim()).append(") ");
                }
                if (split) {
                    placeNote.append("SPLIT (min ").append(minSplitStr.trim()).append(" ML) ");
                }
                placeNote.append(placeSide).append(" order placed - ")
                        .append(quantity).append(" ML @ $").append(pricePerMl).append("/ML");
                String regionName = licence.getRegionName();
                if (regionName != null && regionName.trim().length() > 0) {
                    placeNote.append(", ").append(regionName);
                }
                placeNote.append(", orderListingId=").append(orderListingId).append(".");
                // Broker-assist: the sidecar names the staff member who confirmed for the client
                // (plain text; angle brackets and line breaks stripped, length-capped).
                String placedBy = req.has("placedBy") && !req.get("placedBy").isJsonNull()
                        ? req.get("placedBy").getAsString() : null;
                if (placedBy != null) {
                    placedBy = placedBy.replaceAll("[<>\\r\\n]", " ").replaceAll("\\s+", " ").trim();
                    if (placedBy.length() > 160) placedBy = placedBy.substring(0, 160);
                    if (placedBy.length() > 0) placeNote.append(" Placed by ").append(placedBy).append(".");
                }
                noteWritten = writeClientNote(application, delegate, clientId, accountId, placeNote.toString());
            } catch (Exception postEx) {
                application.log("ai-broker-exec: post-placement note composition failed for order "
                        + orderListingId + " (placement unaffected): " + postEx.getMessage());
            }

            Map<String, Object> resp = new LinkedHashMap<String, Object>();
            resp.put("status", "success");
            resp.put("orderListingId", orderListingId);
            resp.put("cleared", cleared);
            resp.put("regions", regions);
            resp.put("propertyId", propertyId);
            resp.put("regionName", licence.getRegionName());
            resp.put("expiry", orderExpiry);
            resp.put("season", dto.getSeason());
            resp.put("summaryOk", Boolean.valueOf(summaryOk));
            resp.put("noteWritten", Boolean.valueOf(noteWritten));
            out.print(idemDone(idem, idemKey, jsonOut(resp)));
            return;

        } else if ("withdraw".equals(op)) {
            long orderListingId = req.has("orderListingId") ? req.get("orderListingId").getAsLong() : 0L;
            String reason = req.has("reason") ? req.get("reason").getAsString() : "Withdrawn via AI Advisor";
            if (orderListingId <= 0L) {
                response.setStatus(400);
                out.print(jsonOut(fail("withdraw requires orderListingId")));
                return;
            }
            delegate.deleteOrderListing(String.valueOf(orderListingId), reason);

            // B1: the withdrawal is DONE from this line on — the note below is isolated and
            // can never turn the response into "failed".
            boolean noteWritten = false;
            try {
                noteWritten = writeClientNote(application, delegate, clientId, accountId,
                        "AI Advisor: order " + orderListingId + " withdrawn - " + reason + ".");
            } catch (Exception postEx) {
                application.log("ai-broker-exec: post-withdrawal note failed for order "
                        + orderListingId + " (withdrawal unaffected): " + postEx.getMessage());
            }

            Map<String, Object> resp = new LinkedHashMap<String, Object>();
            resp.put("status", "success");
            resp.put("orderListingId", Long.valueOf(orderListingId));
            resp.put("withdrawn", Boolean.TRUE);
            resp.put("noteWritten", Boolean.valueOf(noteWritten));
            out.print(idemDone(idem, idemKey, jsonOut(resp)));
            return;

        } else if ("optout".equals(op)) {
            // ---- the client asked the AI assistant, on a phone call, not to be called --------
            // Two CRM-side records, the same ones a broker would make by hand: a Contact Note on the
            // client's file, and "Include in Campaigns" switched off (registry_user.campaign_optin —
            // the flag the CRM's own campaign lists and the AI call campaigns both honour). Goes
            // through WaterfindDelegate.updateUserSettings, the same path as the client's own
            // notification-settings page; only the campaign flag is set on the DTO, so every other
            // setting is left untouched (the BO skips null fields). The sidecar's own suppression
            // list is already updated before this is called; this write-through is best-effort and
            // each half is reported separately.
            String note = req.has("note") ? req.get("note").getAsString() : "";
            boolean noteWritten = writeClientNote(application, delegate, clientId, accountId, note);
            boolean optinOff = false;
            try {
                UserSettingsDto dto = new UserSettingsDto();
                dto.setUserId(Long.valueOf(clientId));
                dto.setIncludeInCampaigns(Boolean.FALSE);
                Boolean updated = delegate.updateUserSettings(dto);
                optinOff = (updated != null && updated.booleanValue());
            } catch (Exception e) {
                application.log("ai-broker-exec: campaign opt-in update failed for client " + clientId + ": " + e.getMessage(), e);
            }
            Map<String, Object> resp = new LinkedHashMap<String, Object>();
            resp.put("status", "success");
            resp.put("noteWritten", Boolean.valueOf(noteWritten));
            resp.put("campaignOptinOff", Boolean.valueOf(optinOff));
            out.print(idemDone(idem, idemKey, jsonOut(resp)));
            return;

        } else {
            response.setStatus(400);
            out.print(jsonOut(fail("unknown op '" + op + "'")));
            return;
        }
    } catch (Exception e) {
        // trade rejections (ERROR_NO_RTR, ERROR_NOT_ENOUGH_WATER, ...) surface as
        // WaterfindErrors wrapped in UnrecoverableServiceException — report the cause.
        // Only PRE-placement failures can reach here (post-placement work is isolated above),
        // so "failed" is definitive: nothing was placed and a retry is safe. Recorded against
        // the idempotency key so a replay gets the same verdict without re-executing.
        Throwable cause = (e.getCause() != null) ? e.getCause() : e;
        String msg = cause.getMessage();
        out.print(idemDone(idem, idemKey, jsonOut(fail(msg != null ? msg : cause.getClass().getSimpleName()))));
        return;
    }
%>
