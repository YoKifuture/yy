import {spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {paperTemplates} from '../dist/paper-model.mjs';
import {panelResponse} from '../dist/absorbers.mjs';

const pdfReader = fileURLToPath(new URL('./read-paper.py', import.meta.url));
export const paperId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bad = message => Object.assign(new Error(message), {status: 422});
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export async function paperText(data, python) {
  if (!data?.pdf) {
    const value = text(data?.text, 90_001);
    if (value.length < 100 || value.length > 90_000) throw bad('请提供 100–90,000 字的论文正文，或选择有可提取文本的 PDF。');
    return value;
  }
  if (!python) throw bad('当前节点未配置 PDF 解析。可以粘贴论文正文。');
  if (typeof data.pdf !== 'string' || data.pdf.length > 13_400_000) throw bad('PDF 最大为 10 MB。');
  const bytes = Buffer.from(data.pdf, 'base64');
  if (bytes.length > 10_000_000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw bad('请选择格式有效且小于 10 MB 的 PDF。');
  return new Promise((accept, reject) => {
    const child = spawn(python, [pdfReader], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
    let output = '';
    const timer = setTimeout(() => child.kill(), 25_000);
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 90_000) child.kill();
    });
    child.once('error', () => reject(bad('PDF 解析器未启动。可改为粘贴论文正文。')));
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && output.length >= 100 && output.length <= 90_000) accept(output);
      else reject(bad('PDF 文本提取失败。请提供可选中文本的论文，或粘贴原文与图表数据。'));
    });
    child.stdin.end(bytes);
  });
}

export function preparePaper(data) {
  if (!Object.hasOwn(paperTemplates, data?.template)) throw bad('请选择与论文结构、边界和指标一致的模型。');
  const {template} = data;
  const model = paperTemplates[template];
  const title = text(data.title, 300);
  const source = text(data.source, 500);
  const figure = text(data.figure, 240);
  const evidence = text(data.evidence, 10_000);
  if (!(title && source && figure && evidence) || data.confirmed !== true) {
    throw bad('请核对论文、图表出处、参数来源和所选模型的边界条件。');
  }
  const geometry = {};
  for (const [key, label] of Object.entries(model.fields)) {
    const value = data.geometry?.[key];
    if (!Number.isFinite(value) || value <= 0 || value > 1500) throw bad(`请检查论文参数 ${label}。`);
    geometry[key] = value;
  }
  const {start, stop, count} = data.sweep ?? {};
  if (![start, stop].every(Number.isFinite) || !Number.isInteger(count) || count < 5 || count > 321 || !(stop > start && start >= 50)) {
    throw bad('请检查扫频范围（起始频率 ≥ 50 Hz，5–321 点）。');
  }
  const {length, width, height, hole, plate, ratio, depth, duct, neck, neckLength, cavityLength, cavityHeight} = geometry;
  const step = (stop - start) / (count - 1);
  if (step < .01) throw bad('扫频步长应至少为 0.01 Hz。');
  if (template === 'mpp') {
    const pitch = hole * Math.sqrt(Math.PI / (4 * ratio));
    if (stop > 2500 || ratio > .1 || plate + depth > height + 1e-8 || Math.min(length, width) < 5 * pitch
      || [start, stop].some(frequency => panelResponse(frequency, geometry) === null)) {
      throw bad('微穿孔板参数超出当前 Maa 模型、扫频或包络的适用条件。');
    }
  } else if (duct > 400 || stop > Math.min(2000, Math.floor(343000 / (2 * duct) * .9))
    || neck > cavityLength || cavityLength >= length || duct + neckLength + cavityHeight > height + 1e-8) {
    throw bad('侧支结构超出包络或二维刚壁单平面模态的适用条件。');
  }
  const reference = data.reference;
  const invalidLevel = template === 'mpp' ? value => value < 0 || value > 1 : value => Math.abs(value) > 150;
  if (!Array.isArray(reference) || reference.length < 5 || reference.length > 1000 || reference.some((point, index) =>
    !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] < start || point[0] > stop
    || (index > 0 && point[0] <= reference[index - 1][0]) || invalidLevel(point[1]))) {
    throw bad('对照曲线需要 5–1000 个扫频范围内的有效频点，按频率递增，指标与模板一致。');
  }
  if (reference[0][0] > start + step || reference.at(-1)[0] < stop - step) throw bad('论文对照频点应覆盖复现扫频的起止区间。');
  const {rmse, peakHz} = data.tolerances ?? {};
  if (!Number.isFinite(rmse) || !Number.isFinite(peakHz) || rmse <= 0 || rmse >= (template === 'mpp' ? 1 : 30)
    || peakHz <= 0 || peakHz >= stop - start) throw bad('请填写有效的曲线均方根误差和峰频偏差上限。');
  return {template, title, source, figure, evidence, geometry, sweep: {start, stop, step, count}, reference, tolerances: {rmse, peakHz}};
}

export function createPaperLibrary(folder, solver) {
  const root = resolve(folder);
  const read = id => readFile(join(root, id, 'case.json'), 'utf8').then(JSON.parse);
  async function list() {
    const names = await readdir(root).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records = await Promise.all(names.filter(id => paperId.test(id)).map(read));
    return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async function save(id) {
    const saved = await read(id).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (saved) return saved;
    const job = solver.status(id);
    if (!job?.paper || job.state !== 'succeeded' || !job.result?.comparison?.passed) throw bad('需有通过论文曲线对照的 COMSOL 求解结果。');
    const {series, comparison} = job.result;
    const {reference} = job.paper;
    const validatedBand = {low: reference[0][0], high: reference.at(-1)[0]};
    const entry = {id, ...job.paper, series, comparison, validatedBand, savedAt: new Date().toISOString()};
    const base = entry.template === 'mpp' ? 'absorber' : 'side-branch';
    await mkdir(root, {recursive: true});
    const staging = await mkdtemp(join(root, '.paper-'));
    try {
      for (const extension of ['mph', 'csv']) {
        const artifact = solver.artifact(id, base + '.' + extension);
        if (!artifact) throw bad('求解文件已失效，请重新求解。');
        await pipeline(artifact, createWriteStream(join(staging, 'model.' + extension)));
      }
      await writeFile(join(staging, 'case.json'), JSON.stringify(entry), {flag: 'wx'});
      try { await rename(staging, join(root, id)); }
      catch (error) {
        if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) return await read(id);
        throw error;
      }
      return entry;
    } finally {
      if (resolve(staging).startsWith(root + sep + '.paper-')) await rm(staging, {recursive: true, force: true});
    }
  }
  const artifact = (id, extension) => createReadStream(join(root, id, 'model.' + extension));
  return {list, save, read, artifact};
}
