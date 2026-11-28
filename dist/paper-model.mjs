import {averageAbsorption} from './slit-model.mjs';

const dimensions = {length: '总长 mm', width: '总宽 mm', height: '总厚或总高 mm'};
export const paperTemplates = Object.freeze({
  mpp: {name: '刚性背衬微穿孔板', metric: '正入射吸声系数', unit: 'α', track: 'thin',
    fields: {...dimensions, hole: '孔径 mm', plate: '板厚 mm', ratio: '开孔率（0–1）', depth: '背腔深度 mm'}},
  helmholtz: {name: '二维矩形风道侧支亥姆霍兹', metric: '无流传声损失', unit: 'dB', track: 'duct',
    fields: {...dimensions, duct: '主风道净高 mm', neck: '颈口净宽 mm', neckLength: '颈长 mm',
      cavityLength: '腔体轴向净长 mm', cavityHeight: '腔体净高 mm'}},
});

export function interpolate(points, frequency) {
  if (frequency < points[0][0] || frequency > points.at(-1)[0]) return null;
  const index = points.findIndex(([f]) => f >= frequency);
  const [f, result] = points[index];
  if (f === frequency || index === 0) return result;
  const [previous, value] = points[index - 1];
  return value + (result - value) * (frequency - previous) / (f - previous);
}

export function comparePaperCurve(reference, series, tolerances) {
  const values = reference.map(([f, value]) => [f, value, interpolate(series, f)]);
  if (values.some(([, , simulated]) => simulated === null)) throw new Error('COMSOL 曲线未覆盖论文对照频点。');
  const peak = index => values.reduce((best, point) => point[index] > best[index] ? point : best)[0];
  const rmse = Math.sqrt(values.reduce((sum, [, target, computed]) => sum + (target - computed) ** 2, 0) / values.length);
  const peakErrorHz = Math.abs(peak(1) - peak(2));
  return {rmse, peakErrorHz, comparedPoints: values.length, passed: rmse <= tolerances.rmse && peakErrorHz <= tolerances.peakHz};
}

export function eligiblePaperDesigns(entries, inputs, track, profile) {
  const {low, high, length, width, height, min} = inputs;
  const required = track === 'thin' ? [inputs.reserve] : [inputs.duct, inputs.allowance];
  if (![low, high, length, width, height, min, ...required].every(Number.isFinite) || !(high > low && min > 0)) return [];
  if ((track === 'thin' && inputs.reserve < 0) || (track === 'duct' && (inputs.duct <= 0 || inputs.allowance < 0))) return [];
  const candidates = [];
  for (const entry of entries) {
    const template = paperTemplates[entry.template];
    if (template?.track !== track || !entry.comparison.passed) continue;
    const g = entry.geometry;
    if (entry.series[0][0] > low || entry.series.at(-1)[0] < high
      || (entry.validatedBand && (entry.validatedBand.low > low || entry.validatedBand.high < high))) continue;
    if (track === 'thin') {
      const planarFit = g.length <= length && g.width <= width || g.length <= width && g.width <= length;
      if (!planarFit || g.height + inputs.reserve > height || g.hole < min) continue;
    } else if (g.length + inputs.allowance > length || g.width !== width || g.height > height || g.duct !== inputs.duct || g.neck < min) continue;
    const series = Array.from({length: 41}, (_, index) => {
      const frequency = index === 40 ? high : low + index * (high - low) / 40;
      return [frequency, interpolate(entry.series, frequency)];
    });
    const power = track === 'duct' ? series.map(([f, level]) => [f, 10 ** (-level / 10)]) : series;
    const mean = averageAbsorption(power, profile);
    const average = track === 'duct' ? -10 * Math.log10(mean) : mean;
    candidates.push({...entry, id: 'paper-' + entry.id, series, average});
  }
  return candidates.sort((a, b) => b.average - a.average);
}
