'use strict';
/* The commentator only ever sees public events (actions, community cards, shown hands, results).
   It never receives hole cards, so it cannot leak hand strength. */
const crypto = require('crypto');

const LINES = {
  matchStart: ['يا هلا ومرحبا! {n} لاعبين، وكل واحد معه {amt}. الطاولة ما ترحم.', 'حياكم الله. الليلة نعرف مين يعرف يكذب بأناقة.', 'بدأت المباراة. ورقتين لكل واحد، ونيات كثيرة.'],
  handStart: ['التوزيع رقم {n}. {btn} على الزر، والإجباري على {sb} و{bb}.', 'توزيع {n}… خلّوا الوجيه ثابتة والقلوب أثبت.', 'وزّعت الأوراق. اللي يبتسم الحين يا واثق يا ممثل.', 'التوزيع {n} بدأ. {bb} دفع الكبير، ونشوف مين يتحرك.'],
  check: ['{p} مرّر… هدوء قبل العاصفة ولا ما عنده شي؟', 'تمرير من {p}. حركة دبلوماسية بامتياز.', '{p} طق الطاولة. لا جديد… أو هذا اللي يبينا نصدقه.', '{p} يلعبها على البارد.'],
  call: ['{p} ساوى {amt}. ما يبي يطلع من السالفة.', 'مساواة من {p}… يا إنه مصدّق، يا إنه فضولي.', '{p} دفع {amt} وسكت. السكوت أحيانًا أخطر من الكلام.'],
  bet: ['{p} افتتح بـ{to}. الحين صار للكلام قيمة.', 'رهان {to} من {p}. مين يبي يدفع ويشوف؟', '{p} حط {to} على الطاولة بكل هدوء.'],
  raise: ['رفع الرهان إلى {to}؟ واضح أن {p} يبي يقنعنا بشيء.', '{p} رفع إلى {to}… الثقة هذي يا إنها ورقة قوية، يا إنها تمثيل ممتاز!', 'رفع من {p}. الكرة الحين في ملعب الباقين.'],
  raiseBig: ['أوووه! {p} رفع إلى {to} مرة وحدة. هذا يا مجنون يا عبقري.', 'رفع ثقيل من {p}! الطاولة صارت تعرق.'],
  allin: ['{p} دخل بكل اللي عنده: {to}! ما في رجعة الحين.', 'كل الفلوس على الطاولة من {p}. هذي اسمها جرأة… أو تهوّر.', 'All-In من {p}! خلّونا نشوف مين قلبه قوي.'],
  fold: ['{p} انسحب. أحيانًا أذكى حركة إنك تطلع.', 'انسحاب تكتيكي من {p}؟ بنمشيها لك هالمرة.', '{p} رمى الورقتين، وأسرارهن راحت معهن.'],
  timeoutFold: ['انتهى وقت {p}، فانسحب تلقائيًا.', '{p} طوّل… والطاولة ما تنتظر. انسحاب تلقائي.'],
  timeoutCheck: ['انتهى وقت {p}، فمرّر تلقائيًا.'],
  flop: ['نزل الفلوب: {cards}. شوفوا وجيه بعض الحين.', 'ثلاث أوراق على الطاولة: {cards}. المؤامرة تتعقد.', 'الفلوب {cards}… فيه ناس ارتاحت وناس انقهرت، وأنا ما أدري مين.'],
  turn: ['ورقة التيرن: {cards}. حسبوها زين.', 'التيرن نزل {cards}. باقي ورقة وحدة على الحسم.'],
  river: ['الريفر: {cards}. آخر فرصة للتمثيل.', 'نزلت آخر ورقة {cards}. الحين كل شي على المكشوف… تقريبًا.'],
  runout: ['ما فيه مزايدة بعد الحين. نكشف الأوراق ونكمل الطاولة!', 'الكل داخل بكل اللي عنده. اكشفوا وخلّوا الورق يتكلم.'],
  winFold: ['{w} يجمع {amt} بدون ما يكشف شي. أحلى فوز.', 'القدر راح لـ{w}، والسر باقي سر.'],
  winShowdown: ['ونكشف! {w} أخذ {amt} بـ«{hand}».', 'الأوراق ما تكذب… حتى لو أصحابها يكذبون. مبروك يا {w}، «{hand}» أخذت {amt}.', '{w} فاز بـ«{hand}». الباقين: لا تزعلون، الدنيا دوّارة.'],
  split: ['تعادل! القدر ينقسم بين {ws}، والكرامة كذلك.', 'نفس القوة بالضبط؟ نص نص يا جماعة.'],
  sidepot: ['قسمة معقدة: {w} أخذ القدر الرئيسي، و{w2} أخذ الجانبي. هذا البوكر يا سادة.', 'أكثر من قدر وأكثر من فائز. {w} و{w2} يطلعون مبسوطين.'],
  busted: ['{p} خلص رصيده وطلع من التوزيعات. يتابع معنا من المدرجات.', 'وداعًا {p}… الطاولة قاسية.'],
  matchOver: ['انتهت المباراة! {w} طلع بكل الفلوس: {amt}.', '{w} بطل الطاولة الليلة. الثأر في المباراة الجاية؟'],
  talk_scary: ['{p} يقول ورقته تخوّف… أنا خفت، بس من الثقة مو من الورقة.', 'تصريح خطير من {p}. نصدّق؟ ما نصدّق؟', '{p}، الكلام ببلاش… الرهان هو اللي يتكلم.'],
  talk_nothing: ['{p} يقول ما عنده شي… وهذا بالضبط اللي يقوله اللي عنده شي.', 'تواضع مريب يا {p}.', 'ما عنده شي؟ هذي أقدم حيلة في الكتاب.'],
  talk_dare: ['{p} يتحدى: جرّب وساوِ. الحين صارت شخصية.', 'تحدي مفتوح من {p}! الطاولة سخنت.', '{p} يستفزكم… لا تاخذونها شخصية. أو خذوها.'],
  disconnect: ['{p} انقطع اتصاله. مقعده محجوز له مؤقتًا.'],
  reconnect: ['{p} رجع للطاولة. هلا والله.'],
  host: ['{p} صار مدير الغرفة الحين.']
};
const TALK = { scary: 'ورقتي تخوّف', nothing: 'ما عندي شيء', dare: 'جرّب وساوِ الرهان' };

const money = (n) => '\u2066$' + Number(n).toLocaleString('en-US') + '\u2069';
const SUIT = { s: '♠\uFE0E', h: '♥\uFE0E', d: '♦\uFE0E', c: '♣\uFE0E' };
const cardText = (c) => (c.v === 14 ? 'A' : c.v === 13 ? 'K' : c.v === 12 ? 'Q' : c.v === 11 ? 'J' : String(c.v)) + SUIT[c.s];

class Bot {
  constructor() { this.bags = {}; this.last = {}; }
  pick(key) {
    const pool = LINES[key];
    if (!pool) return '';
    if (!this.bags[key] || !this.bags[key].length) {
      const idx = pool.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      if (idx.length > 1 && idx[idx.length - 1] === this.last[key]) [idx[0], idx[idx.length - 1]] = [idx[idx.length - 1], idx[0]];
      this.bags[key] = idx;
    }
    const i = this.bags[key].pop();
    this.last[key] = i;
    return pool[i];
  }
  line(key, vars) {
    return '\u200F' + this.pick(key).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? '\u2068' + vars[k] + '\u2069' : ''));
  }
  /* Choose the most meaningful public event of a batch. */
  comment(evs, name, ctx) {
    const by = (k) => evs.filter((e) => e.k === k);
    const mo = by('matchOver')[0];
    if (mo) return this.line('matchOver', { w: name(mo.winner), amt: money(ctx.total) });
    const win = by('win')[0];
    if (win) {
      if (win.byFold) return this.line('winFold', { w: name(win.seat), amt: money(win.amount) });
      const pots = win.pots;
      const allW = [...new Set(pots.flatMap((p) => p.winners.map((w) => w.seat)))];
      if (pots.some((p) => p.winners.length > 1) && allW.length > 1 && pots.length === 1) return this.line('split', { ws: allW.map(name).join(' و') });
      if (pots.length > 1 && allW.length > 1) return this.line('sidepot', { w: name(pots[0].winners[0].seat), w2: name(pots[pots.length - 1].winners[0].seat) });
      const w = allW[0], tot = pots.reduce((a, p) => a + p.amount, 0);
      return this.line('winShowdown', { w: name(w), amt: money(tot), hand: ctx.handName(w) || '' });
    }
    const st = by('street').pop();
    if (st && ctx.runout) return this.line('runout');
    if (st) return this.line(st.street, { cards: st.cards.map(cardText).join(' ') });
    if (by('reveal').length) return this.line('runout');
    const a = by('act').pop();
    if (a) {
      const v = { p: name(a.seat), amt: money(a.amount || 0), to: money(a.to || a.amount || 0) };
      if (a.auto) return this.line(a.a === 'check' ? 'timeoutCheck' : 'timeoutFold', v);
      if (a.allIn && a.a !== 'fold') return this.line('allin', v);
      if (a.a === 'raise') return this.line(a.to >= ctx.bigRaise ? 'raiseBig' : 'raise', v);
      return this.line(a.a, v);
    }
    const hs = by('handStart')[0];
    if (hs) return this.line('handStart', { n: hs.no, btn: name(hs.btn), sb: hs.sb == null ? 'لا أحد' : name(hs.sb), bb: name(hs.bb) });
    return null;
  }
}

module.exports = { Bot, TALK, money, cardText };
