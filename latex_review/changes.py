"""Split a diff into independently reviewable changes; apply or revert any subset of them."""
import difflib
import re

from .git import within

CONTEXT = 3      # Edits closer than this many lines form one change.
EXCERPT = 6000   # Characters of source kept per side for display.


def text_of(data):
    """Decoded text, or None for binary content. A missing file is empty text."""
    if data is None:
        return ''
    if b'\0' in data:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


def split_lines(text):
    """Lines including their newline, split on '\\n' only."""
    return re.findall(r'[^\n]*\n|[^\n]+\Z', text)


def excerpt(lines):
    text = ''.join(lines)
    return (text[:EXCERPT], True) if len(text) > EXCERPT else (text, False)


def diff_units(repo, before, after, is_figure=lambda path: False):
    """The changes between two revisions, numbered c001, c002, … in file order."""
    units = []
    files = repo.changed_files(before, after)
    old_blobs, new_blobs = repo.blobs(before, files), repo.blobs(after, files)
    for path in files:
        old, new = old_blobs[path], new_blobs[path]
        a, b = text_of(old), text_of(new)
        status = 'added' if old is None else 'deleted' if new is None else 'modified'
        binary = a is None or b is None
        old_lines, new_lines = ([], []) if binary else (split_lines(a), split_lines(b))
        groups = [] if binary else list(difflib.SequenceMatcher(
            None, old_lines, new_lines, autojunk=False).get_grouped_opcodes(CONTEXT))
        whole = binary or status != 'modified' or is_figure(path) or not groups
        kind = 'binary' if binary else 'figure' if is_figure(path) else 'text'
        if whole:
            groups = [[('replace', 0, len(old_lines), 0, len(new_lines))]]
        for group in groups:
            edits = [list(op) for op in group if op[0] != 'equal']
            i, j, x, y = edits[0][1], edits[-1][2], edits[0][3], edits[-1][4]
            old_text, old_cut = excerpt(old_lines[i:j])
            new_text, new_cut = excerpt(new_lines[x:y])
            units.append({'id': f'c{len(units) + 1:03}', 'file': path, 'status': status, 'kind': kind,
                          'whole_file': whole, 'ops': [] if whole else edits,
                          'old_start': i + 1, 'old_end': max(i + 1, j),
                          'new_start': x + 1, 'new_end': max(x + 1, y),
                          'old_text': '' if binary else old_text, 'new_text': '' if binary else new_text,
                          'truncated': old_cut or new_cut})
    return units


def apply_units(old, new, units):
    """`old` with the selected changes of one file applied (None means deleted)."""
    if any(u['whole_file'] for u in units):
        return new
    a, b = split_lines(old.decode()), split_lines(new.decode())
    for _, i, j, x, y in sorted((op for u in units for op in u['ops']), key=lambda op: op[1], reverse=True):
        a[i:j] = b[x:y]
    return ''.join(a).encode()


def revert_units(old, new, units):
    """`new` with the selected changes of one file undone (None means deleted)."""
    if any(u['whole_file'] for u in units):
        return old
    a, b = split_lines(old.decode()), split_lines(new.decode())
    for _, i, j, x, y in sorted((op for u in units for op in u['ops']), key=lambda op: op[3], reverse=True):
        b[x:y] = a[i:j]
    return ''.join(b).encode()


def scope_violations(repo, base, revision, scope):
    """Paths, or path:line, changed since `base` outside the task's scope."""
    ranges, violations = scope.get('ranges'), []
    files = repo.changed_files(base, revision)
    if ranges is None:
        return [name for name in files if not within(name, scope['paths'])]
    old_blobs, new_blobs = repo.blobs(base, files), repo.blobs(revision, files)
    for name in files:
        old, new = old_blobs[name], new_blobs[name]
        a, b = text_of(old), text_of(new)
        if name not in ranges or old is None or a is None or b is None:
            violations.append(name)
            continue
        allowed = ranges[name]
        matcher = difflib.SequenceMatcher(None, split_lines(a), split_lines(b), autojunk=False)
        for tag, i, j, _, _ in matcher.get_opcodes():
            if tag == 'equal':
                continue
            # An insertion may attach to either side of a line boundary inside the scope.
            permitted = (any(start - 1 <= i <= end for start, end in allowed) if i == j else
                         all(any(start <= n <= end for start, end in allowed) for n in range(i + 1, j + 1)))
            if not permitted:
                violations.append(f'{name}:{i + 1}')
                break
    return violations
