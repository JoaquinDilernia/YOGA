import { createPautaRepo } from './repo.js';
import { createMetaClient } from './meta.js';
import { createAgentRunner } from './agent.js';
import { buildShopContext } from './shop.js';
import { createPautaRouter } from './routes.js';

// Agente de pauta: una cuenta de Meta por tienda, con su presupuesto, contexto e historial.
// metaToken: token de usuario del sistema del Business Manager con acceso a las cuentas de las dos marcas.
export function createPauta({ db, stores, canAccess, getStoreData, metaToken, anthropic, model, metaFactory = createMetaClient }) {
  const repo = createPautaRepo(db);
  const metaFor = (settings) => (metaToken && settings.meta_ad_account_id
    ? metaFactory({ accessToken: metaToken, accountId: settings.meta_ad_account_id })
    : null);
  const getShop = async (key) => buildShopContext(await getStoreData(stores.find((s) => s.key === key)));
  const startRun = anthropic ? createAgentRunner({ anthropic, repo, metaFor, getShop, stores, model }) : null;

  // Corrida diaria de todas las tiendas, una detrás de otra (no se pisan con el rate limit de Meta)
  async function runDaily() {
    if (!startRun) return;
    for (const store of stores) {
      try {
        const { run, done } = await startRun(store.key, 'daily', null);
        const finished = await done;
        console.log(`[pauta:${store.key}] corrida diaria: ${finished?.status ?? run.status}`);
      } catch (err) {
        console.error(`[pauta:${store.key}] corrida diaria no arrancó:`, err.message);
      }
    }
  }

  const router = createPautaRouter({ repo, stores, canAccess, metaFor, getShop, startRun, hasMetaToken: Boolean(metaToken) });
  return { repo, router, runDaily, startRun };
}
