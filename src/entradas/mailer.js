import nodemailer from 'nodemailer';

// Mail por SMTP (Hostinger por defecto), uno para todas las tiendas o uno por tienda:
// MAIL='{"user":"hola@yogaypatitas.com.ar","pass":"..."}' o MAIL_PERRITOS=... · opcionales: host, port, name (remitente), bcc (copia de cada envío)
export function createMailer(config, storeName) {
  const { user, pass, host = 'smtp.hostinger.com', port = 465, name = storeName, bcc } = config;
  const transport = nodemailer.createTransport({ host, port: Number(port), secure: Number(port) === 465, auth: { user, pass } });
  return {
    send: ({ to, subject, html, text }) => transport.sendMail({ from: { name, address: user }, to, bcc, subject, html, text }),
    verify: () => transport.verify(),
  };
}
