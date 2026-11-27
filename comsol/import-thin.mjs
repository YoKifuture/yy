import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluateThin} from '../dist/absorbers.mjs';
import {THIN_SAMPLE} from '../test/fixtures/inputs.mjs';
import {readSweep} from '../server/solver.mjs';

const dirs = process.argv.slice(2);
if (dirs.length !== 3) throw new Error('请依次传入微穿孔板、Miki 和 Delany–Bazley 的三个已求解目录。');
const series = await Promise.all(dirs.map(async dir => readSweep(await readFile(join(dir, 'absorber.csv'), 'utf8'), 600, 15, 41)));
const known = evaluateThin(THIN_SAMPLE);
const db = evaluateThin({...THIN_SAMPLE, material: 'db'});
for (const [index, reference] of [known.panel.series, known.layer.series, db.layer.series].entries()) {
  const error = Math.max(...series[index].map(([, alpha], i) => Math.abs(alpha - reference[i][1])));
  if (error > .03) throw new Error('解析与 COMSOL 曲线偏差超过 0.03，实际最大值 ' + error);
  const mean = series[index].reduce((total, [, alpha]) => total + alpha, 0) / series[index].length;
  console.log(JSON.stringify({template: ['MPP', 'Miki', 'Delany–Bazley'][index], maxError: error, average: mean}));
}
const result = {mpp: series[0], porous: series[1], db: series[2]};
const csv = ['frequency_hz,mpp_alpha,miki_alpha,delany_bazley_alpha',
  ...result.mpp.map(([frequency, alpha], index) => [frequency, alpha, result.porous[index][1], result.db[index][1]].join(','))];
await Promise.all([
  writeFile(new URL('../test/fixtures/thin-evidence.mjs', import.meta.url), 'export const thinEvidence = ' + JSON.stringify(result) + ';\n'),
  writeFile(new URL('../test/fixtures/thin-absorption.csv', import.meta.url), csv.join('\n') + '\n'),
]);
