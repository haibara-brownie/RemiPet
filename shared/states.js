'use strict';

// 状态词汇表:后端聚合、hook 映射、渲染动画映射的唯一事实源。

// 多会话聚合时的优先级,高者胜出
const STATE_PRIORITY = {
  error: 7,
  waiting: 6,     // Notification:等授权 / 等回复,必须持续展示直到下一个事件
  working: 5,     // 工具调用中
  compacting: 4,  // 压缩上下文
  thinking: 3,    // 收到提示词,酝酿中
  done: 2,        // 刚完成(短暂庆祝)
  idle: 1,
  sleeping: 0,
};

const VALID_STATES = Object.keys(STATE_PRIORITY);

// 一次性状态的存活时间,到期回落 idle
const ONESHOT_TTL_MS = { done: 12000, error: 45000 };

// 忙碌状态兜底:长时间无后续事件(比如用户 Esc 打断,不会有 Stop)则回落 idle
const BUSY_STATES = ['thinking', 'working', 'compacting'];
const BUSY_TTL_MS = 10 * 60 * 1000;

// 全局空闲多久后进入打瞌睡
const SLEEPY_AFTER_MS = 10 * 60 * 1000;

// 状态 → Spine 动画(数组则随机挑一个)
// 动画语义(逐帧核实,见 /tmp/remi_frames):
//   0=静止看书  a=安静看书(呼吸感)  a_win=执笔抵嘴微笑回味
//   b=低头执笔慢写/记录  c=闭眼把书凑近脸陶醉  d=挥笔狂写冒汗(赶稿)
//   d_win=狂写→停笔得意一笑  e=执笔悬停沉思  light=发光特效层(叠加)
const STATE_ANIM = {
  idle: ['a'],
  thinking: ['e'],     // 酝酿/组织语言:执笔沉思
  working: ['b'],      // 默认;实际按工具类型选,见 toolAnim()
  compacting: ['b'],   // 整理笔记
  waiting: ['a'],      // 安静等你,靠气泡提醒
  done: ['c'],         // 陶醉欣赏成品(渲染层叠 light 发光)
  error: ['d'],        // 手忙脚乱冒汗 + 红色气泡
  sleeping: ['0'],
};

// 写/执行类工具=狂写 d,读/搜类=边看边记 b
// (前半是 Claude Code 工具名,后半是 Codex 工具名,两边不冲突,共用一张表)
const WRITE_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'TodoWrite', 'TaskCreate', 'TaskUpdate',
  'exec', 'exec_command', 'write_stdin', 'apply_patch', 'js',
]);
function toolAnim(toolName) { return WRITE_TOOLS.has(toolName) ? 'd' : 'b'; }

// 状态 → 气泡文案(null 表示不显示气泡)
const STATE_BUBBLE = {
  idle: null,
  sleeping: null,
  thinking: ['唔姆…怎么写比较好', '本小姐酝酿中,稍安勿躁', '嗯哼,有点意思…'],
  compacting: ['整理一下记忆…', '上下文太乱了,收拾收拾'],
  done: ['哼哼,完工了哦☆', '搞定!快来夸夸本小姐', '写完了!快来验收~'],
  error: ['呜哇,出错了…', '不、不是本小姐的错!'],
  waiting: ['喂—!在等你回复哦!', '快看看,需要你点头!'],
};

// 提示词情绪 → 蕾米的反应(顶掉本轮 thinking 气泡)
const EMOTION_BUBBLE = {
  praise: ['嘿嘿…被夸了☆', '哼哼,本小姐当然厉害'],
  thanks: ['小事一桩,不用谢~', '为你效劳是本小姐的荣幸'],
  scold: ['呜…对不起嘛', '这、这次一定好好写!'],
};
const EMOTION_ANIM = { praise: 'c', thanks: 'a_win', scold: 'd' };

// API 错误类型中文化
const ERROR_ZH = {
  rate_limit: '限流了',
  rate_limit_error: '限流了',
  overloaded_error: 'API 过载',
  server_error: '服务端出错',
  billing_error: '账单问题',
  authentication_failed: '认证失败',
  api_error: 'API 出错',
};
function errorLabel(t) { return ERROR_ZH[t] || t; }

// 工具名 → 干活文案
const TOOL_LABEL = {
  Bash: '在敲命令',
  Read: '在翻文件',
  Edit: '在改代码', Write: '在写代码', MultiEdit: '在改代码', NotebookEdit: '在改代码',
  Grep: '在翻箱倒柜', Glob: '在翻箱倒柜',
  Task: '召唤了小弟干活', Agent: '召唤了小弟干活',
  WebFetch: '在上网冲浪', WebSearch: '在上网冲浪',
  TodoWrite: '在列清单', TaskCreate: '在列清单', TaskUpdate: '在列清单',
  // Codex(CLI / ChatGPT App)工具名
  exec: '在敲命令', exec_command: '在敲命令', write_stdin: '在敲命令',
  apply_patch: '在改代码', js: '在跑脚本',
  update_plan: '在列清单', view_image: '在看图', web_search: '在上网冲浪',
  spawn_agent: '召唤了小弟干活', wait_agent: '在等小弟干完活', send_message: '在给小弟传话',
};

function toolBubble(toolName) {
  if (!toolName) return '唔姆…处理中';
  const label = TOOL_LABEL[toolName] || `在用 ${toolName}`;
  // 狂写类配"唰唰唰",翻资料类配"唔姆"
  return WRITE_TOOLS.has(toolName) ? `唰唰唰…${label}` : `唔姆…${label}`;
}

function pick(arr) { return Array.isArray(arr) ? arr[Math.floor(Math.random() * arr.length)] : arr; }

// 提示词情绪嗅探:夸奖 / 道谢 / 责备(Claude hook 与 Codex 适配器共用)
function detectEmotion(prompt) {
  if (typeof prompt !== 'string' || !prompt || prompt.length > 2000) return null;
  if (/(谢谢|辛苦了|thank|thx)/i.test(prompt)) return 'thanks';
  if (/(好棒|真棒|厉害|太强|干得好|优雅|完美|nb|牛逼|牛啊|爱你|(?:^|\s)666|good job|awesome|perfect|well done|great work)/i.test(prompt)) return 'praise';
  if (/(笨蛋|太蠢|垃圾|什么玩意|搞什么|气死|无语)/i.test(prompt)) return 'scold';
  return null;
}

module.exports = {
  STATE_PRIORITY, VALID_STATES, ONESHOT_TTL_MS,
  BUSY_STATES, BUSY_TTL_MS, SLEEPY_AFTER_MS,
  STATE_ANIM, STATE_BUBBLE, EMOTION_BUBBLE, EMOTION_ANIM,
  toolBubble, toolAnim, errorLabel, pick, detectEmotion,
};
