import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sizeOf from 'image-size';
import { HttpError, badRequest, conflict } from '../errors.js';

// Las piezas van tal cual a Meta, que no acepta WebP: imagen JPG/PNG hasta 8 MB o video MP4/MOV hasta 200 MB
export const MEDIA_TYPES = {
  'image/jpeg': { kind: 'image', ext: 'jpg', maxBytes: 8 * 1024 * 1024 },
  'image/png': { kind: 'image', ext: 'png', maxBytes: 8 * 1024 * 1024 },
  'video/mp4': { kind: 'video', ext: 'mp4', maxBytes: 200 * 1024 * 1024 },
  'video/quicktime': { kind: 'video', ext: 'mov', maxBytes: 200 * 1024 * 1024 },
};
export const SLOTS = ['feed', 'story'];
const MB = 1024 * 1024;

export function createMediaService({ repo, storage }) {
  const purge = (key) => key && storage.remove(key).catch((err) => console.error('[media] no se pudo borrar', key, err.message));

  // El archivo llega en streaming (PUT con el archivo como cuerpo). El tipo se confirma por el contenido, no por lo declarado
  async function upload(store, creativeId, slot, { stream, mime, bytes, originalName }) {
    if (!SLOTS.includes(slot)) throw badRequest('Lugar inválido (feed o historia).');
    const type = MEDIA_TYPES[mime];
    if (!type) throw new HttpError(415, 'Elegí una imagen JPG/PNG o un video MP4/MOV.');
    if (!Number.isFinite(bytes) || bytes <= 0) throw new HttpError(411, 'Falta el tamaño del archivo.');
    if (bytes > type.maxBytes) throw new HttpError(413, `${type.kind === 'video' ? 'El video' : 'La imagen'} pesa más de ${type.maxBytes / MB} MB.`);
    const creative = await repo.getCreative(store, creativeId);
    if (creative.status !== 'unused') throw conflict('Esta pieza ya se publicó: no se le pueden cambiar los archivos.');

    const key = `${store}/${creativeId}/${slot}-${crypto.randomUUID()}.${type.ext}`;
    try {
      await storage.putStream(key, stream, bytes, mime);
    } catch (err) {
      if (err.code === 'TOO_LARGE') throw new HttpError(413, 'El archivo es más grande de lo que se declaró.');
      throw err;
    }
    try {
      const real = (await fileTypeFromBuffer(await storage.readHead(key, 4100)))?.mime;
      if (!MEDIA_TYPES[real] || MEDIA_TYPES[real].kind !== type.kind) throw new HttpError(415, 'El archivo no es una imagen JPG/PNG ni un video MP4/MOV.');
      const head = await storage.head(key);
      if (head?.bytes !== bytes) throw badRequest('El archivo no se subió completo. Probá de nuevo.');
      let width = null;
      let height = null;
      if (type.kind === 'image') {
        try {
          ({ width, height } = sizeOf(await storage.read(key)));
        } catch {
          throw new HttpError(415, 'No pudimos leer la imagen. Probá con otra.');
        }
      }
      const { row, oldKey } = await repo.setMedia(creativeId, {
        slot, kind: type.kind, storageKey: key, mime: real, bytes, width, height, originalName: String(originalName ?? '').slice(0, 200),
      });
      await purge(oldKey);
      return { ...row, url: await storage.url(key) };
    } catch (err) {
      await purge(key);
      throw err;
    }
  }

  async function removeSlot(store, creativeId, slot) {
    const creative = await repo.getCreative(store, creativeId);
    if (creative.status !== 'unused') throw conflict('Esta pieza ya se publicó: no se le pueden cambiar los archivos.');
    await purge(await repo.removeMedia(creativeId, slot));
  }

  // Para el panel: cada archivo con su link de 1 h
  const withUrl = async (m) => (m ? { id: m.id, kind: m.kind, mime: m.mime, bytes: m.bytes, width: m.width, height: m.height, original_name: m.original_name, url: await storage.url(m.storage_key) } : null);
  const withUrls = (creatives) => Promise.all(creatives.map(async (c) => ({ ...c, feed: await withUrl(c.feed), story: await withUrl(c.story) })));

  return { upload, removeSlot, withUrls, remove: purge, read: (m) => storage.read(m.storage_key), signedUrl: (m) => storage.url(m.storage_key), isRemote: storage.driver === 's3' };
}
