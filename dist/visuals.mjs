export const colors = {
  accent: '#63f7df', comparison: '#a79bff', band: '#55f5e41a', grid: '#9fbded22', text: '#a2b9cf',
};

function resizeCanvas(canvas) {
  const {width, height} = canvas.getBoundingClientRect();
  if (width < 1 || height < 1) return null;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  return {width, height, context};
}

export function drawWorkspaceWave(canvas) {
  const frame = resizeCanvas(canvas);
  if (!frame) return;
  const {width, height, context: ctx} = frame;
  const fade = ctx.createLinearGradient(0, 0, width, height * .3);
  fade.addColorStop(0, '#4df7db00');
  fade.addColorStop(.34, '#4df7db7a');
  fade.addColorStop(.68, '#78c6ffb0');
  fade.addColorStop(1, '#b29aff1f');

  ctx.lineWidth = 1;
  for (let row = 0; row < 19; row++) {
    const depth = row / 18;
    ctx.beginPath();
    ctx.strokeStyle = fade;
    ctx.globalAlpha = row % 6 === 0 ? .88 : .36;
    for (let column = 0; column <= 160; column++) {
      const progress = column / 160;
      const envelope = Math.sin(Math.PI * progress) ** 1.5;
      const phase = progress * 10.3 + depth * 4.1;
      const elevation = Math.sin(phase) * .24 + Math.sin(phase * 1.73 + .5) * .06;
      const x = width * progress;
      const y = height * (.46 + (depth - .5) * .69 + elevation * envelope);
      if (column === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function closestIndex(points, frequency) {
  let first = 0;
  let last = points.length - 1;
  while (first < last) {
    const middle = (first + last) >> 1;
    if (points[middle][0] < frequency) first = middle + 1;
    else last = middle;
  }
  return first > 0 && frequency - points[first - 1][0] < points[first][0] - frequency ? first - 1 : first;
}

const cursors = new WeakMap();

function chartCursor(canvas) {
  if (cursors.has(canvas)) return cursors.get(canvas);
  const line = canvas.parentElement.querySelector('.plot-crosshair');
  const output = document.getElementById(canvas.getAttribute('aria-describedby'));
  const cursor = {scale: null, index: null};

  cursor.clear = () => {
    cursor.index = null;
    line.hidden = true;
    output.hidden = true;
  };

  function show(index) {
    const {series, xAt, unit, decimals} = cursor.scale;
    const [frequency] = series[0].points[index];
    cursor.index = index;
    const frequencyText = value => value.toLocaleString('zh-CN', {maximumFractionDigits: 4, useGrouping: false}) + ' Hz';
    output.textContent = [frequencyText(frequency), ...series.map(({points, label}) => {
      const [at, value] = points[closestIndex(points, frequency)];
      const location = at === frequency ? '' : ' @ ' + frequencyText(at);
      return label + ' ' + value.toFixed(decimals) + unit + location;
    })].join('  ·  ');
    line.style.left = xAt(frequency) + 'px';
    line.hidden = false;
    output.hidden = false;
  }

  canvas.addEventListener('pointermove', event => {
    if (!cursor.scale) return;
    const {series, frequencyAt, left, right} = cursor.scale;
    const x = event.clientX - canvas.getBoundingClientRect().left;
    if (x < left || x > right) return cursor.clear();
    show(closestIndex(series[0].points, frequencyAt(x)));
  });
  canvas.addEventListener('pointerleave', cursor.clear);
  canvas.addEventListener('blur', cursor.clear);
  canvas.addEventListener('keydown', event => {
    if (!cursor.scale || !['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') return cursor.clear();
    const last = cursor.scale.series[0].points.length - 1;
    const next = (cursor.index ?? (event.key === 'ArrowRight' ? -1 : last + 1)) + (event.key === 'ArrowRight' ? 1 : -1);
    show(Math.min(last, Math.max(0, next)));
  });
  cursors.set(canvas, cursor);
  return cursor;
}

export function draw(canvas, series, band, yUnit, scaleUnit = false) {
  const cursor = chartCursor(canvas);
  cursor.clear();
  cursor.scale = null;
  canvas.removeAttribute('tabindex');
  const frame = resizeCanvas(canvas);
  if (!frame || !series.length) return;
  const {width, height, context: ctx} = frame;
  const left = 49;
  const right = width - 20;
  const top = 26;
  const bottom = height - 38;
  if (right <= left || bottom <= top) return;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const line of series) {
    for (const [frequency, value] of line.points) {
      xMin = Math.min(xMin, frequency);
      xMax = Math.max(xMax, frequency);
      yMin = Math.min(yMin, value);
      yMax = Math.max(yMax, value);
    }
  }
  if (xMax <= xMin) return;
  const ySpan = Math.max(yMax - yMin, 1);
  yMin = scaleUnit ? 0 : Math.floor(yMin - ySpan * .08);
  yMax = scaleUnit ? 1 : Math.ceil(yMax + ySpan * .09);
  const xAt = frequency => left + (frequency - xMin) * (right - left) / (xMax - xMin);
  const yAt = value => bottom - (value - yMin) * (bottom - top) / (yMax - yMin);
  if (band && band.high > xMin && band.low < xMax) {
    const from = xAt(Math.max(xMin, band.low));
    const until = xAt(Math.min(xMax, band.high));
    ctx.fillStyle = colors.band;
    ctx.fillRect(from, top, until - from, bottom - top);
  }
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  for (let i = 0; i <= 4; i++) {
    const value = yMin + i * (yMax - yMin) / 4;
    const y = yAt(value);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(scaleUnit ? value.toFixed(2) : String(Math.round(value)), left - 8, y);
  }
  const ticks = width < 460 ? 3 : 5;
  for (let i = 0; i <= ticks; i++) {
    const value = xMin + i * (xMax - xMin) / ticks;
    const x = xAt(value);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(String(Number(value.toFixed(xMax - xMin < ticks ? 2 : 0))), x, bottom + 12);
  }
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(yUnit, left, 12);
  ctx.textAlign = 'right';
  ctx.fillText('频率 / Hz', right, height - 10);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 1, top - 3, right - left + 2, bottom - top + 6);
  ctx.clip();
  for (const line of series) {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    line.points.forEach(([frequency, value], index) => {
      if (index === 0) ctx.moveTo(xAt(frequency), yAt(value));
      else ctx.lineTo(xAt(frequency), yAt(value));
    });
    ctx.stroke();
  }
  ctx.restore();
  cursor.scale = {
    series, left, right, xAt,
    unit: scaleUnit ? '' : ' dB',
    decimals: scaleUnit ? 3 : 2,
    frequencyAt: x => xMin + (x - left) * (xMax - xMin) / (right - left),
  };
  canvas.tabIndex = 0;
}
