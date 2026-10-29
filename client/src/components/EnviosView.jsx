import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw, Send } from 'lucide-react';
import { entradasApi } from '../api.js';
import { formatMoney } from '../utils.js';

const STATUS = {
  sent: { label: 'Enviada', cls: 'paid' },
  pending: { label: 'Pendiente', cls: 'pending' },
  failed: { label: 'Con error', cls: 'voided' },
  skipped: { label: 'No aplica', cls: 'skipped' },
};

const when = (iso) => (iso ? new Date(iso).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function what(item) {
  const parts = item.classes.map((c) => `${c.title}${c.time ? ` · ${c.time}` : ''}${c.qty > 1 ? ` (×${c.qty})` : ''}`);
  for (const g of item.gifts) parts.push(`${g.name}${g.qty > 1 ? ` (×${g.qty})` : ''}`);
  return parts.join(' + ') || '—';
}

// Entradas y gift cards mandadas por mail: el envío es automático, acá se ve qué salió y se reintenta o reenvía
export default function EnviosView({ token, store, onError }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const api = entradasApi(token, store);

  const load = useCallback(() => {
    entradasApi(token, store).list().then(setData).catch(onError);
  }, [token, store, onError]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const act = async (id, fn) => {
    setBusy(id);
    try {
      const row = await fn();
      setData((d) => ({ ...d, items: d.items.map((x) => (x.id === row.id ? row : x)) }));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const resend = (item) => {
    const email = window.prompt('¿A qué mail lo reenviamos?', item.email);
    if (email === null) return;
    act(item.id, () => api.resend(item.id, email.trim() === item.email ? undefined : email.trim()));
  };

  if (!data) return <div className="empty">Cargando envíos…</div>;

  return (
    <main>
      <div className="section-head">
        <p className="section-hint">
          Cada venta pagada desde el {when(data.since)} recibe su entrada (o el código de la gift card) por mail y se marca como enviada en
          Tienda Nube. Se revisa cada 5 minutos.
        </p>
        <button className="btn ghost icon" onClick={load} aria-label="Actualizar" title="Actualizar">
          <RefreshCw size={18} />
        </button>
      </div>
      {!data.configured && <div className="alert">Falta configurar el mail de esta tienda: todavía no se mandan entradas.</div>}

      {data.items.length === 0 ? (
        <div className="empty">Todavía no hay envíos.</div>
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Qué compró</th>
                  <th>Mail</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const st = STATUS[item.status] || { label: item.status, cls: '' };
                  return (
                    <tr key={item.id}>
                      <td data-label="Orden">
                        <strong>{item.name || '—'}</strong>
                        <small className="muted"> #{item.order_number}</small>
                        <div className="muted">{when(item.order_created_at)}</div>
                      </td>
                      <td data-label="Qué compró">
                        {what(item)}
                        {item.coupons.length > 0 && (
                          <div className="muted">
                            {item.coupons.map((c) => `${c.code} (${formatMoney(c.value)})`).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td data-label="Mail">{item.email || '—'}</td>
                      <td data-label="Estado">
                        <span className={`status ${st.cls}`}>{st.label}</span>
                        {item.mail_sent_at && <div className="muted">Mail: {when(item.mail_sent_at)}</div>}
                        {item.error && <div className="warn-text">{item.error}</div>}
                      </td>
                      <td className="num">
                        {item.status === 'failed' && (
                          <button className="btn" disabled={busy === item.id} onClick={() => act(item.id, () => api.retry(item.id))}>
                            <RotateCcw size={16} aria-hidden /> Reintentar
                          </button>
                        )}
                        {item.status !== 'skipped' && item.status !== 'failed' && (
                          <button className="btn ghost" disabled={busy === item.id} onClick={() => resend(item)}>
                            <Send size={16} aria-hidden /> Reenviar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
