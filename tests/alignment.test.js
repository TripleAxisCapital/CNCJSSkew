import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRigidTransform, transformPoint, rotateVector } from '../widget/alignment.js';

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

test('rejects points too close together', () => {
  assert.throws(() => computeRigidTransform(
    { x: 0, y: 0 }, { x: 1, y: 0 },
    { x: 0, y: 0 }, { x: 1, y: 0 }
  ), /too close/);
});

test('rejects excessive spacing error', () => {
  assert.throws(() => computeRigidTransform(
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 0, y: 0 }, { x: 102, y: 0 },
    { maxSpacingErrorMm: 0.5 }
  ), /spacing differs/);
});

test('rotateVector does not translate', () => {
  const v = rotateVector({ x: 10, y: 0 }, Math.PI / 2);
  near(v.x, 0, 1e-9);
  near(v.y, 10, 1e-9);
});
