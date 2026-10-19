import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { fetchMe, fetchTurnos, getLastStore, getSession, setLastStore, setSession } from './api.js';
import { downloadCSV, matchesQuery } from './utils.js';
import Login from './components/Login.jsx';
import ListView from './components/ListView.jsx';
import CalendarView from './components/CalendarView.jsx';

export default function App() {
  const [session, setSessionState] = useState(getSession);
  const [stores, setStores] = useState([]);
  const [storeKey, setStoreKey] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const logout = useCallback(() => {
    setSession(null);
    setSessionState(null);
    setStores([]);
    setStoreKey(null);
    setData(null);
  }, []);

  const handleError = useCallback(
    (err) => {
      if (err.unauthorized) logout();
      else setError(err.message);
    },
    [logout]
  );

  // Tiendas a las que tiene acceso el usuario
  useEffect(() => {
    if (!session) return;
    fetchMe(session.token)
      .then(({ stores }) => {
        setStores(stores);
        const last = getLastStore();
        setStoreKey(stores.some((s) => s.key === last) ? last : stores[0]?.key || null);
        if (!stores.length) setError('Tu usuario no tiene tiendas asignadas');
      })
      .catch(handleError);
  }, [session, handleError]);

  const load = useCallback(
    async (fresh = false) => {
      if (!session || !storeKey) return;
      setLoading(true);
      setError('');
      try {
        setData(await fetchTurnos(session.token, storeKey, fresh));
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(false);
      }
    },
    [session, storeKey, handleError]
  );

  useEffect(() => {
    load();
  }, [load]);

  const switchStore = (key) => {
    setLastStore(key);
    setData(null);
    setStoreKey(key);
  };

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

  const currentStore = stores.find((s) => s.key === storeKey);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🧘</span>
          <div>
            <strong>{currentStore?.name || 'Turnos'}</strong>
            <small>Hola, {session.user?.name}</small>
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

      {stores.length > 1 && (
        <div className="store-switch">
          {stores.map((s) => (
            <button key={s.key} className={s.key === storeKey ? 'active' : ''} onClick={() => switchStore(s.key)}>
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Buscar por nombre, mail, teléfono u orden…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => downloadCSV(slots, `turnos-${storeKey}.csv`)} disabled={!slots.length}>
          Descargar CSV
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {!data && loading && <div className="empty">Cargando turnos…</div>}

      {data && (
        <main>
          <Routes>
            <Route path="/lista" element={<ListView slots={slots} searching={!!query.trim()} />} />
            <Route path="/calendario" element={<CalendarView key={storeKey} slots={slots} />} />
            <Route path="*" element={<Navigate to="/lista" replace />} />
          </Routes>
          <p className="updated">Actualizado {new Date(data.updatedAt).toLocaleString('es-AR')}</p>
        </main>
      )}
    </div>
  );
}
