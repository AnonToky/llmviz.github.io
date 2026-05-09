import { loadJson } from '../../shared/data-loader.js';
import { getAppState, onAppStateChange, setAppState } from '../../shared/app-state.js';
import { createInteractiveTooltip, escapeHtml, institutionLink } from '../../shared/interactive-tooltip.js';
import { themePapers } from '../../shared/theme-filter.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

/* ── Map projection (Equirectangular with slight Y compression for aesthetics) ── */
function projectLonLat(lon, lat, width, height, padding) {
  const x = padding + ((lon + 180) / 360) * (width - padding * 2);
  const y = padding + ((90 - lat) / 160) * (height - padding * 2); // compress poles
  return { x, y };
}

function polygonToPath(rings, width, height, padding) {
  return rings
    .map((ring) => {
      if (!ring.length) return '';
      const head = projectLonLat(ring[0][0], ring[0][1], width, height, padding);
      const body = ring.slice(1).map(([lon, lat]) => {
        const p = projectLonLat(lon, lat, width, height, padding);
        return `L${p.x},${p.y}`;
      }).join(' ');
      return `M${head.x},${head.y} ${body}Z`;
    })
    .join(' ');
}

function geometryToPath(geometry, width, height, padding) {
  if (!geometry) return '';
  if (geometry.type === 'Polygon') return polygonToPath(geometry.coordinates, width, height, padding);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p) => polygonToPath(p, width, height, padding)).join(' ');
  return '';
}

function mapRange(value, domainMin, domainMax, rangeMin, rangeMax) {
  if (domainMin === domainMax) return (rangeMin + rangeMax) / 2;
  return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

/* ── Graticule generation ── */
function generateGraticule(width, height, padding) {
  const paths = [];
  // Latitude lines every 30°
  for (let lat = -60; lat <= 80; lat += 30) {
    let d = '';
    for (let lon = -180; lon <= 180; lon += 5) {
      const p = projectLonLat(lon, lat, width, height, padding);
      d += (lon === -180 ? 'M' : 'L') + `${p.x},${p.y}`;
    }
    paths.push(d);
  }
  // Longitude lines every 60°
  for (let lon = -180; lon <= 180; lon += 60) {
    let d = '';
    for (let lat = -70; lat <= 85; lat += 5) {
      const p = projectLonLat(lon, lat, width, height, padding);
      d += (lat === -70 ? 'M' : 'L') + `${p.x},${p.y}`;
    }
    paths.push(d);
  }
  return paths;
}

/* ── Alias & normalization utilities ── */
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

/* ── Color helpers ── */
function colorByMode(item, mode) {
  if (mode === 'org_type') {
    if (item.org_type === 'university') return '#10b981';
    if (item.org_type === 'company') return '#f59e0b';
    return '#8b5cf6';
  }
  return item.community === 'chinese' ? '#ef4444' : '#3b82f6';
}

function createSymbol(item, radius, color) {
  if (item.org_type === 'university') {
    return createSvgElement('rect', { x: -radius, y: -radius, width: radius * 2, height: radius * 2, rx: 2, fill: color, class: 'map-point' });
  }
  if (item.org_type === 'research_lab') {
    const r = radius;
    return createSvgElement('path', { d: `M0,${-r} L${r},${r} L${-r},${r}Z`, fill: color, class: 'map-point' });
  }
  return createSvgElement('circle', { cx: 0, cy: 0, r: radius, fill: color, class: 'map-point' });
}

/* ── Build year-indexed paper map ── */
function buildPapersByYearAndInstitution(nodes, aliasLookup, institutionNames) {
  // Map<year, Map<institutionName, paperNode[]>>
  const yearMap = new Map();
  nodes.forEach((node) => {
    const year = node.year;
    if (!year) return;
    if (!yearMap.has(year)) yearMap.set(year, new Map());
    const instMap = yearMap.get(year);
    normalizeNodeInstitutions(node, aliasLookup, institutionNames).forEach((name) => {
      if (!instMap.has(name)) instMap.set(name, []);
      instMap.get(name).push(node);
    });
  });
  return yearMap;
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

/* ── Overlap resolver ── */
function computePositions(items, radiusById, width, height, padding) {
  const positions = new Map();
  const anchorById = new Map();
  items.forEach((item) => {
    const anchor = projectLonLat(item.lng, item.lat, width, height, padding);
    anchorById.set(item.id, anchor);
    positions.set(item.id, { ...anchor });
  });

  for (let iteration = 0; iteration < 60; iteration += 1) {
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
        const minDist = (radiusById.get(a.id) || 6) + (radiusById.get(b.id) || 6) + 8;
        if (distance >= minDist) continue;
        const push = (minDist - distance) / 2;
        const ux = dx / distance;
        const uy = dy / distance;
        pa.x -= ux * push;
        pa.y -= uy * push;
        pb.x += ux * push;
        pb.y += uy * push;
      }
    }
    items.forEach((item) => {
      const pos = positions.get(item.id);
      const anchor = anchorById.get(item.id);
      pos.x += (anchor.x - pos.x) * 0.04;
      pos.y += (anchor.y - pos.y) * 0.04;
      pos.x = Math.max(padding, Math.min(width - padding, pos.x));
      pos.y = Math.max(padding, Math.min(height - padding, pos.y));
    });
  }

  return { positions, anchorById };
}

/* ════════════════════════════════════════════
   MAIN INIT
════════════════════════════════════════════ */
export async function initInstitutionMap(container) {
  if (!container) return;

  const MIN_YEAR = 2013;
  const MAX_YEAR = 2026;

  container.innerHTML = `
    <div class="module-shell">
      <p class="module-tag">Module 04</p>
      <h3 class="module-title">机构发表时间线地图</h3>
      <p class="module-subtitle">通过年份筛选，查看每年有哪些机构发表了 LLM 相关论文，观察研究力量的时空变化。</p>

      <div class="scenario-panel institution-scenario-panel">
        <div class="map-year-control">
          <div class="map-year-header">
            <span class="map-year-label">筛选年份</span>
            <span class="map-year-value">${MIN_YEAR} – ${MAX_YEAR}</span>
          </div>
          <div class="map-range-row">
            <input type="range" class="map-year-start" min="${MIN_YEAR}" max="${MAX_YEAR}" value="${MIN_YEAR}" step="1" />
            <input type="range" class="map-year-end" min="${MIN_YEAR}" max="${MAX_YEAR}" value="${MAX_YEAR}" step="1" />
          </div>
          <div class="map-year-ticks">
            ${Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => `<span>${MIN_YEAR + i}</span>`).join('')}
          </div>
          <div class="map-play-row">
            <button class="map-play-btn" type="button" title="自动播放年份动画">&#9654; 播放</button>
            <label class="map-cumulative-label"><input type="checkbox" class="map-cumulative" checked /> 累计模式</label>
          </div>
        </div>
      </div>

      <div class="chart-toolbar chart-toolbar-wrap">
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
            <option value="papers_in_range">年份内论文数</option>
            <option value="influence_score">影响力</option>
            <option value="citations_count">总引用数</option>
            <option value="papers_count">总论文数</option>
          </select>
        </label>
        <label class="chart-control">
          <input class="map-link-toggle" type="checkbox" checked />
          显示合作联系
        </label>
        <div class="chart-stat" aria-live="polite">加载中...</div>
      </div>

      <div class="institution-layout">
        <div class="module-canvas chart-canvas map-canvas">
          <svg class="chart-svg map-svg" viewBox="0 0 960 480" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Institution world map"></svg>
        </div>
        <aside class="institution-side-panel">
          <h4 class="institution-ranking-title">年份活跃机构排行</h4>
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
  const linkToggle = container.querySelector('.map-link-toggle');
  const statEl = container.querySelector('.chart-stat');
  const svg = container.querySelector('.map-svg');
  const canvas = container.querySelector('.map-canvas');
  const detailEl = container.querySelector('.map-detail');
  const legendEl = container.querySelector('.map-legend');
  const rankingEl = container.querySelector('.institution-ranking');
  const yearValueEl = container.querySelector('.map-year-value');
  const yearStartEl = container.querySelector('.map-year-start');
  const yearEndEl = container.querySelector('.map-year-end');
  const playBtn = container.querySelector('.map-play-btn');
  const cumulativeEl = container.querySelector('.map-cumulative');
  const evidenceEl = container.querySelector('.institution-scenario-evidence');

  if (!svg || !canvas || !statEl) return;

  try {
    const [world, rawInstitutions, nodes, edges, aliasRows] = await Promise.all([
      loadJson('./public/world.geojson'),
      loadJson('./data/processed/institutions_geo.json'),
      loadJson('./data/processed/nodes.json'),
      loadJson('./data/processed/edges.json'),
      loadJson('./data/processed/institution_aliases.json').catch(() => [])
    ]);

    const width = 960;
    const height = 480;
    const padding = 20;
    const aliasLookup = buildAliasLookup(aliasRows);
    const tooltip = createInteractiveTooltip(canvas);
    const institutions = mergeInstitutions(rawInstitutions, aliasLookup);
    const institutionNames = new Set(institutions.map((item) => item.institution));
    const byName = new Map(institutions.map((item) => [item.institution, item]));
    const papersByYearInst = buildPapersByYearAndInstitution(nodes, aliasLookup, institutionNames);
    const instLinks = buildInstitutionLinks(nodes, edges, aliasLookup, institutionNames).slice(0, 60);

    /* ── Draw base map ── */
    // Ocean background
    svg.appendChild(createSvgElement('rect', { x: 0, y: 0, width, height, class: 'map-ocean', rx: 6 }));

    // Graticule
    const gratGroup = createSvgElement('g', { class: 'map-graticule-group' });
    generateGraticule(width, height, padding).forEach((d) => {
      gratGroup.appendChild(createSvgElement('path', { d, class: 'map-graticule' }));
    });
    svg.appendChild(gratGroup);

    // Land
    const landGroup = createSvgElement('g', { class: 'map-land-group' });
    (world.features || []).forEach((feature) => {
      const pathData = geometryToPath(feature.geometry, width, height, padding);
      if (pathData) landGroup.appendChild(createSvgElement('path', { d: pathData, class: 'world-land' }));
    });
    svg.appendChild(landGroup);

    // Layers
    const linkLayer = createSvgElement('g', { class: 'map-link-layer' });
    const pointLayer = createSvgElement('g', { class: 'map-point-layer' });
    const labelLayer = createSvgElement('g', { class: 'map-label-layer' });
    svg.append(linkLayer, pointLayer, labelLayer);

    /* ── State ── */
    let filterStart = MIN_YEAR;
    let filterEnd = MAX_YEAR;
    let playing = false;
    let playTimer = null;

    /* ── Compute which institutions are active in the year range ── */
    function getActiveInstitutions() {
      const cumulative = cumulativeEl.checked;
      const activeMap = new Map(); // name -> paper count in range

      for (let y = (cumulative ? MIN_YEAR : filterStart); y <= filterEnd; y += 1) {
        const yearInst = papersByYearInst.get(y);
        if (!yearInst) continue;
        yearInst.forEach((papers, name) => {
          activeMap.set(name, (activeMap.get(name) || 0) + papers.length);
        });
      }
      return activeMap;
    }

    function render() {
      pointLayer.innerHTML = '';
      labelLayer.innerHTML = '';
      linkLayer.innerHTML = '';

      const colorMode = colorModeEl.value;
      const sizeMode = sizeModeEl.value;
      const showLinks = linkToggle.checked;
      const activeMap = getActiveInstitutions();

      // Filter institutions that have papers in range
      const visible = institutions.filter((item) => activeMap.has(item.institution));

      if (visible.length === 0) {
        statEl.textContent = `${filterStart}–${filterEnd} 年份内无机构发表记录`;
        rankingEl.innerHTML = '<p style="color:var(--muted)">该年份范围无数据</p>';
        detailEl.innerHTML = '';
        return;
      }

      // Compute sizes
      const sizeValues = visible.map((item) => {
        if (sizeMode === 'papers_in_range') return activeMap.get(item.institution) || 0;
        return Number(item[sizeMode]) || 0;
      });
      const minVal = Math.min(...sizeValues);
      const maxVal = Math.max(...sizeValues);
      const radiusById = new Map(visible.map((item, i) => [item.id, mapRange(sizeValues[i], minVal, maxVal, 5, 16)]));

      // Positions
      const { positions, anchorById } = computePositions(visible, radiusById, width, height, padding);

      // Draw links
      if (showLinks) {
        const visibleIds = new Set(visible.map((item) => item.id));
        const filtered = instLinks.filter((link) => {
          const s = byName.get(link.source);
          const t = byName.get(link.target);
          return s && t && visibleIds.has(s.id) && visibleIds.has(t.id);
        });
        const maxCount = Math.max(...filtered.map((l) => l.count), 1);
        filtered.slice(0, 40).forEach((link) => {
          const s = byName.get(link.source);
          const t = byName.get(link.target);
          const pa = positions.get(s.id);
          const pb = positions.get(t.id);
          if (!pa || !pb) return;
          const line = createSvgElement('line', {
            x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
            class: 'map-institution-link',
            'stroke-width': mapRange(link.count, 1, maxCount, 0.6, 3)
          });
          linkLayer.appendChild(line);
        });
      }

      // Draw points
      visible.forEach((item) => {
        const pos = positions.get(item.id);
        if (!pos) return;
        const radius = radiusById.get(item.id);
        const color = colorByMode(item, colorMode);
        const papersInRange = activeMap.get(item.institution) || 0;

        const group = createSvgElement('g', {
          class: 'map-point-group',
          'data-id': item.id,
          transform: `translate(${pos.x},${pos.y})`,
          tabindex: '0',
          role: 'button'
        });

        // Pulse ring for highly active institutions
        if (papersInRange >= 3) {
          const pulse = createSvgElement('circle', { cx: 0, cy: 0, r: radius + 3, class: 'map-pulse-ring', fill: 'none', stroke: color });
          group.appendChild(pulse);
        }

        const symbol = createSymbol(item, radius, color);
        group.appendChild(symbol);

        // Tooltip
        const url = institutionLink(item);
        const tooltipHtml = `
          <strong>${escapeHtml(item.institution)}</strong>
          <span>${escapeHtml(item.city)}, ${escapeHtml(item.country)}</span>
          <span>${filterStart}–${filterEnd} 年论文: <b>${papersInRange}</b></span>
          <span>总论文 ${item.papers_count} · 引用 ${Number(item.citations_count || 0).toLocaleString()}</span>
          <span>影响力 ${item.influence_score} · 类型 ${item.org_type}</span>
          ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看机构</a>` : ''}
        `;
        group.addEventListener('pointerenter', (e) => tooltip.show(e, tooltipHtml));
        group.addEventListener('pointermove', (e) => tooltip.move(e));
        group.addEventListener('pointerleave', () => tooltip.hideSoon());
        group.addEventListener('click', () => setAppState({ selectedInstitutionId: item.id }, 'institution-map'));
        pointLayer.appendChild(group);

        // Labels for top institutions
        if (papersInRange >= 3 || item.influence_score >= 75) {
          const label = createSvgElement('text', {
            x: pos.x + radius + 4,
            y: pos.y - radius - 2,
            class: 'map-label'
          });
          label.textContent = item.institution;
          labelLayer.appendChild(label);
        }
      });

      // Stats
      statEl.textContent = `${filterStart}–${filterEnd} 活跃机构 ${visible.length}/${institutions.length} · 联系 ${instLinks.length} 条`;

      // Ranking
      renderRanking(visible, activeMap);

      // Detail
      renderDetail(visible, activeMap);

      // Legend
      renderLegend();

      // Evidence
      evidenceEl.textContent = `显示 ${filterStart}–${filterEnd} 年间有论文发表的机构${cumulativeEl.checked ? '（累计模式）' : '（仅限年份内）'}`;
    }

    function renderRanking(visible, activeMap) {
      rankingEl.innerHTML = '';
      const sorted = visible.slice().sort((a, b) => (activeMap.get(b.institution) || 0) - (activeMap.get(a.institution) || 0));
      sorted.slice(0, 15).forEach((item, index) => {
        const count = activeMap.get(item.institution) || 0;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'institution-rank-row';
        row.innerHTML = `<span>${index + 1}</span><strong>${escapeHtml(item.institution)}</strong><em>${count}篇</em>`;
        row.addEventListener('click', () => setAppState({ selectedInstitutionId: item.id }, 'institution-map'));
        rankingEl.appendChild(row);
      });
    }

    function renderDetail(visible, activeMap) {
      const total = visible.reduce((sum, item) => sum + (activeMap.get(item.institution) || 0), 0);
      const topCountry = {};
      visible.forEach((item) => {
        topCountry[item.country] = (topCountry[item.country] || 0) + (activeMap.get(item.institution) || 0);
      });
      const countries = Object.entries(topCountry).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const countryText = countries.map(([c, n]) => `${c}(${n}篇)`).join('、');
      detailEl.innerHTML = `<strong>${filterStart}–${filterEnd}</strong> 共 ${visible.length} 个机构发表 ${total} 篇论文。主要来源国：${countryText}`;
    }

    function renderLegend() {
      legendEl.innerHTML = '';
      const items = colorModeEl.value === 'community'
        ? [['#3b82f6', '英文社区'], ['#ef4444', '中文社区']]
        : [['#f59e0b', '公司'], ['#10b981', '大学'], ['#8b5cf6', '研究实验室']];
      items.forEach(([color, label]) => {
        const chip = document.createElement('span');
        chip.className = 'legend-chip map-legend-chip';
        chip.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${label}`;
        legendEl.appendChild(chip);
      });
      ['圆形=公司', '方形=大学', '三角=实验室', '脉冲环=年份内≥3篇'].forEach((label) => {
        const chip = document.createElement('span');
        chip.className = 'legend-chip';
        chip.textContent = label;
        legendEl.appendChild(chip);
      });
    }

    /* ── Year slider handlers ── */
    function updateYearDisplay() {
      yearValueEl.textContent = filterStart === filterEnd ? `${filterStart}` : `${filterStart} – ${filterEnd}`;
    }

    yearStartEl.addEventListener('input', () => {
      filterStart = Number(yearStartEl.value);
      if (filterStart > filterEnd) {
        filterEnd = filterStart;
        yearEndEl.value = filterEnd;
      }
      updateYearDisplay();
      render();
    });

    yearEndEl.addEventListener('input', () => {
      filterEnd = Number(yearEndEl.value);
      if (filterEnd < filterStart) {
        filterStart = filterEnd;
        yearStartEl.value = filterStart;
      }
      updateYearDisplay();
      render();
    });

    cumulativeEl.addEventListener('change', render);

    /* ── Play animation ── */
    function stopPlay() {
      playing = false;
      if (playTimer) clearInterval(playTimer);
      playTimer = null;
      playBtn.innerHTML = '&#9654; 播放';
      playBtn.classList.remove('is-playing');
    }

    function startPlay() {
      playing = true;
      playBtn.innerHTML = '&#9724; 停止';
      playBtn.classList.add('is-playing');
      filterStart = MIN_YEAR;
      filterEnd = MIN_YEAR;
      yearStartEl.value = filterStart;
      yearEndEl.value = filterEnd;
      cumulativeEl.checked = true;
      updateYearDisplay();
      render();

      playTimer = setInterval(() => {
        if (filterEnd >= MAX_YEAR) {
          stopPlay();
          return;
        }
        filterEnd += 1;
        yearEndEl.value = filterEnd;
        updateYearDisplay();
        render();
      }, 1200);
    }

    playBtn.addEventListener('click', () => {
      if (playing) stopPlay();
      else startPlay();
    });

    /* ── Other controls ── */
    colorModeEl.addEventListener('change', render);
    sizeModeEl.addEventListener('change', render);
    linkToggle.addEventListener('change', render);

    onAppStateChange(() => render());

    // Initial render
    render();

  } catch (error) {
    console.error('Institution map error:', error);
    container.querySelector('.chart-stat').textContent = '数据加载失败，请检查 JSON 文件';
  }
}
