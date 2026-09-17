import * as THREE from 'three';
import { makeRNG, sstep } from '../core/rng.js';
import { STARFALL, FAULT_GLSL, seismicDrop, faultBend, faultContains } from './starfall-field.js';
import { seismicArrivalTime, seismicDustPose, seismicRockPose } from './seismic-particles.js';

// Large-scale movement and a layered advancing dust curtain. All displacement
// remains behind the danger line: the driveable world and its physics agree.
export class SeismicMass {
  constructor(event){
    this.event=event;this.materials=new WeakSet();this.depths=new WeakMap();
    this.uniforms={...event.uniforms};
    this.sources=[];this.dustBudget=280;this.rockBudget=120;
    this.frustum=new THREE.Frustum();this.clipMatrix=new THREE.Matrix4();this.bounds=new THREE.Sphere();
    const rng=makeRNG(0xD05712),{origin,axis}=event.escape;
    for(let row=-312;row<=624;row+=26)for(let side=-312;side<=312;side+=24){
      const s=side+(rng()-.5)*14,d=row+faultBend(s);
      const x=origin.x+axis.z*s+axis.x*d,z=origin.z-axis.x*s+axis.z*d;
      const front=d+8,birth=seismicArrivalTime(front);
      this.sources.push({x,z,d,front,birth,seed:rng()*90,size:10+rng()*9,
        y:event.terrain.heightAt(x,z)-seismicDrop(x,z,origin,axis,front,sstep(17,22.5,birth))});
    }
    this._dust();this._rocks();
  }
  _dust(){
    const base=new THREE.PlaneGeometry(1,1),geo=new THREE.InstancedBufferGeometry();
    geo.index=base.index;geo.attributes=base.attributes;
    geo.setAttribute('aPose',new THREE.InstancedBufferAttribute(new Float32Array(420*4),4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aStyle',new THREE.InstancedBufferAttribute(new Float32Array(420*4),4).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount=0;
    const fallback=new THREE.DataTexture(new Uint8Array([160,160,160,255]),1,1);fallback.needsUpdate=true;
    const mat=new THREE.ShaderMaterial({uniforms:{...this.uniforms,uAtlas:{value:fallback},uAtlasReady:{value:0}},
      transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.NormalBlending,
      vertexShader:`attribute vec4 aPose,aStyle;varying vec2 vUv;varying vec3 vStyle;varying float vNear;
        void main(){vec4 v=viewMatrix*vec4(aPose.xyz,1.0);vNear=smoothstep(2.0,9.0,-v.z);
          v.xy+=position.xy*vec2(aPose.w,aStyle.x);gl_Position=projectionMatrix*v;
          vUv=uv;vStyle=aStyle.yzw;}`,
      fragmentShader:`uniform sampler2D uAtlas;uniform float uAtlasReady;
        varying vec2 vUv;varying vec3 vStyle;varying float vNear;
        vec4 tile(float f){vec2 uv=clamp(vec2(mix(vUv.x,1.0-vUv.x,vStyle.z),vUv.y),vec2(.004),vec2(.996));
          return texture2D(uAtlas,(uv+vec2(mod(f,5.0),4.0-floor(f/5.0)))/5.0);}
        void main(){float f=floor(vStyle.x),k=fract(vStyle.x);vec4 a=tile(f),b=tile(min(24.0,f+1.0));
          float alpha=mix(a.a,b.a,k);vec3 rgb=mix(a.rgb*a.a,b.rgb*b.a,k)/max(.0001,alpha);
          float edge=1.0-smoothstep(.52,1.0,length((vUv-.5)*2.0));
          alpha=mix(edge*.6,alpha,uAtlasReady)*vStyle.y*vNear;
          if(alpha<.003)discard;
          float shade=dot(rgb,vec3(.2126,.7152,.0722));
          vec3 dust=mix(vec3(.035,.028,.023),vec3(.19,.16,.135),pow(shade,.7));
          gl_FragColor=vec4(dust,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`});
    this.dust=new THREE.Mesh(geo,mat);this.dust.name='AdvancingDustCurtain';this.dust.frustumCulled=false;
    this.event.root.add(this.dust);
    this.dustReady=new Promise(resolve=>{
      if(typeof document==='undefined'){resolve(false);return;}
      new THREE.TextureLoader().load('assets/textures/collapse-dust/impact-flipbook.png',texture=>{
        texture.colorSpace=THREE.NoColorSpace;texture.generateMipmaps=false;
        texture.minFilter=texture.magFilter=THREE.LinearFilter;
        mat.uniforms.uAtlas.value=texture;mat.uniforms.uAtlasReady.value=1;fallback.dispose();resolve(true);
      },undefined,()=>resolve(false));
    });
  }
  _rocks(){
    const base=new THREE.DodecahedronGeometry(1,0),geo=new THREE.InstancedBufferGeometry();geo.index=base.index;geo.attributes=base.attributes;
    geo.setAttribute('aPose',new THREE.InstancedBufferAttribute(new Float32Array(180*4),4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSpin',new THREE.InstancedBufferAttribute(new Float32Array(180*2),2).setUsage(THREE.DynamicDrawUsage));geo.instanceCount=0;
    const mat=new THREE.ShaderMaterial({uniforms:{uKey:{value:this.event.terrain.uniforms?.uSunDir?.value||new THREE.Vector3(.3,.8,.4)}},
      transparent:true,depthWrite:false,
      vertexShader:`attribute vec4 aPose;attribute vec2 aSpin;varying vec3 vNormal,vLocal;varying float vFade;
        void main(){float c=cos(aSpin.x),s=sin(aSpin.x);mat3 r=mat3(c,s,0.,-s,c,0.,0.,0.,1.);
          vec3 shape=vec3(.83,.42,1.12);vec3 p=r*(position*shape)*aPose.w+aPose.xyz;
          gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);vNormal=r*normalize(normal/shape);vLocal=position;vFade=aSpin.y;}`,
      fragmentShader:`varying vec3 vNormal,vLocal;varying float vFade;uniform vec3 uKey;
        void main(){float grain=fract(sin(dot(floor(vLocal*43.),vec3(17.13,91.27,34.5)))*43578.3);
          if(vFade<.003)discard;
          float l=.24+.76*max(0.,dot(normalize(vNormal),normalize(uKey)));
          gl_FragColor=vec4(mix(vec3(.09,.075,.061),vec3(.19,.16,.13),grain)*l,vFade);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`});
    this.rocks=new THREE.Mesh(geo,mat);this.rocks.name='FractureRockfall';this.rocks.frustumCulled=false;this.event.root.add(this.rocks);
  }
  setQuality(q){const tier=q?.name;this.dustBudget=tier==='ULTRA'?420:tier==='HIGH'?280:tier==='MEDIUM'?160:90;
    this.rockBudget=tier==='ULTRA'?180:tier==='HIGH'?120:tier==='MEDIUM'?70:40;}
  install(){
    const e=this.event;
    // Original scanned rocks and facility meshes descend WITH their source
    // terrain. Chain material lighting hooks and identical depth displacement.
    const warp=shader=>{
      Object.assign(shader.uniforms,e.uniforms);
      if(shader.vertexShader.includes('vec3 seismicWorld'))return;
      shader.vertexShader=FAULT_GLSL+shader.vertexShader.replace('#include <project_vertex>',`
        vec4 earthquakePosition=vec4(transformed,1.0);
        #ifdef USE_BATCHING
          earthquakePosition=batchingMatrix*earthquakePosition;
        #endif
        #ifdef USE_INSTANCING
          earthquakePosition=instanceMatrix*earthquakePosition;
        #endif
        earthquakePosition=modelMatrix*earthquakePosition;
        vec4 mvPosition=viewMatrix*vec4(seismicWorld(earthquakePosition.xyz),1.0);
        gl_Position=projectionMatrix*mvPosition;`).replace('#include <worldpos_vertex>',`
        #include <worldpos_vertex>
        #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
          worldPosition.xyz=seismicWorld(worldPosition.xyz);
        #endif`);
    };
    for(const root of [e.props.group,e.delivery?.facility,e.delivery?.cargo])root?.traverse(object=>{
      if(!object.isMesh||object.isSkinnedMesh)return;
      for(const material of [object.material].flat()){
        if(!material?.isMeshStandardMaterial)continue;
        if(!this.materials.has(material)){
          this.materials.add(material);const previous=material.onBeforeCompile,key=material.customProgramCacheKey();
          material.onBeforeCompile=(shader,renderer)=>{previous.call(material,shader,renderer);warp(shader);};
          material.customProgramCacheKey=()=>key+'-seismic-mass-v2';material.needsUpdate=true;
        }
        if(!this.depths.has(material)){
          const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:material.map,alphaMap:material.alphaMap,alphaTest:material.alphaTest,side:material.side});
          depth.onBeforeCompile=warp;depth.customProgramCacheKey=()=> 'seismic-depth-v2';this.depths.set(material,depth);
        }
        if(!Array.isArray(object.material))object.customDepthMaterial=this.depths.get(material);
      }
    });
  }
  update(state,camera){
    const e=this.event,front=state.front;
    this.dust.visible=this.rocks.visible=e.escape.active&&state.quake>0;
    if(!this.dust.visible){this.dust.geometry.instanceCount=this.rocks.geometry.instanceCount=0;return;}
    const clouds=[],rocks=[],focus=camera?.position||e.rover.pos;
    if(camera){
      camera.updateMatrixWorld();
      this.frustum.setFromProjectionMatrix(this.clipMatrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    }
    const view=camera?.matrixWorldInverse.elements;
    const depth=p=>view?-(view[2]*p.x+view[6]*p.y+view[10]*p.z+view[14]):p.distance;
    for(const source of this.sources){
      if(front<source.front||state.time<=source.birth||state.time>source.birth+12)continue;
      for(let layer=0;layer<2;layer++){
        const pose=seismicDustPose(source,state.time,layer);
        if(pose){
          this.bounds.center.set(pose.x,pose.y,pose.z);this.bounds.radius=Math.hypot(pose.width,pose.height)*.5;
          if(!camera||this.frustum.intersectsSphere(this.bounds))
            clouds.push({...pose,distance:(pose.x-focus.x)**2+(pose.y-focus.y)**2+(pose.z-focus.z)**2});
        }
      }
      const rock=seismicRockPose(source,state.time);
      if(rock){
        let floor=e.terrain.heightAt(rock.x,rock.z)-seismicDrop(rock.x,rock.z,e.escape.origin,e.escape.axis,front,state.quake);
        if(faultContains(rock.x,rock.z,e.escape.origin,e.escape.axis,front,state.quake))floor-=STARFALL.depth;
        // Fade before reaching the actual floor, not halfway into an open fault.
        rock.fade*=sstep(floor,floor+1.5,rock.y);
        this.bounds.center.set(rock.x,rock.y,rock.z);this.bounds.radius=rock.size*1.2;
        if(rock.fade>.003&&(!camera||this.frustum.intersectsSphere(this.bounds)))
          rocks.push({...rock,distance:(rock.x-focus.x)**2+(rock.y-focus.y)**2+(rock.z-focus.z)**2});
      }
    }
    // Spend the same quality budgets on visible nearby plumes, then blend
    // back-to-front so alpha smoke does not reorder as a moving solid wall.
    clouds.sort((a,b)=>a.distance-b.distance);
    if(clouds.length>this.dustBudget){
      clouds.length=this.dustBudget;
      const cutoff=clouds[clouds.length-1].distance;
      for(const cloud of clouds)cloud.opacity*=1-sstep(cutoff*.75,cutoff,cloud.distance);
    }
    clouds.sort((a,b)=>depth(b)-depth(a));
    const dp=this.dust.geometry.attributes.aPose,ds=this.dust.geometry.attributes.aStyle;
    clouds.forEach((p,i)=>{dp.setXYZW(i,p.x,p.y,p.z,p.width);ds.setXYZW(i,p.height,p.frame,p.opacity,p.mirror);});
    dp.needsUpdate=ds.needsUpdate=true;this.dust.geometry.instanceCount=clouds.length;
    rocks.sort((a,b)=>a.distance-b.distance);rocks.length=Math.min(rocks.length,this.rockBudget);
    rocks.sort((a,b)=>depth(b)-depth(a));
    const rp=this.rocks.geometry.attributes.aPose,rs=this.rocks.geometry.attributes.aSpin;
    rocks.forEach((p,i)=>{rp.setXYZW(i,p.x,p.y,p.z,p.size);rs.setXY(i,p.spin,p.fade);});
    rp.needsUpdate=rs.needsUpdate=true;this.rocks.geometry.instanceCount=rocks.length;
  }
}
