// Lectura de Tienda Nube: productos (cada uno es una fecha de clase, cada variante un horario) y órdenes.
// La usan la vista de turnos y el contexto del agente de pauta.
const CACHE_MS = 60 * 1000;
const UA = 'Turnos Panel (jdilernia99@gmail.com)';

export async function tnGetAll(store, resource, fields, fetchFn = fetch) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const url = `https://api.tiendanube.com/v1/${store.id}/${resource}?per_page=200&page=${page}&fields=${fields}`;
    const res = await fetchFn(url, { headers: { Authentication: `bearer ${store.token}`, 'User-Agent': UA } });
    if (res.status === 404 && page > 1) break; // TN responde 404 pasada la última página
    if (!res.ok) throw new Error(`Tienda Nube ${resource} ${res.status}: ${await res.text()}`);
    const items = await res.json();
    out.push(...items);
    if (items.length < 200) break;
  }
  return out;
}

async function tnGetStore(store, fetchFn = fetch) {
  const res = await fetchFn(`https://api.tiendanube.com/v1/${store.id}/store?fields=url_with_protocol`, {
    headers: { Authentication: `bearer ${store.token}`, 'User-Agent': UA },
  });
  if (!res.ok) return { url: '' };
  const json = await res.json();
  return { url: json.url_with_protocol || '' };
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const productName = (p) => p.name?.es || Object.values(p.name || {})[0] || '';

// "Sábado 24 de Octubre • Palermo • Mario Bravo 1029" -> { date: '2026-10-24', title, place }
export function parseProductName(name, refDate) {
  const [dayPart, ...rest] = name.split('•').map((s) => s.trim());
  const m = norm(dayPart).match(/(\d{1,2})\s+de\s+([a-z]+)/);
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return { date: null, title: name, place: '' };
  const day = Number(m[1]);
  const weekday = DAYS.findIndex((d) => norm(dayPart).startsWith(d));
  const ref = new Date(refDate || Date.now());
  // El nombre no trae año: probamos el año de referencia y el siguiente, priorizando el que coincide con el día de semana
  const candidates = [ref.getUTCFullYear(), ref.getUTCFullYear() + 1, ref.getUTCFullYear() - 1];
  let year = candidates.find((y) => weekday >= 0 && new Date(Date.UTC(y, month, day)).getUTCDay() === weekday);
  if (!year) year = month < ref.getUTCMonth() - 1 ? ref.getUTCFullYear() + 1 : ref.getUTCFullYear();
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, title: dayPart, place: rest.join(' • ') };
}

// Pagos que no cuentan como lugar ocupado (se muestran igual, marcados)
export const INACTIVE_PAYMENTS = ['voided', 'refunded', 'abandoned'];

const startMinutes = (time = '') => {
  const m = time.match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9999;
};

export async function fetchStoreRaw(store, fetchFn = fetch) {
  const [products, orders, info] = await Promise.all([
    tnGetAll(store, 'products', 'id,name,published,created_at,canonical_url,variants', fetchFn),
    tnGetAll(store, 'orders', 'id,number,status,payment_status,created_at,contact_name,contact_email,contact_phone,customer,products,note,total,currency,landing_url', fetchFn),
    tnGetStore(store, fetchFn),
  ]);
  return { products, orders, storeUrl: info.url };
}

export function buildTurnos(store, { products, orders }) {
  const slots = new Map();
  const getSlot = (productId, variantId, info) => {
    const key = `${productId}-${variantId}`;
    if (!slots.has(key)) slots.set(key, { key, productId, variantId, stockLeft: null, published: false, url: '', attendees: [], ...info });
    return slots.get(key);
  };

  for (const p of products) {
    const parsed = parseProductName(productName(p), p.created_at);
    if (!parsed.date) continue; // gift cards, etc.
    for (const v of p.variants || []) {
      const time = (v.values || []).map((x) => x.es || Object.values(x)[0]).join(' · ');
      const slot = getSlot(p.id, v.id, { ...parsed, time });
      slot.stockLeft = v.stock_management ? v.stock : null;
      slot.published = p.published;
      slot.url = p.canonical_url || '';
    }
  }

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const item of o.products || []) {
      const baseName = item.name_without_variants || item.name;
      const time = (item.variant_values || []).join(' · ');
      let slot = slots.get(`${item.product_id}-${item.variant_id}`);
      if (!slot) {
        const parsed = parseProductName(baseName, o.created_at);
        if (!parsed.date) continue; // gift cards, etc.: no son turnos
        slot = getSlot(item.product_id, item.variant_id, { ...parsed, time });
      }
      slot.attendees.push({
        orderId: o.id,
        number: o.number,
        name: o.contact_name || o.customer?.name || '',
        email: o.contact_email || o.customer?.email || '',
        phone: o.contact_phone || o.customer?.phone || '',
        qty: Number(item.quantity) || 1,
        // Orden de un solo ítem: total real (con cupones/descuentos); si no, precio × cantidad del ítem
        amount: o.products.length === 1 ? Number(o.total) : Number(item.price) * (Number(item.quantity) || 1),
        currency: o.currency || 'ARS',
        paymentStatus: o.payment_status,
        createdAt: o.created_at,
        note: o.note || '',
      });
    }
  }

  const list = [...slots.values()]
    .filter((s) => s.attendees.length || s.published)
    .map((s) => ({ ...s, booked: s.attendees.reduce((n, a) => (INACTIVE_PAYMENTS.includes(a.paymentStatus) ? n : n + a.qty), 0) }))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || startMinutes(a.time) - startMinutes(b.time) || a.place.localeCompare(b.place));

  return { store: { key: store.key, name: store.name }, slots: list, updatedAt: new Date().toISOString() };
}

// Caché por tienda de lo crudo de TN: turnos y pauta comparten la misma lectura
export function createStoreData({ fetchFn = fetch, ttlMs = CACHE_MS } = {}) {
  const cache = new Map();
  return async function getStoreData(store, fresh = false) {
    const hit = cache.get(store.key);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.data;
    const raw = await fetchStoreRaw(store, fetchFn);
    const data = { raw, turnos: buildTurnos(store, raw) };
    cache.set(store.key, { at: Date.now(), data });
    return data;
  };
}
