import { computeRigidTransform } from './alignment.js';
import { transformGcode, ALIGNMENT_MARKER } from './gcode-transform.js';

const MM_PER_INCH = 25.4;
const SETTINGS_KEY = 'cncjsskew.settings.v1';

const qs = new URLSearchParams(window.location.search);
const token = qs.get('token') || '';
const host = qs.get('host') || window.location.origin;

const defaultSettings = {
  cadA: { x: 0, y: -40 },
  cadB: { x: 0, y: 40 },
  maxSpacingErrorMm: 0.25,
  maxRotationDeg: 10,
  minReferenceDistanceMm: 5
};

const state = {
  socketConnected: false,
  port: '',
  controllerType: '',
  activeState: '',
  workflow: 'idle',
  activeWcs: 'G54',
  reportInches: false,
  workPositionMm: { x: NaN, y: NaN, z: NaN },
  machinePositionMm: { x: NaN, y: NaN, z: NaN },
  captureA: null,
  captureB: null,
  transform: null,
  originalProgram: null,
  alignedProgram: null,
  currentProgramName: '',
  currentProgramIsAligned: false,
  settings: loadSettings(),
  message: { type: 'info', text: 'Connect CNCjs to your Shapeoko, then capture two reference points.' }
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      ...defaultSettings,
      ...saved,
      cadA: { ...defaultSettings.cadA, ...(saved.cadA || {}) },
      cadB: { ...defaultSettings.cadB, ...(saved.cadB || {}) }
    };
  } catch {
    return structuredClone(defaultSettings);
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function fixed(value, digits = 3) {
  return finite(value) ? Number(value).toFixed(digits) : '—';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setMessage(type, text) {
  state.message = { type, text };
  render();
}

function isSafeToCapture() {
  const s = String(state.activeState || '').toLowerCase();
  return state.socketConnected && state.port && state.controllerType === 'Grbl' && state.workflow === 'idle' && (s === 'idle' || s === '');
}

function currentPositionReady() {
  return finite(state.workPositionMm.x) && finite(state.workPositionMm.y);
}

function snapshotPosition() {
  if (!currentPositionReady()) throw new Error('No valid GRBL work position is available yet. Wait for the machine status to update.');
  return {
    x: Number(state.workPositionMm.x),
    y: Number(state.workPositionMm.y),
    z: Number(state.workPositionMm.z),
    wcs: state.activeWcs || 'G54',
    capturedAt: Date.now()
  };
}

function calculateAlignment(showMessage = true) {
  state.transform = null;
  if (!state.captureA || !state.captureB) return null;
  if (state.captureA.wcs !== state.captureB.wcs) {
    throw new Error(`Reference points were captured in different work coordinate systems (${state.captureA.wcs} and ${state.captureB.wcs}). Re-capture both without changing WCS.`);
  }

  const transform = computeRigidTransform(
    state.settings.cadA,
    state.settings.cadB,
    state.captureA,
    state.captureB,
    {
      maxSpacingErrorMm: Number(state.settings.maxSpacingErrorMm),
      maxRotationDeg: Number(state.settings.maxRotationDeg),
      minReferenceDistanceMm: Number(state.settings.minReferenceDistanceMm)
    }
  );
  state.transform = transform;
  if (showMessage) {
    state.message = {
      type: Math.abs(transform.spacingErrorMm) > 0.1 ? 'warning' : 'success',
      text: `Alignment ready: ${transform.angleDeg >= 0 ? '+' : ''}${transform.angleDeg.toFixed(4)}° rotation. Reference spacing error: ${Math.abs(transform.spacingErrorMm).toFixed(3)} mm.`
    };
  }
  return transform;
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body.msg || body.message || detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return response.json();
}

async function refreshProgram({ quiet = false } = {}) {
  if (!state.port) throw new Error('No CNCjs serial port is selected.');
  const data = await apiFetch(`/api/gcode?port=${encodeURIComponent(state.port)}`);
  const gcode = data.data || data.gcode || '';
  const name = data.name || 'program.nc';
  state.currentProgramName = name;
  state.currentProgramIsAligned = gcode.includes(ALIGNMENT_MARKER);

  if (gcode && !state.currentProgramIsAligned) {
    state.originalProgram = { name, gcode };
    state.alignedProgram = null;
  } else if (!gcode) {
    state.originalProgram = null;
    state.alignedProgram = null;
  }

  if (!quiet) {
    state.message = gcode
      ? { type: 'success', text: state.currentProgramIsAligned ? 'The aligned preview is currently loaded.' : 'Original G-code loaded and ready for alignment.' }
      : { type: 'warning', text: 'No G-code is currently loaded in CNCjs.' };
  }
  render();
  return { name, gcode };
}

async function loadProgram(name, gcode) {
  if (!state.port) throw new Error('No CNCjs serial port is selected.');
  return apiFetch('/api/gcode', {
    method: 'POST',
    body: JSON.stringify({ port: state.port, name, gcode, context: {} })
  });
}

function alignedName(name) {
  const source = name || 'program.nc';
  const match = source.match(/^(.*?)(\.[^.]+)?$/);
  return `${match?.[1] || source}.aligned${match?.[2] || '.nc'}`;
}

async function applyAlignment() {
  if (!state.originalProgram?.gcode) {
    await refreshProgram({ quiet: true });
  }
  if (!state.originalProgram?.gcode) throw new Error('Load your original Fusion G-code in CNCjs first.');
  const transform = calculateAlignment(false);
  if (!transform) throw new Error('Capture both reference points first.');

  if (state.activeWcs !== state.captureA.wcs) {
    throw new Error(`Active WCS changed from ${state.captureA.wcs} to ${state.activeWcs} after capture. Restore ${state.captureA.wcs} or re-capture both points.`);
  }

  const result = transformGcode(state.originalProgram.gcode, transform);
  if (result.programWcs && result.programWcs !== state.activeWcs) {
    throw new Error(`The G-code selects ${result.programWcs}, but the reference points were captured in ${state.activeWcs}. Select ${result.programWcs} in CNCjs and re-capture both points.`);
  }

  const name = alignedName(state.originalProgram.name);
  await loadProgram(name, result.gcode);
  state.alignedProgram = { name, gcode: result.gcode, result };
  state.currentProgramName = name;
  state.currentProgramIsAligned = true;
  state.message = {
    type: 'success',
    text: `Aligned preview loaded into CNCjs. Rotation ${transform.angleDeg >= 0 ? '+' : ''}${transform.angleDeg.toFixed(4)}°. Review the normal CNCjs visualizer before pressing Run. The original G-code is unchanged in memory.`
  };
  render();
}

async function restoreOriginal() {
  if (!state.originalProgram?.gcode) throw new Error('No original program is retained. Reload the original G-code from CNCjs.');
  await loadProgram(state.originalProgram.name, state.originalProgram.gcode);
  state.currentProgramName = state.originalProgram.name;
  state.currentProgramIsAligned = false;
  state.alignedProgram = null;
  state.message = { type: 'success', text: 'Original unaligned G-code restored.' };
  render();
}

function updateSetting(path, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  if (path === 'cadA.x') state.settings.cadA.x = n;
  if (path === 'cadA.y') state.settings.cadA.y = n;
  if (path === 'cadB.x') state.settings.cadB.x = n;
  if (path === 'cadB.y') state.settings.cadB.y = n;
  if (path === 'maxSpacingErrorMm') state.settings.maxSpacingErrorMm = n;
  if (path === 'maxRotationDeg') state.settings.maxRotationDeg = n;
  saveSettings();
  try {
    if (state.captureA && state.captureB) calculateAlignment(false);
  } catch (err) {
    state.transform = null;
    state.message = { type: 'error', text: err.message };
  }
  render();
}

function capture(which) {
  if (!isSafeToCapture()) throw new Error('Stop the machine and wait for GRBL to be Idle before capturing a reference point.');
  const point = snapshotPosition();
  if (which === 'A') state.captureA = point;
  else state.captureB = point;
  state.transform = null;

  if (state.captureA && state.captureB) {
    calculateAlignment(true);
  } else {
    state.message = { type: 'info', text: `Point ${which} captured. Jog to the other reference and capture it.` };
  }
  render();
}

function resetCaptures() {
  state.captureA = null;
  state.captureB = null;
  state.transform = null;
  state.message = { type: 'info', text: 'Reference captures cleared. The loaded G-code was not changed.' };
  render();
}

function captureText(capture) {
  if (!capture) return 'Not captured';
  return `Work X ${fixed(capture.x)}  Y ${fixed(capture.y)} mm · ${escapeHtml(capture.wcs)}`;
}

function programBadge() {
  if (!state.currentProgramName) return '<span class="badge">No program</span>';
  return state.currentProgramIsAligned
    ? '<span class="badge good">ALIGNED PREVIEW</span>'
    : '<span class="badge">ORIGINAL</span>';
}

function render() {
  const app = document.getElementById('app');
  const t = state.transform;
  const connectedBadge = state.socketConnected && state.port
    ? '<span class="badge good">Connected</span>'
    : '<span class="badge bad">Disconnected</span>';
  const controllerOk = state.controllerType === 'Grbl';
  const captureEnabled = isSafeToCapture() && currentPositionReady();
  const applyEnabled = controllerOk && !!state.captureA && !!state.captureB && !!state.transform && !!state.originalProgram?.gcode && isSafeToCapture();

  app.innerHTML = `
    <section class="card">
      <div class="card-header"><span>CNCJSSkew · Workpiece Align</span>${connectedBadge}</div>
      <div class="card-body">
        <div class="status-grid">
          <div class="status-item"><div class="label">Port</div><div class="value">${escapeHtml(state.port || '—')}</div></div>
          <div class="status-item"><div class="label">Controller</div><div class="value">${escapeHtml(state.controllerType || '—')}</div></div>
          <div class="status-item"><div class="label">Machine state</div><div class="value">${escapeHtml(state.activeState || '—')}</div></div>
          <div class="status-item"><div class="label">Active WCS</div><div class="value">${escapeHtml(state.activeWcs || '—')}</div></div>
          <div class="status-item"><div class="label">Work X</div><div class="value">${fixed(state.workPositionMm.x)} mm</div></div>
          <div class="status-item"><div class="label">Work Y</div><div class="value">${fixed(state.workPositionMm.y)} mm</div></div>
        </div>
        ${!controllerOk && state.controllerType ? '<div class="message error">This widget intentionally supports GRBL only. Your Shapeoko 3 should be connected as Grbl.</div>' : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-header"><span>1 · Reference points</span><span class="small">CAD coordinates in mm</span></div>
      <div class="card-body">
        <div class="point">
          <div class="point-title"><span>Point A</span><span class="badge ${state.captureA ? 'good' : ''}">${state.captureA ? 'Captured' : 'Waiting'}</span></div>
          <div class="coord-row">
            <span>X</span><input id="cadAx" type="number" step="0.001" value="${state.settings.cadA.x}">
            <span>Y</span><input id="cadAy" type="number" step="0.001" value="${state.settings.cadA.y}">
          </div>
          <div class="captured">${captureText(state.captureA)}</div>
          <button id="captureA" ${captureEnabled ? '' : 'disabled'}>Capture current position as A</button>
        </div>
        <div class="point">
          <div class="point-title"><span>Point B</span><span class="badge ${state.captureB ? 'good' : ''}">${state.captureB ? 'Captured' : 'Waiting'}</span></div>
          <div class="coord-row">
            <span>X</span><input id="cadBx" type="number" step="0.001" value="${state.settings.cadB.x}">
            <span>Y</span><input id="cadBy" type="number" step="0.001" value="${state.settings.cadB.y}">
          </div>
          <div class="captured">${captureText(state.captureB)}</div>
          <button id="captureB" ${captureEnabled ? '' : 'disabled'}>Capture current position as B</button>
        </div>
        <div class="small">Jog the spindle manually to the exact center of each physical reference. CNCJSSkew records the current GRBL <strong>work position</strong>; it does not use an electrical probe.</div>
        <div class="actions"><button id="resetCaptures" class="danger">Clear captures</button></div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><span>2 · Alignment</span>${t ? '<span class="badge good">Ready</span>' : '<span class="badge">Not calculated</span>'}</div>
      <div class="card-body">
        ${t ? `
          <div class="metrics-grid">
            <div class="metric"><div class="label">Rotation</div><div class="value">${t.angleDeg >= 0 ? '+' : ''}${t.angleDeg.toFixed(5)}°</div></div>
            <div class="metric"><div class="label">Spacing error</div><div class="value">${Math.abs(t.spacingErrorMm).toFixed(3)} mm</div></div>
            <div class="metric"><div class="label">X translation</div><div class="value">${t.translation.x >= 0 ? '+' : ''}${t.translation.x.toFixed(3)} mm</div></div>
            <div class="metric"><div class="label">Y translation</div><div class="value">${t.translation.y >= 0 ? '+' : ''}${t.translation.y.toFixed(3)} mm</div></div>
          </div>
        ` : '<div class="small">Capture A and B. Rotation and translation are calculated automatically.</div>'}
        <hr>
        <div class="settings-row"><label for="spacingLimit">Max spacing error</label><input id="spacingLimit" type="number" min="0.01" step="0.01" value="${state.settings.maxSpacingErrorMm}"></div>
        <div class="settings-row"><label for="rotationLimit">Max rotation</label><input id="rotationLimit" type="number" min="0.1" step="0.1" value="${state.settings.maxRotationDeg}"></div>
        <div class="small">Safety limits prevent a bad capture from silently producing a dangerous toolpath.</div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><span>3 · G-code</span>${programBadge()}</div>
      <div class="card-body">
        <div class="status-item"><div class="label">Loaded program</div><div class="value program-name">${escapeHtml(state.currentProgramName || 'None')}</div></div>
        <div class="actions">
          <button id="refreshProgram">Refresh original program</button>
          <button id="applyAlignment" class="primary" ${applyEnabled ? '' : 'disabled'}>Apply & load aligned preview</button>
          <button id="restoreOriginal" ${state.originalProgram?.gcode && state.currentProgramIsAligned ? '' : 'disabled'}>Restore original</button>
        </div>
        <div class="small" style="margin-top:8px">Apply does <strong>not</strong> start the CNC. It loads a transformed copy into CNCjs so you can inspect the normal visualizer first. Your original Fusion G-code is retained and can be restored.</div>
        <div class="message ${escapeHtml(state.message.type)}">${escapeHtml(state.message.text)}</div>
      </div>
    </section>
  `;

  bindEvents();
  notifyResize();
}

function bindEvents() {
  const on = (id, event, fn) => document.getElementById(id)?.addEventListener(event, fn);
  const guarded = fn => async (...args) => {
    try { await fn(...args); }
    catch (err) { setMessage('error', err?.message || String(err)); }
  };

  on('captureA', 'click', guarded(() => capture('A')));
  on('captureB', 'click', guarded(() => capture('B')));
  on('resetCaptures', 'click', resetCaptures);
  on('refreshProgram', 'click', guarded(() => refreshProgram()));
  on('applyAlignment', 'click', guarded(() => applyAlignment()));
  on('restoreOriginal', 'click', guarded(() => restoreOriginal()));

  on('cadAx', 'change', e => updateSetting('cadA.x', e.target.value));
  on('cadAy', 'change', e => updateSetting('cadA.y', e.target.value));
  on('cadBx', 'change', e => updateSetting('cadB.x', e.target.value));
  on('cadBy', 'change', e => updateSetting('cadB.y', e.target.value));
  on('spacingLimit', 'change', e => updateSetting('maxSpacingErrorMm', e.target.value));
  on('rotationLimit', 'change', e => updateSetting('maxRotationDeg', e.target.value));
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
  } catch { /* parent messaging is best effort */ }
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

function convertReportedPosition(pos) {
  const multiplier = state.reportInches ? MM_PER_INCH : 1;
  return {
    x: finite(pos?.x) ? Number(pos.x) * multiplier : NaN,
    y: finite(pos?.y) ? Number(pos.y) * multiplier : NaN,
    z: finite(pos?.z) ? Number(pos.z) * multiplier : NaN
  };
}

let socket = null;
if (!token) {
  state.message = { type: 'error', text: 'CNCjs did not provide an authentication token. Add this page as a CNCjs Custom Widget, not as a normal browser tab.' };
  render();
} else if (typeof window.io !== 'function' && typeof window.io?.connect !== 'function') {
  state.message = { type: 'error', text: 'CNCjs Socket.IO client could not be loaded from this Raspberry Pi.' };
  render();
} else {
  const ioFactory = typeof window.io.connect === 'function' ? window.io.connect.bind(window.io) : window.io;
  socket = ioFactory(host, { query: `token=${encodeURIComponent(token)}` });

  socket.on('connect', () => {
    state.socketConnected = true;
    window.parent.postMessage({ token, action: { type: 'connect' } }, '*');
    render();
  });
  socket.on('disconnect', () => {
    state.socketConnected = false;
    state.port = '';
    state.controllerType = '';
    render();
  });
  socket.on('serialport:open', options => {
    if (options?.port) state.port = options.port;
    if (options?.controllerType) state.controllerType = options.controllerType;
    render();
  });
  socket.on('serialport:close', options => {
    if (!options?.port || options.port === state.port) {
      state.port = '';
      state.controllerType = '';
      state.workPositionMm = { x: NaN, y: NaN, z: NaN };
    }
    render();
  });
  socket.on('workflow:state', workflow => {
    state.workflow = workflow || 'idle';
    render();
  });
  socket.on('controller:settings', (type, controllerSettings) => {
    state.controllerType = type || state.controllerType;
    const reportUnits = Number(controllerSettings?.settings?.$13 ?? controllerSettings?.['$13'] ?? 0);
    state.reportInches = reportUnits > 0;
  });
  socket.on('controller:state', (type, controllerState) => {
    state.controllerType = type || state.controllerType;
    if (type !== 'Grbl') {
      render();
      return;
    }
    const status = controllerState?.status || {};
    state.activeState = status.activeState || state.activeState;
    state.activeWcs = controllerState?.parserstate?.modal?.wcs || state.activeWcs || 'G54';
    if (status.wpos) state.workPositionMm = convertReportedPosition(status.wpos);
    if (status.mpos) state.machinePositionMm = convertReportedPosition(status.mpos);
    render();
  });
  socket.on('gcode:load', (name, gcode) => {
    state.currentProgramName = name || 'program.nc';
    state.currentProgramIsAligned = String(gcode || '').includes(ALIGNMENT_MARKER);
    if (gcode && !state.currentProgramIsAligned) {
      state.originalProgram = { name: state.currentProgramName, gcode };
      state.alignedProgram = null;
    }
    render();
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

render();
