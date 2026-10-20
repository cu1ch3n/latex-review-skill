"""Tasks: one isolated Git worktree per editing assignment, with an enforced scope."""
import json
from pathlib import Path
import re
import secrets
import shutil
import time

from .files import read_json, write_json
from .git import Repo, clean_path
from .outline import build_outline, resolve_sections, selected_ranges

NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')
MARKER = 'latex-review.json'
# Untracked build products are never part of a snapshot.
GENERATED = ('.aux', '.log', '.out', '.toc', '.lof', '.lot', '.loe', '.fls', '.fdb_latexmk', '.synctex.gz',
             '.bbl', '.blg', '.bcf', '.run.xml', '.xdv', '.dvi', '.nav', '.snm', '.vrb', '.idx', '.ilg', '.ind')


def slug(text):
    value = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:40].strip('-')
    return value if NAME.fullmatch(value or '-') else ''


def task_marker(path):
    """The task that owns a working tree, as (integration root, task name), or (toplevel, None)."""
    repo = Repo(path)
    top = repo.toplevel()
    marker = read_json(repo.git_dir() / MARKER)
    if marker:
        return Path(marker['root']), marker['task']
    return top, None


def revision_reader(repo, rev, folder):
    """A read(path) function over the .tex files of `folder` at `rev`, fetched in one call."""
    paths = [p for p in repo.files(rev, folder) if p.endswith('.tex')]
    texts = {p: data.decode(errors='replace') for p, data in repo.blobs(rev, paths).items() if data is not None}
    return texts.get


class Tasks:
    def __init__(self, app):
        self.app = app

    def get(self, name, open_only=True):
        task = self.app.store.one('SELECT * FROM tasks WHERE name=?', name)
        if not task or (open_only and task['closed']):
            raise LookupError(f'No open review task named {name!r}.')
        return task

    def list(self):
        return self.app.store.all('SELECT * FROM tasks WHERE closed IS NULL ORDER BY created')

    def snapshot_scope(self, task):
        return [self.app.project.source_dir, *task['scope']['paths']]

    def snapshot(self, task):
        return Repo(task['worktree']).snapshot(self.snapshot_scope(task), exclude=GENERATED)

    def create(self, name=None, title=None, sections=(), files=()):
        app, project = self.app, self.app.project
        if sections and files:
            raise ValueError('Choose sections or files for the scope, not both.')
        title = (title or name or 'LaTeX review').strip()[:120]
        explicit = bool(name)
        name = name or slug(title) or 'review-' + secrets.token_hex(3)
        if not NAME.fullmatch(name):
            raise ValueError('Task names use lowercase letters, digits and hyphens (at most 64 characters).')
        with app.lock:
            candidate, suffix = name, 1
            while True:
                existing = app.store.one('SELECT * FROM tasks WHERE name=?', candidate)
                if not existing or existing['closed']:
                    break
                if self.matches(existing, sections, files):
                    return existing
                if explicit:
                    raise ValueError(f'Task {name!r} already exists with a different scope. '
                                     'Finish it first or choose another name.')
                suffix += 1
                candidate = f'{name[:60]}-{suffix}'
            name = candidate
            if not app.repo.has_head():
                raise ValueError('The repository needs at least one commit before a review can start.')
            if app.repo.text('for-each-ref', '--count=1', f'refs/latex-review/{name}/'):
                raise ValueError(f'Task name {name!r} is still used by another working tree of this repository.')
            worktree = project.worktrees / name
            if worktree.exists():
                raise ValueError(f'The folder {worktree} already exists. Remove it or choose another name.')
            paths = [clean_path(f) for f in files]
            base = app.repo.snapshot([project.source_dir, *paths], exclude=GENERATED)
            if sections:
                outline = build_outline(revision_reader(app.repo, base, project.doc_dir), project.main)
                ranges, chosen = selected_ranges(outline['nodes'], resolve_sections(outline['nodes'], sections))
                scope = {'sections': chosen, 'ranges': ranges, 'paths': sorted(ranges)}
            else:
                scope = {'sections': [], 'ranges': None, 'paths': paths or [project.source_dir]}
            worktree.parent.mkdir(parents=True, exist_ok=True)
            app.repo.run('worktree', 'add', '--detach', str(worktree), base)
            try:
                write_json(Repo(worktree).git_dir() / MARKER, {'task': name, 'root': str(project.root)})
                app.repo.update_ref(f'refs/latex-review/{name}/base', base)
                with app.store.transaction() as db:
                    db.execute('DELETE FROM tasks WHERE name=?', (name,))
                    for table in ('rounds', 'actions', 'messages', 'jobs'):
                        db.execute(f'DELETE FROM {table} WHERE task=?', (name,))
                    db.execute('INSERT INTO tasks(name,title,worktree,base,accepted,scope,created) VALUES(?,?,?,?,?,?,?)',
                               (name, title, str(worktree), base, base, json.dumps(scope, ensure_ascii=False), time.time()))
            except BaseException:
                app.repo.run('worktree', 'remove', '--force', str(worktree), check=False)
                app.repo.delete_refs(f'refs/latex-review/{name}/')
                raise
            return self.get(name)

    @staticmethod
    def matches(task, sections, files):
        """Whether a repeated `start` asks for the same scope (or for none)."""
        scope = task['scope']
        if not sections and not files:
            return True
        if sections:
            wanted = {s.strip().removeprefix('label:') for s in sections}
            known = {v for s in scope['sections'] for v in (s['id'], s['id'].removeprefix('label:'), s['number'], s['title'])}
            return bool(scope['sections']) and wanted <= known
        return scope['ranges'] is None and sorted(clean_path(f) for f in files) == sorted(scope['paths'])

    def finish(self, name, force=False):
        """Remove the worktree. Returns the manuscript files the task changed and what was left undecided."""
        app = self.app
        with app.lock:
            task = self.get(name)
            if app.publisher.busy(name):
                raise ValueError('A round is still being built. Wait for it before finishing.')
            worktree = Path(task['worktree'])
            problems = []
            counts = app.review.counts(name)
            if counts['pending'] or counts['commented']:
                problems.append(f"{counts['pending']} pending and {counts['commented']} commented changes")
            # A fully reviewed worktree equals the accepted text: rejected changes were reverted.
            leftover = app.repo.changed_files(task['accepted'], self.snapshot(task)) if worktree.exists() else []
            if leftover:
                problems.append('edits that are not in the manuscript in ' + ', '.join(leftover[:5]))
            if problems and not force:
                raise ValueError('The task still has ' + '; '.join(problems) +
                                 '. Publish and finish the review first, or use --force to discard them.')
            if worktree.exists():
                app.repo.run('worktree', 'remove', '--force', str(worktree))
            app.repo.run('worktree', 'prune', check=False)
            app.repo.delete_refs(f'refs/latex-review/{name}/')
            shutil.rmtree(app.state / 'rounds' / name, ignore_errors=True)
            app.store.execute('UPDATE tasks SET closed=? WHERE name=?', time.time(), name)
        app.publisher.prune_cache()
        return {'changed': app.repo.changed_files(task['base'], task['accepted']), 'discarded': counts}
