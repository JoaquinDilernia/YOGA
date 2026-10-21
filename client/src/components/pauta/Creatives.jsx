import { useCallback, useEffect, useMemo, useState } from 'react';
import { creativesApi } from '../../api.js';
import { formatDate } from '../../utils.js';

const POLL_MS = 5000;
const MB = 1024 * 1024;
// Lo mismo que acepta el servidor (Meta no toma WebP)
const ACCEPT = {
  'image/jpeg': { kind: 'image', max: 8 * MB },
  'image/png': { kind: 'image', max: 8 * MB },
  'video/mp4': { kind: 'video', max: 200 * MB },
  'video/quicktime': { kind: 'video', max: 200 * MB },
};
export const CTA_LABELS = { BUY_TICKETS: 'Comprar entradas', SHOP_NOW: 'Comprar', LEARN_MORE: 'Más información' };
const STATUS = { unused: 'Sin usar', publishing: 'Publicando…', used: 'Publicada', archived: 'Archivada' };
const SLOT_LABEL = { feed: 'Feed (4:5 o 1:1)', story: 'Historia / reel (9:16)' };
// Proporción esperada por lugar, con tolerancia: avisa, no bloquea
const RATIO_OK = { feed: (r) => r >= 0.75 && r <= 1.05, story: (r) => r >= 0.5 && r <= 0.6 };

// Links posibles: la tienda y cada fecha próxima publicada
export function linkOptions(shop) {
  const opts = [];
  if (shop?.storeUrl) opts.push({ value: shop.storeUrl, label: 'Tienda (inicio)' });
  for (const c of shop?.upcomingClasses ?? []) {
    if (c.url && c.published && !opts.some((o) => o.value === c.url)) {
      opts.push({ value: c.url, label: `${formatDate(c.date)} · ${c.place}${c.left === 0 ? ' (completa)' : ''}` });
    }
  }
  return opts;
}

export function LinkField({ value, onChange, options }) {
  const known = options.some((o) => o.value === value);
  const [custom, setCustom] = useState(Boolean(value) && !known);
  return (
    <label className="field">
      <span>A dónde lleva el botón</span>
      <select
        value={custom ? '__otro' : value}
        onChange={(e) => {
          if (e.target.value === '__otro') {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {!value && !custom && <option value="">Elegí…</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="__otro">Otro link…</option>
      </select>
      {custom && <input placeholder="https://…" value={value} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

export function AdsetSelect({ adsets, value, onChange }) {
  return (
    <label className="field">
      <span>Conjunto</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Elegí el conjunto…</option>
        {adsets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.status !== 'ACTIVE' ? ' (pausado)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

const sizeLabel = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

export default function Creatives({ token, store, shop, adsets, connected, onError }) {
  const api = useMemo(() => creativesApi(token, store), [token, store]);
  const [creatives, setCreatives] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | creative
  const [error, setError] = useState('');
  const links = useMemo(() => linkOptions(shop), [shop]);

  const fail = useCallback((err) => (err.unauthorized ? onError(err) : setError(err.message)), [onError]);
  const load = useCallback(async () => {
    try {
      setCreatives((await api.list()).creatives);
    } catch (err) {
      fail(err);
    }
  }, [api, fail]);

  useEffect(() => {
    setCreatives(null);
    setEditing(null);
    load();
  }, [load]);

  // Publicar sigue en el servidor (un video tarda en Meta): se consulta hasta que termine
  const publishing = creatives?.some((c) => c.status === 'publishing');
  useEffect(() => {
    if (!publishing) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [publishing, load]);

  const replace = (c) => setCreatives((list) => list.map((x) => (x.id === c.id ? c : x)));

  return (
    <section>
      <div className="section-head">
        <h3 className="section-title">Piezas</h3>
        {editing !== 'new' && (
          <button className="btn" onClick={() => setEditing('new')}>
            Nueva pieza
          </button>
        )}
      </div>
      <p className="muted section-hint">
        Subí la foto o el video con su texto. Queda lista para publicarla en un conjunto, y el agente la tiene en
        cuenta para sus recomendaciones.
      </p>
      {error && <div className="alert">{error}</div>}

      {editing === 'new' && (
        <CreativeForm
          links={links}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const { creative } = await api.create(body);
            setCreatives((list) => [creative, ...(list ?? [])]);
            setEditing(null);
          }}
        />
      )}

      {creatives === null ? (
        <p className="muted">Cargando piezas…</p>
      ) : creatives.length === 0 && editing !== 'new' ? (
        <p className="muted">Todavía no hay piezas cargadas.</p>
      ) : (
        <div className="creatives">
          {creatives.map((c) =>
            editing?.id === c.id ? (
              <CreativeForm
                key={c.id}
                initial={c}
                links={links}
                onCancel={() => setEditing(null)}
                onSave={async (body) => {
                  replace((await api.update(c.id, body)).creative);
                  setEditing(null);
                }}
              />
            ) : (
              <CreativeCard
                key={c.id}
                c={c}
                api={api}
                adsets={adsets}
                connected={connected}
                onChange={replace}
                onRemoved={() => setCreatives((list) => list.filter((x) => x.id !== c.id))}
                onEdit={() => setEditing(c)}
                onError={fail}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function CreativeForm({ initial, links, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    name: initial?.name ?? '',
    copy: initial?.copy ?? '',
    headline: initial?.headline ?? '',
    link: initial?.link ?? links[0]?.value ?? '',
    cta: initial?.cta ?? 'BUY_TICKETS',
    notes: initial?.notes ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="card pad creative-form" onSubmit={submit}>
      <h3>{initial ? 'Editar pieza' : 'Nueva pieza'}</h3>
      <div className="settings-grid">
        <label className="field">
          <span>Nombre</span>
          <input required maxLength={120} placeholder="Ej. Reel cachorros sábado" value={form.name} onChange={set('name')} />
          <small>Para reconocerla en el panel y en el nombre del anuncio.</small>
        </label>
        <label className="field">
          <span>Título (opcional)</span>
          <input maxLength={120} placeholder="Ej. Yoga con cachorros" value={form.headline} onChange={set('headline')} />
          <small>La línea en negrita al lado del botón.</small>
        </label>
      </div>
      <label className="field">
        <span>Texto del anuncio</span>
        <textarea
          required
          rows={4}
          maxLength={2000}
          placeholder="Lo que se lee arriba de la foto o el video"
          value={form.copy}
          onChange={set('copy')}
        />
      </label>
      <div className="settings-grid">
        <LinkField value={form.link} onChange={(link) => setForm((f) => ({ ...f, link }))} options={links} />
        <label className="field">
          <span>Botón</span>
          <select value={form.cta} onChange={set('cta')}>
            {Object.entries(CTA_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Notas para el agente (opcional)</span>
        <input
          maxLength={1000}
          placeholder="A qué fecha o público apunta, cuándo usarla…"
          value={form.notes}
          onChange={set('notes')}
        />
      </label>
      {error && <div className="alert">{error}</div>}
      <div className="decision-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </button>
        <button className="btn primary" disabled={saving}>
          {saving ? 'Guardando…' : initial ? 'Guardar' : 'Crear y subir archivos'}
        </button>
      </div>
    </form>
  );
}

function CreativeCard({ c, api, adsets, connected, onChange, onRemoved, onEdit, onError }) {
  const [publishing, setPublishing] = useState(false);
  const [adsetId, setAdsetId] = useState('');
  const [busy, setBusy] = useState(false);
  const editable = c.status === 'unused';

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const publish = () =>
    run(async () => {
      const adset = adsets.find((a) => a.id === adsetId);
      onChange((await api.publish(c.id, { adset_id: adsetId, adset_name: adset?.name ?? '' })).creative);
      setPublishing(false);
    });

  return (
    <div className={`card pad creative ${c.status}`}>
      <div className="creative-head">
        <div>
          <strong>{c.name}</strong>
          <small className="muted"> · {CTA_LABELS[c.cta] || c.cta}</small>
        </div>
        <span className={`pill ${c.status === 'used' ? '' : c.status === 'publishing' ? 'warn' : 'idle'}`}>
          {STATUS[c.status]}
        </span>
      </div>

      <div className="slots">
        {['feed', 'story'].map((slot) => (
          <MediaSlot
            key={slot}
            slot={slot}
            file={c[slot]}
            editable={editable}
            onUpload={(file, onProgress) => api.upload(c.id, slot, file, onProgress).then((r) => onChange(r.creative))}
            onRemove={() => run(async () => onChange((await api.removeMedia(c.id, slot)).creative))}
            onError={onError}
          />
        ))}
      </div>

      <p className="creative-copy">{c.copy}</p>
      {c.headline && <p className="muted">{c.headline}</p>}
      <p className="note">
        Lleva a{' '}
        <a href={c.link} target="_blank" rel="noreferrer">
          {c.link.replace(/^https?:\/\//, '').slice(0, 60)}
        </a>
        {c.notes && ` · ${c.notes}`}
      </p>
      {c.status === 'used' && (
        <p className="note">
          Anuncio {c.meta_ad_id} en el conjunto {c.meta_adset_id}
          {c.used_at && ` · ${new Date(c.used_at).toLocaleDateString('es-AR')}`}
        </p>
      )}
      {c.publish_error && c.status === 'unused' && <div className="alert">No se pudo publicar: {c.publish_error}</div>}

      {publishing ? (
        <div className="publish-row">
          <AdsetSelect adsets={adsets} value={adsetId} onChange={setAdsetId} />
          <div className="decision-actions">
            <button className="btn ghost" onClick={() => setPublishing(false)} disabled={busy}>
              Cancelar
            </button>
            <button className="btn primary" onClick={publish} disabled={busy || !adsetId}>
              {busy ? 'Publicando…' : 'Publicar ahora'}
            </button>
          </div>
          <small className="muted">El anuncio nace activo dentro del conjunto: si el conjunto está pausado, no gasta.</small>
        </div>
      ) : (
        <div className="decision-actions">
          {editable && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                if (confirm(`¿Borrar la pieza "${c.name}" y sus archivos?`)) run(async () => (await api.remove(c.id), onRemoved()));
              }}
            >
              Borrar
            </button>
          )}
          {c.status === 'used' && (
            <button className="btn ghost" disabled={busy} onClick={() => run(async () => (await api.update(c.id, { status: 'archived' }), onRemoved()))}>
              Archivar
            </button>
          )}
          {editable && (
            <button className="btn ghost" disabled={busy} onClick={onEdit}>
              Editar
            </button>
          )}
          {editable && (
            <button
              className="btn primary"
              disabled={busy || !c.feed || !connected || adsets.length === 0}
              title={
                !connected
                  ? 'Se habilita cuando conectemos la cuenta de Meta'
                  : !c.feed
                    ? 'Falta subir el archivo de feed'
                    : adsets.length === 0
                      ? 'La cuenta no tiene conjuntos todavía'
                      : ''
              }
              onClick={() => setPublishing(true)}
            >
              Publicar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MediaSlot({ slot, file, editable, onUpload, onRemove, onError }) {
  const [progress, setProgress] = useState(null);
  const [warning, setWarning] = useState('');

  useEffect(() => {
    if (!file?.width || !file?.height) return setWarning('');
    setWarning(RATIO_OK[slot](file.width / file.height) ? '' : `Mide ${file.width}×${file.height}: no es la proporción ideal.`);
  }, [file, slot]);

  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const type = ACCEPT[f.type];
    if (!type) return onError(new Error('Elegí una imagen JPG/PNG o un video MP4/MOV.'));
    if (f.size > type.max) return onError(new Error(`${type.kind === 'video' ? 'El video' : 'La imagen'} pesa más de ${type.max / MB} MB.`));
    setProgress(0);
    onUpload(f, setProgress)
      .catch(onError)
      .finally(() => setProgress(null));
  };

  return (
    <div className="media-slot">
      <small className="muted">{SLOT_LABEL[slot]}</small>
      <div className={`media-box ${slot}`}>
        {file ? (
          file.kind === 'video' ? (
            <video src={file.url} controls muted playsInline preload="metadata" />
          ) : (
            <img src={file.url} alt="" />
          )
        ) : (
          <span className="muted">{slot === 'feed' ? 'Sin archivo' : 'Opcional'}</span>
        )}
        {progress !== null && (
          <div className="upload-progress">
            <div className="bar">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <small>{progress < 1 ? `Subiendo ${Math.round(progress * 100)}%` : 'Verificando…'}</small>
          </div>
        )}
      </div>
      {file && (
        <small className="muted">
          {file.kind === 'video' ? 'Video' : 'Imagen'} · {sizeLabel(file.bytes)}
          {file.width ? ` · ${file.width}×${file.height}` : ''}
        </small>
      )}
      {warning && <small className="warn-text">{warning}</small>}
      {editable && (
        <div className="media-actions">
          <label className={`btn small ${progress !== null ? 'disabled' : ''}`}>
            {file ? 'Cambiar' : 'Subir'}
            <input type="file" accept="image/jpeg,image/png,video/mp4,video/quicktime" hidden onChange={pick} disabled={progress !== null} />
          </label>
          {file && slot === 'story' && (
            <button className="btn ghost small" onClick={onRemove} disabled={progress !== null}>
              Quitar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
