const SUPABASE_URL = 'https://oqthohrbgrdbnmzmytag.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xdGhvaHJiZ3JkYm5tem15dGFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzU0NTQsImV4cCI6MjA5OTAxMTQ1NH0.NgEgHEFtgXy7YCzgZQsLHMSSPfEemoBX-yihGBLsTsU';
    const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const childKey = 'parentalRewardsChild';

    // The notification PUBLIC key lives in config.js (next to index.html), so updating
    // this file never wipes it. Never put the private key anywhere in the website.
    const VAPID_PUBLIC_KEY = (window.APP_CONFIG && window.APP_CONFIG.vapidPublicKey) || 'BLcnUhKqKnw4649ZWl8ssz6KfA616VyP_HFRQsPSJlPJSh2yOw_vRNc69juDBlW8y3qqBungpGOD-6bIonBMSvk';
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => Array.from(document.querySelectorAll(selector));

    let session = null; // { role, familyId, parentName?, memberRole?, userId?, childId?, token? }
    let booting = true;
    let needsOnboarding = false;
    let recovering = false;
    let activeTab = 'family';
    let family = null;
    let loading = false;

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Secondary actions (edit, delete, skip) live behind a small "..." button
    function moreMenu(buttonsHtml) {
      return `<details class="more"><summary aria-label="More actions">&#8943;</summary><div class="more-menu">${buttonsHtml}</div></details>`;
    }

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let editing = null; // { type: 'challenge' | 'goal', id }
    let mobileView = 'home';

    // Phones only: switch between the dashboard and the settings/profile page
    function setMobileView(view) {
      mobileView = view;
      $('#appScreen').dataset.view = view;
      $$('[data-mview]').forEach((button) => button.classList.toggle('active', button.dataset.mview === view));
      if (view === 'settings') {
        $('#settingsSection').open = true;
        $('#themeSection').open = true;
      }
      window.scrollTo(0, 0);
    }

    function nextDate(days) {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date.toISOString().slice(0, 10);
    }

    // Local-time "today" (YYYY-MM-DD), avoids off-by-one around midnight
    function todayStr() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // Next date (after today) that falls on one of the selected weekdays
    function nextOccurrence(days) {
      for (let i = 1; i <= 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        if (days.includes(d.getDay())) {
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
      }
      return todayStr();
    }

    // First date on/after today that falls on one of the selected weekdays
    function firstOccurrence(days, skips = []) {
      for (let i = 0; i <= 60; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const str = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (days.includes(d.getDay()) && !skips.includes(str)) return str;
      }
      return todayStr();
    }

    function parentEmails() {
      return family?.parent_emails || [];
    }

    let swReg = null;
    let pushIsOn = false;

    async function registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      try {
        swReg = await navigator.serviceWorker.register('sw.js');
      } catch (e) {
        console.warn('Service worker not registered', e);
      }
    }

    function urlBase64ToUint8Array(base64) {
      const padding = '='.repeat((4 - (base64.length % 4)) % 4);
      const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    }

    function pushSupported() {
      return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    }

    async function currentPushSubscription() {
      if (!pushSupported()) return null;
      const reg = swReg || await navigator.serviceWorker.getRegistration();
      return reg ? reg.pushManager.getSubscription() : null;
    }

    async function updatePushUI() {
      if (!session) return;
      const btn = $('#pushBtn');
      const status = $('#pushStatus');
      if (!btn || !status) return;

      if (!pushSupported()) {
        btn.classList.add('hidden');
        status.textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
          ? 'For notifications on iPhone/iPad: tap Share, choose Add to Home Screen, then open the app from your Home Screen.'
          : 'This browser does not support notifications.';
        return;
      }
      if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith('PASTE')) {
        btn.classList.add('hidden');
        status.textContent = 'Notifications are not set up yet. Add your public key to config.js (see the setup steps).';
        return;
      }
      if (Notification.permission === 'denied') {
        btn.classList.add('hidden');
        status.textContent = 'Notifications are blocked. Allow them for this site in your browser or phone settings.';
        return;
      }

      btn.classList.remove('hidden');
      const sub = await currentPushSubscription();
      pushIsOn = !!sub;
      btn.textContent = sub ? 'Turn off notifications' : 'Turn on notifications';
      status.textContent = sub
        ? 'Notifications are on for this device. Your browser already allowed them, so it will not ask again.'
        : Notification.permission === 'granted'
          ? 'Allowed in your browser. Press the button to finish setting up this device.'
          : session.role === 'parent'
          ? 'Get a notification when a child finishes something.'
          : 'Get a notification when your parent sends something back.';
    }

    async function togglePush() {
      const status = $('#pushStatus');
      const say = (text) => { status.textContent = text; };

      try {
        // Turning off
        if (pushIsOn) {
          const existing = await currentPushSubscription();
          if (existing) {
            const endpoint = existing.endpoint;
            await existing.unsubscribe();
            await removePushOnServer(endpoint);
          }
          await updatePushUI();
          return;
        }

        // Turning on. Phones only show the permission box if it is asked for
        // straight away inside the tap, so do this BEFORE any other waiting.
        const permissionPromise = Notification.permission === 'default'
          ? Notification.requestPermission()
          : Promise.resolve(Notification.permission);
        say('Waiting for you to allow notifications...');
        const permission = await permissionPromise;

        if (permission !== 'granted') {
          await updatePushUI();
          if (permission !== 'denied') say('Notifications were not allowed. Tap the button to try again.');
          return;
        }

        say('Setting up this device...');
        let reg = swReg || await navigator.serviceWorker.getRegistration();
        if (!reg) reg = await navigator.serviceWorker.register('sw.js');
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('The notification helper (sw.js) did not start. Check that sw.js is uploaded next to index.html.')), 10000))
        ]);

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        const res = await savePushToServer(sub);
        if (res.error) throw new Error(res.error.message);
        await updatePushUI();
      } catch (e) {
        console.error(e);
        const message = 'Could not turn on notifications: ' + (e && e.message ? e.message : e);
        say(message);
        alert(message);
      }
    }

    // Keep this device's subscription attached to whoever is signed in
    function savePushToServer(sub) {
      const json = sub.toJSON();
      const args = { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth };
      return session.role === 'child'
        ? db.rpc('child_save_push_subscription', { p_token: session.token, ...args })
        : db.rpc('save_push_subscription', args);
    }

    function removePushOnServer(endpoint) {
      return session.role === 'child'
        ? db.rpc('child_remove_push_subscription', { p_token: session.token, p_endpoint: endpoint })
        : db.rpc('remove_push_subscription', { p_endpoint: endpoint });
    }

    async function syncPushSubscription() {
      try {
        const sub = await currentPushSubscription();
        if (!sub) return;
        const json = sub.toJSON();
        await savePushToServer(sub);
      } catch (e) { /* not important */ }
    }

    async function removePushFromServer() {
      try {
        const sub = await currentPushSubscription();
        if (sub) await removePushOnServer(sub.endpoint);
      } catch (e) { /* not important */ }
    }

    function check(res) {
      if (res.error) {
        alert(res.error.message || 'Something went wrong.');
        return false;
      }
      return true;
    }

    function getChildToken() {
      try { return JSON.parse(localStorage.getItem(childKey) || 'null')?.token || null; } catch (e) { return null; }
    }

    function fmtDate(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function addDays(dateStr, n) {
      const [y, m, d] = dateStr.split('-').map(Number);
      return fmtDate(new Date(y, m - 1, d + n));
    }

    function dayDiff(fromStr, toStr) {
      const [y1, m1, d1] = fromStr.split('-').map(Number);
      const [y2, m2, d2] = toStr.split('-').map(Number);
      return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
    }

    function weekdayOf(dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(y, m - 1, d).getDay();
    }

    // Next selected weekday after a given date; if that has already passed, today onwards
    // Next selected weekday after a given date, passing over skipped days.
    // If that has already passed, start from today instead.
    function nextRecurringDate(days, afterDate, skips = []) {
      let cursor = afterDate;
      for (let step = 0; step < 60; step++) {
        let next = null;
        for (let i = 1; i <= 7; i++) {
          const candidate = addDays(cursor, i);
          if (days.includes(weekdayOf(candidate))) { next = candidate; break; }
        }
        if (!next) break;
        if (!skips.includes(next)) return next < todayStr() ? firstOccurrence(days, skips) : next;
        cursor = next;
      }
      return firstOccurrence(days, skips);
    }

    function isSkippedOn(item, date) {
      return (item.skip_dates || []).includes(date);
    }

    function prettyDate(dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    // How far through its time a goal is (0 to 100) and how many days are left
    function goalProgress(goal) {
      const now = new Date();
      const [y, m, d] = goal.due_date.split('-').map(Number);
      const repeating = (goal.recurring_days || []).length > 0;
      // A repeating goal only counts its own day: the bar runs from 6am to 9pm that day.
      // Other goals run from when they were created to the end of the due day.
      const end = repeating ? new Date(y, m - 1, d, 21, 0) : new Date(y, m - 1, d + 1);
      const start = repeating
        ? new Date(y, m - 1, d, 6, 0)
        : (goal.created_at ? new Date(goal.created_at) : new Date(end.getTime() - 7 * 86400000));
      const total = end - start;
      const pct = total > 0 ? Math.min(100, Math.max(0, ((now - start) / total) * 100)) : 100;
      return { pct, daysLeft: dayDiff(todayStr(), goal.due_date) };
    }

    function repeatLabel(days) {
      return (days || []).length
        ? ' Repeats: ' + [...days].sort().map((d) => DAY_NAMES[d]).join(', ') + '.'
        : '';
    }

    function childName(childId) {
      return family?.children.find((child) => child.id === childId)?.name || 'Child';
    }

    function activeChild() {
      return family?.children.find((child) => child.id === session?.childId);
    }

    function setMessage(id, message) {
      const element = $(id);
      if (element) element.textContent = message || '';
    }

    function requestMessage(request) {
      return childName(request.child_id) + ' has completed this challenge: ' + request.challenge_name;
    }

    // Returns 'changed' | 'same' | 'expired' | 'error'
    async function loadParentData(silent) {
      if (!silent) loading = true;
      const familyId = session.familyId;
      const { data: familyRow, error } = await db
        .from('families')
        .select('id, family_name, family_code')
        .eq('id', familyId)
        .maybeSingle();

      if (error) { loading = false; return 'error'; }
      if (!familyRow) { loading = false; return 'expired'; }

      const [childrenRes, challengesRes, goalsRes, rewardsRes, requestsRes, membersRes, logRes, consRes, approvalsRes, notesRes, activitiesRes, summariesRes] = await Promise.all([
        db.from('children').select('id, family_id, name, points, created_at').eq('family_id', familyId).order('created_at', { ascending: true }),
        db.from('challenges').select('*').eq('family_id', familyId).order('created_at', { ascending: true }),
        db.from('goals').select('*').eq('family_id', familyId).order('due_date', { ascending: true }),
        db.from('rewards').select('*').eq('family_id', familyId).order('created_at', { ascending: true }),
        db.from('completion_requests').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
        db.from('family_members').select('*').eq('family_id', familyId).order('created_at', { ascending: true }),
        db.from('points_log').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(500),
        db.from('consequences').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
        db.from('approvals').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(200),
        db.from('notes').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(100),
        db.from('activities').select('*').eq('family_id', familyId).order('activity_date', { ascending: true }),
        db.from('weekly_summaries').select('*').eq('family_id', familyId).order('week_start', { ascending: false }).limit(12)
      ]);

      const members = membersRes.data || [];
      const next = {
        ...familyRow,
        children: childrenRes.data || [],
        challenges: challengesRes.data || [],
        goals: goalsRes.data || [],
        rewards: rewardsRes.data || [],
        requests: requestsRes.data || [],
        parents: members,
        parent_emails: members.map((m) => m.email).filter(Boolean),
        log: logRes.data || [],
        consequences: consRes.data || [],
        approvals: approvalsRes.data || [],
        notes: notesRes.data || [],
        activities: activitiesRes.data || [],
        summaries: summariesRes.data || []
      };
      const changed = !family || JSON.stringify(next) !== JSON.stringify(family);
      family = next;
      loading = false;
      return changed ? 'changed' : 'same';
    }

    async function loadChildData(silent) {
      const token = session.token || getChildToken();
      if (!token) return 'expired';
      if (!silent) loading = true;
      const { data, error } = await db.rpc('child_state', { p_token: token });
      if (error) {
        loading = false;
        return /expired/i.test(error.message || '') ? 'expired' : 'error';
      }
      if (!data) { loading = false; return 'expired'; }

      const next = {
        id: data.family_id,
        family_name: data.family_name,
        family_code: null,
        children: [data.child],
        challenges: data.challenges || [],
        goals: data.goals || [],
        rewards: data.rewards || [],
        requests: data.requests || [],
        parents: [],
        parent_emails: data.parent_emails || [],
        log: data.log || [],
        consequences: data.consequences || [],
        notes: data.notes || [],
        activities: data.activities || []
      };
      const changed = !family || JSON.stringify(next) !== JSON.stringify(family);
      family = next;
      loading = false;
      return changed ? 'changed' : 'same';
    }

    async function loadData(silent = false) {
      if (!session) return 'error';
      return session.role === 'child' ? loadChildData(silent) : loadParentData(silent);
    }

    // Quietly re-check the database and only redraw if something changed
    // Quietly re-check the database and only redraw if something changed
    let lastAutoRefresh = 0;
    let realtimeChannel = null;
    let realtimeTimer = null;

    async function autoRefresh() {
      if (!session || loading || document.hidden) return;
      // Children check every 5 seconds; parents every 15 (they also get instant live updates)
      const every = session.role === 'child' ? 5000 : 15000;
      if (Date.now() - lastAutoRefresh < every - 500) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox'))) return;
      lastAutoRefresh = Date.now();
      const result = await loadData(true);
      if (result === 'changed') render();
      else if (result === 'expired') signOut();
    }

    // Live updates for signed-in parents: the database tells us the moment anything changes
    function startRealtime() {
      if (realtimeChannel || !session || session.role !== 'parent') return;
      const familyId = session.familyId;
      let channel = db.channel('family-' + familyId);
      ['children', 'challenges', 'goals', 'rewards', 'completion_requests', 'consequences', 'points_log', 'family_members', 'approvals', 'notes', 'activities', 'weekly_summaries'].forEach((table) => {
        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: 'family_id=eq.' + familyId }, () => {
          clearTimeout(realtimeTimer);
          realtimeTimer = setTimeout(() => { lastAutoRefresh = 0; autoRefresh(); }, 300);
        });
      });
      channel.subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('Live updates unavailable, falling back to checking every 15 seconds:', status);
      });
      realtimeChannel = channel;
    }

    function stopRealtime() {
      clearTimeout(realtimeTimer);
      if (realtimeChannel) {
        db.removeChannel(realtimeChannel);
        realtimeChannel = null;
      }
    }

    async function refreshAndRender() {
      const result = await loadData(false);
      if (result === 'expired') { signOut(); return; }
      render();
    }

    function resetState() {
      stopRealtime();
      session = null;
      family = null;
      loading = false;
      needsOnboarding = false;
      activeTab = 'family';
      editing = null;
      document.title = 'Parental Rewards';
      setMobileView('home');
    }

    async function enterParent(user) {
      booting = false;
      localStorage.removeItem(childKey);
      const { data: member, error } = await db.from('family_members').select('*').eq('user_id', user.id).maybeSingle();
      if (error) {
        resetState();
        render();
        setMessage('#parentError', 'Could not load your account: ' + error.message);
        return;
      }
      if (!member) {
        session = null;
        family = null;
        needsOnboarding = true;
        $('#onboardEmail').textContent = user.email || '';
        render();
        return;
      }
      needsOnboarding = false;
      session = { role: 'parent', familyId: member.family_id, parentName: member.name, memberRole: member.role, userId: user.id };
      const openParam = new URLSearchParams(window.location.search).get('open');
      activeTab = new URLSearchParams(window.location.search).get('tab') === 'requests' ? 'requests' : 'family';
      if (window.location.search) history.replaceState(null, '', window.location.pathname);
      await refreshAndRender();
      syncPushSubscription();
      startRealtime();
      if (openParam === 'summary') openSummary();
    }

    async function enterChild() {
      booting = false;
      needsOnboarding = false;
      const token = getChildToken();
      session = { role: 'child', token };
      const result = await loadChildData(false);
      if (result !== 'changed' && result !== 'same') {
        localStorage.removeItem(childKey);
        resetState();
        render();
        return;
      }
      session = { role: 'child', token, familyId: family.id, childId: family.children[0].id };
      activeTab = 'challenges';
      render();
      syncPushSubscription();
    }

    async function startFromAuth(authSession) {
      if (authSession?.user) await enterParent(authSession.user);
      else if (getChildToken()) await enterChild();
      else { booting = false; resetState(); render(); }
    }

    async function afterOnboard() {
      const { data } = await db.auth.getUser();
      if (data?.user) await enterParent(data.user);
    }

    function setAuthTab(tab) {
      $$('[data-auth-tab]').forEach((button) => button.classList.toggle('active', button.dataset.authTab === tab));
      $$('.auth-panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.authPanel !== tab));
      $$('.error, .notice').forEach((el) => el.textContent = '');
    }

    function setOnboardTab(tab) {
      $$('[data-onboard-tab]').forEach((button) => button.classList.toggle('active', button.dataset.onboardTab === tab));
      $$('.onboard-panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.onboardPanel !== tab));
      $$('.error, .notice').forEach((el) => el.textContent = '');
    }

    async function signOut() {
      if (session?.role === 'parent' || session?.role === 'child') await removePushFromServer();
      const token = getChildToken();
      if (token) {
        db.rpc('child_logout', { p_token: token });
        localStorage.removeItem(childKey);
      }
      if (session?.role === 'parent' || needsOnboarding) {
        await db.auth.signOut({ scope: 'local' });
      }
      resetState();
      render();
    }

    function render() {
      $('#onboardScreen').classList.toggle('hidden', booting || !needsOnboarding);
      if (booting || needsOnboarding) {
        $('#authScreen').classList.add('hidden');
        $('#appScreen').classList.add('hidden');
        return;
      }
      if (!session) {
        $('#authScreen').classList.remove('hidden');
        $('#appScreen').classList.add('hidden');
        return;
      }

      if (!family || loading) {
        $('#authScreen').classList.add('hidden');
        $('#appScreen').classList.remove('hidden');
        $('#pageTitle').textContent = 'Loading...';
        $('#pageSubtitle').textContent = 'Getting family data from Supabase.';
        return;
      }

      const child = activeChild();
      const isParent = session.role === 'parent';
      if (!isParent && !child) {
        signOut();
        return;
      }

      $('#authScreen').classList.add('hidden');
      $('#appScreen').classList.remove('hidden');
      $('#profileLabel').textContent = isParent ? 'Parent account' : 'Child account';
      $('#profileName').textContent = isParent ? (session.parentName || 'Parent') : child.name;
      $('#profileDetail').textContent = isParent ? 'Family code: ' + family.family_code : family.family_name;
      $('#sidebarNote').textContent = isParent
        ? 'Give children the family code and their name so they can sign in.'
        : 'Finish challenges, complete goals, and keep track of rewards and consequences.';

      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      $('#pageTitle').textContent = greeting + ', ' + (isParent ? (session.parentName || 'there') : child.name);
      $('#pageSubtitle').textContent = prettyDate(todayStr()) + (isParent ? ' · ' + family.family_name : '');
      $('#scoreLabel').textContent = isParent ? 'Family points' : 'My points';
      $('#mobileSettingsLabel').textContent = isParent ? 'Settings' : 'Profile';
      $('#scoreValue').textContent = isParent
        ? family.children.reduce((sum, kid) => sum + kid.points, 0)
        : child.points;

      $$('.parent-only').forEach((item) => item.classList.toggle('hidden', !isParent));

      // One page, no tabs: show the sections in order of importance for who is signed in
      const order = isParent
        ? { overviewSection: -2, todaySection: -1, attentionSection: 0, childrenSection: 1, goalsSection: 2, activitiesSection: 3, feedbackSection: 4, calendarSection: 5, consequenceSection: 6, challengesSection: 7, rewardsSection: 8, aiSummarySection: 9, summarySection: 10, historySection: 11, settingsSection: 12, themeSection: 13 }
        : { todaySection: -1, feedbackSection: 0, consequenceSection: 1, goalsSection: 2, activitiesSection: 3, calendarSection: 4, challengesSection: 5, rewardsSection: 6, historySection: 7, themeSection: 8 };
      Object.entries(order).forEach(([id, position]) => { $('#' + id).style.order = position; });
      // Children have no Activity page, so their history sits on their Profile page
      $('#historySection').dataset.view = isParent ? 'activity' : 'settings';
      $('#feedbackSection').dataset.view = isParent ? 'activity' : 'home';
      $('#navActivity').classList.toggle('hidden', !isParent);

      renderParents();
      renderChildren();
      renderChallengeSelect();
      renderChallenges();
      renderGoalSelect();
      renderConsequenceSelect();
      renderChildPicker('feedbackChildren');
      renderChildPicker('activityChildren');
      renderGoals();
      renderRewards();
      renderConsequences();
      renderRequests();
      renderHistory();
      renderApprovals();
      renderSummary();
      renderActivities();
      renderFeedback();
      renderCalendar();
      renderOverview();
      renderSummaries();
      renderToday();
      updatePushUI();
    }

    function renderChildren() {
      const list = $('#childrenList');
      if (session.role !== 'parent') { list.innerHTML = ''; return; }
      if (!family.children.length) {
        list.innerHTML = '<div class="empty">No children added yet. Use "+ Add child" above.</div>';
        return;
      }

      list.innerHTML = family.children.map((child) => {
        const activeGoals = family.goals.filter((g) => g.child_id === child.id && g.status === 'active').length;
        return `
        <article class="item kid-card">
          <div class="kid-top">
            <span class="avatar">${esc(child.name.charAt(0).toUpperCase())}</span>
            <div>
              <div class="item-title">${esc(child.name)}</div>
              <div class="meta">${activeGoals} active ${activeGoals === 1 ? 'goal' : 'goals'}</div>
            </div>
            <span class="pill green">${child.points} points</span>
          </div>
          <div class="row"><button class="btn ghost small" type="button" onclick="openChildDetail('${child.id}')">View details</button><button class="btn ghost small" type="button" onclick="openFeedbackFor('${child.id}')">Give feedback</button><button class="btn ghost small" type="button" onclick="openChildSetup('${child.id}')">Quick setup</button></div>
          <details class="inline-edit">
            <summary>Manage</summary>
            <div class="row">
              <input id="name-${child.id}" value="${esc(child.name)}" maxlength="40" style="width:170px" aria-label="Name for ${esc(child.name)}" />
              <button class="btn secondary small" type="button" onclick="renameChild('${child.id}')">Save name</button>
            </div>
            <div class="row">
              <input id="points-${child.id}" type="number" min="0" step="1" value="${child.points}" style="width:170px" aria-label="Points for ${esc(child.name)}" />
              <button class="btn secondary small" type="button" onclick="setChildPoints('${child.id}')">Save points</button>
            </div>
            <div class="row">
              <button class="btn danger small" type="button" onclick="deleteChildAccount('${child.id}')">Remove child</button>
            </div>
          </details>
        </article>
      `;
      }).join('');
    }

    function renderChildPicker(containerId) {
      const box = $('#' + containerId);
      const checked = new Set($$('#' + containerId + ' input[data-child]:checked').map((b) => b.value));
      if (!family.children.length) {
        box.innerHTML = '<span class="meta">Add a child first.</span>';
        return;
      }
      const only = family.children.length === 1;
      const allChecked = family.children.every((c) => checked.has(c.id));
      box.innerHTML = (only ? '' : `<label><input type="checkbox" data-all ${allChecked ? 'checked' : ''} /> All</label>`)
        + family.children.map((child) =>
          `<label><input type="checkbox" data-child value="${child.id}" ${checked.has(child.id) || only ? 'checked' : ''} /> ${esc(child.name)}</label>`
        ).join('');
    }

    function renderChallengeSelect() { renderChildPicker('challengeChildren'); }
    function renderGoalSelect() { renderChildPicker('goalChildren'); }
    function renderConsequenceSelect() { renderChildPicker('consequenceChildren'); }

    function renderParents() {
      const isOwner = session.memberRole === 'owner';
      $('#familyCodeDisplay').textContent = family.family_code || '';
      const familyInput = $('#familyNameInput');
      if (familyInput && document.activeElement !== familyInput) familyInput.value = family.family_name || '';
      $('#parentsList').innerHTML = (family.parents || []).map((p) => {
        const canEdit = p.user_id === session.userId || isOwner;
        return `
        <article class="item">
          <div class="item-header">
            <div>
              <div class="item-title">${esc(p.name)}</div>
              <div class="meta">${esc(p.email)}${p.role === 'owner' ? ' (account owner)' : ''}${p.user_id === session.userId ? ' (you)' : ''}</div>
            </div>
            ${isOwner && p.role !== 'owner' ? `<button class="btn secondary" type="button" onclick="removeParent('${p.user_id}')">Remove</button>` : ''}
          </div>
          ${canEdit ? `
          <div class="row">
            <input id="parent-name-${p.user_id}" value="${esc(p.name)}" maxlength="40" style="width:200px" aria-label="Name for ${esc(p.name)}" />
            <button class="btn secondary" type="button" onclick="renameParent('${p.user_id}')">Save name</button>
          </div>` : ''}
        </article>
      `;
      }).join('');
    }

    function renderHistory() {
      const list = $('#historyList');
      const isParent = session.role === 'parent';
      const entries = (family.log || []).filter((e) => isParent || e.child_id === session.childId);
      $('#historyCount').textContent = entries.length ? '(' + entries.length + ')' : '';
      if (!entries.length) {
        list.innerHTML = '<div class="empty">No points activity yet.</div>';
        return;
      }
      list.innerHTML = entries.map((e) => {
        const when = new Date(e.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const plus = e.amount > 0;
        return `
          <article class="item">
            <div class="item-header">
              <div>
                <div class="item-title">${esc(e.reason)}</div>
                <div class="meta">${isParent ? esc(childName(e.child_id)) + ' · ' : ''}${when}</div>
              </div>
              <span class="pill ${plus ? 'green' : 'amber'}">${plus ? '+' : ''}${e.amount} points</span>
            </div>
          </article>
        `;
      }).join('');
    }

    function setPicker(containerId, ids) {
      const kids = $$('#' + containerId + ' input[data-child]');
      kids.forEach((b) => b.checked = ids.includes(b.value));
      const all = $('#' + containerId + ' [data-all]');
      if (all) all.checked = kids.every((b) => b.checked);
    }

    function setDays(containerId, days) {
      $$('#' + containerId + ' input').forEach((b) => b.checked = days.includes(Number(b.value)));
    }

    function openForm(formId) {
      const details = $('#' + formId).closest('details');
      if (!details) return;
      // On phones the form may be on another page: switch to it first
      let top = details;
      while (top.parentElement && top.parentElement.tagName !== 'MAIN') top = top.parentElement;
      if (top.dataset.view && mobileView !== top.dataset.view) setMobileView(top.dataset.view);
      for (let d = details; d; d = d.parentElement ? d.parentElement.closest('details') : null) d.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function closeForm(formId) {
      const details = $('#' + formId)?.closest('details');
      if (details) details.open = false;
    }

    function cancelEdit() {
      editing = null;
      ['challengeForm', 'goalForm', 'rewardForm', 'consequenceForm', 'activityForm'].forEach((id) => $('#' + id).reset());
      lastManualActivityDate = null;
      $('#activityDate').value = todayStr();
      $('#challengePoints').value = 10;
      $('#goalDueDate').value = nextDate(7);
      $('#rewardCost').value = 50;
      $('#rewardLimit').value = 1;
      $('#rewardUntil').value = nextDate(14);
      $('#challengeFormTitle').textContent = 'Add challenge';
      $('#goalFormTitle').textContent = 'Add goal';
      $('#goalSkipBox').classList.add('hidden');
      $('#rewardFormTitle').textContent = 'Add reward';
      $('#consequenceFormTitle').textContent = 'Add consequence';
      $('#activityFormTitle').textContent = 'Add activity';
      $('#challengeSubmit').textContent = 'Create challenge';
      $('#goalSubmit').textContent = 'Create goal';
      $('#rewardSubmit').textContent = 'Create reward';
      $('#consequenceSubmit').textContent = 'Add consequence';
      $('#activitySubmit').textContent = 'Add activity';
      ['challengeCancel', 'goalCancel', 'rewardCancel', 'consequenceCancel', 'activityCancel'].forEach((id) => $('#' + id).classList.add('hidden'));
      ['#challengeError', '#goalError', '#rewardError', '#consequenceError', '#activityError'].forEach((id) => setMessage(id, ''));
      updateGoalDueState();
      updateGoalConsequenceUI();
      updateConsequenceUI();
      updateActivityUI();
      ['challengeForm', 'goalForm', 'rewardForm', 'consequenceForm', 'activityForm'].forEach(closeForm);
      if (family) { renderChallengeSelect(); renderGoalSelect(); renderConsequenceSelect(); renderChildPicker('activityChildren'); }
    }

    function startEditReward(id) {
      const r = family.rewards.find((x) => x.id === id);
      if (!r) return;
      cancelEdit();
      editing = { type: 'reward', id };
      $('#rewardName').value = r.name;
      $('#rewardCost').value = r.cost;
      $('#rewardLimit').value = r.limit_count;
      $('#rewardUntil').value = r.available_until;
      $('#rewardFormTitle').textContent = 'Edit reward';
      $('#rewardSubmit').textContent = 'Save changes';
      $('#rewardCancel').classList.remove('hidden');
      openForm('rewardForm');
    }

    function startEditConsequence(id) {
      const c = family.consequences.find((x) => x.id === id);
      if (!c) return;
      cancelEdit();
      editing = { type: 'consequence', id };
      if (GOAL_CONSEQUENCE_PRESETS.includes(c.name)) {
        $('#consequenceChoice').value = c.name;
        $('#consequenceName').value = '';
      } else {
        $('#consequenceChoice').value = '__other';
        $('#consequenceName').value = c.name;
      }
      updateConsequenceUI();
      $('#consequenceDetails').value = c.details || '';
      $('#consequenceDays').value = c.ends_on ? dayDiff(c.starts_on, c.ends_on) + 1 : '';
      setPicker('consequenceChildren', [c.child_id]);
      $('#consequenceFormTitle').textContent = 'Edit consequence';
      $('#consequenceSubmit').textContent = 'Save changes';
      $('#consequenceCancel').classList.remove('hidden');
      openForm('consequenceForm');
    }

    function startEditChallenge(id) {
      const c = family.challenges.find((x) => x.id === id);
      if (!c) return;
      cancelEdit();
      editing = { type: 'challenge', id };
      $('#challengeName').value = c.name;
      $('#challengePoints').value = c.points;
      $('#challengeDetails').value = c.details || '';
      setPicker('challengeChildren', [c.child_id]);
      setDays('challengeDays', c.recurring_days || []);
      $('#challengeFormTitle').textContent = 'Edit challenge';
      $('#challengeSubmit').textContent = 'Save changes';
      $('#challengeCancel').classList.remove('hidden');
      openForm('challengeForm');
    }

    function startEditGoal(id) {
      const g = family.goals.find((x) => x.id === id);
      if (!g) return;
      cancelEdit();
      editing = { type: 'goal', id };
      $('#goalName').value = g.name;
      $('#goalDetails').value = g.details || '';
      if (GOAL_CONSEQUENCE_PRESETS.includes(g.consequence)) {
        $('#goalConsequenceChoice').value = g.consequence;
        $('#goalConsequence').value = '';
      } else {
        $('#goalConsequenceChoice').value = '__other';
        $('#goalConsequence').value = g.consequence || '';
      }
      updateGoalConsequenceUI();
      $('#goalConsequenceDays').value = g.consequence_days || '';
      $('#goalDueDate').value = g.due_date;
      setPicker('goalChildren', [g.child_id]);
      setDays('goalDays', g.recurring_days || []);
      updateGoalDueState();
      $('#goalFormTitle').textContent = 'Edit goal';
      renderGoalSkipList(g);
      $('#goalSubmit').textContent = 'Save changes';
      $('#goalCancel').classList.remove('hidden');
      openForm('goalForm');
    }

    const GOAL_CONSEQUENCE_PRESETS = ['No screens', 'Early bedtime', 'No dessert or treats'];

    // Dropdown choice, or the typed text when "Other..." is picked
    function getGoalConsequence() {
      return $('#goalConsequenceChoice').value === '__other'
        ? $('#goalConsequence').value.trim()
        : $('#goalConsequenceChoice').value;
    }

    function updateGoalConsequenceUI() {
      const other = $('#goalConsequenceChoice').value === '__other';
      $('#goalConsequenceOtherWrap').classList.toggle('hidden', !other);
      $('#goalConsequence').required = other;
    }

    // Same dropdown as goals: three presets, or "Other..." to type your own
    function getConsequenceName() {
      return $('#consequenceChoice').value === '__other'
        ? $('#consequenceName').value.trim()
        : $('#consequenceChoice').value;
    }

    function updateConsequenceUI() {
      const other = $('#consequenceChoice').value === '__other';
      $('#consequenceOtherWrap').classList.toggle('hidden', !other);
      $('#consequenceName').required = other;
    }

    function updateGoalDueState() {
      const recurring = $$('#goalDays input:checked').length > 0;
      $('#goalDueDate').disabled = recurring;
      $('#goalDueNote').textContent = recurring ? '(set automatically from repeat days)' : '';
    }

    function renderChallenges() {
      const list = $('#challengeList');
      const isParent = session.role === 'parent';
      const child = activeChild();
      const today = todayStr();
      const dow = new Date().getDay();

      const isRecurring = (c) => (c.recurring_days || []).length > 0;
      const doneToday = (c) => c.last_completed_date === today;
      const dueToday = (c) => !isRecurring(c) || (c.recurring_days.includes(dow) && !isSkippedOn(c, today));

      const challenges = isParent
        ? family.challenges
        : family.challenges.filter((c) => c.child_id === child.id && dueToday(c) && !doneToday(c));

      if (!challenges.length) {
        list.innerHTML = '<div class="empty">' + (isParent ? 'No optional challenges yet.' : 'No optional challenges right now.') + '</div>';
        return;
      }

      list.innerHTML = challenges.map((challenge) => {
        const waitingRequest = family.requests.find((r) => r.challenge_id === challenge.id && r.status === 'waiting');
        const latest = family.requests.find((r) => r.challenge_id === challenge.id);
        const deniedNote = !isParent && latest && latest.status === 'denied'
          ? `<div class="denied-note">Sent back by your parent${latest.deny_reason ? ': ' + esc(latest.deny_reason) : '.'}</div>`
          : '';
        const bits = [
          isParent ? 'For ' + childName(challenge.child_id) : '',
          isRecurring(challenge) ? 'Repeats ' + [...challenge.recurring_days].sort().map((d) => DAY_NAMES[d]).join(', ') : '',
          challenge.details || ''
        ].filter(Boolean).map(esc).join(' · ');

        const skippedToday = isRecurring(challenge) && isSkippedOn(challenge, today);
        const skipBtn = isRecurring(challenge) && challenge.recurring_days.includes(dow)
          ? `<button class="btn small" type="button" onclick="setOccurrenceSkipped('challenge', '${challenge.id}', '${today}', ${!skippedToday})">${skippedToday ? 'Restore today' : 'Skip today'}</button>`
          : '';
        const actions = isParent
          ? (skippedToday
              ? '<span class="pill">Skipped today</span>'
              : doneToday(challenge)
                ? '<span class="pill green">Done today</span>'
                : approveIconBtn(`approveChallenge('${challenge.id}')`))
            + moreMenu(skipBtn
              + `<button class="btn small" type="button" onclick="startEditChallenge('${challenge.id}')">Edit</button>`
              + `<button class="btn small danger-text" type="button" onclick="deleteChallenge('${challenge.id}')">Delete</button>`)
          : (waitingRequest
              ? '<span class="pill amber">Sent</span>'
              : `<button class="btn ghost small" type="button" onclick="sendCompletionRequest('${challenge.id}')">✓ I finished this</button>`);

        return `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(challenge.name)}</div>
              ${bits ? `<div class="row-meta">${bits}</div>` : ''}
              ${deniedNote}
            </div>
            <span class="pill green">${challenge.points} pts</span>
            <div class="row-actions">${actions}</div>
          </article>
        `;
      }).join('');
    }

    // A repeating goal that was just done stays hidden from the child until its next day
    function isWaitingForNextDay(goal) {
      return (goal.recurring_days || []).length > 0 && goal.status === 'active' && goal.due_date > todayStr();
    }

    function goalStatusLabel(goal) {
      if (goal.status === 'completed') return 'Completed';
      if (goal.status === 'consequence') return 'Consequence active';
      if (goal.status === 'waiting') return 'Waiting for approval';
      if ((goal.recurring_days || []).length && goal.status === 'active' && goal.due_date > todayStr()) return 'Upcoming';
      if (goal.due_date === todayStr()) return 'Due today';
      if (goal.due_date < todayStr()) return 'Overdue';
      return 'Active';
    }

    function renderGoals() {
      const list = $('#goalList');
      const isParent = session.role === 'parent';
      const child = activeChild();
      const goals = isParent
        ? family.goals
        : family.goals.filter((goal) => goal.child_id === child.id);

      const openGoals = goals.filter((g) => g.status !== 'completed' && !isWaitingForNextDay(g));
      const overdueGoals = openGoals.filter((g) => g.status === 'active' && g.due_date < todayStr());
      $('#goalsMeta').innerHTML = (openGoals.length ? openGoals.length + ' open' : 'None open')
        + (overdueGoals.length ? ' \u00b7 <span style="color:var(--red);font-weight:600">' + overdueGoals.length + ' overdue</span>' : '');

      if (!goals.length) {
        list.innerHTML = '<div class="empty">No goals yet.</div>';
        return;
      }

      let open = goals.filter((g) => g.status !== 'completed' && !isWaitingForNextDay(g)).sort((a, b) => a.due_date.localeCompare(b.due_date));
      let upcomingGoals = goals.filter(isWaitingForNextDay).sort((a, b) => a.due_date.localeCompare(b.due_date));
      let done = goals.filter((g) => g.status === 'completed');

      // Picked from the overview chart: only overdue goals, or only goals due today
      const filtering = isParent && !!goalFilter;
      let banner = '';
      if (filtering) {
        const today = todayStr();
        open = goals.filter((g) =>
          g.status === 'active' && !isWaitingForNextDay(g)
          && (goalFilter.childId === 'all' || g.child_id === goalFilter.childId)
          && (goalFilter.kind === 'overdue' ? g.due_date < today : g.due_date === today)
        ).sort((a, b) => a.due_date.localeCompare(b.due_date));
        upcomingGoals = [];
        done = [];
        const kidName = goalFilter.childId !== 'all' ? childName(goalFilter.childId) : '';
        banner = `<div class="filter-banner"><span>Showing <strong>${goalFilter.kind === 'overdue' ? 'overdue goals' : 'goals due today'}</strong>${kidName ? ' for ' + esc(kidName) : ''}</span><button class="btn ghost small" type="button" onclick="clearGoalFilter()">Show all goals</button></div>`;
      }

      const card = (goal) => {
        const p = goalProgress(goal);
        const upcoming = isWaitingForNextDay(goal);
        let tone = 'ok';
        let fill = p.pct;
        let label;
        if (goal.status === 'waiting') {
          tone = 'wait'; fill = 100; label = 'Waiting for approval';
        } else if (goal.status === 'consequence') {
          tone = 'bad'; fill = 100; label = 'Consequence active';
        } else if (p.daysLeft < 0) {
          tone = 'bad'; fill = 100; label = 'Overdue by ' + (-p.daysLeft) + (p.daysLeft === -1 ? ' day' : ' days');
        } else if (upcoming) {
          fill = 0; label = 'Next one starts ' + (p.daysLeft === 1 ? 'tomorrow' : 'in ' + p.daysLeft + ' days');
        } else {
          tone = p.pct >= 85 ? 'bad' : p.pct >= 60 ? 'warn' : 'ok';
          label = p.daysLeft === 0 ? 'Due today, ends tonight' : p.daysLeft === 1 ? '1 day left' : p.daysLeft + ' days left';
        }

        const overdue = goal.status !== 'consequence' && goal.status !== 'waiting' && goal.due_date < todayStr();
        let actions = '';
        let boxes = '';
        if (isParent) {
          if (goal.status === 'waiting') { const d = goalDecision(goal, 'g'); actions += d.buttons; boxes += d.boxes; }
          if (overdue) actions += `<button class="btn danger small" type="button" onclick="applyConsequence('${goal.id}')">Apply consequence</button><button class="btn ghost small" type="button" onclick="ignoreConsequence('${goal.id}')">Ignore consequence</button>`;
          let menu = '';
          if (goal.status === 'active' && (goal.recurring_days || []).length && goal.due_date >= todayStr()) menu += `<button class="btn small" type="button" onclick="setOccurrenceSkipped('goal', '${goal.id}', '${goal.due_date}', true)">Skip this one</button>`;
          menu += `<button class="btn small" type="button" onclick="startEditGoal('${goal.id}')">Edit</button>`;
          menu += `<button class="btn small danger-text" type="button" onclick="deleteGoal('${goal.id}')">Delete</button>`;
          actions += moreMenu(menu);
        } else if (goal.status === 'active' && !upcoming) {
          actions = `<button class="btn warning" type="button" onclick="markGoalDone('${goal.id}')">✓ I completed this goal</button>`;
        }

        const metaBits = [
          isParent ? 'For ' + childName(goal.child_id) : '',
          repeatLabel(goal.recurring_days).trim(),
          goal.details || ''
        ].filter(Boolean).map(esc).join(' ');

        return `
          <article class="item goal-card tone-${tone}">
            <div class="item-header">
              <div>
                <div class="item-title">${esc(goal.name)}</div>
                ${metaBits ? `<div class="meta">${metaBits}</div>` : ''}
              </div>
              <span class="pill ${goal.status === 'completed' ? 'green' : tone === 'bad' ? 'amber' : ''}">${goalStatusLabel(goal)}</span>
            </div>
            <div class="progress ${tone}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(fill)}"><span style="width:${fill}%"></span></div>
            <div class="progress-meta"><span>${label}</span><span>Due ${prettyDate(goal.due_date)}</span></div>
            ${goal.denied_at && goal.status === 'active' ? `<div class="denied-note">Sent back by your parent${goal.deny_reason ? ': ' + esc(goal.deny_reason) : '.'}</div>` : ''}
            <div class="goal-consequence">If missed: ${esc(goal.consequence)}${goal.consequence_days ? ' (for ' + goal.consequence_days + (goal.consequence_days === 1 ? ' day' : ' days') + ')' : ''}</div>
            ${actions ? `<div class="row">${actions}</div>` : ''}
            ${boxes}
          </article>
        `;
      };

      const doneRow = (goal) => `
        <div class="row-item">
          <div class="row-main">
            <div class="row-title">${esc(goal.name)}</div>
            <div class="row-meta">${isParent ? 'For ' + esc(childName(goal.child_id)) + ' · ' : ''}Due ${prettyDate(goal.due_date)}</div>
          </div>
          <span class="pill green">Completed</span>
          ${isParent ? `<button class="btn secondary small" type="button" onclick="deleteGoal('${goal.id}')">Delete</button>` : ''}
        </div>
      `;

      const upcomingRow = (goal) => `
        <div class="row-item">
          <div class="row-main">
            <div class="row-title">${esc(goal.name)}</div>
            <div class="row-meta">${isParent ? 'For ' + esc(childName(goal.child_id)) + ' · ' : ''}Next due ${prettyDate(goal.due_date)}${esc(repeatLabel(goal.recurring_days))}</div>
          </div>
          ${isParent ? `<button class="btn secondary small" type="button" onclick="startEditGoal('${goal.id}')">Edit</button><button class="btn secondary small" type="button" onclick="deleteGoal('${goal.id}')">Delete</button>` : ''}
        </div>
      `;

      list.innerHTML = banner + (open.length ? open.map(card).join('') : `<div class="empty">${filtering ? 'No goals match.' : 'No open goals right now.'}</div>`)
        + (upcomingGoals.length ? `<details class="done-list"><summary>Upcoming (${upcomingGoals.length})</summary>${upcomingGoals.map(upcomingRow).join('')}</details>` : '')
        + (done.length ? `<details class="done-list"><summary>Completed (${done.length})</summary>${done.map(doneRow).join('')}</details>` : '');
    }

    function renderRewards() {
      const list = $('#rewardList');
      const isParent = session.role === 'parent';
      const child = activeChild();
      const today = todayStr();

      if (!family.rewards.length) {
        list.innerHTML = '<div class="empty">No rewards created yet.</div>';
        return;
      }

      list.innerHTML = family.rewards.map((reward) => {
        const remaining = reward.limit_count - reward.claimed_count;
        const isAvailable = remaining > 0 && reward.available_until >= today;
        const canClaim = !isParent && child.points >= reward.cost && isAvailable;

        let progress = '';
        let hint = '';
        if (!isParent) {
          const pct = Math.min(100, Math.round((child.points / reward.cost) * 100));
          progress = `<div class="progress reward" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
          hint = !isAvailable
            ? (remaining <= 0 ? 'All claimed. ' : 'No longer available. ')
            : child.points >= reward.cost ? 'Ready to redeem! ' : (reward.cost - child.points) + ' more points to go. ';
        }

        const actions = isParent
          ? moreMenu(`<button class="btn small" type="button" onclick="startEditReward('${reward.id}')">Edit</button><button class="btn small danger-text" type="button" onclick="deleteReward('${reward.id}')">Delete</button>`)
          : `<button class="btn ${canClaim ? '' : 'secondary'}" type="button" ${canClaim ? '' : 'disabled'} onclick="claimReward('${reward.id}')">Redeem</button>`;

        return `
          <article class="item reward-card">
            <div class="item-header">
              <div class="item-title">${esc(reward.name)}</div>
              <span class="pill">${reward.cost} points</span>
            </div>
            ${progress}
            <div class="meta">${hint}${remaining} of ${reward.limit_count} left. Until ${prettyDate(reward.available_until)}.</div>
            <div class="row">${actions}</div>
          </article>
        `;
      }).join('');
    }

    function renderConsequences() {
      const list = $('#consequenceList');
      const isParent = session.role === 'parent';
      const child = activeChild();
      const today = todayStr();
      const mine = (x) => isParent || x.child_id === child.id;

      const active = (family.consequences || []).filter((c) => c.status === 'active' && mine(c));
      const linked = new Set(active.filter((c) => c.goal_id).map((c) => c.goal_id));
      // Goals in a consequence from before this version (no record), and goals whose deadline has passed
      const goalItems = family.goals.filter((g) => mine(g) && (
        (g.status === 'consequence' && !linked.has(g.id)) ||
        (g.status !== 'completed' && g.status !== 'consequence' && g.due_date < today)
      ));

      $('#consequenceSection').classList.toggle('hidden', !isParent && !active.length && !goalItems.length);
      if (!active.length && !goalItems.length) {
        list.innerHTML = isParent ? '' : '<div class="empty">No consequences to show.</div>';
        return;
      }

      const consequenceCard = (c) => {
        const ended = c.ends_on && c.ends_on < today;
        const left = c.ends_on ? dayDiff(today, c.ends_on) + 1 : 0;
        const endText = c.ends_on
          ? (ended ? 'Ended ' + prettyDate(c.ends_on) : left + (left === 1 ? ' day left' : ' days left') + ', ends at the end of ' + prettyDate(c.ends_on))
          : 'No end date';
        return `
          <article class="item">
            <div class="item-header">
              <div>
                <div class="item-title">${esc(c.name)}</div>
                <div class="meta">For ${esc(childName(c.child_id))}. Started ${c.starts_on}. ${endText}. ${esc(c.details)}</div>
              </div>
              <span class="pill ${ended ? 'green' : 'amber'}">${ended ? 'Ended' : 'Consequence'}</span>
            </div>
            ${isParent ? `
            <div class="row">
              <button class="btn success" type="button" onclick="resolveConsequence('${c.id}')">Mark resolved</button>
              ${moreMenu(`<button class="btn small" type="button" onclick="startEditConsequence('${c.id}')">Edit</button><button class="btn small danger-text" type="button" onclick="deleteConsequence('${c.id}')">Delete</button>`)}
            </div>` : ''}
          </article>
        `;
      };

      const goalCard = (goal) => `
        <article class="item">
          <div class="item-header">
            <div>
              <div class="item-title">${esc(goal.name)}</div>
              <div class="meta">For ${esc(childName(goal.child_id))}. Due ${goal.due_date}. Status: ${goalStatusLabel(goal)}</div>
            </div>
            <span class="pill amber">Consequence</span>
          </div>
          <div class="email-preview">
            <div><strong>Consequence:</strong> ${esc(goal.consequence)}${goal.consequence_days ? ' (for ' + goal.consequence_days + (goal.consequence_days === 1 ? ' day' : ' days') + ')' : ''}</div>
          </div>
          <div class="row">
            ${isParent && goal.status !== 'consequence' ? `<button class="btn danger" type="button" onclick="applyConsequence('${goal.id}')">Apply consequence</button>` : ''}
            ${isParent && goal.status === 'active' ? `<button class="btn ghost" type="button" onclick="ignoreConsequence('${goal.id}')">Ignore consequence</button>` : ''}
            ${isParent && goal.status === 'consequence' ? `<button class="btn success" type="button" onclick="clearConsequence('${goal.id}')">Mark resolved</button>` : ''}
          </div>
        </article>
      `;

      list.innerHTML = active.map(consequenceCard).join('') + goalItems.map(goalCard).join('');
    }

    function approveIconBtn(handler) {
      return `<button class="btn success small icon" type="button" title="Approve" aria-label="Approve" onclick="${handler}">✓</button>`;
    }

    function denyIconBtn(handler) {
      return `<button class="btn ghost-danger small icon" type="button" title="Deny" aria-label="Deny" onclick="${handler}">✕</button>`;
    }

    function requestCard(request) {
      const challenge = family.challenges.find((c) => c.id === request.challenge_id);
      const key = 'req-' + request.id;
      return `
        <article class="row-item can-deny">
          <div class="row-main">
            <div class="row-title">${esc(childName(request.child_id))} finished: ${esc(request.challenge_name)}</div>
            <div class="row-meta">Challenge${challenge ? ' · ' + challenge.points + ' points' : ''}</div>
          </div>
          <div class="row-actions">
            ${approveIconBtn(`approveChallenge('${request.challenge_id}')`)}
            ${denyIconBtn(`toggleDeny('${key}')`)}
          </div>
          <div class="deny-box hidden" id="deny-${key}">
            <input id="deny-reason-${key}" maxlength="200" placeholder="Reason (optional)" onkeydown="if (event.key === 'Enter') denyRequest('${request.id}')" />
            <button class="btn danger small" type="button" onclick="denyRequest('${request.id}')">Confirm deny</button>
            <button class="btn secondary small" type="button" onclick="toggleDeny('${key}')">Cancel</button>
          </div>
        </article>
      `;
    }

    // Tick / cross / tip controls for a goal waiting for a decision.
    // "scope" keeps element ids unique when the same goal appears in two places.
    function goalDecision(goal, scope) {
      const id = goal.id;
      const key = scope + '-' + id;
      const buttons =
        approveIconBtn(`approveGoal('${id}')`)
        + denyIconBtn(`toggleGoalBox('deny', '${key}')`)
        + `<button class="btn ghost small" type="button" title="Give bonus points for doing it really well" onclick="toggleGoalBox('tip', '${key}')">Tip</button>`;
      const boxes = `
        <div class="deny-box hidden" id="deny-goal-${key}">
          <input id="deny-reason-goal-${key}" maxlength="200" placeholder="Reason (optional)" onkeydown="if (event.key === 'Enter') denyGoal('${id}', '${key}')" />
          <button class="btn danger small" type="button" onclick="denyGoal('${id}', '${key}')">Confirm deny</button>
          <button class="btn secondary small" type="button" onclick="toggleGoalBox('deny', '${key}')">Cancel</button>
        </div>
        <div class="deny-box hidden" id="tip-goal-${key}">
          <span class="meta">Bonus for doing it really well:</span>
          <button class="btn ghost small" type="button" onclick="setTip('${key}', 5)">+5</button>
          <button class="btn ghost small" type="button" onclick="setTip('${key}', 10)">+10</button>
          <button class="btn ghost small" type="button" onclick="setTip('${key}', 20)">+20</button>
          <input id="tip-amount-${key}" type="number" min="1" max="1000" step="1" placeholder="points" style="flex:0 0 90px;min-width:90px" onkeydown="if (event.key === 'Enter') approveGoalWithTip('${id}', '${key}')" />
          <button class="btn success small" type="button" onclick="approveGoalWithTip('${id}', '${key}')">✓ Approve + tip</button>
          <button class="btn secondary small" type="button" onclick="toggleGoalBox('tip', '${key}')">Cancel</button>
        </div>
      `;
      return { buttons, boxes };
    }

    function toggleGoalBox(kind, key) {
      const target = document.getElementById(kind + '-goal-' + key);
      if (!target) return;
      ['deny', 'tip'].forEach((k) => {
        if (k !== kind) {
          const other = document.getElementById(k + '-goal-' + key);
          if (other) other.classList.add('hidden');
        }
      });
      target.classList.toggle('hidden');
      if (!target.classList.contains('hidden')) {
        const input = target.querySelector('input');
        if (input) input.focus();
      }
    }

    function setTip(key, amount) {
      const input = document.getElementById('tip-amount-' + key);
      if (input) { input.value = amount; input.focus(); }
    }

    function goalRequestCard(goal) {
      const d = goalDecision(goal, 'a');
      return `
        <article class="row-item can-deny">
          <div class="row-main">
            <div class="row-title">${esc(childName(goal.child_id))} completed: ${esc(goal.name)}</div>
            <div class="row-meta">Goal · due ${prettyDate(goal.due_date)}</div>
          </div>
          <div class="row-actions">${d.buttons}</div>
          ${d.boxes}
        </article>
      `;
    }

    function toggleDeny(key) {
      const box = document.getElementById('deny-' + key);
      if (!box) return;
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) document.getElementById('deny-reason-' + key).focus();
    }

    async function denyRequest(requestId) {
      if (session.role !== 'parent') return;
      const reason = document.getElementById('deny-reason-req-' + requestId).value.trim();
      const res = await db.from('completion_requests').update({ status: 'denied', deny_reason: reason || null }).eq('id', requestId);
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function denyGoal(goalId, key) {
      if (session.role !== 'parent') return;
      const reason = document.getElementById('deny-reason-goal-' + key).value.trim();
      const res = await db.from('goals').update({
        status: 'active',
        deny_reason: reason || null,
        denied_at: new Date().toISOString()
      }).eq('id', goalId);
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function approveGoalWithTip(goalId, key) {
      if (session.role !== 'parent') return;
      const goal = family.goals.find((g) => g.id === goalId);
      if (!goal) return;
      const amount = Math.round(Number(document.getElementById('tip-amount-' + key).value));
      if (!amount || amount < 1) {
        alert('Enter how many bonus points to give.');
        return;
      }
      const outcome = goalApprovalOutcome(goal);
      const { data, error } = await db.rpc('approve_goal', {
        p_goal_id: goalId, p_new_status: outcome.status, p_new_due: outcome.due, p_tip: amount
      });
      if (error) {
        alert(error.message);
        return;
      }
      await refreshAndRender();
      if (data) showToast('Approved with a +' + amount + ' tip: ' + goal.name, data);
    }

    // Tab labels like "Requests (3)" for parents, and the browser tab title
    function updateBadges() {
      const isParent = session.role === 'parent';
      const waitingChallenges = family.requests.filter((r) => r.status === 'waiting').length;
      const waitingGoals = family.goals.filter((g) => g.status === 'waiting').length;
      const total = waitingChallenges + waitingGoals;
      const badge = $('#attentionCount');
      badge.textContent = total;
      badge.classList.toggle('hidden', !total);
      $('#attentionSection').classList.toggle('calm', !total);
      const unreadNotes = isParent ? 0 : (family.notes || []).filter((n) => n.child_id === session.childId && !n.read_at).length;
      const badgeCount = isParent ? total : unreadNotes;
      const navBadge = $('#navBadge');
      navBadge.textContent = badgeCount;
      navBadge.classList.toggle('hidden', !badgeCount);
      document.title = badgeCount ? '(' + badgeCount + ') Parental Rewards' : 'Parental Rewards';
    }

    function renderRequests() {
      updateBadges();
      if (session.role !== 'parent') return;
      const list = $('#requestList');

      const groups = family.children.map((kid) => ({
        kid,
        requests: family.requests.filter((r) => r.child_id === kid.id && r.status === 'waiting'),
        goals: family.goals.filter((g) => g.child_id === kid.id && g.status === 'waiting')
      })).filter((g) => g.requests.length + g.goals.length);

      if (!groups.length) {
        list.innerHTML = '<div class="empty" style="background:transparent">Nothing waiting. You are all caught up.</div>';
        return;
      }

      list.innerHTML = groups.map(({ kid, requests, goals }) => `
        <section class="list">
          <h3>${esc(kid.name)} (${requests.length + goals.length})</h3>
          ${goals.map(goalRequestCard).join('')}
          ${requests.map(requestCard).join('')}
        </section>
      `).join('');
    }

    async function signUp(event) {
      event.preventDefault();
      setMessage('#createError', '');
      setMessage('#createNotice', '');
      const { data, error } = await db.auth.signUp({
        email: $('#createParentEmail').value.trim().toLowerCase(),
        password: $('#createParentPassword').value
      });
      if (error) {
        setMessage('#createError', error.message);
        return;
      }
      if (!data.session) {
        setMessage('#createNotice', 'Check your email to confirm your account, then come back and sign in.');
      }
    }

    async function parentSignIn(event) {
      event.preventDefault();
      setMessage('#parentError', '');
      setMessage('#parentNotice', '');
      const { error } = await db.auth.signInWithPassword({
        email: $('#parentSignInEmail').value.trim().toLowerCase(),
        password: $('#parentSignInPassword').value
      });
      if (error) {
        setMessage('#parentError', /invalid login/i.test(error.message) ? 'Email or password is not right.' : error.message);
      }
      // On success the auth listener signs us in.
    }

    async function forgotPassword() {
      setMessage('#parentError', '');
      setMessage('#parentNotice', '');
      const email = $('#parentSignInEmail').value.trim().toLowerCase();
      if (!email) {
        setMessage('#parentError', 'Type your email above first.');
        return;
      }
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
      if (error) {
        setMessage('#parentError', error.message);
        return;
      }
      setMessage('#parentNotice', 'If that email has an account, a reset link is on its way.');
    }

    async function setNewPassword(event) {
      event.preventDefault();
      setMessage('#recoverError', '');
      const { data, error } = await db.auth.updateUser({ password: $('#recoverPassword').value });
      if (error) {
        setMessage('#recoverError', error.message);
        return;
      }
      recovering = false;
      history.replaceState(null, '', window.location.pathname);
      $('#recoverForm').reset();
      setAuthTab('parent');
      await enterParent(data.user);
    }

    async function createFamily(event) {
      event.preventDefault();
      setMessage('#newFamilyError', '');
      const { error } = await db.rpc('create_family', {
        p_family_name: $('#newFamilyName').value.trim(),
        p_parent_name: $('#newParentName').value.trim()
      });
      if (error) {
        setMessage('#newFamilyError', error.message);
        return;
      }
      await afterOnboard();
    }

    async function joinFamily(event) {
      event.preventDefault();
      setMessage('#joinError', '');
      const { data, error } = await db.rpc('join_family', {
        p_code: $('#joinCode').value.trim(),
        p_parent_name: $('#joinName').value.trim()
      });
      if (error) {
        setMessage('#joinError', error.message);
        return;
      }
      if (!data) {
        setMessage('#joinError', 'That invite code is not valid or has expired.');
        return;
      }
      await afterOnboard();
    }

    async function claimFamily(event) {
      event.preventDefault();
      setMessage('#claimError', '');
      const { data, error } = await db.rpc('claim_legacy_family', {
        p_email: $('#claimEmail').value.trim(),
        p_passcode: $('#claimPasscode').value
      });
      if (error) {
        setMessage('#claimError', error.message);
        return;
      }
      if (!data) {
        setMessage('#claimError', 'That email or passcode is not right.');
        return;
      }
      await afterOnboard();
    }

    async function childSignIn(event) {
      event.preventDefault();
      setMessage('#childError', '');
      const { data: token, error } = await db.rpc('child_login', {
        p_family_code: $('#childFamilyCode').value.trim(),
        p_name: $('#childSignInName').value.trim()
      });
      if (error) {
        setMessage('#childError', error.message);
        return;
      }
      if (!token) {
        setMessage('#childError', 'Family code or child name is not right.');
        return;
      }
      localStorage.setItem(childKey, JSON.stringify({ token }));
      await enterChild();
    }

    async function createInvite() {
      setMessage('#inviteError', '');
      const { data, error } = await db.rpc('create_invite');
      if (error) {
        setMessage('#inviteError', error.message);
        return;
      }
      $('#inviteResult').innerHTML = `
        <div class="email-preview">
          <div><strong>Invite code:</strong> ${esc(data)}</div>
          <div>Works once and expires in 7 days.</div>
        </div>`;
    }

    async function regenerateCode() {
      if (!confirm('Generate a new family code? Children will need the new code the next time they sign in.')) return;
      const res = await db.rpc('regenerate_family_code');
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function addChild(event) {
      event.preventDefault();
      setMessage('#childAddError', '');
      const name = $('#childName').value.trim();
      if (family.children.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        setMessage('#childAddError', 'A child with that name already exists.');
        return;
      }
      const { data: created, error } = await db.from('children').insert({ family_id: family.id, name, points: 0 }).select('id').single();
      if (error) {
        setMessage('#childAddError', error.message);
        return;
      }
      event.target.reset();
      closeForm('childForm');
      await refreshAndRender();
      if (created) openChildSetup(created.id);
    }

    async function renameChild(childId) {
      if (session.role !== 'parent') return;
      const name = document.getElementById('name-' + childId).value.trim();
      if (!name) { alert('Please enter a name.'); return; }
      if (family.children.some((c) => c.id !== childId && c.name.toLowerCase() === name.toLowerCase())) {
        alert('Another child already has that name.');
        return;
      }
      const res = await db.from('children').update({ name }).eq('id', childId);
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function renameParent(userId) {
      if (session.role !== 'parent') return;
      const name = document.getElementById('parent-name-' + userId).value.trim();
      if (!name) { alert('Please enter a name.'); return; }
      const res = await db.rpc('rename_parent', { p_user_id: userId, p_name: name });
      if (!check(res)) return;
      if (userId === session.userId) session.parentName = name;
      await refreshAndRender();
    }

    async function removeParent(userId) {
      if (session.role !== 'parent') return;
      if (!confirm('Remove this parent? They will lose access to the family.')) return;
      const res = await db.rpc('remove_parent', { p_user_id: userId });
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function deleteChildAccount(childId) {
      if (session.role !== 'parent') return;
      const kid = family.children.find((c) => c.id === childId);
      if (!kid) return;
      if (!confirm('Remove ' + kid.name + '? This also deletes their points, challenges, goals and requests. This cannot be undone.')) return;
      const res = await db.rpc('remove_child', { p_child_id: childId });
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function addChallenge(event) {
      event.preventDefault();
      setMessage('#challengeError', '');
      const childIds = $$('#challengeChildren input[data-child]:checked').map((box) => box.value);
      if (!childIds.length) {
        setMessage('#challengeError', 'Pick at least one child.');
        return;
      }
      const days = $$('#challengeDays input:checked').map((box) => Number(box.value));
      const fields = {
        name: $('#challengeName').value.trim(),
        points: Number($('#challengePoints').value),
        details: $('#challengeDetails').value.trim(),
        recurring_days: days
      };

      if (editing?.type === 'challenge') {
        if (childIds.length !== 1) {
          setMessage('#challengeError', 'Pick exactly one child when editing.');
          return;
        }
        await db.from('challenges').update({ ...fields, child_id: childIds[0] }).eq('id', editing.id);
        cancelEdit();
        await refreshAndRender();
        return;
      }

      const { error } = await db.from('challenges').insert(childIds.map((id) => ({ family_id: family.id, child_id: id, ...fields })));
      if (error) {
        setMessage('#challengeError', error.message);
        return;
      }
      event.target.reset();
      $('#challengePoints').value = 10;
      closeForm('challengeForm');
      await refreshAndRender();
    }

    async function addGoal(event) {
      event.preventDefault();
      setMessage('#goalError', '');
      const childIds = $$('#goalChildren input[data-child]:checked').map((box) => box.value);
      if (!childIds.length) {
        setMessage('#goalError', 'Pick at least one child.');
        return;
      }
      const days = $$('#goalDays input:checked').map((box) => Number(box.value));
      const fields = {
        name: $('#goalName').value.trim(),
        details: $('#goalDetails').value.trim(),
        consequence: getGoalConsequence(),
        consequence_days: $('#goalConsequenceDays').value ? Math.max(1, Math.round(Number($('#goalConsequenceDays').value))) : null,
        recurring_days: days
      };

      if (editing?.type === 'goal') {
        if (childIds.length !== 1) {
          setMessage('#goalError', 'Pick exactly one child when editing.');
          return;
        }
        const existing = family.goals.find((g) => g.id === editing.id);
        const sameDays = existing && [...(existing.recurring_days || [])].sort().join() === [...days].sort().join();
        const dueDate = days.length
          ? (sameDays ? existing.due_date : firstOccurrence(days))
          : $('#goalDueDate').value;
        await db.from('goals').update({ ...fields, child_id: childIds[0], due_date: dueDate }).eq('id', editing.id);
        cancelEdit();
        await refreshAndRender();
        return;
      }

      const dueDate = days.length ? firstOccurrence(days) : $('#goalDueDate').value;
      const { error } = await db.from('goals').insert(childIds.map((id) => ({
        family_id: family.id,
        child_id: id,
        due_date: dueDate,
        status: 'active',
        ...fields
      })));
      if (error) {
        setMessage('#goalError', error.message);
        return;
      }
      event.target.reset();
      $('#goalDueDate').value = nextDate(7);
      updateGoalDueState();
      updateGoalConsequenceUI();
      closeForm('goalForm');
      await refreshAndRender();
    }

    async function addReward(event) {
      event.preventDefault();
      setMessage('#rewardError', '');
      const fields = {
        name: $('#rewardName').value.trim(),
        cost: Number($('#rewardCost').value),
        limit_count: Number($('#rewardLimit').value),
        available_until: $('#rewardUntil').value
      };

      if (editing?.type === 'reward') {
        const existing = family.rewards.find((r) => r.id === editing.id);
        if (existing && fields.limit_count < existing.claimed_count) {
          setMessage('#rewardError', 'Times available cannot be less than the ' + existing.claimed_count + ' already redeemed.');
          return;
        }
        const res = await db.from('rewards').update(fields).eq('id', editing.id);
        if (!check(res)) return;
        cancelEdit();
        await refreshAndRender();
        return;
      }

      const { error } = await db.from('rewards').insert({ family_id: family.id, ...fields, claimed_count: 0 });
      if (error) {
        setMessage('#rewardError', error.message);
        return;
      }
      event.target.reset();
      $('#rewardCost').value = 50;
      $('#rewardLimit').value = 1;
      $('#rewardUntil').value = nextDate(14);
      closeForm('rewardForm');
      await refreshAndRender();
    }

    async function deleteReward(id) {
      if (session.role !== 'parent') return;
      if (!confirm('Delete this reward? This cannot be undone.')) return;
      const res = await db.from('rewards').delete().eq('id', id);
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function markGoalDone(goalId) {
      const res = await db.rpc('child_mark_goal_done', { p_token: session.token, p_goal_id: goalId });
      if (!check(res)) return;
      activeTab = 'requests';
      await refreshAndRender();
    }

    // Recurring goals go back to active with the next due date; one-time goals are completed
    function renderGoalSkipList(goal) {
      const dates = [...(goal.skip_dates || [])].sort();
      $('#goalSkipBox').classList.toggle('hidden', !dates.length);
      $('#goalSkipList').innerHTML = dates.map((d) => `
        <div class="row-item">
          <div class="row-main">
            <div class="row-title">${prettyDate(d)}</div>
            <div class="row-meta">${d < todayStr() ? 'Already passed' : 'Skipped'}</div>
          </div>
          <button class="btn ghost small" type="button" onclick="restoreSkippedDate('${goal.id}', '${d}')">Restore</button>
        </div>`).join('');
    }

    // Put a skipped day back. If the goal has already moved past it, the goal goes back to that day.
    async function restoreSkippedDate(goalId, date) {
      if (session.role !== 'parent') return;
      const goal = family.goals.find((g) => g.id === goalId);
      if (!goal) return;
      const movesBack = goal.status === 'active' && date < goal.due_date;
      if (movesBack && date < todayStr() && !confirm('That day has already passed, so the goal will be overdue again. Restore it anyway?')) return;
      const update = { skip_dates: (goal.skip_dates || []).filter((d) => d !== date) };
      if (movesBack) update.due_date = date;
      const res = await db.from('goals').update(update).eq('id', goalId);
      if (!check(res)) return;
      await refreshAndRender();
      const fresh = family.goals.find((g) => g.id === goalId);
      if (fresh && editing?.type === 'goal' && editing.id === goalId) {
        $('#goalDueDate').value = fresh.due_date;
        renderGoalSkipList(fresh);
      }
    }

    // Waive the consequence for an overdue goal: it moves on without one
