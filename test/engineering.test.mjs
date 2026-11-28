import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRequest, runThinTurn, runTurn} from '../dist/agent.mjs';
import {evaluateThin} from '../dist/absorbers.mjs';
import {evaluate, spectralProfile} from '../dist/engineering.mjs';
import {SAMPLE, THIN_SAMPLE} from './fixtures/inputs.mjs';
import {thinEvidence} from './fixtures/thin-evidence.mjs';
import {recommendStructures} from '../dist/structure-screen.mjs';

test('parses range, mixed units and complete enclosure in the declared order', () => {
  const result = parseRequest('频段 0.6–1.2 kHz，包络 25×32×1.5 cm，最小孔径 0.5 mm');
  assert.deepEqual(result.patch, {low: 600, high: 1200, length: 250, width: 320, height: 15, min: .5});
});

test('updates an existing thin case and detects incompatible limits', () => {
  const answer = runThinTurn({message: '厚度改成 12 mm，频段 700–1100 Hz', inputs: THIN_SAMPLE});
  assert.deepEqual(answer.inputs, {...THIN_SAMPLE, height: 12, low: 700, high: 1100});
  const limit = evaluateThin({...answer.inputs, min: 2});
  assert.equal(limit.panel, null);
  assert.equal(limit.items[0].id, 'porous');
});

test('runs the selected branch without requiring unrelated measurements', () => {
  const withoutMaterial = evaluateThin({...THIN_SAMPLE, material: null, resistivity: undefined});
  assert.deepEqual(withoutMaterial.items.map(item => item.id), ['mpp']);
  const withoutHoleSize = evaluateThin({...THIN_SAMPLE, min: undefined});
  assert.deepEqual(withoutHoleSize.items.map(item => item.id), ['porous']);
});

test('handles the submitted installation dimensions and a material model change', () => {
  const answer = runThinTurn({message: '安装尺寸250*320*15mm，安装预留2 mm，流阻率 20000，改用 Delany–Bazley', inputs: THIN_SAMPLE});
  assert.deepEqual(answer.inputs, {...THIN_SAMPLE, material: 'db'});
  assert.equal(answer.selected, 'porous');
});

test('disputed values and inferred values require confirmation', () => {
  const conflict = runThinTurn({message: '厚度 12 mm，厚度 14 mm', inputs: THIN_SAMPLE});
  assert.equal(conflict.inputs.height, 15);
  assert.match(conflict.text, /确认/);
  const model = runThinTurn({message: '给出备选方案', inputs: THIN_SAMPLE, proposed: {patch: {height: 22}, compare: true}});
  assert.equal(model.inputs.height, 15);
  assert.deepEqual(model.suggestions, {height: 22});
});

test('three precomputed absorption curves match the analytical models', () => {
  const miki = evaluateThin(THIN_SAMPLE);
  const db = evaluateThin({...THIN_SAMPLE, material: 'db'});
  assert.deepEqual(miki.panel.geometry, {hole: .5, plate: 1, ratio: .006, depth: 12});
  for (const [source, expected] of [[thinEvidence.mpp, miki.panel.series], [thinEvidence.porous, miki.layer.series], [thinEvidence.db, db.layer.series]]) {
    assert.equal(source.length, 41);
    source.forEach(([f, value], index) => {
      assert.equal(f, expected[index][0]);
      assert(value >= 0 && value <= 1);
      assert(Math.abs(value - expected[index][1]) < .004);
    });
  }
});

test('duct workflow retains validated sample geometry and requests missing inputs', () => {
  assert.equal(evaluate(SAMPLE).items[0].fit.cavityLength, 97);
  assert.match(runTurn({message: '频段 380–460 Hz', inputs: {}}).text, /风道高度/);
});

test('recommends a folded path for a narrow band when a straight path does not fit', () => {
  const input = {...THIN_SAMPLE, low: 1000, high: 1100, length: 70, width: 45, min: 2, wall: 1};
  const result = recommendStructures(input, evaluateThin(input), 'thin');
  assert.equal(result.priority, 'coiled');
  assert.equal(result.items.find(item => item.id === 'quarter-wave').status, 'blocked');
  const folded = result.items.find(item => item.id === 'coiled');
  assert.equal(folded.status, 'analytic');
  const [design] = result.rankings;
  assert(design.geometry.cellLength <= input.length && design.geometry.cellWidth <= input.width);
  assert.equal(design.series.length, 41);
  assert(design.series.every(([, alpha]) => alpha >= 0 && alpha <= 1));
  assert.match(runThinTurn({message: '哪种超构适合？', inputs: input}).text, /优先验证卷曲迷宫/);
});

test('uses the dominant spectral band for screening and asks for missing manufacturing constraints', () => {
  const answer = runThinTurn({
    message: '推荐超构', inputs: {length: 70, width: 45, height: 15}, peak: {low: 1000, high: 1100},
  });
  assert.equal(answer.inputs.low, 1000);
  assert.equal(answer.selected, undefined);
  assert.match(answer.text, /卷曲迷宫.*安装预留/);
  assert.match(answer.text, /声学黑洞/);
});

test('ranks comparable absorbers with an optional spectrum-weighted metric', () => {
  const input = {...THIN_SAMPLE, wall: 1};
  const profile = spectralProfile([[600, 48], [900, 68], [1200, 48]], input.low, input.high);
  const analysis = evaluateThin(input);
  const base = recommendStructures(input, analysis, 'thin');
  const weighted = recommendStructures(input, analysis, 'thin', profile);
  assert.equal(weighted.rankings.length, 3);
  assert.match(weighted.summary, /频谱加权/);
  assert.equal(weighted.priority, 'mpp');
  assert(weighted.rankings[0].average > base.rankings[0].average);
  assert.match(runThinTurn({message: '推荐超构', inputs: input, profile}).text, /频谱加权/);
  assert.equal(runThinTurn({message: '提交仿真', inputs: input, activeCandidate: 'coiled'}).showSolver, undefined);
});
