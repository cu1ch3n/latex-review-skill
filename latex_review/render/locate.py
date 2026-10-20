"""Find where source lines, sections and figures appear in a frozen PDF."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import posixpath
from pathlib import Path
import re
import subprocess

import pymupdf as pdf

from ..outline import argument, build_outline

MAX_LOOKUPS = 80
CAPTION_PREFIXES = ('Figure ', 'Fig. ', 'Abbildung ', 'Figure~', '图 ', '图')
BOUNDARY = re.compile(r'^\s*\\(?:\[|\]|begin\{|end\{|input\{|include\{|(?:sub)*section\*?\{|chapter\*?\{|paragraph\{)')


class Build:
    """A compiled snapshot: its PDF and the sources it was compiled from."""

    def __init__(self, info, main, source_dir):
        self.info, self.main, self.source_dir = info, main, source_dir
        self.root = Path(info['root'])
        self.document = pdf.open(info['pdf'])
        self._outline = self._figures = self._margins = self._locator = None

    def path(self, name):
        """The snapshot file for a repository path."""
        return self.root / posixpath.relpath(name, self.source_dir or '.')

    def read(self, name):
        path = self.path(name)
        return path.read_text(errors='replace') if path.is_file() else None

    @property
    def outline(self):
        if self._outline is None:
            self._outline = build_outline(self.read, self.main)['nodes']
        return self._outline

    @property
    def locator(self):
        if self._locator is None:
            self._locator = Locator(self)
        return self._locator

    @property
    def margins(self):
        if self._margins is None:
            self._margins = Margins(self.document)
        return self._margins

    @property
    def figures(self):
        if self._figures is None:
            self._figures = FigureLocator(self)
        return self._figures

    def close(self):
        self.document.close()


def source_range(lines, start, end, whole=False):
    """Widen a line range to complete paragraphs, so a changed word is shown in context."""
    if not lines:
        return 1, 0
    if whole:
        return 1, len(lines)
    start, end = min(max(1, start), len(lines)), min(max(1, end), len(lines))
    lower, upper = max(1, start - 60), min(len(lines), end + 60)
    while start > lower and lines[start - 2].strip() and not BOUNDARY.match(lines[start - 2]):
        start -= 1
    while end < upper and lines[end].strip() and not BOUNDARY.match(lines[end]):
        end += 1
    return start, end


def text_bounds(page):
    """Horizontal extent of the page's text, padded, so crops never cut words."""
    blocks = [b for b in page.get_text('blocks') if b[4].strip()]
    if not blocks:
        return 0, page.rect.width
    return max(0, min(b[0] for b in blocks) - 8), min(page.rect.width, max(b[2] for b in blocks) + 8)


class Margins:
    """Running headers and footers: text that repeats at the same height on many pages."""

    def __init__(self, document):
        pages = len(document)
        sample = sorted({round(i * (pages - 1) / 39) for i in range(40)}) if pages > 40 else range(pages)
        tops, bottoms = Counter(), Counter()
        for number in sample:
            blocks = text_blocks(document[number])
            if len(blocks) < 2:
                continue
            if blocks[1][1] - blocks[0][3] >= 8:
                tops[round(blocks[0][3])] += 1
            if blocks[-1][1] - max(b[3] for b in blocks[:-1]) >= 8:
                bottoms[round(blocks[-1][1])] += 1
        needed = max(3, .3 * len(sample))
        top = tops.most_common(1)
        bottom = bottoms.most_common(1)
        self.header = top[0][0] + 1 if top and top[0][1] >= needed else None
        self.footer = bottom[0][0] - 1 if bottom and bottom[0][1] >= needed else None

    def body(self, page):
        """Top and bottom of the running text on a page."""
        blocks = [b for b in text_blocks(page)
                  if not (self.header is not None and b[3] <= self.header + 1)
                  and not (self.footer is not None and b[1] >= self.footer - 1)]
        if not blocks:
            return (self.header or 36) + 4, (self.footer or page.rect.height - 36) - 4
        return max(0, min(b[1] for b in blocks) - 6), min(page.rect.height, max(b[3] for b in blocks) + 6)


def text_blocks(page):
    return sorted((b for b in page.get_text('blocks') if b[4].strip()), key=lambda b: b[1])


class Locator:
    """Source lines to PDF regions, using SyncTeX."""

    def __init__(self, build):
        self.build = build
        self.cache = {}

    def lookup(self, path, line):
        key = (str(path), line)
        if key not in self.cache:
            result = subprocess.run(['synctex', 'view', '-i', f'{line}:0:{path}', '-o', self.build.info['pdf']],
                                    capture_output=True, text=True)
            records = []
            for block in re.split(r'(?m)^Page:', result.stdout)[1:]:
                fields = dict(re.findall(r'(?m)^(x|y|h|v|W|H):([\d.+-]+)', block))
                try:
                    page = int(block.splitlines()[0]) - 1
                    y, v, height = float(fields['y']), float(fields['v']), float(fields['H'])
                    records.append((page, min(y, v - height), max(y, v)))
                except (ValueError, KeyError, IndexError):
                    continue
            self.cache[key] = records
        return self.cache[key]

    def locate(self, name, start, end, whole=False):
        """Regions {page, clip, label} showing the given source lines."""
        path = self.build.path(name)
        if not path.is_file() or path.suffix != '.tex':
            return []
        lines = path.read_text(errors='replace').split('\n')
        start, end = source_range(lines, start, end, whole)
        wanted = [n for n in range(start, end + 1)
                  if lines[n - 1].strip() and not lines[n - 1].lstrip().startswith('%')]
        if len(wanted) > MAX_LOOKUPS:
            step = len(wanted) / MAX_LOOKUPS
            wanted = sorted({wanted[int(i * step)] for i in range(MAX_LOOKUPS)} | {wanted[0], wanted[-1]})
        document, positions = self.build.document, {}
        with ThreadPoolExecutor(8) as pool:
            for records in pool.map(lambda n: self.lookup(path, n), wanted):
                for page, y0, y1 in records:
                    if 0 <= page < len(document):
                        positions.setdefault(page, []).append((y0, y1))
        result = []
        for number, points in sorted(positions.items()):
            page = document[number]
            top = max(0, min(p[0] for p in points) - 14)
            bottom = min(page.rect.height, max(p[1] for p in points) + 16)
            # Keep whole text lines that intersect the located region.
            for block in page.get_text('blocks'):
                if block[1] < bottom and block[3] > top and block[3] - block[1] < 180:
                    top, bottom = min(top, block[1] - 8), max(bottom, block[3] + 8)
            body_top, body_bottom = self.build.margins.body(page)
            top, bottom = max(top, min(body_top, min(p[0] for p in points))), min(bottom, max(body_bottom, max(p[1] for p in points)))
            left, right = text_bounds(page)
            clip = pdf.Rect(left, max(0, top), right, min(page.rect.height, bottom))
            result.append({'page': number, 'clip': list(clip), 'label': page.get_label() or str(number + 1)})
        return result


class FigureLocator:
    """Figure floats by their \\label, through hyperref anchors and captions.

    SyncTeX can map structural float commands to a neighbouring paragraph;
    named figure anchors avoid importing that unrelated text.
    """

    def __init__(self, build):
        self.build = build
        self.document = build.document
        self.margins = build.margins
        self.toc = self.document.get_toc(simple=False)
        self.names = self.document.resolve_names()
        self.labels = {}
        for path in Path(build.info['pdf']).parent.rglob('*.aux'):
            for line in path.read_text(errors='replace').splitlines():
                if not line.startswith(r'\newlabel'):
                    continue
                label, end = argument(line, len(r'\newlabel'))
                value, _ = argument(line, end)
                if not value:
                    continue
                fields, i = [], 0
                while i < len(value):
                    field, i = argument(value, i)
                    if field is None:
                        break
                    fields.append(field)
                if len(fields) >= 4:
                    self.labels[label] = (fields[0], fields[3])

    def content(self, name, text):
        """SyncTeX positions (page, top, bottom) of the figure's content lines."""
        path = self.build.path(name)
        lines = content_lines(text)[:MAX_LOOKUPS]
        return [record for line in lines for record in self.build.locator.lookup(path, line)]

    def locate(self, name, *_):
        text = self.build.read(name)
        if text is None:
            return []
        regions = []
        for label in re.findall(r'\\label\{([^}]+)\}', text):
            number, anchor = self.labels.get(label, ('', ''))
            destination = self.names.get(anchor)
            if not destination or not anchor.startswith('figure.'):
                continue
            page = destination['page']
            if not 0 <= page < len(self.document):
                continue
            source = self.document[page]
            top = (pdf.Point(destination['to']) * source.transformation_matrix).y
            captions = [r for prefix in CAPTION_PREFIXES for r in source.search_for(prefix + number + ':')]
            captions += [r for prefix in CAPTION_PREFIXES for r in source.search_for(prefix + number + '：')]
            if not captions:
                continue
            caption = min(captions, key=lambda r: abs(r.y0 - top))
            bottom = max((b[3] for b in source.get_text('blocks') if pdf.Rect(b[:4]).intersects(caption)),
                         default=caption.y1) + 10
            # Without hypcap the anchor sits at the caption; the float's content lies above it.
            content = [y0 for p, y0, _ in self.content(name, text) if p == page and
                       caption.y0 - .8 * source.rect.height < y0 < caption.y0]
            top = min([top, *content])
            left, right = text_bounds(source)
            regions.append({'page': page, 'clip': [left, max(0, top - 6), right, bottom]})
        return regions


FLOAT_STRUCTURE = re.compile(r'\s*(%|\\(begin|end)\{(figure|table)\*?\}|\\(caption|label|centering)\b)')


def content_lines(text):
    """Lines of a figure file that typeset its content, not its float structure."""
    return [n for n, line in enumerate(text.split('\n'), 1) if line.strip() and not FLOAT_STRUCTURE.match(line)]


def entry_for(node, toc):
    """The PDF outline entry of a heading, by its hyperref name or its title."""
    names = {node['kind'] + '.' + node['number']}
    if node['kind'] == 'chapter':
        names.add('appendix.' + node['number'])
    if node['kind'] == 'section':
        names.add('appendix.' + node['number'])
    matches = [i for i, row in enumerate(toc) if row[3].get('nameddest') in names]
    if not matches:
        matches = [i for i, row in enumerate(toc) if row[1].strip().casefold() == node['title'].strip().casefold()]
    if len(matches) != 1:
        raise ValueError(f"Heading {node['number']} {node['title']!r} is not uniquely in the PDF outline.")
    return matches[0]


def position(document, row, names):
    destination = row[3]
    named = names.get(destination.get('nameddest'))
    if named:
        page = named['page']
        if not 0 <= page < len(document):
            raise ValueError('The heading is outside this PDF.')
        point = pdf.Point(named['to']) * document[page].transformation_matrix
    else:
        page = row[2] - 1
        if not 0 <= page < len(document):
            raise ValueError('The heading is outside this PDF.')
        point = pdf.Point(destination.get('to', (0, 0)))
    return page, max(0, point.y - 4)


def add_interval(intervals, page, top, bottom):
    if bottom - top <= 2:
        return
    merged = []
    for a, b in sorted(intervals.get(page, []) + [(top, bottom)]):
        if merged and a <= merged[-1][1] + 20:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    intervals[page] = merged


def subtract_interval(intervals, page, top, bottom):
    remaining = []
    for a, b in intervals.get(page, []):
        if b <= top or a >= bottom:
            remaining.append((a, b))
            continue
        if top - a > 2:
            remaining.append((a, top))
        if b - bottom > 2:
            remaining.append((bottom, b))
    intervals[page] = remaining


def section_intervals(document, node, nodes, figures, figure_files=lambda name: False):
    """Vertical page intervals {page: [(top, bottom)]} that show a section, with its own floats."""
    toc = figures.toc if figures else document.get_toc(simple=False)
    names = figures.names if figures else document.resolve_names()
    index = entry_for(node, toc)
    start_page, top = position(document, toc[index], names)
    boundary = next((row for row in toc[index + 1:] if row[0] <= toc[index][0] and row[2] > 0), None)
    end_page, bottom = (position(document, boundary, names) if boundary
                        else (len(document) - 1, document[-1].rect.height - 60))
    intervals = {}
    margins = getattr(figures, 'margins', None) or Margins(document)
    for page in range(start_page, end_page + 1):
        body_top, body_bottom = margins.body(document[page])
        add_interval(intervals, page, top if page == start_page else body_top,
                     bottom if page == end_page else body_bottom)
    own = {f for f in node['files'] if figure_files(f)}
    # A float of the next section can precede its heading on the same page: leave it out.
    # This section's own floats belong to it wherever TeX placed them.
    following = None
    if boundary:
        for candidate in nodes:
            try:
                if toc[entry_for(candidate, toc)][3].get('xref') == boundary[3].get('xref'):
                    following = candidate
                    break
            except ValueError:
                continue
    if following and figures:
        for name in set(following['files']) - own:
            if figure_files(name):
                for region in figures.locate(name):
                    subtract_interval(intervals, region['page'], region['clip'][1], region['clip'][3])
    missing = []
    for name in own:
        found = figures.locate(name) if figures else []
        if not found:
            missing.append(name)
        for region in found:
            add_interval(intervals, region['page'], region['clip'][1], region['clip'][3])
    return intervals, missing
