import { describe, expect, it } from 'vitest';
import { createMailer } from '../src/entradas/mailer.js';

const msg = { to: 'cliente@mail.com', subject: 'Tu entrada', html: '<p>hola</p>', text: 'hola' };

describe('createMailer con Resend', () => {
  it('manda por la API de Resend con el remitente de la tienda', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ id: 'x' }) }; };
    const mailer = createMailer({ user: 'hola@yogaypatitas.com.ar', bcc: 'copia@mail.com' }, 'Yoga y Patitas', { resendKey: 're_123', fetchFn });
    await mailer.send(msg);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer re_123');
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      from: 'Yoga y Patitas <hola@yogaypatitas.com.ar>', to: ['cliente@mail.com'], bcc: ['copia@mail.com'], subject: 'Tu entrada', html: '<p>hola</p>', text: 'hola',
    });
  });

  it('si Resend rechaza, el error dice por qué (queda en el panel de Envíos)', async () => {
    const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({ message: 'The yogaypatitas.com.ar domain is not verified' }) });
    const mailer = createMailer({ user: 'hola@yogaypatitas.com.ar' }, 'Yoga y Patitas', { resendKey: 're_123', fetchFn });
    await expect(mailer.send(msg)).rejects.toThrow('Resend 403: The yogaypatitas.com.ar domain is not verified');
  });
});
