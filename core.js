/* Orbit core: dates, cycle predictions, moon math and all the playful copy.
   Plain script so the page and the service worker can both load it. */
(function (root) {
  'use strict';
  const DAY = 86400000;

  // ---------- dates (local, YYYY-MM-DD) ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function key(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); }
  function addDays(k, n) { const d = parse(k); d.setDate(d.getDate() + n); return key(d); }
  function diff(a, b) { return Math.round((parse(a) - parse(b)) / DAY); } // a - b in days
  function todayKey() { return key(new Date()); }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function pick(arr, seed) { return arr[hash(String(seed)) % arr.length]; }

  // ---------- moon ----------
  // Fraction of the synodic month: 0 new, 0.5 full.
  function moonFraction(k) {
    const d = parse(k);
    const jd = d.getTime() / DAY + 2440587.5;
    let f = ((jd - 2451550.1) / 29.530588853) % 1;
    if (f < 0) f += 1;
    return f;
  }
  const MOON_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  function moonName(f) { return MOON_NAMES[Math.floor(((f + 1 / 16) % 1) * 8)]; }

  // ---------- cycle ----------
  const FLOW = ['spotting', 'light', 'medium', 'heavy'];
  function flowDays(days) {
    return Object.keys(days || {}).filter(k => days[k] && ['light', 'medium', 'heavy'].includes(days[k].flow)).sort();
  }
  function periodsFrom(state) {
    const list = flowDays(state.days);
    const periods = [];
    for (const k of list) {
      const last = periods[periods.length - 1];
      if (last && diff(k, last.end) <= 2) last.end = k; else periods.push({ start: k, end: k });
    }
    const p = state.profile || {};
    if (p.anchorStart) {
      const near = periods.some(x => Math.abs(diff(x.start, p.anchorStart)) <= 4 || (diff(p.anchorStart, x.start) >= 0 && diff(p.anchorStart, x.end) <= 0));
      if (!near) {
        periods.push({ start: p.anchorStart, end: addDays(p.anchorStart, (p.periodLen || 5) - 1), synthetic: true });
        periods.sort((a, b) => (a.start < b.start ? -1 : 1));
      }
    }
    return periods;
  }
  function stats(state) {
    const p = state.profile || {};
    const periods = periodsFrom(state);
    const gaps = [];
    for (let i = 1; i < periods.length; i++) {
      const g = diff(periods[i].start, periods[i - 1].start);
      if (g >= 18 && g <= 60) gaps.push(g);
    }
    const recent = gaps.slice(-6);
    let cycleLen = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : (p.cycleLen || 28);
    cycleLen = Math.max(20, Math.min(45, cycleLen));
    const lens = periods.filter(x => !x.synthetic).map(x => diff(x.end, x.start) + 1).filter(n => n >= 2 && n <= 10).slice(-6);
    let periodLen = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : (p.periodLen || 5);
    periodLen = Math.max(2, Math.min(10, periodLen));
    const variation = recent.length >= 2 ? Math.max(...recent) - Math.min(...recent) : null;
    return { periods, cycleLen, periodLen, cyclesLogged: recent.length, variation };
  }

  const PHASES = {
    menstrual: { name: 'Menstrual', emoji: '🌑', color: '#ff4d7e', season: 'Inner winter' },
    follicular: { name: 'Follicular', emoji: '🌒', color: '#ff9bd2', season: 'Inner spring' },
    ovulation: { name: 'Ovulation', emoji: '🌕', color: '#ffd166', season: 'Inner summer' },
    luteal: { name: 'Luteal', emoji: '🌘', color: '#a78bfa', season: 'Inner autumn' },
  };

  function ovDay(L, P) { return Math.max(P + 3, L - 14); }
  function phaseFor(cd, L, P) {
    const ov = ovDay(L, P);
    if (cd <= P) return 'menstrual';
    if (cd < ov - 1) return 'follicular';
    if (cd <= ov + 1) return 'ovulation';
    return 'luteal';
  }

  // Everything the app needs to know about one date.
  function info(state, k, st) {
    st = st || stats(state);
    const t = todayKey();
    const L = st.cycleLen, P = st.periodLen;
    const starts = st.periods.map(x => x.start);
    if (!starts.length) return null;
    const lastBefore = (d) => { let s = null; for (const x of starts) if (x <= d) s = x; return s; };
    let start, predicted = false;
    const cur = lastBefore(t);
    if (k <= t || !cur) {
      start = lastBefore(k);
      if (!start) {
        // before the first logged period: project backwards
        const first = starts[0];
        const back = Math.ceil(diff(first, k) / L);
        start = addDays(first, -back * L);
        predicted = true;
      }
    } else {
      let nxt = addDays(cur, L);
      if (nxt <= t) nxt = addDays(t, 1);
      if (k < nxt) start = cur;
      else { start = addDays(nxt, Math.floor(diff(k, nxt) / L) * L); predicted = true; }
    }
    const cd = diff(k, start) + 1;
    const ov = ovDay(L, P);
    let late = 0;
    if (k <= t && cd > L) late = cd - L;
    const phase = late ? 'luteal' : phaseFor(cd, L, P);
    const logged = state.days && state.days[k] && state.days[k].flow;
    const isLoggedPeriod = !!(logged && logged !== 'spotting');
    let isPeriod;
    const inRange = st.periods.some(x => k >= x.start && k <= x.end);
    if (k < t) isPeriod = isLoggedPeriod || inRange;
    else if (k === t) {
      const curP = st.periods.find(x => x.start === start);
      const ongoing = !curP || curP.synthetic || diff(t, curP.end) <= 1;
      isPeriod = isLoggedPeriod || inRange || (cd <= P && !late && ongoing);
    }
    else isPeriod = cd <= P;
    const fertile = !late && cd >= ov - 5 && cd <= ov + 1;
    return { key: k, cycleDay: cd, start, cycleLen: L, periodLen: P, ovDay: ov, phase, late, predicted, isPeriod, isLoggedPeriod, isPredictedPeriod: !isLoggedPeriod && isPeriod && k > t, fertile, isOvulation: !late && cd === ov };
  }

  function nextPeriod(state, st) {
    st = st || stats(state);
    const t = todayKey();
    const i = info(state, t, st);
    if (!i) return null;
    if (i.late) return { inDays: -i.late, date: addDays(t, 0), late: i.late };
    if (i.isLoggedPeriod || (i.cycleDay <= i.periodLen && i.isPeriod)) {
      return { inDays: 0, onPeriod: true, periodDay: i.cycleDay, date: addDays(i.start, st.cycleLen) };
    }
    const date = addDays(i.start, st.cycleLen);
    return { inDays: diff(date, t), date };
  }

  // ---------- hormones (stylised, for illustration only) ----------
  function g(x, mu, s) { return Math.exp(-0.5 * ((x - mu) / s) ** 2); }
  function hormones(cd, L, P) {
    const ov = ovDay(L, P);
    return {
      estrogen: 0.14 + 0.86 * g(cd, ov - 1, 2.6) + 0.42 * g(cd, ov + 7, 3.6),
      progesterone: 0.05 + 0.92 * g(cd, ov + 7, 3.3),
      lh: 0.06 + 0.94 * g(cd, ov, 0.9),
      fsh: 0.14 + 0.32 * g(cd, 3, 3) + 0.46 * g(cd, ov, 1.25),
    };
  }

  function energyLevel(i) {
    if (!i) return 3;
    if (i.phase === 'menstrual') return i.cycleDay <= 2 ? 1 : 2;
    if (i.phase === 'follicular') return 4;
    if (i.phase === 'ovulation') return 5;
    return i.cycleDay > i.cycleLen - 5 || i.late ? 2 : 3;
  }

  // ---------- copy ----------
  const VIBES = {
    menstrual: [
      "Your hormones just hit the reset button. Today you're a blanket burrito wearing a tiny crown.",
      'Estrogen and progesterone both clocked out. You have permission to do the same.',
      'Low tide in the hormone ocean. Soft lights, warm snacks, zero apologies.',
      'Your body is doing a full renovation. Supervisors are allowed to lie down.',
      "Today's forecast: 90% chance of heating pad with scattered chocolate.",
      'You are a candle in a storm: small, warm and absolutely not to be messed with.',
    ],
    follicular: [
      'Estrogen is climbing and so are you. Fresh-start energy unlocked.',
      "You're a phone at 80% and still charging. Say yes to the plan.",
      "The brain fog is lifting and curiosity is rising. You're basically a brand new browser tab.",
      "It's springtime on the inside. Plant an idea and watch it sprout.",
      'Your hormones are hyping you up like a best friend in a party bathroom.',
      'You are a shooting star with a to-do list, and you might actually finish it.',
    ],
    ovulation: [
      'Peak estrogen, peak glow. You are a disco ball in human form.',
      'Confidence is at full moon. Send the text. Wear the outfit.',
      "You're magnetic today. Things are literally falling into your orbit.",
      'Your face is doing that thing where every light is good lighting.',
      'Main character arc: now streaming.',
      'You are a supernova in a cute top. Handle with sunglasses.',
    ],
    luteal: [
      'Progesterone is running the show, and it wants snacks and a nap. Respect the boss.',
      'Your patience bar is shorter than usual. Guard it like a phone at 5%.',
      'Nesting mode: on. Clean sheets and comfort shows count as self-care.',
      'Cravings are part of the package this week. Feed the beast, and toss in a vegetable.',
      "Feelings are turned up loud this week. Loud doesn't mean wrong.",
      'Late-cycle you is a cozy introvert with a short fuse and impeccable taste.',
    ],
  };

  const CARDS = {
    menstrual: {
      diet: ['Warm, iron-rich comfort: lentil soup, leafy greens, a little red meat if you eat it.', 'Ginger tea and warm meals are easy on a grumpy gut today.', 'Hydrate like it is your job. Bonus points for something warm.'],
      move: ['Gentle stretching or a slow walk. Rest counts as training today.', 'Restorative yoga or a cozy walk around the block.', 'Skip the PR attempts. Light movement, lots of breathing.'],
      glow: ['Skin can be extra sensitive. Keep it simple: gentle cleanser, rich moisturizer.', 'Hair mask and an early night. Low effort, high reward.', 'A warm bath and a face mask count as maintenance.'],
      mind: ['Your inner critic is loud right now. Talk back gently.', 'Great time to journal and look back on the last month.', 'Say no to one thing today. It feels good.'],
      body: ['Heat on the belly or lower back can take the edge off cramps.', 'Your energy is at its lowest. Plan the easy version of today.', 'Iron and water are your two best friends this week.'],
      note: "Hormones are at their lowest, so it's normal to feel more tired and inward. It's a natural reset.",
    },
    follicular: {
      diet: ['Fresh and crunchy: salads, fermented foods, citrus. Your gut likes variety now.', 'Lean protein and colorful veg to fuel the energy comeback.', 'Try a new recipe. Your brain is in the mood for novelty.'],
      move: ['Energy is building. Good week to try a new class or up the intensity.', 'Cardio, dance or a run feel easier now.', 'Strength training hits different this phase. Go for it.'],
      glow: ['Skin is usually calmer and brighter. Good week to try a new product.', 'Exfoliate gently and let the glow do its thing.', 'Low-maintenance glow season. Keep up the SPF.'],
      mind: ['Your brain is hungry for new stuff. Start the project, learn the thing.', 'Brainstorm now and sort it out later.', 'Social battery is recharging. Make plans.'],
      body: ['Energy and stamina are climbing day by day.', 'You may bounce back faster from workouts right now.', 'Appetite tends to be steadier this week.'],
      note: 'Estrogen rises as your body gets ready to ovulate. Energy, mood and motivation usually climb with it.',
    },
    ovulation: {
      diet: ['Light and fresh: veggies, fiber and plenty of water.', 'Fiber-rich foods help your body process the estrogen peak.', 'Snack on fruit and nuts to keep the high energy steady.'],
      move: ['Peak power. HIIT, heavy lifts or a big hike.', 'Group workouts or sports. You are feeling social and strong.', 'Go for the personal best. Warm up properly first.'],
      glow: ['Natural glow is at its peak. Let the skin breathe.', 'Minimal makeup day. You do not need much.', 'Oil can creep up. A light moisturizer is plenty.'],
      mind: ['Communication is on point. Have the big conversation.', 'Confidence is high. Pitch the idea, ask for the thing.', 'Great day for dates, interviews and photos.'],
      body: ['Some people feel a twinge on one side around ovulation.', 'Energy and libido often peak around now.', 'Body temperature rises slightly after ovulation.'],
      note: 'An egg gets released and estrogen peaks. Many people feel their most confident and social here.',
    },
    luteal: {
      diet: ['Complex carbs and magnesium (dark chocolate counts) help with cravings.', 'Steady meals help keep mood swings in check.', 'Go easy on salt and caffeine if bloating is showing up.'],
      move: ['Moderate workouts: pilates, swimming, steady cardio.', 'Lower the intensity as the phase goes on. Walks are great.', 'Strength work is still fine. Just give yourself more rest.'],
      glow: ['Breakouts can pop up. Keep pores clear and hands off.', 'Spot treatment on standby. Clay mask night.', 'Skin may get oilier. Lightweight everything.'],
      mind: ['Turn the to-do list into a to-done list. Finish, do not start.', 'Your detail radar is sharp. Great for editing and organizing.', 'Feelings are louder. Pause before you hit send.'],
      body: ['Bloating and tender breasts are common later in this phase.', 'Your body may want more food. That is normal.', 'Sleep can get lighter. Cool, dark room helps.'],
      note: "Progesterone takes the lead after ovulation. Later on, as hormones drop, PMS can show up. It's temporary.",
    },
  };

  const PARTNER_TIPS = {
    menstrual: ['Bring snacks, offer the heating pad, keep plans cozy.', 'Low-key night in. Let them pick the show.', 'Warm drink delivery would be legendary today.'],
    follicular: ['Fresh energy today. Suggest something new to do together.', 'Good day to plan an adventure or a date.', 'They are in a good groove. Hype them up.'],
    ovulation: ['Compliments land extra well today. Plan a date.', 'Peak social energy. Say yes to going out.', 'They are glowing. Tell them.'],
    luteal: ['Extra patience, extra snacks, fewer debates.', 'Handle a chore without being asked.', 'Comfort food and a calm evening go a long way.'],
  };

  const NOTIFY = {
    menstrual: ['🩸 Cycle day {d}. Hydrate, heating pad, and cancel whatever you want.', '🩸 Your uterus filed a complaint. Snacks are officially approved.', '🩸 Low-energy day and that is fine. Be a blanket burrito.'],
    follicular: ["🌱 Energy is coming back online. Good day to start something.", '🌱 Estrogen says: book the thing, text the friend, try the workout.', '🌱 Fresh-start energy. Use it before it wanders off.'],
    ovulation: ['✨ Peak glow alert. You are a whole moment today.', '✨ Confidence at full moon. Go be a little dangerous.', '✨ You are magnetic today. Use your powers for good.'],
    luteal: ['🌘 Luteal mode: snacks are not a personality flaw.', '🌘 Short fuse warning. Protect your peace and your fries.', '🌘 Cozy season. Comfort show, clean sheets, early night.'],
  };

  function notification(state) {
    const st = stats(state);
    const t = todayKey();
    const i = info(state, t, st);
    if (!i) return { title: '🪐 Orbit', body: 'Log your last period so the cosmos can do its thing.' };
    const np = nextPeriod(state, st);
    if (np && np.late) return { title: '🪐 Orbit check-in', body: `Your period is ${np.late} day${np.late > 1 ? 's' : ''} behind the forecast. Bodies wander sometimes. Log it when it shows up.` };
    if (np && !np.onPeriod && np.inDays === 0) return { title: '🔴 Period may start today', body: 'Supplies in the bag? Log it in Orbit when it arrives.' };
    if (np && !np.onPeriod && np.inDays > 0 && np.inDays <= 2) return { title: `⏳ Period in about ${np.inDays} day${np.inDays > 1 ? 's' : ''}`, body: 'Heads up from orbit: pack the kit and stock the snacks.' };
    const line = pick(NOTIFY[i.phase], t + 'n').replace('{d}', i.cycleDay);
    return { title: `${PHASES[i.phase].emoji} ${PHASES[i.phase].name} · Day ${i.cycleDay}`, body: line.replace(/^\S+\s/, '') };
  }

  function decode(state, k) {
    const st = stats(state);
    const i = info(state, k, st);
    if (!i) return null;
    const c = CARDS[i.phase];
    const s = k + (state.profile && state.profile.name || '');
    return {
      info: i,
      vibe: pick(VIBES[i.phase], s + 'v'),
      diet: pick(c.diet, s + 'd'), move: pick(c.move, s + 'm'), glow: pick(c.glow, s + 'g'),
      mind: pick(c.mind, s + 'mi'), body: pick(c.body, s + 'b'), note: c.note,
      partnerTip: pick(PARTNER_TIPS[i.phase], s + 'p'),
      energy: energyLevel(i),
    };
  }

  // ---------- orbit social bits ----------
  const MOODS = ['Sleepy but Sparkly', 'Main Character Energy', 'Soft & Snacky', 'Chaotic but Cute', 'Do Not Perceive Me', 'Running on Iced Coffee', 'Glowing & Going', 'In My Feelings', 'Feral but Fabulous', 'Cozy Hermit Mode', 'Unbothered', 'Spicy Today', 'Busy Being Booked', 'Touch Grass Era'];
  const TITLE_ADJ = {
    menstrual: ['Crimson', 'Ruby', 'Garnet', 'Scarlet'], follicular: ['Rose', 'Coral', 'Peach', 'Blush'],
    ovulation: ['Golden', 'Solar', 'Radiant', 'Gilded'], luteal: ['Violet', 'Indigo', 'Amethyst', 'Midnight'],
    none: ['Silver', 'Starlit', 'Cosmic', 'Lunar', 'Electric', 'Velvet'],
  };
  const TITLE_NOUN = ['Comet', 'Nebula', 'Nova', 'Meteor', 'Galaxy', 'Aurora', 'Eclipse', 'Quasar', 'Starlight', 'Orbit', 'Pulsar', 'Stardust'];
  const TITLE_ROLE = ['Dreamer', 'Oracle', 'Voyager', 'Alchemist', 'Navigator', 'Muse', 'Rebel', 'Captain', 'Wanderer', 'Enchanter', 'Gardener', 'Pilot', 'Strategist', 'Guardian'];
  function cosmicTitle(phase, seed) {
    const adj = TITLE_ADJ[phase] || TITLE_ADJ.none;
    return `${pick(adj, seed + 'a')} ${pick(TITLE_NOUN, seed + 'n')} ${pick(TITLE_ROLE, seed + 'r')}`;
  }

  const LOG = {
    flow: [['spotting', 'Spotting', '💧'], ['light', 'Light', '🩸'], ['medium', 'Medium', '🩸🩸'], ['heavy', 'Heavy', '🌊']],
    feel: [['moody', 'Moody', '🌪️'], ['tears', 'Teary', '😭'], ['anxiety', 'Anxious', '🫨'], ['exhausted', 'Exhausted', '🫠'], ['happy', 'Happy', '😊'], ['calm', 'Calm', '🧘'], ['irritable', 'Irritable', '😤'], ['confident', 'Confident', '💅']],
    crave: [['salty', 'Salty', '🥨'], ['sweet', 'Sweet', '🍭'], ['fried', 'Fried', '🍟'], ['chocolate', 'Chocolate', '🍫'], ['carbs', 'Carbs', '🍝'], ['spicy', 'Spicy', '🌶️']],
    sym: [['cramps', 'Cramps', '⚡'], ['headache', 'Headache', '🤕'], ['bloating', 'Bloating', '🎈'], ['acne', 'Breakout', '🌋'], ['tender', 'Tender chest', '💗'], ['backache', 'Backache', '🦴'], ['nausea', 'Nausea', '🤢'], ['insomnia', 'Bad sleep', '🦉']],
  };

  root.OrbitCore = {
    key, parse, addDays, diff, todayKey, hash, pick, pad,
    moonFraction, moonName, FLOW, flowDays, periodsFrom, stats, info, nextPeriod, phaseFor, ovDay,
    PHASES, hormones, energyLevel, VIBES, CARDS, PARTNER_TIPS, NOTIFY, notification, decode,
    MOODS, cosmicTitle, LOG,
  };
})(typeof self !== 'undefined' ? self : this);
