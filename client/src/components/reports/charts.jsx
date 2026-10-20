import { useEffect, useRef, useState } from 'react';

// Gráficos en SVG propio: columnas (una serie) y líneas (varias series de la misma unidad).
// Colores validados contra daltonismo: Meta = azul, Tienda Nube = naranja.
export const COLORS = { meta: '#3a72b0', shop: '#e0712f' };

const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Ticks "redondos" para el eje Y: 0 / 5 mil / 10 mil…
function niceTicks(max, count = 4) {
  if (!max || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

const compact = new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 });
export const shortDate = (iso) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

// Fechas del eje X: unas 6 marcas repartidas, siempre la primera y la última
function xLabelIndexes(n) {
  if (n <= 7) return [...Array(n).keys()];
  const step = Math.ceil((n - 1) / 5);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out.at(-1) !== n - 1) out[out.length - 1] = n - 1;
  return out;
}

function Frame({ width, ticks, y, n, x, data, children }) {
  const innerW = width - PAD.left - PAD.right;
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={PAD.left + innerW} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.left - 8} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">
            {compact.format(t)}
          </text>
        </g>
      ))}
      {xLabelIndexes(n).map((i) => (
        <text key={i} x={x(i)} y={H - 6} className="axis" textAnchor="middle">
          {shortDate(data[i].date)}
        </text>
      ))}
      {children}
    </>
  );
}

// El tooltip va al costado del punto, del lado con más lugar, para no tapar la línea
function Tooltip({ x, width, children }) {
  const right = x < width / 2;
  return (
    <div className="chart-tip" style={right ? { left: x + 12 } : { right: width - x + 12 }}>
      {children}
    </div>
  );
}

// Columnas de una serie (ej. inversión por día). El título de la tarjeta nombra la serie.
export function ColumnChart({ data, valueKey, format, color, label }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const n = data.length;
  const ticks = niceTicks(Math.max(...data.map((d) => d[valueKey])));
  const top = ticks.at(-1);
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const band = n ? innerW / n : 0;
  const barW = Math.max(2, Math.min(24, band - 2));
  const x = (i) => PAD.left + band * i + band / 2;
  const y = (v) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / top);
  const base = y(0);

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={label}>
          <Frame width={width} ticks={ticks} y={y} n={n} x={x} data={data}>
            {data.map((d, i) => {
              const v = d[valueKey];
              const h = base - y(v);
              const r = Math.min(4, barW / 2, h);
              const x0 = x(i) - barW / 2;
              // Punta redondeada arriba, recta contra la base
              const path =
                h > 0
                  ? `M${x0},${base} V${base - h + r} Q${x0},${base - h} ${x0 + r},${base - h} H${x0 + barW - r} Q${x0 + barW},${base - h} ${x0 + barW},${base - h + r} V${base} Z`
                  : '';
              return (
                <g key={d.date}>
                  {path && <path d={path} fill={color} opacity={hover == null || hover === i ? 1 : 0.55} />}
                  <rect
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={H - PAD.top - PAD.bottom}
                    fill="transparent"
                    tabIndex={0}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </Frame>
        </svg>
      )}
      {hover != null && (
        <Tooltip x={x(hover)} width={width}>
          <strong>{format(data[hover][valueKey])}</strong>
          <span>{shortDate(data[hover].date)}</span>
        </Tooltip>
      )}
    </div>
  );
}

// Líneas de varias series con la misma unidad (ej. ventas según Meta vs órdenes en la tienda)
export function LineChart({ data, series, format, label }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const n = data.length;
  const ticks = niceTicks(Math.max(...data.flatMap((d) => series.map((s) => d[s.key] ?? 0))));
  const top = ticks.at(-1);
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const x = (i) => PAD.left + (n > 1 ? (innerW * i) / (n - 1) : innerW / 2);
  const y = (v) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / top);

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = n > 1 ? Math.round(((e.clientX - box.left - PAD.left) / innerW) * (n - 1)) : 0;
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div>
      <div className="legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="chart" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={label}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <Frame width={width} ticks={ticks} y={y} n={n} x={x} data={data}>
              {hover != null && (
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
              )}
              {series.map((s) => (
                <g key={s.key}>
                  <polyline
                    points={data.map((d, i) => `${x(i)},${y(d[s.key] ?? 0)}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {hover != null && (
                    <circle
                      cx={x(hover)}
                      cy={y(data[hover][s.key] ?? 0)}
                      r="4.5"
                      fill={s.color}
                      stroke="var(--card)"
                      strokeWidth="2"
                    />
                  )}
                </g>
              ))}
            </Frame>
          </svg>
        )}
        {hover != null && (
          <Tooltip x={x(hover)} width={width}>
            <span>{shortDate(data[hover].date)}</span>
            {series.map((s) => (
              <div key={s.key} className="tip-row">
                <i style={{ background: s.color }} />
                <strong>{format(data[hover][s.key] ?? 0)}</strong>
                <span>{s.label}</span>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
    </div>
  );
}
