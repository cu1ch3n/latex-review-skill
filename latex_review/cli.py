"""Agent-facing command line. Every command prints one JSON object; failures exit with status 1."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.parse import quote
import webbrowser

from . import SKILL_ROOT
from .client import ServerError, connect, server_home, stop
from .config import ENGINES, ConfigError
from .files import LockBusy, atomic_write
from .git import GitError
from .publish import PublishError, render_command
from .tasks import task_marker

USAGE = '''First time: review.py doctor
Typical loop (run from the document repository, then from the task worktree):
  review.py start polish-intro --section 1.2 --title "Polish the introduction"
  review.py publish              # build and show the PDF diff; prints the review URL
  review.py feedback --wait 300  # wait until the user has reviewed the round
  review.py finish               # remove the worktree once everything is decided'''


class Failure(RuntimeError):
    def __init__(self, payload):
        super().__init__(payload.get('error', ''))
        self.payload = payload


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')))


def resolve(args):
    """The integration root and, when known, the task this command is about."""
    try:
        root, task = task_marker(args.repo)
    except GitError:
        raise Failure({'error': f'{args.repo} is not inside a Git repository.'}) from None
    if args.task and task and args.task != task:
        raise Failure({'error': f'This worktree belongs to task {task!r}; run other tasks from the main repository.'})
    return root, args.task or task


def require_task(task):
    if not task:
        raise Failure({'error': 'Run this inside a task worktree, or pass --task NAME.'})
    return task


def cursor_file(root, task):
    return server_home(root).parent / 'agents' / (task + '.cursor')


def doctor():
    """Check the tools the skill needs, and install the renderer's packages ahead of time."""
    mac = sys.platform == 'darwin'
    tex_hint = ('Install MacTeX (brew install --cask mactex-no-gui), or BasicTeX plus `sudo tlmgr install latexmk`.'
                if mac else 'Install TeX Live, e.g. `sudo apt install latexmk texlive-latex-recommended`.')
    checks = []

    def check(name, ok, detail='', hint=''):
        checks.append({'name': name, 'ok': bool(ok), 'detail': detail, **({'hint': hint} if not ok else {})})

    def version(tool):
        try:
            output = subprocess.run([tool, '--version'], capture_output=True, text=True, timeout=30).stdout
        except (OSError, subprocess.SubprocessError):
            return ''
        return output.strip().split('\n')[0][:80]

    check('platform', os.name == 'posix', sys.platform, 'macOS and Linux are supported; on Windows, use WSL.')
    check('python', sys.version_info >= (3, 10), platform.python_version(), 'Install Python 3.10 or newer.')
    for tool, hint in (('git', 'Install Git.'), ('latexmk', tex_hint), ('synctex', tex_hint)):
        check(tool, shutil.which(tool), version(tool) if shutil.which(tool) else 'not found', hint)
    engines = [engine for engine in ENGINES if shutil.which(engine)]
    check('tex engines', engines, ', '.join(engines) or 'none found', tex_hint)
    try:
        command = render_command()
        result = subprocess.run([*command, '-c', 'import pymupdf, PIL; print(pymupdf.VersionBind)'],
                                cwd=Path.home(), capture_output=True, text=True, timeout=900)
        check('pdf renderer', result.returncode == 0, ('PyMuPDF ' + result.stdout.strip()) if result.returncode == 0
              else result.stderr.strip()[-300:], 'Check that uv can download packages, then run doctor again.')
    except PublishError as error:
        check('pdf renderer', False, str(error), 'Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh'
              + (' (or brew install uv)' if mac else ''))
    ok = all(c['ok'] for c in checks)
    return {'ok': ok, 'checks': checks,
            'next': f'Ready. Try the example: python3 {SKILL_ROOT / "examples" / "demo.py"}' if ok
            else 'Fix the failed checks above, then run doctor again.'}


def start(client, root, task, args):
    if task and (args.name or args.section or args.file):
        if args.name and args.name != task:
            raise Failure({'error': f'This worktree already belongs to task {task!r}. Run `start` without '
                                    'arguments to attach, or start new tasks from the main repository.'})
    if not task:
        info = client.post('/api/tasks', {'name': args.name, 'title': args.title, 'sections': args.section,
                                          'files': args.file})
        task = info['task']
    else:
        info = client.get(f'/api/tasks/{quote(task)}')
    if info['state'] == 'editing':
        info['next'] = f"Edit only inside {info['worktree']}, then run `publish` from there."
    if args.open:
        webbrowser.open(info['url'])
    return info


def publish(client, root, task, args):
    job = client.post(f'/api/tasks/{quote(task)}/publish')
    if args.no_wait:
        return {'task': task, 'job': job['job'], 'status': job['status'],
                'next': 'The round is building. Run `status` or `publish` again later.'}
    deadline = time.monotonic() + args.timeout
    while True:
        result = client.get('/api/jobs/' + job['job'])
        if result['status'] in ('done', 'failed'):
            break
        if time.monotonic() > deadline:
            return {'task': task, 'job': job['job'], 'status': 'building', 'phase': result['phase'],
                    'next': 'Still building. Run `publish` again to keep waiting.'}
        time.sleep(1)
    info = client.get(f'/api/tasks/{quote(task)}')
    if result['status'] == 'failed':
        raise Failure({'task': task, 'error': result.get('error'), 'details': result.get('details', []),
                       **({'log': result['log']} if result.get('log') else {}), 'next': result.get('next', '')})
    value = {'task': task, 'round': result['round'], 'changes': result['changes'], 'url': info['url'],
             'viewing': info['viewing']}
    if result['outcome'] == 'published':
        value.update(kinds=result['kinds'], warnings=result['warnings'])
        value['next'] = (f"Ask the user to review round {result['round']} at {info['url']}"
                         + (' (the page is open and updates by itself)' if info['viewing'] else '')
                         + ', then run `feedback --wait 300`.')
        if args.open and not info['viewing']:
            webbrowser.open(info['url'])
    elif result['outcome'] == 'unchanged':
        value.update(message=f"Nothing new since round {result['round']}.", next=info['next'])
    else:
        value.update(message='The worktree matches the accepted text; there is nothing to review.',
                     next=info['next'])
    return value


def feedback(client, root, task, args):
    path = cursor_file(root, task)
    after = 0 if args.all else int((path.read_text().strip() if path.exists() else '') or 0)
    deadline = time.monotonic() + args.wait
    while True:
        try:
            value = client.get(f'/api/tasks/{quote(task)}/feedback?after={after}')
        except (URLError, ConnectionError):
            time.sleep(2)
            client = connect(root)
            continue
        if value['state'] not in ('reviewing', 'building') or time.monotonic() >= deadline:
            break
        time.sleep(min(2, max(.1, deadline - time.monotonic())))
    if value['state'] in ('reviewing', 'building') and args.wait:
        value['waited'] = args.wait
    info = client.get(f'/api/tasks/{quote(task)}')
    value['url'] = info['url']
    emit(value)  # Print before moving the cursor, so an interrupted read is delivered again.
    if not args.all:
        atomic_write(path, str(value['cursor']))


def main(argv=None):
    parser = argparse.ArgumentParser(prog='review.py', description='Review LaTeX edits as PDF diffs.',
                                     epilog=USAGE, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', type=Path, default=Path.cwd(), help='Document repository or task worktree')
    parser.add_argument('--task', help='Task name, when running outside its worktree')
    commands = parser.add_subparsers(dest='command', required=True, metavar='COMMAND')
    command = commands.add_parser('start', help='Create a task worktree, or attach to the current one')
    command.add_argument('name', nargs='?', help='lowercase-with-hyphens; derived from --title if omitted')
    command.add_argument('--section', action='append', default=[], help='Section number, exact title or label')
    command.add_argument('--file', action='append', default=[], help='Repository-relative file or folder')
    command.add_argument('--title', help='Short description shown on the review page')
    command.add_argument('--open', action='store_true', help='Open the review page in a browser')
    command = commands.add_parser('publish', help='Build the PDF diff of the worktree for review')
    command.add_argument('--no-wait', action='store_true', help='Return as soon as the build is queued')
    command.add_argument('--timeout', type=float, default=900, help='Seconds to wait for the build')
    command.add_argument('--open', action='store_true', help='Open the review page unless it is already open')
    command = commands.add_parser('feedback', help='New decisions and comments from the user')
    command.add_argument('--wait', type=float, default=0, help='Wait up to this many seconds for the review')
    command.add_argument('--all', action='store_true', help='Repeat all feedback instead of only new items')
    commands.add_parser('status', help='Where the task stands and what to do next')
    command = commands.add_parser('finish', help='Remove the task worktree after the review')
    command.add_argument('--force', action='store_true', help='Discard undecided or unpublished changes')
    commands.add_parser('list', help='Open tasks of this repository')
    commands.add_parser('doctor', help='Check the required tools and prepare the PDF renderer')
    command = commands.add_parser('server', help='Show or stop the review server')
    command.add_argument('action', choices=['status', 'stop'])
    command.add_argument('--force', action='store_true', help='Stop even while a round is being built')
    command = commands.add_parser('serve', help=argparse.SUPPRESS)
    command.add_argument('--root', type=Path, required=True)
    command.add_argument('--port', type=int, default=0)
    command.add_argument('--idle', type=float)
    args = parser.parse_args(argv)
    if args.command == 'serve':
        from .server import IDLE_TIMEOUT, serve
        return serve(args.root, args.port, args.idle or IDLE_TIMEOUT)
    if args.command == 'doctor':
        result = doctor()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result['ok'] else 1)
    try:
        root, task = resolve(args)
        if args.command == 'server':
            if args.action == 'stop':
                url = stop(root, args.force)
                return emit({'running': False, **({'stopped': url} if url else {})})
            client = connect(root, start=False)
            if not client:
                return emit({'running': False})
            return emit({'running': True, **client.get('/api/info'), 'csrf': None})
        client = connect(root)
        if args.command == 'start':
            return emit(start(client, root, task, args))
        if args.command == 'list':
            return emit({'tasks': client.get('/api/tasks')['tasks']})
        task = require_task(task)
        if args.command == 'publish':
            return emit(publish(client, root, task, args))
        if args.command == 'feedback':
            if not 0 <= args.wait <= 3600:
                raise Failure({'error': '--wait must be between 0 and 3600 seconds.'})
            return feedback(client, root, task, args)
        if args.command == 'status':
            return emit(client.get(f'/api/tasks/{quote(task)}'))
        if args.command == 'finish':
            result = client.post(f'/api/tasks/{quote(task)}/finish', {'force': args.force})
            result['next'] = ((f'The accepted changes are in {root}, not committed. ' if result['changed_files'] else
                               'No changes were accepted; the manuscript is unchanged. ') +
                              'Do not edit the removed worktree again.')
            return emit(result)
    except Failure as failure:
        emit(failure.payload)
    except (ServerError, ConfigError, GitError, LockBusy, ValueError, LookupError, OSError) as error:
        emit({'error': str(error)})
    sys.exit(1)
