import {evaluate, validateProfile} from './engineering.mjs';
import {evaluateThin, THIN_FIELDS} from './absorbers.mjs';
import {recommendStructures} from './structure-screen.mjs';

export const fields = Object.freeze({
  low: '起始频率', high: '终止频率', length: '轴向长度', width: '模块宽度',
  height: '模块高度', duct: '保留风道高度', allowance: '接口及装配占用', min: '最小可制造开口', wall: '盖板与隔墙等厚值',
});

const measure = '(\\d+(?:\\.\\d+)?)';
const separator = '(?:改为|调整为|改成|改到|调到|提高到|降低到|设为|为|是|[:：=])?';
const dimensionLabels = {
  length: '轴向长度|模块长度|整件长度|轴长|长',
  width: '模块宽度|整件宽度|宽度|宽',
  height: '模块总厚|总厚度|厚度|总厚|模块高度|整件高度|总高度|总高|高度|高',
  duct: '保留风道高度|风道净高|主风道高度|风道高度|风道',
  allowance: '接口及装配占用|接口和装配占用|装配占用|接口占用|接口和装配|预留',
  min: '最小可制造开口|最小孔径|最小开口|开口下限|孔径下限',
  wall: '盖板与隔墙等厚值|通道壁厚|隔墙壁厚|隔墙厚度|壁厚',
};
const toHz = (value, unit) => Number(value) * (unit?.toLowerCase() === 'khz' ? 1000 : 1);
const toMM = (value, unit) => Number(value) * ({m: 1000, cm: 10}[unit?.toLowerCase()] || 1);

export function parseRequest(message, thin = false) {
  const input = message.normalize('NFKC').trim();
  const patch = {};
  const conflicts = new Set();
  function record(key, value) {
    if (Number.isFinite(patch[key]) && patch[key] !== value) conflicts.add(key);
    patch[key] = value;
  }
  let dimensions = input.replace(new RegExp(`(?:包络|安装尺寸|模块尺寸|整件尺寸|外形|长\\s*[×xX*]\\s*宽\\s*[×xX*]\\s*高)\\s*${separator}\\s*${measure}\\s*[×xX*]\\s*${measure}\\s*[×xX*]\\s*${measure}\\s*(mm|cm|m)?`, 'gi'), (_, a, b, c, unit) => {
    [a, b, c].forEach((value, index) => record(['length', 'width', 'height'][index], toMM(value, unit)));
    return ' ';
  });
  const usePeak = /主峰|最高峰|最大峰/.test(input) && /按|用|选择|设为|改用/.test(input);
  const range = new RegExp(`${measure}\\s*(k?hz)?\\s*(?:[-–—~～至到])\\s*${measure}\\s*(k?hz)?`, 'gi');
  for (const match of input.matchAll(range)) {
    const [full, a, aUnit, b, bUnit] = match;
    if (!aUnit && !bUnit && !/频段|扫频|频率/.test(input)) continue;
    record('low', toHz(a, aUnit || bUnit));
    record('high', toHz(b, bUnit || aUnit));
    dimensions = dimensions.replace(full, ' ');
  }
  for (const [key, label] of Object.entries({low: '起始频率|频段下限', high: '终止频率|频段上限', ...dimensionLabels})) {
    const frequency = key === 'low' || key === 'high';
    const units = frequency ? 'khz|hz' : 'mm|cm|m';
    const pattern = new RegExp(`(?:^|[\\s,，、。;；])(?:${label})\\s*${separator}\\s*(?:最大|不超过|上限|至少|下限)?\\s*${measure}\\s*(${units})?(?![a-zA-Z\\d.])`, 'gi');
    for (const match of dimensions.matchAll(pattern)) record(key, (frequency ? toHz : toMM)(match[1], match[2]));
  }
  if (thin) {
    const reserved = dimensions.match(new RegExp(`(?:安装预留|预留厚度)\\s*${separator}\\s*${measure}\\s*(mm|cm|m)?`, 'i'));
    const resistivity = dimensions.match(new RegExp(`流阻率\\s*${separator}\\s*${measure}`, 'i'));
    if (reserved) record('reserve', toMM(reserved[1], reserved[2]));
    if (resistivity) record('resistivity', Number(resistivity[1]));
  }
  const askSolve = /(?:运行|提交|开始|执行|重跑|计算).{0,5}(?:仿真|求解|COMSOL)/i.test(input);
  const selected = /(?:选用|选定|选择|改用|用).{0,5}(?:微穿孔板|MPP)/i.test(input) ? 'perforate'
    : /(?:选用|选定|选择|改用|用).{0,5}亥姆霍兹/.test(input) ? 'helmholtz' : null;
  const compare = /比较|对比|依据|理由|为什么|优先|重新筛选|推荐|超构|迷宫|黑洞|哪种|选什么|适合/.test(input);
  return {patch, conflicts: [...conflicts], usePeak, askSolve, selected, compare};
}

export function cleanInputs(source) {
  return Object.fromEntries(Object.keys(fields).flatMap(key =>
    Number.isFinite(source?.[key]) ? [[key, source[key]]] : []));
}

function describeScreening(screening) {
  const ranked = screening.rankings.map((item, index) =>
    `${index + 1}. ${screening.items.find(family => family.id === item.id).name}　${item.average.toFixed(3)}`);
  const other = screening.items.filter(item => !screening.rankings.some(candidate => candidate.id === item.id));
  return [screening.summary, ...ranked, ...other.map(item => `${item.name}。 ${item.reason}`)].join('\n');
}

function selectedPeak(peak, parsed, inputs, trace) {
  if (!peak) return {};
  const hasBand = [inputs?.low, inputs?.high, parsed.patch.low, parsed.patch.high].some(Number.isFinite);
  if (!parsed.usePeak && (!parsed.compare || hasBand)) return {};
  trace.push({label: '目标频段', detail: `采用频谱主峰的 ${peak.low}–${peak.high} Hz 频段。`});
  return {low: peak.low, high: peak.high};
}

export function runTurn({message, inputs, peak, proposed}) {
  const parsed = parseRequest(message);
  const {patch, conflicts} = parsed;
  const trace = [{label: '解析需求', detail: '识别了本轮频段、安装约束和操作意图。'}];
  const answer = (text, data = {}) => ({text, inputs: cleanInputs(inputs), trace, ...data});
  if (conflicts.length) {
    return answer(`这轮给出了不同的${conflicts.map(key => fields[key]).join('和')}。请确认采用哪个值。`);
  }
  // Confirm consequential changes directly in the form when an external model interpreted them.
  const inferred = Object.fromEntries(Object.entries(cleanInputs(proposed?.patch))
    .filter(([key]) => !Object.hasOwn(patch, key)));
  if (Object.keys(inferred).length) {
    trace.push({label: '待确认', detail: '保留本轮明确识别的参数，额外的模型提取值需在表单中确认。'});
  }
  const proposedValues = Object.entries(inferred).map(([key, value]) =>
    `${fields[key]} ${value} ${key === 'low' || key === 'high' ? 'Hz' : 'mm'}`);
  if (parsed.usePeak && !peak) return answer('请先导入可识别主峰的频谱，或直接说明目标频段。');
  const knownIntent = Object.keys(patch).length || parsed.usePeak || parsed.askSolve || parsed.selected || parsed.compare || proposed?.compare === true;
  if (!knownIntent) {
    const suggestion = proposedValues.length ? `模型提取到 ${proposedValues.join('、')}。请核对后填入选型条件。` : '';
    return answer(suggestion || '可以说“目标 380–460 Hz，模块高度改为 140 mm”，也可以要求比较候选、按主峰筛选或提交仿真。');
  }
  const confirmed = {...selectedPeak(peak, parsed, inputs, trace), ...patch};
  const updated = {...cleanInputs(inputs), ...confirmed};
  const changes = Object.keys(confirmed).filter(key => confirmed[key] !== inputs?.[key]);
  if (changes.length) trace.push({label: '更新条件', detail: changes.map(key => fields[key]).join('、')});
  const result = evaluate(updated);
  const screening = recommendStructures(updated, result, 'duct');
  if ((parsed.compare || proposed?.compare === true) && screening && !parsed.selected && !parsed.askSolve) {
    trace.push({label: '超构选型', detail: `检查了 ${screening.items.length} 种结构的条件。`});
    return answer(describeScreening(screening), {inputs: updated, suggestions: inferred});
  }
  const missing = Object.keys(fields).filter(key => key !== 'wall' && !Number.isFinite(updated[key]));
  if (missing.length) {
    trace.push({label: '校验约束', detail: `缺少 ${missing.length} 项。`});
    return answer(`已记录当前条件。请补充${missing.map(key => fields[key]).join('、')}。`, {inputs: updated, suggestions: inferred});
  }
  trace.push({label: '执行选型', detail: result.error || `有 ${result.items.filter(item => item.fit).length} 个模板通过初筛。`});
  if (result.error) return answer(result.error, {inputs: updated});
  const choice = parsed.selected ? result.items.find(item => item.id === parsed.selected) : result.items.find(item => item.fit);
  const leading = choice?.fit ? `推荐验证${choice.name}，初估调谐 ${Math.round(choice.fit.frequency)} Hz。${choice.reason}`
    : choice ? `${choice.name}当前不可用。${choice.reason}` : '这组限制下两个模板均未通过。';
  const alternative = parsed.compare ? result.items.filter(item => item !== choice).map(item => `${item.name}　${item.reason}`).join('\n') : '';
  const remark = proposedValues.length ? `模型还提取到 ${proposedValues.join('、')}，请核对后填入表单。` : '';
  const canSolve = choice?.id === 'helmholtz' && !!choice.fit;
  const solverMessage = parsed.askSolve && (canSolve ? '已准备仿真参数，可在求解区核对并运行。' : '当前风道求解模板支持通过初筛的侧支亥姆霍兹。');
  return answer([leading, alternative, remark, solverMessage].filter(Boolean).join('\n'), {
    inputs: updated,
    selected: choice?.fit ? choice.id : null,
    showSolver: parsed.askSolve && canSolve,
    suggestions: inferred,
  });
}

export function cleanThin(source) {
  const numeric = Object.fromEntries(THIN_FIELDS.flatMap(key => Number.isFinite(source?.[key]) ? [[key, source[key]]] : []));
  return {...numeric, material: ['db', 'miki'].includes(source?.material) ? source.material : null};
}

export function runThinTurn({message, inputs, peak, proposed, profile, activeCandidate}) {
  const parsed = parseRequest(message, true);
  const {patch, conflicts, usePeak, askSolve, selected, compare} = parsed;
  const material = /(?:改用|换成|切换到|选用|使用|用)\s*(miki|delany[–— -]?bazley|db)\b/i.exec(message)?.[1]?.toLowerCase();
  const trace = [{label: '解析需求', detail: '读取目标频段、薄型模块包络和选型意图。'}];
  const current = cleanThin(inputs);
  const suggestions = cleanThin(Object.fromEntries(Object.entries(cleanInputs(proposed?.patch))
    .filter(([key]) => !Object.hasOwn(patch, key) && current[key] !== proposed.patch[key])));
  delete suggestions.material;
  function answer(text, data = {}) { return {text, inputs: current, trace, suggestions, ...data}; }
  if (conflicts.length) return answer(`同一轮给出了不同的${conflicts.map(key => fields[key]).join('和')}，请确认具体数值。`);
  if (Object.hasOwn(patch, 'duct') || Object.hasOwn(patch, 'allowance')) return answer('这些风道参数请在侧支风道模式设置。薄型模块需要安装预留，可在表单中填写。');
  if (usePeak && !peak) return answer('请先导入含有可识别主峰的频谱，或直接指定目标频段。');
  const changed = {...selectedPeak(peak, parsed, current, trace), ...patch};
  if (!Object.keys(changed).length && !material && !askSolve && !selected && !compare && proposed?.compare !== true) {
    return answer(Object.keys(suggestions).length ? '已提取待确认的参数。核对后可应用到表单。'
      : '可以说“频段改为 700–1100 Hz，厚度改成 12 mm”，或要求比较候选、按主峰筛选和提交仿真。');
  }
  Object.assign(current, changed);
  if (material) current.material = material === 'miki' ? 'miki' : 'db';
  if (Object.keys(changed).length || material) {
    const labels = {...fields, reserve: '安装预留', resistivity: '流阻率', height: '模块总厚'};
    const updates = Object.keys(changed).map(key => labels[key]);
    if (material) updates.push('多孔材料模型');
    trace.push({label: '更新条件', detail: updates.join('、')});
  }
  const result = evaluateThin(current);
  const screening = recommendStructures(current, result, 'thin', validateProfile(profile));
  if (screening && !selected && !material && !askSolve && (compare || proposed?.compare === true || !result.error)) {
    trace.push({label: '超构选型', detail: `检查了 ${screening.items.length} 种结构的条件。`});
    return answer(describeScreening(screening));
  }
  if (askSolve && !selected && !material && ['quarter-wave', 'coiled'].includes(activeCandidate)
    && screening?.rankings.some(item => item.id === activeCandidate)) {
    return answer('当前通道方案可导出尺寸和解析曲线。需建立开口、弯道与损耗边界的模型，再运行通道仿真。');
  }
  trace.push({label: '执行选型', detail: result.error || `${result.items.length} 个候选有有效的计算结果。`});
  if (result.error) return answer(result.error);
  const choice = selected === 'perforate' ? result.panel
    : material ? result.layer : result.items.find(item => askSolve && item.id === activeCandidate) ?? result.items[0];
  const labels = {mpp: '微穿孔板', porous: current.material === 'db' ? 'Delany–Bazley 多孔层' : 'Miki 多孔层'};
  const ranking = result.items.map(item => `${labels[item.id]}的目标带平均正入射吸声系数为 ${item.average.toFixed(3)}`).join('，');
  if (selected === 'helmholtz') return answer('薄型模式用于分析刚性背衬吸声件。侧支亥姆霍兹需要净风道和侧挂空间，请切换到侧支风道模式。');
  if (!choice) return answer(['当前没有通过条件校核的目标候选。', result.panelIssue, result.materialIssue].filter(Boolean).join(''));
  return answer(`${ranking}。优先验证${labels[choice.id]}。正入射吸声系数可用于部件方案筛选。${askSolve ? '可在薄型模块区核对并运行 COMSOL。' : ''}`,
    {selected: choice.id, showSolver: askSolve});
}
