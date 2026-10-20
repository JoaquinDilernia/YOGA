import { artDate, centsToArs, daysAgo, monthStart, summarizeRow, totals } from './metrics.js';

// A dónde lleva el anuncio (qué fecha/producto de la tienda está vendiendo)
function adLink(creative) {
  const spec = creative?.object_story_spec;
  return spec?.link_data?.link
    ?? spec?.video_data?.call_to_action?.value?.link
    ?? creative?.asset_feed_spec?.link_urls?.[0]?.website_url
    ?? null;
}

// Foto de la cuenta: estructura + métricas, en pesos y con la compra como resultado.
// La usan tanto el resumen del panel como el contexto del agente.
export async function buildSnapshot(meta, now = new Date()) {
  const today = artDate(now);
  const [campaigns, adsets, ads, monthRows, weekByAd, weekByAdsetDaily, todayRows] = await Promise.all([
    meta.getCampaigns(),
    meta.getAdsets(),
    meta.getAds(),
    meta.getInsights('account', monthStart(now), today),
    meta.getInsights('ad', daysAgo(6, now), today),
    meta.getInsights('adset', daysAgo(6, now), today, { daily: true }),
    meta.getInsights('account', today, today),
  ]);

  const byAd = new Map(weekByAd.map((r) => [r.ad_id, summarizeRow(r)]));
  const adsetWeek = new Map();
  const adsetDaily = new Map();
  for (const r of weekByAdsetDaily) {
    if (!adsetWeek.has(r.adset_id)) adsetWeek.set(r.adset_id, []);
    adsetWeek.get(r.adset_id).push(r);
    if (!adsetDaily.has(r.adset_id)) adsetDaily.set(r.adset_id, []);
    const s = summarizeRow(r);
    adsetDaily.get(r.adset_id).push({ date: r.date_start, spend: s.spend, purchases: s.purchases, purchaseValue: s.purchaseValue });
  }

  const live = (o) => !['DELETED', 'ARCHIVED'].includes(o.effective_status);
  return {
    generatedAt: now.toISOString(),
    today,
    spendToday: totals(todayRows).spend,
    month: totals(monthRows),
    last7d: totals(weekByAd),
    campaigns: campaigns.filter(live).map((c) => ({
      id: c.id, name: c.name, objective: c.objective, status: c.status, effectiveStatus: c.effective_status,
      dailyBudgetArs: centsToArs(c.daily_budget), isCbo: c.daily_budget != null || c.lifetime_budget != null, createdAt: c.created_time,
    })),
    adsets: adsets.filter(live).map((a) => ({
      id: a.id, name: a.name, campaignId: a.campaign_id, status: a.status, effectiveStatus: a.effective_status,
      dailyBudgetArs: centsToArs(a.daily_budget), optimizationGoal: a.optimization_goal, destination: a.destination_type,
      promotedObject: a.promoted_object ?? null, learningStage: a.learning_stage_info?.status ?? null, targeting: a.targeting,
      createdAt: a.created_time,
      last7d: totals(adsetWeek.get(a.id) ?? []), daily: (adsetDaily.get(a.id) ?? []).sort((x, y) => x.date.localeCompare(y.date)),
    })),
    ads: ads.filter(live).map((a) => ({
      id: a.id, name: a.name, adsetId: a.adset_id, campaignId: a.campaign_id, status: a.status, effectiveStatus: a.effective_status,
      createdAt: a.created_time, creativeId: a.creative?.id ?? null, copy: a.creative?.body ?? null, link: adLink(a.creative),
      thumbnail: a.creative?.thumbnail_url ?? null, last7d: byAd.get(a.id) ?? summarizeRow({}),
    })),
  };
}
