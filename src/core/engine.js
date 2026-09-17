/* ============================================================
   RENDER ENGINE
   ------------------------------------------------------------
   WebGL2, linear HDR pipeline, MSAA-backed composer, bloom, and a
   final pass that treats the image as what it is in fiction: a
   camera bolted to a rover, with event-driven sensor interference.
   ============================================================ */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { QUALITY, isApplePlatform, renderPixelRatio, renderFeatures } from './quality.js';
import { snapShadowTarget } from './shadow-framing.js';
import { LocalRayPass } from './local-ray-pass.js';
export { QUALITY } from './quality.js';

/* `pixels` is a hard ceiling on the framebuffer, and it is the single most
   important number here. A Retina MacBook reports devicePixelRatio 2, so a
   naive `setPixelRatio(dpr)` on a 1710-point-wide window renders 3420x2136 —
   7.3 megapixels through a terrain shader that ray-marches and triplanar
   samples. That is what makes it crawl, not the geometry. Capping total pixels
   rather than the ratio keeps the same budget on every display. */

/* ACES fitted + the rover-camera conceit */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uExposure: { value: 1.0 },
    uVignette: { value: 0.46 },
    uGrain: { value: 0.0 },
    uAberr: { value: 1.0 },
    uGlitch: { value: 0.0 },
    uFlash: { value: 0.0 },
    uNightLift: { value: 1.0 },
    uLetterbox: { value: 0.0 },
    uAA: { value: 0.94 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSunUV: { value: new THREE.Vector3(0.5, 0.5, 0) }   // xy = screen pos, z = visibility
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uExposure, uVignette, uGrain, uAberr, uGlitch, uFlash, uNightLift, uLetterbox, uAA;
    uniform vec2 uRes; uniform vec3 uSunUV;

    vec3 aces(vec3 x){
      const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
      return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
    }
    // Integer hash. The usual fract(sin(dot(...))) trick correlates hard on an
    // integer lattice like gl_FragCoord and lays a visible diagonal weave over
    // the whole frame — this one is actually white.
    float hash(vec2 p){
      uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
      uint n = (q.x ^ q.y) * 1597334673u;
      n = (n ^ (n >> 15u)) * 2246822519u;
      n = (n ^ (n >> 13u)) * 3266489917u;
      return float(n ^ (n >> 16u)) * (1.0 / 4294967295.0);
    }

    /* Contrast-adaptive FXAA after bloom. MSAA resolves polygon silhouettes,
       while this catches shader detail, alpha edges and the sub-pixel lunar
       ridges that otherwise sparkle as the camera moves. It exits early on
       flat areas, so regolith texture is not blurred indiscriminately. */
    float aaLuma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 fxaa(vec2 uv){
      vec2 px = 1.0 / uRes;
      vec3 rgbM = texture2D(tDiffuse, uv).rgb;
      if (uAA < 0.001) return rgbM;
      vec3 rgbNW = texture2D(tDiffuse, uv + vec2(-1.0,-1.0)*px).rgb;
      vec3 rgbNE = texture2D(tDiffuse, uv + vec2( 1.0,-1.0)*px).rgb;
      vec3 rgbSW = texture2D(tDiffuse, uv + vec2(-1.0, 1.0)*px).rgb;
      vec3 rgbSE = texture2D(tDiffuse, uv + vec2( 1.0, 1.0)*px).rgb;
      float lumaM = aaLuma(rgbM), lumaNW = aaLuma(rgbNW), lumaNE = aaLuma(rgbNE);
      float lumaSW = aaLuma(rgbSW), lumaSE = aaLuma(rgbSE);
      float lumaMin = min(lumaM, min(min(lumaNW,lumaNE), min(lumaSW,lumaSE)));
      float lumaMax = max(lumaM, max(max(lumaNW,lumaNE), max(lumaSW,lumaSE)));
      float range = lumaMax - lumaMin;
      if (range < max(0.026, lumaMax * 0.105)) return rgbM;
      vec2 dir = vec2(-((lumaNW+lumaNE)-(lumaSW+lumaSE)),
                       (lumaNW+lumaSW)-(lumaNE+lumaSE));
      float reduce = max((lumaNW+lumaNE+lumaSW+lumaSE)*0.03125, 0.0078125);
      float invMin = 1.0 / (min(abs(dir.x),abs(dir.y)) + reduce);
      dir = clamp(dir * invMin, vec2(-8.0), vec2(8.0)) * px;
      vec3 rgbA = 0.5 * (
        texture2D(tDiffuse, uv + dir*(1.0/3.0-0.5)).rgb +
        texture2D(tDiffuse, uv + dir*(2.0/3.0-0.5)).rgb);
      vec3 rgbB = rgbA*0.5 + 0.25*(
        texture2D(tDiffuse, uv + dir*-0.5).rgb +
        texture2D(tDiffuse, uv + dir* 0.5).rgb);
      float lumaB = aaLuma(rgbB);
      vec3 resolved = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
      return mix(rgbM, resolved, uAA);
    }

    void main(){
      vec2 uv = vUv;
      float aspect = uRes.x / uRes.y;

      /* sensor tear when the chassis takes a hit */
      if (uGlitch > 0.001){
        float band = step(0.985 - uGlitch*0.25, hash(vec2(floor(uv.y*140.0), floor(uTime*22.0))));
        uv.x += band * (hash(vec2(floor(uv.y*140.0), 7.0))-0.5) * 0.055 * uGlitch;
      }

      /* Resolve edges before the lens treatment. A screen-space derivative
         supplies the tiny chromatic shift without re-running FXAA per channel. */
      vec2 d = uv - 0.5;
      float r2 = dot(d,d);
      float k = uAberr * (0.0004 + 0.0026*r2);
      vec3 col = fxaa(uv);
      vec2 shiftPx = d * k * uRes;
      col.r += dFdx(col.r)*shiftPx.x + dFdy(col.r)*shiftPx.y;
      col.b -= dFdx(col.b)*shiftPx.x + dFdy(col.b)*shiftPx.y;

      /* anamorphic-ish veiling glare toward the sun — the one thing a vacuum
         cannot give you, but a scratched lens can */
      if (uSunUV.z > 0.001){
        vec2 sp = uSunUV.xy - uv;
        sp.x *= aspect;
        float dd = length(sp);
        float streak = exp(-abs(sp.y)*46.0) * exp(-abs(sp.x)*2.2);
        float halo = exp(-dd*7.0)*0.30 + exp(-dd*1.7)*0.06;
        col += vec3(0.84,0.91,0.94) * (streak*0.10 + halo*0.52) * uSunUV.z;
        // a couple of ghosts along the optical axis
        vec2 g1 = mix(uv, uSunUV.xy, 1.62); vec2 g2 = mix(uv, uSunUV.xy, 2.35);
        col += vec3(0.46,0.54,0.57) * exp(-length((g1-uSunUV.xy)*vec2(aspect,1.0))*16.0) * 0.055 * uSunUV.z;
        col += vec3(0.50,0.47,0.43) * exp(-length((g2-uSunUV.xy)*vec2(aspect,1.0))*22.0) * 0.035 * uSunUV.z;
      }

      col *= uExposure;
      col += uFlash;

      /* tone map in linear, then encode */
      col = aces(col);

      // Cold charcoal grade: preserve cyan scan/orange suit accents, but pull
      // neutral terrain toward silver-black and give the frame a firmer toe.
      float gradeLum = dot(col, vec3(0.299,0.587,0.114));
      col = mix(col, vec3(gradeLum*0.94, gradeLum*0.975, gradeLum), 0.18);
      col = max(vec3(0.0), (col-0.11)*1.04+0.11);
      // Lift only the lowest decade of the signal before the false moon
      // appears. Unlike exposure this reveals silhouettes without blowing out
      // lamps, screens and the white lunar disc.
      // Do not lift absolute black: the airless sky must remain black. Only
      // values carrying real surface signal enter the camera's shadow toe.
      float nightToe = smoothstep(0.0015, 0.010, gradeLum)
                     * (1.0 - smoothstep(0.035, 0.20, gradeLum));
      col += vec3(0.0045,0.0062,0.0088) * uNightLift * nightToe;

      /* vignette + a faint barrel darkening at the corners */
      float vig = 1.0 - uVignette * smoothstep(0.28, 0.92, r2*1.65);
      col *= vig;

      /* sensor noise: rises where the signal is low, exactly like a real CMOS */
      float lum = dot(col, vec3(0.299,0.587,0.114));
      float n = hash(gl_FragCoord.xy + vec2(floor(uTime*61.0), floor(uTime*37.0))) - 0.5;
      col += n * uGrain * (0.012 + 0.034*(1.0 - smoothstep(0.0, 0.26, lum)));

      /* photo-mode letterbox */
      float lb = step(uv.y, uLetterbox*0.5) + step(1.0-uLetterbox*0.5, uv.y);
      col *= 1.0 - lb;

      col = pow(max(col, 0.0), vec3(1.0/2.2));
      gl_FragColor = vec4(col, 1.0);
    }`
};

export class Engine {
  constructor(canvas, qualityKey = 'high') {
    this.canvas = canvas;
    this.quality = QUALITY[qualityKey] || QUALITY.high;
    // WebKit/Chromium on macOS can intermittently resolve a multisampled
    // half-float post target as black under a heavy transparent workload. It
    // often emits no context-loss or framebuffer error. Use a conservative
    // presentation path on Apple GPUs; discrete PC GPUs keep HDR + bloom.
    this.stableFramebuffer = isApplePlatform(
      navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false,
      powerPreference: 'high-performance', depth: true,
      preserveDrawingBuffer: this.stableFramebuffer
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;      // the final pass owns tone mapping
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = true;

    this.renderScale = 1;      // fixed during play; quality remains user-selectable
    // Runtime render-target reallocations can expose a cleared WebGL buffer as
    // a black frame on some macOS/browser combinations. Prefer a stable image;
    // players can still choose a lower quality tier in Settings.
    this.adaptive = false;
    this.caps = {
      floatLinear: this.renderer.extensions.has('OES_texture_float_linear'),
      maxTex: this.renderer.capabilities.maxTextureSize,
      aniso: this.renderer.capabilities.getMaxAnisotropy(),
      maxSamples: this.renderer.capabilities.maxSamples || 0
    };
    this.caps.hdr = this.renderer.extensions.has('EXT_color_buffer_float');
    if (!this.caps.floatLinear) {
      console.warn('[REGOLITH] OES_texture_float_linear unavailable — terrain sampling will be blocky.');
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x120b0d);
    // Thin suspended iron dust creates real aerial perspective on Mars.
    this.scene.fog = new THREE.Fog(0x4b2b2a, 310, 2350);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.08, 26000);
    this.camera.position.set(0, 3, -8);

    /* ---- event key: parallel silver light from the temporary false moon ----
       The legacy property name stays `sun` because terrain shadow plumbing and
       imported materials already share it, but normal play keeps it at zero. */
    this.sun = new THREE.DirectionalLight(0xdde7ea, 0);
    this.sun.name = 'MarsSunAndAnomalyKey';
    this._shadowAnchor = new THREE.Vector3();
    this.configureKeyShadow();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // Dust-scattered twilight is warm at the horizon and cooler overhead.
    this.fill = new THREE.HemisphereLight(0x746d82, 0x51251b, 0.46);
    this.scene.add(this.fill);
    // Neutral ground bounce for the rover. The terrain owns its
    // fill in the custom shader; this low-energy light only stops gameplay
    // silhouettes from collapsing to pure black when the giant primary is
    // directly behind them.
    this.silverFill = new THREE.DirectionalLight(0x9aa8ad, 0.16);
    this.silverFill.castShadow = false;
    this.scene.add(this.silverFill, this.silverFill.target);

    this.buildComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildComposer() {
    const q = this.quality;
    const previousUniforms = this.final?.uniforms;
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x), h = Math.max(2, size.y);
    this.features = renderFeatures(q, {
      stableFramebuffer: this.stableFramebuffer, hdrSupported: this.caps.hdr,
      maxSamples: this.caps.maxSamples
    });
    // The experimental pass samples the scene's real depth, including the
    // displaced terrain. Avoid multisample depth resolves on this opt-in path.
    if (this.rayPass) this.features.samples = 0;
    const samples = this.features.samples;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: this.features.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace
    });
    if (this.rayPass) rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    // EffectComposer.dispose() frees its own two targets and nothing else.
    // UnrealBloomPass carries a mip chain of eleven more, so rebuilding the
    // composer without walking the passes leaks eleven render targets every
    // time the quality tier changes — which used to be rare enough not to show.
    if (this.composer) {
      for (const p of this.composer.passes) if (p !== this.rayPass) p.dispose?.();
      this.composer.dispose();
    }
    this.composer = new EffectComposer(this.renderer, rt);
    // r160 Texture.clone() shares Source. Depth attachments on ping-pong
    // targets must have independent sources or sampling creates GL feedback.
    if (this.rayPass) this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this._composerPixelRatio = this.renderer.getPixelRatio();
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (this.rayPass) this.composer.addPass(this.rayPass);
    // Threshold sits above a sunlit white radiator on purpose: at 0.72 the
    // rover's own thermal panels bloomed and veiled the entire frame.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.36, 0.62, 1.24);
    this.bloom.enabled = this.features.bloom;
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    // Paused quality changes must not reset exposure, event framing or the
    // moon glare. Resolution/AA and the disposed input texture belong to the
    // new pipeline; all other current camera values carry across unchanged.
    if (previousUniforms) {
      for (const [name, uniform] of Object.entries(previousUniforms)) {
        if (name === 'tDiffuse' || name === 'uRes' || name === 'uAA') continue;
        const next = this.final.uniforms[name];
        if (!next) continue;
        if (next.value?.copy) next.value.copy(uniform.value);
        else next.value = uniform.value;
      }
    }
    this.final.uniforms.uAA.value = q.fxaa;
    this.final.renderToScreen = true;
    this.composer.addPass(this.final);
  }

  setQuality(key) {
    this.quality = QUALITY[key] || QUALITY.high;
    this.configureKeyShadow();
    this.resize();
    this.buildComposer();
    this.resize();
  }

  setRayTracing(enabled) {
    enabled = enabled === true;
    if (enabled === !!this.rayPass) return;
    if (enabled) {
      if (!this.renderer.capabilities?.isWebGL2) throw new Error('实验光追需要 WebGL 2');
      const pass = new LocalRayPass(this, this.raySources || []);
      try { pass.prepare(); } catch (error) { pass.dispose(); throw error; }
      this.rayPass = pass;
    } else {
      // buildComposer disposes the old pass and both depth attachments.
      this.rayPass = null;
    }
    this.buildComposer(); this.resize();
  }

  configureKeyShadow() {
    const shadow = this.sun.shadow;
    const size = Math.min(this.quality.shadow || 0, this.caps.maxTex);
    if (shadow.map && (!size || shadow.mapSize.x !== size)) {
      shadow.map.dispose(); shadow.map = null;
    }
    this.renderer.shadowMap.enabled = size > 0;
    this.sun.castShadow = size > 0;
    // Always configure the camera, including LOW -> HIGH before any map exists.
    shadow.mapSize.set(Math.max(1, size), Math.max(1, size));
    Object.assign(shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 180 });
    shadow.camera.updateProjectionMatrix();
    shadow.bias = -0.00035;
    shadow.normalBias = this.quality.name === 'ULTRA' ? 0.024 : 0.035;
    shadow.radius = 1;
    shadow.needsUpdate = true;
  }

  /** Device pixel ratio, clamped so the framebuffer never exceeds the budget. */
  _pixelRatio() {
    return renderPixelRatio(this.quality, window.innerWidth, window.innerHeight,
      window.devicePixelRatio || 1, this.renderScale);
  }

  /** Rolling frame-time governor. Trades resolution for a steady frame rate
      before the player ever notices, and gives it back when there is headroom. */
  governor(dt) {
    if (!this.adaptive) return;
    this._ft = this._ft === undefined ? dt : this._ft * 0.92 + dt * 0.08;
    this._govT = (this._govT || 0) + dt;
    if (this._govT < 1.1) return;
    this._govT = 0;
    const ms = this._ft * 1000;
    const before = this.renderScale;
    if (ms > 23 && this.renderScale > 0.62) this.renderScale = Math.max(0.62, this.renderScale - 0.08);
    else if (ms < 13.5 && this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.06);
    if (Math.abs(this.renderScale - before) > 0.005) this.resize();
  }

  resize() {
    const px = this._pixelRatio();
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(px);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bw = Math.max(2, Math.floor(w * px)), bh = Math.max(2, Math.floor(h * px));
    if (this.composer) {
      if (this._composerPixelRatio !== px) {
        this.composer.setPixelRatio(px);
        this._composerPixelRatio = px;
      }
      this.composer.setSize(w, h);
      this.final.uniforms.uRes.value.set(bw, bh);
      if (this.bloom) this.bloom.setSize(bw, bh);
    }
  }

  /** keep the shadow frustum tight around the rover so 2 k feels like 8 k */
  aimShadow(target, sunDir) {
    this.silverFill.target.position.copy(target);
    this.silverFill.position.copy(target)
      .addScaledVector(sunDir, -65);
    this.silverFill.position.y += 34;
    this.silverFill.target.updateMatrixWorld();
    this.silverFill.updateMatrixWorld();
    // The key direction must follow the sky on LOW too; castShadow controls
    // only map allocation, not where the physical light points.
    snapShadowTarget(target, sunDir, 26, this.sun.castShadow ? this.sun.shadow.mapSize.x : 0, this._shadowAnchor);
    this.sun.target.position.copy(this._shadowAnchor);
    this.sun.position.copy(this._shadowAnchor).addScaledVector(sunDir, 90);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  render(dt) {
    this.final.uniforms.uTime.value += dt;
    // Resize before drawing. Resizing the composer after it had presented the
    // frame reallocated/cleared its targets while that frame was still on
    // screen, producing a full black blink whenever the adaptive governor
    // stepped the resolution up or down (especially in the dense flower tide).
    this.governor(dt);
    try { this.composer.render(dt); }
    catch (error) {
      if (!this.rayPass) throw error;
      // The failed pass may still have its framebuffer bound. Do not let the
      // next composer restore a target that setRayTracing is about to dispose.
      this.renderer.setRenderTarget(null);
      this.setRayTracing(false);
      this.onRayTracingFailure?.(error);
      this.composer.render(dt);
    }
  }
}
