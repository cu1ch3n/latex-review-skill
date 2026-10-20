"""Render one review round: locate every change in both PDFs, classify it, and draw it in context."""
import json
from pathlib import Path
import re

from ..git import within
from ..outline import deepest_node
from .inline import Strips, render_section, snap
from .locate import Build
from .pdfdiff import crop_image, pixel_difference, text_changes


def typeset_words(text):
    """Source as TeX reads it for typesetting: no comments, any run of spaces is one space."""
    text = re.sub(r'(?<!\\)%[^\n]*', '', text)
    return [' '.join(paragraph.split()) for paragraph in re.split(r'\n[ \t]*\n', text) if paragraph.strip()]


def classify(old, new, unit, old_locator, new_locator, body, figure_files):
    """PDF regions of a change on both sides, its glyph marks and what kind of difference it is."""
    name = unit['file']
    if unit['kind'] != 'binary' and not unit['truncated'] and unit['status'] == 'modified' \
            and typeset_words(unit['old_text']) == typeset_words(unit['new_text']):
        return {'pairs': [], 'comparison': 'identical'}  # Only comments or line breaks changed.
    located = name.endswith('.tex') and unit['kind'] != 'binary' and name in body
    whole = unit['whole_file'] or figure_files(name)
    left = old_locator.locate(name, unit['old_start'], unit['old_end'], whole) if located and unit['status'] != 'added' else []
    right = new_locator.locate(name, unit['new_start'], unit['new_end'], whole) if located and unit['status'] != 'deleted' else []
    analysis = text_changes(old.document, new.document, left, right)
    pairs, pixels = [], 0
    for j in range(max(len(left), len(right))):
        l, r = left[j] if j < len(left) else None, right[j] if j < len(right) else None
        pairs.append({'old': l, 'new': r, 'before_marks': analysis['old_marks'].get(j, []),
                      'after_marks': analysis['new_marks'].get(j, [])})
        if not analysis['text_changed']:
            pixels += pixel_difference(crop_image(old.document, l) if l else None,
                                       crop_image(new.document, r) if r else None)['changed_pixels']
    moved = any(l['page'] != r['page'] or l['label'] != r['label'] or
                any(abs(a - b) > 1 for a, b in zip(l['clip'], r['clip'])) for l, r in zip(left, right))
    kind = ('unmapped' if not pairs else 'text' if analysis['text_changed'] else 'layout' if pixels else
            'position' if moved else 'identical')
    return {'pairs': pairs, 'comparison': kind}


def loose_block(card, strips, old, new):
    """A change shown on its own, outside a section view."""
    before, after = [], []
    for pair in card['pairs']:
        for side, build, images, marks in (('old', old, before, 'before_marks'), ('new', new, after, 'after_marks')):
            if pair.get(side):
                page, clip = pair[side]['page'], pair[side]['clip']
                images.append(strips(build.document, page, *snap(build.document, page, clip[1], clip[3]),
                                     pair[marks], side))
    return {'units': [card['id']], 'identical': card['comparison'] == 'identical',
            'before': [b for b in before if b], 'after': [a for a in after if a]}


def render_round(request, out):
    figures = tuple(request['figures'])
    figure_files = lambda name: within(name, figures)
    old = Build(request['old'], request['main'], request['source_dir'])
    new = Build(request['new'], request['main'], request['source_dir'])
    try:
        body = {f for build in (old, new) for node in build.outline for f in node['files']}
        old_locator, new_locator = old.locator, new.locator
        cards, units = [], {}
        for unit in request['units']:
            card = {'id': unit['id'], 'file': unit['file'],
                    **classify(old, new, unit, old_locator, new_locator, body, figure_files)}
            outline, start, end = ((old.outline, unit['old_start'], unit['old_end']) if unit['status'] == 'deleted'
                                   else (new.outline, unit['new_start'], unit['new_end']))
            node = deepest_node(outline, unit['file'], start, end) if card['pairs'] else None
            card['context_node'] = node['id'] if node else None
            cards.append(card)
            pages = sorted({p['new' if p.get('new') else 'old']['label'] for p in card['pairs']}, key=str)
            units[unit['id']] = {'visual': card['comparison'], 'pages': pages,
                                 'section': node and f"{node['number']} {node['title']}".strip()}
        strips = Strips(out)
        sections, loose = [], []
        order = {n['id']: i for i, n in enumerate(new.outline)}
        nodes = sorted({c['context_node'] for c in cards if c['context_node'] in order}, key=order.get)
        placed = set()
        for identity in nodes:
            node = new.outline[order[identity]]
            members = [(i, c) for i, c in enumerate(cards) if c['context_node'] == identity]
            try:
                blocks, unlocated, _ = render_section(old, new, node, members, strips, figure_files)
            except ValueError:
                continue  # Not in the PDF outline (e.g. no hyperref); shown as loose changes below.
            for block in blocks:
                if block['kind'] == 'change':
                    block['units'] = [cards[i]['id'] for i in block.pop('cards')]
            if not any(b['kind'] == 'change' for b in blocks):
                continue
            sections.append({'node': identity, 'number': node['number'], 'title': node['title'], 'blocks': blocks})
            placed.update(i for i, _ in members if i not in unlocated)
        for index, card in enumerate(cards):
            if index not in placed:
                loose.append(loose_block(card, strips, old, new))
        result = {'units': units, 'sections': sections, 'loose': loose}
        (out / 'round.json').write_text(json.dumps(result, ensure_ascii=False))
        return result
    finally:
        old.close()
        new.close()


def main(path):
    path = Path(path)
    render_round(json.loads(path.read_text()), path.parent)
