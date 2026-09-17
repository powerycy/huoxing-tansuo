import * as THREE from 'three';
import { planEscapeRoute } from '../game/escape-route.js';
import { createFoldPaintTexture } from './fold-paint-texture.js';

export const FOLD = Object.freeze({ width: 15, apron: 34, radius: 6, feed: 68,
  thickness: 0.012, printShear: 0.58, introStart: -110, start: -65, subjectDistance: -82 });

// The receiving plane never pivots. Source geometry first loses thickness,
// then SLIDES around a fixed floor-to-upright bend. Its original UVs survive:
// this is the actual consumed world, not a rectangular backdrop screenshot.
// Shared analytic mapping for color, shadows and the CPU camera helper.
export const FOLD_GLSL = /* glsl */`
  uniform vec2 uFoldOrigin, uFoldAxis;
  uniform float uFoldFront, uFoldOn, uFoldBaseY, uFoldFeed, uFoldLift;
  float foldSide(vec3 p) {return dot(p.xz-uFoldOrigin,vec2(uFoldAxis.y,-uFoldAxis.x));}
  float foldBow(float s) {return 1.8*sin(s*.018)+.65*sin(s*.057);}
  float foldAmount(vec3 p) {
    return smoothstep(0.0, 15.0, uFoldFront+foldBow(foldSide(p))-dot(p.xz-uFoldOrigin,uFoldAxis))*uFoldOn;
  }
  float foldCrest(float s) {
    // World-anchored, unequal brush tips; no rectangular upper/side boundary.
    return 155.0+56.0*sin(s*.012+.7)+31.0*sin(s*.034+1.3)
      +17.0*sin(s*.081+.4)+9.0*sin(s*.19)
      +28.0*pow(max(0.0,sin(s*.15+.4)),12.0)
      +13.0*pow(max(0.0,sin(s*.49)),16.0);
  }
  vec3 foldPath(vec3 p) {
    float side=foldSide(p), front=uFoldFront+foldBow(side);
    float d=dot(p.xz-uFoldOrigin,uFoldAxis), k=foldAmount(p);
    float h=p.y-uFoldBaseY;
    // A small oblique print shear preserves facades, rather than hiding all
    // station details under their roofs in a strictly top-down footprint.
    float feed=uFoldFeed*smoothstep(.96,1.0,k);
    float q=front-d+h*.58+feed;
    float bend=max(0.0,q-34.0), angle=min(bend/6.0,1.57079632679);
    float travel=min(q,34.0)+6.0*sin(angle);
    float rise=6.0*(1.0-cos(angle))+max(0.0,bend-9.42477796077);
    // Retain a hairline thickness on the local surface normal. The near side
    // faces the escaping rover (+axis), just as the floor's normal faced up.
    vec2 xz=uFoldOrigin+vec2(uFoldAxis.y,-uFoldAxis.x)*side
      +uFoldAxis*(front-travel+h*.012*sin(angle));
    return vec3(xz.x,uFoldBaseY+rise+h*.012*cos(angle),xz.y);
  }
  vec3 foldWorld(vec3 p) {
    return mix(p,foldPath(p),foldAmount(p));
  }
  float foldRemaining(vec3 p) {
    return .6+uFoldLift*foldCrest(foldSide(p))-(foldPath(p).y-uFoldBaseY);
  }
  vec2 foldCanvas(vec3 p) {
    return vec2(foldSide(p),dot(p.xz-uFoldOrigin,uFoldAxis)-(p.y-uFoldBaseY)*.58);
  }
`;

// Genuine painted imagery replaces the consumed surface. Layer 0 retains the
// original geology; layer 1 is the oil painting, in the SAME sampler slot.
// There is no procedural stripe/contour approximation or fullscreen filter.
export const FOLD_PAINT_GLSL = /* glsl */`
  uniform sampler2DArray uGeology;
  uniform float uFoldPaintReady;
  void foldClip(vec3 p) {
    if(foldAmount(p)>.995 && foldRemaining(p)<0.0)discard;
  }
  vec3 foldDecodePaint(vec3 c) {
    return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));
  }
  vec3 foldPigment(vec3 original, vec3 p) {
    vec2 canvas=foldCanvas(p);
    // A whole composition spans 320 metres, not hundreds of repeated tiny
    // waves. Source coordinates travel with the flat image through the bend.
    vec2 q=vec2(canvas.x/320.0+.5,(canvas.y+320.0)/320.0);
    // Mirrored addressing stays continuous across repeats without changing
    // geology's clamp wrap mode. Explicit gradients avoid fold-boundary LOD
    // instability and keep individual impasto strokes filtered at a distance.
    vec2 cell=mod(q,2.0), uv=1.0-abs(cell-1.0);
    vec2 direction=sign(1.0-cell);
    vec2 dx=dFdx(q)*direction, dy=dFdy(q)*direction;
    float k=foldAmount(p);
    if(k<.001 || uFoldPaintReady<.5)return original;
    vec3 paint=foldDecodePaint(textureGrad(uGeology,vec3(uv,1.0),dx,dy).rgb);
    // Keep source buildings legible as a few painted masses, not live PBR
    // highlights layered over a blue surface. The painting owns the color.
    float value=floor(clamp(dot(original,vec3(.2126,.7152,.0722)),0.0,1.0)*5.0+.5)/5.0;
    paint*=.86+value*.18;
    float lamp=clamp((original.r-original.b)*2.0,0.0,1.0);
    paint=mix(paint,vec3(.72,.43,.09),lamp*.48);
    return mix(original,paint,smoothstep(.08,.85,k));
  }
`;

export class DimensionalFold {
  constructor({ scene, terrain, rover, sky, props, escape }) {
    Object.assign(this, { scene, terrain, rover, sky, props, escape });
    // Keep one geology sampler identity across terrain, plants and buildings.
    // Array layers preserve every geology byte and avoid a 17th terrain unit.
    const sourceGeology=terrain.texGeology;
    const fixtureSource=sourceGeology || new THREE.DataTexture(new Uint8Array(4),1,1);
    this.paintAsset=createFoldPaintTexture(sourceGeology?terrain:{texGeology:fixtureSource});
    terrain.texGeology=this.paintAsset.texture;
    const geologyUniform=terrain.uniforms?.uGeology || {value:terrain.texGeology};
    geologyUniform.value=terrain.texGeology;
    sourceGeology?.dispose();
    if(!sourceGeology)fixtureSource.dispose();
    this.uniforms = {
      uGeology:geologyUniform, uFoldPaintReady:{value:0},
      uFoldOrigin: {value:new THREE.Vector2(escape.origin.x,escape.origin.z)},
      uFoldAxis: {value:new THREE.Vector2(escape.axis.x,escape.axis.z)},
      uFoldFront: {value:FOLD.introStart}, uFoldOn: {value:0},
      uFoldBaseY: {value:0}, uFoldFeed: {value:0}, uFoldLift: {value:0}
    };
    this.paintReady=this.paintAsset.ready.then(ready=>{
      this.uniforms.uFoldPaintReady.value=ready?1:0;
      return ready;
    });
    this.root = new THREE.Group(); this.root.name='DimensionalCollapse'; scene.add(this.root);
    this.root.visible=false; this.materials=new WeakSet();this.warps=new WeakMap();this.objects=new Map();this.lights=new Map();
    this._baseHeights=new Map(); this._edgeFront=NaN;
    this._buildCinematicOutcrop();
    // At the witness's completed compression the plane should pass close to
    // its feet, so the crown visibly lowers instead of the whole rock rising.
    this.anchorHeight=this.subject.root.y;
    this.uniforms.uFoldBaseY.value=this.anchorHeight;

    // The only added geometry is the contact seam and existing route markers.
    // The enormous irregular image is made from the original world meshes.
    const edgeCount=192;
    this.edgePositions=new Float32Array((edgeCount+1)*2*3);
    const edgeUv=new Float32Array((edgeCount+1)*2*2), indices=[];
    for(let i=0;i<=edgeCount;i++) {
      for(let j=0;j<2;j++){const n=i*2+j;edgeUv[n*2]=i/edgeCount;edgeUv[n*2+1]=j;}
      if(i<edgeCount){const a=i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(this.edgePositions,3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv',new THREE.BufferAttribute(edgeUv,2));geo.setIndex(indices);
    const edgeMaterial=new THREE.ShaderMaterial({
      uniforms:this.uniforms,side:THREE.DoubleSide,transparent:true,depthWrite:false,
      vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*viewMatrix*vec4(position,1.0);}`,
      fragmentShader:/* glsl */`
        uniform float uFoldOn;varying vec2 vUv;
        void main(){
          float rim=1.0-smoothstep(.04,.49,abs(vUv.y-.5));
          float ends=smoothstep(0.,.07,vUv.x)*(1.-smoothstep(.93,1.,vUv.x));
          gl_FragColor=vec4(vec3(.69,.64,.52),rim*ends*uFoldOn*.82);
        }`
    });
    this.edge=new THREE.Mesh(geo,edgeMaterial);this.edge.name='GroundContactSeam';
    this.edge.frustumCulled=false;this.root.add(this.edge);
    this.guide=new THREE.Group();this.guide.name='EscapeHomeGuidance';this.root.add(this.guide);
    this.guideMat=new THREE.MeshBasicMaterial({color:0xffd99f,transparent:true,opacity:0.78,depthWrite:false});
    this.guideGeo=new THREE.RingGeometry(0.65,0.88,3);this.guideGeo.rotateX(-Math.PI/2);
    this.install();
  }
  _buildCinematicOutcrop() {
    const {origin,axis}=this.escape, lateral=10, d=FOLD.subjectDistance;
    const x=origin.x+axis.x*d+axis.z*lateral, z=origin.z+axis.z*d-axis.x*lateral;
    const g=new THREE.Group();g.name='DimensionalWitnessScannedOutcrop';this.scene.add(g);
    const scans=this.props.scanVariants || [];
    // Reuse existing scanned meshes and their full material setup, including
    // textures and local lighting hooks. No substitute primitive/tower asset.
    let fallback=null;
    if(!scans.length)this.props.group?.traverse(o=>{if(!fallback&&o.isMesh&&o.geometry&&o.material===this.props.rockMat)fallback=o;});
    const placements=[
      [0,0,6.4,0.16,0],[-2.7,-1.0,4.3,-.54,1],[2.6,-.5,3.7,.58,2],
      [-1.0,2.4,2.8,1.1,3],[3.6,2.2,1.65,.29,1],[-4.4,1.5,1.5,-1.2,2]
    ];
    for(const [side,depth,size,yaw,index] of placements) {
      const source=scans[index%Math.max(1,scans.length)];
      const geometry=source?.geometries[0] || fallback?.geometry;
      const material=source?.material || fallback?.material;
      if(!geometry||!material)continue;
      const rock=new THREE.Mesh(geometry,material);
      const px=x+axis.z*side+axis.x*depth,pz=z-axis.x*side+axis.z*depth;
      rock.position.set(px,this.terrain.heightAt(px,pz)-size*.04,pz);
      rock.scale.set(size,size*(index===0?1.22:.80),size*.90);rock.rotation.y=yaw;
      rock.castShadow=true;rock.receiveShadow=true;g.add(rock);
      // The staged scan is also a real obstacle during ordinary exploration.
      // The escape boundary catches the rover before folded collision differs.
      geometry.computeBoundingSphere();
      this.props.colliders?.push({x:px,z:pz,r:geometry.boundingSphere.radius*size*.76,
        kind:'dimensional-outcrop'});
    }
    g.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(g), center=new THREE.Vector3(x,this.terrain.heightAt(x,z),z);
    if(!bounds.isEmpty()){
      bounds.getCenter(center);
      this.subject={root:new THREE.Vector3(center.x,bounds.min.y,center.z),
        crown:new THREE.Vector3(center.x,bounds.max.y,center.z),radius:Math.max(3,bounds.getSize(new THREE.Vector3()).length()*.5)};
    } else this.subject={root:center.clone(),crown:center.clone().add(new THREE.Vector3(0,5,0)),radius:5};
    this.outcrop=g;
  }
  getCinematicSubject() {
    if(!this.outcrop.children.length)return null;
    return {root:this.subject.root.clone(),crown:this.subject.crown.clone(),radius:this.subject.radius};
  }
  getMuralFocus() {
    this.refreshUniforms();
    const u=this.uniforms,axis=u.uFoldAxis.value,origin=u.uFoldOrigin.value;
    const d=u.uFoldFront.value-FOLD.apron-FOLD.radius;
    return new THREE.Vector3(origin.x+axis.x*d,u.uFoldBaseY.value+10+u.uFoldLift.value*45,origin.y+axis.y*d);
  }
  sampleFoldPosition(worldPosition,target=new THREE.Vector3(),refresh=true) {
    // Camera samples before the draw update; derive this frame's state rather
    // than chasing last frame's uniforms. Cached base-height lookups are cheap.
    if(refresh)this.refreshUniforms();
    const u=this.uniforms,axis=u.uFoldAxis.value,origin=u.uFoldOrigin.value;
    const d=(worldPosition.x-origin.x)*axis.x+(worldPosition.z-origin.y)*axis.y;
    const side=(worldPosition.x-origin.x)*axis.y-(worldPosition.z-origin.y)*axis.x;
    const front=u.uFoldFront.value+1.8*Math.sin(side*.018)+.65*Math.sin(side*.057);
    const k=THREE.MathUtils.smoothstep(front-d,0,FOLD.width)*u.uFoldOn.value;
    const h=worldPosition.y-u.uFoldBaseY.value;
    const feed=u.uFoldFeed.value*THREE.MathUtils.smoothstep(k,.96,1);
    const q=front-d+h*FOLD.printShear+feed,bend=Math.max(0,q-FOLD.apron);
    const angle=Math.min(bend/FOLD.radius,Math.PI/2);
    const travel=Math.min(q,FOLD.apron)+FOLD.radius*Math.sin(angle);
    const rise=FOLD.radius*(1-Math.cos(angle))+Math.max(0,bend-FOLD.radius*Math.PI/2);
    const finalD=front-travel+h*FOLD.thickness*Math.sin(angle);
    // Read input before writing target: light targets may pass the same vector.
    const x=worldPosition.x,y=worldPosition.y,z=worldPosition.z;
    return target.set(THREE.MathUtils.lerp(x,origin.x+axis.y*side+axis.x*finalD,k),
      THREE.MathUtils.lerp(y,u.uFoldBaseY.value+rise+h*FOLD.thickness*Math.cos(angle),k),
      THREE.MathUtils.lerp(z,origin.y-axis.x*side+axis.y*finalD,k));
  }
  refreshUniforms(visible=this.root.visible||this.escape.cinematicActive) {
    const e=this.escape,progress=THREE.MathUtils.clamp(e.introProgress??1,0,1),intro=!!e.introActive;
    const front=intro?THREE.MathUtils.lerp(FOLD.introStart,e.front,THREE.MathUtils.smoothstep(progress,.12,.48)):e.front;
    // Sampling a cinematic may precede root visibility by one tick at its
    // entry. That tick is the intact establishing shot (fold amount zero).
    const amount=visible?(intro?THREE.MathUtils.smoothstep(progress,.13,.27):1):0;
    this.uniforms.uFoldOn.value=amount;
    this.uniforms.uFoldFront.value=front;
    const lift=intro?THREE.MathUtils.smoothstep(progress,.53,.95):1;
    this.uniforms.uFoldFeed.value=lift*FOLD.feed;
    this.uniforms.uFoldLift.value=lift;
    this.uniforms.uFoldBaseY.value=this._baseHeight(front);
    return {front,amount};
  }
  _baseHeight(front) {
    // Continuous spatial interpolation avoids frame-dependent lerp/jitter.
    // Hold the intro's sheet plane fixed, then gently follow the return valley.
    const cell=20, a=Math.floor(front/cell)*cell,b=a+cell;
    for(const d of [a,b])if(!this._baseHeights.has(d)) {
      const {origin,axis}=this.escape;
      this._baseHeights.set(d,this.terrain.heightAt(origin.x+axis.x*d,origin.z+axis.z*d));
    }
    const sampled=THREE.MathUtils.lerp(this._baseHeights.get(a),this._baseHeights.get(b),THREE.MathUtils.smoothstep(front,a,b));
    return THREE.MathUtils.lerp(this.anchorHeight,sampled,THREE.MathUtils.smoothstep(front,FOLD.start,FOLD.start+45));
  }
  install() {
    const U=this.uniforms;
    // Clipmap rings own ShaderMaterial instances: patch every existing ring,
    // not just the template. New quality tiers copy the patched template and
    // the shared uniforms below, so they stay folded too.
    if(this.terrain.uniforms)Object.assign(this.terrain.uniforms,U);
    const terrainMaterials=[this.terrain.material,...(this.terrain.levels||[]).map(level=>level.mesh.material)];
    for(const terrain of terrainMaterials)if (!this.materials.has(terrain)) {
      this.materials.add(terrain);Object.assign(terrain.uniforms,U);
      if(!terrain.vertexShader.includes('float foldAmount')) {
        terrain.vertexShader=FOLD_GLSL+terrain.vertexShader.replace('gl_Position = projectionMatrix * viewMatrix * wp;',`
          vec3 foldSource=wp.xyz;
          wp.xyz=foldWorld(wp.xyz);
          // Ring sag must not collapse to submillimeter spacing on the mural.
          // Keep coarse clipmap overlap safely behind its fine neighbor.
          float foldK=foldAmount(foldSource);
          float foldVertical=smoothstep(1.0,7.0,wp.y-uFoldBaseY);
          wp.xz-=uFoldAxis*uSag*.35*foldK*foldVertical;
          wp.y-=uSag*.35*foldK*(1.0-foldVertical);
          gl_Position = projectionMatrix * viewMatrix * wp;
        `);
        terrain.fragmentShader=FOLD_GLSL+FOLD_PAINT_GLSL+terrain.fragmentShader
        .replace('uniform sampler2D uSunMask, uTrail, uGeology;','uniform sampler2D uSunMask, uTrail;')
        .replace('texture2D(uGeology, guv)','texture(uGeology, vec3(guv,0.0))')
        .replace('gl_FragColor = vec4(col, 1.0);',
        'foldClip(vW);col=foldPigment(col,vW);gl_FragColor=vec4(col,1.0);')
        // Keep vW for the original texture image, but use the projected
        // receiver for live model shadows; the same geometry casts them.
        .replace('matrix * vec4(vW + normalize(vN)*0.035, 1.0)',
          'matrix * vec4(foldWorld(vW) + normalize(vN)*0.035, 1.0)')
        .replace('uRShadowMat * vec4(vW, 1.0)','uRShadowMat * vec4(foldWorld(vW), 1.0)')
        .replace('return mix(visibility,1.0,smoothstep(100.0,160.0,viewDistance));',
          'return mix(visibility,1.0,max(smoothstep(100.0,160.0,viewDistance),foldAmount(vW)));');
      }
      terrain.needsUpdate=true;
    }
    const excluded = object => {
      for(let p=object;p;p=p.parent) if(p===this.rover.root||p===this.sky.group||p===this.root) return true;
      return false;
    };
    this.scene.traverse(object=>{
      if((object.isPointLight||object.isSpotLight)&&!excluded(object)&&!this.lights.has(object)) {
        this.lights.set(object,{position:object.position.clone(),sourceIntensity:object.intensity,lastIntensity:object.intensity,
          target:object.isSpotLight?object.target.position.clone():null});
      }
      if(!object.isMesh||excluded(object))return;
      for(const mat of [object.material].flat()) {
        if(!mat)continue;
        if(this.warps.has(mat))this.attachDepth(object,mat,this.warps.get(mat));
        if(this.materials.has(mat)){
          if(mat.isShaderMaterial&&mat.vertexShader.includes('foldWorld(world')) {
            if(!this.objects.has(object))this.objects.set(object,object.frustumCulled);
          }
          continue;
        }
        const plantVec3='gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);';
        const plantVec4='gl_Position = projectionMatrix * viewMatrix * world;';
        if(mat.isShaderMaterial && (mat.vertexShader.includes(plantVec3)||mat.vertexShader.includes(plantVec4))) {
          this.materials.add(mat);Object.assign(mat.uniforms,U);
          mat.vertexShader=FOLD_GLSL+mat.vertexShader.replace(plantVec3,
            'world=foldWorld(world);gl_Position=projectionMatrix*viewMatrix*vec4(world,1.0);')
            .replace(plantVec4,'world.xyz=foldWorld(world.xyz);gl_Position=projectionMatrix*viewMatrix*world;');
          mat.fragmentShader=FOLD_GLSL+FOLD_PAINT_GLSL+mat.fragmentShader.replace('gl_FragColor = vec4(col, 1.0);',
            'foldClip(vWorld);col=foldPigment(col,vWorld);gl_FragColor=vec4(col,1.0);');
          this.objects.set(object,object.frustumCulled);
          mat.needsUpdate=true;continue;
        }
        if(!mat.isMeshStandardMaterial&&!mat.isMeshBasicMaterial)continue;
        this.materials.add(mat);
        const previous=mat.onBeforeCompile, key=mat.customProgramCacheKey();
        const warp=shader=>{
          Object.assign(shader.uniforms,U);
          shader.vertexShader=FOLD_GLSL+'\nvarying vec3 vFoldWorld;\n'+shader.vertexShader.replace('#include <project_vertex>',`
            vec4 foldPosition=vec4(transformed,1.0);
            #ifdef USE_BATCHING
              foldPosition=batchingMatrix*foldPosition;
            #endif
            #ifdef USE_INSTANCING
              foldPosition=instanceMatrix*foldPosition;
            #endif
            foldPosition=modelMatrix*foldPosition;
            vFoldWorld=foldPosition.xyz;
            vec4 mvPosition=viewMatrix*vec4(foldWorld(foldPosition.xyz),1.0);
            gl_Position=projectionMatrix*mvPosition;
          `).replace('#include <worldpos_vertex>',`
            #include <worldpos_vertex>
            #if defined(USE_ENVMAP) || defined(DISTANCE) || defined(USE_SHADOWMAP) || defined(USE_TRANSMISSION) || NUM_SPOT_LIGHT_COORDS > 0
              worldPosition.xyz=foldWorld(worldPosition.xyz);
            #endif
          `);
        };
        mat.onBeforeCompile=(shader,renderer)=>{
          previous.call(mat,shader,renderer);warp(shader);
          shader.fragmentShader=FOLD_GLSL+FOLD_PAINT_GLSL+'\nvarying vec3 vFoldWorld;\n'+shader.fragmentShader.replace('#include <opaque_fragment>',`
            // A collapsed object becomes a printed image: retain its actual
            // decoded albedo even where the old 3-D normal faced away from the
            // moon. No new texture fetch or whole-world exposure change.
            foldClip(vFoldWorld);
            vec3 foldPrint=diffuseColor.rgb*.52;
            outgoingLight=mix(outgoingLight,max(outgoingLight,foldPrint),foldAmount(vFoldWorld)*.92);
            outgoingLight=foldPigment(outgoingLight,vFoldWorld);
            #include <opaque_fragment>
          `);
        };
        mat.customProgramCacheKey=()=>key+'|dimensional-oil-image-v4';mat.needsUpdate=true;
        this.warps.set(mat,warp);this.attachDepth(object,mat,warp);
      }
    });
  }
  attachDepth(object,mat,warp) {
    if(!this.objects.has(object))this.objects.set(object,object.frustumCulled);
    if(object.castShadow&&!object.customDepthMaterial) {
      const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:mat.side,
        map:mat.map,alphaMap:mat.alphaMap,alphaTest:mat.alphaTest});
      depth.onBeforeCompile=shader=>{
        warp(shader);
        shader.fragmentShader=FOLD_GLSL+FOLD_PAINT_GLSL+'\nvarying vec3 vFoldWorld;\n'+shader.fragmentShader
          .replace('void main() {','void main() {\n foldClip(vFoldWorld);');
      };
      depth.customProgramCacheKey=()=> 'dimensional-oil-depth-v4';
      object.customDepthMaterial=depth;
    }
  }
  buildRoute(start) {
    this.guide.clear();
    const {axis,home}=this.escape;
    const goal={x:home.x-axis.x*9,z:home.z-axis.z*9};
    this.route=planEscapeRoute(start,goal,this.terrain,this.props.colliders);
    this.escape.route=this.route;
    for(let i=1;i<this.route.length;i+=2) {
      const p=this.route[i], next=this.route[Math.min(i+1,this.route.length-1)];
      const m=new THREE.Mesh(this.guideGeo,this.guideMat);
      m.position.set(p.x,this.terrain.heightAt(p.x,p.z)+0.23,p.z);
      m.rotation.y=Math.atan2(next.x-p.x,next.z-p.z);this.guide.add(m);
    }
    return this.route;
  }
  _updateEdge(front) {
    if(Math.abs(front-this._edgeFront)<.08)return;
    this._edgeFront=front;
    const {origin,axis}=this.escape,count=this.edgePositions.length/6-1;
    for(let i=0;i<=count;i++) {
      const lateral=(i/count-.5)*900;
      // Deterministic low-frequency waviness, not moving noise or strobing.
      const bow=1.8*Math.sin(lateral*.018)+.65*Math.sin(lateral*.057);
      for(let j=0;j<2;j++) {
        const d=front+bow+(j-.5)*.28;
        const x=origin.x+axis.x*d+axis.z*lateral,z=origin.z+axis.z*d-axis.x*lateral;
        const index=(i*2+j)*3;
        this.edgePositions[index]=x;this.edgePositions[index+1]=this.terrain.heightAt(x,z)+.18;this.edgePositions[index+2]=z;
      }
    }
    this.edge.geometry.attributes.position.needsUpdate=true;
  }
  _updateLights(amount) {
    const {origin,axis}=this.escape,front=this.uniforms.uFoldFront.value;
    for(const [light,state] of this.lights) {
      // Read new facility power values when its controller supplied one;
      // otherwise retain the pre-fold intensity instead of compounding fades.
      if(light.intensity!==state.lastIntensity)state.sourceIntensity=light.intensity;
      const world=state.position.clone();
      if(light.parent)light.parent.localToWorld(world);
      const d=(world.x-origin.x)*axis.x+(world.z-origin.z)*axis.z;
      const lateral=(world.x-origin.x)*axis.z-(world.z-origin.z)*axis.x;
      const bow=1.8*Math.sin(lateral*.018)+.65*Math.sin(lateral*.057);
      const k=THREE.MathUtils.smoothstep(front+bow-d,0,FOLD.width)*amount;
      light.intensity=state.sourceIntensity*(1-k);state.lastIntensity=light.intensity;
      const projected=this.sampleFoldPosition(world,new THREE.Vector3(),false);
      if(light.parent)light.parent.worldToLocal(projected);
      light.position.copy(projected);
      if(state.target) {
        const target=light.target,p=state.target.clone();
        if(target.parent)target.parent.localToWorld(p);
        this.sampleFoldPosition(p,p,false);
        if(target.parent)target.parent.worldToLocal(p);
        target.position.copy(p);
      }
    }
  }
  update(visible) {
    const e=this.escape;
    // Keep the collapsed world behind the completion overlay. Only leaving
    // the world/menu or resetting a game restores intact geometry.
    this.root.visible=visible&&e.phase!=='idle';
    const {front,amount}=this.refreshUniforms(this.root.visible);
    for(const [object,original] of this.objects)object.frustumCulled=amount>0?false:original;
    this._updateLights(amount);
    if(this.root.visible)this._updateEdge(front);
    this.guide.visible=e.active&&!e.cinematicActive;
    for(const marker of this.guide.children) {
      const p=marker.position;
      const d=(p.x-e.origin.x)*e.axis.x+(p.z-e.origin.z)*e.axis.z;
      marker.visible=d>front+3&&p.distanceTo(this.rover.pos)<135;
    }
    if(e.active)this.props.revealHomeGuidance(2);
  }
}
