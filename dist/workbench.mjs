import {fields, runThinTurn, runTurn} from './agent.mjs';
import {evaluateThin, THIN_SAMPLE} from './absorbers.mjs';
import {thinEvidence} from './thin-evidence.mjs';
import {detectPeaks, parseSpectrum} from './engineering.mjs';

const byId = id => document.getElementById(id);
const names = {mpp: '浅背腔微穿孔板', porous: '刚性背衬多孔纤维层'};
const display = value => Number(value.toFixed(2));
const same = (current, expected) => Object.keys(current).every(key => Object.is(current[key], expected[key]));

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
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('此链接仅提供网页演示。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '服务不可用。');
  return result;
}

export function connectWorkbench({draw, add, addFacts, colors, getInputs, peak, ductSelected, updateDuct}) {
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
  let upload = 0;

  const thinInputs = () => Object.fromEntries(Object.keys(THIN_SAMPLE).map(key => {
    const field = thinForm.elements.namedItem(key);
    return [key, key === 'material' ? field.value : field.valueAsNumber];
  }));
  const inputsFor = mode => mode === 'thin' ? thinInputs() : getInputs();

  function links(mode, job) {
    const area = byId(mode + '-artifacts');
    area.replaceChildren();
    if (!job) return;
    const filename = mode === 'thin' ? 'absorber' : 'side-branch';
    for (const [ext, label] of [['mph', '下载 COMSOL 模型'], ['csv', '下载本次曲线']]) {
      const link = add(area, 'a', label, 'download');
      link.href = 'api/jobs/' + job.id + '/' + filename + '.' + ext;
      link.download = filename + '.' + ext;
    }
  }

  function renderThin() {
    const inputs = thinInputs();
    const result = evaluateThin(inputs);
    const area = byId('thin-candidates');
    const error = byId('thin-error');
    area.replaceChildren();
    error.hidden = !result.error;
    error.textContent = result.error || '';
    byId('thin-summary').textContent = result.error ? '' : '净厚 ' + display(result.usable) + ' mm';
    const sample = same(inputs, {...THIN_SAMPLE, material: inputs.material}) ? thinEvidence : null;
    const job = live.thin && same(inputs, live.thin.inputs) ? live.thin : null;
    const items = result.items ?? [];
    if (!items.some(item => item.id === thinChoice)) thinChoice = items[0]?.id ?? null;
    const series = items.map((item, index) => {
      const {id, geometry: g} = item;
      const card = add(area, 'article', '', index ? 'candidate' : 'candidate leading');
      const header = add(card, 'header');
      add(header, 'h3', names[id]);
      add(header, 'span', index ? '备选' : '优先验证', 'indicator');
      add(card, 'p', '频带平均吸声系数 ' + item.average.toFixed(3) + '（解析模型）');
      addFacts(add(card, 'dl'), id === 'mpp'
        ? [['孔径', g.hole + ' mm'], ['板厚', g.plate + ' mm'], ['开孔率', display(g.ratio * 100) + '%'], ['背腔', display(g.depth) + ' mm']]
        : [['厚度', display(g.thickness) + ' mm'], ['流阻率', g.resistivity + ' Pa·s/m²'], ['模型', g.material === 'db' ? 'D–B' : 'Miki']]);
      const button = add(card, 'button', thinChoice === id ? '已选用' : '选用此方案', 'secondary select-plan');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(thinChoice === id));
      button.addEventListener('click', () => {
        thinChoice = id;
        renderThin();
        area.querySelector('[aria-pressed="true"]')?.focus();
      });
      const baseline = id === 'porous' && inputs.material === 'db' ? 'db' : id;
      const calculated = job?.candidate === id ? job.result.series : sample?.[baseline];
      return {points: calculated || item.series, color: id === 'mpp' ? colors.accent : colors.comparison};
    });
    if (!result.error && !result.panel) add(area, 'p', '当前孔径下限或厚度条件下，微穿孔板模板未通过。', 'note');
    if (!result.error && !result.layer) add(area, 'p', '当前流阻率或频段超出经验模型的适用范围。', 'note');
    byId('abs-source').textContent = result.error ? '补齐参数后生成曲线'
      : job ? '本次 COMSOL 曲线 · ' + names[job.candidate] + '，其余为解析估算或预求解样例'
      : sample ? '参赛工况 · COMSOL 6.4 预求解曲线' : '当前参数 · 解析初筛';
    byId('thin-guidance').textContent = '刚性背衬、正入射、无平均流。该指标用于吸声部件比较。';
    byId('other-structures').textContent = result.error ? '' : '四分之一波长结构在中心频率附近需约 ' + display(result.quarterWave)
      + ' mm 声程。卷曲布置还需确认截面、弯折与损耗。侧支亥姆霍兹和消声器需确认风道净截面与接口。声学黑洞需先核实结构振动路径。';
    byId('submit-thin').disabled = !capabilities.solver || !thinChoice || pending;
    byId('download-thin').disabled = !items.length;
    links('thin', job);
    draw(byId('abs-chart'), series, null, '吸声系数 α', true);
  }

  function renderDuct() {
    const active = live.duct && ductSelected()?.structure === 'helmholtz' && same(getInputs(), live.duct.inputs) ? live.duct : null;
    byId('submit-duct').disabled = !capabilities.solver || pending || ductSelected()?.structure !== 'helmholtz';
    links('duct', active);
    if (active) byId('sim-status').textContent = '本次 COMSOL 已求解 · 峰值 ' + active.result.peak[0] + ' Hz · ' + display(active.result.peak[1]) + ' dB。下图为原样例。';
  }

  function switchTrack(mode) {
    track = mode;
    for (const key of ['thin', 'duct']) {
      byId('show-' + key).setAttribute('aria-pressed', String(key === mode));
      byId(key + '-track').hidden = key !== mode;
    }
    apply.hidden = true;
    if (mode === 'thin') renderThin();
    else { updateDuct(); renderDuct(); }
  }

  function message(text, own, steps = []) {
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
  byId('chat-compare').addEventListener('click', () => { if (!send.disabled) void converse('比较候选及依据'); });
  byId('chat-sweep').addEventListener('click', () => { if (!send.disabled) void converse('提交仿真'); });
  byId('reset-agent').addEventListener('click', () => {
    ++turn;
    chatLog.replaceChildren();
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
      thinPeak = detectPeaks(spectrum).find(peak => peak.low >= 100 && peak.high <= 2500);
      status.textContent = thinPeak ? '识别到 ' + thinPeak.frequency + ' Hz 主峰，已更新目标频段。' : '模板范围内未识别出突出的窄带峰，请手动填写频段。';
      if (thinPeak) { populate(thinForm, thinPeak); renderThin(); }
    } catch (error) {
      if (active === upload) status.textContent = error.message;
    }
  });
  for (const [element, event] of [[ductForm, 'input'], [byId('candidates'), 'click'], [byId('peaks'), 'click'], [byId('load-demo'), 'click']]) {
    element.addEventListener(event, renderDuct);
  }
  byId('load-thin').addEventListener('click', () => {
    upload++;
    thinPeak = null;
    byId('thin-upload').value = '';
    byId('thin-upload-status').textContent = '两列为频率（Hz）与声级（dB）';
    populate(thinForm, THIN_SAMPLE);
    thinChoice = null;
    renderThin();
  });
  byId('download-thin').addEventListener('click', () => {
    const inputs = thinInputs();
    const result = evaluateThin(inputs);
    if (result.error) return;
    const file = {inputs, metric: 'normal incidence absorption', method: 'analytical', selected: thinChoice, candidates: result.items};
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], {type: 'application/json'}));
    link.download = 'thin-acoustics-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  populate(thinForm, THIN_SAMPLE);
  renderThin();
  const absorptionObserver = new ResizeObserver(renderThin);
  absorptionObserver.observe(byId('abs-chart'));
  api('status', undefined, 2500).then(info => { capabilities = info; }).catch(() => {}).finally(() => {
    byId('provider-status').textContent = capabilities.codex ? 'Codex 已配置 · 由工程模板计算及校核。' : '网页演示 · 规则选型与已求解曲线。';
    if (!capabilities.solver) {
      for (const mode of ['thin', 'duct']) byId(mode + '-job-status').textContent = '实时求解需连接 COMSOL 节点。';
    }
    renderThin();
    renderDuct();
  });
}
