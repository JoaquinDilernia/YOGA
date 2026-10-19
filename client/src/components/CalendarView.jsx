import { useMemo, useState } from 'react';
import { formatDate, todayISO } from '../utils.js';
import SlotCard from './SlotCard.jsx';

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const monthFmt = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' });
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export default function CalendarView({ slots }) {
  const today = todayISO();
  const byDate = useMemo(() => {
    const map = new Map();
    for (const s of slots) {
      if (!s.date) continue;
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date).push(s);
    }
    return map;
  }, [slots]);

  // Arranca en el mes de hoy, o en el del próximo turno si este mes no tiene nada
  const [cursor, setCursor] = useState(() => {
    const dates = [...byDate.keys()];
    const hasThisMonth = dates.some((d) => d.startsWith(today.slice(0, 7)));
    const start = hasThisMonth ? today : dates.find((d) => d >= today) || today;
    const [sy, sm] = start.split('-').map(Number);
    return { y: sy, m: sm - 1 };
  });
  const [selected, setSelected] = useState(null);

  const { y, m } = cursor;
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // semana arranca lunes
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [...Array(offset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  const move = (delta) => {
    const d = new Date(y, m + delta, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setSelected(null);
  };

  const selectedSlots = selected ? byDate.get(selected) || [] : [];

  return (
    <div>
      <div className="cal-nav">
        <button className="btn ghost" onClick={() => move(-1)} aria-label="Mes anterior">
          ‹
        </button>
        <h2>{monthFmt.format(first).replace(/^./, (c) => c.toUpperCase())}</h2>
        <button className="btn ghost" onClick={() => move(1)} aria-label="Mes siguiente">
          ›
        </button>
      </div>

      <div className="calendar card">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} className="cal-cell empty-cell" />;
          const date = iso(y, m, day);
          const daySlots = byDate.get(date) || [];
          const total = daySlots.reduce((n, s) => n + s.booked, 0);
          return (
            <button
              key={date}
              className={`cal-cell ${daySlots.length ? 'has' : ''} ${date === today ? 'is-today' : ''} ${date === selected ? 'is-selected' : ''} ${date < today ? 'is-past' : ''}`}
              onClick={() => daySlots.length && setSelected(date === selected ? null : date)}
              disabled={!daySlots.length}
            >
              <span className="cal-day">{day}</span>
              {daySlots.length > 0 && (
                <>
                  <span className="cal-total">{total} anotados</span>
                  <span className="cal-slots">
                    {daySlots.map((s) => (
                      <span key={s.key} className="cal-chip">
                        {(s.time || '').split(/[–-]/)[0]} · {s.booked}
                      </span>
                    ))}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="day-group">
          <h2 className="day-title">{formatDate(selected)}</h2>
          {selectedSlots.map((s) => (
            <SlotCard key={s.key} slot={s} />
          ))}
        </div>
      ) : (
        <p className="muted center">Tocá un día con clases para ver los anotados.</p>
      )}
    </div>
  );
}
