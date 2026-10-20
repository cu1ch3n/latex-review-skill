"""Explain PDF changes from glyph positions, with a pixel comparison for drawings.

Text matching spans every region of a change, including page breaks. Pixel
differences never stand in for text edits: a reflow moves unchanged text.
"""
from collections import defaultdict
import difflib
import unicodedata

import pymupdf as pdf
from PIL import Image, ImageChops

SCALE = 2.0


def normalize(text):
    return unicodedata.normalize('NFKC', text).replace('­', '')


def extract(document, positions):
    """Glyphs and words inside each region; regions are numbered by their index ('pair')."""
    glyphs, words = [], []
    for pair, position in enumerate(positions):
        page, clip = document[position['page']], pdf.Rect(position['clip'])
        for block in page.get_text('rawdict', clip=clip)['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    for char in span['chars']:
                        for value in normalize(char['c']):
                            if not value.isspace():
                                glyphs.append({'text': value, 'rect': list(char['bbox']),
                                               'pair': pair, 'page': position['page']})
        for word in page.get_text('words', clip=clip):
            words.append({'text': normalize(word[4]), 'rect': list(word[:4]), 'pair': pair, 'page': position['page']})
    # Drop discretionary line-end hyphens; keep lexical hyphens inside a line.
    for i in range(len(glyphs) - 2, 0, -1):
        a, b, c = glyphs[i - 1:i + 2]
        if b['text'] == '-' and a['text'].isalpha() and c['text'].islower() and (
                b['pair'] != c['pair'] or c['rect'][1] > b['rect'][1] + 3):
            del glyphs[i]
    return glyphs, words


def merge_rects(rects):
    """Join neighbouring boxes on one line; keep separate rows and distant terms apart."""
    result = []
    for rect in sorted((pdf.Rect(r) for r in rects), key=lambda r: (round(r.y0 / 2), r.x0)):
        for index in range(len(result) - 1, max(-1, len(result) - 13), -1):
            previous = result[index]
            if abs(previous.y0 - rect.y0) < 1.7 and abs(previous.y1 - rect.y1) < 2 and -1 <= rect.x0 - previous.x1 < 4:
                result[index] = previous | rect
                break
        else:
            result.append(rect)
    return [list(r) for r in result]


def marks(glyphs, indices, words, kind):
    by_pair, selected = defaultdict(list), defaultdict(list)
    for i in sorted(set(indices)):
        selected[glyphs[i]['pair']].append(pdf.Rect(glyphs[i]['rect']))
    for pair, rects in selected.items():
        # Highlight whole words, not the letters a replacement happens to share.
        for word in (w for w in words if w['pair'] == pair):
            box = pdf.Rect(word['rect'])
            if any(box.contains((r.tl + r.br) / 2) for r in rects):
                by_pair[pair].append(word['rect'])
        if not by_pair[pair]:
            by_pair[pair] = [list(r) for r in rects]
    return {pair: [{'kind': kind, 'rect': r} for r in merge_rects(rects)] for pair, rects in by_pair.items()}


def joined(words):
    """Word texts, with words hyphenated at a line or page break joined again."""
    result, previous = [], None
    for word in words:
        text = word['text']
        if (previous and result[-1].endswith('-') and result[-1][-2:-1].isalpha() and text[:1].islower()
                and (word['pair'] != previous['pair'] or word['rect'][1] > previous['rect'][3] - 2)):
            result[-1] = result[-1][:-1] + text
        else:
            result.append(text)
        previous = word
    return result


def summarize_words(old, new):
    a, b = joined(old), joined(new)
    result = []
    for tag, i, j, x, y in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag != 'equal':
            left, right = ' '.join(a[i:j]), ' '.join(b[x:y])
            result.append({'old': left[:180], 'new': right[:180], 'truncated': len(left) > 180 or len(right) > 180})
    return result


def text_changes(old_document, new_document, left, right):
    """Glyph-level differences between the old regions `left` and the new regions `right`."""
    a, aw = extract(old_document, left) if left else ([], [])
    b, bw = extract(new_document, right) if right else ([], [])
    matcher = difflib.SequenceMatcher(None, [g['text'] for g in a], [g['text'] for g in b], autojunk=False)
    removed, added, moved_a, moved_b = [], [], [], []
    for tag, i, j, x, y in matcher.get_opcodes():
        if tag != 'equal':
            removed.extend(range(i, j))
            added.extend(range(x, y))
            continue
        for u, v in zip(range(i, j), range(x, y)):
            old, new = a[u], b[v]
            p, q = left[old['pair']], right[new['pair']]
            r, s = pdf.Rect(old['rect']), pdf.Rect(new['rect'])
            if old['pair'] != new['pair'] or any(abs(delta) > .65 for delta in (
                    r.x0 - p['clip'][0] - s.x0 + q['clip'][0], r.y0 - p['clip'][1] - s.y0 + q['clip'][1],
                    r.width - s.width, r.height - s.height)):
                moved_a.append(u)
                moved_b.append(v)
    changed = bool(removed or added)
    return {'old_marks': marks(a, removed if changed else moved_a, aw, 'removed' if changed else 'moved'),
            'new_marks': marks(b, added if changed else moved_b, bw, 'added' if changed else 'moved'),
            'text_changed': changed, 'moved': bool(moved_a or moved_b), 'text_available': bool(a or b),
            'edits': summarize_words(aw, bw) if changed else []}


def crop_image(document, position):
    """A raster of one region, for pixel comparison."""
    clip = pdf.Rect(position['clip'])
    pixmap = document[position['page']].get_pixmap(matrix=pdf.Matrix(SCALE, SCALE), clip=clip, alpha=False)
    return Image.frombytes('RGB', (pixmap.width, pixmap.height), pixmap.samples)


def pixel_difference(old_image, new_image):
    """How many pixels differ between two crops, aligned at their top-left corners."""
    width = max(old_image.width if old_image else 0, new_image.width if new_image else 0)
    height = max(old_image.height if old_image else 0, new_image.height if new_image else 0)
    canvases = []
    for source in (old_image, new_image):
        canvas = Image.new('RGB', (width, height), 'white')
        if source is not None:
            canvas.paste(source.convert('RGB'), (0, 0))
        canvases.append(canvas)
    mask = ImageChops.difference(*canvases).convert('L').point(lambda x: 255 if x >= 24 else 0)
    return {'changed_pixels': mask.histogram()[255], 'bounds': mask.getbbox()}
