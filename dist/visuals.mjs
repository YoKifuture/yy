export const colors = {
  accent: '--chart-accent', comparison: '--chart-comparison',
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
  const clearLock = output.parentElement.querySelector('.clear-lock');
  const legend = canvas.closest('.chart-panel').querySelector('.axis-note:has([data-series])');
  const cursor = {scale: null, index: null, pinned: null, hiddenSeries: new Set(), repaint: null};

  cursor.clear = () => {
    cursor.index = null;
    cursor.pinned = null;
    line.hidden = true;
    output.hidden = true;
    clearLock.hidden = true;
    line.classList.remove('locked');
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
    clearLock.hidden = cursor.pinned === null;
    line.classList.toggle('locked', cursor.pinned !== null);
  }

  function atPointer(event) {
    const {series, frequencyAt, left, right} = cursor.scale;
    const x = event.clientX - canvas.getBoundingClientRect().left;
    return x < left || x > right ? null : closestIndex(series[0].points, frequencyAt(x));
  }

  function pin(index) {
    cursor.pinned = cursor.scale.series[0].points[index][0];
    show(index);
  }

  cursor.restoreLock = () => {
    const {series, xMin, xMax} = cursor.scale;
    if (cursor.pinned < xMin || cursor.pinned > xMax) cursor.clear();
    else show(closestIndex(series[0].points, cursor.pinned));
  };

  function dismissPreview() {
    if (cursor.pinned === null) cursor.clear();
  }

  canvas.addEventListener('pointermove', event => {
    if (!cursor.scale || cursor.pinned !== null || event.pointerType === 'touch') return;
    const index = atPointer(event);
    if (index === null) cursor.clear();
    else show(index);
  });
  canvas.addEventListener('pointerleave', dismissPreview);
  canvas.addEventListener('blur', dismissPreview);
  canvas.addEventListener('click', event => {
    if (!cursor.scale) return;
    const index = atPointer(event);
    if (index === null) return;
    if (cursor.pinned === cursor.scale.series[0].points[index][0]) cursor.clear();
    else pin(index);
  });
  clearLock.addEventListener('click', () => {
    cursor.clear();
    canvas.focus();
  });
  canvas.addEventListener('keydown', event => {
    if (!cursor.scale || !['ArrowLeft', 'ArrowRight', 'Escape', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') return cursor.clear();
    if (event.key === 'Enter' || event.key === ' ') return cursor.pinned === null ? pin(cursor.index ?? 0) : cursor.clear();
    const last = cursor.scale.series[0].points.length - 1;
    const next = (cursor.index ?? (event.key === 'ArrowRight' ? -1 : last + 1)) + (event.key === 'ArrowRight' ? 1 : -1);
    const index = Math.min(last, Math.max(0, next));
    if (cursor.pinned === null) show(index);
    else pin(index);
  });
  const legendButtons = [...(legend?.querySelectorAll('[data-series]') ?? [])];
  for (const button of legendButtons) {
    const id = button.dataset.series;
    button.addEventListener('click', () => {
      if (cursor.hiddenSeries.has(id)) cursor.hiddenSeries.delete(id);
      else cursor.hiddenSeries.add(id);
      cursor.repaint?.();
    });
  }
  cursor.filter = series => {
    const hidden = cursor.hiddenSeries;
    if (series.length && series.every(line => hidden.has(line.id))) hidden.delete(series[0].id);
    const shown = series.filter(line => !hidden.has(line.id));
    if (legend) legend.hidden = !series.length;
    for (const button of legendButtons) {
      const id = button.dataset.series;
      const checked = !hidden.has(id);
      button.hidden = !series.some(line => line.id === id);
      button.setAttribute('aria-pressed', String(checked));
      button.disabled = checked && shown.length === 1;
    }
    return shown;
  };
  cursors.set(canvas, cursor);
  return cursor;
}

export function refreshCharts() {
  document.querySelectorAll('.plot canvas').forEach(canvas => {
    cursors.get(canvas)?.repaint?.();
  });
}

export function draw(canvas, series, band, yUnit, scaleUnit = false) {
  const cursor = chartCursor(canvas);
  cursor.repaint = () => draw(canvas, series, band, yUnit, scaleUnit);
  const shown = cursor.filter(series);
  if (cursor.pinned === null || !series.length) cursor.clear();
  cursor.scale = null;
  canvas.removeAttribute('tabindex');
  const frame = resizeCanvas(canvas);
  if (!frame || !series.length) return;
  const {width, height, context: ctx} = frame;
  const styles = getComputedStyle(canvas);
  const color = name => styles.getPropertyValue(name).trim();
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
    ctx.fillStyle = color('--chart-band');
    ctx.fillRect(from, top, until - from, bottom - top);
  }
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.strokeStyle = color('--chart-grid');
  ctx.fillStyle = color('--chart-text');
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
  for (const line of shown) {
    ctx.beginPath();
    ctx.strokeStyle = color(line.color);
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
    series: shown, left, right, xAt, xMin, xMax,
    unit: scaleUnit ? '' : ' dB',
    decimals: scaleUnit ? 3 : 2,
    frequencyAt: x => xMin + (x - left) * (xMax - xMin) / (right - left),
  };
  canvas.tabIndex = 0;
  if (cursor.pinned !== null) cursor.restoreLock();
}
