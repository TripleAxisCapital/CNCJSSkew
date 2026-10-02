import { rotateVector, transformPoint } from './alignment.js';

const MM_PER_INCH = 25.4;
const ALIGNMENT_MARKER = 'CNCJSSkew aligned';
const TOLERANCE = 1e-10;

export class GCodeTransformError extends Error {
  constructor(message, lineNumber = null, line = '') {
    super(lineNumber ? `Line ${lineNumber}: ${message}` : message);
    this.name = 'GCodeTransformError';
    this.lineNumber = lineNumber;
    this.line = line;
  }
}

function isCode(value, expected) {
  return Math.abs(Number(value) - expected) < 1e-7;
}

function unitScale(units) {
  return units === 'inch' ? MM_PER_INCH : 1;
}

function toMm(value, units) {
  return value * unitScale(units);
}

function fromMm(value, units) {
  return value / unitScale(units);
}

function normalizeNegativeZero(value) {
  return Math.abs(value) < 0.0000005 ? 0 : value;
}

export function formatGcodeNumber(value, decimals = 5) {
  const safe = normalizeNegativeZero(value);
  let out = safe.toFixed(decimals);
  out = out.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (out === '-0') out = '0';
  return out;
}

/** Tokenize letter/number words while ignoring semicolon and parenthesized comments. */
export function tokenizeGcodeLine(line) {
  const tokens = [];
  let i = 0;
  let parenDepth = 0;
  let semicolonIndex = -1;

  while (i < line.length) {
    const ch = line[i];
    if (ch === ';' && parenDepth === 0) {
      semicolonIndex = i;
      break;
    }
    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1;
      i += 1;
      continue;
    }
    if (parenDepth > 0) {
      i += 1;
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      const start = i;
      const letter = ch;
      i += 1;
      while (i < line.length && /\s/.test(line[i])) i += 1;
      const numberStart = i;
      const rest = line.slice(i);
      const match = rest.match(/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))/);
      if (match) {
        const rawNumber = match[0];
        const end = i + rawNumber.length;
        tokens.push({
          letter: letter.toUpperCase(),
          originalLetter: letter,
          value: Number(rawNumber),
          start,
          numberStart,
          end,
          raw: line.slice(start, end)
        });
        i = end;
        continue;
      }
    }
    i += 1;
  }

  return { tokens, semicolonIndex };
}

function insertBeforeSemicolon(line, addition, semicolonIndex) {
  if (!addition) return line;
  if (semicolonIndex >= 0) {
    const before = line.slice(0, semicolonIndex).replace(/\s+$/, '');
    const after = line.slice(semicolonIndex);
    return `${before}${addition} ${after}`;
  }
  return `${line.replace(/\s+$/, '')}${addition}`;
}

function applyTokenReplacements(line, replacements, additions, semicolonIndex) {
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let output = line;
  for (const replacement of sorted) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }

  // Token replacement can shift the semicolon index, so find it again.
  const updated = tokenizeGcodeLine(output);
  return insertBeforeSemicolon(output, additions.join(''), updated.semicolonIndex);
}

function wordMap(tokens) {
  const map = new Map();
  for (const token of tokens) {
    const arr = map.get(token.letter) || [];
    arr.push(token);
    map.set(token.letter, arr);
  }
  return map;
}

function lastWord(map, letter) {
  const items = map.get(letter);
  return items && items.length ? items[items.length - 1] : null;
}

function allGCodes(map) {
  return (map.get('G') || []).map(token => token.value);
}

function containsDynamicExpression(line) {
  // Parentheses are comments in GRBL, so strip comments before checking.
  const { tokens, semicolonIndex } = tokenizeGcodeLine(line);
  let code = semicolonIndex >= 0 ? line.slice(0, semicolonIndex) : line;
  // Remove parenthesized comments.
  code = code.replace(/\([^)]*\)/g, '');
  // A # variable or [expression] means static rewriting is not guaranteed safe.
  return code.includes('#') || code.includes('[') || code.includes(']') || tokens.some(t => !Number.isFinite(t.value));
}

function getMotionFromGCodes(gCodes, currentMotion) {
  let motion = currentMotion;
  for (const g of gCodes) {
    if (isCode(g, 0)) motion = 'G0';
    else if (isCode(g, 1)) motion = 'G1';
    else if (isCode(g, 2)) motion = 'G2';
    else if (isCode(g, 3)) motion = 'G3';
    else if (g >= 38 && g < 39) motion = `G${g}`;
    else if (isCode(g, 80)) motion = null;
    else if (g > 80 && g < 90) motion = `G${g}`;
  }
  return motion;
}

function getWcs(gCodes) {
  for (const g of gCodes) {
    if (g >= 54 && g <= 59.3) {
      // Do not treat G59.4+ as WCS.
      if ([54,55,56,57,58,59,59.1,59.2,59.3].some(v => isCode(g, v))) {
        return `G${formatGcodeNumber(g, 1)}`;
      }
    }
  }
  return null;
}

function ensureSupportedCoordinateCommands(gCodes, hasXY, lineNumber, line) {
  const unsupported = [];
  for (const g of gCodes) {
    if (isCode(g, 68) || isCode(g, 69)) unsupported.push(`G${g} program rotation`);
    if (isCode(g, 50) || isCode(g, 51)) unsupported.push(`G${g} scaling`);
    if (isCode(g, 90.1) || isCode(g, 91.1)) unsupported.push(`G${g} absolute/incremental arc-center mode`);
    if (hasXY && (isCode(g, 10) || isCode(g, 92) || isCode(g, 92.1) || isCode(g, 92.2) || isCode(g, 92.3))) {
      unsupported.push(`G${g} coordinate-offset command with X/Y`);
    }
    if (hasXY && (isCode(g, 28) || isCode(g, 30))) unsupported.push(`G${g} with X/Y`);
    if (hasXY && g >= 38 && g < 39) unsupported.push(`G${g} probing move with X/Y`);
    if (hasXY && g >= 80 && g < 90) unsupported.push(`G${g} canned cycle with X/Y`);
  }
  if (unsupported.length) {
    throw new GCodeTransformError(`Unsupported for safe XY alignment: ${unsupported.join(', ')}.`, lineNumber, line);
  }
}

/**
 * Rotate + translate a GRBL/Fusion style 3-axis program into the currently
 * measured work coordinate frame. Z, feeds, spindle commands and machine-only
 * moves are preserved.
 */
export function transformGcode(gcode, transform, options = {}) {
  if (typeof gcode !== 'string' || !gcode.trim()) {
    throw new GCodeTransformError('No G-code is loaded.');
  }
  if (gcode.includes(ALIGNMENT_MARKER) && !options.allowRealign) {
    throw new GCodeTransformError('This program already contains a CNCJSSkew alignment marker. Restore/reload the original program before applying a new alignment.');
  }
  if (!transform || !Number.isFinite(transform.angleRad) || !transform.translation) {
    throw new GCodeTransformError('A valid alignment transform is required.');
  }

  const decimals = Number.isInteger(options.decimals) ? options.decimals : 5;
  const lines = gcode.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const output = [];
  const wcsSeen = new Set();
  const warnings = [];
  const stats = {
    totalLines: lines.length,
    transformedMotionLines: 0,
    transformedArcLines: 0,
    machineCoordinateLinesPreserved: 0,
    addedAxisWords: 0
  };

  const state = {
    units: 'mm',
    distanceMode: 'absolute',
    plane: 'G17',
    motion: null,
    cadPosition: { x: 0, y: 0 },
    known: { x: false, y: false }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];

    if (containsDynamicExpression(line)) {
      throw new GCodeTransformError('Dynamic expressions/macros (# or [ ]) are not supported because they cannot be safely transformed statically.', lineNumber, line);
    }

    const parsed = tokenizeGcodeLine(line);
    const map = wordMap(parsed.tokens);
    const gCodes = allGCodes(map);
    const xToken = lastWord(map, 'X');
    const yToken = lastWord(map, 'Y');
    const iToken = lastWord(map, 'I');
    const jToken = lastWord(map, 'J');
    const hasXY = !!(xToken || yToken);
    const hasIJ = !!(iToken || jToken);

    // Modal updates apply to coordinates in this block.
    if (gCodes.some(g => isCode(g, 20))) state.units = 'inch';
    if (gCodes.some(g => isCode(g, 21))) state.units = 'mm';
    if (gCodes.some(g => isCode(g, 90))) state.distanceMode = 'absolute';
    if (gCodes.some(g => isCode(g, 91))) state.distanceMode = 'incremental';
    if (gCodes.some(g => isCode(g, 17))) state.plane = 'G17';
    if (gCodes.some(g => isCode(g, 18))) state.plane = 'G18';
    if (gCodes.some(g => isCode(g, 19))) state.plane = 'G19';
    state.motion = getMotionFromGCodes(gCodes, state.motion);

    const wcs = getWcs(gCodes);
    if (wcs) wcsSeen.add(wcs);

    ensureSupportedCoordinateCommands(gCodes, hasXY, lineNumber, line);

    const isG53 = gCodes.some(g => isCode(g, 53));
    if (isG53) {
      if (hasXY) {
        throw new GCodeTransformError('G53 machine-coordinate X/Y moves cannot be safely re-oriented. Use G53 only for Z/retract moves in an aligned program.', lineNumber, line);
      }
      stats.machineCoordinateLinesPreserved += 1;
      output.push(line);
      continue;
    }

    const isArc = state.motion === 'G2' || state.motion === 'G3';
    const isLinear = state.motion === 'G0' || state.motion === 'G1';
    const isTransformableMotion = isLinear || isArc;

    if (isArc && state.plane !== 'G17' && Math.abs(transform.angleRad) > TOLERANCE) {
      throw new GCodeTransformError(`${state.motion} in ${state.plane} cannot be safely represented after XY rotation. Use G17 XY-plane arcs or linearize the toolpath in CAM.`, lineNumber, line);
    }

    if (!isTransformableMotion) {
      if (hasXY || hasIJ) {
        // Coordinate words on a non-motion command are ambiguous and risky.
        throw new GCodeTransformError(`X/Y/I/J words are present while modal motion is ${state.motion || 'unknown'}. This block cannot be safely transformed.`, lineNumber, line);
      }
      output.push(line);
      continue;
    }

    const replacements = [];
    const additions = [];

    const replaceToken = (token, letter, numericValue) => {
      const text = `${token.originalLetter}${formatGcodeNumber(numericValue, decimals)}`;
      replacements.push({ start: token.start, end: token.end, text });
    };
    const addWord = (letter, numericValue) => {
      additions.push(` ${letter}${formatGcodeNumber(numericValue, decimals)}`);
      stats.addedAxisWords += 1;
    };

    if (hasXY) {
      if (state.distanceMode === 'absolute') {
        if (!xToken && !state.known.x) {
          throw new GCodeTransformError('Absolute motion omits X before the program has established a known X position. Output both X and Y on the first XY move from CAM.', lineNumber, line);
        }
        if (!yToken && !state.known.y) {
          throw new GCodeTransformError('Absolute motion omits Y before the program has established a known Y position. Output both X and Y on the first XY move from CAM.', lineNumber, line);
        }

        const targetCad = {
          x: xToken ? toMm(xToken.value, state.units) : state.cadPosition.x,
          y: yToken ? toMm(yToken.value, state.units) : state.cadPosition.y
        };
        const targetAligned = transformPoint(targetCad, transform);
        const outX = fromMm(targetAligned.x, state.units);
        const outY = fromMm(targetAligned.y, state.units);

        if (xToken) replaceToken(xToken, 'X', outX); else addWord('X', outX);
        if (yToken) replaceToken(yToken, 'Y', outY); else addWord('Y', outY);

        state.cadPosition = targetCad;
        state.known.x = true;
        state.known.y = true;
      } else {
        const deltaCad = {
          x: xToken ? toMm(xToken.value, state.units) : 0,
          y: yToken ? toMm(yToken.value, state.units) : 0
        };
        const deltaAligned = rotateVector(deltaCad, transform.angleRad);
        const outX = fromMm(deltaAligned.x, state.units);
        const outY = fromMm(deltaAligned.y, state.units);

        if (xToken) replaceToken(xToken, 'X', outX); else addWord('X', outX);
        if (yToken) replaceToken(yToken, 'Y', outY); else addWord('Y', outY);

        if (state.known.x) state.cadPosition.x += deltaCad.x;
        if (state.known.y) state.cadPosition.y += deltaCad.y;
      }
      stats.transformedMotionLines += 1;
    }

    if (isArc && hasIJ) {
      const centerOffsetCad = {
        x: iToken ? toMm(iToken.value, state.units) : 0,
        y: jToken ? toMm(jToken.value, state.units) : 0
      };
      const centerOffsetAligned = rotateVector(centerOffsetCad, transform.angleRad);
      const outI = fromMm(centerOffsetAligned.x, state.units);
      const outJ = fromMm(centerOffsetAligned.y, state.units);

      if (iToken) replaceToken(iToken, 'I', outI); else addWord('I', outI);
      if (jToken) replaceToken(jToken, 'J', outJ); else addWord('J', outJ);
      stats.transformedArcLines += 1;
    }

    if (!hasXY && isArc && hasIJ) {
      // Full-circle arc: endpoint is unchanged but center vector rotates.
      stats.transformedMotionLines += 1;
    }

    output.push(applyTokenReplacements(line, replacements, additions, parsed.semicolonIndex));
  }

  if (wcsSeen.size > 1) {
    throw new GCodeTransformError(`Program uses multiple work coordinate systems (${[...wcsSeen].join(', ')}). CNCJSSkew intentionally refuses multi-WCS programs because one captured alignment cannot safely describe all offsets.`);
  }

  if (stats.transformedMotionLines === 0) {
    throw new GCodeTransformError('No transformable XY motion was found in the loaded G-code.');
  }

  const header = [
    `; ${ALIGNMENT_MARKER}`,
    `; rotation_deg=${formatGcodeNumber(transform.angleDeg, 6)} translation_mm=X${formatGcodeNumber(transform.translation.x, 5)} Y${formatGcodeNumber(transform.translation.y, 5)}`,
    `; reference_spacing_mm=cad:${formatGcodeNumber(transform.cadDistanceMm, 5)} measured:${formatGcodeNumber(transform.measuredDistanceMm, 5)} error:${formatGcodeNumber(transform.spacingErrorMm, 5)}`
  ];

  if (Math.abs(transform.spacingErrorMm) > 0.1) {
    warnings.push(`Reference spacing differs by ${Math.abs(transform.spacingErrorMm).toFixed(3)} mm. Alignment was allowed, but re-centering the reference points may improve accuracy.`);
  }

  return {
    gcode: `${header.join('\n')}\n${output.join('\n')}`,
    stats,
    warnings,
    programWcs: wcsSeen.size === 1 ? [...wcsSeen][0] : null
  };
}

export { ALIGNMENT_MARKER };
