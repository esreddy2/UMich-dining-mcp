# The nutrition data

## The canonical nutrients

The site publishes nine nutrients and a calorie count. The server gives them canonical
names, so a filter or a sort never depends on how the site spelled a row.

| Key | Label | Canonical unit | Also accepted in a threshold |
|---|---|---|---|
| `calories` | Calories | kcal | — |
| `totalFat` | Total Fat | g | mg |
| `saturatedFat` | Saturated Fat | g | mg |
| `transFat` | Trans Fat | g | mg |
| `cholesterol` | Cholesterol | mg | g |
| `sodium` | Sodium | mg | g |
| `totalCarbohydrate` | Total Carbohydrate | g | mg |
| `dietaryFiber` | Dietary Fiber | g | mg |
| `sugars` | Sugars | g | mg |
| `protein` | Protein | g | mg |

A threshold may be written in any of the accepted units. The unit defaults to the
canonical one.

```json
{ "nutrients": { "protein": { "min": 30_000, "unit": "mg" } } }
```

is the same as `{"protein": {"min": 30}}`. A unit the nutrient cannot be expressed in — a
kilogram of protein — is refused by name.

## The micronutrients

The site publishes exactly four micronutrients, and only as a percentage of the Daily Value
the panel refers to. The server keeps the published percent and derives the physical
amount from that Daily Value.

| Name | Published | Daily Value | Derived unit | Field |
|---|---|---|---|---|
| Vitamin A | %DV | 900 mcg RAE | mcg RAE | `vitaminA` |
| Vitamin C | %DV | 90 mg | mg | `vitaminC` |
| Calcium | %DV | 1300 mg | mg | `calcium` |
| Iron | %DV | 18 mg | mg | `iron` |

A selected micronutrient is an amount, like every other nutrient of the row:

```json
"iron": 2.7
```

The figure is derived: 15% of the 18 mg Daily Value of iron. The Daily Value is the one
the panel itself refers to; the server does not compute a daily value table of its own.
The unit is in the `units` map of the response: `mg`, or `mcg RAE` for the vitamin A.

The percent the site prints stays available where it belongs: under the name `%DV` in a
threshold, and in the panel of `get_item_nutrition`, which carries both figures for every
micronutrient:

```json
"micronutrients": { "Iron": { "pct": 15, "amount": 2.7, "unit": "mg" } }
```

### The rounding caveat

The site publishes whole percentages, so the derived amount carries the rounding of the
published figure: a 15% value is somewhere between 13% and 17% of the Daily Value, not
exactly 15%. The derived amount is a rounded figure, not a measurement.

### The thresholds on a micronutrient

A threshold in mg is compared against the **derived** amount, not against the percent
re-rounded to an integer. A threshold in `%DV` is compared against the published percent.

```json
{ "nutrients": { "Iron": { "min": 2, "unit": "mg" } } }
```

keeps the dishes with at least 2 mg of iron, which is about 11% of the Daily Value.

**A micronutrient threshold without a unit is read in the amount the row carries.** That is
the unit `list_nutrition_fields` reports as the `defaultUnit` of the nutrient, and it is the
same figure the row shows, so the threshold and the row can be read together. The
published percent is still there under its own name:

| Threshold | Meaning | Dishes it keeps |
|---|---|---|
| `{"Iron": {"min": 2}}` | at least 2 mg | 102 |
| `{"Iron": {"min": 2, "unit": "%DV"}}` | at least 2 %DV | 483 |
| `{"Iron": {"min": 2, "unit": "g"}}` | at least 0.002 g | 102 |

Write the unit when the number means something else.

## The missing values

Three rules, and they matter more than the numbers:

- A dish that publishes no value for a nutrient is `null`, never `0`.
- A constraint on a nutrient **excludes** the dishes that publish no value for it. A
  missing value is not a small value.
- A value the site writes as `trace` or `< 1%` is not a value at all. It is reported as
  missing rather than as zero or as one.

## The serving size

The published serving size is kept as the site's own text, and its weight in grams is
read from the same text:

| Published | `servingSize` | `servingSizeGrams` |
|---|---|---|
| `Cups (253g)` | `Cups (253g)` | 253 |
| `1/2 Cup (113g)` | `1/2 Cup (113g)` | 113 |
| `4 oz (113g)` | `4 oz (113g)` | 113 |
| `.5 oz Serving (14g)` | `.5 oz Serving (14g)` | 14 |
| `4 oz` | `4 oz` | 113.398 |
| `1 Each` | `1 Each` | `null` |

The gram figure in parentheses wins. An ounce amount is converted with the standard factor
of 28.349523125 g per ounce. Where the site publishes neither, the weight is `null`:
nothing is ever guessed.

## The sorting

`sort_by` takes a canonical nutrient key, one of `proteinToCalorie` and
`fiberToCalorie`, or the name of a micronutrient. A micronutrient sorts by its amount, the
number the row carries. Dishes without a value always sort last, whatever the direction.

The sort is applied to the whole answer before the limit: the rows that come back are the
first ones of the order that was asked for. Both sweep tools sort, and both take a
`limit` of 50 rows by default.

`sort_order` is `asc` or `desc`; it defaults to `desc`, so the biggest value comes first.
An unknown `sort_by` is refused: a typo would otherwise return a list that looks sorted and
is not.
