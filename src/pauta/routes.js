import express from 'express';
import { HttpError, badRequest, unavailable } from '../errors.js';
import { buildSnapshot } from './snapshot.js';
import { createExecutor } from './agent.js';

const SNAPSHOT_TTL_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,30}$/;
const LEVEL_LABEL = { campaign: 'la campaña', adset: 'el conjunto', ad: 'el anuncio' };

// Express 4 no atrapa errores de handlers async
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const uuid = (v) => {
  if (!UUID.test(String(v))) throw badRequest('Id inválido');
  return v;
};
const text = (v, max, label) => {
  if (typeof v !== 'string') throw badRequest(`${label}: tiene que ser texto`);
  if (v.length > max) throw badRequest(`${label}: máximo ${max} caracteres`);
  return v.trim();
};
const amount = (v, label) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) throw badRequest(`${label}: tiene que ser un número entero`);
  return n;
};
const metaIdOrEmpty = (v, label) => {
  const s = text(v, 40, label).replace(/^act_/, '');
  if (s && !META_ID.test(s)) throw badRequest(`${label}: tiene que ser un número (el ID de Meta)`);
  return s;
};

function parseSettings(body = {}) {
  const out = {};
  for (const k of ['agent_enabled', 'autonomous']) {
    if (k in body) {
      if (typeof body[k] !== 'boolean') throw badRequest(`${k} tiene que ser sí o no`);
      out[k] = body[k];
    }
  }
  if ('monthly_cap_ars' in body) out.monthly_cap_ars = amount(body.monthly_cap_ars, 'Tope mensual');
  if ('target_cpa_ars' in body) out.target_cpa_ars = amount(body.target_cpa_ars, 'Costo objetivo por venta');
  if ('business_notes' in body) out.business_notes = text(body.business_notes, 5000, 'Contexto');
  const ids = { meta_ad_account_id: 'Cuenta publicitaria', meta_page_id: 'Página de Facebook', meta_ig_user_id: 'Cuenta de Instagram', meta_pixel_id: 'Píxel' };
  for (const [k, label] of Object.entries(ids)) if (k in body) out[k] = metaIdOrEmpty(body[k], label);
  return out;
}

// canAccess(user, storeKey): el usuario tiene esa tienda asignada
export function createPautaRouter({ repo, stores, canAccess, metaFor, getShop, startRun, hasMetaToken }) {
  const r = express.Router({ mergeParams: true });

  r.use((req, _res, next) => {
    const store = stores.find((s) => s.key === req.params.store);
    if (!store || !canAccess(req.user, store.key)) return next(new HttpError(403, 'No tenés acceso a esa tienda'));
    req.store = store;
    next();
  });

  // La foto de Meta se cachea unos minutos por tienda: cada carga del panel no le pega a la API
  const cache = new Map();
  async function snapshot(store, meta, force) {
    const hit = cache.get(store);
    if (!force && hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.data;
    const data = await buildSnapshot(meta);
    cache.set(store, { at: Date.now(), data });
    return data;
  }
  const invalidate = (store) => cache.delete(store);

  async function metaOf(store) {
    const settings = await repo.getSettings(store);
    const meta = metaFor(settings);
    if (!meta) throw unavailable(hasMetaToken ? 'Falta cargar la cuenta publicitaria de Meta en Ajustes.' : 'Falta el token de Meta (META_ACCESS_TOKEN) en el servidor.');
    return { settings, meta };
  }

  r.get('/overview', wrap(async (req, res) => {
    const store = req.store.key;
    const [settings, runs, pending, questions, requests] = await Promise.all([
      repo.getSettings(store), repo.listRuns(store, 1), repo.listDecisions(store, { status: 'pending', limit: 100 }),
      repo.listQuestions(store, { status: 'open' }), repo.listRequests(store, { status: 'open' }),
    ]);
    const meta = metaFor(settings);
    let snap = null;
    let metaError = null;
    let shop = null;
    let shopError = null;
    await Promise.all([
      meta && snapshot(store, meta, req.query.refresh === '1').then((s) => { snap = s; }, (err) => { metaError = String(err.message || err); }),
      getShop(store).then((s) => { shop = s; }, (err) => { shopError = String(err.message || err); }),
    ]);
    res.json({
      configured: { metaToken: hasMetaToken, metaAccount: Boolean(settings.meta_ad_account_id), agent: Boolean(startRun) },
      settings, lastRun: runs[0] ?? null, pending, questions, requests, snapshot: snap, metaError, shop, shopError,
    });
  }));

  r.put('/settings', wrap(async (req, res) => {
    const settings = await repo.updateSettings(req.store.key, parseSettings(req.body));
    invalidate(req.store.key);
    res.json({ settings });
  }));

  r.get('/runs', wrap(async (req, res) => res.json({ runs: await repo.listRuns(req.store.key, 20) })));

  r.post('/runs', wrap(async (req, res) => {
    if (!startRun) throw unavailable('Falta la clave de Claude (ANTHROPIC_API_KEY) en el servidor.');
    const { run, done } = await startRun(req.store.key, 'manual', req.user.name);
    done.finally(() => invalidate(req.store.key));
    res.status(202).json({ run });
  }));

  r.get('/decisions', wrap(async (req, res) => {
    const status = req.query.status;
    if (status && !['pending', 'executing', 'executed', 'rejected', 'failed'].includes(status)) throw badRequest('Estado inválido');
    res.json({ decisions: await repo.listDecisions(req.store.key, { status, limit: 100 }) });
  }));

  r.post('/decisions/:id/approve', wrap(async (req, res) => {
    const store = req.store.key;
    const id = uuid(req.params.id);
    const { settings, meta } = await metaOf(store);
    const d = await repo.claimPending(store, id, req.user.name, 'executing');
    try {
      const result = await createExecutor({ meta, repo, store, settings })(d.tool, d.input, { userName: req.user.name });
      await repo.setDecisionResult(id, { status: 'executed', result });
    } catch (err) {
      await repo.setDecisionResult(id, { status: 'failed', error: String(err.message || err) });
    }
    invalidate(store);
    res.json({ decision: await repo.getDecision(store, id) });
  }));

  r.post('/decisions/:id/reject', wrap(async (req, res) => {
    const store = req.store.key;
    const id = uuid(req.params.id);
    await repo.claimPending(store, id, req.user.name, 'rejected');
    res.json({ decision: await repo.getDecision(store, id) });
  }));

  // Pausar/activar a mano desde la tabla del panel (queda en el historial)
  r.post('/objects/:id/status', wrap(async (req, res) => {
    const store = req.store.key;
    const id = String(req.params.id);
    if (!META_ID.test(id)) throw badRequest('Id de Meta inválido');
    const { level, status, name = '' } = req.body || {};
    if (!LEVEL_LABEL[level] || !['ACTIVE', 'PAUSED'].includes(status)) throw badRequest('Pedido inválido');
    const { settings, meta } = await metaOf(store);
    const input = { level, object_id: id, object_name: text(name, 200, 'Nombre'), status };
    const result = await createExecutor({ meta, repo, store, settings })('set_status', input);
    await repo.addDecision(store, {
      tool: 'set_status', input, status: 'executed', result, decidedBy: req.user.name,
      title: `${status === 'ACTIVE' ? 'Activar' : 'Pausar'} ${LEVEL_LABEL[level]} ${input.object_name}`.trim(),
      reason: 'Hecho a mano desde el panel.',
    });
    invalidate(store);
    res.json({ ok: true });
  }));

  r.post('/questions/:id/answer', wrap(async (req, res) => {
    const store = req.store.key;
    const answer = text(req.body?.answer ?? '', 2000, 'Respuesta');
    if (!answer) throw badRequest('Escribí la respuesta');
    const question = await repo.answerQuestion(store, uuid(req.params.id), answer, req.user.name);
    res.json({ question });
  }));

  r.post('/questions/:id/dismiss', wrap(async (req, res) => {
    res.json({ question: await repo.dismissQuestion(req.store.key, uuid(req.params.id)) });
  }));

  r.post('/requests/:id/done', wrap(async (req, res) => {
    res.json({ request: await repo.closeRequest(req.store.key, uuid(req.params.id)) });
  }));

  r.get('/learnings', wrap(async (req, res) => res.json({ learnings: await repo.listLearnings(req.store.key) })));

  r.delete('/learnings/:id', wrap(async (req, res) => {
    await repo.deleteLearning(req.store.key, uuid(req.params.id));
    res.status(204).end();
  }));

  return r;
}

// Errores de la API de pauta en JSON con el mensaje para el panel
export function pautaErrorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('[pauta]', err);
  res.status(500).json({ error: 'Error inesperado' });
}
