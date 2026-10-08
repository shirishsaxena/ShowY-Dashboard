// Per-device look: theme (auto/light/dark), card layout and the accent colour.

import { state, prefs, setPref } from './state.js';

export const DEFAULT_ACCENT = '#7c5cff';

export const LAYOUTS = ['cards', 'compact', 'list'];
export const THEMES = ['auto', 'light', 'dark'];

const prefersLight = matchMedia('(prefers-color-scheme: light)');
prefersLight.addEventListener('change', () => applyTheme());

export function applyTheme(theme = prefs.theme) {
  const resolved = theme === 'light' || theme === 'dark' ? theme : prefersLight.matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').content = resolved === 'light' ? '#f4f6fb' : '#0b0f17';
}

export function setTheme(theme) {
  setPref('theme', theme);
  applyTheme(theme);
}

export function applyLayout(layout = prefs.layout) {
  document.body.dataset.layout = LAYOUTS.includes(layout) ? layout : 'cards';
}

export function setLayout(layout) {
  setPref('layout', layout);
  applyLayout(layout);
}

export const isHexColor = (c) => /^#[0-9a-f]{6}$/i.test(c);

export function applyAccent(color) {
  document.documentElement.style.setProperty('--accent', isHexColor(color) ? color : DEFAULT_ACCENT);
}

/** Apply the saved accent and remember it so the next page load starts with the right colour. */
export function syncAccent() {
  const { accent } = state.config.settings;
  if (accent !== prefs.accent) setPref('accent', accent);
  applyAccent(accent);
}
