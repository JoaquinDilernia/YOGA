import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db.js';
import { createPauta } from '../src/pauta/index.js';
import { pautaErrorHandler } from '../src/pauta/routes.js';

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
  const pauta = createPauta({
    db, stores: STORES, metaToken, anthropic,
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

  it('sin cuenta de Meta no se puede analizar', async () => {
    const res = await ctx.as('marcos').post('/api/pauta/gatitos/runs');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cuenta de Meta/);
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

  it('la corrida diaria salta las tiendas sin Meta conectada', async () => {
    const script = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Todo en orden' }] }];
    const { as, pauta } = await setup({ script });
    await as('marcos').put('/api/pauta/perritos/settings', { meta_ad_account_id: '123' });
    await pauta.runDaily();
    const runs = async (store) => (await as('marcos').get(`/api/pauta/${store}/runs`)).body.runs;
    expect((await runs('perritos'))[0]).toMatchObject({ kind: 'daily', status: 'done', report: 'Todo en orden' });
    expect((await runs('gatitos'))[0]).toMatchObject({ kind: 'daily', status: 'skipped', report: 'Falta conectar la cuenta de Meta en Ajustes.' });
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
