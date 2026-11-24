/* 黄金矿工对抗赛 · 联机消息协议（前后端共用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PROTO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MSG = {
    // 客户端 -> 服务器
    CREATE: 'create',       // {cfg, name} 创建房间
    JOIN: 'join',           // {code, name} 加入房间
    LEAVE: 'leave',         // 离开房间
    SET_CFG: 'setCfg',      // {cfg} 房主更新配置（含物品数量档位），仅未开始有效
    START: 'start',         // 房主开始对局
    INPUT: 'input',         // {act:'fire'|'bomb'} 玩家操作
    FLOW: 'flow',           // {act, i?} 流程推进（见 FLOW）
    PING: 'ping',
    // 服务器 -> 客户端
    ROOM: 'room',           // {code, seat, isHost, players[], cfg, phase}
    STARTED: 'started',     // {seedId, cfg}
    STATE: 'state',         // 权威快照（见 game-core.serialize）
    EVENT: 'event',         // 一次性事件 {kind, ...}（如 toast）
    ERROR: 'error',         // {msg}
    PONG: 'pong'
  };

  // FLOW.act 取值
  const FLOW = {
    TO_SHOP: 'toShop',        // 结果页 -> 商店（房主）
    BUY: 'buy',               // 商店购买 {i}
    SKIP: 'skip',             // 商店跳过
    NEXT_ROUND: 'nextRound',  // 商店 -> 下一轮（房主）
    TO_FINAL: 'toFinal',      // 结果页 -> 最终结算（房主，比赛结束）
    AGAIN: 'again',           // 最终页 -> 再来一局（房主）
    BACK: 'back'              // 最终页 -> 回到大厅（房主）
  };

  // 快照 phase 取值（与 game-core 内部一致）
  const PHASE = {
    SETUP: 'setup',
    COUNTDOWN: 'countdown',
    PLAY: 'play',
    ROUND_END: 'roundEnd',
    RESULT: 'result',
    SHOP: 'shop',
    FINAL: 'final'
  };

  return {
    MSG, FLOW, PHASE,
    TICK_HZ: 30,                 // 服务器权威步长
    SNAPSHOT_HZ: 20,             // 快照广播频率
    INTERP_DELAY_MS: 100,        // 客户端插值缓冲（约 2~3 个快照）
    ROOM_CODE_LEN: 4,
    MAX_PLAYERS: 4
  };
});
