import path from "path";
import fs from "fs";
import { readText } from "./fsWalk.js";

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/i;
const ALTER_TABLE_RE = /alter\s+table\s+"?(\w+)"?/i;
const CHECK_RE = /"?(\w+)"?\s+in\s*\(([^()]+)\)/gi;
const RLS_ENABLE_RE = /alter\s+table\s+"?(\w+)"?\s+enable\s+row\s+level\s+security/gi;
const POLICY_RE = /create\s+policy\s+"?[^"]*"?\s+on\s+"?(\w+)"?/gi;
const FK_INLINE_RE = /"?(\w+)"?\s+(?:uuid|bigint|int|integer|text)[^,()]*references\s+(?:"?\w+"?\.)?"?(\w+)"?/gi;
const FK_ALTER_RE = /add\s+(?:constraint\s+\w+\s+)?foreign\s+key\s*\(\s*"?(\w+)"?\s*\)\s*references\s+(?:"?\w+"?\.)?"?(\w+)"?/gi;

/** Splits a SQL file into naive top-level statements (semicolon-terminated).
 * Good enough for this repo's straightforward, comment-light migration style. */
function splitStatements(sql) {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses supabase/schema.sql + supabase/migrations/*.sql for tables, lifecycle
 * status columns (from CHECK (...IN (...)) constraints, matched to the table
 * each statement targets), and RLS policy presence. This is the ground truth
 * the state-engine validates workflow definitions against. */
export function discoverSchema(supabaseRoot) {
  const schemaFile = path.join(supabaseRoot, "schema.sql");
  const migrationsDir = path.join(supabaseRoot, "migrations");

  const files = [schemaFile, ...(fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(migrationsDir, f))
    : [])];

  const tables = new Set();
  const stateColumns = new Map(); // "table.column" -> { values:Set, sources:[{file,statementPreview}] }
  const rlsEnabledTables = new Set();
  const policyTables = new Map(); // table -> count
  const fkEdges = []; // { fromTable, fromColumn, toTable }

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const relFile = path.relative(supabaseRoot, file).split(path.sep).join("/");
    const sql = readText(file);

    for (const m of sql.matchAll(RLS_ENABLE_RE)) rlsEnabledTables.add(m[1]);
    for (const m of sql.matchAll(POLICY_RE)) policyTables.set(m[1], (policyTables.get(m[1]) || 0) + 1);

    for (const stmt of splitStatements(sql)) {
      const createMatch = stmt.match(CREATE_TABLE_RE);
      const alterMatch = stmt.match(ALTER_TABLE_RE);
      const table = createMatch?.[1] || alterMatch?.[1];
      if (!table) continue;
      if (createMatch) tables.add(table);

      if (/check\s*\(/i.test(stmt)) {
        for (const cm of stmt.matchAll(CHECK_RE)) {
          const column = cm[1];
          const valuesRaw = cm[2];
          const values = [...valuesRaw.matchAll(/'([^']*)'/g)].map((x) => x[1]);
          if (!values.length) continue;
          const key = `${table}.${column}`;
          if (!stateColumns.has(key)) stateColumns.set(key, { table, column, values: new Set(), sources: [] });
          const entry = stateColumns.get(key);
          for (const v of values) entry.values.add(v);
          entry.sources.push({ file: `supabase/${relFile}`, valuesInThisStatement: values });
        }
      }

      if (createMatch) {
        for (const fm of stmt.matchAll(FK_INLINE_RE)) {
          fkEdges.push({ fromTable: table, fromColumn: fm[1], toTable: fm[2] });
        }
      }
      for (const fm of stmt.matchAll(FK_ALTER_RE)) {
        fkEdges.push({ fromTable: table, fromColumn: fm[1], toTable: fm[2] });
      }
    }
  }

  const stateColumnsOut = {};
  for (const [key, entry] of stateColumns) {
    stateColumnsOut[key] = { table: entry.table, column: entry.column, values: [...entry.values].sort(), sources: entry.sources };
  }

  return {
    files: files.filter((f) => fs.existsSync(f)).map((f) => path.relative(supabaseRoot, f)),
    tables: [...tables].sort(),
    stateColumns: stateColumnsOut,
    rlsEnabledTables: [...rlsEnabledTables].sort(),
    tablesWithPolicies: [...policyTables.keys()].sort(),
    tablesRlsNoPolicy: [...rlsEnabledTables].filter((t) => !policyTables.has(t)).sort(),
    fkEdges: dedupeEdges(fkEdges).filter((e) => tables.has(e.toTable)),
  };
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const key = `${e.fromTable}.${e.fromColumn}->${e.toTable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
