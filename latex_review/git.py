"""Git plumbing. Snapshots and private commits never touch the user's index, HEAD or branches."""
from functools import cache
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

IDENTITY = {'GIT_AUTHOR_NAME': 'latex-review', 'GIT_AUTHOR_EMAIL': 'latex-review@localhost',
            'GIT_COMMITTER_NAME': 'latex-review', 'GIT_COMMITTER_EMAIL': 'latex-review@localhost'}


class GitError(RuntimeError):
    pass


@cache
def git_binary():
    """The git executable itself, skipping wrappers such as macOS's /usr/bin/git shim."""
    git = shutil.which('git') or 'git'
    try:
        real = subprocess.run([git, '--exec-path'], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return git
    candidate = os.path.join(real, 'git')
    return candidate if real and os.access(candidate, os.X_OK) else git


def within(path, scopes):
    """Whether a repository path lies inside any scope; '' covers everything."""
    return any(scope in ('', '.') or path == scope or path.startswith(scope.rstrip('/') + '/')
               for scope in scopes)


def clean_path(value):
    """Normalize a repository-relative path, refusing anything that escapes the repository."""
    path = PurePosixPath(str(value).replace('\\', '/'))
    if path.is_absolute() or '..' in path.parts or (path.parts and path.parts[0] == '.git'):
        raise ValueError(f'Use a repository-relative path: {value}')
    return '' if str(path) == '.' else path.as_posix().rstrip('/')


class Repo:
    def __init__(self, path):
        self.path = Path(path)

    def run(self, *args, input=None, env=None, check=True, timeout=300):
        result = subprocess.run([git_binary(), '-c', 'core.quotepath=off', '--literal-pathspecs', *args],
                                cwd=self.path, input=input, env=env, capture_output=True, timeout=timeout)
        if check and result.returncode:
            message = result.stderr.decode(errors='replace').strip()
            raise GitError(message or f'git {args[0]} failed with exit code {result.returncode}')
        return result.stdout

    def text(self, *args, **options):
        return self.run(*args, **options).decode().strip()

    def toplevel(self):
        return Path(self.text('rev-parse', '--show-toplevel')).resolve()

    def git_dir(self):
        return Path(self.text('rev-parse', '--absolute-git-dir')).resolve()

    def rev(self, name):
        return self.text('rev-parse', '--verify', '--quiet', name + '^{commit}')

    def has_head(self):
        return self.run('rev-parse', '--verify', '--quiet', 'HEAD^{commit}', check=False) != b''

    def blob(self, rev, path):
        """The file at `rev`, or None when it does not exist there."""
        return self.read([(rev, path)])[(rev, path)]

    def blobs(self, rev, paths):
        """Several files at one revision: {path: bytes or None}."""
        return {path: data for (_, path), data in self.read([(rev, p) for p in paths]).items()}

    def read(self, specs):
        """Files at revisions in one call: {(rev, path): bytes or None}."""
        specs = list(dict.fromkeys(specs))
        if not specs:
            return {}
        output = self.run('cat-file', '--batch', input=''.join(f'{rev}:{p}\n' for rev, p in specs).encode())
        result, position = {}, 0
        for spec in specs:
            end = output.index(b'\n', position)
            header = output[position:end].split()
            position = end + 1
            if len(header) == 3 and header[1] == b'blob':
                size = int(header[2])
                result[spec] = output[position:position + size]
                position += size + 1
            else:
                result[spec] = None
                if len(header) == 3:  # A tree or another object: skip its contents.
                    position += int(header[2]) + 1
        return result

    def files(self, rev, path=''):
        """Repository paths of all files below `path` at `rev`."""
        args = ['ls-tree', '-r', '-z', '--name-only', rev] + (['--', path] if path else [])
        return [p.decode() for p in self.run(*args).split(b'\0') if p]

    def changed_files(self, before, after):
        output = self.run('diff', '--name-only', '--no-renames', '-z', before, after)
        return [p.decode() for p in output.split(b'\0') if p]

    def mode(self, rev, path):
        entry = self.text('ls-tree', rev, '--', path).split()
        return entry[0] if entry else None

    def tree_id(self, rev, path=''):
        return self.text('rev-parse', f'{rev}:{path}' if path else f'{rev}^{{tree}}')

    def hash_object(self, data):
        return self.text('hash-object', '-w', '--stdin', input=data)

    def commit_tree(self, tree, parent, message):
        parents = ['-p', parent] if parent else []
        return self.text('commit-tree', '--no-gpg-sign', tree, *parents, '-m', message,
                         env={**os.environ, **IDENTITY})

    def update_ref(self, ref, value):
        self.run('update-ref', ref, value)

    def delete_refs(self, prefix):
        refs = self.text('for-each-ref', '--format=%(refname)', prefix).splitlines()
        if refs:
            self.run('update-ref', '--stdin', input=''.join(f'delete {r}\n' for r in refs).encode())

    def snapshot(self, include=(), exclude=()):
        """Commit the working tree as it is now, with untracked files under `include`.

        Untracked files ending in one of `exclude` are left out. A private index keeps
        the user's staging area, HEAD and branches untouched.
        """
        head = self.rev('HEAD')
        staged_new = [p for p in self.run('diff', '--cached', '--name-only', '--diff-filter=A', '-z').split(b'\0') if p]
        with tempfile.TemporaryDirectory(prefix='latex-review-index-') as temporary:
            env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index')}

            def capture():
                self.run('read-tree', head, env=env)
                self.run('add', '-u', env=env)
                untracked = self.run('ls-files', '--others', '--exclude-standard', '-z', env=env).split(b'\0')
                chosen = {p for p in untracked if p and within(p.decode(), include)
                          and not p.decode().endswith(tuple(exclude))}
                chosen |= {p for p in staged_new if (self.path / p.decode()).is_file()}
                if chosen:
                    self.run('add', '--pathspec-from-file=-', '--pathspec-file-nul', env=env,
                             input=b'\0'.join(sorted(chosen)) + b'\0')
                return self.text('write-tree', env=env)

            tree = capture()
            if tree != capture() or head != self.rev('HEAD'):
                raise GitError('Files changed while the snapshot was taken. Wait for saves to finish and retry.')
        return self.commit_tree(tree, head, 'latex-review snapshot')

    def commit_with(self, parent, contents, message):
        """A private commit: `parent` with some files replaced (bytes) or removed (None)."""
        with tempfile.TemporaryDirectory(prefix='latex-review-index-') as temporary:
            env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
            self.run('read-tree', parent, env=env)
            for path, data in sorted(contents.items()):
                if data is None:
                    self.run('update-index', '--force-remove', '--', path, env=env)
                else:
                    oid = self.hash_object(data)
                    mode = self.mode(parent, path) or '100644'
                    self.run('update-index', '--add', '--cacheinfo', f'{mode},{oid},{path}', env=env)
            tree = self.text('write-tree', env=env)
        return self.commit_tree(tree, parent, message)

    def export(self, rev, path, destination):
        """Write the tree `rev:path` into `destination`, refusing links that leave it."""
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        spec = f'{rev}:{path}' if path else rev
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen([git_binary(), 'archive', '--format=tar', spec], cwd=self.path,
                                       stdout=subprocess.PIPE, stderr=errors)
            try:
                with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
                    for member in archive:
                        check_member(member)
                        if hasattr(tarfile, 'data_filter'):
                            archive.extract(member, destination, filter='data')
                        else:
                            archive.extract(member, destination)
            except BaseException:
                process.kill()
                process.wait()
                raise
            finally:
                process.stdout.close()
            if process.wait():
                errors.seek(0)
                raise GitError(errors.read().decode(errors='replace').strip() or 'git archive failed')


def check_member(member):
    name = PurePosixPath(member.name)
    if name.is_absolute() or '..' in name.parts:
        raise GitError('Unsafe path in snapshot: ' + member.name)
    if member.issym() or member.islnk():
        target = os.path.normpath((name.parent / member.linkname).as_posix())
        if PurePosixPath(member.linkname).is_absolute() or target.split('/')[0] == '..':
            raise GitError('A link in the snapshot points outside the document: ' + member.name)


def merge3(ours, base, theirs):
    """Three-way merge of file contents. Returns (result, conflict); None means deleted."""
    if ours == base or ours == theirs:
        return theirs, False
    if theirs == base:
        return ours, False
    if ours is None or base is None or theirs is None or any(b'\0' in x for x in (ours, base, theirs)):
        return None, True
    with tempfile.TemporaryDirectory(prefix='latex-review-merge-') as temporary:
        paths = [Path(temporary) / name for name in ('ours', 'base', 'theirs')]
        for path, data in zip(paths, (ours, base, theirs)):
            path.write_bytes(data)
        result = subprocess.run([git_binary(), 'merge-file', '-p', *map(str, paths)], capture_output=True)
        return result.stdout, result.returncode != 0
