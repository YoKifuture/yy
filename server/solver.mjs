import {createReadStream, existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {evaluate} from '../dist/engineering.mjs';
import {evaluateThin, panelResponse, porousResponse} from '../dist/absorbers.mjs';

export function readSweep(csv, start, step, count) {
  const rows = csv.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('%'));
  if (rows.length !== count) throw new Error('COMSOL 返回的频点数不一致。');
  return rows.map((row, index) => {
    const [frequency, evaluationFrequency, loss] = row.split(',').map(Number);
    if (![frequency, evaluationFrequency, loss].every(Number.isFinite)
      || Math.abs(frequency - evaluationFrequency) > 1e-4
      || Math.abs(frequency - (start + step * index)) > 1e-4) {
      throw new Error('COMSOL 返回的频点或传声损失格式异常。');
    }
    return [frequency, Math.abs(loss) < 1e-8 ? 0 : Number(loss.toFixed(6))];
  });
}

const runner = fileURLToPath(new URL('../comsol/run-sample.ps1', import.meta.url));

export function createSolver(bin) {
  const enabled = process.platform === 'win32' && !!bin && ['comsolbatch.exe', 'comsolcompile.exe']
    .every(program => existsSync(join(bin, program)));
  const jobs = new Map();
  let active = false;

  async function execute(job, params, sweep) {
    active = true;
    job.state = 'running';
    try {
      job.dir = await mkdtemp(join(tmpdir(), 'hood-acoustics-'));
      await writeFile(join(job.dir, 'job.properties'), Object.entries(params).map(([key, value]) => `${key}=${value}`).join('\n'));
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner,
          '-ComsolBin', bin, '-JobDirectory', job.dir], {windowsHide: true, stdio: 'ignore'});
        const timeout = setTimeout(() => {
          if (!child.pid) return;
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
          killer.on('error', () => child.kill());
        }, 300_000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('close', code => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`COMSOL 批处理退出码 ${code}。`));
        });
      });
      const load = async name => readSweep(await readFile(join(job.dir, name), 'utf8'), sweep.start, sweep.step, sweep.count);
      if (params.mode) {
        const series = await load('absorber.csv');
        const expected = f => params.mode === 1 ? panelResponse(f, params)
          : porousResponse(f, params.thickness, params.resistivity, params.mode === 2 ? 'miki' : 'db');
        const gap = Math.max(...series.map(([f, value]) => Math.abs(value - expected(f))));
        if (!Number.isFinite(gap) || gap > .03 || series.some(([, value]) => value < -1e-5 || value > 1.00001)) {
          throw new Error('吸声系数未通过一致性检查。');
        }
        job.result = {series, gap, sweep};
      } else {
        const [reference, resonator] = await Promise.all([load('reference.csv'), load('side-branch.csv')]);
        if (reference.some(([, loss]) => Math.abs(loss) > .05)) throw new Error('空直管基准未通过校核。');
        const peak = resonator.reduce((best, point) => point[1] > best[1] ? point : best);
        job.result = {reference, resonator, peak, sweep};
      }
      job.state = 'succeeded';
    } catch (error) {
      console.error(`COMSOL ${job.id}: ${error.message}`);
      job.state = 'failed';
    } finally {
      active = false;
    }
  }

  function startJob(inputs, params, sweep, candidate) {
    if (jobs.size >= 20) {
      const oldest = jobs.values().next().value;
      jobs.delete(oldest.id);
      const root = resolve(tmpdir());
      if (oldest.dir?.startsWith(root + sep + 'hood-acoustics-')) {
        void rm(oldest.dir, {recursive: true, force: true}).catch(error => console.error(error.message));
      }
    }
    const job = {id: randomUUID(), state: 'queued', inputs, candidate, result: null};
    jobs.set(job.id, job);
    void execute(job, params, sweep);
    return {id: job.id, state: job.state};
  }

  function submit(inputs) {
    if (!enabled) return {error: '当前部署未启用 COMSOL 工作节点。', status: 503};
    if (active) return {error: '有一个求解任务正在运行，请稍后再试。', status: 409};
    const check = evaluate(inputs);
    const fit = check.items?.find(item => item.id === 'helmholtz')?.fit;
    if (!fit) return {error: check.error || '该工况没有通过亥姆霍兹初筛。', status: 422};
    const {length, duct, low, high} = inputs;
    const upper = Math.min(2000, Math.floor(343000 / (2 * duct) * .9));
    if (length > 1500 || duct > 400 || high > upper || low < 50) {
      return {error: `二维单模态模板需要轴长不超过 1500 mm、风道不高于 400 mm，且扫频上限不超过 ${upper} Hz。`, status: 422};
    }
    const start = Math.max(50, Math.round(low * .7));
    const end = Math.min(upper, Math.round(high * 1.3));
    const step = Math.max(1, Math.ceil((end - start) / 160));
    const count = Math.floor((end - start) / step) + 1;
    const stop = start + (count - 1) * step;
    const sweep = {start, stop, step, count};
    const {neck, neckLength, cavityLength, cavityHeight} = fit;
    const params = {length, duct, neck, neckLength, cavityLength, cavityHeight, start, stop, step};
    return startJob(inputs, params, sweep, 'helmholtz');
  }

  function submitThin(inputs, candidate) {
    if (!enabled) return {error: '当前部署未启用 COMSOL 工作节点。', status: 503};
    if (active) return {error: '有一个求解任务正在运行，请稍后再试。', status: 409};
    const check = evaluateThin(inputs);
    const fit = check.items?.find(item => item.id === candidate);
    if (!fit) return {error: check.error || '请选择已通过薄型模块初筛的结构。', status: 422};
    const start = inputs.low;
    const stop = inputs.high;
    const count = 41;
    const step = (stop - start) / (count - 1);
    const sweep = {start, stop, step, count};
    const mode = candidate === 'mpp' ? 1 : inputs.material === 'miki' ? 2 : 3;
    const {material, ...geometry} = fit.geometry;
    return startJob(inputs, {...geometry, mode, start, stop, step}, sweep, candidate);
  }

  function status(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const {state, result, inputs, candidate} = job;
    return {id, state, result, inputs, candidate};
  }

  function artifact(id, filename) {
    const job = jobs.get(id);
    const names = job?.candidate === 'helmholtz' ? ['reference', 'side-branch'] : ['absorber'];
    if (job?.state !== 'succeeded' || !names.some(name => [name + '.mph', name + '.csv'].includes(filename))) return null;
    return createReadStream(join(job.dir, filename));
  }

  return {enabled, submit, submitThin, status, artifact};
}
