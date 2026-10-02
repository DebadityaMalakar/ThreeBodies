import './style.css';

type Precision = 'FP16' | 'FP32' | 'FP64';
type NumericArray = Float32Array | Uint16Array | Float64Array;
interface Float32 { whole: NumericArray; decimal: NumericArray; format: Precision }
interface Vec32 { x: Float32; y: Float32 }
interface Star { x: number; y: number; oldX: number; oldY: number; mass: number }
interface Scenario { name: string; zoom: number; rate: number; bodies: Body[] }
interface View { zoom: number; cameraX: number; cameraY: number }

const WIDTH = 720;
const HEIGHT = 405;
let precision: Precision = 'FP32';
function floatToHalf(value: number): number {
  const float = new Float32Array([value]);
  const raw = new Uint32Array(float.buffer)[0];
  const sign = (raw >>> 16) & 0x8000;
  const exponent = ((raw >>> 23) & 0xff) - 127 + 15;
  const fraction = raw & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | (fraction >>> 13);
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) << 16;
  const exponent = (value >>> 10) & 31;
  const fraction = value & 1023;
  let raw: number;
  if (exponent === 0) raw = sign;
  else if (exponent === 31) raw = sign | 0x7f800000 | (fraction << 13);
  else raw = sign | ((exponent - 15 + 127) << 23) | (fraction << 13);
  return new Float32Array(new Uint32Array([raw]).buffer)[0];
}

function createFloat32(whole: number, decimal = 0): Float32 {
  if (precision === 'FP16') {
    const result: Float32 = { whole: new Uint16Array(1), decimal: new Uint16Array(1), format: precision };
    result.whole[0] = floatToHalf(whole);
    result.decimal[0] = floatToHalf(decimal);
    return result;
  }
  const ArrayType = precision === 'FP64' ? Float64Array : Float32Array;
  const result: Float32 = { whole: new ArrayType(1), decimal: new ArrayType(1), format: precision };
  result.whole[0] = whole;
  result.decimal[0] = decimal;
  return result;
}
function floatValue(value: Float32): number {
  if (value.format === 'FP16') return halfToFloat(value.whole[0]) + halfToFloat(value.decimal[0]);
  return value.whole[0] + value.decimal[0];
}
function f(value: number): Float32 { return createFloat32(value); }
function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }

class Two {
  hi: Float32;
  low: Float32;
  constructor(hi: Float32 = f(0), low: Float32 = f(0)) { this.hi = hi; this.low = low; }
  plus(delta: Float32): Two {
    const hi = floatValue(this.hi);
    const value = floatValue(delta);
    const sum = hi + value;
    const error = (hi - (sum - value)) + (value - (sum - hi));
    const low = floatValue(this.low) + error;
    const rounded = sum + low;
    return new Two(f(rounded), f((sum - (rounded - low)) + (low - (rounded - sum))));
  }
  value(): number { return floatValue(this.hi) + floatValue(this.low); }
  gap(other: Two): number { return other.value() - this.value(); }
}

class Body {
  x: Two; y: Two; u: Two; v: Two; mass: number;
  constructor(x: Two, y: Two, u: Two, v: Two, mass: number) { this.x = x; this.y = y; this.u = u; this.v = v; this.mass = mass; }
  static make(x: number, y: number, u: number, v: number, mass: number): Body {
    return new Body(new Two(f(x)), new Two(f(y)), new Two(f(u)), new Two(f(v)), mass);
  }
  drift(step: number): Body {
    return new Body(this.x.plus(f(this.u.value() * step)), this.y.plus(f(this.v.value() * step)), this.u, this.v, this.mass);
  }
  kick(ax: number, ay: number, step: number): Body {
    return new Body(this.x, this.y, this.u.plus(f(ax * step)), this.v.plus(f(ay * step)), this.mass);
  }
  pull(other: Body): Vec32 {
    const dx = this.x.gap(other.x);
    const dy = this.y.gap(other.y);
    const radius2 = dx * dx + dy * dy + 1e-12;
    const scale = 1 / (radius2 * Math.sqrt(radius2));
    return { x: f(dx * scale), y: f(dy * scale) };
  }
}

class System {
  a: Body; b: Body; c: Body;
  constructor(a: Body, b: Body, c: Body) { this.a = a; this.b = b; this.c = c; }
  bodies(): Body[] { return [this.a, this.b, this.c]; }
  kick(ab: Vec32, ac: Vec32, bc: Vec32, step: number): System {
    const ax = this.b.mass * floatValue(ab.x) + this.c.mass * floatValue(ac.x);
    const ay = this.b.mass * floatValue(ab.y) + this.c.mass * floatValue(ac.y);
    const bx = this.c.mass * floatValue(bc.x) - this.a.mass * floatValue(ab.x);
    const by = this.c.mass * floatValue(bc.y) - this.a.mass * floatValue(ab.y);
    const cx = -this.a.mass * floatValue(ac.x) - this.b.mass * floatValue(bc.x);
    const cy = -this.a.mass * floatValue(ac.y) - this.b.mass * floatValue(bc.y);
    return new System(this.a.kick(ax, ay, step), this.b.kick(bx, by, step), this.c.kick(cx, cy, step));
  }
  leap(step: number): System {
    const half = step * 0.5;
    const drifted = new System(this.a.drift(half), this.b.drift(half), this.c.drift(half));
    const kicked = drifted.kick(drifted.a.pull(drifted.b), drifted.a.pull(drifted.c), drifted.b.pull(drifted.c), step);
    return new System(kicked.a.drift(half), kicked.b.drift(half), kicked.c.drift(half));
  }
  step(step: number): System {
    const weight = 1.3512071919596578 * step;
    return this.leap(weight).leap(step - 2 * weight).leap(weight);
  }
  pace(): number {
    let fastest = Infinity;
    const bodies = this.bodies();
    for (let left = 0; left < 3; left += 1) for (let right = left + 1; right < 3; right += 1) {
      const dx = bodies[right].x.gap(bodies[left].x); const dy = bodies[right].y.gap(bodies[left].y);
      const du = bodies[right].u.gap(bodies[left].u); const dv = bodies[right].v.gap(bodies[left].v);
      const r2 = dx * dx + dy * dy + 1e-12;
      const freeFall = r2 * Math.sqrt(r2) / (bodies[left].mass + bodies[right].mass);
      fastest = Math.min(fastest, freeFall * r2 / (r2 + freeFall * (du * du + dv * dv)));
    }
    return Math.sqrt(Math.max(fastest, 1e-8));
  }
  run(duration: number): System {
    let left = duration; let current: System = this;
    const fuelLimit = precision === 'FP16' ? 256 : 512;
    for (let fuel = fuelLimit; fuel > 0 && left > 0; fuel -= 1) {
      const candidate = Math.min(left, 0.02 * current.pace());
      const step = precision === 'FP32' ? candidate : Math.max(candidate, 0.00005);
      current = current.step(step); left -= step;
    }
    return current;
  }
  center(): System {
    const bodies = this.bodies(); const mass = bodies.reduce((sum, body) => sum + body.mass, 0);
    const x = bodies.reduce((sum, body) => sum + body.mass * body.x.value(), 0) / mass;
    const y = bodies.reduce((sum, body) => sum + body.mass * body.y.value(), 0) / mass;
    const u = bodies.reduce((sum, body) => sum + body.mass * body.u.value(), 0) / mass;
    const v = bodies.reduce((sum, body) => sum + body.mass * body.v.value(), 0) / mass;
    const centered = bodies.map(body => Body.make(body.x.value() - x, body.y.value() - y, body.u.value() - u, body.v.value() - v, body.mass));
    return new System(centered[0], centered[1], centered[2]);
  }
  energy(): number {
    const bodies = this.bodies();
    const kinetic = bodies.reduce((sum, body) => sum + 0.5 * body.mass * (body.u.value() ** 2 + body.v.value() ** 2), 0);
    const potential = (left: Body, right: Body) => left.mass * right.mass / Math.sqrt(left.x.gap(right.x) ** 2 + left.y.gap(right.y) ** 2 + 1e-12);
    return kinetic - potential(bodies[0], bodies[1]) - potential(bodies[0], bodies[2]) - potential(bodies[1], bodies[2]);
  }
  sane(): boolean { return this.bodies().every(body => Number.isFinite(body.x.value()) && body.x.value() ** 2 + body.y.value() ** 2 < 1e12); }
}

function trio(p: number, q: number): Body[] { return [Body.make(-1, 0, p, q, 1), Body.make(1, 0, p, q, 1), Body.make(0, 0, -2 * p, -2 * q, 1)]; }
function randomBodies(seed: number): Body[] {
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 8) / 0x1000000; };
  return [0, 1, 2].map(index => { const angle = index * Math.PI * 2 / 3 + random() * 1.2; const radius = 0.7 + random() * 0.6; const x = radius * Math.cos(angle); const y = radius * Math.sin(angle); return Body.make(x, y, random() * 0.5 - 0.25 - 0.5 * y, random() * 0.5 - 0.25 + 0.5 * x, 0.6 + random() * 0.8); });
}
function makeScenarios(): Scenario[] {
  return [
    { name: 'Figure-8', zoom: 400, rate: 0.9, bodies: [Body.make(0.97000436, -0.24308753, 0.466203685, 0.43236573, 1), Body.make(-0.97000436, 0.24308753, 0.466203685, 0.43236573, 1), Body.make(0, 0, -0.93240737, -0.86473146, 1)] },
    { name: 'Butterfly I', zoom: 400, rate: 0.8, bodies: trio(0.30689, 0.12551) }, { name: 'Moth I', zoom: 270, rate: 1.4, bodies: trio(0.46444, 0.39606) },
    { name: 'Yin-Yang I', zoom: 235, rate: 1.5, bodies: trio(0.51394, 0.30474) }, { name: 'Yarn', zoom: 230, rate: 2, bodies: trio(0.55906, 0.34919) },
    { name: 'Lagrange triangle', zoom: 150, rate: 1.6, bodies: [Body.make(0, 1, -0.7598357, 0, 1), Body.make(-0.866, -0.5, 0.3799, -0.658, 1), Body.make(0.866, -0.5, 0.3799, 0.658, 1)] },
    { name: 'Pythagorean 3-4-5', zoom: 100, rate: 1.4, bodies: [Body.make(1, 3, 0, 0, 3), Body.make(-2, -1, 0, 0, 4), Body.make(1, -1, 0, 0, 5)] },
    { name: 'Star, planet and moon', zoom: 300, rate: 0.5, bodies: [Body.make(0, 0, 0, 0, 1), Body.make(1, 0, 0, 1.005, 0.01), Body.make(1.05, 0, 0, 1.454, 0.0001)] },
    { name: 'Two stars and a planet', zoom: 140, rate: 1.2, bodies: [Body.make(-0.247, 0, 0, -0.693, 1), Body.make(0.353, 0, 0, 0.99, 0.7), Body.make(2.2, 0, 0, 0.88, 0.002)] },
    { name: 'Chaos', zoom: 130, rate: 1.6, bodies: randomBodies(0x31415926) },
  ];
}

const canvas = document.querySelector<HTMLCanvasElement>('.tbdp');
if (!canvas) throw new Error('Canvas not found');
const canvasElement: HTMLCanvasElement = canvas;
const contextCandidate = canvas.getContext('2d', { alpha: false });
if (!contextCandidate) throw new Error('Canvas context not available');
const context: CanvasRenderingContext2D = contextCandidate;
const image = context.createImageData(WIDTH, HEIGHT);
const trail = new Uint8ClampedArray(WIDTH * HEIGHT);
const scenarios = makeScenarios();
let scenario = 0; let world = new System(...scenarios[0].bodies as [Body, Body, Body]).center();
let previous = performance.now(); let simulated = 0; let paused = false; let lines = true; let tour = true; let speed = 1;
let fps = 0; let frameSamples = 0; let fpsStamp = previous;
let oldStars: Star[] = world.bodies().map(body => ({ x: body.x.value(), y: body.y.value(), oldX: body.x.value(), oldY: body.y.value(), mass: body.mass }));

function load(index: number): void {
  scenario = (index + scenarios.length) % scenarios.length; const bodies = scenario === 9 ? randomBodies(Math.floor(Math.random() * 0xffffffff)) : scenarios[scenario].bodies;
  world = new System(...bodies.map(body => Body.make(body.x.value(), body.y.value(), body.u.value(), body.v.value(), body.mass)) as [Body, Body, Body]).center();
  oldStars = world.bodies().map(body => ({ x: body.x.value(), y: body.y.value(), oldX: body.x.value(), oldY: body.y.value(), mass: body.mass })); trail.fill(0); simulated = 0;
  if (scenarioSelect) scenarioSelect.value = String(scenario + 1);
}
function colorFor(index: number): [number, number, number] { return index === 0 ? [255, 198, 102] : index === 1 ? [92, 196, 255] : [255, 105, 145]; }
function viewFor(stars: Star[], config: Scenario): View {
  let maxX = 0; let maxY = 0;
  for (const star of stars) { maxX = Math.max(maxX, Math.abs(star.x)); maxY = Math.max(maxY, Math.abs(star.y)); }
  const zoomX = WIDTH * 0.44 / Math.max(maxX, 0.1);
  const zoomY = HEIGHT * 0.44 / Math.max(maxY, 0.1);
  return { zoom: Math.min(config.zoom, zoomX, zoomY), cameraX: 0, cameraY: 0 };
}
function draw(): void {
  const data = image.data; const config = scenarios[scenario]; const stars = world.bodies().map((body, index) => ({ x: body.x.value(), y: body.y.value(), oldX: oldStars[index].x, oldY: oldStars[index].y, mass: body.mass })); const view = viewFor(stars, config);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const index = y * WIDTH + x; const positionX = (x - WIDTH / 2) / view.zoom + view.cameraX; const positionY = (HEIGHT / 2 - y) / view.zoom + view.cameraY; let red = 3; let green = 7; let blue = 15; let brightness = 0; let potential = 0;
    for (const [bodyIndex, star] of stars.entries()) { const dx = positionX - star.x; const dy = positionY - star.y; const distance2 = dx * dx + dy * dy + 0.00004; const light = star.mass / Math.sqrt(distance2); potential += light; brightness += light * 0.08 + 0.02 * star.mass / distance2; const age = trail[index]; if (age > 0 && ((age >> 6) & 3) === bodyIndex) { const [tr, tg, tb] = colorFor(bodyIndex); red += tr * age / 255; green += tg * age / 255; blue += tb * age / 255; } }
    if (lines && Math.abs(Math.sin(3.5 * Math.log(potential + 0.001))) < 0.035) brightness += 0.22;
    const hash = (x * 374761393 + y * 668265263) >>> 0; if ((hash & 2047) < 3) brightness += ((hash >>> 8) & 255) / 255 * 0.35;
    const offset = index * 4; data[offset] = clamp(red + brightness * 240, 0, 255); data[offset + 1] = clamp(green + brightness * 145, 0, 255); data[offset + 2] = clamp(blue + brightness * 80, 0, 255); data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  for (const [index, star] of stars.entries()) { const px = WIDTH / 2 + (star.x - view.cameraX) * view.zoom; const py = HEIGHT / 2 - (star.y - view.cameraY) * view.zoom; const radius = Math.max(2, Math.min(11, 8 * Math.cbrt(star.mass))); const [cr, cg, cb] = colorFor(index); context.beginPath(); context.arc(px, py, radius, 0, Math.PI * 2); context.fillStyle = `rgb(${cr},${cg},${cb})`; context.shadowBlur = radius * 3; context.shadowColor = `rgb(${cr},${cg},${cb})`; context.fill(); context.shadowBlur = 0; }
  context.fillStyle = '#f8fbff'; context.font = '600 15px ui-monospace, monospace'; context.fillText(`${scenario + 1}/10  ${config.name}`, 24, 30); context.fillStyle = '#8da4bd'; context.font = '12px ui-monospace, monospace'; context.fillText(`${paused ? 'PAUSED  ' : ''}${precision}  ${fps} FPS  x${speed.toFixed(2)}  ${lines ? 'FIELD LINES  ' : ''}${tour ? 'TOUR' : ''}`, 24, 50); oldStars = stars;
}
function updateTrails(): void { for (let index = 0; index < trail.length; index += 1) trail[index] = trail[index] > 3 ? trail[index] - 3 : 0; const config = scenarios[scenario]; const view = viewFor(oldStars, config); for (const [bodyIndex, star] of oldStars.entries()) { const x = Math.floor(WIDTH / 2 + (star.x - view.cameraX) * view.zoom); const y = Math.floor(HEIGHT / 2 - (star.y - view.cameraY) * view.zoom); if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) trail[y * WIDTH + x] = 192 + bodyIndex * 20; } }
function frame(now: number): void { const elapsed = Math.min(50, now - previous); previous = now; frameSamples += 1; if (now - fpsStamp >= 500) { fps = Math.round(frameSamples * 1000 / (now - fpsStamp)); frameSamples = 0; fpsStamp = now; if (fpsReadout) fpsReadout.textContent = `${fps} FPS`; } if (!paused) { const duration = elapsed * 0.001 * scenarios[scenario].rate * speed; updateTrails(); world = world.run(duration); simulated += duration; if (tour && simulated > (scenario === 9 ? 70 : 40)) load(scenario + 1); if (!world.sane()) load(scenario); } draw(); requestAnimationFrame(frame); }

canvas.width = WIDTH; canvas.height = HEIGHT;
function fitCanvas(): void {
  const padding = window.innerWidth <= 640 ? 20 : 48;
  const availableWidth = Math.max(320, window.innerWidth - padding);
  const availableHeight = Math.max(180, window.innerHeight - padding);
  const scale = Math.min(availableWidth / WIDTH, availableHeight / HEIGHT);
  canvasElement.style.width = `${Math.floor(WIDTH * scale)}px`;
  canvasElement.style.height = `${Math.floor(HEIGHT * scale)}px`;
}
fitCanvas();
window.addEventListener('resize', fitCanvas, { passive: true });
const precisionButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-precision]')];
const precisionNote = document.querySelector<HTMLElement>('[data-precision-note]');
const fpsReadout = document.querySelector<HTMLElement>('[data-fps]');
const scenarioSelect = document.querySelector<HTMLSelectElement>('[data-scenario]');
const tourButton = document.querySelector<HTMLButtonElement>('[data-tour]');
function setPrecision(next: Precision): void {
  precision = next;
  load(scenario);
  precisionButtons.forEach(button => button.classList.toggle('active', button.dataset.precision === precision));
  if (precisionNote) {
    precisionNote.textContent = precision === 'FP16' ? 'lowest precision; render not guaranteed' : precision === 'FP32' ? 'balanced' : 'slow / precise';
    precisionNote.classList.toggle('warning', precision === 'FP16');
  }
}
precisionButtons.forEach(button => button.addEventListener('click', () => setPrecision(button.dataset.precision as Precision)));
function setTour(enabled: boolean): void {
  tour = enabled;
  if (tourButton) { tourButton.textContent = `AUTO TOUR: ${tour ? 'ON' : 'OFF'}`; tourButton.classList.toggle('active', tour); tourButton.setAttribute('aria-pressed', String(tour)); }
}
scenarioSelect?.addEventListener('change', () => { setTour(false); load(Number(scenarioSelect.value) - 1); });
tourButton?.addEventListener('click', () => setTour(!tour));
setTour(tour);
window.addEventListener('keydown', event => { if (event.code === 'Space') { paused = !paused; event.preventDefault(); } else if (event.key.toLowerCase() === 'g') lines = !lines; else if (event.key.toLowerCase() === 't') setTour(!tour); else if (event.key.toLowerCase() === 'r') load(scenario); else if (event.key.toLowerCase() === 'n' || event.key === 'ArrowRight') load(scenario + 1); else if (event.key.toLowerCase() === 'b' || event.key === 'ArrowLeft') load(scenario - 1); else if (event.key === 'ArrowUp') speed = clamp(speed * 1.25, 0.125, 8); else if (event.key === 'ArrowDown') speed = clamp(speed * 0.8, 0.125, 8); else if (/^[0-9]$/.test(event.key)) load(event.key === '0' ? 9 : Number(event.key) - 1); });
requestAnimationFrame(frame);
