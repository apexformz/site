# Apexformz frontend

Next.js 14 / React 18 interface for Apexformz. Run commands from the repository root:

```sh
npm run dev --workspace=apps/frontend
npm run build --workspace=apps/frontend
npm run start --workspace=apps/frontend
```

The frontend uses `NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api`). Authenticated training requires the backend and AI services described in the root README. Experimental Squash coaching is supported across the frontend, backend validators/session relay, shared types, and AI position analysis.

## Interface system

The original ApexFormz blue identity is paired with spacious Manrope typography, rounded material surfaces, and sculpted visual depth. Day mode uses pearl surfaces; night mode uses softer slate surfaces. Shared RGB design tokens live in `src/styles/globals.css` and `tailwind.config.ts`, including semantic foreground, muted, surface, border, and accent colors. `AppShell` provides athlete navigation; `Brand`, `LoadingScreen`, and `MotionProvider` provide shared identity, loading, and reduced-motion behavior.

`ThemeProvider` and `ThemeToggle` support day/night switching, local persistence under `apexformz-theme`, and cross-tab synchronization. A small pre-paint script applies the saved theme before hydration. Day mode is the default. The camera viewport stays dark in both themes for readable tracking overlays.

The hero uses the textured model at `public/models/apex-athlete-reference.glb`, reconstructed from the user's supplied athlete picture through the explicitly approved TRELLIS service. `ReferenceAthleteModel.tsx` renders the actual 3D geometry, preserving the running pose and pearl/cobalt appearance with smooth normals and soft lighting. Its gentle spatial loop and pointer response move the posed model; this asset does not have a skeleton or a limb animation rig. Unseen surfaces and small details are inferred from the single image. The exact supplied PNG at `public/images/apex-athlete-reference.png` is used while loading and if WebGL is unavailable.

Three.js loads only when the scene approaches the viewport. Animation pauses offscreen or in a hidden tab, respects reduced motion, and disposes its resources on navigation. The pause control freezes the pose and pointer response. Captions stay in their own row below the model. Asset provenance and conversion settings are in `../../assets/apex-athlete-reference.json`. The original logo remains at `public/logo.png`.

The interface is a multi-page application. Home explains the product, first-session journey, coaching/progress/circle features, technology, and common questions. `/sports` provides the searchable library and sport-specific context; `/technology` explains tracking, analysis, data handling, and limitations through an interactive coaching diagram. Athlete workspaces have dedicated `/dashboard`, `/profile`, and `/circles` pages, alongside circle details, movement setup, training, and results routes. Public pages share an expanded footer; account pages include relevant guidance.

The existing Framer Motion dependency powers shared-layout tabs, sport filtering, score rings, scroll reveals, accessible accordions, and interactive illustrations. References considered: [Motion layout animations](https://motion.dev/docs/react-layout-animations), [Kokonut smooth tabs](https://kokonutui.com/docs/navigation/smooth-tab), [21st](https://21st.dev/), [Prompt Motion](https://prompt-motion.com/), [Originkit](https://www.originkit.dev/), and [Watermelon UI](https://ui.watermelon.sh/animated-components). The implementation uses original project components; Three.js renders the actual textured 3D asset.

The public sport order begins Squash, Taekwondo, Yoga. Football is removed from discovery and new-account choices; historical Football records remain readable. Squash offers ready stance, forehand volley preparation, and backhand volley preparation. Its app-authored angle guides are experimental and are not a trained or validated Squash model. They do not assess ball/racket movement, grip, or a complete stroke. Reference provenance is in `../ai-service/app/data/squash_reference_notes.json`.

The palette and design references are documented in `../../assets/apex-redesign.json`.

## Browser verification

With the production frontend running on port 3000:

```sh
node scripts/ui-smoke.cjs
```

Run that command from the repository root. The script resolves a local Playwright installation or the bundled Codex runtime. Set `PLAYWRIGHT_MODULE` to another installed Playwright module path if needed. It uses installed Google Chrome; `UI_BASE_URL` overrides the local URL.

The checks cover desktop, 390px mobile, and 320px layouts; day/night rendering and persistence; navigation and filters; auth validation/pending/error flows; modal focus; empty/error states; reduced motion; and denied camera access. API responses, socket connections, and camera denial are fixtures confined to the test script. No real accounts or training sessions are created. Live pose inference and backend integration require a separate test with running services and a real camera.

Screenshots and the JSON report are written to `outputs/ui-review-v4/` in the repository root. The updated checks also cover the WebGL scene/caption layout, marketing tabs and FAQs, the interactive technology flow, and Squash discovery and movement selection. Separate analysis/API checks exercise the experimental Squash path with synthetic landmarks and mocked persistence; real camera quality still requires an athlete session with running services.

`node scripts/model-smoke.cjs` checks the reference GLB checksum, spatial animation, exact paused frames, offscreen/hidden-tab behavior, reduced motion, mobile day/night framing, and both context-loss and failed-download fallbacks. It also verifies that the fallback PNG is the unaltered user-supplied image. Its screenshots and report are saved to `outputs/reference-athlete/ui-checks/`.
