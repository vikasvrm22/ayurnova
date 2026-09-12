/**
 * Phase 1 API envelope helpers for the new public catalog endpoints
 * (server/src/routes/catalogPublic.js). Existing routes keep their
 * original `{item}`/`{items,total}`/`{error}` response shapes unchanged -
 * changing those would break every existing admin/public-site page that
 * already destructures those exact fields. New endpoints start clean with
 * this envelope instead of inheriting the old ad-hoc shapes.
 */

export function sendOk(res, data, meta, status = 200) {
  const body = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  return res.status(status).json(body);
}

export function sendFail(res, status, code, message, fields) {
  const body = { success: false, error: { code, message } };
  if (fields) body.error.fields = fields;
  return res.status(status).json(body);
}

/** Thrown deliberately by route/service code for a condition that is safe
 * to describe to the client (a 4xx caused by bad/missing input, a 404, an
 * explicit conflict, etc). `expose: true` marks it as such. Anything else
 * thrown (a raw Supabase/Postgres error, a programming bug) has no
 * `.expose` flag and must never have its raw `.message` sent to the client -
 * see server/src/middleware/errorHandler.js.
 *
 * `fields` (optional, Phase 6A) carries a field->message validation map,
 * the same shape validateAddress()/validateVariant() etc already return -
 * lets new-envelope routes report per-field errors the same way the older
 * `{error, fields}` admin routes always have, without inventing a second
 * convention. Omitted entirely (not even an empty object) when not given,
 * so every existing AppError call site is unaffected. */
export class AppError extends Error {
  constructor(message, status = 400, code = "BAD_REQUEST", fields) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.expose = true;
    if (fields) this.fields = fields;
  }
}

/** Wraps an async Express handler so a thrown/rejected error reaches
 * `next(e)` automatically instead of needing a try/catch in every route. */
export function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Error-handling middleware for routers that use the new {success,data}/
 * {success,error} envelope end-to-end (currently only catalogPublic.js).
 * Must be registered with `router.use(...)` AFTER all of that router's
 * routes. Mirrors the safety rule in the global errorHandler: only
 * `AppError`s (or anything explicitly marked `.expose = true`) ever get
 * their message shown to the client; everything else becomes a generic
 * 500 with the real error logged server-side only. */
export function catalogErrorHandler(err, req, res, next) {
  if (err.expose) {
    return sendFail(res, err.status || 400, err.code || "BAD_REQUEST", err.message, err.fields);
  }
  console.error("[catalogPublic] unexpected error:", err);
  return sendFail(res, 500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}
