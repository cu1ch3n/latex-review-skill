from pathlib import Path
from unittest.mock import patch

from helpers import RepoCase, fake_round, git

from latex_review.review import Conflict

METHOD = 'paper/sections/method.tex'


class ReviewTests(RepoCase):
    def setUp(self):
        super().setUp()
        self.review_app = self.app()
        self.task = self.review_app.tasks.create('polish', 'Polish', files=['paper'])

    def decide(self, action, changes, body='', **extra):
        latest = self.review_app.review.latest_round('polish')
        return self.review_app.review.decide('polish', {'action': action, 'round': latest['number'],
                                                         'changes': changes, 'body': body, **extra})

    def two_changes(self):
        self.edit(self.task, METHOD, 'Method sentence 2.', 'Agent A.')
        self.edit(self.task, METHOD, 'Detail sentence 15.', 'Agent B.')
        return fake_round(self.review_app, 'polish')

    def test_accept_merges_into_a_dirty_manuscript_without_touching_git(self):
        round_ = self.two_changes()
        self.assertEqual([u['id'] for u in round_['units']], ['c001', 'c002'])
        self.write(METHOD, self.method_text.replace('Detail sentence 3.', 'User edit.'))
        head, index = git(self.root, 'rev-parse', 'HEAD'), (self.root / '.git/index').read_bytes()
        state = self.decide('accept', ['c001'])
        text = self.read(METHOD)
        self.assertIn('Agent A.', text)
        self.assertNotIn('Agent B.', text)
        self.assertIn('User edit.', text)
        self.assertEqual(state['decisions'], {'c001': 'accepted', 'c002': 'pending'})
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), head)
        self.assertEqual((self.root / '.git/index').read_bytes(), index)
        accepted = self.review_app.tasks.get('polish')['accepted']
        self.assertIn(b'Agent A.', self.review_app.repo.blob(accepted, METHOD))
        self.assertNotIn(b'User edit.', self.review_app.repo.blob(accepted, METHOD))

    def test_undo_goes_back_one_decision_at_a_time_and_keeps_later_user_edits(self):
        self.two_changes()
        first = self.decide('accept', ['c001'], id='first')
        self.decide('accept', ['c002'], id='second')
        self.assertEqual(first['undo']['id'], 'first')
        with self.assertRaises(ValueError):
            self.review_app.review.undo('polish', 'first')
        self.write(METHOD, self.read(METHOD).replace('Method sentence 15.', 'Later user edit.'))
        self.review_app.review.undo('polish', 'second')
        self.assertNotIn('Agent B.', self.read(METHOD))
        restored = self.review_app.review.undo('polish', 'first')
        self.assertEqual(restored['restored'], ['c001'])
        self.assertEqual(self.read(METHOD), self.method_text.replace('Method sentence 15.', 'Later user edit.'))
        self.assertEqual(restored['decisions'], {'c001': 'pending', 'c002': 'pending'})
        self.assertIsNone(restored['undo'])
        self.assertEqual(self.review_app.tasks.get('polish')['accepted'], self.task['base'])

    def test_conflicting_accept_writes_nothing(self):
        self.two_changes()
        self.write(METHOD, self.method_text.replace('Method sentence 2.', 'User rewrote this line.'))
        before = self.read(METHOD)
        with self.assertRaisesRegex(Conflict, 'changed in your manuscript'):
            self.decide('accept', ['c001'])
        self.assertEqual(self.read(METHOD), before)
        self.assertEqual(self.review_app.review.page_state('polish')['decisions']['c001'], 'pending')

    def test_undo_refuses_when_the_accepted_text_was_edited_again(self):
        self.two_changes()
        self.decide('accept', ['c001'], id='accept')
        self.write(METHOD, self.read(METHOD).replace('Agent A.', 'User changed the accepted line.'))
        before = self.read(METHOD)
        with self.assertRaisesRegex(Conflict, "Can't undo"):
            self.review_app.review.undo('polish', 'accept')
        self.assertEqual(self.read(METHOD), before)
        self.assertEqual(self.review_app.review.page_state('polish')['undo']['id'], 'accept')

    def test_reject_reverts_the_worktree_and_undo_restores_it(self):
        self.two_changes()
        worktree = Path(self.task['worktree'])
        self.decide('reject', ['c002'], id='reject')
        self.assertNotIn('Agent B.', self.read(METHOD, worktree))
        self.assertIn('Agent A.', self.read(METHOD, worktree))
        self.assertEqual(self.read(METHOD), self.method_text)
        self.review_app.review.undo('polish', 'reject')
        self.assertIn('Agent B.', self.read(METHOD, worktree))

    def test_reject_keeps_text_the_agent_edited_again(self):
        self.two_changes()
        self.edit(self.task, METHOD, 'Agent B.', 'Agent B, edited again.')
        self.decide('accept', ['c001'])
        state = self.decide('reject', ['c002'])
        self.assertEqual(state['decisions']['c002'], 'rejected')
        feedback = self.review_app.review.feedback('polish')
        self.assertEqual(feedback['feedback'][-1]['not_reverted'], [METHOD])
        self.assertEqual(feedback['state'], 'revise')

    def test_added_and_deleted_files_round_trip(self):
        worktree = Path(self.task['worktree'])
        self.write('paper/new.tex', 'New file.\n', worktree)
        (worktree / 'paper/main.tex').unlink()
        round_ = fake_round(self.review_app, 'polish')
        ids = [u['id'] for u in round_['units']]
        self.assertEqual({u['status'] for u in round_['units']}, {'added', 'deleted'})
        self.decide('accept', ids, id='both')
        self.assertTrue((self.root / 'paper/new.tex').exists())
        self.assertFalse((self.root / 'paper/main.tex').exists())
        self.review_app.review.undo('polish', 'both')
        self.assertFalse((self.root / 'paper/new.tex').exists())
        self.assertEqual(self.read('paper/main.tex'), self.main_text)

    def test_retries_with_the_same_id_are_idempotent(self):
        self.two_changes()
        self.decide('accept', ['c001'], id='retry')
        state = self.decide('accept', ['c001'], id='retry')
        self.assertEqual(state['decisions']['c001'], 'accepted')
        self.assertEqual(self.read(METHOD).count('Agent A.'), 1)
        with self.assertRaises(ValueError):
            self.decide('reject', ['c001'], id='retry')
        with self.assertRaises(ValueError):
            self.decide('reject', ['c001'])

    def test_decisions_wait_while_a_round_is_being_built(self):
        self.two_changes()
        with patch.object(self.review_app.publisher, 'busy', return_value=True):
            with self.assertRaisesRegex(ValueError, 'publishing'):
                self.decide('accept', ['c001'])

    def test_interrupted_accept_and_undo_finish_after_a_restart(self):
        self.two_changes()
        app = self.review_app
        with patch.object(app.review, 'complete'):
            self.decide('accept', ['c001'], id='crash')
        self.assertEqual(app.store.one("SELECT status FROM actions WHERE id='crash'")['status'], 'applying')
        self.assertIn('Agent A.', self.read(METHOD))
        app = self.app()
        self.assertEqual(app.review.page_state('polish')['decisions']['c001'], 'accepted')
        self.assertIn(b'Agent A.', app.repo.blob(app.tasks.get('polish')['accepted'], METHOD))
        with patch.object(app.review, 'complete'):
            app.review.undo('polish', 'crash')
        self.assertEqual(app.store.one("SELECT status FROM actions WHERE id='crash'")['status'], 'undoing')
        app = self.app()
        self.assertEqual(app.review.page_state('polish')['decisions']['c001'], 'pending')
        self.assertEqual(self.read(METHOD), self.method_text)

    def test_a_write_that_fails_halfway_is_rolled_back(self):
        worktree = Path(self.task['worktree'])
        self.write('paper/main.tex', self.main_text.replace('Intro sentence 1.', 'Agent intro.'), worktree)
        self.edit(self.task, METHOD, 'Method sentence 2.', 'Agent A.')
        fake_round(self.review_app, 'polish')
        from latex_review import review
        real, calls = review.write_or_delete, []

        def flaky(path, data):
            calls.append(path)
            if len(calls) == 2:
                raise OSError('disk full')
            real(path, data)

        with patch.object(review, 'write_or_delete', flaky):
            with self.assertRaisesRegex(OSError, 'disk full'):
                self.decide('accept', ['c001', 'c002'])
        self.assertEqual(self.read('paper/main.tex'), self.main_text)
        self.assertEqual(self.read(METHOD), self.method_text)
        state = self.review_app.review.page_state('polish')
        self.assertEqual(state['decisions'], {'c001': 'pending', 'c002': 'pending'})
        self.assertEqual(self.review_app.tasks.get('polish')['accepted'], self.task['base'])
        self.decide('accept', ['c001', 'c002'])
        self.assertIn('Agent A.', self.read(METHOD))

    def test_feedback_reports_comments_with_locations_and_moves_on(self):
        self.two_changes()
        self.decide('comment', ['c001'], 'Too informal.')
        feedback = self.review_app.review.feedback('polish')
        self.assertEqual(feedback['state'], 'reviewing')
        comment = feedback['feedback'][0]
        self.assertEqual(comment['text'], 'Too informal.')
        self.assertEqual(comment['changes'][0]['file'], METHOD)
        self.assertIn('Agent A.', comment['changes'][0]['new'])
        self.decide('accept', ['c002'])
        later = self.review_app.review.feedback('polish', feedback['cursor'])
        self.assertEqual([item['kind'] for item in later['feedback']], ['accept'])
        self.assertEqual(later['state'], 'revise')
        self.assertEqual(later['counts'], {'accepted': 1, 'rejected': 0, 'commented': 1, 'pending': 0})

    def test_undone_decisions_are_hidden_or_corrected(self):
        self.two_changes()
        self.decide('reject', ['c001'], id='unseen')
        self.review_app.review.undo('polish', 'unseen')
        self.assertEqual(self.review_app.review.feedback('polish')['feedback'], [])
        self.decide('reject', ['c001'], id='seen')
        cursor = self.review_app.review.feedback('polish')['cursor']
        self.review_app.review.undo('polish', 'seen')
        items = self.review_app.review.feedback('polish', cursor)['feedback']
        self.assertEqual([(i['kind'], i['undid']) for i in items], [('undo', 'reject')])

    def test_next_round_shows_only_what_is_still_proposed(self):
        self.edit(self.task, METHOD, 'Method sentence 2.', 'Agent A.')
        self.edit(self.task, METHOD, 'Detail sentence 2.', 'Agent B.')
        self.edit(self.task, METHOD, 'Detail sentence 18.', 'Agent C.')
        fake_round(self.review_app, 'polish')
        self.decide('accept', ['c001'])
        self.decide('reject', ['c002'])
        self.decide('comment', ['c003'], 'Shorter, please.')
        self.assertEqual(self.review_app.review.summary('polish')['state'], 'revise')
        self.edit(self.task, METHOD, 'Agent C.', 'C.')
        second = fake_round(self.review_app, 'polish')
        self.assertEqual([(u['old_text'], u['new_text']) for u in second['units']],
                         [('Detail sentence 18.\n', 'C.\n')])
        detail = self.review_app.review.round_detail('polish', 2)
        self.assertEqual(detail['units'][0]['history'][0]['comment'], 'Shorter, please.')
        self.assertIsNone(self.review_app.review.page_state('polish')['undo'])
        self.assertEqual(self.review_app.review.summary('polish')['state'], 'reviewing')
        self.decide('accept', ['c001'])
        self.assertEqual(self.review_app.review.summary('polish')['state'], 'done')
        text = self.read(METHOD)
        self.assertIn('Agent A.', text)
        self.assertIn('C.\n', text)
        self.assertNotIn('Agent B.', text)

    def test_notes_reach_the_agent(self):
        self.two_changes()
        self.decide('accept', ['c001'])
        self.decide('accept', ['c002'])
        self.assertEqual(self.review_app.review.summary('polish')['state'], 'done')
        self.review_app.review.note('polish', 'Also tighten the conclusion.')
        feedback = self.review_app.review.feedback('polish')
        self.assertEqual(feedback['feedback'][-1], {'id': feedback['cursor'], 'kind': 'note', 'round': 1,
                                                    'text': 'Also tighten the conclusion.'})
        self.assertEqual(feedback['state'], 'revise')


class TaskTests(RepoCase):
    def test_section_scope_and_repeated_start(self):
        app = self.app()
        task = app.tasks.create(None, 'Polish details', sections=['2.1'])
        self.assertEqual(task['name'], 'polish-details')
        self.assertEqual(task['scope']['sections'][0]['title'], 'Details')
        self.assertEqual(list(task['scope']['ranges']), [METHOD])
        self.assertEqual(app.tasks.create(None, 'Polish details', sections=['sec:details'])['name'], 'polish-details')
        other = app.tasks.create(None, 'Polish details', sections=['Introduction'])
        self.assertEqual(other['name'], 'polish-details-2')
        with self.assertRaisesRegex(ValueError, 'different scope'):
            app.tasks.create('polish-details', 'x', sections=['Introduction'])
        with self.assertRaisesRegex(ValueError, 'matches 0'):
            app.tasks.create('missing', 'x', sections=['No such section'])
        branches = git(self.root, 'branch', '--list')
        self.assertEqual(branches.strip(), '* ' + git(self.root, 'branch', '--show-current').strip())

    def test_snapshot_keeps_untracked_sources_but_not_build_products(self):
        self.write('paper/fresh.tex', 'Not committed yet.\n')
        self.write('paper/main.aux', 'build product')
        self.write('paper/main.log', 'build product')
        task = self.app().tasks.create('t', 'T')
        worktree = Path(task['worktree'])
        self.assertTrue((worktree / 'paper/fresh.tex').exists())
        self.assertFalse((worktree / 'paper/main.log').exists())
        self.assertNotIn('latex-review', git(worktree, 'status', '--porcelain'))

    def test_finish_requires_a_decided_review_unless_forced(self):
        app = self.app()
        task = app.tasks.create('t', 'T')
        self.edit(task, METHOD, 'Method sentence 2.', 'Agent.')
        with self.assertRaisesRegex(ValueError, 'not in the manuscript'):
            app.tasks.finish('t')
        fake_round(app, 't')
        with self.assertRaisesRegex(ValueError, '1 pending'):
            app.tasks.finish('t')
        app.review.decide('t', {'action': 'accept', 'round': 1, 'changes': ['c001']})
        self.edit(task, 'paper/main.tex', 'Intro sentence 5.', 'Second idea.')
        fake_round(app, 't')
        app.review.decide('t', {'action': 'reject', 'round': 2, 'changes': ['c001']})
        result = app.tasks.finish('t')
        self.assertEqual(result['changed'], [METHOD])
        self.assertFalse(Path(task['worktree']).exists())
        self.assertEqual(git(self.root, 'for-each-ref', 'refs/latex-review/'), '')
        self.assertIn('Agent.', self.read(METHOD))
        with self.assertRaises(LookupError):
            app.tasks.get('t')
        again = app.tasks.create('t', 'Second time')
        self.assertEqual(again['title'], 'Second time')
        forced = app.tasks.finish('t', force=True)
        self.assertEqual((forced['changed'], forced['discarded']['pending']), ([], 0))
