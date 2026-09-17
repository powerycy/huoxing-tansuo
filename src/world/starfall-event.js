import * as THREE from 'three';
import { makeRNG, sstep } from '../core/rng.js';
import { planEscapeRoute } from '../game/escape-route.js';
import { STARFALL, starfallState, faultBend, FAULT_GLSL, SKY_FLOW_GLSL, skyTurnAt, quakeImpactAt, seismicDrop } from './starfall-field.js';
import { SeismicMass } from './seismic-mass.js';

// An actual sky volume, an upward relay beam and open, depth-bearing fissures.
// No screen-space video, world flattening, rectangular mural or exposure flash.
export class StarfallEvent {
  constructor({scene,terrain,rover,sky,props,escape,quality,delivery}) {
    Object.assign(this,{scene,terrain,rover,sky,props,escape,delivery});
    this.root=new THREE.Group();this.root.name='StarfallAndSeismicEscape';scene.add(this.root);
    this.skyRoot=new THREE.Group();this.root.add(this.skyRoot);
    this.materials=new Set();this.finished=0;this.lastPhase='idle';
    this.uniforms={uQuakeOrigin:{value:new THREE.Vector2(escape.origin.x,escape.origin.z)},
      uQuakeAxis:{value:new THREE.Vector2(escape.axis.x,escape.axis.z)},
      uQuakeFront:{value:escape.front},uQuakeOn:{value:0},uSkyAmount:{value:0},uClock:{value:0},uSkyTurn:{value:0},
      // Legacy diagnostic bookmarks may still read these. No folding is installed.
      uFoldOn:{value:0},uFoldPaintReady:{value:0}};
    this.anchor=new THREE.Vector3(escape.origin.x-1.9,terrain.heightAt(escape.origin.x,escape.origin.z)+12.5,escape.origin.z+.2);
    if(delivery?.signalTip){delivery.signalTip.updateWorldMatrix(true,false);delivery.signalTip.getWorldPosition(this.anchor);}
    this.skyBearing=Math.atan2(-escape.axis.x,-escape.axis.z);
    this.uniforms.uBearing={value:this.skyBearing};
    this.shakeOffset=new THREE.Vector3();this._audioClock=0;
    this._buildSky();this._buildBeam();this._buildFaults();this._buildGuides();
    // Retain the old diagnostics handle; moving screen-space specks are now
    // replaced by fixed-origin fracture fragments and textured impact clouds.
    this.debris=new THREE.Group();this.debris.visible=false;
    this.mass=new SeismicMass(this);
    this.setQuality(quality);this.root.visible=false;
  }
  _buildSky() {
    const placeholder=new THREE.DataTexture(new Uint8Array([10,23,54,255]),1,1);
    placeholder.needsUpdate=true;
    this.skyMaterial=new THREE.ShaderMaterial({transparent:true,side:THREE.BackSide,
      depthWrite:false,depthTest:true,fog:false,uniforms:{...this.uniforms,uPaint:{value:placeholder},uBearing:{value:this.skyBearing}},
      vertexShader:'varying vec3 vDirection;void main(){vDirection=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:SKY_FLOW_GLSL+`varying vec3 vDirection;uniform sampler2D uPaint;uniform float uSkyAmount,uClock;
        void main(){vec3 d=normalize(vDirection);float az=atan(d.x,d.z)-uBearing;
          az=mod(az+3.14159265,6.2831853)-3.14159265;
          vec2 angular=skyFlow(vec2(az,asin(clamp(d.y,0.0,1.0))),-uSkyTurn);
          vec2 uv=vec2(angular.x/6.2831853+.5,.38+angular.y/1.5707963*.60);
          vec3 paint=texture2D(uPaint,uv).rgb;
          float horizon=smoothstep(-.015,.14,d.y);
          float reveal=smoothstep(0.0,.22,uSkyAmount-(1.0-d.y)*.24);
          gl_FragColor=vec4(paint*vec3(.34,.40,.52)+vec3(.004,.008,.023),horizon*reveal*uSkyAmount);
        }`});
    const dome=new THREE.Mesh(new THREE.SphereGeometry(7800,64,40),this.skyMaterial);
    dome.renderOrder=-800;dome.frustumCulled=false;this.skyRoot.add(dome);
    this.paintReady=new Promise(resolve=>{
      if(typeof document==='undefined'){resolve(false);return;}
      new THREE.TextureLoader().load('assets/textures/events/dimensional-starry-oil.png',texture=>{
        texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.MirroredRepeatWrapping;
        this.skyMaterial.uniforms.uPaint.value=texture;placeholder.dispose();
        this.uniforms.uFoldPaintReady.value=1;resolve(true);
      },undefined,()=>resolve(false));
    });
    // Short, unequal tapered strokes follow broad currents and multiple eddies.
    // Separate depths and tangents make this a volume, not contour lines on a quad.
    const count=26000,rng=makeRNG(0x51A22),centers=[],tangents=[],sizes=[],colors=[];
    const blue=['#28499b','#3e68b3','#5e86c8','#8facd8'];
    const white=['#90bddd','#aec9d4','#d1d7b0','#e6d69c'];
    const gold=['#ddbd5e','#eee0a3','#bba14d'];
    const direction=(az,el)=>new THREE.Vector3(Math.sin(az)*Math.cos(el),Math.sin(el),Math.cos(az)*Math.cos(el));
    for(let i=0;i<count;i++){
      let az,el,angle=0,palette=blue;
      const type=((i*9973)%count)/count;
      if(type<.36){az=(rng()-.5)*Math.PI*2;el=.13+rng()*1.32;angle=.12*Math.sin(az*3);}
      else if(type<.66){az=(rng()-.5)*3.8;el=.48+.17*Math.sin(az*2.2)+.055*(rng()-.5);angle=Math.atan(.37*Math.cos(az*2.2));palette=white;}
      else if(type<.9){const which=i%2,theta=rng()*Math.PI*5.5,r=.015+theta*.013;
        az=(which? .83:-.43)+Math.cos(theta)*r;el=(which?.51:.85)+Math.sin(theta)*r*.75;
        az+=(rng()-.5)*.045;el+=(rng()-.5)*.04;angle=theta+Math.PI/2;palette=white;}
      else{const star=i%9,theta=rng()*Math.PI*2,r=.013+Math.pow(rng(),.6)*.06;
        az=-1.8+star*.43+Math.cos(theta)*r;el=.9+(star%3)*.17+Math.sin(theta)*r;
        angle=theta+Math.PI/2;palette=gold;}
      az+=this.skyBearing;
      const radius=1900+rng()*430,dir=direction(az,el),p=dir.clone().multiplyScalar(radius);
      const tangent=direction(az+Math.cos(angle)*.001,el+Math.sin(angle)*.001).sub(dir).normalize();
      centers.push(...p.toArray());tangents.push(...tangent.toArray());
      sizes.push(3+rng()*10,.7+rng()*1.8,rng()*6.28);
      colors.push(...new THREE.Color(palette[Math.floor(rng()*palette.length)]).toArray());
    }
    const geo=new THREE.InstancedBufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute([-.5,0,0,-.31,-.5,0,.34,-.32,0,.5,0,0,.26,.5,0,-.35,.3,0],3));
    geo.setIndex([0,1,5,1,2,5,2,4,5,2,3,4]);
    for(const [name,array] of [['aCenter',centers],['aTangent',tangents],['aSize',sizes],['aColor',colors]])
      geo.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(array),3));
    geo.instanceCount=count;
    const mat=new THREE.ShaderMaterial({transparent:true,side:THREE.DoubleSide,depthWrite:false,fog:false,
      uniforms:this.uniforms,vertexShader:SKY_FLOW_GLSL+`attribute vec3 aCenter,aTangent,aSize,aColor;uniform float uClock;varying vec3 vColor;varying float vEdge;
        vec3 flowPoint(vec3 p){float r=length(p),az=atan(p.x,p.z)-uBearing;
          az=mod(az+3.14159265,6.2831853)-3.14159265;
          vec2 q=skyFlow(vec2(az,asin(clamp(p.y/r,-1.0,1.0))),uSkyTurn);
          q.x+=uBearing;return vec3(sin(q.x)*cos(q.y),sin(q.y),cos(q.x)*cos(q.y))*r;}
        void main(){vec3 center=flowPoint(aCenter),tangent=normalize(flowPoint(aCenter+aTangent)-center);
          vec3 normal=normalize(center),across=normalize(cross(normal,tangent));
          vec3 p=center+tangent*(position.x*aSize.x+sin(uClock*.12+aSize.z)*1.3)+across*position.y*aSize.y;
          vColor=aColor;vEdge=1.0-abs(position.y)*.65;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
      fragmentShader:'uniform float uSkyAmount;varying vec3 vColor;varying float vEdge;void main(){gl_FragColor=vec4(vColor*.78,uSkyAmount*vEdge*.90);}'});
    this.strokes=new THREE.Mesh(geo,mat);this.strokes.frustumCulled=false;this.strokes.renderOrder=-790;
    this.skyRoot.add(this.strokes);
  }
  _buildBeam(){
    this.beam=new THREE.Group();this.beam.position.copy(this.anchor);this.root.add(this.beam);
    const geometry=new THREE.CylinderGeometry(1,1,1,32,1,true);
    for(const [radius,opacity] of [[.48,.85],[1.3,.24],[3.1,.065]]){
      const material=new THREE.ShaderMaterial({transparent:true,side:THREE.DoubleSide,depthWrite:false,
        blending:THREE.AdditiveBlending,uniforms:{uPower:{value:0},uOpacity:{value:opacity}},
        vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader:'varying vec2 vUv;uniform float uPower,uOpacity;void main(){float end=smoothstep(0.0,.08,vUv.y)*(1.0-smoothstep(.9,1.0,vUv.y));gl_FragColor=vec4(.12,.58,1.0,end*uPower*uOpacity);}'});
      const mesh=new THREE.Mesh(geometry,material);mesh.userData.radius=radius;this.beam.add(mesh);
    }
    this.beamLight=new THREE.PointLight(0x499dff,0,38,2);this.beamLight.position.copy(this.anchor).add(new THREE.Vector3(0,-5,0));this.root.add(this.beamLight);
  }
  _buildFaults(){
    const positions=[],meta=[],slopes=[],indices=[],{origin,axis}=this.escape;
    // Each cross-section has two broken lips, two rock walls and a deep floor.
    for(let row=-364;row<=624;row+=26){
      for(let i=0;i<=300;i++){
        const s=-600+i*4,d=row+faultBend(s),x=origin.x+axis.z*s+axis.x*d,z=origin.z-axis.x*s+axis.z*d;
        const h=this.terrain.heightAt(x,z),slope=(this.terrain.heightAt(x+axis.x*3,z+axis.z*3)-this.terrain.heightAt(x-axis.x*3,z-axis.z*3))/6;
        for(const [lane,depth] of [[-1,0],[-1,1],[1,1],[1,0]]){
          positions.push(x,h,z);meta.push(s,row,lane,depth);slopes.push(slope);
        }
        if(i<300){const a=positions.length/3-4;for(let j=0;j<3;j++)indices.push(a+j,a+j+4,a+j+1,a+j+1,a+j+4,a+j+5);}
      }
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('aFault',new THREE.Float32BufferAttribute(meta,4));geometry.setAttribute('aSlope',new THREE.Float32BufferAttribute(slopes,1));geometry.setIndex(indices);
    const rock=this.terrain.uniforms?.uRockColor?.value;
    const mat=new THREE.ShaderMaterial({uniforms:{...this.uniforms,uRockFace:{value:rock||this.skyMaterial.uniforms.uPaint.value},
      uRockReady:{value:rock?1:0},uKey:{value:this.terrain.uniforms?.uSunDir?.value||new THREE.Vector3(.3,.7,.4)}},side:THREE.DoubleSide,
      vertexShader:FAULT_GLSL+`attribute vec4 aFault;attribute float aSlope;varying float vDepth,vWidth;varying vec3 vP;
        void main(){float w=faultWidth(aFault.x,aFault.y);vec3 p=position;
          p.xz+=uQuakeAxis*w*aFault.z;p.y+=aSlope*w*aFault.z-aFault.w*8.0*smoothstep(0.0,.6,w)+.055;
          p=seismicWorld(p);vDepth=aFault.w;vWidth=w;vP=p;gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);}`,
      fragmentShader:`varying float vDepth,vWidth;varying vec3 vP;uniform sampler2D uRockFace;uniform float uRockReady;uniform vec3 uKey;
        void main(){if(vWidth<.018)discard;
          vec3 rock=mix(vec3(.11,.095,.075),texture2D(uRockFace,vec2((vP.x+vP.z)*.19,vP.y*.24)).rgb,uRockReady);
          vec3 normal=normalize(cross(dFdx(vP),dFdy(vP)));
          vec3 c=mix(rock*(.2+abs(dot(normal,uKey))*.36),vec3(.001,.003,.007),smoothstep(.05,.80,vDepth));
          c+=vec3(.008,.025,.044)*pow(vDepth,6.0);gl_FragColor=vec4(c,1.0);}`});
    this.faults=new THREE.Mesh(geometry,mat);this.faults.frustumCulled=false;this.root.add(this.faults);
  }
  _buildGuides(){
    this.guide=new THREE.Group();this.root.add(this.guide);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-1.2,0,-1.2,0,0,1.4,1.2,0,-1.2,0,0,-.4],3));g.setIndex([0,1,3,1,2,3]);
    this.guideGeo=g;this.guideMat=new THREE.MeshBasicMaterial({color:0xdbb765,side:THREE.DoubleSide,transparent:true,opacity:.7,depthWrite:false});
  }
  setQuality(q){this.strokes.geometry.instanceCount=q?.name==='ULTRA'?26000:q?.name==='HIGH'?19000:q?.name==='MEDIUM'?13000:8000;this.mass?.setQuality(q);}
  getCinematicSubject(){return {root:this.anchor.clone(),crown:this.anchor.clone().add(new THREE.Vector3(0,12,0)),radius:5};}
  sampleFoldPosition(p){return p.clone();}
  buildRoute(start){
    this.guide.clear();const {axis,home}=this.escape;
    this.route=planEscapeRoute(start,{x:home.x-axis.x*9,z:home.z-axis.z*9},this.terrain,this.props.colliders);
    this.escape.route=this.route;
    for(let i=1;i<this.route.length;i+=2){const p=this.route[i],n=this.route[Math.min(i+1,this.route.length-1)],m=new THREE.Mesh(this.guideGeo,this.guideMat);
      m.position.set(p.x,this.terrain.heightAt(p.x,p.z)+.23,p.z);m.rotation.y=Math.atan2(n.x-p.x,n.z-p.z);this.guide.add(m);}
    return this.route;
  }
  install(){
    // Patch the production template as well as existing rings so quality rebuilds
    // inherit the same shared uniforms. Adds no terrain texture samplers.
    Object.assign(this.terrain.uniforms,this.uniforms);
    for(const material of [this.terrain.material,...(this.terrain.levels||[]).map(l=>l.mesh.material)]){
      if(!material||this.materials.has(material))continue;this.materials.add(material);Object.assign(material.uniforms,this.uniforms);
      if(!material.vertexShader.includes('vec3 seismicWorld'))material.vertexShader=FAULT_GLSL+material.vertexShader.replace(
        'gl_Position = projectionMatrix * viewMatrix * wp;',
        'wp.xyz=seismicWorld(wp.xyz);gl_Position = projectionMatrix * viewMatrix * wp;');
      if(!material.fragmentShader.includes('bool faultContains'))material.fragmentShader=FAULT_GLSL+material.fragmentShader.replace('gl_FragColor = vec4(col, 1.0);',
        'if(uQuakeOn>.001 && faultContains(vW))discard;gl_FragColor = vec4(col, 1.0);')
        .replace('uRShadowMat * vec4(vW, 1.0)','uRShadowMat * vec4(seismicWorld(vW), 1.0)')
        .replace('matrix * vec4(vW + normalize(vN)*0.035, 1.0)','matrix * vec4(seismicWorld(vW) + normalize(vN)*0.035, 1.0)');
      material.needsUpdate=true;
    }
    this.mass.install();
  }
  update(visible=true,dt=0,camera){
    const e=this.escape,state=starfallState(e);
    if(e.phase==='complete'){if(this.lastPhase==='idle')this.finished=STARFALL.settle;else this.finished=Math.min(STARFALL.settle,this.finished+Math.max(0,Math.min(dt,.05)));}
    else this.finished=0;
    const fade=e.phase==='complete'?1-sstep(0,STARFALL.settle,this.finished):1;
    this.lastPhase=e.phase;this.root.visible=visible&&state.visible;
    this.uniforms.uQuakeFront.value=state.front;this.uniforms.uQuakeOn.value=state.quake;
    this.uniforms.uSkyAmount.value=state.sky*fade;this.uniforms.uClock.value=state.time;
    // Decelerate angular travel after completion instead of abruptly freezing.
    const tail=e.phase==='complete'?this.finished-this.finished*this.finished/(2*STARFALL.settle):0;
    this.uniforms.uSkyTurn.value=skyTurnAt(state.time)+tail*.11;
    if(!visible||!state.visible){this.uniforms.uQuakeOn.value=0;this.beamLight.intensity=0;this._audioClock=0;return;}
    this.install();
    this.mass.update(state,camera);
    if(camera)this.skyRoot.position.copy(camera.position);
    const power=state.beam*fade*(1-sstep(16,24,state.time)*.76),height=1600*state.beam;
    const drop=seismicDrop(this.anchor.x,this.anchor.z,e.origin,e.axis,state.front,state.quake);
    this.beam.position.y=this.anchor.y-drop;this.beamLight.position.y=this.anchor.y-5-drop;
    for(const m of this.beam.children){m.scale.set(m.userData.radius,Math.max(.001,height),m.userData.radius);m.position.y=height*.5;m.material.uniforms.uPower.value=power;}
    this.beamLight.intensity=power*22;
    this.guide.visible=e.active&&!e.cinematicActive;
    this.lastState=state;
  }
  shakeCamera(camera){
    const e=this.escape,state=starfallState(e);
    if(!e.active||state.quake===0)return;
    const impact=quakeImpactAt(state.time),near=1-sstep(35,180,Math.max(0,e.gap));
    const amount=(e.cinematicActive?.06+impact*.30:.022+near*.060)*state.quake,t=state.time;
    this.shakeOffset.set(Math.sin(t*16.1)*amount,(Math.sin(t*23.3)+Math.sin(t*9.7))*.5*amount,0);
    camera.position.add(this.shakeOffset);
    camera.updateMatrixWorld();
  }
  prepareFrame(camera){camera.position.sub(this.shakeOffset);this.shakeOffset.set(0,0,0);}
  audioState(audio){
    const e=this.escape,s=starfallState(e),near=1-sstep(35,180,Math.max(0,e.gap));
    if(e.active&&s.time>=this._audioClock&&s.time-this._audioClock<.2){
      for(const at of [18.2,21.5,24.3])if(this._audioClock<at&&s.time>=at)audio?.seismicImpact?.(at===24.3?1:.7);
    }
    this._audioClock=s.time;
    return e.active?s.quake*(e.cinematicActive?.40+quakeImpactAt(s.time)*.6:.4+near*.6):0;
  }
}
