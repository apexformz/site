/** Real Chrome regression using checksum-bound squash Data Capture video as its camera.
 * No pose/recognition results are mocked. Deliberate faults are identified in the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import os from 'node:os';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = process.cwd();
const base = option('--base-url', 'http://127.0.0.1:3101');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use a local test server');
const fixturesPath = path.resolve(option('--fixtures', 'data/audit/browser-squash/fixtures/manifest.json'));
const packRoot = path.resolve(option('--pack-root', process.env.SPORT_PACKS_DIR ?? 'sport-packs'));
const out = path.resolve(option('--out', 'data/audit/browser-squash/validation.json'));
const only = option('--only', '').split(',').filter(Boolean);
const soakSeconds = Number(option('--soak-seconds', '120'));
if (!(soakSeconds >= 10 && soakSeconds <= 1800)) throw new Error('soak-seconds must be 10..1800');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const modulePath = option('--playwright-module', process.env.APEX_PLAYWRIGHT_MODULE);
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const fixtureDocument = json(fixturesPath);
const fixtures = fixtureDocument.fixtures;
assert.equal(sha(fs.readFileSync(fixtureDocument.manifest_path)), fixtureDocument.manifest_sha256, 'Source manifest changed');
for (const f of fixtures) {
  assert.match(f.source_uri, /^s3:\/\/apexformz-datacapture-[^/]+\/raw\/squash\//, 'Only squash Data Capture');
  assert.equal(sha(fs.readFileSync(f.source_mp4_path)), f.source_sha256, `Source changed: ${f.id}`);
  f.resolved = path.resolve(f.y4m_path);
  assert.equal(sha(fs.readFileSync(f.resolved)), f.y4m_sha256, `fixture changed: ${f.id}`);
}
const pinPaths = ['package.json', 'package-lock.json', fixturesPath, fixtureDocument.manifest_path, 'tools/validate_squash_browser.mjs', 'apps/frontend/.next/BUILD_ID',
  'apps/frontend/src/components/brain/BrainTrainingPage.tsx', 'apps/frontend/src/lib/brain/config.ts',
  'packages/brain-client/src/worker.ts', 'packages/brain-client/src/client.ts', 'packages/brain-client/src/protocol.ts',
  'packages/brain-client/src/react/useApexBrain.ts', 'apps/frontend/src/lib/brain/ort-shim.mjs',
  'apps/frontend/src/lib/brain/runtime-assets.generated.json', 'apps/frontend/public/models/pose_landmarker_full.task',
  'apps/frontend/public/models/reid/reid.json',
  'apps/frontend/public/models/squash/index.json', path.join(packRoot, 'squash/manifest.json'),
  'apps/frontend/public/pack-trust.json', 'apps/frontend/src/lib/brain/pack-trust.generated.json'];
const reidConfig = json('apps/frontend/public/models/reid/reid.json');
const reidPath = path.resolve('apps/frontend/public/models/reid', reidConfig.model_url);
assert.equal(`sha256:${sha(fs.readFileSync(reidPath))}`, reidConfig.digest, 'Re-ID model differs from its declared digest');
pinPaths.push(reidPath);
for (const entry of json('apps/frontend/public/models/squash/index.json')) {
  for (const key of ['model_url', 'deployment_url']) pinPaths.push(path.join('apps/frontend/public/models/squash', entry[key]));
}
function addFiles(directory, include) {
  for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
    const p = path.join(directory, e.name);
    if (e.isDirectory()) addFiles(p, include);
    else if (include(p)) pinPaths.push(p);
  }
}
addFiles('packages', (p) => p.includes(`${path.sep}src${path.sep}`) && /\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts'));
addFiles('apps/frontend/src', (p) => /\.(ts|tsx|mjs|json)$/.test(p));
addFiles('apps/frontend/.next/static', (p) => /\.(js|wasm)$/.test(p));
addFiles('apps/frontend/public/runtime', (p) => /\.(js|mjs|wasm|json)$/.test(p));
addFiles(path.join(packRoot, 'squash'), (p) => p.endsWith('.json'));
for (const f of fixtures) pinPaths.push(f.resolved, f.source_mp4_path);
const pins = Object.fromEntries(pinPaths.map((p) => [p, sha(fs.readFileSync(p))]));
const report = { schema_version: '1.0.0', status: 'running', started_at: new Date().toISOString(),
  purpose: 'real_browser_integration_regression', base_url: base, headless: true,
  machine: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, ram_bytes: os.totalmem(), node: process.version },
  source: 'existing_landscape_squash_Data_Capture_only', fixtures_manifest: fixturesPath,
  sport_pack_root: packRoot, build_trust: json('apps/frontend/public/pack-trust.json'),
  fixtures_sha256: sha(fs.readFileSync(fixturesPath)), source_pins: pins,
  coaching_accuracy: null, independent_recognition_accuracy: null, production_eligible: false,
  limitations: ['Recorded video loops through Chrome fake camera; no physical camera or target-device validation.',
    'Tap lifecycle uses the existing recorded athlete; multi-person crossing accuracy still requires independent recordings.',
    'Training-source integration regression does not estimate independent recognition or technique accuracy.',
    'CPU/software graphics and local timings describe this test machine only.',
    'Explicit worker/camera/model/network fault injections are test conditions, never training evidence.'], cases: [] };
fs.mkdirSync(path.dirname(out), { recursive: true });
const save = () => fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
save();

// Observe the real public worker protocol. Only named fault cases change input or resources.
function installProbe({ view, forceMain, forceCPU, denyCamera }) {
  const p = window.__squashBrowser = { counts: {}, states: [], ready: [], errors: [], loaded: [],
    poses: 0, landmarkPoses: 0, ticks: 0, assessments: 0, inferences: 0, qualityOK: 0,
    nonfinite: 0, wrongMovement: 0, strictVerdicts: 0, strictCues: 0, activeImages: 0, maxActiveImages: 0,
    poseAges: [], imageSizes: {}, reasons: {}, workers: [], streams: [], pauseImages: false,
    lastTick: null, lastPose: null, pinCommands: [], pinResponses: [], pinnedFrames: 0,
    detectionTasks: {}, inferredTasks: {}, expectedClasses: {}, invalidProbabilities: 0, poseDelegates: {}, strictLabels: 0, drawCalls: 0,
    fallbackNames: 0, closestMatches: 0, invalidClosestMatches: 0, recognitionLevels: {} };
  const bump = (k) => { p.counts[k] = (p.counts[k] ?? 0) + 1; };
  const ctxPrototype = CanvasRenderingContext2D.prototype;
  const stroke = ctxPrototype.stroke;
  ctxPrototype.stroke = function (...a) { p.drawCalls++; return stroke.apply(this, a); };
  const captureBitmap = window.createImageBitmap.bind(window);
  window.createImageBitmap = (...a) => p.pauseImages
    ? Promise.reject(new Error('Deliberate capture stall before bitmap transfer')) : captureBitmap(...a);
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...a) => {
    if (denyCamera) throw new DOMException('Browser validation: permission denied', 'NotAllowedError');
    const stream = await original(...a); p.streams.push(stream); return stream;
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...a) {
      super(...a); p.workers.push(this);
      this.requests = new Map();
      this.addEventListener('message', ({ data: m }) => {
        bump('worker:' + m.type);
        if (m.type === 'ready') p.ready.push(m);
        if (m.type === 'state') p.states.push(m.state);
        if (m.type === 'error') p.errors.push(m);
        if (m.type === 'image_done') p.activeImages = Math.max(0, p.activeImages - 1);
        if (m.type === 'ok' && this.requests.get(m.id) === 'load_movement_models') {
          p.loaded = m.result.map(({model_task, model, input, calibration}) => ({model_task, model, input, calibration}));
          for (const c of m.result) p.expectedClasses[c.model_task] = c.classes;
        }
        if (m.type === 'ok' && this.requests.get(m.id) === 'pin_subject') {
          p.pinResponses.push({ id: m.id, status: m.result });
        }
        if (m.type === 'pose') {
          // Older protocol had no image_done; retain diagnostics without asserting a false queue bound.
          p.poses++; if (m.frame.normalized_landmarks?.some((l) => l.visibility > .5)) p.landmarkPoses++;
          const delegate = m.frame.provenance?.delegate ?? 'unknown'; p.poseDelegates[delegate] = (p.poseDelegates[delegate] ?? 0) + 1;
          p.poseAges.push(performance.now() - m.frame.timestamp_ms); if (p.poseAges.length > 3000) p.poseAges.shift();
          const size = m.frame.image_size.join('x'); p.imageSizes[size] = (p.imageSizes[size] ?? 0) + 1;
          const torso = m.frame.normalized_landmarks.filter((l) => [11, 12, 23, 24].includes(l.id) && l.visibility > .5);
          p.lastPose = { frame_id: m.frame.frame_id, timestamp_ms: m.frame.timestamp_ms, subject_id: m.frame.tracked_subject_id,
            landmark_count: m.frame.normalized_landmarks.length, torso, quality: m.frame.quality };
          if (m.frame.tracked_subject_id?.startsWith('pinned-')) p.pinnedFrames++;
        }
        if (m.type === 'movement_detection') {
          p.inferences++; p.detectionTasks[m.detection.model_task] = (p.detectionTasks[m.detection.model_task] ?? 0) + 1;
          const entries = Object.entries(m.detection.probabilities ?? {});
          if (entries.length) {
            // RecognizerOutput deliberately separates UNKNOWN from the known-class map.
            const expected = p.expectedClasses[m.detection.model_task]?.filter((k) => k !== 'UNKNOWN');
            const unknown = m.detection.unknown_probability;
            if (!expected || entries.length !== expected.length || entries.some(([k, v]) => !expected.includes(k) || !Number.isFinite(v) || v < 0 || v > 1)
                || !Number.isFinite(unknown) || unknown < 0 || unknown > 1
                || Math.abs(entries.reduce((a, [,v]) => a + v, unknown) - 1) > 1e-4) p.invalidProbabilities++;
            else p.inferredTasks[m.detection.model_task] = (p.inferredTasks[m.detection.model_task] ?? 0) + 1;
          }
          if (p.recognitionMode === 'validated' && m.detection.calibration_status !== 'validated'
              && (!m.detection.unknown || m.detection.capture_label || m.detection.capture_name || m.detection.level || m.detection.closest_match)) p.strictLabels++;
          if (m.detection.level) p.recognitionLevels[m.detection.level] = (p.recognitionLevels[m.detection.level] ?? 0) + 1;
          if (['group', 'family'].includes(m.detection.level)) p.fallbackNames++;
          if (m.detection.closest_match) {
            p.closestMatches++;
            if (!m.detection.unknown || m.detection.capture_label || m.detection.movement_id || !['group', 'family'].includes(m.detection.level)) p.invalidClosestMatches++;
          }
          p.reasons[m.detection.reason ?? 'recognized'] = (p.reasons[m.detection.reason ?? 'recognized'] ?? 0) + 1;
        }
        if (m.type === 'tick') {
          const t = m.tick; p.ticks++; p.lastTick = { frame_id: t.frame_id, timestamp_ms: t.timestamp_ms, quality: t.quality };
          if (t.quality.ok) p.qualityOK++;
          if (t.temporal?.movement_id && t.temporal.movement_id !== p.movement) p.wrongMovement++;
          for (const f of t.features ?? []) if (f.value !== null && !Number.isFinite(f.value)) p.nonfinite++;
          if (t.assessment) {
            p.assessments++;
            if (t.assessment.score !== null && !Number.isFinite(t.assessment.score)) p.nonfinite++;
            for (const c of t.assessment.criteria) {
              if (c.measurement.value !== null && !Number.isFinite(c.measurement.value)) p.nonfinite++;
              if (p.mode === 'strict' && c.provenance.validation_status !== 'approved' && ['PASS', 'IMPROVE'].includes(c.state)) p.strictVerdicts++;
            }
          }
          if (p.mode === 'strict' && t.feedback?.kind === 'technique_cue') p.strictCues++;
        }
      });
    }
    postMessage(m, ...a) {
      if (m.id) this.requests.set(m.id, m.type);
      bump('host:' + m.type);
      if (m.type === 'init') {
        if (forceMain) m = { ...m, detector: undefined };
        else if (forceCPU && m.detector) m = { ...m, detector: { ...m.detector, delegate: 'CPU' } };
      }
      if (m.type === 'start') {
        p.movement = m.request.movement_id;
        p.mode = new URL(location.href).searchParams.get('mode') ?? 'strict';
        p.recognitionMode = new URL(location.href).searchParams.get('recognition') === 'validated' ? 'validated' : 'preview';
      }
      if (m.type === 'pin_subject') p.pinCommands.push({ id: m.id, point: m.point });
      if (m.type === 'pose_frame') {
        p.poses++; if (m.frame.normalized_landmarks?.some((l) => l.visibility > .5)) p.landmarkPoses++;
        const delegate = m.frame.provenance?.delegate ?? 'unknown'; p.poseDelegates[delegate] = (p.poseDelegates[delegate] ?? 0) + 1;
        p.poseAges.push(performance.now() - m.frame.timestamp_ms); if (p.poseAges.length > 3000) p.poseAges.shift();
        const size = m.frame.image_size.join('x'); p.imageSizes[size] = (p.imageSizes[size] ?? 0) + 1;
      }
      if (m.type === 'image') {
        p.activeImages++; p.maxActiveImages = Math.max(p.maxActiveImages, p.activeImages);
      }
      return super.postMessage(m, ...a);
    }
    terminate() { bump('worker:terminated'); return super.terminate(); }
  };
  // Setup is real host input, with view taken from the source manifest, not an invented label.
  localStorage.setItem('brain_setup_squash', JSON.stringify({ mode: new URL(location.href).searchParams.get('mode'),
    movement_id: new URL(location.href).searchParams.get('movement'),
    calibration: { full_body_framing: true, camera_tilt_deg: null, nominal_view: view, handedness: 'right',
      handedness_assumed: false, floor_orientation_available: false, scale_known: false,
      scale_marker_m: null, athlete_context: 'unknown' } }));
}

async function snapshot(page) {
  return page.evaluate(() => {
    const { workers, streams, poseAges, ...p } = window.__squashBrowser;
    const sorted = [...poseAges].sort((a, b) => a - b);
    return { ...p, pose_age_ms: { p50: sorted[Math.floor(sorted.length * .5)] ?? null,
      p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null },
      stream_tracks: streams.flatMap((s) => s.getTracks().map((t) => ({ readyState: t.readyState, kind: t.kind }))),
      memory: performance.memory ? { used_js_heap: performance.memory.usedJSHeapSize, total_js_heap: performance.memory.totalJSHeapSize } : null };
  });
}

/** Use the real detected torso to click the displayed athlete through the same mirror/crop as the UI. */
async function tapDetectedAthlete(page, previousSubject = null) {
  await page.waitForFunction(() => {
    const pose = window.__squashBrowser.lastPose;
    return pose?.torso.length === 4 && performance.now() - pose.timestamp_ms < 1000;
  }, null, { timeout: 45000 });
  const point = await page.locator('video').evaluate((video) => {
    const pose = window.__squashBrowser.lastPose;
    const raw = { x: pose.torso.reduce((s, p) => s + p.x, 0) / 4, y: pose.torso.reduce((s, p) => s + p.y, 0) / 4 };
    const box = video.getBoundingClientRect();
    const scale = Math.max(box.width / video.videoWidth, box.height / video.videoHeight);
    const x = box.left + (box.width - video.videoWidth * scale) / 2 + (1 - raw.x) * video.videoWidth * scale;
    const y = box.top + (box.height - video.videoHeight * scale) / 2 + raw.y * video.videoHeight * scale;
    const blocked = document.elementFromPoint(x, y)?.closest('button, a, [data-no-pin]');
    return { x, y, raw, blocked: !!blocked, observed_frame: pose.frame_id };
  });
  assert(!point.blocked, 'Detected torso must be a tappable part of the camera surface');
  const before = (await snapshot(page)).pinCommands.length;
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(({ before, previousSubject }) => {
    const p = window.__squashBrowser;
    return p.pinCommands.length === before + 1 && p.lastPose?.subject_id?.startsWith('pinned-')
      && p.lastPose.subject_id !== previousSubject && p.lastPose.landmark_count > 0;
  }, { before, previousSubject }, { timeout: 30000 });
  const observed = await snapshot(page);
  const command = observed.pinCommands.at(-1);
  assert(Math.abs(command.point.x - point.raw.x) < .01 && Math.abs(command.point.y - point.raw.y) < .01,
    'Actual pointer gesture must undo the mirrored video and object-cover crop');
  await page.getByRole('button', { name: 'Unpin athlete', exact: true }).waitFor();
  return { gesture: point, command, response: observed.pinResponses.find((r) => r.id === command.id)?.status,
    subject_id: observed.lastPose.subject_id, tracked_frame: observed.lastPose.frame_id };
}

async function runCase(spec) {
  const fixture = fixtures.find((f) => f.id === spec.fixture);
  assert(fixture, `missing ${spec.fixture}`);
  const result = { id: spec.id, fixture: fixture.id, source_view: fixture.view, movement_id: fixture.movement_id,
    mode: spec.mode ?? 'development', recognition_mode: spec.recognition ?? 'preview', deliberate_faults: spec.faults ?? [], status: 'running', checks: [],
    console_errors: [], page_errors: [], failed_requests: [], http_errors: [], external_requests: [] };
  report.cases.push(result); save();
  console.log('START ' + spec.id);
  const browser = await chromium.launch({ channel: option('--channel', 'chrome'), headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${fixture.resolved}`, '--enable-unsafe-swiftshader', '--no-proxy-server',
      ...(spec.forceCPU ? ['--disable-gpu'] : [])] });
  report.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera'], serviceWorkers: 'block' });
  const page = await context.newPage();
  const origin = new URL(base).origin;
  let poseModelRequests = 0;
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin && ['http:', 'https:'].includes(u.protocol)) {
      result.external_requests.push(u.href); return route.abort('blockedbyclient');
    }
    if (spec.blockModels && u.pathname.includes('/models/squash/') && u.pathname.endsWith('.onnx')) return route.fulfill({ status: 503, body: 'Deliberate model availability fault' });
    if (spec.failFirstPoseModel && u.pathname === '/models/pose_landmarker_full.task' && poseModelRequests++ === 0)
      return route.fulfill({ status: 503, body: 'Deliberate first GPU initialization model-fetch fault; CPU retry uses actual asset' });
    return route.continue();
  });
  page.on('console', (m) => { if (m.type() === 'error') result.console_errors.push(m.text().slice(0,1500)); });
  page.on('pageerror', (e) => result.page_errors.push(e.message));
  page.on('requestfailed', (r) => result.failed_requests.push({ url: r.url(), error: r.failure()?.errorText }));
  page.on('response', (r) => { if (r.status() >= 400) result.http_errors.push({ url: r.url(), status: r.status() }); });
  await page.addInitScript(installProbe, { view: fixture.view, forceMain: !!spec.forceMain, forceCPU: !!spec.forceCPU, denyCamera: !!spec.denyCamera });
  const check = (ok, description) => { assert(ok, description); result.checks.push(description); console.log('  OK ' + description); };
  try {
    if (spec.setup) {
      await page.goto(`${base}/train/squash/setup?mode=${result.mode}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.getByRole('textbox', { name: 'Search movements' }).fill(fixture.movement_name);
      await page.locator('button[aria-pressed]').filter({ hasText: fixture.movement_name }).first().click();
      await page.getByLabel('Camera view').selectOption(fixture.view);
      await page.getByRole('button', { name: /^development/i }).click();
      await page.getByRole('button', { name: 'Enter Arena' }).click();
      await page.waitForURL((u) => u.pathname === '/train/squash' && u.searchParams.get('movement') === fixture.movement_id && u.searchParams.get('mode') === result.mode);
      check(true, 'Actual setup picker, source view and development mode route to selected drill');
    } else await page.goto(`${base}/train/squash?movement=${encodeURIComponent(fixture.movement_id)}&mode=${result.mode}&recognition=${result.recognition_mode}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__squashBrowser.ready.length && document.body.innerText.includes('ON DEVICE') || document.body.innerText.includes('could not load'), { timeout: 60000 });
    if (!spec.blockModels) {
      await page.waitForFunction(() => window.__squashBrowser.loaded?.length === 2, { timeout: 60000 });
      check(true, 'Both actual static and dynamic ONNX models loaded in module worker');
    } else {
      check((await page.getByRole('region', { name: 'Squash movement recognition' }).innerText()).toLowerCase().includes('could not load'),
        'Model fault is clearly shown as recognition unavailable');
    }
    await page.getByRole('button', { name: 'ENABLE CAMERA TO START' }).click();
    if (spec.denyCamera) {
      await page.waitForTimeout(1200);
      check(await page.getByText('Camera is disabled', { exact: true }).isVisible(), 'Permission denial leaves camera disabled');
      check(await page.getByTitle('Start session', { exact: true }).isDisabled(), 'Session cannot start without camera');
      check((await snapshot(page)).ticks === 0, 'Permission failure produces no assessment frames');
    } else {
      await page.waitForFunction(() => { const v = document.querySelector('video'); return v?.readyState >= 2 && v.videoWidth > v.videoHeight; }, { timeout: 20000 });
      result.camera_size = await page.locator('video').evaluate((v) => [v.videoWidth, v.videoHeight]);
      if (spec.fixture === 'front_native') check(result.camera_size[0] === 1280 && result.camera_size[1] === 720, 'Native source exercises actual 1280x720 camera pixels');
      check(true, 'Chrome decodes landscape source through real getUserMedia');
      await page.getByTitle('Start session', { exact: true }).click();
      await page.waitForFunction(() => window.__squashBrowser.states.some((s) => s === 'ACTIVE') && window.__squashBrowser.ticks >= 15, { timeout: 60000 });
      result.clocks = { page: await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now() })),
        worker: await page.workers()[0].evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now() })) };
      check(true, 'Real session starts and browser pose pipeline reaches Brain ticks');
      if (spec.forceMain) check((await snapshot(page)).ready.some((r) => !r.detector), 'Deliberately unavailable worker detector uses real main-thread fallback');
      else check((await snapshot(page)).ready.some((r) => r.detector), 'Real MediaPipe initializes inside module worker');
      if (spec.pinLifecycle) {
        result.pin_lifecycle = { initial: await tapDetectedAthlete(page) };
        check(true, 'Actual pointer tap maps the mirrored athlete to raw coordinates and creates a pinned track');
        const first = result.pin_lifecycle.initial.subject_id;
        const samples = (await snapshot(page)).pinnedFrames;
        await page.waitForFunction((n) => window.__squashBrowser.pinnedFrames >= n + 30, samples, { timeout: 45000 });
        result.pin_lifecycle.repinned = await tapDetectedAthlete(page, first);
        check(result.pin_lifecycle.repinned.response?.appearance_samples > 0,
          'Real re-ID model has populated the first athlete gallery before re-pinning');
        check(result.pin_lifecycle.repinned.subject_id !== first, 'A second real tap creates a new pin identity after tracking has collected appearance crops');
      }
      if (spec.lifecycle) {
        await page.getByTitle('Toggle camera', { exact: true }).click();
        await page.waitForFunction(() => window.__squashBrowser.states.at(-1) === 'PAUSED');
        const before = await snapshot(page);
        await page.waitForTimeout(1600);
        check((await snapshot(page)).ticks <= before.ticks + 1, 'Camera pause stops new assessment ticks');
        check(await page.locator('[aria-label="Recognition specificity"], [aria-label="Recognition level"]').count() === 0, 'Pause removes exact, closest, group and family recognition names');
        check(await page.getByText('Camera is disabled', { exact: true }).isVisible(), 'Pause removes camera and pose overlay');
        await page.getByRole('button', { name: 'ENABLE CAMERA TO START' }).click();
        await page.waitForFunction((n) => window.__squashBrowser.ticks > n + 10, before.ticks, { timeout: 45000 });
        check(true, 'Camera resumes with fresh real pose ticks');
        if (spec.pinLifecycle) {
          const pinned = result.pin_lifecycle.repinned.subject_id;
          await page.waitForFunction((subject) => {
            const p = window.__squashBrowser;
            return p.lastPose?.subject_id === subject && p.lastPose.landmark_count > 0;
          }, pinned, { timeout: 45000 });
          check(true, 'Camera pause/resume preserves the explicitly pinned athlete and reacquires fresh landmarks');
          await page.getByRole('button', { name: 'Unpin athlete', exact: true }).click();
          await page.waitForFunction(() => {
            const p = window.__squashBrowser;
            return p.pinCommands.at(-1)?.point === null && !p.lastPose?.subject_id?.startsWith('pinned-') && p.lastPose?.landmark_count > 0;
          }, null, { timeout: 30000 });
          check(await page.getByRole('button', { name: 'Unpin athlete', exact: true }).count() === 0,
            'Unpin button sends null and restores automatic tracking without generating a new pin');
          result.pin_lifecycle.unpinned = (await snapshot(page)).lastPose;
          result.pin_lifecycle.pinned_again = await tapDetectedAthlete(page, pinned);
          check(result.pin_lifecycle.pinned_again.subject_id !== pinned, 'Pinning again after unpin starts a fresh identity');
        }
      }
      if (spec.stale) {
        const painted = await page.locator('canvas').evaluateAll((canvases) => canvases.some((c) => {
          const ctx = c.getContext('2d'); if (!ctx) return false;
          const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) return true;
          return false;
        }));
        check(painted, 'Fresh real landmarks render visible skeleton pixels');
        await page.evaluate(() => { window.__squashBrowser.pauseImages = true; });
        await page.waitForTimeout(2500);
        const text = await page.locator('body').innerText();
        check(text.includes('Waiting for the first pose frame') || text.includes('Coaching is paused'), 'Stalled capture expires live assessment presentation');
        check(await page.locator('[aria-label="Recognition specificity"], [aria-label="Recognition level"]').count() === 0, 'Stalled capture expires exact, closest, group and family recognition names');
        const empty = await page.locator('canvas').evaluateAll((canvases) => canvases.every((c) => {
          const ctx = c.getContext('2d'); if (!ctx) return true;
          const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) return false;
          return true;
        }));
        check(empty, 'Stalled capture clears stale skeleton pixels');
        const stalledTicks = (await snapshot(page)).ticks;
        await page.evaluate(() => { window.__squashBrowser.pauseImages = false; });
        await page.waitForFunction((n) => window.__squashBrowser.ticks > n + 10, stalledTicks, { timeout: 45000 });
        check(true, 'Capture resumes producing fresh ticks after the deliberate stall');
      }
      const seconds = spec.soak ? soakSeconds : spec.seconds ?? 12;
      result.samples = [];
      for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
        await page.waitForTimeout(Math.min(5, seconds - elapsed) * 1000);
        result.samples.push({ elapsed_s: Math.min(seconds, elapsed + 5), ...(await snapshot(page)),
          recognition_specificity: await page.locator('[aria-label="Recognition specificity"]').allTextContents() });
      }
      if (spec.cameraEnded) {
        await page.evaluate(() => { const p = window.__squashBrowser; const t = p.streams.at(-1).getVideoTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
        await page.waitForFunction(() => window.__squashBrowser.states.at(-1) === 'PAUSED');
        check(await page.getByText('Camera is disabled', { exact: true }).isVisible(), 'Ended camera track pauses session and clears camera');
      }
      if (spec.fatalWorker) {
        await page.workers()[0].evaluate(() => setTimeout(() => { throw new Error('DELIBERATE_BROWSER_WORKER_FAULT'); }, 0));
        await page.getByText('Brain failed to start', { exact: true }).waitFor({ timeout: 15000 });
        check(true, 'Uncaught real worker error shows failure/reload overlay');
        await page.waitForFunction(() => window.__squashBrowser.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')) && window.__squashBrowser.counts['worker:terminated'] > 0);
        check(await page.getByTitle('Start session', { exact: true }).isDisabled(), 'Fatal failure stops camera, terminates worker and prevents another start');
        result.before_reload = await snapshot(page);
        await page.getByRole('button', { name: 'RELOAD', exact: true }).click();
        await page.waitForFunction(() => window.__squashBrowser.loaded?.length === 2, null, { timeout: 60000 });
        await page.getByRole('button', { name: 'ENABLE CAMERA TO START' }).click();
        await page.getByTitle('Start session', { exact: true }).click();
        await page.waitForFunction(() => window.__squashBrowser.ticks >= 15, null, { timeout: 60000 });
        check(true, 'Reload recovers a new worker and a fresh real video session');
        await page.waitForFunction(() => window.__squashBrowser.inferredTasks.static_pose > 0 && window.__squashBrowser.inferredTasks.dynamic_movement > 0, null, { timeout: 45000 });
        check(true, 'Recovered worker executes both real ONNX models before completion');
        await page.getByTitle('Finish session', { exact: true }).click();
        await page.waitForURL('**/results/**', { timeout: 30000 });
        check(true, 'Recovered session completes to results');
      } else {
        await page.getByTitle('Finish session', { exact: true }).click();
        await page.waitForURL('**/results/**', { timeout: 30000 });
        check(true, 'Completion commits local session and opens actual results page');
        const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('brain_session_')).map((k) => JSON.parse(localStorage.getItem(k))));
        check(stored.some((s) => s.ended_at && s.summary && s.sport === 'squash' && s.movement_id === fixture.movement_id), 'Results have a committed local squash summary');
        const chronology = await page.evaluate(async () => {
          const events = await new Promise((resolve, reject) => {
            const request = indexedDB.open('apexformz-brain-outbox', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('events', 'readonly'); const r = tx.objectStore('events').getAll();
              r.onsuccess = () => { resolve(r.result); db.close(); }; r.onerror = () => { reject(r.error); db.close(); };
            };
          });
          const ordered = events.sort((a, b) => a.sequence - b.sequence);
          const regressions = ordered.flatMap((e, i) => i && e.monotonic_ms < ordered[i-1].monotonic_ms
            ? [{ sequence: e.sequence, type: e.event_type, timestamp: e.monotonic_ms,
              previous: { sequence: ordered[i-1].sequence, type: ordered[i-1].event_type, timestamp: ordered[i-1].monotonic_ms } }]
            : []);
          const invalidSpans = ordered.filter((e) => e.payload?.end_ms != null && e.payload?.start_ms != null && e.payload.end_ms < e.payload.start_ms);
          return { count: ordered.length, regressions, invalidSpans: invalidSpans.length };
        });
        result.event_chronology = chronology;
        check(chronology.count > 0 && chronology.regressions.length === 0, 'Committed browser events preserve monotonic source/lifecycle clock order');
        check(chronology.invalidSpans === 0, 'Committed movement events have nonnegative time spans');
      }
      await page.waitForFunction(() => window.__squashBrowser.counts['worker:terminated'] > 0 && window.__squashBrowser.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
      check(true, 'Leaving the training page releases camera tracks and terminates worker');
      const p = await snapshot(page);
      check(p.nonfinite === 0 && p.wrongMovement === 0, 'Finite measurements and correct selected drill throughout');
      check(p.strictVerdicts === 0 && p.strictCues === 0, 'Strict mode never approves provisional criteria or speaks draft technique');
      check(p.poses > 10 && p.landmarkPoses > 0, 'Actual MediaPipe outputs include detected body landmarks');
      if (!spec.blockModels) check(p.inferences > 0, 'Loaded recognizers produce actual browser detection outputs');
      check(p.invalidProbabilities === 0, 'Model probability maps have expected classes, finite values and sum to one');
      check(p.invalidClosestMatches === 0, 'Closest suggestions remain separate from accepted exact labels');
      if (spec.blockModels) {
        check(result.http_errors.some((e) => e.status === 503 && e.url.includes('/models/squash/')) && p.loaded.length === 0 && !Object.keys(p.inferredTasks).length,
          'Deliberate model HTTP failure leaves pose coaching operational without recognition');
      }
      if (!spec.blockModels && result.recognition_mode === 'preview') check(p.inferredTasks.static_pose > 0 && p.inferredTasks.dynamic_movement > 0, 'Both ONNX models execute and return real class probability maps in recognition preview');
      if (result.recognition_mode === 'validated') check(p.strictLabels === 0 && !Object.keys(p.inferredTasks).length, 'Validated-only provisional recognition abstains without executing unvalidated inference');
      if (spec.expectFallback) {
        check(result.mode === 'strict' && p.fallbackNames > 0, 'Strict coaching independently permits supported recognition preview groups or families');
        check(result.samples.some((s) => s.recognition_specificity.some((label) => ['Closest match', 'Movement group', 'Movement family'].includes(label.trim()))),
          'Real UI visibly presents a closest match, movement group or family while coaching remains strict');
      }
      if (spec.forceCPU || spec.failFirstPoseModel) check(p.poseDelegates.CPU > 0, 'Actual pose evidence confirms CPU delegate');
      if (spec.failFirstPoseModel) check(poseModelRequests >= 2 && result.http_errors.some((e) => e.status === 503 && e.url.endsWith('/models/pose_landmarker_full.task')),
        'Failed first GPU initialization automatically retries real MediaPipe with CPU');
      if (spec.soak) {
        const mid = result.samples[Math.floor(result.samples.length / 2)];
        const last = result.samples.at(-1);
        check(last.ticks > mid.ticks + 10, 'Sustained playback continues producing live ticks');
        check(Number.isFinite(last.pose_age_ms.p95) && last.pose_age_ms.p50 >= 0 && last.pose_age_ms.p95 < 1500, 'Sustained pose age stays within 1500ms on this development machine');
        check(last.maxActiveImages <= 1, 'At most one transferred image is outstanding during sustained playback');
        if (mid.memory && last.memory) check(last.memory.used_js_heap < mid.memory.used_js_heap + 64 * 1024 * 1024, 'Browser heap does not grow by 64MiB during the second half of playback');
      }
    }
    check(result.page_errors.filter((e) => !spec.fatalWorker || !e.includes('DELIBERATE_BROWSER_WORKER_FAULT')).length === 0, 'No unexpected browser JavaScript exceptions');
    check(result.external_requests.length === 0, 'Inference/assets remain on local origin without external requests');
    check(result.http_errors.every((e) => e.status === 503 && ((spec.blockModels && e.url.includes('/models/squash/'))
      || (spec.failFirstPoseModel && e.url.endsWith('/models/pose_landmarker_full.task')))), 'No unexpected missing/failed HTTP assets');
    const observed = await snapshot(page);
    check(observed.errors.every((e) => spec.blockModels && e.message.includes('movement model fetch failed: 503')), 'No unexpected Brain worker errors');
    check(result.failed_requests.every((r) => {
      const u = new URL(r.url);
      return r.error === 'net::ERR_ABORTED' && u.searchParams.has('_rsc') && /^\/(train|results)\//.test(u.pathname);
    }), 'No unexpected failed network requests (cancelled Next navigation prefetches excluded)');
    result.status = 'passed';
  } catch (e) {
    result.status = 'failed'; result.error = e.stack ?? String(e);
  } finally {
    try { result.final = await snapshot(page); result.body_text = (await page.locator('body').innerText()).slice(0,20000); }
    catch (e) { result.snapshot_error = String(e); }
    const screenshot = path.join(path.dirname(out), `${path.basename(out, '.json')}-${spec.id}.png`);
    try { await page.screenshot({ path: screenshot, fullPage: true }); result.screenshot = path.relative(root, screenshot); } catch { /* context may have crashed */ }
    await browser.close();
    result.finished_at = new Date().toISOString(); save();
    console.log(`${result.status.toUpperCase()} ${spec.id}${result.error ? ': ' + result.error.split('\n')[0] : ''}`);
  }
}

const cases = [
  { id: 'setup-to-training', fixture: 'front', setup: true, seconds: 15 },
  { id: 'tap-pin-lifecycle', fixture: 'front', pinLifecycle: true, lifecycle: true, seconds: 15 },
  { id: 'front-development-lifecycle', fixture: 'front', lifecycle: true, stale: true, cameraEnded: true, seconds: 15, faults: ['capture_stall', 'track_ended'] },
  { id: 'back-strict', fixture: 'back', mode: 'strict', recognition: 'validated', seconds: 15 },
  { id: 'back-strict-preview', fixture: 'back', mode: 'strict', recognition: 'preview', expectFallback: true, seconds: 15 },
  { id: 'left-development', fixture: 'left', seconds: 15 },
  { id: 'right-development', fixture: 'right', seconds: 15 },
  { id: 'front-native-soak', fixture: 'front_native', soak: true },
  { id: 'cpu-worker-fallback', fixture: 'front', forceCPU: true, seconds: 15, faults: ['GPU_unavailable'] },
  { id: 'automatic-cpu-fallback', fixture: 'front', failFirstPoseModel: true, seconds: 15, faults: ['first_GPU_initialization_model_fetch_HTTP_503'] },
  { id: 'main-thread-fallback', fixture: 'front', forceMain: true, lifecycle: true, seconds: 15, faults: ['worker_detector_unavailable'] },
  { id: 'recognizer-unavailable', fixture: 'front', blockModels: true, seconds: 10, faults: ['ONNX_model_HTTP_503'] },
  { id: 'camera-permission-denied', fixture: 'front', denyCamera: true, faults: ['getUserMedia_NotAllowedError'] },
  { id: 'fatal-worker', fixture: 'front', fatalWorker: true, seconds: 5, faults: ['uncaught_worker_exception'] },
];
try {
  const servedManifest = await fetch(new URL('/api/brain/sport-packs/squash/manifest', base));
  assert.equal(servedManifest.status, 200, 'Verified squash manifest must be served');
  assert.deepEqual(await servedManifest.json(), json(path.join(packRoot, 'squash/manifest.json')), 'Served pack must match the pinned pack directory');
  const servedTrust = await fetch(new URL('/pack-trust.json', base));
  assert.equal(servedTrust.status, 200, 'Build trust metadata must be served');
  assert.deepEqual(await servedTrust.json(), report.build_trust, 'Served trust metadata must match this build');
  assert.deepEqual(report.build_trust, json('apps/frontend/src/lib/brain/pack-trust.generated.json'), 'Public and imported build trust metadata must agree');
  report.pack_preflight = { status: 'passed', signature: json(path.join(packRoot, 'squash/manifest.json')).signature.algorithm,
    trust_mode: report.build_trust.mode, registry_sha256: report.build_trust.registry_sha256 };
  report.planned_cases = cases.filter((c) => !only.length || only.includes(c.id)).map((c) => c.id);
  if (only.length && only.some((id) => !cases.some((c) => c.id === id))) throw new Error('Unknown --only case');
  for (const spec of cases) if (!only.length || only.includes(spec.id)) await runCase(spec);
  for (const [p, digest] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(p)), digest, `Pinned input changed during validation: ${p}`);
  report.status = report.cases.length && report.cases.every((c) => c.status === 'passed') ? 'passed' : 'failed';
} catch (e) { report.status = 'failed'; report.error = e.stack ?? String(e); }
report.finished_at = new Date().toISOString(); save();
console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({ id, status, checks }) => ({ id, status, checks: checks.length })), report: out }));
if (report.status !== 'passed') process.exitCode = 1;
