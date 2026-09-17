// Run: node tools/check-scene-integration.mjs
// Storage and entry-point regressions; GPU output is checked in the browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const records = new Map();
globalThis.localStorage = {
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => records.set(key, value),
  removeItem: (key) => records.delete(key),
};
globalThis.location = { search: '' };
const { Save: mission } = await import('../src/core/save.js?mission-check');
mission.write({ delivery: { stage: 'return' }, power: 43 });
const original = JSON.stringify(mission.read());
globalThis.location.search = '?event-preview=1';
const { Save: preview } = await import('../src/core/save.js?preview-check');
assert.equal(preview.read(), null);
preview.write({ delivery: { stage: 'relay' }, power: 99 });
assert.equal(JSON.stringify(mission.read()), original, 'preview must not overwrite a mission');
preview.clear();
assert.equal(JSON.stringify(mission.read()), original, 'preview restart must not clear a mission');

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
assert.match(main, /const PORTER_MODE = false/);
assert.match(main, /uRShadowMat\.value = sh\.matrix/);
assert.doesNotMatch(main, /engine\.sun\.intensity = App\.keyIntensity \* lerp/);
assert.match(main, /rupture\.updateCinematic\?\.\(dt\)/);
assert.match(main, /boost: !controlsLocked && !!raw\.boost, cinematicHold: cinematic/);
assert.match(main, /App\.porter \|\| controlsLocked \? \[\] : rover\.wheels/);
assert.match(main, /if \(App\.state === ST\.PLAY\) stepWorld\(dt, raw, input\)/);
assert.doesNotMatch(main, /App\.engine\.bloom\.enabled = !!i/);
const tide = await readFile(new URL('../src/world/flower-tide.js', import.meta.url), 'utf8');
assert.match(tide, /this\.fireflies = new GrassFireflies\(/);
assert.match(tide, /this\.fireflies\.update\(\{ \.\.\.vegetationState, phase: this\.phase \}\)/,
  'fireflies receive the same time, grass growth, maturity and fade as vegetation');
console.log('PASS: preview save isolation, rover-only entry, cinematic/boost wiring, stable lighting guards');
