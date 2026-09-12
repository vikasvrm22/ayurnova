import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signStaffToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: "12h" }
  );
}

/** Verifies the admin panel's own JWT (staff login) - separate from
 * customer auth, which uses Supabase Auth tokens instead (see
 * customerAuth.js). Attach as middleware on every /api/admin/* route. */
export function requireStaffAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.staff = { id: payload.sub, email: payload.email, role: payload.role, name: payload.name };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
