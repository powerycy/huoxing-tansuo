// Coarse A* over real collision/height data, not a straight line through rocks.
// Route is guidance only: it never modifies original terrain or collision.
export function planEscapeRoute(start, goal, terrain, colliders = []) {
  const step = 6, radius = 410, side = Math.floor(radius * 2 / step) + 1;
  const id = (x, z) => z * side + x;
  const point = (key) => ({ x: (key % side) * step - radius, z: Math.floor(key / side) * step - radius });
  const keyFor = p => id(Math.round((p.x + radius) / step), Math.round((p.z + radius) / step));
  const from = keyFor(start), to = keyFor(goal), open = new Set([from]);
  const costs = new Map([[from, 0]]), parents = new Map(), cache = new Map();
  const inspect = key => {
    if (cache.has(key)) return cache.get(key);
    const p = point(key), h = terrain.heightAt(p.x, p.z);
    const blocked = Math.hypot(p.x, p.z) > radius || colliders.some(c =>
      Math.hypot(p.x - c.x, p.z - c.z) < c.r + 3.0);
    const value = { ...p, h, blocked }; cache.set(key, value); return value;
  };
  const edgeClear = (a, b) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if(length<0.001)return true;
    const samples=Math.max(4,Math.ceil(length/1.5));
    let previous = terrain.heightAt(a.x, a.z);
    for (let n = 1; n <= samples; n++) {
      const x = a.x + (b.x - a.x) * n / samples, z = a.z + (b.z - a.z) * n / samples;
      const h = terrain.heightAt(x, z);
      if (Math.abs(h - previous) / (length / samples) > 0.72 || colliders.some(c => Math.hypot(x-c.x,z-c.z) < c.r+2.6)) return false;
      previous = h;
    }
    return true;
  };
  let reached = null;
  for (let iteration = 0; open.size && iteration < 16000; iteration++) {
    let best, score = Infinity;
    for (const k of open) {
      const p = point(k), f = costs.get(k) + Math.hypot(p.x-goal.x,p.z-goal.z);
      if (f < score) { score=f; best=k; }
    }
    open.delete(best);
    const a = inspect(best);
    if (best === to || Math.hypot(a.x-goal.x,a.z-goal.z) < 9 && edgeClear(a,goal)) { reached=best; break; }
    for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
      const x = best % side + dx, z = Math.floor(best/side) + dz;
      if (x < 0 || z < 0 || x >= side || z >= side) continue;
      const k = id(x,z), b = inspect(k);
      if (b.blocked || !edgeClear(a,b)) continue;
      const d = step * Math.hypot(dx,dz), slope = Math.abs(b.h-a.h)/d;
      const g = costs.get(best) + d * (1 + slope*slope*12);
      if (g >= (costs.get(k) ?? Infinity)) continue;
      costs.set(k,g); parents.set(k,best); open.add(k);
    }
  }
  // Never label a failed direct path as a verified safe route.
  if (reached === null) return [];
  const route = [goal];
  for (let k = reached; k !== undefined; k = parents.get(k)) route.push(point(k));
  route.reverse(); route[0] = { ...start };
  if (route.length > 1 && !edgeClear(start,route[1])) return [];
  // String-pull only through collision- and slope-tested segments. This removes
  // staircase zigzags from the grid without cutting across boulders or cliffs.
  const smooth=[route[0]];
  for(let i=0;i<route.length-1;){
    let next=i+1;
    for(let j=Math.min(i+12,route.length-1);j>i+1;j--)if(edgeClear(route[i],route[j])){next=j;break;}
    smooth.push(route[next]);i=next;
  }
  const dense=[smooth[0]];
  for(let i=1;i<smooth.length;i++){
    const a=smooth[i-1],b=smooth[i],count=Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/9);
    for(let j=1;j<=count;j++)dense.push({x:a.x+(b.x-a.x)*j/count,z:a.z+(b.z-a.z)*j/count});
  }
  return dense;
}
