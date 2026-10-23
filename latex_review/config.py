"""Find the document to build and read the optional per-project settings file."""
from dataclasses import dataclass
import json
import posixpath
from pathlib import Path
import re

from .git import Repo, clean_path, within

CONFIG_NAME = '.latex-review.json'
ENGINES = ('pdflatex', 'xelatex', 'lualatex')
SETTINGS = {'main', 'engine', 'latexmkrc', 'source_dir', 'partial_builds', 'preload',
            'dependencies', 'figures', 'worktrees', 'build_workers'}
SKIP_DIRS = {'build', 'out', 'output', 'node_modules', '__pycache__'}
PREFERRED = ('main', 'thesis', 'paper', 'manuscript', 'document', 'ms', 'article', 'report', 'book')
MAGIC = re.compile(r'^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)', re.I | re.M)
PDF_MODE = re.compile(r'^\s*\$pdf_mode\s*=\s*(\d)', re.M)
DEFAULT_FILES = re.compile(r'''@default_files\s*=\s*\(\s*['"]([^'"]+)['"]''')
DOCUMENT_CLASS = re.compile(r'^[^%\n]*\\documentclass', re.M)
XETEX_HINT = re.compile(r'^[^%\n]*(?:\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|xeCJK|unicode-math|polyglossia)\b'
                        r'|\\documentclass(?:\[[^\]]*\])?\{ctex)', re.M)


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Project:
    root: Path               # the integration working tree
    state: Path              # private review state, inside the Git directory
    main: str                # repository path of the root document
    engine: str
    latexmkrc: str | None    # repository path
    source_dir: str          # repository path exported for each build ('' = everything)
    partial_builds: bool     # allow \includeonly builds when the document uses \include
    preload: dict            # include target -> file to \input when that target is left out
    dependencies: dict       # include target -> targets that must be compiled with it
    figures: tuple           # repository paths whose files are reviewed as whole figures
    worktrees: Path          # parent directory of task worktrees
    build_workers: int = 1   # independent tasks built concurrently

    @property
    def doc_dir(self):
        return posixpath.dirname(self.main)

    def is_figure(self, path):
        return within(path, self.figures)

    def signature(self):
        """Settings that change build output."""
        return json.dumps([self.main, self.engine, self.latexmkrc, self.source_dir,
                           self.preload, self.dependencies], sort_keys=True)


def load_project(root):
    root = Path(root).resolve()
    state = Repo(root).git_dir() / 'latex-review'
    settings = {}
    path = root / CONFIG_NAME
    if path.exists():
        try:
            settings = json.loads(path.read_text())
        except ValueError as error:
            raise ConfigError(f'{CONFIG_NAME} is not valid JSON: {error}') from None
        if not isinstance(settings, dict):
            raise ConfigError(f'{CONFIG_NAME} must contain a JSON object.')
        unknown = sorted(set(settings) - SETTINGS)
        if unknown:
            raise ConfigError(f'Unknown settings in {CONFIG_NAME}: {", ".join(unknown)}')
    main = clean_path(settings['main']) if settings.get('main') else detect_main(root)
    if not (root / main).is_file():
        raise ConfigError(f'Root document not found: {main}')
    doc_dir = posixpath.dirname(main)
    rc = clean_path(settings['latexmkrc']) if settings.get('latexmkrc') else find_latexmkrc(root, doc_dir)
    engine = settings.get('engine') or detect_engine(root, main, rc)
    if engine not in ENGINES:
        raise ConfigError(f'"engine" must be one of {", ".join(ENGINES)}.')
    source_dir = clean_path(settings.get('source_dir', doc_dir))
    if not within(main, [source_dir]) or (rc and not within(rc, [source_dir])):
        raise ConfigError('"source_dir" must contain the root document and its latexmkrc.')
    preload, dependencies = settings.get('preload', {}), settings.get('dependencies', {})
    if not (isinstance(preload, dict) and all(isinstance(v, str) for v in preload.values())):
        raise ConfigError('"preload" maps include targets to files, e.g. {"chapters/two": "macros/two.tex"}.')
    if not (isinstance(dependencies, dict) and all(isinstance(v, list) for v in dependencies.values())):
        raise ConfigError('"dependencies" maps include targets to lists of include targets.')
    if 'figures' in settings:
        figures = tuple(clean_path(p) for p in settings['figures'])
    else:
        figures = tuple(posixpath.join(doc_dir, name) for name in ('figures', 'figs')
                        if (root / doc_dir / name).is_dir())
    worktrees = ((root / settings['worktrees']).resolve() if settings.get('worktrees')
                 else root.parent / (root.name + '-tasks'))
    if worktrees == root or root in worktrees.parents:
        raise ConfigError('"worktrees" must be outside the repository.')
    build_workers = settings.get('build_workers', 1)
    if type(build_workers) is not int or not 1 <= build_workers <= 8:
        raise ConfigError('"build_workers" must be an integer between 1 and 8.')
    return Project(root=root, state=state, main=main, engine=engine, latexmkrc=rc,
                   source_dir=source_dir, partial_builds=settings.get('partial_builds', True) is not False,
                   preload=preload, dependencies=dependencies, figures=figures, worktrees=worktrees,
                   build_workers=build_workers)


def candidate_dirs(root):
    yield root
    for directory in sorted(root.iterdir()):
        if directory.is_dir() and not directory.name.startswith('.') and directory.name not in SKIP_DIRS:
            yield directory


def detect_main(root):
    for directory in candidate_dirs(root):
        for name in ('latexmkrc', '.latexmkrc'):
            rc = directory / name
            match = rc.is_file() and DEFAULT_FILES.search(rc.read_text(errors='replace'))
            if match and (directory / match[1]).is_file():
                return (directory / match[1]).relative_to(root).as_posix()
    found = []
    for directory in candidate_dirs(root):
        for path in sorted(directory.glob('*.tex')):
            text = path.read_text(errors='replace')[:300_000]
            if DOCUMENT_CLASS.search(text) and '\\begin{document}' in text:
                found.append(path.relative_to(root).as_posix())
    if len(found) == 1:
        return found[0]
    if not found:
        raise ConfigError('No root document (a .tex file with \\documentclass) was found. '
                          f'Create {CONFIG_NAME} with {{"main": "path/to/main.tex"}}.')

    def rank(path):
        stem = posixpath.splitext(posixpath.basename(path))[0].lower()
        return (path.count('/'), PREFERRED.index(stem) if stem in PREFERRED else len(PREFERRED))

    best = sorted(found, key=rank)
    if rank(best[0]) < rank(best[1]) and rank(best[0])[1] < len(PREFERRED):
        return best[0]
    raise ConfigError(f'Several root documents were found ({", ".join(found[:6])}). '
                      f'Create {CONFIG_NAME} with {{"main": "{found[0]}"}}.')


def find_latexmkrc(root, doc_dir):
    for directory in dict.fromkeys([doc_dir, '']):
        for name in ('latexmkrc', '.latexmkrc'):
            path = posixpath.join(directory, name)
            if (root / path).is_file():
                return path
    return None


def detect_engine(root, main, rc):
    text = (root / main).read_text(errors='replace')
    magic = MAGIC.search('\n'.join(text.splitlines()[:40]))
    if magic:
        name = magic[1].lower()
        name = {'xetex': 'xelatex', 'luatex': 'lualatex', 'pdftex': 'pdflatex'}.get(name, name)
        if name in ENGINES:
            return name
    if rc:
        mode = PDF_MODE.search((root / rc).read_text(errors='replace'))
        if mode and mode[1] in '145':
            return {'1': 'pdflatex', '4': 'lualatex', '5': 'xelatex'}[mode[1]]
    return 'xelatex' if XETEX_HINT.search(text) else 'pdflatex'
