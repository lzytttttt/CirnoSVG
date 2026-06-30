// Web Worker for heavy image processing
// Receives: { blob, options }
// Returns: { svgString } or { error }

self.onmessage = async function(e) {
  const { blob, options = {} } = e.data;
  try {
    const svgString = await traceToSVG(blob, options);
    self.postMessage({ svgString });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

/**
 * Image to SVG — custom contour-tracing pipeline.
 * Optimized version running in Web Worker context.
 *
 * 1. Preprocess: bilateral smooth + local contrast boost
 * 2. Segment: superpixel-like region growing on the gradient landscape
 * 3. Contour: trace boundaries between adjacent regions
 * 4. Simplify: Douglas-Peucker path reduction
 * 5. Fill: sample average color per region
 * 6. Assemble SVG from contour paths
 */
async function traceToSVG(blob, options = {}) {
  const { simplify = 5, scale = 1 } = options;

  const bitmap = await createImageBitmap(blob);

  const maxDim = 800;
  let w = bitmap.width;
  let h = bitmap.height;
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  let imageData = ctx.getImageData(0, 0, w, h);

  // Step 1: pixel-level cleanup
  cleanupAlpha(imageData);

  // Step 1.5: dilate subject edges to cover semi-transparent background removal artifacts
  dilateEdges(imageData, 2);

  // Step 1.6: fill remaining interior holes
  fillInteriorHoles(imageData);

  // Step 2: preprocess — bilateral smooth + CLAHE
  preprocess(imageData, simplify);

  // Step 3: segment into regions
  const segResult = segment(imageData, simplify);

  // Step 4: extract contours + fill colors
  const paths = extractContours(segResult, imageData, simplify);

  // Step 5: assemble SVG
  return buildSVG(paths, w, h, scale);
}

// ============================================================
// Step 1: Alpha cleanup
// ============================================================

function cleanupAlpha(imageData) {
  const { data, width, height } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 100) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
    } else {
      data[i + 3] = 255;
    }
  }
  // Remove isolated pixels
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (src[idx + 3] === 0) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if (src[(ny * width + nx) * 4 + 3] >= 200) n++;
        }
      }
      if (n < 2) data[idx] = data[idx + 1] = data[idx + 2] = data[idx + 3] = 0;
    }
  }
}

// ============================================================
// Step 1.5: Edge dilation to cover semi-transparent artifacts
// ============================================================

/**
 * Expand the opaque subject mask by `radius` pixels.
 * Semi-transparent edges from background removal get covered
 * by the nearest opaque subject color, eliminating gray fragments.
 */
function dilateEdges(imageData, radius) {
  const { data, width, height } = imageData;
  const len = width * height;

  for (let pass = 0; pass < radius; pass++) {
    // Find transparent pixels adjacent to opaque pixels
    const toFill = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (data[i * 4 + 3] > 0) continue; // already opaque

        // Check 4-neighbors for opaque pixel
        let bestI = -1, bestDist = Infinity;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (data[ni * 4 + 3] > 0) {
            // Prefer neighbor with higher alpha (more confident)
            if (data[ni * 4 + 3] < bestDist) {
              bestDist = data[ni * 4 + 3];
              bestI = ni;
            }
          }
        }
        if (bestI >= 0) {
          toFill.push([i, bestI]);
        }
      }
    }

    // Apply dilation
    for (const [target, source] of toFill) {
      data[target * 4] = data[source * 4];
      data[target * 4 + 1] = data[source * 4 + 1];
      data[target * 4 + 2] = data[source * 4 + 2];
      data[target * 4 + 3] = 255;
    }
  }
}

// ============================================================
// Step 1.6: Fill interior holes in subject mask
// ============================================================

/**
 * Fill transparent pixels that are inside the subject (not connected to image edges).
 * Uses flood fill from edges to identify true background, then fills remaining
 * transparent pixels with nearest opaque neighbor color.
 */
function fillInteriorHoles(imageData) {
  const { data, width, height } = imageData;
  const len = width * height;

  // Phase 1: Flood fill from edges to mark true background
  const isBg = new Uint8Array(len); // 1 = connected to edge (true background)
  const queue = [];

  // Seed: all transparent pixels on image edges
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const i = y * width + x;
      if (data[i * 4 + 3] === 0 && !isBg[i]) {
        isBg[i] = 1;
        queue.push(i);
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) {
      const i = y * width + x;
      if (data[i * 4 + 3] === 0 && !isBg[i]) {
        isBg[i] = 1;
        queue.push(i);
      }
    }
  }

  // BFS to propagate background label through connected transparent pixels
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % width, y = (i / width) | 0;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (data[ni * 4 + 3] === 0 && !isBg[ni]) {
        isBg[ni] = 1;
        queue.push(ni);
      }
    }
  }

  // Phase 2: Find interior holes (transparent but NOT connected to edge)
  // and fill them with nearest opaque neighbor color
  const holes = [];
  for (let i = 0; i < len; i++) {
    if (data[i * 4 + 3] === 0 && !isBg[i]) {
      holes.push(i);
    }
  }

  if (holes.length === 0) return;

  // For each hole pixel, find nearest opaque pixel via expanding search
  for (const i of holes) {
    const x = i % width, y = (i / width) | 0;
    let found = false;
    // Search in expanding radius (max 10 pixels)
    for (let r = 1; r <= 10 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // only check perimeter
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (data[ni * 4 + 3] > 0) {
            data[i * 4] = data[ni * 4];
            data[i * 4 + 1] = data[ni * 4 + 1];
            data[i * 4 + 2] = data[ni * 4 + 2];
            data[i * 4 + 3] = 255;
            found = true;
          }
        }
      }
    }
  }
}

// ============================================================
// Step 2: Preprocessing — separable bilateral filter
// ============================================================

function preprocess(imageData, simplify) {
  const { data, width, height } = imageData;
  const len = width * height;

  // Build RGB arrays (only foreground)
  const r = new Float32Array(len);
  const g = new Float32Array(len);
  const b = new Float32Array(len);
  const fg = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    if (data[idx + 3] > 0) {
      r[i] = data[idx]; g[i] = data[idx + 1]; b[i] = data[idx + 2];
      fg[i] = 1;
    }
  }

  // Bilateral filter parameters
  const radius = Math.max(1, Math.round(2 + (10 - simplify) * 0.3));
  const sigmaS = radius * 1.5;
  const sigmaR = 20 + (10 - simplify) * 5;

  const tempR = new Float32Array(len);
  const tempG = new Float32Array(len);
  const tempB = new Float32Array(len);
  const outR = new Float32Array(len);
  const outG = new Float32Array(len);
  const outB = new Float32Array(len);

  // Pass 1: horizontal (dx only, dy=0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fg[i]) continue;

      let wSum = 0, sr = 0, sg = 0, sb = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const j = y * width + nx;
        if (!fg[j]) continue;
        const spatialDist = (dx * dx) / (2 * sigmaS * sigmaS);
        const dr = r[i] - r[j], dg = g[i] - g[j], db = b[i] - b[j];
        const colorDist = (dr * dr + dg * dg + db * db) / (2 * sigmaR * sigmaR);
        const w = Math.exp(-spatialDist - colorDist);
        wSum += w; sr += w * r[j]; sg += w * g[j]; sb += w * b[j];
      }

      if (wSum > 0) {
        tempR[i] = sr / wSum; tempG[i] = sg / wSum; tempB[i] = sb / wSum;
      }
    }
  }

  // Pass 2: vertical (dy only, dx=0), using temp as input
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fg[i]) continue;

      let wSum = 0, sr = 0, sg = 0, sb = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const j = ny * width + x;
        if (!fg[j]) continue;
        const spatialDist = (dy * dy) / (2 * sigmaS * sigmaS);
        const dr = tempR[i] - tempR[j], dg = tempG[i] - tempG[j], db = tempB[i] - tempB[j];
        const colorDist = (dr * dr + dg * dg + db * db) / (2 * sigmaR * sigmaR);
        const w = Math.exp(-spatialDist - colorDist);
        wSum += w; sr += w * tempR[j]; sg += w * tempG[j]; sb += w * tempB[j];
      }

      if (wSum > 0) {
        outR[i] = sr / wSum; outG[i] = sg / wSum; outB[i] = sb / wSum;
      }
    }
  }

  // Write back
  for (let i = 0; i < len; i++) {
    if (!fg[i]) continue;
    const idx = i * 4;
    data[idx] = Math.round(outR[i]);
    data[idx + 1] = Math.round(outG[i]);
    data[idx + 2] = Math.round(outB[i]);
  }
}

// ============================================================
// Step 3: Superpixel segmentation (SLIC-like)
// ============================================================

function segment(imageData, simplify) {
  const { data, width, height } = imageData;
  const len = width * height;

  // Grid spacing: fewer seeds = larger regions = simpler SVG
  const S = Math.max(6, Math.round(20 - simplify * 1.2));
  const numX = Math.ceil(width / S);
  const numY = Math.ceil(height / S);

  // Initialise seed grid — each seed: { x, y, r, g, b }
  const seeds = [];
  for (let gy = 0; gy < numY; gy++) {
    for (let gx = 0; gx < numX; gx++) {
      // Move seed to lowest-gradient position in 3×3 neighbourhood
      let bestX = gx * S + (S >> 1);
      let bestY = gy * S + (S >> 1);
      bestX = Math.min(bestX, width - 1);
      bestY = Math.min(bestY, height - 1);

      const idx = (bestY * width + bestX) * 4;
      if (data[idx + 3] === 0) continue; // skip background seeds
      seeds.push({
        x: bestX, y: bestY,
        r: data[idx], g: data[idx + 1], b: data[idx + 2],
      });
    }
  }

  // Precompute grayscale gradient for boundary weighting
  const gray = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  // Assign each pixel to nearest seed (in space + color)
  const labels = new Int32Array(len).fill(-1);
  const dists = new Float32Array(len).fill(Infinity);
  const m = 4 + (10 - simplify) * 0.6; // compactness: higher = more compact regions
  const mSq = m * m;
  const sSq = S * S;

  // 3 iterations of assignment + update (enough for convergence)
  for (let iter = 0; iter < 3; iter++) {
    // BUG FIX: Reset distances before each iteration
    dists.fill(Infinity);

    // Assignment
    for (let si = 0; si < seeds.length; si++) {
      const seed = seeds[si];
      const yMin = Math.max(0, seed.y - S * 2);
      const yMax = Math.min(height - 1, seed.y + S * 2);
      const xMin = Math.max(0, seed.x - S * 2);
      const xMax = Math.min(width - 1, seed.x + S * 2);

      for (let y = yMin; y <= yMax; y++) {
        for (let x = xMin; x <= xMax; x++) {
          const i = y * width + x;
          if (data[i * 4 + 3] === 0) continue;

          const dx = x - seed.x, dy = y - seed.y;
          const dSpatial = (dx * dx + dy * dy) / sSq;
          const dr = data[i * 4] - seed.r;
          const dg = data[i * 4 + 1] - seed.g;
          const db = data[i * 4 + 2] - seed.b;
          const dColor = (dr * dr + dg * dg + db * db) / (255 * 255);
          const d = Math.sqrt(dSpatial * mSq + dColor);

          if (d < dists[i]) {
            dists[i] = d;
            labels[i] = si;
          }
        }
      }
    }

    // Update seeds to cluster centres
    const sumX = new Float64Array(seeds.length);
    const sumY = new Float64Array(seeds.length);
    const sumR = new Float64Array(seeds.length);
    const sumG = new Float64Array(seeds.length);
    const sumB = new Float64Array(seeds.length);
    const cnt = new Int32Array(seeds.length);

    for (let i = 0; i < len; i++) {
      const si = labels[i];
      if (si < 0) continue;
      const idx = i * 4;
      sumX[si] += i % width;
      sumY[si] += (i / width) | 0;
      sumR[si] += data[idx];
      sumG[si] += data[idx + 1];
      sumB[si] += data[idx + 2];
      cnt[si]++;
    }

    for (let si = 0; si < seeds.length; si++) {
      if (cnt[si] === 0) continue;
      seeds[si].x = Math.round(sumX[si] / cnt[si]);
      seeds[si].y = Math.round(sumY[si] / cnt[si]);
      seeds[si].r = Math.round(sumR[si] / cnt[si]);
      seeds[si].g = Math.round(sumG[si] / cnt[si]);
      seeds[si].b = Math.round(sumB[si] / cnt[si]);
    }
  }

  // Post-process: enforce connectivity, merge tiny regions
  enforceConnectivity(labels, data, width, height, seeds.length);

  return { labels, seeds, width, height };
}

/**
 * Merge tiny disconnected regions into their largest neighbour.
 * Optimized: single-pass pixel index instead of per-region full scan.
 */
function enforceConnectivity(labels, data, width, height, numSeeds) {
  const len = width * height;
  const minSize = Math.max(20, len / numSeeds * 0.3);

  // Build per-region pixel index in single pass
  const regionPixels = new Map(); // si → pixel indices array
  for (let i = 0; i < len; i++) {
    const si = labels[i];
    if (si < 0) continue;
    let arr = regionPixels.get(si);
    if (!arr) { arr = []; regionPixels.set(si, arr); }
    arr.push(i);
  }

  // For each undersized region, find best neighbor and merge
  for (const [si, pixels] of regionPixels) {
    if (pixels.length >= minSize) continue;

    // Find most common neighbour from this region's pixels
    const neighbourCount = new Map();
    for (const i of pixels) {
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = ny * width + nx;
        const nl = labels[ni];
        if (nl >= 0 && nl !== si) {
          neighbourCount.set(nl, (neighbourCount.get(nl) || 0) + 1);
        }
      }
    }

    let bestNeighbour = -1, bestCount = 0;
    for (const [nl, cnt] of neighbourCount) {
      if (cnt > bestCount) { bestCount = cnt; bestNeighbour = nl; }
    }

    if (bestNeighbour >= 0) {
      for (const i of pixels) {
        labels[i] = bestNeighbour;
      }
    }
  }
}

// ============================================================
// Step 4: Extract contours between regions + fill colors
// ============================================================

function extractContours(segResult, imageData, simplify) {
  const { labels, seeds, width, height } = segResult;
  const { data } = imageData;
  const len = width * height;

  // Find unique labels and compute average colors
  const usedLabels = new Set();
  for (let i = 0; i < len; i++) {
    if (labels[i] >= 0) usedLabels.add(labels[i]);
  }

  // Build region colour map from actual pixels (more accurate than seed colour)
  const sumR = new Map(), sumG = new Map(), sumB = new Map(), cnt = new Map();
  for (let i = 0; i < len; i++) {
    const si = labels[i];
    if (si < 0) continue;
    const idx = i * 4;
    sumR.set(si, (sumR.get(si) || 0) + data[idx]);
    sumG.set(si, (sumG.get(si) || 0) + data[idx + 1]);
    sumB.set(si, (sumB.get(si) || 0) + data[idx + 2]);
    cnt.set(si, (cnt.get(si) || 0) + 1);
  }

  const regionColor = new Map();
  for (const si of usedLabels) {
    const c = cnt.get(si) || 1;
    regionColor.set(si, {
      r: Math.round(sumR.get(si) / c),
      g: Math.round(sumG.get(si) / c),
      b: Math.round(sumB.get(si) / c),
    });
  }

  // Build per-region bounding box index in single pass
  const regionPixels = new Map(); // si → { minX, minY, maxX, maxY }
  for (let i = 0; i < len; i++) {
    const si = labels[i];
    if (si < 0) continue;
    const x = i % width, y = (i / width) | 0;
    let rp = regionPixels.get(si);
    if (!rp) {
      rp = { minX: x, minY: y, maxX: x, maxY: y };
      regionPixels.set(si, rp);
    }
    if (x < rp.minX) rp.minX = x;
    if (x > rp.maxX) rp.maxX = x;
    if (y < rp.minY) rp.minY = y;
    if (y > rp.maxY) rp.maxY = y;
  }

  // Trace horizontal and vertical boundary edges between different regions
  const hEdges = [];
  for (let y = 0; y < height - 1; y++) {
    let runStart = -1, runLabelA = -1, runLabelB = -1;
    for (let x = 0; x < width; x++) {
      const a = labels[y * width + x];
      const b = labels[(y + 1) * width + x];
      const isEdge = a >= 0 && b >= 0 && a !== b;
      if (isEdge) {
        if (runStart < 0) {
          runStart = x; runLabelA = a; runLabelB = b;
        } else if (a !== runLabelA || b !== runLabelB) {
          hEdges.push({ x1: runStart, y1: y, x2: x - 1, y2: y, a: runLabelA, b: runLabelB });
          runStart = x; runLabelA = a; runLabelB = b;
        }
      } else if (runStart >= 0) {
        hEdges.push({ x1: runStart, y1: y, x2: x - 1, y2: y, a: runLabelA, b: runLabelB });
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      hEdges.push({ x1: runStart, y1: y, x2: width - 1, y2: y, a: runLabelA, b: runLabelB });
    }
  }

  const vEdges = [];
  for (let x = 0; x < width - 1; x++) {
    let runStart = -1, runLabelA = -1, runLabelB = -1;
    for (let y = 0; y < height; y++) {
      const a = labels[y * width + x];
      const b = labels[y * width + x + 1];
      const isEdge = a >= 0 && b >= 0 && a !== b;
      if (isEdge) {
        if (runStart < 0) {
          runStart = y; runLabelA = a; runLabelB = b;
        } else if (a !== runLabelA || b !== runLabelB) {
          vEdges.push({ x1: x, y1: runStart, x2: x, y2: y - 1, a: runLabelA, b: runLabelB });
          runStart = y; runLabelA = a; runLabelB = b;
        }
      } else if (runStart >= 0) {
        vEdges.push({ x1: x, y1: runStart, x2: x, y2: y - 1, a: runLabelA, b: runLabelB });
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      vEdges.push({ x1: x, y1: runStart, x2: x, y2: height - 1, a: runLabelA, b: runLabelB });
    }
  }

  const allEdges = [...hEdges, ...vEdges];

  // Convert edges to SVG path segments
  const paths = [];

  for (const edge of allEdges) {
    const pts = [];
    if (edge.x1 === edge.x2) {
      for (let y = edge.y1; y <= edge.y2; y++) {
        pts.push([edge.x1, y]);
      }
    } else {
      for (let x = edge.x1; x <= edge.x2; x++) {
        pts.push([x, edge.y1]);
      }
    }

    if (pts.length < 2) continue;

    const simplified = douglasPeucker(pts, 1.5);

    let d = `M${simplified[0][0]},${simplified[0][1]}`;
    for (let i = 1; i < simplified.length; i++) {
      d += `L${simplified[i][0]},${simplified[i][1]}`;
    }

    const ca = regionColor.get(edge.a) || { r: 128, g: 128, b: 128 };
    const cb = regionColor.get(edge.b) || { r: 128, g: 128, b: 128 };
    const strokeR = Math.round((ca.r + cb.r) / 2);
    const strokeG = Math.round((ca.g + cb.g) / 2);
    const strokeB = Math.round((ca.b + cb.b) / 2);

    paths.push({
      d,
      fill: `rgb(${ca.r},${ca.g},${ca.b})`,
      stroke: `rgb(${strokeR},${strokeG},${strokeB})`,
      regionA: edge.a,
    });
  }

  // Generate filled region polygons using pre-computed bounding boxes
  const regionPaths = [];
  for (const si of usedLabels) {
    const rp = regionPixels.get(si);
    if (!rp) continue;
    const { minX, minY, maxX, maxY } = rp;

    const outline = traceRegionOutline(labels, si, minX, minY, maxX, maxY, width, height);
    if (outline.length < 3) continue;

    const simplified = douglasPeucker(outline, 2);
    let d = `M${simplified[0][0]},${simplified[0][1]}`;
    for (let i = 1; i < simplified.length; i++) {
      d += `L${simplified[i][0]},${simplified[i][1]}`;
    }
    d += 'Z';

    const color = regionColor.get(si);
    if (!color) continue;
    regionPaths.push({
      d,
      fill: `rgb(${color.r},${color.g},${color.b})`,
      stroke: 'none',
      regionA: si,
    });
  }

  return { regionPaths, edgePaths: paths };
}

// ============================================================
// Moore neighborhood contour tracing
// ============================================================

function traceRegionOutline(labels, si, minX, minY, maxX, maxY, width, height) {
  // Find top-left boundary pixel
  let startX = -1, startY = -1;
  for (let y = minY; y <= maxY && startY < 0; y++) {
    for (let x = minX; x <= maxX && startY < 0; x++) {
      if (labels[y * width + x] !== si) continue;
      // Check if boundary (has a non-region neighbour)
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || labels[ny * width + nx] !== si) {
          startX = x; startY = y; break;
        }
      }
    }
  }
  if (startX < 0) return [];

  // Moore neighborhood tracing (8 directions, clockwise from right)
  // Direction order: right, down-right, down, down-left, left, up-left, up, up-right
  const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const outline = [];
  let x = startX, y = startY;
  let dir = 6; // start looking upward
  const maxSteps = (maxX - minX + 1) * (maxY - minY + 1) * 2; // safety limit
  let steps = 0;

  do {
    outline.push([x, y]);
    // Search for next boundary pixel starting from (dir + 5) % 8 (back-track rule)
    let found = false;
    const startDir = (dir + 5) % 8; // backtrack 2 positions
    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8;
      const nx = x + dirs[d][0], ny = y + dirs[d][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (labels[ny * width + nx] === si) {
        // Check it's a boundary pixel
        let isBoundary = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const bx = nx + dx, by = ny + dy;
          if (bx < 0 || bx >= width || by < 0 || by >= height || labels[by * width + bx] !== si) {
            isBoundary = true; break;
          }
        }
        if (isBoundary) {
          dir = d;
          x = nx; y = ny;
          found = true;
          break;
        }
      }
    }
    if (!found) break;
    steps++;
  } while ((x !== startX || y !== startY) && steps < maxSteps);

  // Subsample if too many points
  const maxPoints = 200;
  if (outline.length > maxPoints) {
    const step = outline.length / maxPoints;
    const result = [];
    for (let i = 0; i < maxPoints; i++) {
      result.push(outline[Math.round(i * step)]);
    }
    return result;
  }
  return outline;
}

// ============================================================
// Douglas-Peucker path simplification (iterative, stack-based)
// ============================================================

function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = 0, maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const d = pointLineDistance(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      if (maxIdx - start > 1) stack.push([start, maxIdx]);
      if (end - maxIdx > 1) stack.push([maxIdx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function pointLineDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  const projX = a[0] + clamped * dx;
  const projY = a[1] + clamped * dy;
  return Math.hypot(p[0] - projX, p[1] - projY);
}

// ============================================================
// Step 5: Build SVG (array join)
// ============================================================

function buildSVG(paths, w, h, scale) {
  const sw = w * scale, sh = h * scale;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${sw}" height="${sh}">`);

  // Layer 1: filled regions (background)
  parts.push('  <g id="fills">');
  for (const p of paths.regionPaths) {
    parts.push(`    <path d="${p.d}" fill="${p.fill}" stroke="none"/>`);
  }
  parts.push('  </g>');

  // Layer 2: edge contours (detail lines)
  parts.push('  <g id="edges" stroke-linecap="round" stroke-linejoin="round">');
  for (const p of paths.edgePaths) {
    parts.push(`    <path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="0.8"/>`);
  }
  parts.push('  </g>');

  parts.push('</svg>');
  return parts.join('\n');
}
