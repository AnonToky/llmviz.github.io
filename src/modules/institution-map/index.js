import { loadJson } from '../../shared/data-loader.js';
import { getAppState, onAppStateChange, setAppState } from '../../shared/app-state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const MAP_SCENARIOS = {
  leader: {
    label: '谁在主导',
    question: '哪些机构在 LLM 论文主线中最有影响力？',
    description: '看看是哪些公司、实验室和大学在主导这段研究史。力量是集中在少数玩家，还是群体推进？',
    rankTitle: '影响力排行',
    metric: 'influence_score'
  },
  paper: {
    label: '论文背后是谁',
    question: '当前选中的论文由哪些机构推动？',
    description: '选了一篇论文后，它的作者来自哪些机构？这些机构在整个故事中扮演什么角色？',
    rankTitle: '当前论文相关机构',
    metric: 'papers_count'
  },
  bridge: {
    label: '谁连接主线',
    question: '哪些机构通过引用关系把不同论文主线连接起来？',
    description: '故事的不同章节需要有人来接力。这些机构如何在不同的研究阶段和流派之间架起桥梁？',
    rankTitle: '联系强度排行',
    metric: 'link_count'
  }
};

function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
  return el;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value) return [value];
  return [];
}

function projectLonLat(lon, lat, width, height, padding) {
  return {
    x: padding + ((lon + 180) / 360) * (width - padding * 2),
    y: padding + ((90 - lat) / 180) * (height - padding * 2)
  };
}

function polygonToPath(rings, width, height, padding) {
  return rings
    .map((ring) => {
      if (!ring.length) return '';
      const head = projectLonLat(ring[0][0], ring[0][1], width, height, padding);
      const body = ring.slice(1).map(([lon, lat]) => {
        const p = projectLonLat(lon, lat, width, height, padding);
        return `L ${p.x} ${p.y}`;
      }).join(' ');
      return `M ${head.x} ${head.y} ${body} Z`;
    })
    .join(' ');
}

function geometryToPath(geometry, width, height, padding) {
  if (!geometry) return '';
  if (geometry.type === 'Polygon') return polygonToPath(geometry.coordinates, width, height, padding);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((polygon) => polygonToPath(polygon, width, height, padding)).join(' ');
  return '';
}

function mapRange(value, domainMin, domainMax, rangeMin, rangeMax) {
  if (domainMin === domainMax) return (rangeMin + rangeMax) / 2;
  return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

function clampTranslate(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampTransform(transform, bounds, viewportWidth, viewportHeight) {
  const next = { ...transform };
  const scaledWidth = (bounds.maxX - bounds.minX) * next.k;
  const scaledHeight = (bounds.maxY - bounds.minY) * next.k;

  if (scaledWidth <= viewportWidth) {
    next.x = viewportWidth / 2 - ((bounds.minX + bounds.maxX) / 2) * next.k;
  } else {
    next.x = clampTranslate(next.x, viewportWidth - bounds.maxX * next.k, -bounds.minX * next.k);
  }

  if (scaledHeight <= viewportHeight) {
    next.y = viewportHeight / 2 - ((bounds.minY + bounds.maxY) / 2) * next.k;
  } else {
    next.y = clampTranslate(next.y, viewportHeight - bounds.maxY * next.k, -bounds.minY * next.k);
  }

  return next;
}

function colorByMode(item, mode) {
  if (mode === 'org_type') {
    if (item.org_type === 'university') return '#16a34a';
    if (item.org_type === 'company') return '#d97706';
    return '#7c3aed';
  }
  return item.community === 'chinese' ? '#dc2626' : '#2563eb';
}

function createSymbol(item, radius, color) {
  if (item.org_type === 'university') {
    return createSvgElement('rect', { x: -radius, y: -radius, width: radius * 2, height: radius * 2, fill: color, class: 'map-point' });
  }
  if (item.org_type === 'research_lab') {
    return createSvgElement('path', { d: `M 0 ${-radius} L ${radius} ${radius} L ${-radius} ${radius} Z`, fill: color, class: 'map-point' });
  }
  return createSvgElement('circle', { cx: 0, cy: 0, r: radius, fill: color, class: 'map-point' });
}

function normalizeName(name, aliasLookup) {
  return aliasLookup.get(String(name || '').trim()) || String(name || '').trim();
}

function buildAliasLookup(aliasRows) {
  const lookup = new Map();
  aliasRows.forEach((row) => {
    lookup.set(row.canonical, row.canonical);
    (row.aliases || []).forEach((alias) => lookup.set(alias, row.canonical));
  });
  return lookup;
}

function normalizeNodeInstitutions(node, aliasLookup, institutionNames) {
  return Array.from(new Set(asArray(node.institution)
    .map((name) => normalizeName(name, aliasLookup))
    .filter((name) => institutionNames.has(name))));
}

function institutionId(name) {
  return `inst_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

function mergeInstitutions(rawInstitutions, aliasLookup) {
  const merged = new Map();
  rawInstitutions.forEach((item) => {
    const institution = normalizeName(item.institution, aliasLookup);
    const current = merged.get(institution);
    if (!current) {
      merged.set(institution, { ...item, id: institutionId(institution), institution });
      return;
    }
    current.papers_count += Number(item.papers_count) || 0;
    current.citations_count += Number(item.citations_count) || 0;
    current.influence_score = Math.max(current.influence_score, Number(item.influence_score) || 0);
  });
  return Array.from(merged.values());
}

function createLinkStrength(links) {
  const strength = new Map();
  links.forEach((link) => {
    strength.set(link.source, (strength.get(link.source) || 0) + link.count);
    strength.set(link.target, (strength.get(link.target) || 0) + link.count);
  });
  return strength;
}

function scenarioValue(item, scenario, linkStrength) {
  if (scenario.metric === 'link_count') return linkStrength.get(item.institution) || 0;
  return Number(item[scenario.metric]) || 0;
}

function regionOfInstitution(item) {
  if (item.lng < -30 && item.lat > 15) return 'North America';
  if (item.lng >= -30 && item.lng <= 45 && item.lat > 35) return 'Europe';
  if (item.lng >= 95 && item.lat > 15) return 'East Asia';
  if (item.lng >= 90 && item.lng <= 130) return 'Southeast Asia';
  return 'Other regions';
}

function pickBalancedInstitutions(items, scoreFn, limit = 22) {
  const sorted = items.slice().sort((a, b) => scoreFn(b) - scoreFn(a) || b.influence_score - a.influence_score);
  const regions = ['North America', 'Europe', 'East Asia', 'Southeast Asia', 'Other regions'];
  const selected = [];
  const selectedIds = new Set();

  regions.forEach((region) => {
    sorted
      .filter((item) => regionOfInstitution(item) === region)
      .slice(0, region === 'North America' ? 7 : 4)
      .forEach((item) => {
        if (selected.length < limit && !selectedIds.has(item.id)) {
          selected.push(item);
          selectedIds.add(item.id);
        }
      });
  });

  sorted.forEach((item) => {
    if (selected.length < limit && !selectedIds.has(item.id)) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  });

  return selected;
}

function buildInstitutionLinks(nodes, edges, aliasLookup, institutionNames) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const linkMap = new Map();
  edges.forEach((edge) => {
    const sourceNames = normalizeNodeInstitutions(nodeById.get(edge.source) || {}, aliasLookup, institutionNames);
    const targetNames = normalizeNodeInstitutions(nodeById.get(edge.target) || {}, aliasLookup, institutionNames);
    sourceNames.forEach((source) => {
      targetNames.forEach((target) => {
        if (source === target) return;
        const [a, b] = source < target ? [source, target] : [target, source];
        const key = `${a}__${b}`;
        if (!linkMap.has(key)) linkMap.set(key, { source: a, target: b, count: 0 });
        linkMap.get(key).count += 1;
      });
    });
  });
  return Array.from(linkMap.values()).sort((a, b) => b.count - a.count);
}

function summarizePapers(papers) {
  return papers
    .slice()
    .sort((a, b) => (b.citations_count || 0) - (a.citations_count || 0))
    .slice(0, 5)
    .map((paper) => `${paper.year}《${paper.title.length > 36 ? `${paper.title.slice(0, 35)}...` : paper.title}》`);
}

function buildYearBuckets(nodes, aliasLookup, institutionNames) {
  const years = Array.from(new Set(nodes.map((node) => Number(node.year)).filter(Number.isFinite))).sort((a, b) => a - b);
  const buckets = new Map();

  nodes.forEach((node) => {
    const year = Number(node.year);
    if (!Number.isFinite(year)) return;
    const institutionList = normalizeNodeInstitutions(node, aliasLookup, institutionNames);
    if (!buckets.has(year)) buckets.set(year, new Map());
    institutionList.forEach((name) => {
      const current = buckets.get(year).get(name) || {
        institution: name,
        papers_count: 0,
        citations_count: 0,
        year_score: 0,
        papers: []
      };
      current.papers_count += 1;
      current.citations_count += Number(node.citations_count) || 0;
      current.year_score += ((Number(node.citations_count) || 0) * 0.12) + 1;
      current.papers.push(node);
      buckets.get(year).set(name, current);
    });
  });

  return { years, buckets };
}

function formatYearLabel(year) {
  return Number.isFinite(year) ? `${year} 年` : '当前年份';
}

export async function initInstitutionMap(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="module-shell">
      <p class="module-tag">Module 04</p>
      <h3 class="module-title">故事幕后：是谁在推动这条线</h3>
      <p class="module-subtitle">机构不是背景板，而是故事背后的推进者；这里看公司、实验室和大学如何在不同年份接力。
      <div class="scenario-panel institution-scenario-panel">
        <div>
          <p class="scenario-kicker">问题场景</p>
          <h4 class="scenario-title map-question-title"></h4>
          <p class="scenario-copy map-question-copy"></p>
        </div>
        <div class="scenario-switch map-scenario-switch" role="tablist" aria-label="机构地图问题场景">
          ${Object.entries(MAP_SCENARIOS).map(([id, scenario]) => `<button class="scenario-button map-scenario" type="button" data-scenario="${id}">${scenario.label}</button>`).join('')}
        </div>
      </div>
      <div class="chart-toolbar chart-toolbar-wrap">
        <label class="chart-control map-year-control">
          年份
          <input class="chart-range map-year-range" type="range" min="0" max="0" step="1" value="0" />
          <output class="year-badge map-year-output">2026</output>
        </label>
        <label class="chart-control map-compare-toggle-control">
          <input class="map-compare-toggle" type="checkbox" />
          对比另一年
        </label>
        <label class="chart-control map-compare-year-control">
          对比年
          <input class="chart-range map-compare-year-range" type="range" min="0" max="0" step="1" value="0" disabled />
          <output class="year-badge map-compare-year-output">2025</output>
        </label>
        <label class="chart-control map-compare-filter-control">
          变化方向
          <select class="chart-select map-compare-filter" disabled>
            <option value="all">全部变化</option>
            <option value="growth">只看增长</option>
            <option value="decline">只看下降</option>
          </select>
        </label>
        <label class="chart-control">
          颜色维度
          <select class="chart-select map-color-mode">
            <option value="community">研究社区</option>
            <option value="org_type">机构类型</option>
          </select>
        </label>
        <label class="chart-control">
          大小维度
          <select class="chart-select map-size-mode">
            <option value="influence_score">影响力</option>
            <option value="citations_count">引用数</option>
            <option value="papers_count">论文数</option>
          </select>
        </label>
        <label class="chart-control">
          <input class="map-link-toggle" type="checkbox" checked />
          显示机构联系
        </label>
        <div class="chart-stat" aria-live="polite">加载中...</div>
      </div>
      <div class="institution-layout">
        <div class="module-canvas chart-canvas map-canvas">
          <svg class="chart-svg" viewBox="0 0 900 440" role="img" aria-label="Institution world map scatter chart"></svg>
        </div>
        <aside class="institution-side-panel">
          <h4 class="institution-ranking-title">机构排行榜</h4>
          <p class="institution-scenario-evidence"></p>
          <div class="institution-ranking"></div>
        </aside>
      </div>
      <div class="chart-detail map-detail"></div>
      <div class="legend-row map-legend"></div>
    </div>
  `;

  const colorModeEl = container.querySelector('.map-color-mode');
  const sizeModeEl = container.querySelector('.map-size-mode');
  const yearRangeEl = container.querySelector('.map-year-range');
  const yearOutputEl = container.querySelector('.map-year-output');
  const compareToggleEl = container.querySelector('.map-compare-toggle');
  const compareYearRangeEl = container.querySelector('.map-compare-year-range');
  const compareYearOutputEl = container.querySelector('.map-compare-year-output');
  const compareFilterEl = container.querySelector('.map-compare-filter');
  const linkToggle = container.querySelector('.map-link-toggle');
  const statEl = container.querySelector('.chart-stat');
  const svg = container.querySelector('.chart-svg');
  const detailEl = container.querySelector('.map-detail');
  const legendEl = container.querySelector('.map-legend');
  const rankingEl = container.querySelector('.institution-ranking');
  const scenarioButtons = Array.from(container.querySelectorAll('.map-scenario'));
  const questionTitleEl = container.querySelector('.map-question-title');
  const questionCopyEl = container.querySelector('.map-question-copy');
  const evidenceEl = container.querySelector('.institution-scenario-evidence');
  const rankingTitleEl = container.querySelector('.institution-ranking-title');

  if (!colorModeEl || !sizeModeEl || !yearRangeEl || !yearOutputEl || !compareToggleEl || !compareYearRangeEl || !compareYearOutputEl || !compareFilterEl || !linkToggle || !statEl || !svg || !detailEl || !legendEl || !rankingEl || !questionTitleEl || !questionCopyEl || !evidenceEl || !rankingTitleEl) return;

  try {
    const [world, rawInstitutions, nodes, edges, aliasRows] = await Promise.all([
      loadJson('./public/world.geojson'),
      loadJson('./data/processed/institutions_geo.json'),
      loadJson('./data/processed/nodes.json'),
      loadJson('./data/processed/edges.json'),
      loadJson('./data/processed/institution_aliases.json').catch(() => [])
    ]);

    const width = 900;
    const height = 440;
    const padding = 18;
    const aliasLookup = buildAliasLookup(aliasRows);
    const institutions = mergeInstitutions(rawInstitutions, aliasLookup);
    const institutionNames = new Set(institutions.map((item) => item.institution));
    const byName = new Map(institutions.map((item) => [item.institution, item]));
    const { years, buckets } = buildYearBuckets(nodes, aliasLookup, institutionNames);
    const instLinks = buildInstitutionLinks(nodes, edges, aliasLookup, institutionNames).slice(0, 55);
    const linkStrength = createLinkStrength(instLinks);
    const papersByInstitution = new Map(institutions.map((item) => [item.institution, []]));
    nodes.forEach((node) => {
      normalizeNodeInstitutions(node, aliasLookup, institutionNames).forEach((name) => {
        papersByInstitution.get(name)?.push(node);
      });
    });

    const viewport = createSvgElement('g', { class: 'map-viewport' });
    const mapLayer = createSvgElement('g');
    const anchorLayer = createSvgElement('g');
    const linkLayer = createSvgElement('g');
    const pointLayer = createSvgElement('g');
    const labelLayer = createSvgElement('g');
    viewport.append(mapLayer);
    svg.append(viewport, anchorLayer, linkLayer, pointLayer, labelLayer);

    (world.features || []).forEach((feature) => {
      const pathData = geometryToPath(feature.geometry, width, height, padding);
      if (pathData) mapLayer.appendChild(createSvgElement('path', { d: pathData, class: 'world-land' }));
    });

    let transform = { x: 0, y: 0, k: 1 };
    let panning = null;
    let positionById = new Map();
    let anchorById = new Map();
    let visibleIds = new Set();
    let activeScenarioId = 'leader';
    let compareEnabled = false;
    let compareFocus = 'all';
    const yearMin = years[0] || 2013;
    const yearMax = years[years.length - 1] || 2026;
    const initialYear = Math.min(yearMax, Math.max(yearMin, Number(getAppState().yearRangeEnd) || yearMax));
    const initialCompareYear = Math.max(yearMin, initialYear - 1);

    yearRangeEl.min = String(yearMin);
    yearRangeEl.max = String(yearMax);
    yearRangeEl.value = String(initialYear);
    yearOutputEl.textContent = String(initialYear);
    compareYearRangeEl.min = String(yearMin);
    compareYearRangeEl.max = String(yearMax);
    compareYearRangeEl.value = String(initialCompareYear);
    compareYearOutputEl.textContent = String(initialCompareYear);
    compareFilterEl.disabled = true;

    function selectedYear() {
      const year = Number(getAppState().yearRangeEnd);
      return Number.isFinite(year) ? year : initialYear;
    }

    function compareYear() {
      const year = Number(compareYearRangeEl.value);
      return Number.isFinite(year) ? year : initialCompareYear;
    }

    function yearBucket() {
      return buckets.get(selectedYear()) || new Map();
    }

    function compareBucket() {
      return buckets.get(compareYear()) || new Map();
    }

    function comparisonStatsFor(name) {
      const current = yearBucket().get(name) || { institution: name, papers_count: 0, citations_count: 0, year_score: 0, papers: [] };
      const previous = compareBucket().get(name) || { institution: name, papers_count: 0, citations_count: 0, year_score: 0, papers: [] };
      return {
        current,
        previous,
        papersDelta: current.papers_count - previous.papers_count,
        citationsDelta: current.citations_count - previous.citations_count,
        scoreDelta: current.year_score - previous.year_score
      };
    }

    function compareMatches(delta) {
      if (compareFocus === 'growth') return delta > 0;
      if (compareFocus === 'decline') return delta < 0;
      return true;
    }

    function yearStatsFor(name) {
      return yearBucket().get(name) || {
        institution: name,
        papers_count: 0,
        citations_count: 0,
        year_score: 0,
        papers: []
      };
    }

    function publishYear(year) {
      const nextYear = Math.min(yearMax, Math.max(yearMin, year));
      yearRangeEl.value = String(nextYear);
      yearOutputEl.textContent = String(nextYear);
      setAppState({ year: nextYear, yearRangeStart: nextYear, yearRangeEnd: nextYear }, 'institution-map');
    }

    function syncCompareYear(year) {
      const nextYear = Math.min(yearMax, Math.max(yearMin, year));
      compareYearRangeEl.value = String(nextYear);
      compareYearOutputEl.textContent = String(nextYear);
    }

    publishYear(initialYear);

    function activeScenario() {
      return MAP_SCENARIOS[activeScenarioId] || MAP_SCENARIOS.leader;
    }

    function selectedPaperInstitutions() {
      const paper = nodes.find((node) => node.id === getAppState().selectedPaperId);
      return new Set(normalizeNodeInstitutions(paper || {}, aliasLookup, institutionNames));
    }

    function selectedInstitution() {
      const selectedId = getAppState().selectedInstitutionId;
      return institutions.find((item) => item.id === selectedId) || institutions[0];
    }

    function toScreen(position) {
      return { x: transform.x + position.x * transform.k, y: transform.y + position.y * transform.k };
    }

    function computePositions(items, radiusById) {
      const positions = new Map();
      anchorById = new Map();
      items.forEach((item, index) => {
        const anchor = projectLonLat(item.lng, item.lat, width, height, padding);
        anchorById.set(item.id, anchor);
        positions.set(item.id, { ...anchor, index });
      });

      for (let iteration = 0; iteration < 90; iteration += 1) {
        for (let i = 0; i < items.length; i += 1) {
          for (let j = i + 1; j < items.length; j += 1) {
            const a = items[i];
            const b = items[j];
            const pa = positions.get(a.id);
            const pb = positions.get(b.id);
            let dx = pb.x - pa.x;
            let dy = pb.y - pa.y;
            let distance = Math.hypot(dx, dy);
            if (distance < 0.01) {
              const angle = (i + j + 1) * 2.399963;
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              distance = 1;
            }
            const minDistance = (radiusById.get(a.id) || 7) + (radiusById.get(b.id) || 7) + 9;
            if (distance >= minDistance) continue;
            const push = (minDistance - distance) / 2;
            const ux = dx / distance;
            const uy = dy / distance;
            pa.x -= ux * push;
            pa.y -= uy * push;
            pb.x += ux * push;
            pb.y += uy * push;
          }
        }

        items.forEach((item) => {
          const position = positions.get(item.id);
          const anchor = anchorById.get(item.id);
          position.x += (anchor.x - position.x) * 0.035;
          position.y += (anchor.y - position.y) * 0.035;
          position.x = clampTranslate(position.x, padding, width - padding);
          position.y = clampTranslate(position.y, padding, height - padding);
        });
      }

      return positions;
    }

    function updateOverlayPositions() {
      anchorLayer.querySelectorAll('.map-anchor-line').forEach((line) => {
        const id = line.getAttribute('data-id');
        const anchor = anchorById.get(id);
        const position = positionById.get(id);
        if (!anchor || !position) return;
        const a = toScreen(anchor);
        const b = toScreen(position);
        line.setAttribute('x1', a.x);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x);
        line.setAttribute('y2', b.y);
      });
      anchorLayer.querySelectorAll('.map-anchor-dot').forEach((dot) => {
        const anchor = anchorById.get(dot.getAttribute('data-id'));
        if (!anchor) return;
        const p = toScreen(anchor);
        dot.setAttribute('cx', p.x);
        dot.setAttribute('cy', p.y);
      });
      linkLayer.querySelectorAll('.map-institution-link').forEach((line) => {
        const sourcePos = positionById.get(line.getAttribute('data-source-id'));
        const targetPos = positionById.get(line.getAttribute('data-target-id'));
        if (!sourcePos || !targetPos) return;
        const a = toScreen(sourcePos);
        const b = toScreen(targetPos);
        line.setAttribute('x1', a.x);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x);
        line.setAttribute('y2', b.y);
      });
      pointLayer.querySelectorAll('.map-point-group').forEach((group) => {
        const pos = positionById.get(group.getAttribute('data-id'));
        if (!pos) return;
        const p = toScreen(pos);
        group.setAttribute('transform', `translate(${p.x} ${p.y})`);
      });
      labelLayer.querySelectorAll('.map-label').forEach((label) => {
        const pos = positionById.get(label.getAttribute('data-id'));
        if (!pos) return;
        const p = toScreen(pos);
        const radius = Number(label.getAttribute('data-radius')) || 0;
        label.setAttribute('x', p.x + radius + 4);
        label.setAttribute('y', p.y - radius - 2);
      });
    }

    function applyTransform() {
      transform = clampTransform(transform, { minX: 0, maxX: width, minY: 0, maxY: height }, width, height);
      viewport.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.k})`);
      updateOverlayPositions();
    }

    function visibleInstitutions() {
      const relatedNames = selectedPaperInstitutions();
      const yearItems = Array.from(yearBucket().values())
        .map((item) => byName.get(item.institution) || item)
        .filter(Boolean);
      let top;
      if (compareEnabled) {
        const comparedItems = (yearItems.length ? yearItems : institutions)
          .filter((item) => compareMatches(comparisonStatsFor(item.institution).scoreDelta));
        top = pickBalancedInstitutions(
          comparedItems.length ? comparedItems : yearItems.length ? yearItems : institutions,
          (item) => Math.abs(comparisonStatsFor(item.institution).scoreDelta)
        );
      } else if (activeScenarioId === 'bridge') {
        top = pickBalancedInstitutions(yearItems, (item) => yearStatsFor(item.institution).year_score);
      } else if (activeScenarioId === 'paper' && relatedNames.size) {
        top = pickBalancedInstitutions(yearItems, (item) => (relatedNames.has(item.institution) ? 1000 : 0) + yearStatsFor(item.institution).papers_count);
      } else {
        top = pickBalancedInstitutions(yearItems.length ? yearItems : institutions, (item) => yearStatsFor(item.institution).year_score);
      }
      relatedNames.forEach((name) => {
        const item = byName.get(name);
        if (item && !top.some((candidate) => candidate.id === item.id)) top.push(item);
      });
      return top;
    }

    function renderScenario() {
      const scenario = activeScenario();
      questionTitleEl.textContent = scenario.question;
      questionCopyEl.textContent = scenario.description;
      rankingTitleEl.textContent = scenario.rankTitle;
      scenarioButtons.forEach((button) => {
        const active = button.dataset.scenario === activeScenarioId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      });
      const paperInsts = selectedPaperInstitutions();
      if (compareEnabled) {
        const topRise = Array.from(yearBucket().values())
          .map((item) => ({ name: item.institution, delta: comparisonStatsFor(item.institution).papersDelta }))
          .filter((item) => compareMatches(item.delta))
          .sort((a, b) => b.delta - a.delta)[0];
        evidenceEl.textContent = topRise
          ? `${formatYearLabel(selectedYear())}对比 ${compareYear()} 年，增长最快的是 ${topRise.name}（+${topRise.delta} 篇）。`
          : `${formatYearLabel(selectedYear())}暂无可对比的机构变化。`;
      } else if (activeScenarioId === 'paper') {
        evidenceEl.textContent = paperInsts.size
          ? `${formatYearLabel(selectedYear())}当前论文关联 ${paperInsts.size} 个已归一化机构。`
          : '先在论文网络、路径图或地铁图中选中论文，可查看其机构归属。';
      } else if (activeScenarioId === 'bridge') {
        evidenceEl.textContent = `${formatYearLabel(selectedYear())}基于 ${instLinks.length} 条机构共同引用联系计算。`;
      } else {
        const top = Array.from(yearBucket().values()).sort((a, b) => b.year_score - a.year_score || b.papers_count - a.papers_count)[0];
        evidenceEl.textContent = top ? `${formatYearLabel(selectedYear())}主要论文来源：${top.institution}。` : `${formatYearLabel(selectedYear())}暂无论文数据。`;
      }
    }

    function renderLegend() {
      legendEl.innerHTML = '';
      const items = colorModeEl.value === 'community'
        ? [['#2563eb', '英文社区'], ['#dc2626', '中文社区']]
        : [['#d97706', '公司'], ['#16a34a', '大学'], ['#7c3aed', '研究实验室']];
      items.forEach(([color, label]) => {
        const chip = document.createElement('span');
        chip.className = 'legend-chip map-legend-chip';
        chip.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${label}`;
        legendEl.appendChild(chip);
      });
      ['圆形=公司', '方形=大学', '三角=研究实验室', '细线=真实地理锚点', '描边=当前论文机构'].forEach((label) => {
        const chip = document.createElement('span');
        chip.className = 'legend-chip';
        chip.textContent = label;
        legendEl.appendChild(chip);
      });
    }

    function renderLinks() {
      linkLayer.innerHTML = '';
      if (!linkToggle.checked) return;
      const paperInsts = selectedPaperInstitutions();
      const filtered = instLinks.filter((link) => {
        const source = byName.get(link.source);
        const target = byName.get(link.target);
        return source && target && visibleIds.has(source.id) && visibleIds.has(target.id);
      });
      const maxCount = Math.max(...filtered.map((link) => link.count), 1);
      filtered.forEach((link) => {
        const source = byName.get(link.source);
        const target = byName.get(link.target);
        const a = toScreen(positionById.get(source.id) || projectLonLat(source.lng, source.lat, width, height, padding));
        const b = toScreen(positionById.get(target.id) || projectLonLat(target.lng, target.lat, width, height, padding));
        const active = paperInsts.has(link.source) || paperInsts.has(link.target);
        const line = createSvgElement('line', {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          class: active ? 'map-institution-link is-active' : 'map-institution-link',
          'stroke-width': mapRange(link.count, 1, maxCount, 0.8, 4),
          'data-source-id': source.id,
          'data-target-id': target.id
        });
        linkLayer.appendChild(line);
      });
    }

    function renderRanking() {
      const paperInsts = selectedPaperInstitutions();
      const yearItems = Array.from(yearBucket().values());
      rankingEl.innerHTML = '';
      const candidates = (yearItems.length ? yearItems : institutions.map((item) => ({
        institution: item.institution,
        papers_count: 0,
        citations_count: 0,
        year_score: 0,
        papers: []
      })))
        .filter((item) => !compareEnabled || compareMatches(comparisonStatsFor(item.institution).scoreDelta))
        .sort((a, b) => {
          if (compareEnabled) {
            const deltaA = Math.abs(comparisonStatsFor(a.institution).scoreDelta);
            const deltaB = Math.abs(comparisonStatsFor(b.institution).scoreDelta);
            return deltaB - deltaA || comparisonStatsFor(b.institution).papersDelta - comparisonStatsFor(a.institution).papersDelta;
          }
          const relatedDiff = activeScenarioId === 'paper'
            ? Number(paperInsts.has(b.institution)) - Number(paperInsts.has(a.institution))
            : 0;
          const scoreA = activeScenarioId === 'bridge' ? yearStatsFor(a.institution).year_score : activeScenarioId === 'paper' ? yearStatsFor(a.institution).papers_count : yearStatsFor(a.institution).year_score;
          const scoreB = activeScenarioId === 'bridge' ? yearStatsFor(b.institution).year_score : activeScenarioId === 'paper' ? yearStatsFor(b.institution).papers_count : yearStatsFor(b.institution).year_score;
          return relatedDiff || scoreB - scoreA || b.papers_count - a.papers_count || b.citations_count - a.citations_count;
        })
        .slice(0, 12)
        .forEach((item, index) => {
          const row = document.createElement('button');
          const institution = byName.get(item.institution) || institutions.find((candidate) => candidate.institution === item.institution);
          row.type = 'button';
          row.className = paperInsts.has(item.institution) ? 'institution-rank-row is-related' : 'institution-rank-row';
          const value = compareEnabled
            ? comparisonStatsFor(item.institution).papersDelta
            : activeScenarioId === 'bridge'
              ? yearStatsFor(item.institution).year_score
              : activeScenarioId === 'paper'
                ? yearStatsFor(item.institution).papers_count
                : yearStatsFor(item.institution).year_score;
          row.innerHTML = compareEnabled
            ? `<span>${index + 1}</span><strong>${item.institution}</strong><em>${value > 0 ? '+' : ''}${Math.round(value)}</em>`
            : `<span>${index + 1}</span><strong>${item.institution}</strong><em>${Math.round(value)}</em>`;
          if (institution) {
            row.addEventListener('click', () => setAppState({ selectedInstitutionId: institution.id }, 'institution-map'));
          }
          rankingEl.appendChild(row);
        });
    }

    function renderDetail() {
      const selected = selectedInstitution();
      if (!selected) {
        detailEl.textContent = '没有可用机构数据。';
        return;
      }
      const currentStats = yearStatsFor(selected.institution);
      const deltaStats = comparisonStatsFor(selected.institution);
      const papers = currentStats.papers || [];
      const selectedPaper = nodes.find((node) => node.id === getAppState().selectedPaperId);
      const selectedPaperText = selectedPaper
        ? `当前选中论文《${selectedPaper.title}》${selectedPaperInstitutions().has(selected.institution) ? '属于该机构。' : '暂未归到该机构。'}`
        : '尚未选中论文。';
      const paperText = summarizePapers(papers).join('；') || '暂无可展示论文';
      const linkText = `机构联系强度 ${linkStrength.get(selected.institution) || 0}`;
      const compareText = compareEnabled
        ? `<br />对比 ${compareYear()} 年：论文 ${deltaStats.papersDelta > 0 ? '+' : ''}${deltaStats.papersDelta}，引用 ${deltaStats.citationsDelta > 0 ? '+' : ''}${Math.round(deltaStats.citationsDelta)}，活跃度 ${deltaStats.scoreDelta > 0 ? '+' : ''}${Math.round(deltaStats.scoreDelta)}`
        : '';
      detailEl.innerHTML = `<strong>${selected.institution}</strong> · ${selected.city}, ${selected.country}<br />${formatYearLabel(selectedYear())}论文数 ${currentStats.papers_count}，引用数 ${currentStats.citations_count.toLocaleString()}，活跃度 ${Math.round(currentStats.year_score)}，类型 ${selected.org_type}，${linkText}。${compareText}<br />${selectedPaperText}<br />本年代表论文：${paperText}`;
    }

    function renderPoints() {
      const colorMode = colorModeEl.value;
      const sizeMode = sizeModeEl.value;
      const visible = visibleInstitutions();
      const selectedNames = selectedPaperInstitutions();
      visibleIds = new Set(visible.map((item) => item.id));
      pointLayer.innerHTML = '';
      labelLayer.innerHTML = '';
      anchorLayer.innerHTML = '';
      const values = visible.map((item) => {
        const stats = compareEnabled ? comparisonStatsFor(item.institution) : yearStatsFor(item.institution);
        return compareEnabled
          ? (sizeMode === 'citations_count' ? Math.abs(stats.citationsDelta) : Math.abs(stats.scoreDelta))
          : (sizeMode === 'papers_count' ? stats.papers_count : sizeMode === 'citations_count' ? stats.citations_count : stats.year_score);
      });
      const minValue = Math.min(...values);
      const maxValue = Math.max(...values);
      const radiusById = new Map(visible.map((item) => {
        const stats = compareEnabled ? comparisonStatsFor(item.institution) : yearStatsFor(item.institution);
        const value = compareEnabled
          ? (sizeMode === 'papers_count' ? Math.abs(stats.papersDelta) : sizeMode === 'citations_count' ? Math.abs(stats.citationsDelta) : Math.abs(stats.scoreDelta))
          : sizeMode === 'papers_count'
            ? stats.papers_count
            : sizeMode === 'citations_count'
              ? stats.citations_count
              : stats.year_score;
        return [item.id, mapRange(value, minValue, maxValue, 4, 11)];
      }));
      positionById = computePositions(visible, radiusById);
      visible.forEach((item) => {
        const radius = radiusById.get(item.id);
        const stats = compareEnabled ? comparisonStatsFor(item.institution) : yearStatsFor(item.institution);
        const anchor = anchorById.get(item.id);
        const projected = positionById.get(item.id);
        if (anchor && projected && Math.hypot(projected.x - anchor.x, projected.y - anchor.y) > 3) {
          anchorLayer.appendChild(createSvgElement('line', { class: 'map-anchor-line', 'data-id': item.id }));
          anchorLayer.appendChild(createSvgElement('circle', { class: 'map-anchor-dot', 'data-id': item.id, r: 2.1 }));
        }
        const position = toScreen(positionById.get(item.id) || projectLonLat(item.lng, item.lat, width, height, padding));
        const group = createSvgElement('g', { class: 'map-point-group', 'data-id': item.id, transform: `translate(${position.x} ${position.y})`, tabindex: '0', role: 'button' });
        const symbol = createSymbol(item, radius, colorByMode(item, colorMode));
        symbol.setAttribute('data-id', item.id);
        symbol.classList.toggle('is-related', selectedNames.has(item.institution));
        symbol.classList.toggle('is-selected', getAppState().selectedInstitutionId === item.id);
        if (compareEnabled) {
          const delta = stats.papersDelta;
          symbol.classList.toggle('is-growth', delta > 0);
          symbol.classList.toggle('is-decline', delta < 0);
        }
        const title = createSvgElement('title');
        title.textContent = compareEnabled
          ? `${item.institution}\n${item.country}\n对比 ${selectedYear()} vs ${compareYear()}\n论文变化: ${stats.papersDelta > 0 ? '+' : ''}${stats.papersDelta}\n引用变化: ${Math.round(stats.citationsDelta) > 0 ? '+' : ''}${Math.round(stats.citationsDelta)}`
          : `${item.institution}\n${item.country}\n${formatYearLabel(selectedYear())}${sizeMode === 'papers_count' ? `论文数: ${stats.papers_count}` : sizeMode === 'citations_count' ? `引用数: ${stats.citations_count}` : `活跃度: ${Math.round(stats.year_score)}`}`;
        symbol.appendChild(title);
        group.appendChild(symbol);
        group.addEventListener('pointerdown', (event) => event.stopPropagation());
        group.addEventListener('click', () => setAppState({ selectedInstitutionId: item.id }, 'institution-map'));
        group.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setAppState({ selectedInstitutionId: item.id }, 'institution-map');
          }
        });
        pointLayer.appendChild(group);

        if (selectedNames.has(item.institution) || item.influence_score >= 68) {
          const label = createSvgElement('text', { class: 'map-label', 'data-id': item.id, 'data-radius': radius });
          label.textContent = item.institution;
          labelLayer.appendChild(label);
        }
      });
      statEl.textContent = `${formatYearLabel(selectedYear())}可见机构 ${visible.length}/${yearBucket().size || institutions.length} · 归一化别名 ${aliasLookup.size} 个 · 联系 ${instLinks.length} 条`;
      if (compareEnabled) {
        statEl.textContent = `${formatYearLabel(selectedYear())}对比 ${compareYear()} 年 · 可见机构 ${visible.length}/${yearBucket().size || institutions.length} · 归一化别名 ${aliasLookup.size} 个 · 联系 ${instLinks.length} 条`;
      }
      renderScenario();
      renderLinks();
      renderRanking();
      renderLegend();
      renderDetail();
      updateOverlayPositions();
    }

    yearRangeEl.addEventListener('input', () => {
      publishYear(Number(yearRangeEl.value));
    });
    compareToggleEl.addEventListener('change', () => {
      compareEnabled = compareToggleEl.checked;
      compareYearRangeEl.disabled = !compareEnabled;
      compareFilterEl.disabled = !compareEnabled;
      renderPoints();
    });
    compareYearRangeEl.addEventListener('input', () => {
      syncCompareYear(Number(compareYearRangeEl.value));
      if (compareEnabled) renderPoints();
    });
    compareFilterEl.addEventListener('change', () => {
      compareFocus = compareFilterEl.value;
      if (compareEnabled) renderPoints();
    });
    colorModeEl.addEventListener('change', renderPoints);
    sizeModeEl.addEventListener('change', renderPoints);
    linkToggle.addEventListener('change', renderPoints);
    scenarioButtons.forEach((button) => {
      button.addEventListener('click', () => {
        activeScenarioId = button.dataset.scenario || 'leader';
        if (activeScenarioId === 'bridge') sizeModeEl.value = 'papers_count';
        if (activeScenarioId === 'leader' && sizeModeEl.value === 'influence_score') sizeModeEl.value = 'papers_count';
        renderPoints();
      });
    });
    onAppStateChange(({ state }) => {
      if (Number.isFinite(state.yearRangeEnd) && String(state.yearRangeEnd) !== yearRangeEl.value) {
        yearRangeEl.value = String(state.yearRangeEnd);
        yearOutputEl.textContent = String(state.yearRangeEnd);
      }
      renderPoints();
    });
    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      const py = ((event.clientY - rect.top) / rect.height) * height;
      const nextK = Math.max(0.7, Math.min(4, transform.k * (event.deltaY > 0 ? 0.9 : 1.1)));
      transform.x = px - ((px - transform.x) / transform.k) * nextK;
      transform.y = py - ((py - transform.y) / transform.k) * nextK;
      transform.k = nextK;
      applyTransform();
    }, { passive: false });
    svg.addEventListener('pointerdown', (event) => {
      panning = { lastX: event.clientX, lastY: event.clientY };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', (event) => {
      if (!panning) return;
      transform.x += event.clientX - panning.lastX;
      transform.y += event.clientY - panning.lastY;
      panning.lastX = event.clientX;
      panning.lastY = event.clientY;
      applyTransform();
    });
    svg.addEventListener('pointerup', () => { panning = null; });
    svg.addEventListener('pointerleave', () => { panning = null; });

    applyTransform();
    renderPoints();
  } catch (error) {
    statEl.textContent = '数据加载失败，请检查 institutions_geo.json、institution_aliases.json、nodes.json、edges.json 与 world.geojson';
    svg.innerHTML = '';
  }
}
