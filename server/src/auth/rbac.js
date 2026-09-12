import { ROLE_PERMISSIONS } from "../config.js";

export function requirePermission(action) {
  return (req, res, next) => {
    const role = req.staff?.role;
    const perms = ROLE_PERMISSIONS[role];
    if (!perms || !perms[action]) {
      return res.status(403).json({ error: `Role '${role}' cannot perform '${action}'` });
    }
    next();
  };
}
