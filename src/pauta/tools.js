const s = (description) => ({ type: 'string', description });
const n = (description) => ({ type: 'number', description });
const why = {
  title: s('Título corto de la recomendación, en lenguaje simple (ej. "Pausar el anuncio del reel de cachorros")'),
  reason: s('Por qué, con los números que lo justifican'),
  expected_impact: s('Qué esperás que pase y cuándo se va a poder medir'),
};
const whyReq = ['title', 'reason', 'expected_impact'];

// Las acciones sobre Meta quedan como recomendaciones pendientes de aprobación en el panel,
// salvo que el modo autónomo esté prendido: ahí pausar un anuncio se ejecuta solo.
export const TOOL_DEFINITIONS = [
  {
    name: 'pause_ad',
    description: 'Pausar un anuncio. Usalo con anuncios que gastaron de verdad sin generar compras, con fatiga clara, o que llevan a una fecha que ya está completa o ya pasó. Nunca dejes un conjunto activo sin anuncios.',
    input_schema: { type: 'object', properties: { ad_id: s('ID del anuncio'), ad_name: s('Nombre del anuncio'), ...why }, required: ['ad_id', ...whyReq] },
  },
  {
    name: 'set_status',
    description: 'Proponer pausar o activar una campaña, un conjunto o un anuncio. Activar algo empieza a gastar plata: siempre queda pendiente de aprobación.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset', 'ad'] },
        object_id: s('ID del objeto'), object_name: s('Nombre del objeto'),
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        ...why,
      },
      required: ['level', 'object_id', 'status', ...whyReq],
    },
  },
  {
    name: 'propose_budget_change',
    description: 'Proponer cambiar el presupuesto diario de una campaña (CBO) o de un conjunto. En PESOS. Respetá el tope mensual.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset'] }, object_id: s('ID'), object_name: s('Nombre'),
        current_budget_ars: n('Presupuesto diario actual en pesos'), proposed_budget_ars: n('Presupuesto diario propuesto en pesos'),
        ...why,
      },
      required: ['level', 'object_id', 'current_budget_ars', 'proposed_budget_ars', ...whyReq],
    },
  },
  {
    name: 'propose_campaign',
    description: 'Proponer una campaña nueva de ventas (objetivo Ventas, presupuesto a nivel campaña). Se crea PAUSADA y sin conjuntos: en una próxima corrida proponés los conjuntos con propose_adset. Usalo solo si no hay una campaña de ventas que sirva.',
    input_schema: {
      type: 'object',
      properties: {
        name: s('Nombre en MAYÚSCULAS con guiones bajos (ej. VENTAS_CLASES_NOV)'),
        daily_budget_ars: n('Presupuesto diario de la campaña en pesos'),
        ...why,
      },
      required: ['name', 'daily_budget_ars', ...whyReq],
    },
  },
  {
    name: 'propose_adset',
    description: 'Proponer un conjunto nuevo dentro de una campaña existente (por ejemplo para probar otro público). Buscá antes los intereses reales con search_interest — nunca inventes IDs. El conjunto se crea PAUSADO, optimizando compras del píxel de la tienda; sin presupuesto propio si la campaña es CBO.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: s('ID de la campaña'),
        name: s('Nombre del conjunto, en MAYÚSCULAS con guiones bajos (ej. VENTAS_PALERMO_AMANTESPERROS)'),
        targeting: { type: 'object', description: 'Targeting de Graph API: geo_locations (ej. ciudad o radio alrededor de la sede), age_min, age_max, genders, flexible_spec con intereses, targeting_automation.advantage_audience (0 o 1)' },
        daily_budget_ars: n('Solo si la campaña NO es CBO: presupuesto diario del conjunto en pesos'),
        ...why,
      },
      required: ['campaign_id', 'name', 'targeting', ...whyReq],
    },
  },
  {
    name: 'reuse_ad',
    description: 'Proponer copiar un anuncio que ya existe en la cuenta (mismo creativo, mismo link) a otro conjunto. Sirve para llevar un anuncio que vende bien a un público nuevo. El anuncio nuevo nace ACTIVO dentro del conjunto (si el conjunto está pausado no gasta).',
    input_schema: {
      type: 'object',
      properties: {
        source_ad_id: s('ID del anuncio de origen'), creative_id: s('creativeId del anuncio de origen (de ads[])'),
        adset_id: s('ID del conjunto destino'), adset_name: s('Nombre del conjunto destino'), ad_name: s('Nombre del anuncio nuevo'),
        ...why,
      },
      required: ['creative_id', 'adset_id', ...whyReq],
    },
  },
  {
    name: 'promote_ig_post',
    description: 'Proponer promocionar un post o reel que ya está publicado en el Instagram de la marca (lista igPosts) como anuncio en un conjunto, con botón que lleva a la tienda. Usa el post original: suma sus likes y comentarios, y el texto es el del post. Elegí el link: la página de la fecha que hay que llenar (upcomingClasses[].url) o la tienda (storeUrl). No lo propongas si ya está en promotedIn para ese conjunto.',
    input_schema: {
      type: 'object',
      properties: {
        ig_media_id: s('id del post (de igPosts)'), adset_id: s('ID del conjunto destino'), adset_name: s('Nombre del conjunto'),
        permalink: s('Link del post (de igPosts)'), link: s('URL de la tienda a la que lleva el botón'),
        ...why,
      },
      required: ['ig_media_id', 'adset_id', 'link', ...whyReq],
    },
  },
  {
    name: 'search_interest',
    description: 'Buscar intereses reales de Meta (con tamaño de público) para armar segmentaciones. Solo lectura.',
    input_schema: { type: 'object', properties: { query: s('Término, ej. "yoga", "perros", "gatos", "bienestar"') }, required: ['query'] },
  },
  {
    name: 'request_creative',
    description: 'Pedirle al equipo una pieza nueva cuando hace falta (fatiga, ángulo sin probar, fecha que necesita empuje). Sé concreto: formato, qué se ve, qué dice, por qué.',
    input_schema: {
      type: 'object',
      properties: { concept: s('Idea de la pieza en una línea'), style_notes: s('Formato (reel 9:16, feed 4:5), qué mostrar, texto, tono, referencias'), reason: s('Por qué hace falta ahora') },
      required: ['concept', 'style_notes', 'reason'],
    },
  },
  {
    name: 'save_learning',
    description: 'Guardar o actualizar un aprendizaje con evidencia repetida (mínimo 2-3 observaciones consistentes, nunca de una sola muestra). Pasá learning_id para actualizar o marcarlo obsolete.',
    input_schema: { type: 'object', properties: { learning_id: s('ID existente (omitir para crear)'), text: s('El aprendizaje, corto y accionable'), evidence: s('Evidencia con fechas y números'), status: { type: 'string', enum: ['active', 'obsolete'] } }, required: ['text', 'evidence'] },
  },
  {
    name: 'record_outcome',
    description: 'Registrar qué pasó realmente después de una decisión ejecutada (lista decisionsToEvaluate), con números.',
    input_schema: { type: 'object', properties: { decision_id: s('ID de la decisión'), outcome: s('Resultado medido') }, required: ['decision_id', 'outcome'] },
  },
  {
    name: 'ask_team',
    description: 'Hacerle una pregunta al equipo cuando te falta un dato que solo ellos tienen (fechas nuevas que se vienen, promos, capacidad real, cómo llegan las reservas, qué pieza tienen grabada). La ven en el panel y la contestan; la respuesta te llega en answeredQuestions en una próxima corrida. Una pregunta por llamada, concreta y que se pueda contestar en una o dos líneas. No repitas preguntas que sigan en openQuestions.',
    input_schema: {
      type: 'object',
      properties: {
        question: s('La pregunta, concreta (ej. "¿Van a abrir fechas de diciembre? Si sí, ¿cuándo las cargan en la tienda?")'),
        why: s('Qué decisión destraba la respuesta'),
        quick_answers: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Opcional: hasta 4 respuestas típicas cortas para contestar con un toque (ej. "Sí", "No")' },
      },
      required: ['question', 'why'],
    },
  },
];

export const READ_ONLY_TOOLS = new Set(['search_interest']);
export const META_ACTIONS = new Set(['pause_ad', 'set_status', 'propose_budget_change', 'propose_campaign', 'propose_adset', 'reuse_ad', 'promote_ig_post']);
