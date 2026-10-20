"""The HTTP server and the agent CLI, talking to an in-process server with a stub compiler."""
import json
from pathlib import Path
import subprocess
import sys
import threading
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from helpers import ROOT, RepoCase
from test_build import compiler

from latex_review import build, code_version
from latex_review.files import write_json
from latex_review.server import Handler, ThreadingHTTPServer


def fake_render(output, request):
    units = {u['id']: {'visual': 'text', 'edits': [], 'pages': ['1'], 'section': None} for u in request['units']}
    (output / 'round.json').write_text(json.dumps({'units': units, 'sections': [], 'loose': [
        {'units': [u['id']], 'before': [], 'after': []} for u in request['units']]}))
    (output / 's0001.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')


class ServerCase(RepoCase):
    def setUp(self):
        super().setUp()
        self.server_app = self.app()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.app = self.server_app
        self.url = self.server_app.url = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        write_json(self.server_app.state / 'server' / 'connection.json',
                   {'url': self.url, 'port': self.server.server_port, 'pid': 0, 'version': code_version(),
                    'root': str(self.root)})
        run, _ = compiler()
        self.patches = [patch.object(build, 'run', run), patch.object(build, 'tex_version', return_value='TeX'),
                        patch('latex_review.publish.render', fake_render),
                        patch.object(Handler, 'log_message', lambda *args: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        super().tearDown()

    def http(self, path, data=None, headers=None):
        request = Request(self.url + path, None if data is None else json.dumps(data).encode(),
                          {'Content-Type': 'application/json', **(headers or {})})
        with urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()

    def cli(self, *args, cwd=None, ok=True):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/review.py'), *args], cwd=cwd or self.root,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return json.loads(result.stdout)


class HttpTests(ServerCase):
    def test_requests_must_come_from_this_origin_with_the_token(self):
        status, headers, body = self.http('/')
        self.assertEqual(status, 200)
        self.assertIn(b'LaTeX Review', body)
        self.assertEqual(headers['Cache-Control'], 'no-cache')
        token = json.loads(self.http('/api/info')[2])['csrf']
        for path, data, extra, code in [
                ('/api/tasks', None, {'Host': 'attacker.example'}, 403),
                ('/api/tasks', None, {'Origin': 'https://attacker.example'}, 403),
                ('/api/tasks', {'title': 'x'}, {}, 403),
                ('/api/tasks', {'title': 'x'}, {'X-Review-Token': 'wrong'}, 403),
                ('/files/x/1/../../state.sqlite3', None, {}, 404),
                ('/api/tasks/missing', None, {}, 404),
                ('/nowhere', None, {}, 404)]:
            with self.assertRaises(HTTPError) as caught:
                self.http(path, data, extra)
            caught.exception.close()
            self.assertEqual(caught.exception.code, code, path)
        status, _, body = self.http('/api/tasks', {'title': 'Via HTTP'}, {'X-Review-Token': token})
        self.assertEqual(json.loads(body)['task'], 'via-http')

    def test_round_files_are_immutable_and_compressed(self):
        task = self.server_app.tasks.create('t', 'T')
        self.edit(task, 'paper/main.tex', 'Intro sentence 1.', 'Changed.')
        job = self.server_app.publisher.submit('t')
        for _ in range(200):
            if self.server_app.publisher.job(job['id'])['status'] in ('done', 'failed'):
                break
            threading.Event().wait(.05)
        self.assertEqual(self.server_app.publisher.job(job['id'])['status'], 'done')
        status, headers, body = self.http('/files/t/1/s0001.svg', headers={'Accept-Encoding': 'gzip'})
        self.assertIn('immutable', headers['Cache-Control'])
        self.assertEqual(headers['Content-Encoding'], 'gzip')
        with self.assertRaises(HTTPError) as caught:
            self.http('/files/t/1/s0001.svg', headers={'If-None-Match': headers['ETag'], 'Accept-Encoding': 'gzip'})
        caught.exception.close()
        self.assertEqual(caught.exception.code, 304)
        detail = json.loads(self.http('/api/tasks/t/rounds/1')[2])
        self.assertEqual(detail['units'][0]['new_text'], 'Changed.\n')
        state = json.loads(self.http('/api/tasks/t/state')[2])
        self.assertEqual((state['round'], state['latest'], state['decisions']), (1, 1, {'c001': 'pending'}))


class CliTests(ServerCase):
    def test_the_agent_loop(self):
        started = self.cli('start', 'polish', '--section', 'Method', '--title', 'Polish the method')
        self.assertEqual(started['url'], self.url + '/?task=polish')
        self.assertEqual(started['state'], 'editing')
        self.assertEqual(started['scope']['sections'], ['2 Method'])
        worktree = Path(started['worktree'])
        self.assertEqual(self.cli('start', cwd=worktree)['task'], 'polish')
        self.assertEqual(self.cli('--repo', str(worktree), 'status')['task'], 'polish')
        self.assertIn('already belongs', self.cli('start', 'other', cwd=worktree, ok=False)['error'])
        self.assertIn('task worktree', self.cli('publish', ok=False)['error'])

        text = (worktree / 'paper/sections/method.tex').read_text()
        (worktree / 'paper/sections/method.tex').write_text(text.replace('Method sentence 3.', 'Sharper.'))
        published = self.cli('publish', cwd=worktree)
        self.assertEqual((published['round'], published['changes']), (1, 1))
        self.assertIn('feedback --wait', published['next'])
        self.assertEqual(self.cli('publish', cwd=worktree)['message'], 'Nothing new since round 1.')

        waiting = self.cli('feedback', cwd=worktree)
        self.assertEqual((waiting['state'], waiting['feedback']), ('reviewing', []))
        timer = threading.Timer(.5, lambda: self.server_app.review.decide(
            'polish', {'action': 'comment', 'round': 1, 'changes': ['c001'], 'body': 'Keep the example.'}))
        timer.start()
        answer = self.cli('feedback', '--wait', '20', cwd=worktree)
        timer.join()
        self.assertEqual(answer['state'], 'revise')
        self.assertEqual(answer['feedback'][0]['text'], 'Keep the example.')
        self.assertEqual(answer['feedback'][0]['changes'][0]['new'], 'Sharper.')
        self.assertEqual(self.cli('feedback', cwd=worktree)['feedback'], [])
        self.assertEqual(len(self.cli('feedback', '--all', cwd=worktree)['feedback']), 1)

        self.assertEqual([t['task'] for t in self.cli('list')['tasks']], ['polish'])
        self.assertIn('commented', self.cli('finish', cwd=worktree, ok=False)['error'])
        finished = self.cli('--task', 'polish', 'finish', '--force')
        self.assertTrue(finished['finished'])
        self.assertFalse(worktree.exists())

    def test_build_failures_are_reported_to_the_agent(self):
        started = self.cli('start', 'broken', '--title', 'Broken')
        worktree = Path(started['worktree'])
        bad, _ = compiler(fail=True)
        good, _ = compiler()
        build.run = lambda command, cwd, transcript: (bad if 'Broken' in (Path(cwd) / 'main.tex').read_text()
                                                      else good)(command, cwd, transcript)
        (worktree / 'paper/main.tex').write_text(self.main_text.replace('Intro sentence 2.', 'Broken \\foo.'))
        failure = self.cli('publish', cwd=worktree, ok=False)
        self.assertEqual(failure['error'], 'Your edits do not compile.')
        self.assertTrue(failure['details'])
        self.assertIn('Fix the LaTeX errors', failure['next'])
        self.assertEqual(self.cli('status', cwd=worktree)['state'], 'build_failed')


class LifecycleTests(RepoCase):
    """Real server processes, started and stopped the way the CLI does it."""

    def test_stop_waits_for_exit_and_leaves_a_newer_servers_file_alone(self):
        from latex_review.client import connect, server_home, stop
        from latex_review.files import locked, read_json
        home = server_home(self.root)
        client = connect(self.root)
        first = client.get('/api/info')['pid']
        self.assertEqual(stop(self.root), client.url)
        with locked(home / 'server.lock', blocking=False):
            pass  # The old server has exited and released its lock.
        self.assertIsNone(read_json(home / 'connection.json'))
        client = connect(self.root)
        second = client.get('/api/info')['pid']
        self.assertNotEqual(first, second)
        # Simulate a newer server having replaced the connection file meanwhile.
        newer = {'url': 'http://127.0.0.1:1', 'pid': 1, 'version': 'x', 'root': str(self.root)}
        write_json(home / 'connection.json', newer)
        client.post('/api/shutdown', {})
        with locked(home / 'server.lock'):
            pass
        self.assertEqual(read_json(home / 'connection.json'), newer)
        (home / 'connection.json').unlink()
        client = connect(self.root)  # Found through the last port, or started afresh.
        self.assertTrue(client.get('/api/info')['pid'])
        stop(self.root)
