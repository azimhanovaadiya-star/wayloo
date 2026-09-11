/**
 * DebugOverlay — bounding boxes + labels drawn over the live video.
 * Only rendered in demo mode; every label comes from the real Scene.
 */

import { useEffect, useRef } from "react";
import type { Scene } from "../types";

export function DebugOverlay({
  scene,
  videoWidth,
  videoHeight,
}: {
  scene: Scene | null;
  videoWidth: number;
  videoHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (videoWidth <= 0 || videoHeight <= 0) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Thirds guide (light, demo framing).
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo((canvas.width * i) / 3, 0);
      ctx.lineTo((canvas.width * i) / 3, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (canvas.height * i) / 3);
      ctx.lineTo(canvas.width, (canvas.height * i) / 3);
      ctx.stroke();
    }

    if (!scene) return;
    for (const obj of scene.objects) {
      const [x1, y1, x2, y2] = obj.bbox;
      ctx.strokeStyle = "#f5b700";
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = `${obj.name} ${Math.round(obj.confidence * 100)}%`;
      ctx.font = "600 15px Space Grotesk, sans-serif";
      const w = ctx.measureText(label).width + 10;
      const ly = Math.max(y1 - 24, 2);
      ctx.fillStyle = "#f5b700";
      ctx.fillRect(x1, ly, w, 20);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillText(label, x1 + 5, ly + 15);
    }
  }, [scene, videoWidth, videoHeight]);

  if (videoWidth <= 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full object-cover -scale-x-100"
      aria-hidden="true"
    />
  );
}