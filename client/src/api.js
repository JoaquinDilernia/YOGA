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

export async function fetchTurnos(token, fresh = false) {
  const res = await fetch(`/api/turnos${fresh ? '?fresh=1' : ''}`, {
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
