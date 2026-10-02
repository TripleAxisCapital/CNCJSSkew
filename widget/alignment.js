export const EPSILON = 1e-9;

export function assertFinitePoint(point, label = 'point') {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    throw new Error(`${label} must contain finite X and Y values.`);
  }
  return { x: Number(point.x), y: Number(point.y) };
}

export function distance(a, b) {
  const p = assertFinitePoint(a, 'point A');
  const q = assertFinitePoint(b, 'point B');
  return Math.hypot(q.x - p.x, q.y - p.y);
}

export function normalizeAngleRadians(angle) {
  let value = angle;
  while (value <= -Math.PI) value += Math.PI * 2;
  while (value > Math.PI) value -= Math.PI * 2;
  return value;
}

export function rotateVector(vector, angleRad) {
  const p = assertFinitePoint(vector, 'vector');
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return {
    x: (p.x * c) - (p.y * s),
    y: (p.x * s) + (p.y * c)
  };
}

export function transformPoint(point, transform) {
  const p = assertFinitePoint(point, 'point');
  if (!transform || !Number.isFinite(transform.angleRad)) {
    throw new Error('A valid alignment transform is required.');
  }
  const rotated = rotateVector(p, transform.angleRad);
  return {
    x: rotated.x + transform.translation.x,
    y: rotated.y + transform.translation.y
  };
}

/**
 * Compute the best rigid 2D mapping (rotation + translation, no scale) from
 * two CAD/program reference points to two measured work-coordinate points.
 *
 * Translation is based on the two midpoints so any small reference-spacing
 * measurement error is shared equally between the two references instead of
 * being placed entirely on point B.
 */
export function computeRigidTransform(cadA, cadB, measuredA, measuredB, options = {}) {
  const A = assertFinitePoint(cadA, 'CAD point A');
  const B = assertFinitePoint(cadB, 'CAD point B');
  const P = assertFinitePoint(measuredA, 'measured point A');
  const Q = assertFinitePoint(measuredB, 'measured point B');

  const {
    minReferenceDistanceMm = 5,
    maxSpacingErrorMm = 0.5,
    maxRotationDeg = 15
  } = options;

  const cadVector = { x: B.x - A.x, y: B.y - A.y };
  const measuredVector = { x: Q.x - P.x, y: Q.y - P.y };
  const cadDistanceMm = Math.hypot(cadVector.x, cadVector.y);
  const measuredDistanceMm = Math.hypot(measuredVector.x, measuredVector.y);

  if (cadDistanceMm < minReferenceDistanceMm) {
    throw new Error(`CAD reference points are too close together (${cadDistanceMm.toFixed(3)} mm). Use points at least ${minReferenceDistanceMm} mm apart.`);
  }
  if (measuredDistanceMm < minReferenceDistanceMm) {
    throw new Error(`Measured reference points are too close together (${measuredDistanceMm.toFixed(3)} mm). Re-capture the references.`);
  }

  const cadAngle = Math.atan2(cadVector.y, cadVector.x);
  const measuredAngle = Math.atan2(measuredVector.y, measuredVector.x);
  const angleRad = normalizeAngleRadians(measuredAngle - cadAngle);
  const angleDeg = angleRad * 180 / Math.PI;

  if (Math.abs(angleDeg) > maxRotationDeg) {
    throw new Error(`Measured rotation is ${angleDeg.toFixed(3)}°, which exceeds the ${maxRotationDeg}° safety limit. Re-check the captured points or raise the limit deliberately.`);
  }

  const spacingErrorMm = measuredDistanceMm - cadDistanceMm;
  if (Math.abs(spacingErrorMm) > maxSpacingErrorMm) {
    throw new Error(`Reference spacing differs by ${Math.abs(spacingErrorMm).toFixed(3)} mm, exceeding the ${maxSpacingErrorMm.toFixed(3)} mm safety limit. Re-center the tool on both references before applying alignment.`);
  }

  const cadMid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const measuredMid = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
  const rotatedCadMid = rotateVector(cadMid, angleRad);
  const translation = {
    x: measuredMid.x - rotatedCadMid.x,
    y: measuredMid.y - rotatedCadMid.y
  };

  const transform = {
    angleRad,
    angleDeg,
    translation,
    cadDistanceMm,
    measuredDistanceMm,
    spacingErrorMm,
    endpointResidualMm: Math.abs(spacingErrorMm) / 2,
    cadA: A,
    cadB: B,
    measuredA: P,
    measuredB: Q
  };

  const mappedA = transformPoint(A, transform);
  const mappedB = transformPoint(B, transform);
  transform.mappedA = mappedA;
  transform.mappedB = mappedB;
  transform.residualA = { x: P.x - mappedA.x, y: P.y - mappedA.y };
  transform.residualB = { x: Q.x - mappedB.x, y: Q.y - mappedB.y };

  return transform;
}
