import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRigidTransform } from '../widget/alignment.js';
import { transformGcode, tokenizeGcodeLine } from '../widget/gcode-transform.js';

const ninety = computeRigidTransform(
  { x: 0, y: 0 }, { x: 100, y: 0 },
  { x: 10, y: 20 }, { x: 10, y: 120 },
  { maxRotationDeg: 100 }
);

test('tokenizer ignores comments', () => {
  const result = tokenizeGcodeLine('G1 X10 (X999) Y20 ; X777');
  const values = result.tokens.map(t => `${t.letter}${t.value}`);
  assert.deepEqual(values, ['G1', 'X10', 'Y20']);
});

test('transforms absolute XY moves', () => {
  const src = 'G21\nG90\nG54\nG0 X0 Y0\nG1 X10 Y0 F100\n';
  const result = transformGcode(src, ninety);
  assert.match(result.gcode, /G0 X10 Y20/);
  assert.match(result.gcode, /G1 X10 Y30 F100/);
  assert.equal(result.programWcs, 'G54');
});

test('adds missing coupled axis on absolute move', () => {
  const src = 'G21\nG90\nG0 X0 Y0\nG1 X10\n';
  const result = transformGcode(src, ninety);
  assert.match(result.gcode, /G1 X10 Y30/);
});

test('rotates incremental vectors without translation', () => {
  const src = 'G21\nG91\nG1 X10 Y0\n';
  const result = transformGcode(src, ninety);
  assert.match(result.gcode, /G1 X0 Y10/);
});

test('rotates G17 arc endpoint and I/J offsets', () => {
  const src = 'G21\nG90\nG17\nG0 X0 Y0\nG2 X10 Y0 I5 J0\n';
  const result = transformGcode(src, ninety);
  assert.match(result.gcode, /G2 X10 Y30 I0 J5/);
  assert.equal(result.stats.transformedArcLines, 1);
});

test('preserves G53 Z move', () => {
  const src = 'G21\nG90\nG0 X0 Y0\nG53 G0 Z-5\nG1 X10 Y0\n';
  const result = transformGcode(src, ninety);
  assert.match(result.gcode, /G53 G0 Z-5/);
});

test('rejects G53 XY move', () => {
  const src = 'G21\nG90\nG53 G0 X0 Y0\n';
  assert.throws(() => transformGcode(src, ninety), /G53 machine-coordinate X\/Y/);
});

test('rejects non-G17 arcs after rotation', () => {
  const src = 'G21\nG90\nG18\nG0 X0 Y0\nG2 X10 Z-1 I5 K0\n';
  assert.throws(() => transformGcode(src, ninety), /G18 cannot be safely represented/);
});

test('handles inch programs while transform remains mm based', () => {
  const src = 'G20\nG90\nG0 X0 Y0\nG1 X1 Y0\n';
  const result = transformGcode(src, ninety);
  // Translation 10,20 mm => 0.39370,0.78740 in. 1 inch X rotated => +1 inch Y.
  assert.match(result.gcode, /G0 X0\.3937 Y0\.7874/);
  assert.match(result.gcode, /G1 X0\.3937 Y1\.7874/);
});

test('rejects double alignment marker', () => {
  const src = '; CNCJSSkew aligned\nG21\nG90\nG0 X0 Y0\n';
  assert.throws(() => transformGcode(src, ninety), /already contains/);
});

test('rejects multi-WCS program', () => {
  const src = 'G21\nG90\nG54\nG0 X0 Y0\nG55\nG1 X10 Y0\n';
  assert.throws(() => transformGcode(src, ninety), /multiple work coordinate systems/);
});
