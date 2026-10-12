// WebGL2 compute-by-fragment-shader helper on an OffscreenCanvas. Works on the main thread and in workers.
// See FILTER_API.md "GPU helper". Every call returns a fresh 8-bit RGBA ImageData.
(function (root) {
  const AD = root.AD = root.AD || {};
  let gl = null, tried = false, vbo = null, maxTex = 0;
  const programs = new Map();

  const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  function init() {
    if (tried) return gl;
    tried = true;
    try {
      if (typeof OffscreenCanvas === 'undefined') return null;
      const canvas = new OffscreenCanvas(1, 1);
      gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
      if (!gl) return null;
      canvas.addEventListener && canvas.addEventListener('webglcontextlost', () => { gl = null; programs.clear(); });
      maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    } catch (e) { gl = null; }
    return gl;
  }

  function typeOf(v) {
    if (typeof v === 'number') return 'float';
    if (v && typeof v === 'object' && 'int' in v) return 'int';
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return ({ 2: 'vec2', 3: 'vec3', 4: 'vec4', 9: 'mat3', 16: 'mat4' })[v.length] || null;
    return null;
  }

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error('shader: ' + log); }
    return s;
  }

  function program(snippet, decls) {
    const key = decls + '\n' + snippet;
    let p = programs.get(key);
    if (p) return p;
    const frag = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_img;
uniform vec2 u_size;
uniform vec2 u_out;
${decls}
out vec4 o_color;
${snippet}
void main() { vec2 uv = gl_FragCoord.xy / u_out; o_color = vec4(clamp(fx(uv).rgb, 0.0, 1.0), 1.0); }`;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    p = { prog, locs: new Map() };
    programs.set(key, p);
    if (programs.size > 96) programs.delete(programs.keys().next().value);
    return p;
  }

  function texture(img, unit, filter) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    return t;
  }

  AD.gpu = {
    get available() { return !!init(); },
    get maxTextureSize() { init(); return maxTex; },

    // opts: { image, width?, height?, uniforms?, textures?: { name: ImageData }, nearest?: bool }
    run(snippet, opts) {
      if (!init()) throw new Error('WebGL2 unavailable');
      const img = opts.image, W = Math.round(opts.width || img.width), H = Math.round(opts.height || img.height);
      if (Math.max(img.width, img.height, W, H) > maxTex) throw new Error(`image exceeds GPU texture limit (${maxTex}px)`);
      const uniforms = opts.uniforms || {}, extra = opts.textures || {};
      let decls = '';
      for (const [k, v] of Object.entries(uniforms)) {
        const t = typeOf(v);
        if (!t) throw new Error(`uniform ${k}: unsupported value`);
        decls += `uniform ${t} ${k};\n`;
      }
      for (const k of Object.keys(extra)) decls += `uniform sampler2D ${k};\n`;
      const { prog } = program(snippet, decls);
      gl.useProgram(prog);

      const texs = [texture(img, 0, opts.nearest ? gl.NEAREST : gl.LINEAR)];
      gl.uniform1i(gl.getUniformLocation(prog, 'u_img'), 0);
      let unit = 1;
      for (const [k, t] of Object.entries(extra)) {
        texs.push(texture(t, unit, gl.LINEAR));
        gl.uniform1i(gl.getUniformLocation(prog, k), unit++);
      }
      gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), img.width, img.height);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_out'), W, H);
      for (const [k, v] of Object.entries(uniforms)) {
        const loc = gl.getUniformLocation(prog, k), t = typeOf(v);
        if (!loc) continue;  // optimised away
        if (t === 'float') gl.uniform1f(loc, v);
        else if (t === 'int') gl.uniform1i(loc, v.int);
        else if (t === 'vec2') gl.uniform2fv(loc, v);
        else if (t === 'vec3') gl.uniform3fv(loc, v);
        else if (t === 'vec4') gl.uniform4fv(loc, v);
        else if (t === 'mat3') gl.uniformMatrix3fv(loc, true, v);   // row-major input
        else if (t === 'mat4') gl.uniformMatrix4fv(loc, true, v);
      }

      const target = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      gl.viewport(0, 0, W, H);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const out = new ImageData(W, H);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out.data);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(target);
      for (const t of texs) gl.deleteTexture(t);
      return out;
    },

    // Common GLSL helpers filters can prepend to their snippet.
    GLSL: {
      luma: 'float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
      // Sample u_img at input pixel coordinates (x, y), pixel centres at integer + 0.5.
      px: 'vec4 px(vec2 p) { return texture(u_img, (p + 0.5) / u_size); }',
    },
  };
})(typeof self !== 'undefined' ? self : globalThis);
