# The tool reference

Nine tools and two resources. Every tool is read-only and reaches the dining site of the
University of Michigan.

## The tools at a glance

| Tool | Purpose |
|---|---|
| `list_locations` | The ten halls, their contact details and their service periods. |
| `get_menu` | The whole menu of one hall, with the nutrition panels. |
| `search_dishes` | Find dishes by name. |
| `filter_dishes` | Filter the menus by allergen, trait and nutrients. |
| `list_nutrition_fields` | The nutrient names, their units and the Daily Value basis. |
| `get_hours` | The service periods of a day and the regular weekly schedule. |
| `find_open_now` | Which halls are serving at a given time. |
| `get_item_nutrition` | The nutrition panel of a single dish. |

## The response contract

`search_dishes` and `filter_dishes` return coded rows. The codes are frozen for the life of
the contract.

```json
{
  "key": { "halls": { "1": "bursley" }, "meals": { "3": "Lunch" },
           "stations": { "7": "Grill" }, "traits": { "5": "vegan" },
           "allergens": { "7": "milk" } },
  "units": { "calories": "kcal", "protein": "g" },
  "fields": ["hall", "meal", "station", "name", "traits", "allergens",
             "mhealthyTier", "calories", "servingSize",
             "servingSizeGrams", "protein"],
  "note": "Allergen codes: check key.allergens before reporting; site data is advisory.",
  "date": "2026-10-21",
  "totalMatches": 1,
  "matches": [
    [1, 3, 7, "Grilled Chicken", [5], [7], 3, 320, "1 Each (113g)", 113, 32]
  ],
  "failures": []
}
```

A row is an **array** and the `fields` list names its positions, once per response. The
member names of a named row are two and a half times the data of the row, repeated on
every row: a named row cost 216 bytes, an array row costs 72.

### The codes

| Vocabulary | Codes | Order |
|---|---|---|
| Halls | 1..10 | The registry: bursley, east-quad, markley, mosher-jordan, north-quad, south-quad, twigs-at-oxford, wolverine-village, lawyers-club, martha-cook. |
| Meals | 1..4 | Breakfast, Brunch, Lunch, Dinner. A label the site invents takes the next free code, from 5. |
| Allergens | 1..15 | The taxonomy order: alcohol, beef, coconut, eggs, fish, item-is-deep-fried, milk, oats, peanuts, pork, sesame-seed, shellfish, soy, tree-nuts, wheat_barley_rye. |
| Boolean traits | 1..6 | glutenfree, halal, kosher, spicy, vegan, vegetarian. |
| Stations | 1..n | A frozen vocabulary, the same in every response: the same station always carries the same number. A name the site invents takes the next free number. |
| `mhealthyTier` | 1..5 | 1 = Nutrient Dense Low … 5 = Nutrient Dense High. |

`umich://taxonomy` publishes the code, the slug and the label of every allergen and trait;
`umich://dining-halls` publishes the code of every hall.

### The rules

- The `key` block lists only what the response uses. A response with no allergens has no
  `key.allergens`.
- The `traits` array carries the six boolean traits only. The density tier
  is lifted into `mhealthyTier`, because that is the number the filters speak.
- The `units` map gives the unit of every nutrient the response returns.
- The `fields` list names the positions of a row, in order. A row always carries the
  hall, the meal, the station, the name, the traits, the allergens, the density tier,
  the calories, the serving size and the serving size in grams. Every
  other nutrient, the sodium included, is asked for by name with `include_nutrients`,
  and a nutrient a filter constrained is always returned.
- A dish without a published value is `null`, never `0`.
- A single-day response carries `date`; a range response carries `dateRange` and each row
  carries the `dates` it appeared on.
- The `note` is present when the response carries allergens, when the site published a
  meal this server cannot parse, when a station matched nothing, when the query covered a
  range of days, or when a day of the range carried no menu. It is absent when there is
  nothing to say.

## list_locations

The ten halls with their address, phone, e-mail, map link, gluten-free pantry and the
service periods of the requested day.

| Parameter | Type | Meaning |
|---|---|---|
| `date` | `YYYY-MM-DD` | The day to read. Defaults to today. |

## get_menu

The whole menu of one hall: the meals, the stations and the dishes, with the same coded row
the sweep tools return. The panel of a single dish comes from `get_item_nutrition`.

| Parameter | Type | Meaning |
|---|---|---|
| `hall` | hall id | The hall to read. Required. |
| `date` | `YYYY-MM-DD` | The day to read. Defaults to today. |
| `meal` | meal name | Keeps only that meal. |
| `station` | string | Keeps only that station. |
| `limit` | 1..500 | How many dishes to return. The whole menu is returned when it is not given. |
| `include_nutrients` | string[] | The nutrients to return, or `["all"]`. |

## search_dishes

A case-insensitive substring match on the dish name.

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string | The text to look for. Required. |
| `hall` | hall id, or hall id[] | The halls to search: one hall, or a list of them. Left out, or an empty list, searches every hall. |
| `date` | `YYYY-MM-DD` | A single day. Cannot be combined with `from`/`to`. |
| `from` | `YYYY-MM-DD` | The first day of a range. |
| `to` | `YYYY-MM-DD` | The last day of a range. Defaults to the last published day. |
| `offset` | number | How many pages of the range to skip. The `coverage` block names the offset of the next page. |
| `meal` | meal name | Narrows the search to one meal. |
| `station` | string | Narrows the search to one station. |
| `sort_by` | string | A nutrient key, a micronutrient name, `proteinToCalorie` or `fiberToCalorie`. An unknown field is refused. |
| `sort_order` | `asc`, `desc` | The direction. It defaults to `desc`. |
| `limit` | 1..500 | How many rows to return, the first of them in the order asked for. Defaults to 50; ask again with a larger limit for more. |

```json
{ "name": "search_dishes", "arguments": { "query": "tiramisu", "from": "2026-10-24" } }
```

## filter_dishes

The filters of the menus.

| Parameter | Type | Meaning |
|---|---|---|
| `exclude_allergens` | allergen slugs | Keeps the dishes that carry none of them. |
| `require_traits` | trait slugs | Keeps the dishes that carry every one of them. |
| `min_mhealthy` | 1..5 | The lowest acceptable nutrient-density tier. |
| `max_carbon` | 1..3 | The highest acceptable carbon footprint. |
| `max_calories`, `min_calories` | number | Caps in kcal. |
| `max_sodium_mg`, `min_sodium_mg` | number | Caps in mg. |
| `nutrients` | object | A range per nutrient: `{"protein": {"min": 20, "max": 40, "unit": "g"}}`. A micronutrient threshold without a unit is read in the amount the row carries; `"%DV"` asks for the published percent. |
| `include_nutrients` | string[] | The nutrients to return, or `all`. A nutrient the filter constrained is always returned. |
| `sort_by` | string | A nutrient key, a micronutrient name, `proteinToCalorie` or `fiberToCalorie`. An unknown field is refused. The whole list is in `list_nutrition_fields`. |
| `sort_order` | `asc`, `desc` | The direction. It defaults to `desc`. |
| `query` | string | A substring of the dish name. |
| `meal`, `station` | | Narrow the sweep. |
| `hall` | hall id, or hall id[] | The halls to sweep: one hall, or a list of them. Left out, or an empty list, sweeps every hall. |
| `date` | `YYYY-MM-DD` | A single day. Cannot be combined with `from`/`to`. |
| `from`, `to` | `YYYY-MM-DD` | A range. `to` defaults to the last published day. |
| `limit` | 1..500 | How many rows to return, the first of them in the order asked for. Defaults to 50; ask again with a larger limit for more. |

```json
{ "name": "filter_dishes",
  "arguments": { "exclude_allergens": ["peanuts"], "require_traits": ["vegan"],
                 "nutrients": { "protein": { "min": 20, "unit": "g" } },
                 "include_nutrients": ["protein", "Iron"], "sort_by": "sodium" } }
```

## list_nutrition_fields

The ten canonical nutrients with their units and the alternative units a threshold may be
written in, the four published micronutrients with their Daily Value, and the fields a
sweep can be sorted on.

A micronutrient is published as a percent of the Daily Value and is returned as the amount
that percent stands for: `mg`, or `mcg RAE` for the vitamin A. The `defaultUnit` of a
micronutrient is that amount unit, so a threshold without a unit is read in the amount, and
`"%DV"` asks for the published percent.

## get_hours

| Parameter | Type | Meaning |
|---|---|---|
| `hall` | hall id | One hall, or every hall. |
| `date` | `YYYY-MM-DD` | The day to read. Defaults to today. |

A hall that cannot be read is reported in `failures`; the other halls are still returned.
A day the site states is closed comes back as a single period, `{"label": "Closed",
"times": "Closed", "closed": true}`, not as an empty list.

## find_open_now

| Parameter | Type | Meaning |
|---|---|---|
| `date` | `YYYY-MM-DD` | The day to look at. Defaults to today. |
| `at` | `HH:MM` | The campus-local time of day. Defaults to the current time. |

## get_item_nutrition

The full nutrition panel of one dish.

| Parameter | Type | Meaning |
|---|---|---|
| `hall` | hall id | The hall to read. Required. |
| `item` | string | The dish name. Required. |
| `date` | `YYYY-MM-DD` | The day to read. Defaults to today. |
| `meal` | meal name | Narrows the search to one meal. |
| `station` | string | Narrows the search to one station. |

The name is matched case-insensitively: an exact match wins, otherwise a unique substring
match is used, and an ambiguous name is reported rather than guessed.

The panel carries the figures of the site as they are published, and the `micronutrients`
map beside it carries every micronutrient as the amount it stands for (`mg`, or `mcg RAE`
for the vitamin A): the percent the site prints is the `pct` the panel publishes, and the
`amount` is derived from it.

```json
"micronutrients": {
  "Vitamin C": 0,
  "Calcium": 39,
  "Iron": 1.98
}
```
