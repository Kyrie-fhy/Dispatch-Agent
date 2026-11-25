export const adminDataScript = `
(function () {
  'use strict';
  var App = window.__dispatchAdmin;
  if (!App) return;
  var state = App.state;
  var views = App.views;
  var esc = App.esc;
  var centsToYuan = App.centsToYuan;
  var moneyText = App.moneyText;
  var fmtDay = App.fmtDay;
  var fmtTime = App.fmtTime;
  var toast = App.toast;
  var copyText = App.copyText;
  var openModal = App.openModal;

  var el = function (id) { return document.getElementById(id); };
  var viewRoot = function () { return el('view'); };
  var str = function (value) { return value === null || value === undefined ? '' : String(value); };
  var num = function (value) { var parsed = Number(value); return isFinite(parsed) ? parsed : 0; };
  var isCurrent = function (section, accountId) {
    return Boolean(state.token) && state.section === section && (!accountId || state.accountId === accountId);
  };
  var accountPath = function (accountId, suffix) {
    return '/accounts/' + encodeURIComponent(accountId) + (suffix || '');
  };
  var badge = function (label, tone) {
    return '<span class="badge ' + (tone || 'neutral') + '">' + esc(label) + '</span>';
  };
  var notice = function (text, warn) {
    return '<div class="notice' + (warn ? ' warn' : '') + '">' + esc(text) + '</div>';
  };
  var loading = function (text) {
    return '<div class="loading-card"><span class="spinner"></span>' + esc(text || '正在加载…') + '</div>';
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
  var field = function (label, id, value, hint, placeholder, type) {
    return '<label class="field" for="' + esc(id) + '"><span class="field-label">' + esc(label) + '</span>' +
      '<input id="' + esc(id) + '" class="text-input" type="' + esc(type || 'text') + '" value="' + esc(value) +
      '" placeholder="' + esc(placeholder || '') + '" autocomplete="off">' +
      (hint ? '<span class="field-hint">' + esc(hint) + '</span>' : '') + '</label>';
  };
  var textarea = function (label, id, value, hint, rows) {
    return '<label class="field" for="' + esc(id) + '"><span class="field-label">' + esc(label) + '</span>' +
      '<textarea id="' + esc(id) + '" class="text-input" rows="' + num(rows || 3) + '">' + esc(value) + '</textarea>' +
      (hint ? '<span class="field-hint">' + esc(hint) + '</span>' : '') + '</label>';
  };
  var splitList = function (value) {
    var seen = {};
    return String(value || '').split(/[\\n,，、;；]+/).map(function (item) { return item.trim(); })
      .filter(function (item) {
        if (!item || seen[item]) return false;
        seen[item] = true;
        return true;
      });
  };
  var parseYuanToCents = function (value) {
    if (value === null || value === undefined) return null;
    var text = String(value).trim();
    if (!/^\\d+(?:\\.\\d{1,2})?$/.test(text)) return null;
    var parts = text.split('.');
    var fraction = (parts[1] || '') + '00';
    var cents = Number(parts[0]) * 100 + Number(fraction.slice(0, 2));
    if (!Number.isSafeInteger(cents) || cents <= 0) return null;
    return cents;
  };
  var request = function (path, opts) {
    var options = opts || {};
    var headers = { Authorization: 'Bearer ' + state.token };
    var body;
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    return fetch('/admin/api' + path, {
      method: options.method || 'GET', headers: headers, body: body, cache: 'no-store'
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        if (response.status === 401) {
          App.logout(true);
          throw new Error('口令已失效，请重新进入后台。');
        }
        if (!response.ok) {
          var failure = new Error((data && (data.message || data.error)) || ('请求失败 ' + response.status));
          failure.status = response.status;
          failure.code = data && (data.code || data.error);
          throw failure;
        }
        return data;
      });
    });
  };
  var downloadFile = function (path, filename, stillCurrent) {
    return fetch('/admin/api' + path, {
      headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store'
    }).then(function (response) {
      if (response.status === 401) {
        App.logout(true);
        throw new Error('口令已失效，请重新进入后台。');
      }
      if (!response.ok) {
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
          throw new Error((data && (data.message || data.error)) || ('下载失败 ' + response.status));
        });
      }
      return response.blob().then(function (blob) {
        if (stillCurrent && !stillCurrent()) return;
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('已开始下载 ' + filename + '。', 'success');
      });
    });
  };

  var current = function () { return App.currentAccount(); };

  /* ================= 模块 3：货品与价格库 ================= */

  var catalogView = {
    data: null, status: 'all', search: '', category: '',
    customers: null, queryResult: null, queryText: '', csv: { text: '', preview: null }
  };
  var catalogQuerySeq = 0;
  var catalogCsvSeq = 0;

  var autoCatalogCode = function (code) {
    return /^[MV]-[0-9a-f]{8}-[0-9a-f]{4}-/i.test(str(code));
  };
  var catalogCodeText = function (productCode, variantCode) {
    var productLabel = autoCatalogCode(productCode) ? '手工建档' : str(productCode);
    var variantLabel = autoCatalogCode(variantCode) ? '手工建档' : str(variantCode);
    if (!productLabel && !variantLabel) return '';
    if (productLabel === variantLabel && productLabel === '手工建档') return productLabel;
    return productLabel + ' / ' + variantLabel;
  };

  var catalogStatusLabel = { active: '在售', discontinued: '已下架' };
  var priceSourceLabel = {
    customer_history: '熟客价', catalog: '库内价', spoken: '原话价', manual: '手改价'
  };
  var catalogTone = function (status) {
    if (status === 'active') return 'ok';
    if (status === 'discontinued') return 'warn';
    return 'neutral';
  };
  var catalogItems = function () {
    return catalogView.data && Array.isArray(catalogView.data.items) ? catalogView.data.items : [];
  };
  var catalogFiltered = function () {
    var search = catalogView.search.trim().toLowerCase();
    return catalogItems().filter(function (item) {
      var aliases = (item.aliases || []).concat(item.brandAliases || []);
      if (catalogView.category && item.category !== catalogView.category) return false;
      if (catalogView.status === 'missing' && item.unit !== null) return false;
      if (catalogView.status === 'active' && item.status !== 'active') return false;
      if (catalogView.status === 'discontinued' && item.status !== 'discontinued') return false;
      if (!search) return true;
      var haystack = [item.product, item.brand, item.specification, item.packaging, item.flavorOrGrade,
        item.productCode, item.variantCode, item.category].concat(aliases).join(' ').toLowerCase();
      return haystack.indexOf(search) >= 0;
    });
  };
  var unitCell = function (unit) {
    if (unit === null || unit === undefined || unit === '') return '<span class="badge warn">缺单位</span>';
    return '<span class="unit-chip">' + esc(unit) + '</span>';
  };
  var catalogRowsHtml = function (items) {
    if (!items.length) {
      return '<tr><td colspan="7" class="table-empty">没有符合条件的货品。可以清除搜索或切换筛选。</td></tr>';
    }
    return items.map(function (item) {
      var aliases = (item.aliases || []).join('、');
      var brandAliases = (item.brandAliases || []).join('、');
      var sub = [item.category || '未分类'];
      if (aliases) sub.push('俗称：' + aliases);
      if (brandAliases) sub.push('品牌别名：' + brandAliases);
      var status = catalogStatusLabel[item.status] || item.status || '未知';
      return '<tr class="catalog-row' + (item.unit === null ? ' missing-unit' : '') + '">' +
        '<td><span class="cell-main">' + esc(item.product) + '</span>' +
        '<span class="line-sub">' + esc(sub.join(' · ')) + '</span>' +
        '<span class="line-sub mono">' + esc(catalogCodeText(item.productCode, item.variantCode)) + '</span></td>' +
        '<td>' + esc(item.brand || '—') + '</td>' +
        '<td>' + esc(item.specification || item.packaging || '—') + '</td>' +
        '<td>' + unitCell(item.unit) + '</td>' +
        '<td class="num"><span class="money">' + moneyText(item.priceCents) + '</span></td>' +
        '<td>' + badge(status, catalogTone(item.status)) + '</td>' +
        '<td><div class="row-actions">' +
        '<button type="button" class="btn btn-small" data-catalog-edit="' + esc(item.variantId) + '">编辑</button>' +
        '<button type="button" class="btn btn-small btn-primary-outline" data-catalog-toggle="' + esc(item.variantId) + '">' +
        (item.status === 'active' ? '快速下架' : '重新上架') + '</button></div></td></tr>';
    }).join('');
  };
  var catalogEmptyRow = function () {
    return '<tr><td colspan="7" class="table-empty">当前还没有货品。点右上角「+ 新增货品」或「上传 CSV 更新」开始维护。</td></tr>';
  };
  var renderCatalogRows = function () {
    var body = el('catalogRows');
    if (!body) return;
    var items = catalogFiltered();
    body.innerHTML = items.length ? catalogRowsHtml(items) : catalogEmptyRow();
    var count = el('catalogCount');
    if (count) count.textContent = '当前显示 ' + items.length + ' 条规格';
    Array.prototype.forEach.call(document.querySelectorAll('[data-catalog-status]'), function (node) {
      node.classList.toggle('active', node.getAttribute('data-catalog-status') === catalogView.status);
    });
  };
  var renderCatalogQuery = function () {
    var box = el('catalog-query-result');
    if (!box) return;
    var result = catalogView.queryResult;
    if (!result) { box.innerHTML = ''; return; }
    var status = result.status || 'unmatched';
    var badges = {
      active: { label: '已自动配价', tone: 'ok' },
      discontinued: { label: '已下架提醒', tone: 'warn' },
      unit_mismatch: { label: '单位对不上', tone: 'warn' },
      ambiguous: { label: '有多款待选', tone: 'warn' },
      unmatched: { label: '库外新货', tone: 'neutral' },
      external: { label: '库外新货', tone: 'neutral' }
    };
    var statusInfo = badges[status] || { label: '待核对', tone: 'neutral' };
    var source = result.priceSource ? (priceSourceLabel[result.priceSource] || '手动价') : '留空待补价';
    var priceHtml = result.priceCents === null || result.priceCents === undefined
      ? '<span class="badge warn">留空待补价</span>'
      : '<span class="money result-price">' + moneyText(result.priceCents) + '</span> ' +
        badge(source, result.priceSource === 'customer_history' ? 'info' : 'ok');
    var item = result.item;
    var candidates = Array.isArray(result.candidates) ? result.candidates : [];
    if (!candidates.length && item) candidates = [item];
    var html = '<div class="result-panel"><div class="result-head">' + badge(statusInfo.label, statusInfo.tone) +
      '<div class="result-price-wrap">' + priceHtml + '</div></div>';
    html += '<p class="result-reason">' + esc(result.reason || (result.priceCents === null
      ? '库内没有可直接套用的价格，AI 会留空等你补价，不会算成 ¥0.00。'
      : '已按当前货品库' + (result.priceSource === 'customer_history' ? '和这位熟客的历史成交价' : '') + '给出参考价。')) + '</p>';
    if (item) {
      html += '<div class="result-hit"><b>' + esc(item.product) + '</b> ' +
        esc([item.brand, item.specification].filter(Boolean).join(' · ')) + ' · ' + unitCell(item.unit) +
        '<span class="line-sub mono">' + esc(item.productCode || '') + ' / ' + esc(item.variantCode || '') + '</span></div>';
    }
    if (candidates.length > 1) {
      html += '<div class="table-wrap"><table class="compact-table"><thead><tr><th>候选货品</th><th>品牌 / 规格</th>' +
        '<th>单位</th><th class="num">挂牌价</th><th>状态</th></tr></thead><tbody>' +
        candidates.map(function (candidate) {
          return '<tr><td>' + esc(candidate.product) + '</td><td>' +
            esc([candidate.brand, candidate.specification].filter(Boolean).join(' · ') || '—') + '</td>' +
            '<td>' + unitCell(candidate.unit) + '</td><td class="num">' + moneyText(candidate.priceCents) + '</td>' +
            '<td>' + badge(catalogStatusLabel[candidate.status] || candidate.status, catalogTone(candidate.status)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '<p class="field-hint">试查只读，不会写入草稿或正式单。</p></div>';
    box.innerHTML = html;
  };
  var loadCatalogCustomers = function (accountId) {
    if (catalogView.customers) return;
    request(accountPath(accountId, '/customers')).then(function (data) {
      if (!isCurrent('catalog', accountId)) return;
      catalogView.customers = data && Array.isArray(data.customers) ? data.customers : [];
      var select = el('catalog-query-customer');
      if (!select) return;
      var selected = select.value;
      select.innerHTML = '<option value="">不模拟熟客（按库内价）</option>' +
        catalogView.customers.map(function (customer) {
          return '<option value="' + esc(customer.id) + '">' + esc(customer.name) + '</option>';
        }).join('');
      if (selected) select.value = selected;
    }, function () {
      if (isCurrent('catalog', accountId)) catalogView.customers = [];
    });
  };
  var renderCatalogView = function () {
    var account = current();
    if (!account || !catalogView.data) { loadCatalogView(); return; }
    var data = catalogView.data;
    var summary = data.summary || {};
    var missing = num(summary.missingUnitVariantCount);
    var html = pageHead('货品与价格库', '维护 227+ 货品的价格、单位与上下架，支持一句话试查和 CSV 增量预演。', badge('价格底库', 'info'));
    html += '<section class="card catalog-overview"><div class="card-head"><div><span class="section-kicker">货品库概览</span>' +
      '<h2>' + num(summary.productCount) + ' 个商品 · ' + num(summary.variantCount) + ' 条规格</h2>' +
      '<p>' + (data.importedAt ? '最近一次 CSV 导入：' + esc(fmtTime(data.importedAt)) : '还没有导入过 CSV，可先新增单品。') +
      ' · 当前版本 ' + num(data.catalogRevision) + '</p></div>' +
      '<div class="row-actions">' +
      '<button type="button" class="btn btn-primary" data-catalog-add="1">+ 新增货品</button>' +
      '<button type="button" class="btn btn-secondary" data-catalog-upload="1">上传 CSV 更新</button>' +
      '<button type="button" class="btn btn-secondary" data-catalog-export="1">导出当前货品 CSV</button>' +
      '</div></div>' +
      '<div class="metric-grid">' +
      metric('总商品数', num(summary.productCount) + ' 个', '') +
      metric('规格总数', num(summary.variantCount) + ' 条', '') +
      metric('在售', num(summary.activeVariantCount) + ' 条', '') +
      metric('已下架', num(summary.discontinuedVariantCount) + ' 条', '') +
      metric('缺单位', missing ? '<span class="text-amber">' + missing + '</span> 条' : '0 条',
        missing ? '未填单位时 AI 会留空防算错价，补上即可自动配价' : '单位已齐') +
      '</div>' +
      (missing ? notice('未填单位时 AI 会留空防算错价，补上即可自动配价。点「去补单位」只看缺单位货品。', true) : '') +
      (missing ? '<div class="row-actions" style="margin-top:6px"><button type="button" class="btn btn-small btn-primary-outline" data-nav="catalog" data-missing-unit="1">去补单位 ›</button></div>' : '') +
      '</section>';

    html += '<section class="card sandbox-card"><div class="card-head"><div><span class="section-kicker">一句话试查小沙盒</span>' +
      '<h2>模拟客户这句话，AI 会怎么认货配价</h2><p>只读演示，绝不写库；也不消耗真实对话。</p></div></div>' +
      '<div class="query-row"><label class="field grow" for="catalog-query-text"><span class="field-label">客户原话</span>' +
      '<input id="catalog-query-text" class="text-input" value="' + esc(catalogView.queryText) +
      '" placeholder="例如：安井鱼豆腐500g 2箱" autocomplete="off"></label>' +
      '<label class="field" for="catalog-query-customer"><span class="field-label">模拟某位熟客（测熟客价）</span>' +
      '<select id="catalog-query-customer" class="select"><option value="">不模拟熟客（按库内价）</option>' +
      (catalogView.customers || []).map(function (customer) {
        return '<option value="' + esc(customer.id) + '">' + esc(customer.name) + '</option>';
      }).join('') + '</select></label>' +
      '<button type="button" class="btn btn-primary" data-catalog-query="1">立即试查</button></div>' +
      '<details class="soft-details"><summary>按字段精确试查（品名 / 品牌 / 规格 / 单位）</summary>' +
      '<div class="field-grid four" style="margin-top:10px">' +
      field('品名', 'catalog-query-product', '', '', '例如：鱼豆腐') +
      field('品牌', 'catalog-query-brand', '', '', '例如：安井') +
      field('规格', 'catalog-query-spec', '', '', '例如：500g') +
      field('计价单位', 'catalog-query-unit', '', '', '例如：箱 / 袋') +
      '</div></details><div id="catalog-query-result"></div></section>';

    html += '<section class="card"><div class="card-head"><div><span class="section-kicker">货品明细</span>' +
      '<h2>宽屏货品表</h2><p id="catalogCount">当前显示 ' + catalogFiltered().length + ' 条规格</p></div></div>' +
      '<div class="filter-bar"><input id="catalog-search" class="text-input grow" value="' + esc(catalogView.search) +
      '" placeholder="搜索品名 / 品牌 / 规格 / 别名 / 货号" autocomplete="off">' +
      '<select id="catalog-category" class="select"><option value="">全部分类</option>' +
      (data.categories || []).map(function (category) {
        return '<option value="' + esc(category) + '"' + (catalogView.category === category ? ' selected' : '') + '>' +
          esc(category) + '</option>';
      }).join('') + '</select>' +
      '<div class="filter-pills">' +
      [['all', '全部'], ['active', '在售'], ['discontinued', '已下架'], ['missing', '缺单位']].map(function (pair) {
        return '<button type="button" class="pill-filter' + (catalogView.status === pair[0] ? ' active' : '') +
          '" data-catalog-status="' + pair[0] + '">' + pair[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="table-wrap catalog-table-wrap"><table class="catalog-table"><thead><tr><th>标准品名</th><th>品牌</th>' +
      '<th>规格</th><th>计价单位</th><th class="num">挂牌价</th><th>状态</th><th>操作</th></tr></thead>' +
      '<tbody id="catalogRows"></tbody></table></div></section>';
    viewRoot().innerHTML = html;
    renderCatalogRows();
    renderCatalogQuery();
    loadCatalogCustomers(account.id);
  };
  var loadCatalogView = function (accountId) {
    var account = current();
    if (!account) {
      viewRoot().innerHTML = emptyCard('还没有配送员账号',
        '先到「账号与开通」生成一次性开通码，配送员开通后就能维护他的货品库。', 'accounts', '去账号与开通');
      return Promise.resolve();
    }
    catalogQuerySeq += 1;
    catalogView.data = null;
    viewRoot().innerHTML = loading('正在读取 ' + App.accountLabel(account) + ' 的货品与价格库…');
    return request(accountPath(account.id, '/catalog')).then(function (data) {
      if (!isCurrent('catalog', account.id)) return;
      catalogView.data = data;
      renderCatalogView();
    }, function (error) {
      if (isCurrent('catalog', account.id)) viewRoot().innerHTML = App.errorCard(error.message);
    });
  };
  views.catalog = {
    mount: function () {
      var filter = state.catalogFilter || {};
      catalogView.search = '';
      catalogView.category = '';
      catalogView.queryResult = null;
      catalogView.customers = null;
      catalogView.queryText = '';
      catalogView.status = filter.missingUnitOnly ? 'missing' : 'all';
      loadCatalogView(state.accountId);
    }
  };

  var catalogVariantById = function (variantId) {
    var items = catalogItems();
    for (var index = 0; index < items.length; index++) if (items[index].variantId === variantId) return items[index];
    return null;
  };
  var openCatalogEditor = function (variant) {
    var data = catalogView.data;
    if (!data) return;
    var targetAccountId = state.accountId;
    var editing = Boolean(variant);
    var products = [];
    var seenProducts = {};
    catalogItems().forEach(function (item) {
      if (seenProducts[item.productId]) return;
      seenProducts[item.productId] = true;
      products.push(item);
    });
    var productOptions = '<option value="__new__">新建一个商品</option>' + products.map(function (item) {
      return '<option value="' + esc(item.productId) + '">' + esc(item.product) +
        (item.brand ? ' · ' + esc(item.brand) : '') + '</option>';
    }).join('');
    var bodyHtml = '<div class="field-grid">' +
      (editing ? '' : '<label class="field" for="catalogEditorProduct"><span class="field-label">保存到哪里</span>' +
        '<select id="catalogEditorProduct" class="select">' + productOptions + '</select>' +
        '<span class="field-hint">选已有商品会新增一条规格；选「新建一个商品」会创建新商品。</span></label>') +
      field('标准品名（必填）', 'catProduct', variant ? variant.product : '', '', '例如：鱼豆腐') +
      field('品牌', 'catBrand', variant ? variant.brand : '', '', '例如：安井') +
      field('分类', 'catCategory', variant ? variant.category : '', '', '例如：冻品') +
      field('包装规格', 'catPackaging', variant ? variant.packaging : '', '', '例如：袋装') +
      field('售卖规格', 'catFlavor', variant ? (variant.flavorOrGrade || '') : '', '', '例如：原味') +
      field('标准规格', 'catSpec', variant ? variant.specification : '', '', '例如：500g') +
      field('计价单位（可留空）', 'catUnit', variant && variant.unit !== null ? variant.unit : '', '留空表示暂缺单位，AI 会留空防算错价。', '例如：箱 / 袋 / 包') +
      field('挂牌价（元，必填）', 'catPrice', variant ? centsToYuan(variant.priceCents) : '', '必须是大于 0、最多两位小数的金额。', '例如：82.00') +
      '<label class="field" for="catStatus"><span class="field-label">销售状态</span>' +
      '<select id="catStatus" class="select"><option value="active"' +
      (!variant || variant.status === 'active' ? ' selected' : '') + '>在售</option>' +
      '<option value="discontinued"' + (variant && variant.status === 'discontinued' ? ' selected' : '') +
      '>已下架</option></select></label></div>' +
      textarea('商品俗称 / 别名（逗号或换行分隔）', 'catAliases',
        variant ? (variant.aliases || []).join('、') : '', '例如：鱼豆腐、鱼豆付', 2) +
      textarea('品牌别名（逗号或换行分隔）', 'catBrandAliases',
        variant ? (variant.brandAliases || []).join('、') : '', '例如：安井、安景', 2) +
      '<p class="modal-note">编辑会带上当前货品库版本，避免别处刚改过时覆盖。单位留空会清除为缺单位。</p>' +
      '<div class="modal-error" id="catError"></div>';
    var aliasBaseline = {
      aliases: variant ? (variant.aliases || []).join('、') : '',
      brandAliases: variant ? (variant.brandAliases || []).join('、') : ''
    };
    openModal({
      title: editing ? '编辑这条规格' : '新增货品或规格',
      bodyHtml: bodyHtml,
      confirmText: editing ? '保存这条规格' : '保存新货品',
      confirmTone: 'primary',
      onConfirm: function () {
        if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
        var errorNode = el('catError');
        var product = el('catProduct') ? el('catProduct').value.trim() : '';
        var priceText = el('catPrice') ? el('catPrice').value.trim() : '';
        var cents = parseYuanToCents(priceText);
        if (!product) {
          if (errorNode) errorNode.textContent = '请填写标准品名。';
          toast('请填写标准品名。', 'error');
          return false;
        }
        if (cents === null || cents <= 0) {
          if (errorNode) errorNode.textContent = '挂牌价必须是大于 0、最多两位小数的金额。';
          toast('挂牌价必须是大于 0、最多两位小数的金额。', 'error');
          return false;
        }
        if (errorNode) errorNode.textContent = '';
        var unitText = el('catUnit') ? el('catUnit').value.trim() : '';
        var aliasText = el('catAliases') ? el('catAliases').value : '';
        var brandAliasText = el('catBrandAliases') ? el('catBrandAliases').value : '';
        var picked = editing ? '' : (el('catalogEditorProduct') ? el('catalogEditorProduct').value : '__new__');
        var addingToExisting = !editing && picked && picked !== '__new__';
        var body = {
          product: product,
          brand: el('catBrand') ? el('catBrand').value.trim() : '',
          category: el('catCategory') ? el('catCategory').value.trim() : '',
          packaging: el('catPackaging') ? el('catPackaging').value.trim() : '',
          flavorOrGrade: el('catFlavor') ? el('catFlavor').value.trim() : '',
          specification: el('catSpec') ? el('catSpec').value.trim() : '',
          unit: unitText ? unitText : null,
          priceCents: cents,
          status: el('catStatus') ? el('catStatus').value : 'active',
          expectedRevision: num(data.catalogRevision)
        };
        if (editing || addingToExisting) {
          if (aliasText !== aliasBaseline.aliases) body.aliases = splitList(aliasText);
          if (brandAliasText !== aliasBaseline.brandAliases) body.brandAliases = splitList(brandAliasText);
        } else {
          body.aliases = splitList(aliasText);
          body.brandAliases = splitList(brandAliasText);
        }
        var path;
        var method;
        if (editing) {
          path = accountPath(targetAccountId, '/catalog/variants/' + encodeURIComponent(variant.variantId));
          method = 'PATCH';
        } else {
          if (picked && picked !== '__new__') body.productId = picked;
          path = accountPath(targetAccountId, '/catalog/items');
          method = 'POST';
        }
        return request(path, { method: method, body: body }).then(function () {
          toast(editing ? '这条规格已保存。' : '新货品已保存。', 'success');
          App.loadAccounts().catch(function () {});
          if (state.accountId !== targetAccountId) return;
          return loadCatalogView(targetAccountId);
        }, function (error) {
          var message = error.status === 409 ? '货品库已在别处更新，请关闭弹窗后刷新列表再改。' : error.message;
          if (errorNode) errorNode.textContent = message;
          throw new Error(message);
        });
      }
    });
    var picker = el('catalogEditorProduct');
    if (picker) picker.addEventListener('change', function () {
      var picked = catalogItems().filter(function (item) { return item.productId === picker.value; })[0];
      if (!picked) {
        if (el('catProduct')) el('catProduct').value = '';
        if (el('catBrand')) el('catBrand').value = '';
        if (el('catCategory')) el('catCategory').value = '';
        if (el('catPackaging')) el('catPackaging').value = '';
        if (el('catFlavor')) el('catFlavor').value = '';
        if (el('catSpec')) el('catSpec').value = '';
        if (el('catAliases')) el('catAliases').value = '';
        if (el('catBrandAliases')) el('catBrandAliases').value = '';
        aliasBaseline = { aliases: '', brandAliases: '' };
        return;
      }
      if (el('catProduct')) el('catProduct').value = picked.product;
      if (el('catBrand')) el('catBrand').value = picked.brand || '';
      if (el('catCategory')) el('catCategory').value = picked.category || '';
      if (el('catPackaging')) el('catPackaging').value = picked.packaging || '';
      if (el('catFlavor')) el('catFlavor').value = picked.flavorOrGrade || '';
      if (el('catSpec')) el('catSpec').value = '';
      var aliasesText = (picked.aliases || []).join('、');
      var brandAliasesText = (picked.brandAliases || []).join('、');
      if (el('catAliases')) el('catAliases').value = aliasesText;
      if (el('catBrandAliases')) el('catBrandAliases').value = brandAliasesText;
      aliasBaseline = { aliases: aliasesText, brandAliases: brandAliasesText };
    });
  };
  var toggleCatalogVariant = function (variant, accountId) {
    var targetAccountId = accountId || state.accountId;
    if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
    var next = variant.status === 'active' ? 'discontinued' : 'active';
    request(accountPath(targetAccountId, '/catalog/variants/' + encodeURIComponent(variant.variantId)), {
      method: 'PATCH',
      body: { priceCents: variant.priceCents, status: next, expectedRevision: num(catalogView.data.catalogRevision) }
    }).then(function () {
      toast(next === 'active' ? '已重新上架。' : '已快速下架。', 'success');
      App.loadAccounts().catch(function () {});
      if (state.accountId !== targetAccountId) return;
      return loadCatalogView(targetAccountId);
    }, function (error) {
      toast(error.status === 409 ? '货品库已在别处更新，请刷新后再操作。' : error.message, 'error');
    });
  };
  var renderCsvPreview = function (preview) {
    var box = el('catalogCsvPreview');
    if (!box) return;
    if (!preview) { box.innerHTML = ''; return; }
    var changes = [];
    (preview.priceChanges || []).forEach(function (row) {
      changes.push({ type: '改价', name: row.product + ' · ' + row.specification,
        from: moneyText(row.oldPriceCents), to: moneyText(row.newPriceCents) });
    });
    (preview.statusChanges || []).forEach(function (row) {
      changes.push({ type: '状态', name: row.product + ' · ' + row.specification,
        from: catalogStatusLabel[row.oldStatus] || row.oldStatus, to: catalogStatusLabel[row.newStatus] || row.newStatus });
    });
    (preview.unitChanges || []).forEach(function (row) {
      changes.push({ type: '单位', name: row.product + ' · ' + row.specification,
        from: row.oldUnit || '缺单位', to: row.newUnit || '缺单位' });
    });
    var errors = Array.isArray(preview.errors) ? preview.errors : [];
    var html = '<div class="csv-summary">' +
      '<span class="badge info">新增商品 ' + num(preview.addedProducts) + '</span>' +
      '<span class="badge info">新增规格 ' + num(preview.addedVariants) + '</span>' +
      '<span class="badge warn">改价 ' + num((preview.priceChanges || []).length) + ' 处</span>' +
      '<span class="badge warn">状态变更 ' + num((preview.statusChanges || []).length) + ' 处</span>' +
      '<span class="badge warn">单位变更 ' + num((preview.unitChanges || []).length) + ' 处</span>' +
      '<span class="badge neutral">无变化 ' + num(preview.unchangedCount) + ' 条</span>' +
      '<span class="badge ' + (num(preview.missingUnitCount) ? 'warn' : 'ok') + '">导入后缺单位合计 ' +
      num(preview.missingUnitCount) + '</span></div>';
    if (errors.length) {
      html += '<div class="error-list"><b>预演发现问题</b><ul>' + errors.map(function (error) {
        return '<li>' + esc(typeof error === 'string' ? error : (error.message || JSON.stringify(error))) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (changes.length) {
      html += '<div class="table-wrap"><table class="compact-table"><thead><tr><th>类型</th><th>货品</th>' +
        '<th>原值</th><th>新值</th></tr></thead><tbody>' +
        changes.slice(0, 30).map(function (change) {
          return '<tr><td>' + esc(change.type) + '</td><td>' + esc(change.name) + '</td><td>' +
            esc(change.from) + '</td><td>' + esc(change.to) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (changes.length > 30 ? '<p class="field-hint">仅先展示前 30 条，共 ' + changes.length + ' 条变化。</p>' : '');
    } else {
      html += notice('表内货品与当前库一致，没有价格、状态或单位变化。');
    }
    html += '<p class="field-hint">只增量更新表里列出的货品，表外老货品保持不动，防止误删。</p>';
    box.innerHTML = html;
  };
  var previewCatalogCsv = function (expectedSeq) {
    var seq = expectedSeq !== undefined ? expectedSeq : ++catalogCsvSeq;
    catalogView.csv.seq = seq;
    var csv = catalogView.csv.text;
    var targetAccountId = catalogView.csv.accountId || state.accountId;
    var errorNode = el('catalogCsvError');
    var box = el('catalogCsvPreview');
    if (!csv) {
      if (errorNode) errorNode.textContent = '请先选择一个 UTF-8 编码的 .csv 文件。';
      return;
    }
    if (errorNode) errorNode.textContent = '';
    if (box) box.innerHTML = '<div class="loading-inline">正在预演差异…</div>';
    request(accountPath(targetAccountId, '/catalog/import/preview'), { method: 'POST', body: { csv: csv } })
      .then(function (preview) {
        if (seq !== catalogCsvSeq || !isCurrent('catalog', targetAccountId) || !el('catalogCsvPreview')) return;
        catalogView.csv.preview = preview;
        renderCsvPreview(preview);
      }, function (error) {
        if (seq !== catalogCsvSeq || !isCurrent('catalog', targetAccountId)) return;
        catalogView.csv.preview = null;
        var message = error.message || '预演失败，请检查 CSV 格式。';
        if (errorNode) errorNode.textContent = message;
        if (box) box.innerHTML = '<div class="error-card inline"><h2>预演没有通过</h2><p>' + esc(message) + '</p></div>';
      });
  };
  var openCatalogCsvModal = function () {
    var targetAccountId = state.accountId;
    var modalSessionSeq = ++catalogCsvSeq;
    catalogView.csv = { text: '', preview: null, accountId: targetAccountId, seq: modalSessionSeq };
    openModal({
      title: '上传 CSV 增量更新货品',
      bodyHtml: '<p>选择 UTF-8 编码的 .csv 文件。先预演差异，再确认导入。</p>' +
        '<label class="field" for="catalogCsvFile"><span class="field-label">货品 CSV 文件</span>' +
        '<input id="catalogCsvFile" class="text-input" type="file" accept=".csv,text/csv"></label>' +
        '<p class="modal-warn">仅增量更新表里列出的货品；表外老货品不动，防止误删。单个文件不超过 2 MiB。</p>' +
        '<div class="row-actions" style="margin-top:8px"><button type="button" class="btn btn-small btn-secondary" data-catalog-repreview="1">重新预演差异</button></div>' +
        '<div id="catalogCsvError" class="modal-error"></div><div id="catalogCsvPreview"></div>',
      confirmText: '确认增量导入',
      confirmTone: 'primary',
      onConfirm: function () {
        if (state.accountId !== targetAccountId || catalogView.csv.accountId !== targetAccountId) {
          throw new Error('当前查看的配送员已切换，请重新操作');
        }
        var errorNode = el('catalogCsvError');
        var preview = catalogView.csv.preview;
        if (!preview || !catalogView.csv.text) {
          if (errorNode) errorNode.textContent = '请先选择 CSV 并等预演完成。';
          toast('请先选择 CSV 并等预演完成。', 'error');
          return false;
        }
        var requestId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        return request(accountPath(targetAccountId, '/catalog/import/confirm'), {
          method: 'POST',
          body: { csv: catalogView.csv.text, previewToken: preview.previewToken, requestId: requestId }
        }).then(function () {
          toast('CSV 已增量导入，货品库已更新。', 'success');
          App.loadAccounts().catch(function () {});
          if (state.accountId !== targetAccountId) return;
          return loadCatalogView(targetAccountId);
        }, function (error) {
          var message = error.status === 409 ? '期间货品库已变动，请重新预演。' : error.message;
          if (errorNode) errorNode.textContent = message;
          throw new Error(message);
        });
      }
    });
  };
  var readCatalogCsvFile = function (input) {
    var file = input && input.files ? input.files[0] : null;
    var errorNode = el('catalogCsvError');
    var targetAccountId = catalogView.csv.accountId || state.accountId;
    var readSeq = ++catalogCsvSeq;
    catalogView.csv = { text: '', preview: null, accountId: targetAccountId, seq: readSeq };
    if (!file) return;
    if (!/\\.csv$/i.test(file.name)) {
      if (errorNode) errorNode.textContent = '请选择 .csv 文件。';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      if (errorNode) errorNode.textContent = '文件超过 2 MiB，请拆分后再上传。';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      if (readSeq !== catalogCsvSeq || state.accountId !== targetAccountId || !el('catalogCsvFile')) return;
      catalogView.csv.text = String(reader.result || '');
      previewCatalogCsv(readSeq);
    };
    reader.onerror = function () {
      if (readSeq !== catalogCsvSeq || state.accountId !== targetAccountId) return;
      if (errorNode) errorNode.textContent = '文件读取失败，请确认是 UTF-8 文本。';
    };
    reader.readAsText(file, 'utf-8');
  };

  /* ================= 模块 4：熟客与叫法 ================= */

  var customersView = { data: null, search: '', prices: {}, expanded: {} };
  var filteredCustomers = function () {
    var search = customersView.search.trim().toLowerCase();
    var list = customersView.data && Array.isArray(customersView.data.customers) ? customersView.data.customers : [];
    if (!search) return list;
    return list.filter(function (customer) {
      var aliases = (customer.aliases || []).map(function (alias) { return alias.alias; }).join(' ');
      return (customer.name + ' ' + aliases).toLowerCase().indexOf(search) >= 0;
    });
  };
  var customerCardHtml = function (customer) {
    var aliases = Array.isArray(customer.aliases) ? customer.aliases : [];
    var last = customer.lastDeliveredAt ? fmtDay(customer.lastDeliveredAt) : '还没有送达记录';
    var basis = customer.lastDeliveredAtBasis === 'trip_issued_at' ? '（按出单时间）' : '';
    return '<article class="customer-card" data-customer-card="' + esc(customer.id) + '">' +
      '<div class="customer-head"><div><h3>' + esc(customer.name) + '</h3>' +
      '<span class="line-sub">历史送达 ' + num(customer.deliveredTripCount) + ' 趟 · 最近送货 ' + esc(last + basis) + '</span></div>' +
      '<div class="row-actions">' +
      '<button type="button" class="btn btn-small btn-primary-outline" data-customer-alias-add="' + esc(customer.id) +
      '" data-customer-name="' + esc(customer.name) + '">+ 加叫法</button>' +
      '<button type="button" class="btn btn-small btn-secondary" data-customer-prices="' + esc(customer.id) + '">查看历史成交价 ▾</button>' +
      '</div></div>' +
      '<div class="alias-row">' + (aliases.length ? aliases.map(function (alias) {
        return '<span class="alias-chip">' + esc(alias.alias) +
          '<button type="button" class="alias-remove" data-customer-alias-remove="' + esc(customer.id) +
          '" data-customer-alias="' + esc(alias.alias) + '" aria-label="删除叫法">×</button></span>';
      }).join('') : '<span class="muted">还没有记过口语叫法。点「+ 加叫法」补上，AI 以后录单更容易认对人。</span>') + '</div>' +
      '<div id="customerPrices-' + esc(customer.id) + '" class="customer-prices hidden"></div></article>';
  };
  var renderCustomerList = function () {
    var box = el('customerList');
    if (!box) return;
    customersView.expanded = {};
    var list = filteredCustomers();
    box.innerHTML = list.length ? list.map(customerCardHtml).join('') : notice('没有匹配的熟客。换个店名或叫法再搜。');
    var count = el('customerCount');
    if (count) count.textContent = '当前显示 ' + list.length + ' 位熟客';
  };
  var renderCustomersView = function () {
    if (!customersView.data) { loadCustomersView(); return; }
    customersView.expanded = {};
    var all = customersView.data.customers || [];
    var html = pageHead('熟客与叫法', '维护熟客的口语叫法和最近历史成交价，只影响以后录单认人。', badge('只读历史', 'info'));
    html += '<section class="card"><div class="card-head"><div><h2>熟客档案</h2>' +
      '<p>这里维护熟客口语叫法，只影响以后录单认人，绝不改动历史正式送货单。</p></div></div>' +
      '<div class="filter-bar"><input id="customer-search" class="text-input grow" value="' + esc(customersView.search) +
      '" placeholder="按店名或叫法搜索" autocomplete="off"><span class="muted" id="customerCount">当前显示 ' +
      filteredCustomers().length + ' 位熟客</span></div>' +
      '<div id="customerList">' + (all.length ? filteredCustomers().map(customerCardHtml).join('') : notice('还没有熟客档案。等配送员出过正式单后，这里会自动出现。')) + '</div></section>';
    viewRoot().innerHTML = html;
  };
  var loadCustomersView = function (accountId) {
    var account = current();
    if (!account) {
      viewRoot().innerHTML = emptyCard('还没有配送员账号',
        '先到「账号与开通」生成一次性开通码，配送员开通后就能维护熟客叫法。', 'accounts', '去账号与开通');
      return Promise.resolve();
    }
    customersView.data = null;
    viewRoot().innerHTML = loading('正在读取熟客档案与叫法…');
    return request(accountPath(account.id, '/customers')).then(function (data) {
      if (!isCurrent('customers', account.id)) return;
      customersView.data = data;
      renderCustomersView();
    }, function (error) {
      if (isCurrent('customers', account.id)) viewRoot().innerHTML = App.errorCard(error.message);
    });
  };
  views.customers = {
    mount: function () {
      customersView.search = '';
      customersView.prices = {};
      customersView.expanded = {};
      loadCustomersView(state.accountId);
    }
  };

  var pricesTableHtml = function (sales) {
    if (!sales.length) return notice('这位熟客还没有可追溯的已送达成交价。');
    var rows = sales.slice(0, 50).map(function (sale) {
      return '<tr><td>' + esc(fmtDay(sale.issuedAt)) + '</td>' +
        '<td>' + esc(sale.productName) + '<span class="line-sub">' +
        esc([sale.brand, sale.spec].filter(Boolean).join(' · ') || '—') + '</span></td>' +
        '<td>' + esc(sale.unit || '—') + '</td><td class="num">' + esc(sale.receivedQuantity) + '</td>' +
        '<td class="num"><span class="money">' + moneyText(sale.unitPriceCents) + '</span></td></tr>';
    }).join('');
    return '<div class="table-wrap"><table class="compact-table"><thead><tr><th>日期</th><th>品名 / 品牌规格</th>' +
      '<th>单位</th><th class="num">实收数量</th><th class="num">成交单价</th></tr></thead><tbody>' + rows +
      '</tbody></table></div>' + (sales.length > 50
        ? '<p class="field-hint">仅展示最近 50 条，共 ' + sales.length + ' 条已送达成交记录。</p>' : '') +
      '<p class="field-hint">AI 认熟客时会优先参考这里最近的成交单价，所以显示为「熟客价」。历史正式单只读。</p>';
  };
  var toggleCustomerPrices = function (customerId, button) {
    var targetAccountId = state.accountId;
    var box = el('customerPrices-' + customerId);
    if (!box) return;
    if (customersView.expanded[customerId]) {
      customersView.expanded[customerId] = false;
      box.classList.add('hidden');
      button.textContent = '查看历史成交价 ▾';
      return;
    }
    customersView.expanded[customerId] = true;
    box.classList.remove('hidden');
    button.textContent = '收起历史成交价 ▴';
    if (customersView.prices[customerId]) {
      box.innerHTML = pricesTableHtml(customersView.prices[customerId]);
      return;
    }
    box.innerHTML = '<div class="loading-inline">正在读取最近历史成交价…</div>';
    request(accountPath(targetAccountId, '/customers/' + encodeURIComponent(customerId) + '/prices')).then(function (data) {
      if (!isCurrent('customers', targetAccountId)) return;
      var sales = data && Array.isArray(data.sales) ? data.sales : [];
      customersView.prices[customerId] = sales;
      var target = el('customerPrices-' + customerId);
      if (target) target.innerHTML = pricesTableHtml(sales);
    }, function (error) {
      if (!isCurrent('customers', targetAccountId)) return;
      var target = el('customerPrices-' + customerId);
      if (target) target.innerHTML = '<div class="modal-error">' + esc(error.message) + '</div>';
    });
  };
  var aliasDialog = function (customerId, customerName) {
    var targetAccountId = state.accountId;
    var flow = { customerId: customerId, conflict: null, attemptedAlias: '' };
    openModal({
      title: '给熟客加一个叫法',
      bodyHtml: '<p>给 <b>' + esc(customerName) + '</b> 加一个客户常用叫法，例如「老李」「李记」。</p>' +
        '<label class="field" for="customerAliasInput"><span class="field-label">叫法</span>' +
        '<input id="customerAliasInput" class="text-input" maxlength="200" autocomplete="off" placeholder="例如：老李">' +
        '<span class="field-hint">只影响以后录单认人，不会改历史正式送货单。</span></label>' +
        '<div id="customerAliasConflict" class="hidden"></div>' +
        '<div class="modal-error" id="customerAliasError"></div>',
      confirmText: '添加叫法',
      confirmTone: 'primary',
      onConfirm: function () {
        if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
        var input = el('customerAliasInput');
        var value = input ? input.value.trim() : '';
        var errorNode = el('customerAliasError');
        if (!value) {
          if (errorNode) errorNode.textContent = '请填写叫法。';
          return false;
        }
        if (errorNode) errorNode.textContent = '';
        var body = { customerId: customerId, alias: value };
        if (flow.conflict && flow.attemptedAlias === value) {
          var ack = el('customerAliasAck');
          if (!ack || !ack.checked) {
            if (errorNode) errorNode.textContent = '请先勾选确认，再添加这个有冲突的叫法。';
            return false;
          }
          if (flow.conflict === 'customer_name_conflict') body.allowCanonicalConflict = true;
          else body.allowRebind = true;
        } else {
          flow.conflict = null;
        }
        return request(accountPath(targetAccountId, '/customer-aliases'), { method: 'POST', body: body })
          .then(function () {
            toast('已给「' + customerName + '」加上叫法「' + value + '」。', 'success');
            if (state.accountId !== targetAccountId) return;
            return loadCustomersView(targetAccountId);
          }, function (error) {
            if (state.accountId !== targetAccountId) return false;
            if (error.status === 409 && (error.code === 'customer_alias_conflict' || error.code === 'customer_name_conflict')) {
              flow.conflict = error.code;
              flow.attemptedAlias = value;
              var box = el('customerAliasConflict');
              if (box) {
                box.classList.remove('hidden');
                box.innerHTML = '<div class="modal-warn">' +
                  esc(error.code === 'customer_name_conflict'
                    ? '这个叫法和其他熟客的正式店名相同，确认是当前这位熟客的叫法吗？'
                    : '这个叫法已经绑在另一位熟客名下，确认要强制换绑到当前熟客吗？') +
                  '</div><label class="checkbox-row"><input type="checkbox" id="customerAliasAck">' +
                  '我确认这是当前熟客的叫法，允许继续</label>';
              }
              var confirm = document.querySelector('#modalRoot [data-modal-confirm]');
              if (confirm) confirm.textContent = '确认并添加叫法';
              return false;
            }
            throw error;
          });
      }
    });
  };
  var removeAliasDialog = function (customerId, alias) {
    var targetAccountId = state.accountId;
    openModal({
      title: '删除这个叫法？',
      bodyHtml: '<p>将从熟客档案里删除叫法 <b>' + esc(alias) + '</b>。</p>' +
        '<p class="modal-note">只影响以后录单认人，历史正式送货单和已经记下的熟客关系都不会改变。</p>',
      confirmText: '删除叫法',
      confirmTone: 'danger',
      onConfirm: function () {
        if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
        return request(accountPath(targetAccountId, '/customer-aliases'), {
          method: 'DELETE', body: { customerId: customerId, alias: alias }
        }).then(function () {
          toast('已删除叫法「' + alias + '」。', 'success');
          if (state.accountId !== targetAccountId) return;
          return loadCustomersView(targetAccountId);
        });
      }
    });
  };

  /* ================= 模块 5A：对话质检 ================= */

  var qualityView = {
    filter: 'attention', days: '7', highlightTurnId: '', scopeId: '',
    turns: null, fallbackTried: false
  };
  var qualityFilters = [
    ['attention', '需关注'], ['failed', '出错/中断'], ['unpriced', '没配上价'],
    ['question', '有追问/选款'], ['undone', '被撤回'], ['all', '全部回合']
  ];
  var eventOfKinds = function (turn, kinds) {
    var events = turn.events || [];
    return events.filter(function (event) { return kinds.indexOf(event.kind) >= 0; });
  };
  var lastEvent = function (turn, kind) {
    var events = (turn.events || []).filter(function (event) { return event.kind === kind; });
    return events.length ? events[events.length - 1] : null;
  };
  function voiceEventOf(turn) {
    var events = turn.events || [];
    for (var index = 0; index < events.length; index++) {
      if (events[index].kind === 'voice_correction') return events[index];
    }
    return null;
  }
  var turnElapsed = function (turn) {
    return typeof turn.elapsedMs === 'number' && isFinite(turn.elapsedMs)
      ? (turn.elapsedMs / 1000).toFixed(1) + 's' : '—';
  };
  var turnOutcome = function (turn) {
    if (turn.status === 'failed') return { label: '出错', tone: 'bad' };
    if (turn.status === 'interrupted') return { label: '中断', tone: 'bad' };
    if (turn.status === 'running') return { label: '处理中', tone: 'warn' };
    if (turn.undone) return { label: '被撤回', tone: 'neutral' };
    if (turn.mistakeStatus) return { label: '已记错题', tone: 'info' };
    if (lastEvent(turn, 'delivery_proposal')) return { label: '现场提案', tone: 'warn' };
    if (turn.question) return { label: '有追问', tone: 'warn' };
    if (turn.unpriced) return { label: '没配上价', tone: 'warn' };
    return { label: '已更新草稿', tone: 'ok' };
  };
  var intentSummary = function (turn) {
    var delivery = lastEvent(turn, 'delivery_proposal') || lastEvent(turn, 'delivery_intent');
    var tool = lastEvent(turn, 'tool');
    var outcome = tool && tool.payload && tool.payload.result ? tool.payload.result.outcome : null;
    var lines = [];
    if (delivery) {
      lines.push('这是送货现场核对，AI 先判断要改哪家店、哪一行，再给出' + "'现场提案'" + '。');
    } else if (turn.question) {
      lines.push('AI 判断为录单或改单，但有几处需要你补充或选款。');
    } else if (turn.status === 'failed' || turn.status === 'interrupted') {
      lines.push('AI 在判断或处理途中没有完成，这一轮需要重试或排查。');
    } else {
      lines.push('AI 判断为录单 / 改单，并尝试更新当前草稿。');
    }
    if (outcome === 'questions') {
      lines.push('<span class="badge warn">需要你补充信息</span>');
    } else if (outcome === 'issues') {
      lines.push('<span class="badge warn">有几处要核对</span>');
    } else if (outcome === 'error') {
      lines.push('<span class="badge bad">工具执行出错</span>');
    }
    var plan = lastEvent(turn, 'plan');
    if (plan && plan.payload && Array.isArray(plan.payload.steps)) {
      var stepTexts = plan.payload.steps.map(function (step) { return step.text; }).filter(Boolean);
      if (stepTexts.length) lines.push('<span class="line-sub">计划：' + stepTexts.map(esc).join(' → ') + '</span>');
    }
    return lines.join(' ');
  };
  var turnDetailLines = function (turn) {
    var lines = [];
    var events = turn.events || [];
    events.forEach(function (event) {
      if (event.kind === 'change' && event.payload && Array.isArray(event.payload.lines)) {
        event.payload.lines.forEach(function (line) { lines.push(line); });
      }
      if (event.kind === 'tool' && event.payload && event.payload.result) {
        var result = event.payload.result;
        if (Array.isArray(result.lines)) result.lines.forEach(function (line) { lines.push(line); });
        if (Array.isArray(result.questions)) result.questions.forEach(function (question) {
          lines.push((question.customer ? question.customer + '：' : '') + question.text);
        });
        if (Array.isArray(result.customerLinks)) result.customerLinks.forEach(function (link) {
          lines.push('认出熟客「' + link.spoken + '」→「' + link.canonicalName + '」');
        });
      }
      if (event.kind === 'questions' && event.payload && Array.isArray(event.payload.questions)) {
        event.payload.questions.forEach(function (question) {
          lines.push((question.customer ? question.customer + '：' : '') + question.text);
        });
      }
    });
    return lines.filter(Boolean).slice(0, 20);
  };
  var guardrailHtml = function (turn) {
    var lines = [];
    (turn.events || []).forEach(function (event) {
      if (event.kind !== 'tool' || !event.payload || !event.payload.result) return;
      var result = event.payload.result;
      if (Array.isArray(result.catalog)) result.catalog.forEach(function (line) { lines.push(line); });
    });
    var html = '';
    if (lines.length) {
      html += '<ul class="timeline-list">' + lines.slice(0, 20).map(function (line) {
        var source = line.priceSource ? (priceSourceLabel[line.priceSource] || '手动价') : '留空待补价';
        var price = line.price === null || line.price === undefined
          ? '<span class="badge warn">留空待补价</span>' : '<span class="money">¥' + esc(line.price) + '</span>';
        var flags = badge(source, line.priceSource === 'customer_history' ? 'info' : 'ok');
        if (line.status === 'discontinued') flags += badge('已下架', 'warn');
        if (line.matchMethod === 'homophone') flags += badge('同音纠偏', 'info');
        if (line.priceHint) flags += '<span class="line-sub">' + esc(line.priceHint) + '</span>';
        return '<li><b>' + esc(line.product || '未命名货品') + '</b> ' + price + ' ' + flags + '</li>';
      }).join('') + '</ul>';
    }
    if (turn.unpriced) {
      html += notice('这一轮有明细没配上价：AI 会留空等你补价，不会把价格算成 ¥0.00。', true);
    }
    if (!html) html = '<p class="muted">这一轮没有需要留空或选款的货品，草稿按正常护栏通过。</p>';
    return html;
  };
  var techDetailsHtml = function (turn) {
    var models = (turn.events || []).filter(function (event) { return event.kind === 'model'; });
    var rows = models.map(function (event) {
      var payload = event.payload || {};
      var toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
      return '<div class="tech-row"><b>' + esc(payload.model || '模型调用') + '</b>' +
        '<span class="line-sub">' + esc(payload.promptVersion || '—') + ' · ' + esc(payload.outcome || '—') +
        ' · 耗时 ' + num(payload.elapsedMs) + 'ms · 输入 ' + num(payload.inputTokens) + ' Token · 输出 ' +
        num(payload.outputTokens) + ' Token</span>' +
        (toolCalls.length ? '<span class="line-sub">工具：' + toolCalls.map(function (call) {
          return esc(call.name || '工具');
        }).join('、') + '</span>' : '') + '</div>';
    }).join('');
    return '<details class="soft-details"><summary>开发者技术详情（查看原始技术报文） ▸</summary>' +
      (rows ? '<div class="tech-list">' + rows + '</div>' : '<p class="field-hint">这一轮没有记录模型调用。</p>') +
      '<pre class="prompt-text">' + esc(JSON.stringify(turn.events || [], null, 2)) + '</pre></details>';
  };
  var materialThumbsHtml = function (materials) {
    if (!materials || !materials.length) return '';
    return '<div class="chat-thumbs">' + materials.map(function (material) {
      return '<span class="chat-thumb" data-quality-material-id="' + esc(material.id) +
        '" data-quality-material-name="' + esc(material.name || '原图') + '">图片加载中…</span>';
    }).join('') + '</div>';
  };
  var fillQualityThumbs = function (root) {
    var accountId = state.accountId;
    Array.prototype.forEach.call(root.querySelectorAll('[data-quality-material-id]'), function (node) {
      var id = node.getAttribute('data-quality-material-id');
      var name = node.getAttribute('data-quality-material-name') || '原图';
      App.loadMaterialUrl(accountId, id).then(function (url) {
        if (state.accountId !== accountId) return;
        node.innerHTML = '';
        var image = document.createElement('img');
        image.src = url;
        image.alt = name;
        image.loading = 'lazy';
        image.addEventListener('click', function () { App.openLightbox(url, name); });
        node.appendChild(image);
      }, function (error) {
        node.textContent = error && error.message ? error.message : '图片加载失败';
        node.classList.add('muted');
      });
    });
  };
  var qualityCardHtml = function (turn) {
    var outcome = turnOutcome(turn);
    var voice = voiceEventOf(turn);
    var details = turnDetailLines(turn);
    var highlight = qualityView.highlightTurnId === turn.id ? ' highlight' : '';
    var html = '<article class="quality-card' + highlight + '" id="quality-turn-' + esc(turn.id) + '">' +
      '<div class="quality-head"><div class="quality-meta"><span class="cell-main">' + esc(fmtTime(turn.createdAt)) +
      '</span><span class="line-sub">耗时 ' + esc(turnElapsed(turn)) + '</span></div>' +
      '<div class="quality-badges">' + badge(outcome.label, outcome.tone) +
      (turn.mistakeStatus ? badge(turn.mistakeStatus === 'open' ? '错题待修复' : '错题已修复', 'neutral') : '') +
      '</div><div class="row-actions">' +
      (turn.mistakeStatus
        ? '<button type="button" class="btn btn-small" data-nav="mistakes" data-status="' +
          (turn.mistakeStatus === 'open' ? 'open' : 'all') + '">查看错题 ›</button>'
        : '<button type="button" class="btn btn-small btn-primary-outline" data-mistake-add="' + esc(turn.id) + '">记为错题</button>') +
      '<button type="button" class="btn btn-small" data-quality-case="' + esc(turn.id) + '">复制回合 Case</button>' +
      '</div></div>';
    html += '<div class="quality-chat"><div class="chat-row user"><span class="chat-avatar">配送</span>' +
      '<div class="chat-bubble"><div class="chat-text">' +
      (str(turn.userText).trim() ? esc(turn.userText) : '<span class="muted">（这一轮没有留下文字）</span>') +
      '</div>' + materialThumbsHtml(turn.materials) + '</div></div>' +
      '<div class="chat-row assistant"><span class="chat-avatar">AI</span><div class="chat-bubble"><div class="chat-text">' +
      esc(turn.assistantText || '（这一轮没有助手回复）') + '</div></div></div></div>';
    html += '<div class="timeline-bar">' +
      '<div class="timeline-step"><span class="timeline-dot">1</span><div class="timeline-body"><b>① 收到原话</b>' +
      (voice
        ? '<div class="voice-compare"><div class="voice-side"><span class="line-sub">语音原转写</span><p>' +
          esc(voice.payload && voice.payload.rawText) + '</p></div><div class="voice-arrow">→</div>' +
          '<div class="voice-side"><span class="line-sub">纠偏后提交</span><p>' +
          esc((voice.payload && voice.payload.text) || turn.userText) + '</p></div>' +
          '<div class="voice-words">' + (Array.isArray(voice.payload && voice.payload.corrections)
            ? voice.payload.corrections.map(function (correction) {
              return '<span class="badge info">' + esc(correction.from) + ' → ' + esc(correction.to) + '</span>';
            }).join('') : '') + '</div></div>'
        : '<p class="muted">' + (str(turn.userText).trim() ? '收到并读取了这段文字。' : '这一轮主要靠图片或选项输入。') + '</p>') +
      '</div></div>' +
      '<div class="timeline-step"><span class="timeline-dot">2</span><div class="timeline-body"><b>② 判定意图</b>' +
      '<p>' + intentSummary(turn) + '</p></div></div>' +
      '<div class="timeline-step"><span class="timeline-dot">3</span><div class="timeline-body"><b>③ 拆出明细</b>' +
      (details.length ? '<ul class="timeline-list">' + details.map(function (line) {
        return '<li>' + esc(line) + '</li>';
      }).join('') + '</ul>' : '<p class="muted">这一轮没有新增或修改明细。</p>') + '</div></div>' +
      '<div class="timeline-step"><span class="timeline-dot">4</span><div class="timeline-body"><b>④ 查库/护栏结果</b>' +
      guardrailHtml(turn) + '</div></div></div>';
    html += techDetailsHtml(turn) + '</article>';
    return html;
  };
  var renderQuality = function (accountId, turns) {
    if (!isCurrent('quality', accountId)) return;
    var html = pageHead('对话质检', '用 4 步人话因果故事查看 AI 每轮做了什么，技术日志统一折叠。', badge('只读排障', 'info'));
    html += '<section class="card"><div class="card-head"><div><h2>筛选要看的回合</h2>' +
      '<p>默认只显示需关注的回合；点「全部回合」可以回看所有记录。</p></div></div>' +
      '<div class="filter-bar"><div class="filter-pills">' + qualityFilters.map(function (pair) {
        return '<button type="button" class="pill-filter' + (qualityView.filter === pair[0] ? ' active' : '') +
          '" data-quality-filter="' + pair[0] + '">' + pair[1] + '</button>';
      }).join('') + '</div>' +
      '<select id="quality-days" class="select"><option value="7"' + (qualityView.days === '7' ? ' selected' : '') +
      '>近 7 天</option><option value="30"' + (qualityView.days === '30' ? ' selected' : '') +
      '>近 30 天</option><option value="all"' + (qualityView.days === 'all' ? ' selected' : '') +
      '>全部</option></select></div>' +
      (qualityView.scopeId ? notice('已从所属趟次带入定位，会优先高亮你点的那一轮。') : '') +
      (qualityView.highlightTurnId && !turns.some(function (turn) { return turn.id === qualityView.highlightTurnId; })
        ? notice('当前筛选里没有找到要定位的那一轮，已自动切到「全部回合 / 全部时间」兜底查找。', true) : '') +
      '</section>';
    html += turns.length ? turns.map(qualityCardHtml).join('') : emptyCard('这个筛选下没有对话回合',
      '可以切到「全部回合」看看，或者换一个时间范围。');
    viewRoot().innerHTML = html;
    fillQualityThumbs(viewRoot());
    if (qualityView.highlightTurnId) {
      setTimeout(function () {
        var node = el('quality-turn-' + qualityView.highlightTurnId);
        if (!node) return;
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.add('highlight');
      }, 40);
    }
  };
  var loadQuality = function (accountId) {
    var account = current();
    if (!account) {
      viewRoot().innerHTML = emptyCard('还没有配送员账号',
        '先到「账号与开通」生成一次性开通码，配送员开通后就能查看 AI 对话。', 'accounts', '去账号与开通');
      return Promise.resolve();
    }
    var filter = qualityView.filter;
    var days = qualityView.days;
    viewRoot().innerHTML = loading('正在读取最近对话与 AI 处理过程…');
    var path = accountPath(account.id, '/quality-turns?filter=' + encodeURIComponent(filter) +
      '&days=' + encodeURIComponent(days));
    return request(path).then(function (data) {
      if (!isCurrent('quality', account.id)) return;
      var turns = data && Array.isArray(data.turns) ? data.turns : [];
      qualityView.turns = turns;
      var found = !qualityView.highlightTurnId || turns.some(function (turn) {
        return turn.id === qualityView.highlightTurnId;
      });
      if (!found && !qualityView.fallbackTried) {
        qualityView.fallbackTried = true;
        qualityView.filter = 'all';
        qualityView.days = 'all';
        state.qualityFilter = { filter: 'all', highlightTurnId: qualityView.highlightTurnId, scopeId: qualityView.scopeId };
        return loadQuality(account.id);
      }
      renderQuality(account.id, turns);
    }, function (error) {
      if (isCurrent('quality', account.id)) viewRoot().innerHTML = App.errorCard(error.message);
    });
  };
  views.quality = {
    mount: function () {
      var filter = state.qualityFilter || {};
      qualityView.filter = filter.filter || 'attention';
      qualityView.days = '7';
      qualityView.highlightTurnId = filter.highlightTurnId || '';
      qualityView.scopeId = filter.scopeId || '';
      qualityView.fallbackTried = false;
      loadQuality(state.accountId);
    }
  };

  var openMistakeDialog = function (turn) {
    var targetAccountId = state.accountId;
    var categories = ['货品认错', '漏行多行', '价格没配上', '客户认错', '语音听错', '其他'];
    openModal({
      title: '把这一轮记为错题',
      bodyHtml: '<p>选一个最贴近的错因，再写清楚你期望 AI 下次怎么录。记录会冻结当前内容，方便以后回放。</p>' +
        '<div class="radio-pills">' + categories.map(function (category) {
          return '<label class="radio-pill"><input type="radio" name="mistakeCategory" value="' + esc(category) + '"' +
            (category === '货品认错' ? ' checked' : '') + '> ' + esc(category) + '</label>';
        }).join('') + '</div>' +
        textarea('期望的正确结果（必填）', 'mistakeExpected', '',
          '用大白话写希望 AI 怎么录，例如：应录成安井鱼豆腐 2 箱，单价 82 元。', 3) +
        textarea('备注（可选）', 'mistakeNote', '', '补充说明，例如客户原话里还提到了什么。', 2) +
        '<label class="checkbox-row"><input type="checkbox" id="mistakeIncludeCatalog" checked> ' +
        '同时冻结当前货品库快照（推荐，方便总指挥精准回放）</label>' +
        '<div class="modal-error" id="mistakeError"></div>',
      confirmText: '保存到错题本',
      confirmTone: 'primary',
      onConfirm: function () {
        if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
        var picked = document.querySelector('#modalRoot input[name="mistakeCategory"]:checked');
        var expected = el('mistakeExpected') ? el('mistakeExpected').value.trim() : '';
        var errorNode = el('mistakeError');
        if (!picked) {
          if (errorNode) errorNode.textContent = '请选择一个错因。';
          return false;
        }
        if (!expected) {
          if (errorNode) errorNode.textContent = '请填写期望的正确结果。';
          return false;
        }
        if (errorNode) errorNode.textContent = '';
        return request(accountPath(targetAccountId, '/mistakes'), {
          method: 'POST',
          body: {
            turnId: turn.id,
            category: picked.value,
            expectedOutcome: expected,
            note: el('mistakeNote') ? el('mistakeNote').value.trim() : '',
            includeCatalog: el('mistakeIncludeCatalog') ? el('mistakeIncludeCatalog').checked : true
          }
        }).then(function () {
          toast('已记入错题本，可在错题本里继续处理。', 'success');
          App.loadAccounts().catch(function () {});
          if (state.accountId !== targetAccountId) return;
          return loadQuality(targetAccountId);
        });
      }
    });
  };
  var copyTurnCase = function (turnId) {
    var targetAccountId = state.accountId;
    request(accountPath(targetAccountId, '/turns/' + encodeURIComponent(turnId) + '/eval-case?catalog=1')).then(function (data) {
      if (!isCurrent('quality', targetAccountId)) return;
      copyText(JSON.stringify(data, null, 2), '已复制这一轮的回合 Case JSON（如需脱敏冻结请先点“记为错题”）。');
    }, function (error) {
      if (!isCurrent('quality', targetAccountId)) return;
      toast(error.message, 'error');
    });
  };

  /* ================= 模块 5B：错题本 ================= */

  var mistakesView = { status: 'open', list: null };
  var mistakeStatusLabel = { open: '待修复', resolved: '已修复' };
  var mistakesFilters = [['open', '待修复'], ['resolved', '已修复'], ['all', '全部']];
  var mistakeCardHtml = function (mistake) {
    var status = mistake.status === 'resolved' ? 'resolved' : 'open';
    return '<article class="mistake-card"><div class="card-head"><div><span class="badge info">' +
      esc(mistake.category) + '</span> ' + badge(mistakeStatusLabel[status], status === 'open' ? 'warn' : 'ok') +
      '<span class="line-sub">记录于 ' + esc(fmtTime(mistake.createdAt)) + '</span></div>' +
      '<div class="row-actions">' +
      '<button type="button" class="btn btn-small btn-primary-outline" data-mistake-status="' + esc(mistake.turnId) +
      '" data-mistake-next="' + (status === 'open' ? 'resolved' : 'open') + '">' +
      (status === 'open' ? '标为已修复' : '重开为待修复') + '</button>' +
      '<button type="button" class="btn btn-small" data-mistake-edit="' + esc(mistake.turnId) + '">编辑备注/期望</button>' +
      '<button type="button" class="btn btn-small" data-mistake-copy="' + esc(mistake.turnId) + '">复制脱敏 Case</button>' +
      '<button type="button" class="btn btn-small" data-mistake-download="' + esc(mistake.turnId) + '">下载 Case JSON</button>' +
      '</div></div>' +
      '<div class="quote-box"><span class="section-kicker">原始报单预览</span><p>' +
      esc(mistake.userTextPreview || '（这轮没有留下文字，可能是图片单）') + '</p>' +
      (mistake.hasImages ? badge('含图片', 'neutral') : '') + '</div>' +
      '<div class="expected-box"><span class="section-kicker">期望的正确结果</span><p>' +
      esc(mistake.expectedOutcome) + '</p></div>' +
      (mistake.note ? '<div class="note-box"><span class="section-kicker">备注</span><p>' + esc(mistake.note) + '</p></div>' : '') +
      '</article>';
  };
  var renderMistakesView = function () {
    if (!mistakesView.list) { loadMistakesView(); return; }
    var list = mistakesView.list;
    var html = pageHead('错题本', '把 AI 录错的话收进错题本，写清期望结果并导出脱敏 Case。', badge('内部复盘', 'info'));
    html += '<section class="card"><div class="card-head"><div><h2>已冻结的 AI 错题</h2>' +
      '<p>这里存放已冻结脱敏的 AI 错题，可一键复制或下载标准 Case JSON 发给总指挥回放修复。</p></div></div>' +
      '<div class="filter-bar"><div class="filter-pills">' + mistakesFilters.map(function (pair) {
        return '<button type="button" class="pill-filter' + (mistakesView.status === pair[0] ? ' active' : '') +
          '" data-mistake-filter="' + pair[0] + '">' + pair[1] + '</button>';
      }).join('') + '</div></div>' +
      (list.length ? list.map(mistakeCardHtml).join('') : emptyCard('这个状态下的错题本还是空的',
        '去「对话质检」里把 AI 录错的回合记进来，就能在这里集中修复。')) +
      '</section>';
    viewRoot().innerHTML = html;
  };
  var loadMistakesView = function (accountId) {
    var account = current();
    if (!account) {
      viewRoot().innerHTML = emptyCard('还没有配送员账号',
        '先到「账号与开通」生成一次性开通码，配送员开通后就能积累错题。', 'accounts', '去账号与开通');
      return Promise.resolve();
    }
    mistakesView.list = null;
    viewRoot().innerHTML = loading('正在读取错题本…');
    return request(accountPath(account.id, '/mistakes?status=' + encodeURIComponent(mistakesView.status)))
      .then(function (data) {
        if (!isCurrent('mistakes', account.id)) return;
        mistakesView.list = data && Array.isArray(data.mistakes) ? data.mistakes : [];
        renderMistakesView();
      }, function (error) {
        if (isCurrent('mistakes', account.id)) viewRoot().innerHTML = App.errorCard(error.message);
      });
  };
  views.mistakes = {
    mount: function () {
      var filter = state.mistakesFilter || {};
      mistakesView.status = filter.status === 'resolved' ? 'resolved' : filter.status === 'all' ? 'all' : 'open';
      loadMistakesView(state.accountId);
    }
  };

  var patchMistake = function (turnId, body, message, accountId) {
    var targetAccountId = accountId || state.accountId;
    if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
    return request(accountPath(targetAccountId, '/mistakes/' + encodeURIComponent(turnId)), {
      method: 'PATCH', body: body
    }).then(function () {
      toast(message, 'success');
      App.loadAccounts().catch(function () {});
      if (state.accountId !== targetAccountId) return;
      return loadMistakesView(targetAccountId);
    });
  };
  var openMistakeEdit = function (mistake) {
    var targetAccountId = state.accountId;
    var categories = ['货品认错', '漏行多行', '价格没配上', '客户认错', '语音听错', '其他'];
    openModal({
      title: '编辑错题备注与期望',
      bodyHtml: '<label class="field" for="mistakeEditCategory"><span class="field-label">错因</span>' +
        '<select id="mistakeEditCategory" class="select">' + categories.map(function (category) {
          return '<option value="' + esc(category) + '"' + (mistake.category === category ? ' selected' : '') + '>' +
            esc(category) + '</option>';
        }).join('') + '</select></label>' +
        textarea('期望的正确结果（必填）', 'mistakeEditExpected', mistake.expectedOutcome, '', 3) +
        textarea('备注（可选）', 'mistakeEditNote', mistake.note || '', '', 2) +
        '<div class="modal-error" id="mistakeEditError"></div>',
      confirmText: '保存修改',
      confirmTone: 'primary',
      onConfirm: function () {
        if (state.accountId !== targetAccountId) throw new Error('当前查看的配送员已切换，请重新操作');
        var expected = el('mistakeEditExpected') ? el('mistakeEditExpected').value.trim() : '';
        if (!expected) {
          var errorNode = el('mistakeEditError');
          if (errorNode) errorNode.textContent = '期望的正确结果不能为空。';
          return false;
        }
        return patchMistake(mistake.turnId, {
          category: el('mistakeEditCategory') ? el('mistakeEditCategory').value : mistake.category,
          expectedOutcome: expected,
          note: el('mistakeEditNote') ? el('mistakeEditNote').value.trim() : ''
        }, '错题已更新。', targetAccountId);
      }
    });
  };

  /* ================= 事件绑定 ================= */

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!target) return;
    if (target.id === 'catalog-search' && isCurrent('catalog')) {
      catalogView.search = target.value;
      renderCatalogRows();
    }
    if (target.id === 'catalog-query-text' && isCurrent('catalog')) {
      catalogView.queryText = target.value;
    }
    if (target.id === 'customer-search' && isCurrent('customers')) {
      customersView.search = target.value;
      renderCustomerList();
    }
  });
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target) return;
    if (target.id === 'catalog-category' && isCurrent('catalog')) {
      catalogView.category = target.value;
      renderCatalogRows();
    }
    if (target.id === 'quality-days' && isCurrent('quality')) {
      qualityView.days = target.value;
      loadQuality(state.accountId);
    }
    if (target.id === 'catalogCsvFile') readCatalogCsvFile(target);
  });
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var node;
    node = target.closest('[data-catalog-status]');
    if (node && isCurrent('catalog')) {
      catalogView.status = node.getAttribute('data-catalog-status');
      renderCatalogRows();
      return;
    }
    if (target.closest('[data-catalog-add]') && isCurrent('catalog')) {
      openCatalogEditor(null);
      return;
    }
    if (target.closest('[data-catalog-upload]') && isCurrent('catalog')) {
      openCatalogCsvModal();
      return;
    }
    if (target.closest('[data-catalog-export]') && isCurrent('catalog')) {
      var exportAccountId = state.accountId;
      downloadFile(accountPath(exportAccountId, '/catalog/export.csv'), '货品库.csv', function () {
        return isCurrent('catalog', exportAccountId);
      }).catch(function (error) {
        toast(error.message, 'error');
      });
      return;
    }
    if (target.closest('[data-catalog-repreview]') && isCurrent('catalog')) {
      previewCatalogCsv();
      return;
    }
    node = target.closest('[data-catalog-edit]');
    if (node && isCurrent('catalog')) {
      var variant = catalogVariantById(node.getAttribute('data-catalog-edit'));
      if (variant) openCatalogEditor(variant);
      return;
    }
    node = target.closest('[data-catalog-toggle]');
    if (node && isCurrent('catalog')) {
      var toggled = catalogVariantById(node.getAttribute('data-catalog-toggle'));
      var toggleAccountId = state.accountId;
      if (toggled) toggleCatalogVariant(toggled, toggleAccountId);
      return;
    }
    if (target.closest('[data-catalog-query]') && isCurrent('catalog')) {
      var reqAccountId = state.accountId;
      var reqSeq = ++catalogQuerySeq;
      var text = el('catalog-query-text') ? el('catalog-query-text').value.trim() : '';
      var customerId = el('catalog-query-customer') ? el('catalog-query-customer').value : '';
      var body = {};
      if (text) body.query = text;
      else {
        body.product = el('catalog-query-product') ? el('catalog-query-product').value.trim() : '';
        body.brand = el('catalog-query-brand') ? el('catalog-query-brand').value.trim() : '';
        body.specification = el('catalog-query-spec') ? el('catalog-query-spec').value.trim() : '';
        body.unit = el('catalog-query-unit') ? el('catalog-query-unit').value.trim() : '';
        if (!body.product) {
          toast('请输入一句客户原话，或至少填写品名。', 'error');
          return;
        }
      }
      if (customerId) body.customerId = customerId;
      var resultBox = el('catalog-query-result');
      if (resultBox) resultBox.innerHTML = '<div class="loading-inline">正在按当前货品库试查…</div>';
      request(accountPath(reqAccountId, '/catalog/test-query'), { method: 'POST', body: body })
        .then(function (result) {
          if (!isCurrent('catalog') || state.accountId !== reqAccountId || reqSeq !== catalogQuerySeq) return;
          catalogView.queryResult = result;
          renderCatalogQuery();
        }, function (error) {
          if (!isCurrent('catalog') || state.accountId !== reqAccountId || reqSeq !== catalogQuerySeq) return;
          if (resultBox) resultBox.innerHTML = '<div class="error-card inline"><h2>试查没有完成</h2><p>' +
            esc(error.message) + '</p></div>';
        });
      return;
    }
    node = target.closest('[data-customer-alias-add]');
    if (node && isCurrent('customers')) {
      aliasDialog(node.getAttribute('data-customer-alias-add'), node.getAttribute('data-customer-name') || '这位熟客');
      return;
    }
    node = target.closest('[data-customer-alias-remove]');
    if (node && isCurrent('customers')) {
      removeAliasDialog(node.getAttribute('data-customer-alias-remove'), node.getAttribute('data-customer-alias') || '');
      return;
    }
    node = target.closest('[data-customer-prices]');
    if (node && isCurrent('customers')) {
      toggleCustomerPrices(node.getAttribute('data-customer-prices'), node);
      return;
    }
    node = target.closest('[data-quality-filter]');
    if (node && isCurrent('quality')) {
      qualityView.filter = node.getAttribute('data-quality-filter');
      qualityView.fallbackTried = false;
      state.qualityFilter = { filter: qualityView.filter, highlightTurnId: qualityView.highlightTurnId, scopeId: qualityView.scopeId };
      loadQuality(state.accountId);
      return;
    }
    node = target.closest('[data-quality-case]');
    if (node && isCurrent('quality')) {
      copyTurnCase(node.getAttribute('data-quality-case'));
      return;
    }
    node = target.closest('[data-mistake-add]');
    if (node && isCurrent('quality')) {
      var turn = (qualityView.turns || []).filter(function (item) {
        return item.id === node.getAttribute('data-mistake-add');
      })[0];
      if (turn) openMistakeDialog(turn);
      return;
    }
    node = target.closest('[data-mistake-filter]');
    if (node && isCurrent('mistakes')) {
      mistakesView.status = node.getAttribute('data-mistake-filter');
      state.mistakesFilter = { status: mistakesView.status };
      loadMistakesView(state.accountId);
      return;
    }
    node = target.closest('[data-mistake-status]');
    if (node && isCurrent('mistakes')) {
      var next = node.getAttribute('data-mistake-next');
      var statusAccountId = state.accountId;
      try {
        patchMistake(node.getAttribute('data-mistake-status'), { status: next },
          next === 'resolved' ? '已标为修复。' : '已重开为待修复。', statusAccountId);
      } catch (error) {
        toast(error && error.message ? error.message : '操作失败', 'error');
      }
      return;
    }
    node = target.closest('[data-mistake-edit]');
    if (node && isCurrent('mistakes')) {
      var mistake = (mistakesView.list || []).filter(function (item) {
        return item.turnId === node.getAttribute('data-mistake-edit');
      })[0];
      if (mistake) openMistakeEdit(mistake);
      return;
    }
    node = target.closest('[data-mistake-copy]');
    if (node && isCurrent('mistakes')) {
      var copyAccountId = state.accountId;
      request(accountPath(copyAccountId, '/mistakes/' + encodeURIComponent(node.getAttribute('data-mistake-copy')) + '/export'))
        .then(function (data) {
          if (!isCurrent('mistakes', copyAccountId)) return;
          copyText(JSON.stringify(data, null, 2), '已复制脱敏 Case JSON。');
        }, function (error) {
          if (!isCurrent('mistakes', copyAccountId)) return;
          toast(error.message, 'error');
        });
      return;
    }
    node = target.closest('[data-mistake-download]');
    if (node && isCurrent('mistakes')) {
      var turnId = node.getAttribute('data-mistake-download');
      var downloadAccountId = state.accountId;
      downloadFile(accountPath(downloadAccountId, '/mistakes/' + encodeURIComponent(turnId) + '/export'),
        'case-' + String(turnId).slice(0, 8) + '.json', function () {
          return isCurrent('mistakes', downloadAccountId);
        }).catch(function (error) {
        toast(error.message, 'error');
      });
    }
  });
})();
`;
