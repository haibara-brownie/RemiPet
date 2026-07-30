'use strict';

// RemiPet 渲染器:用 spine-player 渲染蕾米,根据主进程推送的状态切换动画和气泡。

/* global spine */

const params = new URLSearchParams(location.search);
if (params.has('debug')) document.body.classList.add('debug');
// 生成图标时铺满画布,不留气泡空间
if (params.has('icon')) document.body.classList.add('icon-mode');

const bubbleEl = document.getElementById('bubble');
const bubbleTextEl = document.getElementById('bubble-text');
let bubbleTimer = null;

function setBubble(text, tone) {
  clearTimeout(bubbleTimer);
  bubbleEl.classList.remove('tone-error', 'tone-warn');
  if (!text) { bubbleEl.classList.remove('show'); return; }
  if (tone === 'error') bubbleEl.classList.add('tone-error');
  if (tone === 'warn') bubbleEl.classList.add('tone-warn');
  bubbleTextEl.textContent = text;
  bubbleEl.classList.add('show');
  // 内容被限高裁掉时打个渐隐标记
  requestAnimationFrame(() => {
    const clipped = bubbleTextEl.scrollHeight > bubbleTextEl.clientHeight + 1;
    bubbleEl.classList.toggle('clipped', clipped);
  });
}

let player = null;
let currentAnim = null;
window.__ready = false;

function setAnim(name, loop) {
  if (!player || !name || name === currentAnim) return;
  try {
    player.setAnimation(name, loop !== false);
    currentAnim = name;
  } catch (e) { console.error('setAnimation failed', name, e); }
}

window.__setAnim = (name, loop) => { currentAnim = null; setAnim(name, loop); };
window.__setBubble = setBubble;

// 调试:暂停并定格到动画的指定时间点(拆帧分析用)
window.__seek = (name, t) => {
  if (!player) return false;
  if (currentAnim !== name) { player.setAnimation(name, true); currentAnim = name; }
  player.paused = true;
  const entry = player.animationState.getCurrent(0);
  if (!entry) return false;
  entry.trackTime = t;
  player.animationState.apply(player.skeleton);
  player.skeleton.updateWorldTransform(spine.Physics.update);
  return true;
};

// 所有动画包围盒取并集,固定成全局视口:切换状态时人物不再缩放/跳位
function fitGlobalViewport(p) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const vp = {};
  for (const anim of p.skeleton.data.animations) {
    if (anim.name === 'light') continue; // 纯特效层,包围盒不算它
    p.calculateAnimationViewport(anim, vp);
    minX = Math.min(minX, vp.x); minY = Math.min(minY, vp.y);
    maxX = Math.max(maxX, vp.x + vp.width); maxY = Math.max(maxY, vp.y + vp.height);
  }
  if (!Number.isFinite(minX)) return;
  p.config.viewport = {
    x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    padLeft: '2%', padRight: '2%', padTop: '2%', padBottom: '2%',
    animations: {},
  };
}

// 素材未准备好(仓库不含素材)时给出引导,而不是白屏
if (!window.REMI_SPINE) {
  document.getElementById('player').innerHTML =
    '<div style="padding:14px;font-size:12px;line-height:1.7;color:#7a4a52;'
    + 'background:rgba(255,255,255,.94);border-radius:10px;margin:8px;-webkit-app-region:no-drag">'
    + '<b>还没有素材</b><br>1. 把 Spine 素材放进 <code>assets/spine/</code>'
    + '<br>2. 跑 <code>npm run gen-assets</code><br>详见 README「准备素材」</div>';
  window.__ready = true;
  if (window.remiAPI) window.remiAPI.rendererReady();
  throw new Error('REMI_SPINE missing: run npm run gen-assets');
}

new spine.SpinePlayer('player', {
  skeleton: window.REMI_SPINE.skeleton,
  atlas: window.REMI_SPINE.atlas,
  rawDataURIs: window.REMI_SPINE.rawDataURIs,
  animation: 'a',
  alpha: true,
  backgroundColor: '#00000000',
  showControls: false,
  showLoading: false,
  preserveDrawingBuffer: true,
  success: (p) => {
    player = p;
    window.__player = p;
    fitGlobalViewport(p);
    p.setAnimation('a', true);
    currentAnim = 'a';
    window.__ready = true;
    if (window.remiAPI) window.remiAPI.rendererReady();
  },
  error: (_p, msg) => { console.error('spine load error:', msg); },
});

// 操作按钮行:权限卡片 → 批准/拒绝(+去回复);等待回话 → 去回复
const actionsEl = document.getElementById('actions');
const btnAllow = document.getElementById('btn-allow');
const btnDeny = document.getElementById('btn-deny');
const btnFocus = document.getElementById('btn-focus');
let currentPermId = null;

function setActions(permission, canFocus) {
  currentPermId = permission ? permission.id : null;
  btnAllow.style.display = permission ? '' : 'none';
  btnDeny.style.display = permission ? '' : 'none';
  btnFocus.style.display = canFocus ? '' : 'none';
  actionsEl.classList.toggle('show', !!permission || !!canFocus);
}

btnAllow.addEventListener('click', () => { if (currentPermId && window.remiAPI) window.remiAPI.decide(currentPermId, 'allow'); });
btnDeny.addEventListener('click', () => { if (currentPermId && window.remiAPI) window.remiAPI.decide(currentPermId, 'deny'); });
btnFocus.addEventListener('click', () => { if (window.remiAPI) window.remiAPI.focus(); });

// 主进程推送:{ state, animation, bubble, tone, permission, canFocus }
if (window.remiAPI) {
  window.remiAPI.onUpdate((u) => {
    if (u.animation) setAnim(u.animation, true);
    setBubble(u.bubble || null, u.tone);
    setActions(u.permission || null, !!u.canFocus);
  });
}
