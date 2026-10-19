import { useMemo, useState } from 'react';
import { formatDate, todayISO } from '../utils.js';
import SlotCard from './SlotCard.jsx';

const FILTERS = [
  ['upcoming', 'Próximos'],
  ['past', 'Pasados'],
  ['all', 'Todos'],
];

export function groupByDate(slots) {
  const groups = new Map();
  for (const s of slots) {
    const k = s.date || 'sin-fecha';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()];
}

export default function ListView({ slots, searching }) {
  const [filter, setFilter] = useState('upcoming');
  const today = todayISO();

  const groups = useMemo(() => {
    const filtered = slots.filter((s) => {
      if (!s.date) return filter === 'all';
      if (filter === 'upcoming') return s.date >= today;
      if (filter === 'past') return s.date < today;
      return true;
    });
    const g = groupByDate(filtered);
    return filter === 'past' ? g.reverse() : g;
  }, [slots, filter, today]);

  return (
    <div>
      <div className="segmented">
        {FILTERS.map(([key, label]) => (
          <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {groups.length === 0 && <div className="empty">{searching ? 'No hay resultados para esa búsqueda.' : 'No hay turnos para mostrar.'}</div>}

      {groups.map(([date, daySlots]) => {
        const total = daySlots.reduce((n, s) => n + s.booked, 0);
        return (
          <div className="day-group" key={date}>
            <h2 className="day-title">
              {date === 'sin-fecha' ? 'Sin fecha' : formatDate(date)}
              {date === today && <span className="pill today">Hoy</span>}
              <span className="day-total">{total} anotados</span>
            </h2>
            {daySlots.map((s) => (
              <SlotCard key={s.key} slot={s} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
