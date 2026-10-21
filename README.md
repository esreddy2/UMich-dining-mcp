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
| Transport | stdio |
| Runtime | Node.js 20.18.1 or newer |
| Halls | the ten dining halls |
| Registry | [`io.github.esreddy2/umich-dining-mcp`](https://registry.modelcontextprotocol.io) |

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

### Example questions

```
What is serving at Bursley for dinner tonight?

Which halls are open right now?

Find vegan dishes at South Quad that do not contain soy.

What are the ingredients of the Oatmeal at Bursley? How many calories?

When is Markley open on Saturday?

Show me dishes with more than 500 mg of sodium.
```

## The halls

| id | Hall | id | Hall |
|---|---|---|---|
| `bursley` | Bursley | `south-quad` | South Quad |
| `east-quad` | East Quad | `twigs-at-oxford` | Twigs at Oxford |
| `markley` | Markley | `wolverine-village` | Wolverine Village |
| `mosher-jordan` | Mosher-Jordan | `lawyers-club` | Lawyers Club |
| `north-quad` | North Quad | `martha-cook` | Martha Cook |

The id is what `get_menu`, `get_hours` and `search_dishes` expect.

## Dates

The site publishes menus from **three days ago to fourteen days ahead**. Outside that range
the site does not answer with an error, it answers with a *different day's menu*, so a date
outside the range is refused before anything is fetched, with a message that names the range
the site offers. When the page states which day it rendered, that day is compared with the
one you asked for and a mismatch is an error rather than a wrong answer.

## Filters

| Parameter | Meaning |
|---|---|
| `exclude_allergens` | Keeps only the dishes that do **not** carry any of the listed allergens. |
| `require_traits` | Keeps only the dishes that carry **every** listed trait. |
| `min_mhealthy` | Minimum nutrient-density tier, 1..5 (3 = "Nutrient Dense Medium or better"). |
| `max_carbon` | Maximum carbon footprint: `low`, `medium` or `high`. |
| `max_calories`, `max_sodium_mg` | Numeric caps. Dishes without a published value are excluded. |

## Allergens

> Allergen data is only as good as the site. The menu page flags the allergens the kitchen
> reported for a dish, but it does not distinguish "contains" from "may contain", there are
> no ingredient lists, and a missing flag is not an absence of the allergen. The site's own
> guidance is: *"Look for the signs posted near each food serving area for a list of menu
> options with allergens highlighted in red."* "Gluten Free" means the dish is made without
> gluten, not that it is safe for someone with coeliac disease. Dedicated gluten-free
> pantries exist at South Quad, East Quad, Mosher-Jordan and Bursley.

The same caveat is repeated in the description of every tool that returns allergen data and
in every response that contains it. No tool ever claims that a dish is safe.

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
