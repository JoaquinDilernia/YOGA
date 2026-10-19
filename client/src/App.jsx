import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { fetchTurnos, getSession, setSession } from './api.js';
import { downloadCSV, matchesQuery } from './utils.js';
import Login from './components/Login.jsx';
import ListView from './components/ListView.jsx';
import CalendarView from './components/CalendarView.jsx';

export default function App() {
  const [session, setSessionState] = useState(getSession);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const logout = useCallback(() => {
    setSession(null);
    setSessionState(null);
    setData(null);
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      if (!session) return;
      setLoading(true);
      setError('');
      try {
        setData(await fetchTurnos(session.token, fresh));
      } catch (err) {
        if (err.unauthorized) logout();
        else setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [session, logout]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Filtra anotados por búsqueda; si hay búsqueda, oculta horarios sin coincidencias
  const slots = useMemo(() => {
    if (!data) return [];
    if (!query.trim()) return data.slots;
    return data.slots
      .map((s) => ({ ...s, attendees: s.attendees.filter((a) => matchesQuery(a, query.trim())) }))
      .filter((s) => s.attendees.length);
  }, [data, query]);

  if (!session) {
    return (
      <Login
        onLogin={(s) => {
          setSession(s);
          setSessionState(s);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🧘</span>
          <div>
            <strong>{session.store?.name || 'Turnos'}</strong>
            <small>Panel de turnos</small>
          </div>
        </div>
        <nav className="tabs">
          <NavLink to="/lista">Lista</NavLink>
          <NavLink to="/calendario">Calendario</NavLink>
        </nav>
        <div className="actions">
          <button className="btn ghost" onClick={() => load(true)} disabled={loading} title="Traer lo último de Tienda Nube">
            {loading ? 'Actualizando…' : 'Actualizar'}
          </button>
          <button className="btn ghost" onClick={logout}>
            Salir
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Buscar por nombre, mail, teléfono u orden…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => downloadCSV(slots)} disabled={!slots.length}>
          Descargar CSV
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {!data && loading && <div className="empty">Cargando turnos…</div>}

      {data && (
        <main>
          <Routes>
            <Route path="/lista" element={<ListView slots={slots} searching={!!query.trim()} />} />
            <Route path="/calendario" element={<CalendarView slots={slots} />} />
            <Route path="*" element={<Navigate to="/lista" replace />} />
          </Routes>
          <p className="updated">Actualizado {new Date(data.updatedAt).toLocaleString('es-AR')}</p>
        </main>
      )}
    </div>
  );
}
