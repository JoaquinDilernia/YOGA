// Mails de entrada (clases) y de gift card. Un solo mail por orden: si trae las dos cosas, van las dos secciones.
// HTML con estilos en línea (los clientes de mail ignoran <style>) y versión en texto plano.
const ACCENT = '#6b8f6f';
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';
// '2027-10-29' -> '29 de octubre de 2027'
const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} de ${MONTHS[m - 1]} de ${y}`;
};

const row = (label, value) =>
  `<tr><td style="padding:6px 0;color:#7a756d;font-size:14px;width:110px;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;font-size:15px;color:#2b2a28"><strong>${esc(value)}</strong></td></tr>`;

const box = (inner) =>
  `<div style="border:1px solid #ebe6de;border-radius:12px;padding:16px 20px;margin:16px 0;background:#fbfaf7">${inner}</div>`;

function classBlock(c) {
  const rows = [row('Clase', c.title), c.time && row('Horario', c.time), c.place && row('Lugar', c.place), row('Entradas', String(c.qty))].filter(Boolean);
  return box(`<table role="presentation" style="border-collapse:collapse;width:100%">${rows.join('')}</table>`);
}

function couponBlock(c) {
  return box(
    `<div style="font-size:13px;color:#7a756d;margin-bottom:6px">${esc(c.label)} · ${esc(money(c.value))}</div>` +
      `<div style="font-family:Consolas,Menlo,monospace;font-size:24px;letter-spacing:3px;color:${ACCENT};font-weight:bold">${esc(c.code)}</div>` +
      `<div style="font-size:13px;color:#7a756d;margin-top:6px">Válido hasta el ${esc(longDate(c.endDate))} · un solo uso</div>`,
  );
}

const classText = (c) => [`- ${c.title}`, c.time && `  Horario: ${c.time}`, c.place && `  Lugar: ${c.place}`, `  Entradas: ${c.qty}`].filter(Boolean).join('\n');

// entry: { name, orderNumber, classes: [{ title, time, place, qty }], coupons: [{ code, value, label, endDate }] }
// store: { name, url } · hidePlace: sin la dirección (cuando la sede está a confirmar)
export function renderMail(store, entry, { hidePlace = false } = {}) {
  if (hidePlace) entry = { ...entry, classes: entry.classes.map((c) => ({ ...c, place: '' })) };
  const hasClasses = entry.classes.length > 0;
  const hasGifts = entry.coupons.length > 0;
  const hi = firstName(entry.name);

  const subject = hasClasses
    ? `Tu entrada para ${store.name}${entry.classes.length === 1 ? ` · ${entry.classes[0].title}` : ''}`
    : `Tu gift card de ${store.name}`;

  const html = [];
  const text = [];
  html.push(`<p style="font-size:18px;margin:0 0 8px">¡Hola${hi ? ` ${esc(hi)}` : ''}!</p>`);
  text.push(`¡Hola${hi ? ` ${hi}` : ''}!`, '');

  if (hasClasses) {
    html.push('<p style="margin:0 0 4px">Gracias por tu compra, ya tenés tu lugar. Esta es tu entrada:</p>');
    html.push(...entry.classes.map(classBlock));
    html.push(
      '<p style="margin:0 0 6px"><strong>Antes de venir</strong></p>' +
        '<ul style="margin:0 0 16px;padding-left:20px;color:#2b2a28">' +
        '<li>Te recomendamos llegar 10 minutos antes para arrancar puntuales.</li>' +
        '<li>Vení con ropa cómoda.</li>' +
        '<li>Al llegar, mostrá este mail o decí tu nombre.</li>' +
        '</ul>',
    );
    text.push('Gracias por tu compra, ya tenés tu lugar. Esta es tu entrada:', '', ...entry.classes.map(classText), '');
    text.push('Antes de venir:', '- Te recomendamos llegar 10 minutos antes para arrancar puntuales.', '- Vení con ropa cómoda.', '- Al llegar, mostrá este mail o decí tu nombre.', '');
  }

  if (hasGifts) {
    const one = entry.coupons.length === 1;
    html.push(`<p style="margin:${hasClasses ? '8px' : '0'} 0 4px">${hasClasses ? 'Y acá' : 'Gracias por tu compra. Acá'} ${one ? 'está el código de tu gift card' : 'están los códigos de tus gift cards'} para regalar:</p>`);
    html.push(...entry.coupons.map(couponBlock));
    html.push(
      '<p style="margin:0 0 6px"><strong>Cómo se usa</strong></p>' +
        '<ol style="margin:0 0 16px;padding-left:20px;color:#2b2a28">' +
        `<li>Entrar a ${store.url ? `<a href="${esc(store.url)}" style="color:${ACCENT}">${esc(store.url.replace(/^https?:\/\//, ''))}</a>` : 'la tienda'} y elegir fecha y horario.</li>` +
        '<li>En el carrito, cargar el código en "Cupón de descuento".</li>' +
        '</ol>',
    );
    text.push(`${one ? 'Código de tu gift card' : 'Códigos de tus gift cards'} para regalar:`, '');
    for (const c of entry.coupons) text.push(`- ${c.code} · ${c.label} · ${money(c.value)} · válido hasta el ${longDate(c.endDate)}, un solo uso`);
    text.push('', 'Cómo se usa:', `1. Entrar a ${store.url || 'la tienda'} y elegir fecha y horario.`, '2. En el carrito, cargar el código en "Cupón de descuento".', '');
  }

  html.push('<p style="margin:0 0 4px">Si tenés alguna consulta, respondé este mail.</p>');
  html.push(`<p style="margin:0">¡Nos vemos!<br><strong>${esc(store.name)}</strong></p>`);
  html.push(`<p style="font-size:12px;color:#a39d93;margin-top:24px">Orden #${esc(entry.orderNumber)}</p>`);
  text.push('Si tenés alguna consulta, respondé este mail.', '', '¡Nos vemos!', store.name, '', `Orden #${entry.orderNumber}`);

  const body =
    '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f7f4ef;font-family:Helvetica,Arial,sans-serif;color:#2b2a28;line-height:1.5">' +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:18px;padding:28px 24px;border-top:6px solid ${ACCENT}">` +
    html.join('\n') +
    '</div></body></html>';

  return { subject, html: body, text: text.join('\n') };
}
