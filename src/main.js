import { initThemeRiver } from './modules/theme-river/index.js';
import { initPaperForce } from './modules/paper-force/index.js';
import { initButterflyPath } from './modules/butterfly-path/index.js';
import { initInstitutionMap } from './modules/institution-map/index.js';
import { initMetroMap } from './modules/metro-map/index.js';
import { getAppState, onAppStateChange, phaseLabelByYear } from './shared/app-state.js';
import { loadJson } from './shared/data-loader.js';

function shorten(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

async function initFocusPanel() {
  const yearEl = document.getElementById('focus-year');
  const phaseEl = document.getElementById('focus-phase');
  const paperEl = document.getElementById('focus-paper');
  const navYearEl = document.getElementById('nav-focus-year');
  const navThemeEl = document.getElementById('nav-focus-theme');
  const navPaperEl = document.getElementById('nav-focus-paper');

  if (!yearEl || !phaseEl || !paperEl) {
    return;
  }

  const nodes = await loadJson('./data/processed/nodes.json');
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  function render(state) {
    const node = nodeById.get(state.selectedPaperId);
    const rangeStart = Number.isFinite(state.yearRangeStart) ? state.yearRangeStart : state.year;
    const rangeEnd = Number.isFinite(state.yearRangeEnd) ? state.yearRangeEnd : state.year;
    const yearText = rangeStart !== rangeEnd ? `${rangeStart}-${rangeEnd}` : String(rangeEnd);
    const paperText = node ? shorten(node.title, 56) : '未选择论文';
    yearEl.textContent = yearText;
    phaseEl.textContent = phaseLabelByYear(rangeEnd);
    paperEl.textContent = paperText;
    if (navYearEl) navYearEl.textContent = yearText;
    if (navThemeEl) navThemeEl.textContent = state.selectedTheme || '未选择主题';
    if (navPaperEl) navPaperEl.textContent = paperText;
  }

  render(getAppState());
  onAppStateChange(({ state }) => render(state));
}

function initStoryNav() {
  const nav = document.querySelector('.story-nav');
  const toggle = document.getElementById('story-nav-toggle');
  const icon = toggle?.querySelector('.toggle-icon');

  if (!nav || !toggle || !icon) return;

  function syncToggle() {
    const collapsed = nav.classList.contains('is-collapsed');
    icon.textContent = collapsed ? '‹' : '›';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '折叠侧边栏');
  }

  toggle.addEventListener('click', () => {
    nav.classList.toggle('is-collapsed');
    syncToggle();
  });

  syncToggle();
}

export function bootstrapApp() {
  const themeRiverEl = document.getElementById('theme-river');
  const paperForceEl = document.getElementById('paper-force');
  const butterflyPathEl = document.getElementById('butterfly-path');
  const institutionMapEl = document.getElementById('institution-map');
  const metroMapEl = document.getElementById('metro-map');

  if (!themeRiverEl || !paperForceEl || !butterflyPathEl || !institutionMapEl || !metroMapEl) {
    throw new Error('Missing one or more module mount elements in index.html');
  }

  initThemeRiver(themeRiverEl);
  initPaperForce(paperForceEl);
  initButterflyPath(butterflyPathEl);
  initInstitutionMap(institutionMapEl);
  initMetroMap(metroMapEl);
  initStoryNav();
  initFocusPanel().catch(() => {
    // The charts remain usable even if the summary panel cannot load its copy.
  });
}

bootstrapApp();
