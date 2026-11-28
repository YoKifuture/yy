import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanInputs, cleanThin, runThinTurn, runTurn} from '../dist/agent.mjs';
import {createCodex} from './codex.mjs';
import {createSolver} from './solver.mjs';
import {createPaperLibrary, paperId, paperText, preparePaper} from './papers.mjs';

const webRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const provider = createCodex(process.env.HOOD_CODEX_COMMAND);
const solver = createSolver(process.env.HOOD_COMSOL_BIN);
const paperPython = process.env.HOOD_PAPER_PYTHON;
const paperLibrary = createPaperLibrary(process.env.HOOD_PAPER_LIBRARY || fileURLToPath(new URL('../models/papers/', import.meta.url)), solver);
const host = process.env.HOOD_HOST || '127.0.0.1';
const port = Number(process.env.HOOD_PORT || 8768);
const publicHost = process.env.HOOD_PUBLIC_HOST?.toLowerCase();
const publicUrl = publicHost && new URL('https://' + publicHost + '/');
const accessToken = process.env.HOOD_ACCESS_TOKEN;
if (publicUrl && (publicUrl.host !== publicHost || publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password)) {
  throw new Error('HOOD_PUBLIC_HOST must be a hostname with an optional port.');
}
if (publicHost && (!accessToken || accessToken.length < 24)) {
  throw new Error('HOOD_ACCESS_TOKEN must contain at least 24 characters for network access.');
}
const digest = value => createHash('sha256').update(value).digest();
const remoteLogin = accessToken && digest('acoustic:' + accessToken);
const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json'};

function json(response, status, data) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(data));
}

async function body(request, maxBytes = 24_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求超过大小限制。'), {status: 413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求需要有效的 JSON。'), {status: 400}); }
}

createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const authority = request.headers.host?.toLowerCase();
    if (!authority || ![publicHost, `127.0.0.1:${port}`, `localhost:${port}`].includes(authority)) {
      return json(response, 403, {error: '此服务地址未配置。'});
    }
    if (publicHost && authority === publicHost) {
      response.setHeader('Cache-Control', 'private, no-store');
      const supplied = request.headers.authorization?.match(/^Basic ([A-Za-z0-9+/=]+)$/i)?.[1];
      if (!supplied || !timingSafeEqual(digest(Buffer.from(supplied, 'base64')), remoteLogin)) {
        response.setHeader('WWW-Authenticate', 'Basic realm="Acoustic Lab", charset="UTF-8"');
        return json(response, 401, {error: '此工作区需要访问凭据。'});
      }
    }
    const path = new URL(request.url, 'http://localhost').pathname;
    const method = request.method;
    if (method === 'POST' && path.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (origin && ![`http://${authority}`, `https://${authority}`].includes(origin)) {
        return json(response, 403, {error: '请从应用网页发起请求。'});
      }
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json(response, 415, {error: '请求需要 application/json 格式。'});
      }
    }
    if (method === 'GET' && path === '/api/status') {
      return json(response, 200, {codex: !!provider, solver: solver.enabled, papers: true, paperPdf: !!paperPython, publicUrl: publicUrl?.href});
    }
    if (method === 'POST' && path === '/api/papers/analyze') {
      if (!provider) return json(response, 503, {error: '当前节点未配置 Codex。可以手工核对并填写论文工况。'});
      const data = await body(request, 13_410_000);
      const sourceText = await paperText(data, paperPython);
      try {
        const result = await provider({text: sourceText, focus: typeof data.focus === 'string' ? data.focus.slice(0, 400) : ''}, 'paper');
        return json(response, 200, result);
      } catch (error) {
        console.error(error.message);
        return json(response, 502, {error: '论文解析未完成。可重试，或按原文手工填写工况。'});
      }
    }
    if (method === 'POST' && path === '/api/papers/jobs') {
      const result = solver.submitPaper(preparePaper(await body(request, 96_000)));
      return json(response, result.status || 202, result);
    }
    if (method === 'GET' && path === '/api/papers') {
      return json(response, 200, {entries: (await paperLibrary.list()).map(({reference, ...entry}) => entry)});
    }
    if (method === 'POST' && path === '/api/papers') {
      const data = await body(request);
      if (typeof data?.id !== 'string' || !paperId.test(data.id)) return json(response, 400, {error: '无效的复现任务编号。'});
      return json(response, 200, await paperLibrary.save(data.id));
    }
    const paperMatch = path.match(/^\/api\/papers\/([a-f0-9-]+)\/(model\.(mph|csv)|case\.json)$/);
    if (method === 'GET' && paperMatch && paperId.test(paperMatch[1])) {
      const [_, id, name, extension] = paperMatch;
      const entry = await paperLibrary.read(id).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!entry) return json(response, 404, {error: '复现记录不存在。'});
      response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      if (!extension) return json(response, 200, entry);
      response.writeHead(200, {'Content-Type': 'application/octet-stream'});
      const artifact = paperLibrary.artifact(id, extension);
      artifact.on('error', () => response.destroy());
      return artifact.pipe(response);
    }
    if (method === 'POST' && path === '/api/agent') {
      const data = await body(request);
      const message = typeof data?.message === 'string' ? data.message.trim() : '';
      if (!message || message.length > 1800) return json(response, 400, {error: '请输入不超过 1800 字的需求。'});
      const thin = data.track === 'thin';
      const inputs = (thin ? cleanThin : cleanInputs)(data.inputs);
      const peak = Number.isFinite(data.peak?.low) && Number.isFinite(data.peak?.high) ? {low: data.peak.low, high: data.peak.high} : null;
      let proposed;
      let mode = 'local';
      if (provider) {
        try {
          proposed = await provider({message, inputs});
          mode = 'codex';
        } catch (error) {
          console.error(error.message);
          mode = 'fallback';
        }
      }
      const run = thin ? runThinTurn : runTurn;
      return json(response, 200, {...run({message, inputs, peak, proposed, profile: data.profile, activeCandidate: data.activeCandidate}), mode});
    }
    if (method === 'POST' && path === '/api/jobs') {
      const data = await body(request);
      const result = data?.track === 'thin'
        ? solver.submitThin(cleanThin(data.inputs), data.candidate)
        : solver.submit(cleanInputs(data?.inputs));
      return json(response, result.status || 202, result);
    }
    const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/((?:reference|side-branch|absorber)\.(?:mph|csv)))?$/);
    if (method === 'GET' && match) {
      if (!match[2]) {
        const result = solver.status(match[1]);
        return json(response, result ? 200 : 404, result || {error: '求解任务不存在。'});
      }
      const artifact = solver.artifact(match[1], match[2]);
      if (!artifact) return json(response, 404, {error: '求解文件不可用。'});
      response.writeHead(200, {'Content-Disposition': `attachment; filename="${match[2]}"`, 'Content-Type': 'application/octet-stream'});
      artifact.on('error', () => response.destroy());
      return artifact.pipe(response);
    }
    if (method !== 'GET' && method !== 'HEAD') return json(response, 405, {error: '操作不受支持。'});
    const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const file = resolve(webRoot, relative);
    const type = types[extname(file)];
    if (!file.startsWith(resolve(webRoot) + sep) || !type || !(await stat(file).catch(() => null))?.isFile()) {
      return json(response, 404, {error: '页面不存在。'});
    }
    response.writeHead(200, {'Content-Type': `${type}; charset=utf-8`});
    if (method === 'HEAD') return response.end();
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) json(response, error.status || 500, {error: error.status ? error.message : '服务暂时不可用。'});
  }
}).listen(port, host, () => console.log(`http://${host}:${port}/ · Codex ${provider ? 'enabled' : 'off'} · COMSOL ${solver.enabled ? 'enabled' : 'off'}`));
