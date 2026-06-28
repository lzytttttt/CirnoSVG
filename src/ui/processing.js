/**
 * Processing UI state management
 */

export function showProcessing(text = '处理中...') {
  const section = document.getElementById('processing-section');
  const textEl = document.getElementById('processing-text');
  if (section) section.classList.remove('hidden');
  if (textEl) textEl.textContent = text;
  updateProgress(0);
}

export function hideProcessing() {
  const section = document.getElementById('processing-section');
  if (section) section.classList.add('hidden');
}

export function updateProgress(percent) {
  const fill = document.getElementById('progress-fill');
  if (fill) {
    fill.style.width = Math.min(100, Math.max(0, percent)) + '%';
  }
}
