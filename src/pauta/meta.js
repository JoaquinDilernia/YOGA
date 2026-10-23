// Cliente mínimo de la Graph API de Meta (Marketing API), uno por cuenta publicitaria.
// Mismo cliente que el agente de uniformar: fetch directo, un reintento ante rate limit.
const V = 'v23.0';
const RETRYABLE = new Set([4, 17, 32, 613]);

export const normalizeAccountId = (id) => {
  const clean = String(id || '').trim().replace(/^act_/, '');
  return clean ? `act_${clean}` : '';
};

export function createMetaClient({ accessToken, accountId, fetchFn = fetch, retryDelayMs = 2000 }) {
  const BASE = `https://graph.facebook.com/${V}`;
  // Los archivos de video se suben a este host: graph.facebook.com corta el upload y responde vacío
  const VIDEO_BASE = `https://graph-video.facebook.com/${V}`;
  accountId = normalizeAccountId(accountId);

  async function reqOnce(path, { method = 'GET', params = {}, body, form, base = BASE } = {}) {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const res = await fetchFn(url, {
      method,
      ...(form ? { body: form } : body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Meta respondió HTTP ${res.status} sin datos válidos${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    if (json.error) {
      const detail = json.error.error_user_msg || (json.error.error_subcode ? `subcode ${json.error.error_subcode}` : null);
      const err = new Error(`Meta ${json.error.code}: ${json.error.message}${detail ? ` (${detail})` : ''}`);
      err.code = json.error.code;
      throw err;
    }
    return json;
  }

  async function req(path, opts) {
    try {
      return await reqOnce(path, opts);
    } catch (err) {
      if (!RETRYABLE.has(err.code)) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs));
      return reqOnce(path, opts);
    }
  }

  const FIELDS = {
    account: 'name,currency,timezone_name,account_status',
    campaign: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,created_time',
    adset: 'id,name,campaign_id,status,effective_status,daily_budget,optimization_goal,destination_type,promoted_object,targeting,learning_stage_info,start_time,created_time',
    ad: 'id,name,adset_id,campaign_id,status,effective_status,created_time,creative{id,body,title,thumbnail_url,object_story_spec,asset_feed_spec}',
    igMedia: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count',
    insights: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpm,actions,action_values',
  };
  const list = async (path, fields, limit = 200) => (await req(path, { params: { fields, limit: String(limit) } })).data ?? [];

  return {
    accountId,
    getAccount: () => req(accountId, { params: { fields: FIELDS.account } }),
    getCampaigns: () => list(`${accountId}/campaigns`, FIELDS.campaign),
    getAdsets: () => list(`${accountId}/adsets`, FIELDS.adset),
    getAds: () => list(`${accountId}/ads`, FIELDS.ad, 500),
    // since/until en YYYY-MM-DD (hora de la cuenta). daily=true parte por día.
    async getInsights(level, since, until, { daily = false } = {}) {
      const params = { level, fields: FIELDS.insights, time_range: { since, until }, limit: '500' };
      if (daily) params.time_increment = '1';
      return (await req(`${accountId}/insights`, { params })).data ?? [];
    },
    setStatus: (objectId, status) => req(objectId, { method: 'POST', body: { status } }),
    updateDailyBudget: (objectId, dailyBudgetCents) => req(objectId, { method: 'POST', body: { daily_budget: dailyBudgetCents } }),
    createCampaign: (payload) => req(`${accountId}/campaigns`, { method: 'POST', body: payload }),
    createAdset: (payload) => req(`${accountId}/adsets`, { method: 'POST', body: payload }),
    async uploadImage(buffer) {
      const json = await req(`${accountId}/adimages`, { method: 'POST', body: { bytes: buffer.toString('base64') } });
      return Object.values(json.images)[0].hash;
    },
    // Con fileUrl (bucket firmado) Meta descarga el video; con buffer (storage local en desarrollo) se manda el archivo
    async uploadVideo({ fileUrl, buffer, name }) {
      if (fileUrl) return (await req(`${accountId}/advideos`, { method: 'POST', body: { file_url: fileUrl, ...(name ? { name } : {}) } })).id;
      const form = new FormData();
      if (name) form.append('name', name);
      form.append('source', new Blob([buffer]), 'video.mp4');
      return (await req(`${accountId}/advideos`, { method: 'POST', form, base: VIDEO_BASE })).id;
    },
    async waitVideoReady(videoId, { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const { status } = await req(videoId, { params: { fields: 'status' } });
        if (status?.video_status === 'ready') return;
        if (status?.video_status === 'error') {
          throw new Error(`Meta no pudo procesar el video: ${status.processing_phase?.errors?.[0]?.message ?? 'error desconocido'}`);
        }
        if (Date.now() >= until) throw new Error('Meta sigue procesando el video, probá publicar de nuevo en unos minutos.');
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
    async videoThumbnail(videoId) {
      const { data = [] } = await req(`${videoId}/thumbnails`);
      return (data.find((t) => t.is_preferred) ?? data[0])?.uri ?? null;
    },
    // Lo necesario para copiar un creativo existente (ver buildCopyCreativeSpec)
    getCreative: (creativeId) => req(creativeId, { params: { fields: 'name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags' } }),
    createCreative: (spec) => req(`${accountId}/adcreatives`, { method: 'POST', body: spec }),
    createAd: ({ name, adsetId, creativeId, status }) =>
      req(`${accountId}/ads`, { method: 'POST', body: { name, adset_id: adsetId, creative: { creative_id: creativeId }, status } }),
    async searchInterests(query) {
      // La búsqueda de segmentación NO va bajo la cuenta publicitaria
      const json = await req('search', { params: { type: 'adinterest', q: query, limit: '15' } });
      return (json.data ?? []).map((d) => ({ id: d.id, name: d.name, audienceMin: d.audience_size_lower_bound, audienceMax: d.audience_size_upper_bound }));
    },
    // Últimos posts/reels de la cuenta de IG. El alcance orgánico necesita instagram_manage_insights:
    // si no está, se devuelve null sin cortar.
    async getIgMedia(igUserId, limit = 25) {
      const media = await list(`${igUserId}/media`, FIELDS.igMedia, limit);
      return Promise.all(media.map(async (m) => {
        let reach = null;
        try {
          const ins = await reqOnce(`${m.id}/insights`, { params: { metric: 'reach' } });
          reach = ins.data?.[0]?.values?.[0]?.value ?? null;
        } catch {
          reach = null;
        }
        return {
          id: m.id,
          type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'post',
          caption: m.caption ?? '',
          thumbnail: m.thumbnail_url ?? m.media_url ?? null,
          permalink: m.permalink ?? '',
          timestamp: m.timestamp,
          likes: m.like_count ?? 0,
          comments: m.comments_count ?? 0,
          reach,
        };
      }));
    },
  };
}
