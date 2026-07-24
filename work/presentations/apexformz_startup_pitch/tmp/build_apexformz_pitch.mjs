import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../../..");
const finalPptx = path.join(projectRoot, "outputs", "Apexformz_startup_pitch.pptx");
const previewDir = path.join(__dirname, "preview");
const layoutDir = path.join(__dirname, "layout");
const montagePath = path.join(__dirname, "apexformz_startup_pitch_montage.webp");
const sourceNotesPath = path.join(__dirname, "source-notes.txt");

const C = {
  bg: "#FFFFFF",
  ink: "#000000",
  deep: "#0A0F1E",
  muted: "#5F6673",
  faint: "#F2F2F2",
  panel: "#EDEDED",
  rule: "#B8BCC4",
  cyan: "#00D4FF",
  green: "#00FF88",
  blue: "#3D8DFF",
  red: "#FF4757",
};

const font = "Helvetica Neue";

const assets = {
  cricket: path.join(projectRoot, "apps", "frontend", "public", "postures", "cricket_cover_drive.png"),
  tennis: path.join(projectRoot, "apps", "frontend", "public", "postures", "tennis_serve_trophy.png"),
  squat: path.join(projectRoot, "apps", "frontend", "public", "postures", "yoga_squats.png"),
};

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(await blob.arrayBuffer()));
}

async function readImageBuffer(filePath) {
  const bytes = await fs.readFile(filePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addText(slide, text, x, y, w, h, options = {}) {
  const shape = slide.shapes.add({
    geometry: "rect",
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    fontSize: options.size ?? 20,
    typeface: options.face ?? font,
    bold: options.bold ?? false,
    color: options.color ?? C.ink,
    alignment: options.align ?? "left",
    verticalAlignment: options.valign ?? "top",
    autoFit: options.autoFit ?? "shrinkText",
    wrap: "square",
    insets: options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function addPanel(slide, x, y, w, h, options = {}) {
  return slide.shapes.add({
    geometry: options.geometry ?? "roundRect",
    position: { left: x, top: y, width: w, height: h },
    fill: options.fill ?? C.faint,
    line: options.line ?? { style: "solid", fill: options.stroke ?? "none", width: options.stroke ? 1 : 0 },
  });
}

function addRule(slide, x, y, w, options = {}) {
  return slide.shapes.add({
    geometry: "rect",
    position: { left: x, top: y, width: w, height: options.height ?? 1 },
    fill: options.fill ?? C.rule,
    line: { style: "solid", fill: "none", width: 0 },
  });
}

function addFooter(slide, n) {
  addText(slide, "APEXFORMZ", 41, 662, 180, 22, { size: 12, bold: true, color: C.muted });
  addText(slide, String(n).padStart(2, "0"), 1178, 662, 60, 22, { size: 12, color: C.muted, align: "right" });
}

function addTitle(slide, title, n) {
  addText(slide, title, 41, 35, 1198, 88, { size: 42, color: C.ink });
  addFooter(slide, n);
}

function addSourceNotes(slide, lines) {
  slide.speakerNotes.textFrame.setText([
    "[Sources]",
    ...lines,
  ]);
}

async function addImage(slide, imagePath, x, y, w, h, alt, fit = "cover") {
  slide.images.add({
    blob: await readImageBuffer(imagePath),
    contentType: "image/png",
    alt,
    fit,
    position: { left: x, top: y, width: w, height: h },
    geometry: "roundRect",
    borderRadius: "rounded-xl",
  });
}

function addStage(slide, index, label, body, x, y, w, h, accent = C.cyan) {
  addPanel(slide, x, y, w, h, { fill: C.faint });
  addText(slide, String(index).padStart(2, "0"), x + 20, y + 20, 55, 36, { size: 24, bold: true, color: accent });
  addText(slide, label, x + 80, y + 22, w - 100, 34, { size: 24, bold: true, color: C.ink });
  addText(slide, body, x + 20, y + 75, w - 40, h - 95, { size: 18, color: C.muted });
}

function addMetric(slide, value, label, x, y, w, h, color = C.cyan) {
  addPanel(slide, x, y, w, h, { fill: C.faint });
  addText(slide, value, x + 28, y + 40, w - 56, 78, { size: 54, bold: true, color });
  addText(slide, label, x + 28, y + 130, w - 56, 68, { size: 18, color: C.deep });
}

async function slide1(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addText(slide, "APEXFORMZ", 41, 40, 360, 52, { size: 34, bold: true, color: C.ink });
  addText(slide, "AI form coaching that works wherever an athlete trains", 41, 178, 615, 250, { size: 58, color: C.ink });
  addText(slide, "A startup pitch for browser-based technique intelligence, real-time feedback, and habit-forming practice.", 44, 506, 570, 90, { size: 24, color: C.muted });
  addRule(slide, 44, 622, 310, { fill: C.cyan, height: 4 });
  addText(slide, "Pitch deck | July 2026", 44, 642, 280, 28, { size: 16, color: C.muted });
  addPanel(slide, 700, 42, 538, 588, { fill: "#EAF5FB", stroke: C.rule });
  await addImage(slide, assets.cricket, 700, 42, 538, 588, "Apexformz cricket technique blueprint", "cover");
  addSourceNotes(slide, [
    "Project README describes SmartCoach as an AI-powered sports training platform with real-time pose estimation.",
    "Visual asset: apps/frontend/public/postures/cricket_cover_drive.png.",
  ]);
}

function slide2(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "Technique coaching still happens too late for most athletes", 2);
  addText(slide, "Athletes practice far more often than they are observed by a trained coach. The result is delayed correction, uneven quality, and weak follow-through between formal sessions.", 41, 150, 740, 120, { size: 24, color: C.deep });
  addStage(slide, 1, "Access gap", "Quality coaching is scarce, scheduled, and expensive for everyday athletes.", 41, 330, 355, 210, C.cyan);
  addStage(slide, 2, "Feedback gap", "Most form errors are noticed after the rep, not at the moment they happen.", 462, 330, 355, 210, C.blue);
  addStage(slide, 3, "Adherence gap", "Progress is hard to sustain when practice does not feel measurable.", 883, 330, 355, 210, C.green);
  addSourceNotes(slide, [
    "Problem framing inferred from implemented product capabilities: real-time analysis, feedback, saved sessions, XP, streaks, and social circles.",
    "Primary repo references: README.md; apps/frontend/src/app/page.tsx; apps/backend/prisma/schema.prisma.",
  ]);
}

function slide3(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "Apexformz turns a phone camera into a live form coach", 3);
  addText(slide, "The product converts ordinary video into coachable posture data, then returns concise corrections while the athlete is still moving.", 41, 142, 760, 82, { size: 24, color: C.deep });
  const y = 300;
  const w = 260;
  const gap = 38;
  addStage(slide, 1, "Capture", "Browser AI reads pose, hand, and face landmarks on the athlete device.", 41, y, w, 210, C.cyan);
  addStage(slide, 2, "Analyze", "A rules engine compares joint angles, phase timing, and kinetic sequence.", 41 + (w + gap), y, w, 210, C.blue);
  addStage(slide, 3, "Coach", "The app shows score, priority issues, and voice guidance without waiting for a trainer.", 41 + 2 * (w + gap), y, w, 210, C.green);
  addStage(slide, 4, "Retain", "Sessions become progress, XP, streaks, achievements, and circle motivation.", 41 + 3 * (w + gap), y, w, 210, C.red);
  addSourceNotes(slide, [
    "Frontend training loop: apps/frontend/src/app/train/[sport]/page.tsx.",
    "Pose capture: apps/frontend/src/hooks/useHolisticDetection.ts.",
    "Voice coaching: apps/frontend/src/hooks/useVoiceCoaching.ts.",
    "Backend session persistence: apps/backend/src/routes/sessions.ts.",
  ]);
}

async function slide4(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "The MVP already covers a multi-sport coaching surface", 4);
  addText(slide, "Apexformz is not a single-pose demo. The repository contains a multi-service product, sport-specific posture libraries, and dynamic movement definitions.", 41, 127, 840, 90, { size: 23, color: C.deep });
  addMetric(slide, "6", "sports supported: cricket, tennis, yoga, running, boxing, and football", 41, 300, 360, 245, C.cyan);
  addMetric(slide, "60", "static pose blueprints for frame-by-frame form comparison", 460, 300, 360, 245, C.blue);
  addMetric(slide, "12", "dynamic movement blueprints for multi-phase skill analysis", 879, 300, 360, 245, C.green);
  addSourceNotes(slide, [
    "Counts computed from apps/ai-service/app/data/reference_poses.json and apps/ai-service/app/data/reference_movements.json.",
    "Sport selection UI: apps/frontend/src/app/dashboard/page.tsx and apps/frontend/src/app/train/[sport]/setup/page.tsx.",
  ]);
}

async function slide5(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "The athlete sees scored correction during the rep", 5);
  addText(slide, "The live training page combines camera view, skeleton overlay, score ring, high-priority corrections, target posture, and voice prompts into one coaching loop.", 41, 150, 560, 150, { size: 24, color: C.deep });
  await addImage(slide, assets.tennis, 740, 132, 498, 498, "Apexformz tennis serve technical blueprint", "cover");
  addStage(slide, 1, "Prioritized issues", "Only medium and high severity corrections are surfaced to avoid overwhelming the athlete.", 41, 350, 260, 155, C.red);
  addStage(slide, 2, "Voice cueing", "Speech guidance is throttled and sequential so the user hears one actionable fix at a time.", 332, 350, 260, 155, C.cyan);
  addSourceNotes(slide, [
    "Live session UI: apps/frontend/src/app/train/[sport]/page.tsx.",
    "Feedback UI: apps/frontend/src/components/ActionableFeedback.tsx.",
    "Voice logic: apps/frontend/src/hooks/useVoiceCoaching.ts.",
    "Visual asset: apps/frontend/public/postures/tennis_serve_trophy.png.",
  ]);
}

function slide6(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "The architecture separates fast perception from coaching logic", 6);
  addText(slide, "Video frames stay local. The system streams abstract keypoints through a WebSocket relay to a dedicated AI service, then persists sessions and frame evidence for progress tracking.", 41, 132, 790, 96, { size: 23, color: C.deep });

  const y = 305;
  const boxes = [
    ["Browser", "MediaPipe Holistic detects pose, hands, and face; frames are downscaled for speed."],
    ["Relay", "Socket.IO authenticates sessions and forwards keypoints to the AI service."],
    ["AI service", "FastAPI analyzers return score, severity, joint angles, and coaching issues."],
    ["Database", "PostgreSQL stores sessions, frames, XP, streaks, circles, and leaderboards."],
  ];
  boxes.forEach(([label, body], i) => {
    const x = 41 + i * 300;
    addPanel(slide, x, y, 250, 205, { fill: C.faint });
    addText(slide, label, x + 20, y + 24, 210, 36, { size: 24, bold: true, color: i === 2 ? C.blue : C.ink });
    addText(slide, body, x + 20, y + 76, 210, 100, { size: 16, color: C.muted });
    if (i < boxes.length - 1) {
      addRule(slide, x + 258, y + 101, 34, { fill: C.cyan, height: 3 });
      addText(slide, ">", x + 282, y + 90, 20, 30, { size: 20, bold: true, color: C.cyan });
    }
  });
  addSourceNotes(slide, [
    "Architecture summary: README.md and docker-compose.yml.",
    "Browser perception: apps/frontend/src/hooks/useHolisticDetection.ts.",
    "WebSocket relay: apps/backend/src/websocket/sessionRelay.ts.",
    "AI service: apps/ai-service/main.py and apps/ai-service/app/routes/analysis.py.",
    "Persistence model: apps/backend/prisma/schema.prisma.",
  ]);
}

async function slide7(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "Dynamic analysis is the start of the moat", 7);
  addText(slide, "Static angle checks tell athletes what a position looks like. Dynamic analysis evaluates whether the movement sequence is actually being performed well.", 41, 130, 640, 92, { size: 23, color: C.deep });
  await addImage(slide, assets.squat, 742, 98, 496, 430, "Apexformz yoga squat dynamic movement blueprint", "cover");
  addStage(slide, 1, "Phase detection", "A finite-state machine tracks stance, load, impact, follow-through, or cycle stages.", 41, 290, 205, 180, C.cyan);
  addStage(slide, 2, "Kinetic chain", "The engine checks whether hips, shoulders, and arms fire in the expected order.", 268, 290, 205, 180, C.blue);
  addStage(slide, 3, "Fluidity score", "Motion smoothness is estimated from changing angular velocities over time.", 495, 290, 205, 180, C.green);
  addText(slide, "This shifts Apexformz from pose matching toward sport-specific movement intelligence.", 44, 552, 645, 58, { size: 24, bold: true, color: C.ink });
  addSourceNotes(slide, [
    "Dynamic analyzer: apps/ai-service/app/services/dynamic/dynamic_analyzer.py.",
    "Phase detector: apps/ai-service/app/services/dynamic/phase_detector.py.",
    "Kinetic chain validator: apps/ai-service/app/services/dynamic/kinetic_chain.py.",
    "Visual asset: apps/frontend/public/postures/yoga_squats.png.",
  ]);
}

function slide8(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "Apexformz turns practice into retained behavior", 8);
  addText(slide, "The product does not stop at correction. It uses progress mechanics and small-group accountability to make training measurable, repeatable, and social.", 41, 132, 840, 90, { size: 23, color: C.deep });
  const items = [
    ["XP and levels", "Session duration and score convert into XP, levels, and visible progression."],
    ["Achievements", "Milestones reward first sessions, streaks, perfect scores, and volume."],
    ["Validated streaks", "Streaks count only when duration and sport-specific quality thresholds are met."],
    ["Training circles", "Shared streaks, health scores, roles, and nudges create peer accountability."],
  ];
  items.forEach(([label, body], i) => {
    const x = i % 2 === 0 ? 41 : 657;
    const y = i < 2 ? 280 : 468;
    addPanel(slide, x, y, 581, 132, { fill: C.faint });
    addText(slide, label, x + 24, y + 24, 250, 30, { size: 24, bold: true, color: i === 3 ? C.green : C.ink });
    addText(slide, body, x + 24, y + 64, 520, 48, { size: 17, color: C.muted });
  });
  addSourceNotes(slide, [
    "Gamification engine: apps/backend/src/utils/gamification.ts.",
    "Enhanced streak logic: apps/backend/src/services/streak.service.ts.",
    "Circle logic: apps/backend/src/services/circle.service.ts; apps/backend/src/routes/circles.ts.",
    "Dashboard UI: apps/frontend/src/app/dashboard/page.tsx.",
  ]);
}

function slide9(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "The wedge is coaching between formal sessions", 9);
  addText(slide, "Apexformz can enter where athletes already practice alone, then expand into coach-led programs once the data trail proves improvement.", 41, 132, 840, 92, { size: 23, color: C.deep });
  const lanes = [
    ["Individual athletes", "Home practice for cricket, tennis, yoga, running, boxing, and football learners who need immediate form feedback."],
    ["Academies and clubs", "Coach dashboards can convert session histories into between-practice assignments and measurable development plans."],
    ["Wellness and fitness", "Static poses, squats, planks, gait, and posture routines create an entry point outside competitive sport."],
  ];
  lanes.forEach(([label, body], i) => {
    const x = 41 + i * 411;
    addPanel(slide, x, 300, 375, 285, { fill: C.faint });
    addText(slide, label, x + 26, 332, 320, 42, { size: 26, bold: true, color: C.ink });
    addText(slide, body, x + 26, 398, 315, 126, { size: 18, color: C.muted });
    addRule(slide, x + 26, 548, 130, { fill: i === 0 ? C.cyan : i === 1 ? C.blue : C.green, height: 4 });
  });
  addSourceNotes(slide, [
    "Customer wedge inferred from repository-supported sport coverage, posture library, saved sessions, and circle/social mechanics.",
    "Repo references: apps/frontend/src/app/train/[sport]/setup/page.tsx; apps/backend/prisma/schema.prisma.",
  ]);
}

function slide10(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addTitle(slide, "Revenue can scale from users to teams to infrastructure", 10);
  addText(slide, "The same coaching engine can support direct subscriptions, coach-managed deployments, and eventually biomechanics APIs or white-label integrations.", 41, 130, 870, 82, { size: 23, color: C.deep });
  const models = [
    ["Athlete app", "Freemium onboarding, paid unlimited analysis, sport packs, and advanced training history."],
    ["Academy toolkit", "Coach seats, team rosters, assigned drills, progress review, and circle-based accountability."],
    ["Motion intelligence API", "Scoring, pose blueprint, dynamic phase, and kinetic-chain services for partners."],
  ];
  models.forEach(([label, body], i) => {
    const x = 41 + i * 411;
    addPanel(slide, x, 260, 375, 300, { fill: C.faint });
    addText(slide, label, x + 26, 298, 320, 42, { size: 26, bold: true, color: i === 2 ? C.blue : C.ink });
    addText(slide, body, x + 26, 370, 315, 118, { size: 18, color: C.muted });
    addText(slide, i === 0 ? "B2C" : i === 1 ? "B2B" : "Platform", x + 26, 505, 160, 34, { size: 20, bold: true, color: i === 0 ? C.cyan : i === 1 ? C.green : C.blue });
  });
  addSourceNotes(slide, [
    "Business model is a recommended pitch framing inferred from the implemented user app, session data model, circle model, and AI service architecture.",
    "No external pricing or revenue claims are used.",
  ]);
}

function slide11(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addText(slide, "APEXFORMZ", 41, 40, 260, 50, { size: 34, bold: true, color: C.ink });
  addText(slide, "Funding now turns the MVP into a defensible coaching platform", 41, 172, 760, 155, { size: 50, color: C.ink });
  addText(slide, "Near-term capital should harden reliability, validate paid demand with pilots, and expand the movement intelligence library.", 44, 370, 665, 72, { size: 24, color: C.muted });
  const asks = [
    ["Product validation", "Run structured pilots with academies and committed individual athletes."],
    ["Technical depth", "Hire computer-vision, biomechanics, and product engineering capacity."],
    ["Data advantage", "Build consented movement datasets and coach-reviewed scoring standards."],
    ["Commercial launch", "Package athlete, academy, and partner offerings with clear retention metrics."],
  ];
  asks.forEach(([label, body], i) => {
    const y = 118 + i * 116;
    addPanel(slide, 820, y, 418, 82, { fill: C.faint });
    addText(slide, label, 844, y + 16, 210, 28, { size: 22, bold: true, color: i === 2 ? C.blue : C.ink });
    addText(slide, body, 844, y + 47, 350, 24, { size: 15, color: C.muted });
  });
  addRule(slide, 44, 504, 330, { fill: C.cyan, height: 4 });
  addText(slide, "Seeking seed capital and pilot partners", 44, 532, 470, 40, { size: 24, bold: true, color: C.ink });
  addText(slide, "Apexformz | AI technique coaching", 44, 640, 400, 28, { size: 16, color: C.muted });
  addSourceNotes(slide, [
    "Roadmap and ask are pitch recommendations based on current MVP capabilities observed in the repository.",
    "No funding amount, revenue, or user traction is asserted because the repository does not contain those metrics.",
  ]);
}

async function main() {
  await fs.mkdir(path.dirname(finalPptx), { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  await fs.mkdir(layoutDir, { recursive: true });

  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

  await slide1(presentation);
  slide2(presentation);
  slide3(presentation);
  await slide4(presentation);
  await slide5(presentation);
  slide6(presentation);
  await slide7(presentation);
  slide8(presentation);
  slide9(presentation);
  slide10(presentation);
  slide11(presentation);

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(path.join(previewDir, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(layoutDir, `${stem}.layout.json`), await layout.text(), "utf8");
  }

  await writeBlob(montagePath, await presentation.export({ format: "webp", montage: true, scale: 1 }));

  await fs.writeFile(sourceNotesPath, [
    "Apexformz startup pitch deck source notes",
    "",
    "This deck uses only repository-derived claims and internal project visual assets.",
    "No external market-size, revenue, user traction, or clinical performance claims are included.",
    "",
    "Core sources:",
    "- README.md",
    "- package.json",
    "- docker-compose.yml",
    "- apps/frontend/src/app/page.tsx",
    "- apps/frontend/src/app/dashboard/page.tsx",
    "- apps/frontend/src/app/train/[sport]/page.tsx",
    "- apps/frontend/src/app/train/[sport]/setup/page.tsx",
    "- apps/frontend/src/hooks/useHolisticDetection.ts",
    "- apps/frontend/src/hooks/useWebSocket.ts",
    "- apps/frontend/src/hooks/useVoiceCoaching.ts",
    "- apps/frontend/src/components/ActionableFeedback.tsx",
    "- apps/frontend/src/components/PoseSkeleton.tsx",
    "- apps/backend/src/index.ts",
    "- apps/backend/src/websocket/sessionRelay.ts",
    "- apps/backend/src/routes/sessions.ts",
    "- apps/backend/src/utils/gamification.ts",
    "- apps/backend/src/services/streak.service.ts",
    "- apps/backend/src/services/circle.service.ts",
    "- apps/backend/prisma/schema.prisma",
    "- apps/ai-service/main.py",
    "- apps/ai-service/app/routes/analysis.py",
    "- apps/ai-service/app/services/pose_analyzer.py",
    "- apps/ai-service/app/services/analyzers/base.py",
    "- apps/ai-service/app/services/analyzers/registry.py",
    "- apps/ai-service/app/services/analyzers/squat.py",
    "- apps/ai-service/app/services/analyzers/plank.py",
    "- apps/ai-service/app/services/dynamic/dynamic_analyzer.py",
    "- apps/ai-service/app/services/dynamic/phase_detector.py",
    "- apps/ai-service/app/services/dynamic/kinetic_chain.py",
    "- apps/ai-service/app/data/reference_poses.json",
    "- apps/ai-service/app/data/reference_movements.json",
    "- apps/frontend/public/postures/*.png",
  ].join("\n"), "utf8");

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(finalPptx);
  console.log(JSON.stringify({ finalPptx, previewDir, layoutDir, montagePath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
