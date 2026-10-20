import { describe, expect, it } from 'vitest';
import { buildTurnos } from '../src/tiendanube.js';
import { buildShopContext, cameFromMeta } from '../src/pauta/shop.js';
import { summarizeRow, totals } from '../src/pauta/metrics.js';

const NOW = new Date('2026-10-20T15:00:00Z');
const store = { key: 'perritos', name: 'Yoga y Patitas' };

const product = (id, name, variants, published = true) => ({
  id, name: { es: name }, published, created_at: '2026-10-01T00:00:00Z', canonical_url: `https://tienda/p/${id}`,
  variants: variants.map(([vid, time, stock]) => ({ id: vid, values: [{ es: time }], stock_management: true, stock })),
});
const order = (id, created, items, { total = 34900, landing = '', payment = 'paid' } = {}) => ({
  id, number: id, status: 'open', payment_status: payment, created_at: created, total: String(total), currency: 'ARS', landing_url: landing,
  products: items.map(([productId, variantId, qty = 1]) => ({ product_id: productId, variant_id: variantId, quantity: qty, price: '34900', variant_values: [] })),
});

function raw() {
  return {
    storeUrl: 'https://tienda',
    products: [
      product(1, 'Sábado 24 de Octubre • Palermo • Mario Bravo 1029', [[11, '10:30–11:30', 14], [12, '11:45–12:45', 0]]),
      product(2, 'Sábado 17 de Octubre • Palermo • Mario Bravo 1029', [[21, '10:30–11:30', 0]], false),
      { id: 3, name: { es: 'Gift Card Cumpleaños' }, published: true, created_at: '2026-10-01T00:00:00Z', canonical_url: 'https://tienda/gift', variants: [{ id: 31, price: '34900', values: [] }] },
    ],
    orders: [
      order(100, '2026-10-19T14:00:00Z', [[1, 11, 2]], { total: 69800, landing: 'https://tienda/p/1?fbclid=abc' }),
      order(101, '2026-10-20T13:00:00Z', [[1, 12]]),
      order(102, '2026-10-20T13:30:00Z', [[1, 11]], { payment: 'pending' }),
      order(103, '2026-09-30T13:30:00Z', [[2, 21]]),
    ],
  };
}

describe('contexto de la tienda para el agente', () => {
  it('arma las próximas fechas con lugares libres y ocupación', () => {
    const r = raw();
    const shop = buildShopContext({ raw: r, turnos: buildTurnos(store, r) }, NOW);
    expect(shop.upcomingClasses).toHaveLength(1); // la del 17 ya pasó
    const c = shop.upcomingClasses[0];
    expect(c).toMatchObject({ date: '2026-10-24', place: 'Palermo • Mario Bravo 1029', daysUntil: 4, left: 14, url: 'https://tienda/p/1' });
    // reservas no anuladas: 2 + 1 + 1 (el pago pendiente ocupa lugar, como en el panel de turnos)
    expect(c.booked).toBe(4);
    expect(c.fillPct).toBe(22);
    expect(shop.otherProducts).toEqual([{ name: 'Gift Card Cumpleaños', price: 34900, url: 'https://tienda/gift' }]);
  });

  it('cuenta ventas pagadas y estima cuáles vinieron de Meta', () => {
    const r = raw();
    const shop = buildShopContext({ raw: r, turnos: buildTurnos(store, r) }, NOW);
    expect(shop.sales.last7d).toMatchObject({ orders: 2, tickets: 3, revenue: 104700, fromMetaOrders: 1, fromMetaRevenue: 69800 });
    expect(shop.sales.today.orders).toBe(1);
    expect(shop.sales.monthToDate.orders).toBe(2);
    expect(shop.sales.daily).toHaveLength(14);
  });

  it('reconoce clics de Meta por la URL de llegada', () => {
    expect(cameFromMeta({ landing_url: 'https://x/?fbclid=1' })).toBe(true);
    expect(cameFromMeta({ landing_url: 'https://x/?utm_source=instagram&utm_medium=paid' })).toBe(true);
    expect(cameFromMeta({ landing_url: 'https://x/?utm_source=google' })).toBe(false);
    expect(cameFromMeta({})).toBe(false);
  });
});

describe('métricas de Meta orientadas a ventas', () => {
  it('toma la compra una sola vez aunque venga con varios action_type', () => {
    const row = {
      spend: '10000', impressions: '5000', clicks: '100', ctr: '2', cpm: '2000',
      actions: [{ action_type: 'omni_purchase', value: '2' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }, { action_type: 'landing_page_view', value: '80' }],
      action_values: [{ action_type: 'omni_purchase', value: '69800' }],
    };
    expect(summarizeRow(row)).toMatchObject({ spend: 10000, purchases: 2, purchaseValue: 69800, costPerPurchase: 5000, roas: 6.98, landingViews: 80 });
    expect(totals([row, row])).toMatchObject({ spend: 20000, purchases: 4, costPerPurchase: 5000, roas: 6.98 });
  });

  it('sin compras no inventa costo por compra', () => {
    expect(summarizeRow({ spend: '500' })).toMatchObject({ purchases: 0, costPerPurchase: null, roas: 0 });
    expect(totals([])).toMatchObject({ spend: 0, costPerPurchase: null, roas: null });
  });
});

describe('cliente de Meta', () => {
  it('normaliza el id de la cuenta publicitaria', async () => {
    const { normalizeAccountId } = await import('../src/pauta/meta.js');
    expect(normalizeAccountId('123')).toBe('act_123');
    expect(normalizeAccountId('act_123')).toBe('act_123');
    expect(normalizeAccountId('')).toBe('');
  });
});

describe('reporte', () => {
  it('compara contra el período anterior de la misma duración', async () => {
    const { previousRange } = await import('../src/pauta/report.js');
    expect(previousRange('2026-10-14', '2026-10-20')).toEqual({ since: '2026-10-07', until: '2026-10-13' });
    expect(previousRange('2026-10-01', '2026-10-31')).toEqual({ since: '2026-08-31', until: '2026-09-30' });
  });

  it('suma las ventas de la tienda día por día, incluidos los días sin ventas', async () => {
    const { buildShopReport } = await import('../src/pauta/report.js');
    const r = buildShopReport(raw(), '2026-10-18', '2026-10-20');
    expect(r.daily.map((d) => [d.date, d.orders, d.fromMeta])).toEqual([['2026-10-18', 0, 0], ['2026-10-19', 1, 1], ['2026-10-20', 1, 0]]);
    expect(r.totals).toMatchObject({ orders: 2, tickets: 3, revenue: 104700, fromMetaOrders: 1 });
    expect(r.previousTotals.orders).toBe(0);
  });
});
