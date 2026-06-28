/**
 * Background removal using @imgly/background-removal
 * Runs entirely in the browser via ONNX Runtime Web
 */

let bgRemovalModule = null;

export async function removeBackground(file, onProgress) {
  // Lazy-load the module to avoid blocking initial page load
  if (!bgRemovalModule) {
    bgRemovalModule = await import('@imgly/background-removal');
  }

  const { removeBackground: removeBg } = bgRemovalModule;

  // Convert File to the right format
  const input = file instanceof Blob ? file : new Blob([file], { type: file.type });

  const result = await removeBg(input, {
    progress: (key, current, total) => {
      if (onProgress && total > 0) {
        onProgress(current / total);
      }
    },
    output: {
      format: 'image/png',
      quality: 1,
    },
    // Use public ONNX models from CDN
    model: 'medium', // 'small' | 'medium' | 'large' — medium is good balance
    fetchArgs: {
      cache: 'force-cache',
    },
  });

  return result;
}
