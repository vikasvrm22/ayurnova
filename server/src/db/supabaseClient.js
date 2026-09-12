import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

let serviceClient = null;

/** The server's own client, using the SERVICE ROLE key. This bypasses RLS
 * entirely - it's the equivalent trust boundary to the Jobs11 build's
 * service-account Sheets client: only the Express server holds this key,
 * never the browser, and every route that uses it enforces its own
 * auth/RBAC checks before touching the database. */
export function supabaseAdmin() {
  if (serviceClient) return serviceClient;
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error(
      "Supabase not configured - set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env. See SETUP.md."
    );
  }
  serviceClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
  return serviceClient;
}

/** A client scoped to a specific customer's Supabase Auth JWT (from the
 * storefront's Authorization header) - used for the few endpoints that act
 * "as the customer" (e.g. reading their own orders), so Postgres RLS
 * policies apply exactly as if the customer queried Supabase directly. */
export function supabaseAsCustomer(accessToken) {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error("Supabase not configured - set SUPABASE_URL and SUPABASE_ANON_KEY in server/.env.");
  }
  return createClient(config.supabase.url, config.supabase.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });
}
