// Small linear-algebra and projective-geometry helpers: homographies, linear solves, perspective warps.
// A homography H is a length-9 array (row-major 3x3) mapping (x, y, 1) -> (x', y', w').
(function (root) {
  const AD = root.AD = root.AD || {};
  const geom = AD.geom = {};

  // Solve A x = b (A is n*n as array of rows) by Gaussian elimination with partial pivoting.
  // Returns null if singular.
  geom.solve = (A, b) => {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  };

  // Least squares: minimise |A x - b| via the normal equations (fine for the small, well-scaled systems here).
  geom.leastSquares = (A, b) => {
    const n = A[0].length, AtA = Array.from({ length: n }, () => new Array(n).fill(0)), Atb = new Array(n).fill(0);
    for (let r = 0; r < A.length; r++) for (let i = 0; i < n; i++) {
      Atb[i] += A[r][i] * b[r];
      for (let j = 0; j < n; j++) AtA[i][j] += A[r][i] * A[r][j];
    }
    return geom.solve(AtA, Atb);
  };

  // Homography mapping src[i] -> dst[i] (arrays of {x, y}); 4 points exact, more points least squares.
  geom.homography = (src, dst) => {
    const A = [], b = [];
    for (let i = 0; i < src.length; i++) {
      const { x, y } = src[i], { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = src.length === 4 ? geom.solve(A, b) : geom.leastSquares(A, b);
    return h ? [...h, 1] : null;
  };

  // Affine (6 dof) or similarity fits are often more stable for tracking; least squares for n >= 3.
  geom.affine = (src, dst) => {
    const A = [], b = [];
    for (let i = 0; i < src.length; i++) {
      const { x, y } = src[i];
      A.push([x, y, 1, 0, 0, 0]); b.push(dst[i].x);
      A.push([0, 0, 0, x, y, 1]); b.push(dst[i].y);
    }
    const a = geom.leastSquares(A, b);
    return a ? [a[0], a[1], a[2], a[3], a[4], a[5], 0, 0, 1] : null;
  };

  geom.apply = (H, x, y) => {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  };

  geom.multiply = (A, B) => {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
  };

  geom.invert = H => {
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
    return inv.map(v => v / det);
  };

  geom.identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  geom.translation = (tx, ty) => [1, 0, tx, 0, 1, ty, 0, 0, 1];
  geom.dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

  // Warp `d` so that output pixel (x, y) samples the input at H_outToIn (x, y).
  geom.warpPerspective = (d, H_outToIn, outW, outH, interp = 'bilinear', fill) =>
    AD.img.warp(d, outW, outH, (x, y, t) => {
      const w = H_outToIn[6] * x + H_outToIn[7] * y + H_outToIn[8];
      if (w <= 1e-12) return false;
      t[0] = (H_outToIn[0] * x + H_outToIn[1] * y + H_outToIn[2]) / w;
      t[1] = (H_outToIn[3] * x + H_outToIn[4] * y + H_outToIn[5]) / w;
      return true;
    }, interp, fill);

  // Intersection of line p1-p2 with line p3-p4 (homogeneous; returns null for parallel lines).
  geom.intersect = (p1, p2, p3, p4) => {
    const l1 = [p1.y - p2.y, p2.x - p1.x, p1.x * p2.y - p2.x * p1.y];
    const l2 = [p3.y - p4.y, p4.x - p3.x, p3.x * p4.y - p4.x * p3.y];
    const x = l1[1] * l2[2] - l1[2] * l2[1], y = l1[2] * l2[0] - l1[0] * l2[2], w = l1[0] * l2[1] - l1[1] * l2[0];
    return Math.abs(w) < 1e-12 ? null : { x: x / w, y: y / w };
  };
})(typeof window !== 'undefined' ? window : globalThis);
