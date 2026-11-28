import {parseSpectrum} from './engineering.mjs';
import {eligiblePaperDesigns, paperTemplates} from './paper-model.mjs';

const byId = id => document.getElementById(id);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const metric = (value, unit) => value.toFixed(unit === 'α' ? 3 : 2) + (unit === 'α' ? '' : ' dB');

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取 PDF。'));
    reader.readAsDataURL(file);
  });
}

export function connectPapers({api, add, draw, colors, saveJson, onLibrary}) {
  const dialog = byId('paper-dialog');
  const form = byId('paper-form');
  const field = name => form.elements.namedItem(name);
  const analysis = byId('paper-analysis');
  const status = byId('paper-job-status');
  const saveStatus = byId('paper-save-status');
  const analyze = byId('paper-analyze');
  const run = byId('paper-run');
  const save = byId('paper-save');
  const upload = byId('paper-file');
  const source = byId('paper-text');
  let capabilities = {};
  let library = [];
  let verifiedJob;
  let extracting = false;
  let running = false;
  let selectedTemplate;

  function sync() {
    analyze.disabled = extracting || running || !capabilities.codex
      || (!source.value.trim() && (!capabilities.paperPdf || !upload.files[0]));
    run.disabled = extracting || running || !capabilities.solver || !paperTemplates[field('template').value];
    upload.disabled = extracting || !capabilities.paperPdf || !capabilities.codex;
  }

  function renderGeometry(values = {}) {
    const name = field('template').value;
    const template = paperTemplates[name];
    const geometry = byId('paper-geometry');
    if (selectedTemplate !== name) {
      selectedTemplate = name;
      geometry.replaceChildren();
      for (const [key, label] of Object.entries(template?.fields ?? {})) {
        const element = add(add(geometry, 'label', label), 'input');
        Object.assign(element, {name: key, type: 'number', step: 'any', required: true});
      }
    }
    for (const key of Object.keys(template?.fields ?? {})) {
      const value = values[key];
      if (Number.isFinite(value)) field(key).value = value;
    }
    byId('paper-template-note').textContent = name === 'unmatched'
      ? '已保留建模要点。补上与论文一致的 COMSOL 模板后才能求解。'
      : template ? '结果指标为' + template.metric + '，单位 ' + template.unit + '。' : '';
    sync();
  }

  function downloadLinks(parent, base, names) {
    parent.replaceChildren();
    for (const [filename, label] of names) {
      const link = add(parent, 'a', label, 'download');
      link.href = base + '/' + filename;
      link.download = filename;
    }
  }

  function paperCard(parent, entry, subtitle) {
    const card = add(parent, 'article', '', 'candidate');
    const template = paperTemplates[entry.template];
    add(card, 'h3', entry.title);
    add(card, 'p', template.name + ' · ' + entry.figure);
    const {length, width, height} = entry.geometry;
    add(card, 'p', `${length} × ${width} × ${height} mm · ${subtitle}`);
    add(card, 'p', entry.source);
    downloadLinks(add(card, 'div', '', 'sim-actions'), 'api/papers/' + (entry.id.replace(/^paper-/, '')),
      [['model.mph', 'COMSOL 模型'], ['model.csv', '求解数据'], ['case.json', '复现记录']]);
  }

  async function refresh() {
    const area = byId('paper-library');
    if (!capabilities.papers) {
      area.textContent = '连接完整服务后查看推荐库。';
      return;
    }
    try {
      const result = await api('papers');
      library = result.entries;
      area.replaceChildren();
      if (!library.length) add(area, 'p', '验证通过并入库的论文案例将在这里显示。', 'note');
      for (const entry of library) {
        const template = paperTemplates[entry.template];
        paperCard(area, entry, '对照误差 ' + metric(entry.comparison.rmse, template.unit) + ' · 峰频偏差 ' + entry.comparison.peakErrorHz.toFixed(1) + ' Hz');
      }
      onLibrary();
    } catch (error) { area.textContent = error.message; }
  }

  function update(info) {
    capabilities = info;
    byId('paper-connection').textContent = info.papers
      ? `Codex ${info.codex ? '已连接' : '待连接'} · PDF 解析 ${info.paperPdf ? '可用' : '待配置'} · COMSOL ${info.solver ? '已连接' : '待连接'}`
      : '此网址提供在线选型。论文解析、COMSOL 和共享推荐库需要连接完整服务。';
    sync();
    void refresh();
  }

  function matches(track, inputs, profile) { return eligiblePaperDesigns(library, inputs, track, profile); }

  function renderMatches(track, inputs, profile) {
    const options = matches(track, inputs, profile);
    const area = byId(track + '-paper-options');
    area.replaceChildren();
    area.hidden = options.length === 0;
    if (!options.length) return;
    add(area, 'h3', '与当前工况匹配的已验证论文方案', 'selection-subhead');
    const cards = add(area, 'div', '', 'candidate-grid');
    for (const entry of options) {
      const template = paperTemplates[entry.template];
      const weighting = profile ? '频谱加权' : '目标频带';
      paperCard(cards, entry, weighting + (track === 'thin' ? '平均吸声系数 ' : '等效传声损失 ') + metric(entry.average, template.unit));
    }
  }

  byId('open-papers').addEventListener('click', () => {
    dialog.showModal();
    if (verifiedJob) renderComparison(verifiedJob);
    void refresh();
  });
  upload.addEventListener('change', () => {
    byId('paper-file-name').textContent = upload.files[0]?.name || 'PDF 最大 10 MB';
    sync();
  });
  source.addEventListener('input', sync);
  form.addEventListener('input', event => {
    if (event.target === field('template')) renderGeometry();
    if (event.target !== field('confirmed')) field('confirmed').checked = false;
  });
  byId('paper-reference-file').addEventListener('change', async event => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    if (file.size > 60_000) { status.textContent = '曲线 CSV 最大为 60 KB。'; return; }
    try {
      field('reference').value = await file.text();
      field('confirmed').checked = false;
      status.textContent = '已读取 ' + file.name + '，请核对曲线来源和列单位。';
    } catch { status.textContent = '无法读取曲线文件。'; }
  });

  byId('paper-export').addEventListener('click', () => {
    const values = Object.fromEntries(new FormData(form));
    delete values.confirmed;
    saveJson('paper-reproduction-draft.json', {status: 'draft', fields: values, notes: analysis.textContent});
  });

  analyze.addEventListener('click', async () => {
    extracting = true;
    sync();
    analysis.textContent = '正在从论文提取参数、边界条件与对照结论…';
    try {
      const file = upload.files[0];
      const data = {text: source.value.trim(), focus: byId('paper-focus').value.trim()};
      if (!data.text && file) {
        if (file.size > 10_000_000) throw new Error('PDF 最大为 10 MB。');
        data.pdf = await asBase64(file);
      }
      const draft = await api('papers/analyze', data, 100_000);
      const values = ['title', 'source', 'figure', 'evidence', 'template'];
      form.reset();
      for (const name of values) field(name).value = typeof draft[name] === 'string' ? draft[name] : '';
      selectedTemplate = null;
      renderGeometry(draft.geometry);
      analysis.textContent = draft.missing.length
        ? '已提取草稿。请逐项核对，并补齐以下内容。\n' + draft.missing.join('\n')
        : '已提取草稿。请核对论文原文，填写对照曲线与复现误差上限。';
    } catch (error) { analysis.textContent = error.message; }
    finally { extracting = false; sync(); }
  });

  function renderComparison(job) {
    const template = paperTemplates[job.paper.template];
    const {result, paper} = job;
    const {comparison} = result;
    const outcome = comparison.passed ? '通过论文曲线对照' : '未达到论文对照误差上限';
    status.textContent = `${outcome}。对照 ${comparison.comparedPoints} 点，均方根误差 ${metric(comparison.rmse, template.unit)}，峰频偏差 ${comparison.peakErrorHz.toFixed(1)} Hz。`;
    byId('paper-result').hidden = false;
    draw(byId('paper-chart'), [
      {id: 'paper', points: paper.reference, color: colors.comparison, label: '论文'},
      {id: 'comsol', points: result.series, color: colors.accent, label: 'COMSOL'},
    ], null, template.metric, paper.template === 'mpp');
    const filename = paper.template === 'mpp' ? 'absorber' : 'side-branch';
    downloadLinks(byId('paper-downloads'), 'api/jobs/' + job.id, [[filename + '.mph', '下载 MPH'], [filename + '.csv', '下载 COMSOL 曲线']]);
    save.disabled = !comparison.passed || library.some(entry => entry.id === job.id);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (run.disabled) return;
    running = true;
    sync();
    verifiedJob = null;
    byId('paper-result').hidden = true;
    saveStatus.textContent = '';
    status.textContent = '正在校核并提交论文工况…';
    try {
      const read = name => field(name).valueAsNumber;
      const template = field('template').value;
      const geometry = Object.fromEntries(Object.keys(paperTemplates[template].fields).map(key => [key, read(key)]));
      const reference = parseSpectrum(field('reference').value);
      const meta = Object.fromEntries(['title', 'source', 'figure', 'evidence'].map(name => [name, field(name).value]));
      const {id} = await api('papers/jobs', {...meta, template, geometry, reference, confirmed: field('confirmed').checked,
        sweep: {start: read('start'), stop: read('stop'), count: read('count')},
        tolerances: {rmse: read('rmse'), peakHz: read('peakHz')}});
      for (let iteration = 0; iteration < 165; iteration++) {
        await delay(2000);
        const job = await api('jobs/' + id);
        if (job.state === 'failed') throw new Error('COMSOL 未完成求解，请核对输入和计算节点日志。');
        if (job.state === 'succeeded') {
          verifiedJob = job;
          renderComparison(job);
          return;
        }
        status.textContent = 'COMSOL 正在运行论文工况…';
      }
      throw new Error('等待求解结果超时。');
    } catch (error) { status.textContent = error.message; }
    finally { running = false; sync(); }
  });

  save.addEventListener('click', async () => {
    if (!verifiedJob?.result?.comparison?.passed) return;
    save.disabled = true;
    try {
      await api('papers', {id: verifiedJob.id}, 15_000);
      saveStatus.textContent = '原模型、论文出处、对照曲线和误差已入库。';
      await refresh();
    } catch (error) { saveStatus.textContent = error.message; save.disabled = false; }
  });

  update({});
  return {update, matches, renderMatches};
}
