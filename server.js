import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import { createStoreData } from './src/tiendanube.js';
import { connect } from './src/db.js';
import { createPauta } from './src/pauta/index.js';
import { pautaErrorHandler } from './src/pauta/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'cambiar-esto';
const SESSION_DAYS = 30;

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
const getStoreData = createStoreData();
const getTurnos = async (store, fresh) => (await getStoreData(store, fresh)).turnos;

// ---------- Pauta (opcional: sin DATABASE_URL el panel muestra solo turnos) ----------
let pauta = null;
if (process.env.DATABASE_URL) {
  const db = await connect(process.env.DATABASE_URL);
  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  pauta = createPauta({
    db,
    stores: STORES,
    canAccess: (user, key) => user.stores.includes(key),
    getStoreData,
    metaToken: process.env.META_ACCESS_TOKEN || null,
    anthropic,
    model: process.env.PAUTA_MODEL || undefined,
  });
  if (!process.env.META_ACCESS_TOKEN) console.warn('[pauta] META_ACCESS_TOKEN no está definida: Pauta sin conexión a Meta');
  if (!anthropic) console.warn('[pauta] ANTHROPIC_API_KEY no está definida: el agente no corre');
  cron.schedule('0 9 * * *', () => pauta.runDaily(), { timezone: 'America/Argentina/Buenos_Aires' });
} else {
  console.warn('[pauta] DATABASE_URL no está definida: la sección Pauta está apagada');
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
  res.json({ user: { name: req.user.name }, stores: userStores(req.user), pauta: Boolean(pauta) });
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

if (pauta) app.use('/api/pauta/:store', auth, pauta.router, pautaErrorHandler);

const dist = path.join(__dirname, 'client', 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(PORT, () => console.log(`[turnos] escuchando en :${PORT} (${STORES.map((s) => s.key).join(', ')})`));
