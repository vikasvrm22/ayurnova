/**
 * Global error handler for every existing `{error: "..."}`-shaped route
 * (admin API + server/src/routes/public.js). Phase 0 found this returning
 * raw Supabase/Postgres error text (and any other internal exception
 * message) straight to the client - e.g. a malformed query could leak a
 * column/table name.
 *
 * Fix: only an error explicitly marked `.expose = true` (our own code,
 * e.g. AppError from server/src/utils/apiResponse.js, or the image-upload
 * validation errors in server/src/storage/imageUpload.js) ever has its
 * `.message` sent to the client. Anything else - any error that reaches
 * here without that flag, which in practice is always a raw Supabase/DB
 * error or an unexpected bug - gets a generic message while the real
 * error is still fully logged server-side.
 *
 * The response shape (`{error: "<string>"}`, optionally with `fields`) is
 * kept byte-for-byte identical to before for exposed errors, because every
 * existing admin/public-site page already does `data.error` / `err.fields` -
 * changing the shape here would regress all of them.
 */
export function errorHandler(err, req, res, next) {
  const status = err.status || 500;

  if (err.expose) {
    const body = { error: err.message || "Request failed" };
    if (err.fields) body.fields = err.fields;
    return res.status(status).json(body);
  }

  console.error(err);
  res.status(status >= 500 ? status : 500).json({ error: "Internal server error" });
}
