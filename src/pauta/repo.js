import { conflict, notFound } from '../errors.js';

// Todo lo de la pauta, siempre filtrado por tienda (store_key)
export const SETTINGS_FIELDS = [
  'agent_enabled', 'autonomous', 'monthly_cap_ars', 'target_cpa_ars', 'business_notes',
  'meta_ad_account_id', 'meta_page_id', 'meta_ig_user_id', 'meta_pixel_id',
];

export function createPautaRepo(db) {
  const one = async (sql, params, msg) => {
    const { rows } = await db.query(sql, params);
    if (!rows[0] && msg) throw notFound(msg);
    return rows[0];
  };
  const all = async (sql, params) => (await db.query(sql, params)).rows;

  return {
    // La fila de ajustes se crea la primera vez que se pide
    async getSettings(store) {
      await db.query('INSERT INTO pauta_settings (store_key) VALUES ($1) ON CONFLICT (store_key) DO NOTHING', [store]);
      return one(`SELECT store_key, ${SETTINGS_FIELDS.join(', ')}, updated_at FROM pauta_settings WHERE store_key = $1`, [store]);
    },
    async updateSettings(store, patch) {
      await this.getSettings(store);
      const cols = Object.keys(patch).filter((c) => SETTINGS_FIELDS.includes(c));
      if (!cols.length) return this.getSettings(store);
      const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await db.query(`UPDATE pauta_settings SET ${set}, updated_at = now() WHERE store_key = $1`, [store, ...cols.map((c) => patch[c])]);
      return this.getSettings(store);
    },

    startRun: (store, kind, userName) => one('INSERT INTO pauta_runs (store_key, kind, started_by) VALUES ($1, $2, $3) RETURNING *', [store, kind, userName ?? null]),
    finishRun: (id, { status, report = '', error = null }) => one(
      'UPDATE pauta_runs SET status = $2, report = $3, error = $4, finished_at = now() WHERE id = $1 RETURNING *',
      [id, status, report, error],
    ),
    runningRun: (store) => one(
      "SELECT * FROM pauta_runs WHERE store_key = $1 AND status = 'running' AND started_at > now() - interval '30 minutes' ORDER BY started_at DESC LIMIT 1",
      [store],
    ),
    listRuns: (store, limit = 10) => all('SELECT * FROM pauta_runs WHERE store_key = $1 ORDER BY started_at DESC LIMIT $2', [store, limit]),

    addDecision: (store, d) => one(
      `INSERT INTO pauta_decisions (store_key, run_id, tool, input, title, reason, expected_impact, status, result, error, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $8 = 'pending' THEN NULL ELSE now() END) RETURNING *`,
      [store, d.runId ?? null, d.tool, d.input ?? {}, d.title ?? '', d.reason ?? '', d.expectedImpact ?? '', d.status, d.result ?? null, d.error ?? null, d.decidedBy ?? null],
    ),
    getDecision: (store, id) => one('SELECT * FROM pauta_decisions WHERE store_key = $1 AND id = $2', [store, id], 'No existe esa recomendación.'),
    listDecisions: (store, { status, limit = 50 } = {}) => all(
      `SELECT * FROM pauta_decisions WHERE store_key = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
      [store, status ?? null, limit],
    ),
    // Se toma solo si seguía pendiente: dos personas aprobando a la vez no ejecutan dos veces
    async claimPending(store, id, userName, status) {
      const row = await one(
        "UPDATE pauta_decisions SET status = $4, decided_by = $3, decided_at = now() WHERE store_key = $1 AND id = $2 AND status = 'pending' RETURNING *",
        [store, id, userName, status],
      );
      if (row) return row;
      await this.getDecision(store, id);
      throw conflict('Esta recomendación ya fue resuelta.');
    },
    setDecisionResult: (id, { status, result = null, error = null }) => one(
      'UPDATE pauta_decisions SET status = $2, result = $3, error = $4 WHERE id = $1 RETURNING *', [id, status, result, error],
    ),
    recordOutcome: (store, id, outcome) => one(
      'UPDATE pauta_decisions SET outcome = $3 WHERE store_key = $1 AND id = $2 RETURNING id', [store, id, outcome], 'No existe esa decisión.',
    ),
    executedWithoutOutcome: (store, olderThanHours = 48) => all(
      `SELECT id, tool, input, title, reason, created_at, decided_at FROM pauta_decisions
       WHERE store_key = $1 AND status = 'executed' AND outcome IS NULL AND coalesce(decided_at, created_at) < now() - make_interval(hours => $2)
       ORDER BY created_at LIMIT 20`,
      [store, olderThanHours],
    ),

    addRequest: (store, r) => one(
      'INSERT INTO pauta_creative_requests (store_key, concept, style_notes, reason) VALUES ($1, $2, $3, $4) RETURNING *',
      [store, r.concept, r.styleNotes ?? '', r.reason ?? ''],
    ),
    listRequests: (store, { status = 'open' } = {}) => all(
      'SELECT * FROM pauta_creative_requests WHERE store_key = $1 AND status = $2 ORDER BY created_at DESC LIMIT 50', [store, status],
    ),
    closeRequest: (store, id) => one(
      "UPDATE pauta_creative_requests SET status = 'done', closed_at = now() WHERE store_key = $1 AND id = $2 RETURNING *", [store, id], 'No existe ese pedido.',
    ),

    upsertLearning(store, { learning_id: id, text, evidence, status = 'active' }) {
      if (id) {
        return one('UPDATE pauta_learnings SET text = $3, evidence = $4, status = $5, updated_at = now() WHERE store_key = $1 AND id = $2 RETURNING *',
          [store, id, text, evidence ?? '', status], 'No existe ese aprendizaje.');
      }
      return one('INSERT INTO pauta_learnings (store_key, text, evidence, status) VALUES ($1, $2, $3, $4) RETURNING *', [store, text, evidence ?? '', status]);
    },
    listLearnings: (store, { activeOnly = false } = {}) => all(
      `SELECT * FROM pauta_learnings WHERE store_key = $1 AND ($2::boolean = false OR status = 'active') ORDER BY updated_at DESC LIMIT 100`,
      [store, activeOnly],
    ),
    async deleteLearning(store, id) {
      const { rowCount } = await db.query('DELETE FROM pauta_learnings WHERE store_key = $1 AND id = $2', [store, id]);
      if (!rowCount) throw notFound('No existe ese aprendizaje.');
    },

    // quick_answers es jsonb: el array va serializado (pg mandaría un array de Postgres)
    addQuestion: (store, q) => one(
      'INSERT INTO pauta_questions (store_key, run_id, question, why, quick_answers) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [store, q.runId ?? null, q.question, q.why ?? '', JSON.stringify(q.quickAnswers ?? [])],
    ),
    getQuestion: (store, id) => one('SELECT * FROM pauta_questions WHERE store_key = $1 AND id = $2', [store, id], 'No existe esa pregunta.'),
    listQuestions: (store, { status = 'open', limit = 30 } = {}) => all(
      'SELECT * FROM pauta_questions WHERE store_key = $1 AND status = $2 ORDER BY coalesce(answered_at, created_at) DESC LIMIT $3',
      [store, status, limit],
    ),
    // Solo si sigue abierta: evita que dos personas respondan la misma
    async answerQuestion(store, id, answer, userName) {
      const row = await one(
        "UPDATE pauta_questions SET status = 'answered', answer = $3, answered_by = $4, answered_at = now() WHERE store_key = $1 AND id = $2 AND status = 'open' RETURNING *",
        [store, id, answer, userName],
      );
      if (row) return row;
      await this.getQuestion(store, id);
      throw conflict('Esta pregunta ya fue respondida o descartada.');
    },
    async dismissQuestion(store, id) {
      const row = await one(
        "UPDATE pauta_questions SET status = 'dismissed' WHERE store_key = $1 AND id = $2 AND status = 'open' RETURNING *", [store, id],
      );
      if (row) return row;
      await this.getQuestion(store, id);
      throw conflict('Esta pregunta ya fue respondida o descartada.');
    },
    // Respondidas desde que ARRANCÓ la última corrida terminada: lo que se contestó durante esa corrida no lo vio
    answeredSinceLastRun: (store) => all(
      `SELECT question, answer, answered_at, answered_by FROM pauta_questions
       WHERE store_key = $1 AND status = 'answered'
         AND answered_at > coalesce((SELECT max(started_at) FROM pauta_runs WHERE store_key = $1 AND status = 'done'), '-infinity'::timestamptz)
       ORDER BY answered_at LIMIT 20`,
      [store],
    ),

    // Reserva antes de llamar a Meta: si el post ya está (o se está promocionando) en ese conjunto, 409
    async reserveIgPromotion(store, p) {
      const row = await one(
        `INSERT INTO pauta_ig_promotions (store_key, ig_media_id, permalink, meta_adset_id, adset_name, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (store_key, ig_media_id, meta_adset_id) DO NOTHING RETURNING *`,
        [store, p.igMediaId, p.permalink ?? '', p.adsetId, p.adsetName ?? '', p.userName ?? null],
      );
      if (!row) throw conflict('Ese post ya está promocionado en ese conjunto.');
      return row;
    },
    completeIgPromotion: (id, adId) => one('UPDATE pauta_ig_promotions SET meta_ad_id = $2 WHERE id = $1 RETURNING *', [id, adId]),
    releaseIgPromotion: (id) => db.query('DELETE FROM pauta_ig_promotions WHERE id = $1 AND meta_ad_id IS NULL', [id]),
    listIgPromotions: (store) => all(
      'SELECT * FROM pauta_ig_promotions WHERE store_key = $1 AND meta_ad_id IS NOT NULL ORDER BY created_at DESC LIMIT 500', [store],
    ),

    // Piezas, cada una con su archivo de feed y (opcional) de historia
    createCreative: (store, c, userName) => one(
      `INSERT INTO pauta_creatives (store_key, name, copy, headline, notes, link, cta, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [store, c.name, c.copy, c.headline ?? '', c.notes ?? '', c.link, c.cta, userName ?? null],
    ),
    getCreative: (store, id) => one('SELECT * FROM pauta_creatives WHERE store_key = $1 AND id = $2', [store, id], 'No existe esa pieza.'),
    async updateCreative(store, id, patch) {
      const cols = Object.keys(patch).filter((c) => ['name', 'copy', 'headline', 'notes', 'link', 'cta', 'status'].includes(c));
      if (!cols.length) return this.getCreative(store, id);
      const set = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
      return one(`UPDATE pauta_creatives SET ${set} WHERE store_key = $1 AND id = $2 RETURNING *`, [store, id, ...cols.map((c) => patch[c])], 'No existe esa pieza.');
    },
    async listCreatives(store, { status } = {}) {
      const creatives = await all(
        'SELECT * FROM pauta_creatives WHERE store_key = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 200',
        [store, status ?? null],
      );
      if (!creatives.length) return [];
      const media = await all('SELECT * FROM pauta_media WHERE creative_id = ANY($1)', [creatives.map((c) => c.id)]);
      return creatives.map((c) => ({
        ...c,
        feed: media.find((m) => m.creative_id === c.id && m.slot === 'feed') ?? null,
        story: media.find((m) => m.creative_id === c.id && m.slot === 'story') ?? null,
      }));
    },
    // Se reclama antes de tocar Meta (con video puede tardar minutos): un segundo "Publicar" recibe 409
    async claimCreative(store, id) {
      const row = await one("UPDATE pauta_creatives SET status = 'publishing', publish_error = NULL WHERE store_key = $1 AND id = $2 AND status = 'unused' RETURNING *", [store, id]);
      if (row) return row;
      const c = await this.getCreative(store, id);
      if (c.status === 'used') throw conflict(`La pieza "${c.name}" ya se publicó (anuncio ${c.meta_ad_id}).`);
      if (c.status === 'publishing') throw conflict(`La pieza "${c.name}" se está publicando. Esperá a que termine.`);
      throw conflict(`La pieza "${c.name}" está archivada.`);
    },
    releaseCreative: (id, error = null) => db.query("UPDATE pauta_creatives SET status = 'unused', publish_error = $2 WHERE id = $1 AND status = 'publishing'", [id, error]),
    // Al arrancar: una publicación que quedó a medias por un reinicio vuelve a estar disponible
    releaseStuckCreatives: () => db.query("UPDATE pauta_creatives SET status = 'unused', publish_error = 'Se cortó la publicación (reinicio del servidor). Revisá en Meta que no se haya creado el anuncio antes de publicar de nuevo.' WHERE status = 'publishing'"),
    async deleteCreative(store, id) {
      const c = await this.getCreative(store, id);
      if (c.status === 'publishing' || c.status === 'used') throw conflict('Una pieza publicada no se puede borrar: archivala.');
      const keys = (await this.getMedia(id)).map((m) => m.storage_key);
      await db.query('DELETE FROM pauta_creatives WHERE store_key = $1 AND id = $2', [store, id]);
      return keys;
    },
    markCreativeUsed: (id, adId, adsetId) => one(
      "UPDATE pauta_creatives SET status = 'used', meta_ad_id = $2, meta_adset_id = $3, used_at = now() WHERE id = $1 RETURNING *",
      [id, adId, adsetId],
    ),
    getMedia: (creativeId) => all('SELECT * FROM pauta_media WHERE creative_id = $1', [creativeId]),
    // Reemplaza el archivo del lugar (feed/historia): devuelve la clave vieja para borrarla del storage
    async setMedia(creativeId, m) {
      const old = await one('SELECT storage_key FROM pauta_media WHERE creative_id = $1 AND slot = $2', [creativeId, m.slot]);
      const row = await one(
        `INSERT INTO pauta_media (creative_id, slot, kind, storage_key, mime, bytes, width, height, original_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (creative_id, slot) DO UPDATE SET kind = $3, storage_key = $4, mime = $5, bytes = $6, width = $7, height = $8, original_name = $9, created_at = now()
         RETURNING *`,
        [creativeId, m.slot, m.kind, m.storageKey, m.mime, m.bytes, m.width ?? null, m.height ?? null, m.originalName ?? ''],
      );
      return { row, oldKey: old?.storage_key ?? null };
    },
    async removeMedia(creativeId, slot) {
      const { rows } = await db.query('DELETE FROM pauta_media WHERE creative_id = $1 AND slot = $2 RETURNING storage_key', [creativeId, slot]);
      return rows[0]?.storage_key ?? null;
    },
  };
}
