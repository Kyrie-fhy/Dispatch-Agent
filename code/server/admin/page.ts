export const adminPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch 排障后台</title>
<style>
  :root { --green: #12664d; --green-dark: #0b4b38; --ink: #18211d; --muted: #64736b; --line: #dfe7e2;
    --paper: #ffffff; --bg: #f3f6f4; --amber: #b45309; --amber-bg: #fef3c7; --red: #b91c1c; --red-bg: #fee2e2;
    --blue: #1d4ed8; --blue-bg: #dbeafe; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  button, select, input { font: inherit; }
  button { cursor: pointer; }
  .hidden { display: none !important; }
  .mono { font-family: var(--mono); }
  .topbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center;
    padding: 12px 20px; background: var(--green); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
  .brand { font-size: 17px; font-weight: 700; letter-spacing: .2px; }
  .brand .tag { margin-left: 8px; padding: 1px 7px; border: 1px solid rgba(255,255,255,.55); border-radius: 999px;
    font-size: 11px; font-weight: 500; vertical-align: 2px; }
  .auth-tag { padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.15); color: #e6f5ee;
    font-size: 11px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-left: auto; }
  .controls label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #d9eee6; }
  .controls select { max-width: 260px; padding: 5px 8px; border: 0; border-radius: 6px; background: #fff; color: var(--ink); }
  .controls button { padding: 5px 12px; border: 0; border-radius: 6px; background: #fff; color: var(--green-dark); font-weight: 600; }
  .controls button.ghost { background: transparent; border: 1px solid rgba(255,255,255,.5); color: #fff; font-weight: 500; }
  .tabs { display: flex; gap: 4px; padding: 3px; border-radius: 8px; background: rgba(0,0,0,.18); }
  .tabs button { padding: 5px 12px; border-radius: 6px; background: transparent; color: #d9eee6; font-weight: 500; }
  .tabs button.active { background: #fff; color: var(--green-dark); font-weight: 700; }
  .status { min-height: 26px; padding: 4px 20px; color: var(--muted); font-size: 12px; }
  .status.error { color: var(--red); }
  .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 30; display: flex; flex-direction: column;
    gap: 8px; width: min(380px, calc(100vw - 36px)); pointer-events: none; }
  .toast { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--line);
    border-left: 4px solid var(--blue); border-radius: 9px; background: #fff; color: var(--ink);
    box-shadow: 0 12px 30px rgba(18,102,77,.18); font-size: 12px; line-height: 1.45;
    pointer-events: auto; animation: toast-in .18s ease-out; }
  .toast.success { border-left-color: var(--green); }
  .toast.error { border-color: #fecaca; border-left-color: var(--red); background: #fff7f7; }
  .toast.info { border-left-color: var(--blue); }
  .toast-text { flex: 1; min-width: 0; word-break: break-word; overflow-wrap: anywhere; }
  .toast-close { flex: 0 0 auto; padding: 0 2px; border: 0; background: transparent; color: var(--muted);
    font-size: 16px; line-height: 1; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  main { padding: 0 20px 28px; }
  .layout { display: grid; grid-template-columns: minmax(430px, 43%) minmax(0, 1fr); gap: 16px; align-items: start; }
  .panel { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; min-width: 0; }
  .left { position: sticky; top: 78px; max-height: calc(100vh - 96px); display: flex; flex-direction: column; }
  .panel-tabs { display: flex; gap: 4px; padding: 10px 12px 0; border-bottom: 1px solid var(--line); }
  .panel-tabs button { padding: 7px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); }
  .panel-tabs button.active { border-color: var(--green); color: var(--green); font-weight: 700; }
  .left-content { padding: 14px; overflow: auto; }
  .right { padding: 14px; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 12px; margin-bottom: 12px; border-radius: 8px;
    background: #f7faf8; border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .summary b { color: var(--ink); }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #fff; }
  .card-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .card-head h3 { margin: 0; font-size: 15px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.warn { background: var(--amber-bg); color: var(--amber); }
  .badge.bad { background: var(--red-bg); color: var(--red); }
  .badge.info { background: var(--blue-bg); color: var(--blue); }
  .badge.muted { background: #eef2f0; color: var(--muted); }
  .pending { display: inline-block; padding: 0 6px; border-radius: 4px; background: var(--amber-bg); color: var(--amber); font-weight: 700; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 7px; border-bottom: 1px solid #edf1ee; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; background: #f8faf9; white-space: nowrap; }
  td.num, th.num { text-align: right; font-family: var(--mono); white-space: nowrap; }
  .line-sub { color: var(--muted); font-size: 11px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(102px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .stat { padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: #fbfcfb; }
  .stat span { display: block; color: var(--muted); font-size: 11px; }
  .stat b { font-family: var(--mono); font-size: 17px; }
  .filter { display: flex; align-items: center; gap: 7px; margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  .filter input, .filter select { padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); }
  .filter input[type="search"] { flex: 1; min-width: 180px; }
  .catalog-name { word-break: break-word; }
  .turn { border: 1px solid var(--line); border-left: 3px solid var(--green); border-radius: 10px; padding: 12px; margin-bottom: 14px; background: #fff; }
  .turn.bad { border-left-color: var(--red); }
  .turn.warn { border-left-color: #d97706; }
  .turn-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; color: var(--muted); font-size: 11px; margin-bottom: 8px; }
  .turn-head .spacer { flex: 1; }
  .bubble { padding: 9px 11px; border-radius: 9px; background: #f1f7f4; white-space: pre-wrap; word-break: break-word; }
  .bubble.assistant { background: #f7f8fa; border: 1px solid #e8ebee; margin-top: 8px; }
  .bubble-label { display: block; margin-bottom: 3px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .5px; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
  .thumb { width: 132px; height: 100px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #f4f6f5;
    display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 11px; text-align: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
  .model-card { margin-top: 10px; padding: 9px 10px; border: 1px solid #b9d9cd; border-radius: 9px; background: #f2faf6; }
  .model-head { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; font-size: 11px; color: var(--muted); }
  .chip { padding: 1px 8px; border: 1px solid #8dc7b2; border-radius: 999px; background: #fff; color: var(--green);
    font: 600 11px var(--mono); }
  .model-card pre, .raw pre, .tools pre, .prompt-text { margin: 7px 0 0; padding: 9px; border-radius: 7px; background: #0f241d;
    color: #d8f3e8; font: 11px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 320px; }
  .input-summary { margin-top: 5px; color: var(--muted); font-size: 11px; }
  .tool-card { min-width: 0; margin-top: 8px; padding: 9px 10px; border: 1px solid #93c5fd;
    border-left: 3px solid var(--blue); border-radius: 9px; background: #eff6ff; overflow: hidden; }
  .tool-card.warn { border-color: #fcd34d; border-left-color: var(--amber); background: #fffbeb; }
  .tool-card.bad { border-color: #fca5a5; border-left-color: var(--red); background: #fef2f2; }
  .tool-head { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; font-size: 11px; color: var(--muted); }
  .tool-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; align-items: start; }
  .tool-body > div { min-width: 0; }
  .tool-body pre { min-width: 0; margin-top: 4px; padding: 8px 9px; max-height: 220px; border-radius: 7px;
    background: #fff; color: var(--ink); border: 1px solid #dbeafe; font: 11px/1.55 var(--mono);
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; overflow: auto; }
  .tool-body label { display: block; margin-top: 7px; color: var(--muted); font-size: 10px; font-weight: 700; }
  .turn-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .turn-actions button { padding: 3px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff;
    color: var(--green); font-size: 11px; }
  .event-list { margin: 10px 0 0; padding: 0; list-style: none; }
  .event-list li { padding: 5px 8px; border-left: 2px solid #cfe2d9; margin: 3px 0 3px 3px; font-size: 12px; }
  .event-list .kind { display: inline-block; min-width: 104px; color: var(--green); font: 600 11px var(--mono); }
  .timeline-bar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 2px 0 12px; }
  .timeline-step { display: flex; gap: 8px; align-items: flex-start; min-width: 0; padding: 7px 9px;
    border: 1px solid var(--line); border-radius: 9px; background: #fbfcfb; }
  .timeline-step .dot { flex: 0 0 auto; width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; background: #9aa8a0; }
  .timeline-step.ok .dot { background: #16a34a; }
  .timeline-step.warn .dot { background: #d97706; }
  .timeline-step.bad .dot { background: #dc2626; }
  .timeline-step.skip .dot { background: #9aa8a0; }
  .timeline-step.ok { border-color: #bbf7d0; background: #f0fdf4; }
  .timeline-step.warn { border-color: #fde68a; background: #fffbeb; }
  .timeline-step.bad { border-color: #fecaca; background: #fef2f2; }
  .timeline-step.skip { border-color: #e2e8e4; background: #f6f8f7; }
  .timeline-step .step-text { min-width: 0; }
  .timeline-step .step-label { display: block; font-size: 12px; font-weight: 700; color: var(--ink); }
  .timeline-step .step-sub { display: block; color: var(--muted); font-size: 11px; word-break: break-word; overflow-wrap: anywhere; }
  .cause { margin: 12px 0; }
  .cause-title { margin-bottom: 5px; font-size: 13px; font-weight: 700; color: var(--ink); }
  .cause-line { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 9px; background: #fbfcfb; font-size: 12px; }
  .cause-line b { color: var(--ink); }
  .cause-block { margin-top: 8px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: #fbfcfb; }
  .cause-block b { display: block; margin-bottom: 4px; font-size: 12px; }
  .table-scroll { overflow-x: auto; }
  .change-list { margin: 0; padding-left: 18px; }
  .change-list li { margin: 2px 0; }
  .voice-compare { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 8px; align-items: stretch; margin-top: 8px; }
  .voice-box { padding: 8px 10px; border: 1px solid #fcd34d; border-radius: 8px; background: #fffbeb; word-break: break-word; }
  .voice-box.fixed { border-color: #86efac; background: #f0fdf4; }
  .voice-label { display: block; margin-bottom: 3px; color: var(--muted); font-size: 10px; font-weight: 700; }
  .voice-arrow { align-self: center; color: var(--muted); font-weight: 700; }
  .corrections { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .correction-tag { display: inline-block; padding: 1px 8px; border: 1px solid #cfe2d9; border-radius: 999px;
    background: #eef6f1; color: var(--green-dark); font-size: 11px; }
  .hint-bar { margin-top: 7px; padding: 6px 9px; border-left: 4px solid #d97706; border-radius: 6px;
    background: var(--amber-bg); color: #7c2d12; font-size: 12px; }
  .hint-bar.bad { border-left-color: var(--red); background: var(--red-bg); color: #7f1d1d; }
  .raw-tech { margin-top: 12px; padding-top: 8px; border-top: 1px dashed var(--line); }
  .raw-tech > summary { color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; }
  @media (max-width: 900px) { .timeline-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 560px) { .timeline-bar { grid-template-columns: 1fr; }
    .voice-compare { grid-template-columns: 1fr; } .voice-arrow { justify-self: center; } }
  .muted { color: var(--muted); }
  details.raw { margin-top: 9px; }
  details.raw summary { color: var(--muted); font-size: 11px; cursor: pointer; }
  .prompt-card { border: 1px solid var(--line); border-radius: 11px; padding: 14px; margin-bottom: 14px; background: #fff; }
  .prompt-card.focus { outline: 2px solid #f59e0b; outline-offset: 2px; }
  .prompt-card .meta { color: var(--muted); font-size: 12px; margin: 3px 0 10px; }
  .prompt-block { margin: 10px 0; }
  .prompt-block label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 700; }
  .row-actions { display: flex; gap: 8px; align-items: center; }
  .row-actions button { padding: 3px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--green); font-size: 11px; }
  .notice { padding: 9px 12px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 12px; margin-bottom: 14px; }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .login-card { width: min(420px, 100%); padding: 26px; border: 1px solid var(--line); border-radius: 14px; background: #fff;
    box-shadow: 0 18px 50px rgba(18,102,77,.12); }
  .login-card h1 { margin: 0 0 6px; color: var(--green); font-size: 22px; }
  .login-card p { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
  .login-card input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
  .login-card button { width: 100%; margin-top: 12px; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--green); color: #fff; font-weight: 700; }
  .error { min-height: 20px; margin-top: 10px; color: var(--red); font-size: 12px; }
  .lightbox { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
    background: rgba(10,20,16,.82); padding: 24px; cursor: zoom-out; }
  .lightbox img { max-width: 96vw; max-height: 92vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
  @media (max-width: 1080px) { .layout { grid-template-columns: 1fr; } .left { position: static; max-height: none; } }
</style>
</head>
<body>
<div id="login" class="login-wrap hidden">
  <form id="login-form" class="login-card">
    <h1>Dispatch 排障后台</h1>
    <p>请输入管理员口令。口令只保存在本浏览器会话中，关闭标签页即清除；所有查询均为只读。</p>
    <input id="login-token" type="password" autocomplete="current-password" placeholder="DISPATCH_ADMIN_TOKEN" required>
    <button type="submit">进入后台</button>
    <div id="login-error" class="error"></div>
  </form>
</div>
<div id="app" class="hidden">
  <header class="topbar">
    <div class="brand">Dispatch 排障后台<span class="tag">只读</span></div>
    <span class="auth-tag">口令已启用 · 当前为只读查询</span>
    <div class="controls">
      <label>配送员 <select id="account-select"></select></label>
      <label>范围 <select id="scope-select"></select></label>
      <button id="refresh" type="button">刷新最新数据</button>
      <nav class="tabs">
        <button type="button" data-view="diagnostics" class="active">单据与对话排障</button>
        <button type="button" data-view="prompts">提示词与工具看板</button>
      </nav>
      <button id="logout" type="button" class="ghost">退出口令</button>
    </div>
  </header>
  <div id="status" class="status"></div>
  <main>
    <section id="diagnostics-view">
      <div class="layout">
        <aside class="panel left">
          <div class="panel-tabs">
            <button type="button" data-left="sheets" class="active">送货单</button>
            <button type="button" data-left="picking">取货单</button>
            <button type="button" data-left="memory">熟客与叫法</button>
            <button type="button" data-left="catalog">货品库</button>
          </div>
          <div id="left-content" class="left-content"></div>
        </aside>
        <section class="panel right">
          <div id="stats" class="stats"></div>
          <label class="filter"><input id="anomaly-filter" type="checkbox"> 只看需关注/有追问/有改动的回合</label>
          <div id="turns"></div>
        </section>
      </div>
    </section>
    <section id="prompts-view" class="hidden">
      <div class="notice">只读展示 · 修改提示词须经代码提交与真实评测验证。以下内容来自当前服务端代码。</div>
      <div id="prompts"></div>
    </section>
  </main>
</div>
<div id="lightbox" class="lightbox hidden"><img id="lightbox-img" alt="原图"></div>
<div id="toast-stack" class="toast-stack" aria-live="polite" aria-atomic="false"></div>
<script>
(function () {
  var state = { token: '', accounts: [], accountId: '', overview: null, scope: null, view: 'diagnostics',
    left: 'sheets', onlyAnomaly: false, prompts: null, focusVersion: '', materialSources: {},
    catalog: null, catalogLoading: false, catalogFilter: '', catalogStatus: 'all' };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  var pending = '<span class="pending">待补价</span>';
  var missingPrice = function (cents, pendingCount) {
    return cents === null || cents === undefined || (cents === 0 && pendingCount > 0);
  };
  var moneyText = function (cents, pendingCount) {
    return missingPrice(cents, pendingCount) ? '待补价' : '¥' + (cents / 100).toFixed(2);
  };
  var moneyHtml = function (cents, pendingCount) {
    return missingPrice(cents, pendingCount) ? pending : esc('¥' + (cents / 100).toFixed(2));
  };
  var dash = '<span class="muted">—</span>';
  var statusLabel = { completed: '已完成', running: '处理中', failed: '失败', interrupted: '中断', done: '完成',
    pending: '待送', delivered: '已送达', unrecorded: '未记录', draft: '草稿', skipped: '跳过', needs_input: '待补充', runningStep: '处理中' };
  var setStatus = function (text, error) {
    var node = el('status');
    node.textContent = text || '';
    node.className = 'status' + (error ? ' error' : '');
  };
  var toast = function (message, type) {
    var stack = el('toast-stack');
    if (!stack || !message) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (type || 'info');
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    var text = document.createElement('div');
    text.className = 'toast-text';
    text.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    var remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    close.addEventListener('click', remove);
    node.appendChild(text);
    node.appendChild(close);
    stack.appendChild(node);
    while (stack.children.length > 3) stack.removeChild(stack.firstChild);
    setTimeout(remove, type === 'error' ? 6000 : 3400);
  };
  var copyText = function (text, done, fail) {
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-9999px';
      document.body.appendChild(area);
      var copied = false;
      try { area.select(); copied = document.execCommand('copy'); } catch (e) { copied = false; }
      document.body.removeChild(area);
      if (copied) done(); else fail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  };
  var api = function (path) {
    return fetch('/admin/api' + path, { headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store' })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (response.status === 401) {
            logout(true);
            throw new Error('口令不正确或已失效');
          }
          if (!response.ok) throw new Error((data && (data.message || data.error)) || ('请求失败 ' + response.status));
          return data;
        });
      });
  };
  var showLogin = function () {
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    el('login-token').focus();
  };
  var clearMaterialUrls = function () {
    Object.keys(state.materialSources).forEach(function (key) {
      var url = state.materialSources[key];
      if (url) URL.revokeObjectURL(url);
    });
    state.materialSources = {};
    el('lightbox').classList.add('hidden');
    el('lightbox-img').removeAttribute('src');
  };
  var logout = function (expired) {
    clearMaterialUrls();
    state.token = '';
    state.accountId = '';
    state.accounts = [];
    state.overview = null;
    state.scope = null;
    state.catalog = null;
    state.catalogLoading = false;
    state.catalogFilter = '';
    state.catalogStatus = 'all';
    sessionStorage.removeItem('dispatchAdminToken');
    el('login-error').textContent = expired ? '口令不正确或已失效，请重新输入。' : '';
    if (expired) toast('口令不正确或已失效，请重新输入。', 'error');
    showLogin();
  };
  var boot = function () {
    state.token = sessionStorage.getItem('dispatchAdminToken') || '';
    if (!state.token) { showLogin(); return; }
    el('login').classList.add('hidden');
    el('app').classList.remove('hidden');
    loadAccounts().catch(function () { /* 顶部状态与登录页已提示错误 */ });
  };
  var loadAccounts = function () {
    setStatus('正在读取配送员账号…');
    return api('/accounts').then(function (data) {
      state.accounts = data.accounts;
      if (!state.accounts.length) { setStatus('库内还没有配送员账号。'); return; }
      if (!state.accounts.some(function (account) { return account.id === state.accountId; })) {
        state.accountId = state.accounts[0].id;
      }
      renderAccountSelect();
      return loadOverview();
    }).catch(function (error) { setStatus(error.message, true); throw error; });
  };
  var accountLabel = function (account) {
    var mode = account.draftConfirmed ? '已出单' : '草稿';
    return account.subject + ' · ' + account.provider + ' · ' + mode + ' · ' + account.tripCount + ' 趟';
  };
  var renderAccountSelect = function () {
    el('account-select').innerHTML = state.accounts.map(function (account) {
      return '<option value="' + esc(account.id) + '"' + (account.id === state.accountId ? ' selected' : '') + '>' +
        esc(accountLabel(account)) + '</option>';
    }).join('');
  };
  var loadOverview = function () {
    setStatus('正在读取账号概览…');
    return api('/accounts/' + state.accountId + '/overview').then(function (data) {
      state.overview = data;
      renderScopeSelect();
      return loadScope();
    }).catch(function (error) { setStatus(error.message, true); throw error; });
  };
  var currentScopeValue = '';
  var renderScopeSelect = function () {
    var overview = state.overview;
    var options = [];
    if (overview.draftConfirmed && overview.currentTripId) {
      options.push({ value: 'trip:' + overview.currentTripId, label: '当前趟（已出单）' });
    } else {
      options.push({ value: 'draft:' + overview.draft.id, label: '当前草稿 · 修订 ' + overview.draft.revision });
    }
    overview.trips.forEach(function (trip) {
      if (trip.id === overview.currentTripId) return;
      options.push({ value: 'trip:' + trip.id, label: '正式趟 · ' + new Date(trip.issuedAt).toLocaleString() + ' · ' + trip.customers + ' 店' });
    });
    overview.staleDrafts.forEach(function (draft) {
      options.push({ value: 'draft:' + draft.id, label: '旧草稿 · ' + draft.turnCount + ' 轮 · ' + new Date(draft.lastTurnAt).toLocaleString() });
    });
    var preferred = overview.draftConfirmed && overview.currentTripId
      ? 'trip:' + overview.currentTripId : 'draft:' + overview.draft.id;
    if (!options.some(function (option) { return option.value === currentScopeValue; })) currentScopeValue = preferred;
    el('scope-select').innerHTML = options.map(function (option) {
      return '<option value="' + esc(option.value) + '"' + (option.value === currentScopeValue ? ' selected' : '') + '>' +
        esc(option.label) + '</option>';
    }).join('');
  };
  var loadScope = function () {
    var value = el('scope-select').value || currentScopeValue;
    currentScopeValue = value;
    var parts = value.split(':');
    var kind = parts[0];
    var id = parts.slice(1).join(':');
    setStatus('正在读取排障数据…');
    return api('/accounts/' + state.accountId + '/scopes/' + id).then(function (data) {
      state.scope = data;
      setStatus('已载入 ' + (kind === 'trip' ? '正式趟' : '草稿') + ' ' + id.slice(0, 8) + '，数据为只读。');
      renderDiagnostics();
    }).catch(function (error) { setStatus(error.message, true); throw error; });
  };
  var renderDiagnostics = function () {
    renderLeft();
    renderStats();
    renderTurns();
    if (state.left === 'catalog' && !state.catalog) loadCatalogView().catch(function () { /* 顶部状态已提示 */ });
  };
  var renderStats = function () {
    var stats = state.scope.stats;
    var cards = [
      ['回合数', stats.turns], ['模型调用', stats.modelCalls],
      ['输入 Token', stats.inputTokens], ['输出 Token', stats.outputTokens],
      ['模型中位耗时', stats.medianModelMs === null ? '—' : Math.round(stats.medianModelMs) + ' ms'],
      ['失败 / 撤销', stats.failed + ' / ' + stats.undone]
    ];
    el('stats').innerHTML = cards.map(function (card) {
      return '<div class="stat"><span>' + esc(card[0]) + '</span><b>' + esc(card[1]) + '</b></div>';
    }).join('');
  };
  var renderLeft = function () {
    if (state.left === 'picking') { renderPicking(); return; }
    if (state.left === 'memory') { renderMemory(); return; }
    if (state.left === 'catalog') { renderCatalogView(); return; }
    renderSheets();
  };
  var scopeSummary = function () {
    var document = state.scope.document;
    var parts = [];
    if (document.stale) {
      return '<div class="summary"><span>旧草稿</span><span class="mono">' + esc(document.scopeId) +
        '</span><span>原始草稿明细已不在当前工作区，以下保留对话与 Harness 事件</span></div>';
    }
    if (document.type === 'trip') {
      parts.push('正式趟 · 第 <b>' + esc(document.version) + '</b> 版');
      parts.push('配送修订 <b>' + esc(document.statusRevision) + '</b>');
      parts.push('出单 <b>' + esc(document.issuedAt ? new Date(document.issuedAt).toLocaleString() : '—') + '</b>');
      parts.push('应收 <b>' + moneyHtml(document.dueCents, document.pendingPrices) + '</b>');
    } else {
      parts.push('当前草稿 · 修订 <b>' + esc(document.revision) + '</b>');
      parts.push(document.draftConfirmed ? '<b>已出单</b>' : '未出单');
      parts.push('预计 <b>' + (document.dueCents === 0 && document.pendingPrices === 0
        ? dash : moneyHtml(document.dueCents, document.pendingPrices)) + '</b>');
    }
    parts.push(document.pendingPrices ? '<b>' + esc(document.pendingPrices) + '</b> 处待补价' : '无待补价');
    parts.push('门店 <b>' + esc(document.customers.length) + '</b>');
    return '<div class="summary">' + parts.map(function (part) { return '<span>' + part + '</span>'; }).join('') + '</div>';
  };
  var lineStatus = function (status) {
    var cls = status === 'delivered' ? 'ok' : status === 'unrecorded' ? 'warn' : 'muted';
    return '<span class="badge ' + cls + '">' + esc(statusLabel[status] || status) + '</span>';
  };
  var renderSheets = function () {
    var document = state.scope.document;
    var html = scopeSummary();
    if (document.stale) html += '<div class="notice">这是一份已经离开当前工作区的旧草稿，只剩对话和 Harness 记录可供排查。</div>';
    else if (!document.customers.length) html += '<div class="notice">没有客户单。</div>';
    document.customers.forEach(function (customer) {
      var locked = customer.locked ? '<span class="badge ok">已锁定</span>' : '<span class="badge info">可修改</span>';
      html += '<div class="card"><div class="card-head"><h3>' + esc(customer.customer || '（未命名客户）') + '</h3><div>' + locked + '</div></div>';
      var pendingLabel = customer.pendingPrices ? ' · ' + customer.pendingPrices + ' 处待补价' : '';
      if (document.type === 'trip') {
        html += '<div class="muted" style="font-size:12px;margin-bottom:6px">原订 ' +
          moneyHtml(customer.orderCents, customer.orderPendingPrices) + ' · 预计应收 ' +
          moneyHtml(customer.dueCents, customer.pendingPrices) + pendingLabel + '</div>';
      } else {
        var blankCustomer = !customer.lines.length || customer.lines.every(function (line) { return line.blank; });
        html += '<div class="muted" style="font-size:12px;margin-bottom:6px">预计合计 ' +
          (blankCustomer ? dash : moneyHtml(customer.dueCents, customer.pendingPrices)) + pendingLabel + '</div>';
      }
      html += '<table><thead><tr><th>货品</th><th class="num">原订</th><th class="num">实收</th><th class="num">单价</th><th class="num">小计</th><th>状态</th></tr></thead><tbody>';
      customer.lines.forEach(function (line) {
        var name = [line.brand, line.product, line.specification].filter(Boolean).join(' / ') || '（空行）';
        var original = line.blank ? dash : esc(line.originalQuantity || '—') + ' ' + esc(line.unit || '');
        var received = line.receivedQuantity === null ? dash : esc(line.receivedQuantity) + ' ' + esc(line.unit || '');
        var unit = line.blank ? dash : line.invalidPrice !== undefined
          ? '<span class="badge bad">异常: ' + esc(line.invalidPrice) + '</span>'
          : moneyHtml(line.unitPriceCents, 0);
        var amount = line.blank ? dash : moneyHtml(line.amountCents, 0);
        var tags = '';
        if (document.type === 'draft') {
          if (line.priceSource === 'customer_history') tags += '<span class="badge info">熟客价</span>';
          else if (line.priceSource === 'catalog') tags += '<span class="badge info">库内价</span>';
          if (line.catalogStatus === 'discontinued') tags += '<span class="badge warn">已下架</span>';
        }
        var hint = document.type === 'draft' && line.priceHint
          ? '<div class="line-sub">' + esc(line.priceHint) + '</div>' : '';
        html += '<tr><td>' + esc(name) + (tags ? ' ' + tags : '') +
          '<div class="line-sub mono">' + esc(line.id) + '</div>' + hint + '</td>' +
          '<td class="num">' + original + '</td>' +
          '<td class="num">' + received + '</td>' +
          '<td class="num">' + unit + '</td>' +
          '<td class="num">' + amount + '</td>' +
          '<td>' + lineStatus(line.status) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    });
    el('left-content').innerHTML = html;
  };
  var renderPicking = function () {
    var document = state.scope.document;
    var rows = document.picking || [];
    if (document.type === 'draft') {
      var grouped = {};
      document.customers.forEach(function (customer) {
        customer.lines.forEach(function (line) {
          if (!line.product) return;
          var key = [line.brand, line.product, line.specification, line.unit].join('\\u0000');
          if (!grouped[key]) grouped[key] = { brand: line.brand, product: line.product, specification: line.specification,
            unit: line.unit, quantity: 0 };
          grouped[key].quantity += Number(line.originalQuantity) || 0;
        });
      });
      rows = Object.keys(grouped).map(function (key) { return grouped[key]; });
    }
    var html = scopeSummary();
    if (!rows.length) html += '<div class="notice">' +
      (document.stale ? '旧草稿的取货明细已不在当前工作区。' : '这趟还没有可汇总的取货货品。') + '</div>';
    else {
      html += '<table><thead><tr><th>货品</th><th class="num">取货数量</th></tr></thead><tbody>';
      rows.forEach(function (row) {
        html += '<tr><td>' + esc([row.brand, row.product, row.specification].filter(Boolean).join(' / ') || '（空行）') +
          '</td><td class="num">' + esc(row.quantity) + ' ' + esc(row.unit || '') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    el('left-content').innerHTML = html;
  };
  var renderMemory = function () {
    var overview = state.overview;
    var aliasByCustomer = {};
    overview.aliases.forEach(function (alias) {
      (aliasByCustomer[alias.customerId] = aliasByCustomer[alias.customerId] || []).push(alias);
    });
    var html = '<div class="card"><div class="card-head"><h3>熟客档案</h3><span class="muted">' +
      esc(overview.parties.length) + ' 位 · ' + esc(overview.aliases.length) + ' 条叫法</span></div>';
    if (!overview.parties.length) html += '<div class="notice">还没有熟客。</div>';
    else {
      html += '<table><thead><tr><th>正式店名</th><th>已记叫法</th></tr></thead><tbody>';
      overview.parties.forEach(function (party) {
        var aliases = aliasByCustomer[party.id] || [];
        html += '<tr><td>' + esc(party.name) + '<div class="line-sub mono">' + esc(party.id) + '</div></td><td>' +
          (aliases.length ? aliases.map(function (alias) { return '<span class="badge info">' + esc(alias.alias) + '</span>'; }).join(' ') :
            '<span class="muted">—</span>') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '</div>';
    el('left-content').innerHTML = html;
  };
  var catalogItems = function () {
    if (!state.catalog) return [];
    var keyword = (state.catalogFilter || '').trim().toLowerCase();
    return (state.catalog.items || []).filter(function (item) {
      if (state.catalogStatus === 'active' && item.status !== 'active') return false;
      if (state.catalogStatus === 'discontinued' && item.status !== 'discontinued') return false;
      if (state.catalogStatus === 'missing_unit' && item.unit !== null) return false;
      if (!keyword) return true;
      return [item.productCode, item.variantCode, item.brand, item.product, item.specification,
        (item.aliases || []).join(' ')].filter(Boolean).some(function (value) {
        return String(value).toLowerCase().indexOf(keyword) >= 0;
      });
    });
  };
  var catalogRowsHtml = function () {
    var rows = catalogItems();
    if (!rows.length) return '<tr><td colspan="8" class="muted">没有符合条件的货品。</td></tr>';
    return rows.map(function (item) {
      var name = [item.brand, item.product].filter(Boolean).join(' / ') || '（未命名货品）';
      var unit = item.unit ? esc(item.unit) : '<span class="badge warn">未标</span>';
      var status = item.status === 'active' ? '<span class="badge ok">在售</span>' : '<span class="badge muted">已下架</span>';
      var aliases = item.aliases && item.aliases.length
        ? item.aliases.map(function (alias) { return '<span class="badge info">' + esc(alias) + '</span>'; }).join(' ')
        : '<span class="muted">—</span>';
      var price = typeof item.priceCents === 'number' ? esc('¥' + (item.priceCents / 100).toFixed(2)) : dash;
      return '<tr><td class="mono">' + esc(item.productCode) + '<div class="line-sub mono">' + esc(item.variantCode) + '</div></td>' +
        '<td>' + esc(item.category || '—') + '</td>' +
        '<td class="catalog-name">' + esc(name) + '</td>' +
        '<td>' + esc(item.specification || '—') + '</td>' +
        '<td>' + unit + '</td>' +
        '<td class="num">' + price + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + aliases + '</td></tr>';
    }).join('');
  };
  var renderCatalogRows = function () {
    var body = document.getElementById('catalog-rows');
    if (body) body.innerHTML = catalogRowsHtml();
  };
  var renderCatalogView = function () {
    if (!state.catalog) {
      el('left-content').innerHTML = '<div class="notice">' +
        (state.catalogLoading ? '正在读取货品库…' : '货品库尚未载入，点击左侧「货品库」标签可重试。') + '</div>';
      return;
    }
    var data = state.catalog;
    var summary = data.summary || {};
    var tags = [
      ['商品数', summary.productCount], ['规格数', summary.variantCount],
      ['在售', summary.activeVariantCount], ['已下架', summary.discontinuedVariantCount],
      ['缺单位', summary.missingUnitVariantCount],
      ['最近导入', data.importedAt ? new Date(data.importedAt).toLocaleString() : '—'],
    ];
    var html = '<div class="summary">' + tags.map(function (tag) {
      return '<span>' + esc(tag[0]) + ' <b>' + esc(tag[1]) + '</b></span>';
    }).join('') + '</div>';
    if (!(data.items || []).length) {
      html += '<div class="notice">该账号尚未导入货品库（可用命令行 <code>npm run catalog:import</code> 导入）。</div>';
    } else {
      html += '<div class="filter"><input id="catalog-search" type="search" placeholder="搜索编号 / 品牌 / 品名 / 规格 / 别名" value="' +
        esc(state.catalogFilter) + '"><select id="catalog-status">' +
        [['all', '全部'], ['active', '在售'], ['discontinued', '已下架'], ['missing_unit', '缺单位']].map(function (option) {
          return '<option value="' + esc(option[0]) + '"' + (state.catalogStatus === option[0] ? ' selected' : '') + '>' +
            esc(option[1]) + '</option>';
        }).join('') + '</select></div>';
      html += '<table><thead><tr><th>编号</th><th>分类</th><th>品牌与品名</th><th>规格</th><th>单位</th>' +
        '<th class="num">挂牌价</th><th>状态</th><th>别名</th></tr></thead><tbody id="catalog-rows">' +
        catalogRowsHtml() + '</tbody></table>';
    }
    el('left-content').innerHTML = html;
  };
  var loadCatalogView = function () {
    if (!state.token || !state.accountId || state.catalogLoading) return Promise.resolve();
    var accountId = state.accountId;
    state.catalogLoading = true;
    state.catalog = null;
    renderCatalogView();
    setStatus('正在读取货品库…');
    return api('/accounts/' + accountId + '/catalog').then(function (data) {
      if (accountId !== state.accountId) return;
      state.catalogLoading = false;
      state.catalog = data;
      renderCatalogView();
      setStatus('已载入货品库只读快照：' + (data.items || []).length + ' 个规格。');
    }).catch(function (error) {
      if (accountId !== state.accountId) return;
      state.catalogLoading = false;
      state.catalog = null;
      renderCatalogView();
      setStatus(error.message, true);
      throw error;
    });
  };
  var summarizeEvent = function (event) {
    var payload = event.payload || {};
    if (event.kind === 'plan') return (payload.steps || []).map(function (step) { return step.text; }).join(' → ');
    if (event.kind === 'step') return (payload.id || '') + ' · ' + (statusLabel[payload.state] || payload.state || '') +
      (payload.result ? ' · ' + payload.result : '');
    if (event.kind === 'questions') return (payload.questions || []).map(function (question) {
      return (question.customer ? question.customer + '：' : '') + question.text;
    }).join('；');
    if (event.kind === 'change') return (payload.lines || []).join('；');
    if (event.kind === 'customer_links') return (payload.links || []).map(function (link) {
      return link.spoken + ' → ' + link.canonicalName + (link.merged ? '（合并）' : '');
    }).join('；');
    if (event.kind === 'edit_confirmation') return '确认操作：' + (payload.operations || []).length + ' 项，接受词「' + payload.accept + '」';
    if (event.kind === 'delivery_proposal') return (payload.customer || '') + ' · 行 ' + (payload.edits || []).length +
      ' · ' + (payload.canComplete ? '可确认送达' : '需核对') + (payload.pendingPriceNames && payload.pendingPriceNames.length ?
        ' · 待补价：' + payload.pendingPriceNames.join('、') : '');
    if (event.kind === 'delivery_applied') return '核对卡状态：' + (payload.status || '');
    if (event.kind === 'preview') return '预览 ' + ((payload.preview && payload.preview.previewId) || '') + ' · 应收 ' +
      moneyText(payload.preview && payload.preview.totalCents, payload.preview && payload.preview.pendingPrices);
    if (event.kind === 'undo') return '撤销到修订 ' + payload.revision;
    if (event.kind === 'end') return '结束：' + (statusLabel[payload.status] || payload.status) + ' · 修订 ' + payload.revision +
      (payload.elapsedMs !== undefined ? ' · ' + payload.elapsedMs + ' ms' : '') + (payload.errorCode ? ' · ' + payload.errorCode : '');
    if (event.kind === 'submitted') return '提交：' + (payload.textLength || 0) + ' 字 · ' + (payload.images || 0) + ' 图';
    if (event.kind === 'image_applied') return '图片已应用 ' + String(payload.digest || '').slice(0, 12);
    if (event.kind === 'tool') return '工具 ' + (payload.name || '');
    if (event.kind === 'voice_correction') {
      var count = Array.isArray(payload.corrections) ? payload.corrections.length : 0;
      return '语音纠偏：' + (payload.rawText || '（无原转写）') + ' → ' + (payload.text || '（无提交文字）') +
        (count ? '（' + count + ' 项纠偏）' : '（无逐项纠偏）');
    }
    return JSON.stringify(payload);
  };
  var prettyJson = function (value) {
    var text = value === undefined || value === null ? '' : String(value);
    try { text = JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2); } catch (e) { text = String(value); }
    return text;
  };
  var intentOf = function (turn) {
    var found = null;
    turn.events.forEach(function (event) {
      if (event.kind === 'model' && event.payload && event.payload.phase === 'intent' && event.payload.intents) found = event.payload.intents;
    });
    return found;
  };
  var turnSignals = function (turn) {
    var signals = [];
    var bad = turn.status === 'failed' || turn.status === 'interrupted';
    if (bad) signals.push({ label: turn.status === 'failed' ? '执行失败' : '执行中断', cls: 'bad' });
    if (turn.undone) signals.push({ label: '已撤销', cls: 'warn' });
    var asked = turn.events.some(function (event) {
      return event.kind === 'questions' || event.kind === 'edit_confirmation';
    });
    if (asked) signals.push({ label: '护栏追问/确认', cls: 'warn' });
    var changed = turn.startRevision !== turn.endRevision;
    if (changed) signals.push({ label: '有改动', cls: 'info' });
    if (turn.events.some(function (event) { return event.kind === 'delivery_proposal'; })) {
      signals.push({ label: '现场提案', cls: 'info' });
    }
    var intent = intentOf(turn);
    if (intent && intent.draft && !changed && !asked) signals.push({ label: '口语未产生改动', cls: 'warn' });
    if (turn.elapsedMs !== null && turn.elapsedMs !== undefined && turn.elapsedMs > 3000) {
      signals.push({ label: '慢响应 (>3s)', cls: 'warn' });
    }
    return signals;
  };
  var modelCardHtml = function (payload) {
    var toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
    var summary = payload.inputSummary;
    var parts = [];
    if (summary) {
      if (summary.customerCount !== undefined) parts.push('草稿 ' + summary.customerCount + ' 店 ' + (summary.itemCount || 0) + ' 行');
      if (summary.pendingPrices !== undefined) parts.push(summary.pendingPrices + ' 处待补价');
      if (Array.isArray(summary.spokenNumbers) && summary.spokenNumbers.length) parts.push('口语数字 ' + summary.spokenNumbers.length);
      if (summary.hasPreviousQuestions) parts.push('有前轮追问');
      if (summary.hasLastSummary) parts.push('有上轮摘要');
      if (summary.shopCount !== undefined) parts.push('门店 ' + summary.shopCount);
      if (summary.lineCount !== undefined) parts.push('明细 ' + summary.lineCount);
      if (summary.questionCount !== undefined) parts.push('前轮问题 ' + summary.questionCount);
    }
    var html = '<div class="model-card"><div class="model-head">' +
      '<button type="button" class="chip" data-prompt-version="' + esc(payload.promptVersion || '') + '">' +
      esc(payload.promptVersion || '未标版本') + '</button>' +
      '<span>' + esc(payload.model || '') + '</span><span>' + esc(payload.outcome || '') + '</span>' +
      (payload.phase ? '<span>阶段 ' + esc(payload.phase) + '</span>' : '') +
      '<span>' + esc(payload.elapsedMs === undefined ? '—' : payload.elapsedMs + ' ms') + '</span>' +
      '<span>Token ' + esc(payload.inputTokens === undefined ? '—' : payload.inputTokens) + ' / ' +
      esc(payload.outputTokens === undefined ? '—' : payload.outputTokens) + '</span></div>';
    if (parts.length) html += '<div class="input-summary">输入摘要：' + esc(parts.join(' · ')) + '</div>';
    toolCalls.forEach(function (call) {
      html += '<div class="row-actions" style="margin-top:7px"><span class="badge info">模型提案 · ' + esc(call.name) + '</span></div>' +
        '<pre>' + esc(prettyJson(call.arguments)) + '</pre>';
    });
    return html + '</div>';
  };
  var toolCardHtml = function (payload) {
    var result = payload.result || {};
    var outcome = result.outcome || 'recorded';
    var cls = outcome === 'error' || outcome === 'issues' ? 'bad'
      : outcome === 'question' || outcome === 'questions' || outcome === 'confirmation' || outcome === 'blocked_or_noop' ? 'warn' : '';
    var badge = cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : 'info';
    return '<div class="tool-card ' + cls + '"><div class="tool-head">' +
      '<span class="badge ' + badge + '">工具/护栏 · ' + esc(payload.name || '') + '</span>' +
      '<span class="badge muted mono">' + esc(payload.promptVersion || '') + '</span>' +
      '<span>裁决 ' + esc(outcome) + '</span></div>' +
      '<div class="tool-body"><div><label>入参摘要</label><pre>' + esc(prettyJson(payload.arguments)) + '</pre></div>' +
      '<div><label>服务端结果</label><pre>' + esc(prettyJson(result)) + '</pre></div></div></div>';
  };
  var actionLabel = { add: '新增', fill: '补填', update: '修改', remove_line: '删除', set_customer: '选店' };
  var catalogStatusText = { active: '唯一在售', ambiguous: '同名多款待选', unit_mismatch: '单位不符',
    discontinued: '已下架', unmatched: '库外新货', external: '手动库外' };
  var catalogStatusClass = { active: 'ok', ambiguous: 'warn', unit_mismatch: 'warn', discontinued: 'warn',
    unmatched: 'info', external: 'info' };
  var priceSourceText = { spoken: '原话价', customer_history: '熟客价', catalog: '库内价', manual: '手改价' };
  var blockedReasonText = { locked_sheet: '客户单已锁定', new_item_after_issue: '现场不能新增原单外货品',
    next_trip_order: '下趟订单暂不处理' };
  var voiceEventOf = function (turn) {
    for (var index = 0; index < turn.events.length; index++) {
      if (turn.events[index].kind === 'voice_correction') return turn.events[index];
    }
    return null;
  };
  var modelEventsOf = function (turn) {
    return turn.events.filter(function (event) { return event.kind === 'model'; });
  };
  var toolEventsOf = function (turn) {
    return turn.events.filter(function (event) { return event.kind === 'tool'; });
  };
  var hasEvent = function (turn, kind) {
    return turn.events.some(function (event) { return event.kind === kind; });
  };
  var parseToolArgs = function (value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch (e) { return null; }
  };
  var operationRows = function (turn) {
    var fromTools = [];
    var fromModels = [];
    turn.events.forEach(function (event) {
      var payload = event.payload || {};
      if (event.kind === 'tool' && payload.name === 'edit_draft' && payload.arguments
        && Array.isArray(payload.arguments.operations)) {
        Array.prototype.push.apply(fromTools, payload.arguments.operations.filter(function (op) {
          return op && typeof op === 'object';
        }));
      }
      if (event.kind === 'model' && Array.isArray(payload.toolCalls)) {
        payload.toolCalls.forEach(function (call) {
          if (!call || call.name !== 'edit_draft') return;
          var args = parseToolArgs(call.arguments);
          if (args && Array.isArray(args.operations)) {
            Array.prototype.push.apply(fromModels, args.operations.filter(function (op) {
              return op && typeof op === 'object';
            }));
          }
        });
      }
    });
    return fromTools.length ? fromTools : fromModels;
  };
  var catalogRowsOf = function (turn) {
    var rows = [];
    turn.events.forEach(function (event) {
      var payload = event.payload || {};
      if (event.kind === 'tool' && payload.result && Array.isArray(payload.result.catalog)) {
        payload.result.catalog.forEach(function (row) { if (row && typeof row === 'object') rows.push(row); });
      }
    });
    return rows;
  };
  var intentOfTurn = function (turn) {
    var structured = null;
    var delivery = null;
    turn.events.forEach(function (event) {
      var payload = event.payload || {};
      if (event.kind === 'delivery_intent') delivery = payload;
      if (event.kind === 'model' && payload.phase === 'intent' && payload.intents) structured = payload.intents;
    });
    return { structured: structured, delivery: delivery };
  };
  var intentText = function (turn) {
    var found = intentOfTurn(turn);
    if (found.delivery) return found.delivery.adjust ? '送货核对' : '闲聊/查询';
    if (!found.structured) return '';
    var labels = [];
    if (found.structured.draft) labels.push('录单改草稿');
    if (found.structured.preview) labels.push('生成预览');
    if (found.structured.query) labels.push('闲聊/查询');
    if (found.structured.answering && found.structured.draft) labels.push('回答追问');
    return labels.join('、');
  };
  var intentModelFailed = function (turn) {
    if (hasEvent(turn, 'delivery_intent')) return false;
    return turn.events.some(function (event) {
      var payload = event.payload || {};
      return event.kind === 'model' && payload.phase === 'intent' && !payload.intents;
    });
  };
  var hasToolRecord = function (turn) {
    return toolEventsOf(turn).length > 0 || hasEvent(turn, 'plan');
  };
  var guardrailEvents = function (turn) {
    var hints = [];
    turn.events.forEach(function (event) {
      var payload = event.payload || {};
      if (event.kind === 'questions' && Array.isArray(payload.questions)) {
        payload.questions.forEach(function (question) {
          if (!question || !question.text) return;
          hints.push({ cls: 'warn', text: (question.customer ? question.customer + '：' : '') + question.text });
        });
      }
      if (event.kind === 'edit_confirmation') {
        var operations = Array.isArray(payload.operations) ? payload.operations.length : 0;
        hints.push({ cls: 'warn', text: '需要确认操作 ' + operations + ' 项，接受词「' + (payload.accept || '') + '」' });
      }
      if (event.kind === 'tool' && payload.result) {
        var result = payload.result;
        if (Array.isArray(result.issues)) {
          result.issues.forEach(function (issue) {
            var message = typeof issue === 'string' ? issue : issue && issue.message;
            if (message) hints.push({ cls: 'bad', text: message });
          });
        }
        if (Array.isArray(result.conflicts)) {
          result.conflicts.forEach(function (conflict) {
            if (!conflict) return;
            hints.push({ cls: 'warn', text: '冲突行：' +
              [conflict.customer, conflict.brand, conflict.product, conflict.specification].filter(Boolean).join(' / ') });
          });
        }
        if (result.outcome === 'error') {
          hints.push({ cls: 'bad', text: '工具报错：' + (result.errorCode || payload.name || '未知错误') });
        }
      }
    });
    return hints;
  };
  var timelineSteps = function (turn) {
    var voice = voiceEventOf(turn);
    var failed = turn.status === 'failed' || turn.status === 'interrupted';
    var ops = operationRows(turn);
    var tools = toolEventsOf(turn);
    var intent = intentText(turn);
    var received = Boolean(turn.userText && turn.userText.trim()) || (turn.materials && turn.materials.length > 0);
    var steps = [{
      label: '① 收到原话',
      state: received ? 'ok' : 'warn',
      sub: voice ? '含语音纠偏' : received ? (turn.materials && turn.materials.length ? '文字与图片' : '文字原话') : '未收到内容',
    }];
    var intentState = 'warn';
    var intentSub = '意图未明确';
    if (failed) { intentState = 'bad'; intentSub = turn.status === 'failed' ? '回合执行失败' : '回合执行中断'; }
    else if (intentModelFailed(turn)) { intentState = 'bad'; intentSub = '意图模型调用失败'; }
    else if (intent) { intentState = 'ok'; intentSub = intent; }
    else if (hasToolRecord(turn)) { intentState = 'ok'; intentSub = '快捷操作'; }
    steps.push({ label: '② 判定意图', state: intentState, sub: intentSub });
    var previewTool = tools.some(function (event) {
      var name = event.payload && event.payload.name;
      return name === 'preview_trip' || name === 'import_image' || name === 'propose_delivery';
    });
    var asked = tools.some(function (event) { return event.payload && event.payload.name === 'ask_user'; })
      || hasEvent(turn, 'questions');
    var detailState = 'warn';
    var detailSub = '无操作明细';
    if (failed) { detailState = 'bad'; detailSub = '模型或回合异常'; }
    else if (ops.length) { detailState = 'ok'; detailSub = '拆出 ' + ops.length + ' 行'; }
    else if (previewTool) { detailState = 'ok'; detailSub = '触发生成预览 / 图片识别 / 送货核对'; }
    else if (asked) { detailState = 'warn'; detailSub = '未拆明细，直接追问'; }
    else if (intent === '闲聊/查询' || (!intent && !hasToolRecord(turn))) { detailState = 'skip'; detailSub = '纯问答，未拆明细'; }
    steps.push({ label: '③ 拆出明细', state: detailState, sub: detailSub });
    var badTool = tools.some(function (event) {
      return event.payload && event.payload.result && event.payload.result.outcome === 'error';
    });
    var writeTools = tools.filter(function (event) {
      var name = event.payload && event.payload.name;
      return name === 'edit_draft' || name === 'preview_trip' || name === 'import_image' || name === 'propose_delivery';
    });
    var warned = catalogRowsOf(turn).some(function (row) {
      return row.status === 'ambiguous' || row.status === 'unit_mismatch' || row.status === 'discontinued';
    }) || guardrailEvents(turn).length > 0 || turn.undone;
    var checkState = 'ok';
    var checkSub = '顺利落草稿';
    if (failed || badTool) { checkState = 'bad'; checkSub = failed ? '回合失败' : '工具报错'; }
    else if (!writeTools.length && !warned) { checkState = 'skip'; checkSub = '未触发工具写操作'; }
    else if (!writeTools.length && warned) { checkState = 'warn'; checkSub = '仅追问，未写草稿'; }
    else if (warned) { checkState = 'warn'; checkSub = turn.undone ? '已撤销' : '存在待选/追问/拦截'; }
    else if (writeTools.some(function (event) { return event.payload && event.payload.name === 'preview_trip'; })) {
      checkSub = '完成预览';
    } else if (writeTools.some(function (event) { return event.payload && event.payload.name === 'propose_delivery'; })) {
      checkSub = '完成送货核对';
    }
    steps.push({ label: '④ 查库/护栏结果', state: checkState, sub: checkSub });
    return steps;
  };
  var timelineBarHtml = function (turn) {
    return '<div class="timeline-bar">' + timelineSteps(turn).map(function (step) {
      return '<div class="timeline-step ' + step.state + '"><span class="dot" aria-hidden="true"></span>' +
        '<span class="step-text"><span class="step-label">' + esc(step.label) + '</span>' +
        '<span class="step-sub">' + esc(step.sub) + '</span></span></div>';
    }).join('') + '</div>';
  };
  var materialThumbsHtml = function (turn) {
    if (!turn.materials.length) return '';
    return '<div class="thumbs">' + turn.materials.map(function (material) {
      return '<div class="thumb" data-thumb="' + esc(material.id) + '">加载图片…<div class="line-sub">' + esc(material.name) +
        (material.organized ? ' · 已识别' : '') + '</div></div>';
    }).join('') + '</div>';
  };
  var inputModuleHtml = function (turn) {
    var voice = voiceEventOf(turn);
    var html = '<div class="cause"><div class="cause-title">原始输入</div>';
    html += '<div class="bubble"><span class="bubble-label">配送员原话</span>' + esc(turn.userText || '（无文字）') + '</div>';
    if (voice) {
      var voicePayload = voice.payload || {};
      var corrections = Array.isArray(voicePayload.corrections) ? voicePayload.corrections : [];
      html += '<div class="voice-compare">' +
        '<div class="voice-box"><span class="voice-label">语音原转写</span><div>' + esc(voicePayload.rawText || '（无原转写）') +
        '</div></div><div class="voice-arrow">→</div>' +
        '<div class="voice-box fixed"><span class="voice-label">纠偏后提交</span><div>' +
        esc(voicePayload.text || turn.userText || '（无提交文字）') + '</div></div></div>';
      if (corrections.length) {
        html += '<div class="corrections">' + corrections.map(function (entry) {
          return '<span class="correction-tag">' + esc(entry && entry.from) + ' → ' + esc(entry && entry.to) + '</span>';
        }).join('') + '</div>';
      }
    }
    html += materialThumbsHtml(turn);
    html += '<div class="bubble assistant"><span class="bubble-label">助手回复</span>' + esc(turn.assistantText || '（暂无回复）') + '</div>';
    return html + '</div>';
  };
  var modelSummaryHtml = function (turn) {
    var models = modelEventsOf(turn);
    var html = '<div class="cause"><div class="cause-title">AI 意图与模型概况</div><div class="cause-line">';
    html += '<span>判定意图：<b>' + esc(intentText(turn) || '未明确') + '</b></span>';
    html += '<span>总耗时：' + esc(turn.elapsedMs === null || turn.elapsedMs === undefined ? '—' : turn.elapsedMs + ' ms') + '</span>';
    if (!models.length) {
      html += '<span class="muted">未记录模型调用' + (hasToolRecord(turn) ? '（快捷操作）' : '') + '</span>';
    } else {
      html += '<span>模型调用 ' + esc(models.length) + ' 次</span>';
      models.forEach(function (event) {
        var payload = event.payload || {};
        html += '<button type="button" class="chip" data-prompt-version="' + esc(payload.promptVersion || '') + '">' +
          esc(payload.model || '未标模型') + ' · ' + esc(payload.promptVersion || '未标版本') + '</button>';
      });
    }
    return html + '</div></div>';
  };
  var questionsText = function (value) {
    if (!Array.isArray(value)) return '';
    return value.map(function (question) {
      if (!question) return '';
      return (question.customer ? question.customer + '：' : '') + (question.text || '');
    }).filter(Boolean).join('；');
  };
  var previewText = function (result) {
    var payload = result || {};
    if (payload.outcome === 'issues') return '预览被拦下：' + (Array.isArray(payload.issues) ? payload.issues.join('；') : '请先核对必填项');
    var parts = [];
    if (payload.previewId) parts.push('预览 ' + String(payload.previewId).slice(0, 8));
    if (typeof payload.totalCents === 'number') parts.push('预计应收 ¥' + (payload.totalCents / 100).toFixed(2));
    if (typeof payload.pendingPrices === 'number') parts.push(payload.pendingPrices ? payload.pendingPrices + ' 处待补价' : '无待补价');
    return parts.join(' · ') || '已生成送货单预览（仍需配送员确认）';
  };
  var deliveryText = function (result, args) {
    var payload = result || {};
    var parts = [];
    if (payload.customer) parts.push(payload.customer);
    if (args && args.sheetNumber !== undefined) parts.push('第 ' + args.sheetNumber + ' 店');
    if (args && Array.isArray(args.edits)) parts.push('拟改 ' + args.edits.length + ' 行');
    if (payload.canComplete !== undefined) parts.push(payload.canComplete ? '可确认送达' : '需核对');
    if (payload.blockedReason) parts.push(blockedReasonText[payload.blockedReason] || payload.blockedReason);
    if (Array.isArray(payload.pendingPriceNames) && payload.pendingPriceNames.length) {
      parts.push('待补价：' + payload.pendingPriceNames.join('、'));
    }
    return parts.join(' · ') || '送货现场核对提案';
  };
  var actionBlocks = function (turn) {
    var blocks = [];
    toolEventsOf(turn).forEach(function (event) {
      var payload = event.payload || {};
      var name = payload.name;
      if (name === 'import_image') {
        var added = payload.result && typeof payload.result.added === 'number' ? ' · 新增 ' + payload.result.added + ' 行' : '';
        blocks.push({ title: '图片识别写入草稿', text: '已使用本回合上传的图片识别结果' + added });
      } else if (name === 'preview_trip') {
        blocks.push({ title: '生成送货单预览', text: previewText(payload.result) });
      } else if (name === 'ask_user') {
        blocks.push({ title: '向配送员追问', text: questionsText(payload.arguments && payload.arguments.questions) || '需要配送员补充信息' });
      } else if (name === 'propose_delivery') {
        blocks.push({ title: '送货核对提案', text: deliveryText(payload.result, payload.arguments) });
      }
    });
    return blocks;
  };
  var operationsModuleHtml = function (turn) {
    var ops = operationRows(turn);
    var blocks = actionBlocks(turn);
    if (!ops.length && !blocks.length) return '';
    var html = '<div class="cause"><div class="cause-title">AI 拆出哪几行</div>';
    if (ops.length) {
      html += '<div class="table-scroll"><table><thead><tr><th>动作</th><th>客户</th><th>品牌</th><th>货品</th>' +
        '<th>规格</th><th>数量单位</th><th class="num">原话单价</th></tr></thead><tbody>';
      ops.forEach(function (op) {
        var action = actionLabel[op.action] || op.action || '—';
        var customer = op.customer || (op.customerNumber !== undefined ? '第 ' + op.customerNumber + ' 店' : '—');
        var quantity = [op.quantity, op.unit].filter(Boolean).join(' ') || '—';
        html += '<tr><td>' + esc(action) + '</td><td>' + esc(customer) + '</td><td>' + esc(op.brand || '—') + '</td>' +
          '<td>' + esc(op.product || '—') + '</td><td>' + esc(op.specification || '—') + '</td>' +
          '<td>' + esc(quantity) + '</td><td class="num">' + esc(op.price ? '¥' + op.price : '—') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    blocks.forEach(function (block) {
      html += '<div class="cause-block"><b>' + esc(block.title) + '</b><div>' + esc(block.text) + '</div></div>';
    });
    return html + '</div>';
  };
  var catalogModuleHtml = function (turn) {
    var rows = catalogRowsOf(turn);
    var hints = guardrailEvents(turn);
    if (!rows.length && !hints.length) return '';
    var html = '<div class="cause"><div class="cause-title">查货品库与护栏结果</div>';
    if (rows.length) {
      html += '<div class="table-scroll"><table><thead><tr><th>输入货品/规格/单位</th><th>查库结果</th>' +
        '<th>配价来源</th><th class="num">单价</th><th>护栏提示</th></tr></thead><tbody>';
      rows.forEach(function (row) {
        var input = [row.input && row.input.product, row.input && row.input.brand,
          row.input && row.input.specification, row.input && row.input.unit].filter(Boolean).join(' / ') || '—';
        var status = catalogStatusText[row.status] || row.status || '—';
        var statusClass = catalogStatusClass[row.status] || 'muted';
        var source = priceSourceText[row.priceSource] || (row.price === null || row.price === undefined ? '待补价' : '—');
        var price = row.price === null || row.price === undefined || row.price === '' ? '—' : '¥' + row.price;
        var hint = row.priceHint || (row.status === 'ambiguous' ? '同名多款待选，需配送员选定' : '—');
        html += '<tr><td>' + esc(input) + '</td><td><span class="badge ' + statusClass + '">' + esc(status) + '</span></td>' +
          '<td>' + esc(source) + '</td><td class="num">' + esc(price) + '</td><td>' + esc(hint) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    hints.forEach(function (hint) {
      html += '<div class="hint-bar ' + (hint.cls === 'bad' ? 'bad' : '') + '">' + esc(hint.text) + '</div>';
    });
    return html + '</div>';
  };
  var changesModuleHtml = function (turn) {
    var links = [];
    var changes = [];
    turn.events.forEach(function (event) {
      var payload = event.payload || {};
      if (event.kind === 'customer_links' && Array.isArray(payload.links)) {
        Array.prototype.push.apply(links, payload.links.filter(function (link) { return link && typeof link === 'object'; }));
      }
      if (event.kind === 'change' && Array.isArray(payload.lines)) {
        Array.prototype.push.apply(changes, payload.lines.filter(function (line) { return typeof line === 'string'; }));
      }
    });
    var revision = turn.startRevision === turn.endRevision
      ? '修订 ' + turn.startRevision + '（未变）' : '修订 ' + turn.startRevision + ' → ' + turn.endRevision;
    var html = '<div class="cause"><div class="cause-title">草稿最终改了什么</div>';
    html += '<div class="cause-line"><span>' + esc(revision) + '</span>' +
      (turn.undone ? '<span class="badge warn">已撤销</span>' : '') + '</div>';
    if (links.length) {
      html += '<div class="cause-block"><b>认人关联</b><div>' + links.map(function (link) {
        return '<span class="correction-tag">' + esc(link.spoken) + ' → ' + esc(link.canonicalName) +
          (link.merged ? '（合并）' : '') + '</span>';
      }).join(' ') + '</div></div>';
    }
    if (changes.length) {
      html += '<div class="cause-block"><b>改动明细</b><ul class="change-list">' + changes.map(function (line) {
        return '<li>' + esc(line) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (!links.length && !changes.length) html += '<div class="cause-line muted">本轮没有改动草稿。</div>';
    return html + '</div>';
  };
  var renderTurns = function () {
    var turns = state.scope.turns;
    if (state.onlyAnomaly) {
      turns = turns.filter(function (turn) { return turnSignals(turn).length > 0; });
    }
    if (!turns.length) {
      el('turns').innerHTML = '<div class="notice">' + (state.onlyAnomaly ? '没有符合筛选条件的回合。' : '这个范围还没有对话回合。') + '</div>';
      return;
    }
    var html = '';
    turns.forEach(function (turn) {
      var signals = turnSignals(turn);
      var bad = signals.some(function (signal) { return signal.cls === 'bad'; });
      var warn = signals.some(function (signal) { return signal.cls === 'warn'; });
      var others = [];
      var modelEvents = [];
      var toolEvents = [];
      html += '<article class="turn ' + (bad ? 'bad' : warn ? 'warn' : '') + '">';
      html += '<div class="turn-head"><span class="mono">' + esc(turn.createdAt ? new Date(turn.createdAt).toLocaleString() : '') + '</span>' +
        '<span class="badge ' + (turn.status === 'completed' ? 'ok' : bad ? 'bad' : 'warn') + '">' +
        esc(statusLabel[turn.status] || turn.status) + '</span>' +
        signals.map(function (signal) {
          return '<span class="badge ' + signal.cls + '">' + esc(signal.label) + '</span>';
        }).join('') +
        '<span>修订 ' + esc(turn.startRevision) + ' → ' + esc(turn.endRevision) + '</span>' +
        (turn.elapsedMs !== null ? '<span>总耗时 ' + esc(turn.elapsedMs) + ' ms</span>' : '') +
        '<span class="spacer"></span>' +
        '<span class="turn-actions"><button type="button" data-eval-export="' + esc(turn.id) + '">导出评测 Case</button>' +
        '<button type="button" data-eval-copy="' + esc(turn.id) + '">复制 Case</button></span>' +
        '<span class="mono muted">' + esc(turn.id) + '</span></div>';
      html += timelineBarHtml(turn);
      html += inputModuleHtml(turn);
      html += modelSummaryHtml(turn);
      html += operationsModuleHtml(turn);
      html += catalogModuleHtml(turn);
      html += changesModuleHtml(turn);
      turn.events.forEach(function (event) {
        if (event.kind === 'model') { modelEvents.push(event); return; }
        if (event.kind === 'tool') { toolEvents.push(event); return; }
        others.push(event);
      });
      html += '<details class="raw-tech"><summary>查看原始技术报文 ▸（模型调用 / 工具入参 / ' +
        esc(turn.events.length) + ' 条原始事件）</summary>';
      modelEvents.forEach(function (event) { html += modelCardHtml(event.payload || {}); });
      toolEvents.forEach(function (event) { html += toolCardHtml(event.payload || {}); });
      if (others.length) {
        html += '<ul class="event-list">';
        others.forEach(function (event) {
          html += '<li><span class="kind">' + esc(event.kind) + '</span>' + esc(summarizeEvent(event)) + '</li>';
        });
        html += '</ul>';
      }
      html += '<details class="raw"><summary>展开原始事件 JSON（' + esc(turn.events.length) + ' 条）</summary><pre>' +
        esc(JSON.stringify(turn.events, null, 2)) + '</pre></details>';
      html += '</details>';
      html += '</article>';
    });
    el('turns').innerHTML = html;
    loadThumbs();
  };
  var loadThumbs = function () {
    var nodes = document.querySelectorAll('[data-thumb]');
    var accountId = state.accountId;
    Array.prototype.forEach.call(nodes, function (node) {
      var id = node.getAttribute('data-thumb');
      var key = accountId + ':' + id;
      if (state.materialSources[key]) {
        injectThumb(node, state.materialSources[key]);
        return;
      }
      fetch('/admin/api/accounts/' + accountId + '/materials/' + id + '/content', {
        headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store'
      }).then(function (response) {
        if (!response.ok) throw new Error('图片 ' + response.status);
        return response.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        if (!state.token || accountId !== state.accountId) {
          URL.revokeObjectURL(url);
          return;
        }
        state.materialSources[key] = url;
        injectThumb(node, url);
      }).catch(function (error) {
        node.textContent = '图片加载失败：' + error.message;
      });
    });
  };
  var injectThumb = function (node, url) {
    node.innerHTML = '';
    var image = document.createElement('img');
    image.src = url;
    image.alt = '上传原图';
    image.addEventListener('click', function () { openLightbox(url); });
    node.appendChild(image);
  };
  var openLightbox = function (url) {
    el('lightbox-img').src = url;
    el('lightbox').classList.remove('hidden');
    setStatus('已放大原图，点击黑色遮罩关闭。');
  };
  var setView = function (view, quiet) {
    state.view = view;
    el('diagnostics-view').classList.toggle('hidden', view !== 'diagnostics');
    el('prompts-view').classList.toggle('hidden', view !== 'prompts');
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.classList.toggle('active', button.getAttribute('data-view') === view);
    });
    if (view === 'prompts') loadPrompts().catch(function () { /* 顶部状态已提示 */ });
    if (!quiet) {
      var label = view === 'prompts' ? '提示词与工具看板' : '单据与对话排障';
      setStatus('已切换到「' + label + '」。');
      toast('已切换到「' + label + '」。', 'info');
    }
  };
  var loadPrompts = function () {
    if (state.prompts) { renderPrompts(); return Promise.resolve(); }
    setStatus('正在读取提示词与工具模板…');
    return api('/prompts').then(function (data) {
      state.prompts = data.prompts;
      setStatus('提示词与工具模板为当前服务端只读快照。');
      renderPrompts();
    }).catch(function (error) {
      setStatus(error.message, true);
      throw error;
    });
  };
  var renderPrompts = function () {
    var html = '';
    state.prompts.forEach(function (entry, index) {
      var focused = state.focusVersion && entry.version === state.focusVersion;
      html += '<article class="prompt-card' + (focused ? ' focus' : '') + '" data-prompt-card="' + index + '">';
      html += '<div class="card-head"><h3>' + esc(entry.title) + '</h3><div class="row-actions">' +
        '<span class="badge muted">' + esc(entry.module) + '</span>' +
        '<span class="badge info mono">' + esc(entry.version) + '</span>' +
        '<button type="button" data-copy-prompt="' + index + '">复制全文</button></div></div>';
      html += '<div class="meta">' + esc(entry.description) + '</div>';
      entry.prompts.forEach(function (prompt) {
        html += '<div class="prompt-block"><label>' + esc(prompt.label) + '</label><pre class="prompt-text">' +
          esc(prompt.text) + '</pre></div>';
      });
      if (entry.tools) {
        html += '<details class="tools"><summary>展开工具 JSON Schema</summary><pre>' +
          esc(JSON.stringify(entry.tools, null, 2)) + '</pre></details>';
      }
      html += '</article>';
    });
    el('prompts').innerHTML = html;
    if (state.focusVersion) {
      var card = document.querySelector('.prompt-card.focus');
      if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };
  var copyPrompt = function (index) {
    var entry = state.prompts[index];
    if (!entry) return;
    var text = entry.prompts.map(function (prompt) { return '【' + prompt.label + '】\\n' + prompt.text; }).join('\\n\\n');
    copyText(text, function () {
      setStatus('已复制「' + entry.title + '」全文。');
      toast('已复制「' + entry.title + '」全文。', 'success');
    }, function () {
      setStatus('复制失败，请手动选择文本。', true);
      toast('复制失败：未能写入剪贴板，请手动选择文本。', 'error');
    });
  };
  var turnHitCatalog = function (turnId) {
    var turn = state.scope && state.scope.turns.filter(function (item) { return item.id === turnId; })[0];
    if (!turn) return false;
    return turn.events.some(function (event) {
      return event.kind === 'tool' && event.payload && event.payload.result &&
        Array.isArray(event.payload.result.catalog);
    });
  };
  var evalCasePath = function (turnId) {
    return '/accounts/' + state.accountId + '/turns/' + turnId + '/eval-case' +
      (turnHitCatalog(turnId) ? '?catalog=1' : '');
  };
  var copyEvalCase = function (turnId) {
    if (!state.accountId) {
      toast('请先选择配送员账号。', 'error');
      return;
    }
    setStatus('正在读取评测 Case…');
    api(evalCasePath(turnId)).then(function (data) {
      var text = JSON.stringify(data, null, 2);
      copyText(text, function () {
        setStatus('已复制 ' + data.id + ' 的评测 Case JSON。');
        toast('已复制 ' + data.id + ' 评测 Case。', 'success');
      }, function () {
        setStatus('复制失败，请改用导出按钮。', true);
        toast('复制失败：未能写入剪贴板，请改用「导出评测 Case」。', 'error');
      });
    }).catch(function (error) {
      setStatus(error.message, true);
      toast('复制失败：' + error.message, 'error');
    });
  };
  var exportEvalCase = function (turnId) {
    if (!state.accountId) {
      toast('请先选择配送员账号。', 'error');
      return;
    }
    setStatus('正在导出评测 Case…');
    api(evalCasePath(turnId)).then(function (data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = data.id + '.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('已导出 ' + data.id + '.json；含脱敏环境、Trace 与双层 Grader 模板。');
      toast('已导出 ' + data.id + '.json。', 'success');
    }).catch(function (error) {
      setStatus(error.message, true);
      toast('导出失败：' + error.message, 'error');
    });
  };
  el('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = el('login-token').value.trim();
    if (!value) {
      el('login-error').textContent = '请输入排障后台口令。';
      toast('请输入排障后台口令。', 'error');
      return;
    }
    state.token = value;
    sessionStorage.setItem('dispatchAdminToken', value);
    el('login-error').textContent = '';
    loadAccounts().then(function () {
      el('login').classList.add('hidden');
      el('app').classList.remove('hidden');
      toast('已进入排障后台。', 'success');
    }).catch(function (error) {
      state.token = '';
      sessionStorage.removeItem('dispatchAdminToken');
      el('login-error').textContent = error.message;
      toast('登录失败：' + error.message, 'error');
      showLogin();
    });
  });
  el('logout').addEventListener('click', function () {
    logout(false);
    toast('已退出口令。', 'info');
  });
  el('refresh').addEventListener('click', function () {
    if (state.view === 'prompts') {
      state.prompts = null;
      loadPrompts().then(function () {
        toast('已刷新提示词与工具模板。', 'success');
      }, function (error) {
        toast('刷新失败：' + error.message, 'error');
      });
    } else if (state.accountId) {
      state.catalog = null;
      loadAccounts().then(function () {
        toast('已刷新最新排障数据。', 'success');
      }, function (error) {
        toast('刷新失败：' + error.message, 'error');
      });
    } else {
      toast('当前没有可刷新的配送员账号。', 'info');
    }
  });
  el('account-select').addEventListener('change', function (event) {
    clearMaterialUrls();
    state.accountId = event.target.value;
    state.catalog = null;
    currentScopeValue = '';
    loadOverview().then(function () {
      var account = state.accounts.filter(function (item) { return item.id === state.accountId; })[0];
      toast('已切换到配送员 ' + (account ? account.subject : state.accountId.slice(0, 8)) + '。', 'success');
    }, function (error) {
      toast('切换账号失败：' + error.message, 'error');
    });
  });
  el('scope-select').addEventListener('change', function () {
    loadScope().then(function () {
      var select = el('scope-select');
      var label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '所选范围';
      toast('已载入「' + label + '」。', 'success');
    }, function (error) {
      toast('载入范围失败：' + error.message, 'error');
    });
  });
  el('anomaly-filter').addEventListener('change', function (event) {
    state.onlyAnomaly = event.target.checked;
    if (state.scope) renderTurns();
    var count = document.querySelectorAll('#turns article.turn').length;
    var message = state.onlyAnomaly ? '已筛选出 ' + count + ' 轮需关注回合。' : '已显示全部 ' + count + ' 轮回合。';
    setStatus(message);
    toast(message, 'info');
  });
  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'catalog-search') {
      state.catalogFilter = event.target.value;
      renderCatalogRows();
    }
  });
  document.addEventListener('change', function (event) {
    if (event.target && event.target.id === 'catalog-status') {
      state.catalogStatus = event.target.value;
      renderCatalogRows();
    }
  });
  document.addEventListener('click', function (event) {
    var view = event.target.closest('[data-view]');
    if (view) { setView(view.getAttribute('data-view')); return; }
    var left = event.target.closest('[data-left]');
    if (left) {
      state.left = left.getAttribute('data-left');
      Array.prototype.forEach.call(document.querySelectorAll('[data-left]'), function (button) {
        button.classList.toggle('active', button.getAttribute('data-left') === state.left);
      });
      if (state.left === 'catalog') {
        if (state.accountId) loadCatalogView().catch(function () { /* 顶部状态已提示 */ });
        else renderCatalogView();
      } else {
        renderLeft();
      }
      var leftLabel = { sheets: '送货单', picking: '取货单', memory: '熟客与叫法', catalog: '货品库' }[state.left] || state.left;
      setStatus('已切换到「' + leftLabel + '」视图。');
      toast('已切换到「' + leftLabel + '」。', 'info');
      return;
    }
    var version = event.target.closest('[data-prompt-version]');
    if (version) {
      var versionLabel = version.getAttribute('data-prompt-version');
      state.focusVersion = versionLabel;
      setView('prompts', true);
      toast('已定位到版本 ' + (versionLabel || '未标版本') + ' 的提示词卡片。', 'success');
      return;
    }
    var copy = event.target.closest('[data-copy-prompt]');
    if (copy) { copyPrompt(Number(copy.getAttribute('data-copy-prompt'))); return; }
    var exportCase = event.target.closest('[data-eval-export]');
    if (exportCase) { exportEvalCase(exportCase.getAttribute('data-eval-export')); return; }
    var copyCase = event.target.closest('[data-eval-copy]');
    if (copyCase) { copyEvalCase(copyCase.getAttribute('data-eval-copy')); return; }
    if (event.target === el('lightbox')) {
      el('lightbox').classList.add('hidden');
      setStatus('已关闭原图。');
    }
  });
  boot();
})();
</script>
</body>
</html>`;
