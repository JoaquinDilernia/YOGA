import { useState } from 'react';

const META_FIELDS = [
  ['meta_ad_account_id', 'Cuenta publicitaria', 'Business Manager → Cuentas publicitarias (el número, con o sin act_)'],
  ['meta_page_id', 'Página de Facebook', 'Configuración de la página → Información → ID'],
  ['meta_ig_user_id', 'Cuenta de Instagram', 'ID de la cuenta de Instagram conectada (para promocionar posts)'],
  ['meta_pixel_id', 'Píxel', 'Administrador de eventos → el píxel conectado a Tienda Nube'],
];

const toField = (v) => (v == null ? '' : String(v));

// Ajustes de la pauta de una tienda: presupuesto, contexto para el agente y conexión con Meta
export default function SettingsForm({ settings, onSave }) {
  const [form, setForm] = useState(() => ({
    agent_enabled: settings.agent_enabled,
    autonomous: settings.autonomous,
    monthly_cap_ars: toField(settings.monthly_cap_ars),
    target_cpa_ars: toField(settings.target_cpa_ars),
    business_notes: settings.business_notes,
    ...Object.fromEntries(META_FIELDS.map(([k]) => [k, settings[k]])),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...form,
        monthly_cap_ars: form.monthly_cap_ars.replace(/\D/g, ''),
        target_cpa_ars: form.target_cpa_ars.replace(/\D/g, ''),
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="card pad settings" onSubmit={submit}>
      <h3>Ajustes de pauta</h3>

      <div className="settings-grid">
        <label className="field">
          <span>Tope mensual de inversión ($)</span>
          <input
            inputMode="numeric"
            placeholder="Ej. 300000"
            value={form.monthly_cap_ars}
            onChange={set('monthly_cap_ars')}
          />
          <small>El agente nunca propone algo que lo pase. Vacío: no propone gastar más.</small>
        </label>
        <label className="field">
          <span>Costo objetivo por venta ($)</span>
          <input
            inputMode="numeric"
            placeholder="Ej. 8000"
            value={form.target_cpa_ars}
            onChange={set('target_cpa_ars')}
          />
          <small>Cuánto vale la pena pagar en anuncios por cada venta.</small>
        </label>
      </div>

      <label className="field">
        <span>Contexto para el agente</span>
        <textarea
          rows={6}
          placeholder="Qué tiene de especial la marca, a quién le habla, promos vigentes, fechas importantes, qué no hacer…"
          value={form.business_notes}
          onChange={set('business_notes')}
        />
      </label>

      <div className="checks">
        <label>
          <input type="checkbox" checked={form.agent_enabled} onChange={set('agent_enabled')} />
          Análisis diario (9 h)
        </label>
        <label>
          <input type="checkbox" checked={form.autonomous} onChange={set('autonomous')} />
          Modo autónomo: el agente puede pausar anuncios sin pedir permiso
        </label>
      </div>

      <h4>Conexión con Meta</h4>
      <div className="settings-grid">
        {META_FIELDS.map(([k, label, hint]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <input inputMode="numeric" value={form[k]} onChange={set(k)} />
            <small>{hint}</small>
          </label>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}
      <div className="decision-actions">
        <button className="btn primary" disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </form>
  );
}
