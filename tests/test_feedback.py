"""Waiting for review completion preserves feedback until the agent receives it."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from helpers import ROOT
from latex_review import cli


class FeedbackTests(unittest.TestCase):
    def test_a_message_ends_both_wait_modes_even_while_building(self):
        for state in ('reviewing', 'building'):
            for wait in (None, 60):
                with self.subTest(state=state, wait=wait), tempfile.TemporaryDirectory() as folder:
                    cursor = Path(folder) / 'cursor'
                    cursor.write_text('7')
                    items = [{'id': 8, 'kind': 'comment', 'text': 'Keep the example.'},
                             {'id': 9, 'kind': 'note', 'text': 'Pause and rethink the approach.'}]
                    client = Mock()
                    client.get.side_effect = [{'state': state, 'feedback': items, 'cursor': 9}, {'url': 'review'}]
                    with patch.object(cli, 'cursor_file', return_value=cursor), \
                            patch.object(cli.time, 'sleep', side_effect=AssertionError('Must return on the message')), \
                            patch.object(cli, 'emit') as emit:
                        cli.feedback(client, ROOT, 'task', SimpleNamespace(wait=wait, all=False))
                    result = emit.call_args.args[0]
                    self.assertEqual(result['state'], state)
                    self.assertEqual(result['feedback'], items)
                    self.assertNotIn('waited', result)
                    self.assertEqual(cursor.read_text(), '9')

    def test_unlimited_wait_survives_long_reviews_without_consuming_partial_feedback(self):
        with tempfile.TemporaryDirectory() as folder:
            cursor = Path(folder) / 'cursor'
            cursor.write_text('7')
            elapsed = [0]
            partial = {'id': 8, 'kind': 'comment', 'text': 'Keep the example.'}
            responses = iter([
                {'state': 'building', 'feedback': [], 'cursor': 7},
                {'state': 'reviewing', 'feedback': [partial], 'cursor': 8},
                {'state': 'revise', 'feedback': [partial, {'id': 9, 'kind': 'accept'}], 'cursor': 9},
            ])

            def get(path):
                if path.endswith('/feedback?after=7'):
                    return next(responses)
                return {'url': 'http://localhost/review'}

            def sleep(_):
                self.assertEqual(cursor.read_text(), '7')
                elapsed[0] += 4000  # A review can take longer than the bounded wait's one-hour limit.

            with patch.object(cli, 'cursor_file', return_value=cursor), \
                    patch.object(cli.time, 'monotonic', side_effect=lambda: elapsed[0]), \
                    patch.object(cli.time, 'sleep', side_effect=sleep), patch.object(cli, 'emit') as emit:
                cli.feedback(Mock(get=get), ROOT, 'task', SimpleNamespace(wait=None, all=False))
            result = emit.call_args.args[0]
            self.assertEqual(result['state'], 'revise')
            self.assertEqual([item['id'] for item in result['feedback']], [8, 9])
            emit.assert_called_once()
            self.assertEqual(cursor.read_text(), '9')

    def test_bounded_wait_still_returns_on_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            cursor = Path(folder) / 'cursor'
            elapsed = [0]

            def get(path):
                return {'state': 'reviewing', 'feedback': [], 'cursor': 0} if '/feedback?' in path else {'url': 'review'}

            def sleep(seconds):
                elapsed[0] += seconds

            with patch.object(cli, 'cursor_file', return_value=cursor), \
                    patch.object(cli.time, 'monotonic', side_effect=lambda: elapsed[0]), \
                    patch.object(cli.time, 'sleep', side_effect=sleep), patch.object(cli, 'emit') as emit:
                cli.feedback(Mock(get=get), ROOT, 'task', SimpleNamespace(wait=5, all=False))
            self.assertEqual(emit.call_args.args[0]['waited'], 5)
            self.assertEqual(emit.call_args.args[0]['state'], 'reviewing')
