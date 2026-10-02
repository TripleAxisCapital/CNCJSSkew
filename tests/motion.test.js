import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeMidpointMove } from '../widget/motion.js';

test('midpoint move retracts before XY and drains planner', () => {
  const result = buildSafeMidpointMove({
    currentPositionMm: { x: 0, y: 0, z: -2 },
    midpointMm: { x: 10, y: 20 },
    mode: 'xy',
    safeZMm: 5,
    activeWcs: 'G54',
    modalUnits: 'G21',
    modalDistance: 'G90'
  });
  assert.deepEqual(result.commands.slice(0, 7), [
    'G54', 'G21', 'G90', 'G0 Z5', 'G4 P0', 'G0 X10 Y20', 'G4 P0'
  ]);
  assert.deepEqual(result.target, { x: 10, y: 20, z: 5 });
});

test('midpoint move never lowers Z before horizontal motion', () => {
  const result = buildSafeMidpointMove({
    currentPositionMm: { x: 1, y: 2, z: 12 },
    midpointMm: { x: 10, y: 20 },
    mode: 'x',
    safeZMm: 5,
    activeWcs: 'G55',
    modalUnits: 'G20',
    modalDistance: 'G91'
  });
  assert.equal(result.targetZ, 12);
  assert.match(result.commands.join('\n'), /G0 Z12\nG4 P0\nG0 X10/);
  assert.equal(result.commands.at(-2), 'G20');
  assert.equal(result.commands.at(-1), 'G91');
});

test('midpoint move rejects unknown WCS', () => {
  assert.throws(() => buildSafeMidpointMove({
    currentPositionMm: { x: 0, y: 0, z: 0 },
    midpointMm: { x: 1, y: 2 },
    safeZMm: 5,
    activeWcs: 'G53'
  }), /Unsupported work coordinate system/);
});
