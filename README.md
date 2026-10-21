# umich-dining-mcp

An MCP server that answers questions about the **dining halls** of the University of
Michigan in Ann Arbor: what is being served, which dishes are vegan or halal, what a dish
contains, how calorie content, and when each hall is open.

All data comes live from [dining.umich.edu](https://dining.umich.edu), the university's own
dining site. Nothing is mirrored or cached on disk.

| | |
|---|---|
| Transport | stdio |
| Runtime | Node.js >= 20.18.1 |
| Source of truth | `dining.umich.edu` only |
| Scope | the 10 dining halls |
| Data verified on | 2026-10-20 |

## Install

The package is not published yet, so install it from the repository for now:

```bash
npm install -g github:esreddy2/UMich-dining-mcp
```

or run it straight from the repository:

```bash
npx github:esreddy2/UMich-dining-mcp
```

### Claude Code

```bash
claude mcp add umich-dining -- npx -y github:esreddy2/UMich-dining-mcp
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "umich-dining": {
      "command": "npx",
      "args": ["-y", "github:esreddy2/UMich-dining-mcp"]
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "umich-dining": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:esreddy2/UMich-dining-mcp"]
    }
  }
}
```

Once the package is on npm, `npx -y umich-dining-mcp` works the same way.

## Tools

| Tool | What it does |
|---|---|
| `list_locations` | The ten halls with address, phone, e-mail, map link, today's service periods, whether they are open right now, and whether they have a gluten-free pantry. |
| `get_menu` | The menu of one hall: meals, stations and dishes with traits, allergens and the nutrition panel. |
| `search_dishes` | Find dishes by name, in one hall or across all of them (case-insensitive substring match). |
| `filter_dishes` | Filter the menus by allergen, trait, nutrient density, carbon footprint, calories and sodium. |
| `get_hours` | The service periods of a day plus the regular weekly schedule. |
| `find_open_now` | Which halls are serving at the current time. |
| `get_item_nutrition` | The full nutrition panel of a single dish. |

### Resources

| Resource | Content |
|---|---|
| `umich://dining-halls` | The hall registry as JSON. |
| `umich://taxonomy` | The 15 allergens and 14 traits with their display labels, the trait implication closure and the allergen caveat. |

### Examples

```
> What is serving at Bursley for dinner tonight?

> Which halls are open right now?

> Find vegan dishes at South Quad that do not contain soy.

> What are the ingredients of the Oatmeal at Bursley? How many calories?

> When is Markley open on Saturday?

> Show me dishes with more than 500 mg of sodium.
```

## The ten halls

| id | Hall | Meals published on 2026-10-20 | Stations | Dishes |
|---|---|---|---|---|
| `bursley` | Bursley | Breakfast, Lunch, Dinner | 22 | 66 |
| `east-quad` | East Quad | Dinner | 9 | 40 |
| `markley` | Markley | Dinner | 6 | 14 |
| `mosher-jordan` | Mosher-Jordan | Breakfast, Lunch, Dinner | 21 | 65 |
| `north-quad` | North Quad | Dinner | 7 | 20 |
| `south-quad` | South Quad | Breakfast, Lunch, Dinner | 28 | 94 |
| `twigs-at-oxford` | Twigs at Oxford | Dinner | 5 | 17 |
| `wolverine-village` | Wolverine Village | Breakfast, Lunch, Dinner | 31 | 97 |
| `lawyers-club` | Lawyers Club | Lunch, Dinner | 12 | 23 |
| `martha-cook` | Martha Cook | Dinner | 8 | 12 |

448 dishes in total. The counts are a regression lock: `tests/menu.test.ts` fails when the
site changes shape.

## Dates

The site's own datepicker is bounded at **today - 3 days** and **today + 14 days**. Outside
that range the site does not answer with an error, it answers with a *different day's menu*,
so the range is checked before anything is fetched, and a date outside it is refused with a
message that names the range the site offers. When the page does expose the day it rendered
(the datepicker the site builds in the browser), that day is compared with the requested one
and a mismatch is an error rather than wrong data.

## Filters

| Parameter | Meaning |
|---|---|
| `exclude_allergens` | Keeps only the dishes that do **not** carry any of the listed allergens. |
| `require_traits` | Keeps only the dishes that carry **every** listed trait. |
| `min_mhealthy` | Minimum nutrient-density tier, 1..5 (3 = "Nutrient Dense Medium or better"). |
| `max_carbon` | Maximum carbon footprint: `low`, `medium` or `high`. |
| `max_calories`, `max_sodium_mg` | Numeric caps. Dishes without a published value are excluded. |

"Gluten Free" means *made without gluten*, not *safe for someone with coeliac disease*.
Dishes that are vegan are reported as vegetarian as well, because the site keeps the two
apart; no other trait implies another (halal does not imply vegetarian, and neither does
kosher).

## Allergen caveat

> Allergen data is only as good as the site. The menu page flags the allergens the kitchen
> reported for a dish, but the data does not distinguish "contains" from "may contain", there
> are no ingredient lists, and it is not safe to treat a missing flag as an absence of the
> allergen. The site's own guidance is: *"Look for the signs posted near each food serving
> area for a list of menu options with allergens highlighted in red."* The "Gluten Free" trait
> means the dish is made without gluten, not that it is safe for someone with coeliac disease.
> Dedicated gluten-free pantries exist only at South Quad, East Quad, Mosher-Jordan and Bursley.

The caveat is repeated in the description of every tool that can return allergen data and in
every response that contains it. No tool ever claims that a dish is safe.

## Caching and request etiquette

This server talks to somebody else's website, so it is deliberately gentle:

* **One User-Agent.** `dining.umich.edu` answers HTTP 200 only for a small set of clients;
  the default is `python-requests/2.32.3`, which is the only one measured to work (a generic
  fetch agent and a headless-Chrome agent both get 403). It is not our real identity, it is
  configurable, and the README says so. Set `UMICH_DINING_USER_AGENT` to use your own.
* **At most two requests in flight** and **at least 500 ms between requests**.
* **A TTL cache** with in-flight de-duplication, so ten concurrent questions about the same
  hall cost one request. Today's menu is cached for 15 minutes, a future menu for 6 hours, a
  past menu for 24 hours and the regular hours for 24 hours.
* **Stale on error.** If the site is unreachable and a cached copy exists, the cached copy is
  served and flagged as stale instead of failing the question.

| Environment variable | Default | Meaning |
|---|---|---|
| `UMICH_DINING_USER_AGENT` | `python-requests/2.32.3` | The User-Agent to use. |
| `UMICH_DINING_BASE_URL` | `https://dining.umich.edu` | The site to read. |
| `UMICH_DINING_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `UMICH_DINING_MAX_RETRIES` | `3` | Retries after the first attempt. |
| `UMICH_DINING_MAX_CONCURRENCY` | `2` | Requests in flight. |
| `UMICH_DINING_MIN_GAP_MS` | `500` | Minimum gap between requests. |
| `UMICH_DINING_TTL_TODAY_MS` | `900000` | Cache lifetime of today's menu. |
| `UMICH_DINING_TTL_FUTURE_MS` | `21600000` | Cache lifetime of a future menu. |
| `UMICH_DINING_TTL_PAST_MS` | `86400000` | Cache lifetime of a past menu. |
| `UMICH_DINING_TTL_REGULAR_HOURS_MS` | `86400000` | Cache lifetime of the weekly schedule. |

## Why not NetNutrition

MDining's own backend (`fss.studentlife.umich.edu/NetNutrition`) was probed live and is
neither as accurate nor as available as the website, so it is not used:

| | website | NetNutrition |
|---|---|---|
| Bursley menu, today | 66 dishes, 22 stations, 3 meals | a "Start-up Error" page: *"No Menus match the current selection"* |
| hours | full weekly schedule | "Closed" for all seven days |
| search | – | a "Start-up Error" page |
| dishes | posted dishes | also recipe components ("Bread & Butter Pickle") that are not posted dishes |
| authentication | none | a cookie session: bootstrap GET, then a four-step POST |
| horizon | today-3 days .. today+14 days | 14 days |

The rule for this server is that the website wins.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

The test suite never touches the network: `tests/fixtures/` holds the live HTML of the ten
halls and of the regular hours page, captured on 2026-10-20.

The tests are written to catch bugs, not to describe the code. They come in four layers:

| Layer | What it checks | Against what |
| --- | --- | --- |
| `tests/expected-data.test.ts` | every meal, station, dish, trait, allergen, tier and nutrition value | the expected data of `tests/fixtures/expected/` |
| `tests/source-truth.test.ts` | the same facts, re-read | the raw markup of the fixtures, with regular expressions only |
| `tests/*-detail.test.ts` | nutrition, hours, service and MCP contract | the markup, the site's data and the protocol |
| `tests/oracle/build_expected.py` | writes the expected data | the fixtures, with its own HTML reader |

The expected data is written by a second implementation of the site reader that shares no
code with `src/`: it has its own tolerant HTML parser, and it was checked against the live
rendered pages of all ten halls as well. A test that compares the parser with the expected
data therefore compares it with the markup of the site, not with itself. The oracle is
written in Python and is not part of the test run:

```bash
npm run test:oracle          # fail when the expected data is out of date
python3 tests/oracle/build_expected.py   # rewrite it after a new capture
```

```bash
npm run capture              # re-capture the fixtures for today
npm run capture -- 2026-10-20
npm run test:live            # the network-gated tests
```

After the site changes its HTML, re-capture the fixtures, rebuild the expected data with the
oracle, update this table, and the parsers will tell you what moved.

## Contact

Questions, bug reports or a request to use a different User-Agent: open an issue at
<https://github.com/esreddy2/UMich-dining-mcp/issues>.

## License

MIT, see [LICENSE](LICENSE).
