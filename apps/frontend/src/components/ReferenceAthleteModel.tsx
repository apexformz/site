'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

const MODEL_SOURCE = '/models/apex-athlete-reference.glb';

export interface ReferenceAthleteModelProps {
  /** Pause the posed model's gentle presentation loop at its current frame. */
  playing?: boolean;
  className?: string;
  style?: CSSProperties;
  fallbackSrc?: string | null;
  ariaLabel?: string;
  onReady?: () => void;
  onUnavailable?: (error: Error) => void;
}

type ModelState = 'idle' | 'loading' | 'ready' | 'unavailable';

/**
 * The export has UV splits and no authored normals. Average triangle normals
 * across identical positions without welding UVs or changing the texture.
 */
function smoothOrganicNormals(geometry: BufferGeometry) {
  const positions = geometry.attributes.position;
  if (!positions) return;
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  const index = geometry.index;
  const sums = new Map<string, [number, number, number]>();
  const keys = Array.from({ length: positions.count }, (_, i) =>
    [positions.getX(i), positions.getY(i), positions.getZ(i)]
      .map((value) => Math.round(value * 1e5))
      .join(','),
  );
  const count = index?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const ab = [
      positions.getX(b) - positions.getX(a),
      positions.getY(b) - positions.getY(a),
      positions.getZ(b) - positions.getZ(a),
    ];
    const ac = [
      positions.getX(c) - positions.getX(a),
      positions.getY(c) - positions.getY(a),
      positions.getZ(c) - positions.getZ(a),
    ];
    const nx = ab[1] * ac[2] - ab[2] * ac[1];
    const ny = ab[2] * ac[0] - ab[0] * ac[2];
    const nz = ab[0] * ac[1] - ab[1] * ac[0];
    for (const vertex of [a, b, c]) {
      const normal = sums.get(keys[vertex]) ?? [0, 0, 0];
      normal[0] += nx;
      normal[1] += ny;
      normal[2] += nz;
      sums.set(keys[vertex], normal);
    }
  }
  for (let i = 0; i < positions.count; i++) {
    const normal = sums.get(keys[i]) ?? [0, 1, 0];
    const length = Math.hypot(...normal) || 1;
    normals.setXYZ(
      i,
      normal[0] / length,
      normal[1] / length,
      normal[2] / length,
    );
  }
  normals.needsUpdate = true;
}

/**
 * A textured 3D reconstruction of the supplied athlete image. The source asset
 * is a posed mesh, not an animation rig; its loop presents that authored pose
 * with gentle spatial motion while retaining the reference's silhouette.
 */
export function ReferenceAthleteModel({
  playing = true,
  className = '',
  style,
  fallbackSrc = '/images/apex-athlete-reference.png',
  ariaLabel = 'A textured three-dimensional reconstruction of the reference athlete in a running pose.',
  onReady,
  onUnavailable,
}: ReferenceAthleteModelProps) {
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
    let frameReady = false;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let renderer: WebGLRenderer | undefined;
    let scene: Scene | undefined;
    let camera: OrthographicCamera | undefined;
    let stage: Group | undefined;
    let environment: WebGLRenderTarget | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;
    const loadController = new AbortController();
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

    const collectResources = (root: Object3D) => {
      root.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]) {
          materials.add(material);
          for (const value of Object.values(material)) {
            const texture = value as Texture | undefined;
            if (texture?.isTexture) textures.add(texture);
          }
        }
      });
    };

    const disposeGraphics = () => {
      cancelFrame();
      frameReady = false;
      clearTimeout(loadTimeout);
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      renderer?.domElement.removeEventListener(
        'webglcontextlost',
        onContextLost,
      );
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => {
        const image = texture.source?.data;
        if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
          image.close();
        texture.dispose();
      });
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
      loadController.abort();
      disposeGraphics();
      setState('unavailable');
      callbacksRef.current.onUnavailable?.(
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    };

    function onContextLost(event: Event) {
      event.preventDefault();
      unavailable(new Error('The athlete graphics context was lost.'));
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
    const poseAt = (seconds: number) => {
      if (!stage) return;
      const phase = (seconds * Math.PI * 2) / 8;
      stage.rotation.set(
        Math.sin(phase) * 0.008 + pointer.currentY * 0.025,
        Math.sin(phase) * 0.055 + pointer.currentX * 0.09,
        Math.sin(phase) * 0.004,
      );
      stage.position.y = (1 - Math.cos(phase)) * 0.008;
    };
    const tick = (now: number) => {
      frame = 0;
      if (!canAnimate() || disposed || failed) return;
      const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0;
      lastFrame = now;
      elapsed += delta;
      const ease = 1 - Math.exp(-delta * 5);
      pointer.currentX += (pointer.x - pointer.currentX) * ease;
      pointer.currentY += (pointer.y - pointer.currentY) * ease;
      poseAt(elapsed);
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
        pointer.currentX = pointer.currentY = 0;
        poseAt(0);
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
      loadTimeout = setTimeout(
        () =>
          unavailable(new Error('The athlete model took too long to load.')),
        45000,
      );
      try {
        const [THREE, { GLTFLoader }, { RoomEnvironment }, response] =
          await Promise.all([
            import('three'),
            import('three/examples/jsm/loaders/GLTFLoader.js'),
            import('three/examples/jsm/environments/RoomEnvironment.js'),
            fetch(MODEL_SOURCE, { signal: loadController.signal }),
          ]);
        if (disposed || failed) return;
        if (!response.ok)
          throw new Error(
            `The athlete model could not load (${response.status}).`,
          );
        const buffer = await response.arrayBuffer();
        if (disposed || failed) return;
        const gltf = await new GLTFLoader().parseAsync(buffer, '/models/');
        collectResources(gltf.scene);
        if (disposed || failed) {
          disposeGraphics();
          return;
        }
        clearTimeout(loadTimeout);

        renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: true,
          powerPreference: 'default',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        renderer.domElement.setAttribute('aria-hidden', 'true');
        renderer.domElement.style.cssText =
          'display:block;width:100%;height:100%;opacity:0;';
        renderer.domElement.addEventListener('webglcontextlost', onContextLost);
        host.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 30);
        // This camera reproduces the image's right-facing three-quarter pose.
        camera.position.set(-5.2, 0.3, 2.6);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        const room = new RoomEnvironment();
        const pmrem = new THREE.PMREMGenerator(renderer);
        try {
          environment = pmrem.fromScene(room, 0.04);
          scene.environment = environment.texture;
          scene.environmentIntensity = 0.6;
        } finally {
          room.dispose();
          pmrem.dispose();
        }
        scene.add(new THREE.HemisphereLight(0xddeaff, 0x667292, 0.6));
        const keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
        keyLight.position.set(-3, 5, 4);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0x8bbaff, 0.3);
        fillLight.position.set(4, 1, -3);
        scene.add(fillLight);

        const subject = gltf.scene;
        subject.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          smoothOrganicNormals(mesh.geometry);
          const finishSurface = (material: Material) => {
            const surface = material as MeshStandardMaterial;
            if (!surface.isMeshStandardMaterial) return material;
            // Retain the generated color atlas. A restrained clear coat brings
            // back the reference's polished pearl/glass finish under soft light.
            const polished = new THREE.MeshPhysicalMaterial({
              map: surface.map,
              color: surface.color,
              metalness: 0.08,
              roughness: 0.36,
              clearcoat: 0.65,
              clearcoatRoughness: 0.24,
              emissiveMap: surface.map,
              emissive: 0xffffff,
              emissiveIntensity: 0.14,
              flatShading: false,
              side: surface.side,
              transparent: surface.transparent,
              opacity: surface.opacity,
            });
            materials.add(polished);
            if (polished.map)
              polished.map.anisotropy = Math.min(
                renderer!.capabilities.getMaxAnisotropy(),
                4,
              );
            return polished;
          };
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(finishSurface)
            : finishSurface(mesh.material);
        });
        const bounds = new THREE.Box3().setFromObject(subject);
        const centre = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        if (!Number.isFinite(size.y) || size.y <= 0)
          throw new Error('The athlete model has invalid bounds.');
        subject.position.sub(centre);
        stage = new THREE.Group();
        stage.add(subject);
        stage.scale.setScalar(1 / size.y);
        scene.add(stage);

        // Fit actual projected vertices across the motion envelope, not an
        // oversized world bounding box, so the full athlete stays prominent.
        const viewBounds = new THREE.Box3();
        const vertex = new THREE.Vector3();
        for (const yaw of [-0.16, 0, 0.16]) {
          for (const pitch of [-0.035, 0.035]) {
            stage.rotation.set(pitch, yaw, 0);
            stage.updateMatrixWorld(true);
            subject.traverse((object) => {
              const mesh = object as Mesh;
              if (!mesh.isMesh) return;
              const positions = mesh.geometry.attributes.position;
              for (let i = 0; i < positions.count; i++) {
                vertex
                  .fromBufferAttribute(positions, i)
                  .applyMatrix4(mesh.matrixWorld)
                  .applyMatrix4(camera!.matrixWorldInverse);
                viewBounds.expandByPoint(vertex);
              }
            });
          }
        }
        const viewSize = viewBounds.getSize(new THREE.Vector3());
        const viewCentre = viewBounds.getCenter(new THREE.Vector3());
        const fitCamera = () => {
          if (!renderer || !camera || disposed || failed) return;
          const width = Math.max(1, wrapper.clientWidth);
          const height = Math.max(1, wrapper.clientHeight);
          const aspect = width / height;
          const span = Math.max(viewSize.y + 0.025, viewSize.x / aspect) * 1.07;
          camera.left = viewCentre.x - (span * aspect) / 2;
          camera.right = viewCentre.x + (span * aspect) / 2;
          camera.top = viewCentre.y + span / 2;
          camera.bottom = viewCentre.y - span / 2;
          camera.updateProjectionMatrix();
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
          renderer.setSize(width, height, false);
          if (frameReady && visible && !document.hidden) draw();
        };
        poseAt(0);
        fitCamera();
        resizeObserver = new ResizeObserver(fitCamera);
        resizeObserver.observe(wrapper);
        await renderer.compileAsync(scene, camera);
        if (disposed || failed || !renderer) return;
        if (renderer.getContext().isContextLost())
          throw new Error('The athlete graphics context could not initialise.');
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
      loadController.abort();
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
      data-model-source={MODEL_SOURCE}
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

export default ReferenceAthleteModel;
