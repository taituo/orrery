/**
 * Twenty planets for bot avatars. Each is the same procedural shader (planet-shader.ts) with a
 * surface kind, a palette, and a few features (rings, tilt, spin). Designs are referenced by
 * index in a bot's avatar ("planet:7"); a bot without one gets a planet derived from its id.
 */
export const KIND = {
  bands: 0, // gas giant: warped latitude bands
  storm: 1, // gas giant with a great storm
  rocky: 2, // cratered rock
  terran: 3, // oceans, land, ice caps, drifting clouds
  ice: 4, // pale ice with hairline cracks
  lava: 5, // dark crust, glowing veins
  clouds: 6, // a world wrapped in swirling cloud
  marble: 7, // swirled stone
  star: 9, // boiling light with a corona
  aurora: 10, // dark world, polar lights
  night: 11, // terran, city lights on the night side
  obsidian: 12, // black glass with an iridescent rim
} as const;

export interface PlanetDesign {
  name: string;
  kind: number;
  /** base, second, highlight */
  colors: [string, string, string];
  atmosphere: string;
  /** ring color, if it has rings */
  rings?: string;
  /** axial tilt, radians (rings and bands follow it) */
  tilt?: number;
  /** band frequency (bands, storm) */
  bands?: number;
  /** rotation speed multiplier */
  spin?: number;
  /** sea level for terran worlds (higher = more ocean) */
  sea?: number;
}

export const PLANETS: readonly PlanetDesign[] = [
  { name: "Ember", kind: KIND.lava, colors: ["#1a0b08", "#ff5a1f", "#ffd27a"], atmosphere: "#ff6a3a", spin: 0.7 },
  { name: "Saturn", kind: KIND.bands, colors: ["#e9d3a6", "#b98b5a", "#fff3d6"], atmosphere: "#ffe2b0", rings: "#e7cfa0", tilt: -0.38, bands: 2.4 },
  { name: "Jove", kind: KIND.storm, colors: ["#e8b583", "#a5572f", "#f6e2c7"], atmosphere: "#ffcf9e", bands: 3.2, tilt: 0.08 },
  { name: "Neptune", kind: KIND.storm, colors: ["#3a63d8", "#1d2f8f", "#a9c8ff"], atmosphere: "#6fa0ff", bands: 1.4, tilt: -0.15 },
  { name: "Gaia", kind: KIND.terran, colors: ["#0d3b7a", "#3f8f4f", "#f2f6ff"], atmosphere: "#7fb8ff", sea: 0.52, tilt: 0.4 },
  { name: "Luna", kind: KIND.rocky, colors: ["#c9c6c1", "#6f6b66", "#ffffff"], atmosphere: "#ffffff", spin: 0.5 },
  { name: "Rust", kind: KIND.rocky, colors: ["#c8613a", "#7a2f1c", "#f0b48a"], atmosphere: "#ff9a6a", tilt: 0.3 },
  { name: "Frost", kind: KIND.ice, colors: ["#e6f6ff", "#7fb6d9", "#ffffff"], atmosphere: "#bfe7ff", tilt: -0.3 },
  { name: "Veil", kind: KIND.clouds, colors: ["#f2d39a", "#c98f4f", "#fff7e0"], atmosphere: "#ffe0a0", spin: 0.6 },
  { name: "Sol", kind: KIND.star, colors: ["#ff7a1a", "#ffc13d", "#fff6d0"], atmosphere: "#ffae3a", spin: 0.8 },
  { name: "Pulsar", kind: KIND.star, colors: ["#3f6dff", "#a9c4ff", "#ffffff"], atmosphere: "#8fb2ff", spin: 1.4 },
  { name: "Aurora", kind: KIND.aurora, colors: ["#0d1b2a", "#2b4566", "#5cffc8"], atmosphere: "#3affc0", tilt: 0.25 },
  { name: "Nocturne", kind: KIND.night, colors: ["#08142e", "#1d3b2a", "#ffcf7a"], atmosphere: "#4f7dff", sea: 0.5, tilt: -0.2 },
  { name: "Coral", kind: KIND.marble, colors: ["#f38463", "#fbd3c3", "#c2414b"], atmosphere: "#ffb59c", spin: 0.6 },
  { name: "Amethyst", kind: KIND.marble, colors: ["#5b2a86", "#b38cf0", "#2a0f45"], atmosphere: "#c9a7ff", rings: "#d9c4ff", tilt: 0.5 },
  { name: "Tide", kind: KIND.terran, colors: ["#04506e", "#0aa3a3", "#e8fbff"], atmosphere: "#7ff0ff", sea: 0.66, spin: 0.8 },
  { name: "Dune", kind: KIND.bands, colors: ["#e4b67a", "#b07a44", "#f6dcb0"], atmosphere: "#ffd59a", bands: 5.5, spin: 0.5 },
  { name: "Verdant", kind: KIND.bands, colors: ["#7bc96f", "#2f6d4a", "#d8f5b0"], atmosphere: "#a8ff9a", bands: 3.6, tilt: 0.2 },
  { name: "Obsidian", kind: KIND.obsidian, colors: ["#0b0b10", "#2a2633", "#ffffff"], atmosphere: "#c8a2ff", spin: 0.4 },
  { name: "Halo", kind: KIND.bands, colors: ["#dfe6f5", "#9aa7c7", "#ffffff"], atmosphere: "#dfe9ff", rings: "#ffffff", tilt: 0.95, bands: 1.6 },
];

export const PLANET_PREFIX = "planet:";

/** The planet a bot shows: its chosen one ("planet:7"), else one derived from its id. */
export function planetIndexFor(id: string, avatar?: string | null): number {
  if (avatar?.startsWith(PLANET_PREFIX)) {
    const n = Number(avatar.slice(PLANET_PREFIX.length));
    if (Number.isInteger(n) && n >= 0 && n < PLANETS.length) return n;
  }
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % PLANETS.length;
}

/** Initials for the flat (wireframe) look: a stored avatar unless it names a planet. */
export function initialsFor(name: string, avatar?: string | null): string {
  return (avatar && !avatar.startsWith(PLANET_PREFIX) ? avatar : name[0] || "?").slice(0, 2);
}
