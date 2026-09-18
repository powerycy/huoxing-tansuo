// Separate namespace from the preserved lunar build: saves and graphics
// settings can never leak between the two projects on localhost.
const previewQuery = new URLSearchParams(globalThis.location?.search || '');
const isPreview = ['event-preview', 'station-preview', 'charger-preview', 'time-preview', 'escape-preview']
  .some((key) => previewQuery.has(key));
// Rehearsing the cinematic must never clear or overwrite the player's mission.
const KEY = 'red-regolith.mars-relay.v1' + (isPreview ? '.preview' : '');

export const Save = {
  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch { return null; }
  },
  write(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch { return false; }
  },
  clear() { try { localStorage.removeItem(KEY); } catch { /* private mode */ } },
  appearance() {
    try { return JSON.parse(localStorage.getItem(KEY + '.vehicle') || 'null'); }
    catch { return null; }
  },
  saveAppearance(value) {
    try { localStorage.setItem(KEY + '.vehicle', JSON.stringify(value)); return true; }
    catch { return false; }
  },
  settings() {
    try { return JSON.parse(localStorage.getItem(KEY + '.set') || 'null') || {}; }
    catch { return {}; }
  },
  saveSettings(s) {
    try { localStorage.setItem(KEY + '.set', JSON.stringify(s)); } catch { /* ignore */ }
  }
};
