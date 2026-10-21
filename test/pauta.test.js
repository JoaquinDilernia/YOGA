import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db.js';
import { createPauta } from '../src/pauta/index.js';
import { pautaErrorHandler } from '../src/pauta/routes.js';
import { createLocalStorage } from '../src/storage.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STORES = [{ key: 'perritos', name: 'Yoga y Patitas' }, { key: 'gatitos', name: 'Yoga y Gatitos' }];
const USERS = { marcos: { name: 'Marcos', stores: ['perritos', 'gatitos'] }, fran: { name: 'Francisco', stores: ['gatitos'] } };

// Meta falsa: registra lo que se le pide, una por cuenta publicitaria
function fakeMeta(accountId, calls) {
  const log = (op) => (...args) => {
    calls.push({ accountId, op, args });
    return Promise.resolve({ id: `${op}-1` });
  };
  return {
    accountId,
    getCampaigns: async () => [{ id: '10', name: 'VENTAS', objective: 'OUTCOME_SALES', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '1000000' }],
    getAdsets: async () => [],
    getAds: async () => [],
    getInsights: async () => [],
    searchInterests: async (q) => [{ id: '600', name: q }],
    getIgMedia: async () => [],
    setStatus: log('setStatus'),
    updateDailyBudget: log('updateDailyBudget'),
    createCampaign: log('createCampaign'),
    createAdset: log('createAdset'),
    createCreative: log('createCreative'),
    createAd: log('createAd'),
    uploadImage: async (buf) => {
      calls.push({ accountId, op: 'uploadImage', args: [buf.length] });
      return 'hash-1';
    },
    uploadVideo: log('uploadVideo'),
    waitVideoReady: async () => {},
    videoThumbnail: async () => 'https://thumb',
  };
}

// Claude falso: devuelve las respuestas guionadas en orden y guarda lo que recibió
function fakeAnthropic(script) {
  const received = [];
  return {
    received,
    beta: {
      messages: {
        stream: (params) => {
          received.push(structuredClone(params));
          const next = script.shift();
          return { finalMessage: async () => next };
        },
      },
    },
  };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

async function setup({ script = [], metaToken = 'tok' } = {}) {
  const db = new PGlite();
  await migrate(db);
  const calls = [];
  const anthropic = fakeAnthropic(script);
  const shopRaw = { storeUrl: 'https://tienda', products: [], orders: [] };
  const storage = createLocalStorage({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'piezas-')), secret: 's' });
  const pauta = await createPauta({
    db, stores: STORES, metaToken, anthropic, storage,
    canAccess: (user, key) => user.stores.includes(key),
    getStoreData: async () => ({ raw: shopRaw, turnos: { slots: [] } }),
    metaFactory: ({ accountId }) => fakeMeta(accountId, calls),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/pauta/:store', (req, _res, next) => {
    req.user = USERS[req.headers['x-user']];
    next();
  }, pauta.router, pautaErrorHandler);
  const as = (user) => ({
    get: (url) => request(app).get(url).set('x-user', user),
    post: (url, body) => request(app).post(url).set('x-user', user).send(body ?? {}),
    put: (url, body) => request(app).put(url).set('x-user', user).send(body ?? {}),
    patch: (url, body) => request(app).patch(url).set('x-user', user).send(body ?? {}),
    del: (url) => request(app).delete(url).set('x-user', user),
    upload: (url, buf, mime, name = 'pieza') => request(app).put(url).set('x-user', user).set('content-type', mime).set('x-file-name', encodeURIComponent(name)).send(buf),
  });
  return { db, app, pauta, calls, anthropic, as };
}

describe('pauta por tienda', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('cada tienda tiene sus propios ajustes', async () => {
    const { as } = ctx;
    const put = await as('marcos').put('/api/pauta/perritos/settings', {
      monthly_cap_ars: 300000, target_cpa_ars: 8000, business_notes: 'Cachorros de refugio', meta_ad_account_id: 'act_123', meta_pixel_id: '999',
    });
    expect(put.status).toBe(200);
    expect(put.body.settings).toMatchObject({ monthly_cap_ars: 300000, meta_ad_account_id: '123', business_notes: 'Cachorros de refugio' });

    const gatitos = await as('marcos').get('/api/pauta/gatitos/overview');
    expect(gatitos.body.settings).toMatchObject({ monthly_cap_ars: null, meta_ad_account_id: '' });
    expect(gatitos.body.configured).toMatchObject({ metaToken: true, metaAccount: false });
    expect(gatitos.body.snapshot).toBeNull();

    const perritos = await as('marcos').get('/api/pauta/perritos/overview');
    expect(perritos.body.configured.metaAccount).toBe(true);
    expect(perritos.body.snapshot.campaigns[0]).toMatchObject({ id: '10', dailyBudgetArs: 10000 });
  });

  it('valida los ajustes', async () => {
    const { as } = ctx;
    expect((await as('marcos').put('/api/pauta/perritos/settings', { monthly_cap_ars: -5 })).status).toBe(400);
    expect((await as('marcos').put('/api/pauta/perritos/settings', { meta_page_id: 'mi pagina' })).status).toBe(400);
    expect((await as('marcos').put('/api/pauta/perritos/settings', { autonomous: 'si' })).status).toBe(400);
    // vaciar el tope lo deja sin definir
    const ok = await as('marcos').put('/api/pauta/perritos/settings', { monthly_cap_ars: '' });
    expect(ok.body.settings.monthly_cap_ars).toBeNull();
  });

  it('un usuario solo ve las tiendas que tiene asignadas', async () => {
    const { as } = ctx;
    expect((await as('fran').get('/api/pauta/perritos/overview')).status).toBe(403);
    expect((await as('fran').get('/api/pauta/gatitos/overview')).status).toBe(200);
    expect((await as('marcos').get('/api/pauta/otra/overview')).status).toBe(403);
  });

  it('sin cuenta de Meta igual se puede analizar (solo con la tienda)', async () => {
    const { as, pauta } = await setup({ script: [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Informe' }] }] });
    const res = await as('marcos').post('/api/pauta/gatitos/runs');
    expect(res.status).toBe(202);
    for (let i = 0; i < 50 && (await pauta.repo.runningRun('gatitos')); i++) await new Promise((r) => setTimeout(r, 20));
    expect((await as('marcos').get('/api/pauta/gatitos/runs')).body.runs[0]).toMatchObject({ status: 'done', report: 'Informe' });
  });
});

describe('corrida del agente', () => {
  it('deja recomendaciones y preguntas en la tienda correcta, y se aprueban contra su cuenta', async () => {
    const script = [
      {
        stop_reason: 'tool_use',
        content: [
          toolUse('t1', 'propose_budget_change', { level: 'campaign', object_id: '10', current_budget_ars: 10000, proposed_budget_ars: 15000, title: 'Subir presupuesto', reason: 'Vende a $5.000', expected_impact: 'Más ventas' }),
          toolUse('t2', 'ask_team', { question: '¿Abren fechas de diciembre?', why: 'Para planificar', quick_answers: ['Sí', 'No'] }),
          toolUse('t3', 'search_interest', { query: 'perros' }),
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '**Cómo vamos** — bien.' }] },
    ];
    const { as, pauta, calls, anthropic } = await setup({ script });
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123', monthly_cap_ars: 300000 });

    const { run, done } = await pauta.startRun('perritos', 'manual', 'Marcos');
    expect(run.status).toBe('running');
    const finished = await done;
    expect(finished).toMatchObject({ status: 'done', report: '**Cómo vamos** — bien.', started_by: 'Marcos' });

    // El contexto que vio el modelo es el de la tienda pedida
    const first = anthropic.received[0];
    expect(first.system).toContain('Yoga y Patitas');
    expect(first.messages[0].content).toContain('"monthly_cap_ars":300000');
    expect(first.messages[0].content).toContain('## shop');
    // search_interest se resolvió contra Meta
    const results = anthropic.received[1].messages.at(-1).content;
    expect(JSON.parse(results.find((r) => r.tool_use_id === 't3').content).results[0].name).toBe('perros');

    const overview = (await as('marcos').get('/api/pauta/perritos/overview')).body;
    expect(overview.lastRun.status).toBe('done');
    expect(overview.pending).toHaveLength(1);
    expect(overview.questions[0]).toMatchObject({ question: '¿Abren fechas de diciembre?', quick_answers: ['Sí', 'No'] });
    // Nada se filtró a la otra tienda
    const otra = (await as('marcos').get('/api/pauta/gatitos/overview')).body;
    expect(otra.pending).toHaveLength(0);
    expect(otra.questions).toHaveLength(0);

    // Aprobar ejecuta en la cuenta de esa tienda, en centavos
    const id = overview.pending[0].id;
    const approved = await as('marcos').post(`/api/pauta/perritos/decisions/${id}/approve`);
    expect(approved.body.decision).toMatchObject({ status: 'executed', decided_by: 'Marcos' });
    expect(calls).toContainEqual({ accountId: '123', op: 'updateDailyBudget', args: ['10', 1500000] });
    // Una segunda aprobación no vuelve a ejecutar
    expect((await as('marcos').post(`/api/pauta/perritos/decisions/${id}/approve`)).status).toBe(409);
    // No se puede aprobar una decisión de otra tienda
    expect((await as('marcos').post(`/api/pauta/gatitos/decisions/${id}/reject`)).status).toBe(404);

    // Responder la pregunta: le llega al agente en la próxima corrida
    const qid = overview.questions[0].id;
    const answered = await as('marcos').post(`/api/pauta/perritos/questions/${qid}/answer`, { answer: 'Sí, el 1/12' });
    expect(answered.body.question).toMatchObject({ status: 'answered', answered_by: 'Marcos' });
  });

  it('en modo autónomo pausar un anuncio se ejecuta solo', async () => {
    const script = [
      { stop_reason: 'tool_use', content: [toolUse('t1', 'pause_ad', { ad_id: '55', title: 'Pausar', reason: 'Fecha completa', expected_impact: 'Ahorro' })] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Listo' }] },
    ];
    const { as, pauta, calls } = await setup({ script });
    await as('marcos').put('/api/pauta/gatitos/settings', { meta_ad_account_id: '456', autonomous: true });
    await (await pauta.startRun('gatitos', 'manual', 'Marcos')).done;
    expect(calls).toContainEqual({ accountId: '456', op: 'setStatus', args: ['55', 'PAUSED'] });
    const decisions = (await as('marcos').get('/api/pauta/gatitos/decisions')).body.decisions;
    expect(decisions[0]).toMatchObject({ tool: 'pause_ad', status: 'executed', decided_by: 'Agente' });
  });

  it('sin Meta corre solo con la tienda y no le ofrece herramientas de Meta', async () => {
    const script = [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Patitas ok' }] },
      {
        stop_reason: 'tool_use',
        content: [
          toolUse('t1', 'pause_ad', { ad_id: '55', title: 'x', reason: 'x', expected_impact: 'x' }),
          toolUse('t2', 'request_creative', { concept: 'Reel del sábado', style_notes: '9:16', reason: 'Fecha floja' }),
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Gatitos sin Meta' }] },
    ];
    const { as, pauta, anthropic, calls } = await setup({ script });
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123' });
    await pauta.runDaily();
    const runs = async (store) => (await as('marcos').get(`/api/pauta/${store}/runs`)).body.runs;
    expect((await runs('perritos'))[0]).toMatchObject({ kind: 'daily', status: 'done', report: 'Patitas ok' });
    expect((await runs('gatitos'))[0]).toMatchObject({ kind: 'daily', status: 'done', report: 'Gatitos sin Meta' });

    const offline = anthropic.received[1];
    const names = offline.tools.map((t) => t.name);
    expect(names).toContain('request_creative');
    expect(names).not.toContain('pause_ad');
    expect(names).not.toContain('search_interest');
    expect(offline.system).toContain('Meta todavía no está conectado');
    expect(offline.messages[0].content).toContain('NO CONECTADO');
    // Si igual pide una acción de Meta, recibe error y no se toca nada
    const results = anthropic.received[2].messages.at(-1).content;
    expect(results.find((r) => r.tool_use_id === 't1').is_error).toBe(true);
    expect(calls).toHaveLength(0);
    const overview = (await as('marcos').get('/api/pauta/gatitos/overview')).body;
    expect(overview.requests[0].concept).toBe('Reel del sábado');
    expect(overview.pending).toHaveLength(0);
  });

  it('crear un conjunto exige el píxel cargado', async () => {
    const script = [
      { stop_reason: 'tool_use', content: [toolUse('t1', 'propose_adset', { campaign_id: '10', name: 'VENTAS_PALERMO', targeting: { geo_locations: { countries: ['AR'] } }, title: 'Nuevo conjunto', reason: 'Probar', expected_impact: 'Ventas' })] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    ];
    const { as, pauta, calls } = await setup({ script });
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123' });
    await (await pauta.startRun('perritos', 'manual', 'Marcos')).done;
    const [d] = (await as('marcos').get('/api/pauta/perritos/overview')).body.pending;
    const failed = (await as('marcos').post(`/api/pauta/perritos/decisions/${d.id}/approve`)).body.decision;
    expect(failed).toMatchObject({ status: 'failed', error: 'Falta cargar el píxel en Ajustes de Pauta.' });
    expect(calls.filter((c) => c.op === 'createAdset')).toHaveLength(0);
  });
});

describe('reporte para el cliente', () => {
  it('devuelve Meta y tienda en el rango pedido, y valida las fechas', async () => {
    const { as } = await setup();
    const sinMeta = (await as('marcos').get('/api/pauta/perritos/report?since=2026-10-01&until=2026-10-07')).body;
    expect(sinMeta).toMatchObject({ meta: null, configured: { metaAccount: false }, range: { previous: { since: '2026-09-24', until: '2026-09-30' } } });
    expect(sinMeta.shop.daily).toHaveLength(7);

    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123' });
    const conMeta = (await as('marcos').get('/api/pauta/perritos/report?since=2026-10-01&until=2026-10-07')).body;
    expect(conMeta.meta.daily).toHaveLength(7);
    expect(conMeta.meta.totals).toMatchObject({ spend: 0, purchases: 0 });

    expect((await as('marcos').get('/api/pauta/perritos/report?since=2026-10-07&until=2026-10-01')).status).toBe(400);
    expect((await as('marcos').get('/api/pauta/perritos/report?since=hoy&until=2026-10-01')).status).toBe(400);
    expect((await as('marcos').get('/api/pauta/perritos/report?since=2026-10-01&until=2099-01-01')).status).toBe(400);
    expect((await as('fran').get('/api/pauta/perritos/report?since=2026-10-01&until=2026-10-07')).status).toBe(403);
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function waitPublished(as, base) {
  let creative;
  for (let i = 0; i < 100; i++) {
    [creative] = (await as('marcos').get(base)).body.creatives;
    if (creative.status !== 'publishing') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return creative;
}

describe('piezas', () => {
  const base = '/api/pauta/perritos/creatives';
  const newCreative = { name: 'Reel sábado', copy: 'Quedan 5 lugares', headline: 'Yoga con perritos', link: 'https://tienda/sabado' };

  it('se crea, se le suben archivos verificados y se publica en segundo plano', async () => {
    const { as, calls } = await setup();
    expect((await as('marcos').post(base, { ...newCreative, link: 'javascript:alert(1)' })).status).toBe(400);
    expect((await as('marcos').post(base, { ...newCreative, cta: 'CALL_NOW' })).status).toBe(400);
    const created = await as('marcos').post(base, newCreative);
    expect(created.status).toBe(201);
    expect(created.body.creative).toMatchObject({ status: 'unused', cta: 'BUY_TICKETS', feed: null });
    const id = created.body.creative.id;

    // El tipo se confirma por el contenido, no por lo que declara el navegador
    expect((await as('marcos').upload(`${base}/${id}/media/feed`, Buffer.from('no soy una imagen'), 'image/png')).status).toBe(415);
    expect((await as('marcos').upload(`${base}/${id}/media/feed`, PNG, 'image/webp')).status).toBe(415);
    expect((await as('marcos').upload(`${base}/${id}/media/costado`, PNG, 'image/png')).status).toBe(400);
    const up = await as('marcos').upload(`${base}/${id}/media/feed`, PNG, 'image/png', 'sábado.png');
    expect(up.status).toBe(200);
    expect(up.body.creative.feed).toMatchObject({ kind: 'image', width: 1, height: 1, original_name: 'sábado.png' });
    expect(up.body.creative.feed.url).toMatch(/^\/api\/media\?key=/);
    expect((await as('marcos').upload(`${base}/${id}/media/story`, PNG, 'image/png')).status).toBe(200);

    // Otra tienda no la ve
    expect((await as('marcos').get('/api/pauta/gatitos/creatives')).body.creatives).toHaveLength(0);
    expect((await as('marcos').upload(`/api/pauta/gatitos/creatives/${id}/media/feed`, PNG, 'image/png')).status).toBe(404);

    // Sin Meta conectado no se puede publicar
    expect((await as('marcos').post(`${base}/${id}/publish`, { adset_id: '77' })).status).toBe(503);
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123', meta_page_id: '900' });
    const pub = await as('marcos').post(`${base}/${id}/publish`, { adset_id: '77', adset_name: 'VENTAS_PALERMO' });
    expect(pub.status).toBe(202);
    expect(pub.body.creative.status).toBe('publishing');
    // Un segundo clic no duplica el anuncio
    expect((await as('marcos').post(`${base}/${id}/publish`, { adset_id: '77' })).status).toBe(409);

    const creative = await waitPublished(as, base);
    expect(creative).toMatchObject({ status: 'used', meta_ad_id: 'createAd-1', meta_adset_id: '77' });
    expect(calls.filter((c) => c.op === 'uploadImage')).toHaveLength(2);
    const spec = calls.find((c) => c.op === 'createCreative').args[0];
    expect(spec.asset_feed_spec.link_urls).toEqual([{ website_url: 'https://tienda/sabado' }]);
    expect(spec.asset_feed_spec.call_to_action_types).toEqual(['BUY_TICKETS']);
    expect(calls.find((c) => c.op === 'createAd').args[0]).toMatchObject({ adsetId: '77', status: 'ACTIVE' });
    const decisions = (await as('marcos').get('/api/pauta/perritos/decisions')).body.decisions;
    expect(decisions[0]).toMatchObject({ tool: 'create_ad', status: 'executed', decided_by: 'Marcos' });

    // Publicada ya no se edita ni se borra, pero se puede archivar
    expect((await as('marcos').patch(`${base}/${id}`, { copy: 'otro' })).status).toBe(409);
    expect((await as('marcos').del(`${base}/${id}`)).status).toBe(409);
    expect((await as('marcos').patch(`${base}/${id}`, { status: 'archived' })).body.creative.status).toBe('archived');
    expect((await as('marcos').get(base)).body.creatives).toHaveLength(0);
  });

  it('si Meta falla, la pieza vuelve a estar disponible con el error', async () => {
    const { as } = await setup();
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123' });
    const id = (await as('marcos').post(base, newCreative)).body.creative.id;
    await as('marcos').upload(`${base}/${id}/media/feed`, PNG, 'image/png');
    expect((await as('marcos').post(`${base}/${id}/publish`, { adset_id: '77' })).status).toBe(202);
    const creative = await waitPublished(as, base);
    expect(creative).toMatchObject({ status: 'unused', publish_error: 'Falta cargar la página de Facebook en Ajustes de Pauta.' });
    // Sin publicar se puede borrar
    expect((await as('marcos').del(`${base}/${id}`)).status).toBe(204);
  });

  it('el agente ve las piezas sin usar y puede proponer publicarlas', async () => {
    const script = [
      { stop_reason: 'tool_use', content: [toolUse('t1', 'create_ad', { creative_id: 'x', adset_id: '77', title: 'Publicar reel', reason: 'Fecha floja', expected_impact: 'Ventas' })] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    ];
    const { as, pauta, anthropic } = await setup({ script });
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123' });
    await as('marcos').post(base, newCreative);
    await (await pauta.startRun('perritos', 'manual', 'Marcos')).done;
    expect(anthropic.received[0].messages[0].content).toMatch(/## unusedCreatives\n\[\{"id":"[^"]+","name":"Reel sábado"/);
    const [d] = (await as('marcos').get('/api/pauta/perritos/overview')).body.pending;
    expect(d).toMatchObject({ tool: 'create_ad', status: 'pending' });
  });
});

describe('promocionar posts de Instagram', () => {
  it('crea el anuncio con el post original y no lo duplica en el mismo conjunto', async () => {
    const { as, calls } = await setup();
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123', meta_page_id: '900' });
    expect((await as('marcos').get('/api/pauta/perritos/ig-posts')).status).toBe(503);
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ig_user_id: '800' });
    expect((await as('marcos').get('/api/pauta/perritos/ig-posts')).body.posts).toEqual([]);

    const body = { adset_id: '77', adset_name: 'VENTAS', link: 'https://tienda/sabado', cta: 'SHOP_NOW' };
    const ok = await as('marcos').post('/api/pauta/perritos/ig-posts/1789/promote', body);
    expect(ok.status).toBe(200);
    const spec = calls.find((c) => c.op === 'createCreative').args[0];
    expect(spec).toMatchObject({ source_instagram_media_id: '1789', instagram_user_id: '800', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://tienda/sabado' } } });
    expect((await as('marcos').post('/api/pauta/perritos/ig-posts/1789/promote', body)).status).toBe(409);
    expect((await as('marcos').post('/api/pauta/perritos/ig-posts/1789/promote', { ...body, link: 'ftp://x' })).status).toBe(400);
  });
});
