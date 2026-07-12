// Oahu Move — standalone front-end (GitHub Pages) talking to the
// Google Apps Script JSON API backend (Code.gs doGet/doPost).

// ⚠️ SET THIS to your Apps Script Web App URL after deploying (ends in /exec).
var API_BASE = 'https://script.google.com/macros/s/AKfycbyEAKsrROuR3KAeiCcD5z3sWlB7wrm89UTS_F05wtsdUAj_r3JgzIwDph-tKbrwTBLQ/exec';

var DATA = { tasks: [], owners: [], statuses: [], priorities: [], categories: [] };
var RENTAL_DATA = { listings: [], statuses: [] };
var VIEW = 'cal';
var RENTAL_SUBVIEW = 'active'; // Rentals tab: 'active' (New/Viewed) or 'saved'
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
  if (fn === 'getRentals') return apiGet('getRentals');
  if (fn === 'addListing') return apiPost('addListing', { listing: args[0] });
  if (fn === 'updateListing') return apiPost('updateListing', { listing: args[0] });
  if (fn === 'patchListing') return apiPost('patchListing', { id: args[0], field: args[1], value: args[2] });
  if (fn === 'deleteListing') return apiPost('deleteListing', { id: args[0] });
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
// Tolerates a not-yet-redeployed backend (getRentals unknown to an older
// Apps Script deployment) by falling back to an empty rentals list instead
// of crashing the whole render.
function safeRentals_(r) { return (r && r.listings) ? r : { listings: [], statuses: RENTAL_DATA.statuses || [] }; }
function load() {
  setBusy(true);
  Promise.all([run('getData'), run('getRentals')]).then(function (r) {
    DATA = r[0]; RENTAL_DATA = safeRentals_(r[1]); setBusy(false); fillFilters(); render();
  }).catch(function (e) { setBusy(false); toast('Load failed — retrying'); });
}
function poll() {
  if (BUSY || document.getElementById('modalBg').classList.contains('show') ||
      document.getElementById('rentalModalBg').classList.contains('show')) return;
  Promise.all([run('getData'), run('getRentals')]).then(function (r) {
    var changed = false;
    var rentals = safeRentals_(r[1]);
    if (JSON.stringify(r[0].tasks) !== JSON.stringify(DATA.tasks)) { DATA = r[0]; changed = true; }
    if (JSON.stringify(rentals.listings) !== JSON.stringify(RENTAL_DATA.listings)) { RENTAL_DATA = rentals; changed = true; }
    if (changed) render();
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
  ['cal', 'list', 'rentals'].forEach(function (x) {
    document.getElementById('seg' + x.charAt(0).toUpperCase() + x.slice(1)).className = (v === x) ? 'active' : '';
  });
  document.getElementById('filterControls').style.display = (v === 'list') ? 'flex' : 'none';
  render();
  if (v === 'list') {
    setTimeout(function () {
      var el = document.querySelector('.week-strip-item.active');
      if (el) el.scrollIntoView({ block: 'center' });
    }, 30);
  }
}
function fabClick() {
  if (VIEW === 'rentals') openAddRental(); else openAdd();
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
  if (VIEW === 'rentals') {
    main.innerHTML = renderRentals();
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
      '<div class="cal-nav-center">' +
        '<button onclick="calPrev()" aria-label="Previous">‹</button>' +
        '<div class="cal-title">' + title + '</div>' +
        '<button onclick="calNext()" aria-label="Next">›</button>' +
      '</div>' +
      '<button class="cal-today-btn" onclick="calTodayNav()">Today</button>' +
    '</div>' +
    '<div class="cal-subnav">' +
      '<div class="cal-subnav-center">' +
        '<div class="seg subseg">' +
          '<button class="' + (CAL_SUBVIEW === 'month' ? 'active' : '') + '" onclick="setCalSubview(\'month\')">Month</button>' +
          '<button class="' + (CAL_SUBVIEW === 'week' ? 'active' : '') + '" onclick="setCalSubview(\'week\')">Week</button>' +
        '</div>' +
      '</div>' +
      '<div class="cal-subnav-spacer"></div>' +
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
  html += renderUnscheduledTray(list);
  html += '<div class="cal-hint">Drag a task to reschedule · tap a day to add · tap a task to edit</div>';
  return html;
}

function renderUnscheduledTray(list) {
  var undated = list.filter(function (t) { return !t.due; }).sort(byPriority);
  if (!undated.length) return '';
  return '<div class="cal-tray"><div class="tray-label">📥 Unscheduled — drag onto a day</div><div class="tray-chips">' +
    undated.map(function (t) { return calChip(t); }).join('') +
    '</div></div>';
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

  html += renderUnscheduledTray(list);
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

function listRowHtml(t) {
  var pClass = t.priority === 'Critical' ? 'crit' : t.priority === 'High' ? 'high' : t.priority === 'Low' ? 'low' : '';
  var doneClass = t.status === 'Done' ? ' done' : '';
  var due = parseDue(t.due);
  var overdue = due && t.status !== 'Done' && daysBetween(due, today0()) < 0;
  return '<div class="lrow ' + pClass + doneClass + '" onclick="openEdit(\'' + t.id + '\')">' +
    '<input type="checkbox" class="cbox lrow-cb"' + (t.status === 'Done' ? ' checked' : '') +
      ' onclick="event.stopPropagation()" onchange="patch(\'' + t.id + '\',\'status\',this.checked?\'Done\':\'Not Started\')">' +
    '<div class="lrow-text">' + (t.milestone ? '<span class="lrow-star">★ </span>' : '') + esc(t.task) + '</div>' +
    (t.due ? '<div class="lrow-due' + (overdue ? ' overdue' : '') + '">' + fmtDueShort(t.due) + '</div>' : '') +
  '</div>';
}
function fmtDueShort(s) { var d = parseDue(s); return d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : ''; }

function renderWeekStrip(list) {
  var base = weekStart(today0());
  var html = '<div class="week-strip" id="weekStrip">';
  for (var i = -6; i <= 26; i++) {
    var ws = new Date(base); ws.setDate(ws.getDate() + i * 7);
    var we = new Date(ws); we.setDate(we.getDate() + 6);
    var isActive = ws.getTime() === LIST_WS.getTime();
    var isTodayWeek = (i === 0);
    var hasTasks = list.some(function (t) { var d = parseDue(t.due); return d && d >= ws && d <= we; });
    html += '<div class="week-strip-item' + (isActive ? ' active' : '') + (isTodayWeek ? ' is-today-week' : '') + (hasTasks ? ' has-tasks' : '') +
      '" onclick="jumpToWeek(\'' + iso(ws) + '\')">' +
      '<div class="wsi-month">' + MONTHS[ws.getMonth()].slice(0, 3).toUpperCase() + '</div>' +
      '<div class="wsi-day">' + ws.getDate() + '</div></div>';
  }
  html += '</div>';
  return html;
}
function jumpToWeek(isoStr) {
  var p = isoStr.split('-');
  LIST_WS = new Date(+p[0], +p[1] - 1, +p[2]);
  render();
  setTimeout(function () {
    var el = document.querySelector('.week-strip-item.active');
    if (el) el.scrollIntoView({ block: 'center' });
  }, 30);
}

function renderList(list) {
  var we = new Date(LIST_WS); we.setDate(we.getDate() + 6);
  var isCurrentWeek = weekStart(today0()).getTime() === LIST_WS.getTime();

  var inWeek = list.filter(function (t) {
    var d = parseDue(t.due);
    return d && d >= LIST_WS && d <= we;
  }).sort(function (a, b) {
    var da = parseDue(a.due), db = parseDue(b.due);
    return (da - db) || byPriority(a, b);
  });
  var noDate = list.filter(function (t) { return !t.due; }).sort(byPriority);

  var html = '<div class="list-layout">' + renderWeekStrip(list) + '<div class="list-content">';
  html += '<div class="list-week-title">' + fmtShort(LIST_WS) + ' – ' + fmtShort(we) +
    (isCurrentWeek ? '<span class="lw-now">This Week</span>' : '') + '</div>';
  html += inWeek.length ? inWeek.map(listRowHtml).join('') : '<div class="empty">No tasks this week.</div>';
  if (noDate.length) {
    html += '<div class="list-section-label">No date yet</div>' + noDate.map(listRowHtml).join('');
  }
  html += '</div></div>';
  return html;
}

// ---- rentals view ----
function setRentalSubview(v) {
  RENTAL_SUBVIEW = v;
  render();
}
function fmtMoney(n) {
  n = Number(n);
  return isNaN(n) ? '' : '$' + n.toLocaleString('en-US');
}
function rentalCardHtml(r) {
  var photo = r.photoUrl
    ? '<img class="rental-photo" src="' + esc(r.photoUrl) + '" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'rental-photo-fallback\',textContent:\'🏠\'}))">'
    : '<div class="rental-photo-fallback">🏠</div>';
  var meta = [];
  if (r.beds) meta.push('<span class="chip">' + esc(r.beds) + ' bd</span>');
  if (r.baths) meta.push('<span class="chip">' + esc(r.baths) + ' ba</span>');
  if (r.sqft) meta.push('<span class="chip">' + esc(Number(r.sqft).toLocaleString('en-US')) + ' sqft</span>');
  if (r.propertyType) meta.push('<span class="chip">' + esc(r.propertyType) + '</span>');
  var pets = [];
  if (r.petCat) pets.push('<span class="pet-icon" title="Cat friendly">🐱</span>');
  if (r.petDog) pets.push('<span class="pet-icon" title="Dog friendly">🐕</span>');
  var perks = [];
  if (r.hasYard) perks.push('<span class="chip perk">🌳 Yard</span>');
  if (r.hasAC) perks.push('<span class="chip perk">❄️ AC</span>');
  return '<div class="rental-card">' +
    '<div class="rental-photo-wrap" onclick="openEditRental(\'' + r.id + '\')">' +
      (r.status === 'New' ? '<div class="rental-badge">🆕 New</div>' : '') +
      (pets.length ? '<div class="rental-pets">' + pets.join('') + '</div>' : '') +
      photo +
    '</div>' +
    '<div class="rental-body">' +
      '<div onclick="openEditRental(\'' + r.id + '\')">' +
        (r.price ? '<div class="rental-price">' + fmtMoney(r.price) + '/mo</div>' : '') +
        (r.address ? '<div class="rental-address">' + esc(r.address) + '</div>' : '') +
        '<div class="rental-meta">' + meta.join('') + perks.join('') + '</div>' +
        (r.notes ? '<div class="rental-notes">' + linkify(r.notes) + '</div>' : '') +
      '</div>' +
      (r.url ? '<a class="rental-link" href="' + esc(r.url) + '" target="_blank" rel="noopener">View listing ↗</a>' : '') +
      '<div class="rental-actions">' +
        '<button class="' + (r.status === 'Viewed' ? 'active-viewed' : '') + '" onclick="patchListing(\'' + r.id + '\',\'status\',\'Viewed\')">👀 Viewed</button>' +
        '<button class="' + (r.status === 'Saved' ? 'active-save' : '') + '" onclick="patchListing(\'' + r.id + '\',\'status\',\'' + (r.status === 'Saved' ? 'Viewed' : 'Saved') + '\')">⭐ ' + (r.status === 'Saved' ? 'Saved' : 'Save') + '</button>' +
        '<button onclick="patchListing(\'' + r.id + '\',\'status\',\'Declined\')">✕ Decline</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}
function renderRentals() {
  var all = RENTAL_DATA.listings.slice().sort(function (a, b) {
    return (b.dateAdded || '').localeCompare(a.dateAdded || '');
  });
  var saved = all.filter(function (r) { return r.status === 'Saved'; });
  var html = '<div class="cal-subnav"><div class="cal-subnav-center"><div class="seg subseg">' +
    '<button class="' + (RENTAL_SUBVIEW === 'active' ? 'active' : '') + '" onclick="setRentalSubview(\'active\')">New / Viewed</button>' +
    '<button class="' + (RENTAL_SUBVIEW === 'saved' ? 'active' : '') + '" onclick="setRentalSubview(\'saved\')">⭐ Saved (' + saved.length + ')</button>' +
    '</div></div></div>';

  if (RENTAL_SUBVIEW === 'saved') {
    html += saved.length ? saved.map(rentalCardHtml).join('') : '<div class="empty">No saved listings yet.</div>';
  } else {
    var active = all.filter(function (r) { return r.status === 'New' || r.status === 'Viewed'; })
      .sort(function (a, b) { return (a.status === b.status) ? 0 : (a.status === 'New' ? -1 : 1); });
    html += active.length ? active.map(rentalCardHtml).join('') : '<div class="empty">No listings yet. Tap + to add one.</div>';
  }
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

// ---- rentals: mutations ----
function patchListing(id, field, value) {
  var r = RENTAL_DATA.listings.filter(function (x) { return x.id === id; })[0];
  if (r) r[field] = value;      // optimistic
  render();
  setBusy(true);
  run('patchListing', id, field, value).then(function (d) {
    RENTAL_DATA = d; setBusy(false);
    if (field === 'status') toast(value === 'Declined' ? 'Declined' : value === 'Saved' ? 'Saved ⭐' : 'Marked viewed');
  }).catch(function () { setBusy(false); toast('Save failed'); load(); });
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
  document.getElementById('mDelete').classList.add('hidden');
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
  document.getElementById('mDelete').classList.remove('hidden');
  document.getElementById('modalBg').classList.add('show');
}
function deleteFromModal() {
  var id = document.getElementById('mId').value;
  if (!id) return;
  closeModal();
  del(id);
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

// ---- rentals: modal ----
function openAddRental() {
  document.getElementById('rentalModalTitle').textContent = 'Add listing';
  document.getElementById('rId').value = '';
  document.getElementById('rAddress').value = '';
  document.getElementById('rUrl').value = '';
  document.getElementById('rPhotoUrl').value = '';
  document.getElementById('rPrice').value = '';
  document.getElementById('rSqft').value = '';
  document.getElementById('rBeds').value = '';
  document.getElementById('rBaths').value = '';
  document.getElementById('rNotes').value = '';
  document.getElementById('rentalModalBg').classList.add('show');
}
function openEditRental(id) {
  var r = RENTAL_DATA.listings.filter(function (x) { return x.id === id; })[0]; if (!r) return;
  document.getElementById('rentalModalTitle').textContent = 'Edit listing';
  document.getElementById('rId').value = r.id;
  document.getElementById('rAddress').value = r.address || '';
  document.getElementById('rUrl').value = r.url || '';
  document.getElementById('rPhotoUrl').value = r.photoUrl || '';
  document.getElementById('rPrice').value = r.price || '';
  document.getElementById('rSqft').value = r.sqft || '';
  document.getElementById('rBeds').value = r.beds || '';
  document.getElementById('rBaths').value = r.baths || '';
  document.getElementById('rNotes').value = r.notes || '';
  document.getElementById('rentalModalBg').classList.add('show');
}
function closeRentalModal() { document.getElementById('rentalModalBg').classList.remove('show'); }
function saveRentalModal() {
  var listing = {
    id: document.getElementById('rId').value,
    address: document.getElementById('rAddress').value.trim(),
    url: document.getElementById('rUrl').value.trim(),
    photoUrl: document.getElementById('rPhotoUrl').value.trim(),
    price: document.getElementById('rPrice').value,
    sqft: document.getElementById('rSqft').value,
    beds: document.getElementById('rBeds').value,
    baths: document.getElementById('rBaths').value,
    notes: document.getElementById('rNotes').value.trim()
  };
  if (!listing.address && !listing.url) { toast('Enter an address or URL'); return; }
  closeRentalModal(); setBusy(true);
  var fn = listing.id ? 'updateListing' : 'addListing';
  run(fn, listing).then(function (d) { RENTAL_DATA = d; setBusy(false); render(); toast('Saved'); })
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
document.getElementById('rentalModalBg').addEventListener('click', function (e) {
  if (e.target === this) closeRentalModal();
});
