/** Safe auto-fix for the "/staff" contract-engine findings (checkContracts.js).
 * admin/users.html calls Api.get("/staff") etc, which the Api wrapper turns
 * into GET /api/admin/staff - but the actual staff-management routes are
 * defined inside server/src/routes/adminAuthRoutes.js, mounted at
 * /api/admin/auth (server/src/index.js: app.use("/api/admin/auth",
 * adminAuthRoutes)), so the real path is /api/admin/auth/staff. Every
 * staff-management action on this page 404s today. Deterministic,
 * localized, one-file path-prefix correction - no business logic touched. */
export function applyAdminStaffPath(html) {
  const replacements = [
    ['Api.get("/staff")', 'Api.get("/auth/staff")'],
    ["Api.put(`/staff/${id}`", "Api.put(`/auth/staff/${id}`"],
    ["Api.post(`/staff/${id}/deactivate`", "Api.post(`/auth/staff/${id}/deactivate`"],
    ['Api.post("/staff/invite"', 'Api.post("/auth/staff/invite"'],
  ];
  let out = html;
  let changedCount = 0;
  for (const [before, after] of replacements) {
    if (out.includes(before)) {
      out = out.replace(before, after);
      changedCount += 1;
    }
  }
  if (changedCount === 0) {
    throw new Error("adminStaffPath fixer: none of the expected Api.*(\"/staff...\") call sites were found - refusing to guess, file may have changed.");
  }
  return out;
}
