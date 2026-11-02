/**
 * One procedural planet. The surface is sampled in 3D on the rotating unit sphere (no seams at
 * the date line), lit from the upper left with a soft terminator, wrapped in an atmosphere rim
 * and, for some designs, a tilted ring that passes behind and in front of the disc.
 * Output is premultiplied alpha on a transparent tile.
 */
export const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

export const FRAGMENT = `
precision highp float;
varying vec2 v_uv;
uniform float u_time;     // seconds, already scaled by the planet's spin and activity
uniform float u_kind;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec3 u_atmo;
uniform float u_rings;    // 0 or 1
uniform vec3 u_ring;
uniform float u_tilt;
uniform float u_bands;
uniform float u_sea;
uniform float u_seed;
uniform float u_energy;   // 0 idle .. 1 working: brighter atmosphere and glow
uniform float u_alert;    // 0 .. 1 someone is waiting: warm halo

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

// The surface color at point q (rotating frame). emis receives self-lit light.
vec3 surface(vec3 q, vec3 n, float t, out float emis) {
  emis = 0.0;
  vec3 s = q + vec3(u_seed);
  if (u_kind < 0.5 || (u_kind > 0.5 && u_kind < 1.5)) {
    // gas giant bands, gently flowing
    float warp = fbm(vec3(s.x * 2.0, s.y * 7.0, s.z * 2.0) + vec3(t * 0.05, 0.0, 0.0));
    float b = q.y * u_bands * 3.14159 + warp * 2.2;
    float v = 0.5 + 0.5 * sin(b * 2.0);
    vec3 col = mix(u_c1, u_c2, v);
    col = mix(col, u_c3, smoothstep(0.62, 0.95, fbm(s * 5.0 + vec3(0.0, t * 0.03, 0.0))) * 0.5);
    if (u_kind > 0.5) {
      // the great storm: a swirling oval fixed on the surface
      vec3 e = normalize(vec3(0.55, -0.28, 0.79));
      vec3 d = (q - e) * vec3(1.0, 1.9, 1.0);
      float r = length(d);
      float ang = atan(d.y, d.x + d.z) + 4.0 * exp(-r * 6.0) + t * 0.6;
      float swirl = fbm(vec3(cos(ang) * r * 6.0, sin(ang) * r * 6.0, t * 0.1));
      float eye = smoothstep(0.24, 0.12, r);
      col = mix(col, mix(u_c3, u_c2, swirl), eye);
    }
    return col;
  }
  if (u_kind < 2.5) {
    // rock: hills, maria and craters
    float h = fbm(s * 3.0);
    vec3 col = mix(u_c2, u_c1, smoothstep(0.35, 0.65, h));
    float c = noise(s * 9.0);
    float crater = smoothstep(0.78, 0.82, c) - smoothstep(0.84, 0.9, c);
    col = mix(col, u_c2 * 0.7, smoothstep(0.82, 0.86, c));
    col += u_c3 * crater * 0.35;
    return col;
  }
  if (u_kind < 3.5 || (u_kind > 10.5 && u_kind < 11.5)) {
    // terran: ocean, land, ice caps, clouds drifting faster than the ground
    float h = fbm(s * 2.3);
    float land = smoothstep(u_sea, u_sea + 0.03, h);
    vec3 ocean = u_c1 * (0.75 + 0.5 * smoothstep(u_sea - 0.2, u_sea, h));
    vec3 col = mix(ocean, u_c2 * (0.8 + 0.4 * fbm(s * 8.0)), land);
    col = mix(col, vec3(0.94, 0.97, 1.0), smoothstep(0.78, 0.86, abs(q.y) + 0.1 * fbm(s * 4.0)));
    vec3 cq = rotY(q, t * 0.07);
    float cl = smoothstep(0.52, 0.78, fbm(cq * 3.2 + vec3(u_seed * 2.0)));
    col = mix(col, u_c3, cl * 0.85);
    if (u_kind > 10.5) {
      // city lights, only where it is night (set by the caller via n)
      float lights = step(0.74, noise(s * 38.0)) * land * (1.0 - cl);
      emis = lights;
    }
    return col;
  }
  if (u_kind < 4.5) {
    // ice: pale plains crossed by thin blue cracks
    float h = fbm(s * 2.5);
    vec3 col = mix(u_c1, u_c3, h);
    float crack = abs(noise(s * 7.0) - 0.5);
    col = mix(col, u_c2, smoothstep(0.03, 0.0, crack) * 0.8);
    return col;
  }
  if (u_kind < 5.5) {
    // lava: cooling crust with veins that breathe
    float f = abs(fbm(s * 3.0 + vec3(0.0, t * 0.02, 0.0)) - 0.5);
    float vein = smoothstep(0.07, 0.0, f);
    float pulse = 0.7 + 0.3 * sin(t * 1.6 + fbm(s * 6.0) * 6.0);
    emis = vein * pulse;
    return u_c1 * (0.8 + 0.6 * fbm(s * 6.0));
  }
  if (u_kind < 6.5) {
    // clouds: a whole sky folding over itself
    vec3 w = vec3(fbm(s * 2.0 + t * 0.03), fbm(s * 2.0 + 5.2), fbm(s * 2.0 + 9.1));
    float v = fbm(s * 2.4 + w * 1.8 + vec3(0.0, t * 0.04, 0.0));
    return mix(mix(u_c2, u_c1, v), u_c3, pow(v, 3.0) * 0.9);
  }
  if (u_kind < 7.5) {
    // marble
    float v = sin(q.y * 7.0 + fbm(s * 2.6 + vec3(t * 0.03, 0.0, 0.0)) * 7.0);
    vec3 col = mix(u_c1, u_c2, 0.5 + 0.5 * v);
    return mix(col, u_c3, smoothstep(0.85, 1.0, v) * 0.6);
  }
  if (u_kind < 9.5) {
    // star: boiling surface, fully self-lit
    float v = fbm(s * 4.0 + vec3(t * 0.12, -t * 0.08, t * 0.1));
    float g = fbm(s * 9.0 - vec3(t * 0.2));
    emis = 1.0;
    return mix(u_c1, u_c2, v) + u_c3 * pow(g, 3.0) * 1.2;
  }
  if (u_kind < 10.5) {
    // aurora: a dark world with curtains of light around the poles
    float h = fbm(s * 3.0);
    vec3 col = mix(u_c1, u_c2, h);
    float lon = atan(q.z, q.x);
    float band = smoothstep(0.14, 0.0, abs(abs(q.y) - 0.7 - 0.05 * sin(lon * 3.0 + t)));
    float flick = noise(vec3(lon * 4.0, t * 0.9, 0.0));
    emis = band * (0.4 + flick);
    return col;
  }
  // obsidian: black glass
  return u_c1 + u_c2 * fbm(s * 4.0) * 0.6;
}

// Ring color and opacity at screen point p (planet radius R), or 0 outside the ring.
vec4 ring(vec2 p, float R) {
  vec2 pr = rot2(p, -u_tilt);
  float k = 0.3;
  float d = length(vec2(pr.x, pr.y / k)) / R;
  if (d < 1.26 || d > 1.74) return vec4(0.0);
  float bands = 0.55 + 0.45 * sin(d * 46.0) * sin(d * 13.0 + 1.0);
  float edge = smoothstep(1.26, 1.32, d) * smoothstep(1.74, 1.67, d);
  float gap = smoothstep(0.015, 0.03, abs(d - 1.55));
  float a = edge * gap * bands * 0.85;
  return vec4(u_ring * (0.75 + 0.25 * bands), a);
}

void main() {
  vec2 p = v_uv;
  float hasRings = u_rings;
  float R = hasRings > 0.5 ? 0.55 : (u_kind > 8.5 && u_kind < 9.5 ? 0.68 : 0.8);
  float r = length(p) / R;
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  vec3 L = normalize(vec3(-0.55, 0.5, 0.67));

  // the far half of the ring, hidden where the planet covers it
  vec4 rg = hasRings > 0.5 ? ring(p, R) : vec4(0.0);
  bool front = rot2(p, -u_tilt).y < 0.0;
  if (rg.a > 0.0 && !front && r > 1.0) { col = rg.rgb * rg.a; alpha = rg.a; }

  // the atmosphere just outside the disc (and the corona of a star)
  float isStar = (u_kind > 8.5 && u_kind < 9.5) ? 1.0 : 0.0;
  {
    // computed under the disc too, so the antialiased edge blends into it (no dark seam)
    float reach = mix(10.0, 4.5, isStar);
    float halo = exp(-(max(r, 1.0) - 1.0) * reach) * mix(0.45 + 0.35 * u_energy + 0.35 * u_alert, 0.85, isStar);
    halo *= smoothstep(1.0, 0.82, length(p)); // fade out before the tile edge: never a square
    vec3 hc = mix(u_atmo, vec3(1.0, 0.45, 0.32), u_alert * 0.6);
    col += hc * halo * (1.0 - alpha);
    alpha += halo * (1.0 - alpha);
  }

  if (r < 1.0) {
    vec3 n = vec3(p / R, sqrt(1.0 - r * r));
    // axial tilt, then spin about the axis
    vec3 tn = vec3(rot2(n.xy, -u_tilt), n.z);
    vec3 q = rotY(tn, u_time * 0.25);
    float emis;
    vec3 base = surface(q, n, u_time, emis);
    float d = dot(n, L);
    float lit = smoothstep(-0.28, 0.85, d);
    vec3 surf = base * (0.1 + 0.95 * lit);
    if (u_kind > 8.5 && u_kind < 9.5) {
      surf = base * (0.62 + 0.38 * n.z); // limb darkening, no shadow
    } else if (u_kind > 10.5 && u_kind < 11.5) {
      surf += u_c3 * emis * smoothstep(0.25, -0.15, d) * 1.4; // lights on the night side
    } else if (u_kind > 4.5 && u_kind < 5.5) {
      surf += mix(u_c2, u_c3, emis) * emis * 1.3;
    } else if (u_kind > 9.5 && u_kind < 10.5) {
      surf += u_c3 * emis;
    } else if (u_kind > 11.5) {
      // iridescent rim on black glass
      float f = pow(1.0 - n.z, 2.0);
      vec3 iri = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + f * 1.4 + u_time * 0.05));
      surf += iri * f * 0.9 + vec3(1.0) * pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0) * 0.8;
    }
    // atmosphere: rim light, brighter while the bot works
    float rim = pow(1.0 - n.z, 2.4);
    surf += mix(u_atmo, vec3(1.0, 0.45, 0.32), u_alert * 0.5) * rim * (0.35 + 0.45 * lit) * (0.8 + 0.6 * u_energy);
    float edge = smoothstep(1.0, 0.975, r);
    col = mix(col, surf, edge);
    alpha = mix(alpha, 1.0, edge);
  }

  // the near half of the ring, over the planet
  if (rg.a > 0.0 && (front || r > 1.0)) {
    float shade = (r < 1.0) ? 0.85 : 1.0;
    col = rg.rgb * rg.a * shade + col * (1.0 - rg.a);
    alpha = rg.a + alpha * (1.0 - rg.a);
  }
  gl_FragColor = vec4(col, alpha);
}
`;
