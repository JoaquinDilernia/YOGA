// Mismas reglas que uniformar: instagram_user_id (instagram_actor_id está deprecado desde Graph v22)
// y sin mejoras de IA de Meta, opt-out función por función.
const NO_AI_ENHANCEMENTS = {
  creative_features_spec: Object.fromEntries(
    [
      'image_brightness_and_contrast', 'enhance_cta', 'text_optimizations', 'image_touchups', 'image_uncrop',
      'inline_comment', 'adapt_to_placement', 'media_type_automation', 'description_automation',
      'add_text_overlay', 'image_animation', 'text_generation',
    ].map((f) => [f, { enroll_status: 'OPT_OUT' }]),
  ),
};

// Botón de las piezas: es una entrada para una clase
export const CTA_TYPE = 'BUY_TICKETS';

// Promocionar un post/reel que ya está en Instagram: el anuncio usa el post original (suma likes y comentarios)
// y le agrega el botón hacia la tienda. El texto es el del post.
export function buildIgPostCreativeSpec({ name, pageId, igUserId, mediaId, link }) {
  return {
    name,
    object_id: pageId,
    instagram_user_id: igUserId,
    source_instagram_media_id: mediaId,
    call_to_action: { type: CTA_TYPE, value: { link } },
    degrees_of_freedom_spec: NO_AI_ENHANCEMENTS,
  };
}

const clean = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

// Convención de nombres: {CONJUNTO}_{PIEZA}_{YYYYMMDD}
export function buildAdName({ adsetName, creativeName, date }) {
  const tag = clean(adsetName).replace(/\d{8}$/, '').slice(0, 30) || 'CONJUNTO';
  return `${tag}_${clean(creativeName).slice(0, 30)}_${date.replaceAll('-', '')}`;
}
