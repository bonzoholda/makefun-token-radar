// Token Radar dashboard. Reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the board, filters, a per-protocol detail drawer, the fitted model's
// validation, and a sandbox. No network: every byte shown is in data.js.
//
// Recompute: impliedOf() is the same arithmetic lib/model.ts runs — the feature
// vector [1, log TVL, winsorised growth, log age, category dummies] dotted with the
// fitted coefficients, times the smearing correction — so the page checks every row
// against the number board.json carries. The farm plan is the same derivation too:
// category, chain, TVL and age decide the action, the capital, the hold and every
// cost and time. No protocol name is special-cased anywhere.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };
  var sandbox = { bTvl: DATA.model.b_tvl, bGrowth: DATA.model.b_growth, bAge: DATA.model.b_age };

  function rowObj(r) {
    return { rank: r[0], slug: r[1], name: r[2], category: r[3], chains: r[4], tvl_usd: r[5], change_7d: r[6], age_days: r[7], implied_value_usd: r[8], odds: r[9], expected: r[10], lo: r[11], hi: r[12], verdict: r[13], capital: r[14], gas: r[15], hours: r[16], payoff: r[17], perHour: r[18], breakeven: r[19], minCap: r[20], steps: r[21] };
  }
  var ROWS = DATA.rows.map(rowObj);

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(d) { if (d === null || d === undefined) return 'unknown'; if (d >= 365) return (d / 365).toFixed(1) + 'y'; return Math.max(0, Math.round(d)) + 'd'; }
  function fmtOdds(o) { return (o * 100).toFixed(1) + '%'; }

  function features(r) {
    var g = Math.min(120, Math.max(-60, r.change_7d === null ? 0 : r.change_7d)) / 100;
    var x = [1, Math.log(Math.max(r.tvl_usd, 1)), g, Math.log(Math.max(r.age_days === null ? 365 : r.age_days, 1))];
    DATA.model.cats.forEach(function (c) { x.push(r.category === c ? 1 : 0); });
    return x;
  }
  function impliedOf(r, coef) {
    var x = features(r);
    var c = coef || DATA.model.coef;
    var s = 0;
    for (var i = 0; i < x.length; i++) s += x[i] * c[i];
    return Math.max(1, Math.round(Math.exp(s) * DATA.model.smear));
  }
  function sandboxCoef() {
    var c = DATA.model.coef.slice();
    c[1] = sandbox.bTvl; c[2] = sandbox.bGrowth; c[3] = sandbox.bAge;
    return c;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var p = new URLSearchParams(hash);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('p')) state.selected = p.get('p');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('verdict')) state.verdict = p.get('verdict');
    if (p.get('tab')) state.tab = p.get('tab');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.verdict !== 'all') p.set('verdict', state.verdict);
    if (state.tab !== 'pre-token') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return ROWS.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.odds; bv = b.odds; }
      else if (key === 'expected') { av = a.expected; bv = b.expected; }
      else if (key === 'perhour') { av = a.perHour; bv = b.perHour; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar · radar-2' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: 'Fitted on ' + DATA.model.n_fit + ' token comps' })));
  }
  function lede() {
    var farm = ROWS.filter(function (r) { return r.verdict === 'FARM'; }).length;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, picked by the fitted model — not by TVL alone. Implied value is a model, not a promise: it says what a token would be worth if the protocol launched one at peer multiples, and expected value multiplies it by the launch odds.' })),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Verdict FARM' }), el('b', { text: String(farm) + ' rows' })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))));
  }
  function kpis() {
    var v = DATA.validation;
    return el('section', { class: 'kpis' },
      el('div', { class: 'kpi' }, el('b', { text: 'R² ' + DATA.model.r2 }), el('span', { text: 'log(mcap) fit, n=' + DATA.model.n_fit })),
      el('div', { class: 'kpi' }, el('b', { text: v.loo_med_multiple + '×' }), el('span', { text: 'leave-one-out median error' })),
      el('div', { class: 'kpi' }, el('b', { text: v.wf_med_multiple + '×' }), el('span', { text: 'walk-forward median error (n=' + v.wf_n_test + ')' })),
      el('div', { class: 'kpi' }, el('b', { text: 'R² ' + v.placebo_r2 }), el('span', { text: 'placebo (shuffled outcomes) — must collapse' })),
      el('div', { class: 'kpi' }, el('b', { text: fmtOdds(DATA.km.odds_median) }), el('span', { text: 'median 12-month launch odds' })));
  }
  function integrity() {
    var g = DATA.integrity;
    return el('div', { class: 'integrity' },
      el('b', { text: 'Integrity: ' }),
      document.createTextNode(g.total + ' protocols counted: ' + g.watchlist + ' watchlist + ' + g.pre_token_below_floor + ' pre-token below the floor + ' + g.pre_token_above_floor_off_watchlist + ' pre-token above the floor but off the watchlist (wrapped, staked, versioned or CEX rule) + ' + g.live_token + ' live-token set aside. ' +
        'Board holds ' + g.board + ' rows (' + g.early + ' early); ' + g.pre_token_below_floor_excluded + ' below-floor pre-token protocols were not picked by the model, ' +
        g.excluded_versioned_or_cex + ' versioned/CEX pre-token rows excluded, ' + g.fit_mcap_zero_or_neg + ' token rows had mcap ≤ 0 and were not fitted, ' +
        g.age_unknown + ' protocols have no listing date. Every row recomputes from lib/model.ts.'));
  }
  function controls() {
    var cats = Array.from(new Set(ROWS.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var sel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    sel.addEventListener('change', function () { state.category = sel.value; writeHash(); render(); });
    var vsel = el('select', { id: 'verdict', 'aria-label': 'Filter by verdict' },
      ['all', 'FARM', 'THIN', 'SKIP'].map(function (v) { return el('option', { value: v, text: v === 'all' ? 'All verdicts' : v, selected: v === state.verdict ? 'selected' : null }); }));
    vsel.addEventListener('change', function () { state.verdict = vsel.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), sel),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), vsel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? filtered().length + ' rows shown' : DATA.live.length + ' live-token protocols' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null));
  }
  function boardTable() {
    var list = sortedRows(filtered());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; writeHash(); render(); } })));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gc, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: fmtOdds(r.odds) }),
        el('td', { class: 'num', text: fmtUsd(r.expected) }),
        el('td', null, el('span', { class: 'verdict ' + r.verdict, text: r.verdict }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, odds and farm plan.' }),
        el('thead', null, el('tr', null,
          sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'),
          sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('implied', 'Implied value'),
          sortHeader('odds', 'Launch odds'), sortHeader('expected', 'Expected'), sortHeader('perhour', 'Verdict'))),
        tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the comparables the model was fitted on.' }),
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
        tbody)));
  }
  function modelPanel() {
    var m = DATA.model, v = DATA.validation;
    var sbOut = el('div', { class: 'sub', id: 'sb-out', text: '' });
    function sbRender() {
      var c = sandboxCoef();
      var top = ROWS.map(function (r) { return { r: r, v: impliedOf(r, c) }; })
        .sort(function (a, b) { return b.v - a.v; }).slice(0, 5);
      sbOut.textContent = 'Sandbox top 5: ' + top.map(function (t, i) { return (i + 1) + '. ' + t.r.name + ' ' + fmtUsd(t.v); }).join(' · ') + '. (Sandbox only — board.json keeps the fitted coefficients.)';
    }
    function sbInput(key, label, val) {
      var inp = el('input', { type: 'number', step: '0.01', value: String(val), 'aria-label': label });
      inp.addEventListener('input', function () { var n = parseFloat(inp.value); if (isFinite(n)) { sandbox[key] = n; sbRender(); } });
      return el('div', { class: 'field' }, el('label', { text: label }), inp);
    }
    var panel = el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed — fitted, not flat' }),
      el('p', { class: 'sub', text: 'log(mcap) = ' + m.intercept + ' + ' + m.b_tvl + '·log(TVL) + ' + m.b_growth + '·growth + ' + m.b_age + '·log(age) + category effects, fitted by ridge least squares on the ' + m.n_fit + ' protocols in this snapshot whose market cap is positive. Growth is winsorised to −60%..+120%. No protocol name is special-cased; change the snapshot and every coefficient moves.' }),
      el('div', { class: 'formula', text: 'implied = round(exp(prediction) × smear ' + m.smear + ') · expected = implied × launch odds (Kaplan-Meier, 12-month horizon, TVL-tercile factor)' }),
      el('div', { class: 'valgrid' },
        el('div', { class: 'val' }, el('b', { text: 'R² ' + m.r2 }), el('span', { text: 'in-sample fit (log scale)' })),
        el('div', { class: 'val' }, el('b', { text: v.loo_med_multiple + '×' }), el('span', { text: 'leave-one-out median error; LOCO worst ' + v.loco_med_multiple + '× (' + v.loco_worst_cat + ' ' + v.loco_worst_med_multiple + '×)' })),
        el('div', { class: 'val' }, el('b', { text: v.wf_med_multiple + '×' }), el('span', { text: 'walk-forward: trained on oldest 70%, tested on newest 30% (n=' + v.wf_n_test + ')' })),
        el('div', { class: 'val' }, el('b', { text: 'slope ' + v.boot_slope_p10 + '–' + v.boot_slope_p90 }), el('span', { text: 'bootstrap P10–P90, 200 resamples; placebo R² ' + v.placebo_r2 + ' when outcomes are shuffled' }))),
      el('h3', { text: 'Model sandbox — change a coefficient, watch the top 5 move' }),
      el('div', { class: 'sandbox' },
        sbInput('bTvl', 'TVL elasticity', m.b_tvl),
        sbInput('bGrowth', 'Growth coefficient', m.b_growth),
        sbInput('bAge', 'Age coefficient', m.b_age),
        el('button', { class: 'button', type: 'button', text: 'Reset to fitted', onclick: function () { sandbox.bTvl = m.b_tvl; sandbox.bGrowth = m.b_growth; sandbox.bAge = m.b_age; render(); } })),
      sbOut,
      el('p', { class: 'sub', text: 'Gas assumptions (stated, not hidden): $1 per transaction on cheap chains (Base, Arbitrum, Optimism, Solana, Polygon, zkSync Era, Linea, Blast, Scroll, Mode, Sonic, Berachain, Unichain), $5 elsewhere; 10 transactions over 8 weeks; 3.5 hours of work. A small farmer is assumed to capture 0.002% of expected value if a token launches, capped at $800 — airdrops are shared across thousands of farmers, so one small position never scales linearly with a $500M valuation. Verdict FARM at $20+/hour, THIN at $5+/hour, else SKIP. Break-even deposit: gas ÷ 2%. Minimum capital: gas ÷ 5% of deposit.' }),
      el('p', { class: 'sub', text: '“Records no token” means the snapshot records no token — it is not proof a protocol has none. Live-token protocols are the comparables, never board rows.' }));
    sbRender();
    return panel;
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = ROWS.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedOf(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · records no token' })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Implied value (P10–P90)' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) + ' (' + fmtUsd(row.lo) + '–' + fmtUsd(row.hi) + ')' })),
        el('div', null, el('span', { text: 'Launch odds, next 12 months' }), el('b', { class: 'num', text: fmtOdds(row.odds) })),
        el('div', null, el('span', { text: 'Expected value' }), el('b', { class: 'num', text: fmtUsd(row.expected) }))),
      el('p', { class: 'sub', text: 'The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board — the data would be stale.') + ' Odds come from Kaplan-Meier survival over all 758 protocols: a protocol that has survived this long without a token launches with this probability in the next year. This is an estimate, not a price.' })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm economics — ' + row.verdict }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Suggested capital' }), el('b', { class: 'num', text: fmtUsd(row.capital) })),
        el('div', null, el('span', { text: 'Gas, 10 tx over 8 weeks' }), el('b', { class: 'num', text: fmtUsd(row.gas) })),
        el('div', null, el('span', { text: 'Time' }), el('b', { class: 'num', text: row.hours + ' hours' })),
        el('div', null, el('span', { text: 'Expected payoff' }), el('b', { class: 'num', text: fmtUsd(row.payoff) })),
        el('div', null, el('span', { text: '$ per hour' }), el('b', { class: 'num', text: '$' + row.perHour.toFixed(2) })),
        el('div', null, el('span', { text: 'Break-even deposit' }), el('b', { class: 'num', text: fmtUsd(row.breakeven) })),
        el('div', null, el('span', { text: 'Minimum capital' }), el('b', { class: 'num', text: fmtUsd(row.minCap) })))));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(kpis());
    shell.appendChild(integrity());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
