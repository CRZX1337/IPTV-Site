(function () {
  'use strict';

  // ------------------------------------------------------------------ state --
  let role = null;
  let currentState = null;
  let channels = [];
  let categories = [];
  let favorites = new Set();
  let search = '';
  let activeCategory = 'all';
  let favOnly = false;
  let attachedChannelId = null;
  let hls = null;
  let es = null;
  let unlockAt = 0;
  let countdownTimer = null;
  let loadingChannels = false;
  let lastEpg = null; // { streamId, list }

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    loginView: $('login-view'),
    appView: $('app-view'),
    tabbar: $('tabbar'),
    roleBadge: $('role-badge'),
    logoutBtn: $('logout-btn'),
    connDot: $('conn-dot'),
    video: $('video'),
    offline: $('offline'),
    liveBadge: $('live-badge'),
    streamingUser: $('streaming-user'),
    channelTitle: $('channel-title'),
    channelMeta: $('channel-meta'),
    stopBtn: $('stop-btn'),
    lockInfo: $('lock-info'),
    epgPanel: $('epg-panel'),
    epgNowTitle: $('epg-now-title'),
    epgNowTime: $('epg-now-time'),
    epgNext: $('epg-next'),
    guideChannel: $('guide-channel'),
    guideList: $('guide-list'),
    searchInput: $('search-input'),
    searchClear: $('search-clear'),
    favToggle: $('fav-toggle'),
    categoryChips: $('category-chips'),
    channelList: $('channel-list'),
    toasts: $('toasts'),
  };

  const STAR_PATH =
    '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.8l6.5-.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';

  // ------------------------------------------------------------- favorites --
  function loadFavorites() {
    try {
      favorites = new Set(JSON.parse(localStorage.getItem('hoodtv_favorites') || '[]'));
    } catch {
      favorites = new Set();
    }
  }
  function saveFavorites() {
    localStorage.setItem('hoodtv_favorites', JSON.stringify([...favorites]));
  }
  function toggleFavorite(id) {
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    saveFavorites();
    renderChannels();
    updateFavToggle();
  }

  function updateFavToggle() {
    els.favToggle.classList.toggle('active', favOnly);
  }

  // ------------------------------------------------------------- api helper --
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    if (res.status === 401) {
      showLogin();
      throw new Error('unauthorized');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-json */
    }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- toasts --
  function toast(msg, kind = 'info', ms = 3000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    els.toasts.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px) scale(.96)';
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ----------------------------------------------------------- navigation --
  function setPane(name) {
    $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    $$('.tab').forEach((t) => {
      const on = t.dataset.pane === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setPane(tab.dataset.pane));
  });

  // ---------------------------------------------------------------- login ---
  let selectedRole = 'admin';
  $$('.role-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedRole = btn.dataset.role;
      $$('.role-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $('login-error').textContent = '';
    });
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('password-input').value;
    const submit = $('login-submit');
    submit.disabled = true;
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: { role: selectedRole, password } });
      enterApp(res.role);
    } catch (err) {
      const msg =
        err.code === 'rate_limited' ? 'Zu viele Versuche. Bitte kurz warten.' :
        err.code === 'invalid_credentials' ? 'Zugriff verweigert — falscher Passkey.' :
        err.message;
      $('login-error').textContent = msg;
    } finally {
      submit.disabled = false;
      $('password-input').value = '';
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    teardownApp();
    showLogin();
  });

  function showLogin() {
    teardownApp();
    els.appView.classList.add('hidden');
    els.tabbar.classList.add('hidden');
    els.roleBadge.classList.add('hidden');
    els.logoutBtn.classList.add('hidden');
    els.loginView.classList.remove('hidden');
  }

  // ----------------------------------------------------------------- app ----
  async function enterApp(newRole) {
    role = newRole;
    els.loginView.classList.add('hidden');
    els.appView.classList.remove('hidden');
    els.tabbar.classList.remove('hidden');
    els.roleBadge.textContent = role.toUpperCase();
    els.roleBadge.classList.remove('hidden');
    els.logoutBtn.classList.remove('hidden');

    search = '';
    activeCategory = 'all';
    favOnly = false;
    els.searchInput.value = '';
    els.searchClear.classList.add('hidden');
    updateFavToggle();
    setPane('live');

    await Promise.all([loadChannels(), syncState()]);
    connectSSE();
    startCountdown();
  }

  function teardownApp() {
    if (es) { es.close(); es = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    detachPlayer();
    currentState = null;
    lastEpg = null;
    role = null;
  }

  async function loadChannels() {
    loadingChannels = true;
    renderChannels();
    try {
      const data = await api('/api/channels');
      categories = data.categories || [];
      channels = data.channels || [];
      renderCategories();
    } catch {
      toast('Senderliste konnte nicht geladen werden.', 'err');
    } finally {
      loadingChannels = false;
      renderChannels();
    }
  }

  async function syncState() {
    try {
      const s = await api('/api/state');
      applyState(s);
    } catch { /* handled by 401 flow */ }
  }

  // ------------------------------------------------------------------- SSE --
  function connectSSE() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onopen = () => { els.connDot.className = 'conn-dot on'; };
    es.addEventListener('state', (e) => {
      try { applyState(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.onerror = () => {
      els.connDot.className = 'conn-dot off';
      // EventSource reconnects automatically.
    };
  }

  // ------------------------------------------------------------- state sync --
  function applyState(state) {
    if (!state) return;
    currentState = state;

    if (state.playing && state.channel) {
      els.liveBadge.classList.remove('hidden');
      els.streamingUser.textContent = '● Globaler Stream';
      els.offline.classList.add('hidden');
      els.channelTitle.textContent = state.channel.name || '—';
      els.channelMeta.textContent = [state.channel.categoryName, state.channel.num ? `Sender ${state.channel.num}` : null]
        .filter(Boolean).join('  ·  ');
      if (attachedChannelId !== state.channel.id) {
        attachPlayer(state.channel.id);
      }
      loadEpg(state.channel.id);
    } else {
      els.liveBadge.classList.add('hidden');
      els.streamingUser.textContent = '';
      els.offline.classList.remove('hidden');
      els.channelTitle.textContent = '— Aus —';
      els.channelMeta.textContent = '';
      els.epgPanel.classList.add('hidden');
      lastEpg = null;
      renderGuide();
      detachPlayer();
    }

    updateLock();
    renderChannels();
  }

  function updateLock() {
    const stopVisible = role === 'admin';
    els.stopBtn.classList.toggle('hidden', !stopVisible);
    els.lockInfo.classList.toggle('hidden', role === 'admin');

    if (role === 'user' && currentState) {
      if (currentState.userCanSwitch) {
        els.lockInfo.textContent = 'Entsperrt · Wechsel möglich';
        els.lockInfo.classList.add('unlocked');
        unlockAt = 0;
      } else {
        els.lockInfo.classList.remove('unlocked');
        unlockAt = Date.now() + (currentState.userSwitchInMs || 0);
        renderLockText();
      }
    }
  }

  function renderLockText() {
    if (!unlockAt) {
      els.lockInfo.textContent = 'Entsperrt · Wechsel möglich';
      els.lockInfo.classList.add('unlocked');
      return;
    }
    const remain = unlockAt - Date.now();
    if (remain <= 0) {
      els.lockInfo.textContent = 'Entsperrt · Wechsel möglich';
      els.lockInfo.classList.add('unlocked');
      unlockAt = 0;
      syncState();
    } else {
      els.lockInfo.textContent = `Gesperrt · ${fmtClock(remain)}`;
    }
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if (role === 'user' && currentState && !currentState.userCanSwitch) renderLockText();
    }, 1000);
  }

  // ---------------------------------------------------------------- player --
  function attachPlayer(channelId) {
    detachPlayer();
    attachedChannelId = channelId;
    const video = els.video;
    const src = `/api/stream/${channelId}/playlist.m3u8`;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
    } else if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 3,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === 'networkError' &&
            (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut')) {
          syncState(); // channel likely switched / stopped elsewhere
        } else if (data.type === 'mediaError') {
          hls.recoverMediaError();
        } else {
          hls.startLoad();
        }
      });
    } else {
      toast('Dieser Browser unterstützt kein HLS-Streaming.', 'err');
    }
  }

  function detachPlayer() {
    const video = els.video;
    if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    attachedChannelId = null;
  }

  // ------------------------------------------------------------------- EPG --
  let epgReq = 0;
  async function loadEpg(streamId) {
    const req = ++epgReq;
    try {
      const data = await api(`/api/epg/${streamId}`);
      if (req !== epgReq || !currentState || !currentState.channel || currentState.channel.id !== streamId) return;
      lastEpg = { streamId, list: data.listings || [] };
      renderEpgNow();
      renderGuide();
    } catch {
      lastEpg = { streamId, list: [] };
      renderEpgNow();
      renderGuide();
    }
  }

  function renderEpgNow() {
    const list = lastEpg ? lastEpg.list : [];
    if (!list.length) {
      els.epgPanel.classList.add('hidden');
      return;
    }
    els.epgPanel.classList.remove('hidden');
    const now = list[0];
    els.epgNowTitle.textContent = now.title || '—';
    els.epgNowTime.textContent = epgRange(now);
    const next = list[1];
    els.epgNext.textContent = next
      ? `Danach · ${epgRange(next)} · ${next.title || ''}`
      : '';
  }

  function renderGuide() {
    const list = lastEpg ? lastEpg.list : [];
    els.guideChannel.textContent =
      currentState && currentState.channel ? currentState.channel.name : 'Kein Sender aktiv';
    els.guideList.innerHTML = '';

    if (!list.length) {
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = currentState && currentState.playing
        ? 'Kein Programm verfügbar'
        : 'Starte einen Sender, um das Programm zu sehen.';
      els.guideList.appendChild(div);
      return;
    }

    list.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'guide-item' + (i === 0 ? ' now' : '');
      row.style.animationDelay = `${Math.min(200, i * 40)}ms`;

      const time = document.createElement('div');
      time.className = 'guide-time';
      time.textContent = epgStartTime(item);

      const body = document.createElement('div');
      body.className = 'guide-item-body';
      const title = document.createElement('div');
      title.className = 'guide-item-title';
      title.textContent = item.title || '—';
      body.appendChild(title);
      if (item.description) {
        const desc = document.createElement('div');
        desc.className = 'guide-item-desc';
        desc.textContent = item.description;
        body.appendChild(desc);
      }

      row.appendChild(time);
      row.appendChild(body);

      if (i === 0) {
        const badge = document.createElement('span');
        badge.className = 'guide-now-badge';
        badge.textContent = 'JETZT';
        row.appendChild(badge);
      }

      els.guideList.appendChild(row);
    });
  }

  function epgStartTime(e) {
    const t = e && (e.startTimestamp || e.start);
    return t ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  }

  function epgRange(e) {
    if (!e) return '';
    const start = e.startTimestamp || e.start;
    const end = e.stopTimestamp || e.end;
    const f = (t) => (t ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    const s = f(start);
    const en = f(end);
    return s && en ? `${s}–${en}` : s;
  }

  // ------------------------------------------------------------ categories --
  function renderCategories() {
    const chips = [{ id: 'all', name: 'Alle' }, ...categories];
    els.categoryChips.innerHTML = '';
    for (const c of chips) {
      const b = document.createElement('button');
      b.className = 'chip' + (c.id === activeCategory ? ' active' : '');
      b.textContent = c.name;
      b.addEventListener('click', () => {
        activeCategory = c.id;
        renderCategories();
        renderChannels();
      });
      els.categoryChips.appendChild(b);
    }
  }

  // -------------------------------------------------------------- channels --
  function renderChannels() {
    if (loadingChannels && !channels.length) {
      renderSkeletons();
      return;
    }

    const q = search.trim().toLowerCase();
    const filtered = channels.filter((c) => {
      if (favOnly && !favorites.has(c.id)) return false;
      if (activeCategory !== 'all' && c.categoryId !== activeCategory) return false;
      if (q && !(c.name || '').toLowerCase().includes(q)) return false;
      return true;
    });

    els.channelList.innerHTML = '';
    if (!filtered.length) {
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = channels.length
        ? 'Keine Treffer für deine Suche.'
        : 'Keine Sender verfügbar — Xtream ist nicht konfiguriert.';
      els.channelList.appendChild(div);
      return;
    }

    const activeId = currentState && currentState.channel ? currentState.channel.id : null;
    filtered.forEach((c, i) => {
      els.channelList.appendChild(buildChannelCard(c, activeId, i));
    });
  }

  function buildChannelCard(c, activeId, i) {
    const card = document.createElement('div');
    card.className = 'channel-card' + (c.id === activeId ? ' active' : '');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.style.animationDelay = `${Math.min(240, i * 16)}ms`;

    const logo = document.createElement('div');
    logo.className = 'channel-logo';
    if (c.logo) {
      const img = document.createElement('img');
      img.src = c.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        logo.innerHTML = '';
        logo.textContent = (c.name || '?').charAt(0).toUpperCase();
      });
      logo.appendChild(img);
    } else {
      logo.textContent = (c.name || '?').charAt(0).toUpperCase();
    }

    const body = document.createElement('div');
    body.className = 'channel-body';
    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = c.name;
    const cat = document.createElement('div');
    cat.className = 'channel-cat';
    cat.textContent = c.categoryName || '';
    body.appendChild(name);
    body.appendChild(cat);

    const fav = document.createElement('button');
    fav.className = 'channel-fav' + (favorites.has(c.id) ? ' on' : '');
    fav.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAR_PATH}</svg>`;
    fav.setAttribute('aria-label', favorites.has(c.id) ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen');
    fav.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(c.id);
    });

    card.appendChild(logo);
    card.appendChild(body);
    card.appendChild(fav);

    const activate = () => onChannelClick(c);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    return card;
  }

  function renderSkeletons() {
    els.channelList.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.innerHTML =
        '<div class="sk-logo"></div><div class="sk-line"></div><div class="sk-line short"></div>';
      els.channelList.appendChild(sk);
    }
  }

  async function onChannelClick(channel) {
    if (!currentState) return;
    if (currentState.playing && currentState.channel && currentState.channel.id === channel.id) {
      toast(`Läuft bereits · ${channel.name}`);
      setPane('live');
      return;
    }
    if (role === 'user' && !currentState.userCanSwitch) {
      toast(`Gesperrt · ${fmtClock(currentState.userSwitchInMs)} verbleibend`, 'warn');
      return;
    }
    try {
      const res = await api('/api/control/play', { method: 'POST', body: { channelId: channel.id } });
      applyState(res.state);
      toast(`${channel.name} wird gestreamt`);
      setPane('live');
    } catch (err) {
      if (err.code === 'user_locked') toast('Kanalwechsel gesperrt (Admin-Aktivität).', 'warn');
      else toast(err.message || 'Fehler beim Umschalten.', 'err');
    }
  }

  els.stopBtn.addEventListener('click', async () => {
    try {
      const res = await api('/api/control/stop', { method: 'POST' });
      applyState(res.state);
      toast('Stream gestoppt');
    } catch (err) {
      toast(err.message || 'Stopp fehlgeschlagen.', 'err');
    }
  });

  els.searchInput.addEventListener('input', () => {
    search = els.searchInput.value;
    els.searchClear.classList.toggle('hidden', !search);
    renderChannels();
  });

  els.searchClear.addEventListener('click', () => {
    search = '';
    els.searchInput.value = '';
    els.searchClear.classList.add('hidden');
    els.searchInput.focus();
    renderChannels();
  });

  els.favToggle.addEventListener('click', () => {
    favOnly = !favOnly;
    updateFavToggle();
    renderChannels();
  });

  // ------------------------------------------------------------------ boot --
  loadFavorites();
  (async function boot() {
    try {
      const me = await api('/api/auth/me');
      if (me.authenticated && me.role) enterApp(me.role);
      else showLogin();
    } catch {
      showLogin();
    }
  })();
})();
