import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Interfaz común: putStream(key, stream, maxBytes, mime) · read(key) → Buffer · readHead(key, n) → Buffer
//   head(key) → { bytes } | null · remove(key) · url(key) → URL para ver el archivo (1 h)
// Los archivos pasan en streaming por el servidor: no hace falta CORS en el bucket y no se cargan en memoria.

// Corta la subida si llegan más bytes de los permitidos
function byteLimit(maxBytes) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes) {
        const err = new Error('El archivo es más grande de lo permitido.');
        err.code = 'TOO_LARGE';
        return cb(err);
      }
      cb(null, chunk);
    },
  });
}

export function createLocalStorage({ dir, secret }) {
  const root = path.resolve(dir);
  const full = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('clave inválida');
    return p;
  };
  const sign = (key, exp) => crypto.createHmac('sha256', secret).update(`${key}|${exp}`).digest('base64url');

  return {
    driver: 'local',
    async putStream(key, stream, maxBytes) {
      const p = full(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      try {
        await pipeline(stream, byteLimit(maxBytes), createWriteStream(p));
      } catch (err) {
        await fs.rm(p, { force: true });
        throw err;
      }
    },
    read: (key) => fs.readFile(full(key)),
    async readHead(key, n) {
      const fh = await fs.open(full(key));
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    async head(key) {
      try {
        return { bytes: (await fs.stat(full(key))).size };
      } catch {
        return null;
      }
    },
    remove: (key) => fs.rm(full(key), { force: true }),
    // Link firmado que sirve /api/media (las etiquetas <img>/<video> no mandan el token de sesión)
    async url(key) {
      const exp = Date.now() + 3600_000;
      return `/api/media?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sign(key, exp)}`;
    },
    // Para la ruta /api/media: devuelve el stream si la firma es válida
    openSigned({ key, exp, sig }) {
      if (!key || !sig || Number(exp) < Date.now()) return null;
      const expected = Buffer.from(sign(key, exp));
      const got = Buffer.from(String(sig));
      if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
      return createReadStream(full(key));
    },
  };
}

export async function createS3Storage({ endpoint, region, bucket, accessKeyId, secretAccessKey }) {
  const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  // Sin checksums automáticos (SDK ≥3.729): algunos S3 compatibles rechazan las subidas con checksum
  const client = new S3Client({
    endpoint, region, credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const body = async (out) => Buffer.from(await out.Body.transformToByteArray());

  return {
    driver: 's3',
    async putStream(key, stream, maxBytes, mime) {
      const limited = byteLimit(maxBytes);
      // Subida por partes: el archivo nunca está entero en memoria
      const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: limited, ContentType: mime } });
      await Promise.all([pipeline(stream, limited), upload.done()]).catch(async (err) => {
        await upload.abort().catch(() => {});
        throw err;
      });
    },
    read: async (key) => body(await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))),
    readHead: async (key, n) => body(await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${n - 1}` }))),
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { bytes: out.ContentLength };
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    remove: (key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    // URL firmada: el bucket es privado. Meta también baja los videos desde acá
    url: (key) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 }),
  };
}
