/**
 * SVG Drawing Animation
 * Animates SVG paths to simulate a hand-drawing effect
 */

export function animateSVG(svgEl, speed = 1) {
  // Remove any existing animation classes
  svgEl.classList.remove('svg-animate-done');

  // Get all drawable elements
  const paths = svgEl.querySelectorAll('path, polygon, polyline, circle, ellipse, rect, line');
  if (paths.length === 0) return;

  // Reset all paths
  paths.forEach((el) => {
    el.style.transition = 'none';
    el.style.opacity = '0';
  });

  // Force reflow
  void svgEl.offsetHeight;

  // Animate each path sequentially
  const baseDelay = 200 / speed; // ms between each path
  const drawDuration = 600 / speed; // ms for each path to draw

  paths.forEach((el, index) => {
    const tagName = el.tagName.toLowerCase();
    const delay = index * baseDelay;

    // Get path length for stroke animation
    let pathLength = 0;
    try {
      if (el.getTotalLength) {
        pathLength = el.getTotalLength();
      }
    } catch {
      // Some elements don't support getTotalLength
    }

    if (pathLength > 0) {
      // Stroke drawing animation
      el.style.strokeDasharray = pathLength;
      el.style.strokeDashoffset = pathLength;
      el.style.transition = 'none';

      // Start animation after delay
      setTimeout(() => {
        el.style.transition = `stroke-dashoffset ${drawDuration}ms ease-in-out, opacity ${drawDuration * 0.3}ms ease-in`;
        el.style.opacity = '1';
        el.style.strokeDashoffset = '0';

        // After stroke is drawn, fill fades in
        if (el.style.fill && el.style.fill !== 'none') {
          const originalFill = el.getAttribute('fill') || '';
          if (originalFill && originalFill !== 'none') {
            el.style.fillOpacity = '0';
            setTimeout(() => {
              el.style.transition = `fill-opacity ${drawDuration * 0.5}ms ease-in`;
              el.style.fillOpacity = '1';
            }, drawDuration * 0.6);
          }
        }
      }, delay);
    } else {
      // Simple fade-in for shapes without path length
      setTimeout(() => {
        el.style.transition = `opacity ${drawDuration * 0.5}ms ease-in`;
        el.style.opacity = '1';
      }, delay);
    }
  });

  // Mark as done after all animations complete
  const totalTime = paths.length * baseDelay + drawDuration + 200;
  setTimeout(() => {
    svgEl.classList.add('svg-animate-done');
  }, totalTime);
}

/**
 * Prepare SVG for animation by ensuring all paths have strokes
 */
export function prepareForAnimation(svgEl) {
  const paths = svgEl.querySelectorAll('path, polygon, polyline');

  paths.forEach((el) => {
    // Ensure stroke exists for dash animation
    if (!el.getAttribute('stroke') || el.getAttribute('stroke') === 'none') {
      el.setAttribute('stroke', el.getAttribute('fill') || 'currentColor');
      el.setAttribute('stroke-width', '0.5');
    }
  });
}
