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
    .map((p) => ({ name: productName(p), price: Number(p.variants?.[0]?.price) || null, url: p.canonical_url || '' }));

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
    },
  };
}
