// Lectura de las métricas de Meta en términos del negocio: el resultado que importa es la compra
// de entradas en Tienda Nube (evento Purchase del píxel), no el clic ni el "me gusta".
// Meta reporta la misma compra con varios action_type: se toma el primero que aparezca.
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const ADD_TO_CART = ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];
const CHECKOUT = ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'];
const LANDING = ['landing_page_view'];

const num = (v) => (v == null || v === '' ? 0 : Number(v));
function pick(list, types) {
  for (const t of types) {
    const hit = list?.find((a) => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

export function summarizeRow(row) {
  const spend = num(row.spend);
  const purchases = pick(row.actions, PURCHASE);
  const purchaseValue = Math.round(pick(row.action_values, PURCHASE));
  return {
    spend: Math.round(spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    frequency: row.frequency != null ? Number(num(row.frequency).toFixed(2)) : null,
    clicks: num(row.clicks),
    ctr: row.ctr != null ? Number(num(row.ctr).toFixed(2)) : null,
    cpm: row.cpm != null ? Math.round(num(row.cpm)) : null,
    landingViews: pick(row.actions, LANDING),
    addToCart: pick(row.actions, ADD_TO_CART),
    checkouts: pick(row.actions, CHECKOUT),
    purchases,
    purchaseValue,
    costPerPurchase: purchases > 0 ? Math.round(spend / purchases) : null,
    roas: spend > 0 ? Number((purchaseValue / spend).toFixed(2)) : null,
  };
}

const SUMMED = ['spend', 'impressions', 'clicks', 'landingViews', 'addToCart', 'checkouts', 'purchases', 'purchaseValue'];

export function totals(rows) {
  const sum = Object.fromEntries(SUMMED.map((k) => [k, 0]));
  for (const r of rows) {
    const s = summarizeRow(r);
    for (const k of SUMMED) sum[k] += s[k];
  }
  return {
    ...sum,
    costPerPurchase: sum.purchases > 0 ? Math.round(sum.spend / sum.purchases) : null,
    roas: sum.spend > 0 ? Number((sum.purchaseValue / sum.spend).toFixed(2)) : null,
  };
}

// Fecha YYYY-MM-DD en hora argentina (las cuentas publicitarias también están en ART)
export function artDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(d);
}

export function daysAgo(n, from = new Date()) {
  return artDate(new Date(from.getTime() - n * 86400_000));
}

export const monthStart = (from = new Date()) => `${artDate(from).slice(0, 8)}01`;

// Presupuestos de Meta en la moneda de la cuenta (ARS) vienen en centavos
export const centsToArs = (v) => (v == null ? null : Math.round(Number(v) / 100));
