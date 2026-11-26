/* ============================================================================
 * 黄金矿工对抗赛 · 纯逻辑核心（game-core.js）
 * ----------------------------------------------------------------------------
 * 由单机版 HTML 的游戏逻辑抽出，去掉所有 DOM / Canvas / 音频 / UI 依赖。
 * 服务器与客户端共用同一份文件（UMD），保证规则完全一致：
 *   - 服务器：require('./game-core')，跑权威 update(dt) + fire/bomb + 流程
 *   - 客户端：<script src="/game-core.js">，仅用于渲染所需常量（可选）
 *
 * 静电/音效/粒子等表现层通过 this.fx 事件队列输出，由外层（客户端）消费：
 *   {t:'sfx', k:'coin', v:300} / {t:'boom',x,y,R} / {t:'debris',...} /
 *   {t:'float',...} / {t:'sparkle',...} / {t:'banner',...}
 * 服务器在每个 tick 末尾 drainFx() 后丢掉，客户端不跑本文件。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================= 常量 ================= */
  const W = 1280, H = 720, GROUND = 160, TOPBAR = 44;
  const DEG = Math.PI / 180, MAXA = 75 * DEG, SWING_SPEED = 65 * DEG,
    EXT_SPEED = 420, PULL_BASE = 300, RET_EMPTY = 420, MAX_LEN = 1240,
    SHOW_TIME = 1, L0 = 26, HOOK_R = 8, POWER_MUL = 1.5,
    SHOP_END_DELAY = 1.4, SHOP_RET_MUL = 2;
  const TEAM = [{ name: '红队', c: '#e5484d' }, { name: '蓝队', c: '#3b82f6' }];
  const KEYS1 = [{ fire: 'KeyS', bomb: 'KeyW' }, { fire: 'ArrowDown', bomb: 'ArrowUp' }];
  const KEYS2 = [{ fire: 'KeyS', bomb: 'KeyW' }, { fire: 'KeyG', bomb: 'KeyT' },
                 { fire: 'KeyK', bomb: 'KeyI' }, { fire: 'ArrowDown', bomb: 'ArrowUp' }];
  const DEF = {
    gold_s: { n: '小金块', r: 13, v: 50, w: 2 },
    gold_m: { n: '中金块', r: 21, v: 100, w: 3.5 },
    gold_l: { n: '大金块', r: 33, v: 250, w: 5 },
    gold_xl: { n: '巨型金块', r: 47, v: 500, w: 7 },
    diamond: { n: '钻石', r: 11, v: 600, w: 1.5 },
    rock_s: { n: '小石头', r: 18, v: 11, w: 5.5 },
    rock_l: { n: '大石头', r: 30, v: 20, w: 7 },
    bone: { n: '骨头', r: 14, v: 7, w: 3 },
    skull: { n: '骷髅', r: 15, v: 20, w: 2 },
    bag: { n: '神秘袋', r: 16, v: 0, w: 5 },
    mouse: { n: '老鼠', r: 14, v: 2, w: 1.5, move: 1 },
    pig: { n: '钻石鼠', r: 17, v: 602, w: 1.5, move: 1 },
    tnt: { n: 'TNT', r: 18, v: 0, w: 1 }
  };
  const SHOP = {
    dynamite: { n: '炸药', p: [40, 120], wt: 3 },
    power: { n: '力量药水', p: [120, 380], wt: 2 },
    luck: { n: '幸运草', p: [60, 220], wt: 1.6 },
    rock: { n: '石头收藏书', p: [20, 90], wt: 1.1 },
    polish: { n: '钻石抛光剂', p: [180, 450], wt: 1.5 }
  };
  const AI_CFG = {
    easy: { n: '简单', thr: .4, react: [.1, .35], bomb: .3, miss: .25 },
    normal: { n: '普通', thr: .72, react: [.03, .12], bomb: .8, miss: .07 },
    hard: { n: '困难', thr: .9, react: [0, .03], bomb: 1, miss: 0 }
  };
  const ITEM_TYPES = ['gold_s', 'gold_m', 'gold_l', 'gold_xl', 'diamond',
    'rock_s', 'rock_l', 'bone', 'skull', 'bag', 'mouse', 'pig', 'tnt'];
  const QTY_LEVELS = ['none', 'few', 'normal', 'many'];
  /* 特殊关卡：每轮按总触发率掷出，命中后用关卡专属物品池覆盖默认矿区 */
  const SPECIALS = [
    { id: 'pigHunt',     name: '抓猪大队',   desc: '满屏会跑的猪和钻石猪，拼的就是预判与手速',   pool: ['mouse', 'pig'] },
    { id: 'goldRush',    name: '纯金时代',   desc: '只有金块，重温最纯粹的淘金快感',             pool: ['gold_s', 'gold_m', 'gold_l', 'gold_xl'] },
    { id: 'diamondStorm',name: '钻石风暴',   desc: '钻石与巨型金块满场，一夜暴富或一无所获',     pool: ['diamond', 'gold_xl'] },
    { id: 'noBomb',      name: '炸药禁令',   desc: '全场没有 TNT，物品更密集，纯拼钩爪路线规划', pool: null, dense: true },
    { id: 'blindBox',    name: '神秘盲盒',   desc: '全是神秘袋，开什么全看手气',                 pool: ['bag'] },
    { id: 'ratPlague',   name: '鼠患危机',   desc: '老鼠乱窜、TNT 密布、神秘袋混杂，最混乱一局', pool: ['mouse', 'tnt', 'bag'] }
  ];
  const SPECIAL_RATE = 0.5; // 特殊关卡整体触发率
  const DEFAULT_CFG = {
    mode: '1v1', rounds: 7, roundTime: 60, early: false, seed: '', counts: {}, scoreMode: 'round',
    red: [{ name: '红1', ctrl: 'human' }, { name: '红2', ctrl: 'ai-normal' }],
    blue: [{ name: '蓝1', ctrl: 'ai-normal' }, { name: '蓝2', ctrl: 'ai-normal' }]
  };

  /* ================= 工具 ================= */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(rnd(a, b + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sum = a => a.reduce((x, y) => x + y, 0);
  const clone = o => JSON.parse(JSON.stringify(o));
  function seeded(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
  function hashSeed(str) {
    if (!str) return (Math.random() * 2147483646 | 0) + 1;
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 2147483646 + 1;
  }

  /* ================= 游戏核心类 ================= */
  class GameCore {
    constructor(cfg) {
      this.cfg = clone(Object.assign(clone(DEFAULT_CFG), cfg || {}));
      this.events = [];          // 表现层事件队列（音效/粒子/飘字）
      this.SR = Math.random;     // 矿区生成专用随机流
      this.shopToken = 0;
      this.itemSeq = 1;          // 物品唯一 id（用于网络引用）
      this.G = this._blankState();
    }

    _blankState() {
      return {
        phase: 'setup', round: 0, players: [], items: [], time: 0,
        points: [0, 0], history: [], timeLeft: 0, countdown: 0,
        shake: 0, banner: null, goFlash: 0, emptyT: 0, seedId: '',
        clearEarly: 0, cfg: this.cfg, shop: null, matchWinner: -2,
        special: null  // 本轮特殊关卡 {id,name,desc}，普通轮次为 null
      };
    }

    /* ---------- 随机流 ---------- */
    setSeedForRound(seedStr, round) {
      this.SR = seeded(((hashSeed(seedStr) ^ Math.imul(round + 1, 0x9E3779B1)) >>> 0) % 2147483646 + 1);
    }
    srnd(a, b) { return a + this.SR() * (b - a); }
    sri(a, b) { return Math.floor(this.srnd(a, b + 1)); }

    /* ---------- 表现事件 ---------- */
    fx(kind, data) { this.events.push(Object.assign({ t: kind }, data || {})); }
    drainFx() { const e = this.events; this.events = []; return e; }

    /* ---------- 玩家 ---------- */
    makePlayer(idx, name, team, x, ctrl, keys) {
      const isAI = ctrl !== 'human';
      return {
        idx, name, team, x, py: GROUND - 14, isAI, lvl: isAI ? ctrl.split('-')[1] : null, keys,
        wallet: 0, dynamite: 1, buffs: {}, nextBuffs: {}, strength: 1,
        roundValues: [], cur: 0, stickFlying: false,
        hook: { state: 'swing', dir: 1, ang: 0, len: L0, item: null, burnt: 0, showT: 0 },
        ai: { best: 0, reco: 0, fireAt: null, bombAt: null, bombDecided: false }, reel: 0
      };
    }
    buildPlayers() {
      const cfg = this.cfg;
      if (cfg.mode === '1v1') {
        return [this.makePlayer(0, cfg.red[0].name, 0, Math.round(W / 3), cfg.red[0].ctrl, KEYS1[0]),
                this.makePlayer(1, cfg.blue[0].name, 1, Math.round(W * 2 / 3), cfg.blue[0].ctrl, KEYS1[1])];
      }
      const xs = [256, 512, 768, 1024];
      return [this.makePlayer(0, cfg.red[0].name, 0, xs[0], cfg.red[0].ctrl, KEYS2[0]),
              this.makePlayer(1, cfg.blue[0].name, 1, xs[1], cfg.blue[0].ctrl, KEYS2[1]),
              this.makePlayer(2, cfg.red[1].name, 0, xs[2], cfg.red[1].ctrl, KEYS2[2]),
              this.makePlayer(3, cfg.blue[1].name, 1, xs[3], cfg.blue[1].ctrl, KEYS2[3])];
    }
    resetHooks() {
      const ps = this.G.players, n = ps.length;
      for (let i = 0; i < n / 2; i++) {
        const a = this.srnd(-MAXA, MAXA), d = this.SR() < .5 ? -1 : 1;
        Object.assign(ps[i].hook, { state: 'swing', ang: a, dir: d, len: L0, item: null, burnt: 0, showT: 0 });
        Object.assign(ps[n - 1 - i].hook, { state: 'swing', ang: -a, dir: -d, len: L0, item: null, burnt: 0, showT: 0 });
      }
      ps.forEach(p => { p.ai = { best: 0, reco: 0, fireAt: null, bombAt: null, bombDecided: false }; p.stickFlying = false; });
    }

    /* ---------- 矿区生成 ---------- */
    yRange(t) {
      switch (t) {
        case 'diamond': case 'gold_xl': case 'pig': return [430, 690];
        case 'gold_l': return [360, 670];
        case 'gold_s': case 'bone': return [215, 560];
        case 'tnt': return [300, 660];
        default: return [230, 680];
      }
    }
    makeItem(t, x, y, side) {
      const d = DEF[t];
      const it = {
        id: this.itemSeq++, t, x, y, r: d.r, w: d.w,
        rot: this.srnd(-.5, .5), ph: this.srnd(0, 6.28),
        taken: false, gone: false, fuse: 0
      };
      if (t.startsWith('gold') || t.startsWith('rock')) {
        const n = t.startsWith('gold') ? 9 : 8; it.shape = [];
        for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, q = this.srnd(.78, 1.05); it.shape.push([Math.cos(a) * q, Math.sin(a) * q]); }
      }
      if (t === 'bag') { it.w = this.sri(1, 9); it.bagV = 50 * this.sri(1, 16); it.bagRoll = this.SR(); it.bagFx = this.SR() < .2 ? 'dyn' : 'str'; }
      if (d.move) {
        it.x0 = x;
        const lo = side === 'R' ? W / 2 + 8 : 8, hi = side === 'R' ? W - 8 : W / 2 - 8;
        it.range = Math.max(15, Math.min(this.srnd(45, 120), x - d.r - 8 - lo, hi - d.r - 8 - x));
        if (it.range < 15) it.range = Math.max(15, Math.min(40, Math.min(x - d.r - 8 - lo, hi - d.r - 8 - x)));
        it.vx = (this.SR() < .5 ? -1 : 1) * this.srnd(35, 60);
      }
      return it;
    }
    place(t, list, side) {
      const d = DEF[t], [y0, y1] = this.yRange(t);
      const xMin = side === 'R' ? W / 2 + d.r + 8 : d.r + 16;
      const xMax = side === 'R' ? W - d.r - 16 : W / 2 - d.r - 8;
      for (let a = 0; a < 160; a++) {
        const x = this.srnd(xMin, xMax);
        const y = this.srnd(Math.max(y0, GROUND + 50 + d.r), Math.min(y1, H - d.r - 6));
        let ok = true;
        for (const o of list) { const m = d.r + o.r + 10; if (Math.hypot(o.x - x, o.y - y) < m) { ok = false; break; } }
        if (ok) return this.makeItem(t, x, y, side);
      }
      return null;
    }
    qtyLevel(t) { return (this.G.cfg && this.G.cfg.counts && this.G.cfg.counts[t]) || 'normal'; }
    applyQty(t, base, R) {
      const lv = this.qtyLevel(t);
      if (lv === 'none') return 0;
      if (lv === 'normal') return base;
      if (lv === 'few') {
        if (base <= 0) return this.SR() < .5 ? 0 : (R >= 4 ? 1 : 0);
        let q = Math.floor(base * .5);
        if (this.SR() < .5) q++;
        return Math.max(base > 0 ? 1 : 0, q);
      }
      if (lv === 'many') {
        let q = base + 1 + (base >= 2 ? 1 : 0);
        if (this.SR() < .5) q++;
        return q;
      }
      return base;
    }
    /* 特殊关卡专属数量表：无视玩家档位、池外不生成、走种子流可复现 */
    specialCounts(id, R) {
      const ri = (a, b) => this.sri(a, b);
      switch (id) {
        case 'pigHunt': return { mouse: 4 + ri(0, 2), pig: 3 + ri(0, 2) };
        case 'goldRush': return { gold_s: 3, gold_m: 3, gold_l: 2, gold_xl: 1 + (this.SR() < .5 ? 1 : 0) };
        case 'diamondStorm': return { diamond: 6 + ri(0, 2), gold_xl: 2 + ri(0, 1) };
        case 'blindBox': return { bag: 10 + ri(0, 4) };
        case 'ratPlague': return { mouse: 4 + ri(0, 1), tnt: 3, bag: 4 + ri(0, 1) };
        case 'noBomb': { // 默认矿区去掉 TNT，密度 ×1.35
          const base = {
            gold_s: 2 + ri(0, 1), gold_m: 2, gold_l: 1 + (R >= 2 && this.SR() < .5 ? 1 : 0),
            gold_xl: this.SR() < .3 + R * .06 ? 1 : 0,
            diamond: (this.SR() < .65 ? 1 : 0) + (R >= 3 ? ri(0, 1) : 0),
            rock_s: 2 + ri(0, 1), rock_l: 1 + ri(0, 1), bone: ri(0, 1), skull: ri(0, 1),
            bag: 1 + ri(0, 1), mouse: ri(0, 1), pig: R >= 1 && this.SR() < .45 ? 1 : 0
          };
          const out = {}; Object.keys(base).forEach(t => { out[t] = Math.round(base[t] * 1.35); }); return out;
        }
      }
      return {};
    }
    genField(round, n) {
      const k = n > 2 ? 1.45 : 1, R = round;
      let finalCounts;
      const sp = this.G.special;
      if (sp) {
        finalCounts = this.specialCounts(sp.id, R);
      } else {
        const plan = [
          ['gold_s', 2 + this.sri(0, 1)], ['gold_m', 2],
          ['gold_l', 1 + (R >= 2 && this.SR() < .5 ? 1 : 0)],
          ['gold_xl', this.SR() < .3 + R * .06 ? 1 : 0],
          ['diamond', (this.SR() < .65 ? 1 : 0) + (R >= 3 ? this.sri(0, 1) : 0)],
          ['rock_s', 2 + this.sri(0, 1)], ['rock_l', 1 + this.sri(0, 1)],
          ['bone', this.sri(0, 1)], ['skull', this.sri(0, 1)],
          ['bag', 1 + this.sri(0, 1)], ['mouse', this.sri(0, 1)],
          ['pig', R >= 1 && this.SR() < .45 ? 1 : 0],
          ['tnt', R >= 1 ? this.sri(0, 1) + (R >= 4 ? 1 : 0) : 0]
        ];
        const allowed = ITEM_TYPES.filter(t => this.qtyLevel(t) !== 'none');
        finalCounts = {}; let displaced = 0;
        plan.forEach(([t, c]) => {
          if (this.qtyLevel(t) === 'none') { displaced += c; return; }
          finalCounts[t] = this.applyQty(t, c, R);
        });
        for (let i = 0; i < displaced && allowed.length; i++) {
          const rep = allowed[Math.floor(this.SR() * allowed.length)];
          finalCounts[rep] = (finalCounts[rep] || 0) + 1;
        }
      }
      const counts = Object.keys(finalCounts).map(t => [t, Math.round(finalCounts[t] * k)])
        .filter(([t, c]) => c > 0).sort((a, b) => DEF[b[0]].r - DEF[a[0]].r);
      const all = [];
      ['L', 'R'].forEach(side => {
        const half = [];
        counts.forEach(([t, c]) => { for (let i = 0; i < c; i++) { const it = this.place(t, half, side); if (it) half.push(it); } });
        half.forEach(it => all.push(it));
      });
      return all;
    }

    /* ---------- 数值 ---------- */
    itemValue(it, p) {
      let v = DEF[it.t].v;
      if (it.t.startsWith('rock') && p.buffs.rock) v *= 3;
      if (it.t === 'diamond' && p.buffs.polish) v = Math.round(v * 1.5);
      if (it.t === 'pig') v = 2 + (p.buffs.polish ? 900 : 600);
      return v;
    }
    expectedValue(it, p) { return it.t === 'bag' ? (p.buffs.luck ? 300 : 360) : it.t === 'tnt' ? 0 : this.itemValue(it, p); }
    pullSpeed(p, it) { return PULL_BASE * p.strength * (p.buffs.power ? POWER_MUL : 1) / it.w; }
    openBag(p, it) {
      const fxChance = p.buffs.luck ? .4 : .2;
      if (it.bagRoll < fxChance) {
        if (it.bagFx === 'dyn') { p.dynamite++; return { v: 0, text: '炸药 +1' }; }
        p.strength = Math.min(6, p.strength * 1.5 + 1); return { v: 0, text: '力量爆发！' };
      }
      return { v: it.bagV };
    }

    /* ---------- 钩子与物理 ---------- */
    tipOf(p) { const h = p.hook; return { x: p.x + Math.sin(h.ang) * h.len, y: p.py + Math.cos(h.ang) * h.len }; }
    canAct() { return this.G.phase === 'play' || this.G.phase === 'shop'; }
    fire(p) {
      if (!this.canAct() || p.hook.state !== 'swing') return false;
      p.hook.state = 'extend'; this.fx('sfx', { k: 'fire' }); return true;
    }
    bomb(p) {
      const h = p.hook;
      if (this.G.phase !== 'play') return false; // 商店阶段不可炸
      if (!this.canAct() || h.state !== 'retract' || !h.item || p.dynamite <= 0 || p.stickFlying) return false;
      p.dynamite--; p.stickFlying = true;
      this.G.sticks = this.G.sticks || [];
      this.G.sticks.push({ p, item: h.item, t: 0, dur: .22, x0: p.x, y0: p.py - 10 });
      return true;
    }
    destroyItem(o) {
      o.gone = true; this.fx('debris', { x: o.x, y: o.y, it: o.t });
      for (const p of this.G.players) if (p.hook.item === o) p.hook.item = null;
    }
    explodeTNT(it) {
      if (it.gone) return; it.gone = true; const R = 115;
      this.fx('boom', { x: it.x, y: it.y, R }); this.fx('sfx', { k: 'boom' }); this.G.shake = .4;
      for (const o of this.G.items) {
        if (o === it || o.gone) continue;
        if (Math.hypot(o.x - it.x, o.y - it.y) < R + o.r * .4) {
          if (o.t === 'tnt') { if (!o.fuse) o.fuse = .18; } else this.destroyItem(o);
        }
      }
    }
    // 商店：钩到商品 → 购买。余额足够则扣款+生效+标记售出；不足则提示且商品弹回货架（不外售）
    shopCollect(p, it) {
      const off = it.offer;
      if (!off || off.soldTo !== null) return;
      if (p.wallet < off.price) {
        this.fx('sfx', { k: 'junk' });
        this.fx('float', { x: p.x, y: GROUND + 40, text: '余额不足', c: '#ff6a4d', size: 24 });
        return;
      }
      p.wallet -= off.price;
      if (off.type === 'dynamite') p.dynamite++; else p.nextBuffs[off.type] = true;
      off.soldTo = p.idx;
      const s = this.G.shop;
      if (s) s.log[p.idx] = `购买：${SHOP[off.type].n}`;
      this.fx('sfx', { k: 'buy' });
      this.fx('float', { x: p.x, y: GROUND + 40, text: '-' + off.price, c: '#ffd23f', size: 22 });
    }
    collect(p, it) {
      if (it.shop) { this.shopCollect(p, it); return; }
      let v, txt;
      if (it.t === 'bag') { const r = this.openBag(p, it); v = r.v; txt = r.text || ('+' + this._fmt(v)); }
      else { v = this.itemValue(it, p); txt = '+' + this._fmt(v); }
      p.cur += v; p.wallet += v;
      const col = v >= 300 ? '#ffd23f' : v >= 50 ? '#fff4b8' : v > 0 ? '#e8e2d8' : '#9ff0b0';
      this.fx('float', { x: p.x, y: GROUND - 78, text: txt, c: col, size: v >= 300 ? 30 : 22 });
      if (v >= 50) { this.fx('sfx', { k: 'coin', v }); this.fx('sparkle', { x: p.x, y: p.py, n: v >= 300 ? 24 : 12 }); }
      else if (v > 0) this.fx('sfx', { k: 'junk' });
      else this.fx('sfx', { k: 'buy' });
    }
    _fmt(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
    updatePlayer(p, dt) {
      const h = p.hook;
      if (h.burnt > 0) h.burnt -= dt;
      if (h.state === 'swing') {
        h.ang += h.dir * SWING_SPEED * dt;
        if (h.ang > MAXA) { h.ang = MAXA; h.dir = -1; } else if (h.ang < -MAXA) { h.ang = -MAXA; h.dir = 1; }
        h.len = L0;
        if (p.isAI && this.G.phase === 'shop') this.shopAIThink(p, dt);
        else if (p.isAI && this.G.phase === 'play') this.aiThink(p, dt);
      } else if (h.state === 'show') {
        h.showT -= dt;
        if (h.showT <= 0) {
          if (h.item) {
            if (h.item.shop) { // 商品回到货架原位，已售的留在架上显示“已售出”
              h.item.x = h.item.x0; h.item.y = h.item.y0; h.item.taken = false;
            } else this.G.items = this.G.items.filter(o => o !== h.item);
            h.item = null;
          }
          h.state = 'swing';
        }
      } else if (h.state === 'extend') {
        h.len += EXT_SPEED * dt; const tip = this.tipOf(p);
        if (tip.x < 0 || tip.x > W || tip.y > H || h.len >= MAX_LEN) { h.state = 'retract'; return; }
        for (const it of this.G.items) {
          if (it.gone) continue;
          if (it.shop && it.offer && it.offer.soldTo !== null) continue; // 已售商品钩子穿过
          const R = it.r + HOOK_R;
          if ((tip.x - it.x) ** 2 + (tip.y - it.y) ** 2 >= R * R) continue;
          if (it.t === 'tnt') { this.explodeTNT(it); h.state = 'retract'; h.burnt = .8; break; }
          if (it.taken) {
            if (it.shop) continue; // 商店商品先到先得，不可抢夺
            // 抢夺：物品正被另一玩家拉回（retract）时，本钩子碰到即抢归自己
            const owner = this.G.players.find(q => q !== p && q.hook.item === it && q.hook.state === 'retract');
            if (!owner) continue; // 非拉回中（如已收尾的 show 阶段）不可抢
            owner.hook.item = null;                 // 原主人变空钩收回
            if (owner.isAI && owner.ai) owner.ai.bombDecided = false;
            it.taken = true; h.item = it; h.state = 'retract'; p.ai.bombDecided = false;
            this.fx('sfx', { k: 'grab' });
            this.fx('float', { x: it.x, y: it.y - 26, text: '抢到了！', c: '#ff5a3c', size: 28 });
            break;
          }
          it.taken = true; h.item = it; h.state = 'retract'; p.ai.bombDecided = false;
          this.fx('sfx', { k: it.shop ? 'coin' : 'grab' });
          break;
        }
      } else if (h.state === 'retract') {
        let sp = h.item ? this.pullSpeed(p, h.item) : RET_EMPTY;
        if (this.G.phase === 'shop') sp *= SHOP_RET_MUL;
        h.len -= sp * dt; p.reel += sp * dt / 9;
        if (h.item) {
          const tip = this.tipOf(p), off = h.item.r * .55;
          h.item.x = tip.x + Math.sin(h.ang) * off; h.item.y = tip.y + Math.cos(h.ang) * off;
          if (p.isAI && this.G.phase === 'play') this.aiBomb(p, dt);
        }
        if (h.len <= L0) {
          h.len = L0;
          if (h.item) { this.collect(p, h.item); h.state = 'show'; h.showT = SHOW_TIME; }
          else h.state = 'swing';
        }
      }
    }

    /* ---------- AI ---------- */
    boundLen(px, py, dx, dy) { let l = 1e9; if (dx > 1e-6) l = Math.min(l, (W - px) / dx); if (dx < -1e-6) l = Math.min(l, -px / dx); if (dy > 1e-6) l = Math.min(l, (H - py) / dy); return l; }
    rayHit(px, py, a) {
      const dx = Math.sin(a), dy = Math.cos(a); let best = null, bestD = this.boundLen(px, py, dx, dy);
      for (const it of this.G.items) {
        if (it.taken || it.gone) continue;
        const ox = it.x - px, oy = it.y - py, t = ox * dx + oy * dy; if (t < 0) continue;
        const perp = Math.abs(ox * dy - oy * dx), R = it.r + HOOK_R; if (perp > R) continue;
        const d = t - Math.sqrt(R * R - perp * perp);
        if (d < bestD && d > L0 - 6) { bestD = d; best = it; }
      }
      return { item: best, d: bestD };
    }
    aiScore(p, hit) {
      if (!hit.item || hit.item.t === 'tnt') return -1;
      const ev = this.expectedValue(hit.item, p);
      const total = hit.d / EXT_SPEED + hit.d / this.pullSpeed(p, hit.item) + SHOW_TIME;
      if (total > this.G.timeLeft - .15) return ev > 0 ? .001 : -1;
      return ev / total;
    }
    aiThink(p, dt) {
      const a = p.ai, c = AI_CFG[p.lvl];
      if (a.fireAt !== null) { a.fireAt -= dt; if (a.fireAt <= 0) { a.fireAt = null; this.fire(p); } return; }
      a.reco -= dt;
      if (a.reco <= 0) { a.reco = .3; let best = 0; for (let ang = -MAXA; ang <= MAXA; ang += .025) { const s = this.aiScore(p, this.rayHit(p.x, p.py, ang)); if (s > best) best = s; } a.best = best; }
      if (a.best <= 0) return;
      const s = this.aiScore(p, this.rayHit(p.x, p.py, p.hook.ang));
      if (s > 0 && s >= a.best * c.thr) a.fireAt = Math.random() < c.miss ? rnd(.2, .5) : rnd(c.react[0], c.react[1]);
    }
    aiBomb(p, dt) {
      const a = p.ai, h = p.hook;
      if (a.bombAt !== null) { a.bombAt -= dt; if (a.bombAt <= 0) { a.bombAt = null; this.bomb(p); } return; }
      if (a.bombDecided || p.dynamite <= 0 || p.stickFlying || !h.item) return;
      a.bombDecided = true;
      const v = this.expectedValue(h.item, p), tRem = (h.len - L0) / this.pullSpeed(p, h.item);
      if (h.item.t !== 'bag' && v <= 30 && tRem > 2.5 && Math.random() < AI_CFG[p.lvl].bomb) a.bombAt = rnd(.15, .4);
    }

    /* ---------- 视觉更新的逻辑部分（碎片/爆炸位置在客户端本地推进，这里只处理炸掉物品） ---------- */
    updateSticks(dt) {
      this.G.sticks = this.G.sticks.filter(s => {
        s.t += dt;
        if (s.t >= s.dur) {
          s.p.stickFlying = false;
          if (!s.item.gone && this.G.items.includes(s.item)) {
            s.item.gone = true; this.fx('debris', { x: s.item.x, y: s.item.y, it: s.item.t });
            this.fx('boom', { x: s.item.x, y: s.item.y, R: 45 }); this.fx('sfx', { k: 'small' });
            if (s.p.hook.item === s.item) s.p.hook.item = null;
          }
          return false;
        }
        return true;
      });
    }

    /* ---------- 主更新（服务器权威，固定步长调用） ---------- */
    update(dt) {
      const G = this.G;
      for (const it of G.items) {
        if (!it.taken && !it.gone && it.vx) {
          it.x += it.vx * dt;
          if (it.x < it.x0 - it.range) { it.x = it.x0 - it.range; it.vx = Math.abs(it.vx); }
          if (it.x > it.x0 + it.range) { it.x = it.x0 + it.range; it.vx = -Math.abs(it.vx); }
        }
        if (it.fuse > 0) { it.fuse -= dt; if (it.fuse <= 0) this.explodeTNT(it); }
      }
      if (G.phase === 'countdown') {
        G.countdown -= dt;
        if (G.countdown <= 0) { G.phase = 'play'; G.goFlash = .8; this.fx('sfx', { k: 'go' }); }
      } else if (G.phase === 'play') {
        const prev = Math.ceil(G.timeLeft); G.timeLeft -= dt;
        if (Math.ceil(G.timeLeft) < prev && G.timeLeft <= 5 && G.timeLeft > 0) this.fx('sfx', { k: 'tick' });
        if (G.timeLeft <= 0) { G.timeLeft = 0; this.endRound(); return; }
      } else if (G.phase === 'shop') {
        const s = G.shop;
        if (s && !s.done) {
          const prev = Math.ceil(s.timeLeft); s.timeLeft -= dt;
          if (Math.ceil(s.timeLeft) < prev && s.timeLeft <= 5 && s.timeLeft > 0) this.fx('sfx', { k: 'tick' });
          if (this.shopDone()) {
            s.done = true; s.timeLeft = Math.max(0, s.timeLeft); s.endT = SHOP_END_DELAY;
            G.banner = { text: '购物时间结束', t: 0 };
            this.fx('sfx', { k: 'end' });
          }
        } else if (s && !s.ended) {
          s.endT -= dt;
          if (s.endT <= 0) { s.ended = true; this.startRound(); }
        }
      } else {
        // result / roundEnd / final：物理仍推进一点（让展示期的钩子/粒子自然），但不计时
      }
      for (const p of G.players) this.updatePlayer(p, dt);
      this.updateSticks(dt);
      G.items = G.items.filter(it => !it.gone || it.fuse > 0);
      if (G.shake > 0) G.shake -= dt;
      if (G.goFlash > 0) G.goFlash -= dt;
      if (G.banner) G.banner.t += dt;
      if (G.phase === 'play') {
        const left = G.items.some(it => !it.gone && !it.taken && it.t !== 'tnt');
        const busy = G.players.some(p => p.hook.state !== 'swing');
        if (!left && !busy) { G.emptyT += dt; if (G.emptyT > .5) { G.emptyT = 0; this.endRound('clear'); } }
        else G.emptyT = 0;
      }
    }

    /* ---------- 流程 ---------- */
    startMatch() {
      const G = this.G;
      G.seedId = (this.cfg.seed || '').trim() || String(Math.floor(Math.random() * 90000000) + 10000000);
      G.players = this.buildPlayers();
      G.round = 0; G.points = [0, 0]; G.history = []; G.matchWinner = -2;
      G.time = 0; G.shake = 0; G.banner = null;
      this.startRound();
      return G.seedId;
    }
    rollSpecial() {
      // 用本轮种子流掷，保证同种子同关卡可复现；消费随机数后再 genField 也一致复现
      if (this.SR() < SPECIAL_RATE) {
        const sp = SPECIALS[Math.floor(this.SR() * SPECIALS.length)];
        this.G.special = { id: sp.id, name: sp.name, desc: sp.desc };
      } else {
        this.G.special = null;
      }
    }
    startRound() {
      const G = this.G;
      G.round++;
      this.setSeedForRound(G.seedId, G.round - 1);
      this.rollSpecial();
      G.items = this.genField(G.round - 1, G.players.length);
      G.sticks = []; G.banner = null; G.emptyT = 0; G.shake = 0;
      G.players.forEach(p => { p.buffs = p.nextBuffs; p.nextBuffs = {}; p.strength = 1; p.cur = 0; });
      this.resetHooks();
      G.timeLeft = this.cfg.roundTime; G.countdown = 3; G.phase = 'countdown';
    }
    teamSums() { const s = [0, 0]; this.G.players.forEach(p => s[p.team] += p.cur); return s; }
    isTotal() { return this.G.cfg && this.G.cfg.scoreMode === 'total'; }
    grandTotals() { const s = [0, 0]; this.G.players.forEach(p => { s[p.team] += sum(p.roundValues) + p.cur; }); return s; }
    isLocked() { if (this.isTotal()) return false; const G = this.G, rem = G.cfg.rounds - G.round; return Math.abs(G.points[0] - G.points[1]) > rem; }
    endRound(reason) {
      const G = this.G;
      G.phase = 'roundEnd'; G.clearEarly = reason === 'clear' ? Math.ceil(G.timeLeft) : 0;
      G.players.forEach(p => { if (p.hook.item) p.hook.item = null; p.roundValues.push(p.cur); });
      const s = this.teamSums(), w = s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : -1;
      if (w >= 0) G.points[w]++;
      G.history.push({ sums: s, winner: w });
      G.banner = { text: G.clearEarly ? '矿区已清空！' : '时间到！', t: 0 };
      this.fx('sfx', { k: 'end' });
    }
    matchOver() { const G = this.G; if (G.round >= G.cfg.rounds) return true; return !this.isTotal() && G.cfg.early && this.isLocked(); }
    toResult() { this.G.phase = 'result'; this.G.banner = null; }

    /* ---------- 商店：所有玩家同时出钩抢购柜台上的商品 ---------- */
    genOffers(n) {
      const types = Object.keys(SHOP), out = [], cnt = {};
      while (out.length < n) {
        const tw = sum(types.map(t => (cnt[t] || 0) >= 2 ? 0 : SHOP[t].wt));
        let r = Math.random() * tw, pick = types[0];
        for (const t of types) { const w = (cnt[t] || 0) >= 2 ? 0 : SHOP[t].wt; if (r < w) { pick = t; break; } r -= w; }
        cnt[pick] = (cnt[pick] || 0) + 1;
        const [a, b] = SHOP[pick].p;
        out.push({ type: pick, price: Math.round(rnd(a, b) / 5) * 5, soldTo: null });
      }
      return out;
    }
    // 商品摆到柜台：8 个位置横向均布，柜台 y≈318~372
    makeShopItem(offer, x, y) {
      return {
        id: this.itemSeq++, t: offer.type, shop: true, offer,
        x, y, x0: x, y0: y, r: 30, w: 3, rot: 0, ph: this.srnd(0, 6.28),
        taken: false, gone: false, fuse: 0
      };
    }
    openShop() {
      const G = this.G;
      G.phase = 'shop';
      const offers = this.genOffers(8);
      const n = offers.length, xMin = 130, xMax = W - 130;
      const goods = offers.map((o, i) => this.makeShopItem(o, n === 1 ? W / 2 : xMin + i * (xMax - xMin) / (n - 1), 354)); /*SHOP_LABEL_DESC*/
      G.items = goods;                       // 柜台上的商品直接作为可抓物品
      G.shop = { offers, log: {}, timeLeft: 20, done: false, endT: 0, ended: false };
      G.players.forEach(p => { this.resetHook(p); });
      this.shopToken++;
    }
    resetHook(p) {
      const a = this.srnd(-MAXA, MAXA), d = this.SR() < .5 ? -1 : 1;
      Object.assign(p.hook, { state: 'swing', ang: a, dir: d, len: L0, item: null, burnt: 0, showT: 0 });
      if (p.ai) { p.ai.fireAt = null; p.ai.reco = .1 + this.SR() * .3; p.ai.best = 0; p.ai.bombDecided = true; }
    }
    shopDone() {
      const s = this.G.shop;
      return !!s && (s.done || s.timeLeft <= 0 || s.offers.every(o => o.soldTo !== null));
    }
    // 供旧流程按钮兼容：现在选购由出钩完成，这里只做“结束购物”
    shopCur() { return null; }
    buy() { return false; }
    skipShop() { return false; }
    aiPickShop() { return -1; }
    autoShopAI() { /* 商店 AI 改由 out-of-play aiThink 驱动 */ }
    // 商店专用 AI 决策：挑一件买得起、未被售出的商品，按方向角出钩
    shopAIThink(p, dt) {
      const a = p.ai, c = AI_CFG[p.lvl] || AI_CFG.normal;
      if (a.fireAt !== null) { a.fireAt -= dt; if (a.fireAt <= 0) { a.fireAt = null; this.fire(p); } return; }
      a.reco -= dt;
      if (a.reco > 0) return;
      a.reco = .35 + this.SR() * .4;
      const cand = this.G.shop.offers.map((o, i) => ({ o, i })).filter(({ o }) =>
        o.soldTo === null && o.price <= p.wallet);
      if (!cand.length) return;
      const pri = { power: 3, polish: this.G.round >= 2 ? 2.4 : 1.6, dynamite: p.dynamite < 2 ? 2.6 : 1.2, luck: 1.7, rock: 1 };
      let pick = null, best = -1;
      for (const { o, i } of cand) {
        let sc = (pri[o.type] || 1) - o.price / 1000;
        if (p.lvl === 'easy') sc = this.SR();
        if (sc > best) { best = sc; pick = i; }
      }
      const it = this.G.items[pick];
      if (!it) return;
      const dx = it.x - p.x, dy = it.y - p.py;
      const want = Math.atan2(dx, dy); // 钩子角：sin=dx dir, cos=dy
      const diff = Math.abs(want - p.hook.ang);
      if (diff < .26 && this.SR() > (c.miss || 0)) a.fireAt = this.srnd(c.react[0], c.react[1]);
      else a.dir = (want > p.hook.ang) ? 1 : -1;
    }
    toFinal() {
      const G = this.G; G.phase = 'final'; G.banner = null;
      const pts = G.points, tot = [0, 0]; G.players.forEach(p => tot[p.team] += sum(p.roundValues));
      let w = pts[0] > pts[1] ? 0 : pts[1] > pts[0] ? 1 : -1;
      if (w < 0 && tot[0] !== tot[1]) w = tot[0] > tot[1] ? 0 : 1;
      if (this.isTotal()) w = tot[0] > tot[1] ? 0 : tot[1] > tot[0] ? 1 : -1;
      G.matchWinner = w;
      if (w >= 0) this.fx('sfx', { k: 'win' });
    }
    backToSetup() { this.G = this._blankState(); }

    /* ---------- 快照序列化（仅纯数据，供网络传输） ---------- */
    serialize() {
      const G = this.G;
      return {
        phase: G.phase, round: G.round, rounds: this.cfg.rounds, mode: this.cfg.mode,
        scoreMode: this.cfg.scoreMode || 'round',
        seedId: G.seedId, timeLeft: G.timeLeft, countdown: G.countdown,
        special: G.special ? { id: G.special.id, name: G.special.name, desc: G.special.desc } : null,
        points: G.points.slice(), history: clone(G.history),
        clearEarly: G.clearEarly, matchWinner: G.matchWinner,
        banner: G.banner ? { text: G.banner.text, t: G.banner.t } : null,
        shake: G.shake, goFlash: G.goFlash, time: G.time,
        counts: clone(this.cfg.counts || {}),
        players: G.players.map(p => ({
          idx: p.idx, name: p.name, team: p.team, x: p.x, isAI: p.isAI, lvl: p.lvl,
          wallet: p.wallet, dynamite: p.dynamite, buffs: clone(p.buffs),
          nextBuffs: clone(p.nextBuffs), strength: p.strength,
          roundValues: p.roundValues.slice(), cur: p.cur, stickFlying: p.stickFlying, reel: p.reel,
          hook: {
            state: p.hook.state, dir: p.hook.dir, ang: p.hook.ang, len: p.hook.len,
            burnt: p.hook.burnt, showT: p.hook.showT,
            itemId: p.hook.item ? p.hook.item.id : null
          }
        })),
        items: G.items.map(it => clone(it)),
        sticks: (G.sticks || []).map(s => ({
          pIdx: s.p.idx, itemId: s.item.id, t: s.t, dur: s.dur, x0: s.x0, y0: s.y0
        })),
        shop: G.shop ? {
          offers: clone(G.shop.offers), log: clone(G.shop.log),
          timeLeft: G.shop.timeLeft, done: G.shop.done,
          endT: G.shop.endT, ended: G.shop.ended
        } : null
      };
    }
  }

  return {
    GameCore, W, H, GROUND, TOPBAR, DEF, SHOP, AI_CFG, TEAM,
    ITEM_TYPES, QTY_LEVELS, DEFAULT_CFG, KEYS1, KEYS2, SPECIALS, SPECIAL_RATE,
    MAXA, SWING_SPEED, EXT_SPEED, PULL_BASE, RET_EMPTY, MAX_LEN, SHOW_TIME, L0, HOOK_R, POWER_MUL
  };
});
