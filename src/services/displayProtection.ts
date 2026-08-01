const OLED_WIDTH = 128;
const OLED_HEIGHT = 64;
const FRAME_BYTES = OLED_WIDTH * OLED_HEIGHT / 8;

const SHIFT_PATTERN = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
] as const;

export interface DisplayProtectionOptions {
  pixelShift: boolean;
  staticSleep: boolean;
  sleepAfterMs: number;
  shiftEveryMs?: number;
}

export interface ProtectedFrame {
  frame: number[];
  sleeping: boolean;
  offset: { x: number; y: number };
}

function normalizedFrame(frame: number[]) {
  if (frame.length !== FRAME_BYTES) throw new Error(`OLED frame must contain ${FRAME_BYTES} bytes`);
  if (frame.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return frame;
  return frame.map(value => Math.max(0, Math.min(255, Math.round(Number(value) || 0))));
}

export function framesEqual(first?: number[], second?: number[]) {
  return Boolean(first && second && first.length === second.length && first.every((value, index) => value === second[index]));
}

export function shiftMonoFrame(frame: number[], dx: number, dy: number) {
  const source = normalizedFrame(frame);
  if (dx === 0 && dy === 0) return source;
  const shifted = new Array(FRAME_BYTES).fill(0);
  for (let x = 0; x < OLED_WIDTH; x += 1) {
    for (let y = 0; y < OLED_HEIGHT; y += 1) {
      if ((source[x * 8 + Math.floor(y / 8)] & (1 << (y % 8))) === 0) continue;
      const targetX = x + dx;
      const targetY = y + dy;
      if (targetX < 0 || targetX >= OLED_WIDTH || targetY < 0 || targetY >= OLED_HEIGHT) continue;
      shifted[targetX * 8 + Math.floor(targetY / 8)] |= 1 << (targetY % 8);
    }
  }
  return shifted;
}

export class DisplayProtectionController {
  private sourceFrame?: number[];
  private unchangedSince = 0;
  private shiftStartedAt = 0;

  reset(now = Date.now()) {
    this.sourceFrame = undefined;
    this.unchangedSince = now;
    this.shiftStartedAt = now;
  }

  process(frame: number[], options: DisplayProtectionOptions, now = Date.now()): ProtectedFrame {
    const source = normalizedFrame(frame);
    if (!options.pixelShift && !options.staticSleep) {
      return { frame: source, sleeping: false, offset: { x: 0, y: 0 } };
    }
    if (options.staticSleep && (!this.sourceFrame || !framesEqual(this.sourceFrame, source))) {
      this.sourceFrame = source;
      this.unchangedSince = now;
    }
    if (!this.shiftStartedAt) this.shiftStartedAt = now;

    const sleepAfterMs = Math.max(1000, Number(options.sleepAfterMs) || 0);
    if (options.staticSleep && now - this.unchangedSince >= sleepAfterMs) {
      return { frame: new Array(FRAME_BYTES).fill(0), sleeping: true, offset: { x: 0, y: 0 } };
    }

    if (!options.pixelShift) return { frame: source, sleeping: false, offset: { x: 0, y: 0 } };
    const interval = Math.max(1000, Number(options.shiftEveryMs) || 60_000);
    const [x, y] = SHIFT_PATTERN[Math.floor((now - this.shiftStartedAt) / interval) % SHIFT_PATTERN.length];
    return { frame: shiftMonoFrame(source, x, y), sleeping: false, offset: { x, y } };
  }
}
