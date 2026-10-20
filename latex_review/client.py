"""Find or start the review server of a repository, and talk to it."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from . import SKILL_ROOT, code_version
from .files import LockBusy, locked, read_json
from .git import Repo

START_TIMEOUT = 30


class ServerError(RuntimeError):
    pass


def call(url, path, data=None, token='', timeout=30):
    body = None if data is None else json.dumps(data).encode()
    request = Request(url + path, body, {'Content-Type': 'application/json', 'X-Review-Token': token})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.load(error).get('error')
        except ValueError:
            message = None
        raise ServerError(message or f'HTTP {error.code}') from None


class Client:
    def __init__(self, url, token):
        self.url, self.token = url, token

    def get(self, path, timeout=30):
        return call(self.url, path, timeout=timeout)

    def post(self, path, data=None, timeout=120):
        return call(self.url, path, data or {}, self.token, timeout)


def server_home(root):
    return Repo(root).git_dir() / 'latex-review' / 'server'


def probe(root, info):
    """Ask the server recorded in `info` who it is; None when it does not answer as ours."""
    if not info:
        return None
    address = urlparse(info.get('url', ''))
    if address.scheme != 'http' or address.hostname != '127.0.0.1':
        return None
    try:
        answer = call(info['url'], '/api/info', timeout=5)
    except (OSError, ServerError, ValueError, URLError):
        return None
    if Path(answer.get('root', '')).resolve() != Path(root).resolve():
        return None
    return answer


def connect(root, start=True):
    """A client for the repository's server, starting or upgrading it when needed."""
    root = Path(root).resolve()
    home = server_home(root)
    with locked(home / 'start.lock'):
        info = read_json(home / 'connection.json')
        if not info and read_json(home / 'last.json'):
            # The connection file can go missing; the last port may still answer.
            info = {'url': f"http://127.0.0.1:{read_json(home / 'last.json')['port']}"}
        answer = probe(root, info)
        if answer and (answer['version'] == code_version() or not start):
            return Client(info['url'], answer['csrf'])
        if not start:
            return None
        if answer:
            retire(home, {**info, 'pid': answer['pid'], 'root': str(root)}, answer)
        else:
            clear_stale(home, info)
        return launch(root, home, (info or read_json(home / 'last.json') or {}).get('port', 0))


def stop(root, force=False):
    """Stop the repository's server and wait until it has exited. Returns its URL, or None."""
    client = connect(root, start=False)
    if not client:
        return None
    answer = client.get('/api/info')
    client.post('/api/shutdown', {'force': force})
    wait_for_exit(server_home(root), answer['pid'])
    return client.url


def retire(home, info, answer):
    """Stop a server running older code, once it is not building anything."""
    deadline = time.monotonic() + 900
    while answer.get('busy') and time.monotonic() < deadline:
        time.sleep(2)
        answer = probe(info['root'], info) or {}
    try:
        call(info['url'], '/api/shutdown', {}, answer.get('csrf', ''), timeout=5)
    except (OSError, ServerError, URLError):
        pass
    wait_for_exit(home, info.get('pid'))


def clear_stale(home, info):
    """A server that holds the lock but does not answer is stuck; stop it."""
    try:
        with locked(home / 'server.lock', blocking=False):
            return
    except LockBusy:
        pass
    wait_for_exit(home, (info or {}).get('pid'), patience=5)


def wait_for_exit(home, pid, patience=20):
    deadline = time.monotonic() + patience
    while time.monotonic() < deadline:
        try:
            with locked(home / 'server.lock', blocking=False):
                return
        except LockBusy:
            time.sleep(.2)
    if pid and is_review_server(pid):
        os.kill(pid, signal.SIGTERM)
        time.sleep(1)
        if is_review_server(pid):
            os.kill(pid, signal.SIGKILL)
        time.sleep(.3)


def is_review_server(pid):
    try:
        command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
    except OSError:
        return False
    return 'latex_review' in command and ' serve' in command


def launch(root, home, port):
    home.mkdir(parents=True, exist_ok=True)
    log = home / 'server.log'
    if log.exists() and log.stat().st_size > 2_000_000:
        log.replace(home / 'server.log.1')
    with open(log, 'a') as output:
        process = subprocess.Popen([sys.executable, '-m', 'latex_review', 'serve', '--root', str(root),
                                    '--port', str(port)],
                                   cwd=SKILL_ROOT, env={**os.environ, 'PYTHONPATH': str(SKILL_ROOT)},
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
    deadline = time.monotonic() + START_TIMEOUT
    while time.monotonic() < deadline:
        info = read_json(home / 'connection.json')
        if info and info.get('pid') == process.pid:
            answer = probe(root, info)
            if answer:
                return Client(info['url'], answer['csrf'])
        if process.poll() is not None:
            tail = log.read_text(errors='replace')[-1500:]
            raise ServerError('The review server failed to start:\n' + tail)
        time.sleep(.1)
    raise ServerError(f'The review server did not start within {START_TIMEOUT}s. Log: {log}')
