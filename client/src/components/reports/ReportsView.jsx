import { useCallback, useEffect, useMemo, useState } from 'react';
import { pautaApi } from '../../api.js';
import { formatMoney, todayISO } from '../../utils.js';
import { COLORS, ColumnChart, LineChart, shortDate } from './charts.jsx';

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
};

const PRESETS = [
  ['7d', 'Últimos 7 días', () => ({ since: addDays(todayISO(), -6), until: todayISO() })],
  ['30d', 'Últimos 30 días', () => ({ since: addDays(todayISO(), -29), until: todayISO() })],
  ['month', 'Este mes', () => ({ since: `${todayISO().slice(0, 8)}01`, until: todayISO() })],
  [
    'last',
    'Mes pasado',
    () => {
      const first = new Date(`${todayISO().slice(0, 8)}01T12:00:00`);
      const prevLast = new Date(first);
      prevLast.setDate(0);
      return { since: `${iso(prevLast).slice(0, 8)}01`, until: iso(prevLast) };
    },
  ],
];

const money = (n) => (n == null ? '—' : formatMoney(n));
const int = new Intl.NumberFormat('es-AR');
const num = (n) => (n == null ? '—' : int.format(n));
const longDate = (d) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });

// Variación contra el período anterior. good: 'up' si subir es bueno, 'down' si bajar es bueno, null si es neutro
function Delta({ now, before, good }) {
  if (now == null || before == null || before === 0)
    return <span className="delta muted">Sin datos del período anterior</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className="delta muted">= igual que el período anterior</span>;
  const up = pct > 0;
  const tone = !good ? 'neutral' : (up && good === 'up') || (!up && good === 'down') ? 'good' : 'bad';
  return (
    <span className={`delta ${tone}`}>
      {up ? '▲' : '▼'} {Math.abs(pct)}% vs período anterior
    </span>
  );
}

function Tile({ label, value, delta, hint }) {
  return (
    <div className="card stat">
      <small>{label}</small>
      <strong>{value}</strong>
      {delta}
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
}

export default function ReportsView({ token, store, storeName, onError }) {
  const api = useMemo(() => pautaApi(token, store), [token, store]);
  const [preset, setPreset] = useState('30d');
  const [range, setRange] = useState(() => PRESETS[1][2]());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        setData(await api.report(range.since, range.until, refresh));
        setError('');
      } catch (err) {
        if (err.unauthorized) onError(err);
        else setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [api, range, onError],
  );

  useEffect(() => {
    load();
  }, [load]);

  const pick = (key) => {
    setPreset(key);
    if (key !== 'custom') setRange(PRESETS.find((p) => p[0] === key)[2]());
  };
  const setCustom = (field) => (e) => {
    if (!e.target.value) return;
    setPreset('custom');
    setRange((r) => ({ ...r, [field]: e.target.value }));
  };

  const meta = data?.meta;
  const shop = data?.shop;
  // Ventas por día: lo que reporta Meta al lado de las órdenes reales de la tienda
  const salesDaily = useMemo(() => {
    if (!shop) return [];
    const byDate = new Map((meta?.daily ?? []).map((d) => [d.date, d]));
    return shop.daily.map((d) => ({
      date: d.date,
      metaPurchases: byDate.get(d.date)?.purchases ?? 0,
      shopOrders: d.orders,
      fromMeta: d.fromMeta,
      spend: byDate.get(d.date)?.spend ?? 0,
      revenue: d.revenue,
    }));
  }, [meta, shop]);

  return (
    <div className={`reports ${loading && data ? 'is-loading' : ''}`}>
      <div className="report-head">
        <div>
          <h2>Resultados de la pauta · {storeName}</h2>
          <small className="muted">
            {longDate(range.since)} al {longDate(range.until)}
            {data &&
              ` · comparado con ${shortDate(data.range.previous.since)} al ${shortDate(data.range.previous.until)}`}
          </small>
        </div>
        <div className="actions no-print">
          <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
            Actualizar
          </button>
          <button className="btn" onClick={() => window.print()} disabled={!data}>
            Descargar PDF
          </button>
        </div>
      </div>

      <div className="report-filters no-print">
        <div className="segmented">
          {PRESETS.map(([key, label]) => (
            <button key={key} className={preset === key ? 'active' : ''} onClick={() => pick(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="custom-range">
          <input type="date" value={range.since} max={range.until} onChange={setCustom('since')} aria-label="Desde" />
          <span className="muted">al</span>
          <input
            type="date"
            value={range.until}
            min={range.since}
            max={todayISO()}
            onChange={setCustom('until')}
            aria-label="Hasta"
          />
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {!data && loading && <div className="empty">Armando el reporte…</div>}

      {data && (
        <>
          {!meta && !data.metaError && (
            <div className="notice no-print">
              {data.configured.metaToken
                ? 'Falta conectar la cuenta publicitaria en Pauta → Ajustes.'
                : 'Todavía no está conectado Meta.'}{' '}
              Por ahora el reporte muestra solo las ventas de la tienda.
            </div>
          )}
          {data.metaError && <div className="alert">Meta: {data.metaError}</div>}
          {data.shopError && <div className="alert">Tienda Nube: {data.shopError}</div>}

          {meta && (
            <section>
              <h3 className="section-title">Meta Ads</h3>
              <div className="stats">
                <Tile
                  label="Inversión"
                  value={money(meta.totals.spend)}
                  delta={<Delta now={meta.totals.spend} before={meta.previousTotals.spend} />}
                />
                <Tile
                  label="Ventas atribuidas"
                  value={num(meta.totals.purchases)}
                  delta={<Delta now={meta.totals.purchases} before={meta.previousTotals.purchases} good="up" />}
                  hint={`${money(meta.totals.purchaseValue)} facturados`}
                />
                <Tile
                  label="Costo por venta"
                  value={money(meta.totals.costPerPurchase)}
                  delta={
                    <Delta now={meta.totals.costPerPurchase} before={meta.previousTotals.costPerPurchase} good="down" />
                  }
                />
                <Tile
                  label="Retorno (ROAS)"
                  value={meta.totals.roas != null ? `${String(meta.totals.roas).replace('.', ',')}x` : '—'}
                  delta={<Delta now={meta.totals.roas} before={meta.previousTotals.roas} good="up" />}
                  hint="Pesos facturados por cada peso invertido"
                />
              </div>
              <div className="mini-stats">
                <div>
                  <small>Personas alcanzadas</small>
                  <strong>{num(meta.totals.reach)}</strong>
                </div>
                <div>
                  <small>Impresiones</small>
                  <strong>{num(meta.totals.impressions)}</strong>
                </div>
                <div>
                  <small>Clics</small>
                  <strong>{num(meta.totals.clicks)}</strong>
                </div>
                <div>
                  <small>CTR</small>
                  <strong>{meta.totals.ctr != null ? `${String(meta.totals.ctr).replace('.', ',')}%` : '—'}</strong>
                </div>
                <div>
                  <small>Costo por mil (CPM)</small>
                  <strong>{money(meta.totals.cpm)}</strong>
                </div>
              </div>
            </section>
          )}

          {shop && (
            <section>
              <h3 className="section-title">Tienda Nube</h3>
              <div className="stats three">
                <Tile
                  label="Entradas vendidas"
                  value={num(shop.totals.tickets)}
                  delta={<Delta now={shop.totals.tickets} before={shop.previousTotals.tickets} good="up" />}
                  hint={`${num(shop.totals.orders)} órdenes pagadas`}
                />
                <Tile
                  label="Facturación"
                  value={money(shop.totals.revenue)}
                  delta={<Delta now={shop.totals.revenue} before={shop.previousTotals.revenue} good="up" />}
                />
                <Tile
                  label="Órdenes que llegaron desde Meta"
                  value={num(shop.totals.fromMetaOrders)}
                  hint={`${money(shop.totals.fromMetaRevenue)} · entraron con un clic en un anuncio o post`}
                />
              </div>
            </section>
          )}

          <div className="chart-grid">
            {meta && (
              <section className="card pad">
                <h3>Inversión por día</h3>
                <ColumnChart
                  data={meta.daily}
                  valueKey="spend"
                  format={money}
                  color={COLORS.meta}
                  label="Inversión por día en Meta"
                />
              </section>
            )}
            {shop && (
              <section className="card pad">
                <h3>Ventas por día</h3>
                <LineChart
                  data={salesDaily}
                  format={num}
                  label="Ventas por día"
                  series={[
                    ...(meta ? [{ key: 'metaPurchases', label: 'Atribuidas por Meta', color: COLORS.meta }] : []),
                    { key: 'shopOrders', label: 'Órdenes en la tienda', color: COLORS.shop },
                  ]}
                />
              </section>
            )}
          </div>

          {meta && <Funnel totals={meta.totals} />}

          {meta?.campaigns.length > 0 && (
            <section className="card pad">
              <h3>Campañas</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Campaña</th>
                      <th className="num">Inversión</th>
                      <th className="num">Ventas</th>
                      <th className="num">Costo x venta</th>
                      <th className="num">ROAS</th>
                      <th className="num">CTR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td data-label="Campaña">
                          <strong>{c.name}</strong>
                        </td>
                        <td data-label="Inversión" className="num">
                          {money(c.spend)}
                        </td>
                        <td data-label="Ventas" className="num">
                          {num(c.purchases)}
                        </td>
                        <td data-label="Costo x venta" className="num">
                          {money(c.costPerPurchase)}
                        </td>
                        <td data-label="ROAS" className="num">
                          {c.roas != null ? `${String(c.roas).replace('.', ',')}x` : '—'}
                        </td>
                        <td data-label="CTR" className="num">
                          {c.ctr != null ? `${String(c.ctr).replace('.', ',')}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {meta?.ads.length > 0 && (
            <section>
              <h3 className="section-title">Anuncios con más inversión</h3>
              <div className="ad-grid">
                {meta.ads.slice(0, 6).map((a) => (
                  <div key={a.id} className="card ad-card">
                    {a.thumbnail ? <img src={a.thumbnail} alt="" /> : <div className="ad-thumb-empty" />}
                    <div className="ad-card-body">
                      <strong title={a.name}>{a.name}</strong>
                      <small className="muted">{a.adsetName}</small>
                      <dl>
                        <div>
                          <dt>Inversión</dt>
                          <dd>{money(a.spend)}</dd>
                        </div>
                        <div>
                          <dt>Ventas</dt>
                          <dd>{num(a.purchases)}</dd>
                        </div>
                        <div>
                          <dt>Por venta</dt>
                          <dd>{money(a.costPerPurchase)}</dd>
                        </div>
                        <div>
                          <dt>CTR</dt>
                          <dd>{a.ctr != null ? `${String(a.ctr).replace('.', ',')}%` : '—'}</dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <details className="card pad history">
            <summary>Ver los datos día por día</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Día</th>
                    {meta && <th className="num">Inversión</th>}
                    {meta && <th className="num">Ventas Meta</th>}
                    <th className="num">Órdenes tienda</th>
                    <th className="num">Desde Meta</th>
                    <th className="num">Facturación tienda</th>
                  </tr>
                </thead>
                <tbody>
                  {salesDaily.map((d) => (
                    <tr key={d.date}>
                      <td data-label="Día">{shortDate(d.date)}</td>
                      {meta && (
                        <td data-label="Inversión" className="num">
                          {money(d.spend)}
                        </td>
                      )}
                      {meta && (
                        <td data-label="Ventas Meta" className="num">
                          {d.metaPurchases}
                        </td>
                      )}
                      <td data-label="Órdenes" className="num">
                        {d.shopOrders}
                      </td>
                      <td data-label="Desde Meta" className="num">
                        {d.fromMeta}
                      </td>
                      <td data-label="Facturación" className="num">
                        {money(d.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p className="updated">
            Ventas atribuidas: compras que Meta asocia a un anuncio (clic hasta 7 días o vista en 1 día antes). Órdenes
            desde Meta: las que entraron a la tienda con un clic de Meta. Son dos formas de medir y no tienen por qué
            coincidir.
          </p>
        </>
      )}
    </div>
  );
}

// Embudo: de las impresiones a la compra, con la conversión de cada paso
function Funnel({ totals }) {
  const steps = [
    ['Impresiones', totals.impressions],
    ['Clics', totals.clicks],
    ['Visitas a la tienda', totals.landingViews],
    ['Agregaron al carrito', totals.addToCart],
    ['Iniciaron el pago', totals.checkouts],
    ['Compraron', totals.purchases],
  ].filter(([label, v], i) => i < 2 || label === 'Compraron' || v > 0);
  return (
    <section className="card pad">
      <h3>Del anuncio a la compra</h3>
      <ol className="funnel">
        {steps.map(([label, value], i) => (
          <li key={label}>
            <strong>{num(value)}</strong>
            <span>{label}</span>
            {i > 0 && steps[i - 1][1] > 0 && (
              <small className="muted">
                {String(((value / steps[i - 1][1]) * 100).toFixed(1)).replace('.', ',')}% del paso anterior
              </small>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
