export const adminOpsScript = `
(function () {
  'use strict';
  var App = window.__dispatchAdmin;
  if (!App) return;
  var state = App.state;
  var views = App.views;
  var esc = App.esc;
  var moneyText = App.moneyText;
  var moneyHtml = App.moneyHtml;
  var fmtDay = App.fmtDay;
  var fmtTime = App.fmtTime;
  var toast = App.toast;
  var copyText = App.copyText;
  var api = App.api;
  var openModal = App.openModal;
  var loadMaterialUrl = App.loadMaterialUrl;
  var openLightbox = App.openLightbox;

  var el = function (id) { return document.getElementById(id); };
  var viewRoot = function () { return el('view'); };
  var str = function (value) { return value === null || value === undefined ? '' : String(value); };
  var num = function (value) { var parsed = Number(value); return isFinite(parsed) ? parsed : 0; };
  var pad2 = function (value) { return value < 10 ? '0' + value : String(value); };
  var clock = function (iso) {
    var date = new Date(iso);
    return isNaN(date.getTime()) ? '' : pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  };
  var current = function () { return App.currentAccount(); };
  var isCurrent = function (section, accountId) {
    return Boolean(state.token) && state.section === section && (!accountId || state.accountId === accountId);
  };

  var badge = function (label, tone) {
    return '<span class="badge ' + (tone || 'neutral') + '">' + esc(label) + '</span>';
  };
  var notice = function (text, warn) {
    return '<div class="notice' + (warn ? ' warn' : '') + '">' + esc(text) + '</div>';
  };
  var loading = function (text) {
    return App.loadingCard ? App.loadingCard(text) : '<div class="loading-card"><span class="spinner"></span>' + esc(text || '正在加载…') + '</div>';
  };
  var emptyCard = function (title, text, nav, action) {
    return '<div class="empty-card"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' +
      (nav ? '<button type="button" class="btn btn-primary" data-nav="' + esc(nav) + '">' + esc(action || '去看看') + '</button>' : '') +
      '</div>';
  };
  var pageHead = function (title, description, tag) {
    return '<div class="page-head"><div><h1>' + esc(title) + '</h1><p>' + esc(description) + '</p></div>' +
      (tag ? '<div class="page-tag">' + tag + '</div>' : '') + '</div>';
  };
  var metric = function (label, valueHtml, note) {
    return '<div class="metric"><span class="metric-label">' + esc(label) + '</span>' +
      '<div class="metric-value">' + valueHtml + '</div>' +
      (note ? '<span class="metric-note">' + esc(note) + '</span>' : '') + '</div>';
  };
  var moneyCell = function (cents, pendingCount) {
    var pending = num(pendingCount);
    if (cents === null || cents === undefined || (num(cents) === 0 && pending > 0)) {
      return '<span class="badge warn">待补价</span>';
    }
    return '<span class="money">' + moneyText(cents) + '</span>' +
      (pending ? '<span class="sub-warn">' + pending + ' 项待补价</span>' : '');
  };

  var stageInfo = function (pulse) {
    var stores = num(pulse.storeCount);
    var delivered = num(pulse.deliveredCount);
    if (pulse.stage === 'draft') return { text: '晚间录单中', tone: 'info' };
    if (pulse.stage === 'all_delivered') return { text: '本趟已全部送达', tone: 'ok' };
    return { text: '送货进行中 ' + delivered + '/' + stores + ' 家', tone: 'warn' };
  };
  var light = function (tone, label, detail) {
    return '<div class="light ' + tone + '"><span class="light-dot"></span><div><b>' + esc(label) + '</b>' +
      '<span>' + esc(detail) + '</span></div></div>';
  };
  var lightsHtml = function (system) {
    var data = system || {};
    var database = data.database && data.database.reachable === true;
    var wechat = data.wechat || {};
    var models = data.models || {};
    var labels = { text: '文本模型', image: '识图模型', voice: '语音模型', agent: '助手模型' };
    var html = '<div class="light-grid">' +
      light(database ? 'on' : 'bad', '数据库', database ? '连通正常' : '连接异常') +
      light(wechat.configured ? 'on' : 'off', '微信登录', wechat.configured ? '已配置' : '未配置') +
      light(wechat.requireActivation ? 'on' : 'off', '开通码门禁', wechat.requireActivation ? '已开启' : '未开启');
    ['text', 'image', 'voice', 'agent'].forEach(function (key) {
      var model = models[key] || {};
      html += light(model.configured ? 'on' : 'off', labels[key], model.configured ? (model.name || '已配置') : '未配置');
    });
    return html + '</div>';
  };

  /* ============ 模块 1：首页总览 ============ */

  var loadDashboard = function () {
    var account = current();
    var root = viewRoot();
    if (!account) {
      root.innerHTML = emptyCard('还没有配送员账号',
        '先到「账号与开通」生成一次性开通码，配送员用微信开通后就会出现在这里。', 'accounts', '去账号与开通');
      return;
    }
    var accountId = account.id;
    state.dashboard = null;
    root.innerHTML = loading('正在汇总 ' + App.accountLabel(account) + ' 的业务脉搏…');
    var status = state.systemStatus ? Promise.resolve(state.systemStatus) : api('/system/status');
    Promise.all([api('/accounts/' + encodeURIComponent(accountId) + '/dashboard'), status]).then(function (results) {
      if (!isCurrent('dashboard', accountId)) return;
      state.dashboard = results[0];
      state.systemStatus = results[1];
      App.updateNavBadges();
      renderDashboard();
    }, function (error) {
      if (isCurrent('dashboard', accountId)) root.innerHTML = App.errorCard(error.message);
    });
  };

  var renderDashboard = function () {
    var account = current();
    var data = state.dashboard;
    var root = viewRoot();
    if (!account || !data) { loadDashboard(); return; }
    var pulse = data.pulse || {};
    var todos = data.todos || {};
    var ai = data.ai7d || {};
    var stage = stageInfo(pulse);
    var name = account.remarkName && account.remarkName.trim() ? account.remarkName.trim() : App.accountLabel(account);
    var amountLabel = '预计应收';
    var pendingCount = num(pulse.pendingPriceCount);
    var lastActive = pulse.lastActiveAt ? fmtTime(pulse.lastActiveAt) : '暂无活跃记录';
    var html = pageHead('首页总览', '3 秒看清这趟业务、待处理维护项和 AI 运行状态。', badge('只读总览', 'info'));
    html += '<div class="dashboard-grid">';

    html += '<section class="card">' +
      '<div class="card-head"><div><span class="section-kicker">当前业务脉搏</span><h2>' + esc(name) + '</h2>' +
      (account.disabled ? '<p>' + badge('已停用', 'bad') + '</p>' : '<p>这趟单据与最新活跃情况</p>') + '</div>' +
      '<span class="stage-pill ' + stage.tone + '">' + esc(stage.text) + '</span></div>' +
      '<div class="metric-grid">' +
      metric('门店数', num(pulse.storeCount) + ' 家', '') +
      metric('已送达', num(pulse.deliveredCount) + ' / ' + num(pulse.storeCount) + ' 家', '') +
      metric(amountLabel, moneyHtml(pulse.knownAmountCents, pendingCount),
        pendingCount ? '还有 ' + pendingCount + ' 项缺价，补齐后金额自动更新' : '当下已能算出的金额') +
      metric('待补价', pendingCount ? '<span class="text-amber">' + pendingCount + '</span> 项' : '0 项',
        pendingCount ? '缺价不会算成 ¥0.00' : '价格已齐') +
      metric('最近活跃', esc(lastActive), '') +
      '</div>' +
      '<div class="pulse-progress"><div class="pulse-progress-head"><span>本趟送达进度</span><b>' +
      num(pulse.deliveredCount) + ' / ' + num(pulse.storeCount) + ' 家</b></div>' +
      '<div class="pulse-track"><span style="width:' +
      (num(pulse.storeCount) ? Math.round(num(pulse.deliveredCount) / num(pulse.storeCount) * 100) : 0) +
      '%"></span></div><p class="metric-note">进入「趟次与单据」可查看每家门店明细、冷库取货单和原始对话。</p></div>' +
      '</section>';

    var hit = ai.autoPriceHitRate || {};
    var hitRate = typeof hit.rate === 'number' ? (hit.rate * 100).toFixed(1) + '%' : '暂无记录';
    var hitNote = num(hit.denominator)
      ? num(hit.numerator) + ' / ' + num(hit.denominator) + ' 条明细由库内价或熟客价自动配成'
      : '近 7 天还没有可统计的配价明细';
    var avg = typeof ai.avgElapsedMs === 'number' && isFinite(ai.avgElapsedMs)
      ? (ai.avgElapsedMs / 1000).toFixed(1) + ' 秒' : '暂无记录';
    var cost = typeof ai.estimatedCostYuan === 'number' && isFinite(ai.estimatedCostYuan)
      ? '¥' + ai.estimatedCostYuan.toFixed(2) : '¥0.00';
    var costRates = ai.costRates || data.costRates || {};
    var costNote = costRates.description
      ? '按已记录模型用量估算，不含缓存折扣' : '按已记录模型用量估算';
    html += '<section class="card">' +
      '<div class="card-head"><div><span class="section-kicker">AI 运行体感</span><h2>近 7 天</h2>' +
      '<p>不需要懂技术，也能看出 AI 跑得快不快、配价准不准、大概花了多少钱。</p></div></div>' +
      '<div class="metric-grid">' +
      metric('处理回合', num(ai.turnCount) + ' 轮', '') +
      metric('平均响应', esc(avg), '从收到原话到回复结束') +
      metric('自动配价参考命中率', esc(hitRate), hitNote) +
      metric('近 7 天预估费用', esc(cost), costNote) +
      '</div>' +
      '<div style="margin-top:13px">' + lightsHtml(state.systemStatus) + '</div>' +
      '<p class="metric-note" style="margin-top:9px">' +
      '<span class="help-dot" title="' + esc(costRates.description || costNote) + '">?</span>' +
      ' 费用为估算值，按当前配置的输入/输出单价与已记录用量折算。</p>' +
      '</section>';

    html += '</div>';

    var todoCard = function (kind, count, title, description, action, attrs) {
      return '<button type="button" class="todo-card ' + (count ? 'needs' : 'done') + '" data-nav="' + kind + '" ' + attrs + '>' +
        '<span class="todo-num">' + (count > 99 ? '99+' : count) + '</span>' +
        '<span class="todo-copy"><b>' + esc(title) + '</b><span>' + esc(description) + '</span></span>' +
        '<span class="todo-action">' + esc(action) + ' ›</span></button>';
    };
    html += '<section class="card" style="margin-top:16px">' +
      '<div class="card-head"><div><span class="section-kicker">待处理维护清单</span><h2>需要你动手的 3 件事</h2>' +
      '<p>点一下就能直达对应模块，处理完回首页看数字变化。</p></div></div>' +
      '<div class="todo-grid">' +
      todoCard('catalog', num(todos.missingUnitCount), '缺计价单位的货品',
        '没填单位时 AI 宁可留空也不乱算价，补上单位即可自动配价。', '去补单位', 'data-missing-unit="1"') +
      todoCard('quality', num(todos.attentionTurnCount7d), '近 7 天需关注的 AI 对话',
        '包含出错、中断、没配上价和被撤回的回合。', '去看对话', 'data-filter="attention"') +
      todoCard('mistakes', num(todos.openMistakeCount), '待处理的错题本',
        '已经把 AI 录错的话收进错题本，集中修复更省心。', '去错题本', 'data-status="open"') +
      '</div></section>';
    root.innerHTML = '<div class="view-stage">' + html + '</div>';
  };

  views.dashboard = { mount: function () { loadDashboard(); } };

  /* ============ 模块 2：趟次与单据 ============ */

  var parseYuan = function (value) {
    if (value === null || value === undefined) return null;
    var text = String(value).trim();
    if (!/^\\d+(?:\\.\\d{1,2})?$/.test(text)) return null;
    var parts = text.split('.');
    var whole = parts[0];
    var frac = ((parts[1] || '') + '00').slice(0, 2);
    var cents = Number(whole + frac);
    return Number.isSafeInteger(cents) ? cents : null;
  };
  var draftSummary = function (draft) {
    var stores = 0;
    var known = 0;
    var pending = 0;
    (draft && draft.customers ? draft.customers : []).forEach(function (customer) {
      var items = customer.items || [];
      var meaningful = str(customer.customer).trim() || items.some(function (item) {
        return str(item.product).trim() || str(item.brand).trim() || str(item.specification).trim() || str(item.quantity).trim();
      });
      if (meaningful) stores++;
      items.forEach(function (item) {
        var empty = !str(item.product).trim() && !str(item.brand).trim() && !str(item.specification).trim()
          && !str(item.quantity).trim() && parseYuan(item.price) === null;
        if (empty) return;
        var quantityText = str(item.quantity).trim();
        var quantity = /^[1-9]\\d*$/.test(quantityText) && Number.isSafeInteger(Number(quantityText))
          ? Number(quantityText) : null;
        var price = parseYuan(item.price);
        if (quantity !== null && price !== null && Number.isSafeInteger(quantity * price) && Number.isSafeInteger(known + quantity * price)) {
          known += quantity * price;
        } else pending++;
      });
    });
    return { stores: stores, knownCents: known, pending: pending };
  };
  var tripStatus = function (delivered, customers) {
    if (!customers) return { text: '本趟无门店', tone: 'neutral' };
    if (delivered >= customers) return { text: '本趟已全部送达', tone: 'ok' };
    return { text: '送货进行中 ' + delivered + '/' + customers + ' 家', tone: 'warn' };
  };
  var tripRow = function (id, info, isCurrentRow) {
    var dialogue = info.turns === null || info.turns === undefined
      ? '对话 <span class="muted">见详情</span>' : '对话 <b>' + info.turns + '</b> 轮';
    return '<button type="button" class="trip-row' + (isCurrentRow ? ' current' : '') + '" data-trip-scope="' + esc(id) + '">' +
      '<span class="trip-date"><b>' + esc(info.date) + '</b><span>' + esc(info.time) + '</span></span>' +
      '<span class="trip-status">' + badge(info.status, info.tone) + '</span>' +
      '<span class="trip-metric">门店 <b>' + info.stores + '</b></span>' +
      '<span class="trip-metric">' + moneyCell(info.amountCents, info.pending) + '</span>' +
      '<span class="trip-metric">' + dialogue + '</span>' +
      '<span class="trip-go">查看 ›</span></button>';
  };

  var loadTrips = function () {
    var account = current();
    var root = viewRoot();
    if (!account) {
      root.innerHTML = emptyCard('还没有配送员账号', '先在「账号与开通」生成开通码，配送员开通后就能查他的每一趟。', 'accounts', '去账号与开通');
      return;
    }
    if (state.scopeId) { loadTripDetail(state.scopeId); return; }
    if (state.overview) { renderTripList(); return; }
    var accountId = account.id;
    root.innerHTML = loading('正在读取趟次与单据…');
    api('/accounts/' + encodeURIComponent(accountId) + '/overview').then(function (data) {
      if (!isCurrent('trips', accountId)) return;
      state.overview = data;
      renderTripList();
    }, function (error) {
      if (isCurrent('trips', accountId)) root.innerHTML = App.errorCard(error.message);
    });
  };

  var renderTripList = function () {
    var overview = state.overview;
    var root = viewRoot();
    if (!overview) { loadTrips(); return; }
    var draft = overview.draft || {};
    var summary = draftSummary(draft);
    var history = (overview.trips || []).filter(function (trip) {
      return !(overview.draftConfirmed && trip.id === overview.currentTripId);
    });
    var html = pageHead('趟次与单据', '像翻账本一样查看每一趟。正式单严格只读，不做任何修改。', badge('只读查账', 'info'));
    html += '<section class="card"><div class="card-head"><div><h2>' +
      (overview.draftConfirmed ? '当前本趟' : '当前草稿') + '</h2><p>' +
      (overview.draftConfirmed ? '已经出单，正式单只读' : '还没出单，可回小程序继续录') +
      '</p></div>' +
      '<div class="card-head-side">' + badge(overview.draftConfirmed ? '已出单' : '晚间录单中', overview.draftConfirmed ? 'ok' : 'warn') + '</div></div>' +
      tripRow(draft.id, {
        date: overview.draftConfirmed ? '当前本趟' : '当前草稿',
        time: overview.draftConfirmed ? '已出单' : '录单中',
        status: overview.draftConfirmed ? '已出单' : '晚间录单中',
        tone: overview.draftConfirmed ? 'ok' : 'warn',
        stores: summary.stores,
        amountCents: summary.pending ? (summary.knownCents || 0) : summary.knownCents,
        pending: summary.pending,
        turns: null
      }, true) + '</section>';

    html += '<section class="card"><div class="card-head"><div><h2>历史正式趟</h2>' +
      '<p>共 ' + history.length + ' 趟，按出单时间从新到旧。</p></div></div>';
    if (!history.length) {
      html += notice('还没有历史正式趟。');
    } else {
      history.forEach(function (trip) {
        var status = tripStatus(num(trip.delivered), num(trip.customers));
        html += tripRow(trip.id, {
          date: fmtDay(trip.issuedAt), time: clock(trip.issuedAt),
          status: status.text, tone: status.tone,
          stores: num(trip.customers), amountCents: trip.totalCents,
          pending: trip.pendingPrices, turns: num(trip.turnCount)
        }, false);
      });
    }
    html += '</section>';

    var stale = overview.staleDrafts || [];
    if (stale.length) {
      html += '<details class="soft-details"><summary>更早未出单草稿（' + stale.length + '）</summary>' +
        '<div style="margin-top:10px">' + stale.map(function (item) {
          return '<button type="button" class="trip-row" data-trip-scope="' + esc(item.id) + '">' +
            '<span class="trip-date"><b>更早草稿</b><span>' + esc(fmtTime(item.lastTurnAt)) + '</span></span>' +
            '<span class="trip-status">' + badge('未出单', 'neutral') + '</span>' +
            '<span class="trip-metric">对话 <b>' + num(item.turnCount) + '</b> 轮</span>' +
            '<span class="trip-go">查看 ›</span></button>';
        }).join('') + '</div></details>';
    }
    root.innerHTML = '<div class="view-stage">' + html + '</div>';
  };

  var loadTripDetail = function (scopeId) {
    var account = current();
    var root = viewRoot();
    if (!account) { loadTrips(); return; }
    var accountId = account.id;
    state.scopeId = scopeId;
    state.scope = null;
    root.innerHTML = loading('正在读取这一趟的完整单据…');
    api('/accounts/' + encodeURIComponent(accountId) + '/scopes/' + encodeURIComponent(scopeId)).then(function (data) {
      if (!isCurrent('trips', accountId) || state.scopeId !== scopeId) return;
      state.scope = data;
      state.tripTab = 'sheets';
      renderTripDetail();
    }, function (error) {
      if (isCurrent('trips', accountId)) {
        state.scopeId = '';
        root.innerHTML = App.errorCard(error.message);
      }
    });
  };

  var draftPicking = function (document) {
    var entries = {};
    var order = [];
    (document.customers || []).forEach(function (customer) {
      (customer.lines || []).forEach(function (line) {
        if (line.blank || !str(line.product).trim()) return;
        var key = [line.product, line.brand, line.specification, line.unit].map(function (part) { return str(part).trim(); }).join('\\u0000');
        if (!entries[key]) {
          entries[key] = { product: line.product, brand: line.brand, specification: line.specification,
            unit: line.unit, quantity: 0 };
          order.push(key);
        }
        entries[key].quantity += num(line.originalQuantity);
      });
    });
    return order.map(function (key) { return entries[key]; });
  };

  var sheetsHtml = function (document) {
    if (document.stale) return notice('这是一份已经离开当前工作区的旧草稿，只剩对话可查，单据明细已不在。');
    if (!(document.customers || []).length) return notice('这趟还没有门店单。');
    var priceSourceLabel = { spoken: '原话价', customer_history: '熟客价', catalog: '库内价', manual: '手改价' };
    var lineStatusLabel = { delivered: '已送达', pending: '待送', unrecorded: '未记录', draft: '录单中' };
    return document.customers.map(function (customer) {
      var isTrip = document.type === 'trip';
      var statusBadges = '';
      if (customer.locked) statusBadges += badge('已锁定', 'ok');
      if (customer.deliveryCompleted) statusBadges += badge('已送达', 'ok');
      else if (isTrip) statusBadges += badge('待送', 'neutral');
      else statusBadges += badge('录单中', 'neutral');
      var headMoney = isTrip
        ? '<span>原订 ' + moneyCell(customer.orderCents, customer.orderPendingPrices) + '</span>' +
          '<span>预计应收 <b>' + moneyCell(customer.dueCents, customer.pendingPrices) + '</b></span>'
        : '<span>预计合计 <b>' + moneyCell(customer.dueCents, customer.pendingPrices) + '</b></span>';
      var rows = (customer.lines || []).map(function (line) {
        var name = [line.brand, line.product, line.specification].filter(Boolean).join(' / ') || '（空行）';
        if (line.blank) {
          return '<tr><td class="muted">（空行）</td><td class="num">—</td><td class="num">—</td>' +
            '<td class="num">—</td><td class="num">—</td><td class="muted">—</td></tr>';
        }
        var unitSuffix = line.unit ? ' ' + esc(line.unit) : '';
        var original = esc(line.originalQuantity || '—') + unitSuffix;
        var received = line.receivedQuantity === null || line.receivedQuantity === undefined
          ? '<span class="muted">—</span>' : esc(line.receivedQuantity) + unitSuffix;
        var unitPrice;
        var source = '';
        if (line.invalidPrice !== undefined) {
          unitPrice = badge('价格异常', 'bad');
          source = badge('需重填', 'bad');
        } else if (line.unitPriceCents === null || line.unitPriceCents === undefined) {
          unitPrice = badge('待补价', 'warn');
        } else {
          unitPrice = '<span class="money">' + moneyText(line.unitPriceCents) + '</span>';
        }
        var amount = line.amountCents === null || line.amountCents === undefined
          ? badge('待补价', 'warn') : '<span class="money">' + moneyText(line.amountCents) + '</span>';
        if (isTrip) {
          source += badge(lineStatusLabel[line.status] || '已记录', line.status === 'delivered' ? 'ok' : 'neutral');
        } else {
          if (line.priceSource) source += badge(priceSourceLabel[line.priceSource] || '手改价', 'info');
          else if (line.unitPriceCents === null || line.unitPriceCents === undefined) source += badge('待补价', 'warn');
          else source += badge('手改价', 'info');
          if (line.catalogStatus === 'discontinued') source += badge('已下架', 'warn');
        }
        var hint = !isTrip && line.priceHint ? '<span class="line-sub">' + esc(line.priceHint) + '</span>' : '';
        return '<tr><td><span class="cell-main">' + esc(name) + '</span>' + hint + '</td>' +
          '<td class="num">' + original + '</td><td class="num">' + received + '</td>' +
          '<td class="num">' + unitPrice + '</td><td class="num">' + amount + '</td>' +
          '<td><span class="line-tag">' + source + '</span></td></tr>';
      }).join('');
      return '<article class="customer-card"><div class="customer-head"><h3>' +
        esc(customer.customer || '（未命名门店）') + '</h3><span class="line-tag">' + statusBadges + '</span></div>' +
        '<div class="customer-money">' + headMoney + '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>品名 / 品牌规格</th><th class="num">原订</th>' +
        '<th class="num">实收</th><th class="num">单价</th><th class="num">小计</th><th>来源 / 状态</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div></article>';
    }).join('');
  };

  var pickingHtml = function (document) {
    var rows = document.type === 'draft' ? draftPicking(document) : (document.picking || []);
    if (!rows.length) return notice(document.stale ? '旧草稿的取货明细已不在当前工作区。' : '这趟还没有可汇总的取货货品。');
    var boxItems = 0;
    var body = rows.map(function (row) {
      var unit = str(row.unit).trim();
      var isBox = unit.indexOf('箱') >= 0;
      if (isBox) boxItems++;
      return '<div class="picking-item"><div class="picking-name"><b>' + esc(row.product || '（未命名货品）') + '</b>' +
        '<span>' + esc([row.brand, row.specification].filter(Boolean).join(' · ') || '—') + '</span></div>' +
        '<div class="picking-qty ' + (isBox ? 'is-box' : 'is-other') + '"><b>' + esc(row.quantity) + '</b>' +
        '<span>' + esc(unit || '件') + '</span></div></div>';
    }).join('');
    return '<div class="picking-summary">共 ' + rows.length + ' 个品项 · ' + boxItems + ' 个箱装。浅绿底为「箱」，灰色底为袋 / 盒 / 包 / 其他。</div>' +
      '<div class="picking-grid">' + body + '</div>';
  };

  var chatHtml = function (turns) {
    if (!turns.length) return notice('这一趟还没有对话记录。');
    var html = '<div class="chat-note">微信风原始对话。图片点开可看大图；技术日志统一收进「对话质检」，不混在这里。</div><div class="chat-panel">';
    turns.forEach(function (turn) {
      var scopeId = state.scopeId;
      html += '<div class="chat-day">' + esc(fmtTime(turn.createdAt)) + '</div>';
      html += '<div class="chat-row user"><span class="chat-avatar">配送</span><div class="chat-bubble">';
      if (str(turn.userText).trim()) html += '<div class="chat-text">' + esc(turn.userText) + '</div>';
      else html += '<div class="chat-text muted">（这一轮没有留下文字）</div>';
      var materials = turn.materials || [];
      if (materials.length) {
        html += '<div class="chat-thumbs">' + materials.map(function (material) {
          return '<span class="chat-thumb" data-material-id="' + esc(material.id) + '" data-material-name="' +
            esc(material.name || '原图') + '">图片加载中…</span>';
        }).join('') + '</div>';
      }
      html += '<button type="button" class="chat-jump" data-quality-turn="' + esc(turn.id) +
        '" data-quality-scope="' + esc(scopeId) + '">排查这一句 ›</button></div></div>';
      html += '<div class="chat-row assistant"><span class="chat-avatar">AI</span><div class="chat-bubble">' +
        '<div class="chat-text">' + esc(turn.assistantText || '（这一轮没有助手回复）') + '</div>' +
        '<button type="button" class="chat-jump" data-quality-turn="' + esc(turn.id) +
        '" data-quality-scope="' + esc(scopeId) + '">排查这一句 ›</button></div></div>';
    });
    return html + '</div>';
  };

  var loadChatThumbs = function () {
    var accountId = state.accountId;
    var nodes = document.querySelectorAll('[data-material-id]');
    Array.prototype.forEach.call(nodes, function (node) {
      var id = node.getAttribute('data-material-id');
      var name = node.getAttribute('data-material-name') || '原图';
      loadMaterialUrl(accountId, id).then(function (url) {
        if (state.accountId !== accountId) return;
        node.innerHTML = '';
        var image = document.createElement('img');
        image.src = url;
        image.alt = name;
        image.loading = 'lazy';
        image.addEventListener('click', function () { openLightbox(url, name); });
        node.appendChild(image);
      }, function (error) {
        node.textContent = error && error.message ? error.message : '图片加载失败';
      });
    });
  };

  var renderTripDetail = function () {
    var scope = state.scope;
    var root = viewRoot();
    if (!scope) { loadTrips(); return; }
    var document = scope.document || {};
    var turns = scope.turns || [];
    var isTrip = document.type === 'trip';
    var title = document.stale ? '更早未出单草稿' : isTrip ? '正式趟 · 只读' : (document.draftConfirmed ? '当前本趟 · 已出单' : '当前草稿 · 录单中');
    var dateText = isTrip && document.issuedAt ? fmtTime(document.issuedAt) : '尚未出单';
    var pickingRows = isTrip ? (document.picking || []) : draftPicking(document);
    var html = '<button type="button" class="back-link" data-trip-back="1">‹ 返回全部趟次</button>';
    html += pageHead(title, dateText, badge(isTrip ? '正式单严格只读' : '草稿只读查看', isTrip ? 'ok' : 'info'));
    html += '<section class="card trip-hero"><div class="metric-grid">' +
      metric('门店数', num((document.customers || []).length) + ' 家', '') +
      metric('预计应收', moneyHtml(document.dueCents, document.pendingPrices),
        num(document.pendingPrices) ? '缺价按「待补价」如实显示' : '金额已齐') +
      metric('待补价', num(document.pendingPrices) + ' 项', '') +
      metric('对话', turns.length + ' 轮', '') +
      '</div></section>';
    html += '<div class="seg-tabs">' +
      '<button type="button" class="seg-tab ' + (state.tripTab === 'sheets' ? 'active' : '') + '" data-trip-tab="sheets">送货单<span>' +
      num((document.customers || []).length) + ' 家</span></button>' +
      '<button type="button" class="seg-tab ' + (state.tripTab === 'picking' ? 'active' : '') + '" data-trip-tab="picking">冷库取货单<span>' +
      pickingRows.length + ' 项</span></button>' +
      '<button type="button" class="seg-tab ' + (state.tripTab === 'chat' ? 'active' : '') + '" data-trip-tab="chat">原始对话与原图<span>' +
      turns.length + ' 轮</span></button></div>';
    var body = state.tripTab === 'picking' ? pickingHtml(document)
      : state.tripTab === 'chat' ? chatHtml(turns) : sheetsHtml(document);
    html += '<section class="card view-stage" id="tripTabPanel">' + body + '</section>';
    root.innerHTML = '<div class="view-stage">' + html + '</div>';
    if (state.tripTab === 'chat') loadChatThumbs();
  };

  var switchTripTab = function (nextTab) {
    if (!state.scope || state.tripTab === nextTab) return;
    state.tripTab = nextTab;
    var panel = el('tripTabPanel');
    if (!panel) { renderTripDetail(); return; }
    Array.prototype.forEach.call(document.querySelectorAll('[data-trip-tab]'), function (node) {
      node.classList.toggle('active', node.getAttribute('data-trip-tab') === nextTab);
    });
    var documentData = state.scope.document || {};
    var turns = state.scope.turns || [];
    panel.innerHTML = nextTab === 'picking' ? pickingHtml(documentData)
      : nextTab === 'chat' ? chatHtml(turns) : sheetsHtml(documentData);
    panel.classList.remove('view-stage');
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(function () { panel.classList.add('view-stage'); });
    } else {
      panel.classList.add('view-stage');
    }
    if (nextTab === 'chat') loadChatThumbs();
  };

  views.trips = { mount: function () { loadTrips(); } };

  /* ============ 模块 6：账号与开通 ============ */

  var showCodeModal = function (code, record) {
    var remark = record && record.remarkName ? record.remarkName : '这位配送员';
    openModal({
      title: '一次性开通码已生成',
      bodyHtml: '<p>把下面的开通码发给 <b>' + esc(remark) + '</b>，让他在小程序首次打开时输入一次，之后永久免输。</p>' +
        '<div class="code-display">' + esc(code) + '</div>' +
        '<div class="code-actions"><button type="button" class="btn btn-secondary" data-copy-code="' + esc(code) + '">复制发微信</button></div>' +
        '<p class="modal-note">此开通码只展示这一次。如果没有保存，可以在下方开通码列表对这张「未使用」的码点「作废并重发」。</p>',
      confirmText: '我已保存',
      confirmTone: 'primary',
      onConfirm: function () { return true; }
    });
  };

  var loadAccountsPage = function () {
    var root = viewRoot();
    root.innerHTML = loading('正在读取账号、开通码与系统状态…');
    var status = state.systemStatus ? Promise.resolve(state.systemStatus) : api('/system/status');
    Promise.all([api('/accounts'), api('/activation-codes'), status]).then(function (results) {
      if (!isCurrent('accounts')) return;
      state.accounts = results[0] && Array.isArray(results[0].accounts) ? results[0].accounts : [];
      state.activationCodes = results[1];
      state.systemStatus = results[2];
      App.renderAccountSelect();
      App.updateNavBadges();
      renderAccountsPage();
    }, function (error) {
      if (isCurrent('accounts')) root.innerHTML = App.errorCard(error.message);
    });
  };

  var codeStatus = {
    unused: { text: '未使用', tone: 'warn' },
    redeemed: { text: '已激活', tone: 'ok' },
    revoked: { text: '已作废', tone: 'neutral' }
  };
  var codeRowsHtml = function (records) {
    var filter = state.codeFilter || 'all';
    var list = (records || []).filter(function (record) { return filter === 'all' || record.status === filter; });
    if (!list.length) return '<tr><td colspan="7" class="table-empty">没有符合条件的开通码。</td></tr>';
    return list.map(function (record) {
      var status = codeStatus[record.status] || { text: record.status || '未知', tone: 'neutral' };
      var actions = record.status === 'unused'
        ? '<div class="row-actions">' +
          '<button type="button" class="btn btn-small" data-code-revoke="' + esc(record.id) +
          '" data-code-remark="' + esc(record.remarkName) + '">作废</button>' +
          '<button type="button" class="btn btn-small btn-danger-outline" data-code-reissue="' + esc(record.id) +
          '" data-code-remark="' + esc(record.remarkName) + '">作废并重发新码</button></div>'
        : '<span class="muted">—</span>';
      return '<tr><td class="mono">' + esc(record.codeHint || '—') + '</td><td>' + esc(record.remarkName) + '</td>' +
        '<td>' + badge(status.text, status.tone) + '</td><td>' + esc(fmtTime(record.createdAt)) + '</td>' +
        '<td>' + esc(record.redeemedAt ? fmtTime(record.redeemedAt) : '—') + '</td>' +
        '<td>' + esc(record.redeemedAccountRemark || '—') + '</td><td>' + actions + '</td></tr>';
    }).join('');
  };

  var accountsRowsHtml = function () {
    if (!state.accounts.length) return '<tr><td colspan="8" class="table-empty">还没有配送员账号。生成一张开通码发给配送员即可。</td></tr>';
    var providerLabel = { wechat: '微信登录', development: '本地开发', trial: '试用登录' };
    return state.accounts.map(function (account) {
      var selected = account.id === state.accountId;
      var name = account.remarkName && account.remarkName.trim() ? account.remarkName.trim() : '未命名配送员';
      var status = account.disabled ? badge('已停用', 'bad') : badge('正常使用', 'ok');
      var last = account.lastActiveAt ? fmtTime(account.lastActiveAt)
        : account.lastTurnAt ? fmtTime(account.lastTurnAt) + '（最近对话）' : '暂无记录';
      var toggle = account.disabled
        ? '<button type="button" class="btn btn-small" data-account-enable="' + esc(account.id) +
          '" data-account-name="' + esc(name) + '">恢复启用</button>'
        : '<button type="button" class="btn btn-small btn-danger-outline" data-account-disable="' + esc(account.id) +
          '" data-account-name="' + esc(name) + '">停用</button>';
      return '<tr class="' + (selected ? 'row-current' : '') + '">' +
        '<td><span class="cell-main">' + esc(name) + '</span>' +
        (selected ? ' ' + badge('当前查看', 'info') : '') + '</td>' +
        '<td>' + esc(providerLabel[account.provider] || '账号登录') +
        '<span class="line-sub mono">' + esc(account.subject || '—') + '</span></td>' +
        '<td>' + status + '</td><td>' + esc(last) + '</td>' +
        '<td class="num">' + num(account.tripCount) + '</td>' +
        '<td class="num">' + num(account.catalogVariantCount) + '</td>' +
        '<td class="num">' + (num(account.openMistakeCount) ? '<span class="text-amber">' + num(account.openMistakeCount) + '</span>' : '0') + '</td>' +
        '<td><div class="row-actions">' +
        '<button type="button" class="btn btn-small" data-account-rename="' + esc(account.id) +
        '" data-account-name="' + esc(name) + '">改备注名</button>' + toggle +
        '<button type="button" class="btn btn-small btn-primary-outline" data-account-switch="' + esc(account.id) +
        '">切换查看</button></div></td></tr>';
    }).join('');
  };

  var renderPrompts = function (body) {
    var prompts = state.prompts || [];
    body.innerHTML = prompts.map(function (entry, index) {
      var blocks = (entry.prompts || []).map(function (prompt) {
        return '<div class="prompt-block"><label>' + esc(prompt.label) + '</label><pre class="prompt-text">' +
          esc(prompt.text) + '</pre></div>';
      }).join('');
      var tools = entry.tools
        ? '<details class="soft-details"><summary>展开工具 Schema</summary><pre class="prompt-text">' +
          esc(JSON.stringify(entry.tools, null, 2)) + '</pre></details>' : '';
      return '<article class="rule-card"><div class="card-head"><div><h3>' + esc(entry.title) + '</h3>' +
        '<p>' + esc(entry.module) + ' · ' + esc(entry.description) + '</p></div>' +
        '<button type="button" class="btn btn-small" data-copy-rule="' + index + '">复制全文</button></div>' +
        blocks + tools + '</article>';
    }).join('');
  };
  var loadPrompts = function () {
    var body = el('aiRulesBody');
    if (!body) return;
    if (state.prompts) { renderPrompts(body); return; }
    body.innerHTML = '<div class="loading-inline">正在读取只读规则…</div>';
    api('/prompts').then(function (data) {
      state.prompts = data && Array.isArray(data.prompts) ? data.prompts : [];
      var target = el('aiRulesBody');
      if (target) renderPrompts(target);
    }, function () {});
  };
  var bindAiRules = function () {
    var details = el('aiRulesDetails');
    if (!details) return;
    details.addEventListener('toggle', function () {
      if (details.open) loadPrompts();
    });
  };

  var renderAccountsPage = function () {
    var root = viewRoot();
    var records = state.activationCodes && Array.isArray(state.activationCodes.records)
      ? state.activationCodes.records : [];
    var system = state.systemStatus || {};
    var html = pageHead('账号与开通', '生成一次性开通码、管理配送员启停，查看系统与 AI 配置。', badge('系统管理', 'info'));
    html += '<section class="card"><div class="card-head"><div><h2>生成一次性开通码</h2>' +
      '<p>填配送员中文备注名，生成一张只展示一次的码，发微信让他开通。</p></div></div>' +
      '<form id="activationForm" class="inline-form"><div class="field grow">' +
      '<label class="field-label" for="activationRemark">配送员中文备注名</label>' +
      '<input id="activationRemark" class="text-input" name="remarkName" maxlength="40" autocomplete="off" placeholder="例如：老张冻品" required>' +
      '<span class="field-hint">必填。用一眼能认出的名字，方便区分开通码和账号。</span></div>' +
      '<button type="submit" class="btn btn-primary">生成开通码</button></form></section>';

    html += '<section class="card"><div class="card-head"><div><h2>开通码记录</h2>' +
      '<p>未使用的码可以一键作废；忘了保存就作废并重发一张新码。</p></div>' +
      '<div class="card-head-side"><label class="field-label" for="codeFilter">状态</label>' +
      '<select id="codeFilter" class="select"><option value="all">全部</option>' +
      ['unused', 'redeemed', 'revoked'].map(function (key) {
        return '<option value="' + key + '"' + (state.codeFilter === key ? ' selected' : '') + '>' +
          codeStatus[key].text + '</option>';
      }).join('') + '</select></div></div>' +
      '<div class="table-wrap"><table><thead><tr><th>脱敏提示码</th><th>配送员备注名</th><th>状态</th>' +
      '<th>创建时间</th><th>激活时间</th><th>绑定账号</th><th>操作</th></tr></thead><tbody id="codeRows">' +
      codeRowsHtml(records) + '</tbody></table></div></section>';

    html += '<section class="card"><div class="card-head"><div><h2>已开通配送员</h2>' +
      '<p>停用会立即踢下线并让旧登录凭证永久失效；历史单据与资料不会被删除。</p></div>' +
      '<span class="muted" id="accountsCount">共 ' + state.accounts.length + ' 位</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>配送员</th><th>登录方式与脱敏标识</th><th>状态</th>' +
      '<th>最近活跃</th><th class="num">趟数</th><th class="num">货品数</th><th class="num">待处理错题</th><th>操作</th>' +
      '</tr></thead><tbody id="accountsRows">' + accountsRowsHtml() + '</tbody></table></div></section>';

    var costDescription = system.costRates && system.costRates.description
      ? system.costRates.description : '按已记录模型事件的输入和输出用量估算。';
    html += '<section class="card"><div class="card-head"><div><h2>系统运行状态</h2>' +
      '<p>只展示配置是否就位，不展示任何密钥。</p></div></div>' + lightsHtml(system) +
      '<p class="metric-note" style="margin-top:10px">费用估算口径：' + esc(costDescription) + '</p>' +
      '<details class="soft-details" id="aiRulesDetails"><summary>AI 内部规则（只读参考）</summary>' +
      '<div id="aiRulesBody" class="loading-inline">展开后加载当前 7 组提示词与工具 Schema。</div></details></section>';
    root.innerHTML = '<div class="view-stage">' + html + '</div>';
    bindAiRules();
  };

  var renderCodeRowsOnly = function () {
    var tbody = el('codeRows');
    if (!tbody) { renderAccountsPage(); return; }
    var records = state.activationCodes && Array.isArray(state.activationCodes.records)
      ? state.activationCodes.records : [];
    tbody.innerHTML = codeRowsHtml(records);
  };
  var renderAccountRowsOnly = function () {
    var tbody = el('accountsRows');
    if (!tbody) { renderAccountsPage(); return; }
    tbody.innerHTML = accountsRowsHtml();
    var count = el('accountsCount');
    if (count) count.textContent = '共 ' + state.accounts.length + ' 位';
  };

  var reloadCodes = function () {
    return api('/activation-codes').then(function (data) {
      state.activationCodes = data;
      if (isCurrent('accounts')) renderCodeRowsOnly();
    });
  };
  var reloadAccounts = function () {
    return App.loadAccounts().then(function () {
      if (isCurrent('accounts')) renderAccountRowsOnly();
    });
  };

  var renameDialog = function (id, name) {
    openModal({
      title: '修改配送员备注名',
      bodyHtml: '<label class="field-label" for="renameInput">新的中文备注名</label>' +
        '<input id="renameInput" class="text-input" maxlength="40" autocomplete="off" value="' + esc(name) + '">' +
        '<p class="modal-note">备注名只用于后台区分，不影响配送员登录和已有的历史单据。</p>' +
        '<div class="modal-error" id="renameError"></div>',
      confirmText: '保存备注名',
      confirmTone: 'primary',
      onConfirm: function () {
        var input = el('renameInput');
        var value = input ? input.value.trim() : '';
        var errorNode = el('renameError');
        if (!value) {
          if (errorNode) errorNode.textContent = '备注名不能为空。';
          if (App.shakeNode) App.shakeNode(input);
          if (input) input.focus();
          return false;
        }
        if (errorNode) errorNode.textContent = '';
        return api('/accounts/' + encodeURIComponent(id), {
          method: 'PATCH', body: { remarkName: value }
        }).then(function () {
          toast('备注名已更新。', 'success');
          return reloadAccounts();
        });
      }
    });
  };

  var disableDialog = function (id, name) {
    openModal({
      title: '停用这个配送员账号？',
      bodyHtml: '<p>将立即停用 <b>' + esc(name) + '</b>：手机会马上被踢下线，旧登录凭证永久失效，直到你点「恢复启用」。</p>' +
        '<p class="modal-warn">停用不会删除任何历史正式单、货品库、熟客叫法或错题记录。</p>',
      confirmText: '确认停用',
      confirmTone: 'danger',
      onConfirm: function () {
        return api('/accounts/' + encodeURIComponent(id) + '/disable', { method: 'POST' }).then(function () {
          toast('已停用「' + name + '」。', 'success');
          return reloadAccounts();
        });
      }
    });
  };
  var enableDialog = function (id, name) {
    openModal({
      title: '恢复启用这个账号？',
      bodyHtml: '<p>将恢复 <b>' + esc(name) + '</b> 的正常使用。配送员下次打开小程序会重新走微信登录。</p>',
      confirmText: '恢复启用',
      confirmTone: 'primary',
      onConfirm: function () {
        return api('/accounts/' + encodeURIComponent(id) + '/enable', { method: 'POST' }).then(function () {
          toast('已恢复启用「' + name + '」。', 'success');
          return reloadAccounts();
        });
      }
    });
  };
  var revokeDialog = function (id, remark, reissue) {
    openModal({
      title: reissue ? '作废并重发新开通码？' : '作废这张开通码？',
      bodyHtml: '<p>给 <b>' + esc(remark) + '</b> 的这张「未使用」开通码会立即作废，作废后对方无法再用它开通。</p>' +
        (reissue ? '<p class="modal-note">作废后会马上生成一张新码，并在弹窗里一次性展示。</p>'
          : '<p class="modal-note">如果只是没保存，建议直接选「作废并重发」。</p>'),
      confirmText: reissue ? '作废并重发' : '确认作废',
      confirmTone: 'danger',
      onConfirm: function () {
        return api('/activation-codes/' + encodeURIComponent(id) + '/' + (reissue ? 'reissue' : 'revoke'), {
          method: 'POST'
        }).then(function (data) {
          state.activationCodes = null;
          if (reissue && data && data.code) {
            toast('已作废旧码并生成新开通码。', 'success');
            showCodeModal(data.code, data.record);
          } else {
            toast('开通码已作废。', 'success');
          }
          return reloadCodes();
        });
      }
    });
  };

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'activationForm') return;
    event.preventDefault();
    var input = el('activationRemark');
    var remark = input ? input.value.trim() : '';
    if (!remark) {
      toast('请先填写配送员中文备注名。', 'error');
      if (App.shakeNode) App.shakeNode(input);
      if (input) input.focus();
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = '生成中…'; }
    api('/activation-codes', {
      method: 'POST',
      body: {
        remarkName: remark,
        requestId: 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      }
    }).then(function (data) {
      if (input) input.value = '';
      state.activationCodes = null;
      showCodeModal(data.code, data.record);
      return reloadCodes();
    }).then(function () {
      if (button && button.isConnected) { button.disabled = false; button.textContent = '生成开通码'; }
    }, function () {
      if (button && button.isConnected) { button.disabled = false; button.textContent = '生成开通码'; }
    });
  });

  document.addEventListener('change', function (event) {
    if (event.target && event.target.id === 'codeFilter') {
      state.codeFilter = event.target.value;
      if (isCurrent('accounts')) renderCodeRowsOnly();
    }
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    var scopeButton = target.closest('[data-trip-scope]');
    if (scopeButton) {
      var scopeId = scopeButton.getAttribute('data-trip-scope');
      state.scopeId = scopeId;
      state.scope = null;
      loadTripDetail(scopeId);
      return;
    }
    if (target.closest('[data-trip-back]')) {
      state.scopeId = '';
      state.scope = null;
      state.tripTab = 'sheets';
      if (state.overview) renderTripList(); else loadTrips();
      return;
    }
    var tripTab = target.closest('[data-trip-tab]');
    if (tripTab) {
      switchTripTab(tripTab.getAttribute('data-trip-tab'));
      return;
    }
    var jump = target.closest('[data-quality-turn]');
    if (jump) {
      App.navigate('quality', {
        filter: 'attention',
        scopeId: jump.getAttribute('data-quality-scope') || '',
        highlightTurnId: jump.getAttribute('data-quality-turn') || ''
      });
      return;
    }
    var revoke = target.closest('[data-code-revoke]');
    if (revoke) {
      revokeDialog(revoke.getAttribute('data-code-revoke'), revoke.getAttribute('data-code-remark') || '这位配送员', false);
      return;
    }
    var reissue = target.closest('[data-code-reissue]');
    if (reissue) {
      revokeDialog(reissue.getAttribute('data-code-reissue'), reissue.getAttribute('data-code-remark') || '这位配送员', true);
      return;
    }
    var rename = target.closest('[data-account-rename]');
    if (rename) {
      renameDialog(rename.getAttribute('data-account-rename'), rename.getAttribute('data-account-name') || '');
      return;
    }
    var disable = target.closest('[data-account-disable]');
    if (disable) {
      disableDialog(disable.getAttribute('data-account-disable'), disable.getAttribute('data-account-name') || '这位配送员');
      return;
    }
    var enable = target.closest('[data-account-enable]');
    if (enable) {
      enableDialog(enable.getAttribute('data-account-enable'), enable.getAttribute('data-account-name') || '这位配送员');
      return;
    }
    var switchAccount = target.closest('[data-account-switch]');
    if (switchAccount) {
      App.closeModal(true);
      App.clearMaterialUrls();
      state.accountId = switchAccount.getAttribute('data-account-switch');
      state.dashboard = null;
      state.overview = null;
      state.scope = null;
      state.scopeId = '';
      state.tripTab = 'sheets';
      App.renderAccountSelect();
      App.updateNavBadges();
      App.navigate('dashboard');
      var account = current();
      if (account) toast('已切换到 ' + App.accountLabel(account) + '。', 'success');
      return;
    }
    var copyRule = target.closest('[data-copy-rule]');
    if (copyRule) {
      var entry = (state.prompts || [])[Number(copyRule.getAttribute('data-copy-rule'))];
      if (!entry) return;
      var text = (entry.prompts || []).map(function (prompt) {
        return '【' + prompt.label + '】\\n' + prompt.text;
      }).join('\\n\\n');
      copyText(text, '已复制「' + entry.title + '」全文。', copyRule);
    }
  });

  views.accounts = { mount: function () { loadAccountsPage(); } };

})();
`;
