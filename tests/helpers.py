"""Disposable Git repositories with a small LaTeX document, and an in-process review app."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from latex_review.changes import diff_units  # noqa: E402
from latex_review.server import App  # noqa: E402

MAIN = r'''\documentclass{article}
\usepackage{hyperref}
\begin{document}
\section{Introduction}
\label{sec:intro}
INTRO
\input{sections/method}
\section{Conclusion}
\label{sec:end}
We conclude.
\end{document}
'''
METHOD = r'''\section{Method}
\label{sec:method}
METHOD
\subsection{Details}
\label{sec:details}
DETAILS
'''


def lines(prefix, count):
    return '\n'.join(f'{prefix} sentence {i}.' for i in range(count))


def git(root, *args):
    return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True).stdout.decode()


class RepoCase(unittest.TestCase):
    """A repository at self.root with paper/main.tex and paper/sections/method.tex."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='latex-review-test-')
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'repo'
        (self.root / 'paper/sections').mkdir(parents=True)
        git(self.root, 'init', '-q')
        git(self.root, 'config', 'user.name', 'Test')
        git(self.root, 'config', 'user.email', 'test@localhost')
        self.main_text = MAIN.replace('INTRO', lines('Intro', 20))
        self.method_text = METHOD.replace('METHOD', lines('Method', 20)).replace('DETAILS', lines('Detail', 20))
        self.write('paper/main.tex', self.main_text)
        self.write('paper/sections/method.tex', self.method_text)
        self.write('.gitignore', '*.aux\n')
        git(self.root, 'add', '.')
        git(self.root, 'commit', '-qm', 'initial')
        self.apps = []

    def tearDown(self):
        for app in self.apps:
            app.publisher.stop()
        self.temp.cleanup()

    def write(self, path, text, root=None):
        target = (root or self.root) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def read(self, path, root=None):
        return ((root or self.root) / path).read_text()

    def app(self):
        app = App(self.root)
        app.url = 'http://127.0.0.1:9'
        self.apps.append(app)
        return app

    def edit(self, task, path, old, new):
        target = Path(task['worktree']) / path
        text = target.read_text()
        self.assertIn(old, text)
        target.write_text(text.replace(old, new, 1))


def fake_round(app, name):
    """Record a round from the worktree without compiling, as publishing would."""
    with app.lock:
        task = app.tasks.get(name)
        after = app.tasks.snapshot(task)
        before = task['accepted']
        latest = app.review.latest_round(name)
        units = diff_units(app.repo, before, after, app.project.is_figure)
        number = (latest['number'] if latest else 0) + 1
        app.store.execute('INSERT INTO rounds(task,number,before,after,units,summary,created) VALUES(?,?,?,?,?,?,?)',
                          name, number, before, after, json.dumps(units), json.dumps({'warnings': []}), time.time())
    return app.review.round(name, number)
