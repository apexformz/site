/**
 * Map a tap on the displayed camera view to normalized raw-camera coordinates.
 * The view is drawn with CSS object-fit: cover (cropped to fill) and mirrored for display, while the
 * pose detector sees the raw, un-mirrored frame. Returns null for taps outside the drawn video.
 */
export function tapToRawPoint(
  tap: { clientX: number; clientY: number },
  box: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number },
  mirrored = true,
): { x: number; y: number } | null {
  const vw = video.width || 1280;
  const vh = video.height || 720;
  const scale = Math.max(box.width / vw, box.height / vh);
  const xd = (tap.clientX - box.left - (box.width - vw * scale) / 2) / (vw * scale);
  const yd = (tap.clientY - box.top - (box.height - vh * scale) / 2) / (vh * scale);
  if (!(xd >= 0 && xd <= 1 && yd >= 0 && yd <= 1)) return null;
  return { x: mirrored ? 1 - xd : xd, y: yd };
}
