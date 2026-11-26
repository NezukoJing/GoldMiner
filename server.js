/* ============================================================================
 * 黄金矿工对抗赛 · 权威联机服务器
 * ----------------------------------------------------------------------------
 * 职责：房间管理 / 座位分配 / 唯一权威游戏状态 / 固定步长 30Hz 推进 /
 *       20Hz 快照广播 / 消息协议 / 断线托管。
 * 客户端只发输入和流程指令，不跑规则；规则全在 game-core.js（服务器这份）。
 *
 * 运行：  npm install && npm start    （默认 http://localhost:3000）
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { GameCore } = require('./game-core');
const P = require('./protocol');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { res.writeHead(400).end('bad url'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.resolve(PUBLIC, '.' + urlPath);
  // 允许 /game-core.js 与 /protocol.js 从根目录提供（与 public 里的客户端共用同一份）
  const allowRoot = ['/game-core.js', '/protocol.js'];
  const served = allowRoot.includes(urlPath) ? path.join(ROOT, urlPath) : file;
  if (!served.startsWith(PUBLIC) && !allowRoot.includes(urlPath)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(served, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(served)] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    res.end(buf);
  });
});
const io = new Server(server, { pingInterval: 20000, pingTimeout: 5000 });

/* ---------------- 房间 ---------------- */
let roomSeq = 0;
const rooms = new Map();   // code -> Room

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: P.ROOM_CODE_LEN }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

class Room {
  constructor(hostSocket, cfg, name) {
    this.code = genCode();
    this.cfg = cfg;                       // 房主选择的基础配置
    this.seats = new Array(P.MAX_PLAYERS).fill(null); // 每项 {id,name,connected}
    this.hostId = hostSocket.id;
    this.core = new GameCore(cfg);
    this.started = false;
    this.roundEndT = 0;                   // roundEnd 停留计时
    this.lastTick = Date.now();
    this.acc = 0;
    this.pendingSwap = null;              // {fromId,toId,fromSeat,toSeat} 换座申请
    this.addPlayer(hostSocket, name);
  }
  get nSeats() { return this.cfg.mode === '2v2' ? 4 : 2; }
  addPlayer(socket, name) {
    for (let i = 0; i < this.nSeats; i++) {
      if (!this.seats[i]) {
        this.seats[i] = { id: socket.id, name: (name || ('玩家' + (i + 1))).slice(0, 6), connected: true };
        socket.join(this.code);
        socket.data.room = this.code;
        socket.data.seat = i;
        return i;
      }
    }
    return -1;
  }
  seatOf(socketId) { return this.seats.findIndex(s => s && s.id === socketId); }
  isHost(socketId) { return this.hostId === socketId; }
  emptySeat() { return this.seats.findIndex((s, i) => i < this.nSeats && (!s || !s.connected)); }
  publicPlayers() {
    return this.seats.slice(0, this.nSeats).map((s, i) =>
      s ? { seat: i, name: s.name, connected: s.connected, host: s.id === this.hostId } : null);
  }
  /* ---- 换座：空座直接移动，有人座发申请，同意后交换 ---- */
  swapSeats(a, b) {
    const sa = this.seats[a], sb = this.seats[b];
    this.seats[a] = sb; this.seats[b] = sa;
    if (sa) { sa.seat = b; const s = io.sockets.sockets.get(sa.id); if (s) s.data.seat = b; }
    if (sb) { sb.seat = a; const s = io.sockets.sockets.get(sb.id); if (s) s.data.seat = a; }
  }
  tell(socketId, text) { const s = io.sockets.sockets.get(socketId); if (s) s.emit(P.MSG.EVENT, { kind: 'toast', text }); }
  requestSwap(socket, rawTarget) {
    if (this.started) { socket.emit(P.MSG.ERROR, { msg: '对局已开始，无法换座' }); return; }
    const from = this.seatOf(socket.id);
    const target = Number(rawTarget);
    if (from < 0 || !Number.isInteger(target) || target < 0 || target >= this.nSeats || target === from) return;
    if (this.pendingSwap) { socket.emit(P.MSG.ERROR, { msg: '已有换座申请处理中，请稍候' }); return; }
    const occupant = this.seats[target];
    if (!occupant || !occupant.connected) {
      // 空座（含 AI 补位）直接移动
      this.swapSeats(from, target);
      this.sendRoomAll();
      this.tell(socket.id, `已移动到座位 ${target + 1}`);
      return;
    }
    // 目标有人：发起申请
    this.pendingSwap = { fromId: socket.id, toId: occupant.id, fromSeat: from, toSeat: target };
    socket.emit(P.MSG.EVENT, { kind: 'toast', text: `已向 ${occupant.name} 发送换座申请` });
    const toSock = io.sockets.sockets.get(occupant.id);
    if (toSock) toSock.emit(P.MSG.SWAP_OFFER, { from: from, target: target, name: this.seats[from].name });
  }
  answerSwap(socketId, accept) {
    const p = this.pendingSwap;
    if (!p || socketId !== p.toId) return;
    this.pendingSwap = null;
    if (accept && this.seats[p.fromSeat] && this.seats[p.toSeat]) {
      const fromName = this.seats[p.fromSeat].name, toName = this.seats[p.toSeat].name;
      this.swapSeats(p.fromSeat, p.toSeat);
      this.sendRoomAll();
      this.tell(p.fromId, `已与 ${toName} 交换座位`);
      this.tell(p.toId, `已与 ${fromName} 交换座位`);
    } else {
      const toSock = io.sockets.sockets.get(p.fromId);
      if (toSock) toSock.emit(P.MSG.SWAP_DECLINE, {});
    }
  }
  cancelSwap(socketId) {
    if (this.pendingSwap && this.pendingSwap.fromId === socketId) this.pendingSwap = null;
  }
  clearSwapFor(socketId) {
    if (this.pendingSwap && (this.pendingSwap.fromId === socketId || this.pendingSwap.toId === socketId)) this.pendingSwap = null;
  }
  /* ---- 踢人：仅房主、未开局、非自己、目标座位有人（含掉线玩家） ---- */
  kickPlayer(socket, rawTarget) {
    if (this.started) { socket.emit(P.MSG.ERROR, { msg: '对局已开始，无法踢人' }); return; }
    if (!this.isHost(socket.id)) { socket.emit(P.MSG.ERROR, { msg: '仅房主可踢人' }); return; }
    const target = Number(rawTarget);
    const from = this.seatOf(socket.id);
    if (!Number.isInteger(target) || target < 0 || target >= this.nSeats) {
      socket.emit(P.MSG.ERROR, { msg: '无效的座位' }); return;
    }
    if (target === from) { socket.emit(P.MSG.ERROR, { msg: '不能踢出自己' }); return; }
    const victim = this.seats[target];
    // 空座（从未有人）不允许踢；但掉线但座位上仍挂着的玩家允许房主清除
    if (!victim) { socket.emit(P.MSG.ERROR, { msg: '该座位是空的' }); return; }
    // 清掉可能涉及的换座申请
    this.clearSwapFor(victim.id);
    // 通知被踢者：在线才发 KICKED 并强制退房间；掉线的 socket 已不在，直接清座位
    const victimSock = io.sockets.sockets.get(victim.id);
    if (victimSock && victimSock.connected) {
      victimSock.emit(P.MSG.KICKED, { by: this.seats[from] ? this.seats[from].name : '房主' });
      victimSock.leave(this.code);
      victimSock.data.room = null;
      victimSock.data.seat = undefined;
    }
    // 从座位移除（无论在线/掉线，都真正空出座位）
    const victimName = victim.name;
    this.seats[target] = null;
    this.tell(socket.id, `已将 ${victimName} 移出房间`);
    this.sendRoomAll();
    console.log(`[房间] ${this.code} 房主踢出座位${target} ${victimName}${victim.connected ? '' : '(掉线)'}`);
  }
  roomMsg(socketId) {
    return {
      code: this.code, seat: this.seatOf(socketId), isHost: this.isHost(socketId),
      players: this.publicPlayers(), cfg: this.cfg,
      phase: this.started ? this.core.G.phase : 'setup',
      started: this.started
    };
  }
  // 房主更新房间配置（仅未开始前）：合并 counts 等关键项，然后广播
  setCfg(socketId, patch) {
    if (this.started || !this.isHost(socketId) || !patch) return false;
    const c = patch.cfg || patch;
    if (c.counts && typeof c.counts === 'object') {
      const clean = {};
      const valid = ['none', 'few', 'normal', 'many'];
      for (const t of Object.keys(require('./game-core').DEF)) {
        if (valid.includes(c.counts[t])) clean[t] = c.counts[t];
      }
      this.cfg.counts = clean;
    }
    if (['1v1', '2v2'].includes(c.mode) && !this.started) this.cfg.mode = c.mode;
    if ([5, 7, 9, 11, 13, 15].includes(+c.rounds)) this.cfg.rounds = +c.rounds;
    if ([30, 45, 60].includes(+c.roundTime)) this.cfg.roundTime = +c.roundTime;
    if (typeof c.seed === 'string') this.cfg.seed = c.seed.slice(0, 24);
    if (typeof c.early === 'boolean') this.cfg.early = c.early;
    if (['round', 'total'].includes(c.scoreMode)) this.cfg.scoreMode = c.scoreMode;
    this.sendRoomAll();
    return true;
  }
  broadcastRoom() { io.to(this.code).emit(P.MSG.ROOM, { type: 'update' }); this.sendRoomAll(); }
  sendRoomAll() {
    for (const s of this.seats) if (s && s.connected) {
      const sock = io.sockets.sockets.get(s.id);
      if (sock) sock.emit(P.MSG.ROOM, this.roomMsg(s.id));
    }
  }
  // 把真人座位写进 core 的 cfg，其余用 AI 补位；然后开局
  start() {
    const cfg = JSON.parse(JSON.stringify(this.cfg));
    const is2 = cfg.mode === '2v2';
    const names = is2 ? [cfg.red[0].name, cfg.blue[0].name, cfg.red[1].name, cfg.blue[1].name]
                      : [cfg.red[0].name, cfg.blue[0].name];
    const ctrl = is2
      ? [cfg.red[0].ctrl, cfg.blue[0].ctrl, cfg.red[1].ctrl, cfg.blue[1].ctrl]
      : [cfg.red[0].ctrl, cfg.blue[0].ctrl];
    // 真人座位强制 human 并写入名字；空座位/断线座位用 AI 补位
    for (let i = 0; i < this.nSeats; i++) {
      const s = this.seats[i];
      if (s && s.connected) { ctrl[i] = 'human'; names[i] = s.name; }
      else ctrl[i] = 'ai-normal';
    }
    if (is2) {
      cfg.red[0] = { name: names[0], ctrl: ctrl[0] };
      cfg.blue[0] = { name: names[1], ctrl: ctrl[1] };
      cfg.red[1] = { name: names[2], ctrl: ctrl[2] };
      cfg.blue[1] = { name: names[3], ctrl: ctrl[3] };
    } else {
      cfg.red[0] = { name: names[0], ctrl: ctrl[0] };
      cfg.blue[0] = { name: names[1], ctrl: ctrl[1] };
    }
    this.core = new GameCore(cfg);
    const seedId = this.core.startMatch();
    this.started = true;
    this.roundEndT = 0;
    io.to(this.code).emit(P.MSG.STARTED, { seedId, cfg });
    this.sendRoomAll();
    this.broadcastState();
  }
  // 断线托管：把该座位玩家改为普通 AI，避免流程卡住
  handleDisconnect(socketId) {
    this.clearSwapFor(socketId);
    const seat = this.seatOf(socketId);
    if (seat < 0) return;
    const s = this.seats[seat];
    s.connected = false;
    if (this.started && this.core.G.players[seat]) {
      const p = this.core.G.players[seat];
      p.isAI = true; p.lvl = 'normal'; p.ai = { best: 0, reco: 0, fireAt: null, bombAt: null, bombDecided: false };
      p.hook.state = 'swing'; p.stickFlying = false;
      io.to(this.code).emit(P.MSG.EVENT, { kind: 'toast', text: `${s.name} 掉线，已由电脑接管` });
    }
    // 房主转移给第一个还在线的座位
    if (this.hostId === socketId) {
      const next = this.seats.findIndex(x => x && x.connected);
      this.hostId = next >= 0 ? this.seats[next].id : socketId;
    }
    this.sendRoomAll();
  }
  destroy() { rooms.delete(this.code); }

  /* ---- 固定步长推进 ---- */
  tick(now) {
    if (!this.started) return;
    const G = this.core.G;
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (dt > .25) dt = .25;                 // 防止后台标签页回来后一次跳太多
    this.acc += dt;
    const STEP = 1 / P.TICK_HZ;
    let steps = 0;
    while (this.acc >= STEP && steps < 8) {
      this.stepLogic(STEP);
      this.acc -= STEP; steps++;
    }
  }
  stepLogic(dt) {
    const G = this.core.G;
    if (G.phase === 'roundEnd') {
      // 展示 1.2 秒横幅后进结果页
      this.core.update(dt);
      this.roundEndT += dt;
      if (this.roundEndT >= 1.2) { this.roundEndT = 0; this.core.toResult(); }
      return;
    }
    if (G.phase === 'shop') {
      // 商店：所有玩家同时出钩抢购，权威推进钩爪物理 + 倒计时
      this.core.update(dt);
      return;
    }
    if (G.phase === 'result' || G.phase === 'final') {
      // 非对局阶段：只推进展示动画（钩子摆动、粒子由客户端本地跑），不推进物理
      return;
    }
    this.core.update(dt);
  }
  broadcastState() {
    if (!this.started) return;
    const snap = this.core.serialize();
    const fx = this.core.drainFx();
    io.to(this.code).emit(P.MSG.STATE, { s: snap, fx, serverT: Date.now() });
  }
  // ---- 消息处理 ----
  onInput(socket, msg) {
    if (!this.started) return;
    const G = this.core.G;
    if (G.phase !== 'play' && G.phase !== 'shop') return;
    if (G.phase === 'shop' && this.core.shopDone()) return;
    const seat = this.seatOf(socket.id);
    if (seat < 0 || !G.players[seat]) return;
    const p = G.players[seat];
    if (p.isAI) return;
    if (msg.act === 'fire') this.core.fire(p);
    else if (msg.act === 'bomb') this.core.bomb(p);
  }
  onFlow(socket, msg) {
    if (!this.started) return;
    const G = this.core.G;
    const seat = this.seatOf(socket.id);
    const host = this.isHost(socket.id);
    const act = msg.act;
    if (!host) { socket.emit(P.MSG.ERROR, { msg: '仅房主可推进流程' }); return; }
    if (act === P.FLOW.TO_SHOP && G.phase === 'result' && !this.core.matchOver()) {
      this.core.openShop();
    } else if (act === P.FLOW.TO_FINAL && G.phase === 'result' && this.core.matchOver()) {
      this.core.toFinal();
    } else if (act === P.FLOW.NEXT_ROUND && G.phase === 'shop') {
      if (!this.core.shopDone()) { socket.emit(P.MSG.ERROR, { msg: '抢购进行中，请等待倒计时结束或商品售罄' }); return; }
      this.core.startRound();
    } else if (act === P.FLOW.AGAIN && G.phase === 'final') {
      this.core.startMatch();
    } else if (act === P.FLOW.BACK && G.phase === 'final') {
      this.core.backToSetup(); this.started = false;
      this.sendRoomAll();
      return;
    } else return;
    this.broadcastState();
  }
}

/* ---------------- 连接事件 ---------------- */
io.on('connection', socket => {
  socket.on(P.MSG.CREATE, msg => {
    if (socket.data.room) return;
    const cfg = normalizeCfg(msg && msg.cfg);
    const room = new Room(socket, cfg, msg && msg.name);
    rooms.set(room.code, room);
    socket.emit(P.MSG.ROOM, room.roomMsg(socket.id));
    console.log(`[房间] ${room.code} 创建 by ${socket.data.seat !== undefined ? room.seats[0].name : '?'}`);
  });
  socket.on(P.MSG.JOIN, msg => {
    if (socket.data.room) return;
    const code = String((msg && msg.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { socket.emit(P.MSG.ERROR, { msg: '房间不存在或已结束' }); return; }
    if (room.started) { socket.emit(P.MSG.ERROR, { msg: '对局已开始，无法加入' }); return; }
    if (room.emptySeat() < 0) { socket.emit(P.MSG.ERROR, { msg: '房间已满' }); return; }
    const seat = room.addPlayer(socket, msg && msg.name);
    if (seat < 0) { socket.emit(P.MSG.ERROR, { msg: '房间已满' }); return; }
    socket.emit(P.MSG.ROOM, room.roomMsg(socket.id));
    room.sendRoomAll();
    console.log(`[房间] ${code} 座位${seat} 加入 ${room.seats[seat].name}`);
  });
  socket.on(P.MSG.START, () => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.isHost(socket.id) || room.started) return;
    const need = room.nSeats;
    const ready = room.seats.slice(0, need).filter(s => s && s.connected).length;
    if (ready < 2) { socket.emit(P.MSG.ERROR, { msg: '至少需要 2 名玩家' }); return; }
    room.start();
    console.log(`[房间] ${room.code} 开始 ${room.cfg.mode}`);
  });
  socket.on(P.MSG.SET_CFG, msg => {
    const r = rooms.get(socket.data.room);
    if (!r || !r.isHost(socket.id)) { socket.emit(P.MSG.ERROR, { msg: '仅房主可调整配置' }); return; }
    if (r.started) { socket.emit(P.MSG.ERROR, { msg: '对局已开始，配置已锁定' }); return; }
    r.setCfg(socket.id, msg || {});
  });
  socket.on(P.MSG.SWAP_REQ, msg => {
    const r = rooms.get(socket.data.room);
    if (r) r.requestSwap(socket, msg && msg.target);
  });
  socket.on(P.MSG.SWAP_ANS, msg => {
    const r = rooms.get(socket.data.room);
    if (r) r.answerSwap(socket.id, !!(msg && msg.accept));
  });
  socket.on(P.MSG.SWAP_CANCEL, () => {
    const r = rooms.get(socket.data.room);
    if (r) r.cancelSwap(socket.id);
  });
  socket.on(P.MSG.KICK, msg => {
    const r = rooms.get(socket.data.room);
    if (r) r.kickPlayer(socket, msg && msg.target);
  });
  socket.on(P.MSG.INPUT, msg => { const r = rooms.get(socket.data.room); if (r) r.onInput(socket, msg || {}); });
  socket.on(P.MSG.FLOW, msg => { const r = rooms.get(socket.data.room); if (r) r.onFlow(socket, msg || {}); });
  socket.on(P.MSG.PING, () => socket.emit(P.MSG.PONG, { t: Date.now() }));
  socket.on(P.MSG.LEAVE, () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

function leave(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.room = null;
  if (!room) return;
  room.handleDisconnect(socket.id);
  if (room.seats.every(s => !s || !s.connected)) room.destroy();
}

/* ---------------- 配置清洗 ---------------- */
function normalizeCfg(c) {
  c = c || {};
  const mode = c.mode === '2v2' ? '2v2' : '1v1';
  const rounds = [5, 7, 9, 11, 13, 15].includes(+c.rounds) ? +c.rounds : 7;
  const roundTime = [30, 45, 60].includes(+c.roundTime) ? +c.roundTime : 60;
  const seed = typeof c.seed === 'string' ? c.seed.slice(0, 24) : '';
  const early = !!c.early;
  const scoreMode = ['round', 'total'].includes(c.scoreMode) ? c.scoreMode : 'round';
  const counts = {};
  for (const t of Object.keys(require('./game-core').ITEM_TYPES.reduce((o, x) => (o[x] = 1, o), {}))) {
    if (['none', 'few', 'normal', 'many'].includes(c.counts && c.counts[t])) counts[t] = c.counts[t];
  }
  const nm = (arr, i, def) => (c[arr] && c[arr][i] && String(c[arr][i].name || '').slice(0, 6)) || def;
  return {
    mode, rounds, roundTime, seed, early, scoreMode, counts,
    red: [{ name: nm('red', 0, '红1'), ctrl: 'human' }, { name: nm('red', 1, '红2'), ctrl: 'ai-normal' }],
    blue: [{ name: nm('blue', 0, '蓝1'), ctrl: 'ai-normal' }, { name: nm('blue', 1, '蓝2'), ctrl: 'ai-normal' }]
  };
}

/* ---------------- 主循环 ---------------- */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) room.tick(now);
}, 1000 / P.TICK_HZ);
setInterval(() => { for (const room of rooms.values()) room.broadcastState(); }, 1000 / P.SNAPSHOT_HZ);

server.listen(PORT, () => {
  console.log(`黄金矿工联机服务器已启动： http://localhost:${PORT}`);
  console.log(`协议 ${P.TICK_HZ}Hz 逻辑 / ${P.SNAPSHOT_HZ}Hz 快照`);
});
