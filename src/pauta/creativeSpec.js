// Mismas reglas que uniformar, pero el anuncio lleva a la tienda en vez de a WhatsApp:
//  - instagram_user_id (instagram_actor_id está deprecado desde Graph v22)
//  - sin mejoras de IA de Meta: opt-out función por función
//  - con pieza de historia: customización por ubicación (feed 4:5 / historia 9:16), image_label / video_label como objeto
const NO_AI_ENHANCEMENTS = {
  creative_features_spec: Object.fromEntries(
    [
      'image_brightness_and_contrast', 'enhance_cta', 'text_optimizations', 'image_touchups', 'image_uncrop',
      'inline_comment', 'adapt_to_placement', 'media_type_automation', 'description_automation',
      'add_text_overlay', 'image_animation', 'text_generation',
    ].map((f) => [f, { enroll_status: 'OPT_OUT' }]),
  ),
};

// Botones posibles. Por defecto: es una entrada para una clase
export const CTA_TYPES = ['BUY_TICKETS', 'SHOP_NOW', 'LEARN_MORE'];
export const DEFAULT_CTA = 'BUY_TICKETS';

// UTMs en cada clic: la tienda guarda la URL de llegada y así se puede saber qué campaña y anuncio trajo cada venta
export const URL_TAGS = 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}';

const POSITIONS = {
  feed: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['stream'] },
  story: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['story'], instagram_positions: ['story', 'reels'] },
};

// feed/story: { type: 'image', hash } | { type: 'video', videoId, thumbnailUrl }
export function buildLinkCreativeSpec({ name, pageId, igUserId, message, headline, link, cta = DEFAULT_CTA, feed, story }) {
  const identity = { page_id: pageId, ...(igUserId ? { instagram_user_id: igUserId } : {}) };
  const callToAction = { type: cta, value: { link } };
  const base = { name, url_tags: URL_TAGS, degrees_of_freedom_spec: NO_AI_ENHANCEMENTS };
  if (!story) {
    const data = feed.type === 'image'
      ? { link_data: { link, message, ...(headline ? { name: headline } : {}), image_hash: feed.hash, call_to_action: callToAction } }
      : { video_data: { video_id: feed.videoId, image_url: feed.thumbnailUrl, message, ...(headline ? { title: headline } : {}), call_to_action: callToAction } };
    return { ...base, object_story_spec: { ...identity, ...data } };
  }

  const images = [];
  const videos = [];
  const rule = (media, label) => {
    if (media.type === 'image') {
      images.push({ hash: media.hash, adlabels: [{ name: label }] });
      return { customization_spec: POSITIONS[label], image_label: { name: label } };
    }
    videos.push({ video_id: media.videoId, thumbnail_url: media.thumbnailUrl, adlabels: [{ name: label }] });
    return { customization_spec: POSITIONS[label], video_label: { name: label } };
  };
  const rules = [rule(feed, 'feed'), rule(story, 'story')];
  const format = feed.type !== story.type ? 'AUTOMATIC_FORMAT' : feed.type === 'image' ? 'SINGLE_IMAGE' : 'SINGLE_VIDEO';
  return {
    ...base,
    object_story_spec: identity,
    asset_feed_spec: {
      ...(images.length ? { images } : {}),
      ...(videos.length ? { videos } : {}),
      bodies: [{ text: message }],
      titles: [{ text: headline || name }],
      link_urls: [{ website_url: link }],
      ad_formats: [format],
      call_to_action_types: [cta],
      optimization_type: 'PLACEMENT',
      asset_customization_rules: rules,
    },
  };
}

// Promocionar un post/reel que ya está en Instagram: el anuncio usa el post original (suma likes y comentarios)
// y le agrega el botón hacia la tienda. El texto es el del post.
export function buildIgPostCreativeSpec({ name, pageId, igUserId, mediaId, link, cta = DEFAULT_CTA }) {
  return {
    name,
    object_id: pageId,
    instagram_user_id: igUserId,
    source_instagram_media_id: mediaId,
    call_to_action: { type: cta, value: { link } },
    url_tags: URL_TAGS,
    degrees_of_freedom_spec: NO_AI_ENHANCEMENTS,
  };
}

// Copia de un creativo que ya está en la cuenta (de la agencia anterior o propio) para usarlo en otro conjunto:
// mismo material y texto, pero con las UTMs (los creativos no se pueden editar, hay que crear uno nuevo).
// Se sacan los campos que Meta devuelve pero no acepta al crear: ids de las etiquetas e image_url si ya hay hash.
const withoutIds = (v) => (Array.isArray(v) ? v.map(withoutIds)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id').map(([k, x]) => [k, withoutIds(x)])) : v);

// Meta devuelve opciones de IA que ya no acepta al crear (se configuran función por función)
const DEPRECATED_FEATURES = ['standard_enhancements'];

export function buildCopyCreativeSpec(source, { name }) {
  const story = structuredClone(source.object_story_spec);
  if (story.video_data?.image_hash) delete story.video_data.image_url;
  const features = { ...source.degrees_of_freedom_spec?.creative_features_spec };
  for (const f of DEPRECATED_FEATURES) delete features[f];
  return {
    name,
    object_story_spec: story,
    url_tags: URL_TAGS,
    ...(source.asset_feed_spec ? { asset_feed_spec: withoutIds(source.asset_feed_spec) } : {}),
    ...(Object.keys(features).length ? { degrees_of_freedom_spec: { creative_features_spec: features } } : {}),
  };
}

// Lo que arma la agencia (TechDi) lleva el prefijo en el nombre: así se distingue de lo heredado
export const AGENCY_PREFIX = 'TechDi_';
export const agencyName = (name) => {
  const n = String(name ?? '').trim().replace(/^techdi[_\s|-]*/i, '');
  return `${AGENCY_PREFIX}${n}`;
};

const clean = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

// Convención de nombres: {CONJUNTO}_{PIEZA}_{YYYYMMDD}
export function buildAdName({ adsetName, creativeName, date }) {
  const tag = clean(adsetName).replace(/\d{8}$/, '').slice(0, 30) || 'CONJUNTO';
  return `${tag}_${clean(creativeName).slice(0, 30)}_${date.replaceAll('-', '')}`;
}
