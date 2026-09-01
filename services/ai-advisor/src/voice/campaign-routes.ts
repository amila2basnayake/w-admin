// HTTP surface of call campaigns, mounted by routes.ts at /voice/campaigns behind the voice kill switch
// and the staff gate (requireVoiceAdmin: CRM-minted staff token + BROKER/SU role, fresh from the DB).
//   GET    /voice/campaigns                      list (+ per-state counts)
//   POST   /voice/campaigns                      create a draft {name, flow, payload, scheduled_for?, max_concurrent?, filter?}
//   GET    /voice/campaigns/options              dropdown data (flows + openings, states, brokers, callback numbers, hours)
//   GET    /voice/campaigns/regions?state_id=    market zones of a state
//   GET    /voice/campaigns/clients?q=&state_id=&region_id=&broker_uid=&min_ml=&not_contacted_since=   list builder
//   GET    /voice/campaigns/:id                  detail (brief, counts, members with live state, opening line)
//   PATCH  /voice/campaigns/:id                  edit the brief
//   DELETE /voice/campaigns/:id                  delete a draft
//   POST   /voice/campaigns/:id/members          {client_uids?: [], crns?: []}
//   DELETE /voice/campaigns/:id/members/:uid
//   POST   /voice/campaigns/:id/recheck          re-run eligibility on the list
//   POST   /voice/campaigns/:id/launch | pause | resume | cancel | duplicate | tick
import { Router, type Request, type Response, type NextFunction } from 'express';
import * as camp from './campaigns';

const jh = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e) => {
      if (e instanceof camp.CampaignError) { res.status(e.status).json({ error: e.message }); return; }
      next(e);
    });
  };

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new camp.CampaignError(400, 'bad campaign id');
  return id;
}
function staffOf(req: Request): { uid: number; name: string } {
  return { uid: Number((req as any).staffUid), name: String((req as any).staffName ?? '') };
}

export function campaignRouter(requireVoiceAdmin: (req: Request, res: Response, next: NextFunction) => unknown): Router {
  const r = Router();
  r.use((req, res, next) => { void requireVoiceAdmin(req, res, next); });

  r.get('/', jh(async (_req, res) => { res.json(await camp.listCampaigns()); }));
  r.post('/', jh(async (req, res) => { res.status(201).json(await camp.createCampaign(req.body ?? {}, staffOf(req))); }));
  r.get('/options', jh(async (_req, res) => { res.json(await camp.campaignOptions()); }));
  r.get('/regions', jh(async (req, res) => {
    const sid = Number(req.query.state_id);
    if (!Number.isInteger(sid)) throw new camp.CampaignError(400, 'state_id is required');
    res.json(await camp.regionsOfState(sid));
  }));
  r.get('/clients', jh(async (req, res) => { res.json(await camp.searchClients(camp.parseClientFilter(req.query as any))); }));

  r.get('/:id', jh(async (req, res) => { res.json(await camp.campaignDetail(idParam(req))); }));
  r.patch('/:id', jh(async (req, res) => { res.json(await camp.updateCampaign(idParam(req), req.body ?? {})); }));
  r.delete('/:id', jh(async (req, res) => { await camp.deleteCampaign(idParam(req)); res.json({ ok: true }); }));

  r.post('/:id/members', jh(async (req, res) => { res.json(await camp.addMembers(idParam(req), req.body ?? {}, staffOf(req).uid)); }));
  r.delete('/:id/members/:uid', jh(async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid)) throw new camp.CampaignError(400, 'bad client id');
    res.json({ removed: await camp.removeMember(idParam(req), uid) });
  }));
  r.post('/:id/recheck', jh(async (req, res) => { res.json(await camp.recheckMembers(idParam(req))); }));

  r.post('/:id/launch', jh(async (req, res) => { res.json(await camp.launchCampaign(idParam(req), staffOf(req).uid)); }));
  r.post('/:id/pause', jh(async (req, res) => { res.json(await camp.pauseCampaign(idParam(req))); }));
  r.post('/:id/resume', jh(async (req, res) => { res.json(await camp.resumeCampaign(idParam(req))); }));
  r.post('/:id/cancel', jh(async (req, res) => { res.json(await camp.cancelCampaign(idParam(req))); }));
  r.post('/:id/duplicate', jh(async (req, res) => { res.status(201).json(await camp.duplicateCampaign(idParam(req), staffOf(req))); }));
  /** Manual feeder pass (ops/tests) — the dialer's own tick still decides when calls go out. */
  r.post('/:id/tick', jh(async (req, res) => {
    const c = await camp.getCampaign(idParam(req));
    if (!c) throw new camp.CampaignError(404, 'campaign not found');
    res.json(c.status === 'running' ? await camp.feedCampaign(c) : { campaign_id: c.id, fed: 0, skipped: 0, inflight: await camp.inflightCount(c.id), completed: false, waiting: c.status });
  }));
  return r;
}
