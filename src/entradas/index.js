import crypto from 'node:crypto';
import express from 'express';
import { HttpError, badRequest, notFound } from '../errors.js';
import { parseProductName, tnGetStore } from '../tiendanube.js';
import { createTnClient } from './tn.js';
import { renderMail } from './mail.js';

// Entradas por mail: cada orden pagada desde `since` recibe un mail (entrada de la clase y/o códigos de gift card)
// y después se marca como enviada digitalmente en Tienda Nube.
const MAX_ATTEMPTS = 5;
const LOOKBACK_MS = 30 * 864e5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I, que se confunden al tipearlo

const isGift = (name) => /gift/i.test(name);

// Separa lo que trae la orden: clases (productos con fecha), gift cards y lo demás (festejos de cumple, etc.)
export function classifyOrder(order) {
  const classes = [];
  const gifts = [];
  const others = [];
  // Lo que pagó de verdad: si hubo cupón o descuento, se reparte en proporción entre los productos
  const subtotal = Number(order.subtotal) || 0;
  const factor = subtotal > 0 ? Math.min(1, (Number(order.total) || 0) / subtotal) : 1;
  for (const item of order.products || []) {
    const name = item.name_without_variants || item.name || '';
    const qty = Number(item.quantity) || 1;
    if (isGift(name)) {
      gifts.push({ name, qty, unitValue: Math.round(Number(item.price) * factor) });
      continue;
    }
    const parsed = parseProductName(name, order.created_at);
    if (parsed.date) classes.push({ title: parsed.title, place: parsed.place, date: parsed.date, time: (item.variant_values || []).join(' · '), qty });
    else others.push({ name, qty });
  }
  return { classes, gifts, others };
}

export function couponCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(8);
  return `GIFT${[...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('')}`;
}

// Un cupón por cada gift card comprada (2 gift cards = 2 códigos, se pueden regalar por separado)
function makeCoupons(gifts, now, validityDays) {
  const endDate = new Date(now.getTime() + validityDays * 864e5).toISOString().slice(0, 10);
  return gifts.flatMap((g) => Array.from({ length: g.qty }, () => ({ code: couponCode(), value: g.unitValue, label: g.name, endDate, created: false })));
}

const alreadyDelivered = (order) => Boolean(order.fulfillments?.length) && order.fulfillments.every((f) => f.status === 'DELIVERED');

export function createEntradas({ db, stores, mailerFor, since, giftValidityDays = 365, hidePlace = false, tnFor = (store) => createTnClient(store), storeInfo = tnGetStore, now = () => new Date(), log = console }) {
  const all = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const update = (id, patch) => {
    const cols = Object.keys(patch);
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    return one(`UPDATE entradas SET ${set}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => (['classes', 'gifts', 'coupons'].includes(c) ? JSON.stringify(patch[c]) : patch[c]))]);
  };

  const urls = new Map();
  async function storeUrl(store) {
    if (!urls.has(store.key)) urls.set(store.key, (await storeInfo(store).catch(() => ({ url: '' }))).url);
    return urls.get(store.key);
  }

  // La fila se crea una sola vez por orden (UNIQUE): es lo que impide mandar dos veces
  async function claim(store, order) {
    const { classes, gifts, others } = classifyOrder(order);
    const skipped = !classes.length && !gifts.length;
    const inserted = await one(
      `INSERT INTO entradas (store_key, order_id, order_number, name, email, classes, gifts, status, error, order_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (store_key, order_id) DO NOTHING RETURNING *`,
      [
        store.key, order.id, String(order.number ?? ''), order.contact_name || order.customer?.name || '', order.contact_email || order.customer?.email || '',
        JSON.stringify(classes), JSON.stringify(gifts), skipped ? 'skipped' : 'pending', skipped ? 'No tiene clases ni gift cards' : null, order.created_at || null,
      ],
    );
    const row = inserted || (await one('SELECT * FROM entradas WHERE store_key = $1 AND order_id = $2', [store.key, order.id]));
    return { row, others };
  }

  // Un reintento (automático o del botón) sigue desde el último paso que salió bien
  const busy = new Set();
  async function processOrder(store, order, { manual = false, resend = false, email } = {}) {
    const lock = `${store.key}:${order.id}`;
    if (busy.has(lock)) throw new HttpError(409, 'Esa orden se está procesando, probá en un momento');
    busy.add(lock);
    try {
      let { row, others } = await claim(store, order);
      if (row.status === 'skipped') return row;
      if (row.status === 'sent' && !resend) return row;
      if (row.status === 'failed' && row.attempts >= MAX_ATTEMPTS && !manual) return row;

      const tn = tnFor(store);
      const mailer = mailerFor(store.key);
      try {
        if (!mailer) throw new Error(`Falta configurar el mail de ${store.name} (MAIL_${store.key.toUpperCase()})`);
        const to = email || row.email;
        if (!to) throw new Error('La orden no tiene mail');

        if (row.gifts.length && !row.coupons.length) row = await update(row.id, { coupons: makeCoupons(row.gifts, now(), giftValidityDays) });
        for (const c of row.coupons.filter((x) => !x.created)) {
          try {
            await tn.createCoupon({
              code: c.code, type: 'absolute', value: c.value.toFixed(2), max_uses: 1,
              start_date: now().toISOString().slice(0, 10), end_date: c.endDate,
              combines_with_other_discounts: false, includes_shipping: false,
            });
          } catch (err) {
            // Si ya existe es porque lo creamos en un intento anterior que se cortó antes de guardarlo
            if (!(err.status === 422 && /code/i.test(err.message))) throw err;
          }
          c.created = true;
          row = await update(row.id, { coupons: row.coupons });
        }

        if (!row.mail_sent_at || resend) {
          const msg = renderMail({ name: store.name, url: await storeUrl(store) }, { name: row.name, orderNumber: row.order_number, classes: row.classes, coupons: row.coupons }, { hidePlace });
          await mailer.send({ to, ...msg });
          row = await update(row.id, { mail_sent_at: now(), email: to });
        }

        // Si trae algo que no es clase ni gift card (un festejo, por ejemplo) la orden no se da por enviada
        if (others.length) {
          return await update(row.id, { status: 'sent', error: `No se marcó como enviada: también tiene ${others.map((o) => o.name).join(', ')}` });
        }
        if (!row.delivered_at) {
          await tn.markDelivered(order.id);
          row = await update(row.id, { delivered_at: now() });
        }
        return await update(row.id, { status: 'sent', error: null });
      } catch (err) {
        log.error(`[entradas:${store.key}] orden #${order.number}:`, err.message);
        return await update(row.id, { status: 'failed', attempts: row.attempts + 1, error: err.message.slice(0, 500) });
      }
    } finally {
      busy.delete(lock);
    }
  }

  // Corrida del cron: todas las tiendas con mail configurado, una detrás de otra
  let running = false;
  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const from = new Date(Math.max(new Date(since).getTime(), now().getTime() - LOOKBACK_MS)).toISOString();
      for (const store of stores) {
        if (!mailerFor(store.key)) continue;
        try {
          const done = new Set(
            (await all(`SELECT order_id FROM entradas WHERE store_key = $1 AND (status IN ('sent','skipped') OR attempts >= $2)`, [store.key, MAX_ATTEMPTS]))
              .map((r) => String(r.order_id)),
          );
          const known = new Set((await all('SELECT order_id FROM entradas WHERE store_key = $1', [store.key])).map((r) => String(r.order_id)));
          const orders = await tnFor(store).paidOrdersSince(from);
          for (const o of orders) {
            if (o.status === 'cancelled' || done.has(String(o.id))) continue;
            // Ya la marcaron a mano en Tienda Nube: no se toca
            if (!known.has(String(o.id)) && alreadyDelivered(o)) continue;
            await processOrder(store, o);
          }
        } catch (err) {
          log.error(`[entradas:${store.key}] no se pudo revisar las órdenes:`, err.message);
        }
      }
    } finally {
      running = false;
    }
  }

  const router = express.Router({ mergeParams: true });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const rowFor = async (req) => {
    if (!UUID.test(req.params.id)) throw badRequest('Id inválido');
    const row = await one('SELECT * FROM entradas WHERE store_key = $1 AND id = $2', [req.store.key, req.params.id]);
    if (!row) throw notFound('No existe ese envío');
    return row;
  };
  router.get('/', wrap(async (req, res) => {
    res.json({
      since,
      configured: Boolean(mailerFor(req.store.key)),
      items: await all('SELECT * FROM entradas WHERE store_key = $1 ORDER BY created_at DESC LIMIT 200', [req.store.key]),
    });
  }));
  router.post('/:id/retry', wrap(async (req, res) => {
    const row = await rowFor(req);
    res.json(await processOrder(req.store, await tnFor(req.store).getOrder(row.order_id), { manual: true }));
  }));
  // Reenviar el mail, opcionalmente a otra dirección (si el cliente puso mal la suya)
  router.post('/:id/resend', wrap(async (req, res) => {
    const row = await rowFor(req);
    const email = req.body?.email ? String(req.body.email).trim() : undefined;
    if (email && !EMAIL.test(email)) throw badRequest('Ese mail no parece válido');
    if (row.status === 'skipped') throw badRequest('Esa orden no tiene clases ni gift cards');
    res.json(await processOrder(req.store, await tnFor(req.store).getOrder(row.order_id), { manual: true, resend: true, email }));
  }));

  return { runOnce, processOrder, router };
}

export function entradasErrorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('[entradas]', err);
  res.status(500).json({ error: err.message?.startsWith('Tienda Nube') ? 'No se pudo leer la orden en Tienda Nube' : 'Error inesperado' });
}
