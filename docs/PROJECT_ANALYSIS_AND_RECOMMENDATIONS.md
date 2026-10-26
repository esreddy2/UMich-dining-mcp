# UMich Dining MCP — Comprehensive Project Analysis, Verification & Roadmap

**Date**: 2026-10-26  
**Repository**: `/home/dev/projects/personal/UMich-dining-mcp`  
**Reference & Research Mirror**: `/home/dev/tmp/kilo/personal/UMich-dining-mcp/`  

---

## 1. Executive Summary

A comprehensive verification, code review, and performance audit of the **UMich Dining MCP** server was conducted. The project is in a highly capable state following the v2.0 rebuild, featuring a compact coded-row data format, dual transport capabilities (stdio and StreamableHTTP), an independent Python ground-truth test oracle, and hybrid support for both scraping and the reverse-engineered private OpenShift JSON API.

All automated test suites, typechecks, linters, and oracle checks pass with 100% compliance. However, detailed investigation uncovered several high-impact architectural bottlenecks, subtle runtime bugs, documentation discrepancies, and major token/network optimization opportunities.

---

## 2. Verification & Health Audit

| Verification Check | Target / Command | Status | Details |
|---|---|---|---|
| **Unit & Integration Suite** | `npm test` (`vitest run`) | **PASS** | 34 test files, 562 tests passing (~11.6s) |
| **Type Safety** | `npm run typecheck` (`tsc --noEmit`) | **PASS** | 0 TypeScript errors across strict mode |
| **Linting** | `npm run lint` (`eslint .`) | **PASS** | 0 lint warnings or errors |
| **Production Build** | `npm run build` (`tsc -p tsconfig.build.json`) | **PASS** | Clean build to `dist/` |
| **Ground-Truth Oracle** | `npm run test:oracle` (`python3 build_expected.py --check`) | **PASS** | Exact match on 562 items & 550 panels across 10 dining halls |
| **Payload Budget Test** | `npx vitest run tests/payload-size.test.ts` | **PASS** | `tools/list` within 24,000-byte budget; sweep row <100 bytes |
| **Live Network Test** | `npm run test:live` (`vitest.live.config.ts`) | **FAIL (Nocturnal Fragility)** | Fails late at night (after ~9 PM EDT) due to unpinned time-of-day in assertions |

---

## 3. Discrepancies & Fixes Identified

### 3.1. Server Version Mismatch (`src/server.ts:41`)
- **Issue**: `src/server.ts` hardcodes `const SERVER_VERSION = '0.2.0';`, while `package.json` is at `"2.0.0"` (tagged and released as v2.0.0).
- **Impact**: MCP clients connecting via JSON-RPC initialize handshake with version `0.2.0`, causing version reporting confusion in MCP client dashboards.
- **Fix**: Update `SERVER_VERSION` in `src/server.ts` to `'2.0.0'`, or read dynamically from `package.json`.

### 3.2. Stale Documentation in `README.md`
- **Issue 1**: `README.md` line 80 lists `search_dishes` as an active tool, but `search_dishes` was removed/consolidated into `filter_dishes` (via the `query` argument).
- **Issue 2**: `README.md` does not list the new `get_dining_occupancy` tool registered in `src/server.ts`.
- **Issue 3**: `README.md` lines 11–13 state *"nothing is written to disk and no menu is mirrored"*, which is obsolete now that the persistent disk cache (`src/disk-cache.ts`) writes to `~/.cache/umich-dining-mcp`.
- **Fix**: Synchronize `README.md` with `docs/tool-reference.md` and `src/server.ts`.

### 3.3. Location Details Erased in API Mode (`src/service.ts:445`)
- **Issue**: `loadHallPageFromApi` sets `location: EMPTY_LOCATION` (`address: null, phone: null, email: null, mapUrl: null`). When the private API path is active, `list_locations` returns `null` for all four fields across every dining hall.
- **Root Cause**: `loadHallPageFromApi` only fetches `/dining/menu` and `/dining/meal-hours`, omitting the location metadata.
- **Fix**: Populate `location` using the data available from `GET /dining/locations` (which provides street, city, postal code, phone, email, and coordinates).

### 3.4. Redundant & Fragile Breakfast Probe in `loadHallPageFromApi` (`src/service.ts:354–360`)
- **Issue**: `loadHallPageFromApi` executes a probe call to `/dining/menu?meal=BREAKFAST` to test API availability before querying other meals. It then immediately fetches `BREAKFAST` a second time inside `Promise.all`.
- **Impact**: Doubles HTTP calls for breakfast. More critically, if a hall does not serve breakfast (e.g. Sunday schedules or holiday hours), any failure on breakfast causes the entire API fetch to abort with *"The dining API could not be read"*, forcing a fallback to scraping even when Brunch, Lunch, and Dinner are healthy.
- **Fix**: Remove the preliminary breakfast health probe. Query meals in parallel and treat missing/empty meal responses as unserved periods.

### 3.5. Occupancy Field Verification (`src/service.ts:1814–1825`)
- **Finding**: Testing against the live Michigan app confirmed that the upstream API field `capacity_count` is **already the percentage full** (e.g. `capacity_count: "20"` corresponds to 20% displayed in the Michigan app), **not** the raw headcount.
- **Resolution**: `percent` is taken directly from `capacity_count` (e.g. 20%). The current headcount `current` is derived from `Math.round((percent / 100) * total)` (e.g. 20% of 140 = 28 people). This resolves the ambiguity where both `current` and `percent` were previously set to 20.

### 3.6. Daytime-Dependent Failure in `tests/live.test.ts`
- **Issue**: Calling `getMenu('bursley', todayIn())` without specifying a meal or a mock timestamp causes `autoMeals()` to pick the meal for the current wall-clock time. When running between 9:00 PM and midnight EDT, all dining periods have concluded, resulting in 0 meals and assertion failures on `countItems > 0`.
- **Fix**: In `tests/live.test.ts`, explicitly pass all meals: `getMenu('bursley', todayIn(), ['Breakfast', 'Brunch', 'Lunch', 'Dinner'])` or supply a fixed midday `Date`.

### 3.7. Decouple Hardcoded API Credentials into Config (`src/service.ts:263–264`)
- **Issue**: `API_BASE` and `API_KEY` are hardcoded in `src/service.ts`.
- **Fix**: Export `apiBase` and `apiKey` from `src/config.ts` with environment variable overrides (`UMICH_DINING_API_BASE`, `UMICH_DINING_API_KEY`).

---

## 4. Token Economy & LLM Context Optimizations

MCP tool specifications and payloads are injected directly into LLM contexts on every turn. The following optimizations can significantly reduce token consumption:

1. **Compress `tools/list` Definitions (~1,500–2,000 tokens saved)**:
   - Currently, `tools/list` weighs ~23.8 KB (close to the 24 KB ceiling).
   - Tool descriptions repetitively explain caching concepts: *"stale means a page was served from an expired cache entry; asOf is the age of the data. Re-call only if you need guaranteed-fresh data."* is duplicated verbatim across 5 tools.
   - Refactoring common operational notices into concise standard sentences reduces schema footprint by ~20%.

2. **Omit Redundant `fields` Array in Sweep Responses (~300–600 tokens per call)**:
   - Every `filter_dishes` response currently emits a `fields` array (`["hall", "meal", "station", "name", "traits", "allergens", ...]`).
   - Because the row layout is fixed and documented in the tool schema, emitting `fields` in every runtime payload is redundant.

3. **Strip Null / Missing Fields in `list_locations` (~200–400 tokens per call)**:
   - When location fields (`phone`, `email`, `address`, `mapUrl`) are null, emitting them across 10 halls produces 40 empty keys. Omitting null values or utilizing a compact layout saves tokens.

4. **Trivial Key Block Pruning**:
   - For single-hall queries, `key.halls` emits `{ "1": "bursley" }`. When the hall was explicitly requested in arguments, emitting a 1-item dictionary is superfluous.

5. **Trait Bitmask Encoding (Future v3)**:
   - Traits are currently represented as integer arrays (e.g. `[1, 3, 5]`). A bitmask integer (`1 | 4 | 16 = 21`) reduces multi-trait arrays to a single number per dish.

---

## 5. Performance & Network Optimizations

1. **O(1) Single-Request `list_locations` (100x Speedup)**:
   - **Current**: `list_locations` calls `loadHallPage` for all 10 halls. With 6 HTTP requests per hall (probe + 4 meals + meal-hours) and rate-limiting (concurrency 2, 500ms gap), this triggers up to 60 HTTP requests and takes **15–25 seconds**.
   - **Optimized**: `GET /dining/locations?key={key}` returns all 10 dining halls (and all 28 facilities) in a **single call (<200ms)**.

2. **Proactive Warmer Alignment**:
   - `src/warmer.ts` interval is set to 10 minutes, safely inside the 15-minute `todayMenu` TTL. Coupled with `cacheRefreshThreshold: 0.6` (9 minutes), the cache refreshes in the background before expiration, ensuring callers rarely experience cache misses.

3. **In-Flight Request Deduplication**:
   - `src/cache.ts` maintains an `inFlight` map to prevent cache stampedes during concurrent expired queries.

---

## 6. Features & Roadmap Opportunities

1. **Expand Campus Coverage Beyond Dining Halls (28 Total Locations)**:
   - The OpenShift API indexes 28 locations:
     - **10 Dining Halls**: Bursley, East Quad, Markley, Mosher-Jordan, North Quad, South Quad, Twigs at Oxford, Wolverine Village, Lawyers Club, Martha Cook.
     - **9 Cafés**: Bert's Cafe, Blue Cafe, Fireside Cafe, Java Blu, Maizie's Grill, Muji Cafe, Panda Express, U-Club, etc.
     - **8 Markets**: Blue Market (Bursley, Pierpont, South Quad, Michigan Union), etc.
     - **1 Grill**: Pierpont Commons Grill.
   - Adding a `type` filter (`"dining-halls" | "cafes" | "markets" | "all"`) to `list_locations` extends MCP capability campus-wide.

2. **Embed Occupancy Badges in `list_locations` & `find_open_now`**:
   - Rather than requiring agents to make a separate tool call to `get_dining_occupancy`, open halls can optionally embed real-time crowd level:
     ```json
     { "id": "bursley", "name": "Bursley", "openNow": true, "occupancy": { "count": 20, "percent": 13.4 } }
     ```

3. **Nutritional Ratio Sorting**:
   - Add first-class support for `protein:calorie` and `fiber:calorie` ratios directly into `filter_dishes` sorting parameters.

4. **Multi-Term Quoted OR Queries**:
   - Support `query: '"chicken" "tofu"'` returning dishes containing either term without requiring multiple tool queries.

---

## 7. Synchronized Files in `~/tmp/kilo/personal/UMich-dining-mcp/`

The mirror repository at `/home/dev/tmp/kilo/personal/UMich-dining-mcp/` was populated with up-to-date documentation and architectural artifacts under the appropriate categories:

- `docs/tool-reference.md` — Complete reference of all MCP tools and parameters.
- `docs/nutrition.md` — Micronutrient Daily Values, units, and density formulas.
- `docs/troubleshooting.md` — Common upstream errors and cache diagnosis.
- `docs/PROJECT_ANALYSIS_AND_RECOMMENDATIONS.md` — Copy of this comprehensive audit.
- `work/api/openshift-dining-api-spec.md` — Technical endpoint specifications for the OpenShift JSON API.
- `work/architecture/api-first-architecture-recommendation.md` — Architecture proposal for single-request location loading and scraper fallback.
