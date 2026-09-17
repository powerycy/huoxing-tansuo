// All captions use the existing world's phase clock. Pause, skip and saved
// events cannot leave a wall-clock subtitle running over a different shot.
import { PROFILE } from '../profile.js';
import { sstep } from '../core/rng.js';

const CHAPTERS = ['warning', 'grass', 'first', 'bloom', 'full'];
const WINDOWS = [[0.20, 0.88], [0.16, 0.96], [0.24, 0.96], [0.16, 0.92], [0.02, 0.98]];

export function flowerArchiveAvailable(event) {
  return !!event?.triggered && ['full', 'navigate', 'ascend', 'scar'].includes(event.phase);
}

export function flowerArchiveCue(event, profile = PROFILE) {
  if (!event?.cinematicActive || event.cinematic?.ending) return null;
  const index = CHAPTERS.indexOf(event.phase);
  if (index < 0) return null;
  const progress = event.phaseProgress;
  const [start, end] = WINDOWS[index];
  if (progress <= start || progress >= end) return null;
  const story = profile.flowerStory;
  const project = profile.projects[0];
  const chapters = [
    ['来自荒原的信', story.opening, story.openingDetail, ''],
    ['创作方向', story.growing, '探索 AI、实时三维与游戏叙事之间的可能。', profile.focus.join('  /  ')],
    ['这封信，来自', profile.displayName, profile.role, '在好奇心指引下，持续创作。'],
    ['你正在进入的作品', project.title, project.summary, project.stack.join('  /  ')],
    ['与你连接', story.invitation, '', '花海来信 · 已收录']
  ];
  const [label, title, detail, keywords] = chapters[index];
  // Roughly 1–2 seconds of smooth opacity per edge; never a glitch or flash.
  const feather = index === 4 ? 0.22 : 0.10;
  const opacity = sstep(start, start + feather, progress) * (1 - sstep(end - feather, end, progress));
  return { index, number: `${String(index + 1).padStart(2, '0')} / 05`, label, title, detail, keywords, opacity };
}

export class FlowerArchive {
  constructor(root = document) {
    const $ = id => root.getElementById(id);
    this.cueEl = $('flowerArchiveCue');
    this.notice = $('flowerArchiveNotice');
    this.text = ['Number', 'Label', 'Title', 'Detail', 'Keywords'].map(name => $(`flowerArchive${name}`));
    this.track = [...this.cueEl.querySelectorAll('i')];
    this.profile = $('profile');
    this.seal = $('profileFlowerSeal');
    this.source = $('profileSource');
    this.heading = $('profileTitle');
    this.reset();
  }

  reset() {
    this.current = null;
    this.lastIndex = -1;
    this.noticeTime = 0;
    this.dismissed = false;
    this.available = false;
    this.cueEl.hidden = this.notice.hidden = true;
    this.syncProfile(false);
  }

  dismiss() { this.dismissed = true; this.notice.hidden = true; }

  syncProfile(available) {
    this.profile.classList.toggle('flower-profile', available);
    this.seal.hidden = !available;
    this.source.textContent = available ? '荒野来信 / 花海档案' : '地球链路 / 操作员记录';
    this.heading.textContent = available ? '花海来信 · 创作档案' : '个人档案';
  }

  update(dt, { event, playing, blocked = false, hudOn = true }) {
    const available = flowerArchiveAvailable(event);
    if (available !== this.available) {
      this.available = available;
      this.syncProfile(available);
    }
    this.current = playing && !blocked ? flowerArchiveCue(event) : null;
    this.cueEl.hidden = !this.current;
    if (this.current) {
      const cue = this.current;
      if (cue.index !== this.lastIndex) {
        [cue.number, cue.label, cue.title, cue.detail, cue.keywords].forEach((value, i) => {
          this.text[i].textContent = value;
          this.text[i].hidden = !value;
        });
        this.track.forEach((bar, i) => bar.classList.toggle('on', i <= cue.index));
        this.cueEl.dataset.chapter = String(cue.index);
        this.lastIndex = cue.index;
      }
      this.cueEl.style.opacity = cue.opacity.toFixed(3);
    }
    const showNotice = available && playing && !blocked && hudOn && !event.cinematicActive
      && !this.dismissed && this.noticeTime < 14;
    this.notice.hidden = !showNotice;
    if (showNotice) this.noticeTime += dt;
  }
}

// Canvas capture does not include DOM. The recording tool draws this same cue
// over the rendered frame so an exported flower sequence retains its story.
export function drawFlowerArchiveCue(ctx, cue, width, height) {
  if (!cue) return;
  const scale = Math.min(width / 1440, height / 810);
  const x = width * 0.065, bottom = height * 0.73;
  const font = '"PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.save();
  ctx.globalAlpha = cue.opacity;
  ctx.shadowColor = '#020409'; ctx.shadowBlur = 14 * scale;
  const maxWidth = 480 * scale;
  ctx.fillStyle = '#b6c7e4'; ctx.font = `${11 * scale}px ${font}`;
  ctx.fillText(`${cue.number}    ${cue.label}`, x, bottom - 122 * scale);
  ctx.fillStyle = '#f3eef8'; ctx.font = `300 ${30 * scale}px ${font}`;
  ctx.fillText(cue.title, x, bottom - 75 * scale, maxWidth);
  ctx.fillStyle = '#d5d7df'; ctx.font = `${13 * scale}px ${font}`;
  let line = '', row = 0;
  for (const char of cue.detail) {
    if (ctx.measureText(line + char).width > maxWidth) {
      ctx.fillText(line, x, bottom - 36 * scale + row * 24 * scale);
      line = ''; row++;
    }
    line += char;
  }
  if (line) ctx.fillText(line, x, bottom - 36 * scale + row * 24 * scale);
  ctx.fillStyle = '#bcb6d8'; ctx.font = `${11 * scale}px ${font}`;
  ctx.fillText(cue.keywords, x, bottom + (row * 24 + 8) * scale, maxWidth);
  ctx.shadowBlur = 0;
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i <= cue.index ? '#b6c7e4' : 'rgba(182,199,228,.25)';
    ctx.fillRect(x + i * 27 * scale, bottom + (row * 24 + 28) * scale, 20 * scale, scale);
  }
  ctx.restore();
}
