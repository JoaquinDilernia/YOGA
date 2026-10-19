const KEY = 'turnos_session';

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function setSession(session) {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {}
}

export async function login(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo ingresar');
  return data;
}

export const getLastStore = () => {
  try {
    return localStorage.getItem('turnos_store');
  } catch {
    return null;
  }
};

export const setLastStore = (key) => {
  try {
    localStorage.setItem('turnos_store', key);
  } catch {}
};

export const fetchMe = (token) => authGet('/api/me', token);

export const fetchTurnos = (token, store, fresh = false) =>
  authGet(`/api/turnos?store=${encodeURIComponent(store)}${fresh ? '&fresh=1' : ''}`, token);

async function authGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error(data.error || 'Sesión vencida');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(data.error || 'Error al cargar los turnos');
  return data;
}
