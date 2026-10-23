"""Git plumbing, project detection, the outline parser and change units."""
import json
import os
from pathlib import Path
import tempfile
import unittest

from helpers import RepoCase, git

from latex_review.changes import apply_units, diff_units, revert_units, scope_violations
from latex_review.config import ConfigError, detect_engine, detect_main, load_project
from latex_review.git import GitError, Repo, clean_path, merge3, within
from latex_review.outline import build_outline, deepest_node, resolve_sections, selected_ranges

METHOD = 'paper/sections/method.tex'


class GitTests(RepoCase):
    def test_snapshot_leaves_head_index_and_branches_alone(self):
        repo = Repo(self.root)
        self.write('paper/main.tex', 'staged\n')
        self.write('notes.txt', 'staged new file outside the document\n')
        git(self.root, 'add', '.')
        self.write('paper/main.tex', 'staged and then edited\n')
        self.write('paper/untracked.tex', 'untracked\n')
        self.write('elsewhere.tex', 'untracked outside the document\n')
        head, index = git(self.root, 'rev-parse', 'HEAD'), (self.root / '.git/index').read_bytes()
        revision = repo.snapshot(['paper'])
        self.assertEqual(repo.blob(revision, 'paper/main.tex'), b'staged and then edited\n')
        self.assertEqual(repo.blob(revision, 'paper/untracked.tex'), b'untracked\n')
        self.assertIsNotNone(repo.blob(revision, 'notes.txt'))
        self.assertIsNone(repo.blob(revision, 'elsewhere.tex'))
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), head)
        self.assertEqual((self.root / '.git/index').read_bytes(), index)

    def test_batch_reads_and_private_commits(self):
        repo = Repo(self.root)
        head = repo.rev('HEAD')
        found = repo.read([(head, 'paper/main.tex'), (head, 'missing.tex'), (head, 'paper')])
        self.assertEqual(found[head, 'paper/main.tex'], self.main_text.encode())
        self.assertIsNone(found[head, 'missing.tex'])
        self.assertIsNone(found[head, 'paper'])
        commit = repo.commit_with(head, {'paper/main.tex': b'changed\n', METHOD: None, 'new.tex': b'n\n'}, 'test')
        self.assertEqual(repo.changed_files(head, commit), ['new.tex', 'paper/main.tex', METHOD])
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD').strip(), head)

    def test_export_writes_a_tree_and_refuses_escaping_links(self):
        repo = Repo(self.root)
        target = self.base / 'export'
        repo.export('HEAD', 'paper', target)
        self.assertEqual((target / 'main.tex').read_text(), self.main_text)
        os.symlink('../../outside', self.root / 'paper/link')
        git(self.root, 'add', '.')
        git(self.root, 'commit', '-qm', 'link')
        with self.assertRaisesRegex(GitError, 'outside'):
            repo.export('HEAD', 'paper', self.base / 'again')

    def test_merge_and_paths(self):
        self.assertEqual(merge3(b'a\nb\nc\n', b'a\nb\nc\n', b'a\nB\nc\n'), (b'a\nB\nc\n', False))
        self.assertEqual(merge3(b'A\nb\nc\nd\ne\n', b'a\nb\nc\nd\ne\n', b'a\nb\nc\nd\nE\n'), (b'A\nb\nc\nd\nE\n', False))
        self.assertTrue(merge3(b'x\n', b'a\n', b'y\n')[1])
        self.assertTrue(merge3(None, b'a\n', b'b\n')[1])
        self.assertEqual(merge3(None, b'a\n', None), (None, False))
        for bad in ('../x', '/etc/passwd', '.git/config'):
            with self.assertRaises(ValueError):
                clean_path(bad)
        self.assertEqual(clean_path('./paper/'), 'paper')
        self.assertTrue(within('paper/a.tex', ['paper']))
        self.assertFalse(within('paper-old/a.tex', ['paper']))
        self.assertTrue(within('anything', ['']))


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def test_root_document_detection(self):
        document = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n'
        self.write('paper/main.tex', document)
        self.assertEqual(detect_main(self.root), 'paper/main.tex')
        self.write('paper/appendix.tex', document)
        self.assertEqual(detect_main(self.root), 'paper/main.tex')
        self.write('draft/notes.tex', document)
        self.write('draft/other.tex', document)
        self.write('paper/main.tex', '% \\documentclass{article}\n')
        with self.assertRaisesRegex(ConfigError, 'Several root documents'):
            detect_main(self.root)
        self.write('book/latexmkrc', "@default_files = ('Book.tex');\n$pdf_mode = 5;\n")
        self.write('book/Book.tex', document)
        self.assertEqual(detect_main(self.root), 'book/Book.tex')
        self.assertEqual(detect_engine(self.root, 'book/Book.tex', 'book/latexmkrc'), 'xelatex')

    def test_engine_detection(self):
        self.write('a.tex', '% !TeX program = lualatex\n\\documentclass{article}')
        self.assertEqual(detect_engine(self.root, 'a.tex', None), 'lualatex')
        self.write('b.tex', '\\documentclass{article}\n\\usepackage{fontspec}\n')
        self.assertEqual(detect_engine(self.root, 'b.tex', None), 'xelatex')
        self.write('c.tex', '\\documentclass{article}\n% \\usepackage{fontspec}\n')
        self.assertEqual(detect_engine(self.root, 'c.tex', None), 'pdflatex')

    def test_settings_file(self):
        git(self.root, 'init', '-q')
        self.write('doc/paper.tex', '\\documentclass{article}\\begin{document}\\end{document}')
        self.write('doc/figures/a.tex', '')
        project = load_project(self.root)
        self.assertEqual((project.main, project.doc_dir, project.engine), ('doc/paper.tex', 'doc', 'pdflatex'))
        self.assertTrue(project.is_figure('doc/figures/a.tex'))
        self.assertEqual(project.worktrees, self.root.resolve().parent / (self.root.name + '-tasks'))
        self.assertEqual(project.build_workers, 1)
        self.write('.latex-review.json', json.dumps({'main': 'doc/paper.tex', 'engine': 'xelatex', 'source_dir': '.',
                                                     'preload': {'chapters/a': 'macros/a.tex'}, 'build_workers': 2}))
        project = load_project(self.root)
        self.assertEqual(project.build_workers, 2)
        self.assertEqual((project.engine, project.source_dir, project.preload), ('xelatex', '', {'chapters/a': 'macros/a.tex'}))
        for bad in ({'mian': 'x'}, {'engine': 'tex'}, {'main': 'missing.tex'}, {'source_dir': 'other'},
                    {'worktrees': 'inside'}, *({'build_workers': n} for n in (0, 9, True, '2', 1.5))):
            self.write('.latex-review.json', json.dumps({'main': 'doc/paper.tex', **bad}))
            with self.assertRaises(ConfigError):
                load_project(self.root)
        self.write('.latex-review.json', '{broken')
        with self.assertRaisesRegex(ConfigError, 'not valid JSON'):
            load_project(self.root)


def outline_of(files, main='main.tex'):
    return build_outline(lambda name: files.get(name), main)['nodes']


class OutlineTests(unittest.TestCase):
    def test_article_numbering_labels_and_root_sections(self):
        nodes = outline_of({'main.tex': '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\n'
                                        'Text.\n\\section*{Unnumbered}\n\\subsection{Ignored number}\n\\section{Method}\n'
                                        '\\label{sec:method}\n\\subsection{Details}\nMore.\n\\appendix\n\\section{Proofs}\n'
                                        '\\end{document}\nAfter the end.\n'})
        self.assertEqual([(n['number'], n['title']) for n in nodes],
                         [('1', 'Intro'), ('', 'Unnumbered'), ('1.1', 'Ignored number'), ('2', 'Method'),
                          ('2.1', 'Details'), ('A', 'Proofs')])
        self.assertEqual(nodes[0]['id'], 'label:sec:intro')
        self.assertEqual(nodes[3]['id'], 'label:sec:method')
        self.assertEqual(nodes[0]['ranges'], {'main.tex': [[3, 4]]})
        self.assertEqual(nodes[3]['ranges'], {'main.tex': [[7, 10]]})
        self.assertEqual(nodes[5]['ranges'], {'main.tex': [[12, 12]]})

    def test_book_with_includes_and_glue_lines(self):
        nodes = outline_of({
            'main/Book.tex': '\\begin{document}\n\\frontmatter\n\\chapter{Preface}\n\\mainmatter\n\\part{One}\n'
                               '\\include{chapters/one}\n\\printbibliography\n\\appendix\n\\include{chapters/proofs}\n\\end{document}\n',
            'main/chapters/one.tex': '\\chapter{One}\n\\label{chap:one}\n\\input{chapters/body}\n\\input{chapters/next}\n',
            'main/chapters/body.tex': '\\section{First}\nText.\n',
            'main/chapters/next.tex': '\n% leading comment\n\\section{Next}\n\\label{sec:next}\nMore.\n',
            'main/chapters/proofs.tex': '\\chapter{Proofs}\n\\section{Lemma}\n'}, 'main/Book.tex')
        numbers = {n['title']: n['number'] for n in nodes}
        self.assertEqual(numbers, {'Preface': '', 'One': '1', 'First': '1.1', 'Next': '1.2', 'Proofs': 'A', 'Lemma': 'A.1'})
        first = next(n for n in nodes if n['title'] == 'First')
        following = next(n for n in nodes if n['title'] == 'Next')
        self.assertNotIn('main/chapters/next.tex', first['files'])
        self.assertEqual(following['ranges']['main/chapters/next.tex'], [[1, 5]])
        chapter = next(n for n in nodes if n['id'] == 'label:chap:one')
        self.assertNotIn('main/Book.tex', chapter['files'])

    def test_section_selection(self):
        files = {'main.tex': '\\begin{document}\n\\section{Method}\n\\label{sec:method}\nA\n\\section{Method}\nB\n'
                             '\\section{Results}\nC\n'}
        nodes = outline_of(files)
        self.assertEqual(resolve_sections(nodes, ['1', 'sec:method', 'label:sec:method']), ['label:sec:method'])
        self.assertEqual(resolve_sections(nodes, ['results']), [nodes[2]['id']])
        with self.assertRaisesRegex(ValueError, 'matches 2'):
            resolve_sections(nodes, ['Method'])
        ranges, chosen = selected_ranges(nodes, [nodes[0]['id'], nodes[2]['id']])
        self.assertEqual(ranges, {'main.tex': [[2, 4], [7, 8]]})
        self.assertEqual(chosen[1]['title'], 'Results')

    def test_a_change_belongs_to_the_heading_containing_all_of_it(self):
        nodes = outline_of({'main.tex': '\\begin{document}\n\\section{A}\nx\n\\subsection{B}\ny\n\\section{C}\nz\n'})
        self.assertEqual(deepest_node(nodes, 'main.tex', 5, 5)['title'], 'B')
        self.assertEqual(deepest_node(nodes, 'main.tex', 3, 5)['title'], 'A')
        self.assertIsNone(deepest_node(nodes, 'main.tex', 5, 7))


class ChangeTests(RepoCase):
    def revisions(self, path, new):
        repo = Repo(self.root)
        before = repo.rev('HEAD')
        self.write(path, new)
        return repo, before, repo.snapshot(['paper'])

    def test_units_group_nearby_edits_and_apply_or_revert_independently(self):
        text = self.method_text.replace('Method sentence 1.', 'One.').replace('Method sentence 3.', 'Three.')
        text = text.replace('Detail sentence 12.', 'Twelve.')
        repo, before, after = self.revisions(METHOD, text)
        units = diff_units(repo, before, after)
        self.assertEqual(len(units), 2)
        self.assertEqual((units[0]['old_text'], units[0]['new_text']),
                         ('Method sentence 1.\nMethod sentence 2.\nMethod sentence 3.\n', 'One.\nMethod sentence 2.\nThree.\n'))
        old, new = repo.blob(before, METHOD), repo.blob(after, METHOD)
        only_second = apply_units(old, new, [units[1]])
        self.assertIn(b'Twelve.', only_second)
        self.assertNotIn(b'One.', only_second)
        self.assertEqual(revert_units(old, new, units), old)
        self.assertEqual(revert_units(old, new, [units[0]]), only_second)

    def test_missing_final_newline_is_preserved(self):
        repo, before, after = self.revisions(METHOD, self.method_text + 'Appended')
        units = diff_units(repo, before, after)
        old, new = repo.blob(before, METHOD), repo.blob(after, METHOD)
        self.assertEqual(apply_units(old, new, units), new)
        self.assertEqual(revert_units(old, new, units), old)

    def test_whole_file_units(self):
        repo = Repo(self.root)
        before = repo.rev('HEAD')
        self.write('paper/figures/plot.tex', 'figure body\n')
        self.write('paper/image.bin', 'a\0b')
        (self.root / 'paper/main.tex').unlink()
        after = repo.snapshot(['paper'])
        units = diff_units(repo, before, after, lambda p: p.startswith('paper/figures/'))
        kinds = {u['file']: (u['status'], u['kind'], u['whole_file']) for u in units}
        self.assertEqual(kinds, {'paper/figures/plot.tex': ('added', 'figure', True),
                                 'paper/image.bin': ('added', 'binary', True),
                                 'paper/main.tex': ('deleted', 'text', True)})

    def test_scope_violations(self):
        repo = Repo(self.root)
        base = repo.rev('HEAD')
        scope = {'ranges': {METHOD: [[4, 10]]}, 'paths': [METHOD]}
        self.write(METHOD, self.method_text.replace('Method sentence 5.', 'Inside.'))
        self.assertEqual(scope_violations(repo, base, repo.snapshot(['paper']), scope), [])
        lines = self.method_text.split('\n')
        self.write(METHOD, '\n'.join(lines[:10] + ['Inserted after the range.'] + lines[10:]))
        self.assertEqual(scope_violations(repo, base, repo.snapshot(['paper']), scope), [])
        self.write(METHOD, self.method_text.replace('Method sentence 15.', 'Outside.'))
        self.assertEqual(scope_violations(repo, base, repo.snapshot(['paper']), scope), [f'{METHOD}:18'])
        self.write(METHOD, self.method_text)
        self.write('paper/main.tex', 'changed\n')
        self.assertEqual(scope_violations(repo, base, repo.snapshot(['paper']), scope), ['paper/main.tex'])
        self.assertEqual(scope_violations(repo, base, repo.snapshot(['paper']), {'ranges': None, 'paths': ['paper']}), [])
