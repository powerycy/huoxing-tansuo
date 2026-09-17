import * as THREE from 'three';
import {dustEmitters,dustPose} from './collapse-dust-timing.js';

// CC0 simulated smoke flipbook; transparent, depth-tested and non-additive.
// This is layered 2.5D smoke, not a real-time fluid or volumetric shadow solver.
export class CollapseDust{
  constructor(scene,renderer,camera){
    this.scene=scene;this.renderer=renderer;this.camera=camera;this.root=new THREE.Group();scene.add(this.root);
    this.depth=new THREE.WebGLRenderTarget(1,1,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    this.depth.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
    this.depthMaterial=new THREE.MeshDepthMaterial();this.entries=[];this.visibleCount=0;this.ready=false;
    this.resolution=new THREE.Vector2();this.geometry=new THREE.PlaneGeometry(1,1);
  }
  async load(contacts){
    const texture=await new THREE.TextureLoader().loadAsync('../assets/textures/collapse-dust/impact-flipbook.png');
    texture.colorSpace=THREE.NoColorSpace;texture.generateMipmaps=false;
    texture.minFilter=texture.magFilter=THREE.LinearFilter;
    const vertexShader=`varying vec2 vUv;varying float vDepth,vWorldY;
      void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);vWorldY=world.y;
        vec4 v=viewMatrix*world;vDepth=-v.z;gl_Position=projectionMatrix*v;}`;
    const fragmentShader=`uniform sampler2D atlas,sceneDepth;uniform vec2 resolution;
      uniform float frame,opacity,mirror,nearPlane,farPlane;
      varying vec2 vUv;varying float vDepth,vWorldY;
      vec4 tile(float f){vec2 uv=vec2(mix(vUv.x,1.-vUv.x,mirror),vUv.y);
        // 25 frames, left-to-right, TOP-to-bottom; inset avoids neighboring cells.
        uv=clamp(uv,vec2(.004),vec2(.996));
        return texture2D(atlas,(uv+vec2(mod(f,5.),4.-floor(f/5.)))/5.);}
      void main(){
        float f=floor(frame);vec4 a=tile(f),b=tile(min(24.,f+1.));float blend=fract(frame);
        // Alpha-weighted frame blending avoids dark halos at a changing outline.
        float alpha=mix(a.a,b.a,blend);vec3 premul=mix(a.rgb*a.a,b.rgb*b.a,blend);
        vec3 rgb=premul/max(.0001,alpha);
        float depth=texture2D(sceneDepth,gl_FragCoord.xy/resolution).x;
        float surface=nearPlane*farPlane/(farPlane-(farPlane-nearPlane)*depth);
        float soft=smoothstep(0.,.85,surface-vDepth);
        alpha*=opacity*soft*smoothstep(.36,.60,vWorldY)*smoothstep(.6,2.,vDepth);
        alpha=min(.98,alpha);
        if(alpha<.003)discard;
        float shade=clamp(dot(rgb,vec3(.2126,.7152,.0722)),0.,1.);
        // Neutral rock dust: preserve simulated self-shadow detail without fire,
        // emission, brightness pulsing, or flat black silhouette smoke.
        vec3 dust=mix(vec3(.095,.078,.061),vec3(.51,.435,.34),pow(shade,.63));
        gl_FragColor=vec4(dust,alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`;
    for(const emitter of dustEmitters(contacts)){
      const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.NormalBlending,
        uniforms:{atlas:{value:texture},sceneDepth:{value:this.depth.depthTexture},resolution:{value:this.resolution},
          frame:{value:0},opacity:{value:0},mirror:{value:0},nearPlane:{value:this.camera.near},farPlane:{value:this.camera.far}},vertexShader,fragmentShader});
      const mesh=new THREE.Mesh(this.geometry,material);mesh.visible=false;this.root.add(mesh);this.entries.push({mesh,emitter});
    }
    this.ready=true;
  }
  update(time,enabled,strength=1){
    this.root.visible=enabled&&this.ready;this.visibleCount=0;
    for(const {mesh,emitter} of this.entries){
      const p=dustPose(emitter,time);mesh.visible=!!p;if(!p)continue;
      mesh.position.set(p.x,p.y,p.z);mesh.scale.set(p.width,p.height,1);mesh.quaternion.copy(this.camera.quaternion);
      const u=mesh.material.uniforms;u.frame.value=p.frame;u.opacity.value=p.opacity*strength;u.mirror.value=p.mirror;
      if(this.root.visible)this.visibleCount++;
    }
  }
  captureDepth(){
    if(!this.root.visible||this.visibleCount===0)return;
    const r=this.renderer;r.getDrawingBufferSize(this.resolution);
    if(this.depth.width!==this.resolution.x||this.depth.height!==this.resolution.y)this.depth.setSize(this.resolution.x,this.resolution.y);
    const target=r.getRenderTarget(),override=this.scene.overrideMaterial,shadows=r.shadowMap.enabled;
    this.root.visible=false;this.scene.overrideMaterial=this.depthMaterial;r.shadowMap.enabled=false;
    try{r.setRenderTarget(this.depth);r.clear();r.render(this.scene,this.camera);}
    finally{r.setRenderTarget(target);r.shadowMap.enabled=shadows;this.scene.overrideMaterial=override;this.root.visible=true;}
  }
}
