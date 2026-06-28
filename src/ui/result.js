/**
 * Result section UI state
 */

export function showResult() {
  const section = document.getElementById('result-section');
  if (section) section.classList.remove('hidden');
}

export function hideResult() {
  const section = document.getElementById('result-section');
  if (section) section.classList.add('hidden');
}
