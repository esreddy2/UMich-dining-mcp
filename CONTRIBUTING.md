# Contributing to umich-dining-mcp

## The tests

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

The suite never touches the network. `tests/fixtures/` holds the live HTML of the ten halls
and of the regular hours page, captured for 2026-10-22. The capture date is written to
`tests/fixtures/capture-date.txt`, which the oracle and the tests read, so the fixtures and
the expected data always agree on which day they describe.

It has four layers:

| Layer | What it checks | Against what |
| --- | --- | --- |
| `tests/expected-data.test.ts` | every meal, station, dish, trait, allergen, tier and nutrition value | the expected data of `tests/fixtures/expected/` |
| `tests/source-truth.test.ts` | the same facts, re-read | the raw markup of the fixtures, with regular expressions only |
| `tests/*-detail.test.ts` | nutrition, hours, service and MCP contract | the markup, the site's data and the protocol |
| `tests/oracle/build_expected.py` | writes the expected data | the fixtures, with its own HTML reader |

The expected data is written by a second implementation of the site reader that shares no
code with `src/`: it has its own tolerant HTML parser, and it was checked against the live
rendered pages of all ten halls as well. Comparing the parser with the expected data
therefore compares it with the markup of the site rather than with itself.

The oracle is Python and runs outside the test run:

```bash
npm run test:oracle                       # fail when the expected data is out of date
python3 tests/oracle/build_expected.py    # rewrite it after a new capture
```

## The network tests and the fixtures

```bash
npm run capture              # re-capture the fixtures for today
npm run capture -- 2026-10-22
npm run test:live            # the tests that read the real site
```

When the site changes its HTML: re-capture the fixtures, rebuild the expected data with the
oracle, update the table below, and the parsers will show what moved.

## What the site published for 2026-10-22

| id | Hall | Meals | Stations | Dishes |
|---|---|---|---|---|
| `bursley` | Bursley | Breakfast, Lunch, Dinner | 22 | 69 |
| `east-quad` | East Quad | Breakfast, Lunch, Dinner | 17 | 72 |
| `markley` | Markley | Breakfast, Lunch, Dinner | 14 | 36 |
| `mosher-jordan` | Mosher-Jordan | Breakfast, Lunch, Dinner | 20 | 57 |
| `north-quad` | North Quad | Breakfast, Lunch, Dinner | 20 | 58 |
| `south-quad` | South Quad | Breakfast, Lunch, Dinner | 28 | 97 |
| `twigs-at-oxford` | Twigs at Oxford | Breakfast, Lunch, Dinner | 12 | 43 |
| `wolverine-village` | Wolverine Village | Breakfast, Lunch, Dinner | 29 | 83 |
| `lawyers-club` | Lawyers Club | Lunch, Dinner | 13 | 27 |
| `martha-cook` | Martha Cook | Breakfast, Lunch, Dinner | 14 | 20 |

562 dishes in total. The counts are a regression lock: `tests/menu.test.ts` fails when the
site changes shape.

**The Meals column is about the capture date, and the capture is a full view of the day.**
Nine of the ten halls publish all three meals; Lawyers Club publishes lunch and dinner only,
which is what the site says about that hall on every day of the week.

The capture used to be made for the current day, and for the current day the site publishes
only the meals that have not passed yet, so a capture taken later in the day showed dinner
alone for the halls that had already served breakfast and lunch. A capture for a date in the
future is a full view of all three meals, which is why the fixtures are taken for tomorrow
rather than for the current day. The page then also names the hours block after that day
("Thursday's Hours" for a Thursday) instead of "Today's Hours".

| Date | Bursley | East Quad | Markley | North Quad | Martha Cook | Lawyers Club |
|---|---|---|---|---|---|---|
| Mon 2026-10-19 (past) | B, L, D | – | – | – | – | L, D |
| Tue 2026-10-20 | B, L, D | D | D | D | D | L, D |
| Wed 2026-10-21 | B, L, D | B, L, D | B, L, D | B, L, D | B, L, D | L, D |
| Thu 2026-10-22 (the capture) | B, L, D | B, L, D | B, L, D | B, L, D | B, L, D | L, D |
| Fri 2026-10-23 | B, L, D | B, L, D | B, L, D | B, L, D | B, L, D | L, D |
| Sat 2026-10-24 | B, D | B, D | – | – | – | – |

A dash means the site published no menu for that hall on that day.

## The checks on GitHub

`.github/workflows/ci.yml` runs on every push, one job each, so a failure names the part
that broke: the typecheck, the lint, the tests (on Node 20 and on Node 22), the oracle and
the build of the package. `.github/workflows/live.yml` holds the tests that read the real
site; they run when the published branch changes, once a day, and on demand, and they are
kept apart from the checks of the code.

## Releasing

The version lives in `package.json`, `package-lock.json` and `server.json`; the registry
manifest and the package have to agree.

```bash
npm version 0.2.0 --no-git-tag-version
# edit server.json: version and packages[0].version
git commit -am "release: the version 0.2.0"
git tag v0.2.0
git push origin feat/rebuild --follow-tags
```

The tag triggers `.github/workflows/publish.yml`, which publishes to npm with OIDC (no token
is stored in the repository) and then publishes the server to the MCP registry.

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

The website is therefore the only source this server reads.
