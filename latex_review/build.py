"""Compile frozen snapshots with latexmk. Builds are cached by source tree and never touch live files."""
from functools import cache
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import signal
import subprocess
import time

from .files import locked, read_json, write_json
from .outline import strip_comments

AUXILIARY = {'.aux', '.bbl', '.brf', '.toc', '.lof', '.lot', '.loe', '.out', '.thm'}
INCLUDE = re.compile(r'^\s*\\include\{([^}]+)\}', re.M)
INPUT = re.compile(r'\\(?:input|include|subfile)\{([^}]+)\}')
FILE_LINE_ERROR = re.compile(r'^(\S[^:\n]*):(\d+): (.+)$')
WARNINGS = [
    (re.compile(r"LaTeX Warning: Reference `([^']+)' on page"), 'Undefined reference: {}'),
    (re.compile(r"Warning: Citation [`']([^']+)' on page"), 'Undefined citation: {}'),
    (re.compile(r"LaTeX Warning: Label `([^']+)' multiply defined"), 'Label defined twice: {}'),
    (re.compile(r'Missing character: There is no (\S+)'), 'Missing glyph: {}'),
]
BUILD_TIMEOUT = 1800


class BuildError(RuntimeError):
    def __init__(self, message, details=(), log=None):
        super().__init__(message)
        self.details, self.log = list(details), log


@cache
def tex_version(engine):
    try:
        return subprocess.run([engine, '--version'], capture_output=True, text=True, timeout=60).stdout.split('\n')[0]
    except OSError:
        raise BuildError(f'{engine} was not found. Install TeX Live (or MacTeX) with latexmk.') from None


def includes(main_text):
    """\\include targets of the root document, in order."""
    return [name.strip() for name in INCLUDE.findall(strip_comments(main_text))]


def affected_targets(texts, changed, include_list):
    """The \\include targets whose output depends on the changed files, or ['full'].

    `texts` maps paths relative to the document folder to source text.
    """
    owners = {}

    def visit(name, target, seen):
        name = name if posixpath.splitext(name)[1] else name + '.tex'
        if name in seen or name not in texts:
            return
        seen.add(name)
        owners.setdefault(name, set()).add(target)
        for child in INPUT.findall(strip_comments(texts[name])):
            visit(posixpath.normpath(child.strip()), target, seen)

    for target in include_list:
        visit(target, target, set())
    selected = set()
    for name in changed:
        if name not in owners:
            return ['full']
        selected |= owners[name]
    return sorted(selected)


class Builder:
    """Compiles snapshots of one project into the cache under its state directory."""

    def __init__(self, project, repo):
        self.project, self.repo = project, repo
        self.cache = project.state / 'cache' / 'builds'

    def document_texts(self, rev):
        """Every .tex file of the document folder at `rev`, keyed by path inside that folder."""
        doc = self.project.doc_dir
        paths = [p for p in self.repo.files(rev, doc) if p.endswith('.tex')]
        prefix = doc + '/' if doc else ''
        return {p[len(prefix):]: (data or b'').decode(errors='replace')
                for p, data in self.repo.blobs(rev, paths).items()}

    def plan(self, before, after, changed):
        """Targets to compile for a comparison: a list of \\include names, or ['full']."""
        main = posixpath.basename(self.project.main)
        doc = self.project.doc_dir
        old, new = self.document_texts(before), self.document_texts(after)
        targets = includes(new.get(main, ''))
        if not self.project.partial_builds or len(targets) < 2 or targets != includes(old.get(main, '')):
            return ['full']
        local = []
        for path in changed:
            if doc and not path.startswith(doc + '/'):
                return ['full']
            local.append(path[len(doc) + 1:] if doc else path)
        selected = set(affected_targets(old, local, targets)) | set(affected_targets(new, local, targets))
        if 'full' in selected or not selected:
            return ['full']
        for name in list(selected):
            selected.update(self.project.dependencies.get(name, []))
        return [t for t in targets if t in selected]

    def build(self, rev, targets=('full',), seed=None):
        """Compile `rev` (all of it, or only some \\include targets on top of a full `seed`)."""
        project = self.project
        targets = list(targets)
        partial = targets != ['full']
        if partial and not seed:
            raise BuildError('A partial build needs a completed full build to start from.')
        tree = self.repo.tree_id(rev, project.source_dir)
        key = hashlib.sha256(json.dumps([
            tree, targets, seed and seed['key'], project.signature(), tex_version(project.engine),
            hashlib.sha256(Path(__file__).read_bytes()).hexdigest()]).encode()).hexdigest()[:32]
        folder = self.cache / key
        with locked(self.cache / (key + '.lock')):
            result = read_json(folder / 'result.json')
            if result and Path(result['pdf']).is_file():
                os.utime(folder)
                return result
            shutil.rmtree(folder, ignore_errors=True)
            source = folder / 'src'
            self.repo.export(rev, project.source_dir, source)
            cwd = source / posixpath.relpath(project.doc_dir or '.', project.source_dir or '.')
            main = posixpath.basename(project.main)
            job = posixpath.splitext(main)[0]
            out = cwd / 'build'
            # \include writes one .aux per target next to its own path in the output folder.
            text = (cwd / main).read_text(errors='replace') if (cwd / main).is_file() else ''
            for target in includes(text):
                (out / posixpath.dirname(target)).mkdir(parents=True, exist_ok=True)
            out.mkdir(parents=True, exist_ok=True)
            command = ['latexmk', '-norc']
            if project.latexmkrc:
                command += ['-r', posixpath.relpath(project.latexmkrc, project.doc_dir or '.')]
            command += [{'pdflatex': '-pdf', 'xelatex': '-xelatex', 'lualatex': '-lualatex'}[project.engine],
                        '-outdir=build', f'-jobname={job}', '-synctex=1', '-interaction=nonstopmode',
                        '-halt-on-error', '-file-line-error']
            if partial:
                seed_out = Path(seed['pdf']).parent
                for path in seed_out.rglob('*'):
                    if path.is_file() and path.suffix in AUXILIARY:
                        target = out / path.relative_to(seed_out)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if not target.exists():
                            shutil.copyfile(path, target)
                preload = ''.join(r'\input{' + file + '}' for name, file in project.preload.items()
                                  if name not in targets and (cwd / file).is_file())
                command.append(r'-usepretex=\includeonly{' + ','.join(targets) + '}' +
                               (r'\AtBeginDocument{' + preload + '}' if preload else ''))
            command.append(main)
            transcript = folder / 'latexmk.log'
            started = time.monotonic()
            code = run(command, cwd, transcript)
            pdf, log = out / (job + '.pdf'), out / (job + '.log')
            log_text = log.read_text(errors='replace') if log.is_file() else ''
            if code or not pdf.is_file():
                details = errors(log_text) or transcript.read_text(errors='replace').splitlines()[-25:]
                kept = project.state / 'logs' / (key + '.log')
                kept.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(log if log.is_file() else transcript, kept)
                shutil.rmtree(folder, ignore_errors=True)
                raise BuildError('LaTeX failed to compile.', details, str(kept))
            result = {'key': key, 'tree': tree, 'targets': targets, 'root': str(source), 'cwd': str(cwd),
                      'pdf': str(pdf), 'seconds': round(time.monotonic() - started, 1),
                      'warnings': warnings(log_text)}
            write_json(folder / 'result.json', result)
            return result

    def prune(self, keep, max_age=3 * 86400):
        """Delete cached builds that are not in `keep` and were not used recently."""
        if not self.cache.is_dir():
            return
        now = time.time()
        for folder in self.cache.iterdir():
            if folder.is_dir() and folder.name not in keep and now - folder.stat().st_mtime > max_age:
                with locked(self.cache / (folder.name + '.lock')):
                    shutil.rmtree(folder, ignore_errors=True)
                (self.cache / (folder.name + '.lock')).unlink(missing_ok=True)


RUNNING = set()


def run(command, cwd, transcript):
    """Run the compiler in its own process group, stopping the whole group on interruption."""
    with open(transcript, 'w') as log:
        try:
            process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
        except FileNotFoundError:
            raise BuildError('latexmk was not found. Install TeX Live (or MacTeX) with latexmk.') from None
        RUNNING.add(process)
        try:
            return process.wait(timeout=BUILD_TIMEOUT)
        except BaseException:
            stop(process)
            raise
        finally:
            RUNNING.discard(process)


def stop_all():
    """Stop running compilers, e.g. when the server exits."""
    for process in list(RUNNING):
        stop(process)


def stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        pass


def errors(log_text):
    """The first TeX errors, as 'file:line: message' plus the offending source line."""
    lines, result = log_text.splitlines(), []
    for index, line in enumerate(lines):
        match = FILE_LINE_ERROR.match(line)
        if match or line.startswith('! '):
            context = next((l.strip() for l in lines[index + 1:index + 8] if re.match(r'l\.\d+ ', l)), '')
            message = line[2:] if line.startswith('! ') else line
            result.append(message.removeprefix('./') + (f'  [{context}]' if context else ''))
            if len(result) >= 8:
                break
    return result


def warnings(log_text):
    found = []
    for pattern, template in WARNINGS:
        for match in pattern.finditer(log_text):
            found.append(template.format(match[1]))
    return sorted(set(found))
