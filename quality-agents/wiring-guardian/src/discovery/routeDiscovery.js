/**
 * Best-effort static parser for this repo's Express route files.
 * This is regex/string based (not a real JS/AST parser) - it is deliberately
 * tuned to the consistent style actually used under server/src/routes/
 * (Router(), router.use(mw), router.METHOD("/path", mw1, mw2, async (req,res,next) => {...})).
 * Findings from this parser are evidence, not proof - the tool never claims
 * more precision than a regex scan can deliver.
 */

const METHOD_ROUTE_RE =
  /router\.(get|post|put|delete|patch)\(\s*(["'`])((?:(?!\2).)*)\2\s*,([\s\S]*?)(?:async\s*)?\(\s*req[\w\s,]*\)\s*=>/g;

// Matches up to the first ");" rather than the first ")" - a plain [^)]*
// boundary breaks on router.use(requireStaffAuth, requirePermission("x"))
// because requirePermission("x")'s own closing paren would end the match
// early, silently truncating the captured middleware list before
// requirePermission's argument (and its literal closing paren) is included.
const ROUTER_USE_RE = /router\.use\(([\s\S]*?)\);/g;

const AUTH_MIDDLEWARE_NAMES = ["requireStaffAuth", "requireCustomer", "attachCustomerIfPresent"];
const PERMISSION_RE = /requirePermission\(\s*["'`]([^"'`]+)["'`]\s*\)/;

function extractMiddlewareNames(argsText) {
  const found = [];
  for (const name of AUTH_MIDDLEWARE_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(argsText)) found.push(name);
  }
  const permMatch = argsText.match(PERMISSION_RE);
  if (permMatch) found.push(`requirePermission(${permMatch[1]})`);
  return found;
}

/** Parses one route file's source text into a list of route entries. */
export function parseRouteFile(sourceText, relPath) {
  const fileLevelMiddleware = [];
  for (const m of sourceText.matchAll(ROUTER_USE_RE)) {
    fileLevelMiddleware.push(...extractMiddlewareNames(m[1]));
  }

  const matches = [...sourceText.matchAll(METHOD_ROUTE_RE)];
  const routes = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const method = m[1].toUpperCase();
    const routePath = m[3];
    const routeMiddleware = extractMiddlewareNames(m[4]);
    const lineStart = sourceText.slice(0, m.index).split("\n").length;

    const blockStart = m.index + m[0].length;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : sourceText.length;
    const body = sourceText.slice(blockStart, blockEnd);

    const inlineCustomerCheck = /if\s*\(\s*!\s*req\.customer/.test(body);
    const inlineStaffCheck = /if\s*\(\s*!\s*req\.staff/.test(body);
    const usesReqCustomer = /req\.customer\b/.test(body);
    const usesReqStaff = /req\.staff\b/.test(body);
    // Guest-optional access (req.customer?.x) or a truthy/&& guard around
    // req.customer is this repo's established "works for guests too"
    // pattern (e.g. server/src/routes/public.js dosha-results,
    // server/src/routes/paymentsPublic.js verify/retry) - distinct from an
    // unguarded req.customer.x that assumes a customer is always present.
    const hasOptionalOrGuardedCustomerAccess =
      /req\.customer\?\./.test(body) || /req\.customer\s*&&/.test(body) || /req\.customer\s*\?[^.]/.test(body) || /if\s*\(\s*req\.customer\s*\)/.test(body);
    const rpcCalls = [...body.matchAll(/\.rpc\(\s*["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
    const tableAccess = [...body.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\)/g)].map((x) => x[1]);
    const notifyEvents = [...body.matchAll(/\bnotify\(\s*["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);

    routes.push({
      file: relPath,
      method,
      routePath,
      line: lineStart,
      fileLevelMiddleware: [...new Set(fileLevelMiddleware)],
      routeMiddleware: [...new Set(routeMiddleware)],
      inlineCustomerCheck,
      inlineStaffCheck,
      usesReqCustomer,
      usesReqStaff,
      hasOptionalOrGuardedCustomerAccess,
      rpcCalls: [...new Set(rpcCalls)],
      tableAccess: [...new Set(tableAccess)],
      notifyEvents: [...new Set(notifyEvents)],
      mutating: method !== "GET",
    });
  }
  return routes;
}
