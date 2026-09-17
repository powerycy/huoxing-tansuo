/* ============================================================
   OPERATOR ARCHIVE

   Runtime-facing project identity. Personal contact details are intentionally
   not embedded in the game build.
   ============================================================ */

export const PROFILE = Object.freeze({
  displayName: '好奇的小逸',
  romanizedName: 'CURIOUS YI',
  role: '独立开发者 · 互动体验创作者',
  location: '中国',
  availability: '开放交流',
  intro: '我在探索 AI、实时三维与游戏叙事如何共同构成可以亲自进入的作品。这里既是操作员档案，也是我的项目与创作记录入口。',
  avatar: '',
  focus: ['AI 辅助创作', '实时三维', '交互叙事'],
  flowerStory: {
    opening: '把好奇，送往更远的地方。',
    openingDetail: '一封来自荒原的信，正在与你建立连接。',
    growing: '让想法，慢慢长成世界。',
    invitation: '下一段旅程，期待与你相遇。'
  },

  channels: [
    { label: 'GitHub', detail: '代码与开源项目', handle: '@powerycy', url: 'https://github.com/powerycy' },
    { label: '小红书', detail: '创作过程与灵感', handle: '好奇的小逸', url: '' },
    { label: '🌏', detail: '联系与交流', handle: 'loonges', url: '' },
    { label: '电子邮件', detail: '合作与联系', handle: 'chaoyiyuan3721@gmail.com', url: 'mailto:chaoyiyuan3721@gmail.com' }
  ],

  projects: [
    {
      code: '作品 01 · 持续创作中',
      title: '死亡搁浅 荒野来信',
      summary: '驾驶火星车穿越荒原，恢复失联的基地，见证巨月升起与花海苏醒，最后将记录送回母港。',
      stack: ['Three.js', 'WebGL 2', '程序化地形', '电影化镜头']
    }
  ]
});
