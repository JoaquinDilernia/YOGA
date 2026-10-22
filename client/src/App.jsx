import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BarChart3, CalendarDays, Download, List, LogOut, Megaphone, RefreshCw } from 'lucide-react';
import { fetchMe, fetchTurnos, getLastStore, getSession, setLastStore, setSession } from './api.js';
import { downloadCSV, matchesQuery } from './utils.js';
import Login from './components/Login.jsx';
import ListView from './components/ListView.jsx';
import CalendarView from './components/CalendarView.jsx';
import PautaView from './components/pauta/PautaView.jsx';
import ReportsView from './components/reports/ReportsView.jsx';

const NAV = [
  { to: '/lista', label: 'Lista', icon: List },
  { to: '/calendario', label: 'Calendario', icon: CalendarDays },
  { to: '/pauta', label: 'Pauta', icon: Megaphone, pauta: true },
  { to: '/reportes', label: 'Reportes', icon: BarChart3, pauta: true },
];

export default function App() {
  const [session, setSessionState] = useState(getSession);
  const [stores, setStores] = useState([]);
  const [storeKey, setStoreKey] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  // null hasta saber si el servidor tiene la pauta prendida
  const [pautaEnabled, setPautaEnabled] = useState(null);
  const path = useLocation().pathname;
  const onReports = path.startsWith('/reportes');
  // Pauta y Reportes no usan la lista de turnos ni su buscador
  const onPauta = path.startsWith('/pauta') || onReports;

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
    [logout],
  );

  // Tiendas a las que tiene acceso el usuario
  useEffect(() => {
    if (!session) return;
    fetchMe(session.token)
      .then(({ stores, pauta }) => {
        setStores(stores);
        setPautaEnabled(Boolean(pauta));
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
    [session, storeKey, handleError],
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
  const nav = NAV.filter((n) => !n.pauta || pautaEnabled);
  const section = NAV.find((n) => path.startsWith(n.to))?.label ?? 'Turnos';
  const userName = session.user?.name || '';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <span className="brand-mark" aria-hidden>🧘</span>
          <div>
            <strong>Yoga</strong>
            <small>Panel de gestión</small>
          </div>
        </div>
        {stores.length > 1 && (
          <>
            <span className="side-label">Tienda</span>
            <div className="side-stores">
              {stores.map((s) => (
                <button key={s.key} className={s.key === storeKey ? 'active' : ''} onClick={() => switchStore(s.key)}>
                  {s.name}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="side-label">Secciones</span>
        <nav className="side-nav" aria-label="Secciones">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to}>
              <Icon size={20} aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="me">
          <span className="avatar" aria-hidden>{userName[0]?.toUpperCase()}</span>
          <span className="me-name">{userName}</span>
          <button type="button" className="btn ghost icon" onClick={logout} aria-label="Salir" title="Salir">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="page-header">
          <div className="titles">
            <h1>{section}</h1>
            <p className="subtitle">{currentStore?.name || 'Cargando…'}</p>
          </div>
          <div className="actions">
            {!onPauta && (
              <button
                className="btn ghost icon"
                onClick={() => load(true)}
                disabled={loading}
                aria-label="Actualizar"
                title="Traer lo último de Tienda Nube"
              >
                <RefreshCw size={18} className={loading ? 'spin' : ''} />
              </button>
            )}
            <button type="button" className="btn ghost icon mobile-only" onClick={logout} aria-label="Salir" title="Salir">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <div className="content">
          {stores.length > 1 && (
            <div className="store-switch mobile-only">
              {stores.map((s) => (
                <button key={s.key} className={s.key === storeKey ? 'active' : ''} onClick={() => switchStore(s.key)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}

          {!onPauta && (
            <div className="toolbar">
              <input
                className="search"
                type="search"
                placeholder="Buscar por nombre, mail, teléfono u orden…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="btn" onClick={() => downloadCSV(slots, `turnos-${storeKey}.csv`)} disabled={!slots.length}>
                <Download size={16} aria-hidden /> Descargar CSV
              </button>
            </div>
          )}

          {error && <div className="alert">{error}</div>}
          {!onPauta && !data && loading && <div className="empty">Cargando turnos…</div>}

          {path === '/' && <Navigate to="/lista" replace />}
          {onPauta && pautaEnabled === false && <Navigate to="/lista" replace />}
          {onReports && pautaEnabled && storeKey && (
            <ReportsView
              key={storeKey}
              token={session.token}
              store={storeKey}
              storeName={currentStore?.name}
              onError={handleError}
            />
          )}
          {onPauta && !onReports && pautaEnabled && storeKey && (
            <PautaView token={session.token} store={storeKey} onError={handleError} />
          )}

          {!onPauta && data && (
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
      </div>

      <nav className="bottom mobile-only" aria-label="Secciones">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to}>
            <Icon size={22} aria-hidden />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
