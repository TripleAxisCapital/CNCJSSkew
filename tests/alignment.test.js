import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyResidual,
  computeRigidTransform,
  midpointBetween,
  normalizeQualityThresholds,
  rotateVector,
  transformPoint,
  verifyTransformedPoint,
  workOffsetDifference
} from '../widget/alignment.js';

const near = (actual, expected, tol = 1e-9) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} != ${expected}`);

test('computes exact 90 degree rotation and translation', () => {
  const t = computeRigidTransform(
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 10, y: 20 }, { x: 10, y: 120 },
    { maxRotationDeg: 100 }
  );
  near(t.angleDeg, 90);
  near(t.translation.x, 10);
  near(t.translation.y, 20);
  const p = transformPoint({ x: 25, y: 5 }, t);
  near(p.x, 5);
  near(p.y, 45);
});

test('uses midpoint translation when measured spacing differs slightly', () => {
  const t = computeRigidTransform(
    { x: 0, y: -40 }, { x: 0, y: 40 },
    { x: 100, y: 10 }, { x: 100, y: 90.2 },
    { maxSpacingErrorMm: 1 }
  );
  near(t.spacingErrorMm, 0.2, 1e-9);
  near(t.endpointResidualMm, 0.1, 1e-9);
  near(t.translation.x, 100, 1e-9);
  near(t.translation.y, 50.1, 1e-9);
});

test('rejects coincident CAD points', () => {
  assert.throws(() => computeRigidTransform(
    { x: 1, y: 1 }, { x: 1, y: 1 },
    { x: 0, y: 0 }, { x: 10, y: 0 }
  ), /must be different/);
});

test('rejects excessive spacing error when enabled', () => {
  assert.throws(() => computeRigidTransform(
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 0, y: 0 }, { x: 102, y: 0 },
    { maxSpacingErrorMm: 0.5 }
  ), /spacing differs/);
});

test('allows any spacing error when spacing limit is disabled', () => {
  const t = computeRigidTransform(
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 0, y: 0 }, { x: 250, y: 0 },
    { maxSpacingErrorMm: null, maxRotationDeg: null }
  );
  near(t.spacingErrorMm, 150);
});

test('allows any rotation when rotation limit is disabled', () => {
  const t = computeRigidTransform(
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 0, y: 0 }, { x: -100, y: 0 },
    { maxSpacingErrorMm: null, maxRotationDeg: null }
  );
  near(Math.abs(t.angleDeg), 180);
});

test('midpointBetween returns diagonal midpoint', () => {
  const p = midpointBetween({ x: -10, y: 20 }, { x: 30, y: 80 });
  near(p.x, 10);
  near(p.y, 50);
});

test('verification point reports independent residual', () => {
  const transform = computeRigidTransform(
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 10, y: 20 }, { x: 110, y: 20 }
  );
  const verification = verifyTransformedPoint(
    { x: 50, y: 25 },
    { x: 60.012, y: 44.991 },
    transform
  );
  near(verification.predicted.x, 60);
  near(verification.predicted.y, 45);
  near(verification.residual.x, 0.012, 1e-9);
  near(verification.residual.y, -0.009, 1e-9);
  near(verification.errorMm, 0.015, 1e-9);
});

test('quality classifier uses ordered configurable thresholds', () => {
  assert.equal(classifyResidual(0.01).key, 'excellent');
  assert.equal(classifyResidual(0.04).key, 'good');
  assert.equal(classifyResidual(0.08).key, 'acceptable');
  assert.equal(classifyResidual(0.2).key, 'check');
  assert.throws(() => normalizeQualityThresholds({ excellentMm: 0.1, goodMm: 0.05, acceptableMm: 0.2 }), /ordered/);
});

test('work offset difference reports XY delta magnitude', () => {
  const d = workOffsetDifference({ x: 10, y: 20 }, { x: 10.03, y: 19.96 });
  near(d.x, 0.03, 1e-9);
  near(d.y, -0.04, 1e-9);
  near(d.distanceMm, 0.05, 1e-9);
});

test('rotateVector does not translate', () => {
  const v = rotateVector({ x: 10, y: 0 }, Math.PI / 2);
  near(v.x, 0, 1e-9);
  near(v.y, 10, 1e-9);
});
