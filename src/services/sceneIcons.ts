import type { SceneIconName } from "../types";

export interface SceneIconState {
  value: number;
  playing: boolean;
  connected: boolean;
}

export function drawSceneIcon(
  context: CanvasRenderingContext2D,
  icon: SceneIconName,
  x: number,
  y: number,
  width: number,
  height: number,
  state: SceneIconState,
) {
  context.save();
  context.translate(x, y);
  context.scale(Math.max(1, width) / 16, Math.max(1, height) / 16);
  context.fillStyle = "#fff";
  context.strokeStyle = "#fff";
  context.lineWidth = 1.4;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (icon === "playback") {
    if (state.playing) {
      context.beginPath();
      context.moveTo(4, 2.5);
      context.lineTo(13, 8);
      context.lineTo(4, 13.5);
      context.closePath();
      context.fill();
    } else {
      context.fillRect(3, 3, 3, 10);
      context.fillRect(10, 3, 3, 10);
    }
  } else if (icon === "battery") {
    context.strokeRect(1.5, 4, 12, 8);
    context.fillRect(13.5, 6.2, 1.5, 3.6);
    context.fillRect(3, 5.5, 9 * Math.max(0, Math.min(100, state.value)) / 100, 5);
  } else if (icon === "volume") {
    context.beginPath();
    context.moveTo(2, 6);
    context.lineTo(5, 6);
    context.lineTo(9, 3);
    context.lineTo(9, 13);
    context.lineTo(5, 10);
    context.lineTo(2, 10);
    context.closePath();
    context.fill();
    if (state.value > 0) {
      context.beginPath();
      context.arc(9, 8, 3, -Math.PI / 3, Math.PI / 3);
      context.stroke();
    }
    if (state.value > 55) {
      context.beginPath();
      context.arc(9, 8, 5.5, -Math.PI / 3, Math.PI / 3);
      context.stroke();
    }
  } else {
    context.beginPath();
    context.arc(8, 8, 6, Math.PI, 0);
    context.stroke();
    context.strokeRect(1.5, 8, 2.5, 5);
    context.strokeRect(12, 8, 2.5, 5);
    context.beginPath();
    context.moveTo(12, 13);
    context.lineTo(10, 14.5);
    context.lineTo(7.5, 14.5);
    context.stroke();
    if (!state.connected) {
      context.beginPath();
      context.moveTo(2, 2);
      context.lineTo(14, 14);
      context.stroke();
    }
  }
  context.restore();
}
