import {SAMPLE, detectPeaks, evaluate, parseSpectrum, sampleSpectrum} from './engineering.mjs';
import {simulation} from './simulation.mjs';
import {connectWorkbench} from './workbench.mjs';

const byId = id => document.getElementById(id);
const form = byId('parameters');
const colors = {accent: '#00866b', comparison: '#788d8e', band: '#dceddf', grid: '#e1e9e2', text: '#496568'};
let points = sampleSpectrum();
let isSample = true;
let uploadRequest = 0;
let verifiedInputs = null;
let selectedId = null;
let selectedPlan = null;

function add(parent, tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function draw(canvas, series, band, yUnit, scaleUnit = false) {
  const {width, height} = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const scale = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (!series.length) return;
  const left = 50;
  const right = width - 18;
  const top = 25;
  const bottom = height - 37;
  if (right <= left || bottom <= top) return;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const line of series) {
    for (const [x, y] of line.points) {
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
  }
  if (!(xMax > xMin)) return;
  const ySpan = Math.max(yMax - yMin, 1);
  yMin = Math.floor(yMin - ySpan * .08);
  yMax = Math.ceil(yMax + ySpan * .09);
  if (scaleUnit) { yMin = 0; yMax = 1; }
  const xAt = f => left + (f - xMin) * (right - left) / (xMax - xMin);
  const yAt = db => bottom - (db - yMin) * (bottom - top) / (yMax - yMin);
  if (band && band.high > xMin && band.low < xMax) {
    const from = xAt(Math.max(xMin, band.low));
    const until = xAt(Math.min(xMax, band.high));
    ctx.fillStyle = colors.band;
    ctx.fillRect(from, top, until - from, bottom - top);
  }
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = yMin + i * (yMax - yMin) / 4;
    const y = yAt(value);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'right';
    ctx.fillText(scaleUnit ? value.toFixed(2) : String(Math.round(value)), left - 9, y);
  }
  const ticks = width < 490 ? 3 : 5;
  for (let i = 0; i <= ticks; i++) {
    const value = xMin + i * (xMax - xMin) / ticks;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(value)), xAt(value), bottom + 11);
  }
  ctx.textAlign = 'left';
  ctx.fillText(yUnit, left, 12);
  ctx.textAlign = 'right';
  ctx.fillText('频率 / Hz', right, height - 10);
  for (const line of series) {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    line.points.forEach(([f, db], i) => {
      if (i === 0) ctx.moveTo(xAt(f), yAt(db));
      else ctx.lineTo(xAt(f), yAt(db));
    });
    ctx.stroke();
  }
}

function getInputs() {
  return Object.fromEntries(Object.keys(SAMPLE).map(key => [key, form.elements.namedItem(key).valueAsNumber]));
}

function drawCharts() {
  const {low, high} = getInputs();
  const band = Number.isFinite(low) && high > low ? {low, high} : null;
  draw(byId('spectrum-chart'), [{points, color: colors.accent}], band, '声级 / dB');
  if (simulation) {
    draw(byId('simulation-chart'), [
      {points: simulation.reference, color: colors.comparison},
      {points: simulation.resonator, color: colors.accent},
    ], simulation.inputs, '传声损失 / dB');
  }
}

function renderPeaks() {
  const parent = byId('peaks');
  parent.replaceChildren();
  const peaks = detectPeaks(points);
  if (!peaks.length) add(parent, 'span', '未识别出突出窄带峰，可手动填写目标频段。', 'peak-note');
  for (const peakData of peaks) {
    const peak = add(parent, 'button', `${peakData.frequency} Hz 峰`, 'peak');
    peak.type = 'button';
    peak.title = `将 ${peakData.low}–${peakData.high} Hz 设为目标频段`;
    peak.addEventListener('click', () => {
      form.elements.namedItem('low').value = peakData.low;
      form.elements.namedItem('high').value = peakData.high;
      updateRecommendations();
    });
  }
}

function addFacts(parent, facts) {
  for (const [label, value] of facts) {
    const container = add(parent, 'div');
    add(container, 'dt', label);
    add(container, 'dd', value);
  }
}

function updateSimulationStatus(inputs, current) {
  const fromSample = verifiedInputs && Object.keys(verifiedInputs).every(key => inputs[key] === verifiedInputs[key]);
  if (!simulation) {
    byId('sim-status').textContent = '样例求解数据尚未加载。';
    byId('sim-note').textContent = '候选结构目前显示理论初筛尺寸。COMSOL 已求解曲线将在完成核对后载入。';
    return;
  }
  const activeSample = fromSample && isSample && !current.error && selectedId === 'helmholtz';
  byId('sim-status').textContent = activeSample
    ? '演示样例已求解 · 侧支亥姆霍兹与空直管基准'
    : '当前输入待求解 · 下方保留原演示样例的已求解曲线';
  const peakFrequency = simulation.sweepPeak.frequency;
  const outsideTarget = peakFrequency < simulation.inputs.low || peakFrequency > simulation.inputs.high;
  const finding = outsideTarget ? `样例全扫频峰值位于 ${peakFrequency} Hz，落在目标频段外，需重新调谐。` : '';
  byId('sim-note').textContent = `${finding}二维等截面、刚壁、无平均流，计算中未计入热黏性损耗。传声损失曲线用于部件选型验证。`;
}

function updateRecommendations(focusError = false) {
  const inputs = getInputs();
  const current = evaluate(inputs);
  const errorNode = byId('input-error');
  const candidates = byId('candidates');
  candidates.replaceChildren();
  selectedPlan = null;
  for (const field of form.querySelectorAll('input')) field.removeAttribute('aria-invalid');
  errorNode.hidden = !current.error;
  errorNode.textContent = current.error || '';
  byId('dimension-summary').textContent = current.error ? '' : `可用轴向长度 ${Number(current.usableLength.toFixed(2))} mm · 侧挂空间 ${Number(current.availableHeight.toFixed(2))} mm`;
  if (current.error) {
    const field = form.elements.namedItem(current.focus);
    field.setAttribute('aria-invalid', 'true');
    if (focusError) field.focus();
    add(candidates, 'p', '补齐或修正选型条件后生成候选。', 'note');
    byId('screening-note').textContent = '';
  } else {
    const selected = current.items.find(item => item.id === selectedId && item.fit) ?? current.items.find(item => item.fit);
    selectedId = selected?.id ?? null;
    if (selected) {
      selectedPlan = {structure: selected.id, name: selected.name, inputs, tuningFrequencyHz: selected.fit.frequency,
        geometry: Object.fromEntries(Object.entries(selected.fit).filter(([field]) => !['score', 'frequency'].includes(field)))};
    }
    current.items.forEach((item, index) => {
      const css = item.fit ? (index === 0 ? 'candidate leading' : 'candidate') : 'candidate rejected';
      const card = add(candidates, 'article', '', css);
      const head = add(card, 'header');
      add(head, 'h3', item.name);
      add(head, 'span', item.fit ? (index === 0 ? '优先验证' : '可作备选') : '约束冲突', 'indicator');
      add(card, 'p', item.label);
      add(card, 'p', item.reason);
      if (item.fit) {
        addFacts(add(card, 'dl'), [['初估调谐', `${Math.round(item.fit.frequency)} Hz`], ...item.parameters]);
        const selected = item.id === selectedId;
        const button = add(card, 'button', selected ? '已选用' : '选用此方案', 'secondary select-plan');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(selected));
        button.addEventListener('click', () => {
          selectedId = item.id;
          updateRecommendations();
          candidates.querySelector('[aria-pressed="true"]')?.focus();
        });
      }
    });
    byId('screening-note').textContent = current.items.every(item => !item.fit)
      ? '两个模板均未通过。可核对装配占用、侧挂空间和最小开口后重新筛选。'
      : `${current.relativeBandwidth >= .27 ? '目标频带较宽，单一调谐频率只提供设计起点。' : '初筛以目标频段的几何中心频率为调谐目标。'}候选尺寸与调谐来自简化理论，带宽和传声损失需以同一工况的仿真或试验核对。`;
  }
  byId('download-selection').hidden = !selectedPlan;
  byId('selected-structure').textContent = selectedPlan ? `已选 ${selectedPlan.name}` : '';
  updateSimulationStatus(inputs, current);
  drawCharts();
}

function loadSample() {
  ++uploadRequest;
  isSample = true;
  points = sampleSpectrum();
  selectedId = null;
  byId('upload').value = '';
  byId('upload-error').hidden = true;
  byId('spectrum-source').textContent = '合成演示频谱 · 声级仅用于识别频带';
  for (const [key, val] of Object.entries(SAMPLE)) form.elements.namedItem(key).value = val;
  renderPeaks();
  updateRecommendations();
}

byId('upload').addEventListener('change', async event => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  const request = ++uploadRequest;
  const error = byId('upload-error');
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('文件超过 4 MB，请先缩减频谱数据。');
    const parsed = parseSpectrum(await file.text());
    if (request !== uploadRequest) return;
    points = parsed;
    isSample = false;
    const suggested = detectPeaks(points)[0];
    if (suggested && suggested.low >= 50 && suggested.high <= 5000) {
      form.elements.namedItem('low').value = suggested.low;
      form.elements.namedItem('high').value = suggested.high;
    }
    byId('spectrum-source').textContent = `${file.name} · ${points.length} 个频点 · 文件在浏览器中处理`;
    error.hidden = true;
    renderPeaks();
    updateRecommendations();
  } catch (problem) {
    if (request !== uploadRequest) return;
    error.textContent = problem.message;
    error.hidden = false;
  }
});

form.addEventListener('submit', event => {
  event.preventDefault();
  updateRecommendations(true);
});
form.addEventListener('input', () => updateRecommendations());
byId('load-demo').addEventListener('click', loadSample);
byId('download-selection').addEventListener('click', () => {
  if (!selectedPlan) return;
  const file = new Blob([JSON.stringify(selectedPlan, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${selectedPlan.structure}-screening.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

if (simulation) {
  verifiedInputs = simulation.inputs;
  byId('sim-plot').hidden = false;
  const actions = byId('sim-actions');
  actions.hidden = false;
  addFacts(byId('simulation-facts'), [
    ['样例目标频段', `${simulation.inputs.low}–${simulation.inputs.high} Hz`],
    ['COMSOL 扫频', `${simulation.reference[0][0]}–${simulation.reference.at(-1)[0]} Hz`],
    ['目标频段内峰值', `${simulation.peak.frequency} Hz · ${simulation.peak.loss.toFixed(1)} dB`],
    ['全扫频峰值', `${simulation.sweepPeak.frequency} Hz · ${simulation.sweepPeak.loss.toFixed(1)} dB`],
    ['腔体轴向长 × 高', `${simulation.geometry.cavityLength} × ${simulation.geometry.cavityHeight} mm`],
  ]);
  const csv = add(actions, 'a', '下载曲线 CSV', 'download');
  csv.href = 'data/transmission-loss.csv';
  csv.download = '';
}

loadSample();
const observer = new ResizeObserver(drawCharts);
observer.observe(byId('spectrum-chart'));
observer.observe(byId('simulation-chart'));
connectWorkbench({
  draw, add, addFacts, colors, getInputs,
  peak: () => detectPeaks(points)[0],
  ductSelected: () => selectedPlan,
  updateDuct: selected => { if (selected) selectedId = selected; updateRecommendations(); },
});
