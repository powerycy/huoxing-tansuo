// Shared physical proximity, manual coupling and UI semantics.
export const CHARGER_LABELS = { SLED: '火星母港', 'HALLEY VI': '阿瑞斯六号', RELAY: '孤立中继站' };
export function chargeState(rover, props, home, pressed, locked = false, driving = false) {
  const pads = [{ ...home, r: 6.4, id: 'SLED', online: true },
    { ...props.stationChargePoint, id: 'HALLEY VI', online: !!props.stationOnline },
    { ...props.relayChargePoint, id: 'RELAY', online: true }];
  const nearby = pads.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.z))
    .map(p=>({...p, distance:Math.hypot(rover.pos.x-p.x,rover.pos.z-p.z)}))
    .filter(p=>p.distance<p.r+9).sort((a,b)=>a.distance-b.distance)[0];
  const inside = !!nearby && nearby.distance < nearby.r;
  const stopped = rover.vel.length() < .55;
  const wasCoupled = !!rover.chargeState?.coupled && rover.chargeState.site === nearby?.id;
  const requested = pressed ? !wasCoupled : wasCoupled;
  const coupled = inside && nearby.online && stopped && requested && !locked && !driving;
  return { nearby, inside, stopped, coupled, locked, site: inside ? nearby.id : null };
}
export function chargePrompt(rover, power) {
  const state=rover.chargeState, p=state?.nearby;
  if(!p || state.locked)return '';
  const label=CHARGER_LABELS[p.id];
  if(!p.online)return `${label}充电区 · 恢复基地记录后供电`;
  if(!state.inside)return `${label}充电区 · ${Math.ceil(p.distance)} 米 · 驶入线圈后按 <kbd>T</kbd>`;
  if(!state.stopped)return `${label}充电区 · 停车后按 <kbd>T</kbd> 充电`;
  if(power>=99.9)return `${label} · 电量已满 100%`;
  return state.coupled ? `正在充电 · ${label} · 按 <kbd>T</kbd> 停止`
    : `${label} · 按 <kbd>T</kbd> 开始充电`;
}
