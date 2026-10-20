export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg) => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
export const unavailable = (msg) => new HttpError(503, msg);
