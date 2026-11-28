function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // The controls still work for the current page when storage is unavailable.
  }
}

export function setupAppearance(onThemeChange) {
  const themeControl = document.getElementById('appearance');
  const canvas = document.getElementById('workspace-wave');
  const hero = canvas.parentElement;
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const initialTheme = stored('acoustic-theme');
  themeControl.value = ['light', 'dark'].includes(initialTheme) ? initialTheme : 'system';
  let light = false;
  let clock = 0;
  let animation = null;
  let lastFrame = null;
  let visible = true;
  let frame = null;
  let targetX = 0;
  let targetY = 0;
  let offsetX = 0;
  let offsetY = 0;

  function waveY(progress, depth) {
    const phase = progress * 10.3 + depth * 4.1 - clock * .67;
    const envelope = Math.sin(Math.PI * progress) ** 1.5;
    return frame.height * (.48 + (depth - .5) * .71 + (Math.sin(phase) * .22 + Math.sin(phase * 1.73 + .5) * .055) * envelope)
      + offsetY * envelope;
  }

  function render() {
    if (!frame) return;
    const {width, height, context} = frame;
    const fade = context.createLinearGradient(0, 0, width, height * .4);
    fade.addColorStop(0, '#448ad800');
    fade.addColorStop(.28, light ? '#008c9f7f' : '#61ffd59c');
    fade.addColorStop(.69, light ? '#4069cbbd' : '#7bafffd6');
    fade.addColorStop(1, light ? '#7165de38' : '#b998ff65');
    context.clearRect(0, 0, width, height);
    context.strokeStyle = fade;
    context.lineWidth = 1;

    for (let row = 0; row < 16; row++) {
      const depth = row / 15;
      context.beginPath();
      context.globalAlpha = row % 5 === 0 ? .92 : .46;
      for (let step = 0; step <= 80; step++) {
        const progress = step / 80;
        const x = progress * width + offsetX * Math.sin(Math.PI * progress);
        if (step === 0) context.moveTo(x, waveY(progress, depth));
        else context.lineTo(x, waveY(progress, depth));
      }
      context.stroke();
    }

    const count = width < 500 ? 26 : 55;
    for (let index = 0; index < count; index++) {
      const progress = (index * .618033 + clock * (.033 + index % 6 * .009)) % 1;
      const depth = ((index * 11) % 16) / 15;
      const x = progress * width + offsetX * Math.sin(Math.PI * progress);
      const y = waveY(progress, depth);
      context.globalAlpha = Math.sin(Math.PI * progress) * (.38 + index % 4 * .15);
      context.fillStyle = index % 4 === 0 ? (light ? '#5541b7' : '#d3bbff')
        : (light ? '#007f9b' : '#94ffe5');
      const radius = index % 9 === 0 ? 2.6 : 1 + (index % 4) * .27;
      if (index % 9 === 0) {
        context.beginPath();
        context.arc(x, y, radius * 3, 0, Math.PI * 2);
        context.globalAlpha *= .16;
        context.fill();
        context.globalAlpha *= 4;
      }
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function tick(now) {
    if (lastFrame === null || now - lastFrame >= 32) {
      if (lastFrame !== null) clock += Math.min(64, now - lastFrame) / 1000;
      offsetX += (targetX - offsetX) * .12;
      offsetY += (targetY - offsetY) * .12;
      render();
      lastFrame = now;
    }
    animation = requestAnimationFrame(tick);
  }

  function syncAnimation() {
    const animate = !reducedMotion.matches && visible && !document.hidden;
    if (animate && animation === null) animation = requestAnimationFrame(tick);
    if (!animate && animation !== null) {
      cancelAnimationFrame(animation);
      animation = null;
      lastFrame = null;
    }
  }

  function updateTheme() {
    light = themeControl.value === 'light' || (themeControl.value === 'system' && systemLight.matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]').content = light ? '#e8f2f9' : '#08111f';
    render();
    onThemeChange();
  }

  themeControl.addEventListener('change', () => {
    stored('acoustic-theme', themeControl.value);
    updateTheme();
  });
  hero.addEventListener('pointermove', event => {
    if (reducedMotion.matches || event.pointerType === 'touch') return;
    const bounds = hero.getBoundingClientRect();
    targetX = ((event.clientX - bounds.left) / bounds.width - .5) * 24;
    targetY = ((event.clientY - bounds.top) / bounds.height - .5) * 20;
  });
  hero.addEventListener('pointerleave', () => { targetX = targetY = 0; });
  systemLight.addEventListener('change', updateTheme);
  reducedMotion.addEventListener('change', syncAnimation);
  document.addEventListener('visibilitychange', syncAnimation);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncAnimation();
  }).observe(hero);
  new ResizeObserver(() => {
    const {width, height} = canvas.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    frame = {width, height, context};
    render();
  }).observe(canvas);
  updateTheme();
  syncAnimation();
}
