import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SAMPLE, evaluate} from '../dist/engineering.mjs';

const job = process.argv[2];
if (!job) throw new Error('请传入 COMSOL 批处理任务目录。');
const root = fileURLToPath(new URL('../', import.meta.url));

async function parseSweep(file) {
  const raw = await readFile(join(job, file), 'utf8');
  const rows = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('%'));
  return rows.map((line, index) => {
    const [frequency, studyFrequency, loss] = line.split(',').map(Number);
    if (![frequency, studyFrequency, loss].every(Number.isFinite) || frequency !== studyFrequency || frequency !== 150 + 5 * index) {
      throw new Error(`${file} 的第 ${index + 1} 个频点有误。`);
    }
    return [frequency, Math.abs(loss) < 1e-8 ? 0 : Number(loss.toFixed(8))];
  });
}

function maxLoss(points) {
  if (!points.length) throw new Error('曲线中没有可用于比较的频点。');
  const [frequency, loss] = points.reduce((max, point) => point[1] > max[1] ? point : max);
  return {frequency, loss};
}

const [reference, resonator] = await Promise.all([parseSweep('reference.csv'), parseSweep('side-branch.csv')]);
if (reference.length !== 161 || resonator.length !== 161 || reference.some(([, loss]) => Math.abs(loss) > .01)) {
  throw new Error('扫频点数或空直管基准不符合验收条件。');
}

const {fit} = evaluate(SAMPLE).items.find(item => item.id === 'helmholtz');
const modelGeometry = {neck: 12, neckLength: 20, cavityLength: 97, cavityHeight: 70};
if (Object.entries(modelGeometry).some(([key, value]) => fit[key] !== value)) {
  throw new Error('工程初筛样例与 COMSOL 批处理模型的几何不一致。');
}

const peak = maxLoss(resonator.filter(([frequency]) => frequency >= SAMPLE.low && frequency <= SAMPLE.high));
const sweepPeak = maxLoss(resonator);
const data = {inputs: SAMPLE, geometry: modelGeometry, reference, resonator, peak, sweepPeak};
const csv = ['frequency_hz,reference_tl_db,side_branch_tl_db', ...reference.map(([f, loss], i) => `${f},${loss},${resonator[i][1]}`)];
await Promise.all([mkdir(join(root, 'models'), {recursive: true}), mkdir(join(root, 'dist/data'), {recursive: true})]);
await Promise.all([
  writeFile(join(root, 'dist/simulation.mjs'), `export const simulation = ${JSON.stringify(data)};\n`),
  writeFile(join(root, 'dist/data/transmission-loss.csv'), csv.join('\n') + '\n'),
  copyFile(join(job, 'reference.mph'), join(root, 'models/reference.mph')),
  copyFile(join(job, 'side-branch.mph'), join(root, 'models/side-branch.mph')),
]);
console.log(JSON.stringify({points: reference.length, peak, sweepPeak}));
