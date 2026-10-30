import crypto from 'node:crypto';

// Sesión que firma el panel del bot (BOT-YOGA, Hub → Agente) para entrar sin segundo login:
// `sso.<nombre base64url>.<vence ms>.<firma>` con HMAC-SHA256 y PANEL_SSO_SECRET.
// Si cambia el formato, cambiar también BOT-YOGA/server/src/services/agenteSso.js.
// Tiendas: las del usuario de USERS con el mismo nombre (ej. Francisco → solo gatitos);
// si no hay ninguno con ese nombre, todas (solo los admins del panel del bot reciben token).
export function readSsoToken(token, secret, now = Date.now(), users = []) {
  if (!secret || typeof token !== 'string' || !token.startsWith('sso.')) return null;
  const i = token.lastIndexOf('.');
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  const [, encoded, exp] = payload.split('.');
  if (!(Number(exp) > now)) return null;
  const name = Buffer.from(encoded, 'base64url').toString();
  const known = users.find((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase());
  return { name, stores: known ? known.stores : ['*'], sso: true };
}
