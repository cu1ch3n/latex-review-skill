#!/usr/bin/env python3
"""Try the review loop on a small example paper, playing the agent's part.

    python3 examples/demo.py            # set up, publish, open the review page
    python3 examples/demo.py --dir DIR  # keep the example repository in DIR

The script copies the example paper into a new Git repository, starts a task
scoped to its Design section, applies a few scripted "agent" edits in the
task's worktree, and publishes them. Review them in the browser, then run the
printed `feedback` command to see what an agent would receive.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
REVIEW = HERE.parent / 'scripts' / 'review.py'


def run(*args, cwd):
    result = subprocess.run([sys.executable, str(REVIEW), *args], cwd=cwd, capture_output=True, text=True)
    value = json.loads(result.stdout or '{}')
    if result.returncode:
        sys.exit(f"review.py {args[0]} failed: {value.get('error', result.stderr)}\n" +
                 '\n'.join(value.get('details', [])))
    return value


def git(*args, cwd):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dir', type=Path, help='Folder for the example repository (default: a temporary folder)')
    parser.add_argument('--no-open', action='store_true', help='Do not open the browser')
    args = parser.parse_args()
    missing = [tool for tool in ('git', 'latexmk', 'pdflatex', 'synctex') if not shutil.which(tool)]
    if missing:
        sys.exit('Missing: ' + ', '.join(missing) + '. Run `python3 scripts/review.py doctor` for install hints.')

    base = (args.dir or Path(tempfile.mkdtemp(prefix='latex-review-demo-'))).resolve()
    repo = base / 'example-paper'
    if repo.exists():
        sys.exit(f'{repo} already exists; pass another --dir or remove it.')
    shutil.copytree(HERE / 'paper', repo / 'paper')
    (repo / '.gitignore').write_text('*.aux\n*.log\n*.pdf\n*.synctex.gz\n*.fdb_latexmk\n*.fls\n*.out\n')
    git('init', '-q', cwd=repo)
    git('-c', 'user.name=Example', '-c', 'user.email=example@localhost', 'add', '.', cwd=repo)
    git('-c', 'user.name=Example', '-c', 'user.email=example@localhost', 'commit', '-qm', 'Example paper', cwd=repo)

    plan = json.loads((HERE / 'agent-edits.json').read_text())
    print(f'Example repository: {repo}')
    task = run('start', plan['task'], '--section', plan['section'], '--title', plan['title'], cwd=repo)
    worktree = Path(task['worktree'])
    print(f'Agent worktree:     {worktree}')
    for edit in plan['edits']:
        path = worktree / edit['file']
        text = path.read_text()
        if edit['old'] not in text:
            sys.exit(f"Edit not applicable to {edit['file']}: {edit['old'][:60]!r}")
        path.write_text(text.replace(edit['old'], edit['new'], 1))
    print(f"Applied {len(plan['edits'])} agent edits; compiling both versions (about half a minute the first time)…")
    published = run('publish', *([] if args.no_open else ['--open']), cwd=worktree)
    print(f"""
Round {published['round']}: {published['changes']} changes are ready for review at

    {published['url']}

Keys: A accept · R reject · C comment · J/K next/previous · N next undecided · S LaTeX source · ⌘Z undo.
Accepted changes are written to {repo / 'paper'}; rejected ones are reverted in the worktree.

See what the agent receives after you review:
    python3 {REVIEW} --repo {worktree} feedback

Clean up:
    python3 {REVIEW} --repo {repo} --task {plan['task']} finish --force
    python3 {REVIEW} --repo {repo} server stop
    rm -rf {base}""")


if __name__ == '__main__':
    main()
