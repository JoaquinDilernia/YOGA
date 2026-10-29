// Lo que las entradas le piden a Tienda Nube: órdenes pagadas, cupones para las gift cards y marcar la orden como enviada
const UA = 'Turnos Panel (jdilernia99@gmail.com)';

export class TnError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createTnClient(store, fetchFn = fetch) {
  async function call(method, path, body) {
    const res = await fetchFn(`https://api.tiendanube.com/v1/${store.id}${path}`, {
      method,
      headers: {
        Authentication: `bearer ${store.token}`,
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const textBody = await res.text();
    if (!res.ok) throw new TnError(res.status, `Tienda Nube ${method} ${path.split('?')[0]} ${res.status}: ${textBody.slice(0, 300)}`);
    return textBody ? JSON.parse(textBody) : null;
  }

  return {
    // Órdenes pagadas creadas desde `since` (ISO), todas las páginas
    async paidOrdersSince(since) {
      const out = [];
      for (let page = 1; page < 50; page++) {
        let items;
        try {
          items = await call('GET', `/orders?payment_status=paid&created_at_min=${encodeURIComponent(since)}&per_page=200&page=${page}`);
        } catch (err) {
          if (err.status === 404) break; // TN responde 404 pasada la última página (o si no hay ninguna)
          throw err;
        }
        out.push(...items);
        if (items.length < 200) break;
      }
      return out;
    },
    getOrder: (id) => call('GET', `/orders/${id}`),
    createCoupon: (coupon) => call('POST', '/coupons', coupon),
    // "Enviado digitalmente" en el admin = la orden de despacho en DELIVERED. Sin tracking_info no se avisa al cliente.
    async markDelivered(orderId) {
      const fos = await call('GET', `/orders/${orderId}/fulfillment-orders`);
      for (const fo of fos || []) {
        if (fo.status !== 'DELIVERED') await call('PATCH', `/orders/${orderId}/fulfillment-orders/${fo.id}`, { status: 'DELIVERED' });
      }
    },
  };
}
