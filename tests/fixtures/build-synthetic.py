#!/usr/bin/env python3
"""Build the synthetic menu fixtures the parser tests need.

The captured fixtures hold no Brunch meal and no "no menu" page, so the
parser is never asked to handle either. These pages are built from the same
markup the site uses.
"""
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent


def item(name, traits=(), allergens=()):
    classes = " ".join([f"trait-{trait}" for trait in traits] + [f"allergen-{a}" for a in allergens])
    class_attr = f' class="{classes}"' if classes else ""
    trait_list = ""
    if traits:
        entries = "".join(
            f'<li class="{trait}" title="{trait}">{trait}</li>' for trait in traits
        )
        trait_list = f'<ul class="traits">{entries}</ul>'
    return f"""
                      <li{class_attr}>
                        <a class="" href="#">
                          <h5><i class="fa fa-list">&nbsp;</i><span class="item-name">{name}</span></h5>
                          {trait_list}
                        </a>
                      </li>"""


def station(name, items):
    body = "".join(items)
    return f"""
                    <li>
                      <h4>{name}</h4>
                      <ul class="items">{body}
                      </ul>
                    </li>"""


def meal(label, stations):
    body = "".join(stations)
    return f"""
            <h3><a href="#"><i class="fa fa-minus"></i> {label}</a></h3>
          <div class="courses">
          	<div class="courses_app_title"><span class="course_header_label"></span></div>
          <ul class="courses_wrapper">{body}
          </ul>
          </div>"""


def page(meals_html, date_text):
    return f"""<!DOCTYPE html>
<html lang="en">
<head><title>Menu</title></head>
<body>
<div id="mdining-menu-main" class="small-12 medium-9 large-9 columns">
    <div id="mdining-items">{meals_html}
    </div>
    <h2 class="menuTitle">Menu for <span class="date">{date_text}</span></h2>
</div>
</body>
</html>
"""


def write(name, html):
    path = FIXTURES / name
    path.write_text(html, encoding="utf-8")
    print(f"wrote {path.relative_to(FIXTURES.parent.parent)} ({len(html)} bytes)")


# A Brunch menu beside a Dinner menu, the way the site publishes a Saturday.
brunch = meal(
    "Brunch",
    [
        station(
            "Hot Cereal",
            [item("Oatmeal", traits=("glutenfree", "mhealthy3", "vegan", "carbonlow"))],
        ),
        station("Toast", [item("Scrambled Eggs", traits=("vegetarian",))]),
        station("Signature Maize", [item("Sweet Potato Home Fries")]),
    ],
)
dinner = meal(
    "Dinner",
    [
        station("Soup", [item("Mushroom Bisque", allergens=("milk",))]),
        station("MBakery", [item("Pumpkin Pie")]),
    ],
)
write("brunch.html", page(brunch + dinner, "Saturday, October 24, 2026"))

# A Brunch-only page: the case that used to fail the whole hall-day.
brunch_only = meal(
    "Brunch",
    [
        station("Hot Cereal", [item("Oatmeal", traits=("vegan",))]),
        station("Signature Maize", [item("Sweet Potato Home Fries")]),
    ],
)
write("brunch-only.html", page(brunch_only, "Sunday, October 25, 2026"))

# A meal label the server has no slot for.
supper = meal("Supper", [station("Grill", [item("Night Soup")])])
write("supper.html", page(supper, "Thursday, October 22, 2026"))

# The site's own "no menu" marker.
no_menu = """
            <p class="no-menu">No menu available.</p>
"""
write("no-menu.html", page(no_menu, "Sunday, October 25, 2026"))
