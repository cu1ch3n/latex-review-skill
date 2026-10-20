"""Show changes inside their section: unchanged context strips with before/after strips in place."""
import copy
import difflib
from itertools import zip_longest

import pymupdf as pdf

from .locate import section_intervals
from .pdfdiff import text_changes

MARGIN = 360  # Points of unchanged context kept around each change; the rest is folded.
RUN_GAP = 3    # Unchanged PDF lines that may separate edits shown as one region.
COLORS = {'old': (.78, .16, .22), 'new': (.12, .55, .32)}


def text_rows(document, intervals):
    rows = []
    for page, spans in sorted(intervals.items()):
        for block in document[page].get_text('dict')['blocks']:
            for line in block.get('lines', []):
                rect = pdf.Rect(line['bbox'])
                text = ''.join(s['text'] for s in line['spans']).strip()
                if text and any(a <= (rect.y0 + rect.y1) / 2 <= b for a, b in spans):
                    rows.append({'page': page, 'rect': rect, 'text': ' '.join(text.split())})
    return sorted(rows, key=lambda r: (r['page'], r['rect'].y0, r['rect'].x0))


def balanced_text_pairs(card, old_rows, new_rows, opcodes, old_document, document):
    """Use matching whole PDF lines as boundaries on both sides of a reflow.

    Cropping highlighted lines independently can drop unchanged words that
    wrapped onto another line; equal lines delimit the replaced region.
    """
    def touches(rows, side):
        for pair in card['pairs']:
            position = pair.get(side)
            if not position:
                continue
            marks = pair.get('before_marks' if side == 'old' else 'after_marks') or []
            rects = [pdf.Rect(m['rect']) for m in marks] or [pdf.Rect(position['clip'])]
            if any(row['page'] == position['page'] and any(row['rect'].intersects(r) for r in rects) for row in rows):
                return True
        return False

    selected = [(i, j, x, y) for tag, i, j, x, y in opcodes if tag != 'equal' and
                (touches(old_rows[i:j], 'old') or touches(new_rows[x:y], 'new'))]
    # Nearby edits form one region; a long unchanged stretch between them, such as a
    # float at the top of the next page, separates regions instead of being repeated.
    runs = []
    for i, j, x, y in selected:
        if runs and i - runs[-1][1] <= RUN_GAP and x - runs[-1][3] <= RUN_GAP:
            runs[-1] = (runs[-1][0], j, runs[-1][2], y)
        else:
            runs.append((i, j, x, y))
    if not runs or all(x == y for _, _, x, y in runs):
        return None  # A pure deletion keeps its standalone crop.

    def positions(rows, doc):
        result = []
        for row in rows:
            rect = row['rect']
            if result and result[-1]['page'] == row['page']:
                result[-1]['clip'][3] = max(result[-1]['clip'][3], rect.y1 + 2)
            else:
                result.append({'page': row['page'], 'clip': [0, rect.y0 - 2, doc[row['page']].rect.width, rect.y1 + 2]})
        return result

    left, right, links = [], [], []
    for i, j, x, y in runs:
        # A word hyphenated just before the region continues inside it: the line before
        # joins the comparison, unmarked and not shown, so the fragment is not reported.
        for previous_page in (False, True):
            a, b = line_before(old_rows, i, previous_page), line_before(new_rows, x, previous_page)
            if any(k is not None and rows[k]['text'].endswith('-') for rows, k in ((old_rows, a), (new_rows, b))):
                left += positions(old_rows[a:a + 1] if a is not None else [], old_document)
                right += positions(new_rows[b:b + 1] if b is not None else [], document)
                break
        old, new = positions(old_rows[i:j], old_document), positions(new_rows[x:y], document)
        links += zip_longest(range(len(left), len(left) + len(old)), range(len(right), len(right) + len(new)))
        left += old
        right += new
    # One comparison over all regions keeps words hyphenated across a region boundary intact.
    marks = text_changes(old_document, document, left, right)
    return [{'old': None if a is None else left[a], 'new': None if b is None else right[b],
             'before_marks': [] if a is None else marks['old_marks'].get(a, []),
             'after_marks': [] if b is None else marks['new_marks'].get(b, [])} for a, b in links]


def line_before(rows, index, previous_page=False):
    """The line before rows[index]; with `previous_page`, the last line of the page before,
    which precedes it in the text when floats open the page."""
    if not index:
        return None
    if not previous_page:
        return index - 1
    if index >= len(rows):
        return None  # The region starts after the last line: no page to look before.
    k = index - 1
    while k >= 0 and rows[k]['page'] == rows[index]['page']:
        k -= 1
    return k if k >= 0 else None


def changed_line_bounds(document, position, marks):
    rectangles = [pdf.Rect(mark['rect']) for mark in marks]
    lines = [pdf.Rect(line['bbox']) for block in document[position['page']].get_text('dict')['blocks']
             for line in block.get('lines', []) if any(pdf.Rect(line['bbox']).intersects(r) for r in rectangles)]
    if not lines:
        return position['clip'][1], position['clip'][3]
    return (max(position['clip'][1], min(r.y0 for r in lines) - 2),
            min(position['clip'][3], max(r.y1 for r in lines) + 2))


def snap(document, page_number, top, bottom, limit=10):
    """Move crop edges that cut through ink outwards to the nearest blank pixel row.

    Text boxes miss parts of some glyphs, such as the lower half of a large brace.
    """
    page = document[page_number]

    def ink(y0, y1):
        clip = pdf.Rect(0, max(0, y0), page.rect.width, min(page.rect.height, y1))
        if clip.height < 1:
            return clip, []
        pixmap = page.get_pixmap(matrix=pdf.Matrix(2, 2), clip=clip, colorspace=pdf.csGRAY, alpha=False)
        samples, stride = pixmap.samples, pixmap.stride
        return clip, [min(samples[r * stride:r * stride + pixmap.width]) < 200 for r in range(pixmap.height)]

    clip, rows = ink(bottom, bottom + limit)
    for index, filled in enumerate(rows):
        if not filled:
            bottom = clip.y0 + index * clip.height / len(rows)
            break
    else:
        bottom = clip.y1 if rows else bottom
    clip, rows = ink(top - limit, top)
    for index in range(len(rows) - 1, -1, -1):
        if not rows[index]:
            top = clip.y0 + (index + 1) * clip.height / len(rows)
            break
    else:
        top = clip.y0 if rows else top
    return top, bottom


def grouped_regions(cards, intervals, snapped=None):
    """Merge overlapping change regions so no part of the new text appears twice."""
    result = {}
    for index, card in cards:
        for pair_index, pair in enumerate(card['pairs']):
            position = pair.get('new')
            if not position:
                continue
            page = position['page']
            for start, end in intervals.get(page, []):
                top, bottom = max(start, position['clip'][1]), min(end, position['clip'][3])
                if bottom > top and snapped:
                    top, bottom = snapped(page, top, bottom)
                if bottom > top:
                    result.setdefault(page, []).append({'top': top, 'bottom': bottom, 'pairs': [(index, pair_index)]})
    for page, regions in result.items():
        merged = []
        for region in sorted(regions, key=lambda r: r['top']):
            if merged and region['top'] <= merged[-1]['bottom']:
                merged[-1]['bottom'] = max(merged[-1]['bottom'], region['bottom'])
                merged[-1]['pairs'].extend(region['pairs'])
            else:
                merged.append(region)
        result[page] = merged
    return result


def context_plan(intervals, groups):
    """The section as a sequence of context and change pieces, in reading order."""
    plan = []
    for page, spans in sorted(intervals.items()):
        for start, end in spans:
            cursor = start
            for group in groups.get(page, []):
                top, bottom = max(start, group['top']), min(end, group['bottom'])
                if bottom <= top:
                    continue
                if top > cursor:
                    plan.append({'kind': 'context', 'page': page, 'top': cursor, 'bottom': top})
                plan.append({'kind': 'change', 'page': page, 'top': top, 'bottom': bottom, 'pairs': group['pairs']})
                cursor = bottom
            if cursor < end:
                plan.append({'kind': 'context', 'page': page, 'top': cursor, 'bottom': end})
    return plan


def fold_context(plan, margin=MARGIN):
    """Keep `margin` points of context around changes; replace longer stretches by a gap."""
    offsets, total = [], 0
    for piece in plan:
        offsets.append(total)
        total += piece['bottom'] - piece['top']
    changes = [(offsets[i], offsets[i] + p['bottom'] - p['top']) for i, p in enumerate(plan) if p['kind'] == 'change']
    if not changes:
        return plan
    result = []
    for piece, offset in zip(plan, offsets):
        if piece['kind'] == 'change':
            result.append(piece)
            continue
        height = piece['bottom'] - piece['top']
        keep = []
        for a, b in changes:
            low, high = max(0, a - margin - offset), min(height, b + margin - offset)
            if high > low:
                keep.append((low, high))
        keep.sort()
        cursor = 0
        for low, high in keep:
            low = max(low, cursor)
            if high <= low:
                continue
            if low > cursor:
                result.append({'kind': 'gap'})
            result.append({**piece, 'top': piece['top'] + low, 'bottom': piece['top'] + high})
            cursor = high
        if cursor < height:
            result.append({'kind': 'gap'})
    folded = []
    for piece in result:
        if piece['kind'] == 'gap' and folded and folded[-1]['kind'] == 'gap':
            continue
        folded.append(piece)
    return folded


def svg_strip(document, page_number, top, bottom, marks, out, name, side=''):
    """A full-width horizontal slice of a page as vector SVG, optionally with change marks."""
    source = document[page_number]
    top, bottom = max(0, top), min(source.rect.height, bottom)
    if bottom - top < .1:
        return None
    clip = pdf.Rect(0, top, source.rect.width, bottom)
    clean_name = name + '-clean.svg' if marks else name + '.svg'
    with pdf.open() as fragment:
        target = fragment.new_page(width=clip.width, height=clip.height)
        target.show_pdf_page(target.rect, document, page_number, clip=clip)
        if marks:
            (out / clean_name).write_text(target.get_svg_image(text_as_path=True), encoding='utf-8')
            color = COLORS.get(side, COLORS['new'])
            for mark in marks:
                rectangle = pdf.Rect(mark['rect']) & clip
                if rectangle.is_empty:
                    continue
                rectangle = pdf.Rect(rectangle.x0, rectangle.y0 - top, rectangle.x1, rectangle.y1 - top)
                target.draw_rect(rectangle, color=None, fill=color, fill_opacity=.18, overlay=True)
                if side == 'old':
                    y = rectangle.y0 + rectangle.height * .55
                    target.draw_line((rectangle.x0, y), (rectangle.x1, y), color=color, width=.45)
        (out / (name + '.svg')).write_text(target.get_svg_image(text_as_path=True), encoding='utf-8')
    return {'src': name + '.svg', 'clean': clean_name, 'width': round(clip.width, 2),
            'height': round(clip.height, 2), 'page': page_number + 1, 'label': source.get_label() or str(page_number + 1)}


class Strips:
    """Writes strips with unique names into the round folder."""

    def __init__(self, out):
        self.out, self.count = out, 0

    def __call__(self, document, page, top, bottom, marks=(), side=''):
        self.count += 1
        return svg_strip(document, page, top, bottom, list(marks), self.out, f's{self.count:04}', side)


def render_section(old, new, node, cards, strips, figure_files):
    """Blocks showing one section with its changes in place, and the cards that could not be placed."""
    intervals, missing = section_intervals(new.document, node, new.outline, new.figures, figure_files)
    cards = copy.deepcopy(cards)
    old_rows = new_rows = opcodes = []
    if any(card['comparison'] == 'text' for _, card in cards):
        old_node = next((n for n in old.outline if n['id'] == node['id']), None)
        if old_node:
            try:
                old_intervals, _ = section_intervals(old.document, old_node, old.outline, old.figures, figure_files)
                old_rows, new_rows = text_rows(old.document, old_intervals), text_rows(new.document, intervals)
                opcodes = difflib.SequenceMatcher(None, [r['text'] for r in old_rows], [r['text'] for r in new_rows],
                                                  autojunk=False).get_opcodes()
            except ValueError:
                pass
    for _, card in cards:
        if card['comparison'] != 'text' or figure_files(card['file']):
            continue
        if opcodes:
            balanced = balanced_text_pairs(card, old_rows, new_rows, opcodes, old.document, new.document)
            if balanced:
                card['pairs'] = balanced
                continue
        for pair in card['pairs']:
            if pair.get('old') and pair.get('new') and pair.get('before_marks') and pair.get('after_marks'):
                # Unchanged headings and neighbouring paragraphs stay in the context,
                # instead of being repeated on both sides of a text edit.
                for side, document, marks in (('old', old.document, pair['before_marks']),
                                              ('new', new.document, pair['after_marks'])):
                    top, bottom = changed_line_bounds(document, pair[side], marks)
                    pair[side]['clip'][1], pair[side]['clip'][3] = top, bottom
    plan = fold_context(context_plan(intervals, grouped_regions(
        cards, intervals, lambda page, top, bottom: snap(new.document, page, top, bottom))))
    by_index = dict(cards)
    blocks, located = [], set()
    for piece in plan:
        if piece['kind'] == 'gap':
            blocks.append({'kind': 'gap'})
            continue
        if piece['kind'] == 'context':
            image = strips(new.document, piece['page'], piece['top'], piece['bottom'])
            if image:
                blocks.append({'kind': 'context', 'image': image})
            continue
        indices = sorted({i for i, _ in piece['pairs']})
        located.update(indices)
        pairs = [by_index[i]['pairs'][j] for i, j in piece['pairs']]
        identical = all(by_index[i]['comparison'] == 'identical' for i in indices)
        regions = []
        if not identical:
            for pair in pairs:
                position = pair.get('old')
                if position:
                    regions.append({'page': position['page'], 'top': position['clip'][1],
                                    'bottom': position['clip'][3], 'marks': pair.get('before_marks', [])})
        merged = []
        for region in sorted(regions, key=lambda r: (r['page'], r['top'])):
            if merged and region['page'] == merged[-1]['page'] and region['top'] <= merged[-1]['bottom']:
                merged[-1]['bottom'] = max(merged[-1]['bottom'], region['bottom'])
                merged[-1]['marks'].extend(region['marks'])
            else:
                merged.append({**region, 'marks': list(region['marks'])})
        before = [strips(old.document, r['page'], *snap(old.document, r['page'], r['top'], r['bottom']), r['marks'], 'old')
                  for r in merged]
        after = strips(new.document, piece['page'], piece['top'], piece['bottom'],
                       [m for pair in pairs for m in pair.get('after_marks', [])], 'new')
        edited = any(mark['kind'] != 'moved' for pair in pairs
                     for mark in pair.get('before_marks', []) + pair.get('after_marks', []))
        blocks.append({'kind': 'change', 'cards': indices, 'identical': identical,
                       'reflow': not identical and not edited and all(by_index[i]['comparison'] == 'text' for i in indices),
                       'before': [b for b in before if b], 'after': after})
    unlocated = [i for i, _ in cards if i not in located]
    return blocks, unlocated, len(missing)
