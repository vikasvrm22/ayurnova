import fs from "fs";
import path from "path";
import os from "os";
import { discoverSchema } from "../../src/discovery/schemaDiscovery.js";
import { assert, assertEqual } from "../helpers.js";

const SCHEMA_SQL = `
create table orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  status text not null default 'pending' check (status in ('pending', 'processing', 'cancelled'))
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id)
);

alter table orders enable row level security;
create policy "orders_owner" on orders for select using (true);
`;

const MIGRATION_SQL = `
alter table orders add constraint orders_status_check2 check (status in ('pending', 'processing', 'cancelled', 'shipped'));
`;

export default async function () {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wg-schema-test-"));
  fs.writeFileSync(path.join(tmpRoot, "schema.sql"), SCHEMA_SQL, "utf8");
  fs.mkdirSync(path.join(tmpRoot, "migrations"));
  fs.writeFileSync(path.join(tmpRoot, "migrations", "0001_widen.sql"), MIGRATION_SQL, "utf8");

  const result = discoverSchema(tmpRoot);

  assert(result.tables.includes("orders"), "discovers the orders table");
  assert(result.tables.includes("order_items"), "discovers the order_items table");

  const statusCol = result.stateColumns["orders.status"];
  assert(statusCol, "discovers orders.status as a state column");
  assertEqual(statusCol.values, ["cancelled", "pending", "processing", "shipped"], "unions CHECK values across schema.sql + a later widening migration");

  assert(result.rlsEnabledTables.includes("orders"), "detects RLS enabled on orders");
  assert(result.tablesWithPolicies.includes("orders"), "detects a policy exists on orders");
  assertEqual(result.tablesRlsNoPolicy, [], "orders has RLS enabled AND a policy, so it's not in the no-policy list");

  const fk = result.fkEdges.find((e) => e.fromTable === "order_items" && e.toTable === "orders");
  assert(fk, "discovers the order_items -> orders foreign key edge");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { tables: result.tables.length };
}
