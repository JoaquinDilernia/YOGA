import { useCallback, useEffect, useMemo, useState } from 'react';
import { pautaApi } from '../../api.js';
import { formatDate, formatMoney } from '../../utils.js';
import Report from './Report.jsx';
import SettingsForm from './SettingsForm.jsx';

const POLL_MS = 8000;

const TOOL_LABELS = {
  pause_ad: 'Pausar anuncio',
  set_status: 'Pausar / activar',
  propose_budget_change: 'Presupuesto',
  propose_campaign: 'Campaña nueva',
  propose_adset: 'Conjunto nuevo',
  reuse_ad: 'Copiar anuncio',
  promote_ig_post: 'Promocionar post',
};
const STATUS_LABELS = {
  executed: 'Hecho',
  rejected: 'Rechazado',
  failed: 'Falló',
  executing: 'Ejecutando',
  pending: 'Pendiente',
};
const RUN_LABELS = { running: 'Analizando…', done: 'Listo', failed: 'Falló', skipped: 'Salteado' };
const META_STATUS = {
  ACTIVE: 'Activo',
  PAUSED: 'Pausado',
  CAMPAIGN_PAUSED: 'Campaña pausada',
  ADSET_PAUSED: 'Conjunto pausado',
  WITH_ISSUES: 'Con problemas',
  IN_PROCESS: 'En revisión',
  PENDING_REVIEW: 'En revisión',
  DISAPPROVED: 'Rechazado',
};

const money = (n) => (n == null ? '—' : formatMoney(n));
const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

export default function PautaView({ token, store, onError }) {
  const api = useMemo(() => pautaApi(token, store), [token, store]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const fail = useCallback(
    (err) => {
      if (err.unauthorized) onError(err);
      else setError(err.message);
    },
    [onError],
  );

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        setData(await api.overview(refresh));
        setError('');
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    },
    [api, fail],
  );

  useEffect(() => {
    setData(null);
    setShowSettings(false);
    load();
  }, [load]);

  // Mientras el agente analiza, se consulta cada tanto hasta que termine
  const running = data?.lastRun?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => load(), POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  // Acción sobre el servidor con el botón en "cargando" y recarga al terminar
  const act = async (key, fn, { refresh = false } = {}) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load(refresh);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <>
        {error && <div className="alert">{error}</div>}
        <div className="empty">{loading ? 'Cargando pauta…' : ''}</div>
      </>
    );
  }

  const { configured, settings, snapshot, shop } = data;
  const connected = configured.metaToken && configured.metaAccount;

  return (
    <div className="pauta">
      <div className="pauta-head">
        <div>
          <h2>Pauta en Meta</h2>
          <small className="muted">
            {data.lastRun
              ? `Último análisis: ${when(data.lastRun.started_at)} · ${RUN_LABELS[data.lastRun.status]}`
              : 'El agente todavía no analizó la cuenta'}
            {!settings.agent_enabled && ' · Agente apagado'}
          </small>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? 'Cerrar ajustes' : 'Ajustes'}
          </button>
          <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
            Actualizar
          </button>
          <button
            className="btn primary"
            onClick={() => act('run', api.startRun)}
            disabled={!connected || !configured.agent || running || busy === 'run'}
            title={!connected ? 'Primero conectá la cuenta de Meta en Ajustes' : ''}
          >
            {running ? 'Analizando…' : 'Analizar ahora'}
          </button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {showSettings && (
        <SettingsForm
          settings={settings}
          onSave={async (patch) => {
            await api.saveSettings(patch);
            setShowSettings(false);
            await load(true);
          }}
        />
      )}

      {!configured.metaToken && (
        <div className="notice">
          Falta el token de Meta en el servidor (META_ACCESS_TOKEN). Mientras tanto podés dejar cargados los ajustes.
        </div>
      )}
      {configured.metaToken && !configured.metaAccount && (
        <div className="notice">
          Falta conectar la cuenta publicitaria de esta tienda.{' '}
          <button className="link" onClick={() => setShowSettings(true)}>
            Cargarla en Ajustes
          </button>
        </div>
      )}
      {!configured.agent && (
        <div className="notice">
          Falta la clave de Claude en el servidor (ANTHROPIC_API_KEY): el agente no puede analizar.
        </div>
      )}
      {data.metaError && <div className="alert">Meta: {data.metaError}</div>}
      {data.shopError && <div className="alert">Tienda Nube: {data.shopError}</div>}
      {data.lastRun?.status === 'failed' && <div className="alert">El último análisis falló: {data.lastRun.error}</div>}

      <Stats snapshot={snapshot} shop={shop} settings={settings} />

      {shop?.upcomingClasses?.length > 0 && <Upcoming classes={shop.upcomingClasses} />}

      {data.lastRun?.report && data.lastRun.status !== 'running' && (
        <section className="card pad">
          <h3>Informe del agente</h3>
          <Report text={data.lastRun.report} />
        </section>
      )}

      <section>
        <h3 className="section-title">
          Para aprobar {data.pending.length > 0 && <span className="pill">{data.pending.length}</span>}
        </h3>
        {data.pending.length === 0 ? (
          <p className="muted">No hay recomendaciones pendientes.</p>
        ) : (
          data.pending.map((d) => (
            <Decision
              key={d.id}
              d={d}
              busy={busy}
              connected={connected}
              onApprove={() => act(`ok-${d.id}`, () => api.approve(d.id), { refresh: true })}
              onReject={() => act(`no-${d.id}`, () => api.reject(d.id))}
            />
          ))
        )}
      </section>

      {data.questions.length > 0 && (
        <section>
          <h3 className="section-title">
            Preguntas del agente <span className="pill">{data.questions.length}</span>
          </h3>
          {data.questions.map((q) => (
            <Question
              key={q.id}
              q={q}
              busy={busy === `q-${q.id}`}
              onAnswer={(answer) => act(`q-${q.id}`, () => api.answer(q.id, answer))}
              onDismiss={() => act(`q-${q.id}`, () => api.dismiss(q.id))}
            />
          ))}
        </section>
      )}

      {data.requests.length > 0 && (
        <section>
          <h3 className="section-title">Piezas que pide el agente</h3>
          {data.requests.map((r) => (
            <div key={r.id} className="card pad item">
              <div className="item-body">
                <strong>{r.concept}</strong>
                <p>{r.style_notes}</p>
                {r.reason && <p className="muted">{r.reason}</p>}
              </div>
              <button
                className="btn"
                disabled={busy === `r-${r.id}`}
                onClick={() => act(`r-${r.id}`, () => api.requestDone(r.id))}
              >
                Ya está
              </button>
            </div>
          ))}
        </section>
      )}

      {snapshot && (
        <Structure
          snapshot={snapshot}
          busy={busy}
          onStatus={(o, level, status) =>
            act(`s-${o.id}`, () => api.setStatus(o.id, { level, status, name: o.name }), { refresh: true })
          }
        />
      )}

      <History api={api} onError={fail} key={`${store}-${data.lastRun?.id}`} />
    </div>
  );
}

function Stats({ snapshot, shop, settings }) {
  const cap = settings.monthly_cap_ars;
  const spent = snapshot?.month.spend ?? 0;
  const sales = shop?.sales;
  return (
    <div className="stats">
      <div className="card stat">
        <small>Gasto del mes</small>
        <strong>{snapshot ? money(spent) : '—'}</strong>
        <span className="muted">{cap ? `de ${money(cap)}` : 'Sin tope definido'}</span>
        {cap > 0 && snapshot && (
          <div className="bar">
            <span
              style={{
                width: `${Math.min(100, (spent / cap) * 100)}%`,
                background: spent > cap ? 'var(--danger)' : undefined,
              }}
            />
          </div>
        )}
      </div>
      <div className="card stat">
        <small>Gasto hoy</small>
        <strong>{snapshot ? money(snapshot.spendToday) : '—'}</strong>
        <span className="muted">7 días: {snapshot ? money(snapshot.last7d.spend) : '—'}</span>
      </div>
      <div className="card stat">
        <small>Ventas según Meta · 7 días</small>
        <strong>{snapshot ? snapshot.last7d.purchases : '—'}</strong>
        <span className="muted">
          {snapshot?.last7d.costPerPurchase ? `${money(snapshot.last7d.costPerPurchase)} c/u` : 'Sin costo por venta'}
          {snapshot?.last7d.roas != null && ` · ROAS ${snapshot.last7d.roas}`}
        </span>
      </div>
      <div className="card stat">
        <small>Ventas en la tienda · 7 días</small>
        <strong>{sales ? `${sales.last7d.tickets} entradas` : '—'}</strong>
        <span className="muted">
          {sales ? `${money(sales.last7d.revenue)} · ${sales.last7d.fromMetaOrders} desde Meta` : ''}
        </span>
      </div>
    </div>
  );
}

function Upcoming({ classes }) {
  return (
    <section>
      <h3 className="section-title">Próximas fechas</h3>
      <div className="upcoming">
        {classes.slice(0, 8).map((c) => (
          <div key={`${c.date}-${c.place}`} className="card upcoming-item">
            <div className="upcoming-head">
              <strong>{formatDate(c.date)}</strong>
              <span className={`pill ${c.left === 0 ? 'full' : c.daysUntil <= 3 && c.fillPct < 60 ? 'warn' : ''}`}>
                {c.left === 0 ? 'Completo' : `${c.left} libres`}
              </span>
            </div>
            <small className="muted">
              {c.place}
              {!c.published && ' · No publicada'}
            </small>
            {c.capacity > 0 && (
              <div className="bar">
                <span style={{ width: `${c.fillPct}%` }} />
              </div>
            )}
            <small className="muted">
              {c.booked} anotados{c.fillPct != null && ` · ${c.fillPct}%`}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function DecisionDetail({ d }) {
  const i = d.input || {};
  if (d.tool === 'propose_budget_change') {
    return (
      <p className="detail">
        {i.object_name || i.object_id}: {money(i.current_budget_ars)} → <strong>{money(i.proposed_budget_ars)}</strong>{' '}
        por día
      </p>
    );
  }
  if (d.tool === 'propose_campaign')
    return (
      <p className="detail">
        {i.name} · {money(i.daily_budget_ars)} por día (nace pausada)
      </p>
    );
  if (d.tool === 'propose_adset') return <p className="detail">{i.name} (nace pausado)</p>;
  if (d.tool === 'promote_ig_post') {
    return (
      <p className="detail">
        {i.permalink && (
          <a href={i.permalink} target="_blank" rel="noreferrer">
            Ver post
          </a>
        )}{' '}
        → {i.adset_name || i.adset_id}
        {i.link && (
          <>
            {' '}
            · lleva a{' '}
            <a href={i.link} target="_blank" rel="noreferrer">
              {i.link.replace(/^https?:\/\//, '').slice(0, 50)}
            </a>
          </>
        )}
      </p>
    );
  }
  if (d.tool === 'set_status')
    return (
      <p className="detail">
        {i.object_name || i.object_id} → {i.status === 'ACTIVE' ? 'activar' : 'pausar'}
      </p>
    );
  if (d.tool === 'pause_ad') return <p className="detail">{i.ad_name || i.ad_id}</p>;
  if (d.tool === 'reuse_ad')
    return (
      <p className="detail">
        Anuncio {i.source_ad_id} → {i.adset_name || i.adset_id}
      </p>
    );
  return null;
}

function Decision({ d, busy, connected, onApprove, onReject }) {
  return (
    <div className="card pad decision">
      <div className="decision-head">
        <span className="tag">{TOOL_LABELS[d.tool] || d.tool}</span>
        <small className="muted">{when(d.created_at)}</small>
      </div>
      <strong>{d.title}</strong>
      <DecisionDetail d={d} />
      {d.reason && <p>{d.reason}</p>}
      {d.expected_impact && <p className="muted">Qué esperamos: {d.expected_impact}</p>}
      <div className="decision-actions">
        <button className="btn ghost" disabled={!!busy} onClick={onReject}>
          Rechazar
        </button>
        <button className="btn primary" disabled={!!busy || !connected} onClick={onApprove}>
          {busy === `ok-${d.id}` ? 'Aplicando…' : 'Aprobar'}
        </button>
      </div>
    </div>
  );
}

function Question({ q, busy, onAnswer, onDismiss }) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="card pad question">
      <strong>{q.question}</strong>
      {q.why && <p className="muted">{q.why}</p>}
      {q.quick_answers?.length > 0 && (
        <div className="quick">
          {q.quick_answers.map((a) => (
            <button key={a} className="btn" disabled={busy} onClick={() => onAnswer(a)}>
              {a}
            </button>
          ))}
        </div>
      )}
      <form
        className="answer"
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) onAnswer(answer.trim());
        }}
      >
        <input
          className="search"
          placeholder="Escribí la respuesta…"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <button className="btn primary" disabled={busy || !answer.trim()}>
          Responder
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onDismiss}>
          Descartar
        </button>
      </form>
    </div>
  );
}

function Structure({ snapshot, busy, onStatus }) {
  const adsByAdset = new Map();
  for (const a of snapshot.ads) {
    if (!adsByAdset.has(a.adsetId)) adsByAdset.set(a.adsetId, []);
    adsByAdset.get(a.adsetId).push(a);
  }
  if (!snapshot.campaigns.length) return <p className="muted">La cuenta no tiene campañas todavía.</p>;
  const toggle = (o, level) => (
    <button
      className="btn ghost small"
      disabled={busy === `s-${o.id}`}
      onClick={() => onStatus(o, level, o.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')}
    >
      {o.status === 'ACTIVE' ? 'Pausar' : 'Activar'}
    </button>
  );
  return (
    <section>
      <h3 className="section-title">Campañas · últimos 7 días</h3>
      {snapshot.campaigns.map((c) => (
        <div key={c.id} className="card pad campaign">
          <div className="campaign-head">
            <div>
              <strong>{c.name}</strong>
              <small className="muted">
                {' '}
                · {META_STATUS[c.effectiveStatus] || c.effectiveStatus}
                {c.dailyBudgetArs ? ` · ${money(c.dailyBudgetArs)}/día` : ''}
              </small>
            </div>
            {toggle(c, 'campaign')}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Conjunto / anuncio</th>
                  <th className="num">Gasto</th>
                  <th className="num">Ventas</th>
                  <th className="num">Costo x venta</th>
                  <th className="num">CTR</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {snapshot.adsets
                  .filter((a) => a.campaignId === c.id)
                  .flatMap((a) => [
                    <tr key={a.id} className="adset-row">
                      <td data-label="Conjunto">
                        <strong>{a.name}</strong>
                        <div className="note">
                          {META_STATUS[a.effectiveStatus] || a.effectiveStatus}
                          {a.dailyBudgetArs ? ` · ${money(a.dailyBudgetArs)}/día` : ''}
                          {a.learningStage === 'LEARNING' ? ' · Aprendiendo' : ''}
                        </div>
                      </td>
                      <td data-label="Gasto" className="num">
                        {money(a.last7d.spend)}
                      </td>
                      <td data-label="Ventas" className="num">
                        {a.last7d.purchases}
                      </td>
                      <td data-label="Costo x venta" className="num">
                        {money(a.last7d.costPerPurchase)}
                      </td>
                      <td data-label="CTR" className="num">
                        {a.last7d.impressions ? `${((a.last7d.clicks / a.last7d.impressions) * 100).toFixed(2)}%` : '—'}
                      </td>
                      <td>{toggle(a, 'adset')}</td>
                    </tr>,
                    ...(adsByAdset.get(a.id) ?? []).map((ad) => (
                      <tr key={ad.id} className={ad.status === 'ACTIVE' ? '' : 'inactive-ad'}>
                        <td data-label="Anuncio" className="ad-cell">
                          {ad.thumbnail && <img src={ad.thumbnail} alt="" />}
                          <div>
                            {ad.name}
                            <div className="note">{META_STATUS[ad.effectiveStatus] || ad.effectiveStatus}</div>
                          </div>
                        </td>
                        <td data-label="Gasto" className="num">
                          {money(ad.last7d.spend)}
                        </td>
                        <td data-label="Ventas" className="num">
                          {ad.last7d.purchases}
                        </td>
                        <td data-label="Costo x venta" className="num">
                          {money(ad.last7d.costPerPurchase)}
                        </td>
                        <td data-label="CTR" className="num">
                          {ad.last7d.ctr != null ? `${ad.last7d.ctr}%` : '—'}
                        </td>
                        <td>{toggle(ad, 'ad')}</td>
                      </tr>
                    )),
                  ])}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

// Historial y aprendizajes: se cargan solo si se abren
function History({ api, onError }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!open || state) return;
    Promise.all([api.decisions(), api.learnings(), api.runs()])
      .then(([d, l, r]) =>
        setState({
          decisions: d.decisions.filter((x) => x.status !== 'pending'),
          learnings: l.learnings,
          runs: r.runs,
        }),
      )
      .catch(onError);
  }, [open, state, api, onError]);

  const removeLearning = async (id) => {
    try {
      await api.deleteLearning(id);
      setState((s) => ({ ...s, learnings: s.learnings.filter((l) => l.id !== id) }));
    } catch (err) {
      onError(err);
    }
  };

  return (
    <details className="card pad history" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Historial, análisis anteriores y aprendizajes</summary>
      {!state ? (
        <p className="muted">Cargando…</p>
      ) : (
        <>
          <h4>Decisiones</h4>
          {state.decisions.length === 0 && <p className="muted">Todavía no hay decisiones.</p>}
          {state.decisions.map((d) => (
            <div key={d.id} className="history-item">
              <span className={`status ${d.status === 'executed' ? 'paid' : d.status === 'failed' ? 'refunded' : ''}`}>
                {STATUS_LABELS[d.status]}
              </span>
              <div>
                <strong>{d.title}</strong>
                <small className="muted">
                  {' '}
                  · {TOOL_LABELS[d.tool] || d.tool} · {when(d.decided_at || d.created_at)}
                  {d.decided_by && ` · ${d.decided_by}`}
                </small>
                {d.error && <div className="note">{d.error}</div>}
                {d.outcome && <div className="note">Resultado: {d.outcome}</div>}
              </div>
            </div>
          ))}

          <h4>Aprendizajes</h4>
          {state.learnings.length === 0 && <p className="muted">El agente todavía no guardó aprendizajes.</p>}
          {state.learnings.map((l) => (
            <div key={l.id} className="history-item">
              <div>
                <strong className={l.status === 'obsolete' ? 'obsolete' : ''}>{l.text}</strong>
                <div className="note">{l.evidence}</div>
              </div>
              <button className="btn ghost small" onClick={() => removeLearning(l.id)}>
                Borrar
              </button>
            </div>
          ))}

          <h4>Análisis anteriores</h4>
          {state.runs.map((r) => (
            <details key={r.id} className="run">
              <summary>
                {when(r.started_at)} · {RUN_LABELS[r.status]}
                {r.kind === 'daily' ? ' · diario' : r.started_by ? ` · ${r.started_by}` : ''}
              </summary>
              {r.report ? <Report text={r.report} /> : <p className="muted">{r.error || 'Sin informe'}</p>}
            </details>
          ))}
        </>
      )}
    </details>
  );
}
