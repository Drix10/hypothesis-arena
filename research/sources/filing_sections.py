"""10-K section parser: Items 1, 1A, 2, 7, 7A and 8 with character offsets.

Takes plain text or raw HTML (standard-library html.parser). Per item the last
heading at a line start wins, which skips table-of-contents entries. Fails
closed: any missing, blank or out-of-order item gives no sections and a reason.
Offsets index Result.text; the HTML path returns the converted text.
"""
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

WANTED = ("1", "1A", "2", "7", "7A", "8")

_HEADING = re.compile(
    r"^[ \t]*item[ \t]*(\d{1,2}[A-C]?)(?![0-9A-Za-z])", re.IGNORECASE | re.MULTILINE)
_PUNCT = " .:-–—\t\r\n"
_BLOCK = {"p", "div", "br", "tr", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6"}
_SKIP = {"script", "style"}


@dataclass
class Result:
    text: str
    sections: dict = field(default_factory=dict)  # item -> (start, end)
    reason: str = ""

    def section_text(self, item):
        start, end = self.sections[item]
        return self.text[start:end]


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self._skip += 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html):
    p = _Text()
    p.feed(html)
    p.close()
    return "".join(p.parts).replace("\xa0", " ")


def parse(text, html=False):
    if html:
        text = html_to_text(text)
    last = {}
    for m in _HEADING.finditer(text):
        last[m.group(1).upper()] = m.start()
    missing = [i for i in WANTED if i not in last]
    if missing:
        return Result(text, reason="missing heading: Item " + ", Item ".join(missing))
    starts = [last[i] for i in WANTED]
    if starts != sorted(set(starts)):
        return Result(text, reason="headings out of order")
    # the next heading of any item bounds a section
    bounds = sorted(last.values())
    sections = {}
    for item in WANTED:
        start = last[item]
        end = next((b for b in bounds if b > start), len(text))
        if not _HEADING.sub("", text[start:end], count=1).strip(_PUNCT):
            return Result(text, reason="blank section: Item " + item)
        sections[item] = (start, end)
    return Result(text, sections)
