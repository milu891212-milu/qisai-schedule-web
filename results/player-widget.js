/* ==========================================================================
   海峰成績系統 — 個人成績小工具（給其他網站嵌入用）

   用法（對方網頁只要兩行）：
     <div id="myResults"></div>
     <script src="https://milu891212-milu.github.io/qisai-schedule-web/results/player-widget.js"></script>
     <script>HaifongResults.render('#myResults', '賴均輔');</script>
   畫面＝今年度 局數/勝敗/勝率＋今年每一局，最下面一顆「完整成績」按鈕連到成績系統（?player=姓名）。
   選項：{ year: 2025（預設今年）, limit: 10（只列最近幾局，預設全列、超過高度可捲動）, maxHeight: '420px' }

   只要資料、自己畫畫面：
     HaifongResults.player('賴均輔').then(function (r) { ... });
     r = { name, rank, total:{n,win,loss,rate,bn,bwin,wn,wwin}, years:[{year, ...同total}], games:[...] }
     games 每局 = { year, date, c1, c2, event, stage, black, white, winner, margin, color('黑'/'白'), opponent, won }

   升段進度（2026-11-02 新增）：
     HaifongResults.renderDan('#myDan', '賴均輔')       現成畫面：目前段位、升X段還差幾勝、進度條
     HaifongResults.dan('賴均輔').then(function (d) { ... })   只要資料（欄位見 danProgress 說明）

   資料直接讀成績系統的公開資料（Firestore 公開唯讀），不需要登入、不需要金鑰。
   算法跟成績系統查詢頁一樣：勝方欄＝這位棋士才算勝，其他都算敗。
   ========================================================================== */
(function () {
  'use strict';

  var BASE = 'https://firestore.googleapis.com/v1/projects/test-5cfc9/databases/(default)/documents/results';
  var SITE = 'https://milu891212-milu.github.io/qisai-schedule-web/results/';
  var CACHE_KEY = 'haifong-results-widget-v1';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim(); }
  function getJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('成績資料 HTTP ' + r.status);
      return r.json();
    });
  }
  function dateNum(g) {
    var m = String(g.d).match(/^(\d{1,2})\.(\d{1,2})$/);
    return m ? Number(g.y) * 10000 + Number(m[1]) * 100 + Number(m[2]) : Number(g.y) * 10000;
  }

  /* ---- 讀全部對局：先看 meta 的版本，沒變就用瀏覽器裡的快取 ---- */
  var loading = null;
  function loadAll() {
    if (loading) return loading;
    loading = getJson(BASE + '/meta').then(function (meta) {
      var version = meta.fields && meta.fields.version
        ? String(meta.fields.version.integerValue || meta.fields.version.doubleValue || meta.fields.version.stringValue)
        : '';
      try {
        var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (c && c.version === version && c.games) return c;
      } catch (e) {}
      return listAll('').then(function (docs) {
        var games = [], dan = {};
        docs.forEach(function (doc) {
          var id = doc.name.split('/').pop(), f = doc.fields || {};
          if (/^y\d{4}$/.test(id)) {
            var year = f.year ? (f.year.stringValue || f.year.integerValue) : id.slice(1);
            JSON.parse((f.rows && f.rows.stringValue) || '[]').forEach(function (r) {
              games.push({ y: String(year), d: r[0] || '', c1: r[1] || '', c2: r[2] || '', ev: r[3] || '',
                           st: r[4] || '', b: r[5] || '', w: r[6] || '', win: r[7] || '', mv: r[8] || '' });
            });
          } else if (id === 'danPlayers' && f.players) {
            dan = danMap(f.players);
          }
        });
        var c = { version: version, games: games, dan: dan };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {}
        return c;
      });
    });
    loading.catch(function () { loading = null; });
    return loading;
  }
  function listAll(token) {
    return getJson(BASE + '?pageSize=50' + (token ? '&pageToken=' + encodeURIComponent(token) : ''))
      .then(function (res) {
        var docs = res.documents || [];
        return res.nextPageToken ? listAll(res.nextPageToken).then(function (more) { return docs.concat(more); }) : docs;
      });
  }
  /* 段位資料是 JSON 字串：[[姓名, 目前段位, 結算日期, 勝場], …]；只取 姓名→目前段位 */
  function danMap(v) {
    var list = [], m = {};
    try { list = JSON.parse(v.stringValue || '[]'); } catch (e) {}
    list.forEach(function (r) { if (r && r[0]) m[norm(r[0])] = r[1] || ''; });
    return m;
  }

  function newStat() { return { n: 0, win: 0, loss: 0, rate: 0, bn: 0, bwin: 0, wn: 0, wwin: 0 }; }
  function addStat(s, g) {
    s.n++; if (g.won) s.win++;
    if (g.color === '黑') { s.bn++; if (g.won) s.bwin++; } else { s.wn++; if (g.won) s.wwin++; }
  }
  function finish(s) { s.loss = s.n - s.win; s.rate = s.n ? s.win / s.n : 0; return s; }

  /* ---- 某位棋士的成績 ---- */
  function player(name, opts) {
    opts = opts || {};
    var p = norm(name);
    return loadAll().then(function (data) {
      var games = data.games.filter(function (g) {
        if (norm(g.b) !== p && norm(g.w) !== p) return false;
        if (opts.year && g.y !== String(opts.year)) return false;
        if (opts.excludeFriendly && g.c2 === '交流') return false;
        return true;
      }).sort(function (a, b) { return dateNum(b) - dateNum(a); }).map(function (g) {
        var isB = norm(g.b) === p;
        return { year: g.y, date: g.d, c1: g.c1, c2: g.c2, event: g.ev, stage: g.st,
                 black: g.b, white: g.w, winner: g.win, margin: g.mv,
                 color: isB ? '黑' : '白', opponent: isB ? g.w : g.b, won: norm(g.win) === p };
      });
      var total = newStat(), byYear = {};
      games.forEach(function (g) {
        addStat(total, g);
        addStat(byYear[g.year] = byYear[g.year] || newStat(), g);
      });
      var years = Object.keys(byYear).sort().reverse().map(function (y) {
        var s = finish(byYear[y]); s.year = y; return s;
      });
      return { name: name, rank: (data.dan || {})[p] || '', total: finish(total), years: years, games: games };
    });
  }

  /* ---- 現成畫面：沿用嵌入網站自己的樣式（官網的 card / tag / btn / muted 與 CSS 變數），
         只列「今年」的對局，詳細資料用按鈕連到成績系統看 ---- */
  function render(target, name, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return Promise.resolve();
    var year = String(opts.year || new Date().getFullYear());
    var link = SITE + '?player=' + encodeURIComponent(name);
    var btn = '<a class="btn btn-ghost btn-sm btn-block mt-2" href="' + esc(link) +
      '" target="_blank" rel="noopener">完整成績（海峰成績系統）→</a>';
    el.innerHTML = '<p class="muted mb-0" style="font-size:.9rem">載入中…</p>';

    return player(name, { year: year }).then(function (r) {
      var s = r.total, games = r.games;
      if (!games.length) {
        el.innerHTML = '<p class="muted mb-0" style="font-size:.9rem">' + year + ' 年目前沒有對局紀錄。</p>' + btn;
        return r;
      }
      var shown = opts.limit ? games.slice(0, opts.limit) : games;
      el.innerHTML =
        '<p class="mb-0" style="font-size:.9rem"><strong style="color:var(--ink)">' + year + ' 年度</strong>　' +
          s.n + ' 局　' + s.win + ' 勝 ' + s.loss + ' 敗　勝率 ' + (s.win * 100 / s.n).toFixed(1) + '%</p>' +
        '<ul style="list-style:none;padding:0;margin:6px 0 0;font-size:.9rem' +
          (opts.limit ? '' : ';max-height:' + (opts.maxHeight || '420px') + ';overflow-y:auto') + '">' +
        shown.map(function (g) {
          return '<li style="padding:9px 0;border-bottom:1px solid var(--line)">' +
            '<strong style="color:var(--ink)">' + esc(g.date.replace('.', '/')) + '</strong>　' +
            (g.won ? '<span class="tag" style="background:var(--good-tint);color:var(--good)">勝</span>'
                   : '<span class="tag">敗</span>') + '<br>' +
            '<span>對手：' + esc(g.opponent) + '（執' + g.color + '）' + (g.margin ? '　' + esc(g.margin) : '') + '</span><br>' +
            '<span class="muted" style="font-size:.84rem">' + esc(g.stage) + (g.stage && g.event ? '　·　' : '') +
              esc(g.event) + '</span></li>';
        }).join('') + '</ul>' +
        (shown.length < games.length
          ? '<p class="muted mb-0" style="font-size:.84rem;margin-top:8px">只列出最近 ' + shown.length + ' 局，今年共 ' + games.length + ' 局。</p>'
          : '') +
        btn;
      return r;
    }).catch(function (err) {
      el.innerHTML = '<p class="muted mb-0" style="font-size:.9rem">成績載入失敗（' + esc(err.message) + '）。</p>' + btn;
    });
  }

  /* ---- 升段進度（2026-11-02）----
     跟成績系統「升段提醒」同一套算法：
       還差幾勝 ＝ 升段需要勝場 －（結算日期已達成的勝場 ＋ 結算日期「之後」到今天（台灣時間）的勝局）
       國內、國際、正式、限制都算；交流賽不算。
     段位資料 results/danPlayers [[姓名, 目前段位, 結算日期, 已達成勝場]]、升段規則 results/danRules [[段位, 需要勝場]]
     院方隨時會改（升段、改結算日），所以每次都重讀、不快取（兩份都很小）。 */
  var DAN_ORDER = ['初段', '二段', '三段', '四段', '五段', '六段', '七段', '八段', '九段'];
  var DEFAULT_DAN_RULES = [['初段', 20], ['二段', 30], ['三段', 50], ['四段', 60], ['五段', 70], ['六段', 100], ['七段', 110], ['八段', 120], ['九段', 150]];
  function getDoc(id) {
    return fetch(BASE + '/' + id, { cache: 'no-cache' }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('段位資料 HTTP ' + r.status);
      return r.json();
    });
  }
  function jsonField(doc, key) {
    try { return JSON.parse((doc && doc.fields && doc.fields[key] && doc.fields[key].stringValue) || 'null'); } catch (e) { return null; }
  }
  function dateStrNum(s) {
    var m = String(s).match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
  }
  function numDateStr(n) { n = String(n); return n.slice(0, 4) + '-' + n.slice(4, 6) + '-' + n.slice(6, 8); }
  function todayNum() {
    var t = new Date(Date.now() + 8 * 3600000);   /* 台灣時間 */
    return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  }

  function danProgress(name) {
    var p = norm(name);
    return Promise.all([loadAll(), getDoc('danPlayers'), getDoc('danRules')]).then(function (res) {
      var data = res[0];
      var players = jsonField(res[1], 'players') || [];
      var rules = jsonField(res[2], 'rules') || DEFAULT_DAN_RULES;
      var row = players.filter(function (r) { return r && norm(r[0]) === p; })[0];
      if (!row) return null;
      var dan = row[1] || '', base = dateStrNum(row[2]), baseWins = Number(row[3]) || 0, until = todayNum();
      var ruleRow = rules.filter(function (x) { return x[0] === dan; })[0];
      var need = ruleRow ? Number(ruleRow[1]) : null;
      var idx = DAN_ORDER.indexOf(dan);
      var wins = data.games.filter(function (g) {
        return norm(g.win) === p && g.c2 !== '交流' && dateNum(g) > base && dateNum(g) <= until;
      }).sort(function (a, b) { return dateNum(a) - dateNum(b); }).map(function (g, k) {
        var isB = norm(g.b) === p;
        return { no: baseWins + k + 1, year: g.y, date: g.d, event: g.ev, stage: g.st,
                 opponent: isB ? g.w : g.b, color: isB ? '黑' : '白', margin: g.mv };
      });
      var total = baseWins + wins.length;
      var remaining = need == null ? null : need - total;
      var reachGame = (need != null && baseWins < need && total >= need) ? wins[need - baseWins - 1] : null;
      return {
        name: row[0], dan: dan,
        nextDan: idx >= 0 && idx < DAN_ORDER.length - 1 ? DAN_ORDER[idx + 1] : null,
        need: need, settleDate: base ? numDateStr(base) : '', baseWins: baseWins,
        winsSince: wins.length, total: total, remaining: remaining,
        reached: remaining != null && remaining <= 0, reachGame: reachGame,
        asOf: numDateStr(until), wins: wins
      };
    });
  }

  /* 現成畫面（同樣只用嵌入網站的 class 與 CSS 變數） */
  function renderDan(target, name) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return Promise.resolve();
    el.innerHTML = '<p class="muted mb-0" style="font-size:.9rem">載入中…</p>';
    return danProgress(name).then(function (d) {
      if (!d) { el.innerHTML = '<p class="muted mb-0" style="font-size:.9rem">段位資料裡沒有這位棋士。</p>'; return d; }
      var slash = function (s) { return String(s).replace(/-/g, '/'); };
      var h = '<p class="mb-0" style="font-size:.9rem">目前段位　<strong style="color:var(--ink)">' + esc(d.dan) + '</strong></p>';
      if (!d.nextDan || d.need == null) {
        h += '<p class="muted mb-0" style="font-size:.84rem;margin-top:6px">' + (d.nextDan ? '升段規則沒有設定這個段位。' : '已是最高段位。') + '</p>';
      } else {
        var pct = Math.max(0, Math.min(100, Math.round(d.total * 100 / d.need)));
        h += '<p class="mb-0" style="font-size:1.05rem;margin-top:6px"><strong style="color:var(--ink)">' +
          (d.reached ? '已達升' + esc(d.nextDan) + '標準' : '升' + esc(d.nextDan) + '還差 ' + d.remaining + ' 勝') + '</strong></p>' +
          '<div style="height:8px;background:var(--line);border-radius:4px;margin:8px 0 4px;overflow:hidden">' +
            '<div style="height:100%;width:' + pct + '%;background:var(--good)"></div></div>' +
          '<p class="muted mb-0" style="font-size:.84rem">累積 ' + d.total + '／' + d.need + ' 勝（結算日 ' + slash(d.settleDate) + ' 已 ' + d.baseWins +
            ' 勝，之後又贏 ' + d.winsSince + ' 局；算到 ' + slash(d.asOf) + '，交流賽不算）</p>' +
          (d.reached ? '<p class="muted mb-0" style="font-size:.84rem;margin-top:4px">升段以院方公告為準。</p>' : '');
      }
      el.innerHTML = h;
      return d;
    }).catch(function (err) {
      el.innerHTML = '<p class="muted mb-0" style="font-size:.9rem">升段進度載入失敗（' + esc(err.message) + '）。</p>';
    });
  }

  window.HaifongResults = { load: loadAll, player: player, render: render, dan: danProgress, renderDan: renderDan };
})();
