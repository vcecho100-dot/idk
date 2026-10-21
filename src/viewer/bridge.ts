import type * as THREE from "three";

/**
 * The mounted Studio viewport registers these so UI outside the <Canvas>
 * (toolbar, export, turntable, thumbnails) can use the live renderer.
 */
export interface ViewerBridge {
  /** PNG of the current view, including post-processing. */
  screenshot(): Promise<Blob>;
  /** A framed hero shot for library thumbnails (WebP). */
  thumbnail(width?: number, height?: number): Promise<Blob>;
  /** Renders a 360° orbit frame-by-frame into a canvas of the given size. */
  renderTurntable(opts: { width: number; height: number; frames: number; onFrame: (canvas: HTMLCanvasElement, index: number) => Promise<void> | void; signal?: AbortSignal }): Promise<void>;
  /** The displayed model's scene graph (for tools that read geometry or materials). */
  root(): THREE.Object3D | null;
  invalidate(): void;
}

let current: ViewerBridge | null = null;
const listeners = new Set<() => void>();

export function registerViewer(b: ViewerBridge | null): void {
  current = b;
  listeners.forEach((l) => l());
}

export function viewer(): ViewerBridge | null {
  return current;
}

export function onViewerChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
