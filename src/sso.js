import crypto from 'node:crypto';

// Sesión que firma el panel del bot (BOT-YOGA, Hub → Agente) para entrar sin segundo login:
// `sso.<nombre base64url>.<vence ms>.<firma>` con HMAC-SHA256 y PANEL_SSO_SECRET.
// Si cambia el formato, cambiar también BOT-YOGA/server/src/services/agenteSso.js.
// El usuario del bot es admin y ve todas las tiendas.
export function readSsoToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || !token.startsWith('sso.')) return null;
  const i = token.lastIndexOf('.');
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  const [, name, exp] = payload.split('.');
  if (!(Number(exp) > now)) return null;
  return { name: Buffer.from(name, 'base64url').toString(), stores: ['*'], sso: true };
}
