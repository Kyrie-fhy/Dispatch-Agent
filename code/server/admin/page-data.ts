export const adminDataScript = `
(function () {
  'use strict';
  var App = window.__dispatchAdmin;
  if (!App) return;
  var views = App.views;
  var state = App.state;
  var esc = App.esc;

  var pageHead = function (title, description, tag) {
    return '<div class="page-head"><div><h1>' + esc(title) + '</h1><p>' + esc(description) + '</p></div>' +
      (tag ? '<div class="page-tag">' + tag + '</div>' : '') + '</div>';
  };
  var badge = function (label, tone) {
    return '<span class="badge ' + (tone || 'neutral') + '">' + esc(label) + '</span>';
  };
  var placeholder = function (title, description, contextHtml) {
    var account = App.currentAccount();
    var root = document.getElementById('view');
    var html = pageHead(title, description, badge('即将上线', 'neutral'));
    html += '<section class="placeholder-card"><span class="placeholder-mark">即将上线</span>' +
      '<h2>这个模块正在接入</h2>' +
      '<p>后台账号、趟次、开通码与系统状态已经可用。' + esc(title) +
      '的完整界面正在接入，先不放置半成品写入入口，避免误操作。</p>' +
      (contextHtml ? '<div class="placeholder-context">' + contextHtml + '</div>' : '') +
      (account ? '<p class="muted">当前配送员：' + esc(App.accountLabel(account)) + '</p>' : '') +
      '<button type="button" class="btn btn-secondary" data-nav="dashboard">回首页总览</button></section>';
    root.innerHTML = html;
  };

  views.catalog = {
    mount: function () {
      var filter = state.catalogFilter || {};
      placeholder('货品与价格库', '维护 227+ 货品的价格、单位与上下架，并支持 CSV 预演导入。',
        filter.missingUnitOnly
          ? '已收到首页待办筛选：只看缺计价单位的货品，接入后会直达该筛选列表。' : '');
    }
  };

  views.customers = {
    mount: function () {
      placeholder('熟客与叫法', '查看熟客档案、口语叫法，并只读追溯最近历史成交价。', '');
    }
  };

  views.quality = {
    mount: function () {
      var filter = state.qualityFilter || {};
      var parts = [];
      if (filter.filter) {
        parts.push('当前筛选：' + (filter.filter === 'attention' ? '需关注' : filter.filter));
      }
      if (filter.highlightTurnId) {
        parts.push('已从单据或消息定位到指定回合，接入后会高亮展开');
      }
      if (filter.scopeId) {
        parts.push('已带上所属趟次上下文');
      }
      placeholder('对话质检', '用 4 步人话因果故事查看 AI 每轮做了什么，技术日志统一折叠。',
        parts.length ? esc(parts.join('。')) + '。' : '');
    }
  };

  views.mistakes = {
    mount: function () {
      var filter = state.mistakesFilter || {};
      var status = filter.status === 'resolved' ? '已修复' : '待修复';
      placeholder('错题本', '把 AI 录错的话收进错题本，写清期望结果并导出脱敏 Case。',
        '当前筛选：' + esc(status) + '。');
    }
  };
})();
`;
