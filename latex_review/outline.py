"""Read a document's sectioning structure from source, without running TeX.

Literal \\input / \\include and the standard sectioning commands are followed.
Labels give headings stable identities across renames. Every node owns the
source lines of its heading and body, including its subsections.
"""
import hashlib
import posixpath
import re

LEVELS = {'part': 0, 'chapter': 1, 'section': 2, 'subsection': 3, 'subsubsection': 4}
COMMAND = re.compile(r'^\s*\\(part|chapter|section|subsection|subsubsection|input|include|subfile'
                     r'|appendix|mainmatter|frontmatter|backmatter)\b(\*)?')
VERBATIM = re.compile(r'\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment)\}')
LABEL = re.compile(r'\\label\{([^}]+)\}')


def strip_comments(text):
    return re.sub(r'(?<!\\)%[^\n]*', '', text)


def source_lines(text):
    """Lines split on '\\n' only, so numbers agree with editors and Git."""
    lines = text.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    return lines


def argument(text, position):
    """The next {braced} argument at or after `position`, skipping one [optional] one."""
    while position < len(text) and text[position].isspace():
        position += 1
    if position < len(text) and text[position] == '[':
        end = text.find(']', position)
        return (None, position) if end < 0 else argument(text, end + 1)
    if position >= len(text) or text[position] != '{':
        return None, position
    depth, begin = 1, position + 1
    position += 1
    while position < len(text):
        if text[position] == '\\':
            position += 2
            continue
        if text[position] == '{':
            depth += 1
        elif text[position] == '}':
            depth -= 1
            if depth == 0:
                return text[begin:position], position + 1
        position += 1
    return None, position


def plain_title(value):
    value = re.sub(r'\\(?:linebreak|newline)\b(?:\[[^]]*\])?', ' ', value)
    value = re.sub(r'\\texorpdfstring\{([^{}]*)\}\{([^{}]*)\}', r'\2', value)
    value = re.sub(r'\\[A-Za-z@]+\*?(?:\[[^]]*\])?\{([^{}]*)\}', r'\1', value)
    return re.sub(r'\s+', ' ', value.replace('{', '').replace('}', '').replace('~', ' ')).strip()


def compact_ranges(points):
    result = {}
    for name, lines in points.items():
        spans = []
        for line in sorted(lines):
            if spans and line <= spans[-1][1] + 1:
                spans[-1][1] = line
            else:
                spans.append([line, line])
        result[name] = spans
    return result


def build_outline(read, main):
    """Ordered heading nodes with their source ranges.

    `read(path)` returns the text of a repository path, or None. `main` is the
    repository path of the root document; inputs resolve relative to its folder.
    """
    base = posixpath.dirname(main)
    nodes, stack, warnings, used = [], [], [], set()
    counters = [0] * 5
    flags = {'appendix': False, 'numbered': True}

    def resolve(value):
        value = value.strip()
        if not value or '\\' in value or '#' in value:
            return None
        path = posixpath.normpath(posixpath.join(base, value))
        if path == '..' or path.startswith('../') or posixpath.isabs(path):
            return None
        return path if posixpath.splitext(path)[1] else path + '.tex'

    def record(name, line, root):
        # In the root file, lines after an included chapter are glue, not chapter text.
        if root and (not stack or stack[-1]['file'] != name):
            return
        for node in stack:
            node['_points'].setdefault(name, set()).add(line)

    def walk(name, active=()):
        if name in active:
            warnings.append('Circular input: ' + name)
            return
        text = read(name)
        if text is None:
            warnings.append('Input not found: ' + name)
            return
        root = name == main
        lines = source_lines(strip_comments(text))
        # Leading blank and comment lines belong to the heading that opens a file.
        first = next((j for j, line in enumerate(lines) if line.strip()), None)
        opening = COMMAND.match(lines[first]) if first is not None else None
        prefix = first if opening and opening[1] in LEVELS else 0
        if prefix:
            while stack and stack[-1]['level'] >= LEVELS[opening[1]]:
                stack.pop()
        in_document, verbatim, i = not root, None, 0
        while i < len(lines):
            line = lines[i]
            if not in_document:
                in_document = '\\begin{document}' in line
                i += 1
                continue
            if root and '\\end{document}' in line:
                break
            environment = VERBATIM.search(line)
            if environment:
                verbatim = environment[1]
            if verbatim:
                record(name, i + 1, root)
                if '\\end{' + verbatim + '}' in line:
                    verbatim = None
                i += 1
                continue
            match = COMMAND.match(line)
            if not match:
                if i >= prefix:
                    record(name, i + 1, root)
                i += 1
                continue
            command = match[1]
            if command in ('mainmatter', 'frontmatter', 'backmatter', 'appendix'):
                if command == 'appendix':
                    flags['appendix'] = True
                    counters[1:] = [0] * 4
                else:
                    flags['numbered'] = command == 'mainmatter'
                i += 1
                continue
            joined = '\n'.join(lines[i:])
            value, end = argument(joined, match.end())
            if value is None:
                warnings.append(f'Could not parse {name}:{i + 1}')
                i += 1
                continue
            consumed = joined[:end].count('\n') + 1
            if command in ('input', 'include', 'subfile'):
                if not root:
                    record(name, i + 1, root)
                child = resolve(value)
                if child:
                    walk(child, active + (name,))
                else:
                    warnings.append(f'Dynamic input needs manual review: {name}:{i + 1}')
                i += consumed
                continue
            level = LEVELS[command]
            while stack and stack[-1]['level'] >= level:
                stack.pop()
            rest = joined[end:].split('\n', 1)[0]
            labels = LABEL.findall(rest)
            for following in lines[i + consumed:i + consumed + 8]:
                if not following.strip():
                    continue
                found = re.fullmatch(r'\s*\\label\{([^}]+)\}\s*', following)
                if not found:
                    break
                labels.append(found[1])
            label = next((x for x in labels if not re.match(r'sec:\d', x)), labels[0] if labels else None)
            identity = 'label:' + label if label else f'{name}#{command}:{plain_title(value)}'
            if identity in used:
                identity += ':' + hashlib.sha256(f'{name}:{i}'.encode()).hexdigest()[:8]
            used.add(identity)
            numbered = not match[2] and (flags['numbered'] or level == 0)
            if numbered:
                counters[level] += 1
                if level:
                    counters[level + 1:] = [0] * (4 - level)
            node = {'id': identity, 'title': plain_title(value), 'kind': command, 'level': level,
                    'file': name, 'line': i + 1, 'parent': stack[-1]['id'] if stack else None,
                    'labels': labels, '_points': {},
                    '_counters': counters[:] if numbered else None, '_appendix': flags['appendix']}
            nodes.append(node)
            stack.append(node)
            if i == prefix:
                for k in range(prefix):
                    record(name, k + 1, root)
            for k in range(consumed):
                record(name, i + k + 1, root)
            i += consumed

    walk(main)
    # Numbering starts at chapters in books and at sections in articles.
    top = 1 if any(n['kind'] == 'chapter' for n in nodes) else 2
    for node in nodes:
        counts, level = node.pop('_counters'), node['level']
        appendix = node.pop('_appendix')
        if counts is None or 0 < level < top:
            node['number'] = ''
        elif level == 0:
            node['number'] = str(counts[0])
        else:
            first = chr(64 + counts[top]) if appendix and 1 <= counts[top] <= 26 else str(counts[top])
            node['number'] = '.'.join([first] + [str(n) for n in counts[top + 1:level + 1]])
        node['ranges'] = compact_ranges(node.pop('_points'))
        node['files'] = sorted(node['ranges'])
    return {'nodes': nodes, 'warnings': warnings,
            'signature': hashlib.sha256(repr(nodes).encode()).hexdigest()[:20]}


def overlaps(a, b):
    return any(max(x, u) <= min(y, v) for name in a.keys() & b.keys()
               for x, y in a[name] for u, v in b[name])


def selected_ranges(nodes, ids):
    """Merged source ranges of the selected nodes, and a short description of each."""
    selected = [n for n in nodes if n['id'] in ids]
    if len(selected) != len(set(ids)):
        raise ValueError('The outline changed; select the sections again.')
    points = {}
    for node in selected:
        for name, spans in node['ranges'].items():
            for a, b in spans:
                points.setdefault(name, set()).update(range(a, b + 1))
    return compact_ranges(points), [{'id': n['id'], 'number': n['number'], 'title': n['title']}
                                    for n in selected]


def resolve_sections(nodes, selectors):
    """Map --section values (number, title, label or id) to node identities."""
    ids = []
    for selector in selectors:
        key = selector.strip()
        label = key if key.startswith('label:') else 'label:' + key
        matches = [n for n in nodes if key in (n['id'], n['number']) or n['id'] == label]
        if not matches:
            matches = [n for n in nodes if n['title'].casefold() == key.casefold()]
        if len(matches) != 1:
            options = ', '.join(f"{n['number'] or '-'} {n['title']}" for n in matches[:8])
            raise ValueError(f'Section {selector!r} matches {len(matches)} headings'
                             + (f' ({options}). Use a number or label.' if matches else
                                '. Use a section number such as 3.2, an exact title, or a \\label.'))
        ids.append(matches[0]['id'])
    return list(dict.fromkeys(ids))


def covers(spans, start, end):
    reached = start - 1
    for a, b in sorted(spans):
        if a > reached + 1:
            break
        reached = max(reached, b)
    return reached >= end


def deepest_node(nodes, file, start, end):
    """The most specific heading whose source contains all of the given lines."""
    matches = [n for n in nodes if covers(n['ranges'].get(file, []), start, end)]
    return max(matches, key=lambda n: n['level'], default=None)
