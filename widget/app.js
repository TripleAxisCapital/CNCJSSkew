import {
  classifyResidual,
  computeRigidTransform,
  midpointBetween,
  normalizeQualityThresholds,
  verifyTransformedPoint,
  workOffsetDifference
} from './alignment.js';
import { transformGcode, ALIGNMENT_MARKER } from './gcode-transform.js';
import { buildSafeMidpointMove } from './motion.js';

const MM_PER_INCH = 25.4;
const SERVER_STATE_KEY = 'cncjsskew';
const LOCAL_FALLBACK_KEY = 'cncjsskew.preferences.v3';
const LEGACY_V2_KEY = 'cncjsskew.preferences.v2';
const LEGACY_V1_KEY = 'cncjsskew.settings.v1';

const qs = new URLSearchParams(window.location.search);
const token = qs.get('token') || '';
const host = qs.get('host') || window.location.origin;

const defaultSettings = {
  cadA: { x: 0, y: -40 },
  cadB: { x: 0, y: 40 },
  cadC: { x: null, y: null },
  spacingCheckEnabled: true,
  maxSpacingErrorMm: 0.25,
  rotationCheckEnabled: true,
  maxRotationDeg: 10,
  safeZMm: 5,
  workOffsetToleranceMm: 0.02,
  quality: {
    excellentMm: 0.025,
    goodMm: 0.05,
    acceptableMm: 0.1
  }
};

const defaultPreferences = {
  version: 3,
  settings: defaultSettings,
  profiles: [],
  defaultProfileId: '',
  activeProfileId: '',
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
  modalDistance: 'G90',
  reportInches: false,
  reportUnitsKnown: false,
  workPositionMm: { x: NaN, y: NaN, z: NaN },
  machinePositionMm: { x: NaN, y: NaN, z: NaN },
  workOffsetMm: { x: NaN, y: NaN, z: NaN },

  settings: clone(defaultSettings),
  profiles: [],
  defaultProfileId: '',
  activeProfileId: '',
  profileDirty: false,
  autoApply: false,

  captureA: null,
  captureB: null,
  alignmentWcs: 'G54',
  alignmentWco: null,
  transform: null,
  verification: null,

  originalProgram: null,
  alignedProgram: null,
  currentProgramName: '',
  currentProgramIsAligned: false,
  pendingAutoApply: false,
  autoApplyInFlight: false,
  lastAutoPauseReason: '',

  center: {
    p1: { x: null, y: null },
    p2: { x: null, y: null },
    mode: 'xy'
  },

  profileDraftName: '',
  persistenceReady: false,
  settingsOpen: false,
  message: {
    type: 'info',
    text: 'Capture A and B to create an alignment, or load a fixture profile.'
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

function finitePoint(point) {
  return !!point && finite(point.x) && finite(point.y);
}

function optionalPoint(point) {
  return finitePoint(point) ? { x: Number(point.x), y: Number(point.y) } : null;
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

function validTransform(transform) {
  return !!transform
    && finite(transform.angleRad)
    && transform.translation
    && finite(transform.translation.x)
    && finite(transform.translation.y);
}

function normalizeProfile(profile) {
  if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || !validTransform(profile.transform)) {
    return null;
  }

  const cadA = finitePoint(profile.cadA) ? clone(profile.cadA) : clone(defaultSettings.cadA);
  const cadB = finitePoint(profile.cadB) ? clone(profile.cadB) : clone(defaultSettings.cadB);
  const cadC = finitePoint(profile.cadC) ? clone(profile.cadC) : { x: null, y: null };

  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: profile.updatedAt || profile.createdAt || new Date().toISOString(),
    wcs: profile.wcs || 'G54',
    wco: finitePoint(profile.wco) ? { x: Number(profile.wco.x), y: Number(profile.wco.y) } : null,
    cadA,
    cadB,
    cadC,
    captureA: profile.captureA ? clone(profile.captureA) : null,
    captureB: profile.captureB ? clone(profile.captureB) : null,
    transform: clone(profile.transform),
    safeZMm: finite(profile.safeZMm) ? Number(profile.safeZMm) : defaultSettings.safeZMm,
    lastVerifiedAt: profile.lastVerifiedAt || null,
    lastVerificationErrorMm: finite(profile.lastVerificationErrorMm) ? Number(profile.lastVerificationErrorMm) : null,
    lastVerificationQuality: profile.lastVerificationQuality || null,
    verificationBlocked: !!profile.verificationBlocked
  };
}

function normalizePreferences(raw = {}) {
  let legacyV2 = null;
  let legacyV1 = null;
  try { legacyV2 = JSON.parse(localStorage.getItem(LEGACY_V2_KEY) || 'null'); } catch { /* ignore */ }
  try { legacyV1 = JSON.parse(localStorage.getItem(LEGACY_V1_KEY) || 'null'); } catch { /* ignore */ }

  const source = raw && Object.keys(raw).length ? raw : (legacyV2 || {});
  const rawSettings = source.settings || source || {};
  const quality = {
    ...defaultSettings.quality,
    ...(rawSettings.quality || {})
  };

  const settings = {
    ...defaultSettings,
    ...(legacyV1 || {}),
    ...rawSettings,
    cadA: { ...defaultSettings.cadA, ...((legacyV1 || {}).cadA || {}), ...(rawSettings.cadA || {}) },
    cadB: { ...defaultSettings.cadB, ...((legacyV1 || {}).cadB || {}), ...(rawSettings.cadB || {}) },
    cadC: { ...defaultSettings.cadC, ...(rawSettings.cadC || {}) },
    quality
  };

  try {
    settings.quality = normalizeQualityThresholds(settings.quality);
  } catch {
    settings.quality = clone(defaultSettings.quality);
  }

  const rawProfiles = Array.isArray(source.profiles)
    ? source.profiles
    : (Array.isArray(source.favorites) ? source.favorites : []);
  const profiles = rawProfiles.map(normalizeProfile).filter(Boolean);

  const defaultProfileId = String(source.defaultProfileId || source.defaultFavoriteId || '');
  const activeProfileId = String(source.activeProfileId || source.activeFavoriteId || defaultProfileId || '');

  return {
    version: 3,
    settings,
    profiles,
    defaultProfileId,
    activeProfileId,
    autoApply: !!source.autoApply
  };
}

function persistableState() {
  return {
    version: 3,
    settings: clone(state.settings),
    profiles: clone(state.profiles),
    defaultProfileId: state.defaultProfileId,
    activeProfileId: state.activeProfileId,
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
  state.profiles = preferences.profiles;
  state.defaultProfileId = preferences.defaultProfileId;
  state.activeProfileId = preferences.activeProfileId;
  state.autoApply = preferences.autoApply;

  const preferredId = state.autoApply && state.defaultProfileId
    ? state.defaultProfileId
    : (state.activeProfileId || state.defaultProfileId);
  if (preferredId) activateProfile(preferredId, { quiet: true, persist: false });

  state.persistenceReady = true;
  render();
  scheduleSave(); // Persist any v1/v2 migration back to the Raspberry Pi.
}

function scheduleSave() {
  if (!state.persistenceReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePreferences, 180);
}

async function savePreferences() {
  const payload = persistableState();
  try { localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(payload)); } catch { /* optional */ }

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

function currentPositionReady() {
  return finite(state.workPositionMm.x) && finite(state.workPositionMm.y);
}

function canCapture() {
  return state.socketConnected
    && !!state.port
    && state.controllerType === 'Grbl'
    && state.reportUnitsKnown
    && isMachineIdle()
    && currentPositionReady();
}

function currentWorkOffset() {
  if (finitePoint(state.workOffsetMm)) {
    return { x: Number(state.workOffsetMm.x), y: Number(state.workOffsetMm.y) };
  }
  if (finitePoint(state.machinePositionMm) && finitePoint(state.workPositionMm)) {
    return {
      x: Number(state.machinePositionMm.x) - Number(state.workPositionMm.x),
      y: Number(state.machinePositionMm.y) - Number(state.workPositionMm.y)
    };
  }
  return null;
}

function snapshotPosition() {
  if (!currentPositionReady()) {
    throw new Error('No valid GRBL work position is available yet. Wait for the machine status to update.');
  }
  const wco = currentWorkOffset();
  return {
    x: Number(state.workPositionMm.x),
    y: Number(state.workPositionMm.y),
    z: finite(state.workPositionMm.z) ? Number(state.workPositionMm.z) : null,
    wcs: state.activeWcs || 'G54',
    wco: wco ? clone(wco) : null,
    capturedAt: Date.now()
  };
}

function alignmentOptions() {
  return {
    maxSpacingErrorMm: state.settings.spacingCheckEnabled ? Number(state.settings.maxSpacingErrorMm) : null,
    maxRotationDeg: state.settings.rotationCheckEnabled ? Number(state.settings.maxRotationDeg) : null
  };
}

function markProfileDirty(reason = '') {
  if (!state.activeProfileId) return;
  state.profileDirty = true;
  state.verification = null;
  if (reason) state.message = { type: 'warning', text: `${reason} · update or save the fixture profile before Auto-align can resume.` };
}

function calculateAlignment({ announce = true } = {}) {
  state.transform = null;
  state.verification = null;

  if (!state.captureA || !state.captureB) return null;
  if (state.captureA.wcs !== state.captureB.wcs) {
    throw new Error(`A and B were captured in different work coordinate systems (${state.captureA.wcs} / ${state.captureB.wcs}). Re-capture both in the same WCS.`);
  }

  if (finitePoint(state.captureA.wco) && finitePoint(state.captureB.wco)) {
    const offsetChange = workOffsetDifference(state.captureA.wco, state.captureB.wco);
    if (offsetChange.distanceMm > Number(state.settings.workOffsetToleranceMm)) {
      throw new Error(`The work offset changed by ${offsetChange.distanceMm.toFixed(3)} mm between A and B. Re-capture both points without changing the work offset.`);
    }
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
  state.alignmentWco = finitePoint(state.captureA.wco) ? clone(state.captureA.wco) : currentWorkOffset();

  if (announce) {
    state.message = {
      type: 'success',
      text: `Alignment ready · ${signed(transform.angleDeg, 4)}° · spacing error ${Math.abs(transform.spacingErrorMm).toFixed(3)} mm`
    };
  }
  return transform;
}

function parseFieldValue(element, label, { optional = false } = {}) {
  const raw = String(element.value ?? '').trim().replace(',', '.');
  if (optional && raw === '') {
    element.classList.remove('invalid');
    return null;
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    element.classList.add('invalid');
    throw new Error(`${label} must be a valid number${optional ? ' or left blank' : ''}.`);
  }
  element.classList.remove('invalid');
  return number;
}

function qualitySettingsWith(path, value) {
  const next = { ...state.settings.quality };
  if (path === 'quality.excellentMm') next.excellentMm = value;
  if (path === 'quality.goodMm') next.goodMm = value;
  if (path === 'quality.acceptableMm') next.acceptableMm = value;
  return normalizeQualityThresholds(next);
}

function commitNumericSetting(element) {
  const path = element.dataset.setting;
  if (!path) return;
  const optional = element.dataset.optional === 'true';
  const label = element.dataset.label || path;
  const value = parseFieldValue(element, label, { optional });

  if (['maxSpacingErrorMm', 'maxRotationDeg', 'workOffsetToleranceMm'].includes(path) && value < 0) {
    throw new Error(`${label} cannot be negative.`);
  }

  if (path.startsWith('quality.')) {
    state.settings.quality = qualitySettingsWith(path, value);
  } else if (path === 'cadA.x') state.settings.cadA.x = value;
  else if (path === 'cadA.y') state.settings.cadA.y = value;
  else if (path === 'cadB.x') state.settings.cadB.x = value;
  else if (path === 'cadB.y') state.settings.cadB.y = value;
  else if (path === 'cadC.x') state.settings.cadC.x = value;
  else if (path === 'cadC.y') state.settings.cadC.y = value;
  else if (path === 'maxSpacingErrorMm') state.settings.maxSpacingErrorMm = value;
  else if (path === 'maxRotationDeg') state.settings.maxRotationDeg = value;
  else if (path === 'safeZMm') state.settings.safeZMm = value;
  else if (path === 'workOffsetToleranceMm') state.settings.workOffsetToleranceMm = value;

  if (path.startsWith('cadA.') || path.startsWith('cadB.')) {
    markProfileDirty('Reference coordinates changed');
    if (state.captureA && state.captureB) calculateAlignment({ announce: false });
  } else if (path.startsWith('cadC.')) {
    markProfileDirty('Verification point changed');
    state.verification = null;
  } else if (path === 'safeZMm') {
    markProfileDirty('Safe Z changed');
  }

  scheduleSave();
  render();
}

function captureReference(which) {
  if (!canCapture()) throw new Error('Wait for GRBL to be Idle before capturing a reference point.');
  const point = snapshotPosition();
  if (which === 'A') state.captureA = point;
  else state.captureB = point;

  markProfileDirty(`Point ${which} was re-captured`);
  state.transform = null;
  state.verification = null;

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
  state.verification = null;
  state.alignmentWco = null;
  state.activeProfileId = '';
  state.profileDirty = false;
  state.autoApply = false;
  state.pendingAutoApply = false;
  state.message = { type: 'info', text: 'Alignment cleared. Loaded G-code was not changed.' };
  scheduleSave();
  render();
}

function profileById(id) {
  return state.profiles.find(item => item.id === id) || null;
}

function activeProfile() {
  return profileById(state.activeProfileId);
}

function defaultProfile() {
  return profileById(state.defaultProfileId);
}

function profileValidity(profile = activeProfile(), { ignoreVerification = false } = {}) {
  if (!profile) return { valid: false, waiting: false, reason: 'No fixture profile is selected.' };
  if (!validTransform(profile.transform)) return { valid: false, waiting: false, reason: 'The profile does not contain a valid alignment.' };
  if (state.profileDirty) return { valid: false, waiting: false, reason: 'This profile has unsaved changes.' };
  if (!state.socketConnected || !state.port || state.controllerType !== 'Grbl') {
    return { valid: false, waiting: true, reason: 'Waiting for the Shapeoko connection.' };
  }
  if (!state.reportUnitsKnown) {
    return { valid: false, waiting: true, reason: 'Waiting for GRBL reporting units.' };
  }
  if ((profile.wcs || 'G54') !== state.activeWcs) {
    return { valid: false, waiting: false, reason: `Profile uses ${profile.wcs || 'G54'}, but ${state.activeWcs} is active.` };
  }
  if (!finitePoint(profile.wco)) {
    return { valid: false, waiting: false, reason: 'This older profile has no saved work-offset fingerprint. Re-capture A/B and save or update it.' };
  }

  const currentWco = currentWorkOffset();
  if (!currentWco) return { valid: false, waiting: true, reason: 'Waiting for the current work offset.' };
  const delta = workOffsetDifference(profile.wco, currentWco);
  if (delta.distanceMm > Number(state.settings.workOffsetToleranceMm)) {
    return {
      valid: false,
      waiting: false,
      reason: `Work offset moved ${delta.distanceMm.toFixed(3)} mm since this profile was saved.`
    };
  }

  if (!ignoreVerification && profile.verificationBlocked) {
    const detail = finite(profile.lastVerificationErrorMm)
      ? ` by ${Number(profile.lastVerificationErrorMm).toFixed(3)} mm`
      : '';
    return {
      valid: false,
      waiting: false,
      reason: `The last point-C verification failed${detail}. Re-verify C or re-capture A/B and update the profile.`
    };
  }
  if (!ignoreVerification && state.verification?.profileId === profile.id && state.verification.passed === false) {
    return {
      valid: false,
      waiting: false,
      reason: `Verification failed by ${state.verification.errorMm.toFixed(3)} mm. Re-verify or re-capture A/B.`
    };
  }

  return { valid: true, waiting: false, reason: 'Profile matches the active WCS and saved work offset.' };
}

function currentAlignmentValidity({ ignoreVerification = false } = {}) {
  const profile = activeProfile();
  if (profile) return profileValidity(profile, { ignoreVerification });
  if (!validTransform(state.transform)) return { valid: false, waiting: false, reason: 'No alignment is ready.' };
  if (state.alignmentWcs !== state.activeWcs) {
    return { valid: false, waiting: false, reason: `Alignment was captured in ${state.alignmentWcs}, but ${state.activeWcs} is active.` };
  }
  const currentWco = currentWorkOffset();
  if (finitePoint(state.alignmentWco) && currentWco) {
    const delta = workOffsetDifference(state.alignmentWco, currentWco);
    if (delta.distanceMm > Number(state.settings.workOffsetToleranceMm)) {
      return { valid: false, waiting: false, reason: `Work offset moved ${delta.distanceMm.toFixed(3)} mm since A/B were captured.` };
    }
  }
  if (!ignoreVerification && state.verification?.passed === false) {
    return { valid: false, waiting: false, reason: `Verification failed by ${state.verification.errorMm.toFixed(3)} mm.` };
  }
  return { valid: true, waiting: false, reason: 'Current alignment is valid.' };
}

function activateProfile(id, { quiet = false, persist = true } = {}) {
  const profile = profileById(id);
  if (!profile) return false;

  state.activeProfileId = profile.id;
  state.profileDirty = false;
  state.transform = clone(profile.transform);
  state.alignmentWcs = profile.wcs || 'G54';
  state.alignmentWco = profile.wco ? clone(profile.wco) : null;
  state.captureA = profile.captureA ? clone(profile.captureA) : null;
  state.captureB = profile.captureB ? clone(profile.captureB) : null;
  state.settings.cadA = clone(profile.cadA || defaultSettings.cadA);
  state.settings.cadB = clone(profile.cadB || defaultSettings.cadB);
  state.settings.cadC = clone(profile.cadC || defaultSettings.cadC);
  state.settings.safeZMm = finite(profile.safeZMm) ? Number(profile.safeZMm) : state.settings.safeZMm;
  state.verification = null;

  if (!quiet) state.message = { type: 'success', text: `Loaded fixture profile “${profile.name}”.` };
  if (persist) scheduleSave();
  return true;
}

function buildProfile({ id, name, createdAt }) {
  if (!validTransform(state.transform)) throw new Error('Create an alignment before saving a fixture profile.');
  if (state.alignmentWcs !== state.activeWcs) {
    throw new Error(`Alignment was captured in ${state.alignmentWcs}, but ${state.activeWcs} is active. Re-capture A/B before saving.`);
  }
  const wco = currentWorkOffset();
  if (!wco) throw new Error('Current work offset is not available yet. Wait for GRBL status to update, then save again.');
  if (finitePoint(state.alignmentWco)) {
    const delta = workOffsetDifference(state.alignmentWco, wco);
    if (delta.distanceMm > Number(state.settings.workOffsetToleranceMm)) {
      throw new Error(`Work offset moved ${delta.distanceMm.toFixed(3)} mm since A/B were captured. Re-capture A/B before saving.`);
    }
  }

  return {
    id,
    name,
    createdAt,
    updatedAt: new Date().toISOString(),
    wcs: state.alignmentWcs || state.activeWcs || 'G54',
    wco: clone(wco),
    cadA: clone(state.settings.cadA),
    cadB: clone(state.settings.cadB),
    cadC: clone(state.settings.cadC),
    captureA: state.captureA ? clone(state.captureA) : null,
    captureB: state.captureB ? clone(state.captureB) : null,
    transform: clone(state.transform),
    safeZMm: Number(state.settings.safeZMm),
    lastVerifiedAt: state.verification?.passed ? state.verification.at : null,
    lastVerificationErrorMm: state.verification?.passed ? state.verification.errorMm : null,
    lastVerificationQuality: state.verification ? state.verification.quality.key : null,
    verificationBlocked: state.verification ? !state.verification.passed : false
  };
}

function saveProfile() {
  const input = document.getElementById('profileName');
  const typed = String(input?.value || state.profileDraftName || '').trim();
  const name = typed || `Fixture ${state.profiles.length + 1}`;
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const profile = buildProfile({ id, name, createdAt: new Date().toISOString() });

  state.profiles.push(profile);
  state.activeProfileId = id;
  state.profileDirty = false;
  state.profileDraftName = '';
  state.alignmentWco = clone(profile.wco);
  state.message = { type: 'success', text: `Saved fixture profile “${name}”.` };
  scheduleSave();
  render();
}

function updateActiveProfile() {
  const existing = activeProfile();
  if (!existing) throw new Error('Load a fixture profile before updating it.');
  const replacement = buildProfile({ id: existing.id, name: existing.name, createdAt: existing.createdAt });
  const index = state.profiles.findIndex(item => item.id === existing.id);
  state.profiles[index] = replacement;
  state.profileDirty = false;
  state.alignmentWco = clone(replacement.wco);
  state.message = { type: 'success', text: `Updated fixture profile “${existing.name}”.` };
  scheduleSave();
  render();
  maybeAutoApply();
}

function setDefaultProfile(id) {
  const profile = profileById(id);
  if (!profile) throw new Error('Choose a fixture profile first.');
  activateProfile(id, { quiet: true, persist: false });
  state.defaultProfileId = id;
  state.autoApply = true;
  state.message = { type: 'success', text: `“${profile.name}” is now the default. New original G-code will align automatically.` };
  scheduleSave();
  render();
  maybeAutoApply();
}

function deleteProfile(id) {
  const profile = profileById(id);
  if (!profile) return;
  state.profiles = state.profiles.filter(item => item.id !== id);
  if (state.defaultProfileId === id) state.defaultProfileId = '';
  if (state.activeProfileId === id) {
    state.activeProfileId = '';
    state.profileDirty = false;
    state.verification = null;
  }
  if (!state.defaultProfileId && state.autoApply) state.autoApply = false;
  state.message = { type: 'info', text: `Deleted fixture profile “${profile.name}”.` };
  scheduleSave();
  render();
}

function toggleAutoApply(enabled) {
  state.autoApply = !!enabled;
  if (state.autoApply && !activeProfile()) {
    const fallback = defaultProfile();
    if (fallback) activateProfile(fallback.id, { quiet: true, persist: false });
  }
  if (state.autoApply && !activeProfile()) {
    state.autoApply = false;
    throw new Error('Save or load a fixture profile first. Auto-align intentionally uses a persisted profile.');
  }

  const validity = activeProfile() ? profileValidity(activeProfile()) : { valid: false, reason: 'No profile.' };
  state.message = {
    type: state.autoApply && validity.valid ? 'success' : (state.autoApply ? 'warning' : 'info'),
    text: state.autoApply
      ? (validity.valid ? 'Auto-align is on.' : `Auto-align is on but paused: ${validity.reason}`)
      : 'Auto-align is off.'
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
    if (!quiet && !state.autoApplyInFlight) state.message = { type: 'success', text: 'Aligned preview is loaded.' };
    render();
    return;
  }

  state.originalProgram = { name: state.currentProgramName, gcode: text };
  state.alignedProgram = null;
  if (state.autoApply && activeProfile()) {
    state.pendingAutoApply = true;
    state.message = { type: 'info', text: 'New G-code detected · checking the default fixture profile…' };
  } else if (!quiet) {
    state.message = { type: 'info', text: 'Original G-code loaded.' };
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

async function applyAlignment({ automatic = false } = {}) {
  if (!state.originalProgram?.gcode) await refreshProgram({ quiet: true });
  if (!state.originalProgram?.gcode) throw new Error('Load the original G-code in CNCjs first.');
  if (!validTransform(state.transform)) throw new Error('Capture A/B or load a fixture profile first.');
  if (!isMachineIdle()) throw new Error('Wait for the machine to be Idle before replacing the loaded program.');

  const validity = currentAlignmentValidity();
  if (!validity.valid) throw new Error(validity.reason);

  const result = transformGcode(state.originalProgram.gcode, state.transform);
  const profileWcs = state.alignmentWcs || state.activeWcs || 'G54';
  if (result.programWcs && result.programWcs !== profileWcs) {
    throw new Error(`This alignment uses ${profileWcs}, but the G-code selects ${result.programWcs}. Use a matching profile or re-capture A/B in ${result.programWcs}.`);
  }

  const name = alignedName(state.originalProgram.name);
  state.autoApplyInFlight = automatic;
  try {
    await loadProgram(name, result.gcode);
  } finally {
    state.autoApplyInFlight = false;
  }

  state.alignedProgram = { name, gcode: result.gcode, result };
  state.currentProgramName = name;
  state.currentProgramIsAligned = true;
  state.pendingAutoApply = false;
  state.lastAutoPauseReason = '';
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
    const profile = activeProfile() || defaultProfile();
    if (!profile) return;
    if (state.activeProfileId !== profile.id) activateProfile(profile.id, { quiet: true, persist: false });
    if (!state.originalProgram?.gcode || !validTransform(state.transform)) return;
    if (!state.socketConnected || !state.port || state.controllerType !== 'Grbl' || !isMachineIdle()) return;

    const validity = profileValidity(profile);
    if (!validity.valid) {
      if (!validity.waiting && state.lastAutoPauseReason !== validity.reason) {
        state.lastAutoPauseReason = validity.reason;
        setMessage('warning', `Auto-align paused: ${validity.reason}`, { rerender: false });
      }
      patchProfileStatus();
      return;
    }

    state.autoApplyInFlight = true;
    try {
      await applyAlignment({ automatic: true });
    } catch (err) {
      state.autoApplyInFlight = false;
      state.pendingAutoApply = false;
      setMessage('error', `Auto-align stopped: ${err?.message || String(err)}`);
    }
  }, 100);
}

async function restoreOriginal() {
  if (!state.originalProgram?.gcode) throw new Error('No original program is retained. Reload the original G-code if needed.');
  await loadProgram(state.originalProgram.name, state.originalProgram.gcode);
  state.currentProgramName = state.originalProgram.name;
  state.currentProgramIsAligned = false;
  state.alignedProgram = null;
  state.pendingAutoApply = false;
  state.message = { type: 'success', text: 'Original unaligned G-code restored.' };
  render();
}

function verificationCadPoint() {
  return finitePoint(state.settings.cadC)
    ? { x: Number(state.settings.cadC.x), y: Number(state.settings.cadC.y) }
    : null;
}

function verifyCurrentPosition() {
  if (!canCapture()) throw new Error('Jog to physical verification point C and wait for GRBL to be Idle.');
  if (!validTransform(state.transform)) throw new Error('Create or load an alignment first.');
  const cadC = verificationCadPoint();
  if (!cadC) throw new Error('Enter the CAD X and Y coordinates for verification point C first.');

  const baseValidity = currentAlignmentValidity({ ignoreVerification: true });
  if (!baseValidity.valid) throw new Error(baseValidity.reason);

  const measured = snapshotPosition();
  const result = verifyTransformedPoint(cadC, measured, state.transform);
  const quality = classifyResidual(result.errorMm, state.settings.quality);
  const passed = quality.key !== 'check';
  state.verification = {
    ...result,
    quality,
    passed,
    profileId: state.activeProfileId || '',
    wcs: state.activeWcs,
    at: new Date().toISOString()
  };

  const profile = activeProfile();
  if (profile) {
    profile.lastVerifiedAt = state.verification.at;
    profile.lastVerificationErrorMm = result.errorMm;
    profile.lastVerificationQuality = quality.key;
    profile.verificationBlocked = !passed;
    scheduleSave();
  }

  state.message = {
    type: passed ? 'success' : 'error',
    text: passed
      ? `Verified · ${quality.label} · C residual ${result.errorMm.toFixed(3)} mm.`
      : `Verification failed · C residual ${result.errorMm.toFixed(3)} mm exceeds the Acceptable threshold.`
  };
  render();
  maybeAutoApply();
}

function alignmentHealth() {
  if (!validTransform(state.transform)) return null;
  const independent = !!state.verification;
  const errorMm = independent ? state.verification.errorMm : Number(state.transform.endpointResidualMm || 0);
  const quality = independent ? state.verification.quality : classifyResidual(errorMm, state.settings.quality);
  return {
    ...quality,
    errorMm,
    independent,
    source: independent ? 'Independent point C' : 'A/B geometry only'
  };
}

function setCenterPoint(pointKey, x, y) {
  state.center[pointKey] = { x: Number(x), y: Number(y) };
  render();
}

function captureCenterPoint(pointKey) {
  if (!canCapture()) throw new Error('Wait for GRBL to be Idle before capturing a midpoint point.');
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
  if (!finitePoint(p1) || !finitePoint(p2)) return null;
  return midpointBetween(p1, p2);
}

function moveToMidpoint() {
  if (!canCapture()) throw new Error('Wait for GRBL to be Idle before moving to the midpoint.');
  const midpoint = centerResult();
  if (!midpoint) throw new Error('Enter or capture both midpoint points first.');
  if (!finite(state.workPositionMm.z)) throw new Error('Current Z is not available yet.');
  if (!socket || !state.port) throw new Error('CNCjs is not connected to the Shapeoko.');

  const move = buildSafeMidpointMove({
    currentPositionMm: state.workPositionMm,
    midpointMm: midpoint,
    mode: state.center.mode,
    safeZMm: state.settings.safeZMm,
    activeWcs: state.activeWcs,
    modalUnits: state.modalUnits,
    modalDistance: state.modalDistance
  });

  socket.emit('command', state.port, 'gcode', move.commands, {
    source: 'CNCJSSkew',
    operation: 'safe-midpoint-move'
  });
  state.message = {
    type: 'info',
    text: `Midpoint move queued. Z will first retract to at least ${move.targetZ.toFixed(3)} mm, then move ${state.center.mode.toUpperCase()}.`
  };
  patchMessage();
}

function captureText(capture) {
  if (!capture) return 'Not captured';
  return `X ${fixed(capture.x)} · Y ${fixed(capture.y)} mm · ${escapeHtml(capture.wcs || 'G54')}`;
}

function profileOptions() {
  if (!state.profiles.length) return '<option value="">No fixture profiles yet</option>';
  return state.profiles.map(profile => {
    const selected = profile.id === state.activeProfileId ? ' selected' : '';
    const star = profile.id === state.defaultProfileId ? ' ★' : '';
    return `<option value="${escapeHtml(profile.id)}"${selected}>${escapeHtml(profile.name)}${star}</option>`;
  }).join('');
}

function autoSummary() {
  if (!state.autoApply) return 'Off';
  const profile = activeProfile() || defaultProfile();
  return profile ? `On · ${profile.name}` : 'On · no profile';
}

function programBadge() {
  if (!state.currentProgramName) return '<span class="pill neutral">No file</span>';
  return state.currentProgramIsAligned
    ? '<span class="pill success">Aligned</span>'
    : '<span class="pill neutral">Original</span>';
}

function midpointDisplay() {
  const result = centerResult();
  if (!result) return '<div class="empty-state">Enter or capture two points.</div>';
  if (state.center.mode === 'x') return `<div class="midpoint-value"><span>X midpoint</span><strong>${fixed(result.x, 4)} mm</strong></div>`;
  if (state.center.mode === 'y') return `<div class="midpoint-value"><span>Y midpoint</span><strong>${fixed(result.y, 4)} mm</strong></div>`;
  return `<div class="midpoint-value"><span>XY midpoint</span><strong>X ${fixed(result.x, 4)} · Y ${fixed(result.y, 4)} mm</strong></div>`;
}

function qualityClass(key) {
  if (key === 'excellent' || key === 'good') return 'success';
  if (key === 'acceptable') return 'warning';
  return 'danger';
}

function alignmentDiagram() {
  if (!validTransform(state.transform)) return '';
  const angle = Number(state.transform.angleDeg);
  const svgAngle = -angle;
  return `
    <div class="alignment-visual">
      <svg viewBox="0 0 260 132" role="img" aria-label="Top-down workpiece alignment preview">
        <line x1="130" y1="112" x2="130" y2="18" class="machine-axis" />
        <line x1="42" y1="112" x2="218" y2="112" class="machine-axis secondary-axis" />
        <text x="136" y="23" class="axis-label">Y</text>
        <text x="215" y="106" class="axis-label">X</text>
        <g transform="rotate(${svgAngle} 130 66)">
          <line x1="130" y1="103" x2="130" y2="29" class="work-line" />
          <circle cx="130" cy="101" r="5" class="work-dot" />
          <circle cx="130" cy="31" r="5" class="work-dot" />
          <text x="139" y="105" class="point-label">A</text>
          <text x="139" y="35" class="point-label">B</text>
        </g>
      </svg>
      <div class="visual-caption"><span>Workpiece rotation</span><strong>${signed(angle, 5)}°</strong></div>
    </div>
  `;
}

function verificationPanel() {
  const cadC = state.settings.cadC;
  const verification = state.verification;
  const profile = activeProfile();
  const last = profile && profile.lastVerifiedAt
    ? `Last profile verification: ${new Date(profile.lastVerifiedAt).toLocaleString()}${finite(profile.lastVerificationErrorMm) ? ` · ${Number(profile.lastVerificationErrorMm).toFixed(3)} mm` : ''}`
    : 'Optional but strongly recommended before a precision cut.';

  return `
    <section class="card">
      <div class="section-head compact">
        <div>
          <div class="section-title">Verify alignment</div>
          <div class="subtle">Point C checks the A/B transform without changing it.</div>
        </div>
        ${verification
          ? `<span class="pill ${verification.passed ? 'success' : 'danger'}">${verification.passed ? 'Verified' : 'Failed'}</span>`
          : '<span class="pill neutral">Optional</span>'}
      </div>
      <div class="verification-grid">
        <label><span>C · X</span><input class="numeric-input" data-setting="cadC.x" data-label="C X" data-optional="true" type="text" inputmode="decimal" autocomplete="off" placeholder="CAD X" value="${finite(cadC.x) ? escapeHtml(cadC.x) : ''}"></label>
        <label><span>C · Y</span><input class="numeric-input" data-setting="cadC.y" data-label="C Y" data-optional="true" type="text" inputmode="decimal" autocomplete="off" placeholder="CAD Y" value="${finite(cadC.y) ? escapeHtml(cadC.y) : ''}"></label>
      </div>
      <button id="verifyCurrent" class="button secondary full" ${canCapture() && validTransform(state.transform) && verificationCadPoint() ? '' : 'disabled'}>Verify at current position</button>
      ${verification ? `
        <div class="verification-result ${verification.passed ? 'passed' : 'failed'}">
          <div><span>Expected</span><strong>X ${fixed(verification.predicted.x, 4)} · Y ${fixed(verification.predicted.y, 4)}</strong></div>
          <div><span>Measured</span><strong>X ${fixed(verification.measured.x, 4)} · Y ${fixed(verification.measured.y, 4)}</strong></div>
          <div><span>Residual</span><strong>${fixed(verification.errorMm, 4)} mm</strong></div>
        </div>
      ` : ''}
      <div class="fine-print">Jog to the exact physical center of C, then press Verify. ${escapeHtml(last)}</div>
    </section>
  `;
}

function render() {
  const app = document.getElementById('app');
  const transform = state.transform;
  const health = alignmentHealth();
  const captureEnabled = canCapture();
  const validity = currentAlignmentValidity();
  const applyEnabled = validTransform(transform) && !!state.originalProgram?.gcode && isMachineIdle() && validity.valid;
  const selectedProfile = activeProfile() || defaultProfile();

  app.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div>
          <div class="eyebrow">CNCJSSkew 1.2</div>
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
            <div id="autoSummary" class="subtle">${escapeHtml(autoSummary())}</div>
          </div>
          <label class="switch" title="Automatically align every newly loaded original G-code file">
            <input id="autoApply" type="checkbox" ${state.autoApply ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div id="profileStatus" class="profile-status ${selectedProfile ? (profileValidity(selectedProfile).valid ? 'ready' : 'paused') : 'neutral'}">
          ${selectedProfile ? escapeHtml(profileValidity(selectedProfile).reason) : 'Save a fixture profile to make alignment automatic.'}
        </div>
      </section>

      <section class="card">
        <div class="section-head">
          <div>
            <div class="section-title">Alignment</div>
            <div class="subtle">A + B define rotation and XY translation.</div>
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
          ${alignmentDiagram()}
          <div class="health-card ${health ? qualityClass(health.key) : 'neutral'}">
            <div>
              <span>Alignment health</span>
              <strong>${health ? escapeHtml(health.label) : '—'}</strong>
            </div>
            <div class="health-meta">${health ? `${escapeHtml(health.source)} · ${fixed(health.errorMm, 4)} mm` : ''}</div>
            ${health && !health.independent ? '<div class="health-note">A/B cannot independently prove the setup. Point C verification is recommended.</div>' : ''}
          </div>
        ` : ''}

        <div class="button-row"><button id="clearAlignment" class="button ghost">Clear alignment</button></div>
      </section>

      ${verificationPanel()}

      <section class="card">
        <div class="section-head compact">
          <div>
            <div class="section-title">Fixture profiles</div>
            <div class="subtle">Alignment + WCS + work-offset fingerprint + verification point.</div>
          </div>
          ${state.profileDirty ? '<span class="pill warning">Modified</span>' : ''}
        </div>
        <div class="save-profile-row">
          <input id="profileName" class="text-input" type="text" autocomplete="off" placeholder="e.g. Watch Case · Side 1" value="${escapeHtml(state.profileDraftName)}">
          <button id="saveProfile" class="button secondary" ${validTransform(transform) ? '' : 'disabled'}>Save new</button>
        </div>
        <div class="profile-controls">
          <select id="profileSelect" class="select-input">${profileOptions()}</select>
          <button id="loadProfile" class="button secondary" ${state.profiles.length ? '' : 'disabled'}>Load</button>
          <button id="updateProfile" class="button secondary" ${activeProfile() && validTransform(transform) ? '' : 'disabled'}>Update</button>
          <button id="defaultProfile" class="button secondary" ${state.profiles.length ? '' : 'disabled'}>${selectedProfile && selectedProfile.id === state.defaultProfileId ? 'Default ✓' : 'Use as default'}</button>
          <button id="deleteProfile" class="button ghost danger-text" ${state.profiles.length ? '' : 'disabled'}>Delete</button>
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
        <div class="fine-print">Auto-align only replaces the loaded preview. It never starts the spindle or presses Run.</div>
      </section>

      <section class="card">
        <div class="section-head compact">
          <div>
            <div class="section-title">Midpoint Finder</div>
            <div class="subtle">Find X, Y, or diagonal center and optionally move there safely.</div>
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
        <div class="safe-move-row">
          <label><span>Safe Z · work mm</span><input class="numeric-input" data-setting="safeZMm" data-label="Safe Z" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.safeZMm)}"></label>
          <button id="moveMidpoint" class="button primary" ${captureEnabled && centerResult() ? '' : 'disabled'}>Move to midpoint</button>
        </div>
        <div class="fine-print">The move never lowers Z before traveling horizontally. It retracts to the higher of current Z or Safe Z, drains the GRBL planner, then moves X/Y. The spindle is not controlled.</div>
      </section>

      <details id="safetyDetails" class="card settings-card" ${state.settingsOpen ? 'open' : ''}>
        <summary>
          <span><span class="section-title">Safety & quality</span><span class="subtle">Editable, with no arbitrary upper caps</span></span>
          <span class="chevron">⌄</span>
        </summary>
        <div class="details-body">
          <div class="setting-line">
            <div><strong>Spacing check</strong><div class="subtle">Maximum allowed A↔B distance mismatch.</div></div>
            <label class="switch small-switch"><input id="spacingCheck" type="checkbox" ${state.settings.spacingCheckEnabled ? 'checked' : ''}><span class="slider"></span></label>
          </div>
          <label class="limit-field ${state.settings.spacingCheckEnabled ? '' : 'disabled-field'}"><span>Limit (mm)</span><input class="numeric-input" data-setting="maxSpacingErrorMm" data-label="Spacing limit" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.maxSpacingErrorMm)}" ${state.settings.spacingCheckEnabled ? '' : 'disabled'}></label>

          <div class="setting-line top-gap">
            <div><strong>Rotation check</strong><div class="subtle">Maximum expected workpiece rotation.</div></div>
            <label class="switch small-switch"><input id="rotationCheck" type="checkbox" ${state.settings.rotationCheckEnabled ? 'checked' : ''}><span class="slider"></span></label>
          </div>
          <label class="limit-field ${state.settings.rotationCheckEnabled ? '' : 'disabled-field'}"><span>Limit (degrees)</span><input class="numeric-input" data-setting="maxRotationDeg" data-label="Rotation limit" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.maxRotationDeg)}" ${state.settings.rotationCheckEnabled ? '' : 'disabled'}></label>

          <div class="setting-line top-gap"><div><strong>Work-offset guard</strong><div class="subtle">Auto-align pauses if G54/G55/etc. offset moves more than this.</div></div></div>
          <label class="limit-field"><span>Tolerance (mm)</span><input class="numeric-input" data-setting="workOffsetToleranceMm" data-label="Work-offset tolerance" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.workOffsetToleranceMm)}"></label>

          <div class="quality-settings top-gap">
            <div><strong>Alignment health thresholds</strong><div class="subtle">Residuals at or below these values receive each label.</div></div>
            <div class="quality-grid">
              <label><span>Excellent ≤ mm</span><input class="numeric-input" data-setting="quality.excellentMm" data-label="Excellent threshold" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.quality.excellentMm)}"></label>
              <label><span>Good ≤ mm</span><input class="numeric-input" data-setting="quality.goodMm" data-label="Good threshold" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.quality.goodMm)}"></label>
              <label><span>Acceptable ≤ mm</span><input class="numeric-input" data-setting="quality.acceptableMm" data-label="Acceptable threshold" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(state.settings.quality.acceptableMm)}"></label>
            </div>
          </div>
          <div class="fine-print">Spacing and rotation checks can be switched off. Quality thresholds must stay ordered: Excellent ≤ Good ≤ Acceptable. A and B must always be two distinct points.</div>
        </div>
      </details>

      <section class="machine-strip">
        <div><span>WCS</span><strong id="liveWcs">${escapeHtml(state.activeWcs)}</strong></div>
        <div><span>X</span><strong id="liveX">${fixed(state.workPositionMm.x)}</strong></div>
        <div><span>Y</span><strong id="liveY">${fixed(state.workPositionMm.y)}</strong></div>
        <div><span>Z</span><strong id="liveZ">${fixed(state.workPositionMm.z)}</strong></div>
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
    try { await fn(...args); }
    catch (err) { setMessage('error', err?.message || String(err)); }
  };

  on('autoApply', 'change', guarded(event => toggleAutoApply(event.target.checked)));
  on('captureA', 'click', guarded(() => captureReference('A')));
  on('captureB', 'click', guarded(() => captureReference('B')));
  on('clearAlignment', 'click', clearAlignment);
  on('verifyCurrent', 'click', guarded(verifyCurrentPosition));

  on('profileName', 'input', event => { state.profileDraftName = event.target.value; });
  on('saveProfile', 'click', guarded(saveProfile));
  on('loadProfile', 'click', guarded(() => {
    const id = document.getElementById('profileSelect')?.value;
    if (!id || !activateProfile(id)) throw new Error('Choose a fixture profile first.');
    render();
    maybeAutoApply();
  }));
  on('updateProfile', 'click', guarded(updateActiveProfile));
  on('defaultProfile', 'click', guarded(() => {
    const id = document.getElementById('profileSelect')?.value;
    setDefaultProfile(id);
  }));
  on('deleteProfile', 'click', guarded(() => {
    const id = document.getElementById('profileSelect')?.value;
    if (!id) throw new Error('Choose a fixture profile first.');
    deleteProfile(id);
  }));

  on('applyAlignment', 'click', guarded(() => applyAlignment({ automatic: false })));
  on('refreshProgram', 'click', guarded(() => refreshProgram()));
  on('restoreOriginal', 'click', guarded(restoreOriginal));

  on('captureCenterP1', 'click', guarded(() => captureCenterPoint('p1')));
  on('captureCenterP2', 'click', guarded(() => captureCenterPoint('p2')));
  on('useAlignmentPoints', 'click', guarded(useAlignmentPointsForCenter));
  on('moveMidpoint', 'click', guarded(moveToMidpoint));

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

  on('safetyDetails', 'toggle', event => { state.settingsOpen = event.target.open; });

  document.querySelectorAll('[data-setting]').forEach(input => {
    input.addEventListener('change', guarded(() => commitNumericSetting(input)));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
  });

  document.querySelectorAll('[data-center-point]').forEach(input => {
    input.addEventListener('change', guarded(() => commitCenterField(input)));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
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

function patchProfileStatus() {
  const element = document.getElementById('profileStatus');
  const summary = document.getElementById('autoSummary');
  const profile = activeProfile() || defaultProfile();
  if (summary) summary.textContent = autoSummary();
  if (!element) return;

  if (!profile) {
    element.className = 'profile-status neutral';
    element.textContent = 'Save a fixture profile to make alignment automatic.';
    return;
  }

  const validity = profileValidity(profile);
  element.className = `profile-status ${validity.valid ? 'ready' : 'paused'}`;
  element.textContent = validity.valid
    ? 'Profile matches the active WCS and work offset.'
    : `${state.autoApply ? 'Auto-align paused · ' : ''}${validity.reason}`;
}

function patchLiveStatus() {
  const setText = (id, text) => {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  };
  setText('liveWcs', state.activeWcs || '—');
  setText('liveX', fixed(state.workPositionMm.x));
  setText('liveY', fixed(state.workPositionMm.y));
  setText('liveZ', fixed(state.workPositionMm.z));
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

  const verifyButton = document.getElementById('verifyCurrent');
  if (verifyButton) verifyButton.disabled = !(captureEnabled && validTransform(state.transform) && verificationCadPoint());

  const midpointButton = document.getElementById('moveMidpoint');
  if (midpointButton) midpointButton.disabled = !(captureEnabled && centerResult());

  const applyButton = document.getElementById('applyAlignment');
  if (applyButton) {
    const validity = currentAlignmentValidity();
    applyButton.disabled = !(validTransform(state.transform) && !!state.originalProgram?.gcode && isMachineIdle() && validity.valid);
  }

  patchProfileStatus();
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
    patchLiveStatus();
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
    try { window.parent.postMessage({ token, action: { type: 'connect' } }, '*'); } catch { /* best effort */ }
    patchLiveStatus();
  });

  socket.on('disconnect', () => {
    state.socketConnected = false;
    state.port = '';
    state.controllerType = '';
    state.workOffsetMm = { x: NaN, y: NaN, z: NaN };
    state.reportUnitsKnown = false;
    patchLiveStatus();
  });

  socket.on('serialport:open', options => {
    if (options?.port) state.port = options.port;
    if (options?.controllerType) state.controllerType = options.controllerType;
    state.lastAutoPauseReason = '';
    patchLiveStatus();
    refreshProgram({ quiet: true }).catch(() => {});
  });

  socket.on('serialport:close', options => {
    if (!options?.port || options.port === state.port) {
      state.port = '';
      state.controllerType = '';
      state.workPositionMm = { x: NaN, y: NaN, z: NaN };
      state.workOffsetMm = { x: NaN, y: NaN, z: NaN };
      state.reportUnitsKnown = false;
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
    state.reportUnitsKnown = true;
    patchLiveStatus();
    maybeAutoApply();
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
    state.modalDistance = modal.distance || state.modalDistance || 'G90';
    if (status.wpos) state.workPositionMm = convertReportedPosition(status.wpos);
    if (status.mpos) state.machinePositionMm = convertReportedPosition(status.mpos);
    if (status.wco) state.workOffsetMm = convertReportedPosition(status.wco);

    patchLiveStatus();
    maybeAutoApply();
  });

  socket.on('gcode:load', (name, gcode) => ingestProgram(name, gcode, { quiet: false }));
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
