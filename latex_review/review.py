"""Review decisions: accept, reject, comment, undo, and the feedback stream read by the agent.

Accept merges the selected changes into the manuscript (the integration working tree)
and into the task's private record of accepted text. Reject reverts them in the agent's
worktree. Every file write is journaled first, so an interrupted action finishes on restart.
"""
import json
from pathlib import Path
import re
import time
import uuid

from .changes import apply_units, revert_units
from .files import read_bytes, read_json, write_or_delete
from .git import merge3

DECIDED = {'accept': 'accepted', 'reject': 'rejected', 'comment': 'commented'}
LIVE = ('applying', 'applied', 'undoing')
ACTION_ID = re.compile(r'[A-Za-z0-9-]{1,80}')
SNIPPET = 400


class Conflict(ValueError):
    pass


def snippet(text):
    text = text.rstrip('\n')
    return text if len(text) <= SNIPPET else text[:SNIPPET] + ' …'


class Review:
    def __init__(self, app):
        self.app = app
        self.details = {}

    # Reading

    def latest_round(self, name):
        return self.app.store.one('SELECT * FROM rounds WHERE task=? ORDER BY number DESC LIMIT 1', name)

    def round(self, name, number):
        found = self.app.store.one('SELECT * FROM rounds WHERE task=? AND number=?', name, number)
        if not found:
            raise LookupError(f'Round {number} of {name!r} does not exist.')
        return found

    def actions(self, name, number):
        return self.app.store.all('SELECT * FROM actions WHERE task=? AND round=? ORDER BY seq', name, number)

    def decisions(self, name, round_):
        result = {u['id']: 'pending' for u in round_['units']}
        for action in self.actions(name, round_['number']):
            if action['status'] in LIVE:
                for change in action['changes']:
                    result[change] = DECIDED[action['kind']]
        return result

    def comments(self, name, number):
        return {c: a['body'] for a in self.actions(name, number)
                if a['kind'] == 'comment' and a['status'] in LIVE for c in a['changes']}

    def counts(self, name, round_=None):
        round_ = round_ or self.latest_round(name)
        values = list(self.decisions(name, round_).values()) if round_ else []
        return {k: values.count(k) for k in ('accepted', 'rejected', 'commented', 'pending')}

    def last_change(self, name):
        """The last decision or undo that changed the accepted text or the worktree."""
        return self.app.store.one("SELECT MAX(id) AS id FROM messages WHERE task=? AND kind IN ('accept','reject','undo')",
                                  name)['id']

    def undo_entry(self, name):
        """The last decision, if it can still be undone (only within the latest round)."""
        latest = self.latest_round(name)
        action = self.app.store.one("SELECT * FROM actions WHERE task=? AND status='applied' ORDER BY seq DESC LIMIT 1", name)
        if action and latest and action['round'] == latest['number']:
            return action
        return None

    def summary(self, name):
        """Where the task stands, and what the agent should do next."""
        task = self.app.tasks.get(name)
        latest = self.latest_round(name)
        job = self.app.publisher.current(name)
        counts = self.counts(name, latest)
        number = latest['number'] if latest else None
        notes = latest and self.app.store.one(
            "SELECT id FROM messages WHERE task=? AND kind='note' AND created>? LIMIT 1", name, latest['created'])
        not_reverted = latest and any(a['detail'].get('not_reverted') for a in self.actions(name, number)
                                      if a['kind'] == 'reject' and a['status'] in LIVE)
        if job and job['status'] in ('queued', 'running'):
            state, hint = 'building', 'A round is being built. Run `publish` again to wait for it.'
        elif job and job['status'] == 'failed' and (not latest or job['created'] > latest['created']):
            state, hint = 'build_failed', job['result'].get('next', 'Fix the problem in the worktree, then publish again.')
        elif not latest:
            state, hint = 'editing', 'Edit files in the worktree, then run `publish`.'
        elif counts['pending']:
            state = 'reviewing'
            hint = (f"The user is reviewing round {number} ({counts['pending']} of {sum(counts.values())} "
                    'changes left). Keep this turn open with `feedback --wait`, then continue automatically.')
        elif counts['commented'] or notes or not_reverted:
            state = 'revise'
            hint = ('Revise the commented changes in the worktree, then `publish`. '
                    'Rejected changes were already reverted in your worktree' +
                    (' except where noted.' if not_reverted else '.'))
        else:
            state = 'done'
            hint = ('Every change is decided. Report completion and leave the review open for inspection and undo. '
                    'Run `finish` only when the user asks to clean up the review.')
        return {'task': name, 'title': task['title'], 'state': state, 'round': number, 'counts': counts,
                'next': hint}

    def page_state(self, name, number=None):
        task = self.app.tasks.get(name, open_only=False)
        latest = self.latest_round(name)
        number = number or (latest['number'] if latest else None)
        round_ = self.round(name, number) if number else None
        undo = self.undo_entry(name) if round_ and latest and number == latest['number'] else None
        job = self.app.publisher.current(name)
        self.app.viewers[name] = time.time()
        return {'csrf': self.app.csrf, 'task': name, 'title': task['title'], 'closed': bool(task['closed']),
                'state': None if task['closed'] else self.summary(name)['state'],
                'latest': latest['number'] if latest else None, 'round': number,
                'revision': round_['after'] if round_ else None,
                'decisions': self.decisions(name, round_) if round_ else {},
                'comments': self.comments(name, number) if round_ else {},
                'undo': {'id': undo['id'], 'kind': undo['kind'], 'changes': undo['changes']} if undo else None,
                'job': job and {'id': job['id'], 'status': job['status'], 'phase': job['phase'], 'created': job['created'],
                                'ahead': self.app.publisher.ahead(job) if job['status'] == 'queued' else 0,
                                **{k: job['result'].get(k) for k in ('error', 'details', 'outcome')}}}

    def round_detail(self, name, number):
        """Everything the page needs to show one round. Immutable once published."""
        round_ = self.round(name, number)
        key = (name, number, round_['after'])
        if key not in self.details:
            folder = self.app.state / 'rounds' / name / f'{number:03}'
            render = read_json(folder / 'round.json', {})
            history = self.history(name, round_)
            units = [{k: u[k] for k in ('id', 'file', 'status', 'kind', 'whole_file', 'old_start', 'old_end',
                                        'new_start', 'new_end', 'old_text', 'new_text', 'truncated')}
                     | render.get('units', {}).get(u['id'], {}) | ({'history': history[u['id']]} if u['id'] in history else {})
                     for u in round_['units']]
            self.details[key] = {'task': name, 'round': number, 'before': round_['before'], 'after': round_['after'],
                                 'units': units, 'sections': render.get('sections', []), 'loose': render.get('loose', []),
                                 'warnings': round_['summary'].get('warnings', []),
                                 'files': f'/files/{name}/{number}/'}
        return self.details[key]

    def history(self, name, round_):
        """Comments from the previous round on the text that a change revises."""
        if round_['number'] == 1:
            return {}
        previous = self.round(name, round_['number'] - 1)
        comments = self.comments(name, previous['number'])
        result = {}
        for unit in round_['units']:
            for old in previous['units']:
                if old['id'] not in comments or old['file'] != unit['file']:
                    continue
                same_text = old['old_text'] and old['old_text'] == unit['old_text']
                overlap = max(old['old_start'], unit['old_start']) <= min(old['old_end'], unit['old_end'])
                if same_text or overlap:
                    result.setdefault(unit['id'], []).append(
                        {'round': previous['number'], 'change': old['id'], 'comment': comments[old['id']],
                         'new_text': old['new_text']})
        return result

    def feedback(self, name, after=0):
        """Messages for the agent since `after`, with the current summary."""
        self.app.tasks.get(name)
        rows = self.app.store.all('SELECT * FROM messages WHERE task=? AND id>? ORDER BY id LIMIT 200', name, after)
        undone = {a['id'] for a in self.app.store.all("SELECT id FROM actions WHERE task=? AND status='undone'", name)}
        rounds = {}
        items = []
        for message in rows:
            if message['kind'] == 'undo' and message['data'].get('message', 0) > after:
                continue  # The agent never saw the decision that was undone.
            if message['kind'] != 'undo' and message['action'] in undone:
                continue
            item = {'id': message['id'], 'kind': message['kind'], 'round': message['round']}
            if message['body']:
                item['text'] = message['body']
            changes = message['data'].get('changes', [])
            if changes and message['round']:
                if message['round'] not in rounds:
                    rounds[message['round']] = {u['id']: u for u in self.round(name, message['round'])['units']}
                units = rounds[message['round']]
                if message['kind'] in ('comment', 'reject'):
                    item['changes'] = [{'id': c, 'file': units[c]['file'],
                                        'lines': [units[c]['new_start'], units[c]['new_end']],
                                        'old': snippet(units[c]['old_text']), 'new': snippet(units[c]['new_text'])}
                                       for c in changes if c in units]
                else:
                    item['changes'] = changes
            for key in ('not_reverted', 'undid'):
                if message['data'].get(key):
                    item[key] = message['data'][key]
            items.append(item)
        cursor = rows[-1]['id'] if rows else after
        summary = self.summary(name)
        if any(item['kind'] == 'note' for item in items):
            summary['next'] = ('Read and act on the user\'s message in `feedback` first, even while changes are '
                               'pending or a round is building. Then follow the task state.')
        return {**summary, 'feedback': items, 'cursor': cursor}

    # Writing

    def decide(self, name, data):
        app = self.app
        with app.lock:
            task = app.tasks.get(name)
            kind = data.get('action')
            if kind not in DECIDED:
                raise ValueError('The action must be accept, reject or comment.')
            identity = str(data.get('id') or uuid.uuid4())
            if not ACTION_ID.fullmatch(identity):
                raise ValueError('Invalid action id.')
            chosen = data.get('changes')
            previous = app.store.one('SELECT * FROM actions WHERE id=?', identity)
            if previous:
                if (previous['task'], previous['round'], previous['kind'], previous['changes']) != (
                        name, data.get('round'), kind, chosen):
                    raise ValueError('This action id was already used for another decision.')
                if previous['status'] != 'applied':
                    raise ValueError('That decision was undone or failed. Make it again.')
                return self.page_state(name)
            latest = self.latest_round(name)
            if not latest or data.get('round') != latest['number']:
                raise ValueError('A newer round is available. Reload the page.')
            decisions = self.decisions(name, latest)
            if (not isinstance(chosen, list) or not chosen or len(set(chosen)) != len(chosen)
                    or any(decisions.get(c) != 'pending' for c in chosen)):
                raise ValueError('These changes were already decided. Reload the page.')
            body = str(data.get('body') or '').strip()
            if kind == 'comment' and not body:
                raise ValueError('Write a comment first.')
            if len(body) > 20000:
                raise ValueError('Comments are limited to 20,000 characters.')
            units = {u['id']: u for u in latest['units']}
            selected = [units[c] for c in chosen]
            if kind == 'accept':
                self.accept(task, latest, identity, selected)
            elif kind == 'reject':
                self.reject(task, latest, identity, selected)
            else:
                self.record(identity, task, latest, kind, chosen, body, {}, [], status='applied')
                self.message(name, latest['number'], 'comment', identity, body, {'changes': chosen})
            return self.page_state(name)

    def by_file(self, units):
        grouped = {}
        for unit in units:
            grouped.setdefault(unit['file'], []).append(unit)
        return grouped

    def accept(self, task, round_, identity, units):
        app = self.app
        root = app.project.root
        writes, accepted, conflicts = [], {}, []
        groups = self.by_file(units)
        blobs = app.repo.read([(rev, path) for path in groups for rev in (round_['before'], round_['after'], task['accepted'])])
        for path, group in groups.items():
            base, after = blobs[round_['before'], path], blobs[round_['after'], path]
            proposed = apply_units(base, after, group)
            target = safe_path(root, path)
            current = read_bytes(target)
            merged, conflict = merge3(current, base, proposed)
            recorded, recorded_conflict = merge3(blobs[task['accepted'], path], base, proposed)
            if conflict or recorded_conflict:
                conflicts.append(path)
            elif merged != current:
                writes.append((str(target), current, merged))
            accepted[path] = recorded
        if conflicts:
            raise Conflict(f"{', '.join(u['id'] for u in units)} can't be applied: {', '.join(conflicts)} "
                           'changed in your manuscript since this round was published. Nothing was written. '
                           'Comment on the change to have the agent redo it.')
        after_commit = app.repo.commit_with(task['accepted'], accepted,
                                            'latex-review: accept ' + ', '.join(u['id'] for u in units))
        detail = {'accepted_before': task['accepted'], 'accepted_after': after_commit}
        self.record(identity, task, round_, 'accept', [u['id'] for u in units], '', detail, writes)
        self.carry_out(identity, 'apply')

    def reject(self, task, round_, identity, units):
        app = self.app
        worktree = Path(task['worktree'])
        writes, kept = [], []
        groups = self.by_file(units)
        blobs = app.repo.read([(rev, path) for path in groups for rev in (round_['before'], round_['after'])])
        for path, group in groups.items():
            before, after = blobs[round_['before'], path], blobs[round_['after'], path]
            reverted = revert_units(before, after, group)
            target = safe_path(worktree, path)
            current = read_bytes(target)
            merged, conflict = merge3(current, after, reverted)
            if conflict:
                kept.append(path)
            elif merged != current:
                writes.append((str(target), current, merged))
        detail = {'not_reverted': kept}
        self.record(identity, task, round_, 'reject', [u['id'] for u in units], '', detail, writes)
        self.carry_out(identity, 'apply')

    def record(self, identity, task, round_, kind, changes, body, detail, writes, status='applying'):
        with self.app.store.transaction() as db:
            db.execute('INSERT INTO actions(id,task,round,kind,changes,body,status,detail,created) VALUES(?,?,?,?,?,?,?,?,?)',
                       (identity, task['name'], round_['number'], kind, json.dumps(changes), body, status,
                        json.dumps(detail), time.time()))
            db.executemany('INSERT INTO writes(action,phase,path,expected,target) VALUES(?,?,?,?,?)',
                           [(identity, 'apply', path, expected, target) for path, expected, target in writes])

    def perform(self, identity, phase):
        """Carry out journaled writes. Files already written are skipped, so this can resume."""
        rows = self.app.store.all('SELECT * FROM writes WHERE action=? AND phase=?', identity, phase)
        current = {r['path']: read_bytes(r['path']) for r in rows}
        stale = [r['path'] for r in rows if current[r['path']] not in (r['expected'], r['target'])]
        if stale:
            raise Conflict('These files changed while the decision was being applied: ' + ', '.join(stale))
        for r in rows:
            if current[r['path']] != r['target']:
                write_or_delete(r['path'], r['target'])

    def carry_out(self, identity, phase):
        """Perform and record an action's writes; on failure put back what was written."""
        try:
            self.perform(identity, phase)
        except BaseException:
            try:
                for r in self.app.store.all('SELECT * FROM writes WHERE action=? AND phase=?', identity, phase):
                    if read_bytes(r['path']) == r['target'] and r['target'] != r['expected']:
                        write_or_delete(r['path'], r['expected'])
            except OSError:
                raise  # Left as is: the journal finishes the action when the server restarts.
            with self.app.store.transaction() as db:
                db.execute('DELETE FROM writes WHERE action=? AND phase=?', (identity, phase))
                db.execute('UPDATE actions SET status=? WHERE id=?', ('failed' if phase == 'apply' else 'applied', identity))
            raise
        self.complete(identity)

    def complete(self, identity):
        """Record a performed action as applied, or a performed undo as undone, in one transaction."""
        app = self.app
        action = app.store.one('SELECT * FROM actions WHERE id=?', identity)
        name, number, detail = action['task'], action['round'], action['detail']
        if action['status'] not in ('applying', 'undoing'):
            return
        applying = action['status'] == 'applying'
        accepted = detail.get('accepted_after' if applying else 'accepted_before')
        with app.store.transaction() as db:
            if action['kind'] == 'accept':
                db.execute('UPDATE tasks SET accepted=? WHERE name=?', (accepted, name))
            db.execute('UPDATE actions SET status=? WHERE id=?', ('applied' if applying else 'undone', identity))
            if applying:
                data = {'changes': action['changes']}
                if detail.get('not_reverted'):
                    data['not_reverted'] = detail['not_reverted']
                self.message(name, number, action['kind'], identity, '', data, db)
            else:
                original = db.execute("SELECT id FROM messages WHERE action=? AND kind!='undo' ORDER BY id LIMIT 1",
                                      (identity,)).fetchone()
                self.message(name, number, 'undo', identity, '', {'changes': action['changes'], 'undid': action['kind'],
                                                                 'message': original[0] if original else 0}, db)
        if action['kind'] == 'accept':
            app.repo.update_ref(f'refs/latex-review/{name}/accepted', accepted)

    def message(self, name, number, kind, action, body, data, db=None):
        values = (name, number, kind, action, body, json.dumps(data), time.time())
        query = 'INSERT INTO messages(task,round,kind,action,body,data,created) VALUES(?,?,?,?,?,?,?)'
        if db is not None:
            db.execute(query, values)
        else:
            self.app.store.execute(query, *values)

    def note(self, name, body):
        body = str(body or '').strip()
        if not body or len(body) > 20000:
            raise ValueError('Write a message (at most 20,000 characters).')
        with self.app.lock:
            self.app.tasks.get(name)
            latest = self.latest_round(name)
            self.message(name, latest and latest['number'], 'note', None, body, {})
        return self.page_state(name)

    def undo(self, name, identity):
        app = self.app
        with app.lock:
            app.tasks.get(name)
            action = self.undo_entry(name)
            if not action or action['id'] != identity:
                raise ValueError('Nothing to undo here any more. Reload the page.')
            if action['kind'] == 'accept' and app.tasks.get(name)['accepted'] != action['detail']['accepted_after']:
                raise Conflict('The accepted text changed in an unexpected way; nothing was undone.')
            restores, conflicts = [], []
            for write in app.store.all("SELECT * FROM writes WHERE action=? AND phase='apply'", identity):
                current = read_bytes(write['path'])
                restored, conflict = merge3(current, write['target'], write['expected'])
                if conflict:
                    conflicts.append(write['path'])
                elif restored != current:
                    restores.append((write['path'], current, restored))
            if conflicts:
                raise Conflict("Can't undo: " + ', '.join(display(app, p) for p in conflicts) +
                               ' changed since the decision. Nothing was undone.')
            with app.store.transaction() as db:
                db.execute("UPDATE actions SET status='undoing' WHERE id=?", (identity,))
                db.executemany("INSERT INTO writes(action,phase,path,expected,target) VALUES(?,'undo',?,?,?)",
                               [(identity, path, expected, target) for path, expected, target in restores])
            self.carry_out(identity, 'undo')
            return {**self.page_state(name), 'restored': action['changes']}

    def recover(self):
        """Finish actions that were interrupted, e.g. by a crash, after journaling their writes."""
        for action in self.app.store.all("SELECT * FROM actions WHERE status IN ('applying','undoing') ORDER BY seq"):
            phase = 'apply' if action['status'] == 'applying' else 'undo'
            try:
                self.perform(action['id'], phase)
            except (Conflict, OSError):
                status = 'failed' if phase == 'apply' else 'applied'
                self.app.store.execute('UPDATE actions SET status=? WHERE id=?', status, action['id'])
                continue
            self.complete(action['id'])


def safe_path(root, path):
    target = Path(root) / path
    if target.is_symlink() or not target.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError('Refusing to write outside the working tree: ' + path)
    return target


def display(app, path):
    try:
        return str(Path(path).relative_to(app.root))
    except ValueError:
        return Path(path).name
