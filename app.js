// Oahu Move — standalone front-end (GitHub Pages) talking to the
// Google Apps Script JSON API backend (Code.gs doGet/doPost).

// ⚠️ SET THIS to your Apps Script Web App URL after deploying (ends in /exec).
var API_BASE = 'https://script.google.com/macros/s/AKfycbyEAKsrROuR3KAeiCcD5z3sWlB7wrm89UTS_F05wtsdUAj_r3JgzIwDph-tKbrwTBLQ/exec';

var DATA = { tasks: [], owners: [], statuses: [], priorities: [], categories: [] };
var VIEW = 'cal';
var BUSY = false;
var pollTimer = null;
var CAL = { y: 2026, m: 6 }; // calendar month shown (set to today on boot)
var CAL_SUBVIEW = 'month'; // Calendar tab: 'month' grid or 'week' list
var WF_SHOW_DONE = false; // "This Week's Focus" — show completed tasks toggle
var LIST_WS = null; // List view — start (Sunday) of the week currently shown (set to today's week on boot)

// ---- server bridge (fetch-based JSON API) ----
function apiGet(action) {
  return fetch(API_BASE + '?action=' + encodeURIComponent(action))
    .then(function (r) { return r.json(); });
}
function apiPost(action, payload) {
  var body = Object.assign({ action: action }, payload);
  return fetch(API_BASE, {
    method: 'POST',
    // text/plain avoids a CORS preflight (OPTIONS) request, which Apps Script
    // web apps don't handle. The server still JSON.parses the body itself.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); });
}
function run(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (fn === 'getData') return apiGet('getData');
  if (fn === 'addTask') return apiPost('addTask', { task: args[0] });
  if (fn === 'updateTask') return apiPost('updateTask', { task: args[0] });
  if (fn === 'patchTask') return apiPost('patchTask', { id: args[0], field: args[1], value: args[2] });
  if (fn === 'deleteTask') return apiPost('deleteTask', { id: args[0] });
  return Promise.reject(new Error('Unknown run() fn: ' + fn));
}

function setBusy(b) {
  BUSY = b;
  document.getElementById('dot').className = 'dot' + (b ? ' busy' : '');
  document.getElementById('syncTxt').textContent = b ? 'syncing…' : 'synced';
}
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('show'); }, 1800);
}

// ---- load / refresh ----
function load() {
  setBusy(true);
  run('getData').then(function (d) {
    DATA = d; setBusy(false); fillFilters(); render();
  }).catch(function (e) { setBusy(false); toast('Load failed — retrying'); });
}
function poll() {
  if (BUSY || document.getElementById('modalBg').classList.contains('show')) return;
  run('getData').then(function (d) {
    if (JSON.stringify(d.tasks) !== JSON.stringify(DATA.tasks)) { DATA = d; render(); }
  }).catch(function () {});
}

function fillFilters() {
  var fCat = document.getElementById('fCat');
  if (fCat.options.length <= 1) {
    DATA.categories.forEach(function (c) { fCat.add(new Option(c, c)); });
  }
  // modal selects
  fillSelect('mCat', DATA.categories);
  fillSelect('mOwner', DATA.owners);
  fillSelect('mPriority', DATA.priorities);
  fillSelect('mStatus', DATA.statuses);
}
function fillSelect(id, arr) {
  var s = document.getElementById(id);
  if (s.options.length) return;
  arr.forEach(function (v) { s.add(new Option(v, v)); });
}

// ---- date helpers ----
function parseDue(s) { if (!s) return null; var p = s.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }
function today0() { var d = new Date(); d.setHours(0,0,0,0); return d; }
function weekStart(d) { var x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0,0,0,0); return x; }
function fmtShort(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function daysBetween(a, b) { return Math.round((a - b) / 86400000); }

// ---- filtering ----
function filtered() {
  var cat = document.getElementById('fCat').value;
  var q = document.getElementById('search').value.toLowerCase();
  var showDone = document.getElementById('showDone').checked;
  return DATA.tasks.filter(function (t) {
    if (cat && t.category !== cat) return false;
    if (!showDone && t.status === 'Done') return false;
    if (q && (t.task + ' ' + t.notes + ' ' + t.category).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

// ---- render ----
function setView(v) {
  VIEW = v;
  ['cal', 'list'].forEach(function (x) {
    document.getElementById('seg' + x.charAt(0).toUpperCase() + x.slice(1)).className = (v === x) ? 'active' : '';
  });
  document.getElementById('filterControls').style.display = (v === 'cal') ? 'none' : 'flex';
  render();
}
function toggleWfDone(checked) {
  WF_SHOW_DONE = checked;
  render();
}

function setCalSubview(v) {
  CAL_SUBVIEW = v;
  render();
}

function render() {
  updateHeader();
  var main = document.getElementById('main');
  if (VIEW === 'cal') {
    // Calendar view always shows everything — no filters/search apply here.
    if (CAL_SUBVIEW === 'week') {
      main.innerHTML = renderCalNav() + renderCalendarWeekGrid(DATA.tasks, LIST_WS);
    } else {
      main.innerHTML = renderCalendar(DATA.tasks);
    }
    return;
  }
  main.innerHTML = renderList(filtered());
}

// ---- calendar view ----
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function iso(d) { return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2); }
function shorten(s, maxLen) { s = String(s); maxLen = maxLen || 40; return s.length > maxLen ? s.slice(0, maxLen - 2) + '…' : s; }
function changeMonth(delta) {
  CAL.m += delta;
  if (CAL.m < 0) { CAL.m = 11; CAL.y--; }
  if (CAL.m > 11) { CAL.m = 0; CAL.y++; }
  render();
}
function calToday() { var t = today0(); CAL.y = t.getFullYear(); CAL.m = t.getMonth(); render(); }

function calPrev() { if (CAL_SUBVIEW === 'week') changeListWeek(-1); else changeMonth(-1); }
function calNext() { if (CAL_SUBVIEW === 'week') changeListWeek(1); else changeMonth(1); }
function calTodayNav() { if (CAL_SUBVIEW === 'week') listWeekToday(); else calToday(); }

function renderCalNav() {
  var title = (CAL_SUBVIEW === 'week')
    ? (function () { var we = new Date(LIST_WS); we.setDate(we.getDate() + 6); return fmtShort(LIST_WS) + ' – ' + fmtShort(we); })()
    : MONTHS[CAL.m] + ' ' + CAL.y;
  return '<div class="cal-nav">' +
      '<button onclick="calPrev()" aria-label="Previous">‹</button>' +
      '<div class="cal-title">' + title + '</div>' +
      '<button onclick="calNext()" aria-label="Next">›</button>' +
    '</div>' +
    '<div class="cal-subnav">' +
      '<button class="cal-today-btn" onclick="calTodayNav()">Today</button>' +
      '<div class="seg subseg">' +
        '<button class="' + (CAL_SUBVIEW === 'month' ? 'active' : '') + '" onclick="setCalSubview(\'month\')">Month</button>' +
        '<button class="' + (CAL_SUBVIEW === 'week' ? 'active' : '') + '" onclick="setCalSubview(\'week\')">Week</button>' +
      '</div>' +
    '</div>';
}

function calChip(t, maxLen) {
  var p = t.priority === 'Critical' ? 'crit' : t.priority === 'High' ? 'high' : t.priority === 'Low' ? 'low' : 'norm';
  var done = t.status === 'Done' ? ' chip-done' : '';
  return '<div class="cal-chip ' + p + done + '" data-id="' + t.id + '" data-date="' + (t.due || '') + '">' +
    (t.milestone ? '★ ' : '') + esc(shorten(t.task, maxLen)) + '</div>';
}

function renderCalendar(list) {
  var y = CAL.y, m = CAL.m;
  var byDate = {};
  list.forEach(function (t) { if (t.due) (byDate[t.due] = byDate[t.due] || []).push(t); });
  var todayStr = iso(today0());
  var startDow = new Date(y, m, 1).getDay();
  var daysInMonth = new Date(y, m + 1, 0).getDate();

  var html = renderCalNav();

  html += '<div class="cal-grid cal-dow">' +
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function (d) { return '<div class="dow">' + d + '</div>'; }).join('') +
    '</div>';

  var cells = [];
  for (var i = 0; i < startDow; i++) cells.push(null);
  for (var d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  html += '<div class="cal-grid">';
  cells.forEach(function (d) {
    if (d === null) { html += '<div class="cal-cell empty-cell"></div>'; return; }
    var ds = iso(new Date(y, m, d));
    var items = (byDate[ds] || []).slice().sort(byPriority);
    html += '<div class="cal-cell' + (ds === todayStr ? ' today' : '') + '" data-date="' + ds + '">' +
      '<div class="cal-daynum">' + d + '</div>' +
      '<div class="cal-chips">' + items.map(calChip).join('') + '</div></div>';
  });
  html += '</div>';

  html += renderWeekFocus(list);

  var undated = list.filter(function (t) { return !t.due; }).sort(byPriority);
  html += '<div class="cal-tray"><div class="tray-label">📥 Unscheduled — drag onto a day</div><div class="tray-chips">' +
    (undated.length ? undated.map(calChip).join('') : '<span class="tray-empty">Nothing unscheduled 🎉</span>') +
    '</div></div>';
  html += '<div class="cal-hint">Drag a task to reschedule · tap a day to add · tap a task to edit</div>';
  return html;
}

function renderCalendarWeekGrid(list, ws) {
  var todayStr = iso(today0());
  var byDate = {};
  list.forEach(function (t) { if (t.due) (byDate[t.due] = byDate[t.due] || []).push(t); });

  var html = '<div class="cal-grid cal-dow">' +
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function (d) { return '<div class="dow">' + d + '</div>'; }).join('') +
    '</div>';

  html += '<div class="cal-grid cal-grid-week">';
  for (var i = 0; i < 7; i++) {
    var d = new Date(ws); d.setDate(d.getDate() + i);
    var ds = iso(d);
    var items = (byDate[ds] || []).slice().sort(byPriority);
    html += '<div class="cal-cell' + (ds === todayStr ? ' today' : '') + '" data-date="' + ds + '">' +
      '<div class="cal-daynum">' + d.getDate() + '</div>' +
      '<div class="cal-chips">' + items.map(function (t) { return calChip(t, 90); }).join('') + '</div></div>';
  }
  html += '</div>';

  var undated = list.filter(function (t) { return !t.due; }).sort(byPriority);
  html += '<div class="cal-tray"><div class="tray-label">📥 Unscheduled — drag onto a day</div><div class="tray-chips">' +
    (undated.length ? undated.map(function (t) { return calChip(t); }).join('') : '<span class="tray-empty">Nothing unscheduled 🎉</span>') +
    '</div></div>';
  html += '<div class="cal-hint">Drag a task to reschedule · tap a day to add · tap a task to edit</div>';
  return html;
}

function renderWeekFocus(list) {
  var ws = weekStart(today0());
  var we = new Date(ws); we.setDate(we.getDate() + 6);
  var items = list.filter(function (t) {
    if (!WF_SHOW_DONE && t.status === 'Done') return false;
    var d = parseDue(t.due);
    return d && d >= ws && d <= we;
  }).sort(byPriority);
  var html = '<div class="week-focus"><div class="wf-header-row">' +
    '<div class="wf-header">🔥 This Week’s Focus<small>' + fmtShort(ws) + ' – ' + fmtShort(we) + '</small></div>' +
    '<label class="wf-toggle"><input type="checkbox" id="wfShowDone"' + (WF_SHOW_DONE ? ' checked' : '') +
      ' onchange="toggleWfDone(this.checked)"> Show completed</label>' +
    '</div>';
  html += items.length ? items.map(cardHtml).join('') : '<div class="wf-empty">Nothing due this week' + (WF_SHOW_DONE ? '.' : ' — nice 🎉') + '</div>';
  html += '</div>';
  return html;
}

function updateHeader() {
  var done = DATA.tasks.filter(function (t) { return t.status === 'Done'; }).length;
  var total = DATA.tasks.length || 1;
  var pct = Math.round(done / total * 100);
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progLabel').textContent = done + ' of ' + total + ' done · ' + pct + '%';
  var listTask = DATA.tasks.filter(function (t) { return t.id === 'H7'; })[0];
  var moveTask = DATA.tasks.filter(function (t) { return t.id === 'Z1'; })[0];
  document.getElementById('cdList').textContent = countdown(listTask && listTask.due);
  document.getElementById('cdMove').textContent = countdown(moveTask && moveTask.due);
}
function countdown(due) {
  var d = parseDue(due); if (!d) return '–';
  var n = daysBetween(d, today0());
  return n < 0 ? '✓' : n;
}

function cardHtml(t) {
  var pClass = t.priority === 'Critical' ? 'crit' : t.priority === 'High' ? 'high' : t.priority === 'Low' ? 'low' : '';
  var doneClass = t.status === 'Done' ? ' done' : '';
  var due = parseDue(t.due);
  var overdue = due && t.status !== 'Done' && daysBetween(due, today0()) < 0;
  var ownerSel = '<select class="owner-sel" onchange="patch(\'' + t.id + '\',\'owner\',this.value)">' +
    DATA.owners.map(function (o) { return '<option' + (o === t.owner ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';
  var statusSel = '<select class="status-sel" onchange="patch(\'' + t.id + '\',\'status\',this.value)">' +
    DATA.statuses.map(function (s) { return '<option' + (s === t.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>';
  return '<div class="card ' + pClass + doneClass + '">' +
    '<div class="row1">' +
      '<input type="checkbox" class="cbox"' + (t.status === 'Done' ? ' checked' : '') +
        ' onchange="patch(\'' + t.id + '\',\'status\',this.checked?\'Done\':\'Not Started\')">' +
      '<div class="task-text">' + (t.milestone ? '<span class="star">★ </span>' : '') + esc(t.task) + '</div>' +
    '</div>' +
    '<div class="meta">' +
      '<span class="chip cat">' + esc(t.category) + '</span>' +
      (t.due ? '<span class="chip due' + (overdue ? ' overdue' : '') + '">📅 ' + fmtDue(t.due) + '</span>' : '') +
      ownerSel + statusSel +
    '</div>' +
    (t.notes ? '<div class="notes">' + linkify(t.notes) + '</div>' : '') +
    '<div class="actions"><button onclick="openEdit(\'' + t.id + '\')">✎ Edit</button>' +
      '<button class="del" onclick="del(\'' + t.id + '\')">🗑 Delete</button></div>' +
  '</div>';
}
function fmtDue(s) { var d = parseDue(s); return d ? d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : s; }

function changeListWeek(delta) {
  LIST_WS = new Date(LIST_WS);
  LIST_WS.setDate(LIST_WS.getDate() + delta * 7);
  render();
}
function listWeekToday() {
  LIST_WS = weekStart(today0());
  render();
}

function renderWeekCards(list, ws) {
  var we = new Date(ws); we.setDate(we.getDate() + 6);
  var inWeek = list.filter(function (t) {
    var d = parseDue(t.due);
    return d && d >= ws && d <= we;
  }).sort(function (a, b) {
    var da = parseDue(a.due), db = parseDue(b.due);
    return (da - db) || byPriority(a, b);
  });
  var noDate = list.filter(function (t) { return !t.due; }).sort(byPriority);
  var html = inWeek.length ? inWeek.map(cardHtml).join('') : '<div class="empty">No tasks this week.</div>';
  if (noDate.length) {
    html += '<div class="list-section-label">No date yet</div>' + noDate.map(cardHtml).join('');
  }
  return html;
}

function renderList(list) {
  var we = new Date(LIST_WS); we.setDate(we.getDate() + 6);
  var isCurrentWeek = weekStart(today0()).getTime() === LIST_WS.getTime();

  var html = '<div class="cal-nav">' +
      '<button onclick="changeListWeek(-1)" aria-label="Previous week">‹</button>' +
      '<div class="cal-title">' + fmtShort(LIST_WS) + ' – ' + fmtShort(we) + (isCurrentWeek ? ' <small class="lw-now">This Week</small>' : '') + '</div>' +
      '<button onclick="changeListWeek(1)" aria-label="Next week">›</button>' +
    '</div>' +
    '<div class="cal-subnav"><button class="cal-today-btn" onclick="listWeekToday()">This Week</button></div>';

  html += renderWeekCards(list, LIST_WS);
  return html;
}

function byPriority(a, b) {
  var order = { Critical: 0, High: 1, Normal: 2, Low: 3 };
  return (order[a.priority] || 2) - (order[b.priority] || 2);
}

// ---- mutations ----
function patch(id, field, value) {
  var t = DATA.tasks.filter(function (x) { return x.id === id; })[0];
  if (t) t[field] = value;      // optimistic
  render();
  setBusy(true);
  run('patchTask', id, field, value).then(function (d) {
    DATA = d; setBusy(false);
    if (field === 'status') toast(value === 'Done' ? 'Nice — checked off ✓' : 'Updated');
  }).catch(function () { setBusy(false); toast('Save failed'); load(); });
}
function del(id) {
  if (!confirm('Delete this task?')) return;
  DATA.tasks = DATA.tasks.filter(function (x) { return x.id !== id; });
  render(); setBusy(true);
  run('deleteTask', id).then(function (d) { DATA = d; setBusy(false); toast('Deleted'); })
    .catch(function () { setBusy(false); load(); });
}

// ---- modal ----
function openAdd(prefillDate) {
  document.getElementById('modalTitle').textContent = 'Add task';
  document.getElementById('mId').value = '';
  document.getElementById('mTask').value = '';
  document.getElementById('mCat').value = DATA.categories[0];
  document.getElementById('mOwner').value = 'Unassigned';
  document.getElementById('mDue').value = (typeof prefillDate === 'string') ? prefillDate : '';
  document.getElementById('mPriority').value = 'Normal';
  document.getElementById('mStatus').value = 'Not Started';
  document.getElementById('mMilestone').value = '';
  document.getElementById('mNotes').value = '';
  document.getElementById('modalBg').classList.add('show');
}
function openEdit(id) {
  var t = DATA.tasks.filter(function (x) { return x.id === id; })[0]; if (!t) return;
  document.getElementById('modalTitle').textContent = 'Edit task';
  document.getElementById('mId').value = t.id;
  document.getElementById('mTask').value = t.task;
  document.getElementById('mCat').value = t.category;
  document.getElementById('mOwner').value = t.owner;
  document.getElementById('mDue').value = t.due || '';
  document.getElementById('mPriority').value = t.priority;
  document.getElementById('mStatus').value = t.status;
  document.getElementById('mMilestone').value = t.milestone ? 'yes' : '';
  document.getElementById('mNotes').value = t.notes || '';
  document.getElementById('modalBg').classList.add('show');
}
function closeModal() { document.getElementById('modalBg').classList.remove('show'); }
function saveModal() {
  var task = {
    id: document.getElementById('mId').value,
    task: document.getElementById('mTask').value.trim(),
    category: document.getElementById('mCat').value,
    owner: document.getElementById('mOwner').value,
    due: document.getElementById('mDue').value,
    priority: document.getElementById('mPriority').value,
    status: document.getElementById('mStatus').value,
    milestone: document.getElementById('mMilestone').value === 'yes',
    notes: document.getElementById('mNotes').value.trim()
  };
  if (!task.task) { toast('Enter a task'); return; }
  closeModal(); setBusy(true);
  var fn = task.id ? 'updateTask' : 'addTask';
  run(fn, task).then(function (d) { DATA = d; setBusy(false); render(); toast('Saved'); })
    .catch(function () { setBusy(false); toast('Save failed'); load(); });
}

// ---- utils ----
function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function linkify(s) {
  return esc(s).replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/g, function (u) {
    var href = u.indexOf('http') === 0 ? u : 'https://' + u;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + u + '</a>';
  }).replace(/(\b\d{3}-\d{3}-\d{4}\b|\b1-\d{3}-\d{3}-\d{4}\b)/g, '<a href="tel:$1">$1</a>');
}

// ---- calendar drag & drop (pointer-based, works on touch + mouse) ----
var g = null; // active gesture
function pdown(e) {
  if (VIEW !== 'cal') return;
  var chip = e.target.closest ? e.target.closest('.cal-chip') : null;
  var cell = e.target.closest ? e.target.closest('.cal-cell[data-date]') : null;
  if (!chip && !cell) return;
  g = { x: e.clientX, y: e.clientY, moved: false, chip: chip, cell: cell,
        id: chip ? chip.getAttribute('data-id') : null,
        fromDate: chip ? chip.getAttribute('data-date') : null,
        clone: null, dayEl: null };
}
function pmove(e) {
  if (!g || !g.chip) return; // only chips drag; taps on empty cells scroll normally
  var dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (!g.moved && Math.abs(dx) + Math.abs(dy) > 8) {
    g.moved = true;
    g.clone = g.chip.cloneNode(true);
    g.clone.className += ' cal-chip-drag';
    g.clone.style.pointerEvents = 'none';
    document.body.appendChild(g.clone);
    g.chip.style.opacity = '0.3';
  }
  if (g.moved) {
    e.preventDefault();
    g.clone.style.left = e.clientX + 'px';
    g.clone.style.top = e.clientY + 'px';
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var cell = el && el.closest ? el.closest('.cal-cell[data-date]') : null;
    if (g.dayEl && g.dayEl !== cell) g.dayEl.classList.remove('drag-over');
    if (cell) { cell.classList.add('drag-over'); g.dayEl = cell; }
    else if (g.dayEl) { g.dayEl.classList.remove('drag-over'); g.dayEl = null; }
  }
}
function pup(e) {
  if (!g) return;
  var d = g; g = null;
  if (d.clone) d.clone.remove();
  if (d.chip) d.chip.style.opacity = '';
  if (d.dayEl) d.dayEl.classList.remove('drag-over');
  if (d.chip) {
    if (!d.moved) { openEdit(d.id); return; }       // tap a task = edit
    if (d.dayEl) {                                    // dropped on a day = reschedule
      var nd = d.dayEl.getAttribute('data-date');
      if (nd && nd !== d.fromDate) patch(d.id, 'due', nd);
    }
    return;
  }
  if (d.cell) {                                        // tap empty part of a day = add there
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 10) {
      openAdd(d.cell.getAttribute('data-date'));
    }
  }
}

// ---- boot ----
CAL.y = today0().getFullYear(); CAL.m = today0().getMonth();
LIST_WS = weekStart(today0());
load();
pollTimer = setInterval(poll, 25000);
var mainEl = document.getElementById('main');
mainEl.addEventListener('pointerdown', pdown);
document.addEventListener('pointermove', pmove, { passive: false });
document.addEventListener('pointerup', pup);
document.addEventListener('pointercancel', function () {
  if (g) { if (g.clone) g.clone.remove(); if (g.chip) g.chip.style.opacity = ''; if (g.dayEl) g.dayEl.classList.remove('drag-over'); g = null; }
});
document.getElementById('modalBg').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});
