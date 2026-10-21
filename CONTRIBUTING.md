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
and of the regular hours page, captured on 2026-10-20.

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
npm run capture -- 2026-10-20
npm run test:live            # the tests that read the real site
```

When the site changes its HTML: re-capture the fixtures, rebuild the expected data with the
oracle, update the table below, and the parsers will show what moved.

## What the site published for 2026-10-20

| id | Hall | Meals | Stations | Dishes |
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

**The Meals column is about that one capture, not about the halls.** All ten halls serve
breakfast, lunch and dinner. The capture was taken for the current day, and for the current
day the site publishes only the meals that have not passed yet, so a capture made later in
the day shows dinner alone. The same halls publish all three meals on other days:

| Date | Bursley | East Quad | Markley | North Quad | Martha Cook | Lawyers Club |
|---|---|---|---|---|---|---|
| Mon 2026-10-19 (past) | B, L, D | – | – | – | – | L, D |
| Tue 2026-10-20 (the capture) | B, L, D | D | D | D | D | L, D |
| Wed 2026-10-21 | B, L, D | B, L, D | B, L, D | B, L, D | B, L, D | L, D |
| Thu 2026-10-22 | B, L, D | B, L, D | B, L, D | B, L, D | B, L, D | L, D |
| Sat 2026-10-24 | B, D | B, D | – | – | – | – |

A dash means the site published no menu for that hall on that day. Two consequences for the
fixtures: the capture is a partial view of the day, so a future markup change in a meal
section is only covered for the halls that published it, and a capture for a date in the
future is a full view of all three meals.

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
