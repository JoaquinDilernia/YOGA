import { TOOL_DEFINITIONS, OFFLINE_TOOL_DEFINITIONS, READ_ONLY_TOOLS, META_ACTIONS } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSnapshot } from './snapshot.js';
import { agencyName, buildAdName, buildCopyCreativeSpec, buildIgPostCreativeSpec, buildLinkCreativeSpec } from './creativeSpec.js';
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
export function createExecutor({ meta, repo, store, settings, media }) {
  const need = (field, label) => {
    if (!settings[field]) throw new Error(`Falta cargar ${label} en Ajustes de Pauta.`);
    return settings[field];
  };

  // La pieza se reclama antes de tocar Meta (puede tardar minutos con video): un segundo "Publicar" recibe 409
  // claimed: el panel ya la reclamó para contestar enseguida y publicar en segundo plano
  async function publishCreative({ creative_id: creativeId, adset_id: adsetId, adset_name: adsetName }, { claimed = false } = {}) {
    const creative = claimed ? await repo.getCreative(store, creativeId) : await repo.claimCreative(store, creativeId);
    try {
      return await publishClaimed(creative, adsetId, adsetName);
    } catch (err) {
      await repo.releaseCreative(creativeId, String(err.message || err));
      throw err;
    }
  }

  async function publishClaimed(creative, adsetId, adsetName) {
    const pageId = need('meta_page_id', 'la página de Facebook');
    const files = await repo.getMedia(creative.id);
    const feedFile = files.find((f) => f.slot === 'feed');
    const storyFile = files.find((f) => f.slot === 'story');
    if (!feedFile) throw new Error(`La pieza "${creative.name}" no tiene imagen ni video de feed.`);
    // Imagen: se sube el archivo y Meta devuelve un hash. Video: con el bucket Meta lo descarga del link firmado
    // (el servidor no mueve los MB); con storage local se manda el archivo. Después hay que esperar el procesamiento.
    const toMeta = async (f) => {
      if (f.kind !== 'video') return { type: 'image', hash: await meta.uploadImage(await media.read(f)) };
      const videoName = f.original_name || creative.name;
      const videoId = media.isRemote
        ? await meta.uploadVideo({ fileUrl: await media.signedUrl(f), name: videoName })
        : await meta.uploadVideo({ buffer: await media.read(f), name: videoName });
      await meta.waitVideoReady(videoId);
      return { type: 'video', videoId, thumbnailUrl: await meta.videoThumbnail(videoId) };
    };
    const [feed, story] = await Promise.all([toMeta(feedFile), storyFile ? toMeta(storyFile) : null]);
    const name = buildAdName({ adsetName: adsetName || adsetId, creativeName: creative.name, date: artDate() });
    const spec = buildLinkCreativeSpec({
      name, pageId, igUserId: settings.meta_ig_user_id || null, message: creative.copy, headline: creative.headline,
      link: creative.link, cta: creative.cta, feed, story,
    });
    const { id: metaCreativeId } = await meta.createCreative(spec);
    const ad = await meta.createAd({ name, adsetId, creativeId: metaCreativeId, status: 'ACTIVE' });
    await repo.markCreativeUsed(creative.id, ad.id, adsetId);
    return { ad_id: ad.id, name };
  }

  async function promoteIgPost({ ig_media_id: mediaId, adset_id: adsetId, adset_name: adsetName, permalink, link, cta }, { userName } = {}) {
    const pageId = need('meta_page_id', 'la página de Facebook');
    const igUserId = need('meta_ig_user_id', 'la cuenta de Instagram');
    // Se reserva antes de tocar Meta: dos pedidos a la vez del mismo post y conjunto no crean dos anuncios
    const reservation = await repo.reserveIgPromotion(store, { igMediaId: mediaId, permalink, adsetId, adsetName, userName });
    const name = buildAdName({ adsetName: adsetName || adsetId, creativeName: `IG${mediaId.slice(-6)}`, date: artDate() });
    try {
      const creative = await meta.createCreative(buildIgPostCreativeSpec({ name, pageId, igUserId, mediaId, link, cta }));
      const ad = await meta.createAd({ name, adsetId, creativeId: creative.id, status: 'ACTIVE' });
      await repo.completeIgPromotion(reservation.id, ad.id);
      return { ad_id: ad.id, name };
    } catch (err) {
      await repo.releaseIgPromotion(reservation.id);
      throw err;
    }
  }

  // Conjunto optimizando compras del píxel; sin presupuesto propio si la campaña es CBO
  async function createAdset({ campaignId, name, targeting: base, dailyBudgetArs, status }) {
    const pixelId = need('meta_pixel_id', 'el píxel');
    const targeting = { ...base };
    if (!targeting.targeting_automation) targeting.targeting_automation = { advantage_audience: 0 };
    const adset = await meta.createAdset({
      campaign_id: campaignId, name, status, targeting,
      billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS',
      promoted_object: { pixel_id: pixelId, custom_event_type: 'PURCHASE' },
      ...(dailyBudgetArs ? { daily_budget: Math.round(dailyBudgetArs * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP' } : {}),
    });
    return adset.id;
  }

  // Anuncio nuevo con una copia del creativo (mismo material, con UTMs) en otro conjunto
  async function copyAd({ creativeId, adsetId, adsetName, label }) {
    const name = buildAdName({ adsetName: adsetName || adsetId, creativeName: label || `COPIA${String(creativeId).slice(-6)}`, date: artDate() });
    const source = await meta.getCreative(creativeId);
    const { id: copyId } = await meta.createCreative(buildCopyCreativeSpec(source, { name }));
    const ad = await meta.createAd({ name, adsetId, creativeId: copyId, status: 'ACTIVE' });
    return { ad_id: ad.id, name };
  }

  // Campaña de ventas con sus conjuntos y anuncios de una vez. La campaña nace PAUSADA y es la única llave:
  // conjuntos y anuncios quedan activos adentro y arrancan cuando el equipo la prende.
  async function createCampaign(input) {
    if (input.adsets?.length) need('meta_pixel_id', 'el píxel');
    const campaign = await meta.createCampaign({
      name: agencyName(input.name), objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: [],
      daily_budget: Math.round(input.daily_budget_ars * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    });
    const created = [];
    try {
      for (const a of input.adsets ?? []) {
        const name = agencyName(a.name);
        const row = { adset_id: await createAdset({ campaignId: campaign.id, name, targeting: a.targeting, status: 'ACTIVE' }), name, ads: [] };
        created.push(row);
        for (const c of a.copy_creatives ?? []) row.ads.push(await copyAd({ creativeId: c.creative_id, adsetId: row.adset_id, adsetName: name, label: c.label }));
      }
    } catch (err) {
      const done = created.map((r) => `${r.name} (${r.ads.length} anuncios)`).join(', ') || 'sin conjuntos';
      throw new Error(`${err.message} — La campaña ${campaign.id} quedó creada y pausada, ${done}.`);
    }
    return { campaign_id: campaign.id, adsets: created };
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
      case 'propose_campaign':
        return createCampaign(input);
      case 'propose_adset': {
        const name = agencyName(input.name);
        const adsetId = await createAdset({ campaignId: input.campaign_id, name, targeting: input.targeting, dailyBudgetArs: input.daily_budget_ars, status: 'PAUSED' });
        return { adset_id: adsetId, name };
      }
      case 'reuse_ad':
        return copyAd({
          creativeId: input.creative_id, adsetId: input.adset_id, adsetName: input.adset_name,
          label: input.ad_name || `COPIA${String(input.source_ad_id ?? '').slice(-6)}`,
        });
      case 'create_ad':
        return publishCreative(input, ctx);
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
      if (!meta && (name === 'search_interest' || META_ACTIONS.has(name))) return { error: 'Meta todavía no está conectado: esta herramienta no está disponible.' };
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

// Piezas subidas al panel que todavía no se publicaron: el agente puede proponer publicarlas con create_ad
async function unusedCreativesForContext({ repo, store }) {
  const creatives = await repo.listCreatives(store, { status: 'unused' });
  return creatives.map((c) => ({
    id: c.id, name: c.name, copy: c.copy, headline: c.headline, notes: c.notes, link: c.link, cta: c.cta,
    feed: c.feed?.kind ?? null, story: c.story?.kind ?? null, ready: Boolean(c.feed), created_at: c.created_at,
  }));
}

export async function buildContext({ meta, repo, store, settings, shop }) {
  const [snapshot, requests, learnings, pending, recent, toEvaluate, openQuestions, answered, igPosts, unusedCreatives] = await Promise.all([
    meta ? buildSnapshot(meta) : null,
    repo.listRequests(store, { status: 'open' }),
    repo.listLearnings(store, { activeOnly: true }),
    repo.listDecisions(store, { status: 'pending', limit: 30 }),
    repo.listDecisions(store, { limit: 30 }),
    repo.executedWithoutOutcome(store, 48),
    repo.listQuestions(store, { status: 'open', limit: 30 }),
    repo.answeredSinceLastRun(store),
    meta ? igPostsForContext({ meta, repo, store, settings }) : [],
    unusedCreativesForContext({ repo, store }),
  ]);
  const settingsSection = {
    monthly_cap_ars: settings.monthly_cap_ars, target_cpa_ars: settings.target_cpa_ars,
    autonomous: settings.autonomous, business_notes: settings.business_notes,
  };
  const metaSections = snapshot
    ? {
      spendThisMonth: snapshot.month.spend,
      account: { spendToday: snapshot.spendToday, month: snapshot.month, last7d: snapshot.last7d },
      campaigns: snapshot.campaigns,
      adsets: snapshot.adsets,
      ads: snapshot.ads,
      igPosts,
    }
    : { meta: 'NO CONECTADO: todavía no hay acceso a la cuenta de Meta. No hay datos de anuncios ni se pueden proponer acciones sobre Meta.' };
  const sections = {
    today: snapshot?.today ?? shop.today,
    settings: settingsSection,
    shop,
    ...metaSections,
    unusedCreatives,
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
// Sin Meta conectado igual corre: analiza la tienda (fechas flojas, ventas) y pide piezas o pregunta
export function createAgentRunner({ anthropic, repo, metaFor, getShop, stores, media, model = DEFAULT_MODEL }) {
  async function process(store, runRow, settings, meta) {
    try {
      const dispatch = createDispatcher({ meta, repo, store: store.key, execute: createExecutor({ meta, repo, store: store.key, settings, media }) });
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
          system: buildSystemPrompt(store.name, { metaConnected: Boolean(meta) }),
          tools: meta ? TOOL_DEFINITIONS : OFFLINE_TOOL_DEFINITIONS,
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
    if (!settings.agent_enabled && kind === 'daily') {
      const r = await repo.startRun(storeKey, kind, userName);
      const run = await repo.finishRun(r.id, { status: 'skipped', report: 'El agente está apagado en Ajustes.' });
      return { run, done: Promise.resolve(run) };
    }
    if (await repo.runningRun(storeKey)) throw conflict('Ya hay un análisis corriendo. Esperá unos minutos.');
    const run = await repo.startRun(storeKey, kind, userName);
    return { run, done: process(store, run, settings, meta) };
  };
}
