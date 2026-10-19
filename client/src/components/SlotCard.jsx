import { PAYMENT_LABELS, formatMoney, waLink } from '../utils.js';

// No suman al conteo de anotados
const INACTIVE = ['voided', 'refunded', 'abandoned'];

export default function SlotCard({ slot }) {
  const capacity = slot.stockLeft != null ? slot.stockLeft + slot.booked : null;

  return (
    <section className="slot card">
      <header className="slot-head">
        <div>
          <div className="slot-time">{slot.time || 'Sin horario'}</div>
          {slot.place && <div className="slot-place">{slot.place}</div>}
        </div>
        <div className="slot-count">
          <strong>{slot.booked}</strong> anotado{slot.booked === 1 ? '' : 's'}
          {slot.stockLeft != null && (
            <span className={`pill ${slot.stockLeft === 0 ? 'full' : ''}`}>
              {slot.stockLeft === 0 ? 'Completo' : `${slot.stockLeft} libre${slot.stockLeft === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
      </header>
      {capacity > 0 && (
        <div className="bar">
          <span style={{ width: `${Math.min(100, (slot.booked / capacity) * 100)}%` }} />
        </div>
      )}

      {slot.attendees.length === 0 ? (
        <p className="muted">Todavía no hay anotados.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Mail</th>
                <th>Teléfono</th>
                <th className="num">Personas</th>
                <th className="num">Pagó</th>
              </tr>
            </thead>
            <tbody>
              {slot.attendees.map((a) => (
                <tr key={`${a.orderId}-${slot.key}`} className={INACTIVE.includes(a.paymentStatus) ? 'inactive' : ''}>
                  <td data-label="Nombre">
                    <strong>{a.name || '—'}</strong>
                    <small className="muted"> #{a.number}</small>
                    {a.note && <div className="note">{a.note}</div>}
                  </td>
                  <td data-label="Mail">{a.email ? <a href={`mailto:${a.email}`}>{a.email}</a> : '—'}</td>
                  <td data-label="Teléfono">
                    {a.phone ? (
                      <a href={waLink(a.phone)} target="_blank" rel="noreferrer">
                        {a.phone}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Personas" className="num">
                    {a.qty}
                  </td>
                  <td data-label="Pagó" className="num paid-cell">
                    <strong>{formatMoney(a.amount, a.currency)}</strong>
                    <span className={`status ${a.paymentStatus}`}>{PAYMENT_LABELS[a.paymentStatus] || a.paymentStatus}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
