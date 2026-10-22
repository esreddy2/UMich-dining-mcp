# Troubleshooting

## "The dining site refused the request with HTTP 403"

The site answers only the User-Agent it allows. The server sends
`python-requests/2.32.3`, the one measured to return HTTP 200; a generic browser User-Agent
is refused.

If the site has changed its policy, set your own:

```
UMICH_DINING_USER_AGENT="your-agent/1.0"
```

When the first attempt is refused, the server retries once with its fallback User-Agent
and remembers the one that worked for the rest of the process.

## "The site returned the menu for 2026-10-18 when 2026-10-21 was requested"

The site does not answer a date outside its window with an error; it answers with a
different day's menu. The server compares the day the page rendered with the day that was
asked for and refuses the mismatch rather than returning the wrong day.

Check that the date is inside the published window: three days ago to fourteen days ahead.

## "2026-11-14 is outside the range the site publishes menus for"

The date is outside the window. The site serves from today−3 days to today+14 days. The
message names the range the site currently offers.

## "The cache is warming"

A range query needs one page per hall per day, and the site is fetched at most two pages a
second. A query that would need more upstream pages than `UMICH_DINING_MAX_RANGE_FETCHES`
(default 12) returns the rows it could serve and a `coverage` block:

```json
"coverage": { "requested": 30, "cached": 18, "fetchedNow": 12, "pending": 0 }
```

- `requested` — the pages the query asked for.
- `cached` — the pages that were already in the cache.
- `fetchedNow` — the pages that were fetched during the call.
- `pending` — the pages that were not served.

A `pending` above zero means the answer is incomplete. Ask for a narrower range, or ask
again once the cache has warmed.

## "The answer looks stale"

A response that was served from a cache entry past its lifetime is flagged. That happens
when the site could not be reached: the last known value is returned rather than an error,
and the tool reports it.

## "The data is not what the site shows"

The site changes its menus during the day. Today's menu is cached for fifteen minutes, a
future menu for six hours and a past menu for a day. A menu that changed in the last
fifteen minutes may still be the cached one.

The date of the page the site actually rendered is checked against the date that was
asked for, so a wrong *day* is never returned. A wrong *content* can only be a cache that
has not expired yet.

## "No dish called ... is served at ..."

The dish is not on the menu of that hall on that day. Halls serve different things on
different days, and not every hall serves every meal.

When the name matches more than one dish, the server says so and lists the candidates
instead of picking one. Narrow it with the `meal` and `station` arguments.

## "the site published meal labels this server cannot parse"

The site published a meal this server does not know — a "Brunch", for instance. Those
meals are missing from the answer rather than silently dropped, and the note names them.
The site only publishes Breakfast, Lunch and Dinner at the moment.

## "Unknown nutrient ... Use list_nutrition_fields"

The name of a nutrient is not one the server knows. `list_nutrition_fields` lists the
canonical keys and the published micronutrient names. A nutrient the site does not publish
cannot be filtered on; it is not invented.

## "The unit ... cannot be used for ..."

The threshold was written in a unit the nutrient cannot be expressed in. Each nutrient has
a canonical unit and one alternative; the message names the units that are accepted. See
`docs/nutrition.md`.

## "The dining site refused 5 requests in a row; the fetches are paused for a minute"

The circuit breaker opened after a run of upstream failures. It closes again after a
successful request, or after the cooldown. Nothing needs to be done; the server recovers on
its own.

## "The persistent cache is not being used"

The cache directory is `~/.cache/umich-dining-mcp` by default, and it is off when
`UMICH_DINING_CACHE_DIR` is set to `off`. The cache holds public menu data only; the
directory is created with mode `0700` and the files with mode `0600`.

The persistent cache is used by the long-lived HTTP mode. A one-shot stdio client starts no
background job and reads the cache on demand.

## The cache directory is too big

The cache is pruned at startup and then hourly: an entry whose day left the published
window is dropped, an entry older than `UMICH_DINING_CACHE_MAX_AGE_DAYS` is dropped, and
over `UMICH_DINING_CACHE_MAX_SIZE_MB` the oldest entries go first. The directory can also
be deleted by hand; the server rebuilds it.
