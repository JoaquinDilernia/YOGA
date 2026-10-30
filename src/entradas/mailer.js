import nodemailer from 'nodemailer';

// Mail uno para todas las tiendas o uno por tienda:
// MAIL='{"user":"hola@yogaypatitas.com.ar","pass":"..."}' o MAIL_PERRITOS=... · opcionales: host, port, name (remitente), bcc (copia de cada envío)
// Con RESEND_API_KEY (o "resendKey" en el JSON) sale por la API de Resend (HTTPS): Railway bloquea el SMTP
// saliente fuera del plan Pro. El dominio del remitente (user) tiene que estar verificado en Resend.
// Sin clave de Resend sale por SMTP (Hostinger por defecto) y hace falta "pass".
export function createMailer(config, storeName, { resendKey = process.env.RESEND_API_KEY, fetchFn = fetch } = {}) {
  const key = config.resendKey || resendKey;
  if (key) return createResendMailer({ ...config, key }, storeName, fetchFn);
  const { user, pass, host = 'smtp.hostinger.com', port = 465, name = storeName, bcc } = config;
  const transport = nodemailer.createTransport({ host, port: Number(port), secure: Number(port) === 465, auth: { user, pass } });
  return {
    send: ({ to, subject, html, text }) => transport.sendMail({ from: { name, address: user }, to, bcc, subject, html, text }),
    verify: () => transport.verify(),
  };
}

function createResendMailer({ user, key, name = '', bcc }, storeName, fetchFn) {
  const from = `${(name || storeName).replace(/[<>"]/g, '')} <${user}>`;
  return {
    async send({ to, subject, html, text }) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], ...(bcc ? { bcc: [bcc] } : {}), subject, html, text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(`Resend ${res.status}: ${data.message || data.name || 'no se pudo mandar el mail'}`);
      }
      return res.json();
    },
    verify: async () => true,
  };
}
