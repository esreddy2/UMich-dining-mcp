# umich-dining-mcp

[![npm](https://img.shields.io/npm/v/umich-dining-mcp?style=flat&logo=npm&logoColor=cb3837&logoSize=20)](https://www.npmjs.com/package/umich-dining-mcp)
[![CI](https://github.com/esreddy2/UMich-dining-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/esreddy2/UMich-dining-mcp/actions/workflows/ci.yml)
[![Live site](https://github.com/esreddy2/UMich-dining-mcp/actions/workflows/live.yml/badge.svg)](https://github.com/esreddy2/UMich-dining-mcp/actions/workflows/live.yml)

An MCP server for the dining halls of the University of Michigan in Ann Arbor. It answers
what is being served, which dishes are vegan or halal, what a dish contains, how many
calories it has, and when each hall is open.

Every answer is read live from [dining.umich.edu](https://dining.umich.edu). Pages are kept
in memory for a few minutes so that ten questions cost one visit, but nothing is written to
disk and no menu is mirrored.

| | |
|---|---|
| Transports | Local stdio and hosted Streamable HTTP |
| Runtime | Node.js 20.18.1 or newer |
| Halls | the ten dining halls |
| Registry | [`io.github.esreddy2/umich-dining-mcp`](https://registry.modelcontextprotocol.io) |

## Hosted MCP (no installation required)

The public Streamable HTTP endpoint is:


Connect a compatible MCP client directly to this URL.
No npm installation or GitHub download is needed.

The existing npm package remains available for users who
prefer running the MCP server locally through stdio.

## Install

```bash
npm install -g umich-dining-mcp
```

or run it without installing anything:

```bash
npx -y umich-dining-mcp
```

### Claude Code

```bash
claude mcp add umich-dining -- npx -y umich-dining-mcp
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "umich-dining": {
      "command": "npx",
      "args": ["-y", "umich-dining-mcp"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "umich-dining": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "umich-dining-mcp"]
    }
  }
}
```

Any other client that starts MCP servers over stdio takes the same `mcpServers` entry as
Cursor, with `npx -y umich-dining-mcp` as the command.

## Tools

| Tool | What it does |
|---|---|
| `list_locations` | The ten halls with address, phone, e-mail, map link, today's service periods, whether they are open right now, and whether they have a gluten-free pantry. |
| `get_menu` | The menu of one hall: meals, stations and dishes, with the coded traits and allergens, the density and carbon tiers, the calories and the serving size. |
| `search_dishes` | Find dishes by name, in the halls that are named or across all of them (case-insensitive substring match), on one day or over a range. |
| `filter_dishes` | Filter the menus by allergen, trait, nutrient density, carbon footprint, nutrients, calories and sodium, in the halls that are named or across all of them, on one day or over a range. |
| `list_nutrition_fields` | The supported nutrient names, their units and the Daily Value basis of the micronutrients. |
| `get_hours` | The service periods of a day plus the regular weekly schedule. A hall that cannot be read is reported in `failures`; the others are still returned. |
| `find_open_now` | Which halls are serving at a given time of day. |
| `get_item_nutrition` | The full nutrition panel of a single dish. |

### Resources

| Resource | Content |
|---|---|
| `umich://dining-halls` | The hall registry as JSON, with the code of every hall. |
| `umich://taxonomy` | The 15 allergens and 14 traits with their codes and display labels, the trait implication closure and the allergen caveat. |

### Example questions

```
What is serving at Bursley for dinner tonight?

Which halls are open right now?

Find vegan dishes at South Quad that do not contain soy.

What are the ingredients of the Oatmeal at Bursley? How many calories?

When is Markley open on Saturday?

Show me dishes with more than 500 mg of sodium.

Which halls serve tiramisu between the 24th and the 26th?
```

## The response contract

The rows of `search_dishes` and `filter_dishes` carry small integers instead of names, and a
`key` block at the top of the response maps every code back to its slug. The key lists only
what that response uses. The codes are frozen for the life of the contract.

```json
{
  "key": { "halls": { "1": "bursley" }, "meals": { "3": "Lunch" },
           "stations": { "7": "Grill" }, "traits": { "5": "vegan" },
           "allergens": { "7": "milk" } },
  "units": { "calories": "kcal", "protein": "g" },
  "fields": ["hall", "meal", "station", "name", "traits", "allergens",
             "mhealthyTier", "carbonFootprint", "calories", "servingSize",
             "servingSizeGrams", "protein"],
  "note": "Allergen codes: check key.allergens before reporting; site data is advisory.",
  "date": "2026-10-21",
  "matches": [
    [1, 3, 7, "Grilled Chicken", [5], [7], 3, 2, 320, "1 Each (113g)", 113, 32]
  ]
}
```

A row is an **array**, and the `fields` list names its positions, once per response. The
member names of a named row are two and a half times the data of the row, and the row is
repeated on every row of the answer: a named row cost 216 bytes, an array row costs 72.

- The halls are 1..10 in the order of the registry below, the meals are 1 (Breakfast),
  2 (Brunch), 3 (Lunch) and 4 (Dinner), the allergens are 1..15 and the six boolean traits
  are 1..6 (glutenfree, halal, kosher, spicy, vegan, vegetarian). A meal label the site
  invents takes the next free code, from 5. The stations have a frozen vocabulary too: the
  same station carries the same code in every response, so a code can be remembered.
- `mhealthyTier` is 1 (Nutrient Dense Low) to 5 (Nutrient Dense High) and
  `carbonFootprint` is 1 (low), 2 (medium) or 3 (high). The two scales are fixed and are
  described in the tool descriptions and in `umich://taxonomy`.
- The `traits` array carries the six boolean traits only; the density and the carbon tier
  are lifted into their own numeric fields.
- The `units` map gives the unit of every nutrient the response returns. A micronutrient
  is an amount like every other nutrient: the site publishes the percent of the Daily
  Value, and the row carries the amount that percent stands for — 15 %DV of an 18 mg
  Daily Value of iron is `2.7` in mg. The percent is still available under its own name,
  `%DV`, in a threshold.
- A search or a filter takes the halls it covers: one hall, several halls, or no hall at
  all for every one of them. The rows come back in the order that was asked for, and
  `limit` takes the first of them: the default is 50 rows, and the answer says how many
  matched and how to see the rest.
- The row always carries the calories and the serving size. Every other nutrient, the
  sodium included, is asked for by name with `include_nutrients` — the sodium has nothing
  that makes it more interesting than the protein. A nutrient a filter constrained is
  always returned, whether or not it was asked for.
- A single-day response carries `date`; a range response carries `dateRange` and each row
  carries the `dates` it appeared on.
- A dish without a published value is reported as `null`, never as zero. A `trace` or a
  `<` value is not a value at all.

`get_menu` and the sweep tools return the same compact row, so a row means the same thing
wherever it is read. `get_item_nutrition` is the tool that returns the raw nutrition panel,
of one dish.

A whole menu is far smaller this way: the menu of South Quad went from 60,266 bytes to
8,817, and the menu of Bursley from 42,141 to 6,573. The panel of a single dish is one
call to `get_item_nutrition`.

## The halls

| id | Hall | id | Hall |
|---|---|---|---|
| `bursley` | Bursley | `south-quad` | South Quad |
| `east-quad` | East Quad | `twigs-at-oxford` | Twigs at Oxford |
| `markley` | Markley | `wolverine-village` | Wolverine Village |
| `mosher-jordan` | Mosher-Jordan | `lawyers-club` | Lawyers Club |
| `north-quad` | North Quad | `martha-cook` | Martha Cook |

The id is what `get_menu`, `get_hours` and `search_dishes` expect. The code of a hall is
its position in this list, counted from one.

## Dates

The site publishes menus from **three days ago to fourteen days ahead**. Outside that range
the site does not answer with an error, it answers with a *different day's menu*, so a date
outside the range is refused before anything is fetched, with a message that names the range
the site offers. When the page states which day it rendered, that day is compared with the
one you asked for and a mismatch is an error rather than a wrong answer.

A range is asked for with `from` and `to`; `to` omitted means the last published day. The
two cannot be combined with `date`. A range that does not fit in one call is read in
windows with `offset`; the `coverage` block of the answer names the offset of the next
window.

## Filters

| Parameter | Meaning |
|---|---|
| `exclude_allergens` | Keeps only the dishes that do **not** carry any of the listed allergens. |
| `require_traits` | Keeps only the dishes that carry **every** listed trait. |
| `min_mhealthy` | Minimum nutrient-density tier, 1..5 (3 = "Nutrient Dense Medium or better"). |
| `max_carbon` | Maximum carbon footprint: `1` (low), `2` (medium) or `3` (high). |
| `max_calories`, `min_calories` | Numeric caps in kcal. Dishes without a published value are excluded. |
| `max_sodium_mg`, `min_sodium_mg` | Numeric caps in mg. Dishes without a published value are excluded. |
| `nutrients` | A range per nutrient, e.g. `{"protein": {"min": 20, "unit": "g"}}`. The unit defaults to the nutrient's own and is checked. |
| `include_nutrients` | The nutrients to return, by canonical key or by published name, or `all`. Defaults to the ones the filter used; a constrained nutrient is always returned. |
| `query` | A case-insensitive substring of the dish name. |
| `meal`, `station` | Narrow the sweep to one meal or one station. |
| `sort_by`, `sort_order` | The field to sort on and the direction. |

A constraint on a nutrient excludes the dishes that publish no value for it: an unknown
value is never a zero.

## The cost of a range

A range query reads one page per hall per day, and the site is fetched at most two pages a
second. A query that needs more upstream pages than `UMICH_DINING_MAX_RANGE_FETCHES`
(default 12) returns the rows it could serve and a `coverage` block that says how much was
served:

```json
"coverage": { "requested": 30, "cached": 18, "fetchedNow": 12, "pending": 0, "failed": 0,
              "stale": 0, "offset": 0, "pages": 30, "nextOffset": null }
```

The numbers add up: every page the query asked for was cached, fetched, left pending or
failed. `nextOffset` is where the rest of the range begins, so a wide range is read in
windows: ask again with `offset` set to that number.

The persistent cache exists for this: the pages of the published window are kept on disk and
warmed in the background, so a range query is usually served without touching the site.

## Allergens

> Allergen data is only as good as the site. The menu page flags the allergens the kitchen
> reported for a dish, but it does not distinguish "contains" from "may contain", there are
> no ingredient lists, and a missing flag is not an absence of the allergen. The site's own
> guidance is: *"Look for the signs posted near each food serving area for a list of menu
> options with allergens highlighted in red."* "Gluten Free" means the dish is made without
> gluten, not that it is safe for someone with coeliac disease. Dedicated gluten-free
> pantries exist at South Quad, East Quad, Mosher-Jordan and Bursley.

The caveat is in the description of every tool that returns allergen data and in
`umich://taxonomy`. A response that carries allergens repeats one line reminding the reader
to resolve the codes; the long caveat is not repeated in every body. No tool ever claims
that a dish is safe.

Two further points about the traits, because the site is careful about them: a vegan dish is
reported as vegetarian as well, since the site keeps the two apart, and no other trait
implies another (halal does not imply vegetarian, and neither does kosher).

## Configuration

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
| `UMICH_DINING_MAX_RANGE_FETCHES` | `12` | Upstream pages a single range query may fetch. |
| `UMICH_DINING_CACHE_DIR` | `~/.cache/umich-dining-mcp` | The persistent cache. `off` switches it off. |
| `UMICH_DINING_CACHE_MAX_AGE_DAYS` | `30` | How long a cache entry is kept. |
| `UMICH_DINING_CACHE_MAX_SIZE_MB` | `200` | The largest the persistent cache may grow. |
| `UMICH_DINING_CACHE_PRUNE_INTERVAL_MS` | `3600000` | How often the persistent cache is pruned. |

## How it treats the site

`dining.umich.edu` is somebody else's website, so the server stays gentle with it:

- **Two requests in flight, 500 ms apart at most.** The limit is global to the process.
- **A cache with in-flight de-duplication.** Ten questions about the same hall cost one
  request. Today's menu is cached for 15 minutes, a future menu for 6 hours, a past menu for
  24 hours and the weekly hours for 24 hours.
- **Stale on error.** If the site cannot be reached and a cached copy exists, the copy is
  served and marked as stale instead of failing the question.
- **One User-Agent.** The site answers HTTP 200 to a small set of clients only;
  `python-requests/2.32.3` is the one that has been measured to work, while a generic fetch
  agent and a headless browser both get 403. It is not the server's real identity, which is
  why it is configurable.

## Contributing

Pull requests are welcome. The test suite, the fixtures and the release process are
described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).

## Maintainer hosting and updates

The Oracle deployment is separate from the npm package.
Its NGINX configuration, systemd service and updater are
maintainer infrastructure, not requirements for MCP users.

See [Oracle hosting and automatic updates](docs/hosting.md).

The optional Oracle updater checks published GitHub tags
against npm releases, builds and tests new versions, and
rolls back if the updated service fails its health check.
Ordinary GitHub commits do not trigger deployments.
