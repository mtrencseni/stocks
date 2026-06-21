"use strict";

// Light/dark theme: a CSS-variable swap via a `light` class on <body>.
// Default is dark; the choice persists in localStorage.

const KEY = "theme.v1";

export function getTheme() {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; }
  catch (e) { return "dark"; }
}

function apply(theme) {
  document.body.classList.toggle("light", theme === "light");
  window.dispatchEvent(new CustomEvent("themechange"));   // panes redraw canvas charts
}

export function initTheme() { apply(getTheme()); }

const SUN = `<span class="tt-ico tt-sun" aria-hidden="true">☀</span>`;
const MOON = `<span class="tt-ico tt-moon" aria-hidden="true">☾</span>`;

// a sun/moon pill toggle; appearance is driven by the body.light class via CSS
export function makeThemeToggle() {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "theme-toggle";
  el.setAttribute("aria-label", "Toggle light/dark mode");
  el.innerHTML = `<span class="tt-knob"></span>${SUN}${MOON}`;
  el.addEventListener("click", () => {
    const next = document.body.classList.contains("light") ? "dark" : "light";
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  });
  return el;
}
