import { makeFinding } from "../evidence/Finding.js";

function routeFileBaseName(relPath) {
  return relPath.split("/").pop();
}

/** Builds Layer 3 (module -> module) graph nodes/edges from real evidence:
 * each module's node is the set of DB tables its routes actually touch
 * (from routeDiscovery's tableAccess), and an edge module A -> module B
 * exists when a table A touches has a foreign key into a table B touches
 * (schemaDiscovery.fkEdges), i.e. A's writes/reads are structurally
 * connected to B's data. Flags modules with zero graph edges as leads to
 * check (a genuinely standalone module is fine; a module that SHOULD
 * connect to checkout/orders but doesn't is a real gap). */
export function buildModuleGraph(evidence, modulesConfig) {
  const fileToModule = new Map();
  for (const [moduleName, def] of Object.entries(modulesConfig.modules)) {
    for (const f of def.routeFiles) fileToModule.set(f, moduleName);
  }

  const moduleTables = new Map(); // moduleName -> Set(table)
  for (const r of evidence.server.routes) {
    const moduleName = fileToModule.get(routeFileBaseName(r.file));
    if (!moduleName) continue;
    if (!moduleTables.has(moduleName)) moduleTables.set(moduleName, new Set());
    for (const t of r.tableAccess) moduleTables.get(moduleName).add(t);
  }

  const tableToModules = new Map(); // table -> Set(moduleName)
  for (const [moduleName, tables] of moduleTables) {
    for (const t of tables) {
      if (!tableToModules.has(t)) tableToModules.set(t, new Set());
      tableToModules.get(t).add(moduleName);
    }
  }

  const edgeSet = new Set();
  const edges = [];
  for (const fk of evidence.schema.fkEdges) {
    const fromModules = tableToModules.get(fk.fromTable) || new Set();
    const toModules = tableToModules.get(fk.toTable) || new Set();
    for (const fm of fromModules) {
      for (const tm of toModules) {
        if (fm === tm) continue;
        const key = `${fm}->${tm}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ from: fm, to: tm, via: `${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}` });
      }
    }
  }

  const connected = new Set();
  for (const e of edges) {
    connected.add(e.from);
    connected.add(e.to);
  }

  const nodes = [...moduleTables.entries()].map(([name, tables]) => ({
    module: name,
    tables: [...tables].sort(),
    routeFiles: modulesConfig.modules[name].routeFiles,
    connected: connected.has(name),
  }));

  const findings = [];
  for (const node of nodes) {
    if (node.connected || node.tables.length === 0) continue;
    findings.push(
      makeFinding({
        layer: "L3-module-to-module",
        category: "module-graph",
        module: node.module,
        file: node.routeFiles.map((f) => `server/src/routes/${f}`).join(", "),
        route: null,
        observed: `Module '${node.module}' touches table(s) ${JSON.stringify(node.tables)} but has no discovered foreign-key edge to or from any other module's tables.`,
        expected: "Most product modules are structurally connected to at least one neighbor (e.g. via order_id/product_id) - a fully isolated module is a lead to check.",
        evidence: `buildModuleGraph found 0 fkEdges touching ${JSON.stringify(node.tables)} in either direction.`,
        severity: "P3",
        confidence: "low",
        recommendedFix: "Confirm this module is intentionally standalone (e.g. reference/content data with no order linkage) rather than a missed relationship.",
      })
    );
  }

  return { nodes, edges, findings };
}
