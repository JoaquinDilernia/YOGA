import { parseProductName, productName } from '../tiendanube.js';
import { artDate, daysAgo, monthStart } from './metrics.js';

// Órdenes que entraron desde un anuncio o post de Meta: TN guarda la URL de llegada
// (fbclid lo agrega Meta a cada clic; utm_source si el anuncio lo tiene configurado)
const META_LANDING = /[?&](fbclid|igshid)=|utm_source=(facebook|fb|instagram|ig|meta)\b/i;
export const cameFromMeta = (o) => META_LANDING.test(o.landing_url || '');

const tickets = (o) => (o.products || []).reduce((n, p) => n + (Number(p.quantity) || 1), 0);

function sum(orders) {
  const meta = orders.filter(cameFromMeta);
  return {
    orders: orders.length,
    tickets: orders.reduce((n, o) => n + tickets(o), 0),
    revenue: Math.round(orders.reduce((n, o) => n + Number(o.total || 0), 0)),
    fromMetaOrders: meta.length,
    fromMetaRevenue: Math.round(meta.reduce((n, o) => n + Number(o.total || 0), 0)),
  };
}

// Qué se vende: una fecha (clases), una gift card o un cumpleaños (festejo). Las gift cards de cumpleaños son gift.
export function productKind(name, refDate) {
  if (parseProductName(name, refDate).date) return 'clases';
  if (/gift/i.test(name)) return 'gift';
  if (/cumple/i.test(name)) return 'cumple';
  return 'otros';
}

// Ventas por tipo de producto: una orden cuenta en cada tipo que trae
function byProduct(orders, products) {
  const names = new Map(products.map((p) => [p.id, { name: productName(p), created: p.created_at }]));
  const out = {};
  for (const o of orders) {
    const kinds = new Set();
    for (const line of o.products || []) {
      const p = names.get(line.product_id);
      const kind = productKind(p?.name ?? line.name ?? '', p?.created ?? o.created_at);
      const row = (out[kind] ??= { orders: 0, units: 0, revenue: 0, fromMetaOrders: 0 });
      const qty = Number(line.quantity) || 1;
      row.units += qty;
      row.revenue += Math.round((Number(line.price) || 0) * qty);
      kinds.add(kind);
    }
    for (const k of kinds) {
      out[k].orders += 1;
      if (cameFromMeta(o)) out[k].fromMetaOrders += 1;
    }
  }
  return out;
}

// Ventas por campaña según la UTM de llegada (los anuncios TechDi_ la llevan; los heredados no)
function byCampaign(orders) {
  const out = {};
  for (const o of orders) {
    let campaign = null;
    try {
      campaign = new URL(o.landing_url).searchParams.get('utm_campaign');
    } catch {
      campaign = null;
    }
    if (!campaign) continue;
    const row = (out[campaign] ??= { orders: 0, revenue: 0 });
    row.orders += 1;
    row.revenue += Math.round(Number(o.total || 0));
  }
  return out;
}

// Días YYYY-MM-DD entre since y until inclusive
export function dateRange(since, until) {
  const out = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// Ventas pagadas de la tienda en un rango (para el reporte): totales y día por día
export function salesInRange(raw, since, until) {
  const byDate = new Map(dateRange(since, until).map((d) => [d, []]));
  for (const o of raw.orders) {
    if (o.status === 'cancelled' || o.payment_status !== 'paid') continue;
    byDate.get(artDate(new Date(o.created_at)))?.push(o);
  }
  return {
    totals: sum([...byDate.values()].flat()),
    daily: [...byDate].map(([date, orders]) => {
      const s = sum(orders);
      return { date, orders: s.orders, tickets: s.tickets, revenue: s.revenue, fromMeta: s.fromMetaOrders };
    }),
  };
}

// Lo que el agente necesita saber de la tienda: qué fechas hay que llenar y cómo vienen las ventas
export function buildShopContext({ raw, turnos }, now = new Date()) {
  const today = artDate(now);
  const paid = raw.orders.filter((o) => o.status !== 'cancelled' && o.payment_status === 'paid');
  const orderDate = (o) => artDate(new Date(o.created_at));

  const byDate = new Map();
  for (const s of turnos.slots) {
    if (!s.date || s.date < today) continue;
    const key = `${s.date}|${s.place}`;
    if (!byDate.has(key)) {
      const days = Math.round((Date.parse(s.date) - Date.parse(today)) / 86400_000);
      byDate.set(key, { date: s.date, title: s.title, place: s.place, daysUntil: days, published: s.published, url: s.url, booked: 0, left: 0, capacity: 0, slots: [] });
    }
    const d = byDate.get(key);
    const left = s.stockLeft ?? null;
    d.booked += s.booked;
    if (left != null) {
      d.left += left;
      d.capacity += left + s.booked;
    }
    d.published ||= s.published;
    d.slots.push({ time: s.time, booked: s.booked, left });
  }
  const upcomingClasses = [...byDate.values()].map((d) => ({
    ...d,
    fillPct: d.capacity ? Math.round((d.booked / d.capacity) * 100) : null,
  }));

  const otherProducts = raw.products
    .filter((p) => p.published && !parseProductName(productName(p), p.created_at).date)
    .map((p) => ({ name: productName(p), kind: productKind(productName(p)), price: Number(p.variants?.[0]?.price) || null, url: p.canonical_url || '' }));
  const last30d = paid.filter((o) => orderDate(o) >= daysAgo(29, now));

  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const date = daysAgo(i, now);
    const s = sum(paid.filter((o) => orderDate(o) === date));
    daily.push({ date, orders: s.orders, tickets: s.tickets, revenue: s.revenue, fromMeta: s.fromMetaOrders });
  }

  return {
    storeUrl: raw.storeUrl,
    today,
    upcomingClasses,
    otherProducts,
    sales: {
      note: 'Órdenes pagadas en Tienda Nube (la fuente real). fromMeta = llegaron con un clic de Meta según la URL de llegada (estimación, no cuenta quien vio el anuncio y entró después).',
      today: sum(paid.filter((o) => orderDate(o) === today)),
      last7d: sum(paid.filter((o) => orderDate(o) >= daysAgo(6, now))),
      monthToDate: sum(paid.filter((o) => orderDate(o) >= monthStart(now))),
      daily,
      // clases / gift / cumple: cómo viene cada producto (el foco puede estar en gift y cumpleaños, no solo en las fechas)
      last30dByProduct: byProduct(last30d, raw.products),
      // utm_campaign de la URL de llegada: qué campaña trajo la venta aunque el píxel no la registre
      last30dByCampaign: byCampaign(last30d),
    },
  };
}
