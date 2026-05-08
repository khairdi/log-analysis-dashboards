# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start both servers: Vite (port 5173) + Express (port 3001)
npm run dev:vite   # Vite only — no S3 or session features
npm run dev:server # Express only (tsx watch)
npm run build      # tsc + vite build → dist/
npm run preview    # Serve the production bundle locally
npx tsc --noEmit   # Type-check without building
```

No tests exist. `npm run build` (zero TS errors + clean bundle) is the primary correctness check.

## Architecture

Two-process local app:
- **Frontend** — React + Vite SPA at `http://localhost:5173`
- **Backend** — Express at `http://localhost:3001`, proxied via Vite at `/api`

The backend handles all log parsing, metrics computation, and S3 access. The frontend only renders pre-computed data received from server responses.

### Data flow

Both local files and S3 logs go through server-side sessions:

```
Local file upload   → POST /api/sessions          → SessionData (metrics + session ID)
S3 URI              → POST /api/sessions/from-s3  → SessionData

Filter/dim change   → POST /api/sessions/:id/query     → updated metrics + time series
Sampled logs        → POST /api/sessions/:id/rows      → paginated CfLogRow[]

WAF file upload     → POST /api/waf-sessions           → WafSessionData
WAF filter change   → POST /api/waf-sessions/:id/query → updated metrics
WAF sampled logs    → POST /api/waf-sessions/:id/rows  → paginated WafLogRow[]
```

Sessions expire after 1 hour of inactivity. S3 files are disk-cached at `~/.cloudfront-dashboard-cache/` (overridable via `CACHE_DIR` env var).

### Backend — `server/index.ts`

Single-file Express app. Key helpers:

- `matchesOp(val, op, filterValue)` — evaluates one filter against a string value. Handles all 10 operators; `in`/`not_in` split `filterValue` on `,`.
- `arrayMatchesOp(arr, op, filterValue)` — same semantics for WAF labels/ruleGroups arrays.
- `s3ForBucket(bucket)` — auto-detects bucket region via `GetBucketLocation`, caches result, returns a correctly-configured `S3Client`.

S3 date detection strategies (tried in order):
1. Hierarchical `{yyyy}/{MM}/{dd}/` folders — CloudFront partitioning key pattern
2. Flat `YYYY-MM-DD/` folders
3. Date embedded in filename

### Frontend — `src/`

**`src/types.ts`** — shared types for the CF dashboard:
- `FilterOperator` — union of 10 operators: `eq | neq | contains | not_contains | starts_with | not_starts_with | ends_with | not_ends_with | in | not_in`
- `OPERATOR_LABELS`, `OPERATOR_SYMBOL` — display strings / symbols for each operator
- `isPositiveOp(op)` — `true` for positive operators (blue chips): `eq`, `contains`, `starts_with`, `ends_with`, `in`
- `ActiveFilter` — `{ field, fieldLabel, value, type: FilterOperator }`

**`src/waf/types.ts`** — WAF-specific types. Re-exports `ActiveFilter` and `FilterOperator` from `../types`.

**`src/lib/userAgent.ts`** — imported by both the frontend and `server/index.ts`. URL-decodes CloudFront-encoded UA strings before parsing browser + OS.

**`src/lib/metrics.ts`** — `computeMetrics()`, `computeTimeSeries()`, and `filterRows()`. Imported by the server via relative path. `filterRows` mirrors server `matchesOp` logic exactly.

**`src/components/Dashboard.tsx`** — CF dashboard. Owns `activeFilters: ActiveFilter[]`, `dimension`, `dateRange`, `showAddFilter`. Every state change triggers `POST /api/sessions/:id/query`.

**`src/waf/WafDashboard.tsx`** — WAF dashboard. Same state shape; queries `/api/waf-sessions/:id/query`.

**`src/components/AddFilterPanel.tsx`** — field + operator + value form. Placeholder changes to `value1, value2, …` for `in`/`not_in`. Submits on Enter or Apply.

**`src/components/LogsTable.tsx`** — generic `LogsTable<T>` component. Accepts `Column<T>[]` and a `renderDetail` render prop. Accordion expand (one row at a time), resets on filter change. Exports `DetailField` component which shows hover `=` / `≠` filter buttons.

**`src/components/MetricTable.tsx`** — ranked list with proportional bar, pagination, optional `isIpField` prop (adds external IP lookup icon per row).

**`src/components/RequestsChart.tsx`** — Recharts `LineChart`. Single line for `dimension='all'`, top-5 coloured lines otherwise. Legend pills show filter actions on hover.

**`src/components/IpLink.tsx`** — renders an IP with a link to `whatismyipaddress.com`.

### State and filtering

`activeFilters: ActiveFilter[]` (array — multiple filters can coexist). `handleFilter` logic:
- `eq` replaces any existing `eq` on the same field (mutually exclusive; only one "equals" per field)
- All other operators are additive
- Clicking an already-active filter removes it (toggle)

`ActiveFilter.field` values must match what the server's `matchesOp` checks against:
- CF fields: CloudFront log field names (e.g. `c-country`, `sc-status`) plus virtual fields `referer-host`, `browser`, `os`
- WAF fields: `WafLogRow` property names (e.g. `action`, `clientIp`, `terminatingRule`, `label`)

### Log format assumptions

**CloudFront** — tab-delimited W3C format, gzip on S3:
- Line 1: `#Version: 1.0`, Line 2: `#Fields: date\ttime\t…`
- `-` values kept as-is; timestamps treated as UTC

**WAF** — one JSON object per line, gzip on S3. Each object has `timestamp`, `action`, `httpRequest`, `terminatingRuleId`, `labels`, `ja3Fingerprint`, `ja4Fingerprint`.

### Key CF field mappings

| Dashboard label | CloudFront field |
|---|---|
| Country | `c-country` |
| Referer host | extracted from `cs(Referer)` |
| Host | `cs(Host)` |
| Path | `cs-uri-stem` |
| Status code | `sc-status` |
| Cache status | `x-edge-result-type` |
| Data center | `x-edge-location` |
| ASN | `asn` |
| Protocol | `cs-protocol-version` |
| SSL protocol | `ssl-protocol` |
| Browser / OS | parsed from `cs(User-Agent)` (URL-decoded first) |

### Docker

- `docker-compose.yml` — local machine, mounts `~/.aws`, port 8192
- `docker-compose.ec2.yml` — EC2 with IAM instance role, no credential mount, port 80
- Production build: `esbuild` bundles `server/index.ts` → `dist/server.cjs` (self-contained, no `node_modules` needed at runtime)
