"""The local review server: one per repository, started on demand by the CLI."""
from functools import lru_cache
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

from . import WEB, code_version
from .build import stop_all
from .config import CONFIG_NAME, ConfigError, load_project
from .files import LockBusy, locked, read_json, write_json
from .git import GitError, Repo
from .publish import Publisher
from .review import Review
from .store import Store
from .tasks import Tasks

STATIC = {'/': 'index.html', '/app.js': 'app.js', '/model.js': 'model.js', '/style.css': 'style.css'}
ASSET = re.compile(r'[\w.-]+\.(?:svg|png)')
IDLE_TIMEOUT = 12 * 3600
EXPECTED = (ValueError, LookupError, ConfigError, GitError, OSError)


class App:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.repo = Repo(self.root)
        self.state = self.repo.git_dir() / 'latex-review'
        self.store = Store(self.state / 'state.sqlite3')
        self.lock = threading.RLock()
        self.csrf = secrets.token_urlsafe(32)
        self.viewers = {}
        self.url = ''
        self.activity = time.monotonic()
        self._project = self._stamp = None
        self.tasks = Tasks(self)
        self.review = Review(self)
        self.publisher = Publisher(self)
        self.review.recover()

    @property
    def project(self):
        """Project settings, reloaded when the settings file changes."""
        config = self.root / CONFIG_NAME
        stamp = config.stat().st_mtime_ns if config.exists() else None
        if self._project is None or stamp != self._stamp:
            self._project, self._stamp = load_project(self.root), stamp
        return self._project

    def page(self, name):
        return f'{self.url}/?task={name}'

    def task_info(self, name):
        task = self.tasks.get(name)
        scope = task['scope']
        files = ([f'{path}:{a}-{b}' for path, spans in scope['ranges'].items() for a, b in spans]
                 if scope['ranges'] is not None else scope['paths'])
        viewing = time.time() - self.viewers.get(name, 0) < 15
        return {**self.review.summary(name), 'worktree': task['worktree'], 'url': self.page(name),
                'viewing': viewing, 'scope': {'sections': [f"{s['number']} {s['title']}".strip()
                                                           for s in scope['sections']], 'files': files}}

    def tasks_overview(self):
        result = []
        for task in self.tasks.list():
            summary = self.review.summary(task['name'])
            result.append({'task': task['name'], 'title': task['title'], 'state': summary['state'],
                           'round': summary['round'], 'counts': summary['counts'], 'url': self.page(task['name'])})
        return result


@lru_cache(maxsize=256)
def gzipped(path, mtime, size):
    return gzip.compress(Path(path).read_bytes(), compresslevel=5, mtime=0)


class Handler(BaseHTTPRequestHandler):
    server_version = 'latex-review'

    def log_message(self, format, *args):
        if not re.search(r'" (200|304) ', format % args):
            super().log_message(format, *args)

    @property
    def app(self):
        return self.server.app

    def send(self, data, status=200, content_type='application/json; charset=utf-8', cache='no-store', headers=None):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)

    def send_file(self, path, immutable=False):
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if path.suffix in ('.js', '.css', '.html'):
            content_type += '; charset=utf-8'
        stat = path.stat()
        gzip_ok = any(part.strip().split(';')[0] == 'gzip' and not re.search(r';\s*q=0(?:\.0*)?\s*$', part)
                      for part in self.headers.get('Accept-Encoding', '').split(','))
        compress = path.suffix in ('.svg', '.js', '.css', '.html') and gzip_ok
        headers = {'Vary': 'Accept-Encoding'}
        cache = 'private, max-age=31536000, immutable' if immutable else 'no-cache'
        headers['ETag'] = '"' + hashlib.sha256(f'{path}:{stat.st_mtime_ns}:{stat.st_size}:{compress}'.encode()).hexdigest()[:32] + '"'
        if headers['ETag'] in [t.strip() for t in self.headers.get('If-None-Match', '').split(',')]:
            return self.send(b'', 304, content_type, cache, headers)
        if compress:
            headers['Content-Encoding'] = 'gzip'
            return self.send(gzipped(str(path), stat.st_mtime_ns, stat.st_size), 200, content_type, cache, headers)
        return self.send(path.read_bytes(), 200, content_type, cache, headers)

    def check_origin(self):
        port = self.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in hosts:
            raise PermissionError('Only requests to localhost are accepted.')
        origin = self.headers.get('Origin')
        if origin and origin not in {'http://' + h for h in hosts}:
            raise PermissionError('Cross-origin requests are not accepted.')

    def respond(self, handler):
        self.app.activity = time.monotonic()
        try:
            self.check_origin()
            result = handler()
            if result is not None:
                self.send(result)
        except PermissionError as error:
            self.send({'error': str(error)}, 403)
        except LookupError as error:
            self.send({'error': str(error).strip("'\"")}, 404)
        except LockBusy:
            self.send({'error': 'Another operation is in progress. Try again.'}, 409)
        except EXPECTED as error:
            self.send({'error': str(error)}, 400)
        except Exception as error:
            self.log_error('Unexpected error: %r', error)
            self.send({'error': f'Internal error: {type(error).__name__}: {error}'}, 500)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.respond(self.get)

    def do_POST(self):
        self.respond(self.post)

    def get(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        app = self.app
        if path in STATIC:
            return self.send_file(WEB / STATIC[path])
        if path == '/api/info':
            return {'root': str(app.root), 'version': code_version(), 'pid': os.getpid(),
                    'busy': app.publisher.busy(), 'csrf': app.csrf}
        if path == '/api/tasks':
            return {'tasks': app.tasks_overview(), 'csrf': app.csrf}
        parts = path.strip('/').split('/')
        if parts[:2] == ['api', 'jobs'] and len(parts) == 3:
            job = app.publisher.job(parts[2])
            return {'id': job['id'], 'task': job['task'], 'status': job['status'], 'phase': job['phase'],
                    **job['result']}
        if parts[:2] == ['api', 'tasks'] and len(parts) >= 3:
            name, rest = parts[2], parts[3:]
            if rest == []:
                return app.task_info(name)
            if rest == ['state']:
                number = query.get('round', [''])[0]
                return app.review.page_state(name, int(number) if number.isdigit() else None)
            if rest == ['feedback']:
                after = query.get('after', ['0'])[0]
                return app.review.feedback(name, int(after) if after.isdigit() else 0)
            if len(rest) == 2 and rest[0] == 'rounds' and rest[1].isdigit():
                return app.review.round_detail(name, int(rest[1]))
        if parts[0] == 'files' and len(parts) == 4 and parts[2].isdigit() and ASSET.fullmatch(parts[3]):
            app.tasks.get(parts[1], open_only=False)
            target = app.state / 'rounds' / parts[1] / f'{int(parts[2]):03}' / parts[3]
            if not target.is_file():
                raise LookupError('No such file')
            return self.send_file(target, immutable=True)
        raise LookupError('Not found')

    def post(self):
        app = self.app
        if not secrets.compare_digest(self.headers.get('X-Review-Token', ''), app.csrf):
            raise PermissionError('This page is out of date. Reload it.')
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 <= length < 1_000_000:
            raise ValueError('Request too large.')
        data = json.loads(self.rfile.read(length) or b'{}')
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        parts = urlparse(self.path).path.strip('/').split('/')
        if parts == ['api', 'shutdown']:
            if app.publisher.busy() and not data.get('force'):
                raise ValueError('A round is being built. Stop after it finishes, or force the stop.')
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return {'ok': True}
        if parts == ['api', 'tasks']:
            sections, files = data.get('sections') or [], data.get('files') or []
            if not all(isinstance(v, str) for v in [*sections, *files]):
                raise ValueError('Sections and files must be strings.')
            task = app.tasks.create(data.get('name'), data.get('title'), sections, files)
            return app.task_info(task['name'])
        if parts[:2] != ['api', 'tasks'] or len(parts) != 4:
            raise LookupError('Not found')
        name, action = parts[2], parts[3]
        if action == 'publish':
            job = app.publisher.submit(name)
            return {'job': job['id'], 'status': job['status']}
        if action == 'decide':
            return app.review.decide(name, data)
        if action == 'undo':
            return app.review.undo(name, str(data.get('id', '')))
        if action == 'note':
            return app.review.note(name, data.get('body'))
        if action == 'finish':
            result = app.tasks.finish(name, bool(data.get('force')))
            return {'task': name, 'finished': True, 'changed_files': result['changed'],
                    'discarded': {k: v for k, v in result['discarded'].items() if k in ('pending', 'commented') and v}}
        raise LookupError('Not found')


def serve(root, port=0, idle=IDLE_TIMEOUT):
    """Run the server for one repository until it is idle for `idle` seconds or stopped."""
    root = Repo(root).toplevel()
    state = Repo(root).git_dir() / 'latex-review' / 'server'
    try:
        with locked(state / 'server.lock', blocking=False):
            app = App(root)
            try:
                server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            except OSError:
                server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            server.daemon_threads = True
            server.app = app
            app.url = f'http://127.0.0.1:{server.server_port}'
            info = {'url': app.url, 'port': server.server_port, 'pid': os.getpid(), 'version': code_version(),
                    'root': str(root)}
            write_json(state / 'connection.json', info, mode=0o600)
            write_json(state / 'last.json', {'port': server.server_port})

            def watchdog():
                while True:
                    time.sleep(30)
                    if time.monotonic() - app.activity > idle and not app.publisher.busy():
                        server.shutdown()
                        return

            threading.Thread(target=watchdog, daemon=True).start()
            signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
            print(json.dumps(info), flush=True)
            try:
                server.serve_forever()
            finally:
                app.publisher.stop()
                stop_all()
                server.server_close()
                # A newer server for a repository at the same path may own the file by now.
                if (read_json(state / 'connection.json') or {}).get('pid') == os.getpid():
                    (state / 'connection.json').unlink(missing_ok=True)
    except LockBusy:
        print(json.dumps({'error': 'A review server is already running for this repository.'}), file=sys.stderr)
        sys.exit(2)
