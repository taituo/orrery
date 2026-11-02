import { FRAGMENT, VERTEX } from "./shader";
import { PLANETS } from "./designs";

/**
 * Every planet on the page is drawn by ONE WebGL context: each frame it renders the visible
 * planets one by one into a small offscreen tile and copies each tile to that planet's own 2D
 * canvas. Twenty animated avatars cost one GPU context, not twenty (browsers cap contexts at
 * around sixteen). Planets off screen are skipped; nothing runs while the tab is hidden; with
 * reduced motion each planet is drawn once, still.
 */
export interface PlanetState {
  design: number;
  /** 0 idle .. 1 working */
  energy: number;
  /** 0 .. 1 someone is waiting on this bot's approval */
  alert: number;
}

interface Entry extends PlanetState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  phase: number;
  /** eased versions of energy / alert */
  e: number;
  a: number;
  drawnOnce: boolean;
}

const TILE = 256;
const FPS = 30;

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
};

class Renderer {
  private gl: WebGLRenderingContext | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private entries = new Set<Entry>();
  private observer: IntersectionObserver | null = null;
  private raf = 0;
  private last = 0;
  private clock = 0;
  private failed = false;
  private reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** False when WebGL is unavailable: callers fall back to a flat orb. */
  get supported(): boolean {
    return this.init();
  }

  private init(): boolean {
    if (this.gl) return true;
    if (this.failed || typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    canvas.width = TILE;
    canvas.height = TILE;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return (this.failed = true), false;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "planet shader failed to compile");
      return s;
    };
    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "planet shader failed to link");
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const u of ["u_time", "u_kind", "u_c1", "u_c2", "u_c3", "u_atmo", "u_rings", "u_ring", "u_tilt", "u_bands", "u_sea", "u_seed", "u_energy", "u_alert"]) this.uniforms[u] = gl.getUniformLocation(prog, u);
    } catch (err) {
      console.warn("planets: falling back to flat orbs", err);
      this.failed = true;
      return false;
    }
    this.gl = gl;
    this.glCanvas = canvas;
    this.observer = new IntersectionObserver((items) => {
      for (const it of items) for (const e of this.entries) if (e.canvas === it.target) e.visible = it.isIntersecting;
      this.kick();
    });
    document.addEventListener("visibilitychange", () => this.kick());
    canvas.addEventListener("webglcontextlost", (ev) => (ev.preventDefault(), cancelAnimationFrame(this.raf)));
    canvas.addEventListener("webglcontextrestored", () => ((this.gl = null), this.init(), this.kick()));
    return true;
  }

  add(canvas: HTMLCanvasElement, state: PlanetState): (next: PlanetState) => void {
    if (!this.init()) return () => undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return () => undefined;
    const entry: Entry = { ...state, canvas, ctx, visible: true, phase: Math.random() * 100, e: state.energy, a: state.alert, drawnOnce: false };
    this.entries.add(entry);
    this.observer!.observe(canvas);
    this.kick();
    return (next) => {
      Object.assign(entry, next);
      entry.drawnOnce = false;
      this.kick();
    };
  }

  remove(canvas: HTMLCanvasElement): void {
    for (const e of this.entries) if (e.canvas === canvas) this.entries.delete(e);
    this.observer?.unobserve(canvas);
  }

  private kick(): void {
    if (!this.raf && !document.hidden) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    if (document.hidden || !this.entries.size) return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    if (dt && dt < 1 / FPS - 0.004) return this.kick();
    this.last = now;
    this.clock += dt;
    const gl = this.gl!;
    let anyMoving = false;
    for (const e of this.entries) {
      if (!e.visible) continue;
      // glide toward the requested state
      e.e += (e.energy - e.e) * Math.min(1, dt * 1.5);
      e.a += (e.alert - e.a) * Math.min(1, dt * 1.5);
      if (this.reduced && e.drawnOnce) continue;
      const w = e.canvas.width;
      if (!w) continue;
      const size = Math.min(TILE, w);
      const d = PLANETS[e.design] ?? PLANETS[0]!;
      e.phase += dt * (d.spin ?? 1) * (1 + 2.2 * e.e);
      const u = this.uniforms;
      gl.viewport(0, 0, size, size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.u_time!, this.reduced ? 7 : e.phase);
      gl.uniform1f(u.u_kind!, d.kind);
      gl.uniform3fv(u.u_c1!, rgb(d.colors[0]));
      gl.uniform3fv(u.u_c2!, rgb(d.colors[1]));
      gl.uniform3fv(u.u_c3!, rgb(d.colors[2]));
      gl.uniform3fv(u.u_atmo!, rgb(d.atmosphere));
      gl.uniform1f(u.u_rings!, d.rings ? 1 : 0);
      gl.uniform3fv(u.u_ring!, rgb(d.rings ?? "#ffffff"));
      gl.uniform1f(u.u_tilt!, d.tilt ?? 0);
      gl.uniform1f(u.u_bands!, d.bands ?? 2);
      gl.uniform1f(u.u_sea!, d.sea ?? 0.5);
      gl.uniform1f(u.u_seed!, e.design * 1.37);
      gl.uniform1f(u.u_energy!, e.e);
      gl.uniform1f(u.u_alert!, e.a);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      e.ctx.clearRect(0, 0, w, w);
      e.ctx.drawImage(this.glCanvas!, 0, TILE - size, size, size, 0, 0, w, w);
      e.drawnOnce = true;
      anyMoving = true;
    }
    if (anyMoving && !this.reduced) this.kick();
    else if (this.reduced && [...this.entries].some((e) => e.visible && !e.drawnOnce)) this.kick();
  }
}

export const planets = new Renderer();
