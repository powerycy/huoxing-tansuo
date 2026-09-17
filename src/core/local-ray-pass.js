import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { collectRayTriangles, packRayBVH, rayTexture } from './local-ray-bvh.js';

const vertexShader = `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
export const CONTACT_RAY_GLSL = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDepth, tBase, tRover;
  uniform vec2 uBaseSize, uRoverSize, uPixel;
  uniform float uBaseEnd, uRoverEnd, uActive;
  uniform mat4 uInvProjection, uCameraWorld, uBaseInverse, uRoverInverse;
  uniform vec3 uCamera;
  vec4 fetchNode(sampler2D map, vec2 size, float at) {
    return texture2D(map,(vec2(mod(at,size.x),floor(at/size.x))+.5)/size);
  }
  bool boxHit(vec3 o, vec3 d, vec3 lo, vec3 hi, float reach) {
    float nearT=0.,farT=reach;
    for(int k=0;k<3;k++) {
      if(abs(d[k])<1e-8) { if(o[k]<lo[k] || o[k]>hi[k]) return false; }
      else {
        float a=(lo[k]-o[k])/d[k],b=(hi[k]-o[k])/d[k];
        nearT=max(nearT,min(a,b));farT=min(farT,max(a,b));
      }
    }
    return nearT<=farT;
  }
  bool triangleHit(vec3 o,vec3 d,vec3 a,vec3 b,vec3 c,float reach) {
    vec3 e1=b-a,e2=c-a,p=cross(d,e2); float det=dot(e1,p);
    if(abs(det)<1e-8) return false;
    vec3 s=o-a; float u=dot(s,p)/det;
    if(u<0. || u>1.) return false;
    vec3 q=cross(s,e1); float v=dot(d,q)/det;
    if(v<0. || u+v>1.) return false;
    float t=dot(e2,q)/det;
    return t>.025 && t<reach;
  }
  bool traceModel(sampler2D map,vec2 size,float end,mat4 inv,vec3 worldO,vec3 worldD,float reach) {
    if(end<1.) return false;
    vec3 o=(inv*vec4(worldO,1.)).xyz;
    // Do not normalize: this retains world-metre t under nonuniform scales.
    vec3 d=(inv*vec4(worldD,0.)).xyz;
    float at=0.;
    for(int visit=0;visit<256;visit++) {
      if(at>=end) break;
      vec4 lo=fetchNode(map,size,at),hi=fetchNode(map,size,at+1.);
      if(!boxHit(o,d,lo.xyz,hi.xyz,reach)) {at=lo.w;continue;}
      for(int j=0;j<4;j++) {
        if(float(j)>=hi.w) break;
        float t=at+2.+float(j)*3.;
        if(triangleHit(o,d,fetchNode(map,size,t).xyz,fetchNode(map,size,t+1.).xyz,fetchNode(map,size,t+2.).xyz,reach)) return true;
      }
      at=hi.w>0.?lo.w:at+2.;
    }
    return false;
  }
  vec3 worldPoint(vec2 uv,float depth) {
    vec4 p=uInvProjection*vec4(uv*2.-1.,depth*2.-1.,1.);
    return (uCameraWorld*vec4(p.xyz/p.w,1.)).xyz;
  }
  bool nearby(sampler2D map,vec2 size,float end,mat4 inv,vec3 p) {
    if(end<1.) return false;
    vec3 q=(inv*vec4(p,1.)).xyz;
    vec3 lo=fetchNode(map,size,0.).xyz,hi=fetchNode(map,size,1.).xyz;
    vec3 expansion=vec3(length(inv[0].xyz),length(inv[1].xyz),length(inv[2].xyz))*5.;
    // Conservative scalar expansion also covers rotated/nonuniform roots.
    float e=max(expansion.x,max(expansion.y,expansion.z));
    return all(greaterThan(q,lo-e)) && all(lessThan(q,hi+e));
  }
  void main() {
    float z=texture2D(tDepth,vUv).x;
    float amount=0.;
    if(uActive>.5 && z<.999999) {
      vec3 p=worldPoint(vUv,z);
      float distanceToCamera=distance(p,uCamera);
      if(distanceToCamera<65. && (nearby(tBase,uBaseSize,uBaseEnd,uBaseInverse,p) || nearby(tRover,uRoverSize,uRoverEnd,uRoverInverse,p))) {
        vec2 x=vec2(uPixel.x,0.),y=vec2(0.,uPixel.y);
        vec3 pr=worldPoint(vUv+x,texture2D(tDepth,vUv+x).x)-p;
        vec3 pl=p-worldPoint(vUv-x,texture2D(tDepth,vUv-x).x);
        vec3 pt=worldPoint(vUv+y,texture2D(tDepth,vUv+y).x)-p;
        vec3 pb=p-worldPoint(vUv-y,texture2D(tDepth,vUv-y).x);
        vec3 dx=dot(pr,pr)<dot(pl,pl)?pr:pl,dy=dot(pt,pt)<dot(pb,pb)?pt:pb;
        vec3 n=cross(dx,dy);
        if(dot(n,n)>1e-12) {
          n=normalize(n); if(dot(n,uCamera-p)<0.) n=-n;
          vec3 tangent=normalize(cross(abs(n.y)<.95?vec3(0.,1.,0.):vec3(1.,0.,0.),n));
          vec3 bitangent=cross(n,tangent);
          // Four fixed cosine-weighted hemisphere strata: no animated noise,
          // accumulation, exposure adaptation or random frame-to-frame flash.
          for(int i=0;i<4;i++) {
            float a=float(i)*2.39996323+.47,r=sqrt((float(i)+.5)/4.);
            vec3 d=tangent*cos(a)*r+bitangent*sin(a)*r+n*sqrt(1.-r*r);
            vec3 origin=p+n*max(.07,distanceToCamera*.0015);
            bool hit=traceModel(tBase,uBaseSize,uBaseEnd,uBaseInverse,origin,d,4.);
            if(!hit) hit=traceModel(tRover,uRoverSize,uRoverEnd,uRoverInverse,origin,d,3.);
            amount+=hit?.25:0.;
          }
          amount*=1.-smoothstep(45.,65.,distanceToCamera);
        }
      }
    }
    // Auxiliary depth is diagnostic only; composite samples full precision depth.
    gl_FragColor=vec4(amount,z,0.,1.);
  }
`;

const COMPOSITE = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tDiffuse,tAO,tDepth;
  uniform vec2 uPixel;
  uniform float uNear,uFar;
  float linearDepth(float d){return uNear*uFar/(uFar-d*(uFar-uNear));}
  void main(){
    vec4 color=texture2D(tDiffuse,vUv);
    float center=linearDepth(texture2D(tDepth,vUv).x),ao=0.,weight=0.;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
      vec2 uv=vUv+vec2(float(x),float(y))*uPixel;
      // Sample the full-resolution depth at the AO texel centre, not its
      // byte-quantized auxiliary channel (far-field depth needs >8 bits).
      vec2 sampleUV=(floor(uv/uPixel)+.5)*uPixel;
      float dz=abs(linearDepth(texture2D(tDepth,sampleUV).x)-center);
      float w=exp(-dz/max(.12,center*.005))*((x==0&&y==0)?2.:1.);
      ao+=texture2D(tAO,sampleUV).r*w;weight+=w;
    }
    ao/=max(weight,.0001);
    // This is a restrained contact-visibility composite, not relit GI. Protect
    // emissive windows/headlamps; never clamp HDR highlights to an LDR target.
    float highlight=1.-smoothstep(.45,1.4,max(color.r,max(color.g,color.b)));
    gl_FragColor=vec4(color.rgb*(1.-ao*.32*highlight),color.a);
  }
`;

export function contactRaySize(width, height, ultra) {
  const scale = Math.min(.5, Math.sqrt((ultra ? 240000 : 140000) / Math.max(1, width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

export class LocalRayPass extends Pass {
  constructor(engine, sources) {
    super(); this.engine = engine; this.sources = sources; this.needsSwap = true;
    this.active = false; this.models = []; this.disposed = false;
    this.empty = rayTexture(packRayBVH([]));
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    this.trace = new THREE.ShaderMaterial({ name: 'ExperimentalWorldTriangleContactRays', vertexShader,
      fragmentShader: CONTACT_RAY_GLSL, depthTest: false, depthWrite: false,
      uniforms: {
        tDepth:{value:null},tBase:{value:this.empty},tRover:{value:this.empty},
        uBaseSize:{value:new THREE.Vector2(1024,1)},uRoverSize:{value:new THREE.Vector2(1024,1)},
        uBaseEnd:{value:0},uRoverEnd:{value:0},uActive:{value:0},uPixel:{value:new THREE.Vector2()},
        uBaseInverse:{value:new THREE.Matrix4()},uRoverInverse:{value:new THREE.Matrix4()},
        uInvProjection:{value:new THREE.Matrix4()},uCameraWorld:{value:new THREE.Matrix4()},uCamera:{value:new THREE.Vector3()}
      } });
    this.composite = new THREE.ShaderMaterial({ name: 'ContactRayEdgeAwareComposite',vertexShader,
      fragmentShader:COMPOSITE,depthTest:false,depthWrite:false,
      uniforms:{tDiffuse:{value:null},tAO:{value:this.aoTarget.texture},tDepth:{value:null},
        uPixel:{value:new THREE.Vector2()},uNear:{value:.08},uFar:{value:26000}} });
    this.quad = new FullScreenQuad(this.trace);
  }
  prepare() {
    for (const [slot, source] of this.sources.entries()) {
      if (!source?.root) continue;
      const packed = packRayBVH(collectRayTriangles(source.root, {excludeWheels:source.excludeWheels}),this.engine.caps.maxTex);
      const texture = rayTexture(packed), prefix = slot ? 'Rover' : 'Base';
      this.models.push({root:source.root,texture,triangles:packed.triangles,prefix});
      this.trace.uniforms[`t${prefix}`].value=texture;
      this.trace.uniforms[`u${prefix}Size`].value.set(packed.width,packed.height);
      this.trace.uniforms[`u${prefix}End`].value=packed.texels;
    }
    if (!this.models.some(m=>m.triangles)) throw new Error('未找到可用于实验光追的不透明模型');
    this.active = true;
  }
  setSize(width,height) {
    const [w,h]=contactRaySize(width,height,this.engine.quality.name==='ULTRA');
    this.aoTarget.setSize(w,h);
    this.trace.uniforms.uPixel.value.set(1/width,1/height);
    this.composite.uniforms.uPixel.value.set(1/w,1/h);
  }
  render(renderer,writeBuffer,readBuffer) {
    const camera=this.engine.camera,u=this.trace.uniforms,c=this.composite.uniforms;
    camera.updateMatrixWorld();
    u.tDepth.value=readBuffer.depthTexture;
    u.uActive.value=this.active && this.engine.rayVisible!==false?1:0;
    u.uInvProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);
    u.uCamera.value.setFromMatrixPosition(camera.matrixWorld);
    for(const model of this.models) {
      model.root.updateWorldMatrix(true,false);
      u[`u${model.prefix}Inverse`].value.copy(model.root.matrixWorld).invert();
    }
    const previousErrorHandler=renderer.debug.onShaderError;
    let shaderFailed=false;
    if(!this.validated) renderer.debug.onShaderError=()=>{shaderFailed=true;};
    try {
    // Validate only the first draw, avoiding a synchronous GPU query per frame.
    const diagnosticGL=renderer.getContext();
    if(!this.validated) this.gpuErrors={before:diagnosticGL.getError()};
    this.quad.material=this.trace;renderer.setRenderTarget(this.aoTarget);
    if(!this.validated) {
      const gl=renderer.getContext();
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error('实验光追缓冲区不可用');
    }
    this.quad.render(renderer);
    if(!this.validated) this.gpuErrors.trace=diagnosticGL.getError();
    c.tDiffuse.value=readBuffer.texture;c.tDepth.value=readBuffer.depthTexture;
    c.uNear.value=camera.near;c.uFar.value=camera.far;
    this.quad.material=this.composite;renderer.setRenderTarget(this.renderToScreen?null:writeBuffer);this.quad.render(renderer);
    if(!this.validated) this.gpuErrors.composite=diagnosticGL.getError();
    if(shaderFailed) throw new Error('设备未能编译实验光追着色器');
    if(!this.validated && (this.gpuErrors.trace || this.gpuErrors.composite)) throw new Error('实验光追 GPU 输出不可用，已恢复普通渲染');
    this.validated=true;
    } finally { renderer.debug.onShaderError=previousErrorHandler; }
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    for(const model of this.models)model.texture.dispose();this.models=[];
    this.empty.dispose();this.aoTarget.dispose();this.trace.dispose();this.composite.dispose();this.quad.dispose();
  }
}
