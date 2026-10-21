import { useMemo, useState } from 'react';
import { creativesApi } from '../../api.js';
import { AdsetSelect, CTA_LABELS, LinkField, linkOptions } from './Creatives.jsx';

const TYPE = { reel: 'Reel', post: 'Post', carousel: 'Carrusel' };

// Posts y reels ya publicados en Instagram, para promocionarlos como anuncio (suman sus likes y comentarios)
export default function IgPosts({ token, store, shop, adsets, ready, onError }) {
  const api = useMemo(() => creativesApi(token, store), [token, store]);
  const [posts, setPosts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const links = useMemo(() => linkOptions(shop), [shop]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setPosts((await api.igPosts()).posts);
    } catch (err) {
      if (err.unauthorized) onError(err);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <div className="section-head">
        <h3 className="section-title">Promocionar posts de Instagram</h3>
        {ready && (
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : posts ? 'Actualizar' : 'Ver posts'}
          </button>
        )}
      </div>
      {!ready ? (
        <p className="muted section-hint">
          Se habilita cuando esté conectada la cuenta de Meta y la cuenta de Instagram en Ajustes.
        </p>
      ) : (
        <p className="muted section-hint">
          El anuncio usa el post original (conserva likes y comentarios) y le suma un botón hacia la tienda.
        </p>
      )}
      {error && <div className="alert">{error}</div>}
      {posts?.length === 0 && <p className="muted">No hay posts en la cuenta.</p>}
      {posts?.length > 0 && (
        <div className="ig-grid">
          {posts.map((p) => (
            <div key={p.id} className="card ig-post">
              <a href={p.permalink} target="_blank" rel="noreferrer" className="ig-thumb">
                {p.thumbnail ? <img src={p.thumbnail} alt="" loading="lazy" /> : <span className="muted">Sin vista previa</span>}
                <span className="tag">{TYPE[p.type] || p.type}</span>
              </a>
              <div className="ig-body">
                <small className="muted">
                  {new Date(p.timestamp).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })} · ♥ {p.likes} · 💬{' '}
                  {p.comments}
                  {p.reach != null && ` · alcance ${p.reach}`}
                </small>
                <p className="ig-caption">{p.caption || <span className="muted">Sin texto</span>}</p>
                {p.promotedIn.length > 0 && (
                  <small className="note">Ya promocionado en: {p.promotedIn.map((x) => x.adset_name || x.adset_id).join(', ')}</small>
                )}
                {open === p.id ? (
                  <PromoteForm
                    post={p}
                    adsets={adsets.filter((a) => !p.promotedIn.some((x) => x.adset_id === a.id))}
                    links={links}
                    onCancel={() => setOpen(null)}
                    onSubmit={async (body) => {
                      await api.promote(p.id, { ...body, permalink: p.permalink });
                      setOpen(null);
                      await load();
                    }}
                  />
                ) : (
                  <button className="btn small" onClick={() => setOpen(p.id)} disabled={adsets.length === 0}>
                    Promocionar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PromoteForm({ adsets, links, onSubmit, onCancel }) {
  const [adsetId, setAdsetId] = useState('');
  const [link, setLink] = useState(links[0]?.value ?? '');
  const [cta, setCta] = useState('BUY_TICKETS');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit({ adset_id: adsetId, adset_name: adsets.find((a) => a.id === adsetId)?.name ?? '', link, cta });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="promote-form">
      <AdsetSelect adsets={adsets} value={adsetId} onChange={setAdsetId} />
      <LinkField value={link} onChange={setLink} options={links} />
      <label className="field">
        <span>Botón</span>
        <select value={cta} onChange={(e) => setCta(e.target.value)}>
          {Object.entries(CTA_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="alert">{error}</div>}
      <div className="decision-actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn primary" onClick={submit} disabled={busy || !adsetId || !link}>
          {busy ? 'Creando…' : 'Crear anuncio'}
        </button>
      </div>
    </div>
  );
}
