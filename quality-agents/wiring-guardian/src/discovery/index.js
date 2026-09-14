import path from "path";
import { discoverServer } from "./serverDiscovery.js";
import { discoverFrontend } from "./frontendDiscovery.js";
import { discoverSchema } from "./schemaDiscovery.js";
import { discoverNotifyEvents } from "./notifyDiscovery.js";

/** Runs all discovery passes against the real repository and returns one
 * evidence bundle every downstream engine (contract/state/RBAC/feature-flag/
 * workflow) consumes. Nothing here is invented - every field traces back to
 * a specific file the discovery parsers actually read. */
export function runDiscovery(repoRoot) {
  const serverRoot = path.join(repoRoot, "server");
  const server = discoverServer(serverRoot);
  const frontend = discoverFrontend(repoRoot);
  const schema = discoverSchema(path.join(repoRoot, "supabase"));
  const notifyEvents = discoverNotifyEvents(serverRoot);
  return { repoRoot, discoveredAt: new Date().toISOString(), server, frontend, schema, notifyEvents };
}
