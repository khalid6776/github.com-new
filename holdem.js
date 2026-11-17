'use strict';
/*
 * No-Limit Texas Hold'em engine — server side, pure logic, no networking.
 * The server is the only holder of the deck and hole cards.
 */
const crypto = require('crypto');

const SUITS = ['s', 'h', 'd', 'c'];
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const CAT = { 10: 'رويال فلش', 9: 'ستريت فلش', 8: 'أربعة متشابهة', 7: 'فل هاوس', 6: 'فلش', 5: 'ستريت', 4: 'ثلاثية', 3: 'زوجان', 2: 'زوج', 1: 'ورقة عالية' };
const CAT_EN = { 10: 'Royal Flush', 9: 'Straight Flush', 8: 'Four of a Kind', 7: 'Full House', 6: 'Flush', 5: 'Straight', 4: 'Three of a Kind', 3: 'Two Pair', 2: 'One Pair', 1: 'High Card' };
const MAX_START = 100000000;

const rankLabel = (v) => (v === 14 ? 'A' : v === 13 ? 'K' : v === 12 ? 'Q' : v === 11 ? 'J' : String(v));
const defaultRnd = (n) => crypto.randomInt(n);

function newDeck() {
  const d = [];
  for (const s of SUITS) for (let v = 2; v <= 14; v++) d.push({ v, s });
  return d;
}
function shuffle(a, rnd) {
  rnd = rnd || defaultRnd;
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/* ---------------- Hand evaluation ---------------- */
function eval5(cs) {
  const vals = cs.map((c) => c.v).sort((a, b) => b - a);
  const flush = cs.every((c) => c.s === cs[0].s);
  let sh = 0;
  if (new Set(vals).size === 5) {
    if (vals[0] - vals[4] === 4) sh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5 && vals[2] === 4 && vals[3] === 3 && vals[4] === 2) sh = 5; // wheel only
  }
  const cnt = new Map();
  for (const v of vals) cnt.set(v, (cnt.get(v) || 0) + 1);
  const g = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (sh && flush) return { cat: sh === 14 ? 10 : 9, tb: [sh] };
  if (g[0][1] === 4) return { cat: 8, tb: [g[0][0], g[1][0]] };
  if (g[0][1] === 3 && g[1][1] === 2) return { cat: 7, tb: [g[0][0], g[1][0]] };
  if (flush) return { cat: 6, tb: vals };
  if (sh) return { cat: 5, tb: [sh] };
  if (g[0][1] === 3) return { cat: 4, tb: [g[0][0], g[1][0], g[2][0]] };
  if (g[0][1] === 2 && g[1][1] === 2) return { cat: 3, tb: [g[0][0], g[1][0], g[2][0]] };
  if (g[0][1] === 2) return { cat: 2, tb: [g[0][0], g[1][0], g[2][0], g[3][0]] };
  return { cat: 1, tb: vals };
}
function cmpScore(a, b) {
  if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
  for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
    const x = a.tb[i] || 0, y = b.tb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function orderFive(five, sc) {
  const cnt = new Map();
  for (const c of five) cnt.set(c.v, (cnt.get(c.v) || 0) + 1);
  const out = five.slice().sort((a, b) => cnt.get(b.v) - cnt.get(a.v) || b.v - a.v);
  if ((sc.cat === 5 || sc.cat === 9) && sc.tb[0] === 5) out.push(out.shift()); // A-2-3-4-5: ace last
  return out;
}
function describe(sc) {
  const R = rankLabel, t = sc.tb;
  switch (sc.cat) {
    case 10: return 'رويال فلش';
    case 9: return t[0] === 5 ? 'ستريت فلش منخفض A-5' : 'ستريت فلش حتى ' + R(t[0]);
    case 8: return 'أربعة ' + R(t[0]) + '، والكيكر ' + R(t[1]);
    case 7: return 'ثلاثة ' + R(t[0]) + ' مع زوج ' + R(t[1]);
    case 6: return 'فلش أعلى ورقة فيه ' + R(t[0]);
    case 5: return t[0] === 5 ? 'ستريت منخفض A-2-3-4-5' : 'ستريت حتى ' + R(t[0]);
    case 4: return 'ثلاثية ' + R(t[0]);
    case 3: return 'زوجان ' + R(t[0]) + ' و' + R(t[1]) + '، والكيكر ' + R(t[2]);
    case 2: return 'زوج ' + R(t[0]);
    default: return 'ورقة عالية ' + R(t[0]);
  }
}
function bestHand(cards) {
  let best = null, bc = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++)
    for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      const sc = eval5(five);
      if (!best || cmpScore(sc, best) > 0) { best = sc; bc = five; }
    }
  return { cat: best.cat, tb: best.tb, cards: orderFive(bc, best), name: CAT[best.cat], en: CAT_EN[best.cat], desc: describe(best) };
}

/* ---------------- Settings ---------------- */
function toInt(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && /^\d+$/.test(x.trim())) return Number(x.trim());
  return NaN;
}
function validateSettings(s) {
  s = s || {};
  const startStack = toInt(s.startStack), sb = toInt(s.sb), bb = toInt(s.bb);
  const actionSecs = s.actionSecs == null ? 30 : toInt(s.actionSecs);
  if (![startStack, sb, bb].every((v) => Number.isSafeInteger(v) && v > 0)) return { ok: false, error: 'أدخل مبالغ صحيحة موجبة دون كسور.' };
  if (bb !== 2 * sb) return { ok: false, error: 'الرهان الكبير يجب أن يساوي ضعف الرهان الصغير.' };
  if (startStack < bb) return { ok: false, error: 'رصيد البداية لا يجوز أن يقل عن الرهان الكبير.' };
  if (startStack > MAX_START) return { ok: false, error: 'الحد الأعلى لرصيد البداية $100,000,000.' };
  if (![15, 20, 30, 45, 60, 90].includes(actionSecs)) return { ok: false, error: 'مهلة التصرف غير صالحة.' };
  return { ok: true, settings: { startStack, sb, bb, actionSecs } };
}

/* ---------------- Match / table ---------------- */
function createMatch(opts) {
  const v = validateSettings(opts);
  if (!v.ok) throw new Error(v.error);
  if (!Array.isArray(opts.players) || opts.players.length < 2 || opts.players.length > 7) throw new Error('2 to 7 players');
  const cfg = v.settings;
  return {
    cfg,
    seats: opts.players.map((p) => ({ id: p.id, name: p.name, stack: cfg.startStack, busted: false })),
    total: cfg.startStack * opts.players.length,
    handNo: 0, pos: null, hand: null, over: false, winner: null,
    rnd: opts.rnd || defaultRnd
  };
}
const live = (m, s) => !m.seats[s].busted && m.seats[s].stack > 0;
function nextSeat(m, from, pred) {
  const n = m.seats.length;
  for (let k = 1; k <= n; k++) { const s = (((from + k) % n) + n) % n; if (pred(s)) return s; }
  return -1;
}
const nextLive = (m, from) => nextSeat(m, from, (s) => live(m, s));

/* Dead-button rule: the big blind always advances to the next live player;
   the small blind is posted by last hand's big blind (dead if that player busted);
   the button sits on last hand's small-blind position (may be an empty seat).
   Heads-up: button posts the small blind and the BB alternates. */
function computePositions(m) {
  const liveSeats = m.seats.map((_, i) => i).filter((i) => live(m, i));
  const n = liveSeats.length;
  if (!m.pos) {
    const btn = liveSeats[m.rnd(n)];
    if (n === 2) return { btnPos: btn, sbPos: btn, sbSeat: btn, bbSeat: nextLive(m, btn) };
    const sb = nextLive(m, btn);
    return { btnPos: btn, sbPos: sb, sbSeat: sb, bbSeat: nextLive(m, sb) };
  }
  const prev = m.pos;
  const bb = nextLive(m, prev.bbSeat);
  if (n === 2) { const sb = nextLive(m, bb); return { btnPos: sb, sbPos: sb, sbSeat: sb, bbSeat: bb }; }
  const sbPos = prev.bbSeat;
  return { btnPos: prev.sbPos, sbPos, sbSeat: live(m, sbPos) ? sbPos : null, bbSeat: bb };
}

const isActive = (h, s) => !h.folded[s] && !h.allIn[s];
const contenders = (h) => h.inHand.filter((s) => !h.folded[s]);
const othersActive = (h, s) => h.inHand.filter((x) => x !== s && isActive(h, x)).length;
function maxOtherBet(h, s) {
  let mx = 0;
  for (const x of h.inHand) if (x !== s && !h.folded[x] && h.bet[x] > mx) mx = h.bet[x];
  return mx;
}
/* Amount a player must reach. With no other active player there is nobody to bet against,
   so the target is capped at what the remaining (all-in) players actually put in. */
function target(h, s) { return othersActive(h, s) > 0 ? h.currentBet : Math.min(h.currentBet, maxOtherBet(h, s)); }
function needsAction(h, s) {
  if (!isActive(h, s)) return false;
  if (h.bet[s] < target(h, s)) return true;
  if (othersActive(h, s) === 0) return false;
  return h.actedAt[s] === undefined;
}
function pay(m, s, amt) {
  const h = m.hand, seat = m.seats[s];
  if (!Number.isSafeInteger(amt) || amt < 0 || amt > seat.stack) throw new Error('invalid payment');
  seat.stack -= amt; h.bet[s] += amt; h.committed[s] += amt;
  if (seat.stack === 0) h.allIn[s] = true;
  return amt;
}
function moneyTotal(m) {
  let t = 0;
  for (const s of m.seats) t += s.stack;
  if (m.hand && m.hand.status !== 'done') for (const s of m.hand.inHand) t += m.hand.committed[s];
  return t;
}
function assertMoney(m) {
  const t = moneyTotal(m);
  if (t !== m.total) throw new Error('Money invariant broken: ' + t + ' != ' + m.total);
}

function startHand(m) {
  if (m.over) throw new Error('match over');
  if (m.hand && m.hand.status !== 'done') throw new Error('hand in progress');
  const liveSeats = m.seats.map((_, i) => i).filter((i) => live(m, i));
  if (liveSeats.length < 2) { m.over = true; m.winner = liveSeats[0]; return [{ k: 'matchOver', winner: m.winner }]; }
  m.handNo += 1;
  const pos = computePositions(m);
  m.pos = pos;
  const h = {
    no: m.handNo, deck: m.nextDeck ? m.nextDeck.splice(0) : shuffle(newDeck(), m.rnd), /* nextDeck: test hook only */ burned: [], board: [], inHand: liveSeats,
    hole: {}, folded: {}, allIn: {}, committed: {}, bet: {}, actedAt: {}, lastAction: {},
    street: 'preflop', currentBet: 0, minRaise: m.cfg.bb, toAct: null, turnId: 0, status: 'betting',
    btnPos: pos.btnPos, sbSeat: pos.sbSeat, bbSeat: pos.bbSeat, lastAggressor: null, riverAggressor: null,
    runout: false, shown: {}, mucked: {}, results: null
  };
  for (const s of liveSeats) { h.committed[s] = 0; h.bet[s] = 0; }
  m.hand = h;
  const ev = [{ k: 'handStart', no: h.no, btn: pos.btnPos, sb: pos.sbSeat, bb: pos.bbSeat, seats: liveSeats.slice() }];
  const post = (s, amt, type) => {
    const paid = pay(m, s, Math.min(amt, m.seats[s].stack));
    h.lastAction[s] = { t: type, amt: paid };
    ev.push({ k: 'blind', seat: s, type, amount: paid, allIn: !!h.allIn[s] });
  };
  if (pos.sbSeat !== null) post(pos.sbSeat, m.cfg.sb, 'sb');
  post(pos.bbSeat, m.cfg.bb, 'bb');
  h.currentBet = m.cfg.bb; // players must call the full big blind
  h.minRaise = m.cfg.bb;
  // deal two rounds, starting left of the button
  const order = [];
  let s = nextSeat(m, h.btnPos, (x) => liveSeats.includes(x));
  for (let i = 0; i < liveSeats.length; i++) { order.push(s); s = nextSeat(m, s, (x) => liveSeats.includes(x)); }
  for (let r = 0; r < 2; r++) for (const x of order) (h.hole[x] = h.hole[x] || []).push(h.deck.pop());
  ev.push({ k: 'deal', order });
  const first = nextSeat(m, h.bbSeat, (x) => liveSeats.includes(x) && needsAction(h, x));
  if (first === -1) endRound(m, ev); else setTurn(m, first, ev);
  assertMoney(m);
  return ev;
}
function setTurn(m, s, ev) { m.hand.toAct = s; m.hand.turnId += 1; ev.push({ k: 'turn', seat: s }); }

function legal(m, s) {
  const h = m.hand;
  if (!h || h.status !== 'betting' || h.toAct !== s) return null;
  const st = m.seats[s].stack, b = h.bet[s], t = target(h, s);
  const toCall = Math.min(st, Math.max(0, t - b));
  const oa = othersActive(h, s);
  const reopened = h.actedAt[s] === undefined || h.currentBet - h.actedAt[s] >= h.minRaise;
  const canAggress = oa > 0 && reopened && st > toCall;
  const isBet = h.currentBet === 0;
  const maxTo = b + st;
  let minTo = isBet ? m.cfg.bb : h.currentBet + h.minRaise;
  if (minTo > maxTo) minTo = maxTo; // only an all-in is possible
  return {
    toCall, canCheck: t - b <= 0, canCall: toCall > 0, callAllIn: toCall > 0 && toCall === st,
    canBet: canAggress && isBet, canRaise: canAggress && !isBet, minTo, maxTo,
    canAllIn: (toCall > 0 && st <= toCall) || canAggress,
    currentBet: h.currentBet, bet: b, stack: st, minRaise: h.minRaise,
    pot: h.inHand.reduce((a, x) => a + h.committed[x], 0)
  };
}

function act(m, s, action, amount) {
  const h = m.hand;
  const L = legal(m, s);
  if (!L) return { ok: false, error: 'ليس دورك الآن.' };
  const ev = [];
  const seatAllIn = () => !!h.allIn[s];
  if (action === 'fold') {
    h.folded[s] = true; h.lastAction[s] = { t: 'fold' };
    ev.push({ k: 'act', seat: s, a: 'fold' });
  } else if (action === 'check') {
    if (!L.canCheck) return { ok: false, error: 'لا يمكنك التمرير وعليك مبلغ للمساواة.' };
    h.actedAt[s] = h.currentBet; h.lastAction[s] = { t: 'check' };
    ev.push({ k: 'act', seat: s, a: 'check' });
  } else if (action === 'call' || (action === 'allin' && L.canCall && L.stack <= L.toCall)) {
    if (!L.canCall) return { ok: false, error: 'لا يوجد مبلغ للمساواة.' };
    const paid = pay(m, s, L.toCall);
    h.actedAt[s] = h.currentBet; h.lastAction[s] = { t: 'call', amt: paid, allIn: seatAllIn() };
    ev.push({ k: 'act', seat: s, a: 'call', amount: paid, allIn: seatAllIn() });
  } else if (action === 'bet' || action === 'raise' || action === 'allin') {
    let to;
    if (action === 'allin') {
      if (!L.canAllIn) return { ok: false, error: 'لا يمكنك الدخول بكل رصيدك الآن؛ المتاح لك المساواة أو الانسحاب.' };
      to = L.maxTo;
    } else {
      if (action === 'bet' && !L.canBet) return { ok: false, error: 'الرهان الافتتاحي غير متاح الآن.' };
      if (action === 'raise' && !L.canRaise) return { ok: false, error: 'الرفع غير متاح الآن.' };
      to = toInt(amount);
      if (!Number.isSafeInteger(to)) return { ok: false, error: 'أدخل مبلغًا صحيحًا موجبًا دون كسور.' };
      if (to < L.minTo) return { ok: false, error: 'الحد الأدنى ' + (action === 'bet' ? 'للرهان' : 'للرفع إلى') + ' $' + L.minTo.toLocaleString('en-US') + '.' };
      if (to > L.maxTo) return { ok: false, error: 'المبلغ يتجاوز رصيدك.' };
    }
    const prevBet = h.currentBet;
    const inc = to - prevBet;
    const full = prevBet === 0 ? to >= m.cfg.bb : inc >= h.minRaise;
    if (full) h.minRaise = prevBet === 0 ? to : inc;
    h.currentBet = Math.max(h.currentBet, to);
    const paid = pay(m, s, to - h.bet[s]);
    h.actedAt[s] = to; h.lastAggressor = s;
    if (h.street === 'river') h.riverAggressor = s;
    const kind = prevBet === 0 ? 'bet' : 'raise';
    h.lastAction[s] = { t: kind, amt: paid, to, allIn: seatAllIn() };
    ev.push({ k: 'act', seat: s, a: kind, to, amount: paid, allIn: seatAllIn(), full });
  } else return { ok: false, error: 'إجراء غير معروف.' };

  const rem = contenders(h);
  if (rem.length === 1) {
    returnUncalled(m, ev);
    awardAll(m, rem[0], ev);
  } else {
    const nxt = nextSeat(m, s, (x) => h.inHand.includes(x) && needsAction(h, x));
    if (nxt !== -1) setTurn(m, nxt, ev); else endRound(m, ev);
  }
  assertMoney(m);
  return { ok: true, events: ev };
}

function returnUncalled(m, ev) {
  const h = m.hand;
  const bets = h.inHand.map((s) => [s, h.bet[s]]).sort((a, b) => b[1] - a[1]);
  if (!bets.length) return;
  const [top, tb] = bets[0];
  const second = bets.length > 1 ? bets[1][1] : 0;
  if (tb > second) {
    const r = tb - second;
    h.bet[top] -= r; h.committed[top] -= r; m.seats[top].stack += r;
    if (m.seats[top].stack > 0) h.allIn[top] = false;
    ev.push({ k: 'refund', seat: top, amount: r });
  }
}
function endRound(m, ev) {
  const h = m.hand;
  returnUncalled(m, ev);
  h.toAct = null;
  for (const s of h.inHand) h.bet[s] = 0;
  h.actedAt = {}; h.currentBet = 0; h.minRaise = m.cfg.bb; h.lastAggressor = null;
  const active = h.inHand.filter((s) => isActive(h, s));
  if (h.street === 'river') { h.status = 'showdown'; ev.push({ k: 'roundEnd', street: h.street }); return; }
  if (active.length <= 1) {
    h.status = 'runout'; h.runout = true;
    const seats = contenders(h);
    for (const s of seats) h.shown[s] = true; // all-in and betting closed: hands are tabled
    ev.push({ k: 'roundEnd', street: h.street }, { k: 'reveal', seats });
    return;
  }
  h.status = 'between';
  ev.push({ k: 'roundEnd', street: h.street });
}
function dealStreet(m) {
  const h = m.hand;
  if (!h || (h.status !== 'between' && h.status !== 'runout')) throw new Error('cannot deal street now');
  h.burned.push(h.deck.pop()); // burn card, never revealed
  h.street = STREETS[STREETS.indexOf(h.street) + 1];
  const n = h.street === 'flop' ? 3 : 1, cards = [];
  for (let i = 0; i < n; i++) { const c = h.deck.pop(); h.board.push(c); cards.push(c); }
  const ev = [{ k: 'street', street: h.street, cards }];
  h.lastAction = {};
  if (h.status === 'runout') { if (h.street === 'river') h.status = 'showdown'; return ev; }
  h.status = 'betting';
  const first = nextSeat(m, h.btnPos, (x) => h.inHand.includes(x) && needsAction(h, x));
  if (first === -1) endRound(m, ev); else setTurn(m, first, ev);
  return ev;
}

function buildPots(h) {
  const cs = h.inHand.map((s) => ({ s, c: h.committed[s], f: !!h.folded[s] }));
  const levels = [...new Set(cs.filter((x) => !x.f && x.c > 0).map((x) => x.c))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const L of levels) {
    let amt = 0;
    for (const x of cs) amt += Math.max(0, Math.min(x.c, L) - prev);
    const eligible = cs.filter((x) => !x.f && x.c >= L).map((x) => x.s);
    if (amt > 0) pots.push({ amount: amt, eligible });
    prev = L;
  }
  const total = cs.reduce((a, x) => a + x.c, 0), sum = pots.reduce((a, p) => a + p.amount, 0);
  if (total > sum) {
    if (pots.length) pots[pots.length - 1].amount += total - sum;
    else pots.push({ amount: total - sum, eligible: contenders(h) });
  }
  const merged = [];
  for (const p of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.length === p.eligible.length && last.eligible.every((x, i) => x === p.eligible[i])) last.amount += p.amount;
    else merged.push({ amount: p.amount, eligible: p.eligible.slice() });
  }
  return merged;
}
const potLabel = (i) => (i === 0 ? 'القدر الرئيسي' : 'القدر الجانبي ' + i);

function seatsFromButton(m, list) { // clockwise order starting with first seat left of the button
  const h = m.hand, out = [];
  let s = h.btnPos;
  for (let k = 0; k < m.seats.length; k++) { s = (s + 1) % m.seats.length; if (list.includes(s)) out.push(s); }
  return out;
}
function awardAll(m, w, ev) {
  const h = m.hand;
  const amount = h.inHand.reduce((a, s) => a + h.committed[s], 0);
  m.seats[w].stack += amount;
  h.results = { byFold: true, pots: [{ label: 'القدر', amount, winners: [{ seat: w, amount }], eligible: [w] }], hands: {} };
  ev.push({ k: 'win', byFold: true, seat: w, amount });
  finishHand(m, ev);
}
function showdown(m) {
  const h = m.hand;
  if (!h || h.status !== 'showdown') throw new Error('not at showdown');
  const ev = [];
  const cont = contenders(h);
  const evals = {};
  for (const s of cont) evals[s] = bestHand(h.hole[s].concat(h.board));
  const pots = buildPots(h);
  const tableAll = h.runout || cont.some((s) => h.allIn[s]);
  // showing order: last river aggressor, otherwise first player left of the button
  const ordered = seatsFromButton(m, cont);
  let start = h.riverAggressor != null && cont.includes(h.riverAggressor) ? ordered.indexOf(h.riverAggressor) : 0;
  const order = ordered.slice(start).concat(ordered.slice(0, start));
  const bestShown = pots.map(() => null);
  for (const s of order) {
    let show = tableAll;
    if (!show) {
      show = pots.some((p, i) => p.eligible.length > 1 && p.eligible.includes(s) && (!bestShown[i] || cmpScore(evals[s], bestShown[i]) >= 0));
    }
    if (show) {
      h.shown[s] = true;
      pots.forEach((p, i) => { if (p.eligible.includes(s) && (!bestShown[i] || cmpScore(evals[s], bestShown[i]) > 0)) bestShown[i] = evals[s]; });
    } else h.mucked[s] = true;
  }
  const potResults = [];
  pots.forEach((p, i) => {
    let best = null, winners = [];
    for (const s of p.eligible) {
      const c = best ? cmpScore(evals[s], best) : 1;
      if (c > 0) { best = evals[s]; winners = [s]; } else if (c === 0) winners.push(s);
    }
    const ordW = seatsFromButton(m, winners);
    const share = Math.floor(p.amount / ordW.length);
    let rem = p.amount - share * ordW.length;
    const ws = ordW.map((s) => { const a = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; m.seats[s].stack += a; return { seat: s, amount: a }; });
    potResults.push({ label: potLabel(i), amount: p.amount, eligible: p.eligible, winners: ws, uncontested: p.eligible.length === 1 });
  });
  const hands = {};
  for (const s of cont) if (h.shown[s]) hands[s] = { name: evals[s].name, en: evals[s].en, desc: evals[s].desc, best: evals[s].cards, cat: evals[s].cat };
  h.results = { byFold: false, pots: potResults, hands, mucked: Object.keys(h.mucked).map(Number) };
  ev.push({ k: 'showdown', shown: Object.keys(h.shown).map(Number), mucked: h.results.mucked });
  ev.push({ k: 'win', byFold: false, pots: potResults.map((p) => ({ label: p.label, amount: p.amount, winners: p.winners })) });
  finishHand(m, ev);
  return ev;
}
function finishHand(m, ev) {
  const h = m.hand;
  h.status = 'done'; h.toAct = null;
  for (const s of h.inHand) h.bet[s] = 0;
  const busted = [];
  for (const s of h.inHand) if (m.seats[s].stack === 0) { m.seats[s].busted = true; busted.push(s); }
  let t = 0; for (const s of m.seats) t += s.stack;
  if (t !== m.total) throw new Error('Money invariant broken at payout: ' + t);
  ev.push({ k: 'handOver', no: h.no, busted });
  const liveSeats = m.seats.map((_, i) => i).filter((i) => live(m, i));
  if (liveSeats.length <= 1) { m.over = true; m.winner = liveSeats[0]; ev.push({ k: 'matchOver', winner: m.winner }); }
}
function autoAction(m) {
  const h = m.hand, L = legal(m, h.toAct);
  return L && L.canCheck ? 'check' : 'fold';
}

module.exports = {
  CAT, CAT_EN, STREETS, rankLabel, newDeck, shuffle, eval5, cmpScore, bestHand, describe,
  validateSettings, createMatch, computePositions, startHand, legal, act, dealStreet, showdown,
  buildPots, potLabel, moneyTotal, assertMoney, autoAction, needsAction, toInt
};
