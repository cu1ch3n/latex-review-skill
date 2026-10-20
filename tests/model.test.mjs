import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStops, nextPending, pendingUnits, progress, resolvedSide, stopState, visibleStop, wordDiff} from '../web/model.js';

const detail = {
  sections: [
    {blocks: [{kind: 'context'}, {kind: 'change', units: ['c002']}, {kind: 'gap'}, {kind: 'change', units: ['c001', 'c003']}]},
    {blocks: [{kind: 'change', units: ['c003']}]},
  ],
  loose: [{units: ['c004']}],
};

test('stops follow the document, then loose changes', () => {
  const stops = buildStops(detail);
  assert.deepEqual(stops.map(s => s.units), [['c002'], ['c001', 'c003'], ['c003'], ['c004']]);
  assert.deepEqual(stops.map(s => s.section), [0, 0, 1, null]);
  assert.equal(new Set(stops.map(s => s.key)).size, 4);
});

test('automatic advance skips decided stops and wraps around', () => {
  const stops = buildStops(detail);
  const decisions = {c001: 'pending', c002: 'accepted', c003: 'commented', c004: 'pending'};
  assert.equal(nextPending(stops, decisions), 1);
  assert.equal(nextPending(stops, decisions, 1), 3);
  assert.equal(nextPending(stops, decisions, 3), 1);
  assert.deepEqual(pendingUnits(stops[1], decisions), ['c001']);
  decisions.c001 = decisions.c004 = 'rejected';
  assert.equal(nextPending(stops, decisions, 2), -1);
  assert.equal(nextPending([], decisions), -1);
});

test('decided blocks show the chosen version', () => {
  const decisions = {a: 'accepted', b: 'rejected', c: 'commented', d: 'pending'};
  assert.equal(resolvedSide(['a'], decisions), 'after');
  assert.equal(resolvedSide(['b'], decisions), 'before');
  assert.equal(resolvedSide(['a', 'b'], decisions), null);
  assert.equal(resolvedSide(['c'], decisions), null);
  assert.equal(resolvedSide([], decisions), null);
  assert.equal(stopState(['a'], decisions), 'accepted');
  assert.equal(stopState(['a', 'd'], decisions), 'pending');
  assert.equal(stopState(['a', 'b'], decisions), 'mixed');
  assert.deepEqual(progress(decisions), {accepted: 1, rejected: 1, commented: 1, pending: 1, total: 4, decided: 3});
});

test('scrolling keeps the selected stop while it is visible', () => {
  const regions = [{index: 0, top: 85, bottom: 276}, {index: 1, top: 427, bottom: 618}];
  assert.equal(visibleStop(regions, 1, 70, 645), 1);
  assert.equal(visibleStop(regions, 1, 70, 400), 0);
  assert.equal(visibleStop(regions, 0, 300, 645), 1);
  assert.equal(visibleStop([], 1, 70, 645), 1);
});

test('source diffs work on LaTeX tokens and read as phrases', () => {
  assert.deepEqual(wordDiff('Our method has three steps.\n', 'Our method proceeds in three steps.\n'), [
    {type: 'equal', text: 'Our method '}, {type: 'del', text: 'has'}, {type: 'ins', text: 'proceeds in'},
    {type: 'equal', text: ' three steps.\n'}]);
  assert.deepEqual(wordDiff('\\emph{x}', '\\textbf{x}'), [
    {type: 'del', text: '\\emph'}, {type: 'ins', text: '\\textbf'}, {type: 'equal', text: '{x}'}]);
  assert.deepEqual(wordDiff('', 'new file\n'), [{type: 'ins', text: 'new file\n'}]);
  assert.deepEqual(wordDiff('same', 'same'), [{type: 'equal', text: 'same'}]);
  const long = Array.from({length: 2000}, (_, i) => `w${i}`).join(' ');
  const parts = wordDiff(long, long.replace('w1000', 'changed'));
  assert.equal(parts.filter(p => p.type !== 'equal').map(p => p.text).join('|'), 'w1000|changed');
});
