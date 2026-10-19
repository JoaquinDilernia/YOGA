import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'cambiar-esto';
const SESSION_DAYS = 30;
const CACHE_MS = 60 * 1000;

// Tiendas: STORES='[{"key":"perritos","name":"Yoga y Patitas","id":"123","token":"..."}]'
// Usuarios: USERS='[{"name":"Marcos","password":"...","stores":["perritos","gatitos"]}]'
const parseEnv = (name) => {
  try {
    return JSON.parse(process.env[name] || '[]');
  } catch {
    console.error(`[turnos] ${name} no es un JSON válido`);
    return [];
  }
};
const STORES = parseEnv('STORES').filter((s) => s.key && s.id && s.token);
const USERS = parseEnv('USERS').filter((u) => u.name && u.password && Array.isArray(u.stores));
if (!STORES.length || !USERS.length) console.warn('[turnos] Faltan STORES o USERS');

const userStores = (user) => STORES.filter((s) => user.stores.includes(s.key)).map((s) => ({ key: s.key, name: s.name }));

// ---------- Sesión (token firmado, sin base de datos) ----------
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function createToken(user) {
  const payload = `${Buffer.from(user.name).toString('base64url')}.${Date.now() + SESSION_DAYS * 864e5}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token = '') {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  const [name, exp] = payload.split('.');
  if (Number(exp) < Date.now()) return null;
  // Se busca el usuario en cada request: si se le sacan tiendas o se lo borra, aplica al instante
  return USERS.find((u) => u.name === Buffer.from(name, 'base64url').toString()) || null;
}

function auth(req, res, next) {
  const user = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!user) return res.status(401).json({ error: 'Sesión vencida' });
  req.user = user;
  next();
}

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Rate-limit simple de login por IP
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}

// ---------- Tienda Nube ----------
async function tnGetAll(store, resource, fields) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const url = `https://api.tiendanube.com/v1/${store.id}/${resource}?per_page=200&page=${page}&fields=${fields}`;
    const res = await fetch(url, {
      headers: { Authentication: `bearer ${store.token}`, 'User-Agent': 'Turnos Panel (jdilernia99@gmail.com)' },
    });
    if (res.status === 404 && page > 1) break; // TN responde 404 pasada la última página
    if (!res.ok) throw new Error(`Tienda Nube ${resource} ${res.status}: ${await res.text()}`);
    const items = await res.json();
    out.push(...items);
    if (items.length < 200) break;
  }
  return out;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "Sábado 24 de Octubre • Palermo • Mario Bravo 1029" -> { date: '2026-10-24', title, place }
function parseProductName(name, refDate) {
  const [dayPart, ...rest] = name.split('•').map((s) => s.trim());
  const m = norm(dayPart).match(/(\d{1,2})\s+de\s+([a-z]+)/);
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return { date: null, title: name, place: '' };
  const day = Number(m[1]);
  const weekday = DAYS.findIndex((d) => norm(dayPart).startsWith(d));
  const ref = new Date(refDate || Date.now());
  // El nombre no trae año: probamos el año de referencia y el siguiente, priorizando el que coincide con el día de semana
  const candidates = [ref.getUTCFullYear(), ref.getUTCFullYear() + 1, ref.getUTCFullYear() - 1];
  let year = candidates.find((y) => weekday >= 0 && new Date(Date.UTC(y, month, day)).getUTCDay() === weekday);
  if (!year) year = month < ref.getUTCMonth() - 1 ? ref.getUTCFullYear() + 1 : ref.getUTCFullYear();
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, title: dayPart, place: rest.join(' • ') };
}

// Pagos que no cuentan como lugar ocupado (se muestran igual, marcados)
const INACTIVE_PAYMENTS = ['voided', 'refunded', 'abandoned'];

const startMinutes =(time = '') => {
  const m = time.match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9999;
};

async function buildTurnos(store) {
  const [products, orders] = await Promise.all([
    tnGetAll(store, 'products', 'id,name,published,created_at,variants'),
    tnGetAll(store, 'orders', 'id,number,status,payment_status,created_at,contact_name,contact_email,contact_phone,customer,products,note'),
  ]);

  const slots = new Map();
  const getSlot = (productId, variantId, info) => {
    const key = `${productId}-${variantId}`;
    if (!slots.has(key)) slots.set(key, { key, productId, variantId, stockLeft: null, published: false, attendees: [], ...info });
    return slots.get(key);
  };

  for (const p of products) {
    const name = p.name?.es || Object.values(p.name || {})[0] || '';
    const parsed = parseProductName(name, p.created_at);
    if (!parsed.date) continue; // gift cards, etc.
    for (const v of p.variants || []) {
      const time = (v.values || []).map((x) => x.es || Object.values(x)[0]).join(' · ');
      const slot = getSlot(p.id, v.id, { ...parsed, time });
      slot.stockLeft = v.stock_management ? v.stock : null;
      slot.published = p.published;
    }
  }

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const item of o.products || []) {
      const baseName = item.name_without_variants || item.name;
      const time = (item.variant_values || []).join(' · ');
      let slot = slots.get(`${item.product_id}-${item.variant_id}`);
      if (!slot) {
        const parsed = parseProductName(baseName, o.created_at);
        if (!parsed.date) continue; // gift cards, etc.: no son turnos
        slot = getSlot(item.product_id, item.variant_id, { ...parsed, time });
      }
      slot.attendees.push({
        orderId: o.id,
        number: o.number,
        name: o.contact_name || o.customer?.name || '',
        email: o.contact_email || o.customer?.email || '',
        phone: o.contact_phone || o.customer?.phone || '',
        qty: Number(item.quantity) || 1,
        paymentStatus: o.payment_status,
        createdAt: o.created_at,
        note: o.note || '',
      });
    }
  }

  const list = [...slots.values()]
    .filter((s) => s.attendees.length || s.published)
    .map((s) => ({ ...s, booked: s.attendees.reduce((n, a) => (INACTIVE_PAYMENTS.includes(a.paymentStatus) ? n : n + a.qty), 0) }))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || startMinutes(a.time) - startMinutes(b.time) || a.place.localeCompare(b.place));

  return { store: { key: store.key, name: store.name }, slots: list, updatedAt: new Date().toISOString() };
}

const cache = new Map();
async function getTurnos(store, fresh) {
  const hit = cache.get(store.key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await buildTurnos(store);
  cache.set(store.key, { at: Date.now(), data });
  return data;
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Demasiados intentos, probá en unos minutos' });
  const user = USERS.find((u) => safeEqual(u.password, req.body?.password || ''));
  if (!user) {
    attempts.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  res.json({ token: createToken(user), user: { name: user.name } });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: { name: req.user.name }, stores: userStores(req.user) });
});

app.get('/api/turnos', auth, async (req, res) => {
  const allowed = userStores(req.user);
  const key = req.query.store || allowed[0]?.key;
  const store = allowed.some((s) => s.key === key) && STORES.find((s) => s.key === key);
  if (!store) return res.status(403).json({ error: 'No tenés acceso a esa tienda' });
  try {
    res.json(await getTurnos(store, req.query.fresh === '1'));
  } catch (err) {
    console.error('[turnos]', err);
    res.status(502).json({ error: 'No se pudo leer Tienda Nube' });
  }
});

const dist = path.join(__dirname, 'client', 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(PORT, () => console.log(`[turnos] escuchando en :${PORT} (${STORES.map((s) => s.key).join(', ')})`));
