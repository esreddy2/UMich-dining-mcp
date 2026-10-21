# The oracle

`build_expected.py` writes the expected data of the test suite from the HTML fixtures.

It is a second implementation of the reader of the site, written on purpose:

- it is a different language, so it cannot share a bug with the TypeScript parser;
- it has its own tolerant HTML reader instead of a DOM library, so a parser that
  mis-nests an element, loses a dish or shifts a nutrition panel onto the wrong
  dish shows up in the comparison;
- it never imports anything from `src/`.

The output is `tests/fixtures/expected/`, which the test suite compares with the
parser field by field. The two readers were also both checked against the live
rendered pages of all ten halls, so the expected data is a statement about the
site and not about one of the two readers.

## The markup of the site is broken in two ways

Both are handled the way a browser handles them, and the tests depend on it:

- The serving size cell of a nutrition panel is closed with `</th>` instead of
  `</td>`. An end tag that matches no open element is ignored, so the cell and
  its row stay intact.
- Every dish of a station is closed with a `</li>` that has no matching open
  element. A `</li>` is only honoured when an open `li` is in list item scope,
  so the stray `</li>` is ignored instead of closing the station.

## Usage

```bash
python3 tests/oracle/build_expected.py            # write the expected data
python3 tests/oracle/build_expected.py --check    # fail when it is out of date
npm run test:oracle                                # the same check
```

Run it after every capture of new fixtures. The day the fixtures were captured for is read
from `tests/fixtures/capture-date.txt` and written into the snapshot, so the oracle and the
test suite always name the same day.
