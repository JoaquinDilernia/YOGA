const KEY = 'turnos_session';

// API en otro dominio (front en Hostinger): VITE_API_URL; vacío = mismo origen
const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
export const apiUrl = (url) => (typeof url === 'string' && url.startsWith('/api') ? API + url : url);

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
  const res = await fetch(apiUrl('/api/login'), {
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
  const res = await fetch(apiUrl(url), {
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
  report: (since, until, refresh = false) =>
    authGet(pautaUrl(store, `/report?since=${since}&until=${until}${refresh ? '&refresh=1' : ''}`), token),
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

// Piezas: el archivo va como cuerpo del PUT; XHR para poder mostrar el progreso de la subida
function uploadFile(url, token, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiUrl(url));
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 401) {
        const err = new Error(data.error || 'Sesión vencida');
        err.unauthorized = true;
        return reject(err);
      }
      if (xhr.status === 413 && !data.error) return reject(new Error('El archivo es demasiado grande.'));
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || 'No se pudo subir el archivo'));
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('Se cortó la conexión mientras se subía el archivo.'));
    xhr.send(file);
  });
}

export const creativesApi = (token, store) => ({
  list: () => authGet(pautaUrl(store, '/creatives'), token),
  create: (body) => authRequest('POST', pautaUrl(store, '/creatives'), token, body),
  update: (id, patch) => authRequest('PATCH', pautaUrl(store, `/creatives/${id}`), token, patch),
  remove: (id) => authRequest('DELETE', pautaUrl(store, `/creatives/${id}`), token),
  upload: (id, slot, file, onProgress) => uploadFile(pautaUrl(store, `/creatives/${id}/media/${slot}`), token, file, onProgress),
  removeMedia: (id, slot) => authRequest('DELETE', pautaUrl(store, `/creatives/${id}/media/${slot}`), token),
  publish: (id, adset) => authRequest('POST', pautaUrl(store, `/creatives/${id}/publish`), token, adset),
  igPosts: () => authGet(pautaUrl(store, '/ig-posts'), token),
  promote: (id, body) => authRequest('POST', pautaUrl(store, `/ig-posts/${id}/promote`), token, body),
});
