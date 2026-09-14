import { walkFiles, readText } from "./fsWalk.js";

/** Scans server/src/services + server/src/notify + server/src/routes for
 * every notify("event_name", ...) call site. Route-level notify() calls are
 * already captured per-route by routeDiscovery, but several lifecycle
 * events (order_shipped, order_delivered, ...) are fired from service
 * modules (shipmentService.js, returnsService.js), not from route handlers
 * directly - this pass covers those so the workflow engine's event checks
 * aren't blind to them. */
export function discoverNotifyEvents(serverRoot) {
  const files = [
    ...walkFiles(`${serverRoot}/src/services`, [".js"]),
    ...walkFiles(`${serverRoot}/src/notify`, [".js"]),
    ...walkFiles(`${serverRoot}/src/routes`, [".js"]),
  ];
  const events = new Map(); // eventName -> [{file, line}]
  for (const file of files) {
    const src = readText(file);
    for (const m of src.matchAll(/\bnotify\(\s*["'`]([^"'`]+)["'`]/g)) {
      const lineNo = src.slice(0, m.index).split("\n").length;
      const relPath = file.split(serverRoot)[1]?.replace(/\\/g, "/").replace(/^\//, "") || file;
      const key = m[1];
      if (!events.has(key)) events.set(key, []);
      events.get(key).push({ file: `server/${relPath}`, line: lineNo });
    }
  }
  const eventsOut = {};
  for (const [k, v] of events) eventsOut[k] = v;
  return eventsOut;
}
