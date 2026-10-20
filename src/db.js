// Postgres para la pauta (los turnos se leen directo de Tienda Nube y no necesitan base).
// db es cualquier cosa con query(sql, params) -> { rows, rowCount }: pg.Pool en producción, PGlite en tests.

// Cada tabla lleva store_key: cada tienda tiene su cuenta de Meta, presupuesto, contexto e historial propios
const MIGRATIONS = [
  `
  CREATE TABLE pauta_settings (
    store_key text PRIMARY KEY,
    agent_enabled boolean NOT NULL DEFAULT true,
    -- Con autonomous=false TODO lo que el agente quiere hacer queda pendiente de aprobación
    autonomous boolean NOT NULL DEFAULT false,
    monthly_cap_ars integer CHECK (monthly_cap_ars >= 0),
    target_cpa_ars integer CHECK (target_cpa_ars >= 0),
    business_notes text NOT NULL DEFAULT '',
    meta_ad_account_id text NOT NULL DEFAULT '',
    meta_page_id text NOT NULL DEFAULT '',
    meta_ig_user_id text NOT NULL DEFAULT '',
    meta_pixel_id text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE pauta_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('daily','manual')),
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','skipped')),
    report text NOT NULL DEFAULT '',
    error text,
    started_by text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE INDEX pauta_runs_recent ON pauta_runs (store_key, started_at DESC);

  CREATE TABLE pauta_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_key text NOT NULL,
    run_id uuid REFERENCES pauta_runs(id) ON DELETE SET NULL,
    tool text NOT NULL,
    input jsonb NOT NULL DEFAULT '{}',
    title text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    expected_impact text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('pending','executing','executed','rejected','failed')),
    result jsonb,
    error text,
    outcome text,
    decided_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
  );
  CREATE INDEX pauta_decisions_recent ON pauta_decisions (store_key, created_at DESC);

  CREATE TABLE pauta_creative_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_key text NOT NULL,
    concept text NOT NULL,
    style_notes text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz
  );

  CREATE TABLE pauta_learnings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_key text NOT NULL,
    text text NOT NULL,
    evidence text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','obsolete')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE pauta_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_key text NOT NULL,
    run_id uuid REFERENCES pauta_runs(id) ON DELETE SET NULL,
    question text NOT NULL,
    why text NOT NULL DEFAULT '',
    quick_answers jsonb NOT NULL DEFAULT '[]',
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
    answer text,
    answered_by text,
    answered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Posts de IG promocionados: la fila se reserva antes de llamar a Meta y el UNIQUE impide duplicar
  CREATE TABLE pauta_ig_promotions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_key text NOT NULL,
    ig_media_id text NOT NULL,
    permalink text NOT NULL DEFAULT '',
    meta_ad_id text,
    meta_adset_id text NOT NULL,
    adset_name text NOT NULL DEFAULT '',
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (store_key, ig_media_id, meta_adset_id)
  );
  `,
];

export async function migrate(db) {
  // La transacción tiene que ir por una sola conexión: con pg.Pool se pide un cliente
  const conn = db.connect ? await db.connect() : db;
  try {
    await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await conn.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations');
    for (let v = Number(rows[0].v) + 1; v <= MIGRATIONS.length; v++) {
      await conn.query('BEGIN');
      try {
        for (const stmt of MIGRATIONS[v - 1].split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await conn.query(stmt);
        await conn.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await conn.query('COMMIT');
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (conn !== db) conn.release();
  }
}

export async function connect(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await migrate(pool);
  return pool;
}
