// Separa lo que está corriendo de lo pausado. Lo que está en revisión, rechazado o con problemas
// cuenta como activo: alguien lo quiere prendido y necesita atención.
const PAUSED = new Set(['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'DELETED']);

export const isPaused = (status) => PAUSED.has(status);

const matches = (status, view) => view === 'all' || (view === 'paused') === isPaused(status);

// Campañas → conjuntos → anuncios de la vista elegida. Un conjunto o una campaña se muestran si
// tienen algún anuncio de la vista, o si están vacíos y su propio estado es de la vista.
export function filterTree(snap, view) {
  return snap.campaigns.map((c) => {
    const adsets = snap.adsets.filter((a) => a.campaignId === c.id).map((a) => {
      const all = snap.ads.filter((ad) => ad.adsetId === a.id);
      const ads = all.filter((ad) => matches(ad.effectiveStatus, view));
      const show = ads.length > 0 || (all.length === 0 && matches(a.effectiveStatus, view));
      return show ? { ...a, ads, empty: all.length === 0 } : null;
    }).filter(Boolean);
    const hasAny = snap.adsets.some((a) => a.campaignId === c.id);
    const show = adsets.length > 0 || (!hasAny && matches(c.effectiveStatus, view));
    return show ? { ...c, adsets } : null;
  }).filter(Boolean);
}

export function countAds(snap) {
  const paused = snap.ads.filter((ad) => isPaused(ad.effectiveStatus)).length;
  return { active: snap.ads.length - paused, paused };
}
