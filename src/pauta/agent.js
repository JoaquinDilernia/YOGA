import { TOOL_DEFINITIONS, READ_ONLY_TOOLS, META_ACTIONS } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSnapshot } from './snapshot.js';
import { buildAdName, buildIgPostCreativeSpec } from './creativeSpec.js';
import { artDate } from './metrics.js';
import { conflict } from '../errors.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 12;

// Posts de IG con dónde ya se promocionaron (lo usan el panel y el contexto del agente)
export async function loadIgPosts({ meta, repo, store, igUserId }) {
  const [posts, promos] = await Promise.all([meta.getIgMedia(igUserId), repo.listIgPromotions(store)]);
  return posts.map((p) => ({
    ...p,
    promotedIn: promos
      .filter((x) => x.ig_media_id === p.id)
      .map((x) => ({ adset_id: x.meta_adset_id, adset_name: x.adset_name, ad_id: x.meta_ad_id, created_at: x.created_at })),
  }));
}

// Ejecuta una acción sobre la cuenta de Meta de una tienda (al aprobarla en el panel, o sola en modo autónomo)
export function createExecutor({ meta, repo, store, settings }) {
  const need = (field, label) => {
    if (!settings[field]) throw new Error(`Falta cargar ${label} en Ajustes de Pauta.`);
    return settings[field];
  };

  async function promoteIgPost({ ig_media_id: mediaId, adset_id: adsetId, adset_name: adsetName, permalink, link }, { userName } = {}) {
    const pageId = need('meta_page_id', 'la página de Facebook');
    const igUserId = need('meta_ig_user_id', 'la cuenta de Instagram');
    // Se reserva antes de tocar Meta: dos pedidos a la vez del mismo post y conjunto no crean dos anuncios
    const reservation = await repo.reserveIgPromotion(store, { igMediaId: mediaId, permalink, adsetId, adsetName, userName });
    const name = buildAdName({ adsetName: adsetName || adsetId, creativeName: `IG${mediaId.slice(-6)}`, date: artDate() });
    try {
      const creative = await meta.createCreative(buildIgPostCreativeSpec({ name, pageId, igUserId, mediaId, link }));
      const ad = await meta.createAd({ name, adsetId, creativeId: creative.id, status: 'ACTIVE' });
      await repo.completeIgPromotion(reservation.id, ad.id);
      return { ad_id: ad.id, name };
    } catch (err) {
      await repo.releaseIgPromotion(reservation.id);
      throw err;
    }
  }

  return async function execute(tool, input, ctx = {}) {
    switch (tool) {
      case 'pause_ad':
        await meta.setStatus(input.ad_id, 'PAUSED');
        return { paused: input.ad_id };
      case 'set_status':
        await meta.setStatus(input.object_id, input.status);
        return { [input.object_id]: input.status };
      case 'propose_budget_change':
        await meta.updateDailyBudget(input.object_id, Math.round(input.proposed_budget_ars * 100));
        return { [input.object_id]: input.proposed_budget_ars };
      case 'propose_campaign': {
        const campaign = await meta.createCampaign({
          name: input.name, objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: [],
          daily_budget: Math.round(input.daily_budget_ars * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        });
        return { campaign_id: campaign.id };
      }
      case 'propose_adset': {
        const pixelId = need('meta_pixel_id', 'el píxel');
        const targeting = { ...input.targeting };
        if (!targeting.targeting_automation) targeting.targeting_automation = { advantage_audience: 0 };
        const adset = await meta.createAdset({
          campaign_id: input.campaign_id, name: input.name, status: 'PAUSED', targeting,
          billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS',
          promoted_object: { pixel_id: pixelId, custom_event_type: 'PURCHASE' },
          ...(input.daily_budget_ars ? { daily_budget: Math.round(input.daily_budget_ars * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP' } : {}),
        });
        return { adset_id: adset.id };
      }
      case 'reuse_ad': {
        const name = input.ad_name || buildAdName({ adsetName: input.adset_name || input.adset_id, creativeName: `COPIA${String(input.source_ad_id ?? '').slice(-6)}`, date: artDate() });
        const ad = await meta.createAd({ name, adsetId: input.adset_id, creativeId: input.creative_id, status: 'ACTIVE' });
        return { ad_id: ad.id, name };
      }
      case 'promote_ig_post':
        return promoteIgPost(input, ctx);
      default:
        throw new Error(`Acción desconocida: ${tool}`);
    }
  };
}

// Atiende cada tool_use del modelo durante una corrida
export function createDispatcher({ meta, repo, store, execute }) {
  return async function dispatch(name, input, { runId, settings }) {
    const base = { runId, tool: name, input, title: input.title ?? '', reason: input.reason ?? '', expectedImpact: input.expected_impact ?? '' };
    try {
      if (name === 'search_interest') return { results: await meta.searchInterests(input.query) };
      if (name === 'request_creative') {
        await repo.addRequest(store, { concept: input.concept, styleNotes: input.style_notes, reason: input.reason });
        return { ok: true, note: 'Pedido cargado en el panel para el equipo.' };
      }
      if (name === 'save_learning') return { ok: true, learning_id: (await repo.upsertLearning(store, input)).id };
      if (name === 'record_outcome') {
        await repo.recordOutcome(store, input.decision_id, input.outcome);
        return { ok: true };
      }
      if (name === 'ask_team') {
        const question = String(input.question ?? '').trim();
        if (!question) return { error: 'Falta la pregunta.' };
        const quickAnswers = (Array.isArray(input.quick_answers) ? input.quick_answers : [])
          .filter((a) => typeof a === 'string' && a.trim())
          .slice(0, 4)
          .map((a) => a.trim().slice(0, 80));
        const q = await repo.addQuestion(store, { runId, question, why: String(input.why ?? ''), quickAnswers });
        return { ok: true, question_id: q.id, note: 'La pregunta quedó en el panel; la respuesta te llega en una próxima corrida.' };
      }
      if (!META_ACTIONS.has(name)) return { error: `Herramienta desconocida: ${name}` };

      if (name === 'pause_ad' && settings.autonomous) {
        const result = await execute(name, input);
        await repo.addDecision(store, { ...base, status: 'executed', result, decidedBy: 'Agente' });
        return { ok: true, executed: true, ...result };
      }
      const d = await repo.addDecision(store, { ...base, status: 'pending' });
      return { queued: true, decision_id: d.id, note: 'Quedó pendiente de aprobación en el panel.' };
    } catch (err) {
      if (!READ_ONLY_TOOLS.has(name)) await repo.addDecision(store, { ...base, status: 'failed', error: String(err.message || err) });
      return { error: String(err.message || err) };
    }
  };
}

async function igPostsForContext({ meta, repo, store, settings }) {
  if (!settings.meta_ig_user_id) return [];
  try {
    const posts = await loadIgPosts({ meta, repo, store, igUserId: settings.meta_ig_user_id });
    return posts.map((p) => ({
      id: p.id, type: p.type, caption: p.caption.slice(0, 300), timestamp: p.timestamp, permalink: p.permalink,
      likes: p.likes, comments: p.comments, reach: p.reach, promotedIn: p.promotedIn.map((x) => x.adset_name || x.adset_id),
    }));
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

export async function buildContext({ meta, repo, store, settings, shop }) {
  const [snapshot, requests, learnings, pending, recent, toEvaluate, openQuestions, answered, igPosts] = await Promise.all([
    buildSnapshot(meta),
    repo.listRequests(store, { status: 'open' }),
    repo.listLearnings(store, { activeOnly: true }),
    repo.listDecisions(store, { status: 'pending', limit: 30 }),
    repo.listDecisions(store, { limit: 30 }),
    repo.executedWithoutOutcome(store, 48),
    repo.listQuestions(store, { status: 'open', limit: 30 }),
    repo.answeredSinceLastRun(store),
    igPostsForContext({ meta, repo, store, settings }),
  ]);
  const sections = {
    today: snapshot.today,
    settings: {
      monthly_cap_ars: settings.monthly_cap_ars, target_cpa_ars: settings.target_cpa_ars,
      autonomous: settings.autonomous, business_notes: settings.business_notes,
    },
    spendThisMonth: snapshot.month.spend,
    account: { spendToday: snapshot.spendToday, month: snapshot.month, last7d: snapshot.last7d },
    shop,
    campaigns: snapshot.campaigns,
    adsets: snapshot.adsets,
    ads: snapshot.ads,
    igPosts,
    openCreativeRequests: requests.map((r) => ({ concept: r.concept, created_at: r.created_at })),
    activeLearnings: learnings.map((l) => ({ id: l.id, text: l.text, evidence: l.evidence })),
    pendingRecommendations: pending.map((d) => ({ id: d.id, tool: d.tool, title: d.title, created_at: d.created_at })),
    recentDecisions: recent.filter((d) => d.status !== 'pending').map((d) => ({ id: d.id, tool: d.tool, title: d.title, status: d.status, outcome: d.outcome, created_at: d.created_at })),
    decisionsToEvaluate: toEvaluate,
    openQuestions: openQuestions.map((q) => ({ id: q.id, question: q.question, created_at: q.created_at })),
    answeredQuestions: answered.map((q) => ({ question: q.question, answer: q.answer, answered_by: q.answered_by, answered_at: q.answered_at })),
  };
  return Object.entries(sections).map(([k, v]) => `## ${k}\n${JSON.stringify(v)}`).join('\n\n');
}

// metaFor(settings) devuelve el cliente de la cuenta de esa tienda (o null si falta conectarla)
// getShop(storeKey) devuelve el contexto de Tienda Nube (fechas, lugares, ventas)
export function createAgentRunner({ anthropic, repo, metaFor, getShop, stores, model = DEFAULT_MODEL }) {
  async function process(store, runRow, settings, meta) {
    try {
      const dispatch = createDispatcher({ meta, repo, store: store.key, execute: createExecutor({ meta, repo, store: store.key, settings }) });
      const shop = await getShop(store.key);
      const context = await buildContext({ meta, repo, store: store.key, settings, shop });
      const messages = [{ role: 'user', content: `Análisis ${runRow.kind === 'daily' ? 'diario' : 'pedido desde el panel'} de ${store.name}. Datos actuales:\n\n${context}` }];
      let report = '';
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = anthropic.beta.messages.stream({
          model,
          max_tokens: 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: buildSystemPrompt(store.name),
          tools: TOOL_DEFINITIONS,
          messages,
        });
        const resp = await stream.finalMessage();
        if (resp.stop_reason === 'refusal') throw new Error('El modelo no pudo completar el análisis (refusal).');
        messages.push({ role: 'assistant', content: resp.content });
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) report = text;
        if (resp.stop_reason !== 'tool_use') break;
        const results = [];
        for (const block of resp.content.filter((b) => b.type === 'tool_use')) {
          const result = await dispatch(block.name, block.input ?? {}, { runId: runRow.id, settings });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      return await repo.finishRun(runRow.id, { status: 'done', report: report || 'El agente terminó sin dejar informe.' });
    } catch (err) {
      console.error(`[pauta:${store.key}] corrida falló:`, err);
      return repo.finishRun(runRow.id, { status: 'failed', error: String(err.message || err) });
    }
  }

  // Arranca una corrida y devuelve la fila enseguida; done se resuelve cuando termina
  // (el análisis tarda minutos: el panel muestra "analizando" y consulta de nuevo).
  return async function start(storeKey, kind, userName) {
    const store = stores.find((s) => s.key === storeKey);
    const settings = await repo.getSettings(storeKey);
    const meta = metaFor(settings);
    const skip = !settings.agent_enabled && kind === 'daily' ? 'El agente está apagado en Ajustes.'
      : !meta ? 'Falta conectar la cuenta de Meta en Ajustes.'
        : null;
    if (skip && kind === 'daily') {
      const r = await repo.startRun(storeKey, kind, userName);
      const run = await repo.finishRun(r.id, { status: 'skipped', report: skip });
      return { run, done: Promise.resolve(run) };
    }
    if (skip) throw conflict(skip);
    if (await repo.runningRun(storeKey)) throw conflict('Ya hay un análisis corriendo. Esperá unos minutos.');
    const run = await repo.startRun(storeKey, kind, userName);
    return { run, done: process(store, run, settings, meta) };
  };
}
