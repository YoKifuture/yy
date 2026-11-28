// Effective density and bulk modulus for a rigid slit (Stinson, JASA 89, 1991).
// e^(iωt) convention. A uniform closed tube has Zin = -i Zc cot(kL).
const speed = 343;
const density = 1.204;
const viscosity = 1.825e-5;
const prandtl = .71;
const gamma = 1.4;
const complexProduct = ([ar, ai], [br, bi]) => [ar * br - ai * bi, ar * bi + ai * br];
const reciprocal = ([re, im]) => {
  const norm = re * re + im * im;
  return [re / norm, -im / norm];
};
function squareRoot([re, im]) {
  const root = Math.sqrt((Math.hypot(re, im) + re) / 2);
  return [root, im / (2 * root)];
}

function boundaryFactor(value) {
  const doubled = 2 * value;
  const decay = Math.exp(-doubled);
  const denominator = 1 + decay * decay + 2 * decay * Math.cos(doubled);
  const real = (1 - decay * decay) / denominator;
  const imaginary = 2 * decay * Math.sin(doubled) / denominator;
  return [(real + imaginary) / doubled, (imaginary - real) / doubled];
}

function slitMedium(frequency, gap) {
  const omega = 2 * Math.PI * frequency;
  const boundary = gap / 2000 * Math.sqrt(omega * density / (2 * viscosity));
  const [vr, vi] = boundaryFactor(boundary);
  const [tr, ti] = boundaryFactor(boundary * Math.sqrt(prandtl));
  const rho = reciprocal([1 - vr, -vi]);
  const compliance = [1 + (gamma - 1) * tr, (gamma - 1) * ti];
  const wave = squareRoot(complexProduct(rho, compliance));
  return {waveNumber: wave.map(value => value * omega / speed), impedance: complexProduct(rho, reciprocal(wave))};
}

export function slitAbsorption(medium, pathMM, apertureRatio) {
  const [realK, imaginaryK] = medium.waveNumber;
  const real = realK * pathMM / 1000;
  const imaginary = imaginaryK * pathMM / 1000;
  const decay = Math.exp(2 * imaginary);
  const denominator = 1 + decay * decay - 2 * decay * Math.cos(2 * real);
  const cot = [2 * decay * Math.sin(2 * real) / denominator, (1 - decay * decay) / denominator];
  const [reactanceNeg, resistance] = complexProduct(medium.impedance, cot);
  const realZ = resistance / apertureRatio;
  const imaginaryZ = -reactanceNeg / apertureRatio;
  return 4 * realZ / ((1 + realZ) ** 2 + imaginaryZ ** 2);
}

export function averageAbsorption(series, profile) {
  const weights = profile?.low === series[0][0] && profile?.high === series.at(-1)[0] ? profile.weights : null;
  return series.reduce((sum, point, index) => sum + point[1] * (weights?.[index] ?? 1), 0)
    / (weights ? weights.reduce((sum, value) => sum + value, 0) : series.length);
}

export function fitSlitAbsorbers(input, profile) {
  const {low, high, length, width, height, reserve, wall, min} = input;
  const gapLimit = height - reserve - 2 * wall;
  if (!Number.isFinite(reserve) || reserve < 0 || !Number.isFinite(wall) || !(wall > 0)
    || !Number.isFinite(min) || !(min > 0) || gapLimit < min || low < 100 || high > 2500) return {};
  const span = Math.max(length, width);
  const lateral = Math.min(length, width);
  const frequencyAt = index => index === 40 ? high : low + index * (high - low) / 40;
  const frequencies = Array.from({length: 41}, (_, index) => frequencyAt(index));
  const tuning = [low, (low + high) / 2, high];
  const best = {};

  for (const gap of new Set([min, (min + gapLimit) / 2, gapLimit])) {
    const media = frequencies.map(frequency => slitMedium(frequency, gap));
    for (const breadth of [5 * gap, 8 * gap]) {
      if (Math.PI * high * breadth / 343000 >= .65) continue;
      for (const frequency of tuning) {
        const pathMM = Math.PI * 500 / slitMedium(frequency, gap).waveNumber[0];
        for (const [id, folded] of [['quarter-wave', false], ['coiled', true]]) {
          const openingLeg = wall + gap / 2;
          const turn = folded ? breadth + wall : 0;
          const run = (pathMM - openingLeg - turn) / (folded ? 2 : 1);
          const cellLength = run + gap + 2 * wall + (folded ? breadth / 2 : 0);
          const cellWidth = folded ? 2 * breadth + 3 * wall : breadth + 2 * wall;
          const wavelength = 343000 / high;
          if (run < gap || cellLength > span || cellWidth > lateral || Math.max(cellLength, cellWidth) >= wavelength) continue;
          // The remainder of the rectangular face is rigid, including unused space at the array edges.
          const cells = Math.floor(span / cellLength) * Math.floor(lateral / cellWidth);
          const apertureRatio = Math.min(1, (cells * gap * breadth) / (span * lateral));
          const series = media.map((medium, index) => [frequencies[index], slitAbsorption(medium, pathMM, apertureRatio)]);
          if (series.some(([, value]) => !Number.isFinite(value) || value < 0 || value > 1 + 1e-9)) continue;
          const average = averageAbsorption(series, profile);
          if (!best[id] || average > best[id].average) {
            best[id] = {id, series, average, geometry: {gap, breadth, pathMM, run, cellLength, cellWidth, cells, apertureRatio}};
          }
        }
      }
    }
  }
  return best;
}
