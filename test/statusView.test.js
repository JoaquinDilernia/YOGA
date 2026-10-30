import { describe, it, expect } from 'vitest';
import { isPaused, filterTree, countAds } from '../client/src/components/pauta/statusView.js';

const snap = {
  campaigns: [
    { id: 'c1', name: 'Mensajes', effectiveStatus: 'ACTIVE' },
    { id: 'c2', name: 'Vieja', effectiveStatus: 'PAUSED' },
  ],
  adsets: [
    { id: 's1', campaignId: 'c1', effectiveStatus: 'ACTIVE' },
    { id: 's2', campaignId: 'c1', effectiveStatus: 'PAUSED' },
    { id: 's3', campaignId: 'c2', effectiveStatus: 'CAMPAIGN_PAUSED' },
    { id: 's4', campaignId: 'c1', effectiveStatus: 'ACTIVE' },
  ],
  ads: [
    { id: 'a1', adsetId: 's1', effectiveStatus: 'ACTIVE' },
    { id: 'a2', adsetId: 's1', effectiveStatus: 'PAUSED' },
    { id: 'a3', adsetId: 's1', effectiveStatus: 'WITH_ISSUES' },
    { id: 'a4', adsetId: 's1', effectiveStatus: 'IN_PROCESS' },
    { id: 'a5', adsetId: 's2', effectiveStatus: 'ADSET_PAUSED' },
    { id: 'a6', adsetId: 's3', effectiveStatus: 'CAMPAIGN_PAUSED' },
  ],
};
const ids = (tree) => tree.map((c) => [c.id, c.adsets.map((a) => [a.id, a.ads.map((ad) => ad.id)])]);

describe('activos y pausados', () => {
  it('lo pausado por anuncio, conjunto o campaña cuenta como pausado; lo rechazado o en revisión no', () => {
    expect(['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED'].every(isPaused)).toBe(true);
    expect(['ACTIVE', 'IN_PROCESS', 'PENDING_REVIEW', 'WITH_ISSUES', 'DISAPPROVED'].some(isPaused)).toBe(false);
  });

  it('activos: solo las ramas con algo corriendo, y los rotos quedan a la vista', () => {
    expect(ids(filterTree(snap, 'active'))).toEqual([
      ['c1', [['s1', ['a1', 'a3', 'a4']], ['s4', []]]],
    ]);
  });

  it('pausados: cada anuncio pausado con su conjunto y su campaña', () => {
    expect(ids(filterTree(snap, 'paused'))).toEqual([
      ['c1', [['s1', ['a2']], ['s2', ['a5']]]],
      ['c2', [['s3', ['a6']]]],
    ]);
  });

  it('todos: no esconde nada', () => {
    expect(ids(filterTree(snap, 'all'))).toEqual([
      ['c1', [['s1', ['a1', 'a2', 'a3', 'a4']], ['s2', ['a5']], ['s4', []]]],
      ['c2', [['s3', ['a6']]]],
    ]);
  });

  it('cuenta anuncios activos y pausados', () => {
    expect(countAds(snap)).toEqual({ active: 3, paused: 3 });
  });
});
