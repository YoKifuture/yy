import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRequest, runThinTurn, runTurn} from '../dist/agent.mjs';
import {evaluateThin} from '../dist/absorbers.mjs';
import {evaluate} from '../dist/engineering.mjs';
import {SAMPLE, THIN_SAMPLE} from './fixtures/inputs.mjs';
import {thinEvidence} from './fixtures/thin-evidence.mjs';

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
