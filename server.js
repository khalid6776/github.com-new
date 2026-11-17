'use strict';
/*
 * Poker Bluff — Hold'em server.
 * One process serves the client (public/index.html) and the WebSocket endpoint (/ws).
 * The server is the single source of truth: deck, hole cards, stacks, turns, bets, results.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const H = require('./holdem');
const { Bot, TALK, money } = require('./bot');

const FAST = process.env.FAST === '1'; // test mode: short delays
const CFG = {
  port: Number(process.env.PORT) || 3000,
  maxPlayers: 7,
  graceMs: Number(process.env.GRACE_MS) || 90000,         // seat kept while disconnected
  hostGraceMs: Number(process.env.HOST_GRACE_MS) || 10000, // host role moves after this
  awayActMs: FAST ? 300 : 2500,
  streetMs: FAST ? 30 : 1100,
  runoutMs: FAST ? 30 : 1500,
  showdownMs: FAST ? 30 : 900,
  resultMs: FAST ? 80 : 8000,
  foldResultMs: FAST ? 60 : 4500,
  idleRoomMs: 30 * 60000,
  actionMsOverride: Number(process.env.ACTION_MS) || 0
};
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const newId = () => crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url');
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 16).join('');
}

class Room {
  constructor(code, settings) {
    this.code = code;
    this.settings = settings;
    this.members = []; // {id, token, name, role, connected, discAt, away, ws, lastTalk}
    this.hostId = null;
    this.status = 'lobby'; // lobby | playing | ended
    this.match = null;
    this.evSeq = 0;
    this.bot = new Bot();
    this.botText = 'أهلًا بكم. شاركوا رمز الغرفة، وابدأوا عندما يكتمل العدد.';
    this.botQuote = null;
    this.timers = { turn: null, turnKey: null, pace: null, paceKey: null };
    this.deadline = null;
    this.nextHandAt = null;
    this.lastActivity = Date.now();
    this.paused = false;
  }
  players() { return this.members.filter((m) => m.role === 'player'); }
  byId(id) { return this.members.find((m) => m.id === id); }
  seatOf(id) { return this.match ? this.match.seats.findIndex((s) => s.id === id) : -1; }
  memberBySeat(s) { return this.match ? this.byId(this.match.seats[s].id) : null; }
  nameOfSeat(s) { return this.match && this.match.seats[s] ? this.match.seats[s].name : '—'; }

  uniqueName(name) {
    let n = name, k = 2;
    while (this.members.some((m) => m.name === n)) n = Array.from(name).slice(0, 13).join('') + ' ' + k++;
    return n;
  }
  addMember(name) {
    const role = this.status === 'lobby' && this.players().length < CFG.maxPlayers ? 'player' : 'spectator';
    const m = { id: newId(), token: newToken(), name: this.uniqueName(name), role, connected: false, discAt: null, away: false, ws: null, lastTalk: 0 };
    this.members.push(m);
    if (!this.hostId) this.hostId = m.id;
    return m;
  }
  attach(m, ws) {
    if (m.ws && m.ws !== ws) { try { m.ws.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
    const wasAway = m.away, wasDisc = !m.connected && m.discAt;
    m.ws = ws; m.connected = true; m.discAt = null; m.away = false;
    ws.room = this; ws.member = m;
    if (wasDisc && this.status === 'playing' && this.seatOf(m.id) !== -1) this.say('reconnect', { p: m.name });
    if (wasAway) this.schedule();
  }
  detach(m, ws) {
    if (m.ws !== ws) return;
    m.ws = null; m.connected = false; m.discAt = Date.now();
    if (this.status === 'playing' && this.seatOf(m.id) !== -1) this.say('disconnect', { p: m.name });
    setTimeout(() => this.checkDisconnected(m.id), CFG.graceMs + 50);
    if (m.id === this.hostId) setTimeout(() => this.checkHost(), CFG.hostGraceMs + 50);
    this.broadcast();
  }
  checkDisconnected(id) {
    const m = this.byId(id);
    if (!m || m.connected || !m.discAt || Date.now() - m.discAt < CFG.graceMs) return;
    if (this.status === 'lobby' || m.role === 'spectator' || this.seatOf(m.id) === -1) this.removeMember(m);
    else { m.away = true; this.schedule(); }
    this.broadcast();
  }
  checkHost() {
    const host = this.byId(this.hostId);
    if (host && host.connected) return;
    this.transferHost();
  }
  transferHost() {
    const cand = this.members.filter((m) => m.connected && m.id !== this.hostId);
    const next = cand.find((m) => m.role === 'player') || cand[0];
    if (next) { this.hostId = next.id; this.say('host', { p: next.name }); this.broadcast(); }
  }
  removeMember(m) {
    this.members = this.members.filter((x) => x !== m);
    if (m.ws) { try { m.ws.close(4001, 'removed'); } catch (e) { /* ignore */ } }
    if (this.hostId === m.id) { this.hostId = null; const n = this.members.find((x) => x.connected && x.role === 'player') || this.members.find((x) => x.connected) || this.members[0]; this.hostId = n ? n.id : null; }
  }
  say(key, vars) { this.botText = this.bot.line(key, vars); this.botQuote = null; }

  /* ---------- views ---------- */
  view(member) {
    const m = this.match, h = m && m.hand;
    const seat = member ? this.seatOf(member.id) : -1;
    const v = {
      code: this.code, status: this.status, hostId: this.hostId, settings: this.settings,
      maxPlayers: CFG.maxPlayers, graceSec: Math.round(CFG.graceMs / 1000), evSeq: this.evSeq,
      members: this.members.map((x) => ({ id: x.id, name: x.name, role: x.role, connected: x.connected, away: x.away, host: x.id === this.hostId, seat: this.seatOf(x.id) })),
      you: member ? { id: member.id, name: member.name, role: member.role, seat, host: member.id === this.hostId } : null,
      bot: { text: this.botText, quote: this.botQuote },
      match: null
    };
    if (!m) return v;
    const done = !h || h.status === 'done';
    v.match = {
      handNo: m.handNo, over: m.over, winner: m.over ? m.winner : null, total: m.total, cfg: m.cfg,
      nextHandAt: this.nextHandAt, paused: this.paused,
      seats: m.seats.map((s, i) => {
        const mem = this.byId(s.id);
        const inHand = !!(h && h.inHand.includes(i));
        return {
          i, id: s.id, name: s.name, stack: s.stack, busted: s.busted,
          connected: !!(mem && mem.connected), away: !!(mem && mem.away),
          inHand, folded: inHand && !!h.folded[i], allIn: inHand && !!h.allIn[i],
          bet: inHand ? h.bet[i] : 0, committed: inHand ? h.committed[i] : 0,
          hasCards: inHand && !h.folded[i],
          shown: inHand && h.shown[i] && !h.folded[i] ? h.hole[i] : null, // only tabled hands are public
          mucked: inHand && !!h.mucked[i],
          last: inHand ? h.lastAction[i] || null : null
        };
      }),
      hand: h ? {
        no: h.no, street: h.street, status: h.status, board: h.board, btn: h.btnPos, sb: h.sbSeat, bb: h.bbSeat,
        toAct: h.toAct, turnId: h.turnId, deadline: h.status === 'betting' ? this.deadline : null,
        currentBet: h.currentBet, pot: h.inHand.reduce((a, s) => a + h.committed[s], 0),
        pots: done ? [] : H.buildPots(h).map((p, i) => ({ label: H.potLabel(i), amount: p.amount, eligible: p.eligible })),
        results: h.results
      } : null,
      hole: h && seat !== -1 && h.inHand.includes(seat) ? h.hole[seat] : null, // your own cards only
      legal: h && seat !== -1 && h.status === 'betting' && h.toAct === seat ? H.legal(m, seat) : null
    };
    return v;
  }
  send(member, msg) {
    const ws = member.ws;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ } }
  }
  broadcast(events) {
    const evs = events || [];
    const now = Date.now();
    for (const mem of this.members) if (mem.ws) this.send(mem, { t: 'state', state: this.view(mem), events: evs, now });
  }
  publish(evs, extra) {
    const out = [];
    for (const e of evs) { this.evSeq += 1; out.push(Object.assign({ id: this.evSeq }, e, extra || {})); }
    const m = this.match, h = m && m.hand;
    const txt = this.bot.comment(out, (s) => this.nameOfSeat(s), {
      total: m ? m.total : 0, runout: !!(h && h.runout),
      bigRaise: h ? Math.max(m.cfg.bb * 8, h.inHand.reduce((a, s) => a + h.committed[s], 0)) : 0,
      handName: (s) => (h && h.results && h.results.hands[s] ? h.results.hands[s].name : '')
    });
    if (txt) { this.botText = txt; this.botQuote = null; }
    const busted = out.filter((e) => e.k === 'handOver').flatMap((e) => e.busted);
    if (busted.length && !(m && m.over)) this.botText += ' ' + this.bot.line('busted', { p: busted.map((s) => this.nameOfSeat(s)).join(' و') });
    this.lastActivity = Date.now();
    return out;
  }

  /* ---------- flow ---------- */
  start(member) {
    if (member.id !== this.hostId) return 'فقط مدير الغرفة يبدأ المباراة.';
    if (this.status !== 'lobby') return 'المباراة بدأت بالفعل.';
    const ps = this.players();
    if (ps.length < 2) return 'يلزم لاعبان على الأقل.';
    this.match = H.createMatch(Object.assign({}, this.settings, { players: ps.map((p) => ({ id: p.id, name: p.name })) }));
    this.status = 'playing';
    this.say('matchStart', { n: ps.length, amt: money(this.settings.startStack) });
    this.nextHand();
    return null;
  }
  nextHand() {
    const m = this.match;
    if (!m || m.over) return;
    if (!this.match.seats.some((s) => { const mem = this.byId(s.id); return mem && mem.connected; })) { this.paused = true; this.broadcast(); return; }
    this.paused = false; this.nextHandAt = null;
    const keepText = m.handNo === 0 ? this.botText : null;
    const evs = this.publish(H.startHand(m));
    if (keepText) this.botText = keepText;
    this.broadcast(evs);
    this.schedule();
  }
  resumeIfPaused() { if (this.paused && this.status === 'playing') { this.paused = false; this.nextHand(); } }
  schedule() {
    const m = this.match, h = m && m.hand;
    if (!h) return;
    // turn timer
    if (h.status === 'betting' && h.toAct != null) {
      const mem = this.memberBySeat(h.toAct);
      const away = !mem || mem.away;
      const key = h.no + ':' + h.turnId + ':' + (away ? 'a' : 'n');
      if (this.timers.turnKey !== key) {
        clearTimeout(this.timers.turn);
        const ms = away ? CFG.awayActMs : (CFG.actionMsOverride || this.settings.actionSecs * 1000);
        this.deadline = Date.now() + ms;
        const turnId = h.turnId, no = h.no;
        this.timers.turnKey = key;
        this.timers.turn = setTimeout(() => this.onTimeout(no, turnId), ms);
      }
    } else { clearTimeout(this.timers.turn); this.timers.turnKey = null; this.deadline = null; }
    // pacing timers
    const pk = h.no + ':' + h.status + ':' + h.street;
    if (this.timers.paceKey === pk) return;
    clearTimeout(this.timers.pace); this.timers.paceKey = pk;
    if (h.status === 'between' || h.status === 'runout') {
      this.timers.pace = setTimeout(() => this.step('street', pk), h.status === 'runout' ? CFG.runoutMs : CFG.streetMs);
    } else if (h.status === 'showdown') {
      this.timers.pace = setTimeout(() => this.step('showdown', pk), CFG.showdownMs);
    } else if (h.status === 'done') {
      if (m.over) { this.status = 'ended'; this.nextHandAt = null; return; }
      const d = h.results && h.results.byFold ? CFG.foldResultMs : CFG.resultMs;
      this.nextHandAt = Date.now() + d;
      this.timers.pace = setTimeout(() => this.step('next', pk), d);
    }
  }
  step(kind, pk) {
    const h = this.match && this.match.hand;
    if (!h || this.timers.paceKey !== pk) return;
    this.timers.paceKey = null;
    let evs = [];
    try {
      if (kind === 'street') evs = H.dealStreet(this.match);
      else if (kind === 'showdown') evs = H.showdown(this.match);
      else if (kind === 'next') { this.nextHand(); return; }
    } catch (e) { console.error('[' + this.code + '] step error', e); return; }
    const out = this.publish(evs);
    this.schedule();
    this.broadcast(out);
  }
  onTimeout(no, turnId) {
    const m = this.match, h = m && m.hand;
    if (!h || h.no !== no || h.turnId !== turnId || h.status !== 'betting') return;
    const seat = h.toAct;
    const a = H.autoAction(m);
    const r = H.act(m, seat, a);
    if (!r.ok) return;
    r.events.forEach((e) => { if (e.k === 'act') e.auto = true; });
    const out = this.publish(r.events);
    this.schedule();
    this.broadcast(out);
  }
  handleAct(member, msg) {
    const m = this.match, h = m && m.hand;
    const seat = this.seatOf(member.id);
    if (!h || h.status !== 'betting') return 'لا توجد مزايدة الآن.';
    if (seat === -1 || h.toAct !== seat) return 'ليس دورك.';
    if (msg.turnId !== h.turnId) return null; // stale or duplicate request: ignored silently
    const r = H.act(m, seat, String(msg.action || ''), msg.amount);
    if (!r.ok) return r.error;
    const out = this.publish(r.events);
    this.schedule();
    this.broadcast(out);
    return null;
  }
  talk(member, phrase) {
    if (!TALK[phrase]) return;
    const seat = this.seatOf(member.id);
    const h = this.match && this.match.hand;
    if (seat === -1 || !h || !h.inHand.includes(seat) || h.folded[seat] || h.status === 'done') return;
    const now = Date.now();
    if (now - member.lastTalk < 4000) return;
    member.lastTalk = now;
    this.botQuote = member.name + ': «' + TALK[phrase] + '»';
    this.botText = this.bot.line('talk_' + phrase, { p: member.name });
    const out = this.publish([{ k: 'talk', seat, phrase }]);
    this.botQuote = member.name + ': «' + TALK[phrase] + '»';
    this.broadcast(out);
  }
  newMatch(member) {
    if (member.id !== this.hostId) return 'فقط مدير الغرفة يبدأ مباراة جديدة.';
    if (this.status !== 'ended') return 'المباراة الحالية لم تنتهِ.';
    clearTimeout(this.timers.turn); clearTimeout(this.timers.pace);
    this.timers = { turn: null, turnKey: null, pace: null, paceKey: null };
    this.match = null; this.status = 'lobby'; this.nextHandAt = null; this.paused = false;
    this.members = this.members.filter((x) => x.connected);
    let n = 0;
    for (const x of this.members) { x.away = false; x.role = n < CFG.maxPlayers ? 'player' : 'spectator'; if (x.role === 'player') n++; }
    this.botText = 'مباراة جديدة! مدير الغرفة يحدد الإعدادات، والباقي يجهزون أعصابهم.';
    this.broadcast();
    return null;
  }
  destroy() { clearTimeout(this.timers.turn); clearTimeout(this.timers.pace); for (const m of this.members) if (m.ws) { try { m.ws.close(4002, 'room closed'); } catch (e) { /* ignore */ } } }
}

/* ---------- HTTP (static client) ---------- */
// Flat layout: only index.html is ever served; source files are never exposed.
const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
function err(ws, msg, code) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', msg, code: code || null })); }

wss.on('connection', (ws) => {
  ws.isAlive = true; ws.msgTimes = [];
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    const now = Date.now();
    ws.msgTimes = ws.msgTimes.filter((t) => now - t < 1000); ws.msgTimes.push(now);
    if (ws.msgTimes.length > 20) return; // rate limit
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    try { handle(ws, msg); } catch (e) { console.error('handler error', e); err(ws, 'حدث خطأ غير متوقع.'); }
  });
  ws.on('close', () => { if (ws.room && ws.member) ws.room.detach(ws.member, ws); });
});

function handle(ws, msg) {
  if (msg.t === 'ping') { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pong', now: Date.now() })); return; }
  if (msg.t === 'create') {
    if (ws.member) return err(ws, 'أنت داخل غرفة بالفعل.');
    const name = cleanName(msg.name);
    if (!name) return err(ws, 'اكتب اسمك.');
    const v = H.validateSettings(msg.settings);
    if (!v.ok) return err(ws, v.error);
    const room = new Room(newCode(), v.settings);
    rooms.set(room.code, room);
    const m = room.addMember(name);
    room.attach(m, ws);
    ws.send(JSON.stringify({ t: 'welcome', code: room.code, token: m.token, id: m.id }));
    room.broadcast();
    return;
  }
  if (msg.t === 'join') {
    if (ws.member) return err(ws, 'أنت داخل غرفة بالفعل.');
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) return err(ws, 'لا توجد غرفة بهذا الرمز.', 'no_room');
    let m = null;
    if (typeof msg.token === 'string' && msg.token) m = room.members.find((x) => x.token === msg.token) || null;
    if (!m) {
      if (msg.token && !msg.name) return err(ws, 'انتهت جلستك في هذه الغرفة. ادخل باسمك من جديد.', 'stale_token');
      const name = cleanName(msg.name);
      if (!name) return err(ws, 'اكتب اسمك.');
      m = room.addMember(name);
    }
    room.attach(m, ws);
    ws.send(JSON.stringify({ t: 'welcome', code: room.code, token: m.token, id: m.id }));
    room.broadcast();
    room.resumeIfPaused();
    return;
  }
  const room = ws.room, member = ws.member;
  if (!room || !member) return err(ws, 'ادخل إلى غرفة أولًا.');
  let e = null;
  switch (msg.t) {
    case 'settings': {
      if (member.id !== room.hostId) { e = 'فقط مدير الغرفة يعدّل الإعدادات.'; break; }
      if (room.status !== 'lobby') { e = 'الإعدادات ثابتة بعد بدء المباراة.'; break; }
      const v = H.validateSettings(msg.settings);
      if (!v.ok) { e = v.error; break; }
      room.settings = v.settings; room.broadcast();
      break;
    }
    case 'start': e = room.start(member); break;
    case 'act': e = room.handleAct(member, msg); break;
    case 'talk': room.talk(member, String(msg.phrase || '')); break;
    case 'newMatch': e = room.newMatch(member); break;
    case 'leave': {
      if (room.status === 'playing' && room.seatOf(member.id) !== -1) { e = 'لا يمكن مغادرة مقعدك أثناء المباراة.'; break; }
      room.removeMember(member); ws.room = null; ws.member = null;
      room.broadcast();
      break;
    }
    default: break;
  }
  if (e) err(ws, e);
}

// keep-alive + idle room cleanup
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) { /* ignore */ } }
  const now = Date.now();
  for (const [code, r] of rooms) if (!r.members.some((m) => m.connected) && now - r.lastActivity > CFG.idleRoomMs) { r.destroy(); rooms.delete(code); }
}, 30000).unref();

if (require.main === module) server.listen(CFG.port, () => console.log('Poker Bluff server on http://localhost:' + CFG.port));
module.exports = { server, rooms, CFG };
