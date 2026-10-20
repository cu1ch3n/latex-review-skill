"""The build adapter and the publisher, with the TeX compiler and renderer replaced by stubs."""
import json
from pathlib import Path
from unittest.mock import patch

from helpers import RepoCase, git

from latex_review import build
from latex_review.build import BuildError, Builder, affected_targets, errors, includes, warnings
from latex_review.publish import PublishError

METHOD = 'paper/sections/method.tex'
LOG = '''This is pdfTeX
./sections/method.tex:12: Undefined control sequence.
l.12 \\foo
              bar
LaTeX Warning: Reference `fig:missing' on page 2 undefined on input line 4.
LaTeX Warning: Citation `knuth84' on page 3 undefined on input line 9.
'''


def compiler(fail=False):
    """A latexmk stand-in that writes a PDF and a log for each call, and records the calls."""
    calls = []

    def run(command, cwd, transcript):
        calls.append(command)
        job = next(a.split('=', 1)[1] for a in command if a.startswith('-jobname='))
        out = Path(cwd) / 'build'
        (out / (job + '.log')).write_text(LOG if fail else 'LaTeX Warning: Reference `x\' on page 1 undefined\n')
        Path(transcript).write_text('latexmk output\n')
        if fail:
            return 12
        (out / (job + '.pdf')).write_bytes(b'%PDF stub ' + str(len(calls)).encode())
        (out / (job + '.aux')).write_text('\\relax\n')
        return 0
    return run, calls


class BuildTests(RepoCase):
    def builder(self):
        return Builder(self.app().project, self.app().repo)

    def test_builds_are_cached_by_source_tree(self):
        run, calls = compiler()
        builder = self.builder()
        with patch.object(build, 'run', run), patch.object(build, 'tex_version', return_value='TeX 1'):
            first = builder.build('HEAD')
            self.assertEqual(builder.build('HEAD'), first)
            self.assertEqual(len(calls), 1)
            self.assertIn('-pdf', calls[0])
            self.assertEqual(calls[0][-1], 'main.tex')
            self.assertEqual(first['warnings'], ['Undefined reference: x'])
            self.write('README.md', 'outside the document folder\n')
            git(self.root, 'add', '.')
            git(self.root, 'commit', '-qm', 'readme')
            self.assertEqual(builder.build('HEAD')['key'], first['key'])
            self.write('paper/main.tex', self.main_text + '% edited\n')
            git(self.root, 'commit', '-qam', 'edit')
            self.assertNotEqual(builder.build('HEAD')['key'], first['key'])
            self.assertEqual(len(calls), 2)

    def test_failures_report_tex_errors_and_keep_the_log(self):
        run, _ = compiler(fail=True)
        with patch.object(build, 'run', run), patch.object(build, 'tex_version', return_value='TeX 1'):
            with self.assertRaises(BuildError) as caught:
                self.builder().build('HEAD')
        self.assertEqual(caught.exception.details, ['sections/method.tex:12: Undefined control sequence.  [l.12 \\foo]'])
        self.assertTrue(Path(caught.exception.log).is_file())
        self.assertEqual(list((self.app().state / 'cache' / 'builds').glob('*/result.json')), [])

    def test_log_parsing(self):
        self.assertEqual(warnings(LOG), ['Undefined citation: knuth84', 'Undefined reference: fig:missing'])
        self.assertEqual(errors('! Emergency stop.\n<*> main.tex\n'), ['Emergency stop.'])

    def test_partial_builds_compile_only_affected_chapters(self):
        texts = {'Book.tex': '\\include{chapters/one}\n% \\include{chapters/old}\n\\include{chapters/two}\n',
                 'chapters/one.tex': '\\input{figures/plot}\n', 'chapters/two.tex': '', 'figures/plot.tex': ''}
        targets = includes(texts['Book.tex'])
        self.assertEqual(targets, ['chapters/one', 'chapters/two'])
        self.assertEqual(affected_targets(texts, ['figures/plot.tex'], targets), ['chapters/one'])
        self.assertEqual(affected_targets(texts, ['macros.tex'], targets), ['full'])

    def test_partial_build_commands_preload_excluded_chapters(self):
        self.write('.latex-review.json', json.dumps({'preload': {'sections/one': 'macros/one.tex'}}))
        self.write('paper/main.tex', '\\documentclass{book}\n\\begin{document}\n\\include{sections/one}\n'
                                     '\\include{sections/two}\n\\end{document}\n')
        self.write('paper/sections/one.tex', '\\chapter{One}\n')
        self.write('paper/sections/two.tex', '\\chapter{Two}\nText.\n')
        self.write('paper/macros/one.tex', '')
        git(self.root, 'add', '.')
        git(self.root, 'commit', '-qm', 'chapters')
        before = git(self.root, 'rev-parse', 'HEAD').strip()
        self.write('paper/sections/two.tex', '\\chapter{Two}\nChanged.\n')
        git(self.root, 'commit', '-qam', 'two')
        builder = self.builder()
        self.assertEqual(builder.plan(before, 'HEAD', ['paper/sections/two.tex']), ['sections/two'])
        run, calls = compiler()
        with patch.object(build, 'run', run), patch.object(build, 'tex_version', return_value='TeX 1'):
            seed = builder.build(before)
            builder.build('HEAD', ['sections/two'], seed)
        self.assertIn('-usepretex=\\includeonly{sections/two}\\AtBeginDocument{\\input{macros/one.tex}}', calls[1])
        self.assertTrue((Path(seed['cwd']) / 'build' / 'sections').is_dir())


class PublishTests(RepoCase):
    def setUp(self):
        super().setUp()
        self.publish_app = self.app()
        self.task = self.publish_app.tasks.create('t', 'T', sections=['Method'])
        self.run, self.calls = compiler()

    def publish(self, during_render=None):
        renders = []

        def fake_render(output, request):
            if during_render and not renders:
                during_render()
            renders.append(request)
            units = {u['id']: {'visual': 'text', 'edits': [], 'pages': ['1'], 'section': '2 Method'} for u in request['units']}
            (output / 'round.json').write_text(json.dumps({'units': units, 'sections': [], 'loose': []}))
        job = {'id': 'job', 'task': 't'}
        self.publish_app.store.execute("INSERT OR REPLACE INTO jobs(id,task,status,created) VALUES('job','t','running',0)")
        with patch.object(build, 'run', self.run), patch.object(build, 'tex_version', return_value='TeX 1'), \
                patch('latex_review.publish.render', fake_render):
            result = self.publish_app.publisher.build_round(job)
        self.renders = len(renders)
        return result

    def test_publish_records_rounds_and_reports_new_warnings(self):
        self.assertEqual(self.publish(), {'outcome': 'empty', 'round': None, 'changes': 0})
        self.edit(self.task, METHOD, 'Method sentence 4.', 'Better.')
        result = self.publish()
        self.assertEqual((result['outcome'], result['round'], result['changes']), ('published', 1, 1))
        self.assertEqual(result['warnings'], [])
        self.assertEqual(self.publish()['outcome'], 'unchanged')
        detail = self.publish_app.review.round_detail('t', 1)
        self.assertEqual(detail['units'][0]['section'], '2 Method')
        self.assertEqual(git(self.root, 'for-each-ref', '--format=%(refname)', 'refs/latex-review/t/').split(),
                         ['refs/latex-review/t/base', 'refs/latex-review/t/round-1'])

    def test_decisions_made_during_a_build_are_part_of_the_round(self):
        app = self.publish_app
        self.edit(self.task, METHOD, 'Method sentence 4.', 'Better.')
        self.publish()
        self.edit(self.task, METHOD, 'Method sentence 14.', 'Revised.')
        accept = lambda: app.review.decide('t', {'id': 'during', 'action': 'accept', 'round': 1, 'changes': ['c001']})
        result = self.publish(during_render=accept)
        self.assertEqual((result['round'], result['changes'], self.renders), (2, 1, 2))
        round_ = app.review.round('t', 2)
        self.assertEqual(round_['before'], app.tasks.get('t')['accepted'])
        self.assertIn('Revised.', round_['units'][0]['new_text'])

    def test_publish_refuses_edits_outside_the_scope(self):
        self.edit(self.task, 'paper/main.tex', 'Intro sentence 3.', 'Out of scope.')
        with self.assertRaises(PublishError) as caught:
            self.publish()
        self.assertTrue(str(caught.exception).endswith('outside the task scope: paper/main.tex'))
        self.assertIn('2 Method', caught.exception.details[0])

    def test_publish_reports_compile_errors_of_the_agents_version(self):
        self.edit(self.task, METHOD, 'Method sentence 4.', 'Broken \\foo.')
        good, _ = compiler()
        bad, _ = compiler(fail=True)
        self.run = lambda command, cwd, transcript: (bad if 'Broken' in (Path(cwd) / 'sections/method.tex').read_text()
                                                     else good)(command, cwd, transcript)
        with self.assertRaises(PublishError) as caught:
            self.publish()
        self.assertEqual(str(caught.exception), 'Your edits do not compile.')
        self.assertTrue(caught.exception.details)

    def test_jobs_coalesce_and_report_their_place_in_the_queue(self):
        publisher = self.publish_app.publisher
        with patch.object(publisher, 'jobs') as queue:
            first = publisher.submit('t')
            second = publisher.submit('t')
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(queue.put.call_count, 1)
        self.assertTrue(publisher.busy('t'))
        self.assertEqual(self.publish_app.review.summary('t')['state'], 'building')
        self.assertEqual(self.publish_app.review.page_state('t')['job']['ahead'], 0)
