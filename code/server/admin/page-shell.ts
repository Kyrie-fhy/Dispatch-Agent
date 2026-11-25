export const adminShellHtml = `
<div id="login" class="login-wrap">
  <form id="login-form" class="login-card" autocomplete="off">
    <span class="login-badge">DISPATCH</span>
    <h1>Dispatch 运营与维护后台</h1>
    <p>给配送员用的 AI 录单助手。在这里看清每一趟单据、维护资料、掌握 AI 质量。</p>
    <label class="field-label" for="login-token">管理员口令</label>
    <input id="login-token" type="password" autocomplete="current-password" placeholder="请输入管理员口令" required>
    <button type="submit" id="login-submit" class="btn btn-primary btn-block">进入后台</button>
    <div id="login-error" class="login-error" role="alert"></div>
    <p class="login-foot">口令只保存在本浏览器会话中，关闭标签页即清除。后台默认只允许本机回环访问。</p>
  </form>
</div>
<div id="app" class="app hidden">
  <aside class="sidebar" aria-label="后台导航">
    <div class="side-brand">
      <span class="brand-mark" aria-hidden="true">D</span>
      <div><b>Dispatch</b><span>运营与维护后台</span></div>
    </div>
    <nav class="side-nav">
      <button type="button" class="nav-item" data-nav="dashboard">
        <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg></span><span class="nav-text">首页总览</span>
      </button>
      <div class="nav-group">
        <span class="nav-group-label">日常业务</span>
        <button type="button" class="nav-item" data-nav="trips">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg></span><span class="nav-text">趟次与单据</span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">资料维护</span>
        <button type="button" class="nav-item" data-nav="catalog">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg></span><span class="nav-text">货品与价格库</span>
          <span class="nav-badge warn hidden" id="navBadgeMissing"></span>
        </button>
        <button type="button" class="nav-item" data-nav="customers">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></span><span class="nav-text">熟客与叫法</span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">AI 质量</span>
        <button type="button" class="nav-item" data-nav="quality">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m9 10 2 2 4-4"/></svg></span><span class="nav-text">对话质检</span>
        </button>
        <button type="button" class="nav-item" data-nav="mistakes">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M12 8v4M12 16h.01"/></svg></span><span class="nav-text">错题本</span>
          <span class="nav-badge danger hidden" id="navBadgeMistakes"></span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">系统管理</span>
        <button type="button" class="nav-item" data-nav="accounts">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 8.65-8.65M17 6l2 2M14 9l2 2"/></svg></span><span class="nav-text">账号与开通</span>
        </button>
      </div>
    </nav>
    <div class="side-foot">v2.0 · 只读查账 · 安全维护</div>
  </aside>
  <div class="main-shell">
    <header class="topbar">
      <div class="context" id="topContext">
        <label class="context-label" for="accountSelect">当前查看配送员</label>
        <select id="accountSelect" class="account-select"></select>
        <span id="contextHint" class="context-hint"></span>
      </div>
      <div class="topbar-actions">
        <button type="button" id="themeBtn" class="btn btn-ghost" title="切换浅色 / 深色外观" aria-label="切换外观">
          <span id="themeIcon" class="icon-inline" aria-hidden="true"></span><span class="btn-label-sm" id="themeLabel">外观</span>
        </button>
        <button type="button" id="refreshBtn" class="btn btn-ghost">
          <svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg><span class="btn-label-sm">刷新</span>
        </button>
        <button type="button" id="logoutBtn" class="btn btn-ghost">退出后台</button>
      </div>
    </header>
    <main id="view" tabindex="-1"></main>
  </div>
</div>
<div id="modalRoot" class="modal-root hidden"></div>
<div id="lightbox" class="lightbox hidden" role="dialog" aria-modal="true" aria-label="原图放大">
  <div class="lightbox-inner">
    <img id="lightboxImg" alt="原图放大预览">
    <div id="lightboxCaption" class="lightbox-caption"></div>
  </div>
  <button type="button" id="lightboxClose" class="lightbox-close" aria-label="关闭原图">×</button>
</div>
<div id="toastStack" class="toast-stack" aria-live="polite" aria-atomic="false"></div>
`;

export const adminShellScript = `
(function () {
  'use strict';
  var App = {};
  var el = function (id) { return document.getElementById(id); };
  var views = {};
  var hasRaf = typeof window.requestAnimationFrame === 'function';
  var state = {
    token: '',
    section: 'dashboard',
    accounts: [],
    accountId: '',
    dashboard: null,
    overview: null,
    scopeId: '',
    scope: null,
    tripTab: 'sheets',
    systemStatus: null,
    activationCodes: null,
    prompts: null,
    codeFilter: 'all',
    catalogFilter: { missingUnitOnly: false },
    qualityFilter: { filter: 'attention', highlightTurnId: '', scopeId: '' },
    mistakesFilter: { status: 'open' },
    pendingQualityTurnId: '',
    materialUrls: {},
    materialPending: {},
    renderSeq: 0
  };

  var esc = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  var pad2 = function (value) { return value < 10 ? '0' + value : String(value); };
  var dateOf = function (iso) {
    if (!iso) return null;
    var date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  };
  var fmtDay = function (iso) {
    var date = dateOf(iso);
    if (!date) return '—';
    var now = new Date();
    var prefix = date.getFullYear() === now.getFullYear() ? '' : date.getFullYear() + '年';
    return prefix + (date.getMonth() + 1) + '月' + date.getDate() + '日';
  };
  var fmtTime = function (iso) {
    var date = dateOf(iso);
    if (!date) return '—';
    return fmtDay(iso) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  };
  var centsToYuan = function (cents) {
    var n = Number(cents);
    if (cents === null || cents === undefined || !Number.isSafeInteger(n)) return '';
    var sign = n < 0 ? '-' : '';
    var s = String(Math.abs(n));
    while (s.length < 3) s = '0' + s;
    return sign + s.slice(0, -2) + '.' + s.slice(-2);
  };
  var moneyText = function (cents) {
    var yuan = centsToYuan(cents);
    return yuan ? '¥' + yuan : '待补价';
  };
  var moneyHtml = function (cents, pendingCount) {
    var pending = Number(pendingCount) || 0;
    if (cents === null || cents === undefined || (Number(cents) === 0 && pending > 0)) {
      return '<span class="badge warn">待补价</span>';
    }
    return '<span class="money">' + moneyText(cents) + '</span>';
  };

  var shakeNode = function (node) {
    if (!node || !node.classList) return;
    node.classList.remove('is-shake');
    if (hasRaf) {
      window.requestAnimationFrame(function () { node.classList.add('is-shake'); });
    } else {
      node.classList.add('is-shake');
    }
  };

  /* ---------- 外观主题（跟随系统 / 浅色 / 深色） ---------- */
  var themeIcons = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'
  };
  var themeLabels = { auto: '跟随系统', light: '浅色', dark: '深色' };
  var currentTheme = 'auto';
  var applyTheme = function (mode) {
    currentTheme = mode === 'light' || mode === 'dark' ? mode : 'auto';
    if (document.documentElement) {
      if (currentTheme === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', currentTheme);
    }
    var icon = el('themeIcon');
    var label = el('themeLabel');
    var btn = el('themeBtn');
    if (icon) icon.innerHTML = themeIcons[currentTheme];
    if (label) label.textContent = themeLabels[currentTheme];
    if (btn) btn.setAttribute('title', '当前外观：' + themeLabels[currentTheme] + '（点击切换）');
  };
  var initTheme = function () {
    var saved = 'auto';
    try { if (window.localStorage) saved = window.localStorage.getItem('dispatchAdminTheme') || 'auto'; } catch (e) {}
    applyTheme(saved);
  };
  var cycleTheme = function () {
    var next = currentTheme === 'auto' ? 'dark' : currentTheme === 'dark' ? 'light' : 'auto';
    applyTheme(next);
    try { if (window.localStorage) window.localStorage.setItem('dispatchAdminTheme', next); } catch (e) {}
    toast('已切换外观为「' + themeLabels[next] + '」。', 'info');
  };

  var toast = function (message, tone) {
    var stack = el('toastStack');
    if (!stack || !message) return;
    var kind = tone === 'success' ? 'success' : tone === 'error' ? 'error' : 'info';
    var node = document.createElement('div');
    node.className = 'toast ' + kind;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var text = document.createElement('div');
    text.className = 'toast-text';
    text.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    var removed = false;
    var remove = function () {
      if (removed) return;
      removed = true;
      if (!node.parentNode) return;
      if (!hasRaf) { node.parentNode.removeChild(node); return; }
      node.classList.add('is-leaving');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 165);
    };
    close.addEventListener('click', remove);
    node.appendChild(text);
    node.appendChild(close);
    stack.appendChild(node);
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    setTimeout(remove, kind === 'error' ? 6500 : 3400);
  };

  var flashCopied = function (trigger) {
    if (!trigger || !trigger.classList) return;
    var orig = trigger.getAttribute('data-orig-label') || trigger.textContent;
    trigger.setAttribute('data-orig-label', orig);
    trigger.textContent = '✓ 已复制';
    trigger.classList.add('is-copied');
    if (trigger.__copyTimer) clearTimeout(trigger.__copyTimer);
    trigger.__copyTimer = setTimeout(function () {
      trigger.__copyTimer = null;
      if (trigger.isConnected) {
        trigger.textContent = orig;
        trigger.classList.remove('is-copied');
      }
    }, 1600);
  };

  var copyText = function (text, okMsg, trigger) {
    var done = function () {
      flashCopied(trigger);
      toast(okMsg || '已复制。', 'success');
    };
    var fail = function () { toast('复制失败，请手动选择文本。', 'error'); };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-9999px';
      document.body.appendChild(area);
      var copied = false;
      try { area.select(); copied = document.execCommand('copy'); } catch (error) { copied = false; }
      document.body.removeChild(area);
      if (copied) done(); else fail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  };

  var showLogin = function () {
    if (el('app')) el('app').classList.add('hidden');
    if (el('login')) el('login').classList.remove('hidden');
    if (el('login-token')) el('login-token').focus();
  };
  var accountLabel = function (account) {
    var name = account && account.remarkName && account.remarkName.trim()
      ? account.remarkName.trim() : '未命名配送员 · ' + ((account && account.subject) || '脱敏标识');
    return name + (account && account.disabled ? ' · 已停用' : '');
  };
  var currentAccount = function () {
    for (var index = 0; index < state.accounts.length; index++) {
      if (state.accounts[index].id === state.accountId) return state.accounts[index];
    }
    return null;
  };
  var lightboxTimer = null;
  var clearMaterialUrls = function () {
    if (lightboxTimer) { clearTimeout(lightboxTimer); lightboxTimer = null; }
    Object.keys(state.materialUrls).forEach(function (key) {
      var url = state.materialUrls[key];
      if (url) URL.revokeObjectURL(url);
    });
    state.materialUrls = {};
    state.materialPending = {};
    if (el('lightboxImg')) el('lightboxImg').removeAttribute('src');
    if (el('lightbox')) {
      el('lightbox').classList.remove('is-closing');
      el('lightbox').classList.add('hidden');
    }
  };
  var logout = function (expired) {
    clearMaterialUrls();
    closeModal(true);
    state.token = '';
    state.accounts = [];
    state.accountId = '';
    state.dashboard = null;
    state.overview = null;
    state.scopeId = '';
    state.scope = null;
    state.systemStatus = null;
    state.activationCodes = null;
    state.prompts = null;
    sessionStorage.removeItem('dispatchAdminToken');
    showLogin();
    if (el('login-error')) {
      el('login-error').textContent = expired ? '口令不正确或已失效，请重新输入。' : '';
    }
    if (expired) toast('口令不正确或已失效，请重新输入。', 'error');
  };

  var api = function (path, opts) {
    var options = opts || {};
    var headers = { Authorization: 'Bearer ' + state.token };
    var body;
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = 'application/json';
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    return fetch('/admin/api' + path, {
      method: options.method || 'GET', headers: headers, body: body, cache: 'no-store'
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        if (response.status === 401) {
          logout(true);
          throw new Error('口令不正确或已失效，请重新输入');
        }
        if (!response.ok) {
          var message = (data && (data.message || data.error)) || ('请求失败 ' + response.status);
          if (!options.silent) toast(message, 'error');
          throw new Error(message);
        }
        return data;
      });
    });
  };

  var loadMaterialUrl = function (accountId, id) {
    var key = accountId + ':' + id;
    if (state.materialUrls[key]) return Promise.resolve(state.materialUrls[key]);
    if (state.materialPending[key]) return state.materialPending[key];
    var pending = fetch('/admin/api/accounts/' + encodeURIComponent(accountId) + '/materials/' +
      encodeURIComponent(id) + '/content', {
      headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) throw new Error('图片暂时无法加载（' + response.status + '）');
      return response.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      if (!state.token || state.accountId !== accountId) {
        URL.revokeObjectURL(url);
        throw new Error('账号已切换，图片已释放');
      }
      state.materialUrls[key] = url;
      delete state.materialPending[key];
      return url;
    }, function (error) {
      delete state.materialPending[key];
      throw error;
    });
    state.materialPending[key] = pending;
    return pending;
  };

  var openLightbox = function (url, caption) {
    if (!url || !el('lightboxImg')) return;
    if (lightboxTimer) { clearTimeout(lightboxTimer); lightboxTimer = null; }
    el('lightboxImg').src = url;
    if (el('lightboxCaption')) el('lightboxCaption').textContent = caption || '';
    el('lightbox').classList.remove('is-closing');
    el('lightbox').classList.remove('hidden');
  };
  var closeLightbox = function (immediate) {
    var box = el('lightbox');
    if (!box || box.classList.contains('hidden')) return;
    if (lightboxTimer) { clearTimeout(lightboxTimer); lightboxTimer = null; }
    if (immediate || !hasRaf) {
      box.classList.remove('is-closing');
      box.classList.add('hidden');
      if (el('lightboxImg')) el('lightboxImg').removeAttribute('src');
      return;
    }
    box.classList.add('is-closing');
    lightboxTimer = setTimeout(function () {
      lightboxTimer = null;
      box.classList.remove('is-closing');
      box.classList.add('hidden');
      if (el('lightboxImg')) el('lightboxImg').removeAttribute('src');
    }, 155);
  };

  var modalSeq = 0;
  var modalTimer = null;
  var modalDirty = false;
  var modalBackdropGuard = false;
  var closeModal = function (immediate) {
    var root = el('modalRoot');
    if (!root) return;
    if (modalTimer) { clearTimeout(modalTimer); modalTimer = null; }
    modalSeq += 1;
    modalDirty = false;
    modalBackdropGuard = false;
    try {
      if (document.activeElement && root.contains && root.contains(document.activeElement) && document.activeElement.blur) {
        document.activeElement.blur();
      }
    } catch (e) {}
    if (immediate || !hasRaf || root.classList.contains('hidden')) {
      root.classList.remove('is-closing');
      root.classList.add('hidden');
      root.innerHTML = '';
      return;
    }
    var seq = modalSeq;
    root.classList.add('is-closing');
    modalTimer = setTimeout(function () {
      modalTimer = null;
      if (seq !== modalSeq) return;
      root.classList.remove('is-closing');
      root.classList.add('hidden');
      root.innerHTML = '';
    }, 155);
  };
  var openModal = function (options) {
    var root = el('modalRoot');
    if (!root) return null;
    if (modalTimer) { clearTimeout(modalTimer); modalTimer = null; }
    var mySeq = ++modalSeq;
    modalDirty = false;
    modalBackdropGuard = options.guardBackdrop !== false;
    var title = options.title || '请确认';
    var confirmText = options.confirmText || '确定';
    var tone = options.confirmTone === 'danger' ? 'btn-danger' : 'btn-primary';
    root.classList.remove('is-closing');
    root.innerHTML = '<div class="modal-backdrop" data-modal-close="1"></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="modal-head"><h2>' + esc(title) + '</h2>' +
      '<button type="button" class="modal-x" data-modal-cancel="1" aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' + (options.bodyHtml || '') + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-secondary" data-modal-cancel="1">取消</button>' +
      '<button type="button" class="btn ' + tone + '" data-modal-confirm="1">' + esc(confirmText) + '</button></div>' +
      '</div>';
    root.classList.remove('hidden');
    var card = root.querySelector('.modal-card');
    var confirm = root.querySelector('[data-modal-confirm]');
    var busy = false;
    var reset = function () {
      busy = false;
      if (confirm) { confirm.disabled = false; confirm.textContent = confirmText; }
    };
    var triggerConfirm = function () {
      if (busy || mySeq !== modalSeq || root.classList.contains('is-closing') || root.classList.contains('hidden')) return;
      busy = true;
      confirm.disabled = true;
      confirm.textContent = '处理中…';
      var result;
      try {
        result = options.onConfirm ? options.onConfirm(card) : undefined;
      } catch (error) {
        reset();
        toast(error && error.message ? error.message : '操作失败', 'error');
        return;
      }
      Promise.resolve(result).then(function (keepOpen) {
        if (keepOpen === false) { reset(); return; }
        if (mySeq === modalSeq) closeModal();
      }, function (error) {
        reset();
        toast(error && error.message ? error.message : '操作失败', 'error');
      });
    };
    if (confirm) confirm.addEventListener('click', triggerConfirm);
    if (card) {
      card.addEventListener('input', function () { modalDirty = true; });
      card.addEventListener('change', function () { modalDirty = true; });
      card.addEventListener('keydown', function (event) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && event.target && event.target.tagName === 'INPUT' &&
          event.target.type !== 'checkbox' && event.target.type !== 'radio' && event.target.type !== 'file') {
          if (mySeq !== modalSeq || root.classList.contains('is-closing')) return;
          event.preventDefault();
          triggerConfirm();
        }
      });
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-modal-cancel]'), function (node) {
      node.addEventListener('click', function () { closeModal(); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-modal-close]'), function (node) {
      node.addEventListener('click', function () {
        if (modalDirty && modalBackdropGuard) {
          shakeNode(card);
          toast('表单有未保存修改；如需放弃请点「取消」。', 'info');
          return;
        }
        closeModal();
      });
    });
    var first = root.querySelector('input, select, textarea');
    if (first) first.focus();
    return card;
  };

  var renderAccountSelect = function () {
    var select = el('accountSelect');
    if (!select) return;
    if (!state.accounts.length) {
      select.innerHTML = '<option value="">暂无配送员账号</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = state.accounts.map(function (account) {
      var selected = account.id === state.accountId ? ' selected' : '';
      return '<option value="' + esc(account.id) + '"' + selected + '>' + esc(accountLabel(account)) + '</option>';
    }).join('');
  };
  var updateNavBadges = function () {
    var account = currentAccount();
    var missing = account && typeof account.missingUnitCount === 'number' ? account.missingUnitCount : 0;
    var mistakes = account && typeof account.openMistakeCount === 'number' ? account.openMistakeCount : 0;
    if (state.dashboard && state.dashboard.todos) {
      if (typeof state.dashboard.todos.missingUnitCount === 'number') missing = state.dashboard.todos.missingUnitCount;
      if (typeof state.dashboard.todos.openMistakeCount === 'number') mistakes = state.dashboard.todos.openMistakeCount;
    }
    var missingNode = el('navBadgeMissing');
    if (missingNode) {
      missingNode.textContent = missing > 99 ? '99+' : String(missing);
      missingNode.classList.toggle('hidden', !missing);
    }
    var mistakeNode = el('navBadgeMistakes');
    if (mistakeNode) {
      mistakeNode.textContent = mistakes > 99 ? '99+' : String(mistakes);
      mistakeNode.classList.toggle('hidden', !mistakes);
    }
  };

  var loadingCard = function (text) {
    return '<div class="loading-card"><div class="loading-head"><span class="spinner"></span><span>' +
      esc(text || '正在加载…') + '</span></div>' +
      '<div class="skeleton-bars"><div class="skeleton-bar w40"></div><div class="skeleton-bar w75"></div><div class="skeleton-bar w60"></div></div></div>';
  };

  var navigate = function (section, opts) {
    var options = opts || {};
    if (!views[section]) section = 'dashboard';
    if (section === 'catalog') {
      state.catalogFilter = { missingUnitOnly: options.missingUnitOnly === true };
    } else if (section === 'quality') {
      state.qualityFilter = {
        filter: options.filter || 'attention',
        highlightTurnId: options.highlightTurnId || '',
        scopeId: options.scopeId || ''
      };
      state.pendingQualityTurnId = options.highlightTurnId || '';
    } else if (section === 'mistakes') {
      state.mistakesFilter = { status: options.status || 'open' };
    } else if (section === 'trips') {
      if (options.scopeId) {
        state.scopeId = options.scopeId;
        state.scope = null;
      } else {
        state.scopeId = '';
        state.scope = null;
        state.tripTab = 'sheets';
      }
    }
    state.section = section;
    renderCurrent();
  };

  var errorCard = function (message) {
    return '<div class="error-card"><h2>页面没有加载成功</h2><p>' + esc(message || '请稍后重试。') + '</p>' +
      '<button type="button" class="btn btn-secondary" data-nav="' + esc(state.section) + '">重新加载</button></div>';
  };

  var renderCurrent = function () {
    if (!state.token) { showLogin(); return; }
    if (!views[state.section]) state.section = 'dashboard';
    state.renderSeq += 1;
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (node) {
      node.classList.toggle('active', node.getAttribute('data-nav') === state.section);
    });
    var isGlobal = state.section === 'accounts';
    var topContext = el('topContext');
    if (topContext) topContext.classList.toggle('is-global', isGlobal);
    var hint = el('contextHint');
    if (hint) hint.textContent = isGlobal ? '全局页面 · 管理所有配送员与开通码' : '';
    var root = el('view');
    if (!root) return;
    root.innerHTML = loadingCard('正在加载…');
    try { root.focus({ preventScroll: true }); } catch (error) { root.focus(); }
    var view = views[state.section];
    if (!view || typeof view.mount !== 'function') {
      root.innerHTML = '<div class="empty-card"><h2>这个模块还没准备好</h2><p>请稍后刷新重试。</p></div>';
      return;
    }
    try {
      var result = view.mount(root);
      if (result && typeof result.catch === 'function') {
        result.catch(function (error) { toast(error && error.message ? error.message : '页面加载失败', 'error'); });
      }
    } catch (error) {
      root.innerHTML = errorCard(error && error.message);
    }
  };

  var loadAccounts = function () {
    return api('/accounts').then(function (data) {
      state.accounts = data && Array.isArray(data.accounts) ? data.accounts : [];
      var exists = state.accounts.some(function (account) { return account.id === state.accountId; });
      if (!exists) {
        var preferred = state.accounts.filter(function (account) { return !account.disabled; })[0] || state.accounts[0];
        state.accountId = preferred ? preferred.id : '';
      }
      renderAccountSelect();
      updateNavBadges();
      return state.accounts;
    });
  };

  var boot = function () {
    initTheme();
    state.token = sessionStorage.getItem('dispatchAdminToken') || '';
    if (!state.token) { showLogin(); return; }
    if (el('login')) el('login').classList.add('hidden');
    if (el('app')) el('app').classList.remove('hidden');
    loadAccounts().then(function () {
      renderCurrent();
    }, function () {
      logout(false);
    });
  };

  var loginForm = el('login-form');
  if (loginForm) loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = el('login-token');
    var submitBtn = el('login-submit');
    var value = input ? input.value.trim() : '';
    if (!value) {
      if (el('login-error')) el('login-error').textContent = '请输入管理员口令。';
      shakeNode(input);
      if (input) input.focus();
      return;
    }
    state.token = value;
    sessionStorage.setItem('dispatchAdminToken', value);
    if (el('login-error')) el('login-error').textContent = '';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '正在验证…'; }
    loadAccounts().then(function () {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '进入后台'; }
      if (el('login')) el('login').classList.add('hidden');
      if (el('app')) el('app').classList.remove('hidden');
      renderCurrent();
      toast('已进入运营与维护后台。', 'success');
    }, function (error) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '进入后台'; }
      state.token = '';
      sessionStorage.removeItem('dispatchAdminToken');
      if (el('login-error')) el('login-error').textContent = error && error.message ? error.message : '登录失败';
      shakeNode(input);
      showLogin();
    });
  });

  var themeBtn = el('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', cycleTheme);

  var logoutBtn = el('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', function () {
    logout(false);
    toast('已退出后台。', 'info');
  });
  var refreshBtn = el('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function () {
    refreshBtn.classList.add('is-spinning');
    refreshBtn.disabled = true;
    state.dashboard = null;
    state.overview = null;
    state.scope = null;
    state.systemStatus = null;
    state.activationCodes = null;
    state.prompts = null;
    loadAccounts().then(function () {
      renderCurrent();
      toast('已刷新最新数据。', 'success');
    }, function (error) {
      toast('刷新失败：' + (error && error.message ? error.message : '请稍后重试'), 'error');
    }).then(function () {
      refreshBtn.classList.remove('is-spinning');
      refreshBtn.disabled = false;
    });
  });
  var accountSelect = el('accountSelect');
  if (accountSelect) accountSelect.addEventListener('change', function (event) {
    closeModal(true);
    clearMaterialUrls();
    state.accountId = event.target.value;
    state.dashboard = null;
    state.overview = null;
    state.scope = null;
    state.scopeId = '';
    state.tripTab = 'sheets';
    updateNavBadges();
    renderCurrent();
    var account = currentAccount();
    if (account) toast('已切换到 ' + accountLabel(account) + '。', 'success');
  });

  document.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-nav]');
    if (nav) {
      var opts = {};
      if (nav.getAttribute('data-missing-unit') === '1') opts.missingUnitOnly = true;
      if (nav.getAttribute('data-filter')) opts.filter = nav.getAttribute('data-filter');
      if (nav.getAttribute('data-status')) opts.status = nav.getAttribute('data-status');
      if (nav.getAttribute('data-highlight-turn')) opts.highlightTurnId = nav.getAttribute('data-highlight-turn');
      if (nav.getAttribute('data-scope-id')) opts.scopeId = nav.getAttribute('data-scope-id');
      navigate(nav.getAttribute('data-nav'), opts);
      return;
    }
    var copyCode = event.target.closest('[data-copy-code]');
    if (copyCode) {
      copyText(copyCode.getAttribute('data-copy-code'), '已复制开通码，可直接发微信。', copyCode);
      return;
    }
    if (event.target === el('lightbox')) { closeLightbox(); return; }
    var lightboxClose = event.target.closest('#lightboxClose');
    if (lightboxClose) { closeLightbox(); return; }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeLightbox();
      closeModal();
    }
  });

  App.state = state;
  App.views = views;
  App.esc = esc;
  App.centsToYuan = centsToYuan;
  App.moneyText = moneyText;
  App.moneyHtml = moneyHtml;
  App.fmtDay = fmtDay;
  App.fmtTime = fmtTime;
  App.toast = toast;
  App.copyText = copyText;
  App.shakeNode = shakeNode;
  App.loadingCard = loadingCard;
  App.api = api;
  App.openModal = openModal;
  App.closeModal = closeModal;
  App.clearMaterialUrls = clearMaterialUrls;
  App.loadMaterialUrl = loadMaterialUrl;
  App.openLightbox = openLightbox;
  App.navigate = navigate;
  App.renderCurrent = renderCurrent;
  App.loadAccounts = loadAccounts;
  App.logout = logout;
  App.currentAccount = currentAccount;
  App.accountLabel = accountLabel;
  App.renderAccountSelect = renderAccountSelect;
  App.updateNavBadges = updateNavBadges;
  App.errorCard = errorCard;
  App.boot = boot;
  window.__dispatchAdmin = App;
})();
`;
