/**
 * Image to SVG — custom contour-tracing pipeline.
 *
 * imagetracerjs quantizes colors first → similar colors merge → detail lost.
 * Instead we:
 *   1. Preprocess: bilateral smooth + local contrast boost
 *   2. Segment: superpixel-like region growing on the gradient landscape
 *   3. Contour: trace boundaries between adjacent regions
 *   4. Simplify: Douglas-Peucker path reduction
 *   5. Fill: sample average color per region
 *   6. Assemble SVG from contour paths
 */

export async function traceToSVG(blob, options = {}) {
  const { simplify = 5, scale = 1 } = options;

  const img = await loadImageFromBlob(blob);
  const canvas = document.createElement('canvas');

  const maxDim = 800; // smaller = faster segmentation, still enough detail
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
  let imageData = ctx.getImageData(0, 0, w, h);

  // Step 1: pixel-level cleanup
  cleanupAlpha(imageData);

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
// Step 2: Preprocessing — bilateral filter + CLAHE
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

  // Bilateral filter: smooth while preserving edges
  const radius = Math.max(1, Math.round(2 + (10 - simplify) * 0.3));
  const sigmaS = radius * 1.5;
  const sigmaR = 20 + (10 - simplify) * 5; // color range sigma

  const outR = new Float32Array(len);
  const outG = new Float32Array(len);
  const outB = new Float32Array(len);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fg[i]) continue;

      let wSum = 0, sr = 0, sg = 0, sb = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const j = ny * width + nx;
          if (!fg[j]) continue;

          const spatialDist = (dx * dx + dy * dy) / (2 * sigmaS * sigmaS);
          const dr = r[i] - r[j], dg = g[i] - g[j], db = b[i] - b[j];
          const colorDist = (dr * dr + dg * dg + db * db) / (2 * sigmaR * sigmaR);
          const w = Math.exp(-spatialDist - colorDist);

          wSum += w;
          sr += w * r[j]; sg += w * g[j]; sb += w * b[j];
        }
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
 */
function enforceConnectivity(labels, data, width, height, numSeeds) {
  const len = width * height;
  const minSize = Math.max(20, len / numSeeds * 0.3);

  // Count region sizes
  const sizes = new Int32Array(numSeeds);
  for (let i = 0; i < len; i++) {
    if (labels[i] >= 0) sizes[labels[i]]++;
  }

  // For each undersized region, flood-fill and merge into neighbour
  for (let si = 0; si < numSeeds; si++) {
    if (sizes[si] >= minSize) continue;

    // Find all pixels in this region and their most common neighbour
    const neighbourCount = new Map();
    for (let i = 0; i < len; i++) {
      if (labels[i] !== si) continue;
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
      for (let i = 0; i < len; i++) {
        if (labels[i] === si) labels[i] = bestNeighbour;
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

  // Trace horizontal and vertical boundary edges between different regions
  // Each edge: { x1, y1, x2, y2, labelA, labelB }
  const hEdges = []; // horizontal edges (between row y and y+1)
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

  const vEdges = []; // vertical edges (between col x and x+1)
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
  // Each segment is a line from (x1,y1) to (x2,y2)
  // Group by the pair of regions (a,b) they separate
  const paths = [];

  // Convert each edge run to a polyline
  for (const edge of allEdges) {
    const pts = [];
    if (edge.x1 === edge.x2) {
      // Vertical edge
      for (let y = edge.y1; y <= edge.y2; y++) {
        pts.push([edge.x1, y]);
      }
    } else {
      // Horizontal edge
      for (let x = edge.x1; x <= edge.x2; x++) {
        pts.push([x, edge.y1]);
      }
    }

    if (pts.length < 2) continue;

    // Simplify with Douglas-Peucker
    const simplified = douglasPeucker(pts, 1.5);

    // Build SVG path d attribute
    let d = `M${simplified[0][0]},${simplified[0][1]}`;
    for (let i = 1; i < simplified.length; i++) {
      d += `L${simplified[i][0]},${simplified[i][1]}`;
    }

    // Colour: average of the two adjacent regions
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

  // Also generate filled region polygons for each region
  const regionPaths = [];
  for (const si of usedLabels) {
    // Get bounding box of region
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (labels[y * width + x] === si) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Build outline by tracing region boundary
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

/**
 * Trace the outline of a region by following its boundary pixels.
 */
function traceRegionOutline(labels, si, minX, minY, maxX, maxY, width, height) {
  // Find boundary pixels: region pixel with at least one non-region neighbour
  const boundary = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (labels[y * width + x] !== si) continue;
      let isBoundary = false;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          isBoundary = true; break;
        }
        if (labels[ny * width + nx] !== si) {
          isBoundary = true; break;
        }
      }
      if (isBoundary) boundary.push([x, y]);
    }
  }

  if (boundary.length === 0) return [];

  // Sort boundary points by angle from centroid for a rough polygon
  let cx = 0, cy = 0;
  for (const [x, y] of boundary) { cx += x; cy += y; }
  cx /= boundary.length;
  cy /= boundary.length;

  boundary.sort((a, b) => {
    const aa = Math.atan2(a[1] - cy, a[0] - cx);
    const ab = Math.atan2(b[1] - cy, b[0] - cx);
    return aa - ab;
  });

  // Subsample to reduce point count
  const maxPoints = 200;
  if (boundary.length > maxPoints) {
    const step = boundary.length / maxPoints;
    const result = [];
    for (let i = 0; i < maxPoints; i++) {
      result.push(boundary[Math.round(i * step)]);
    }
    return result;
  }

  return boundary;
}

// ============================================================
// Douglas-Peucker path simplification
// ============================================================

function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = pointLineDistance(points[i], points[0], points[end]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[end]];
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
// Step 5: Build SVG
// ============================================================

function buildSVG(paths, w, h, scale) {
  const sw = w * scale, sh = h * scale;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${sw}" height="${sh}">\n`;

  // Layer 1: filled regions (background)
  svg += '  <g id="fills">\n';
  for (const p of paths.regionPaths) {
    svg += `    <path d="${p.d}" fill="${p.fill}" stroke="none"/>\n`;
  }
  svg += '  </g>\n';

  // Layer 2: edge contours (detail lines)
  svg += '  <g id="edges" stroke-linecap="round" stroke-linejoin="round">\n';
  for (const p of paths.edgePaths) {
    svg += `    <path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="0.8"/>\n`;
  }
  svg += '  </g>\n';

  svg += '</svg>';
  return svg;
}

// ============================================================
// Post-trace: remove background artifact paths
// ============================================================

function filterSubjectPaths(svgStr, imgW, imgH) {
  // (kept for compatibility, but not used in new pipeline)
  return svgStr;
}

// ============================================================
// Helpers
// ============================================================

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}
