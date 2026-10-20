"""PDF rendering. Run with the renderer's pinned packages: make test does this through uv."""
import difflib
from pathlib import Path
import tempfile
import unittest
from xml.etree import ElementTree

from helpers import ROOT

RENDERER = ROOT / 'latex_review' / 'render'  # helpers puts the package on the import path

try:
    import pymupdf as pdf
    from PIL import Image
    from latex_review.render.inline import (balanced_text_pairs, changed_line_bounds, context_plan, fold_context,
                                            grouped_regions, snap, svg_strip, text_rows)
    from latex_review.render.locate import Margins, content_lines, entry_for, position, section_intervals
    from latex_review.render.pdfdiff import crop_image, pixel_difference, text_changes
    from latex_review.render.round import typeset_words
except ImportError:
    pdf = None


@unittest.skipUnless(pdf, 'needs pymupdf and pillow')
class TextChangeTests(unittest.TestCase):
    def setUp(self):
        self.documents = []

    def tearDown(self):
        for document in self.documents:
            document.close()

    def document(self, pages):
        document = pdf.open()
        for text in pages:
            document.new_page(width=600, height=200).insert_text((30, 50), text, fontsize=12)
        self.documents.append(document)
        return document

    def positions(self, document):
        return [{'page': i, 'clip': [20, 20, 580, 180], 'label': str(i + 1)} for i in range(len(document))]

    def compare(self, old, new):
        return text_changes(old, new, self.positions(old), self.positions(new))

    def test_replacement_marks_only_the_affected_words(self):
        old, new = self.document(['The extensions add the following types.']), self.document(['We add the following types.'])
        diff = self.compare(old, new)
        self.assertEqual(diff['edits'], [{'old': 'The extensions', 'new': 'We', 'truncated': False}])
        old_end, new_end = old[0].search_for('extensions')[0].x1, new[0].search_for('We')[0].x1
        self.assertTrue(all(m['rect'][2] <= old_end + .1 for m in diff['old_marks'][0]))
        self.assertTrue(all(m['rect'][2] <= new_end + .1 for m in diff['new_marks'][0]))

    def test_reflow_is_movement_not_new_text(self):
        old = self.document(['The function accepts an argument and returns a result.'])
        new = self.document(['The function accepts an argument\nand returns a result.'])
        diff = self.compare(old, new)
        self.assertFalse(diff['text_changed'])
        self.assertTrue(diff['moved'])
        self.assertTrue(all(m['kind'] == 'moved' for m in diff['new_marks'][0]))
        diff = self.compare(self.document(['alpha beta gamma delta']), self.document(['alpha beta', 'gamma delta']))
        self.assertFalse(diff['text_changed'])
        self.assertIn(1, diff['new_marks'])

    def test_hyphenation_and_math(self):
        self.assertFalse(self.compare(self.document(['A func-\ntion returns.']), self.document(['A function returns.']))['text_changed'])
        self.assertTrue(self.compare(self.document(['order-irrelevant']), self.document(['orderirrelevant']))['text_changed'])
        diff = self.compare(self.document(['x + y']), self.document(['x - y']))
        self.assertEqual((diff['edits'][0]['old'], diff['edits'][0]['new']), ('+', '-'))

    def test_pixels_catch_drawings_and_colour(self):
        old, new = self.document(['']), self.document([''])
        old[0].draw_line((50, 60), (170, 60), width=2)
        new[0].draw_line((50, 75), (170, 75), width=2)
        self.assertFalse(self.compare(old, new)['text_available'])
        self.assertGreater(pixel_difference(crop_image(old, self.positions(old)[0]),
                                            crop_image(new, self.positions(new)[0]))['changed_pixels'], 100)
        same = crop_image(old, self.positions(old)[0])
        self.assertEqual(pixel_difference(same, same), {'changed_pixels': 0, 'bounds': None})
        red, green = Image.new('RGB', (20, 20), (255, 0, 0)), Image.new('RGB', (20, 20), (0, 130, 0))
        self.assertGreater(pixel_difference(red, green)['changed_pixels'], 0)

    def test_one_side_may_be_empty(self):
        document = self.document(['New paragraph.'])
        added = text_changes(None, document, [], self.positions(document))
        self.assertTrue(added['text_changed'] and added['new_marks'] and not added['old_marks'])
        self.assertGreater(pixel_difference(None, crop_image(document, self.positions(document)[0]))['changed_pixels'], 0)


    def test_comment_and_line_break_edits_cannot_change_the_pdf(self):
        self.assertEqual(typeset_words('binds $x$, checks $e$.\n'), typeset_words('binds $x$,\n  checks $e$.\n'))
        self.assertEqual(typeset_words('a % old note\nb\n'), typeset_words('a % new note\nb\n'))
        self.assertNotEqual(typeset_words('100\\% sure\n'), typeset_words('100\\% certain\n'))
        self.assertNotEqual(typeset_words('one\n\ntwo\n'), typeset_words('one two\n'))

@unittest.skipUnless(pdf, 'needs pymupdf and pillow')
class InlineTests(unittest.TestCase):
    def card(self, page, top, bottom):
        return {'pairs': [{'new': {'page': page, 'clip': [0, top, 400, bottom]}}]}

    def test_overlapping_changes_neither_repeat_nor_drop_context(self):
        intervals = {0: [(50, 400)]}
        plan = context_plan(intervals, grouped_regions([(0, self.card(0, 100, 160)), (1, self.card(0, 140, 220))], intervals))
        self.assertEqual([(p['kind'], p['top'], p['bottom']) for p in plan],
                         [('context', 50, 100), ('change', 100, 220), ('context', 220, 400)])
        self.assertEqual(plan[1]['pairs'], [(0, 0), (1, 0)])

    def test_changes_are_clipped_to_the_section(self):
        intervals = {0: [(40, 100), (200, 300)], 1: [(75, 120)]}
        cards = [(0, self.card(0, 90, 220)), (1, self.card(1, 100, 180)), (2, self.card(2, 50, 100))]
        plan = context_plan(intervals, grouped_regions(cards, intervals))
        for piece in plan:
            self.assertTrue(any(a <= piece['top'] < piece['bottom'] <= b for a, b in intervals[piece['page']]))
        self.assertFalse(any((2, 0) in p.get('pairs', []) for p in plan))
        deletion = grouped_regions([(0, {'pairs': [{'old': {'page': 0, 'clip': [0, 40, 400, 80]}, 'new': None}]})], {1: [(40, 300)]})
        self.assertEqual(deletion, {})

    def test_long_unchanged_stretches_fold(self):
        plan = [{'kind': 'context', 'page': 0, 'top': 0, 'bottom': 800}, {'kind': 'change', 'page': 0, 'top': 800, 'bottom': 850},
                {'kind': 'context', 'page': 0, 'top': 850, 'bottom': 900}, {'kind': 'context', 'page': 1, 'top': 0, 'bottom': 900}]
        folded = fold_context(plan, margin=100)
        self.assertEqual([(p['kind'], p.get('page'), p.get('top'), p.get('bottom')) for p in folded],
                         [('gap', None, None, None), ('context', 0, 700, 800), ('change', 0, 800, 850),
                          ('context', 0, 850, 900), ('context', 1, 0, 50), ('gap', None, None, None)])
        self.assertEqual(fold_context(plan[:1]), plan[:1])

    def test_text_edit_keeps_the_unchanged_heading_outside(self):
        with pdf.open() as document:
            page = document.new_page(width=400, height=600)
            page.insert_text((40, 70), 'Section heading')
            page.insert_text((40, 110), 'We changed this word.')
            top, bottom = changed_line_bounds(document, {'page': 0, 'clip': [0, 40, 400, 140]},
                                              [{'rect': list(page.search_for('changed')[0])}])
            text = page.get_text(clip=pdf.Rect(0, top, 400, bottom))
            self.assertIn('We changed this word.', text)
            self.assertNotIn('Section heading', text)

    def test_strips_are_vector_svg_with_a_clean_copy(self):
        with tempfile.TemporaryDirectory() as temporary, pdf.open() as document:
            page = document.new_page(width=400, height=600)
            page.insert_text((40, 110), 'A changed word')
            original = page.get_contents(), page.get_text()
            result = svg_strip(document, 0, 80, 140, [{'rect': list(page.search_for('changed')[0])}],
                               Path(temporary), 's0001', 'old')
            namespace = '{http://www.w3.org/2000/svg}'
            marked = ElementTree.fromstring((Path(temporary) / result['src']).read_text())
            clean = ElementTree.fromstring((Path(temporary) / result['clean']).read_text())
            self.assertGreater(len(marked.findall(f'.//{namespace}path')), len(clean.findall(f'.//{namespace}path')))
            self.assertFalse(marked.findall(f'.//{namespace}image'))
            self.assertEqual((result['width'], result['height'], result['page']), (400, 60, 1))
            self.assertEqual((page.get_contents(), page.get_text()), original)

    def test_reflowed_text_keeps_whole_lines_on_both_sides(self):
        with pdf.open() as old, pdf.open() as new:
            before, after = old.new_page(width=500, height=600), new.new_page(width=500, height=600)
            left = ['A rope stores text in a tree. Each node records', 'the length of its left subtree.', 'Figure 1 shows a rope']
            right = ['A rope stores text in the leaves of a tree.', 'Each node records the length of its left',
                     'subtree.', 'Figure 1 shows a rope']
            for page, rows in [(before, left), (after, right)]:
                for i, row in enumerate(rows):
                    page.insert_text((40, 100 + i * 22), row)
            a, b = text_rows(old, {0: [(50, 300)]}), text_rows(new, {0: [(50, 300)]})
            opcodes = difflib.SequenceMatcher(None, [r['text'] for r in a], [r['text'] for r in b], autojunk=False).get_opcodes()
            card = {'pairs': [{'old': {'page': 0, 'clip': [0, 80, 500, 130]}, 'new': {'page': 0, 'clip': [0, 80, 500, 180]},
                               'before_marks': [{'rect': list(before.search_for('in a tree')[0])}],
                               'after_marks': [{'rect': list(after.search_for(w)[0])} for w in ['leaves', 'Figure']]}]}
            pair = balanced_text_pairs(card, a, b, opcodes, old, new)[0]
            old_text = ' '.join(before.get_text(clip=pdf.Rect(pair['old']['clip'])).split())
            new_text = ' '.join(after.get_text(clip=pdf.Rect(pair['new']['clip'])).split())
            self.assertIn('the length of its left subtree.', old_text)
            self.assertIn('the length of its left subtree.', new_text)
            self.assertNotIn('Figure', old_text + new_text)

    def test_a_float_between_edits_is_context_and_hyphenated_words_stay_whole(self):
        with pdf.open() as old, pdf.open() as new:
            for document, first, second in [(old, 'Old text to the surrounding', 'context. Instead we work.'),
                                            (new, 'New text to the sur-', 'rounding context. Instead we work.')]:
                document.new_page(width=500, height=600).insert_text((40, 100), first)
                page = document.new_page(width=500, height=600)
                for i in range(6):
                    page.insert_text((40, 60 + i * 14), f'Figure row {i} with unchanged rules')
                page.insert_text((40, 200), second)
            a, b = text_rows(old, {0: [(50, 300)], 1: [(40, 300)]}), text_rows(new, {0: [(50, 300)], 1: [(40, 300)]})
            opcodes = difflib.SequenceMatcher(None, [r['text'] for r in a], [r['text'] for r in b], autojunk=False).get_opcodes()
            card = lambda pages: {'pairs': [{'old': {'page': page, 'clip': [0, 40, 500, 300]},
                                             'new': {'page': page, 'clip': [0, 40, 500, 300]},
                                             'before_marks': [], 'after_marks': []} for page in pages]}
            pairs = balanced_text_pairs(card((0, 1)), a, b, opcodes, old, new)
            self.assertEqual([(p['old']['page'], p['new']['page']) for p in pairs], [(0, 0), (1, 1)])
            for pair in pairs:
                self.assertNotIn('Figure row', new[pair['new']['page']].get_text(clip=pdf.Rect(pair['new']['clip'])))
            # The change on the second page alone: its first word was hyphenated on the page before.
            pairs = balanced_text_pairs(card((1,)), a, b, opcodes, old, new)
            self.assertEqual([(p['old']['page'], p['new']['page']) for p in pairs], [(1, 1)])
            self.assertEqual(pairs[0]['after_marks'], [])

    def test_text_added_after_the_last_line_of_a_section(self):
        with pdf.open() as old, pdf.open() as new:
            lines = ['The worklist holds the pending goals.', 'Each step removes one of them.']
            for document, rows in [(old, lines), (new, lines + ['A new paragraph closes the section.'])]:
                page = document.new_page(width=500, height=600)
                for i, row in enumerate(rows):
                    page.insert_text((40, 100 + i * 22), row)
            a, b = text_rows(old, {0: [(50, 300)]}), text_rows(new, {0: [(50, 300)]})
            opcodes = difflib.SequenceMatcher(None, [r['text'] for r in a], [r['text'] for r in b], autojunk=False).get_opcodes()
            card = {'pairs': [{'old': {'page': 0, 'clip': [0, 80, 500, 150]}, 'new': {'page': 0, 'clip': [0, 130, 500, 170]},
                               'before_marks': [], 'after_marks': [{'rect': list(new[0].search_for('closes')[0])}]}]}
            pairs = balanced_text_pairs(card, a, b, opcodes, old, new)
            self.assertEqual([p['old'] for p in pairs], [None])
            self.assertIn('closes the section', new[0].get_text(clip=pdf.Rect(pairs[0]['new']['clip'])))


    def test_crops_never_cut_through_ink(self):
        with pdf.open() as document:
            page = document.new_page(width=400, height=600)
            page.draw_rect(pdf.Rect(40, 115, 200, 156), color=None, fill=(0, 0, 0))
            top, bottom = snap(document, 0, 120, 150)
            self.assertTrue(110 < top <= 115 and 156 <= bottom < 160, (top, bottom))
            page.draw_rect(pdf.Rect(250, 300, 260, 500), color=None, fill=(0, 0, 0))
            self.assertEqual(snap(document, 0, 350, 450), (340, 460))  # Never more than 10pt outwards.
            self.assertEqual(snap(document, 0, 520, 560), (520, 560))

    def test_figure_files_are_located_by_their_content_lines(self):
        text = '% note\n\\begin{figure}[t]\n  \\centering\n  \\fbox{a}\n  \\includegraphics{b}\n  \\caption{C}\n  \\label{fig:c}\n\\end{figure}\n'
        self.assertEqual(content_lines(text), [4, 5])

class Figures:
    """A figure locator stand-in: floats by file name."""

    def __init__(self, document, regions):
        self.toc, self.names, self.regions = document.get_toc(simple=False), document.resolve_names(), regions

    def locate(self, name, *_):
        return self.regions.get(name, [])


@unittest.skipUnless(pdf, 'needs pymupdf and pillow')
class SectionTests(unittest.TestCase):
    def test_headings_are_found_by_hyperref_name_then_title(self):
        toc = [[3, 'Results', 1, {'nameddest': 'subsection.2.1.2'}], [3, 'Results', 3, {'nameddest': 'subsection.5.3.1'}]]
        node = {'kind': 'subsection', 'number': '5.3.1', 'title': 'Results'}
        self.assertEqual(entry_for(node, toc), 1)
        with self.assertRaises(ValueError):
            entry_for({**node, 'number': '4.1.1'}, toc)
        with pdf.open() as document:
            document.new_page(width=400, height=600)
            page, y = position(document, [2, 'S', 1, {'nameddest': 'section.1.1'}], {'section.1.1': {'page': 0, 'to': (20, 500)}})
            self.assertEqual(page, 0)
            self.assertAlmostEqual(y, 96)

    def test_sections_own_their_floats_and_stop_at_the_next_sibling(self):
        with pdf.open() as document:
            for _ in range(3):
                document.new_page(width=400, height=600)
            document.set_toc([[1, 'Chapter', 1], [2, 'First', 1, 120], [2, 'Second', 2, 300], [2, 'Third', 3, 120]])
            first = {'kind': 'section', 'number': '1.1', 'title': 'First', 'files': ['figures/first.tex']}
            second = {'kind': 'section', 'number': '1.2', 'title': 'Second', 'files': ['figures/second.tex']}
            figures = Figures(document, {'figures/first.tex': [{'page': 0, 'clip': [0, 40, 400, 110]}],
                                         'figures/second.tex': [{'page': 1, 'clip': [0, 74, 400, 220]}]})
            spans, missing = section_intervals(document, first, [first, second], figures, lambda f: f.startswith('figures/'))
            self.assertFalse(missing)
            self.assertEqual(spans[0][0][0], 40)
            self.assertFalse(any(a < 220 and b > 74 for a, b in spans[1]))
            self.assertEqual(spans[1][-1][1], 296)

    def test_running_headers_and_footers_are_left_out(self):
        with pdf.open() as document:
            for number in range(6):
                page = document.new_page(width=400, height=600)
                if number:
                    page.insert_text((40, 40), 'Chapter title')
                page.insert_text((40, 100 if number else 50), 'Section heading' if not number else f'Body {number}')
                page.insert_text((40, 130), 'More body text.')
                page.insert_text((190, 520), str(number + 1))
            margins = Margins(document)
            self.assertIsNotNone(margins.header)
            self.assertIsNotNone(margins.footer)
            top, bottom = margins.body(document[2])
            text = document[2].get_text(clip=pdf.Rect(0, top, 400, bottom))
            self.assertIn('Body 2', text)
            self.assertNotIn('Chapter title', text)
            self.assertNotIn('3', text.replace('Body 2', ''))
            top, _ = margins.body(document[0])
            self.assertIn('Section heading', document[0].get_text(clip=pdf.Rect(0, top, 400, 600)))

    def test_words_hyphenated_at_a_break_are_joined(self):
        from latex_review.render.pdfdiff import joined
        word = lambda text, pair, y: {'text': text, 'pair': pair, 'rect': [0, y, 10, y + 10]}
        self.assertEqual(joined([word('sur-', 0, 0), word('rounding', 0, 14), word('order-', 0, 14),
                                 word('Free', 0, 28), word('pre-', 0, 28), word('processing', 1, 0)]),
                         ['surrounding', 'order-', 'Free', 'preprocessing'])
