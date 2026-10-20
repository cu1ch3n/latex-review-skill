"""Publishing: snapshot the agent's worktree, compile both sides, render the comparison, record a round."""
from functools import cache
import json
import os
import queue
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback

from . import RENDER_REQUIREMENTS, SKILL_ROOT
from .build import BuildError, Builder
from .changes import diff_units, scope_violations
from .files import write_json

RENDER_TIMEOUT = 1200


class PublishError(RuntimeError):
    def __init__(self, message, details=(), next_step='', log=None):
        super().__init__(message)
        self.details, self.next_step, self.log = list(details), next_step, log


class Stale(Exception):
    """The user decided something while the round was built, so it compares outdated texts."""


@cache
def render_command():
    if shutil.which('uv'):
        packages = [arg for requirement in RENDER_REQUIREMENTS for arg in ('--with', requirement)]
        return ['uv', 'run', '--quiet', '--no-project', *packages, 'python']
    probe = subprocess.run([sys.executable, '-c', 'import pymupdf, PIL'], capture_output=True)
    if probe.returncode == 0:
        return [sys.executable]
    raise PublishError('The PDF renderer needs uv (https://docs.astral.sh/uv/) or the Python packages '
                       + ' and '.join(RENDER_REQUIREMENTS) + '.', next_step='Install uv, then publish again.')


class Publisher:
    """A single worker that builds rounds one at a time; requests for a waiting task coalesce."""

    def __init__(self, app):
        self.app = app
        self.jobs = queue.Queue()
        self.mutex = threading.Lock()
        self.pending = {}   # task -> id of its queued or running job
        app.store.execute("UPDATE jobs SET status='failed', finished=?, result=? WHERE status IN ('queued','running')",
                          time.time(), json.dumps({'error': 'The review server restarted during the build.',
                                                   'next': 'Publish again.'}))
        self.worker = threading.Thread(target=self.work, name='publisher', daemon=True)
        self.worker.start()

    def submit(self, name):
        self.app.tasks.get(name)
        with self.mutex:
            current = self.pending.get(name)
            if current:
                job = self.job(current)
                if job['status'] == 'queued':
                    return job
            identity = secrets.token_hex(8)
            self.app.store.execute("INSERT INTO jobs(id,task,status,created) VALUES(?,?,'queued',?)",
                                   identity, name, time.time())
            self.pending[name] = identity
            self.jobs.put(identity)
        return self.job(identity)

    def job(self, identity):
        job = self.app.store.one('SELECT * FROM jobs WHERE id=?', identity)
        if not job:
            raise LookupError('Unknown job ' + identity)
        return job

    def current(self, name):
        return self.app.store.one('SELECT * FROM jobs WHERE task=? ORDER BY created DESC LIMIT 1', name)

    def busy(self, name=None):
        with self.mutex:
            return bool(self.pending) if name is None else name in self.pending

    def stop(self):
        self.jobs.put(None)

    def work(self):
        while True:
            identity = self.jobs.get()
            if identity is None:
                return
            job = self.job(identity)
            self.update(identity, status='running')
            try:
                result, status = self.build_round(job), 'done'
            except PublishError as error:
                result, status = {'error': str(error), 'details': error.details, 'next': error.next_step}, 'failed'
                if error.log:
                    result['log'] = error.log
            except Exception as error:  # Reported to the agent instead of killing the worker.
                traceback.print_exc()
                result, status = {'error': f'{type(error).__name__}: {error}', 'next': 'Publish again.'}, 'failed'
            self.update(identity, status=status, result=json.dumps(result), finished=time.time())
            with self.mutex:
                if self.pending.get(job['task']) == identity:
                    del self.pending[job['task']]

    def ahead(self, job):
        """How many rounds, of any task, build before this queued one."""
        return self.app.store.one("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') AND created<?",
                                  job['created'])['n']

    def update(self, identity, **values):
        self.app.store.execute('UPDATE jobs SET ' + ','.join(k + '=?' for k in values) + ' WHERE id=?',
                               *values.values(), identity)

    def build_round(self, job):
        """Publish, and again while the user's decisions during the build change what it compares."""
        while True:
            try:
                return self.publish(job)
            except Stale:
                continue  # Builds are cached by source tree, so mostly the accepted text compiles again.

    def publish(self, job):
        app, name = self.app, job['task']
        project = app.project
        task = app.tasks.get(name)
        if not os.path.isdir(task['worktree']):
            raise PublishError(f"The task worktree {task['worktree']} no longer exists.",
                               next_step='Run `finish --force`, then start a new task.')
        self.update(job['id'], phase='snapshot')
        with app.lock:
            after = app.tasks.snapshot(task)
            task = app.tasks.get(name)
            before = task['accepted']
            latest = app.review.latest_round(name)
            decided = app.review.last_change(name)
        violations = scope_violations(app.repo, task['base'], after, task['scope'])
        if violations:
            allowed = ([f"{s['number']} {s['title']}".strip() for s in task['scope']['sections']]
                       or task['scope']['paths'])
            raise PublishError('Some edits are outside the task scope: ' + ', '.join(violations[:10]),
                               details=['Allowed: ' + ', '.join(allowed)],
                               next_step='Undo those edits in the worktree (or ask the user to widen the scope), '
                                         'then publish again.')
        if latest and latest['before'] == before and app.repo.tree_id(latest['after']) == app.repo.tree_id(after):
            return {'outcome': 'unchanged', 'round': latest['number'], 'changes': len(latest['units'])}
        files = app.repo.changed_files(before, after)
        if not files:
            return {'outcome': 'empty', 'round': None, 'changes': 0}
        units = diff_units(app.repo, before, after, project.is_figure)
        self.update(job['id'], phase='build')
        builder = Builder(project, app.repo)
        targets = builder.plan(before, after, files)
        try:
            seed = builder.build(task['base']) if targets != ['full'] else None
            old = builder.build(before, targets, seed)
        except BuildError as error:
            raise PublishError('The accepted text (the document as the task started, plus the changes accepted '
                               'so far) does not compile, so there is nothing to compare against.', error.details,
                               'Tell the user. If an accepted change broke the build they can undo it on the review '
                               'page; otherwise they should fix the document, then you finish this task and start '
                               'a new one.', error.log) from None
        try:
            new = builder.build(after, targets, seed)
        except BuildError as error:
            raise PublishError('Your edits do not compile.', error.details,
                               'Fix the LaTeX errors in the worktree, then publish again.', error.log) from None
        if app.review.last_change(name) != decided:
            raise Stale
        warnings = sorted(set(new['warnings']) - set(old['warnings']))
        self.update(job['id'], phase='render')
        number = (latest['number'] if latest else 0) + 1
        rounds = app.state / 'rounds' / name
        output = rounds / f'{number:03}.pending-{secrets.token_hex(4)}'
        output.mkdir(parents=True)
        final = rounds / f'{number:03}'
        summary = {'warnings': warnings, 'targets': targets,
                   'builds': [b['key'] for b in (seed, old, new) if b]}
        try:
            render(output, {'task': name, 'round': number, 'main': project.main, 'source_dir': project.source_dir,
                            'figures': list(project.figures), 'old': old, 'new': new, 'units': units})
            with app.lock:
                if app.review.last_change(name) != decided:
                    raise Stale
                shutil.rmtree(final, ignore_errors=True)
                os.replace(output, final)
                app.store.execute('INSERT INTO rounds(task,number,before,after,units,summary,created) '
                                  'VALUES(?,?,?,?,?,?,?)', name, number, before, after,
                                  json.dumps(units, ensure_ascii=False), json.dumps(summary), time.time())
                app.repo.update_ref(f'refs/latex-review/{name}/round-{number}', after)
        finally:
            shutil.rmtree(output, ignore_errors=True)
        self.prune_cache()
        visual = json.loads((final / 'round.json').read_text()).get('units', {})
        kinds = {}
        for unit in visual.values():
            kinds[unit.get('visual', 'source')] = kinds.get(unit.get('visual', 'source'), 0) + 1
        return {'outcome': 'published', 'round': number, 'changes': len(units), 'kinds': kinds, 'warnings': warnings}

    def prune_cache(self):
        keep = set()
        for row in self.app.store.all('SELECT summary FROM rounds JOIN tasks ON rounds.task=tasks.name '
                                      'WHERE tasks.closed IS NULL'):
            keep.update(row['summary'].get('builds', []))
        try:
            Builder(self.app.project, self.app.repo).prune(keep)
        except Exception:  # Pruning is housekeeping; never fail a publish over it.
            traceback.print_exc()


def render(output, request):
    """Run the PDF renderer (pymupdf) in its own pinned environment."""
    write_json(output / 'request.json', request)
    command = [*render_command(), '-m', 'latex_review.render', str(output / 'request.json')]
    env = {**os.environ, 'PYTHONPATH': str(SKILL_ROOT)}
    try:
        result = subprocess.run(command, cwd=SKILL_ROOT, env=env, capture_output=True, text=True,
                                timeout=RENDER_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise PublishError('Rendering the PDF comparison timed out.', next_step='Publish again.') from None
    if result.returncode:
        lines = (result.stderr or result.stdout).strip().splitlines()
        raise PublishError('Rendering the PDF comparison failed.', lines[-12:], 'Publish again; if it keeps '
                           'failing, report the details.')
    (output / 'request.json').unlink(missing_ok=True)
