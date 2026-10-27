'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  BufferGeometry,
  Group,
  Material,
  OrthographicCamera,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

export interface AthleteModelProps {
  /** Pauses the actual joint animation, without resetting the current pose. */
  playing?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Rendered while loading and whenever WebGL is unavailable. Set null to supply your own fallback. */
  fallbackSrc?: string | null;
  ariaLabel?: string;
  onReady?: () => void;
  onUnavailable?: (error: Error) => void;
}

type ModelState = 'idle' | 'loading' | 'ready' | 'unavailable';
type Limb = { pivot: Group; bend: Group; end: Group; contact?: Group };

/** Periodic Catmull–Rom curves keep the joint velocities continuous at each stride. */
function cycleValue(values: readonly number[], phase: number) {
  const position = (((phase % 1) + 1) % 1) * values.length;
  const index = Math.floor(position);
  const t = position - index;
  const value = (offset: number) =>
    values[(index + offset + values.length) % values.length];
  const p0 = value(-1),
    p1 = value(0),
    p2 = value(1),
    p3 = value(2);
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/**
 * A real, articulated WebGL athlete. It fills its parent's explicit width/height;
 * an orthographic camera fits the complete stride envelope at every aspect ratio.
 */
export function AthleteModel({
  playing = true,
  className = '',
  style,
  fallbackSrc = '/images/apex-motion-sculpture.webp',
  ariaLabel = 'A three-dimensional athlete in a running pose.',
  onReady,
  onUnavailable,
}: AthleteModelProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onReady, onUnavailable });
  const playingRef = useRef(playing);
  const controllerRef = useRef<{ refresh: () => void } | null>(null);
  const [state, setState] = useState<ModelState>('idle');

  useEffect(() => {
    callbacksRef.current = { onReady, onUnavailable };
  }, [onReady, onUnavailable]);
  useEffect(() => {
    playingRef.current = playing;
    controllerRef.current?.refresh();
  }, [playing]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const host = canvasHostRef.current;
    if (!wrapper || !host) return;

    let disposed = false;
    let failed = false;
    let initialising = false;
    let visible = false;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 1.4 * 0.78;
    let renderer: WebGLRenderer | undefined;
    let scene: Scene | undefined;
    let camera: OrthographicCamera | undefined;
    let stage: Group | undefined;
    let environment: WebGLRenderTarget | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let renderPose: ((phase: number) => void) | undefined;
    let fitCamera: (() => void) | undefined;
    let frameReady = false;
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery.matches;
    const pointer = { x: 0, y: 0, currentX: 0, currentY: 0 };

    const cancelFrame = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
    };

    const disposeGraphics = () => {
      cancelFrame();
      frameReady = false;
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      if (renderer) {
        renderer.domElement.removeEventListener(
          'webglcontextlost',
          onContextLost,
        );
      }
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      geometries.clear();
      materials.clear();
      textures.clear();
      environment?.dispose();
      environment = undefined;
      scene?.clear();
      if (renderer) {
        renderer.renderLists.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        renderer = undefined;
      }
    };

    const unavailable = (reason: unknown) => {
      if (disposed || failed) return;
      failed = true;
      disposeGraphics();
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      setState('unavailable');
      callbacksRef.current.onUnavailable?.(error);
    };

    function onContextLost(event: Event) {
      event.preventDefault();
      unavailable(new Error('The 3D graphics context was lost.'));
    }

    const canAnimate = () =>
      frameReady &&
      visible &&
      !document.hidden &&
      playingRef.current &&
      !reducedMotion;

    const draw = () => {
      if (!renderer || !scene || !camera || disposed || failed) return;
      try {
        renderer.render(scene, camera);
      } catch (error) {
        unavailable(error);
      }
    };

    const tick = (now: number) => {
      frame = 0;
      if (!canAnimate() || disposed || failed) return;
      const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0;
      lastFrame = now;
      elapsed += delta;
      renderPose?.(elapsed / 1.4);
      const ease = 1 - Math.exp(-delta * 5);
      pointer.currentX += (pointer.x - pointer.currentX) * ease;
      pointer.currentY += (pointer.y - pointer.currentY) * ease;
      if (stage) {
        stage.rotation.y = 0.18 + pointer.currentX * 0.13;
        stage.rotation.x = pointer.currentY * 0.035;
      }
      draw();
      if (canAnimate() && !failed) frame = requestAnimationFrame(tick);
    };

    const refresh = () => {
      cancelFrame();
      if (!frameReady || disposed || failed) return;
      wrapper.dataset.motion = reducedMotion
        ? 'reduced'
        : canAnimate()
          ? 'playing'
          : 'paused';
      if (!visible || document.hidden) return;
      if (reducedMotion) {
        renderPose?.(0.78);
        if (stage) stage.rotation.set(0, 0.18, 0);
      }
      draw();
      if (canAnimate()) frame = requestAnimationFrame(tick);
    };
    controllerRef.current = { refresh };

    const onVisibility = () => refresh();
    const onMotionChange = () => {
      reducedMotion = motionQuery.matches;
      pointer.x = pointer.y = pointer.currentX = pointer.currentY = 0;
      refresh();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion || !playingRef.current || event.pointerType === 'touch')
        return;
      const rect = wrapper.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.x = Math.max(
        -1,
        Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2),
      );
      pointer.y = Math.max(
        -1,
        Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2),
      );
    };
    const onPointerLeave = () => {
      pointer.x = pointer.y = 0;
    };
    document.addEventListener('visibilitychange', onVisibility);
    motionQuery.addEventListener('change', onMotionChange);
    wrapper.addEventListener('pointermove', onPointerMove, { passive: true });
    wrapper.addEventListener('pointerleave', onPointerLeave, { passive: true });

    const initialise = async () => {
      if (initialising || disposed || failed) return;
      initialising = true;
      setState('loading');
      try {
        // The WebGL engine and its reflection environment load only on intersection.
        const [THREE, { RoomEnvironment }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/environments/RoomEnvironment.js'),
        ]);
        if (disposed || failed) return;

        renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: true,
          powerPreference: 'default',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1;
        renderer.domElement.setAttribute('aria-hidden', 'true');
        renderer.domElement.style.cssText =
          'display:block;width:100%;height:100%;opacity:0;';
        renderer.domElement.addEventListener('webglcontextlost', onContextLost);
        host.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 40);
        camera.position.set(-6, 2.8, 8);
        camera.lookAt(0, 0.1, 0);

        const room = new RoomEnvironment();
        const pmrem = new THREE.PMREMGenerator(renderer);
        try {
          environment = pmrem.fromScene(room, 0.035);
          scene.environment = environment.texture;
          scene.environmentIntensity = 0.7;
        } finally {
          room.dispose();
          pmrem.dispose();
        }
        scene.add(new THREE.HemisphereLight(0xdfefff, 0x384c71, 1));
        const key = new THREE.DirectionalLight(0xf5f8ff, 2.4);
        key.position.set(-3, 6, 5);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x5797ff, 2.7);
        rim.position.set(4, 2, -4);
        scene.add(rim);
        const fill = new THREE.DirectionalLight(0xffffff, 0.7);
        fill.position.set(3, 0.5, 5);
        scene.add(fill);

        const ownGeometry = <T extends BufferGeometry>(geometry: T): T => {
          geometries.add(geometry);
          return geometry;
        };
        const ownMaterial = <T extends Material>(material: T): T => {
          materials.add(material);
          return material;
        };
        const pearl = ownMaterial(
          new THREE.MeshPhysicalMaterial({
            color: 0xd9e7fa,
            metalness: 0.27,
            roughness: 0.24,
            clearcoat: 1,
            clearcoatRoughness: 0.16,
          }),
        );
        const porcelain = ownMaterial(
          new THREE.MeshPhysicalMaterial({
            color: 0xf0f6ff,
            metalness: 0.2,
            roughness: 0.22,
            clearcoat: 1,
            clearcoatRoughness: 0.13,
          }),
        );
        const cobalt = ownMaterial(
          new THREE.MeshPhysicalMaterial({
            color: 0x1556d5,
            metalness: 0.62,
            roughness: 0.23,
            clearcoat: 1,
            clearcoatRoughness: 0.12,
          }),
        );
        const azure = ownMaterial(
          new THREE.MeshPhysicalMaterial({
            color: 0x5aabff,
            metalness: 0.45,
            roughness: 0.24,
            clearcoat: 1,
            emissive: 0x164998,
            emissiveIntensity: 0.1,
          }),
        );
        const sphere = ownGeometry(new THREE.SphereGeometry(1, 36, 24));

        const ellipsoid = (
          parent: Group,
          material: Material,
          scale: [number, number, number],
          position: [number, number, number],
        ) => {
          const mesh = new THREE.Mesh(sphere, material);
          mesh.scale.set(...scale);
          mesh.position.set(...position);
          parent.add(mesh);
          return mesh;
        };

        const tapered = (
          length: number,
          top: number,
          middle: number,
          bottom: number,
          material: Material,
        ) => {
          const points = [
            [0.008, -length],
            [bottom, -length + 0.055],
            [middle * 0.83, -length * 0.68],
            [middle, -length * 0.36],
            [top, -0.07],
            [0.008, 0],
          ].map(([radius, y]) => new THREE.Vector2(radius, y));
          // A smooth spline profile gives the limbs organic muscle volume instead of cylinders.
          const profile = new THREE.SplineCurve(points).getPoints(28);
          profile.forEach((point) => {
            point.x = Math.max(0.008, point.x);
          });
          const mesh = new THREE.Mesh(
            ownGeometry(new THREE.LatheGeometry(profile, 32)),
            material,
          );
          mesh.scale.z = 0.88;
          return mesh;
        };

        const joint = (parent: Group, radius: number, side = 1) => {
          const ball = ellipsoid(
            parent,
            cobalt,
            [radius, radius, radius * 0.94],
            [0, 0, 0],
          );
          const ring = new THREE.Mesh(
            ownGeometry(new THREE.TorusGeometry(radius * 0.79, 0.018, 10, 40)),
            azure,
          );
          ring.rotation.y = Math.PI / 2;
          ring.position.x = side * radius * 0.69;
          parent.add(ring);
          return ball;
        };

        stage = new THREE.Group();
        stage.rotation.y = 0.18;
        scene.add(stage);
        const athlete = new THREE.Group();
        stage.add(athlete);

        // Pelvis and a continuous tapering torso establish an athletic silhouette.
        ellipsoid(athlete, cobalt, [0.39, 0.245, 0.255], [0, 0.09, 0]);
        const torso = new THREE.Group();
        torso.position.y = 0.2;
        athlete.add(torso);
        const torsoProfile = new THREE.SplineCurve([
          new THREE.Vector2(0.33, 0),
          new THREE.Vector2(0.3, 0.12),
          new THREE.Vector2(0.285, 0.4),
          new THREE.Vector2(0.36, 0.68),
          new THREE.Vector2(0.51, 0.91),
          new THREE.Vector2(0.57, 1.13),
          new THREE.Vector2(0.43, 1.31),
          new THREE.Vector2(0.16, 1.43),
        ]).getPoints(40);
        const torsoGeometry = ownGeometry(
          new THREE.LatheGeometry(torsoProfile, 64),
        );
        const torsoPositions = torsoGeometry.attributes.position;
        const torsoColors = new Float32Array(torsoPositions.count * 3);
        const pearlColor = new THREE.Color(0xd9e7fa);
        const cobaltColor = new THREE.Color(0x1556d5);
        const panelColor = new THREE.Color();
        for (let vertex = 0; vertex < torsoPositions.count; vertex++) {
          const x = torsoPositions.getX(vertex);
          const y = torsoPositions.getY(vertex);
          const z = torsoPositions.getZ(vertex);
          const side = Math.abs(x) / Math.max(0.001, Math.hypot(x, z));
          const panel =
            THREE.MathUtils.smoothstep(side, 0.77, 0.88) *
            THREE.MathUtils.smoothstep(y, 0.03, 0.16) *
            (1 - THREE.MathUtils.smoothstep(y, 1.14, 1.28));
          panelColor.copy(pearlColor).lerp(cobaltColor, panel);
          torsoColors[vertex * 3] = panelColor.r;
          torsoColors[vertex * 3 + 1] = panelColor.g;
          torsoColors[vertex * 3 + 2] = panelColor.b;
        }
        torsoGeometry.setAttribute(
          'color',
          new THREE.BufferAttribute(torsoColors, 3),
        );
        const shellMaterial = ownMaterial(pearl.clone());
        shellMaterial.color.set(0xffffff);
        shellMaterial.vertexColors = true;
        const shell = new THREE.Mesh(torsoGeometry, shellMaterial);
        shell.scale.z = 0.59;
        torso.add(shell);
        const neck = new THREE.Mesh(
          ownGeometry(new THREE.CapsuleGeometry(0.115, 0.17, 6, 24)),
          cobalt,
        );
        neck.position.set(0, 1.48, 0);
        torso.add(neck);
        const head = new THREE.Group();
        head.position.set(0, 1.57, 0.025);
        torso.add(head);
        const headGeometry = ownGeometry(new THREE.SphereGeometry(1, 40, 32));
        const headPositions = headGeometry.attributes.position;
        for (let vertex = 0; vertex < headPositions.count; vertex++) {
          const y = headPositions.getY(vertex);
          const jaw = Math.max(0, -y);
          headPositions.setXYZ(
            vertex,
            headPositions.getX(vertex) * (1 - jaw * 0.23),
            y,
            headPositions.getZ(vertex) * (1 - jaw * 0.12) + jaw * 0.12,
          );
        }
        headGeometry.computeVertexNormals();
        const headShell = new THREE.Mesh(headGeometry, porcelain);
        headShell.scale.set(0.24, 0.33, 0.255);
        headShell.position.set(0, 0.27, 0.015);
        head.add(headShell);

        const createArm = (side: number): Limb => {
          const pivot = new THREE.Group();
          pivot.position.set(side * 0.555, 1.17, 0);
          torso.add(pivot);
          joint(pivot, 0.17, side);
          ellipsoid(
            pivot,
            pearl,
            [0.2, 0.23, 0.195],
            [side * 0.018, -0.055, 0],
          );
          pivot.add(tapered(0.73, 0.17, 0.205, 0.115, pearl));
          const bend = new THREE.Group();
          bend.position.y = -0.73;
          pivot.add(bend);
          joint(bend, 0.117, side);
          bend.add(tapered(0.66, 0.108, 0.15, 0.078, cobalt));
          const forearmPlate = ellipsoid(
            bend,
            pearl,
            [0.093, 0.23, 0.07],
            [0, -0.265, 0.105],
          );
          forearmPlate.rotation.x = -0.06;
          const end = new THREE.Group();
          end.position.y = -0.66;
          bend.add(end);
          ellipsoid(end, azure, [0.081, 0.075, 0.08], [0, 0, 0]);
          ellipsoid(end, cobalt, [0.112, 0.155, 0.1], [0, -0.14, 0.025]);
          ellipsoid(end, pearl, [0.102, 0.105, 0.055], [0, -0.13, 0.1]);
          const thumb = ellipsoid(
            end,
            cobalt,
            [0.055, 0.09, 0.06],
            [-side * 0.09, -0.105, 0.07],
          );
          thumb.rotation.z = side * 0.3;
          return { pivot, bend, end };
        };

        const createLeg = (side: number): Limb => {
          const pivot = new THREE.Group();
          pivot.position.set(side * 0.255, 0.015, 0);
          athlete.add(pivot);
          joint(pivot, 0.18, side);
          pivot.add(tapered(1.04, 0.22, 0.265, 0.145, pearl));
          const bend = new THREE.Group();
          bend.position.y = -1.04;
          pivot.add(bend);
          joint(bend, 0.145, side);
          ellipsoid(bend, pearl, [0.13, 0.15, 0.075], [0, -0.015, 0.115]);
          bend.add(tapered(1.01, 0.135, 0.192, 0.078, cobalt));
          ellipsoid(bend, pearl, [0.112, 0.31, 0.075], [0, -0.36, 0.1]);
          const end = new THREE.Group();
          end.position.y = -1.01;
          bend.add(end);
          joint(end, 0.09, side);
          ellipsoid(end, pearl, [0.13, 0.1, 0.265], [0, -0.075, 0.14]);
          ellipsoid(end, cobalt, [0.14, 0.045, 0.28], [0, -0.15, 0.14]);
          const contact = new THREE.Group();
          contact.position.set(0, -0.19, 0.13);
          end.add(contact);
          return { pivot, bend, end, contact };
        };

        const arms = [createArm(-1), createArm(1)];
        const legs = [createLeg(-1), createLeg(1)];
        const groundY = -2.12;
        const contactPositions = [new THREE.Vector3(), new THREE.Vector3()];
        const hips = [-0.55, 0.28, 0.6, -0.84];
        const knees = [0.32, 0.18, 1.8, 1.18];
        const ankles = [0.08, -0.25, 0.12, 0.05];

        renderPose = (phase: number) => {
          const stride = phase * Math.PI * 2;
          athlete.position.y = 0;
          athlete.rotation.z = Math.sin(stride) * 0.025;
          torso.rotation.set(
            0.13,
            Math.sin(stride) * 0.085,
            Math.sin(stride) * -0.035,
          );
          head.rotation.set(-0.11, Math.sin(stride) * -0.04, 0);
          legs.forEach((leg, index) => {
            const offset = phase + index * 0.5;
            const hip = cycleValue(hips, offset);
            leg.pivot.rotation.set(hip, 0, index === 0 ? -0.025 : 0.025);
            leg.bend.rotation.x = Math.max(0.12, cycleValue(knees, offset));
            leg.end.rotation.x = cycleValue(ankles, offset);
            const arm = arms[index];
            arm.pivot.rotation.set(
              -hip * 0.9,
              index === 0 ? 0.1 : -0.1,
              index === 0 ? -0.13 : 0.13,
            );
            arm.bend.rotation.x = -1.35 + Math.sin(offset * Math.PI * 2) * 0.2;
            arm.end.rotation.x = -0.08;
          });
          // Keep the planted foot on the floor while allowing a small flight phase.
          athlete.updateMatrixWorld(true);
          legs.forEach((leg, index) =>
            leg.contact!.getWorldPosition(contactPositions[index]),
          );
          const lowestFoot = Math.min(
            contactPositions[0].y,
            contactPositions[1].y,
          );
          athlete.position.y =
            groundY - lowestFoot + Math.pow(Math.sin(stride * 2), 2) * 0.045;
          athlete.updateMatrixWorld(true);
        };

        // A generated, soft contact shadow adds depth without a background or shadow-map pass.
        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.width = shadowCanvas.height = 128;
        const context = shadowCanvas.getContext('2d');
        if (context) {
          const gradient = context.createRadialGradient(64, 64, 3, 64, 64, 62);
          gradient.addColorStop(0, 'rgba(21,40,74,0.26)');
          gradient.addColorStop(0.45, 'rgba(21,40,74,0.11)');
          gradient.addColorStop(1, 'rgba(21,40,74,0)');
          context.fillStyle = gradient;
          context.fillRect(0, 0, 128, 128);
          const texture = new THREE.CanvasTexture(shadowCanvas);
          textures.add(texture);
          const shadow = new THREE.Mesh(
            ownGeometry(new THREE.PlaneGeometry(3.2, 2.4)),
            ownMaterial(
              new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
                opacity: 0.85,
              }),
            ),
          );
          shadow.rotation.x = -Math.PI / 2;
          shadow.position.y = groundY - 0.025;
          scene.add(shadow);
        }

        // Fit the full movement envelope, not just the first frame, so knees/head never crop.
        const envelope = new THREE.Box3();
        const sampleBox = new THREE.Box3();
        for (let sample = 0; sample < 24; sample++) {
          renderPose(sample / 24);
          stage.updateMatrixWorld(true);
          sampleBox.setFromObject(athlete);
          envelope.union(sampleBox);
        }
        const centre = envelope.getCenter(new THREE.Vector3());
        camera.position.copy(centre).add(new THREE.Vector3(-6, 2.7, 8));
        camera.lookAt(centre);
        camera.updateMatrixWorld(true);
        const viewBox = new THREE.Box3();
        const projectedCorner = new THREE.Vector3();
        const projection = new THREE.Matrix4();
        for (let sample = 0; sample < 24; sample++) {
          renderPose(sample / 24);
          stage.updateMatrixWorld(true);
          athlete.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            object.geometry.computeBoundingBox();
            const bounds = object.geometry.boundingBox;
            if (!bounds) return;
            projection.multiplyMatrices(
              camera!.matrixWorldInverse,
              object.matrixWorld,
            );
            for (const x of [bounds.min.x, bounds.max.x]) {
              for (const y of [bounds.min.y, bounds.max.y]) {
                for (const z of [bounds.min.z, bounds.max.z]) {
                  viewBox.expandByPoint(
                    projectedCorner.set(x, y, z).applyMatrix4(projection),
                  );
                }
              }
            }
          });
        }
        const viewSize = viewBox.getSize(new THREE.Vector3());
        const viewCentre = viewBox.getCenter(new THREE.Vector3());
        fitCamera = () => {
          if (!renderer || !camera || disposed) return;
          const width = Math.max(1, wrapper.clientWidth);
          const height = Math.max(1, wrapper.clientHeight);
          const aspect = width / height;
          const span = Math.max(viewSize.y, viewSize.x / aspect) * 1.1;
          camera.left = viewCentre.x - (span * aspect) / 2;
          camera.right = viewCentre.x + (span * aspect) / 2;
          camera.top = viewCentre.y + span / 2;
          camera.bottom = viewCentre.y - span / 2;
          camera.updateProjectionMatrix();
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
          renderer.setSize(width, height, false);
          if (frameReady && visible && !document.hidden) draw();
        };
        fitCamera();
        renderPose(0.78);
        resizeObserver = new ResizeObserver(() => fitCamera?.());
        resizeObserver.observe(wrapper);
        await renderer.compileAsync(scene, camera);
        if (disposed || failed || !renderer) return;
        if (renderer.getContext().isContextLost())
          throw new Error('WebGL could not initialise the athlete scene.');
        frameReady = true;
        renderer.domElement.style.transition = reducedMotion
          ? 'none'
          : 'opacity 350ms ease';
        renderer.domElement.style.opacity = '1';
        setState('ready');
        callbacksRef.current.onReady?.();
        refresh();
      } catch (error) {
        unavailable(error);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        if (visible && !initialising) void initialise();
        refresh();
      },
      { threshold: 0.01 },
    );
    observer.observe(wrapper);

    return () => {
      disposed = true;
      controllerRef.current = null;
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener('change', onMotionChange);
      wrapper.removeEventListener('pointermove', onPointerMove);
      wrapper.removeEventListener('pointerleave', onPointerLeave);
      disposeGraphics();
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
      data-render-state={state}
      style={{ position: 'relative', width: '100%', height: '100%', ...style }}
    >
      {fallbackSrc && (
        <img
          src={fallbackSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
            opacity: state === 'ready' ? 0 : 1,
            transition: 'opacity 250ms ease',
          }}
        />
      )}
      <div
        ref={canvasHostRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0 }}
      />
    </div>
  );
}

export default AthleteModel;
