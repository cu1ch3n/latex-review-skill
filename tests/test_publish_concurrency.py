"""Exercise overlapping tasks, same-task ordering, and shared cached builds."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import threading
import time
from unittest.mock import patch

from helpers import RepoCase
from test_build import compiler

from latex_review import build
from latex_review.build import Builder
from latex_review.publish import PublishError


class ConcurrentPublishTests(RepoCase):
    def setUp(self):
        super().setUp()
        self.write('.latex-review.json', json.dumps({'build_workers': 2}))
        self.publish_app = self.app()
        self.publisher = self.publish_app.publisher
        for name in ('a', 'b', 'c'):
            self.publish_app.tasks.create(name, name.upper())

    def wait_jobs(self, *jobs):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            results = [self.publisher.job(job['id']) for job in jobs]
            if all(job['status'] in ('done', 'failed') for job in results) and not self.publisher.busy():
                return results
            threading.Event().wait(.01)
        self.fail('Jobs did not finish')

    def test_parallel_tasks_leave_same_task_followup_waiting_without_blocking_a_worker(self):
        started = {key: threading.Event() for key in ('a1', 'a2', 'b', 'c')}
        release = {key: threading.Event() for key in started}
        calls, active, peak = [], set(), []
        mutex = threading.Lock()

        def run(job):
            name = job['task']
            with mutex:
                key = ('a2' if 'a1' in calls else 'a1') if name == 'a' else name
                self.assertNotIn(name, active)
                active.add(name)
                calls.append(key)
                peak.append(len(active))
            started[key].set()
            try:
                self.assertTrue(release[key].wait(5), key)
            finally:
                with mutex:
                    active.remove(name)
            if key == 'a1':
                raise PublishError('Expected failure')
            return {'outcome': 'empty'}

        with patch.object(self.publisher, 'build_round', run), \
                patch.object(self.publisher, 'prune_cache') as prune:
            try:
                a1 = self.publisher.submit('a')
                self.assertTrue(started['a1'].wait(5))
                a2 = self.publisher.submit('a')
                self.assertEqual(self.publisher.submit('a')['id'], a2['id'])
                b = self.publisher.submit('b')
                self.assertTrue(started['b'].wait(5))
                c = self.publisher.submit('c')
                self.assertFalse(started['a2'].is_set())
                self.assertFalse(started['c'].is_set())
                release['b'].set()
                self.assertTrue(started['c'].wait(5))
                self.assertFalse(started['a2'].is_set())
                prune.assert_not_called()
                release['a1'].set()
                self.assertTrue(started['a2'].wait(5))
                release['a2'].set()
                release['c'].set()
                results = self.wait_jobs(a1, a2, b, c)
                self.assertEqual([job['status'] for job in results], ['failed', 'done', 'done', 'done'])
                self.assertEqual(max(peak), 2)
                # busy() takes the scheduler lock, including final cache cleanup.
                self.assertFalse(self.publisher.busy())
                prune.assert_called_once()
            finally:
                for gate in release.values():
                    gate.set()

    def test_same_snapshot_is_compiled_once_when_workers_request_it_together(self):
        builder = Builder(self.publish_app.project, self.publish_app.repo)
        entered, release = threading.Event(), threading.Event()
        run, calls = compiler()

        def blocked_compile(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return run(*args)

        with patch.object(build, 'run', blocked_compile), \
                patch.object(build, 'tex_version', return_value='TeX 1'), \
                ThreadPoolExecutor(2) as pool:
            try:
                first = pool.submit(builder.build, 'HEAD')
                self.assertTrue(entered.wait(5))
                second = pool.submit(builder.build, 'HEAD')
            finally:
                release.set()
            self.assertEqual(first.result(5), second.result(5))
            self.assertEqual(len(calls), 1)

    def test_parallel_publishes_keep_rounds_and_artifacts_separate(self):
        app = self.publish_app
        for name in ('a', 'b'):
            self.edit(app.tasks.get(name), 'paper/sections/method.tex', 'Method sentence 4.', name.upper())
        rendezvous = threading.Barrier(2)
        run, _ = compiler()

        def render(output, request):
            rendezvous.wait(5)
            units = {u['id']: {'visual': 'text'} for u in request['units']}
            (output / 'round.json').write_text(json.dumps({'units': units}))

        with patch.object(build, 'run', run), patch.object(build, 'tex_version', return_value='TeX 1'), \
                patch('latex_review.publish.render', render):
            jobs = [self.publisher.submit(name) for name in ('a', 'b')]
            self.assertEqual([job['status'] for job in self.wait_jobs(*jobs)], ['done', 'done'])
            for name in ('a', 'b'):
                detail = app.review.round_detail(name, 1)
                self.assertEqual(detail['units'][0]['new_text'].strip(), name.upper())
                self.assertTrue((Path(app.state) / 'rounds' / name / '001/round.json').is_file())
