const AIR = {speed: 343, density: 1.204, viscosity: 1.825e-5};
export const THIN_SAMPLE = Object.freeze({low: 600, high: 1200, length: 250, width: 320, height: 15, min: .5, reserve: 2, resistivity: 20000, material: 'miki'});

const alpha = (resistance, reactance) => 4 * resistance / ((1 + resistance) ** 2 + reactance ** 2);
const average = points => points.reduce((sum, point) => sum + point[1], 0) / points.length;

export function panelResponse(frequency, {hole, plate, ratio, depth}) {
  const {speed, density, viscosity} = AIR;
  const d = hole / 1000;
  const t = plate / 1000;
  const omega = 2 * Math.PI * frequency;
  const s = d * Math.sqrt(omega * density / (4 * viscosity));
  if (s < 1 || s > 10) return null;
  const resistance = 32 * viscosity * t / (ratio * density * speed * d * d)
    * (Math.sqrt(1 + s * s / 32) + Math.SQRT2 * s * d / (32 * t));
  const reactance = omega * t / (ratio * speed)
    * (1 + 1 / Math.sqrt(9 + s * s / 2) + .85 * d / t) - 1 / Math.tan(omega * depth / (1000 * speed));
  return alpha(resistance, reactance);
}

export function porousResponse(frequency, thickness, resistivity, material) {
  const {speed, density} = AIR;
  const miki = material === 'miki';
  const x = frequency * (miki ? 1 : density) / resistivity;
  if (x < .01 || x > 1 || resistivity < 1000 || resistivity > 50000) return null;
  const zr = 1 + (miki ? .070 * x ** -.632 : .0571 * x ** -.754);
  const zi = -(miki ? .107 * x ** -.632 : .087 * x ** -.732);
  const kL = 2 * Math.PI * frequency * thickness / (1000 * speed);
  const kr = kL * (1 + (miki ? .109 * x ** -.618 : .0978 * x ** -.700));
  const ki = -kL * (miki ? .160 * x ** -.618 : .189 * x ** -.595);
  const denom = Math.cosh(2 * ki) - Math.cos(2 * kr);
  const cr = Math.sin(2 * kr) / denom;
  const ci = -Math.sinh(2 * ki) / denom;
  return alpha(zr * ci + zi * cr, zi * ci - zr * cr);
}

export function evaluateThin(input) {
  const {low, high, length, width, height, min, reserve, resistivity, material} = input;
  const labels = {low: '起始频率', high: '终止频率', length: '模块长', width: '模块宽', height: '模块总厚', min: '最小孔径', reserve: '安装预留', resistivity: '流阻率'};
  for (const [key, label] of Object.entries(labels)) {
    if (!Number.isFinite(input[key])) return {error: `请补充${label}。`, focus: key};
    if (input[key] < 0 || (key !== 'reserve' && input[key] === 0)) return {error: `请检查${label}。`, focus: key};
  }
  if (low < 100 || high > 2500 || high <= low) return {error: '薄型面板模板支持 100–2500 Hz，且终止频率应大于起始频率。', focus: 'high'};
  if (Math.min(length, width) < 15 || height <= reserve || height > 100) {
    return {error: '模块长和宽各需至少 15 mm，总厚需大于安装预留且不超过 100 mm。', focus: 'height'};
  }
  if (!['miki', 'db'].includes(material)) return {error: '请选择 Miki 或 Delany–Bazley。', focus: 'material'};
  const usable = height - reserve;
  const frequencies = Array.from({length: 41}, (_, i) => low + i * (high - low) / 40);
  let best = null;
  for (const hole of [.2, .25, .3, .35, .4, .45, .5, .6, .7, .8, 1, 1.2, 1.5]) {
    if (hole < min) continue;
    for (const plate of [.4, .6, .8, 1, 1.2, 1.5]) {
      for (const depth of [...new Set([usable - plate, (usable - plate) * .75, (usable - plate) * .5])]) {
        if (depth < 3) continue;
        for (const ratio of [.0015, .002, .0025, .003, .004, .005, .006, .008, .01, .013, .016, .02, .025, .03]) {
          const pitch = hole * Math.sqrt(Math.PI / (4 * ratio));
          if (Math.min(length, width) < 5 * pitch) continue;
          const geometry = {hole, plate, ratio, depth};
          const series = frequencies.map(f => [f, panelResponse(f, geometry)]);
          if (series.some(([, value]) => value == null)) continue;
          const mean = average(series);
          if (!best || best.average < mean) best = {id: 'mpp', geometry, series, average: mean};
        }
      }
    }
  }
  const porous = frequencies.map(f => [f, porousResponse(f, usable, resistivity, material)]);
  const scoresValid = porous.every(([, value]) => Number.isFinite(value) && value >= 0 && value <= 1);
  const layer = scoresValid ? {id: 'porous', geometry: {thickness: usable, resistivity, material}, average: average(porous), series: porous} : null;
  const quarterWave = AIR.speed * 1000 / (4 * Math.sqrt(low * high));
  return {items: [best, layer].filter(Boolean).sort((a, b) => b.average - a.average), panel: best, layer, usable, quarterWave};
}
