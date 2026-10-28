/* Orbit app. Cycle data lives in this phone's storage only. */
(function () {
  'use strict';
  const C = window.OrbitCore, CFG = window.ORBIT_CONFIG || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = 'orbit.v1', LSA = 'orbit.acct';
  const SOCIAL = !!(CFG.SOCIAL && CFG.API);
  const FALLBACK_SPELLS = { choc: { e: '🍫', name: 'Chocolate Summoning' }, cuddle: { e: '🫂', name: 'Cuddle Charm' }, snack: { e: '🍟', name: 'Snack Portal' }, quiet: { e: '🤫', name: 'Cone of Calm' }, tea: { e: '🫖', name: 'Warm Mug Hex' }, heat: { e: '🔥', name: 'Heating Pad Rune' }, date: { e: '🌹', name: 'Date Night Glow' }, love: { e: '💜', name: 'Love Beam' } };
  const PARTNER_LINE = { menstrual: 'Low battery, high comfort needs.', follicular: 'Energy rising and up for new things.', ovulation: 'Peak glow and social energy.', luteal: 'Cozy mode. The fuse gets shorter later on.' };
  const HORMONE_TEXT = {
    menstrual: 'Estrogen and progesterone are at their lowest. FSH starts nudging the next cycle awake.',
    follicular: 'Estrogen climbs steadily while a follicle matures. Energy and mood usually rise with it.',
    ovulation: 'LH spikes and estrogen peaks. This is the brief window when an egg is released.',
    luteal: 'Progesterone rises and leads. If no pregnancy happens, both hormones fall near the end and the next period begins.',
  };

  // ---------- storage ----------
  function fresh() { return { profile: null, days: {}, settings: { shareForecast: true, shareCountdown: false, notifyHour: 9, notifyMin: 0 }, orbit: { mood: null, titleSeed: 0 } }; }
  function load() { try { const s = JSON.parse(localStorage.getItem(LS)); if (s && typeof s === 'object') return Object.assign(fresh(), s); } catch (e) {} return fresh(); }
  let S = load();
  let A = (() => { try { return JSON.parse(localStorage.getItem(LSA)); } catch (e) { return null; } })();
  function idbPut(k, v) {
    try {
      const open = indexedDB.open('orbit', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => { try { open.result.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) {} };
    } catch (e) {}
  }
  function save(sync) {
    localStorage.setItem(LS, JSON.stringify(S));
    idbPut('state', { profile: S.profile, days: S.days });
    if (sync !== false) scheduleSync();
  }
  function saveAcct() { if (A) localStorage.setItem(LSA, JSON.stringify(A)); else localStorage.removeItem(LSA); }

  // ---------- ui state ----------
  const today = () => C.todayKey();
  let tab = (location.hash || '').replace('#', '').split('=')[0] || 'today';
  let logDate = today();
  let calY = new Date().getFullYear(), calM = new Date().getMonth();
  let scrub = null;
  let orbit = null; // server view
  let spells = FALLBACK_SPELLS;
  let vapidKey = null;
  let onb = { step: 0 };
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const pend = /join=([A-Za-z0-9]+)/.exec(location.hash || '');
  if (pend) { S.pendingJoin = pend[1].toUpperCase(); save(false); history.replaceState(null, '', location.pathname); tab = 'orbit'; }

  function toast(msg) {
    const old = $('.toast'); if (old) old.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  function fmt(k, opts) { return C.parse(k).toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric' }); }
  function fmtTime(h) { h = ((h % 24) + 24) % 24; const hh = Math.floor(h), mm = Math.round((h - hh) * 60 / 15) * 15; const d = new Date(2000, 0, 1, hh, mm % 60 === 0 && mm === 60 ? 0 : mm); if (mm === 60) d.setHours(hh + 1, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  const initial = (n) => esc((n || '?').trim().charAt(0).toUpperCase());

  // ---------- moon svg ----------
  function moon(cx, cy, r, f, lit, dark) {
    f = ((f % 1) + 1) % 1;
    const k = Math.cos(2 * Math.PI * f), rx = Math.abs(k) * r;
    const top = `${cx} ${cy - r}`, bot = `${cx} ${cy + r}`;
    let d;
    if (f < 0.5) d = `M${top} A${r} ${r} 0 0 1 ${bot} A${rx} ${r} 0 0 ${k > 0 ? 0 : 1} ${top}Z`;
    else d = `M${top} A${r} ${r} 0 0 0 ${bot} A${rx} ${r} 0 0 ${k > 0 ? 1 : 0} ${top}Z`;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${dark || 'rgba(255,255,255,.1)'}"/>` + (f > 0.015 && f < 0.985 ? `<path d="${d}" fill="${lit}"/>` : '');
  }
  function moonIcon(f, lit, size) { return `<svg class="moon" viewBox="0 0 20 20" width="${size || 16}" height="${size || 16}">${moon(10, 10, 8.5, f, lit || '#f4ecff', 'rgba(255,255,255,.14)')}</svg>`; }
  function cycleMoonFrac(d, L, ov) { return d <= ov ? 0.5 * (d - 1) / Math.max(1, ov - 1) : 0.5 + 0.5 * (d - ov) / Math.max(1, L - ov + 1); }

  // ---------- api ----------
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (A && opts.auth !== false) headers.Authorization = `Bearer ${A.id}.${A.token}`;
    let res;
    try { res = await fetch(CFG.API + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
    catch (e) { throw new Error("Can't reach Orbit right now. Check your connection."); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && A) { A = null; saveAcct(); orbit = null; }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  async function ensureAccount() {
    if (A) return A;
    const role = S.profile && S.profile.role === 'partner' ? 'partner' : 'tracker';
    const r = await api('/v1/register', { method: 'POST', auth: false, body: { name: S.profile.name, role, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    A = { id: r.id, token: r.token }; saveAcct();
    await pushTitle(true);
    return A;
  }
  async function loadConfig() {
    if (!SOCIAL || vapidKey) return;
    try { const c = await api('/v1/config', { auth: false }); vapidKey = c.vapidPublicKey; if (c.spells) spells = c.spells; } catch (e) {}
  }
  async function refreshOrbit(silent) {
    if (!SOCIAL || !A) return;
    try {
      const prev = JSON.stringify(orbit);
      orbit = await api('/v1/orbit');
      if (JSON.stringify(orbit) !== prev && !document.querySelector('.scrim') && !isTyping()) render();
      if (S.profile.role === 'tracker') syncForecast();
    } catch (e) { if (!silent) toast(e.message); }
  }
  const isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'); };

  function myTitle() {
    const i = S.profile.role === 'tracker' ? C.info(S, today()) : null;
    return C.cosmicTitle(i ? i.phase : 'none', (A ? A.id : 'x') + today() + (S.orbit.titleSeed || 0));
  }
  async function pushTitle(force) {
    if (!A) return;
    const t = myTitle();
    if (!force && S.orbit.lastTitle === t) return;
    S.orbit.lastTitle = t; save(false);
    try { await api('/v1/profile', { method: 'POST', body: { title: t, mood: S.orbit.mood, name: S.profile.name, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }); } catch (e) {}
  }

  function buildForecast() {
    const st = C.stats(S); const np = C.nextPeriod(S, st); const out = [];
    for (let d = 0; d < 8; d++) {
      const k = C.addDays(today(), d); const dec = C.decode(S, k); if (!dec) break;
      const ph = C.PHASES[dec.info.phase];
      out.push({ d: k, phase: ph.name, emoji: ph.emoji, line: PARTNER_LINE[dec.info.phase], tip: dec.partnerTip, energy: dec.energy,
        countdown: S.settings.shareCountdown && np && !np.onPeriod && !np.late && np.inDays - d >= 0 ? np.inDays - d : null });
    }
    return out;
  }
  let syncTimer = null, lastSent = null;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncForecast, 1200); }
  async function syncForecast() {
    if (!SOCIAL || !A || !S.profile || S.profile.role !== 'tracker') return;
    const hasPartner = orbit && orbit.partner;
    const forecast = hasPartner && S.settings.shareForecast ? buildForecast() : null;
    const body = JSON.stringify(forecast);
    if (body === lastSent) return;
    try { await api('/v1/profile', { method: 'POST', body: { forecast } }); lastSent = body; } catch (e) {}
  }

  // ---------- notifications ----------
  function b64ToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
  async function enableNotifications() {
    if (!SOCIAL) return toast('Notifications need Orbit sync, which is switched off.');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return openSheet(installSheet(isIOS() && !isStandalone() ? 'First add Orbit to your Home Screen, then open it from there to turn on notifications (iPhone needs iOS 16.4 or newer).' : "This browser can't do push notifications."));
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications are blocked. You can allow them in Settings > Notifications > Orbit.');
    try {
      await loadConfig();
      if (!vapidKey) throw new Error("Can't reach Orbit right now.");
      await ensureAccount();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidKey) });
      await api('/v1/push', { method: 'POST', body: { subscription: sub.toJSON() } });
      await api('/v1/profile', { method: 'POST', body: { dailyOn: true, notifyHour: S.settings.notifyHour, notifyMin: S.settings.notifyMin, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      S.settings.notifOn = true; save(false);
      await api('/v1/push/test', { method: 'POST' });
      toast('Notifications on. A test one is on its way.');
      refreshOrbit(true); render();
    } catch (e) { toast(e.message || 'Could not turn on notifications.'); }
  }

  // ---------- rendering ----------
  function render() {
    const app = $('#app'), nav = $('#tabs');
    if (!S.profile) { nav.classList.add('hidden'); app.innerHTML = renderOnboarding(); return; }
    const partnerRole = S.profile.role === 'partner';
    const tabs = partnerRole ? [['today', '🔭', 'Forecast'], ['orbit', '🪐', 'Orbit']] : [['today', '🌙', 'Today'], ['calendar', '📅', 'Calendar'], ['log', '+', 'Log'], ['insights', '🌊', 'Waves'], ['orbit', '🪐', 'Orbit']];
    if (!tabs.some((t) => t[0] === tab)) tab = 'today';
    const unread = orbit && orbit.pings ? orbit.pings.filter((p) => !p.read).length : 0;
    nav.innerHTML = tabs.map(([k, i, l]) => `<button class="tab ${k === tab ? 'on' : ''} ${k === 'log' ? 'plus' : ''}" data-act="tab:${k}"><span class="ti">${i}</span>${l}${k === 'orbit' && unread ? ` (${unread})` : ''}</button>`).join('');
    nav.classList.remove('hidden');
    const views = { today: partnerRole ? viewPartnerHome : viewToday, calendar: viewCalendar, log: viewLog, insights: viewInsights, orbit: viewOrbit };
    app.innerHTML = views[tab]();
    if (tab === 'orbit' && unread && A) api('/v1/pings/read', { method: 'POST' }).then(() => { orbit.pings.forEach((p) => (p.read = 1)); }).catch(() => {});
    if (partnerRole && tab === 'today' && orbit && orbit.partner && orbit.partner.forecast && S.seenSent !== today() + orbit.partner.id) {
      S.seenSent = today() + orbit.partner.id; save(false);
      api('/v1/seen', { method: 'POST', body: { id: orbit.partner.id } }).catch(() => {});
    }
  }

  function header(title, sub) {
    return `<div class="topbar"><div class="brand"><img src="icons/icon-180.png" alt=""><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div><button class="iconbtn" data-act="settings" aria-label="Settings">⚙️</button></div>`;
  }
  const disclaimer = () => `<p class="faint foot">Orbit is for fun and self-awareness. It isn't medical advice and it isn't birth control. Predictions are estimates.</p>`;

  function setupCards() {
    let h = '';
    if (isIOS() && !isStandalone()) h += `<div class="card install"><h2>Install Orbit</h2><p style="margin:0 0 6px">Add Orbit to your Home Screen so it opens like an app and can send notifications.</p><button class="btn small ghost" data-act="install-help">Show me how</button></div>`;
    else if (SOCIAL && !S.settings.notifOn && !S.settings.hideNotifCard) h += `<div class="card"><h2>Cosmic notifications</h2><p style="margin:0 0 10px">Cheeky daily lines for your phase, a heads-up before your period, and pings from your person.</p><div class="row"><button class="btn small" data-act="notif-on">Turn on notifications</button><button class="linkbtn" data-act="hide-notif">Not now</button></div></div>`;
    return h;
  }

  function ringSVG(i, st) {
    const L = Math.max(st.cycleLen, i.late ? i.cycleDay : 0), P = st.periodLen, ov = C.ovDay(st.cycleLen, P);
    const c = 180, R = 152, r = Math.min(10.5, (Math.PI * R / L) * 0.62);
    let s = `<svg viewBox="0 0 360 360"><defs><radialGradient id="rg" cx="50%" cy="50%" r="50%"><stop offset="0.55" stop-color="#7a4dff" stop-opacity=".28"/><stop offset="1" stop-color="#7a4dff" stop-opacity="0"/></radialGradient>
      <filter id="gl" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="4"/></filter></defs>
      <circle cx="${c}" cy="${c}" r="128" fill="url(#rg)"/><circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${r * 2 + 8}"/>`;
    const prog = Math.min(1, (i.cycleDay - 0.5) / L), circ = 2 * Math.PI * (R - r - 9);
    s += `<circle cx="${c}" cy="${c}" r="${R - r - 9}" fill="none" stroke="url(#none)" stroke-width="0"/><circle cx="${c}" cy="${c}" r="${R - r - 9}" fill="none" stroke="${C.PHASES[i.phase].color}" stroke-opacity=".7" stroke-width="3" stroke-linecap="round" stroke-dasharray="${circ * prog} ${circ}" transform="rotate(-90 ${c} ${c})"/>`;
    for (let d = 1; d <= L; d++) {
      const a = (-90 + ((d - 1) / L) * 360) * Math.PI / 180, x = c + R * Math.cos(a), y = c + R * Math.sin(a);
      const ph = d > st.cycleLen ? 'luteal' : C.phaseFor(d, st.cycleLen, P);
      const fert = d <= st.cycleLen && d >= ov - 5 && d <= ov + 1;
      const isT = d === i.cycleDay;
      if (fert) s += `<circle cx="${x}" cy="${y}" r="${r + 3.5}" fill="none" stroke="#4be8c4" stroke-opacity=".55" stroke-width="1.5"/>`;
      if (isT) s += `<circle cx="${x}" cy="${y}" r="${r + 7}" fill="${C.PHASES[ph].color}" opacity=".6" filter="url(#gl)"/><circle cx="${x}" cy="${y}" r="${r + 5}" fill="none" stroke="#fff" stroke-width="2"/>`;
      s += moon(x, y, isT ? r + 2 : r, cycleMoonFrac(Math.min(d, st.cycleLen), st.cycleLen, ov), C.PHASES[ph].color, 'rgba(255,255,255,.13)');
    }
    return s + '</svg>';
  }

  function viewToday() {
    const st = C.stats(S), t = today(), i = C.info(S, t, st), np = C.nextPeriod(S, st), dec = C.decode(S, t);
    const hello = `Hi ${esc(S.profile.name)}`;
    let h = header(hello, fmt(t, { weekday: 'long', month: 'long', day: 'numeric' }));
    h += setupCards();
    if (!i) return h + `<div class="card"><p>Log your last period to start your forecast.</p><button class="btn" data-act="settings">Add it</button></div>`;
    let lbl, big, small;
    if (np.late) { lbl = 'Period is'; big = `${np.late} day${np.late > 1 ? 's' : ''}`; small = 'late. Log it when it starts.'; }
    else if (np.onPeriod) { lbl = 'Period'; big = `Day ${np.periodDay}`; small = `Next one around ${fmt(np.date)}`; }
    else if (np.inDays === 0) { lbl = 'Period'; big = 'Today?'; small = 'Expected today'; }
    else { lbl = 'Period in'; big = `${np.inDays} day${np.inDays > 1 ? 's' : ''}`; small = `Expected ${fmt(np.date, { weekday: 'short', month: 'short', day: 'numeric' })}`; }
    let pill = '';
    if (i.isOvulation) pill = `<span class="pill fert">🌕 Ovulation day (est.)</span>`;
    else if (i.fertile) pill = `<span class="pill fert">✨ In your fertile window</span>`;
    else if (np.late) pill = `<span class="pill late">⏳ Running late</span>`;
    else if (i.isPeriod) pill = `<span class="pill men">🩸 On your period</span>`;
    else pill = `<span class="pill">${C.PHASES[i.phase].emoji} ${C.PHASES[i.phase].name} phase</span>`;
    h += `<div class="ringwrap">${ringSVG(i, st)}<div class="ringcenter"><div class="lbl">${lbl}</div><div class="big">${big}</div><div class="small">${small}</div>${pill}</div></div>`;
    const ph = C.PHASES[i.phase];
    h += `<div class="card decode"><h2>Your daily decode</h2><div class="day" style="color:${ph.color}">Cycle day ${i.cycleDay} · ${ph.name} · ${ph.season}</div><div class="vibe">${esc(dec.vibe)}</div>
      <div class="hscroll"><div class="tip diet"><span class="ico">🥗</span><b>Diet &amp; gut</b><p>${esc(dec.diet)}</p></div><div class="tip move"><span class="ico">🏃‍♀️</span><b>Movement</b><p>${esc(dec.move)}</p></div><div class="tip glow"><span class="ico">💄</span><b>Beauty &amp; glow</b><p>${esc(dec.glow)}</p></div></div></div>`;
    h += partnerCardForTracker();
    h += `<button class="btn block" data-act="tab:log">＋ Log today</button>`;
    return h + disclaimer();
  }

  function partnerCardForTracker() {
    if (!SOCIAL) return '';
    const p = orbit && orbit.partner;
    if (!p) return `<div class="card partner"><h2>Your person</h2><p class="msg">Bring your partner into your orbit so they can see your daily forecast and send you spells.</p><button class="btn small ghost" data-act="tab:orbit">🪐 Invite them</button></div>`;
    const seen = p.seenMyForecastToday;
    const sharing = S.settings.shareForecast;
    const msg = !sharing ? `You're not sharing your forecast with ${esc(p.name)} right now.` : seen ? `${esc(p.name)} checked your forecast today. ✓` : `${esc(p.name)} hasn't peeked at your forecast yet today.`;
    return `<div class="card partner"><h2>In your orbit</h2><div class="row" style="align-items:flex-start"><div class="avatar alt">${initial(p.name)}</div><div class="grow"><div class="msg">${msg}</div>
      <div class="row wrap"><button class="btn small teal" data-act="nudge">👀 Nudge them</button><button class="btn small" data-act="spell-sheet">🪄 Cast a spell</button></div></div></div></div>`;
  }

  function viewPartnerHome() {
    let h = header('Forecast', fmt(today(), { weekday: 'long', month: 'long', day: 'numeric' }));
    h += setupCards();
    const p = orbit && orbit.partner;
    if (!A || !p) {
      return h + `<div class="card"><h2>Join your person's orbit</h2><p>Ask them for their Orbit partner code (Orbit tab > Invite partner), then enter it here.</p>${joinForm()}</div>` + disclaimer();
    }
    const f = p.forecast;
    if (!f) h += `<div class="card center"><div style="font-size:46px">🌌</div><h3>No forecast shared today</h3><p class="muted">${esc(p.name)} hasn't shared a forecast for today. A sweet text never hurts.</p></div>`;
    else {
      const col = { Menstrual: '#ff4d7e', Follicular: '#ff9bd2', Ovulation: '#ffd166', Luteal: '#a78bfa' }[f.phase] || '#c58bff';
      h += `<div class="card"><h2>${esc(p.name)}'s forecast</h2><div class="phasehero"><div class="orb" style="background:radial-gradient(circle at 35% 30%, #fff8, ${col} 45%, #2a1265 100%);box-shadow:0 0 40px ${col}88"></div><div><h3>${esc(f.emoji)} ${esc(f.phase)}</h3><div class="muted">${esc(f.line)}</div></div></div>
        <div class="row between" style="margin-top:14px"><span class="muted">Energy</span><div class="meter">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= f.energy ? 'on' : ''}"></i>`).join('')}</div></div>
        ${f.countdown != null ? `<div class="row between" style="margin-top:10px"><span class="muted">Period</span><b>${f.countdown === 0 ? 'may start today' : `in about ${f.countdown} day${f.countdown > 1 ? 's' : ''}`}</b></div>` : ''}
        <div class="tip mind" style="margin-top:14px;min-height:0"><span class="ico">💡</span><b>Partner tip</b><p>${esc(f.tip)}</p></div></div>`;
    }
    h += `<div class="card partner"><h2>Send some love</h2><div class="row wrap"><button class="btn small teal" data-act="nudge">💫 Nudge ${esc(p.name)}</button><button class="btn small" data-act="spell-sheet">🪄 Cast a spell</button></div></div>`;
    return h + disclaimer();
  }

  // ---------- log ----------
  function day(k) { return S.days[k] || {}; }
  function setDay(k, d) { const clean = {}; for (const [a, b] of Object.entries(d)) if (b != null && b !== '' && !(Array.isArray(b) && !b.length)) clean[a] = b; if (Object.keys(clean).length) S.days[k] = clean; else delete S.days[k]; save(); }
  function viewLog() {
    const k = logDate, d = day(k), i = C.info(S, k);
    const rel = k === today() ? 'Today' : C.diff(k, today()) === -1 ? 'Yesterday' : fmt(k, { weekday: 'long' });
    let h = `<div class="daynav"><button class="iconbtn" data-act="log-prev">‹</button><div class="d">${rel}<small>${fmt(k, { month: 'long', day: 'numeric' })}${i ? ` · Cycle day ${i.cycleDay}` : ''}</small></div><button class="iconbtn" data-act="log-next" ${k >= today() ? 'disabled style="opacity:.3"' : ''}>›</button></div>`;
    const section = (cat, title, items, isOn) => `<div class="card cat-${cat}"><h2>${title}</h2><div class="tiles">${items.map(([v, l, e]) => `<button class="tile ${isOn(v) ? 'on' : ''}" data-act="${cat === 'flow' ? 'flow:' + v : 'tog:' + cat + ':' + v}"><span class="t">${e}</span>${l}</button>`).join('')}</div></div>`;
    h += section('flow', 'Period flow', C.LOG.flow, (v) => d.flow === v);
    h += section('feel', 'Feelings', C.LOG.feel, (v) => (d.feel || []).includes(v));
    h += section('crave', 'Cravings', C.LOG.crave, (v) => (d.crave || []).includes(v));
    h += section('sym', 'Symptoms', C.LOG.sym, (v) => (d.sym || []).includes(v));
    const sl = d.sleep || {};
    h += `<div class="card"><h2>Sleep &amp; energy</h2><div class="row between"><span class="muted">Hours slept</span><div class="stepper"><button data-act="sleep:-0.5">−</button><span class="v">${sl.hours != null ? sl.hours + 'h' : '—'}</span><button data-act="sleep:0.5">+</button></div></div>
      <label class="f">Woke up at</label><input type="time" data-change="wake" value="${esc(sl.wake || '')}">
      <label class="f">Sleep quality</label><div class="moons">${[1, 2, 3, 4, 5].map((n) => `<button class="${sl.q >= n ? 'on' : ''}" data-act="sleepq:${n}">🌙</button>`).join('')}</div>
      <label class="f">Energy</label><div class="moons">${[1, 2, 3, 4, 5].map((n) => `<button class="${d.energy >= n ? 'on' : ''}" data-act="energy:${n}">⚡</button>`).join('')}</div></div>`;
    h += `<div class="card"><h2>Note</h2><textarea data-change="note" placeholder="Anything the stars should know?">${esc(d.note || '')}</textarea></div>`;
    return h + `<p class="faint center">Saved on this phone as you tap.</p>`;
  }

  // ---------- calendar ----------
  function viewCalendar() {
    const st = C.stats(S), t = today();
    const first = new Date(calY, calM, 1, 12), startDow = first.getDay();
    const startKey = C.key(new Date(calY, calM, 1 - startDow, 12));
    let h = header('Calendar', 'Your cycle, mapped to the night sky');
    h += `<div class="card"><div class="calhead"><button class="iconbtn" data-act="cal:-1">‹</button><div class="m">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div><button class="iconbtn" data-act="cal:1">›</button></div><div class="calgrid">`;
    h += ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<div class="wd">${w}</div>`).join('');
    for (let n = 0; n < 42; n++) {
      const k = C.addDays(startKey, n), dt = C.parse(k);
      if (n === 35 && dt.getMonth() !== calM) break;
      const i = C.info(S, k, st), d = S.days[k];
      const cls = ['cday'];
      if (dt.getMonth() !== calM) cls.push('out');
      if (i) { if (i.isPeriod && k <= t) cls.push('period'); else if (i.isPeriod) cls.push('pperiod'); else if (i.fertile) cls.push('fertile'); if (i.isOvulation) cls.push('ovu'); }
      else if (d && d.flow && d.flow !== 'spotting') cls.push('period');
      if (k === t) cls.push('today');
      const f = C.moonFraction(k);
      h += `<div class="${cls.join(' ')}" data-act="calday:${k}" title="${C.moonName(f)}">${dt.getDate()}${moonIcon(f)}${i && i.isOvulation ? '<span class="star">✦</span>' : ''}${d && Object.keys(d).some((x) => x !== 'flow') ? '<span class="dot"></span>' : ''}</div>`;
    }
    h += `</div><div class="legend"><span class="l1">Period</span><span class="l2">Predicted</span><span class="l3">Fertile window</span><span class="l4">Ovulation (est.)</span></div></div>`;
    const np = C.nextPeriod(S, st);
    h += `<div class="card"><h2>Your rhythm</h2><div class="row between"><span class="muted">Average cycle</span><b>${st.cycleLen} days</b></div><div class="row between" style="margin-top:8px"><span class="muted">Average period</span><b>${st.periodLen} days</b></div>
      ${np ? `<div class="row between" style="margin-top:8px"><span class="muted">Next period</span><b>${np.late ? `${np.late} days late` : fmt(np.date, { weekday: 'short', month: 'short', day: 'numeric' })}</b></div>` : ''}
      <div class="row between" style="margin-top:8px"><span class="muted">Tonight's moon</span><b>${moonIcon(C.moonFraction(t), '#f4ecff', 18)} ${C.moonName(C.moonFraction(t))}</b></div>
      <p class="faint" style="margin:12px 0 0">${st.cyclesLogged ? `Based on ${st.cyclesLogged} logged cycle${st.cyclesLogged > 1 ? 's' : ''}.` : 'Based on your setup. It gets sharper as you log periods.'} Moon phases are just for the vibes; predictions come only from what you log. Tap a day to log it.</p></div>`;
    return h + disclaimer();
  }

  // ---------- insights ----------
  function hormoneChart(st, sel) {
    const L = st.cycleLen, P = st.periodLen, ov = C.ovDay(L, P), W = 340, H = 190, top = 24, bot = 168;
    const X = (d) => 8 + ((d - 1) / (L - 1)) * (W - 16), Y = (v) => bot - v * (bot - top - 8);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
    const bands = [['menstrual', 1, P + 0.5], ['follicular', P + 0.5, ov - 1.5], ['ovulation', ov - 1.5, ov + 1.5], ['luteal', ov + 1.5, L]];
    for (const [ph, a, b] of bands) {
      const x1 = X(Math.max(1, a)), x2 = X(Math.min(L, b));
      s += `<rect x="${x1}" y="${top}" width="${Math.max(0, x2 - x1)}" height="${bot - top}" fill="${C.PHASES[ph].color}" opacity=".09"/>`;
      s += `<text x="${(x1 + x2) / 2}" y="14" fill="${C.PHASES[ph].color}" font-size="${ph === 'ovulation' ? 9 : 10.5}" font-weight="700" text-anchor="middle">${ph === 'ovulation' ? 'Ovul.' : C.PHASES[ph].name}</text>`;
    }
    const series = [['estrogen', '#ff8fc8'], ['progesterone', '#a78bfa'], ['lh', '#ffd166'], ['fsh', '#4be8c4']];
    for (const [k, col] of series) {
      let d = '';
      for (let x = 1; x <= L; x += 0.25) { const v = C.hormones(x, L, P)[k]; d += (d ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(v).toFixed(1); }
      s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const hv = C.hormones(sel, L, P);
    s += `<line x1="${X(sel)}" x2="${X(sel)}" y1="${top}" y2="${bot}" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    for (const [k, col] of series) s += `<circle cx="${X(sel)}" cy="${Y(hv[k])}" r="4.5" fill="${col}" stroke="#150a3a" stroke-width="2"/>`;
    s += `<text x="8" y="184" fill="#8173b3" font-size="10">Day 1</text><text x="${W - 8}" y="184" fill="#8173b3" font-size="10" text-anchor="end">Day ${L}</text>`;
    return s + '</svg>';
  }

  function sleepInfo() {
    let wake = 7, hours = null;
    for (let n = 0; n < 4; n++) { const d = day(C.addDays(today(), -n)); if (d.sleep) { if (d.sleep.wake && wake === 7) { const [a, b] = d.sleep.wake.split(':').map(Number); wake = a + b / 60; } if (d.sleep.hours != null && hours == null) hours = d.sleep.hours; } }
    return { wake, hours };
  }
  function energyModel(phase, late) {
    const { wake, hours } = sleepInfo();
    const amp = { menstrual: 0.72, follicular: 1, ovulation: 1.06, luteal: late ? 0.76 : 0.86 }[phase] * (hours != null && hours < 7 ? 0.82 + 0.03 * Math.max(0, hours - 1) : 1);
    const shift = phase === 'luteal' ? -0.5 : 0;
    const awake = 16 + shift;
    const g = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2);
    const rel = (t) => ((t - wake) % 24 + 24) % 24;
    const cort = (t) => { const r = rel(t); let v = r < 0.75 ? 0.35 + 0.65 * r / 0.75 : 0.12 + 0.88 * Math.exp(-(r - 0.75) / 5); if (r > 21) v = Math.max(v, 0.12 + (r - 21) / 3 * 0.25); return v; };
    const mel = (t) => { const r = rel(t); return Math.min(1, g(r, 19.5 + shift, 2.6) * 1.05); };
    const en = (t) => { const r = rel(t); if (r > awake + 0.5) return 0.04; return Math.max(0.04, Math.min(1, amp * (0.2 + 0.72 * g(r, 3.6, 2) + 0.55 * g(r, 10.5, 2) - 0.2 * g(r, 7, 1.1)))); };
    let max = 0; for (let t = 0; t < 24; t += 0.25) max = Math.max(max, en(t));
    const wins = []; let cur = null;
    for (let k = 0; k <= 96; k++) { const t = (wake + k / 4) % 24, ok = en(t) >= max * 0.82 && k / 4 <= awake; if (ok && !cur) cur = [wake + k / 4, wake + k / 4]; else if (ok) cur[1] = wake + k / 4; else if (cur) { wins.push(cur); cur = null; } }
    if (cur) wins.push(cur);
    return { wake, hours, cort, mel, en, wins, windDown: wake + 14.5 + shift, amp };
  }
  function energyChart(m) {
    const W = 340, H = 170, top = 10, bot = 140, X = (t) => 8 + (t / 24) * (W - 16), Y = (v) => bot - v * (bot - top);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd166" stop-opacity=".55"/><stop offset="1" stop-color="#ff7ac6" stop-opacity=".05"/></linearGradient></defs>`;
    for (const [a, b] of m.wins) { const x1 = X(a % 24), x2 = X(b % 24 || 24); if (x2 > x1) s += `<rect x="${x1}" y="${top}" width="${x2 - x1}" height="${bot - top}" rx="6" fill="#4be8c4" opacity=".14"/>`; }
    const path = (fn) => { let d = ''; for (let t = 0; t <= 24; t += 0.25) d += (d ? 'L' : 'M') + X(t).toFixed(1) + ' ' + Y(fn(t)).toFixed(1); return d; };
    s += `<path d="${path(m.en)} L${X(24)} ${bot} L${X(0)} ${bot}Z" fill="url(#eg)"/><path d="${path(m.en)}" fill="none" stroke="#ffd166" stroke-width="2.8"/>`;
    s += `<path d="${path(m.cort)}" fill="none" stroke="#4be8c4" stroke-width="2" stroke-dasharray="5 4"/><path d="${path(m.mel)}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`;
    const nowH = new Date().getHours() + new Date().getMinutes() / 60;
    s += `<line x1="${X(nowH)}" x2="${X(nowH)}" y1="${top}" y2="${bot}" stroke="#fff" stroke-width="1.4"/><circle cx="${X(nowH)}" cy="${Y(m.en(nowH))}" r="5" fill="#fff"/>`;
    [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p'], [24, '12a']].forEach(([t, l]) => (s += `<text x="${X(t)}" y="158" fill="#8173b3" font-size="10" text-anchor="${t === 0 ? 'start' : t === 24 ? 'end' : 'middle'}">${l}</text>`));
    return s + '</svg>';
  }

  function viewInsights() {
    const st = C.stats(S), t = today(), i = C.info(S, t, st), dec = C.decode(S, t);
    let h = header('Waves', 'Your hormones, phase and energy');
    if (!i) return h + `<div class="card">Log a period to see your waves.</div>`;
    const ph = C.PHASES[i.phase];
    h += `<div class="card"><h2>Current phase</h2><div class="phasehero"><div class="orb" style="background:radial-gradient(circle at 35% 30%, #fff9, ${ph.color} 45%, #2a1265 100%);box-shadow:0 0 40px ${ph.color}88"></div><div><h3>${ph.name}</h3><div class="muted">${ph.season} · day ${i.cycleDay}</div></div></div><p style="line-height:1.45;margin:14px 0">${esc(dec.note)}</p>`;
    h += `<div class="weekstrip">`;
    for (let n = -3; n <= 3; n++) {
      const k = C.addDays(t, n), wi = C.info(S, k, st), wp = C.PHASES[wi.phase];
      h += `<div class="w ${n === 0 ? 'today' : ''}">${C.parse(k).toLocaleDateString(undefined, { weekday: 'narrow' })}<svg viewBox="0 0 20 20">${moon(10, 10, 8.5, cycleMoonFrac(Math.min(wi.cycleDay, st.cycleLen), st.cycleLen, C.ovDay(st.cycleLen, st.periodLen)), wp.color, 'rgba(255,255,255,.14)')}</svg>${C.parse(k).getDate()}</div>`;
    }
    h += `</div><div class="hscroll" style="margin-top:12px"><div class="tip mind"><span class="ico">🧠</span><b>Mind</b><p>${esc(dec.mind)}</p></div><div class="tip body"><span class="ico">🫶</span><b>Body</b><p>${esc(dec.body)}</p></div></div></div>`;
    const sel = scrub == null ? Math.min(i.cycleDay, st.cycleLen) : scrub;
    const selKey = C.addDays(i.start, sel - 1), selPh = C.phaseFor(sel, st.cycleLen, st.periodLen);
    h += `<div class="card"><h2>Hormone waves</h2>${hormoneChart(st, sel)}<div class="chartlegend"><span><i style="background:#ff8fc8"></i>Estrogen</span><span><i style="background:#a78bfa"></i>Progesterone</span><span><i style="background:#ffd166"></i>LH</span><span><i style="background:#4be8c4"></i>FSH</span></div>
      <input type="range" min="1" max="${st.cycleLen}" value="${sel}" data-change="scrub" aria-label="Pick a day"><div class="row between"><b id="scrubLbl">${fmt(selKey, { weekday: 'short', month: 'short', day: 'numeric' })} · day ${sel}</b><span class="pill" style="color:${C.PHASES[selPh].color}">${C.PHASES[selPh].name}</span></div><p class="muted" style="line-height:1.45;margin:10px 0 0">${HORMONE_TEXT[selPh]}</p><p class="faint" style="margin:8px 0 0">Curve shapes are a typical pattern scaled to your cycle, not lab values.</p></div>`;
    const m = energyModel(i.phase, i.late);
    const winTxt = m.wins.length ? m.wins.slice(0, 2).map(([a, b]) => `${fmtTime(a)}–${fmtTime(b)}`).join(' and ') : 'Take it easy today';
    h += `<div class="card"><h2>Peak energy</h2><div class="row between wrap"><div><div class="muted" style="font-size:13px">Best focus windows</div><b style="font-size:17px">${winTxt}</b></div><div style="text-align:right"><div class="muted" style="font-size:13px">Wind down</div><b style="font-size:17px">${fmtTime(m.windDown)}</b></div></div>${energyChart(m)}
      <div class="chartlegend"><span><i style="background:#ffd166"></i>Energy</span><span><i style="background:#4be8c4"></i>Wake-up hormone (cortisol-style)</span><span><i style="background:#a78bfa"></i>Sleepy hormone (melatonin-style)</span></div>
      <p class="faint" style="margin:6px 0 0">Shaped by your ${ph.name.toLowerCase()} phase${m.hours != null ? `, ${m.hours}h of sleep` : ''} and a ${fmtTime(m.wake)} wake-up${m.hours == null ? ' (log sleep to personalize)' : ''}. An illustration, not a measurement.</p></div>`;
    const bars = []; let any = false;
    for (let n = 6; n >= 0; n--) { const k = C.addDays(t, -n), hrs = (day(k).sleep || {}).hours; if (hrs != null) any = true; bars.push([k, hrs]); }
    h += `<div class="card"><h2>Sleep this week</h2>${any ? `<div class="row" style="align-items:flex-end;height:110px;gap:8px">${bars.map(([k, v]) => `<div class="grow center"><div style="height:${v ? Math.min(90, v * 9) : 3}px;border-radius:8px;background:linear-gradient(180deg,#a78bfa,#5b3bd6)"></div><div class="faint" style="margin-top:4px">${C.parse(k).toLocaleDateString(undefined, { weekday: 'narrow' })}</div></div>`).join('')}</div>` : `<p class="muted" style="margin:0">Log your sleep in the Log tab to see your pattern here.</p>`}</div>`;
    return h + disclaimer();
  }

  // ---------- orbit ----------
  function joinForm() {
    return `<div class="row" style="margin-top:10px"><input type="text" id="joinCode" placeholder="Enter a code" maxlength="12" autocapitalize="characters" autocomplete="off" value="${esc(S.pendingJoin || '')}" style="text-transform:uppercase"><button class="btn small" data-act="join">Join</button></div>`;
  }
  function viewOrbit() {
    let h = header('Your Orbit', 'Partner and friends');
    if (!SOCIAL) return h + `<div class="card"><h2>Orbit sync is off</h2><p>This version of Orbit runs fully on this phone. Partner and friends sync is switched off.</p></div>`;
    if (!A) {
      return h + `<div class="card"><div style="font-size:44px">🪐</div><h3>Bring your people into orbit</h3><p class="muted" style="line-height:1.45">Share a mood and a cosmic title with friends, and let your partner see your daily forecast and send spells.</p>
        <div class="disclaimer">🔒 Your cycle log never leaves this phone. Joining creates an anonymous profile with only your display name. You choose what gets shared, and you can delete it anytime.</div>
        <button class="btn block" style="margin-top:14px" data-act="connect">Join Orbit</button>${S.pendingJoin ? `<p class="faint">You have an invite code waiting: ${esc(S.pendingJoin)}</p>` : ''}</div>`;
    }
    if (!orbit) { refreshOrbit(); return h + `<div class="card center muted">Loading your orbit…</div>`; }
    const me = orbit.me, tracker = S.profile.role === 'tracker';
    h += `<div class="card"><h2>You</h2><div class="person" style="border:0;padding-top:0"><div class="avatar gold">${initial(S.profile.name)}</div><div class="grow"><div class="nm">${esc(S.profile.name)}</div><div class="ttl">✦ ${esc(myTitle())}</div>${S.orbit.mood ? `<span class="mood">${esc(S.orbit.mood)}</span>` : ''}</div><button class="iconbtn" data-act="reroll" aria-label="New title">🎲</button></div>
      <label class="f">Today's mood tag</label><div class="chips">${C.MOODS.map((m, n) => `<button class="chip ${S.orbit.mood === m ? 'on' : ''}" data-act="mood:${n}">${esc(m)}</button>`).join('')}</div></div>`;
    const p = orbit.partner;
    h += `<div class="card"><h2>Partner</h2>`;
    if (p) {
      h += `<div class="person"><div class="avatar alt">${initial(p.name)}</div><div class="grow"><div class="nm">${esc(p.name)}</div><div class="ttl">${p.title ? '✦ ' + esc(p.title) : ''}</div>${p.mood ? `<span class="mood">${esc(p.mood)}</span>` : ''}</div></div>`;
      if (tracker) h += `<p class="muted" style="margin:10px 0">${!S.settings.shareForecast ? 'Forecast sharing is off.' : p.seenMyForecastToday ? `${esc(p.name)} checked your forecast today ✓` : `${esc(p.name)} hasn't peeked at your forecast yet today.`}</p>`;
      h += `<div class="row wrap" style="margin-top:8px"><button class="btn small teal" data-act="nudge">${tracker ? '👀 Nudge them' : '💫 Nudge'}</button><button class="btn small" data-act="spell-sheet">🪄 Cast a spell</button></div>`;
      if (tracker) h += `<div style="margin-top:10px"><div class="toggle"><div><div class="tt">Share my daily forecast</div><div class="td">Phase, energy and a partner tip. Never your log.</div></div><label class="switch"><input type="checkbox" data-change="shareForecast" ${S.settings.shareForecast ? 'checked' : ''}><span></span></label></div>
        <div class="toggle"><div><div class="tt">Include period countdown</div><div class="td">Lets them see roughly how many days until your period.</div></div><label class="switch"><input type="checkbox" data-change="shareCountdown" ${S.settings.shareCountdown ? 'checked' : ''}><span></span></label></div></div>`;
      h += `<button class="linkbtn" data-act="unlink:${esc(p.id)}">Unlink ${esc(p.name)}</button>`;
    } else {
      h += `<p class="muted" style="margin-top:0">${tracker ? 'Invite your partner. They install Orbit, choose "joining someone\'s orbit" and enter your code.' : "Enter your person's partner code."}</p>`;
      if (tracker) h += `<button class="btn small" data-act="invite:partner">💌 Invite partner</button>`;
      h += joinForm();
    }
    h += `</div>`;
    const fOn = S.settings.friendsOn !== false;
    h += `<div class="card"><h2>Friends</h2><div class="toggle" style="margin-bottom:10px"><div><div class="tt">Friends sync</div><div class="td">${fOn ? 'Friends see your name, mood tag and cosmic title.' : 'Off. Friends can\'t see you and you won\'t see them.'}</div></div><label class="switch"><input type="checkbox" data-change="friendsOn" ${fOn ? 'checked' : ''}><span></span></label></div>`;
    if (!fOn) h += '';
    else if (orbit.friends.length) h += orbit.friends.map((f) => `<div class="person"><div class="avatar">${initial(f.name)}</div><div class="grow"><div class="nm">${esc(f.name)}</div><div class="ttl">${f.title ? '✦ ' + esc(f.title) : ''}</div>${f.mood ? `<span class="mood">${esc(f.mood)}</span>` : ''}</div><button class="iconbtn" data-act="sparkle:${esc(f.id)}" aria-label="Send sparkle">✨</button></div>`).join('');
    else h += `<p class="muted" style="margin-top:0">Friends see only your name, mood tag and cosmic title.</p>`;
    h += fOn ? `<div class="row wrap" style="margin-top:10px"><button class="btn small ghost" data-act="invite:friend">＋ Invite a friend</button></div>${p ? joinForm() : ''}</div>` : `</div>`;
    if (orbit.pings && orbit.pings.length) {
      h += `<div class="card"><h2>Recent pings</h2>${orbit.pings.slice(0, 8).map((x) => { const sp = x.spell && spells[x.spell]; const e = x.kind === 'spell' && sp ? sp.e : x.kind === 'nudge' ? '👀' : '✨'; const what = x.kind === 'spell' && sp ? `cast ${sp.name}` : x.kind === 'nudge' ? 'nudged you' : 'sent a sparkle'; return `<div class="ping"><span class="pe">${e}</span><div class="grow"><b>${esc(x.from_name || 'Someone')}</b> ${what}</div><span class="faint">${ago(x.created)}</span></div>`; }).join('')}</div>`;
    }
    return h + `<p class="faint foot">🔒 Your cycle log stays on this phone. Only what's listed above is shared.</p>`;
  }
  function ago(ts) { const s = Date.now() / 1000 - ts; if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }

  // ---------- onboarding ----------
  function renderOnboarding() {
    if (onb.step === 0) return `<div class="onb"><img class="logo" src="icons/icon-512.png" alt="Orbit"><h1>Orbit</h1><p class="tag">Your cycle, decoded by the cosmos.</p>
      <button class="btn block" data-act="onb:tracker">🌙 I'm tracking my cycle</button>${SOCIAL ? `<button class="btn block ghost" style="margin-top:10px" data-act="onb:partner">🔭 I'm joining my partner's orbit</button>` : ''}
      <p class="disclaimer" style="margin-top:22px">Orbit is for fun and self-awareness. It isn't medical advice and it isn't birth control. Your cycle data stays on this phone.</p></div>`;
    if (onb.step === 'tracker') {
      const def = C.addDays(today(), -10);
      return `<div class="onb"><h1 style="font-size:30px">Let's map your sky</h1><p class="tag">Three quick things. You can change them later.</p>
        <label class="f">What should we call you?</label><input type="text" id="oName" maxlength="24" placeholder="Your name" value="${esc(onb.name || '')}">
        <label class="f">When did your last period start?</label><input type="date" id="oLast" max="${today()}" value="${def}">
        <div class="row" style="gap:12px"><div class="grow"><label class="f">Cycle length (days)</label><input type="number" id="oCycle" min="20" max="45" value="28" inputmode="numeric"></div><div class="grow"><label class="f">Period length (days)</label><input type="number" id="oPeriod" min="2" max="10" value="5" inputmode="numeric"></div></div>
        <p class="faint">Not sure? Leave 28 and 5. Orbit learns from what you log.</p>
        <button class="btn block" style="margin-top:14px" data-act="onb:finish">Start my orbit ✨</button><button class="linkbtn" data-act="onb:back">Back</button></div>`;
    }
    return `<div class="onb"><h1 style="font-size:30px">Join their orbit</h1><p class="tag">See your person's daily forecast and send them spells.</p>
      <label class="f">Your name</label><input type="text" id="oName" maxlength="24" placeholder="Your name">
      <label class="f">Their partner code (optional now)</label><input type="text" id="oCode" maxlength="12" placeholder="e.g. K7M2QX9P" autocapitalize="characters" style="text-transform:uppercase" value="${esc(S.pendingJoin || '')}">
      <button class="btn block" style="margin-top:16px" data-act="onb:partnerfinish">Join ✨</button><button class="linkbtn" data-act="onb:back">Back</button>
      <p class="disclaimer" style="margin-top:16px">This creates an anonymous Orbit profile with just your name. Not medical advice, not birth control.</p></div>`;
  }

  // ---------- sheets ----------
  function openSheet(html) { closeSheet(); const s = document.createElement('div'); s.className = 'scrim'; s.innerHTML = `<div class="sheet"><div class="grab"></div>${html}</div>`; s.addEventListener('click', (e) => { if (e.target === s) closeSheet(); }); document.body.appendChild(s); }
  function closeSheet() { const s = $('.scrim'); if (s) s.remove(); }
  function installSheet(lead) {
    return `<h2>Add Orbit to your Home Screen</h2>${lead ? `<p class="muted">${esc(lead)}</p>` : ''}<ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (the square with an arrow).</li><li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Orbit</b> from your Home Screen and tap <b>Turn on notifications</b>.</li></ol><button class="btn block" style="margin-top:16px" data-act="close">Got it</button>`;
  }
  function spellSheet() {
    return `<h2>Cast a spell 🪄</h2><p class="muted" style="margin-top:-4px">${esc(orbit.partner.name)} gets it as a notification.</p><div class="spellgrid">${Object.entries(spells).map(([k, s]) => `<button class="spell" data-act="cast:${k}"><span class="se">${s.e}</span>${esc(s.name)}</button>`).join('')}</div>`;
  }
  function settingsSheet() {
    const p = S.profile, tracker = p.role === 'tracker', notifTime = `${C.pad(S.settings.notifyHour)}:${C.pad(S.settings.notifyMin)}`;
    let h = `<h2>Settings</h2><label class="f">Name</label><input type="text" data-change="name" maxlength="24" value="${esc(p.name)}">`;
    if (tracker) h += `<label class="f">Last period started</label><input type="date" data-change="anchor" max="${today()}" value="${esc(p.anchorStart || '')}"><div class="row" style="gap:12px"><div class="grow"><label class="f">Usual cycle (days)</label><input type="number" min="20" max="45" data-change="cycleLen" value="${p.cycleLen}"></div><div class="grow"><label class="f">Usual period (days)</label><input type="number" min="2" max="10" data-change="periodLen" value="${p.periodLen}"></div></div><p class="faint">Once you log two or more periods, Orbit uses your real averages instead.</p>`;
    if (SOCIAL) {
      h += `<div class="sec-title">Notifications</div><div class="card" style="margin:0">${S.settings.notifOn ? `<div class="row between"><b>On ✓</b><button class="btn small ghost" data-act="notif-test">Send a test</button></div>` : `<button class="btn small" data-act="notif-on">Turn on notifications</button>`}<label class="f">Daily message time</label><input type="time" data-change="notifyTime" value="${notifTime}"></div>`;
      h += `<div class="sec-title">Orbit sync</div><div class="card" style="margin:0">${A ? `<p style="margin:0 0 10px">Connected as ${esc(p.name)}.</p><button class="btn small danger" data-act="disconnect">Leave Orbit and delete my shared profile</button>` : `<p class="muted" style="margin:0">Not connected. Everything is on this phone only.</p>`}</div>`;
    }
    h += `<div class="sec-title">Your data</div><div class="row wrap"><button class="btn small ghost" data-act="export">Export backup</button><label class="btn small ghost" style="display:inline-block">Import backup<input type="file" accept="application/json" data-change="import" class="hidden"></label></div><button class="btn small danger" style="margin-top:10px" data-act="wipe">Delete everything</button>`;
    h += `<div class="sec-title">About</div><p class="disclaimer">Orbit is for fun and self-awareness. It isn't medical advice, it can't diagnose anything, and it isn't birth control. Predictions are estimates based on what you log. Moon phases are decoration. Talk to a doctor about anything that worries you.</p><p class="faint">Orbit ${esc(CFG.VERSION || '')}</p><button class="btn block" data-act="close">Done</button>`;
    return h;
  }

  // ---------- actions ----------
  async function act(a, el) {
    const [cmd, x, y] = a.split(':');
    const d = day(logDate);
    switch (cmd) {
      case 'tab': tab = x; if (x === 'log' && !el.closest('.tabs')) logDate = today(); if (x === 'log' && el.closest('.tabs')) logDate = logDate || today(); history.replaceState(null, '', '#' + x); render(); window.scrollTo(0, 0); if (x === 'orbit') refreshOrbit(true); return;
      case 'settings': return openSheet(settingsSheet());
      case 'close': closeSheet(); render(); return;
      case 'install-help': return openSheet(installSheet());
      case 'hide-notif': S.settings.hideNotifCard = true; save(false); return render();
      case 'notif-on': closeSheet(); return enableNotifications();
      case 'notif-test': try { const r = await api('/v1/push/test', { method: 'POST' }); toast(r.status === 201 ? 'Test sent. Check your notifications.' : 'Notifications seem off. Turn them on again.'); if (r.status !== 201) { S.settings.notifOn = false; save(false); } } catch (e) { toast(e.message); } return;
      case 'flow': setDay(logDate, Object.assign({}, d, { flow: d.flow === x ? null : x })); toast(d.flow === x ? 'Flow cleared' : 'Logged ✨'); return render();
      case 'tog': { const list = new Set(d[x] || []); list.has(y) ? list.delete(y) : list.add(y); setDay(logDate, Object.assign({}, d, { [x]: [...list] })); return render(); }
      case 'sleep': { const sl = Object.assign({}, d.sleep || {}); sl.hours = Math.max(0, Math.min(14, (sl.hours != null ? sl.hours : 7.5) + (sl.hours == null ? 0 : +x))); setDay(logDate, Object.assign({}, d, { sleep: sl })); return render(); }
      case 'sleepq': { const sl = Object.assign({}, d.sleep || {}); sl.q = sl.q === +x ? null : +x; setDay(logDate, Object.assign({}, d, { sleep: sl })); return render(); }
      case 'energy': setDay(logDate, Object.assign({}, d, { energy: d.energy === +x ? null : +x })); return render();
      case 'log-prev': logDate = C.addDays(logDate, -1); return render();
      case 'log-next': if (logDate < today()) logDate = C.addDays(logDate, 1); return render();
      case 'cal': calM += +x; if (calM < 0) { calM = 11; calY--; } if (calM > 11) { calM = 0; calY++; } return render();
      case 'calday': if (x > today()) return toast("That day hasn't happened yet."); logDate = x; tab = 'log'; render(); window.scrollTo(0, 0); return;
      case 'onb': return onboardAct(x);
      case 'connect': try { await ensureAccount(); await refreshOrbit(); if (S.pendingJoin) await join(S.pendingJoin); render(); toast('Welcome to Orbit 🪐'); } catch (e) { toast(e.message); } return;
      case 'join': { const c = ($('#joinCode') || {}).value || ''; if (!c.trim()) return toast('Enter a code first.'); try { await ensureAccount(); await join(c); } catch (e) { toast(e.message); } return; }
      case 'invite': try { await ensureAccount(); const r = await api('/v1/invite', { method: 'POST', body: { kind: x } }); inviteSheet(r); } catch (e) { toast(e.message); } return;
      case 'share': { const c = el.dataset.code, k = el.dataset.kind; const url = location.origin + location.pathname + '#join=' + c; const text = k === 'partner' ? `Join my Orbit so you can see my daily forecast 🪐 Open this on your iPhone, add it to your Home Screen, and use code ${c}: ${url}` : `Join my Orbit 🪐 Code ${c}: ${url}`; if (navigator.share) { try { await navigator.share({ text }); } catch (e) {} } else { try { await navigator.clipboard.writeText(text); toast('Copied. Paste it in a text.'); } catch (e) { toast('Code: ' + c); } } return; }
      case 'nudge': try { const r = await api('/v1/ping', { method: 'POST', body: { to: orbit.partner.id, kind: 'nudge' } }); toast(r.delivered ? `Nudge sent to ${orbit.partner.name} 👀` : `Saved for ${orbit.partner.name}. They'll see it in Orbit (notifications are off on their side).`); } catch (e) { toast(e.message); } return;
      case 'spell-sheet': if (!orbit || !orbit.partner) return; await loadConfig(); return openSheet(spellSheet());
      case 'cast': closeSheet(); try { const r = await api('/v1/ping', { method: 'POST', body: { to: orbit.partner.id, kind: 'spell', spell: x } }); toast(`${spells[x].e} ${spells[x].name} cast${r.delivered ? '!' : '. They\'ll see it in Orbit.'}`); } catch (e) { toast(e.message); } return;
      case 'sparkle': try { await api('/v1/ping', { method: 'POST', body: { to: x, kind: 'cheer' } }); toast('Sparkle sent ✨'); } catch (e) { toast(e.message); } return;
      case 'mood': S.orbit.mood = S.orbit.mood === C.MOODS[+x] ? null : C.MOODS[+x]; save(false); render(); try { await api('/v1/profile', { method: 'POST', body: { mood: S.orbit.mood } }); } catch (e) { toast(e.message); } return;
      case 'reroll': S.orbit.titleSeed = (S.orbit.titleSeed || 0) + 1; save(false); render(); pushTitle(); return;
      case 'unlink': if (!confirm('Unlink this person? They will no longer see your forecast.')) return; try { await api('/v1/unlink', { method: 'POST', body: { id: x } }); lastSent = null; await refreshOrbit(); await syncForecast(); render(); } catch (e) { toast(e.message); } return;
      case 'disconnect': if (!confirm('Leave Orbit? This deletes your shared profile, links and pings from the server. Your cycle log stays on this phone.')) return; try { await api('/v1/me', { method: 'DELETE' }); } catch (e) {} A = null; saveAcct(); orbit = null; S.settings.notifOn = false; save(false); closeSheet(); render(); toast('You left Orbit.'); return;
      case 'export': { const blob = new Blob([JSON.stringify({ app: 'orbit', v: 1, data: S }, null, 1)], { type: 'application/json' }); const u = URL.createObjectURL(blob); const l = document.createElement('a'); l.href = u; l.download = `orbit-backup-${today()}.json`; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); return; }
      case 'wipe': if (!confirm('Delete all Orbit data on this phone (and your shared profile, if any)? This cannot be undone.')) return; if (A) { try { await api('/v1/me', { method: 'DELETE' }); } catch (e) {} } localStorage.removeItem(LS); localStorage.removeItem(LSA); S = fresh(); A = null; orbit = null; save(false); closeSheet(); onb = { step: 0 }; render(); return;
    }
  }
  async function join(code) {
    const r = await api('/v1/join', { method: 'POST', body: { code } });
    S.pendingJoin = null; save(false);
    toast(`You're now in ${r.person.name}'s orbit 🪐`);
    await refreshOrbit(); render();
  }
  function inviteSheet(r) {
    openSheet(`<h2>${r.kind === 'partner' ? 'Invite your partner 💌' : 'Invite a friend ✨'}</h2><p class="muted">${r.kind === 'partner' ? 'They open Orbit, choose "I\'m joining my partner\'s orbit" and enter this code. It works once and expires in 3 days.' : 'They join Orbit and enter this code in the Orbit tab. It works once and expires in 3 days.'}</p><div class="code">${esc(r.code)}</div><button class="btn block" style="margin-top:14px" data-act="share" data-code="${esc(r.code)}" data-kind="${r.kind}">Share the invite</button><button class="btn block ghost" style="margin-top:10px" data-act="close">Done</button>`);
  }
  async function onboardAct(x) {
    if (x === 'tracker' || x === 'partner') { onb.step = x; return render(); }
    if (x === 'back') { onb.step = 0; return render(); }
    const name = ($('#oName').value || '').trim().slice(0, 24);
    if (!name) return toast('Add your name first.');
    if (x === 'finish') {
      const last = $('#oLast').value; const L = Math.max(20, Math.min(45, +$('#oCycle').value || 28)); const P = Math.max(2, Math.min(10, +$('#oPeriod').value || 5));
      if (!last || last > today()) return toast('Pick the day your last period started.');
      S.profile = { name, role: 'tracker', cycleLen: L, periodLen: P, anchorStart: last, created: Date.now() };
      save(false); tab = 'today'; render(); return;
    }
    if (x === 'partnerfinish') {
      const code = ($('#oCode').value || '').trim();
      S.profile = { name, role: 'partner', created: Date.now() };
      save(false);
      try { await ensureAccount(); if (code) await join(code); else await refreshOrbit(); } catch (e) { toast(e.message); }
      tab = 'today'; render();
    }
  }
  async function change(kind, el) {
    const p = S.profile;
    switch (kind) {
      case 'wake': { const d = day(logDate); setDay(logDate, Object.assign({}, d, { sleep: Object.assign({}, d.sleep || {}, { wake: el.value || null }) })); return; }
      case 'note': { const d = day(logDate); setDay(logDate, Object.assign({}, d, { note: el.value.slice(0, 1000) })); return; }
      case 'scrub': { scrub = +el.value; const y = window.scrollY; render(); window.scrollTo(0, y); const r = $('input[type=range]'); if (r) r.focus(); return; }
      case 'friendsOn': S.settings.friendsOn = el.checked; save(false); try { await api('/v1/profile', { method: 'POST', body: { friendsOn: el.checked } }); } catch (e) { toast(e.message); } await refreshOrbit(true); render(); return;
      case 'shareForecast': S.settings.shareForecast = el.checked; save(false); lastSent = null; await syncForecast(); await refreshOrbit(true); render(); return;
      case 'shareCountdown': S.settings.shareCountdown = el.checked; save(false); lastSent = null; await syncForecast(); return;
      case 'name': p.name = (el.value || '').trim().slice(0, 24) || p.name; save(false); if (A) api('/v1/profile', { method: 'POST', body: { name: p.name } }).catch(() => {}); return;
      case 'anchor': if (el.value && el.value <= today()) { p.anchorStart = el.value; save(); } return;
      case 'cycleLen': p.cycleLen = Math.max(20, Math.min(45, +el.value || 28)); save(); return;
      case 'periodLen': p.periodLen = Math.max(2, Math.min(10, +el.value || 5)); save(); return;
      case 'notifyTime': { const [h, m] = (el.value || '09:00').split(':').map(Number); S.settings.notifyHour = h; S.settings.notifyMin = m; save(false); if (A) api('/v1/profile', { method: 'POST', body: { notifyHour: h, notifyMin: m, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }).catch(() => {}); return; }
      case 'import': { const f = el.files && el.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (j.app !== 'orbit' || !j.data || !j.data.profile) throw 0; S = Object.assign(fresh(), j.data); save(); closeSheet(); render(); toast('Backup restored'); } catch (e) { toast("That file isn't an Orbit backup."); } return; }
    }
  }

  document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (!el || el.disabled) return; e.preventDefault(); act(el.dataset.act, el); });
  document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el && el.dataset.change !== 'scrub' && el.dataset.change !== 'note') change(el.dataset.change, el); });
  document.addEventListener('input', (e) => { const el = e.target.closest('[data-change]'); if (el && (el.dataset.change === 'scrub' || el.dataset.change === 'note')) change(el.dataset.change, el); });

  // ---------- stars ----------
  function drawStars() {
    const cv = $('#stars'), dpr = Math.min(2, window.devicePixelRatio || 1), w = window.innerWidth, h = window.innerHeight;
    cv.width = w * dpr; cv.height = h * dpr; const x = cv.getContext('2d'); x.scale(dpr, dpr);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < Math.round(w * h / 2600); n++) { const r = rnd() < 0.08 ? 1.6 : rnd() * 1.1 + 0.3; x.globalAlpha = 0.35 + rnd() * 0.65; x.fillStyle = rnd() < 0.15 ? '#ffd6f5' : rnd() < 0.2 ? '#cfe2ff' : '#fff'; x.beginPath(); x.arc(rnd() * w, rnd() * h, r, 0, 6.283); x.fill(); }
  }
  window.addEventListener('resize', drawStars);

  // ---------- boot ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open-tab') { tab = e.data.tab; render(); refreshOrbit(true); } });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.profile) { refreshOrbit(true); pushTitle(); } });
  setInterval(() => { if (!document.hidden && S.profile && (tab === 'orbit' || tab === 'today')) refreshOrbit(true); }, 30000);
  drawStars();
  if (S.profile) idbPut('state', { profile: S.profile, days: S.days });
  render();
  if (S.profile && A) { loadConfig(); refreshOrbit(true); pushTitle(); }
  window.__orbit = { get state() { return S; }, get acct() { return A; } };
})();
