import { describe, expect, it } from 'vitest';
import { readSsoToken } from '../src/sso.js';

// Mismo vector que BOT-YOGA/server/src/services/agenteSso.test.js (token firmado por el panel del bot)
const TOKEN = 'sso.TWFyY29z.44200000.Suc3zMc3tNDIgk4rBxLD3TAjmhBtgJ0X8hz1jxd71jw';

describe('readSsoToken', () => {
  it('acepta el token del panel del bot con acceso a todas las tiendas', () => {
    expect(readSsoToken(TOKEN, 'secreto', 1_000_000)).toEqual({ name: 'Marcos', stores: ['*'], sso: true });
  });

  it('si hay un usuario con ese nombre, usa sus tiendas', () => {
    const users = [{ name: 'marcos', password: 'x', stores: ['gatitos'] }];
    expect(readSsoToken(TOKEN, 'secreto', 1_000_000, users).stores).toEqual(['gatitos']);
  });

  it('rechaza vencido, firma de otro secreto, sin secreto configurado o token común', () => {
    expect(readSsoToken(TOKEN, 'secreto', 44_200_001)).toBeNull();
    expect(readSsoToken(TOKEN, 'otro', 1_000_000)).toBeNull();
    expect(readSsoToken(TOKEN, '', 1_000_000)).toBeNull();
    expect(readSsoToken('TWFyY29z.44200000.firma', 'secreto', 1_000_000)).toBeNull();
    expect(readSsoToken(TOKEN.replace('TWFyY29z', 'QWRtaW4'), 'secreto', 1_000_000)).toBeNull();
  });
});
