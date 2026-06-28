import { removeBackground } from './lib/background-removal.js';
import { traceToSVG } from './lib/svg-tracer.js';
import { animateSVG } from './lib/svg-animator.js';
import { initTheme } from './ui/theme.js';
import { initUpload } from './ui/upload.js';
import { showProcessing, hideProcessing, updateProgress } from './ui/processing.js';
import { showResult, hideResult } from './ui/result.js';

// ===== State =====
let currentImage = null;
let currentSVG = null;
let simplifyLevel = 5;

// ===== Initialize =====
initTheme();
initUpload(handleFile);
initSnowfall();

// ===== Simplify Slider =====
const slider = document.getElementById('simplify-slider');
if (slider) {
  slider.addEventListener('input', (e) => {
    simplifyLevel = parseInt(e.target.value, 10);
  });
}

// ===== New Image Button =====
const btnNew = document.getElementById('btn-new');
if (btnNew) {
  btnNew.addEventListener('click', () => {
    hideResult();
    document.getElementById('upload-section').classList.remove('hidden');
    currentImage = null;
    currentSVG = null;
  });
}

// ===== Download Button =====
const btnDownload = document.getElementById('btn-download');
if (btnDownload) {
  btnDownload.addEventListener('click', () => {
    if (!currentSVG) return;
    const blob = new Blob([currentSVG], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'illustration.svg';
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ===== Replay Button =====
const btnReplay = document.getElementById('btn-replay');
if (btnReplay) {
  btnReplay.addEventListener('click', () => {
    const container = document.getElementById('svg-container');
    const svgEl = container.querySelector('svg');
    if (svgEl) {
      const speed = parseFloat(document.getElementById('anim-speed')?.value || 1);
      animateSVG(svgEl, speed);
    }
  });
}

// ===== Main Pipeline =====
async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;

  // Load image
  const img = await loadImage(file);
  currentImage = img;

  // Show processing
  document.getElementById('upload-section').classList.add('hidden');
  showProcessing('❄️ 冻结背景中...');

  try {
    // Step 1: Background removal
    updateProgress(10);
    const nobgBlob = await removeBackground(file, (progress) => {
      updateProgress(10 + progress * 40); // 10-50%
    });

    // Draw no-bg result
    const nobgCanvas = document.getElementById('nobg-canvas');
    const nobgUrl = URL.createObjectURL(nobgBlob);
    const nobgImg = await loadImage(nobgUrl);
    drawToCanvas(nobgCanvas, nobgImg);
    URL.revokeObjectURL(nobgUrl);

    // Draw original
    const origCanvas = document.getElementById('original-canvas');
    drawToCanvas(origCanvas, img);

    // Step 2: SVG tracing
    showProcessing('❄️ 生成冰晶 SVG...');
    updateProgress(55);

    const svgString = await traceToSVG(nobgBlob, {
      scale: 1,
      simplify: simplifyLevel,
    });

    currentSVG = svgString;
    updateProgress(90);

    // Step 3: Show result
    showProcessing('❄️ 冰冻成型...');
    const container = document.getElementById('svg-container');
    container.innerHTML = svgString;

    // Step 4: Animate SVG
    const svgEl = container.querySelector('svg');
    if (svgEl) {
      svgEl.style.width = '100%';
      svgEl.style.height = '100%';
      const speed = parseFloat(document.getElementById('anim-speed')?.value || 1);
      animateSVG(svgEl, speed);
    }

    updateProgress(100);

    // Show result section
    setTimeout(() => {
      hideProcessing();
      showResult();
    }, 300);

  } catch (err) {
    console.error('Processing failed:', err);
    hideProcessing();
    document.getElementById('upload-section').classList.remove('hidden');
    alert('处理失败: ' + err.message);
  }
}

// ===== Helpers =====
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (src instanceof Blob) {
      img.src = URL.createObjectURL(src);
    } else {
      img.src = src;
    }
  });
}

function drawToCanvas(canvas, img) {
  const maxDim = 512;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;

  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
}

// ===== Snowfall Effect =====
function initSnowfall() {
  const container = document.getElementById('snowfall');
  if (!container) return;

  const flakes = ['❄', '❅', '❆', '✦', '·'];
  const count = 25;

  for (let i = 0; i < count; i++) {
    const flake = document.createElement('span');
    flake.className = 'snowflake';
    flake.textContent = flakes[Math.floor(Math.random() * flakes.length)];
    flake.style.left = Math.random() * 100 + '%';
    flake.style.fontSize = (0.5 + Math.random() * 1) + 'rem';
    flake.style.opacity = 0.15 + Math.random() * 0.35;
    flake.style.animationDuration = (12 + Math.random() * 18) + 's';
    flake.style.animationDelay = -(Math.random() * 20) + 's';
    container.appendChild(flake);
  }
}
