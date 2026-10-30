import { TOOL_DEFINITIONS, OFFLINE_TOOL_DEFINITIONS } from './tools.js';
import { agentKnowledge } from './systemPrompt.js';
import { buildContext, createDispatcher, DEFAULT_MODEL } from './agent.js';
import { conflict } from '../errors.js';

const MAX_TURNS = 8;
const HISTORY = 20;
const CONTEXT_TTL_MS = 10 * 60_000;

// En el chat no se le pregunta al equipo (ya está hablando con él) ni se evalúan decisiones: eso es de la corrida diaria
const chatTools = (tools) => tools.filter((t) => !['ask_team', 'record_outcome'].includes(t.name));
const CHAT_TOOLS = chatTools(TOOL_DEFINITIONS);
const CHAT_TOOLS_OFFLINE = chatTools(OFFLINE_TOOL_DEFINITIONS);

export const buildChatSystem = (storeName, { metaConnected = true } = {}) => `Sos el agente de pauta de ${storeName} y su asesor de Meta Ads. Acá el equipo te hace consultas desde el panel, en un chat.

${agentKnowledge(storeName)}

# Cómo contestar
- Contestá lo que te preguntan, en español rioplatense, corto y con los números de los datos que tenés abajo (tienda, próximas fechas, campañas, conjuntos, anuncios, métricas, posts de Instagram, aprendizajes). Si el dato no está, decilo; no lo inventes.
- Con pocos datos (menos de ~3 compras), avisá que todavía no alcanza para concluir.
- No ejecutás nada en Meta. Si de la charla sale un cambio que conviene hacer (pausar, activar, presupuesto, campaña o conjunto nuevo, publicar o promocionar), proponelo con la herramienta que corresponde: queda en "Para aprobar" en el panel. Mencioná en la respuesta qué dejaste ahí.
- Si el equipo te cuenta algo del negocio que vale para adelante (fechas nuevas, promos, qué público compra, cómo llegan las reservas), guardalo con save_learning y decí que lo anotaste.
- Si falta una pieza para probar algo, pedila con request_creative.
- Lo leen los dueños de la marca, no analistas: nada de jerga innecesaria. Usá listas cortas cuando compares cosas.${metaConnected ? '' : '\n- Meta todavía no está conectado: contestá con los datos de la tienda y avisá cuando algo necesite la cuenta de Meta.'}`;

// metaFor(settings) devuelve el cliente de la cuenta de esa tienda (o null si falta conectarla)
// getShop(storeKey) devuelve el contexto de Tienda Nube
export function createPautaChat({ anthropic, repo, metaFor, getShop, stores, model = DEFAULT_MODEL }) {
  const contexts = new Map();
  const busy = new Set();

  // Los datos de la cuenta se arman una vez cada 10 minutos por conversación: las repreguntas usan la caché de prompts
  async function contextFor(storeKey, chatId, meta, settings) {
    const hit = contexts.get(chatId);
    if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.text;
    const shop = await getShop(storeKey);
    const text = await buildContext({ meta, repo, store: storeKey, settings, shop });
    contexts.set(chatId, { text, at: Date.now() });
    return text;
  }

  // Contesta el último mensaje del equipo y guarda la respuesta con lo que hizo el agente
  return async function reply(storeKey, chatId) {
    if (busy.has(chatId)) throw conflict('El agente todavía está contestando en esta conversación.');
    busy.add(chatId);
    try {
      const store = stores.find((s) => s.key === storeKey);
      const history = (await repo.listChatMessages(chatId)).slice(-HISTORY);
      if (history.at(-1)?.role !== 'user') throw conflict('No hay ninguna consulta para contestar.');
      const settings = await repo.getSettings(storeKey);
      const meta = metaFor(settings);
      const dispatch = createDispatcher({ meta, repo, store: storeKey, execute: null });
      const context = await contextFor(storeKey, chatId, meta, settings);
      const messages = history.map((m) => ({ role: m.role, content: m.content }));
      while (messages[0]?.role === 'assistant') messages.shift();
      const actions = [];
      let answer = '';
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const resp = await anthropic.beta.messages.stream({
          model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [
            { type: 'text', text: buildChatSystem(store.name, { metaConnected: Boolean(meta) }) },
            { type: 'text', text: `Datos actuales:\n\n${context}`, cache_control: { type: 'ephemeral' } },
          ],
          tools: meta ? CHAT_TOOLS : CHAT_TOOLS_OFFLINE,
          messages,
        }).finalMessage();
        if (resp.stop_reason === 'refusal') throw new Error('El agente no pudo contestar esta consulta.');
        messages.push({ role: 'assistant', content: resp.content });
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) answer = text;
        if (resp.stop_reason !== 'tool_use') break;
        const results = [];
        for (const block of resp.content.filter((b) => b.type === 'tool_use')) {
          const input = block.input ?? {};
          // autonomous: false siempre: desde el chat nada se ejecuta solo
          const result = await dispatch(block.name, input, { chatId, settings: { ...settings, autonomous: false } });
          if (result.queued) actions.push({ type: 'recommendation', id: result.decision_id, title: input.title || block.name });
          if (block.name === 'save_learning' && result.ok) actions.push({ type: 'learning', id: result.learning_id, title: input.text });
          if (block.name === 'request_creative' && result.ok) actions.push({ type: 'request', title: input.concept });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!answer) throw new Error('El agente no devolvió una respuesta.');
      return await repo.addChatMessage({ chatId, role: 'assistant', content: answer, actions });
    } finally {
      busy.delete(chatId);
    }
  };
}
