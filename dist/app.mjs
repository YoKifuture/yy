import {detectPeaks, evaluate, parseSpectrum} from './engineering.mjs';
import {connectWorkbench} from './workbench.mjs';
import {draw, refreshCharts, colors} from './visuals.mjs';
import {setupAppearance} from './appearance.mjs';
import {recommendStructures} from './structure-screen.mjs';

const byId = id => document.getElementById(id);
const form = byId('parameters');
let points = [];
let uploadRequest = 0;
let selectedId = null;
let selectedPlan = null;

function add(parent, tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function getInputs() {
  return Object.fromEntries([...form.elements].filter(field => field.name).map(field => [field.name, field.valueAsNumber]));
}

function drawCharts() {
  const {low, high} = getInputs();
  const band = Number.isFinite(low) && high > low ? {low, high} : null;
  draw(byId('spectrum-chart'), points.length ? [{id: 'level', points, color: colors.accent, label: '声级'}] : [], band, '声级 / dB');
}

function renderPeaks() {
  const parent = byId('peaks');
  parent.replaceChildren();
  byId('spectrum-empty').hidden = points.length > 0;
  if (!points.length) return;
  const peaks = detectPeaks(points);
  if (!peaks.length) add(parent, 'span', '未识别出突出窄带峰，可手动填写目标频段。', 'peak-note');
  for (const peakData of peaks) {
    const peak = add(parent, 'button', `${peakData.frequency} Hz 峰`, 'peak');
    peak.type = 'button';
    peak.title = `将 ${peakData.low}–${peakData.high} Hz 设为目标频段`;
    peak.addEventListener('click', () => {
      form.elements.namedItem('low').value = peakData.low;
      form.elements.namedItem('high').value = peakData.high;
      form.dispatchEvent(new Event('input', {bubbles: true}));
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

function renderStructureScreen(parent, screening) {
  parent.replaceChildren();
  if (!screening) {
    add(parent, 'p', '填写目标频段与模块长、宽、高即可开始超构选型。', 'note');
    return;
  }
  add(parent, 'p', screening.summary, 'selection-summary');
  const grid = add(parent, 'div', '', 'candidate-grid structure-grid');
  const labels = {model: '已有计算模板', analytic: '已算解析曲线', geometry: '几何可布置', blocked: '当前约束未通过', pending: '待补工况', conditional: '需确认声源路径'};
  for (const candidate of screening.items) {
    const active = candidate.id === screening.priority;
    const card = add(grid, 'article', '', 'candidate' + (active ? ' leading' : candidate.status === 'blocked' ? ' rejected' : ''));
    const head = add(card, 'header');
    add(head, 'h3', candidate.name);
    add(head, 'span', (active ? '优先验证 · ' : '') + labels[candidate.status], 'indicator');
    add(card, 'p', candidate.reason);
  }
}

function updateRecommendations(focusError = false) {
  const inputs = getInputs();
  const current = evaluate(inputs);
  const screening = recommendStructures(inputs, current, 'duct');
  renderStructureScreen(byId('duct-structure-screen'), screening);
  const errorNode = byId('input-error');
  const candidates = byId('candidates');
  candidates.replaceChildren();
  selectedPlan = null;
  for (const field of form.querySelectorAll('input')) field.removeAttribute('aria-invalid');
  errorNode.hidden = !current.error || (!focusError && !Object.values(inputs).some(Number.isFinite));
  errorNode.textContent = current.error || '';
  byId('dimension-summary').textContent = current.error ? '' : `可用轴向长度 ${Number(current.usableLength.toFixed(2))} mm · 侧挂空间 ${Number(current.availableHeight.toFixed(2))} mm`;
  if (current.error) {
    const field = form.elements.namedItem(current.focus);
    if (!errorNode.hidden) field.setAttribute('aria-invalid', 'true');
    if (focusError) field.focus();
    add(candidates, 'p', '补齐工况后显示候选结构。', 'note');
    byId('screening-note').textContent = '';
  } else {
    const selected = current.items.find(item => item.id === selectedId && item.fit) ?? current.items.find(item => item.fit);
    selectedId = selected?.id ?? null;
    if (selected) {
      selectedPlan = {structure: selected.id, name: selected.name, inputs, tuningFrequencyHz: selected.fit.frequency,
        geometry: Object.fromEntries(Object.entries(selected.fit).filter(([field]) => !['score', 'frequency'].includes(field))),
        structureScreening: screening};
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
  drawCharts();
}

function clearDuct() {
  ++uploadRequest;
  points = [];
  selectedId = null;
  byId('upload').value = '';
  byId('upload-error').hidden = true;
  byId('spectrum-source').textContent = 'CSV · 频率 Hz / 声级 dB';
  form.reset();
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

updateRecommendations();
const observer = new ResizeObserver(drawCharts);
observer.observe(byId('spectrum-chart'));
setupAppearance(refreshCharts);
connectWorkbench({
  draw, add, addFacts, colors, getInputs, renderStructureScreen,
  peak: () => detectPeaks(points).find(item => item.low >= 50 && item.high <= 5000),
  clearDuct,
  ductSelected: () => selectedPlan,
  updateDuct: selected => { if (selected) selectedId = selected; updateRecommendations(); },
});
