import express from 'express';
import { HttpError, badRequest, conflict, unavailable } from '../errors.js';
import { buildSnapshot } from './snapshot.js';
import { createExecutor, loadIgPosts } from './agent.js';
import { CTA_TYPES, DEFAULT_CTA } from './creativeSpec.js';
import { buildMetaReport, buildShopReport, previousRange } from './report.js';
import { artDate } from './metrics.js';

const SNAPSHOT_TTL_MS = 5 * 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
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

const url = (v) => {
  const s = text(v ?? '', 1000, 'Link');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw badRequest('Link: tiene que ser una dirección completa (https://...)');
  }
  if (!['https:', 'http:'].includes(u.protocol)) throw badRequest('Link: tiene que empezar con https://');
  return u.toString();
};
const cta = (v) => {
  if (v === undefined || v === null || v === '') return DEFAULT_CTA;
  if (!CTA_TYPES.includes(v)) throw badRequest('Botón inválido');
  return v;
};

// required=true al crear; al editar solo se validan los campos que vienen
function parseCreative(body = {}, required) {
  const out = {};
  const field = (k, max, label, need) => {
    if (!(k in body)) {
      if (required && need) throw badRequest(`Falta ${label.toLowerCase()}`);
      return;
    }
    out[k] = text(body[k], max, label);
    if (need && !out[k]) throw badRequest(`Falta ${label.toLowerCase()}`);
  };
  field('name', 120, 'Nombre', true);
  field('copy', 2000, 'Texto', true);
  field('headline', 120, 'Título', false);
  field('notes', 1000, 'Notas', false);
  if ('link' in body || required) out.link = url(body.link);
  if ('cta' in body || required) out.cta = cta(body.cta);
  return out;
}

// canAccess(user, storeKey): el usuario tiene esa tienda asignada
export function createPautaRouter({ repo, stores, canAccess, metaFor, getShop, getRaw, startRun, hasMetaToken, media }) {
  const r = express.Router({ mergeParams: true });
  const creativeOut = async (store, id) => {
    const c = (await repo.listCreatives(store)).find((x) => x.id === id);
    return (await media.withUrls([c]))[0];
  };

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

  // Reporte para el cliente: resultados de Meta y ventas de la tienda en un rango de fechas
  const reportCache = new Map();
  r.get('/report', wrap(async (req, res) => {
    const store = req.store.key;
    const { since, until } = req.query;
    const today = artDate();
    if (!DATE.test(since ?? '') || !DATE.test(until ?? '') || since > until) throw badRequest('Rango de fechas inválido');
    if (until > today) throw badRequest('La fecha final no puede ser futura');
    if (Date.parse(until) - Date.parse(since) > 366 * 86400_000) throw badRequest('El rango puede ser de hasta un año');

    const settings = await repo.getSettings(store);
    const meta = metaFor(settings);
    const key = `${store}|${since}|${until}|${settings.meta_ad_account_id}`;
    const hit = reportCache.get(key);
    let metaReport = null;
    let metaError = null;
    if (meta) {
      if (hit && req.query.refresh !== '1' && Date.now() - hit.at < SNAPSHOT_TTL_MS) {
        metaReport = hit.data;
      } else {
        try {
          metaReport = await buildMetaReport(meta, since, until);
          reportCache.set(key, { at: Date.now(), data: metaReport });
        } catch (err) {
          metaError = String(err.message || err);
        }
      }
    }
    let shop = null;
    let shopError = null;
    try {
      shop = buildShopReport(await getRaw(store), since, until);
    } catch (err) {
      shopError = String(err.message || err);
    }
    res.json({
      range: { since, until, previous: previousRange(since, until) },
      configured: { metaToken: hasMetaToken, metaAccount: Boolean(settings.meta_ad_account_id) },
      meta: metaReport, metaError, shop, shopError,
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
      const result = await createExecutor({ meta, repo, store, settings, media })(d.tool, d.input, { userName: req.user.name });
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

  // ---------- Piezas: el equipo sube foto o video (feed y opcional historia) y la publica como anuncio ----------
  r.get('/creatives', wrap(async (req, res) => {
    const all = await repo.listCreatives(req.store.key);
    const visible = req.query.archived === '1' ? all : all.filter((c) => c.status !== 'archived');
    res.json({ creatives: await media.withUrls(visible) });
  }));

  r.post('/creatives', wrap(async (req, res) => {
    const c = await repo.createCreative(req.store.key, parseCreative(req.body, true), req.user.name);
    res.status(201).json({ creative: (await media.withUrls([{ ...c, feed: null, story: null }]))[0] });
  }));

  r.patch('/creatives/:id', wrap(async (req, res) => {
    const store = req.store.key;
    const id = uuid(req.params.id);
    const current = await repo.getCreative(store, id);
    const patch = parseCreative(req.body, false);
    if ('status' in (req.body ?? {})) {
      const status = req.body.status;
      const ok = (status === 'archived' && ['unused', 'used'].includes(current.status)) || (status === 'unused' && current.status === 'archived' && !current.meta_ad_id);
      if (!ok) throw badRequest('Cambio de estado inválido');
      patch.status = status;
    }
    const editsContent = Object.keys(patch).some((k) => k !== 'status');
    if (editsContent && current.status !== 'unused') throw conflict('Esta pieza ya se publicó: no se puede editar.');
    await repo.updateCreative(store, id, patch);
    res.json({ creative: await creativeOut(store, id) });
  }));

  r.delete('/creatives/:id', wrap(async (req, res) => {
    const keys = await repo.deleteCreative(req.store.key, uuid(req.params.id));
    await Promise.all(keys.map((k) => media.remove(k)));
    res.status(204).end();
  }));

  // El archivo viaja como cuerpo del PUT, en streaming hacia el bucket (sin cargarlo en memoria)
  r.put('/creatives/:id/media/:slot', wrap(async (req, res) => {
    const store = req.store.key;
    const id = uuid(req.params.id);
    let originalName = '';
    try {
      originalName = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    } catch {
      originalName = '';
    }
    await media.upload(store, id, req.params.slot, {
      stream: req, mime: String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      bytes: Number(req.headers['content-length']), originalName,
    });
    res.json({ creative: await creativeOut(store, id) });
  }));

  r.delete('/creatives/:id/media/:slot', wrap(async (req, res) => {
    const store = req.store.key;
    const id = uuid(req.params.id);
    await media.removeSlot(store, id, req.params.slot);
    res.json({ creative: await creativeOut(store, id) });
  }));

  // Publicar tarda (un video puede llevar minutos en Meta): se reclama la pieza, se contesta 202 y sigue en segundo plano.
  // El panel ve status=publishing y consulta de nuevo; si falla, el error queda en publish_error.
  r.post('/creatives/:id/publish', wrap(async (req, res) => {
    const store = req.store.key;
    const id = uuid(req.params.id);
    const adsetId = String(req.body?.adset_id ?? '');
    if (!META_ID.test(adsetId)) throw badRequest('Elegí el conjunto donde publicarla');
    const adsetName = text(req.body?.adset_name ?? '', 200, 'Conjunto');
    const { settings, meta } = await metaOf(store);
    const files = await repo.getMedia(id);
    if (!files.some((f) => f.slot === 'feed')) throw badRequest('La pieza no tiene archivo de feed.');
    const creative = await repo.claimCreative(store, id);
    const input = { creative_id: id, creative_name: creative.name, adset_id: adsetId, adset_name: adsetName };
    const title = `Publicar la pieza ${creative.name} en ${adsetName || adsetId}`;
    createExecutor({ meta, repo, store, settings, media })('create_ad', input, { claimed: true })
      .then(
        (result) => repo.addDecision(store, { tool: 'create_ad', input, status: 'executed', result, decidedBy: req.user.name, title, reason: 'Publicada a mano desde el panel.' }),
        (err) => repo.addDecision(store, { tool: 'create_ad', input, status: 'failed', error: String(err.message || err), decidedBy: req.user.name, title, reason: 'Publicada a mano desde el panel.' }),
      )
      .catch((err) => console.error('[pauta] publicar pieza:', err))
      .finally(() => invalidate(store));
    res.status(202).json({ creative: await creativeOut(store, id) });
  }));

  // ---------- Instagram: promocionar un post o reel ya publicado ----------
  r.get('/ig-posts', wrap(async (req, res) => {
    const { settings, meta } = await metaOf(req.store.key);
    if (!settings.meta_ig_user_id) throw unavailable('Falta cargar la cuenta de Instagram en Ajustes.');
    res.json({ posts: await loadIgPosts({ meta, repo, store: req.store.key, igUserId: settings.meta_ig_user_id }) });
  }));

  r.post('/ig-posts/:id/promote', wrap(async (req, res) => {
    const store = req.store.key;
    const mediaId = String(req.params.id);
    if (!META_ID.test(mediaId)) throw badRequest('Id de post inválido');
    const body = req.body ?? {};
    const adsetId = String(body.adset_id ?? '');
    if (!META_ID.test(adsetId)) throw badRequest('Elegí el conjunto donde promocionarlo');
    const input = {
      ig_media_id: mediaId, adset_id: adsetId, adset_name: text(body.adset_name ?? '', 200, 'Conjunto'),
      permalink: text(body.permalink ?? '', 500, 'Link del post'), link: url(body.link), cta: cta(body.cta),
    };
    const { settings, meta } = await metaOf(store);
    const result = await createExecutor({ meta, repo, store, settings, media })('promote_ig_post', input, { userName: req.user.name });
    await repo.addDecision(store, {
      tool: 'promote_ig_post', input, status: 'executed', result, decidedBy: req.user.name,
      title: `Promocionar post de Instagram en ${input.adset_name || adsetId}`, reason: 'Hecho a mano desde el panel.',
    });
    invalidate(store);
    res.json({ result });
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
