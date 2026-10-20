"""A real round: latexmk, SyncTeX and the renderer on a small document. Skipped without TeX or uv."""
import json
import shutil
import unittest

from helpers import RepoCase

from latex_review.publish import render_command

TOOLS = all(shutil.which(tool) for tool in ('latexmk', 'pdflatex', 'synctex', 'uv'))
METHOD = 'paper/sections/method.tex'


@unittest.skipUnless(TOOLS, 'needs latexmk, pdflatex, synctex and uv')
class EndToEndTests(RepoCase):
    def test_publish_review_and_accept(self):
        render_command()
        app = self.app()
        task = app.tasks.create('e2e', 'End to end', sections=['Method'])
        self.edit(task, METHOD, 'Method sentence 4.', 'The method is described in detail here.')
        self.edit(task, METHOD, 'Detail sentence 17.', 'A changed detail.')
        app.store.execute("INSERT INTO jobs(id,task,status,created) VALUES('job','e2e','running',0)")
        result = app.publisher.publish({'id': 'job', 'task': 'e2e'})
        self.assertEqual((result['outcome'], result['changes']), ('published', 2))
        self.assertEqual(result['kinds'], {'text': 2})
        detail = app.review.round_detail('e2e', 1)
        self.assertEqual([s['title'] for s in detail['sections']], ['Method', 'Details'])
        blocks = [b for s in detail['sections'] for b in s['blocks'] if b['kind'] == 'change']
        self.assertEqual([b['units'] for b in blocks], [['c001'], ['c002']])
        folder = app.state / 'rounds' / 'e2e' / '001'
        for block in blocks:
            self.assertTrue((folder / block['after']['src']).is_file())
            self.assertTrue(block['before'])
        state = app.review.decide('e2e', {'action': 'accept', 'round': 1, 'changes': ['c001']})
        self.assertEqual(state['decisions'], {'c001': 'accepted', 'c002': 'pending'})
        self.assertIn('The method is described in detail here.', self.read(METHOD))
        self.assertNotIn('A changed detail.', self.read(METHOD))
        self.assertEqual(json.loads((folder / 'round.json').read_text())['units']['c002']['section'], '2.1 Details')


    def test_a_paragraph_and_table_added_at_the_end_of_a_section(self):
        app = self.app()
        task = app.tasks.create('end', 'At the end', sections=['Method'])
        self.edit(task, METHOD, 'Detail sentence 19.', 'Detail sentence 19.\n\nA new closing paragraph.\n\\begingroup\n'
                  '\\begin{tabular}{ll}\nCase & Cost \\\\\nLeaf & 1\n\\end{tabular}\n\\endgroup')
        app.store.execute("INSERT INTO jobs(id,task,status,created) VALUES('job','end','running',0)")
        result = app.publisher.publish({'id': 'job', 'task': 'end'})
        self.assertEqual((result['outcome'], result['changes']), ('published', 1))
        blocks = [b for s in app.review.round_detail('end', 1)['sections'] for b in s['blocks'] if b['kind'] == 'change']
        self.assertEqual([b['units'] for b in blocks], [['c001']])

@unittest.skipUnless(TOOLS, 'needs latexmk, pdflatex, synctex and uv')
class ExampleTests(unittest.TestCase):
    def test_the_bundled_example_publishes_its_seven_changes(self):
        import subprocess
        import sys
        import tempfile
        from pathlib import Path
        from helpers import ROOT
        from latex_review.client import stop
        with tempfile.TemporaryDirectory(prefix='latex-review-example-') as temporary:
            result = subprocess.run([sys.executable, str(ROOT / 'examples/demo.py'), '--dir', temporary, '--no-open'],
                                    capture_output=True, text=True, timeout=600)
            repo = Path(temporary) / 'example-paper'
            try:
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Round 1: 7 changes', result.stdout)
                rounds = repo / '.git/latex-review/rounds/tighten-design/001/round.json'
                visual = sorted(u['visual'] for u in json.loads(rounds.read_text())['units'].values())
                self.assertEqual(visual, ['identical'] + ['text'] * 6)
            finally:
                stop(repo, force=True)
