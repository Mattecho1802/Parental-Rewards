async function ignoreConsequence(goalId) {
      if (session.role !== 'parent') return;
      const goal = family.goals.find((g) => g.id === goalId);
      if (!goal) return;
      const repeats = (goal.recurring_days || []).length > 0;
      const message = repeats
        ? 'Ignore the consequence for "' + goal.name + '"? The goal moves on to its next day with no consequence.'
        : 'Ignore the consequence for "' + goal.name + '"? The goal will be closed with no consequence.';
      if (!confirm(message)) return;
      await resetOrComplete(goalId);
      await refreshAndRender();
    }

    async function resetOrComplete(goalId) {
      const goal = family.goals.find((item) => item.id === goalId);
      if (!goal) return;
      const days = goal.recurring_days || [];
      if (days.length > 0) {
        const nextKid = nextRotationChildId(goal);
        await db.from('goals').update({
          status: 'active',
          due_date: nextRecurringDate(days, goal.due_date, goal.skip_dates || []),
          ...(nextKid ? { child_id: nextKid } : {})
        }).eq('id', goalId);
      } else {
        await db.from('goals').update({ status: 'completed' }).eq('id', goalId);
      }
    }

    function goalApprovalOutcome(goal) {
      const days = goal.recurring_days || [];
      return days.length
        ? { status: 'active', due: nextRecurringDate(days, goal.due_date, goal.skip_dates || []) }
        : { status: 'completed', due: null };
    }

    async function approveGoal(goalId) {
      if (session.role !== 'parent') return;
      const goal = family.goals.find((g) => g.id === goalId);
      if (!goal) return;
      const outcome = goalApprovalOutcome(goal);
      const { data, error } = await db.rpc('approve_goal', {
        p_goal_id: goalId, p_new_status: outcome.status, p_new_due: outcome.due, p_tip: 0
      });
      if (error) {
        alert(error.message);
        return;
      }
      await discardPhotos([goal.photo_path]);
      await refreshAndRender();
      if (data) showToast('Approved: ' + goal.name, data);
    }

    // An active, timed consequence for the same child with the same name: new days get added to it
    function findTimedConsequence(childId, name) {
      const key = (name || '').trim().toLowerCase();
      return (family.consequences || []).find((c) =>
        c.status === 'active' && c.child_id === childId && c.ends_on && (c.name || '').trim().toLowerCase() === key
      );
    }

    async function applyConsequence(goalId) {
      const goal = family.goals.find((g) => g.id === goalId);
      if (!goal) return;
      const today = todayStr();
      const days = goal.consequence_days;
      const alreadyApplied = (family.consequences || []).some((c) => c.goal_id === goalId && c.status === 'active');

      if (!alreadyApplied) {
        const merge = days ? findTimedConsequence(goal.child_id, goal.consequence) : null;
        if (merge) {
          // Same consequence is already running: add these days onto it instead of making a second one
          const update = merge.ends_on >= today
            ? { ends_on: addDays(merge.ends_on, days) }
            : { starts_on: today, ends_on: addDays(today, days - 1) };
          update.details = (merge.details || '') + (merge.details ? ' + ' : 'For goal: ') + goal.name;
          const res = await db.from('consequences').update(update).eq('id', merge.id);
          if (!check(res)) return;
          // This goal's consequence is now part of the running one, so the goal moves on
          await resetOrComplete(goalId);
          activeTab = 'consequences';
          await refreshAndRender();
          return;
        }

        const ins = await db.from('consequences').insert({
          family_id: family.id,
          child_id: goal.child_id,
          goal_id: goal.id,
          name: goal.consequence,
          details: 'For goal: ' + goal.name,
          starts_on: today,
          ends_on: days ? addDays(today, days - 1) : null,
          status: 'active'
        });
        if (!check(ins)) return;
      }

      const up = await db.from('goals').update({ status: 'consequence' }).eq('id', goalId);
      if (!check(up)) return;
      activeTab = 'consequences';
      await refreshAndRender();
    }

    async function addConsequence(event) {
      event.preventDefault();
      setMessage('#consequenceError', '');
      const childIds = $$('#consequenceChildren input[data-child]:checked').map((box) => box.value);
      if (!childIds.length) {
        setMessage('#consequenceError', 'Pick at least one child.');
        return;
      }
      const daysRaw = $('#consequenceDays').value;
      const days = daysRaw ? Math.max(1, Math.round(Number(daysRaw))) : null;
      const fields = {
        name: getConsequenceName(),
        details: $('#consequenceDetails').value.trim()
      };

      if (editing?.type === 'consequence') {
        if (childIds.length !== 1) {
          setMessage('#consequenceError', 'Pick exactly one child when editing.');
          return;
        }
        const existing = family.consequences.find((c) => c.id === editing.id);
        const startsOn = existing?.starts_on || todayStr();
        const res = await db.from('consequences').update({
          ...fields,
          child_id: childIds[0],
          ends_on: days ? addDays(startsOn, days - 1) : null
        }).eq('id', editing.id);
        if (!check(res)) return;
        cancelEdit();
        await refreshAndRender();
        return;
      }

      const today = todayStr();
      const toInsert = [];
      for (const id of childIds) {
        const merge = days ? findTimedConsequence(id, fields.name) : null;
        if (merge) {
          // Same consequence already running: add the days onto it
          const update = merge.ends_on >= today
            ? { ends_on: addDays(merge.ends_on, days) }
            : { starts_on: today, ends_on: addDays(today, days - 1) };
          const res = await db.from('consequences').update(update).eq('id', merge.id);
          if (!check(res)) return;
        } else {
          toInsert.push({
            family_id: family.id,
            child_id: id,
            ...fields,
            starts_on: today,
            ends_on: days ? addDays(today, days - 1) : null,
            status: 'active'
          });
        }
      }
      if (toInsert.length) {
        const { error } = await db.from('consequences').insert(toInsert);
        if (error) {
          setMessage('#consequenceError', error.message);
          return;
        }
      }
      event.target.reset();
      updateConsequenceUI();
      closeForm('consequenceForm');
      await refreshAndRender();
    }

    async function resolveConsequence(id) {
      if (session.role !== 'parent') return;
      const c = family.consequences.find((x) => x.id === id);
      if (!c) return;
      const res = await db.from('consequences').update({ status: 'resolved' }).eq('id', id);
      if (!check(res)) return;
      const goal = c.goal_id ? family.goals.find((g) => g.id === c.goal_id) : null;
      if (goal && goal.status === 'consequence') await resetOrComplete(goal.id);
      await refreshAndRender();
    }

    async function deleteConsequence(id) {
      if (session.role !== 'parent') return;
      if (!confirm('Delete this consequence? This cannot be undone.')) return;
      const c = family.consequences.find((x) => x.id === id);
      const res = await db.from('consequences').delete().eq('id', id);
      if (!check(res)) return;
      const goal = c?.goal_id ? family.goals.find((g) => g.id === c.goal_id) : null;
      if (goal && goal.status === 'consequence') await resetOrComplete(goal.id);
      await refreshAndRender();
    }

    async function renameFamily() {
      if (session.role !== 'parent') return;
      const name = $('#familyNameInput').value.trim();
      if (!name) { alert('Please enter a family name.'); return; }
      const res = await db.rpc('rename_family', { p_name: name });
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function clearConsequence(goalId) {
      await resetOrComplete(goalId);
      activeTab = 'consequences';
      await refreshAndRender();
    }

    async function sendCompletionRequest(challengeId) {
      const { data: requestId, error } = await db.rpc('child_request_completion', { p_token: session.token, p_challenge_id: challengeId });
      if (error) {
        alert(error.message);
        return;
      }
      activeTab = 'requests';
      await refreshAndRender();
    }

    // ---------- themes ----------
    const themeKey = 'parentalRewardsTheme';
    const THEMES = [
      { id: 'system', name: 'System default', swatch: ['#f5f7fa', '#2563eb', '#101828', '#0e1420'] },
      { id: 'light', name: 'Light', swatch: ['#f5f7fa', '#2563eb', '#101828'] },
      { id: 'dark', name: 'Dark', swatch: ['#0e1420', '#4a7af0', '#090e18'] },
      { id: 'ocean', name: 'Ocean', swatch: ['#eef7f9', '#0b7285', '#0a3d49'] },
      { id: 'forest', name: 'Forest', swatch: ['#f1f7f1', '#2e7d4f', '#1b3a2a'] },
      { id: 'sunset', name: 'Sunset', swatch: ['#fff6ef', '#d4501e', '#4a1f2b'] },
      { id: 'lavender', name: 'Lavender', swatch: ['#f6f3ff', '#6d4de0', '#2a1f4d'] },
      { id: 'contrast', name: 'High contrast', swatch: ['#ffffff', '#0030c0', '#000000'] }
    ];

    function getThemeChoice() {
      try { return localStorage.getItem(themeKey) || 'system'; } catch (e) { return 'system'; }
    }

    function applyTheme() {
      const choice = getThemeChoice();
      const resolved = choice === 'system'
        ? (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : choice;
      document.documentElement.setAttribute('data-theme', resolved);
      // colour the phone's browser bar to match
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim() || '#101828');
      if (session && family && $('#calGrid')) renderCalendar();
      $$('[data-theme-choice]').forEach((button) => {
        const active = button.dataset.themeChoice === choice;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function setTheme(choice) {
      try { localStorage.setItem(themeKey, choice); } catch (e) { /* storage blocked: it just will not be remembered */ }
      applyTheme();
    }

    function renderThemes() {
      $('#themeGrid').innerHTML = THEMES.map((t) => `
        <button class="theme-option" type="button" data-theme-choice="${t.id}" aria-pressed="false">
          <span class="swatch">${t.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
          ${esc(t.name)}
        </button>
      `).join('');
      $$('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => setTheme(button.dataset.themeChoice)));
      applyTheme();
    }

    // ---------- chore rotation ----------
    // The child who gets a repeating chore after this one (null when it does not rotate)
    function nextRotationChildId(goal) {
      const ids = (goal.rotation_child_ids || []).filter((cid) => family.children.some((k) => k.id === cid));
      if (ids.length < 2) return null;
      const pos = ids.indexOf(goal.child_id);
      return ids[(pos + 1) % ids.length];
    }

    // The "Take turns" tick only makes sense for a repeating goal with two or more children
    function updateGoalRotateState() {
      const box = $('#goalRotateBox');
      if (!box) return;
      const kids = $$('#goalChildren input[data-child]:checked').length;
      const repeats = $$('#goalDays input:checked').length > 0;
      const show = kids >= 2 && repeats;
      box.classList.toggle('hidden', !show);
      if (!show) $('#goalRotate').checked = false;
    }

    // ---------- photo proof ----------
    let pendingPhoto = null; // { kind, id, base64 }

    async function discardPhotos(paths) {
      const list = (paths || []).filter(Boolean);
      if (!list.length) return;
      try { await db.storage.from('task-photos').remove(list); } catch (e) { /* it can be removed later */ }
    }

    function aiBadge(verdict) {
      const map = {
        looks_done: ['green', 'AI: looks done'],
        unclear: ['amber', 'AI: not sure'],
        doesnt_match: ['amber', "AI: doesn't match"],
        unchecked: ['', 'AI: not checked']
      };
      const m = map[verdict];
      return m ? `<span class="pill ${m[0]}">${m[1]}</span>` : '';
    }

    // Shown to parents on a request that came with a photo
    function proofBlock(item) {
      if (!item || !item.photo_path) return '';
      return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px">
          <button class="btn ghost small" type="button" onclick="viewProof('${esc(item.photo_path)}')">📷 View photo</button>
          ${aiBadge(item.ai_verdict)}
        </div>
        ${item.ai_note ? `<div class="meta" style="margin-top:4px">${esc(item.ai_note)}</div>` : ''}`;
    }

    async function viewProof(path) {
      if (session.role !== 'parent') return;
      const { data, error } = await db.storage.from('task-photos').createSignedUrl(path, 300);
      if (error || !data) {
        alert('The photo could not be opened. It may already have been deleted.');
        return;
      }
      const item = family.goals.find((g) => g.photo_path === path) || family.requests.find((r) => r.photo_path === path);
      showModal('Photo proof',
        `<img src="${esc(data.signedUrl)}" alt="Photo sent by your child" style="width:100%;border-radius:12px" />
         ${item ? `<div style="margin-top:10px">${aiBadge(item.ai_verdict)}</div>${item.ai_note ? `<p class="meta">${esc(item.ai_note)}</p>` : ''}` : ''}
         <p class="meta">The AI is only a helper. The photo is deleted when you approve it or send it back.</p>`,
        `<button class="btn secondary" type="button" onclick="closeModal()">Close</button>`);
    }

    function setPhotoStatus(text) {
      const el = $('#photoStatus');
      if (el) el.textContent = text || '';
    }

    function openPhotoModal(kind, id) {
      const item = (kind === 'goal' ? family.goals : family.challenges).find((x) => x.id === id);
      if (!item) return;
      pendingPhoto = { kind, id, base64: null };
      showModal('Show it is done',
        `<p class="meta" style="margin:0 0 10px">Take a photo of <strong>${esc(item.name)}</strong> done. A helper checks it, then your parent makes the final decision.</p>
         <input id="photoInput" type="file" accept="image/*" capture="environment" onchange="photoChosen(this)" />
         <img id="photoPreview" class="hidden" alt="Your photo" style="width:100%;max-height:300px;object-fit:contain;border-radius:12px;margin-top:10px" />
         <p id="photoStatus" class="meta" style="margin:10px 0 0"></p>`,
        `<button class="btn" id="photoSend" type="button" onclick="submitPhoto(false)" disabled>Send photo</button>
         <button class="btn secondary" type="button" onclick="closeModal()">Cancel</button>`);
    }

    // Shrinks the photo so it uploads quickly (data: URLs only, the page does not allow blob: images)
    function compressImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('unreadable'));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('unreadable'));
          img.onload = () => {
            const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.72));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }

    async function photoChosen(input) {
      const file = input.files && input.files[0];
      if (!file || !pendingPhoto) return;
      setPhotoStatus('Getting your photo ready...');
      try {
        const dataUrl = await compressImage(file);
        pendingPhoto.base64 = dataUrl.split(',')[1];
        const preview = $('#photoPreview');
        preview.src = dataUrl;
        preview.classList.remove('hidden');
        $('#photoSend').disabled = false;
        setPhotoStatus('');
      } catch (e) {
        pendingPhoto.base64 = null;
        $('#photoSend').disabled = true;
        setPhotoStatus('That photo could not be opened. Please take another.');
      }
    }

    function retakePhoto() {
      if (pendingPhoto) openPhotoModal(pendingPhoto.kind, pendingPhoto.id);
    }

    async function submitPhoto(force) {
      if (!pendingPhoto || !pendingPhoto.base64) return;
      const send = $('#photoSend');
      if (send) send.disabled = true;
      setPhotoStatus('Checking your photo...');
      const { data, error } = await db.functions.invoke('verify-photo', {
        body: { token: session.token, kind: pendingPhoto.kind, item_id: pendingPhoto.id, image: pendingPhoto.base64, force: !!force }
      });
      if (error || !data) {
        setPhotoStatus('The photo could not be sent. Check your connection and try again.');
        if (send) send.disabled = false;
        return;
      }
      if (data.error) {
        setPhotoStatus(data.error);
        if (send) send.disabled = false;
        return;
      }
      if (data.needs_confirm) {
        setPhotoStatus((data.note || 'I am not sure that photo shows it done.') + ' Take another, or send it to your parent anyway.');
        $('#modalActions').innerHTML =
          `<button class="btn" type="button" onclick="retakePhoto()">Retake photo</button>
           <button class="btn secondary" type="button" onclick="submitPhoto(true)">Send anyway</button>`;
        return;
      }
      pendingPhoto = null;
      showModal('Sent!',
        `<p style="margin:0">Your parent will take a look.</p>${data.note ? `<p class="meta">${esc(data.note)}</p>` : ''}`,
        `<button class="btn" type="button" onclick="closeModal()">Done</button>`);
      activeTab = 'requests';
      await refreshAndRender();
    }

    // ---------- modal ----------
    function showModal(title, bodyHtml, actionsHtml) {
      $('#modalTitle').textContent = title;
      $('#modalBody').innerHTML = bodyHtml;
      $('#modalActions').innerHTML = actionsHtml || '';
      $('#modal').classList.remove('hidden');
    }

    function closeModal() {
      $('#modal').classList.add('hidden');
    }

    function kv(label, value) {
      return value ? `<div class="kv"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>` : '';
    }

    // Same colours and wording as the goal cards
    function goalDisplay(goal) {
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
        label = p.daysLeft === 0 ? (goal.due_time ? 'Due today at ' + fmtTime(goal.due_time) : 'Due today, ends tonight') : p.daysLeft === 1 ? '1 day left' : p.daysLeft + ' days left';
      }
      return { tone, fill, label };
    }

    function editItem(type, id) {
      closeModal();
      ({ goal: startEditGoal, consequence: startEditConsequence, reward: startEditReward, challenge: startEditChallenge, activity: startEditActivity })[type](id);
    }

    // ---------- skip a whole period (for example a holiday) ----------
    function skippableItem(type, id) {
      const list = { goal: family.goals, challenge: family.challenges, activity: family.activities || [] }[type];
      return list ? list.find((x) => x.id === id) : null;
    }

    function skipPeriodButton(type, item) {
      if (!(item.recurring_days || []).length) return '';
      if (type === 'goal' && (item.status !== 'active' || item.due_date < todayStr())) return '';
      return `<button class="btn ghost" type="button" onclick="skipPeriodFromModal('${type}', '${item.id}')">Skip a period...</button>`;
    }

    function skipPeriodFromModal(type, id) {
      closeModal();
      openSkipPeriod(type, id);
    }

    function openSkipPeriod(type, id) {
      if (session.role !== 'parent') return;
      const item = skippableItem(type, id);
      if (!item) return;
      const today = todayStr();
      showModal('Skip a period',
        `<p class="meta" style="margin:0 0 12px">${esc(item.title || item.name)} will be skipped on every day it would happen between these dates. You can restore single days afterwards.</p>
         <div class="form-grid">
           <label>From
             <input id="skipFrom" type="date" value="${today}" min="${today}" />
           </label>
           <label>To
             <input id="skipTo" type="date" value="${addDays(today, 6)}" min="${today}" />
           </label>
         </div>
         <p id="skipPeriodError" class="error"></p>`,
        `<button class="btn" type="button" onclick="applySkipPeriod('${type}', '${id}')">Skip these days</button>
         <button class="btn secondary" type="button" onclick="closeModal()">Cancel</button>`);
    }

    async function applySkipPeriod(type, id) {
      if (session.role !== 'parent') return;
      const item = skippableItem(type, id);
      if (!item) return;
      setMessage('#skipPeriodError', '');
      const from = $('#skipFrom').value;
      const to = $('#skipTo').value;
      const today = todayStr();
      if (!from || !to) { setMessage('#skipPeriodError', 'Pick a start and an end date.'); return; }
      if (from < today) { setMessage('#skipPeriodError', 'The start date cannot be in the past.'); return; }
      if (to < from) { setMessage('#skipPeriodError', 'The end date must be on or after the start date.'); return; }
      if (dayDiff(from, to) > 366) { setMessage('#skipPeriodError', 'Choose a period of a year or less.'); return; }

      const days = item.recurring_days || [];
      const skips = new Set(item.skip_dates || []);
      let added = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (days.includes(weekdayOf(d)) && !skips.has(d)) { skips.add(d); added++; }
      }
      if (!added) { setMessage('#skipPeriodError', 'It does not happen on any day in that period, so there is nothing to skip.'); return; }

      const update = { skip_dates: [...skips].sort() };
      if (type === 'goal' && skips.has(item.due_date)) {
        if (item.status !== 'active') {
          setMessage('#skipPeriodError', 'This goal is waiting for approval or has a consequence, so it cannot be skipped right now.');
          return;
        }
        update.due_date = nextRecurringDate(days, item.due_date, [...skips]);
      }

      const table = { goal: 'goals', challenge: 'challenges', activity: 'activities' }[type];
      const res = await db.from(table).update(update).eq('id', id);
      if (!check(res)) return;
      closeModal();
      await refreshAndRender();
      showToast('Skipped ' + added + (added === 1 ? ' day' : ' days'), null);
    }

    // "Skip this day" / "Restore this day" for one occurrence of a repeating item
    function skipButton(type, item, date) {
      if (!date || !(item.recurring_days || []).length) return '';
      const skipped = isSkippedOn(item, date);
      if (type === 'goal' && !skipped && date < todayStr()) return '';  // overdue or past goal days cannot be skipped
      if (type === 'goal' && date < item.due_date) return '';           // goal days already passed
      if (skipped) {
        if (type === 'goal' && date <= item.due_date) return '';        // the goal has already moved on
        return `<button class="btn ghost" type="button" onclick="skipFromModal('${type}', '${item.id}', '${date}', false)">Restore this day</button>`;
      }
      return `<button class="btn ghost-danger" type="button" onclick="skipFromModal('${type}', '${item.id}', '${date}', true)">Skip this day</button>`;
    }

    function skipFromModal(type, id, date, skip) {
      closeModal();
      setOccurrenceSkipped(type, id, date, skip);
    }

    async function setOccurrenceSkipped(type, id, date, skip) {
      if (session.role !== 'parent') return;
      const table = { goal: 'goals', challenge: 'challenges', activity: 'activities' }[type];
      const list = { goal: family.goals, challenge: family.challenges, activity: family.activities || [] }[type];
      const item = list.find((x) => x.id === id);
      if (!item) return;
      const skips = new Set(item.skip_dates || []);
      const update = {};
      if (skip) {
        if (type === 'goal' && date < todayStr()) {
          alert('An overdue goal cannot be skipped. Use Ignore consequence instead.');
          return;
        }
        if (type === 'goal' && date === item.due_date) {
          if (item.status !== 'active') {
            alert('This goal is waiting for approval or has a consequence, so it cannot be skipped right now.');
            return;
          }
        }
        skips.add(date);
        if (type === 'goal' && date === item.due_date) {
          update.due_date = nextRecurringDate(item.recurring_days || [], item.due_date, [...skips]);
        }
      } else {
        skips.delete(date);
      }
      update.skip_dates = [...skips].sort();
      const res = await db.from(table).update(update).eq('id', id);
      if (!check(res)) return;
      await refreshAndRender();
    }

    function modalApproveGoal(id) { closeModal(); approveGoal(id); }
    function modalResolve(id) { closeModal(); resolveConsequence(id); }
    function modalRedeem(id) { closeModal(); claimReward(id); }

    const TYPE_LABELS = { goal: 'Goal', consequence: 'Consequence', reward: 'Reward', challenge: 'Challenge', activity: 'Activity' };

    function openCalendarItem(type, id, date) {
      const isParent = session.role === 'parent';
      let title = '';
      let body = '';
      let actions = '';

      if (type === 'goal') {
        const g = family.goals.find((x) => x.id === id);
        if (!g) return;
        const d = goalDisplay(g);
        title = g.name;
        body = kv('For', isParent ? childName(g.child_id) : '')
          + kv('Status', goalStatusLabel(g))
          + kv('Due', prettyDate(g.due_date) + ' (end of day)')
          + kv('Time', d.label)
          + kv('Repeats', (g.recurring_days || []).length ? [...g.recurring_days].sort().map((n) => DAY_NAMES[n]).join(', ') : '')
          + kv('If missed', (g.consequence || '') + (g.consequence_days ? ' (for ' + g.consequence_days + (g.consequence_days === 1 ? ' day)' : ' days)') : ''))
          + kv('This day', date && isSkippedOn(g, date) ? 'Skipped' : '')
          + kv('Details', g.details)
          + `<div class="progress ${d.tone}" style="margin-top:12px"><span style="width:${d.fill}%"></span></div>`;
        if (isParent) {
          if (g.status === 'waiting') actions += approveIconBtn(`modalApproveGoal('${id}')`);
          actions += `<button class="btn secondary" type="button" onclick="editItem('goal', '${id}')">Edit</button>`;
          actions += skipButton('goal', g, date);
          actions += skipPeriodButton('goal', g);
          if (g.status === 'active' && g.due_date < todayStr()) {
            actions += `<button class="btn danger" type="button" onclick="closeModal(); applyConsequence('${id}')">Apply consequence</button>`;
            actions += `<button class="btn ghost" type="button" onclick="closeModal(); ignoreConsequence('${id}')">Ignore consequence</button>`;
          }
        }
      } else if (type === 'consequence') {
        const c = family.consequences.find((x) => x.id === id);
        if (!c) return;
        title = c.name;
        body = kv('For', isParent ? childName(c.child_id) : '')
          + kv('Started', prettyDate(c.starts_on))
          + kv('Ends', c.ends_on ? prettyDate(c.ends_on) + ' (end of day)' : 'No end date')
          + kv('Details', c.details);
        if (isParent) {
          actions += `<button class="btn success" type="button" onclick="modalResolve('${id}')">Mark resolved</button>`;
          actions += `<button class="btn secondary" type="button" onclick="editItem('consequence', '${id}')">Edit</button>`;
        }
      } else if (type === 'reward') {
        const r = family.rewards.find((x) => x.id === id);
        if (!r) return;
        const remaining = r.limit_count - r.claimed_count;
        title = r.name;
        body = kv('Cost', r.cost + ' points')
          + kv('Left', remaining + ' of ' + r.limit_count)
          + kv('Available until', prettyDate(r.available_until));
        if (isParent) {
          actions += `<button class="btn secondary" type="button" onclick="editItem('reward', '${id}')">Edit</button>`;
        } else {
          const kid = activeChild();
          const canClaim = kid && kid.points >= r.cost && remaining > 0 && r.available_until >= todayStr();
          body += kv('Your points', String(kid ? kid.points : 0));
          if (canClaim) actions += `<button class="btn" type="button" onclick="modalRedeem('${id}')">Redeem</button>`;
        }
      } else if (type === 'activity') {
        const a = (family.activities || []).find((x) => x.id === id);
        if (!a) return;
        title = a.title;
        body = kv('For', isParent ? childName(a.child_id) : '')
          + kv('Date', date ? prettyDate(date) : activitySchedule(a))
          + kv('Repeats', (a.recurring_days || []).length ? activitySchedule(a) : '')
          + kv('Time', timeRange(a))
          + kv('Leave by', fmtTime(a.leave_time))
          + kv('This day', date && isSkippedOn(a, date) ? 'Skipped' : '')
          + kv('Details', a.details);
        if (isParent) {
          actions += `<button class="btn secondary" type="button" onclick="editItem('activity', '${id}')">Edit</button>`;
          actions += `<button class="btn danger" type="button" onclick="modalDeleteActivity('${id}')">Delete</button>`;
          actions += skipButton('activity', a, date);
          actions += skipPeriodButton('activity', a);
        }
      } else if (type === 'challenge') {
        const c = family.challenges.find((x) => x.id === id);
        if (!c) return;
        title = c.name;
        body = kv('For', isParent ? childName(c.child_id) : '')
          + kv('Points', c.points + ' points')
          + kv('Repeats', (c.recurring_days || []).length ? [...c.recurring_days].sort().map((n) => DAY_NAMES[n]).join(', ') : 'One-off')
          + kv('This day', date && isSkippedOn(c, date) ? 'Skipped' : '')
          + kv('Details', c.details);
        if (isParent) {
          actions += `<button class="btn secondary" type="button" onclick="editItem('challenge', '${id}')">Edit</button>`;
          actions += skipButton('challenge', c, date);
          actions += skipPeriodButton('challenge', c);
        }
      } else {
        return;
      }
      showModal(title, body, actions);
    }

    // ---------- calendar ----------
    let calMonth = { y: new Date().getFullYear(), m: new Date().getMonth() };
    let calSelected = null;
    const calFilter = { goal: true, consequence: true, reward: true, activity: true, challenge: false };

    function calGridRange() {
      const first = fmtDate(new Date(calMonth.y, calMonth.m, 1));
      const last = fmtDate(new Date(calMonth.y, calMonth.m + 1, 0));
      const lead = (weekdayOf(first) + 6) % 7;
      const tail = 6 - ((weekdayOf(last) + 6) % 7);
      return { first, last, start: addDays(first, -lead), end: addDays(last, tail) };
    }

    function calendarEvents(start, end, filter = calFilter) {
      const isParent = session.role === 'parent';
      const child = activeChild();
      const mine = (x) => isParent || x.child_id === child.id;
      const who = (id) => (isParent ? childName(id) + ': ' : '');
      const dates = [];
      for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
      const events = [];

      if (filter.goal) {
        family.goals.filter(mine).forEach((g) => {
          if (g.status === 'completed') return;
          const days = g.recurring_days || [];
          (g.skip_dates || []).forEach((d) => { if (d >= start && d <= end) events.push({ date: d, type: 'goal', id: g.id, title: who(g.child_id) + g.name, skipped: true }); });
          if (g.due_date >= start && g.due_date <= end) events.push({ date: g.due_date, type: 'goal', id: g.id, title: who(g.child_id) + g.name });
          if (days.length) {
            dates.forEach((d) => {
              if (d > g.due_date && days.includes(weekdayOf(d)) && !isSkippedOn(g, d)) events.push({ date: d, type: 'goal', id: g.id, title: who(g.child_id) + g.name, future: true });
            });
          }
        });
      }
      if (filter.consequence) {
        (family.consequences || []).filter((c) => c.status === 'active' && mine(c)).forEach((c) => {
          const lastDay = c.ends_on || c.starts_on;
          dates.forEach((d) => {
            if (d >= c.starts_on && d <= lastDay) events.push({ date: d, type: 'consequence', id: c.id, title: who(c.child_id) + c.name, cont: d !== c.starts_on });
          });
        });
      }
      if (filter.reward) {
        family.rewards.forEach((r) => {
          if (r.available_until >= start && r.available_until <= end) events.push({ date: r.available_until, type: 'reward', id: r.id, title: 'Ends: ' + r.name });
        });
      }
      if (filter.challenge) {
        family.challenges.filter(mine).forEach((c) => {
          const days = c.recurring_days || [];
          if (!days.length) return;
          const created = c.created_at ? fmtDate(new Date(c.created_at)) : start;
          dates.forEach((d) => {
            if (d >= created && days.includes(weekdayOf(d))) events.push({ date: d, type: 'challenge', id: c.id, title: who(c.child_id) + c.name, skipped: isSkippedOn(c, d) });
          });
        });
      }
      if (filter.activity) {
        (family.activities || []).filter(mine).forEach((a) => {
          dates.forEach((d) => {
            if (activityOccursOn(a, d)) {
              events.push({ date: d, type: 'activity', id: a.id, title: who(a.child_id) + (a.start_time ? fmtTime(a.start_time) + ' ' : '') + a.title, skipped: isSkippedOn(a, d), done: !isSkippedOn(a, d) && activityDone(a, d) });
            }
          });
        });
      }
      return events;
    }

    // One circle per kind of item on a day, with how many there are inside it
    function calDots(items) {
      const counts = {};
      items.filter((e) => !e.skipped).forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
      return ['goal', 'consequence', 'activity', 'reward', 'challenge']
        .filter((type) => counts[type])
        .map((type) => `<span class="cal-dot t-${type}" title="${counts[type]} ${TYPE_LABELS[type].toLowerCase()}${counts[type] === 1 ? '' : 's'}">${counts[type]}</span>`)
        .join('');
    }

    // Black or white number, whichever reads better on that circle's colour (works in every theme)
    function pickTextColor(rgb) {
      const m = String(rgb).match(/\d+(\.\d+)?/g);
      if (!m) return '#fff';
      const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? '#fff' : '#000';
    }

    function applyDotContrast() {
      $$('.cal-dot').forEach((dot) => { dot.style.color = pickTextColor(getComputedStyle(dot).backgroundColor); });
    }

    function renderCalendar() {
      if (!calSelected) calSelected = todayStr();
      const { start, end, first } = calGridRange();
      const events = calendarEvents(start, end);
      const byDate = {};
      events.forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });

      $('#calTitle').textContent = new Date(calMonth.y, calMonth.m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      $$('[data-calfilter]').forEach((button) => button.classList.toggle('active', calFilter[button.dataset.calfilter]));

      const today = todayStr();
      let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const items = byDate[d] || [];
        const other = d.slice(0, 7) !== first.slice(0, 7);
        html += `
          <div class="cal-cell${other ? ' other' : ''}${d === today ? ' today' : ''}${d === calSelected ? ' selected' : ''}" data-cal-date="${d}">
            <div class="cal-num">${Number(d.slice(8))}</div>
            <div class="cal-dots">${calDots(items)}</div>
            <div class="cal-chips">
              ${items.slice(0, 3).map((e) => `<span class="cal-chip t-${e.type}${e.future ? ' future' : ''}${e.cont ? ' cont' : ''}${e.skipped ? ' skipped' : ''}${e.done ? ' done' : ''}" data-cal-item="${e.type}:${e.id}:${e.date}" title="${esc(e.title)}">${esc(e.title)}</span>`).join('')}
              ${items.length > 3 ? `<span class="cal-more">+${items.length - 3} more</span>` : ''}
            </div>
          </div>
        `;
      }
      $('#calGrid').innerHTML = html;
      applyDotContrast();

      const dayItems = byDate[calSelected] || [];
      $('#calDay').innerHTML = `<h3 style="margin:8px 0 0">${prettyDate(calSelected)}</h3>`
        + (dayItems.length
          ? dayItems.map((e) => `
              <article class="row-item clickable k-${e.type}"${e.skipped || e.done ? ' style="opacity:.6"' : ''} data-cal-item="${e.type}:${e.id}:${e.date}">
                <div class="row-main">
                  <div class="row-title"${e.skipped || e.done ? ' style="text-decoration:line-through"' : ''}>${esc(e.title)}</div>
                  <div class="row-meta">${TYPE_LABELS[e.type]}${e.future ? ' · upcoming' : ''}${e.cont ? ' · ongoing' : ''}${e.skipped ? ' · skipped' : ''}${e.done && !e.skipped ? ' · finished' : ''}</div>
                </div>
                <span class="pill${e.done && !e.skipped ? ' green' : ''}">${e.skipped ? 'Skipped' : e.done ? '✓ Done' : TYPE_LABELS[e.type]}</span>
              </article>`).join('')
          : '<div class="empty">Nothing on this day.</div>');
    }

    // ---------- AI weekly report ----------
    const summarySeenKey = 'parentalRewardsSummarySeen';
    try { localStorage.removeItem('parentalRewardsNoAiKey'); } catch (e) { /* an old setting that is no longer used */ }
    const aiAttempted = {}; // weeks already tried since this page was opened

    function seenSummaryId() {
      try { return localStorage.getItem(summarySeenKey); } catch (e) { return null; }
    }

    function renderSummaries() {
      if (session.role !== 'parent') return;
      const list = family.summaries || [];
      const seen = seenSummaryId();
      const unseen = list.length && list[0].id !== seen;
      $('#aiSummaryBtn').innerHTML = 'Weekly report' + (unseen ? ' <span class="pill amber" style="margin-left:6px;min-height:20px;padding:2px 8px">New</span>' : '');
      $('#aiSummaryList').innerHTML = list.length
        ? list.map((sm) => `
            <article class="row-item clickable" onclick="openSummary('${sm.id}')">
              <div class="row-main">
                <div class="row-title">Week of ${prettyDate(sm.week_start)}</div>
                <div class="row-meta">${esc(String(sm.summary).slice(0, 110))}...</div>
              </div>
              ${sm.id !== seen && sm === list[0] ? '<span class="pill amber">New</span>' : ''}
            </article>`).join('')
        : '<div class="empty">No reports yet. One is written every Sunday evening, or write one now.</div>';
    }

    function openSummary(id) {
      if (session.role !== 'parent') return;
      const list = family.summaries || [];
      const sm = id ? list.find((x) => x.id === id) : list[0];
      if (!sm) {
        showModal('Weekly report',
          `<p>There is no report yet. One is written every Sunday evening, or you can write one now.</p>
           <p class="meta">A summary of the week's goals, challenges, feedback and activities.</p>`,
          `<button class="btn" type="button" onclick="closeModal(); generateSummary('this')">Write this week's report</button>
           <button class="btn secondary" type="button" onclick="closeModal(); generateSummary('last')">Last week's</button>`);
        return;
      }
      try { localStorage.setItem(summarySeenKey, sm.id); } catch (e) { /* not important */ }
      renderSummaries();
      showModal('Week of ' + prettyDate(sm.week_start),
        `<p class="meta" style="margin:0 0 10px">${prettyDate(sm.week_start)} to ${prettyDate(sm.week_end)}</p>
         <div class="note-text">${esc(sm.summary)}</div>
         <p class="meta" style="margin-top:14px">${sm.model === 'built-in' ? "Written by the app from the week's data." : "Written by AI from the week's data. It can make mistakes, so use your own judgement."}</p>`,
        `<button class="btn secondary" type="button" onclick="closeModal()">Close</button>`);
    }

    // The "Weekly report" button: open the report, but if it is missing or was not written by AI, try AI first
    async function reportButton() {
      if (session.role !== 'parent') return;
      const list = family.summaries || [];
      const latest = list[0];
      const isAi = latest && latest.model && latest.model !== 'built-in';
      if (isAi) { openSummary(); return; }

      const thisStart = weekRange('this').start;
      const lastStart = weekRange('last').start;
      let which = 'this';
      if (latest) {
        if (latest.week_start === lastStart) which = 'last';
        else if (latest.week_start !== thisStart) { openSummary(); return; } // an older report: just open it
      }
      const key = which + ':' + (latest ? latest.week_start : 'none');
      if (aiAttempted[key]) { openSummary(); return; }
      aiAttempted[key] = true;
      await generateSummary(which, { fromButton: true });
    }

    async function generateSummary(which, opts = {}) {
      if (session.role !== 'parent') return;
      const status = $('#aiStatus');
      const buttons = $$('[data-aigen]');
      buttons.forEach((b) => { b.disabled = true; });
      status.textContent = 'Writing the report. This can take around 15 seconds...';
      showToast('Writing your weekly report...', null);

      const { data, error } = await db.functions.invoke('weekly-summary', { body: { mode: 'mine', week: which } });
      buttons.forEach((b) => { b.disabled = false; });
      hideToast();

      let problem = '';
      if (error) {
        problem = error.name === 'FunctionsFetchError'
          ? 'Could not reach the weekly-summary function. Check it is deployed with exactly that name.'
          : 'The report failed: ' + (error.message || 'unknown error');
      } else if (data && data.error) {
        problem = data.detail || 'The report could not be written.';
      }
      if (problem) {
        status.textContent = problem;
        if (opts.fromButton) {
          if ((family.summaries || []).length) {
            openSummary();
            showToast(problem, null);
          } else {
            showModal('Weekly report', `<p>${esc(problem)}</p>`, '<button class="btn secondary" type="button" onclick="closeModal()">Close</button>');
          }
        } else {
          alert(problem);
        }
        return;
      }

      // Tell the parent which copy of the function answered and which writer was used
      status.textContent = data.version !== 3
        ? 'The weekly-summary function in Supabase is an older version, so it can not use an AI key. Paste in the latest weekly-summary.ts and deploy it.'
        : (data.info || '');
      await refreshAndRender();
      const made = (family.summaries || []).find((x) => x.week_start === data.week_start);
      openSummary(made ? made.id : undefined);
      if (data.note) showToast(data.note, null);
    }

    // ---------- overview donut (parents) ----------
    let overviewChild = 'all';
    let goalFilter = null; // { kind: 'overdue' | 'today', childId: 'all' | id }

    function overviewCounts(childId) {
      const today = todayStr();
      const kids = childId === 'all' ? family.children : family.children.filter((c) => c.id === childId);
      const ids = new Set(kids.map((c) => c.id));
      const activeGoals = family.goals.filter((g) => ids.has(g.child_id) && g.status === 'active' && !isWaitingForNextDay(g));
      return {
        points: kids.reduce((sum, c) => sum + c.points, 0),
        activitiesToday: (family.activities || []).filter((a) => ids.has(a.child_id) && activityOccursOn(a, today) && !isSkippedOn(a, today) && !activityDone(a, today)).length,
        goalsToday: activeGoals.filter((g) => g.due_date === today).length,
        overdue: activeGoals.filter((g) => g.due_date < today).length,
        attention: family.requests.filter((r) => ids.has(r.child_id) && r.status === 'waiting').length
          + family.goals.filter((g) => ids.has(g.child_id) && g.status === 'waiting').length
      };
    }

    function donutSvg(parts, total) {
      const r = 15.9155; // circumference of 100
      if (!total) {
        return `<svg viewBox="0 0 36 36" role="img" aria-label="Nothing needs attention"><circle cx="18" cy="18" r="${r}" fill="none" stroke-width="4" style="stroke: var(--track)"/></svg>`;
      }
      const shown = parts.filter((p) => p.value > 0);
      const gap = shown.length > 1 ? 0.8 : 0;
      let offset = 0;
      const segments = shown.map((p) => {
        const length = (p.value / total) * 100;
        const dash = Math.max(0, length - gap);
        const circle = `<circle cx="18" cy="18" r="${r}" fill="none" stroke-width="4" stroke-dasharray="${dash} ${100 - dash}" stroke-dashoffset="${-offset}" style="stroke: ${p.color}; cursor: pointer" onclick="goToOverview('${p.key}')"><title>${p.label}: ${p.value}</title></circle>`;
        offset += length;
        return circle;
      }).join('');
      return `<svg viewBox="0 0 36 36" role="img" aria-label="Today at a glance"><g transform="rotate(-90 18 18)">${segments}</g></svg>`;
    }

    function renderOverview() {
      if (session.role !== 'parent') return;
      const kids = family.children;
      if (overviewChild !== 'all' && !kids.some((c) => c.id === overviewChild)) overviewChild = 'all';
      $('#overviewChildWrap').classList.toggle('hidden', kids.length < 2);
      const select = $('#overviewChild');
      select.innerHTML = '<option value="all">All children</option>' + kids.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      select.value = overviewChild;

      const counts = overviewCounts(overviewChild);
      const parts = [
        { key: 'attention', label: 'Needs attention', value: counts.attention, color: 'var(--bar-warn)' },
        { key: 'overdue', label: 'Overdue goals', value: counts.overdue, color: 'var(--red)' },
        { key: 'goals', label: 'Goals today', value: counts.goalsToday, color: 'var(--blue)' },
        { key: 'activities', label: 'Activities today', value: counts.activitiesToday, color: 'var(--c-activity)' }
      ];
      const total = parts.reduce((sum, p) => sum + p.value, 0);
      const who = overviewChild === 'all' ? (kids.length === 1 ? kids[0].name : 'All children') : childName(overviewChild);

      $('#donutWrap').innerHTML = donutSvg(parts, total)
        + `<div class="donut-center"><strong>${counts.points}</strong><span>points</span><small>${esc(who)}</small></div>`;
      $('#donutLegend').innerHTML = parts.map((p) => `
        <button class="legend-item${p.value ? '' : ' zero'}" type="button" onclick="goToOverview('${p.key}')">
          <i style="background:${p.color}"></i><span>${p.label}</span><strong>${p.value}</strong>
        </button>`).join('');
    }

    function clearGoalFilter() {
      goalFilter = null;
      renderGoals();
    }

    function jumpTo(sectionId) {
      const el = $('#' + sectionId);
      if (!el) return;
      const view = el.dataset.view;
      if (view && mobileView !== view) setMobileView(view);
      const fold = el.querySelector('details.fold');
      if (fold) fold.open = true;
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }

    // Tapping a part of the chart (or its legend) takes you to that part of the app
    function goToOverview(kind) {
      if (kind === 'attention') {
        goalFilter = null;
        renderGoals();
        jumpTo('attentionSection');
      } else if (kind === 'activities') {
        jumpTo('activitiesSection');
      } else {
        goalFilter = { kind: kind === 'overdue' ? 'overdue' : 'today', childId: overviewChild };
        renderGoals();
        jumpTo('goalsSection');
      }
    }

    // The "Today" panel at the top of the dashboard: the same items as today's calendar day
    function renderToday() {
      const today = todayStr();
      $('#todaySub').textContent = prettyDate(today);
      const events = calendarEvents(today, today, { goal: true, consequence: true, reward: true, activity: true, challenge: false });
      const rank = { activity: 0, goal: 1, consequence: 2, reward: 3 };
      events.sort((x, y) => (rank[x.type] - rank[y.type]) || x.title.localeCompare(y.title));
      const list = $('#todayList');
      if (!events.length) {
        list.innerHTML = '<p class="meta" style="margin:0">Nothing planned today.</p>';
        return;
      }
      list.innerHTML = events.map((e) => {
        const activity = e.type === 'activity' ? (family.activities || []).find((a) => a.id === e.id) : null;
        const pill = e.skipped ? 'Skipped'
          : e.done ? '✓ Done'
          : activity && activity.leave_time ? 'Leave ' + fmtTime(activity.leave_time)
          : TYPE_LABELS[e.type];
        return `
          <article class="row-item clickable k-${e.type}"${e.skipped || e.done ? ' style="opacity:.6"' : ''} onclick="openCalendarItem('${e.type}', '${e.id}', '${e.date}')">
            <div class="row-main">
              <div class="row-title"${e.skipped || e.done ? ' style="text-decoration:line-through"' : ''}>${esc(e.title)}</div>
              <div class="row-meta">${TYPE_LABELS[e.type]}${e.cont ? ' · ongoing' : ''}${e.skipped ? ' · skipped' : ''}${e.done && !e.skipped ? ' · finished' : ''}</div>
            </div>
            <span class="pill${e.done && !e.skipped ? ' green' : activity && activity.leave_time && !e.skipped ? ' amber' : ''}">${esc(pill)}</span>
          </article>`;
      }).join('');
    }

    function shiftMonth(delta) {
      const d = new Date(calMonth.y, calMonth.m + delta, 1);
      calMonth = { y: d.getFullYear(), m: d.getMonth() };
      calSelected = todayStr().slice(0, 7) === fmtDate(d).slice(0, 7) ? todayStr() : fmtDate(d);
      renderCalendar();
    }

    // ---------- activities ----------
    function fmtTime(t) {
      return t ? String(t).slice(0, 5) : '';
    }

    function timeRange(a) {
      const start = fmtTime(a.start_time);
      const end = fmtTime(a.end_time);
      if (start && end) return start + ' to ' + end;
      if (start) return 'from ' + start;
      if (end) return 'until ' + end;
      return '';
    }

    function nowHM() {
      const d = new Date();
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function addMinutesHM(hm, minutes) {
      const [h, m] = hm.split(':').map(Number);
      const total = h * 60 + m + minutes;
      if (total >= 24 * 60) return '23:59';
      return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
    }

    // Finished: an earlier day, or today once its finish time has passed
    // (no finish time: one hour after it starts; no times at all: when the day is over)
    function activityDone(a, date) {
      const today = todayStr();
      if (date < today) return true;
      if (date > today) return false;
      const end = a.end_time ? fmtTime(a.end_time) : (a.start_time ? addMinutesHM(fmtTime(a.start_time), 60) : null);
      return end ? nowHM() >= end : false;
    }

    function activityOccursOn(a, date) {
      const days = a.recurring_days || [];
      if (!days.length) return a.activity_date === date;
      return date >= a.activity_date && (!a.repeat_until || date <= a.repeat_until) && days.includes(weekdayOf(date));
    }

    function activitySchedule(a) {
      const days = a.recurring_days || [];
      if (!days.length) return prettyDate(a.activity_date);
      const order = [1, 2, 3, 4, 5, 6, 0];
      const names = order.filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join(', ');
      return 'Every ' + names + ' from ' + prettyDate(a.activity_date) + (a.repeat_until ? ' until ' + prettyDate(a.repeat_until) : '');
    }

    let lastManualActivityDate = null;

    // When it repeats, the date is worked out from the ticked days and greyed out
    function updateActivityUI() {
      const days = $$('#activityDays input:checked').map((box) => Number(box.value));
      const repeating = days.length > 0;
      const dateInput = $('#activityDate');
      $('#activityUntilWrap').classList.toggle('hidden', !repeating);
      dateInput.disabled = repeating;
      $('#activityDateNote').textContent = repeating ? '(set automatically from the repeat days)' : '';
      if (repeating) {
        const existing = editing?.type === 'activity' ? (family.activities || []).find((a) => a.id === editing.id) : null;
        const sameDays = existing && [...(existing.recurring_days || [])].sort().join() === [...days].sort().join();
        dateInput.value = sameDays ? existing.activity_date : firstOccurrence(days);
      } else {
        dateInput.value = lastManualActivityDate || todayStr();
      }
    }

    function renderActivities() {
      const isParent = session.role === 'parent';
      const child = activeChild();
      const mine = (a) => isParent || a.child_id === child.id;
      const all = (family.activities || []).filter(mine);
      $('#activitiesSection').classList.toggle('hidden', !isParent && !all.length);

      // The next 7 days
      const today = todayStr();
      const days = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(today, i);
        const items = all.filter((a) => activityOccursOn(a, date))
          .sort((x, y) => (x.start_time || '').localeCompare(y.start_time || ''));
        if (items.length) days.push({ date, items });
      }
      const dayName = (date) => (date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : '') + (date === today || date === addDays(today, 1) ? ', ' : '') + prettyDate(date);

      $('#activityUpcoming').innerHTML = days.length
        ? days.map(({ date, items }) => `
            <section class="list">
              <h3 style="margin:6px 0 0;font-size:16px">${esc(dayName(date))}</h3>
              ${items.map((a) => `
                <article class="row-item clickable k-activity"${isSkippedOn(a, date) || activityDone(a, date) ? ' style="opacity:.6"' : ''} onclick="openCalendarItem('activity', '${a.id}', '${date}')">
                  <div class="row-main">
                    <div class="row-title"${isSkippedOn(a, date) || activityDone(a, date) ? ' style="text-decoration:line-through"' : ''}>${a.start_time ? esc(fmtTime(a.start_time)) + ' ' : ''}${esc(a.title)}</div>
                    <div class="row-meta">${[isParent ? esc(childName(a.child_id)) : '', timeRange(a) && a.start_time ? esc(timeRange(a)) : '', esc(a.details || '')].filter(Boolean).join(' · ')}</div>
                  </div>
                  ${isSkippedOn(a, date) ? '<span class="pill">Skipped</span>' : activityDone(a, date) ? '<span class="pill green">✓ Done</span>' : (a.leave_time ? `<span class="pill amber">Leave ${esc(fmtTime(a.leave_time))}</span>` : '')}
                </article>`).join('')}
            </section>`).join('')
        : '<div class="empty">Nothing in the next 7 days.</div>';
    }

    function activityDateFor(days) {
      const existing = editing?.type === 'activity' ? (family.activities || []).find((a) => a.id === editing.id) : null;
      const sameDays = existing && [...(existing.recurring_days || [])].sort().join() === [...days].sort().join();
      return sameDays ? existing.activity_date : firstOccurrence(days);
    }

    async function addActivity(event) {
      event.preventDefault();
      setMessage('#activityError', '');
      const childIds = $$('#activityChildren input[data-child]:checked').map((box) => box.value);
      if (!childIds.length) {
        setMessage('#activityError', 'Pick at least one child.');
        return;
      }
      const days = $$('#activityDays input:checked').map((box) => Number(box.value));
      const start = $('#activityStart').value;
      const end = $('#activityEnd').value;
      const leave = $('#activityLeave').value;
      if (start && end && end <= start) {
        setMessage('#activityError', 'The finish time must be after the start time.');
        return;
      }
      if (start && leave && leave > start) {
        setMessage('#activityError', '"Leave by" should be at or before the start time.');
        return;
      }
      const fields = {
        title: $('#activityTitle').value.trim(),
        details: $('#activityDetails').value.trim() || null,
        activity_date: days.length ? activityDateFor(days) : $('#activityDate').value,
        recurring_days: days,
        repeat_until: days.length && $('#activityUntil').value ? $('#activityUntil').value : null,
        start_time: start || null,
        end_time: end || null,
        leave_time: leave || null
      };

      if (editing?.type === 'activity') {
        if (childIds.length !== 1) {
          setMessage('#activityError', 'Pick exactly one child when editing.');
          return;
        }
        const res = await db.from('activities').update({ ...fields, child_id: childIds[0] }).eq('id', editing.id);
        if (!check(res)) return;
        cancelEdit();
        await refreshAndRender();
        return;
      }

      const { error } = await db.from('activities').insert(childIds.map((id) => ({ family_id: family.id, child_id: id, ...fields })));
      if (error) {
        setMessage('#activityError', error.message);
        return;
      }
      event.target.reset();
      lastManualActivityDate = null;
      $('#activityDate').value = todayStr();
      updateActivityUI();
      closeForm('activityForm');
      await refreshAndRender();
    }

    function startEditActivity(id) {
      const a = (family.activities || []).find((x) => x.id === id);
      if (!a) return;
      cancelEdit();
      editing = { type: 'activity', id };
      $('#activityTitle').value = a.title;
      $('#activityDate').value = a.activity_date;
      lastManualActivityDate = (a.recurring_days || []).length ? null : a.activity_date;
      $('#activityStart').value = fmtTime(a.start_time);
      $('#activityEnd').value = fmtTime(a.end_time);
      $('#activityLeave').value = fmtTime(a.leave_time);
      $('#activityDetails').value = a.details || '';
      $('#activityUntil').value = a.repeat_until || '';
      setPicker('activityChildren', [a.child_id]);
      setDays('activityDays', a.recurring_days || []);
      updateActivityUI();
      $('#activityFormTitle').textContent = 'Edit activity';
      $('#activitySubmit').textContent = 'Save changes';
      $('#activityCancel').classList.remove('hidden');
      openForm('activityForm');
    }

    async function deleteActivity(id) {
      if (session.role !== 'parent') return;
      if (!confirm('Delete this activity? If it repeats, every day it appears on will be removed.')) return;
      const res = await db.from('activities').delete().eq('id', id);
      if (!check(res)) return;
      await refreshAndRender();
    }

    function modalDeleteActivity(id) { closeModal(); deleteActivity(id); }

    // ---------- set up a child: starter goals, challenges and rewards ----------
    const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
    const SCHOOL_DAYS = [1, 2, 3, 4, 5];

    const GOAL_TEMPLATES = [
      { name: 'Make your bed', days: ALL_DAYS, on: true },
      { name: 'Homework done', days: SCHOOL_DAYS, on: true },
      { name: 'Tidy your bedroom', days: [6], on: true },
      { name: 'Brush teeth morning and night', days: ALL_DAYS },
      { name: 'Put dirty clothes in the wash basket', days: ALL_DAYS },
      { name: 'Set or clear the table', days: ALL_DAYS },
      { name: 'Feed the pet', days: ALL_DAYS },
      { name: 'Read for 20 minutes', days: ALL_DAYS },
      { name: 'Pack school bag for tomorrow', days: [0, 1, 2, 3, 4] },
      { name: 'Take out the bins', days: [3] }
    ];

    const CHALLENGE_TEMPLATES = [
      { name: 'Wash the car', points: 20, days: [], on: true },
      { name: 'Help with the washing up', points: 5, days: [], on: true },
      { name: 'Vacuum a room', points: 10, days: [], on: true },
      { name: 'Water the plants', points: 5, days: [0] },
      { name: 'Walk the dog', points: 10, days: [] },
      { name: 'Help cook dinner', points: 10, days: [] },
      { name: 'Tidy the garden', points: 15, days: [] },
      { name: 'Sort out toys or clothes', points: 10, days: [] },
      { name: 'Do something kind for someone', points: 10, days: [] },
      { name: 'Read an extra chapter', points: 5, days: [] }
    ];

    const REWARD_TEMPLATES = [
      { name: '30 minutes extra screen time', cost: 30, limit: 10, on: true },
      { name: 'Choose what is for dinner', cost: 40, limit: 5 },
      { name: 'Movie night', cost: 60, limit: 5, on: true },
      { name: 'Stay up 30 minutes later', cost: 40, limit: 5 },
      { name: 'Trip to the park or an ice cream', cost: 50, limit: 5, on: true },
      { name: 'Pick a family game', cost: 25, limit: 10 }
    ];

    function templateDays(days) {
      if (days.length === 7) return 'Every day';
      if (!days.length) return 'One-off';
      if (days.length === 5 && SCHOOL_DAYS.every((d) => days.includes(d))) return 'Weekdays';
      return 'Every ' + [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join(', ');
    }

    function openChildSetup(childId) {
      if (session.role !== 'parent') return;
      const kid = family.children.find((c) => c.id === childId);
      if (!kid) return;
      const row = (kind, i, name, hint, checked) => `
        <label class="setup-row">
          <input type="checkbox" data-setup="${kind}:${i}" ${checked ? 'checked' : ''} />
          <span>${esc(name)}<small>${esc(hint)}</small></span>
        </label>`;
      const body = `
        <p class="meta">Tick what you would like to start ${esc(kid.name)} with. Goals begin with the consequence "No screens" for 1 day. You can edit or delete everything afterwards.</p>
        <h3>Goals (things to do by a deadline)</h3>
        <div class="list">${GOAL_TEMPLATES.map((t, i) => row('goal', i, t.name, templateDays(t.days), t.on)).join('')}</div>
        <h3>Optional challenges (extra ways to earn points)</h3>
        <div class="list">${CHALLENGE_TEMPLATES.map((t, i) => row('challenge', i, t.name, t.points + ' points · ' + templateDays(t.days), t.on)).join('')}</div>
        ${family.rewards.length ? '' : `
        <h3>Starter rewards (for the whole family)</h3>
        <div class="list">${REWARD_TEMPLATES.map((t, i) => row('reward', i, t.name, t.cost + ' points', t.on)).join('')}</div>`}
        <p id="setupError" class="error"></p>
      `;
      showModal('Set up ' + kid.name, body,
        `<button class="btn" type="button" onclick="applyChildSetup('${childId}')">Add selected</button>
         <button class="btn secondary" type="button" onclick="closeModal()">Skip for now</button>`);
    }

    async function applyChildSetup(childId) {
      if (session.role !== 'parent') return;
      const kid = family.children.find((c) => c.id === childId);
      if (!kid) return;
      const picked = $$('#modalBody input[data-setup]:checked').map((box) => box.dataset.setup.split(':'));
      if (!picked.length) { closeModal(); return; }
      setMessage('#setupError', '');

      const goals = [];
      const challenges = [];
      const rewards = [];
      picked.forEach(([kind, index]) => {
        const i = Number(index);
        if (kind === 'goal') {
          const t = GOAL_TEMPLATES[i];
          goals.push({
            family_id: family.id, child_id: childId, name: t.name, details: '',
            consequence: 'No screens', consequence_days: 1,
            due_date: firstOccurrence(t.days), status: 'active', recurring_days: t.days
          });
        } else if (kind === 'challenge') {
          const t = CHALLENGE_TEMPLATES[i];
          challenges.push({ family_id: family.id, child_id: childId, name: t.name, points: t.points, details: '', recurring_days: t.days });
        } else if (kind === 'reward') {
          const t = REWARD_TEMPLATES[i];
          rewards.push({ family_id: family.id, name: t.name, cost: t.cost, limit_count: t.limit, claimed_count: 0, available_until: addDays(todayStr(), 90) });
        }
      });

      const steps = [['goals', goals], ['challenges', challenges], ['rewards', rewards]];
      for (const [table, rows] of steps) {
        if (!rows.length) continue;
        const { error } = await db.from(table).insert(rows);
        if (error) {
          setMessage('#setupError', 'Could not add ' + table + ': ' + error.message);
          return;
        }
      }
      closeModal();
      await refreshAndRender();
      showToast('Added ' + picked.length + (picked.length === 1 ? ' item' : ' items') + ' for ' + kid.name, null);
    }

    // ---------- feedback notes ----------
    const NOTE_LABELS = { praise: 'Well done', note: 'Note', reminder: 'Reminder' };

    function renderFeedback() {
      const isParent = session.role === 'parent';
      const child = activeChild();
      const notes = (family.notes || []).filter((n) => isParent || n.child_id === child.id);
      const section = $('#feedbackSection');
      section.classList.toggle('hidden', !isParent && !notes.length);
      $('#feedbackTitle').textContent = isParent ? 'Feedback' : 'Feedback from your parents';
      $('#feedbackSub').textContent = isParent
        ? 'Send a child a note. It is not a consequence.'
        : 'Messages your parents have sent you.';
      const list = $('#feedbackList');

      if (!notes.length) {
        list.innerHTML = '<div class="empty">No feedback sent yet.</div>';
        return;
      }

      const when = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

      if (!isParent) {
        const card = (n) => {
          const unread = !n.read_at;
          return `
            <article class="item note-card ${n.kind}${unread ? ' unread' : ''}">
              <div class="item-header">
                <div>
                  <div class="item-title">${NOTE_LABELS[n.kind] || 'Note'}</div>
                  <div class="meta">From ${esc(n.author_name || 'your parent')} · ${when(n.created_at)}</div>
                </div>
                ${unread ? '<span class="pill amber">New</span>' : ''}
              </div>
              <div class="note-text">${esc(n.message)}</div>
              ${unread ? `<div class="row"><button class="btn success small" type="button" onclick="markNoteRead('${n.id}')">&#10003; Got it</button></div>` : ''}
            </article>
          `;
        };
        const fresh = notes.filter((n) => !n.read_at);
        const earlier = notes.filter((n) => n.read_at);
        list.innerHTML = fresh.map(card).join('')
          + (earlier.length ? `<details class="done-list"${fresh.length ? '' : ' open'}><summary>Earlier feedback (${earlier.length})</summary>${earlier.map(card).join('')}</details>` : '');
        return;
      }

      const row = (n) => `
        <article class="row-item">
          <div class="row-main">
            <div class="row-title">${esc(childName(n.child_id))}: ${esc(n.message)}</div>
            <div class="row-meta">${NOTE_LABELS[n.kind] || 'Note'} · ${when(n.created_at)} · ${n.read_at ? 'Seen' : 'Not seen yet'}</div>
          </div>
          <button class="btn secondary small" type="button" onclick="deleteNote('${n.id}')">Delete</button>
        </article>
      `;
      list.innerHTML = notes.slice(0, 5).map(row).join('')
        + (notes.length > 5 ? `<details class="done-list"><summary>Older feedback (${notes.length - 5})</summary>${notes.slice(5).map(row).join('')}</details>` : '');
    }

    async function addFeedback(event) {
      event.preventDefault();
      setMessage('#feedbackError', '');
      const childIds = $$('#feedbackChildren input[data-child]:checked').map((box) => box.value);
      if (!childIds.length) {
        setMessage('#feedbackError', 'Pick at least one child.');
        return;
      }
      const message = $('#feedbackMessage').value.trim();
      if (!message) {
        setMessage('#feedbackError', 'Write a message first.');
        return;
      }
      const { error } = await db.from('notes').insert(childIds.map((id) => ({
        family_id: family.id,
        child_id: id,
        author_id: session.userId,
        author_name: session.parentName || 'Your parent',
        kind: $('#feedbackKind').value,
        message
      })));
      if (error) {
        setMessage('#feedbackError', error.message);
        return;
      }
      event.target.reset();
      closeForm('feedbackForm');
      await refreshAndRender();
    }

    function openFeedbackFor(childId) {
      openForm('feedbackForm');
      setPicker('feedbackChildren', [childId]);
      $('#feedbackMessage').focus();
    }

    async function deleteNote(id) {
      if (session.role !== 'parent') return;
      if (!confirm('Delete this feedback? The child will no longer see it.')) return;
      const res = await db.from('notes').delete().eq('id', id);
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function markNoteRead(id) {
      const res = await db.rpc('child_mark_note_read', { p_token: session.token, p_note_id: id });
      if (!check(res)) return;
      await refreshAndRender();
    }

    // ---------- one child's details (parents, from Settings) ----------
    function openChildDetail(childId) {
      if (session.role !== 'parent') return;
      const kid = family.children.find((c) => c.id === childId);
      if (!kid) return;
      const today = todayStr();

      const goalRows = family.goals.filter((g) => g.child_id === childId && g.status !== 'completed').map((g) => {
        const d = goalDisplay(g);
        return `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(g.name)}</div>
              <div class="row-meta">${esc(d.label)} · due ${prettyDate(g.due_date)}</div>
              <div class="progress mini ${d.tone}"><span style="width:${d.fill}%"></span></div>
            </div>
            <button class="btn secondary small" type="button" onclick="editItem('goal', '${g.id}')">Edit</button>
          </article>`;
      }).join('');

      const challengeRows = family.challenges.filter((c) => c.child_id === childId).map((c) => `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(c.name)}</div>
              <div class="row-meta">${c.points} points${(c.recurring_days || []).length ? ' · repeats ' + [...c.recurring_days].sort().map((n) => DAY_NAMES[n]).join(', ') : ''}</div>
            </div>
            <button class="btn secondary small" type="button" onclick="editItem('challenge', '${c.id}')">Edit</button>
          </article>`).join('');

      const consequenceRows = (family.consequences || []).filter((c) => c.child_id === childId && c.status === 'active').map((c) => `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(c.name)}</div>
              <div class="row-meta">${c.ends_on ? (c.ends_on < today ? 'Ended ' : 'Ends ') + prettyDate(c.ends_on) : 'No end date'}</div>
            </div>
            <button class="btn secondary small" type="button" onclick="editItem('consequence', '${c.id}')">Edit</button>
          </article>`).join('');

      const historyRows = (family.log || []).filter((e) => e.child_id === childId).slice(0, 8).map((e) => `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(e.reason)}</div>
              <div class="row-meta">${new Date(e.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <span class="pill ${e.amount > 0 ? 'green' : 'amber'}">${e.amount > 0 ? '+' : ''}${e.amount}</span>
          </article>`).join('');

      const activityRows = (family.activities || []).filter((a) => a.child_id === childId).map((a) => `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(a.title)}</div>
              <div class="row-meta">${esc(activitySchedule(a))}${timeRange(a) ? ' · ' + esc(timeRange(a)) : ''}</div>
            </div>
            <button class="btn secondary small" type="button" onclick="editItem('activity', '${a.id}')">Edit</button>
          </article>`).join('');

      const noteRows = (family.notes || []).filter((n) => n.child_id === childId).slice(0, 5).map((n) => `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(n.message)}</div>
              <div class="row-meta">${NOTE_LABELS[n.kind] || 'Note'} · ${new Date(n.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${n.read_at ? 'Seen' : 'Not seen yet'}</div>
            </div>
          </article>`).join('');

      const section = (heading, rows, empty) => `<h3>${heading}</h3><div class="list">${rows || `<div class="empty">${empty}</div>`}</div>`;
      const body = `
        <div class="kid-top">
          <span class="avatar">${esc(kid.name.charAt(0).toUpperCase())}</span>
          <div class="item-title">${esc(kid.name)}</div>
          <span class="pill green">${kid.points} points</span>
        </div>
        ${section('Goals', goalRows, 'No open goals.')}
        ${section('Optional challenges', challengeRows, 'No challenges.')}
        ${section('Consequences', consequenceRows, 'No active consequences.')}
        ${section('Activities', activityRows, 'No activities.')}
        ${section('Feedback sent', noteRows, 'No feedback sent yet.')}
        ${section('Recent points activity', historyRows, 'No activity yet.')}
      `;
      showModal(kid.name, body, `<button class="btn" type="button" onclick="closeModal(); openFeedbackFor('${childId}')">Give feedback</button>`);
    }

    let toastTimer = null;
    let toastApprovalId = null;

    function showToast(text, approvalId) {
      toastApprovalId = approvalId || null;
      $('#toastText').textContent = text;
      $('#toastUndo').classList.toggle('hidden', !approvalId);
      $('#toast').classList.remove('hidden');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 9000);
    }

    function hideToast() {
      $('#toast').classList.add('hidden');
      toastApprovalId = null;
    }

    async function undoApproval(id, confirmFirst) {
      if (session.role !== 'parent' || !id) return;
      if (confirmFirst && !confirm('Undo this approval? Any points it gave will be taken back.')) return;
      const res = await db.rpc('undo_approval', { p_approval_id: id });
      if (!check(res)) return;
      hideToast();
      await refreshAndRender();
    }

    function renderApprovals() {
      if (session.role !== 'parent') return;
      const list = $('#approvalList');
      const items = (family.approvals || []).slice(0, 10);
      if (!items.length) {
        list.innerHTML = '<div class="empty">No approvals yet. Approvals from now on show here with an Undo button.</div>';
        return;
      }
      list.innerHTML = items.map((a) => {
        const when = new Date(a.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `
          <article class="row-item">
            <div class="row-main">
              <div class="row-title">${esc(childName(a.child_id))}: ${esc(a.label)}</div>
              <div class="row-meta">${a.kind === 'goal' ? 'Goal' : 'Challenge'} approved · ${when}${a.points ? ' · +' + a.points + ' points' : ''}</div>
            </div>
            ${a.undone_at
              ? '<span class="pill">Undone</span>'
              : `<button class="btn ghost-danger small" type="button" onclick="undoApproval('${a.id}', true)">Undo</button>`}
          </article>
        `;
      }).join('');
    }

    let summaryWeek = 'this';

    // Monday to Sunday
    function weekRange(which) {
      const now = new Date();
      const sinceMonday = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday - (which === 'last' ? 7 : 0));
      const start = fmtDate(monday);
      return { start, end: addDays(start, 6) };
    }

    function renderSummary() {
      if (session.role !== 'parent') return;
      const { start, end } = weekRange(summaryWeek);
      $('#summaryThis').classList.toggle('active', summaryWeek === 'this');
      $('#summaryLast').classList.toggle('active', summaryWeek === 'last');
      $('#summaryRange').textContent = prettyDate(start) + ' to ' + prettyDate(end);

      const inRange = (ts) => {
        const day = fmtDate(new Date(ts));
        return day >= start && day <= end;
      };

      if (!family.children.length) {
        $('#summaryList').innerHTML = '<div class="empty">Add a child to see their weekly summary.</div>';
        return;
      }

      $('#summaryList').innerHTML = family.children.map((kid) => {
        const approvals = (family.approvals || []).filter((a) => a.child_id === kid.id && !a.undone_at && inRange(a.created_at));
        const challengesDone = approvals.filter((a) => a.kind === 'challenge').length;
        const goalsDone = approvals.filter((a) => a.kind === 'goal').length;
        const earned = approvals.reduce((sum, a) => sum + a.points, 0);
        const redeemed = (family.log || []).filter((e) => e.child_id === kid.id && String(e.reason).startsWith('Redeemed:') && inRange(e.created_at));
        const spent = redeemed.reduce((sum, e) => sum - e.amount, 0);
        const consequences = (family.consequences || []).filter((c) => c.child_id === kid.id && inRange(c.created_at));
        const missed = consequences.filter((c) => c.goal_id).length;
        return `
          <article class="item">
            <div class="kid-top">
              <span class="avatar">${esc(kid.name.charAt(0).toUpperCase())}</span>
              <div class="item-title">${esc(kid.name)}</div>
            </div>
            <div class="stat-grid">
              <div class="stat"><strong>${earned}</strong><span>Points earned</span></div>
              <div class="stat"><strong>${spent}</strong><span>Points spent</span></div>
              <div class="stat"><strong>${goalsDone}</strong><span>Goals done</span></div>
              <div class="stat"><strong>${challengesDone}</strong><span>Challenges done</span></div>
              <div class="stat"><strong>${missed}</strong><span>Goals missed</span></div>
              <div class="stat"><strong>${consequences.length}</strong><span>Consequences</span></div>
            </div>
            <div class="meta">${redeemed.length} ${redeemed.length === 1 ? 'reward' : 'rewards'} redeemed</div>
          </article>
        `;
      }).join('');
    }

    async function approveChallenge(challengeId) {
      if (session.role !== 'parent') return;
      const challenge = family.challenges.find((c) => c.id === challengeId);
      const waiting = family.requests.filter((r) => r.challenge_id === challengeId && r.status === 'waiting');
      const { data, error } = await db.rpc('approve_challenge', { p_challenge_id: challengeId, p_today: todayStr() });
      if (error) {
        alert(error.message);
        return;
      }
      const photos = waiting.map((r) => r.photo_path).filter(Boolean);
      if (photos.length) {
        await db.from('completion_requests').update({ photo_path: null }).in('id', waiting.map((r) => r.id));
        await discardPhotos(photos);
      }
      await refreshAndRender();
      if (data) showToast('Approved: ' + (challenge ? challenge.name : 'challenge'), data);
    }

    async function setChildPoints(childId) {
      if (session.role !== 'parent') return;
      const input = document.getElementById('points-' + childId);
      const value = Math.max(0, Math.round(Number(input.value)));
      if (!Number.isFinite(value)) return;
      const res = await db.rpc('set_child_points', { p_child_id: childId, p_points: value });
      if (!check(res)) return;
      await refreshAndRender();
    }

    async function deleteChallenge(challengeId) {
      if (session.role !== 'parent') return;
      if (!confirm('Delete this challenge? This cannot be undone.')) return;
      // Clear any pending request so it doesn't linger in the Requests tab
      await discardPhotos(family.requests.filter((r) => r.challenge_id === challengeId).map((r) => r.photo_path));
      await db.from('completion_requests').delete().eq('challenge_id', challengeId).eq('status', 'waiting');
      await db.from('challenges').delete().eq('id', challengeId);
      await refreshAndRender();
    }

    async function deleteGoal(goalId) {
      if (session.role !== 'parent') return;
      if (!confirm('Delete this goal? This cannot be undone.')) return;
      await discardPhotos([(family.goals.find((g) => g.id === goalId) || {}).photo_path]);
      await db.from('goals').delete().eq('id', goalId);
      await refreshAndRender();
    }

    async function claimReward(rewardId) {
      const res = await db.rpc('child_redeem', { p_token: session.token, p_reward_id: rewardId, p_today: todayStr() });
      if (!check(res)) return;
      await refreshAndRender();
    }

    $('#createParentForm').addEventListener('submit', signUp);
    $('#parentSignInForm').addEventListener('submit', parentSignIn);
    $('#childSignInForm').addEventListener('submit', childSignIn);
    $('#recoverForm').addEventListener('submit', setNewPassword);
    $('#forgotBtn').addEventListener('click', forgotPassword);
    $('#newFamilyForm').addEventListener('submit', createFamily);
    $('#joinFamilyForm').addEventListener('submit', joinFamily);
    $('#claimFamilyForm').addEventListener('submit', claimFamily);
    $('#inviteBtn').addEventListener('click', createInvite);
    $('#regenCodeBtn').addEventListener('click', regenerateCode);
    $('#childForm').addEventListener('submit', addChild);
    $('#challengeForm').addEventListener('submit', addChallenge);
    $('#goalForm').addEventListener('submit', addGoal);
    $('#rewardForm').addEventListener('submit', addReward);
    $('#consequenceForm').addEventListener('submit', addConsequence);
    $('#feedbackForm').addEventListener('submit', addFeedback);
    $('#activityForm').addEventListener('submit', addActivity);
    $('#activityCancel').addEventListener('click', cancelEdit);
    $('#activityDays').addEventListener('change', updateActivityUI);
    $('#activityDate').addEventListener('change', () => { if (!$('#activityDate').disabled) lastManualActivityDate = $('#activityDate').value; });
    $('#rewardCancel').addEventListener('click', cancelEdit);
    $('#consequenceCancel').addEventListener('click', cancelEdit);
    $('#saveFamilyNameBtn').addEventListener('click', renameFamily);
    $('#pushBtn').addEventListener('click', togglePush);
    registerServiceWorker();
    // A notification tapped while the app is already open
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const msg = event.data || {};
        if (msg.type !== 'notification-click' || !session || session.role !== 'parent') return;
        const params = new URL(msg.url, window.location.href).searchParams;
        if (params.get('open') === 'summary') openSummary();
        else if (params.get('tab') === 'requests') jumpTo('attentionSection');
      });
    }
    $('#aiSummaryBtn').addEventListener('click', () => reportButton());
    $('#aiGenThis').addEventListener('click', () => generateSummary('this'));
    $('#aiGenLast').addEventListener('click', () => generateSummary('last'));
    $('#challengeCancel').addEventListener('click', cancelEdit);
    $('#goalCancel').addEventListener('click', cancelEdit);
    $$('[data-auth-tab]').forEach((button) => button.addEventListener('click', () => setAuthTab(button.dataset.authTab)));
    $$('[data-onboard-tab]').forEach((button) => button.addEventListener('click', () => setOnboardTab(button.dataset.onboardTab)));
    $('#goalDays').addEventListener('change', updateGoalDueState);
    $('#goalDays').addEventListener('change', updateGoalRotateState);
    $('#goalChildren').addEventListener('change', () => setTimeout(updateGoalRotateState, 0));
    $('#goalConsequenceChoice').addEventListener('change', updateGoalConsequenceUI);
    $('#consequenceChoice').addEventListener('change', updateConsequenceUI);
    updateConsequenceUI();
    updateGoalConsequenceUI();
    ['challengeChildren', 'goalChildren', 'consequenceChildren', 'feedbackChildren', 'activityChildren'].forEach((id) => {
      $('#' + id).addEventListener('change', (e) => {
        const kids = $$('#' + id + ' input[data-child]');
        if (e.target.matches('[data-all]')) {
          kids.forEach((b) => b.checked = e.target.checked);
        } else {
          const all = $('#' + id + ' [data-all]');
          if (all) all.checked = kids.every((b) => b.checked);
        }
      });
    });

    $('#goalDueDate').value = nextDate(7);
    $('#rewardUntil').value = nextDate(14);
    $('#activityDate').value = todayStr();

    $('#summaryThis').addEventListener('click', () => { summaryWeek = 'this'; renderSummary(); });
    $('#summaryLast').addEventListener('click', () => { summaryWeek = 'last'; renderSummary(); });
    $('#toastUndo').addEventListener('click', () => undoApproval(toastApprovalId, false));
    $$('[data-mview]').forEach((button) => button.addEventListener('click', () => setMobileView(button.dataset.mview)));
    $('#calPrev').addEventListener('click', () => shiftMonth(-1));
    $('#calNext').addEventListener('click', () => shiftMonth(1));
    $('#calToday').addEventListener('click', () => {
      calMonth = { y: new Date().getFullYear(), m: new Date().getMonth() };
      calSelected = todayStr();
      renderCalendar();
    });
    $$('[data-calfilter]').forEach((button) => button.addEventListener('click', () => {
      calFilter[button.dataset.calfilter] = !calFilter[button.dataset.calfilter];
      renderCalendar();
    }));
    $('#calendarSection').addEventListener('click', (e) => {
      const item = e.target.closest('[data-cal-item]');
      if (item) {
        const [type, id, date] = item.dataset.calItem.split(':');
        openCalendarItem(type, id, date);
        return;
      }
      const cell = e.target.closest('[data-cal-date]');
      if (cell) {
        calSelected = cell.dataset.calDate;
        renderCalendar();
      }
    });
    renderThemes();
    if (window.matchMedia) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getThemeChoice() === 'system') applyTheme();
      });
    }
    $('#overviewChild').addEventListener('change', () => {
      overviewChild = $('#overviewChild').value;
      if (goalFilter) goalFilter.childId = overviewChild;
      renderOverview();
      renderGoals();
    });
    const goalsFold = $('#goalsDetails');
    try { if (localStorage.getItem('parentalRewardsGoalsOpen') === '0') goalsFold.open = false; } catch (e) { /* ignore */ }
    goalsFold.addEventListener('toggle', () => {
      try { localStorage.setItem('parentalRewardsGoalsOpen', goalsFold.open ? '1' : '0'); } catch (e) { /* ignore */ }
    });

    // Close an open "..." menu when you tap anywhere else
    document.addEventListener('click', (e) => {
      $$('.more[open]').forEach((menu) => { if (!menu.contains(e.target)) menu.open = false; });
    });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    setInterval(autoRefresh, 5000);
    // Activities cross themselves off as their finish time passes
    setInterval(() => {
      if (!session || !family || document.hidden) return;
      renderToday();
      renderActivities();
      renderCalendar();
      if (session.role === 'parent') renderOverview();
    }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastAutoRefresh = 0; autoRefresh(); } });

    // Parent sign-in state comes from Supabase Auth; children use a saved token.
    db.auth.onAuthStateChange((event, authSession) => {
      // Run outside the callback so we never call Supabase from inside it
      setTimeout(async () => {
        if (event === 'PASSWORD_RECOVERY') {
          recovering = true;
          booting = false;
          resetState();
          setAuthTab('recover');
          render();
          return;
        }
        if (recovering) return;
        if (event === 'INITIAL_SESSION') {
          await startFromAuth(authSession);
        } else if (event === 'SIGNED_IN') {
          if (authSession?.user && !(session?.role === 'parent' && session.userId === authSession.user.id)) {
            await enterParent(authSession.user);
          }
        } else if (event === 'SIGNED_OUT') {
          if (session?.role === 'parent' || needsOnboarding) {
            resetState();
            render();
          }
        }
      }, 0);
    });

    // Fallback in case the auth listener is slow to report the saved session
    setTimeout(async () => {
      if (!booting) return;
      const { data } = await db.auth.getSession();
      if (booting) await startFromAuth(data.session);
    }, 2000);
