export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const dateFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
export const formatDate = (iso) => {
  const s = dateFmt.format(new Date(`${iso}T12:00:00`));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const PAYMENT_LABELS = {
  paid: 'Pagado',
  pending: 'Pendiente',
  authorized: 'Autorizado',
  abandoned: 'Abandonado',
  refunded: 'Reembolsado',
  voided: 'Anulado',
};

export const waLink = (phone) => {
  const digits = (phone || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
};

export function matchesQuery(attendee, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [attendee.name, attendee.email, attendee.phone, String(attendee.number)].some((v) => (v || '').toLowerCase().includes(s));
}

export function downloadCSV(slots, filename = 'turnos.csv') {
  const rows = [['Fecha', 'Horario', 'Lugar', 'Nombre', 'Mail', 'Teléfono', 'Cantidad', 'Pago', 'Orden']];
  for (const s of slots) {
    for (const a of s.attendees) {
      rows.push([s.date || s.title, s.time, s.place, a.name, a.email, a.phone, a.qty, PAYMENT_LABELS[a.paymentStatus] || a.paymentStatus, a.number]);
    }
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
