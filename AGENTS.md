# UMich Dining MCP Guidelines & Invariants

## 1. API & Data Semantics
- **Occupancy (`/dining/capacity`)**: The upstream field `capacity_count` is the percentage full (0–100), matching the official Michigan mobile app. Do not calculate `percent = count / total`. Store `percent = capacity_count` and derive `current = round((percent / 100) * total)`.
- **Private API & Scraping Fallback**: Menus and meal hours query the OpenShift JSON API first; on 4xx/5xx or unserved periods, fallback to scraping WordPress HTML.
- **Locations vs. Hours Distinction**:
  - `list_locations`: Serves facility attributes (`residentsOnly`, `glutenFreePantry`, contact details, `openNow`).
  - `get_hours`: Provides operating schedules (`weekly` full-week matrix, `today` periods, `weekday`).

## 2. Remote Dev Deployment & Probing
- **Deploy Command**: Run `./deploy/oracle/dev-deploy.sh` to build, test, and activate the dev server on Oracle VM.
- **Dev Endpoint**: `https://umich-dining-mcp.duckdns.org/dev/mcp`.
- **Required HTTP Headers**: POST requests must include:
  ```http
  Content-Type: application/json
  Accept: application/json, text/event-stream
  ```
  *(Omitting `text/event-stream` returns HTTP 406 / `-32000 Not Acceptable`).*
- **Probing Script**: Use `python3 ~/tmp/kilo/personal/UMich-dining-mcp/scripts/probe.py [tools|call <tool> <args>]`.

## 3. Testing & Timezone Invariants
- **Campus Timezone**: All published schedules and days resolve in `America/Detroit`.
- **Date Handling**: Always pass `now` to `todayIn(config.timezone, now)` when simulating dates to prevent midnight boundary drift.
- **Nocturnal Test Assertions**: Do not assert `countItems > 0` on default auto-meal selection after 9:00 PM EDT; pass explicit meals (`['Breakfast', 'Brunch', 'Lunch', 'Dinner']`) or mock midday campus time.
