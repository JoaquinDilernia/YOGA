import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db.js';
import { classifyOrder, couponCode, createEntradas, entradasErrorHandler } from '../src/entradas/index.js';
import { renderMail } from '../src/entradas/mail.js';

const NOW = new Date('2026-10-29T15:00:00Z');
const SINCE = '2026-10-29T00:00:00.000Z';
const STORES = [{ key: 'perritos', name: 'Yoga y Patitas', id: '1', token: 't' }, { key: 'gatitos', name: 'Yoga y Gatitos', id: '2', token: 't' }];

const line = (name, { qty = 1, price = '34900.00', time } = {}) => ({
  name, name_without_variants: name, quantity: qty, price, variant_values: time ? [time] : [],
});
const order = (id, products, extra = {}) => ({
  id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-10-29T12:00:00+0000',
  contact_name: 'Agustina Spaini', contact_email: 'agus@example.com', subtotal: '34900.00', total: '34900.00',
  fulfillments: [{ status: 'UNPACKED' }], products, ...extra,
});
const CLASS = 'Sábado 7 de Noviembre • Palermo • Mario Bravo 1029';

// Tienda Nube falsa: órdenes por tienda y registro de lo que se le pide
function fakeTn(ordersByStore, calls, { failDeliver = false, failCoupon = null } = {}) {
  return (store) => ({
    paidOrdersSince: async (since) => {
      calls.push({ store: store.key, op: 'list', since });
      return ordersByStore[store.key] || [];
    },
    getOrder: async (id) => (ordersByStore[store.key] || []).find((o) => String(o.id) === String(id)),
    createCoupon: async (c) => {
      calls.push({ store: store.key, op: 'coupon', coupon: c });
      if (failCoupon) throw failCoupon;
    },
    markDelivered: async (id) => {
      calls.push({ store: store.key, op: 'deliver', id });
      if (failDeliver) throw new Error('Tienda Nube PATCH 403: sin permiso');
    },
  });
}

describe('qué trae cada orden', () => {
  it('separa clases, gift cards y otros productos', () => {
    const o = order(1, [
      line(CLASS, { qty: 2, time: '10:30–11:30' }),
      line('Gift Card Cumpleaños'),
      line('Festejá tu Cumple'),
    ]);
    expect(classifyOrder(o)).toEqual({
      classes: [{ title: 'Sábado 7 de Noviembre', place: 'Palermo • Mario Bravo 1029', date: '2026-11-07', time: '10:30–11:30', qty: 2 }],
      gifts: [{ name: 'Gift Card Cumpleaños', qty: 1, unitValue: 34900 }],
      others: [{ name: 'Festejá tu Cumple', qty: 1 }],
    });
  });

  it('la gift card vale lo que se pagó: los descuentos se reparten', () => {
    const o = order(1, [line('Gift Card Día de la Madre', { qty: 2 })], { subtotal: '69800.00', total: '62820.00' });
    expect(classifyOrder(o).gifts[0].unitValue).toBe(31410);
  });

  it('los códigos son alfanuméricos y sin caracteres confusos', () => {
    const code = couponCode();
    expect(code).toMatch(/^GIFT[A-HJ-NP-Z2-9]{8}$/);
    expect(couponCode()).not.toBe(code);
  });
});

describe('el mail', () => {
  it('trae los datos de la clase', () => {
    const mail = renderMail({ name: 'Yoga y Patitas', url: 'https://yogaypatitas.com' }, {
      name: 'Agustina Spaini', orderNumber: '123',
      classes: [{ title: 'Sábado 7 de Noviembre', place: 'Palermo • Mario Bravo 1029', time: '10:30–11:30', qty: 2 }], coupons: [],
    });
    expect(mail.subject).toBe('Tu entrada para Yoga y Patitas · Sábado 7 de Noviembre');
    expect(mail.text).toContain('¡Hola Agustina!');
    expect(mail.text).toContain('Horario: 10:30–11:30');
    expect(mail.text).toContain('Entradas: 2');
    expect(mail.html).toContain('Mario Bravo 1029');
    expect(mail.text).not.toContain('gift');

    const sinLugar = renderMail({ name: 'Yoga y Patitas', url: '' }, {
      name: 'Agustina', orderNumber: '123', classes: [{ title: 'Sábado 7 de Noviembre', place: 'Palermo • Mario Bravo 1029', time: '10:30–11:30', qty: 1 }], coupons: [],
    }, { hidePlace: true });
    expect(sinLugar.text).not.toContain('Mario Bravo');
    expect(sinLugar.html).not.toContain('Lugar');
  });

  it('gift card: código, valor, vencimiento y cómo usarlo', () => {
    const mail = renderMail({ name: 'Yoga y Gatitos', url: 'https://yogaygatitos.mitiendanube.com' }, {
      name: '<b>Pepa</b>', orderNumber: '9', classes: [],
      coupons: [{ code: 'GIFTABCD2345', value: 34900, label: 'Gift Card Cumpleaños', endDate: '2027-10-29' }],
    });
    expect(mail.subject).toBe('Tu gift card de Yoga y Gatitos');
    expect(mail.text).toContain('GIFTABCD2345');
    expect(mail.text).toContain('válido hasta el 29 de octubre de 2027');
    expect(mail.text).toContain('yogaygatitos.mitiendanube.com');
    expect(mail.html).not.toContain('<b>Pepa</b>'); // lo que escribe el cliente va escapado
  });
});

describe('envío automático', () => {
  let db;
  let calls;
  let sent;
  const mailer = { send: async (m) => sent.push(m) };

  beforeEach(async () => {
    db = new PGlite();
    await migrate(db);
    calls = [];
    sent = [];
  });

  const setup = (orders, opts = {}) =>
    createEntradas({
      db, stores: STORES, since: SINCE, now: () => NOW,
      mailerFor: opts.mailerFor || ((key) => (key === 'perritos' ? mailer : null)),
      tnFor: fakeTn(orders, calls, opts),
      storeInfo: async () => ({ url: 'https://yogaypatitas.com' }),
      log: { error: () => {} },
    });

  it('manda la entrada, marca la orden como enviada y no repite en la próxima vuelta', async () => {
    const e = setup({ perritos: [order(10, [line(CLASS, { time: '10:30–11:30' })])] });
    await e.runOnce();
    await e.runOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('agus@example.com');
    expect(calls.filter((c) => c.op === 'deliver')).toEqual([{ store: 'perritos', op: 'deliver', id: 10 }]);
    const { rows } = await db.query('SELECT * FROM entradas');
    expect(rows[0]).toMatchObject({ status: 'sent', error: null });
    expect(rows[0].delivered_at).not.toBeNull();
    // la tienda sin mail configurado no se toca
    expect(calls.some((c) => c.store === 'gatitos')).toBe(false);
  });

  it('gift card: crea un cupón de un solo uso por unidad y manda los códigos', async () => {
    const e = setup({ perritos: [order(11, [line('Gift Card Cumpleaños', { qty: 2 })], { subtotal: '69800.00', total: '69800.00' })] });
    await e.runOnce();
    const coupons = calls.filter((c) => c.op === 'coupon').map((c) => c.coupon);
    expect(coupons).toHaveLength(2);
    expect(coupons[0]).toMatchObject({ type: 'absolute', value: '34900.00', max_uses: 1, start_date: '2026-10-29', end_date: '2027-10-29', combines_with_other_discounts: false });
    expect(coupons[0].code).not.toBe(coupons[1].code);
    expect(sent[0].text).toContain(coupons[0].code);
    expect(sent[0].text).toContain(coupons[1].code);
    expect(calls.some((c) => c.op === 'deliver')).toBe(true);
  });

  it('no toca órdenes que ya marcaron a mano ni las que no traen clases ni gift cards', async () => {
    const e = setup({
      perritos: [
        order(12, [line(CLASS)], { fulfillments: [{ status: 'DELIVERED' }] }),
        order(13, [line('Festejá tu Cumple')]),
        order(14, [line(CLASS)], { status: 'cancelled' }),
      ],
    });
    await e.runOnce();
    expect(sent).toHaveLength(0);
    expect(calls.some((c) => c.op === 'deliver')).toBe(false);
    const { rows } = await db.query('SELECT order_id, status FROM entradas');
    expect(rows.map((r) => [String(r.order_id), r.status])).toEqual([['13', 'skipped']]);
  });

  it('si trae una clase y un festejo, manda la entrada pero no la marca como enviada', async () => {
    const e = setup({ perritos: [order(15, [line(CLASS), line('Festejá tu Cumple')])] });
    await e.runOnce();
    expect(sent).toHaveLength(1);
    expect(calls.some((c) => c.op === 'deliver')).toBe(false);
    const { rows } = await db.query('SELECT status, error FROM entradas');
    expect(rows[0].status).toBe('sent');
    expect(rows[0].error).toContain('Festejá tu Cumple');
  });

  it('si falla marcarla en TN, el reintento no vuelve a mandar el mail', async () => {
    const orders = { perritos: [order(16, [line(CLASS)])] };
    const failing = setup(orders, { failDeliver: true });
    await failing.runOnce();
    let { rows } = await db.query('SELECT status, attempts, error, mail_sent_at FROM entradas');
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(rows[0].error).toContain('403');
    expect(rows[0].mail_sent_at).not.toBeNull();

    await setup(orders).runOnce();
    ({ rows } = await db.query('SELECT status, attempts FROM entradas'));
    expect(rows[0].status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'deliver')).toHaveLength(2);
  });

  it('un cupón que ya existía (intento cortado) no frena el envío', async () => {
    const err = Object.assign(new Error('Tienda Nube POST /coupons 422: {"code":["has already been taken"]}'), { status: 422 });
    const e = setup({ perritos: [order(17, [line('Gift Card Cumpleaños')])] }, { failCoupon: err });
    await e.runOnce();
    const { rows } = await db.query('SELECT status, coupons FROM entradas');
    expect(rows[0].status).toBe('sent');
    expect(rows[0].coupons[0].created).toBe(true);
  });

  it('deja de reintentar solo después de 5 fallas; el botón reintenta igual', async () => {
    const orders = { perritos: [order(18, [line(CLASS)])] };
    const e = setup(orders, { mailerFor: (key) => (key === 'perritos' ? { send: async () => { throw new Error('SMTP 535 auth failed'); } } : null) });
    for (let i = 0; i < 7; i++) await e.runOnce();
    const { rows } = await db.query('SELECT status, attempts FROM entradas');
    expect(rows[0]).toEqual({ status: 'failed', attempts: 5 });
    const retried = await e.processOrder(STORES[0], orders.perritos[0], { manual: true });
    expect(retried.attempts).toBe(6);
  });

  describe('panel', () => {
    const app = (e, store = STORES[0]) => {
      const a = express();
      a.use(express.json());
      a.use('/api/entradas/:store', (req, _res, next) => {
        req.store = store;
        next();
      }, e.router, entradasErrorHandler);
      return a;
    };

    it('lista los envíos y reenvía a otro mail', async () => {
      const e = setup({ perritos: [order(19, [line(CLASS)])] });
      await e.runOnce();
      const list = await request(app(e)).get('/api/entradas/perritos');
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ since: SINCE, configured: true });
      expect(list.body.items).toHaveLength(1);

      const id = list.body.items[0].id;
      expect((await request(app(e)).post(`/api/entradas/perritos/${id}/resend`).send({ email: 'nada' })).status).toBe(400);
      const res = await request(app(e)).post(`/api/entradas/perritos/${id}/resend`).send({ email: 'otra@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('otra@example.com');
      expect(sent.map((m) => m.to)).toEqual(['agus@example.com', 'otra@example.com']);
      // la orden ya estaba marcada: no se vuelve a pedir
      expect(calls.filter((c) => c.op === 'deliver')).toHaveLength(1);
    });

    it('no deja ver envíos de otra tienda', async () => {
      const e = setup({ perritos: [order(20, [line(CLASS)])] });
      await e.runOnce();
      const { rows } = await db.query('SELECT id FROM entradas');
      const res = await request(app(e, STORES[1])).post(`/api/entradas/gatitos/${rows[0].id}/retry`);
      expect(res.status).toBe(404);
    });
  });
});
