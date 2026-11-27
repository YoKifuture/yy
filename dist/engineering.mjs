const SOUND_SPEED = 343;
const format = (value, digits = 1) => Number(value.toFixed(digits));

export function parseSpectrum(input) {
  const points = new Map();
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length > 100000) throw new Error('频谱最多支持 100,000 行。');
  for (const [index, line] of lines.entries()) {
    const columns = line.trim().split(/[,;\t\s]+/);
    const f = Number(columns[0]);
    const db = Number(columns[1]);
    if (index === 0 && (!Number.isFinite(f) || !Number.isFinite(db))) continue;
    if (!Number.isFinite(f) || !Number.isFinite(db) || f <= 0) throw new Error(`第 ${index + 1} 行需要正频率和有效的声级数值。`);
    if (points.has(f)) throw new Error(`频率 ${f} Hz 重复，请保留一个声级值。`);
    points.set(f, db);
  }
  if (points.size < 5) throw new Error('至少需要 5 个有效频点。');
  return [...points].sort((left, right) => left[0] - right[0]);
}

export function detectPeaks(points) {
  const peaks = [];
  for (let i = 2; i < points.length - 2; i++) {
    const [f, level] = points[i];
    if (level <= points[i - 1][1] || level < points[i + 1][1]) continue;
    let left = i - 1;
    let right = i + 1;
    while (left > 0 && points[left][1] > level - 6 && f - points[left][0] < Math.max(25, f * .14)) left--;
    while (right < points.length - 1 && points[right][1] > level - 6 && points[right][0] - f < Math.max(25, f * .14)) right++;
    const prominence = level - Math.max(points[left][1], points[right][1]);
    if (prominence >= 5) peaks.push({frequency: f, level, low: points[left][0], high: points[right][0], prominence});
  }
  const selected = [];
  for (const peak of peaks.sort((a, b) => b.level - a.level || b.prominence - a.prominence)) {
    if (selected.every(item => Math.abs(item.frequency - peak.frequency) >= Math.max(15, item.frequency * .04))) selected.push(peak);
    if (selected.length === 4) break;
  }
  return selected;
}

function screenHelmholtz({target, usableLength, width, availableHeight, min}) {
  let best = null;
  for (const neck of [8, 10, 12, 14, 16, 20, 24]) {
    if (neck < min) continue;
    for (const neckLength of [12, 16, 20, 24, 28]) {
      const effective = neckLength + .85 * neck;
      const area = neck * width * 1e-6;
      const volume = area / ((2 * Math.PI * target / SOUND_SPEED) ** 2 * effective / 1000);
      const cavityHeight = Math.floor(Math.min(75, availableHeight - neckLength - 5));
      if (cavityHeight < 15) continue;
      const cavityLength = Math.round(volume * 1e9 / (width * cavityHeight));
      if (cavityLength < neck + 10 || cavityLength > usableLength) continue;
      const frequency = SOUND_SPEED / (2 * Math.PI) * Math.sqrt(neck * 1e6 / (cavityLength * cavityHeight * effective));
      const score = Math.abs(frequency - target) / target + Math.abs(neck - 12) / 180 + Math.abs(neckLength - 20) / 230;
      if (!best || score < best.score) best = {score, frequency, neck, neckLength, cavityLength, cavityHeight, volume: cavityLength * cavityHeight * width / 1e6};
    }
  }
  return best;
}

function screenPerforate({target, usableLength, availableHeight, min}) {
  if (usableLength < 65) return null;
  let best = null;
  for (const hole of [.6, .8, 1, 1.2, 1.5]) {
    if (hole < min) continue;
    for (const plate of [.8, 1, 1.2]) {
      const effective = (plate + .85 * hole) / 1000;
      for (const ratio of [.005, .008, .01, .012, .015, .02, .025, .03]) {
        const depth = Math.round(1000 * ratio / ((2 * Math.PI * target / SOUND_SPEED) ** 2 * effective));
        if (depth < 12 || depth + plate + 5 > availableHeight) continue;
        const frequency = SOUND_SPEED / (2 * Math.PI) * Math.sqrt(ratio / (effective * depth / 1000));
        const score = Math.abs(frequency - target) / target + Math.abs(hole - 1) / 20 + Math.abs(ratio - .01) * 2;
        if (!best || score < best.score) best = {score, frequency, hole, plate, ratio, depth};
      }
    }
  }
  return best;
}

export function evaluate(input) {
  const labels = {low: '起始频率', high: '终止频率', length: '轴向长度', width: '模块宽度', height: '模块高度', duct: '保留风道高度', allowance: '接口及装配占用', min: '最小可制造开口'};
  for (const [key, label] of Object.entries(labels)) {
    if (!Number.isFinite(input[key])) return {error: `请补充${label}。`, focus: key};
    if (input[key] < 0 || (key !== 'allowance' && input[key] === 0)) return {error: `${label}需${key === 'allowance' ? '大于等于' : '大于'} 0。`, focus: key};
  }
  if (input.high <= input.low) return {error: '终止频率必须大于起始频率。', focus: 'high'};
  if (input.high > 5000 || input.low < 50) return {error: '本页初筛频率范围为 50–5,000 Hz。', focus: 'low'};
  const usableLength = input.length - input.allowance;
  const availableHeight = input.height - input.duct;
  if (usableLength <= 0) return {error: '轴向空间冲突。请核对模块长度和接口、过渡段、装配占用的合计值。', focus: 'allowance'};
  if (availableHeight <= 0) return {error: '侧壁空间冲突。模块高度需要容纳保留风道和侧挂消声结构。', focus: 'height'};
  const target = Math.sqrt(input.low * input.high);
  const relativeBandwidth = (input.high - input.low) / target;
  const criteria = {...input, target, usableLength, availableHeight};
  const hr = screenHelmholtz(criteria);
  const mpp = screenPerforate(criteria);
  const items = [
    {id: 'helmholtz', name: '侧支亥姆霍兹', label: '侧支腔 · 直通风道', fit: hr,
      reason: hr ? '安装空间内存在可布置的颈口和背腔，适合优先验证窄带峰。' : '当前开口、侧向高度或轴向长度约束下，未找到可布置的颈口与腔体组合。',
      parameters: hr ? [['颈口宽', `${hr.neck} mm`], ['颈长', `${hr.neckLength} mm`], ['腔体长 × 高', `${hr.cavityLength} × ${hr.cavityHeight} mm`], ['腔体几何容积', `${format(hr.volume, 2)} L`]] : []},
    {id: 'perforate', name: '微穿孔板与背腔', label: '壁面阻抗 · 直通风道', fit: mpp,
      reason: mpp ? '孔径、板厚和背腔可用于调谐。吸收带宽与风道传声损失需在损耗模型中验证。' : '当前孔径下限、背腔深度或轴向安装长度无法满足本模板的初筛条件。',
      parameters: mpp ? [['孔径', `${mpp.hole} mm`], ['板厚', `${mpp.plate} mm`], ['开孔率', `${format(100 * mpp.ratio, 2)}%`], ['背腔深度', `${mpp.depth} mm`]] : []},
  ];
  if (relativeBandwidth >= .27) items.reverse();
  items.sort((a, b) => Number(!!b.fit) - Number(!!a.fit));
  return {items, usableLength, availableHeight, target, relativeBandwidth};
}
