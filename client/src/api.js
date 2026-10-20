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

const authGet = (url, token) => authRequest('GET', url, token);

async function authRequest(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error(data.error || 'Sesión vencida');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(data.error || 'Error al cargar los datos');
  return data;
}

// Pauta: todo va por tienda
const pautaUrl = (store, path) => `/api/pauta/${encodeURIComponent(store)}${path}`;
export const pautaApi = (token, store) => ({
  overview: (refresh = false) => authGet(pautaUrl(store, `/overview${refresh ? '?refresh=1' : ''}`), token),
  saveSettings: (patch) => authRequest('PUT', pautaUrl(store, '/settings'), token, patch),
  startRun: () => authRequest('POST', pautaUrl(store, '/runs'), token),
  runs: () => authGet(pautaUrl(store, '/runs'), token),
  decisions: () => authGet(pautaUrl(store, '/decisions'), token),
  approve: (id) => authRequest('POST', pautaUrl(store, `/decisions/${id}/approve`), token),
  reject: (id) => authRequest('POST', pautaUrl(store, `/decisions/${id}/reject`), token),
  setStatus: (id, body) => authRequest('POST', pautaUrl(store, `/objects/${id}/status`), token, body),
  answer: (id, answer) => authRequest('POST', pautaUrl(store, `/questions/${id}/answer`), token, { answer }),
  dismiss: (id) => authRequest('POST', pautaUrl(store, `/questions/${id}/dismiss`), token),
  requestDone: (id) => authRequest('POST', pautaUrl(store, `/requests/${id}/done`), token),
  learnings: () => authGet(pautaUrl(store, '/learnings'), token),
  deleteLearning: (id) => authRequest('DELETE', pautaUrl(store, `/learnings/${id}`), token),
});
