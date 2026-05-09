import { loadJson } from '../../shared/data-loader.js';
import { getAppState, onAppStateChange, setAppState } from '../../shared/app-state.js';
import { createInteractiveTooltip, escapeHtml, institutionLink } from '../../shared/interactive-tooltip.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_YEAR = 2013;
const MAX_YEAR = 2026;

/* ── LLM 领域关键事件标注 ── */
const MILESTONES = [
  { year: 2013, label: 'Word2Vec' },
  { year: 2014, label: 'Seq2Seq' },
  { year: 2017, label: 'Transformer' },
  { year: 2018, label: 'BERT / GPT' },
  { year: 2020, label: 'GPT-3' },
  { year: 2022, label: 'ChatGPT 发布' },
  { year: 2023, label: 'GPT-4 / LLaMA' },
  { year: 2024, label: '多模态大模型' },
  { year: 2026, label: '智能体时代' }
];

function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value) return [value];
  return [];
}

/* ── 投影 ── */
function projectLonLat(lon, lat, width, height, padding) {
  return {
    x: padding + ((lon + 180) / 360) * (width - padding * 2),
    y: padding + ((90 - lat) / 160) * (height - padding * 2)
  };
}

function polygonToPath(rings, w, h, p) {
  return rings.map(ring => {
    if (!ring.length) return '';
    const head = projectLonLat(ring[0][0], ring[0][1], w, h, p);
    const body = ring.slice(1).map(([lon, lat]) => {
      const pt = projectLonLat(lon, lat, w, h, p);
      return `L${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    }).join('');
    return `M${head.x.toFixed(1)},${head.y.toFixed(1)}${body}Z`;
  }).join('');
}

function geometryToPath(g, w, h, p) {
  if (!g) return '';
  if (g.type === 'Polygon') return polygonToPath(g.coordinates, w, h, p);
  if (g.type === 'MultiPolygon') return g.coordinates.map(poly => polygonToPath(poly, w, h, p)).join('');
  return '';
}

function mapRange(v, d0, d1, r0, r1) {
  if (d0 === d1) return (r0 + r1) / 2;
  return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/* ── 别名与数据预处理 ── */
function normalizeName(name, aliasLookup) {
  const key = String(name || '').trim();
  return aliasLookup.get(key) || key;
}

function buildAliasLookup(aliasRows) {
  const lookup = new Map();
  aliasRows.forEach(row => {
    lookup.set(row.canonical, row.canonical);
    (row.aliases || []).forEach(a => lookup.set(a, row.canonical));
  });
  return lookup;
}

function normalizeNodeInstitutions(node, aliasLookup, institutionNames) {
  return Array.from(new Set(asArray(node.institution)
    .map(n => normalizeName(n, aliasLookup))
    .filter(n => institutionNames.has(n))));
}

function institutionId(name) {
  return `inst_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

function mergeInstitutions(raw, aliasLookup) {
  const merged = new Map();
  raw.forEach(item => {
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

function buildPapersByYearAndInstitution(nodes, aliasLookup, institutionNames) {
  const yearMap = new Map();
  nodes.forEach(node => {
    if (!node.year) return;
    const insts = normalizeNodeInstitutions(node, aliasLookup, institutionNames);
    if (!insts.length) return;
    if (!yearMap.has(node.year)) yearMap.set(node.year, new Map());
    const instMap = yearMap.get(node.year);
    insts.forEach(name => {
      if (!instMap.has(name)) instMap.set(name, []);
      instMap.get(name).push(node);
    });
  });
  return yearMap;
}

/* ── 颜色 / 图形 ── */
function colorForInstitution(item, mode) {
  if (mode === 'org_type') {
    if (item.org_type === 'university') return '#22d3ee';
    if (item.org_type === 'company') return '#f59e0b';
    return '#a78bfa';
  }
  return item.community === 'chinese' ? '#f43f5e' : '#38bdf8';
}

function createSymbol(item, radius, color) {
  if (item.org_type === 'university') {
    return createSvgElement('rect', {
      x: -radius, y: -radius, width: radius * 2, height: radius * 2, rx: 2,
      fill: color, class: 'map-point'
    });
  }
  if (item.org_type === 'research_lab') {
    const r = radius;
    return createSvgElement('path', {
      d: `M0,${-r}L${r},${r}L${-r},${r}Z`,
      fill: color, class: 'map-point'
    });
  }
  return createSvgElement('circle', {
    cx: 0, cy: 0, r: radius, fill: color, class: 'map-point'
  });
}

/* ── 防重叠放置 ── */
function computePositions(items, radiusById, W, H, P) {
  const positions = new Map();
  const anchorById = new Map();
  items.forEach(item => {
    const anchor = projectLonLat(item.lng, item.lat, W, H, P);
    anchorById.set(item.id, anchor);
    positions.set(item.id, { ...anchor });
  });

  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const pa = positions.get(a.id), pb = positions.get(b.id);
        let dx = pb.x - pa.x, dy = pb.y - pa.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = Math.cos(i + j); dy = Math.sin(i + j); dist = 1; }
        const minDist = (radiusById.get(a.id) || 6) + (radiusById.get(b.id) || 6) + 6;
        if (dist >= minDist) continue;
        const push = (minDist - dist) / 2;
        const ux = dx / dist, uy = dy / dist;
        pa.x -= ux * push; pa.y -= uy * push;
        pb.x += ux * push; pb.y += uy * push;
      }
    }
    items.forEach(item => {
      const pos = positions.get(item.id);
      const anchor = anchorById.get(item.id);
      pos.x += (anchor.x - pos.x) * 0.05;
      pos.y += (anchor.y - pos.y) * 0.05;
      pos.x = Math.max(P, Math.min(W - P, pos.x));
      pos.y = Math.max(P, Math.min(H - P, pos.y));
    });
  }
  return { positions, anchorById };
}

/* ────────────────────────────────
   主入口
──────────────────────────────── */
export async function initInstitutionMap(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="module-shell">
      <p class="module-tag">Module 04</p>
      <h3 class="module-title">机构影响力时间线地图</h3>
      <p class="module-subtitle">拖动时间轴看谁在哪一年登场；开启“对比模式”直接并排观察两个时期的研究力量版图。</p>

      <!-- ═════ 大型时间轴 ═════ -->
      <div class="im-timeline-wrap">
        <div class="im-timeline-head">
          <div class="im-year-big">
            <span class="im-year-a">${MAX_YEAR}</span>
            <span class="im-year-sep" hidden> vs </span>
            <span class="im-year-b" hidden></span>
          </div>
          <div class="im-timeline-controls">
            <button class="im-play-btn" type="button">&#9654; 播放</button>
            <label class="im-toggle">
              <input type="checkbox" class="im-compare-toggle" />
              <span>对比模式</span>
            </label>
            <label class="im-toggle">
              <input type="checkbox" class="im-cumulative" checked />
              <span>累计</span>
            </label>
          </div>
        </div>
        <div class="im-timeline" role="slider" aria-label="年份选择">
          <div class="im-timeline-track"></div>
          <div class="im-timeline-milestones"></div>
          <div class="im-timeline-ticks"></div>
          <div class="im-timeline-marker im-marker-a" style="left:100%"><span class="im-marker-label">${MAX_YEAR}</span></div>
          <div class="im-timeline-marker im-marker-b" hidden><span class="im-marker-label"></span></div>
        </div>
      </div>

      <!-- ═════ 色彩 / 大小控件 ═════ -->
      <div class="chart-toolbar chart-toolbar-wrap im-toolbar">
        <label class="chart-control">
          颜色
          <select class="chart-select im-color-mode">
            <option value="community">研究社区</option>
            <option value="org_type">机构类型</option>
          </select>
        </label>
        <label class="chart-control">
          大小
          <select class="chart-select im-size-mode">
            <option value="papers_in_range">当年论文数</option>
            <option value="influence_score">影响力</option>
            <option value="citations_count">总引用</option>
          </select>
        </label>
        <div class="chart-stat im-stat" aria-live="polite">加载中…</div>
      </div>

      <!-- ═════ 双地图 ═════ -->
      <div class="im-maps" data-compare="off">
        <div class="im-map-pane" data-role="a">
          <div class="im-map-title">A: <b class="im-title-year-a">${MAX_YEAR}</b></div>
          <svg class="im-svg" viewBox="0 0 960 480" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
        <div class="im-map-pane" data-role="b" hidden>
          <div class="im-map-title">B: <b class="im-title-year-b"></b></div>
          <svg class="im-svg" viewBox="0 0 960 480" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
      </div>

      <!-- ═════ 排行榜柱状图 ═════ -->
      <div class="im-ranking-wrap">
        <h4 class="im-ranking-title">活跃机构排行（按论文数）</h4>
        <div class="im-ranking"></div>
      </div>

      <div class="chart-detail im-detail"></div>
      <div class="legend-row im-legend"></div>
    </div>
  `;

  // DOM
  const timelineEl = container.querySelector('.im-timeline');
  const markerAEl = container.querySelector('.im-marker-a');
  const markerBEl = container.querySelector('.im-marker-b');
  const markerALabel = markerAEl.querySelector('.im-marker-label');
  const markerBLabel = markerBEl.querySelector('.im-marker-label');
  const milestonesEl = container.querySelector('.im-timeline-milestones');
  const ticksEl = container.querySelector('.im-timeline-ticks');
  const yearABigEl = container.querySelector('.im-year-a');
  const yearBBigEl = container.querySelector('.im-year-b');
  const yearSepEl = container.querySelector('.im-year-sep');
  const titleYearA = container.querySelector('.im-title-year-a');
  const titleYearB = container.querySelector('.im-title-year-b');
  const playBtn = container.querySelector('.im-play-btn');
  const compareToggle = container.querySelector('.im-compare-toggle');
  const cumulativeEl = container.querySelector('.im-cumulative');
  const colorModeEl = container.querySelector('.im-color-mode');
  const sizeModeEl = container.querySelector('.im-size-mode');
  const statEl = container.querySelector('.im-stat');
  const mapsEl = container.querySelector('.im-maps');
  const paneA = mapsEl.querySelector('[data-role="a"]');
  const paneB = mapsEl.querySelector('[data-role="b"]');
  const svgA = paneA.querySelector('svg');
  const svgB = paneB.querySelector('svg');
  const rankingEl = container.querySelector('.im-ranking');
  const detailEl = container.querySelector('.im-detail');
  const legendEl = container.querySelector('.im-legend');

  // 状态
  let yearA = MAX_YEAR;
  let yearB = 2017;
  let compareMode = false;
  let playing = false;
  let playTimer = null;

  // 时间轴 tick 和 milestone
  const totalYears = MAX_YEAR - MIN_YEAR;
  for (let y = MIN_YEAR; y <= MAX_YEAR; y++) {
    const tick = document.createElement('div');
    tick.className = 'im-tick';
    if (y % 2 === 1) tick.classList.add('im-tick-minor');
    tick.style.left = `${((y - MIN_YEAR) / totalYears) * 100}%`;
    tick.innerHTML = `<span>${y}</span>`;
    ticksEl.appendChild(tick);
  }
  MILESTONES.forEach(m => {
    const pct = ((m.year - MIN_YEAR) / totalYears) * 100;
    const el = document.createElement('div');
    el.className = 'im-milestone';
    el.style.left = `${pct}%`;
    el.innerHTML = `<span class="im-milestone-dot"></span><span class="im-milestone-label">${m.label}</span>`;
    milestonesEl.appendChild(el);
  });

  try {
    const [world, rawInst, nodes, edges, aliasRows] = await Promise.all([
      loadJson('./public/world.geojson').catch(() => ({ features: [] })),
      loadJson('./data/processed/institutions_geo.json'),
      loadJson('./data/processed/nodes.json'),
      loadJson('./data/processed/edges.json').catch(() => []),
      loadJson('./data/processed/institution_aliases.json').catch(() => [])
    ]);

    const W = 960, H = 480, P = 18;
    const aliasLookup = buildAliasLookup(aliasRows);
    const institutions = mergeInstitutions(rawInst, aliasLookup);
    const instNames = new Set(institutions.map(i => i.institution));
    const byName = new Map(institutions.map(i => [i.institution, i]));
    const papersByYearInst = buildPapersByYearAndInstitution(nodes, aliasLookup, instNames);

    const tooltipA = createInteractiveTooltip(paneA);
    const tooltipB = createInteractiveTooltip(paneB);

    /* ── 画底图（每个 svg 单独绘） ── */
    function drawBaseMap(svg) {
      svg.innerHTML = '';
      // 渐变海洋
      const defs = createSvgElement('defs');
      defs.innerHTML = `
        <radialGradient id="im-ocean-${Math.random().toString(36).slice(2, 7)}" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stop-color="#1e293b" stop-opacity="1"/>
          <stop offset="100%" stop-color="#0f172a" stop-opacity="1"/>
        </radialGradient>
      `;
      svg.appendChild(defs);
      svg.appendChild(createSvgElement('rect', {
        x: 0, y: 0, width: W, height: H, class: 'im-ocean'
      }));

      // 经纬线
      const grat = createSvgElement('g', { class: 'im-graticule' });
      for (let lat = -60; lat <= 75; lat += 30) {
        let d = '';
        for (let lon = -180; lon <= 180; lon += 5) {
          const pt = projectLonLat(lon, lat, W, H, P);
          d += (lon === -180 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1);
        }
        grat.appendChild(createSvgElement('path', { d, class: 'im-gratline' }));
      }
      for (let lon = -150; lon <= 150; lon += 30) {
        let d = '';
        for (let lat = -70; lat <= 80; lat += 5) {
          const pt = projectLonLat(lon, lat, W, H, P);
          d += (lat === -70 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1);
        }
        grat.appendChild(createSvgElement('path', { d, class: 'im-gratline' }));
      }
      svg.appendChild(grat);

      // 陆地
      const landGroup = createSvgElement('g', { class: 'im-land-group' });
      (world.features || []).forEach(feature => {
        const d = geometryToPath(feature.geometry, W, H, P);
        if (d) landGroup.appendChild(createSvgElement('path', { d, class: 'im-land' }));
      });
      svg.appendChild(landGroup);

      // 点图层
      const pointLayer = createSvgElement('g', { class: 'im-points' });
      const labelLayer = createSvgElement('g', { class: 'im-labels' });
      svg.append(pointLayer, labelLayer);
      return { pointLayer, labelLayer };
    }

    const layersA = drawBaseMap(svgA);
    let layersB = null;

    /* ── 计算某个年份的活跃机构 ── */
    function getActive(endYear) {
      const useCumulative = cumulativeEl.checked;
      const startYear = useCumulative ? MIN_YEAR : endYear;
      const map = new Map();
      for (let y = startYear; y <= endYear; y++) {
        const yi = papersByYearInst.get(y);
        if (!yi) continue;
        yi.forEach((papers, name) => {
          map.set(name, (map.get(name) || 0) + papers.length);
        });
      }
      return map;
    }

    /* ── 渲染一个 pane ── */
    function renderPane(pane, tooltip, layers, endYear) {
      const active = getActive(endYear);
      const visible = institutions.filter(i => active.has(i.institution));
      layers.pointLayer.innerHTML = '';
      layers.labelLayer.innerHTML = '';

      if (!visible.length) return { visible: [], active };

      const sizeMode = sizeModeEl.value;
      const colorMode = colorModeEl.value;
      const values = visible.map(i => sizeMode === 'papers_in_range' ? (active.get(i.institution) || 0) : Number(i[sizeMode]) || 0);
      const minV = Math.min(...values), maxV = Math.max(...values);
      const radiusById = new Map(visible.map((i, idx) => [i.id, mapRange(values[idx], minV, maxV, 4, 14)]));

      const { positions } = computePositions(visible, radiusById, W, H, P);

      visible.forEach(item => {
        const pos = positions.get(item.id);
        if (!pos) return;
        const r = radiusById.get(item.id);
        const color = colorForInstitution(item, colorMode);
        const papersN = active.get(item.institution) || 0;

        const g = createSvgElement('g', {
          class: 'im-point-group',
          transform: `translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})`,
          tabindex: '0'
        });
        // 发光底
        g.appendChild(createSvgElement('circle', {
          r: r + 4, class: 'im-glow', fill: color
        }));
        // 高活跃脉冲
        if (papersN >= 3) {
          const pulse = createSvgElement('circle', {
            r: r, class: 'im-pulse', fill: 'none', stroke: color, 'stroke-width': 1.5
          });
          g.appendChild(pulse);
        }
        g.appendChild(createSymbol(item, r, color));

        const tooltipHtml = `
          <strong>${escapeHtml(item.institution)}</strong>
          <span>${escapeHtml(item.city)}, ${escapeHtml(item.country)}</span>
          <span style="color:#fbbf24">${endYear}年${cumulativeEl.checked ? '累计' : ''}论文: <b>${papersN}</b></span>
          <span>总论文 ${item.papers_count} · 引用 ${Number(item.citations_count || 0).toLocaleString()}</span>
        `;
        g.addEventListener('pointerenter', e => tooltip.show(e, tooltipHtml));
        g.addEventListener('pointermove', e => tooltip.move(e));
        g.addEventListener('pointerleave', () => tooltip.hideSoon());
        g.addEventListener('click', () => setAppState({ selectedInstitutionId: item.id }, 'institution-map'));
        layers.pointLayer.appendChild(g);

        // 顶部机构标签
        if (papersN >= 3 || item.influence_score >= 80) {
          const label = createSvgElement('text', {
            x: pos.x + r + 4, y: pos.y - r - 1, class: 'im-label'
          });
          label.textContent = item.institution;
          layers.labelLayer.appendChild(label);
        }
      });

      return { visible, active };
    }

    /* ── 渲染排行榜柱状图 ── */
    function renderRanking(activeA, activeB) {
      rankingEl.innerHTML = '';
      // 合并所有活跃机构
      const merged = new Map();
      activeA.forEach((v, k) => merged.set(k, { a: v, b: 0 }));
      if (activeB) {
        activeB.forEach((v, k) => {
          if (!merged.has(k)) merged.set(k, { a: 0, b: v });
          else merged.get(k).b = v;
        });
      }
      const sorted = Array.from(merged.entries())
        .sort((x, y) => (y[1].a + y[1].b) - (x[1].a + x[1].b))
        .slice(0, 12);
      if (!sorted.length) {
        rankingEl.innerHTML = '<p class="im-empty">当前年份无机构论文数据</p>';
        return;
      }
      const maxVal = Math.max(...sorted.map(([, v]) => Math.max(v.a, v.b))) || 1;
      sorted.forEach(([name, vals]) => {
        const row = document.createElement('div');
        row.className = 'im-rank-row';
        const item = byName.get(name);
        const color = item ? colorForInstitution(item, colorModeEl.value) : '#64748b';
        row.innerHTML = `
          <span class="im-rank-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <div class="im-rank-bars">
            <div class="im-rank-bar-a" style="width:${(vals.a / maxVal) * 100}%;background:${color}">
              <span>${vals.a || ''}</span>
            </div>
            ${activeB ? `<div class="im-rank-bar-b" style="width:${(vals.b / maxVal) * 100}%;background:${color};opacity:0.55">
              <span>${vals.b || ''}</span>
            </div>` : ''}
          </div>
        `;
        row.addEventListener('click', () => {
          if (item) setAppState({ selectedInstitutionId: item.id }, 'institution-map');
        });
        rankingEl.appendChild(row);
      });
    }

    /* ── 图例 ── */
    function renderLegend() {
      legendEl.innerHTML = '';
      const items = colorModeEl.value === 'community'
        ? [['#38bdf8', '英文社区'], ['#f43f5e', '中文社区']]
        : [['#f59e0b', '公司'], ['#22d3ee', '大学'], ['#a78bfa', '研究实验室']];
      items.forEach(([c, lbl]) => {
        const chip = document.createElement('span');
        chip.className = 'legend-chip';
        chip.innerHTML = `<span class="legend-swatch" style="background:${c}"></span>${lbl}`;
        legendEl.appendChild(chip);
      });
      ['● 公司', '■ 大学', '▲ 实验室', '脉冲=年份内≥3篇'].forEach(lbl => {
        const chip = document.createElement('span');
        chip.className = 'legend-chip legend-chip-muted';
        chip.textContent = lbl;
        legendEl.appendChild(chip);
      });
    }

    /* ── 详情条 ── */
    function renderDetail(resultA, resultB) {
      const summarize = (r, year) => {
        const total = Array.from(r.active.values()).reduce((s, n) => s + n, 0);
        const countries = {};
        r.visible.forEach(i => {
          countries[i.country] = (countries[i.country] || 0) + (r.active.get(i.institution) || 0);
        });
        const top = Object.entries(countries).sort((x, y) => y[1] - x[1]).slice(0, 4)
          .map(([c, n]) => `${c} ${n}`).join(' · ');
        return `<b>${year}${cumulativeEl.checked ? ' 累计' : ''}</b> 机构 ${r.visible.length}，论文 ${total}。${top}`;
      };
      if (resultB) {
        detailEl.innerHTML = `<div class="im-detail-row">${summarize(resultA, yearA)}</div><div class="im-detail-row">${summarize(resultB, yearB)}</div>`;
      } else {
        detailEl.innerHTML = summarize(resultA, yearA);
      }
    }

    /* ── 主渲染 ── */
    function render() {
      yearABigEl.textContent = yearA;
      yearBBigEl.textContent = yearB;
      markerALabel.textContent = yearA;
      markerBLabel.textContent = yearB;
      titleYearA.textContent = `${yearA}${cumulativeEl.checked ? ' 累计' : ''}`;
      titleYearB.textContent = `${yearB}${cumulativeEl.checked ? ' 累计' : ''}`;
      markerAEl.style.left = `${((yearA - MIN_YEAR) / totalYears) * 100}%`;
      markerBEl.style.left = `${((yearB - MIN_YEAR) / totalYears) * 100}%`;

      const resultA = renderPane(paneA, tooltipA, layersA, yearA);
      let resultB = null;
      if (compareMode) {
        if (!layersB) layersB = drawBaseMap(svgB);
        resultB = renderPane(paneB, tooltipB, layersB, yearB);
      }
      renderRanking(resultA.active, resultB ? resultB.active : null);
      renderLegend();
      renderDetail(resultA, resultB);
      statEl.textContent = compareMode
        ? `对比模式 · A(${yearA}) ${resultA.visible.length} 机构 / B(${yearB}) ${resultB ? resultB.visible.length : 0} 机构`
        : `${yearA}${cumulativeEl.checked ? ' 累计' : ''} · 活跃机构 ${resultA.visible.length}/${institutions.length}`;
    }

    /* ── 时间轴交互：点击/拖动 ── */
    function pctToYear(pct) {
      const y = Math.round(MIN_YEAR + pct * totalYears);
      return Math.max(MIN_YEAR, Math.min(MAX_YEAR, y));
    }
    let dragging = null;
    function onTimelinePointer(e) {
      if (!dragging && e.type !== 'pointerdown') return;
      const rect = timelineEl.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = pctToYear(pct);
      const marker = dragging || (compareMode && Math.abs(y - yearB) < Math.abs(y - yearA) ? 'b' : 'a');
      if (marker === 'a') yearA = y;
      else yearB = y;
      render();
    }
    timelineEl.addEventListener('pointerdown', (e) => {
      const rect = timelineEl.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = pctToYear(pct);
      // 判断点击更接近哪个 marker
      if (compareMode && Math.abs(y - yearB) < Math.abs(y - yearA)) dragging = 'b';
      else dragging = 'a';
      timelineEl.setPointerCapture(e.pointerId);
      onTimelinePointer(e);
    });
    timelineEl.addEventListener('pointermove', onTimelinePointer);
    timelineEl.addEventListener('pointerup', () => { dragging = null; });
    timelineEl.addEventListener('pointercancel', () => { dragging = null; });

    /* ── 播放 ── */
    function stopPlay() {
      playing = false;
      playBtn.innerHTML = '&#9654; 播放';
      playBtn.classList.remove('is-playing');
      if (playTimer) { clearInterval(playTimer); playTimer = null; }
    }
    function startPlay() {
      playing = true;
      playBtn.innerHTML = '&#9724; 停止';
      playBtn.classList.add('is-playing');
      cumulativeEl.checked = true;
      yearA = MIN_YEAR;
      render();
      playTimer = setInterval(() => {
        if (yearA >= MAX_YEAR) { stopPlay(); return; }
        yearA += 1;
        render();
      }, 900);
    }
    playBtn.addEventListener('click', () => playing ? stopPlay() : startPlay());

    /* ── 对比模式 ── */
    compareToggle.addEventListener('change', () => {
      compareMode = compareToggle.checked;
      mapsEl.setAttribute('data-compare', compareMode ? 'on' : 'off');
      paneB.hidden = !compareMode;
      markerBEl.hidden = !compareMode;
      yearBBigEl.hidden = !compareMode;
      yearSepEl.hidden = !compareMode;
      render();
    });

    /* ── 其他控件 ── */
    colorModeEl.addEventListener('change', render);
    sizeModeEl.addEventListener('change', render);
    cumulativeEl.addEventListener('change', render);
    onAppStateChange(() => render());

    render();
  } catch (err) {
    console.error('institution-map error', err);
    statEl.textContent = '数据加载失败：' + err.message;
  }
}
