#!/usr/bin/env python3
"""Build the expected test data from the committed HTML fixtures.

This file is a deliberately independent second implementation of the site
reader.  It uses its own tolerant HTML tokenizer instead of a DOM library and
it never imports anything from `src/`, so the expectations it writes are
derived from the markup itself and not from the TypeScript parser under test.

The output is committed to `tests/fixtures/expected/` and the test suite
compares the parser against it field by field.

    python3 tests/oracle/build_expected.py          # write the expected data
    python3 tests/oracle/build_expected.py --check  # fail when it is out of date

The two readers were cross-checked against each other and against the live
rendered pages of all ten halls; the expected data is the shared result.
"""

from __future__ import annotations

import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS_DIR = os.path.dirname(HERE)
FIXTURE_DIR = os.path.join(TESTS_DIR, "fixtures")
EXPECTED_DIR = os.path.join(FIXTURE_DIR, "expected")
SNAPSHOT_DIR = os.path.join(TESTS_DIR, "snapshots")


def capture_date() -> str:
    """The day the committed fixtures were captured for."""
    with open(os.path.join(FIXTURE_DIR, "capture-date.txt"), encoding="utf-8") as handle:
        return handle.read().strip()

VOID_ELEMENTS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
RAW_TEXT_ELEMENTS = {"script", "style"}

# The scoping elements of the HTML parsing rules.  A `</li>` is ignored when
# the search for an open `li` runs into one of them first: the site closes
# every item list entry with a `</li>` that has no matching open element, and
# a browser keeps the list intact instead of closing the station.
SCOPING_ELEMENTS = {
    "applet", "caption", "html", "marquee", "object", "table", "td",
    "template", "th",
}
LIST_ITEM_SCOPING_ELEMENTS = SCOPING_ELEMENTS | {"ol", "ul"}

NBSP = " "
DASHES = re.compile("[‐-―]")
WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# The meals the site publishes.
MEAL_LABELS = ["Breakfast", "Lunch", "Dinner"]

HALLS = {
    "bursley": ("bursley.html", "dining-halls/bursley"),
    "east-quad": ("east-quad.html", "dining-halls/east-quad"),
    "markley": ("markley.html", "dining-halls/markley"),
    "mosher-jordan": ("mosher-jordan.html", "dining-halls/mosher-jordan"),
    "north-quad": ("north-quad.html", "dining-halls/north-quad"),
    "south-quad": ("south-quad.html", "dining-halls/south-quad"),
    "twigs-at-oxford": ("twigs-at-oxford.html", "dining-halls/twigs-at-oxford"),
    "wolverine-village": ("wolverine-village-dining-hall.html", "dining-halls/wolverine-village-dining-hall"),
    "lawyers-club": ("lawyers-club.html", "dining-halls/select-access/lawyers-club"),
    "martha-cook": ("martha-cook.html", "dining-halls/select-access/martha-cook"),
}

# The nine nutrients of the FDA panel, in the order the site publishes them.
NUTRIENT_FIELDS = {
    "Total Fat": "totalFat",
    "Saturated Fat": "saturatedFat",
    "Trans Fat": "transFat",
    "Cholesterol": "cholesterol",
    "Sodium": "sodium",
    "Total Carbohydrate": "totalCarbohydrate",
    "Dietary Fiber": "dietaryFiber",
    "Sugars": "sugars",
    "Protein": "protein",
}
NUTRIENT_NAMES = [
    "Total Carbohydrate", "Total Fat", "Saturated Fat", "Trans Fat",
    "Dietary Fiber", "Cholesterol", "Sugars", "Protein", "Sodium",
]


# --------------------------------------------------------------------------
# A tolerant HTML reader
# --------------------------------------------------------------------------


class Node:
    """An element of the parsed document."""

    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag: str, attrs: dict[str, str]) -> None:
        self.tag = tag
        self.attrs = attrs
        self.children: list = []

    def classes(self) -> list[str]:
        return (self.attrs.get("class") or "").split()

    def has_class(self, name: str) -> bool:
        return name in self.classes()

    def elements(self, tag: str | None = None) -> list["Node"]:
        found: list[Node] = []
        for child in self.children:
            if isinstance(child, Node):
                if tag is None or child.tag == tag:
                    found.append(child)
                found.extend(child.elements(tag))
        return found

    def child_elements(self, tag: str | None = None) -> list["Node"]:
        return [
            child for child in self.children
            if isinstance(child, Node) and (tag is None or child.tag == tag)
        ]

    def first(self, tag: str | None = None) -> "Node | None":
        for child in self.children:
            if isinstance(child, Node) and (tag is None or child.tag == tag):
                return child
        return None

    def descendants_with_class(self, tag: str, name: str) -> list["Node"]:
        return [node for node in self.elements(tag) if node.has_class(name)]

    def text(self) -> str:
        parts: list[str] = []
        for child in self.children:
            if isinstance(child, Node):
                parts.append(child.text())
            else:
                parts.append(child)
        return normalize("".join(parts))


def normalize(value: str) -> str:
    """Decode the entities of the site and collapse the whitespace."""
    value = html.unescape(value)
    value = value.replace(NBSP, " ")
    value = DASHES.sub("-", value)
    return re.sub(r"\s+", " ", value).strip()


def parse_attributes(source: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in re.finditer(
        r"""([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?""",
        source,
    ):
        name = match.group(1).lower()
        value = match.group(2)
        if value is None:
            value = match.group(3)
        if value is None:
            value = match.group(4)
        if name and value is not None:
            attrs[name] = value
    return attrs


def close_element(stack: list[Node], name: str) -> None:
    """Handle an end tag the way the HTML parsing rules do.

    The nearest open element of that name is closed together with everything
    that is still open inside it.  A `</li>` is only closed when an open `li`
    is in list item scope, so the stray `</li>` of the site is ignored
    instead of closing the station the item belongs to.
    """
    scope = LIST_ITEM_SCOPING_ELEMENTS if name == "li" else None
    for position in range(len(stack) - 1, 0, -1):
        tag = stack[position].tag
        if tag == name:
            del stack[position:]
            return
        if scope is not None and tag in scope:
            return
    # No open element of that name: the end tag is ignored.


def parse_document(markup: str) -> Node:
    """Parse the markup into a tree, tolerating the site's broken tags.

    The site closes the serving-size cell of a nutrition panel with `</th>`
    instead of `</td>`, and it closes every item of a station with a `</li>`
    that has no matching open element.  Both are handled the way a browser
    handles them: an end tag without a match is ignored, and a `</li>` that
    would have to close a list item across a list boundary is ignored too.
    """
    root = Node("#document", {})
    stack = [root]
    index = 0
    length = len(markup)

    while index < length:
        start = markup.find("<", index)
        if start < 0:
            stack[-1].children.append(markup[index:])
            break
        if start > index:
            stack[-1].children.append(markup[index:start])

        if markup.startswith("<!--", start):
            end = markup.find("-->", start)
            index = length if end < 0 else end + 3
            continue
        if markup.startswith("<!", start) or markup.startswith("<?", start):
            end = markup.find(">", start)
            index = length if end < 0 else end + 1
            continue

        end = markup.find(">", start)
        if end < 0:
            stack[-1].children.append(markup[start:])
            break
        inner = markup[start + 1:end]
        index = end + 1

        if inner.startswith("/"):
            name = inner[1:].strip().lower()
            close_element(stack, name)
            continue

        self_closing = inner.endswith("/")
        if self_closing:
            inner = inner[:-1]
        split = re.search(r"[\s/]", inner)
        if split:
            tag = inner[: split.start()].lower()
            rest = inner[split.start():]
        else:
            tag = inner.lower()
            rest = ""
        node = Node(tag, parse_attributes(rest))
        stack[-1].children.append(node)

        if tag in RAW_TEXT_ELEMENTS:
            close = re.compile(r"</\s*" + re.escape(tag) + r"\s*>", re.IGNORECASE)
            match = close.search(markup, index)
            if match:
                node.children.append(markup[index:match.start()])
                index = match.end()
            continue
        if tag not in VOID_ELEMENTS and not self_closing:
            stack.append(node)

    return root


# --------------------------------------------------------------------------
# The nutrition panels
# --------------------------------------------------------------------------


def decode_email(hex_value: str) -> str | None:
    """Decode the Cloudflare obfuscated e-mail address."""
    clean = hex_value.strip().lower()
    if len(clean) < 4 or len(clean) % 2 or not re.fullmatch(r"[0-9a-f]+", clean):
        return None
    data = bytes.fromhex(clean)
    key = data[0]
    return "".join(chr(byte ^ key) for byte in data[1:])


def split_name_and_value(cell_text: str, strong_text: str) -> tuple[str, str]:
    """Split a cell into the nutrient name and its value.

    The name of a nutrient is wrapped in a <strong> in most rows; the indented
    sub-nutrients are plain text.
    """
    if strong_text:
        position = cell_text.lower().find(strong_text.lower())
        if position >= 0:
            return strong_text, cell_text[position + len(strong_text):].strip()
        return strong_text, cell_text.replace(strong_text, "").strip()
    for candidate in NUTRIENT_NAMES:
        if cell_text.lower().startswith(candidate.lower()):
            return candidate, cell_text[len(candidate):].strip()
    return cell_text, ""


def parse_panel(panel: Node) -> dict | None:
    """Read the nutrition panel of one dish.

    The values are read out of the rows of the table.  The rows themselves
    are not written out: the test suite reads them out of the fixture with
    its own scanner, so that a value can be traced back to the markup
    without the expected file having to carry a copy of it.
    """
    table = None
    for candidate in panel.descendants_with_class("table", "nutrition-facts"):
        table = candidate
        break
    if table is None:
        return None

    values: dict = {
        "servingSize": None,
        "calories": None,
        "micronutrients": {},
    }
    for field in NUTRIENT_FIELDS.values():
        values[field] = None

    for row in table.elements("tr"):
        row_class = " ".join(row.classes())
        cell_nodes = [cell for cell in row.child_elements() if cell.tag in ("td", "th")]
        cells = [cell.text() for cell in cell_nodes]

        if "nutrition-facts-header" in row_class:
            continue
        if not cells:
            continue
        first = cells[0]
        if not first:
            continue
        if first.lower() == "amount per serving":
            continue
        if len(cells) > 1 and cells[1].lower().startswith("% daily value"):
            continue

        strong_node = cell_nodes[0].first("strong")
        strong_text = strong_node.text() if strong_node is not None else ""

        if "micronutrient" in row_class:
            name = strong_text or first
            value = cells[1] if len(cells) > 1 else ""
            if name and value:
                values["micronutrients"][name] = value
            continue

        name, value = split_name_and_value(first, strong_text)

        if "serving-size" in row_class or name.lower() == "serving size":
            values["servingSize"] = value or None
            continue
        if "portion-calories" in row_class or name.lower() == "calories":
            digits = re.sub(r"[^0-9]", "", value)
            values["calories"] = int(digits) if digits else None
            continue
        if name in NUTRIENT_FIELDS:
            values[NUTRIENT_FIELDS[name]] = value or None

    return {"values": values}


# --------------------------------------------------------------------------
# The menu pages
# --------------------------------------------------------------------------


def item_traits(item: Node) -> list[dict]:
    """The published trait list of an item."""
    published: list[dict] = []
    for trait_list in item.descendants_with_class("ul", "traits"):
        for entry in trait_list.child_elements("li"):
            classes = entry.classes()
            if not classes:
                continue
            published.append({
                "slug": classes[0],
                "label": normalize(entry.attrs.get("title") or entry.text()),
            })
    return published


def parse_items_list(items_list: Node) -> list[dict]:
    """Read the items of one station.

    The nutrition panel of a dish is the sibling that follows its <li> inside
    the item list, so the list is read as a sequence.
    """
    items: list[dict] = []
    pending: dict | None = None
    for child in items_list.child_elements():
        if child.tag == "li":
            name = ""
            for span in child.elements("span"):
                if span.has_class("item-name"):
                    name = span.text()
                    break
            if not name:
                pending = None
                continue
            classes = child.classes()
            pending = {
                "name": name,
                "traitClasses": [c[len("trait-"):] for c in classes if c.startswith("trait-")],
                "allergenClasses": [c[len("allergen-"):] for c in classes if c.startswith("allergen-")],
                "publishedTraits": item_traits(child),
                "panel": None,
            }
            items.append(pending)
            continue
        if child.has_class("nutrition") and pending is not None:
            pending["panel"] = parse_panel(child)
    return items


def parse_hall_page(path: str) -> dict:
    markup = open(path, encoding="utf-8", errors="replace").read()
    document = parse_document(markup)

    container = None
    for node in document.elements("div"):
        if node.attrs.get("id") == "mdining-items":
            container = node
            break
    if container is None:
        raise SystemExit(f"{path}: no #mdining-items container")

    meals: list[dict] = []
    children = container.child_elements()
    for position, child in enumerate(children):
        if child.tag != "h3":
            continue
        courses = None
        for following in children[position + 1:]:
            if following.tag == "div" and following.has_class("courses"):
                courses = following
                break
        if courses is None:
            continue

        stations: list[dict] = []
        for station_list in courses.descendants_with_class("ul", "courses_wrapper"):
            for station_node in station_list.child_elements("li"):
                heading = station_node.first("h4")
                if heading is None:
                    continue
                items: list[dict] = []
                for items_list in station_node.child_elements("ul"):
                    if items_list.has_class("items"):
                        items.extend(parse_items_list(items_list))
                stations.append({"name": heading.text(), "items": items})
        meals.append({"label": child.text(), "stations": stations})

    today_hours = []
    for hours_list in document.descendants_with_class("ul", "calhours"):
        for entry in hours_list.child_elements("li"):
            label = ""
            times = ""
            for span in entry.elements("span"):
                if span.has_class("calhours-title"):
                    label = span.text()
                elif span.has_class("calhours-times"):
                    times = span.text()
            if label or times:
                today_hours.append({"label": label, "times": times})
        break

    location = {"address": None, "phone": None, "email": None, "mapUrl": None}
    for details in document.descendants_with_class("ul", "location-details"):
        for entry in details.child_elements("li"):
            classes = entry.classes()
            if "address" in classes:
                anchor = entry.first("a")
                location["address"] = entry.text() or None
                if anchor is not None:
                    location["mapUrl"] = anchor.attrs.get("href")
            elif "phone" in classes:
                location["phone"] = entry.text() or None
            elif "email" in classes:
                for node in entry.elements():
                    if "data-cfemail" in node.attrs:
                        location["email"] = decode_email(node.attrs["data-cfemail"])
                        break
        break

    items = [item for meal in meals for station in meal["stations"] for item in station["items"]]
    panels = [item for item in items if item["panel"] is not None]

    return {
        "meals": meals,
        "todayHours": today_hours,
        "location": location,
        "counts": {
            "meals": len(meals),
            "stations": sum(len(meal["stations"]) for meal in meals),
            "items": len(items),
            "panels": len(panels),
        },
        "source": {
            "itemNameSpans": len(re.findall(r'<span class="item-name">', markup)),
            "nutritionDivs": len(re.findall(r'<div class="nutrition"', markup)),
            "nutritionTables": len(re.findall(r'<table class="nutrition-facts">', markup)),
        },
    }


# --------------------------------------------------------------------------
# The regular hours page
# --------------------------------------------------------------------------


def expand_days(label: str) -> list[str]:
    parts = [part.strip() for part in re.split(r"\s*[-–—]\s*", label) if part.strip()]
    if not parts:
        return []
    if len(parts) == 1:
        return [parts[0]] if parts[0] in WEEKDAYS else []
    start = WEEKDAYS.index(parts[0]) if parts[0] in WEEKDAYS else -1
    end = WEEKDAYS.index(parts[1]) if parts[1] in WEEKDAYS else -1
    if start < 0 or end < 0:
        return []
    days: list[str] = []
    cursor = start
    limit = end if end >= start else end + len(WEEKDAYS)
    while cursor <= limit:
        days.append(WEEKDAYS[cursor % len(WEEKDAYS)])
        cursor += 1
    return days


def hall_of_url(url: str) -> str | None:
    match = re.search(r"/menus-locations/(.+?)/?$", url.strip())
    if not match:
        return None
    path = match.group(1).rstrip("/")
    for hall, (_, hall_path) in HALLS.items():
        if hall_path == path:
            return hall
    return None


def split_on_breaks(cell: Node) -> list[str]:
    """Split the content of a cell at its <br> elements."""
    lines: list[str] = []
    current: list[str] = []

    def walk(node: Node) -> None:
        for child in node.children:
            if isinstance(child, Node):
                if child.tag == "br":
                    lines.append(normalize("".join(current)))
                    current.clear()
                    continue
                walk(child)
            else:
                current.append(child)

    walk(cell)
    tail = normalize("".join(current))
    if tail:
        lines.append(tail)
    return [line for line in lines if line]


def parse_regular_hours(path: str) -> dict:
    markup = open(path, encoding="utf-8", errors="replace").read()
    document = parse_document(markup)

    halls: dict[str, dict] = {}
    for table in document.elements("table"):
        current: dict | None = None
        for row in table.elements("tr"):
            head = None
            for cell in row.child_elements():
                if cell.tag == "th":
                    head = cell
                    break
            if head is not None:
                anchor = head.first("a") or next(iter(head.elements("a")), None)
                url = anchor.attrs.get("href") if anchor is not None else None
                hall = hall_of_url(url) if url else None
                if hall is None:
                    current = None
                    continue
                current = {"name": head.text(), "url": url, "weekly": []}
                halls[hall] = current
                continue

            if current is None:
                continue
            cells = [cell for cell in row.child_elements() if cell.tag == "td"]
            if len(cells) < 2:
                continue
            day_label = cells[0].text()
            days = expand_days(day_label)
            if not days:
                continue
            periods = []
            for raw in split_on_breaks(cells[1]):
                if ":" in raw:
                    label, times = raw.split(":", 1)
                else:
                    label, times = "", raw
                periods.append({
                    "label": label.strip(),
                    "times": times.strip(),
                    "raw": raw,
                })
            current["weekly"].append({
                "dayLabel": day_label,
                "days": days,
                "periods": periods,
            })
    return halls


# --------------------------------------------------------------------------
# The writers
# --------------------------------------------------------------------------


def snapshot_of(halls: dict[str, dict]) -> dict:
    snapshot = {"capturedFor": capture_date(), "halls": {}}
    for hall, data in halls.items():
        meals: dict[str, int] = {label: 0 for label in MEAL_LABELS}
        dish_lines: list[str] = []
        for meal in data["meals"]:
            meals[meal["label"]] = len(meal["stations"])
            for station in meal["stations"]:
                for item in station["items"]:
                    dish_lines.append(f"{meal['label']} | {station['name']} | {item['name']}")
        snapshot["halls"][hall] = {
            "meals": meals,
            "stations": data["counts"]["stations"],
            "items": data["counts"]["items"],
            "dishLines": dish_lines,
        }
    return snapshot


def write_json(path: str, payload: object, indent: int = 1) -> str:
    text = json.dumps(payload, indent=indent, ensure_ascii=False) + "\n"
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            if handle.read() == text:
                return "unchanged"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return "written"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    halls: dict[str, dict] = {}
    for hall, (filename, _) in HALLS.items():
        halls[hall] = parse_hall_page(os.path.join(FIXTURE_DIR, filename))
    regular = parse_regular_hours(os.path.join(FIXTURE_DIR, "regularhours.html"))

    os.makedirs(EXPECTED_DIR, exist_ok=True)
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)

    files: dict[str, object] = {}
    for hall, data in halls.items():
        files[os.path.join(EXPECTED_DIR, f"{hall}.json")] = {"hall": hall, **data}
    files[os.path.join(EXPECTED_DIR, "regular-hours.json")] = regular
    files[os.path.join(SNAPSHOT_DIR, "item-names.json")] = snapshot_of(halls)

    changed = []
    for path, payload in files.items():
        indent = 2 if path.endswith("item-names.json") else 1
        if check:
            state = "unchanged"
            if not os.path.exists(path):
                state = "missing"
            else:
                with open(path, encoding="utf-8") as handle:
                    if json.load(handle) != payload:
                        state = "outdated"
        else:
            state = write_json(path, payload, indent)
        if state != "unchanged":
            changed.append((os.path.relpath(path, TESTS_DIR), state))

    for hall, data in halls.items():
        print(
            f"{hall:20s} meals={data['counts']['meals']:2d} stations={data['counts']['stations']:3d} "
            f"items={data['counts']['items']:3d} panels={data['counts']['panels']:3d} "
            f"(source spans={data['source']['itemNameSpans']:3d} tables={data['source']['nutritionTables']:3d})"
        )
    total_items = sum(data["counts"]["items"] for data in halls.values())
    total_panels = sum(data["counts"]["panels"] for data in halls.values())
    print(f"TOTAL items={total_items} panels={total_panels} regular hours halls={len(regular)}")

    for path, state in changed:
        print(f"{state}: {path}")

    if check and changed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
