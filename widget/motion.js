import { assertFinitePoint } from './alignment.js';

function format(value, digits = 4) {
  const n = Math.abs(Number(value)) < 0.0000005 ? 0 : Number(value);
  return n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function validWcs(value) {
  return /^G(?:5[4-9](?:\.[123])?)$/.test(String(value || ''));
}

/**
 * Build a conservative midpoint move using work coordinates.
 *
 * The Z leg is always completed before XY by an explicit G4 P0 planner drain.
 * targetZ is max(current Z, configured safe Z), so this helper never lowers Z
 * before the horizontal move. Modal units/distance mode are restored afterward.
 */
export function buildSafeMidpointMove({
  currentPositionMm,
  midpointMm,
  mode = 'xy',
  safeZMm,
  activeWcs = 'G54',
  modalUnits = 'G21',
  modalDistance = 'G90'
}) {
  const current = assertFinitePoint(currentPositionMm, 'current position');
  const midpoint = assertFinitePoint(midpointMm, 'midpoint');
  const currentZ = Number(currentPositionMm?.z);
  const safeZ = Number(safeZMm);

  if (!Number.isFinite(currentZ)) throw new Error('Current Z position is not available.');
  if (!Number.isFinite(safeZ)) throw new Error('Safe Z must be a finite number.');
  if (!['x', 'y', 'xy'].includes(mode)) throw new Error('Midpoint move mode must be X, Y, or XY.');
  if (!validWcs(activeWcs)) throw new Error(`Unsupported work coordinate system: ${activeWcs}.`);

  const targetZ = Math.max(currentZ, safeZ);
  const horizontalWords = [];
  if (mode === 'x' || mode === 'xy') horizontalWords.push(`X${format(midpoint.x)}`);
  if (mode === 'y' || mode === 'xy') horizontalWords.push(`Y${format(midpoint.y)}`);

  const commands = [
    activeWcs,
    'G21',
    'G90',
    `G0 Z${format(targetZ)}`,
    'G4 P0',
    `G0 ${horizontalWords.join(' ')}`,
    'G4 P0'
  ];

  if (modalUnits === 'G20') commands.push('G20');
  if (modalDistance === 'G91') commands.push('G91');

  return {
    commands,
    target: {
      x: mode === 'x' || mode === 'xy' ? midpoint.x : current.x,
      y: mode === 'y' || mode === 'xy' ? midpoint.y : current.y,
      z: targetZ
    },
    targetZ
  };
}
