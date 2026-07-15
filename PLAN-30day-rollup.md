# 30-day day-level rollup view (CloudFront dashboard)

## Context

User wants to load ~30 days of CloudFront logs with day-level aggregations. Sizing against the real bucket (`logs.sportskeeda.com`, last 30 days): **47,132 files, 120.7 GB gzip on S3**, decompressing to an estimated 700-900 GB of raw text. The current session model (`server/index.ts` `Session`/`sessions` + `computeFromFilePaths`) keeps decompressed text cached on disk per file and **re-parses every cached file from scratch on every filter/dimension change** — workable for a few files, not for tens of thousands.

Clarified requirements:
- Aggregates only — no raw-row drill-down (`LogsTable`) across the 30 days. Existing single/few-file session flow stays as-is for that.
- Filtering on this view is scoped to **country + device type** only (both low-cardinality, so a per-day joint cube is cheap: ~200 countries × 3 devices × 30 days ≈ 18k cells). Other breakdowns (top path/status/browser/host/etc.) are shown as fixed, unfiltered top-N reference tables — recomputing those under arbitrary filters would require keeping raw rows, which we're explicitly not doing.
- No local download or caching for this path — query S3 directly via S3 Select rather than pulling whole files.

## Approach

New parallel session type, `RollupSession`, that queries every file via **S3 Select** (`SelectObjectContentCommand`, already available via `@aws-sdk/client-s3` — no new dependency) instead of downloading it. S3 filters/projects server-side against the gzipped object directly (`CompressionType: 'GZIP'`, no local gunzip needed) and only the columns we need stream back — nothing is downloaded whole, nothing is cached locally, and each file's narrow result is folded into aggregates immediately and discarded.

Column set requested per file: the same ~10 fields the existing `Metrics` type breaks down by — `date`, `time`, `c-country`, `cs(User-Agent)`, `sc-bytes`, `cs-uri-stem`, `sc-status`, `cs(Host)`, `x-edge-result-type`, `cs-protocol-version`, `x-edge-location`, `asn`, `ssl-protocol`. Still a small fraction of full-row bytes, and it keeps the 30-day view's top-N tables working like the normal dashboard's (confirmed with user: wider column set over narrower/cheaper, to keep those tables). `byIp` is dropped from this view (IP not worth the extra column for a 30-day rollup).

Reused as-is: `cfLineGetter`/`newCfLineState` (for the one-time header peek below), `parseUserAgent` (browser/os/device), `getRefererHost`, `matchesOp`, `mapToEntries`, and on the frontend `RequestsChart` and `MetricTable` (both already generic over `TimeSeriesPoint[]`/`MetricEntry[]`, no changes needed) and `AddFilterPanel`.

### Backend (`server/index.ts`)

1. **`RollupSession` store** — parallel to the existing `sessions`/`wafSessions` maps, same 1-hour idle-expiry `setInterval` pattern. Holds per session: `days: string[]`, `dayTotals: Map<day, {count, bytes}>`, `dayCountryDevice: Map<day, Map<"country\tdevice", {count, bytes}>>`, the unfiltered overall `Metrics` (top-N tables), `rowCount`, `dataMin`/`dataMax`, `lastAccess`. No file paths, no rows.

2. **`listFilesForDate(bucket, prefix, mode, date, profile)`** — extract the existing per-date listing logic out of the `/api/s3/files` handler into a reusable function so the new endpoint can call it once per day in range.

3. **Query via S3 Select**:
   - **JSON-format files**: `SELECT s.date, s.time, s."c-country", s."cs(User-Agent)", s."sc-bytes", s."cs-uri-stem", s."sc-status", ... FROM S3Object s` — field names match our JSON keys directly, no schema discovery needed.
   - **Legacy tab-delimited files**: S3 Select CSV input can't read our `#Fields:` comment header as a schema, so columns are addressed positionally (`s._1`, `s._2`, …) with `Comments: '#'` (skips `#Version:`/`#Fields:` lines) and `FieldDelimiter: '\t'`. Do **one** cheap one-time peek before the main loop — a ranged `GetObjectCommand` (first ~4KB) on the first file in the range, run through the existing `cfLineGetter` just to read its `#Fields:` line — to learn the field→index mapping for this distribution, then build the positional `SELECT` once and reuse for every other file (safe: format is fixed per distribution, same assumption the current code already makes by detecting format once per whole file batch).
   - Parse each returned narrow row (`parseUserAgent` for browser/os/device — S3 Select can't run our JS regex), accumulate into `dayTotals`, `dayCountryDevice`, and the overall unfiltered breakdown maps (country/path/host/status/cache/protocol/dc/asn/browser/os/device/ssl — same fields as today's `Metrics` minus `byIp`).
   - Cap concurrency (e.g. 15-20 concurrent `SelectObjectContentCommand` calls) with a small worker-pool helper — still one call per file (~47k for a full 30-day range), bounding wall time to roughly AWS Select-request latency × files ÷ concurrency rather than full-file download bandwidth. Log per-day completion (`[rollup] 2026-07-09: 1103 files, 812340 rows`) matching the existing `[s3 fetch]`/`[cache save]` style for visibility during a long load. Cost: S3 Select bills per GB scanned (~$0.002/GB) — a few dollars at most for a full 30-day/120GB range.

4. **`POST /api/sessions/rollup`** — body `{ bucket, prefix, mode, startDate, endDate, profile? }` (same shape the picker already has from `/api/s3/dates`). Runs the loop above, stores the `RollupSession`, returns `{ sessionId, days, rowCount, dataMin, dataMax, points, keys: ['requests'], metrics }` where `points` is one entry per day (reuses `TimeSeriesPoint` shape so `RequestsChart` needs no changes).

5. **`POST /api/sessions/rollup/:id/query`** — body `{ filters: ActiveFilter[] }` (only `field: 'c-country'` / `field: 'device'` are meaningful; anything else is ignored). Scans the small in-memory `dayCountryDevice` cube — cheap, no disk or network I/O — applying `matchesOp` per filter against each cell's country/device, summing matches per day. Returns `{ points, keys: ['requests'], filteredTotal, filteredBytes }`. Does **not** recompute the top-N tables (documented limitation, shown in the UI as "unfiltered, last N days").

### Types (`src/types.ts`)

Add `RollupSessionData` and `RollupQueryResult` interfaces mirroring `SessionData`/`QueryResult` but with `days`, `metrics` (single `Metrics`, not table+filtered pair), `filteredTotal`, `filteredBytes` in place of `tableMetrics`/`filteredMetrics`.

### Frontend

- **`S3Picker.tsx`** — add a small mode toggle ("Single date" / "Day-by-day rollup"). In rollup mode, swap the single-date list for two date inputs (start/end, bounded to `dateInfo.dates`) and a "Load N-day rollup" button that POSTs to `/api/sessions/rollup` and calls a new `onRollupSession` prop instead of `onSession`.
- **`FilePicker.tsx`** — thread `onRollupSession` down to `S3Picker`.
- **New `src/components/RollupDashboard.tsx`** — header (bucket, date range, day count) + `RequestsChart` (daily trend) + a 2-field `AddFilterPanel` (`c-country`, `device`) driving `/api/sessions/rollup/:id/query` + active-filter chips (same pattern as `Dashboard.tsx`, inlined — small enough not to warrant extracting a shared component) + `MetricTable` panels off the static `metrics` (labeled "unfiltered, last N days").
- **`App.tsx`** — add `rollupSession` state, route to `RollupDashboard` when set.

## Verification

1. `npx tsc --noEmit` and `npm run build` — must stay clean.
2. Backend smoke test via curl against the real `logs.sportskeeda.com` bucket with a **short 2-3 day range first** (not the full 30 — even S3 Select is ~47k requests for the full range and will take real wall-clock time): confirm `rowCount`, `points` (one per day), and `metrics.byCountry`/`byDevice` look sane; then hit `/query` with a country and a device filter and confirm `filteredTotal` drops appropriately and points shift.
3. Browser: load the picker, switch to rollup mode, pick a short range, confirm the day chart renders, apply a country filter and a device filter (individually and combined), confirm the chart/total updates, confirm the top-N tables render.
4. Only after that works, try a longer range (e.g. 7-14 days) and sanity-check load time before recommending a full 30-day load.
