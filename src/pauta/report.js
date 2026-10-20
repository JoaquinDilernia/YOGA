import { summarizeRow, totals } from './metrics.js';
import { dateRange, salesInRange } from './shop.js';

// Período anterior de la misma duración, para comparar
export function previousRange(since, until) {
  const days = dateRange(since, until).length;
  const end = new Date(Date.parse(`${since}T00:00:00Z`) - 86400_000);
  const start = new Date(end.getTime() - (days - 1) * 86400_000);
  return { since: start.toISOString().slice(0, 10), until: end.toISOString().slice(0, 10) };
}

// Reporte de resultados de Meta para mostrarle al cliente: totales, día por día, campañas y anuncios.
// Al lado, las ventas reales de la tienda en el mismo rango.
export async function buildMetaReport(meta, since, until) {
  const prev = previousRange(since, until);
  const [current, previous, daily, byCampaign, byAd, ads] = await Promise.all([
    meta.getInsights('account', since, until),
    meta.getInsights('account', prev.since, prev.until),
    meta.getInsights('account', since, until, { daily: true }),
    meta.getInsights('campaign', since, until),
    meta.getInsights('ad', since, until),
    meta.getAds(),
  ]);
  const account = summarizeRow(current[0] ?? {});
  const perDay = new Map(daily.map((r) => [r.date_start, summarizeRow(r)]));
  const adInfo = new Map(ads.map((a) => [a.id, a]));
  const bySpend = (a, b) => b.spend - a.spend;
  return {
    totals: { ...totals(current), reach: account.reach, frequency: account.frequency, ctr: account.ctr, cpm: account.cpm },
    previousTotals: totals(previous),
    daily: dateRange(since, until).map((date) => {
      const s = perDay.get(date) ?? summarizeRow({});
      return { date, spend: s.spend, purchases: s.purchases, purchaseValue: s.purchaseValue, impressions: s.impressions, clicks: s.clicks };
    }),
    campaigns: byCampaign.map((r) => ({ id: r.campaign_id, name: r.campaign_name, ...summarizeRow(r) })).sort(bySpend),
    ads: byAd
      .map((r) => ({
        id: r.ad_id, name: r.ad_name, campaignName: r.campaign_name, adsetName: r.adset_name,
        thumbnail: adInfo.get(r.ad_id)?.creative?.thumbnail_url ?? null, status: adInfo.get(r.ad_id)?.effective_status ?? null,
        ...summarizeRow(r),
      }))
      .sort(bySpend),
  };
}

export function buildShopReport(raw, since, until) {
  const prev = previousRange(since, until);
  const current = salesInRange(raw, since, until);
  return { totals: current.totals, previousTotals: salesInRange(raw, prev.since, prev.until).totals, daily: current.daily };
}
