import { computeRigidTransform, midpointBetween } from './alignment.js';
import { transformGcode, ALIGNMENT_MARKER } from './gcode-transform.js';

const MM_PER_INCH = 25.4;
const SERVER_STATE_KEY = 'cncjsskew';
const LOCAL_FALLBACK_KEY = 'cncjsskew.preferences.v2';
const LEGACY_SETTINGS_KEY = 'cncjsskew.settings.v1';

const qs = new URLSearchParams(window.location.search);
const token = qs.get('token') || '';
const host = qs.get('host') || window.location.origin;

const defaultPreferences = {
  settings: {
    cadA: { x: 0, y: -40 },
    cadB: { x: 0, y: 40 },
    spacingCheckEnabled: true,
    maxSpacingErrorMm: 0.25,
    rotationCheckEnabled: true,
    maxRotationDeg: 10
  },
  favorites: [],
  defaultFavoriteId: '',
  activeFavoriteId: '',
  autoApply: false
};

const state = {
  socketConnected: false,
  port: '',
  controllerType: '',
  activeState: '',
  workflow: 'idle',
  activeWcs: 'G54',
  modalUnits: 'G21',
  reportInches: false,
  workPositionMm: { x: NaN, y: NaN, z: NaN },
  machinePositionMm: { x: NaN, y: NaN, z: NaN },

  settings: structuredClone(defaultPreferences.settings),
  favorites: [],
  defaultFavoriteId: '',
  activeFavoriteId: '',
  autoApply: false,

  captureA: null,
  captureB: null,
  alignmentWcs: 'G54',
  transform: null,

  originalProgram: null,
  alignedProgram: null,
  currentProgramName: '',
  currentProgramIsAligned: false,
  pendingAutoApply: false,
  autoApplyInFlight: false,

  center: {
    p1: { x: null, y: null },
    p2: { x: null, y: null },
    mode: 'xy'
  },

  favoriteDraftName: '',
  persistenceReady: false,
  settingsOpen: false,
  message: {
    type: 'info',
    text: 'Capture two reference points to create an alignment, or load a saved favorite.'
  }
};

let socket = null;
let saveTimer = null;
let autoTimer = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function fixed(value, digits = 3) {
  return finite(value) ? Number(value).toFixed(digits) : '—';
}

function signed(value, digits = 3) {
  if (!finite(value)) return '—';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizePreferences(raw = {}) {
  const legacy = (() => {
    try {
      return JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY) || '{}');
    } catch {
      return {};
    }
  })();

  const rawSettings = raw.settings || raw || {};
  const migratedSettings = {
    ...defaultPreferences.settings,
    ...legacy,
    ...rawSettings,
    cadA: {
      ...defaultPreferences.settings.cadA,
      ...(legacy.cadA || {}),
      ...(rawSettings.cadA || {})
    },
    cadB: {
      ...defaultPreferences.settings.cadB,
      ...(legacy.cadB || {}),
      ...(rawSettings.cadB || {})
    }
  };

  if (rawSettings.maxSpacingErrorMm !== undefined && rawSettings.spacingCheckEnabled === undefined) {
    migratedSettings.spacingCheckEnabled = true;
  }
  if (rawSettings.maxRotationDeg !== undefined && rawSettings.rotationCheckEnabled === undefined) {
    migratedSettings.rotationCheckEnabled = true;
  }

  return {
    settings: migratedSettings,
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter(validFavorite) : [],
    defaultFavoriteId: String(raw.defaultFavoriteId || ''),
    activeFavoriteId: String(raw.activeFavoriteId || ''),
    autoApply: !!raw.autoApply
  };
}

function validFavorite(favorite) {
  return !!favorite && typeof favorite.id === 'string' && typeof favorite.name === 'string' && validTransform(favorite.transform);
}

function validTransform(transform) {
  return !!transform
    && finite(transform.angleRad)
    && transform.translation
    && finite(transform.translation.x)
    && finite(transform.translation.y);
}

function persistableState() {
  return {
    version: 2,
    settings: clone(state.settings),
    favorites: clone(state.favorites),
    defaultFavoriteId: state.defaultFavoriteId,
    activeFavoriteId: state.activeFavoriteId,
    autoApply: state.autoApply
  };
}

async function apiJson(path, options = {}, { allow404 = false } = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body.msg || body.message || detail;
    } catch { /* best effort */ }
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function loadPreferences() {
  let raw = null;

  try {
    raw = await apiJson(`/api/state?key=${encodeURIComponent(SERVER_STATE_KEY)}`, {}, { allow404: true });
  } catch (err) {
    console.warn('CNCJSSkew could not read Raspberry Pi state; using browser fallback.', err);
  }

  if (!raw) {
    try {
      raw = JSON.parse(localStorage.getItem(LOCAL_FALLBACK_KEY) || 'null');
    } catch {
      raw = null;
    }
  }

  const preferences = normalizePreferences(raw || {});
  state.settings = preferences.settings;
  state.favorites = preferences.favorites;
  state.defaultFavoriteId = preferences.defaultFavoriteId;
  state.activeFavoriteId = preferences.activeFavoriteId;
  state.autoApply = preferences.autoApply;

  const preferredId = state.defaultFavoriteId || state.activeFavoriteId;
  if (preferredId) {
    activateFavorite(preferredId, { quiet: true, persist: false });
  }

  state.persistenceReady = true;
  render();
}

function scheduleSave() {
  if (!state.persistenceReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePreferences, 180);
}

async function savePreferences() {
  const payload = persistableState();
  try {
    localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(payload));
  } catch { /* browser fallback is optional */ }

  try {
    await apiJson(`/api/state?key=${encodeURIComponent(SERVER_STATE_KEY)}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn('CNCJSSkew could not save Raspberry Pi state; browser fallback was kept.', err);
  }
}

function setMessage(type, text, { rerender = true } = {}) {
  state.message = { type, text };
  if (rerender) render();
  else patchMessage();
}

function isMachineIdle() {
  const active = String(state.activeState || '').toLowerCase();
  return state.workflow === 'idle' && (active === '' || active === 'idle');
}

function canCapture() {
  return state.socketConnected
    && !!state.port
    && state.controllerType === 'Grbl'
    && isMachineIdle()
    && currentPositionReady();
}

function currentPositionReady() {
  return finite(state.workPositionMm.x) && finite(state.workPositionMm.y);
}

function snapshotPosition() {
  if (!currentPositionReady()) {
    throw new Error('No valid GRBL work position is available yet. Wait for the machine status to update.');
  }
  return {
    x: Number(state.workPositionMm.x),
    y: Number(state.workPositionMm.y),
    z: finite(state.workPositionMm.z) ? Number(state.workPositionMm.z) : null,
    wcs: state.activeWcs || 'G54',
    capturedAt: Date.now()
  };
}

function alignmentOptions() {
  return {
    maxSpacingErrorMm: state.settings.spacingCheckEnabled
      ? Number(state.settings.maxSpacingErrorMm)
      : null,
    maxRotationDeg: state.settings.rotationCheckEnabled
      ? Number(state.settings.maxRotationDeg)
      : null
  };
}

function calculateAlignment({ announce = true } = {}) {
  state.transform = null;

  if (!state.captureA || !state.captureB) return null;
  if (state.captureA.wcs !== state.captureB.wcs) {
    throw new Error(`A and B were captured in different work coordinate systems (${state.captureA.wcs} / ${state.captureB.wcs}). Re-capture both in the same WCS.`);
  }

  const transform = computeRigidTransform(
    state.settings.cadA,
    state.settings.cadB,
    state.captureA,
    state.captureB,
    alignmentOptions()
  );

  state.transform = transform;
  state.alignmentWcs = state.captureA.wcs || state.activeWcs || 'G54';

  if (announce) {
    state.message = {
      type: 'success',
      text: `Ready · ${signed(transform.angleDeg, 4)}° · spacing error ${Math.abs(transform.spacingErrorMm).toFixed(3)} mm`
    };
  }
  return transform;
}

function parseFieldValue(element, label) {
  const value = String(element.value || '').trim().replace(',', '.');
  const number = Number(value);
  if (!Number.isFinite(number)) {
    element.classList.add('invalid');
    throw new Error(`${label} must be a valid number.`);
  }
  element.classList.remove('invalid');
  return number;
}

function commitNumericSetting(element) {
  const path = element.dataset.setting;
  if (!path) return;
  const label = element.dataset.label || path;
  const value = parseFieldValue(element, label);
  if ((path === 'maxSpacingErrorMm' || path === 'maxRotationDeg') && value < 0) {
    throw new Error(`${label} cannot be negative. Use 0 or switch the check off.`);
  }

  if (path.startsWith('cad') && state.activeFavoriteId) {
    state.activeFavoriteId = '';
    state.autoApply = false;
  }

  if (path === 'cadA.x') state.settings.cadA.x = value;
  else if (path === 'cadA.y') state.settings.cadA.y = value;
  else if (path === 'cadB.x') state.settings.cadB.x = value;
  else if (path === 'cadB.y') state.settings.cadB.y = value;
  else if (path === 'maxSpacingErrorMm') state.settings.maxSpacingErrorMm = value;
  else if (path === 'maxRotationDeg') state.settings.maxRotationDeg = value;

  scheduleSave();
  if (state.captureA && state.captureB) {
    calculateAlignment({ announce: false });
  }
  render();
}

function captureReference(which) {
  if (!canCapture()) throw new Error('Wait for GRBL to be Idle before capturing a reference point.');
  const point = snapshotPosition();
  if (which === 'A') state.captureA = point;
  else state.captureB = point;

  if (state.activeFavoriteId) {
    state.activeFavoriteId = '';
    state.autoApply = false;
  }
  state.transform = null;

  if (state.captureA && state.captureB) {
    calculateAlignment({ announce: true });
  } else {
    state.message = { type: 'info', text: `Point ${which} captured. Now capture the other reference.` };
  }
  scheduleSave();
  render();
}

function clearAlignment() {
  state.captureA = null;
  state.captureB = null;
  state.transform = null;
  state.activeFavoriteId = '';
  state.autoApply = false;
  state.alignmentWcs = state.activeWcs || 'G54';
  state.message = { type: 'info', text: 'Alignment cleared. Loaded G-code was not changed.' };
  scheduleSave();
  render();
}

function favoriteById(id) {
  return state.favorites.find(item => item.id === id) || null;
}

function activeFavorite() {
  return favoriteById(state.activeFavoriteId);
}

function defaultFavorite() {
  return favoriteById(state.defaultFavoriteId);
}

function activateFavorite(id, { quiet = false, persist = true } = {}) {
  const favorite = favoriteById(id);
  if (!favorite) return false;

  state.activeFavoriteId = favorite.id;
  state.transform = clone(favorite.transform);
  state.alignmentWcs = favorite.wcs || 'G54';
  state.captureA = favorite.captureA ? clone(favorite.captureA) : null;
  state.captureB = favorite.captureB ? clone(favorite.captureB) : null;
  if (favorite.cadA) state.settings.cadA = clone(favorite.cadA);
  if (favorite.cadB) state.settings.cadB = clone(favorite.cadB);

  if (!quiet) {
    state.message = { type: 'success', text: `Loaded favorite “${favorite.name}”.` };
  }
  if (persist) scheduleSave();
  return true;
}

function saveFavorite() {
  if (!validTransform(state.transform)) throw new Error('Create an alignment before saving a favorite.');

  const input = document.getElementById('favoriteName');
  const typed = String(input?.value || state.favoriteDraftName || '').trim();
  const name = typed || `Alignment ${state.favorites.length + 1}`;
  const id = `fav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const favorite = {
    id,
    name,
    createdAt: new Date().toISOString(),
    wcs: state.alignmentWcs || 'G54',
    cadA: clone(state.settings.cadA),
    cadB: clone(state.settings.cadB),
    captureA: state.captureA ? clone(state.captureA) : null,
    captureB: state.captureB ? clone(state.captureB) : null,
    transform: clone(state.transform)
  };

  state.favorites.push(favorite);
  state.activeFavoriteId = id;
  state.favoriteDraftName = '';
  state.message = { type: 'success', text: `Saved “${name}” as a favorite.` };
  scheduleSave();
  render();
}

function setDefaultFavorite(id) {
  const favorite = favoriteById(id);
  if (!favorite) throw new Error('Choose a favorite first.');

  activateFavorite(id, { quiet: true, persist: false });
  state.defaultFavoriteId = id;
  state.autoApply = true;
  state.message = {
    type: 'success',
    text: `“${favorite.name}” is now the default. New G-code will align automatically.`
  };
  scheduleSave();
  render();
  maybeAutoApply();
}

function deleteFavorite(id) {
  const favorite = favoriteById(id);
  if (!favorite) return;

  state.favorites = state.favorites.filter(item => item.id !== id);
  if (state.defaultFavoriteId === id) state.defaultFavoriteId = '';
  if (state.activeFavoriteId === id) state.activeFavoriteId = '';
  state.message = { type: 'info', text: `Deleted favorite “${favorite.name}”.` };
  scheduleSave();
  render();
}

function toggleAutoApply(enabled) {
  state.autoApply = !!enabled;

  if (state.autoApply && !activeFavorite()) {
    const fallback = defaultFavorite();
    if (fallback) activateFavorite(fallback.id, { quiet: true, persist: false });
  }

  if (state.autoApply && !activeFavorite()) {
    state.autoApply = false;
    throw new Error('Save the alignment as a favorite first. Auto-align always uses a saved profile so it stays reliable after refresh/reboot.');
  }

  state.message = {
    type: state.autoApply ? 'success' : 'info',
    text: state.autoApply
      ? 'Auto-align is on. Every newly loaded original G-code file will be aligned automatically.'
      : 'Auto-align is off. You can still apply alignment manually.'
  };
  scheduleSave();
  render();
  maybeAutoApply();
}

async function refreshProgram({ quiet = false } = {}) {
  if (!state.port) throw new Error('No CNCjs serial port is selected.');
  const data = await apiJson(`/api/gcode?port=${encodeURIComponent(state.port)}`);
  ingestProgram(data.name || 'program.nc', data.data || data.gcode || '', { quiet });
}

function ingestProgram(name, gcode, { quiet = false } = {}) {
  const text = String(gcode || '');
  state.currentProgramName = name || 'program.nc';
  state.currentProgramIsAligned = text.includes(ALIGNMENT_MARKER);

  if (!text) {
    state.originalProgram = null;
    state.alignedProgram = null;
    state.pendingAutoApply = false;
    if (!quiet) state.message = { type: 'warning', text: 'No G-code is currently loaded.' };
    render();
    return;
  }

  if (state.currentProgramIsAligned) {
    if (!quiet && !state.autoApplyInFlight) {
      state.message = { type: 'success', text: 'Aligned preview is loaded.' };
    }
    render();
    return;
  }

  state.originalProgram = { name: state.currentProgramName, gcode: text };
  state.alignedProgram = null;

  if (state.autoApply && validTransform(state.transform)) {
    state.pendingAutoApply = true;
    state.message = { type: 'info', text: 'New G-code detected · applying default alignment…' };
  } else if (!quiet) {
    state.message = { type: 'info', text: 'Original G-code loaded. Apply the alignment when ready.' };
  }

  render();
  maybeAutoApply();
}

async function loadProgram(name, gcode) {
  if (!state.port) throw new Error('No CNCjs serial port is selected.');
  return apiJson('/api/gcode', {
    method: 'POST',
    body: JSON.stringify({ port: state.port, name, gcode, context: {} })
  });
}

function alignedName(name) {
  const source = name || 'program.nc';
  const match = source.match(/^(.*?)(\.[^.]+)?$/);
  return `${match?.[1] || source}.aligned${match?.[2] || '.nc'}`;
}

function alignmentProfileWcs() {
  return state.alignmentWcs || state.captureA?.wcs || state.activeWcs || 'G54';
}

async function applyAlignment({ automatic = false } = {}) {
  if (!state.originalProgram?.gcode) {
    await refreshProgram({ quiet: true });
  }
  if (!state.originalProgram?.gcode) throw new Error('Load the original G-code in CNCjs first.');
  if (!validTransform(state.transform)) throw new Error('Capture two points or load a saved favorite first.');
  if (!isMachineIdle()) throw new Error('Wait for the machine to be Idle before replacing the loaded program.');

  const result = transformGcode(state.originalProgram.gcode, state.transform);
  const profileWcs = alignmentProfileWcs();

  if (result.programWcs && profileWcs && result.programWcs !== profileWcs) {
    throw new Error(`This alignment was captured in ${profileWcs}, but the G-code selects ${result.programWcs}. Use a matching favorite or re-capture A/B in ${result.programWcs}.`);
  }
  if (!result.programWcs && profileWcs && state.activeWcs !== profileWcs) {
    throw new Error(`The G-code does not select a WCS. This alignment belongs to ${profileWcs}, but ${state.activeWcs} is active.`);
  }

  const name = alignedName(state.originalProgram.name);
  state.autoApplyInFlight = automatic;
  await loadProgram(name, result.gcode);
  state.autoApplyInFlight = false;

  state.alignedProgram = { name, gcode: result.gcode, result };
  state.currentProgramName = name;
  state.currentProgramIsAligned = true;
  state.pendingAutoApply = false;
  state.message = {
    type: 'success',
    text: automatic
      ? `Auto-aligned “${state.originalProgram.name}”. Review the CNCjs visualizer before running.`
      : 'Aligned preview loaded. Review the CNCjs visualizer before running.'
  };
  render();
}

function maybeAutoApply() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    if (!state.pendingAutoApply || !state.autoApply || state.autoApplyInFlight) return;
    if (!state.originalProgram?.gcode || !validTransform(state.transform)) return;
    if (!state.socketConnected || !state.port || state.controllerType !== 'Grbl' || !isMachineIdle()) return;

    state.autoApplyInFlight = true;
    try {
      await applyAlignment({ automatic: true });
    } catch (err) {
      state.autoApplyInFlight = false;
      state.pendingAutoApply = false;
      setMessage('error', `Auto-align stopped: ${err?.message || String(err)}`);
    }
  }, 80);
}

async function restoreOriginal() {
  if (!state.originalProgram?.gcode) throw new Error('No original program is retained. Reload the original G-code if needed.');
  if (state.autoApply) {
    state.autoApply = false;
    scheduleSave();
  }
  await loadProgram(state.originalProgram.name, state.originalProgram.gcode);
  state.currentProgramName = state.originalProgram.name;
  state.currentProgramIsAligned = false;
  state.alignedProgram = null;
  state.pendingAutoApply = false;
  state.message = { type: 'success', text: 'Original unaligned G-code restored.' };
  render();
}

function setCenterPoint(pointKey, x, y) {
  state.center[pointKey] = { x: Number(x), y: Number(y) };
  render();
}

function captureCenterPoint(pointKey) {
  if (!canCapture()) throw new Error('Wait for GRBL to be Idle before capturing a midpoint reference.');
  const point = snapshotPosition();
  setCenterPoint(pointKey, point.x, point.y);
}

function commitCenterField(element) {
  const pointKey = element.dataset.centerPoint;
  const axis = element.dataset.axis;
  if (!pointKey || !axis) return;
  const value = parseFieldValue(element, `${pointKey.toUpperCase()} ${axis.toUpperCase()}`);
  state.center[pointKey][axis] = value;
  render();
}

function useAlignmentPointsForCenter() {
  if (!state.captureA || !state.captureB) throw new Error('Capture alignment points A and B first.');
  state.center.p1 = { x: Number(state.captureA.x), y: Number(state.captureA.y) };
  state.center.p2 = { x: Number(state.captureB.x), y: Number(state.captureB.y) };
  state.message = { type: 'success', text: 'Midpoint Finder is using alignment points A and B.' };
  render();
}

function centerResult() {
  const { p1, p2 } = state.center;
  if (!finite(p1.x) || !finite(p1.y) || !finite(p2.x) || !finite(p2.y)) return null;
  return midpointBetween(p1, p2);
}

function captureText(capture) {
  if (!capture) return 'Not captured';
  return `X ${fixed(capture.x)} · Y ${fixed(capture.y)} mm · ${escapeHtml(capture.wcs || 'G54')}`;
}

function profileSummary() {
  const favorite = activeFavorite();
  if (favorite) return favorite.name;
  if (validTransform(state.transform)) return 'Current alignment';
  return 'No alignment';
}

function autoSummary() {
  if (!state.autoApply) return 'Off';
  const favorite = activeFavorite() || defaultFavorite();
  return favorite ? `On · ${favorite.name}` : 'On · current alignment';
}

function programBadge() {
  if (!state.currentProgramName) return '<span class="pill neutral">No file</span>';
  return state.currentProgramIsAligned
    ? '<span class="pill success">Aligned</span>'
    : '<span class="pill neutral">Original</span>';
}

function favoriteOptions() {
  if (!state.favorites.length) return '<option value="">No favorites yet</option>';
  return state.favorites.map(favorite => {
    const selected = favorite.id === state.activeFavoriteId ? ' selected' : '';
    const star = favorite.id === state.defaultFavoriteId ? ' ★' : '';
    return `<option value="${escapeHtml(favorite.id)}"${selected}>${escapeHtml(favorite.name)}${star}</option>`;
  }).join('');
}

function midpointDisplay() {
  const result = centerResult();
  if (!result) return '<div class="empty-state">Enter or capture two points.</div>';
  if (state.center.mode === 'x') {
    return `<div class="midpoint-value"><span>X midpoint</span><strong>${fixed(result.x, 4)} mm</strong></div>`;
  }
  if (state.center.mode === 'y') {
    return `<div class="midpoint-value"><span>Y midpoint</span><strong>${fixed(result.y, 4)} mm</strong></div>`;
  }
  return `<div class="midpoint-value"><span>XY midpoint</span><strong>X ${fixed(result.x, 4)} · Y ${fixed(result.y, 4)} mm</strong></div>`;
}

function render() {
  const app = document.getElementById('app');
  const transform = state.transform;
  const captureEnabled = canCapture();
  const applyEnabled = validTransform(transform) && !!state.originalProgram?.gcode && isMachineIdle();
  const selectedFavorite = activeFavorite() || defaultFavorite();

  app.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div>
          <div class="eyebrow">CNCJSSkew</div>
          <h1>Workpiece Align</h1>
          <p>Capture two points. The toolpath follows the part.</p>
        </div>
        <div id="connectionPill" class="pill ${state.socketConnected && state.port ? 'success' : 'danger'}">
          ${state.socketConnected && state.port ? 'Connected' : 'Disconnected'}
        </div>
      </header>

      <section class="card auto-card">
        <div class="row between center">
          <div>
            <div class="section-title">Auto-align</div>
            <div class="subtle">${escapeHtml(autoSummary())}</div>
          </div>
          <label class="switch" title="Automatically align every newly loaded original G-code file">
            <input id="autoApply" type="checkbox" ${state.autoApply ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div class="auto-note">${state.autoApply
          ? `New toolpaths use <strong>${escapeHtml(profileSummary())}</strong> automatically.`
          : 'Turn this on after saving or loading the alignment you want to reuse.'}</div>
      </section>

      <section class="card">
        <div class="section-head">
          <div>
            <div class="section-title">Alignment</div>
            <div class="subtle">CAD coordinates are in millimeters.</div>
          </div>
          ${transform ? '<span class="pill success">Ready</span>' : '<span class="pill neutral">Not set</span>'}
        </div>

        <div class="reference-grid">
          <div class="reference-block">
            <div class="reference-head"><strong>A</strong><span>${state.captureA ? 'Captured' : 'Reference 1'}</span></div>
            <div class="input-pair">
              <label><span>X</span><input class="numeric-input" data-setting="cadA.x" data-label="A X" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.cadA.x)}"></label>
              <label><span>Y</span><input class="numeric-input" data-setting="cadA.y" data-label="A Y" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.cadA.y)}"></label>
            </div>
            <div class="capture-readout">${captureText(state.captureA)}</div>
            <button id="captureA" class="button secondary full" ${captureEnabled ? '' : 'disabled'}>Capture current position</button>
          </div>

          <div class="reference-block">
            <div class="reference-head"><strong>B</strong><span>${state.captureB ? 'Captured' : 'Reference 2'}</span></div>
            <div class="input-pair">
              <label><span>X</span><input class="numeric-input" data-setting="cadB.x" data-label="B X" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.cadB.x)}"></label>
              <label><span>Y</span><input class="numeric-input" data-setting="cadB.y" data-label="B Y" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.cadB.y)}"></label>
            </div>
            <div class="capture-readout">${captureText(state.captureB)}</div>
            <button id="captureB" class="button secondary full" ${captureEnabled ? '' : 'disabled'}>Capture current position</button>
          </div>
        </div>

        ${transform ? `
          <div class="result-strip">
            <div><span>Rotation</span><strong>${signed(transform.angleDeg, 5)}°</strong></div>
            <div><span>X offset</span><strong>${signed(transform.translation.x, 3)}</strong></div>
            <div><span>Y offset</span><strong>${signed(transform.translation.y, 3)}</strong></div>
            <div><span>Spacing Δ</span><strong>${signed(transform.spacingErrorMm, 3)}</strong></div>
          </div>
        ` : ''}

        <div class="button-row">
          <button id="clearAlignment" class="button ghost">Clear</button>
        </div>
      </section>

      <section class="card">
        <div class="section-head compact">
          <div>
            <div class="section-title">Favorites</div>
            <div class="subtle">Saved on the Raspberry Pi through CNCjs.</div>
          </div>
        </div>

        <div class="save-favorite-row">
          <input id="favoriteName" class="text-input" type="text" autocomplete="off" placeholder="Name this alignment" value="${escapeHtml(state.favoriteDraftName)}">
          <button id="saveFavorite" class="button secondary" ${validTransform(transform) ? '' : 'disabled'}>Save</button>
        </div>

        <div class="favorite-controls">
          <select id="favoriteSelect" class="select-input">${favoriteOptions()}</select>
          <button id="loadFavorite" class="button secondary" ${state.favorites.length ? '' : 'disabled'}>Load</button>
          <button id="defaultFavorite" class="button secondary" ${state.favorites.length ? '' : 'disabled'}>${selectedFavorite && selectedFavorite.id === state.defaultFavoriteId ? 'Default ✓' : 'Use as default'}</button>
          <button id="deleteFavorite" class="button ghost danger-text" ${state.favorites.length ? '' : 'disabled'}>Delete</button>
        </div>
      </section>

      <section class="card">
        <div class="section-head compact">
          <div>
            <div class="section-title">Toolpath</div>
            <div class="subtle program-name">${escapeHtml(state.currentProgramName || 'No G-code loaded')}</div>
          </div>
          ${programBadge()}
        </div>
        <div class="button-stack">
          <button id="applyAlignment" class="button primary full" ${applyEnabled ? '' : 'disabled'}>Apply alignment</button>
          <button id="refreshProgram" class="button secondary full">Refresh loaded file</button>
          <button id="restoreOriginal" class="button ghost full" ${state.originalProgram?.gcode && state.currentProgramIsAligned ? '' : 'disabled'}>Restore original</button>
        </div>
        <div class="fine-print">Auto-align replaces the loaded preview only. It never starts the machine.</div>
      </section>

      <section class="card">
        <div class="section-head compact">
          <div>
            <div class="section-title">Midpoint Finder</div>
            <div class="subtle">Find the middle of X, Y, or both axes.</div>
          </div>
        </div>

        <div class="center-point-grid">
          <div class="mini-point">
            <div class="mini-title">Point 1</div>
            <div class="input-pair">
              <label><span>X</span><input class="numeric-input" data-center-point="p1" data-axis="x" type="text" inputmode="decimal" autocomplete="off" value="${finite(state.center.p1.x) ? escapeHtml(state.center.p1.x) : ''}"></label>
              <label><span>Y</span><input class="numeric-input" data-center-point="p1" data-axis="y" type="text" inputmode="decimal" autocomplete="off" value="${finite(state.center.p1.y) ? escapeHtml(state.center.p1.y) : ''}"></label>
            </div>
            <button id="captureCenterP1" class="button secondary full" ${captureEnabled ? '' : 'disabled'}>Capture current</button>
          </div>
          <div class="mini-point">
            <div class="mini-title">Point 2</div>
            <div class="input-pair">
              <label><span>X</span><input class="numeric-input" data-center-point="p2" data-axis="x" type="text" inputmode="decimal" autocomplete="off" value="${finite(state.center.p2.x) ? escapeHtml(state.center.p2.x) : ''}"></label>
              <label><span>Y</span><input class="numeric-input" data-center-point="p2" data-axis="y" type="text" inputmode="decimal" autocomplete="off" value="${finite(state.center.p2.y) ? escapeHtml(state.center.p2.y) : ''}"></label>
            </div>
            <button id="captureCenterP2" class="button secondary full" ${captureEnabled ? '' : 'disabled'}>Capture current</button>
          </div>
        </div>

        <button id="useAlignmentPoints" class="button ghost full" ${state.captureA && state.captureB ? '' : 'disabled'}>Use alignment A + B</button>

        <div class="segmented" role="group" aria-label="Midpoint mode">
          <button data-center-mode="x" class="${state.center.mode === 'x' ? 'active' : ''}">X middle</button>
          <button data-center-mode="y" class="${state.center.mode === 'y' ? 'active' : ''}">Y middle</button>
          <button data-center-mode="xy" class="${state.center.mode === 'xy' ? 'active' : ''}">XY middle</button>
        </div>

        ${midpointDisplay()}
      </section>

      <details id="safetyDetails" class="card settings-card" ${state.settingsOpen ? 'open' : ''}>
        <summary>
          <span>
            <span class="section-title">Safety checks</span>
            <span class="subtle">Editable or completely off</span>
          </span>
          <span class="chevron">⌄</span>
        </summary>
        <div class="details-body">
          <div class="setting-line">
            <div>
              <strong>Spacing check</strong>
              <div class="subtle">Maximum allowed A↔B distance mismatch.</div>
            </div>
            <label class="switch small-switch">
              <input id="spacingCheck" type="checkbox" ${state.settings.spacingCheckEnabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
          <label class="limit-field ${state.settings.spacingCheckEnabled ? '' : 'disabled-field'}">
            <span>Limit (mm)</span>
            <input class="numeric-input" data-setting="maxSpacingErrorMm" data-label="Spacing limit" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.maxSpacingErrorMm)}" ${state.settings.spacingCheckEnabled ? '' : 'disabled'}>
          </label>

          <div class="setting-line top-gap">
            <div>
              <strong>Rotation check</strong>
              <div class="subtle">Maximum expected workpiece rotation.</div>
            </div>
            <label class="switch small-switch">
              <input id="rotationCheck" type="checkbox" ${state.settings.rotationCheckEnabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
          <label class="limit-field ${state.settings.rotationCheckEnabled ? '' : 'disabled-field'}">
            <span>Limit (degrees)</span>
            <input class="numeric-input" data-setting="maxRotationDeg" data-label="Rotation limit" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.maxRotationDeg)}" ${state.settings.rotationCheckEnabled ? '' : 'disabled'}>
          </label>

          <div class="fine-print">There are no hard upper caps. Set any value you want, or switch a check off entirely. Two distinct points are still required mathematically.</div>
        </div>
      </details>

      <section class="machine-strip">
        <div><span>WCS</span><strong id="liveWcs">${escapeHtml(state.activeWcs)}</strong></div>
        <div><span>X</span><strong id="liveX">${fixed(state.workPositionMm.x)}</strong></div>
        <div><span>Y</span><strong id="liveY">${fixed(state.workPositionMm.y)}</strong></div>
        <div><span>State</span><strong id="liveState">${escapeHtml(state.activeState || '—')}</strong></div>
      </section>

      <div id="message" class="toast ${escapeHtml(state.message.type)}">${escapeHtml(state.message.text)}</div>
    </div>
  `;

  bindEvents();
  patchLiveStatus();
  notifyResize();
}

function bindEvents() {
  const on = (id, event, fn) => document.getElementById(id)?.addEventListener(event, fn);
  const guarded = fn => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      setMessage('error', err?.message || String(err));
    }
  };

  on('autoApply', 'change', guarded(event => toggleAutoApply(event.target.checked)));
  on('captureA', 'click', guarded(() => captureReference('A')));
  on('captureB', 'click', guarded(() => captureReference('B')));
  on('clearAlignment', 'click', clearAlignment);

  on('favoriteName', 'input', event => { state.favoriteDraftName = event.target.value; });
  on('saveFavorite', 'click', guarded(saveFavorite));
  on('loadFavorite', 'click', guarded(() => {
    const id = document.getElementById('favoriteSelect')?.value;
    if (!id || !activateFavorite(id)) throw new Error('Choose a favorite first.');
    render();
  }));
  on('defaultFavorite', 'click', guarded(() => {
    const id = document.getElementById('favoriteSelect')?.value;
    setDefaultFavorite(id);
  }));
  on('deleteFavorite', 'click', guarded(() => {
    const id = document.getElementById('favoriteSelect')?.value;
    if (!id) throw new Error('Choose a favorite first.');
    deleteFavorite(id);
  }));

  on('applyAlignment', 'click', guarded(() => applyAlignment({ automatic: false })));
  on('refreshProgram', 'click', guarded(() => refreshProgram()));
  on('restoreOriginal', 'click', guarded(restoreOriginal));

  on('captureCenterP1', 'click', guarded(() => captureCenterPoint('p1')));
  on('captureCenterP2', 'click', guarded(() => captureCenterPoint('p2')));
  on('useAlignmentPoints', 'click', guarded(useAlignmentPointsForCenter));

  on('spacingCheck', 'change', event => {
    state.settings.spacingCheckEnabled = event.target.checked;
    scheduleSave();
    try {
      if (state.captureA && state.captureB) calculateAlignment({ announce: false });
      render();
    } catch (err) {
      state.transform = null;
      setMessage('error', err.message);
    }
  });

  on('safetyDetails', 'toggle', event => { state.settingsOpen = event.target.open; });

  on('rotationCheck', 'change', event => {
    state.settings.rotationCheckEnabled = event.target.checked;
    scheduleSave();
    try {
      if (state.captureA && state.captureB) calculateAlignment({ announce: false });
      render();
    } catch (err) {
      state.transform = null;
      setMessage('error', err.message);
    }
  });

  document.querySelectorAll('[data-setting]').forEach(input => {
    input.addEventListener('change', guarded(() => commitNumericSetting(input)));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') input.blur();
    });
  });

  document.querySelectorAll('[data-center-point]').forEach(input => {
    input.addEventListener('change', guarded(() => commitCenterField(input)));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') input.blur();
    });
  });

  document.querySelectorAll('[data-center-mode]').forEach(button => {
    button.addEventListener('click', () => {
      state.center.mode = button.dataset.centerMode;
      render();
    });
  });
}

function patchMessage() {
  const element = document.getElementById('message');
  if (!element) return;
  element.className = `toast ${state.message.type}`;
  element.textContent = state.message.text;
}

function patchLiveStatus() {
  const setText = (id, text) => {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  };

  setText('liveWcs', state.activeWcs || '—');
  setText('liveX', fixed(state.workPositionMm.x));
  setText('liveY', fixed(state.workPositionMm.y));
  setText('liveState', state.activeState || '—');

  const connection = document.getElementById('connectionPill');
  if (connection) {
    const connected = state.socketConnected && state.port;
    connection.textContent = connected ? 'Connected' : 'Disconnected';
    connection.className = `pill ${connected ? 'success' : 'danger'}`;
  }

  const captureEnabled = canCapture();
  for (const id of ['captureA', 'captureB', 'captureCenterP1', 'captureCenterP2']) {
    const button = document.getElementById(id);
    if (button) button.disabled = !captureEnabled;
  }

  const applyButton = document.getElementById('applyAlignment');
  if (applyButton) {
    applyButton.disabled = !(validTransform(state.transform) && !!state.originalProgram?.gcode && isMachineIdle());
  }
}

function notifyResize() {
  try {
    window.parent.postMessage({
      token,
      action: {
        type: 'resize',
        payload: {
          clientHeight: document.body.clientHeight,
          clientWidth: document.body.clientWidth,
          offsetHeight: document.body.offsetHeight,
          offsetWidth: document.body.offsetWidth,
          scrollHeight: document.body.scrollHeight,
          scrollWidth: document.body.scrollWidth
        }
      }
    }, '*');
  } catch { /* best effort */ }
}

function convertReportedPosition(pos) {
  const multiplier = state.reportInches ? MM_PER_INCH : 1;
  return {
    x: finite(pos?.x) ? Number(pos.x) * multiplier : NaN,
    y: finite(pos?.y) ? Number(pos.y) * multiplier : NaN,
    z: finite(pos?.z) ? Number(pos.z) * multiplier : NaN
  };
}

function openExistingPort(port) {
  if (!socket || !port) return;
  socket.emit('open', port, { controllerType: 'Grbl' }, err => {
    if (err) {
      setMessage('error', `Could not attach CNCJSSkew to ${port}: ${err.message || err}`);
      return;
    }
    state.port = port;
    render();
    refreshProgram({ quiet: true }).catch(() => {});
  });
}

function setupSocket() {
  if (!token) {
    setMessage('error', 'CNCjs did not provide an authentication token. Add this page as a CNCjs Custom Widget.');
    return;
  }
  if (typeof window.io !== 'function' && typeof window.io?.connect !== 'function') {
    setMessage('error', 'CNCjs Socket.IO client could not be loaded from this Raspberry Pi.');
    return;
  }

  const ioFactory = typeof window.io.connect === 'function'
    ? window.io.connect.bind(window.io)
    : window.io;

  socket = ioFactory(host, { query: `token=${encodeURIComponent(token)}` });

  socket.on('connect', () => {
    state.socketConnected = true;
    try {
      window.parent.postMessage({ token, action: { type: 'connect' } }, '*');
    } catch { /* best effort */ }
    patchLiveStatus();
  });

  socket.on('disconnect', () => {
    state.socketConnected = false;
    state.port = '';
    state.controllerType = '';
    patchLiveStatus();
  });

  socket.on('serialport:open', options => {
    if (options?.port) state.port = options.port;
    if (options?.controllerType) state.controllerType = options.controllerType;
    patchLiveStatus();
    refreshProgram({ quiet: true }).catch(() => {});
  });

  socket.on('serialport:close', options => {
    if (!options?.port || options.port === state.port) {
      state.port = '';
      state.controllerType = '';
      state.workPositionMm = { x: NaN, y: NaN, z: NaN };
    }
    patchLiveStatus();
  });

  socket.on('workflow:state', workflow => {
    state.workflow = workflow || 'idle';
    patchLiveStatus();
    maybeAutoApply();
  });

  socket.on('controller:settings', (type, controllerSettings) => {
    state.controllerType = type || state.controllerType;
    const reportUnits = Number(controllerSettings?.settings?.$13 ?? controllerSettings?.['$13'] ?? 0);
    state.reportInches = reportUnits > 0;
  });

  socket.on('controller:state', (type, controllerState) => {
    state.controllerType = type || state.controllerType;
    if (type !== 'Grbl') {
      patchLiveStatus();
      return;
    }

    const status = controllerState?.status || {};
    const modal = controllerState?.parserstate?.modal || {};
    state.activeState = status.activeState || state.activeState;
    state.activeWcs = modal.wcs || state.activeWcs || 'G54';
    state.modalUnits = modal.units || state.modalUnits || 'G21';
    if (status.wpos) state.workPositionMm = convertReportedPosition(status.wpos);
    if (status.mpos) state.machinePositionMm = convertReportedPosition(status.mpos);

    patchLiveStatus();
    maybeAutoApply();
  });

  socket.on('gcode:load', (name, gcode) => {
    ingestProgram(name, gcode, { quiet: false });
  });
}

window.addEventListener('message', event => {
  const data = event.data || {};
  if (data.token !== token) return;
  if (data.action?.type === 'change') {
    const port = data.action?.payload?.port;
    if (port && port !== state.port) openExistingPort(port);
  }
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => notifyResize()).observe(document.body);
}

async function init() {
  render();
  await loadPreferences();
  setupSocket();
}

init().catch(err => setMessage('error', err?.message || String(err)));
