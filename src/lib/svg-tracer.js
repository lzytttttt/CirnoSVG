/**
 * Image to SVG — thin wrapper that delegates heavy processing to a Web Worker.
 * All algorithm code lives in svg-tracer-worker.js and runs off the main thread.
 */

export function traceToSVG(blob, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./svg-tracer-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.svgString);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ blob, options });
  });
}
