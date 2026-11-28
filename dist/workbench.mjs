import {cleanInputs, cleanThin, fields, parseRequest, runThinTurn, runTurn} from './agent.mjs';
import {evaluateThin, THIN_FIELDS} from './absorbers.mjs';
import {detectPeaks, parseSpectrum, spectralProfile} from './engineering.mjs';
import {recommendStructures} from './structure-screen.mjs';
import {averageAbsorption} from './slit-model.mjs';

const byId = id => document.getElementById(id);
const names = {mpp: '浅背腔微穿孔板', porous: '刚性背衬多孔纤维层', 'quarter-wave': '四分之一波长直通道', coiled: '卷曲迷宫（单 U 形）'};
const curveLabels = {mpp: '微穿孔板', porous: '多孔纤维层', 'quarter-wave': '直通道', coiled: '卷曲迷宫'};
const canSolveThin = id => id === 'mpp' || id === 'porous';
const display = value => Number(value.toFixed(2));
const normalize = value => Number.isFinite(value) || (typeof value === 'string' && value) ? value : null;
const same = (current, expected) => Object.keys(current).every(key => normalize(current[key]) === normalize(expected[key]));
const trackMeta = {
  thin: ['吸声模块分析', '按噪声频谱与安装包络筛选超构，比较目标频段内的吸声表现。', '吸声模块'],
  duct: ['风道消声分析', '核对安装空间，筛选侧支方案并计算频域传声损失。', '风道消声'],
};

function saveJson(name, data) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function populate(form, values) {
  for (const [key, value] of Object.entries(values)) {
    const field = form.elements.namedItem(key);
    if (field && (Number.isFinite(value) || typeof value === 'string')) field.value = value;
  }
}

async function api(route, data, timeout = 5000) {
  const options = {signal: AbortSignal.timeout(timeout)};
  if (data) Object.assign(options, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const response = await fetch('api/' + route, options);
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('工作区服务未连接。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '服务不可用。');
  return result;
}

export function connectWorkbench({draw, add, addFacts, colors, getInputs, peak, clearDuct, ductSelected, updateDuct, renderStructureScreen}) {
  const thinForm = byId('thin-form');
  const ductForm = byId('parameters');
  const chatInput = byId('chat-input');
  const chatLog = byId('chat-log');
  const send = byId('send-chat');
  const apply = byId('apply-suggestions');
  const live = {thin: null, duct: null};
  let track = 'thin';
  let thinChoice = null;
  let pending = false;
  let capabilities = {};
  let turn = 0;
  let thinPeak;
  let thinSpectrum = [];
  let upload = 0;
  let caseImport = 0;

  const thinInputs = () => Object.fromEntries(THIN_FIELDS.map(key => {
    const field = thinForm.elements.namedItem(key);
    return [key, key === 'material' ? field.value : field.valueAsNumber];
  }));
  const inputsFor = mode => mode === 'thin' ? thinInputs() : getInputs();
  const profileFor = ({low, high}) => spectralProfile(thinSpectrum, low, high);
  const palette = {mpp: colors.accent, porous: colors.comparison, 'quarter-wave': '--chart-straight', coiled: '--chart-coiled'};

  function thinOptions(inputs, result) {
    const profile = profileFor(inputs);
    const screening = recommendStructures(inputs, result, 'thin', profile);
    const items = [...(screening?.rankings ?? [])];
    if (result.layer) items.push({...result.layer, average: averageAbsorption(result.layer.series, profile)});
    return {screening, items, profile};
  }

  function syncCase() {
    const inputs = inputsFor(track);
    const {low, high, length, width, height} = inputs;
    byId('export-case').disabled = !Object.values(inputs).some(value => normalize(value) !== null);
    const format = value => value.toLocaleString('zh-CN', {maximumFractionDigits: 2, useGrouping: false});
    byId('case-band').textContent = low > 0 && high > low ? format(low) + '–' + format(high) + ' Hz' : '待输入';
    byId('case-envelope').textContent = [length, width, height].every(value => value > 0)
      ? [length, width, height].map(format).join(' × ') + ' mm' : '待输入';
  }

  function showCaseStatus(value) {
    const status = byId('case-status');
    status.textContent = value;
    status.hidden = !value;
  }

  function links(mode, job) {
    const area = byId(mode + '-artifacts');
    area.replaceChildren();
    if (!job) return;
    const files = mode === 'thin' ? [['absorber.mph', '下载模型'], ['absorber.csv', '下载曲线']]
      : [['side-branch.mph', '下载侧支模型'], ['side-branch.csv', '下载侧支曲线'], ['reference.mph', '下载直管模型'], ['reference.csv', '下载直管曲线']];
    for (const [filename, label] of files) {
      const link = add(area, 'a', label, 'download');
      link.href = 'api/jobs/' + job.id + '/' + filename;
      link.download = filename;
    }
  }

  function renderThin() {
    const inputs = thinInputs();
    const result = evaluateThin(inputs);
    const {screening, items, profile} = thinOptions(inputs, result);
    renderStructureScreen(byId('thin-structure-screen'), screening);
    const area = byId('thin-candidates');
    const error = byId('thin-error');
    area.replaceChildren();
    error.hidden = !result.error || !Object.values(inputs).some(value => normalize(value) !== null);
    error.textContent = result.error || '';
    byId('thin-summary').textContent = result.error ? '' : '净厚 ' + display(result.usable) + ' mm';
    const job = live.thin && same(inputs, live.thin.inputs) ? live.thin : null;
    if (result.error && !items.length) add(area, 'p', '补齐工况后显示候选结构。', 'note');
    if (!items.some(item => item.id === thinChoice)) thinChoice = items[0]?.id ?? null;
    const series = items.map(item => {
      const {id, geometry: g} = item;
      const preferred = id === screening?.priority;
      const card = add(area, 'article', '', preferred ? 'candidate leading' : 'candidate');
      const header = add(card, 'header');
      add(header, 'h3', names[id]);
      add(header, 'span', id === 'porous' ? '传统材料对照' : preferred ? '优先验证' : '备选', 'indicator');
      add(card, 'p', (profile ? '频谱加权吸声系数 ' : '频带平均吸声系数 ') + item.average.toFixed(3) + '（解析）');
      addFacts(add(card, 'dl'), id === 'mpp'
        ? [['孔径', g.hole + ' mm'], ['板厚', g.plate + ' mm'], ['开孔率', display(g.ratio * 100) + '%'], ['背腔', display(g.depth) + ' mm']]
        : id === 'porous' ? [['厚度', display(g.thickness) + ' mm'], ['流阻率', g.resistivity + ' Pa·s/m²'], ['模型', g.material === 'db' ? 'D–B' : 'Miki']]
          : [['声程', display(g.pathMM) + ' mm'], ['净缝高 × 通道宽', display(g.gap) + ' × ' + display(g.breadth) + ' mm'],
            ['单元平面尺寸', display(g.cellLength) + ' × ' + display(g.cellWidth) + ' mm'], ['单元数量', String(g.cells)]]);
      if (!canSolveThin(id)) add(card, 'p', '可导出尺寸与解析曲线。开口及拐弯的 COMSOL 模板待接入。');
      const button = add(card, 'button', thinChoice === id ? '已选用' : '选用此方案', 'secondary select-plan');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(thinChoice === id));
      button.addEventListener('click', () => {
        thinChoice = id;
        renderThin();
        area.querySelector('[aria-pressed="true"]')?.focus();
      });
      const calculated = job?.candidate === id ? job.result.series : null;
      return {id, points: calculated || item.series, color: palette[id], label: curveLabels[id]};
    });
    if (result.panelIssue) add(area, 'p', result.panelIssue, 'note');
    if (result.materialIssue) add(area, 'p', result.materialIssue, 'note');
    byId('abs-source').textContent = result.error && !series.length ? '等待工况'
      : job ? 'COMSOL · ' + names[job.candidate] + (series.length > 1 ? ' / 其余曲线为解析结果' : '')
      : '当前工况 · 解析曲线';
    byId('abs-empty').hidden = series.length > 0;
    byId('abs-empty').textContent = result.error ? '完成工况配置后显示吸声曲线' : '当前条件下无可用吸声曲线';
    byId('thin-guidance').textContent = '正入射、刚性背衬 · 无平均流'
      + (thinSpectrum.length && inputs.low > 0 && inputs.high > inputs.low && !profile ? ' · 频谱未完整覆盖目标带，当前采用频带平均' : '');
    byId('submit-thin').disabled = !capabilities.solver || !canSolveThin(thinChoice) || pending;
    byId('submit-thin').title = thinChoice && !canSolveThin(thinChoice) ? '该候选可导出参数，通道 COMSOL 模板待接入' : '';
    byId('download-thin').disabled = !items.length;
    links('thin', job);
    draw(byId('abs-chart'), series, null, '吸声系数 α', true);
    syncCase();
  }

  function renderDuct() {
    const active = live.duct && ductSelected()?.structure === 'helmholtz' && same(getInputs(), live.duct.inputs) ? live.duct : null;
    byId('submit-duct').disabled = !capabilities.solver || pending || ductSelected()?.structure !== 'helmholtz';
    links('duct', active);
    byId('sim-status').textContent = active ? 'COMSOL · 峰值 ' + active.result.peak[0] + ' Hz / ' + display(active.result.peak[1]) + ' dB' : '等待当前工况求解';
    byId('sim-empty').hidden = !!active;
    const points = active ? [
      {id: 'reference', points: active.result.reference, color: colors.comparison, label: '空直管'},
      {id: 'branch', points: active.result.resonator, color: colors.accent, label: '侧支亥姆霍兹'},
    ] : [];
    draw(byId('simulation-chart'), points, active?.inputs, '传声损失 / dB');
    syncCase();
  }

  function switchTrack(mode) {
    track = mode;
    for (const key of ['thin', 'duct']) {
      byId('show-' + key).setAttribute('aria-pressed', String(key === mode));
      byId(key + '-track').hidden = key !== mode;
    }
    apply.hidden = true;
    const [title, description, context] = trackMeta[mode];
    byId('workspace-title').textContent = title;
    byId('workspace-description').textContent = description;
    byId('agent-context').textContent = context;
    if (mode === 'thin') renderThin();
    else { updateDuct(); renderDuct(); }
  }

  function message(text, own, steps = []) {
    byId('chat-empty').hidden = true;
    const entry = add(chatLog, 'article', '', own ? 'chat-message user' : 'chat-message');
    add(entry, 'p', text);
    if (steps.length) {
      const details = add(entry, 'details');
      add(details, 'summary', '查看执行步骤');
      const list = add(details, 'ul');
      for (const step of steps) add(list, 'li', step.label + '　' + step.detail);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function converse(text) {
    const id = ++turn;
    const mode = track;
    const form = mode === 'thin' ? thinForm : ductForm;
    const inputs = inputsFor(mode);
    const args = {message: text, inputs, track: mode, peak: mode === 'thin' ? thinPeak : peak()};
    if (mode === 'thin') {
      const parsed = parseRequest(text, true);
      const hasBand = [inputs.low, inputs.high, parsed.patch.low, parsed.patch.high].some(Number.isFinite);
      const band = parsed.usePeak || !hasBand ? thinPeak ?? inputs : inputs;
      args.profile = profileFor({...band, ...parsed.patch});
      args.activeCandidate = thinChoice;
    }
    const local = mode === 'thin' ? runThinTurn : runTurn;
    message(text, true);
    send.disabled = true;
    apply.hidden = true;
    let result;
    if (capabilities.codex) {
      try { result = await api('agent', args, 70_000); }
      catch { result = {...local(args), mode: 'fallback'}; }
    } else result = {...local(args), mode: 'local'};
    if (id !== turn) return;
    send.disabled = false;
    const sources = {codex: 'Codex + 工程计算', local: '规则 + 工程计算', fallback: 'Codex 暂不可用，已调用本地工程计算'};
    message(result.text, false, [{label: '执行方式', detail: sources[result.mode]}, ...result.trace]);
    if (!same(inputsFor(mode), inputs)) {
      message('表单在处理期间发生变化，请用最新工况重新发送。', false);
      return;
    }
    populate(form, result.inputs);
    if (mode === 'thin') { if (result.selected) thinChoice = result.selected; renderThin(); }
    else { updateDuct(result.selected); renderDuct(); }
    const suggestions = Object.entries(result.suggestions || {}).filter(([key]) => form.elements.namedItem(key));
    if (suggestions.length && track === mode) {
      apply.textContent = '应用建议值（' + suggestions.map(([key, value]) => fields[key] + ' ' + value).join('、') + '）';
      apply.hidden = false;
      apply.onclick = () => {
        if (track !== mode || !same(inputsFor(mode), {...inputs, ...result.inputs})) {
          apply.hidden = true;
          return;
        }
        populate(form, Object.fromEntries(suggestions));
        apply.hidden = true;
        if (mode === 'thin') renderThin();
        else { updateDuct(); renderDuct(); }
      };
    }
    const button = byId('submit-' + mode);
    if (result.showSolver && track === mode) button.scrollIntoView({block: 'center'});
  }

  async function solve(mode) {
    const status = byId(mode + '-job-status');
    pending = true;
    renderThin();
    renderDuct();
    status.textContent = '正在提交…';
    try {
      const {id} = await api('jobs', {track: mode, candidate: thinChoice, inputs: inputsFor(mode)});
      const started = Date.now();
      while (Date.now() - started < 320_000) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const job = await api('jobs/' + id);
        if (job.state === 'failed') throw new Error('求解未通过，请检查节点日志。');
        if (job.state === 'succeeded') {
          live[mode] = job;
          status.textContent = same(inputsFor(mode), job.inputs) ? '求解完成，可下载 MPH 和 CSV。' : '原工况求解完成。恢复原工况可查看结果。';
          return;
        }
        status.textContent = 'COMSOL 求解中 · ' + Math.round((Date.now() - started) / 1000) + ' 秒';
      }
      throw new Error('等待超时，可重新提交。');
    } catch (error) { status.textContent = error.message; }
    finally { pending = false; renderThin(); renderDuct(); }
  }

  for (const mode of ['thin', 'duct']) {
    byId('show-' + mode).addEventListener('click', () => switchTrack(mode));
    byId('submit-' + mode).addEventListener('click', () => void solve(mode));
  }
  byId('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!chatInput.value.trim() || send.disabled) return;
    void converse(chatInput.value.trim());
    chatInput.value = '';
  });
  byId('chat-compare').addEventListener('click', () => { if (!send.disabled) void converse('推荐并比较超构结构'); });
  byId('chat-sweep').addEventListener('click', () => { if (!send.disabled) void converse('提交仿真'); });
  byId('reset-agent').addEventListener('click', () => {
    ++turn;
    chatLog.replaceChildren();
    byId('chat-empty').hidden = false;
    send.disabled = false;
    apply.hidden = true;
  });
  thinForm.addEventListener('submit', event => event.preventDefault());
  thinForm.addEventListener('input', renderThin);
  byId('thin-upload').addEventListener('change', async event => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    const active = ++upload;
    const status = byId('thin-upload-status');
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('文件超过 4 MB。');
      const spectrum = parseSpectrum(await file.text());
      if (active !== upload) return;
      thinSpectrum = spectrum;
      thinPeak = detectPeaks(spectrum).find(peak => peak.low >= 100 && peak.high <= 2500);
      const supported = {low: Math.max(100, spectrum[0][0]), high: Math.min(2500, spectrum.at(-1)[0])};
      const available = supported.high > supported.low;
      status.textContent = thinPeak ? file.name + ' · 主峰 ' + thinPeak.frequency + ' Hz'
        : available ? file.name + ' · 可用频段 ' + supported.low + '–' + supported.high + ' Hz'
          : '频谱与薄型模型的 100–2500 Hz 适用范围无重叠。';
      byId('apply-thin-peak').hidden = !thinPeak;
      if (available && ![thinInputs().low, thinInputs().high].some(Number.isFinite)) populate(thinForm, thinPeak || supported);
      renderThin();
    } catch (error) {
      if (active === upload) status.textContent = error.message;
    }
  });
  byId('apply-thin-peak').addEventListener('click', () => {
    if (thinPeak) { populate(thinForm, thinPeak); renderThin(); }
  });
  for (const [element, event] of [[ductForm, 'input'], [byId('candidates'), 'click']]) {
    element.addEventListener(event, renderDuct);
  }
  function clearTrack(mode) {
    live[mode] = null;
    if (mode === 'thin') {
      upload++;
      thinPeak = null;
      thinSpectrum = [];
      byId('thin-upload').value = '';
      byId('thin-upload-status').textContent = 'CSV · 频率 Hz / 声级 dB';
      byId('apply-thin-peak').hidden = true;
      thinForm.reset();
      thinChoice = null;
      renderThin();
    } else {
      clearDuct();
      renderDuct();
    }
    if (capabilities.solver && !pending) byId(mode + '-job-status').textContent = '';
  }
  byId('load-thin').addEventListener('click', () => clearTrack('thin'));
  byId('load-demo').addEventListener('click', () => clearTrack('duct'));
  byId('export-case').addEventListener('click', () => {
    const clean = track === 'thin' ? cleanThin : cleanInputs;
    saveJson('acoustic-workspace.json', {format: 'acoustic-workspace', version: 1, track, inputs: clean(inputsFor(track))});
  });
  byId('import-case').addEventListener('change', async event => {
    const control = event.currentTarget;
    const file = control.files[0];
    if (!file) return;
    const currentImport = ++caseImport;
    control.value = '';
    try {
      if (file.size > 128_000) throw new Error('工况文件超过大小限制。');
      const data = JSON.parse(await file.text());
      if (currentImport !== caseImport) return;
      if (data?.format !== 'acoustic-workspace' || data.version !== 1 || !Object.hasOwn(trackMeta, data.track)) {
        throw new Error('请选择由工作台保存的工况 JSON 文件。');
      }
      const clean = data.track === 'thin' ? cleanThin : cleanInputs;
      const values = clean(data.inputs);
      if (!Object.values(values).some(value => normalize(value) !== null)) throw new Error('文件中没有工况参数。');
      clearTrack(data.track);
      populate(data.track === 'thin' ? thinForm : ductForm, values);
      switchTrack(data.track);
      showCaseStatus('已载入 ' + file.name);
    } catch (error) {
      if (currentImport === caseImport) showCaseStatus(error instanceof SyntaxError ? '文件中的 JSON 格式无效。' : error.message);
    }
  });
  byId('download-thin').addEventListener('click', () => {
    const inputs = thinInputs();
    const result = evaluateThin(inputs);
    const {screening, items, profile} = thinOptions(inputs, result);
    if (!items.length) return;
    const file = {inputs, metric: 'normal incidence absorption', method: 'analytical', weighting: profile ? 'spectrum' : 'uniform',
      selected: thinChoice, candidates: items, structureScreening: screening};
    saveJson('absorption-report.json', file);
  });

  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const publicWorkspace = 'https://yokifuture.github.io/yy/';
  const dialog = byId('connection-dialog');
  function openConnection() {
    const current = new URL(location.href);
    current.hash = '';
    current.search = '';
    byId('network-link').value = loopback ? (capabilities.publicUrl || publicWorkspace) : current.href;
    byId('connection-summary').textContent = loopback
      ? (capabilities.publicUrl ? '分享已配置的网络入口。' : '当前计算节点在本机。下方网址可跨设备选型，联网对话和实时求解需要接入部署入口。')
      : '分享当前工作区地址。可用功能取决于模型服务及仿真节点的连接状态。';
    byId('connection-model').textContent = capabilities.codex ? '当前连接 · Codex' : '当前连接 · 规则选型';
    byId('connection-solver').textContent = capabilities.solver ? '当前连接 · COMSOL' : '当前连接 · 未接入';
    byId('copy-status').textContent = '';
    dialog.showModal();
  }
  byId('service-menu').addEventListener('click', openConnection);
  byId('share-link').addEventListener('click', openConnection);
  byId('copy-link').addEventListener('click', async () => {
    const url = byId('network-link');
    try {
      await navigator.clipboard.writeText(url.value);
      byId('copy-status').textContent = '链接已复制';
    } catch {
      url.select();
      byId('copy-status').textContent = '链接已选中，可手动复制。';
    }
  });

  renderThin();
  const absorptionObserver = new ResizeObserver(renderThin);
  absorptionObserver.observe(byId('abs-chart'));
  const ductObserver = new ResizeObserver(renderDuct);
  ductObserver.observe(byId('simulation-chart'));
  api('status', undefined, 2500).then(info => { capabilities = info; }).catch(() => {}).finally(() => {
    byId('service-status').textContent = capabilities.codex && capabilities.solver ? '服务已连接' : capabilities.codex || capabilities.solver ? '部分服务在线' : '工程选型';
    byId('service-led').classList.toggle('connected', !!(capabilities.codex && capabilities.solver));
    byId('provider-status').textContent = capabilities.codex ? 'Codex 已连接' : '规则选型 · 模型服务未连接';
    if (!capabilities.solver) {
      for (const mode of ['thin', 'duct']) byId(mode + '-job-status').textContent = 'COMSOL 节点未连接';
    }
    renderThin();
    renderDuct();
  });
}
