export const adminStyles = `
  :root {
    --bg: #F5F6F8;
    --paper: #FFFFFF;
    --line: #E2E8F0;
    --ink: #0F172A;
    --muted: #64748B;
    --green: #0F6E52;
    --green-dark: #0A5640;
    --green-soft: #ECFDF5;
    --amber: #B45309;
    --amber-soft: #FEF3C7;
    --red: #B91C1C;
    --red-soft: #FEE2E2;
    --slate-soft: #F1F5F9;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --shadow: 0 10px 28px rgba(15, 23, 42, .06);
    --shadow-lg: 0 24px 60px rgba(15, 23, 42, .18);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
    -webkit-font-smoothing: antialiased;
  }
  button, input, select, textarea { font: inherit; }
  button { cursor: pointer; }
  b, strong { font-weight: 700; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--mono); }
  .money, .num, .tabular, .metric-value, .picking-qty b, .todo-num, .code-display {
    font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
  }
  .text-amber { color: var(--amber); font-weight: 700; }
  .line-sub { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; line-height: 1.45; word-break: break-word; }
  .sub-warn { display: inline-block; margin-left: 6px; color: var(--amber); font-size: 11px; }
  .full-span { grid-column: 1 / -1; }
  .num { text-align: right; white-space: nowrap; }

  /* ---------- login ---------- */
  .login-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 28px 18px; background:
      radial-gradient(900px 420px at 50% -10%, rgba(15, 110, 82, .12), transparent 65%),
      var(--bg);
  }
  .login-card {
    width: min(440px, 100%); padding: 30px 30px 26px; background: var(--paper);
    border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow-lg);
  }
  .login-badge {
    display: inline-block; margin-bottom: 14px; padding: 4px 10px; border-radius: 999px;
    background: var(--green-soft); color: var(--green); font-size: 12px; font-weight: 800; letter-spacing: .06em;
  }
  .login-card h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.3; letter-spacing: -.01em; }
  .login-card p { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  .login-card input {
    width: 100%; margin-top: 6px; padding: 12px 13px; border: 1px solid var(--line);
    border-radius: 10px; background: #fff; color: var(--ink); outline: none;
  }
  .login-card input:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(15, 110, 82, .14); }
  .login-card .btn { width: 100%; margin-top: 14px; }
  .login-error { min-height: 20px; margin-top: 10px; color: var(--red); font-size: 12px; }
  .login-foot { margin: 14px 0 0 !important; color: var(--muted); font-size: 11px !important; line-height: 1.6; }
  .field-label { display: block; color: var(--ink); font-size: 12px; font-weight: 700; }

  /* ---------- app shell ---------- */
  .app { display: flex; min-height: 100vh; }
  .sidebar {
    position: sticky; top: 0; z-index: 20; flex: 0 0 224px; width: 224px; height: 100vh;
    display: flex; flex-direction: column; padding: 18px 12px 14px;
    background: #FBFCFD; border-right: 1px solid var(--line);
  }
  .side-brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 18px; }
  .brand-mark {
    flex: 0 0 auto; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 10px; background: var(--green); color: #fff; font-size: 17px; font-weight: 800;
  }
  .side-brand b { display: block; font-size: 15px; letter-spacing: .01em; }
  .side-brand span { display: block; color: var(--muted); font-size: 11px; }
  .side-nav { flex: 1; min-height: 0; overflow: auto; padding: 2px 2px 10px; }
  .nav-group { margin-top: 16px; }
  .nav-group-label {
    display: block; padding: 0 12px 6px; color: #94A3B8; font-size: 10px; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
  }
  .nav-item {
    position: relative; width: 100%; display: flex; align-items: center; gap: 9px;
    padding: 9px 10px; margin: 2px 0; border: 0; border-radius: 9px; background: transparent;
    color: #334155; font-size: 13px; font-weight: 600; text-align: left;
  }
  .nav-item:hover { background: #F1F5F9; color: var(--ink); }
  .nav-item.active { background: var(--green-soft); color: var(--green-dark); }
  .nav-item.active::before {
    content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px;
    border-radius: 0 3px 3px 0; background: var(--green);
  }
  .nav-icon {
    flex: 0 0 auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; background: #EEF2F6; color: #475569; font-size: 11px; font-weight: 800;
  }
  .nav-item.active .nav-icon { background: var(--green); color: #fff; }
  .nav-text { flex: 1; min-width: 0; }
  .nav-badge {
    flex: 0 0 auto; min-width: 19px; height: 19px; padding: 0 6px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums;
  }
  .nav-badge.danger { background: var(--red-soft); color: var(--red); }
  .nav-badge.warn { background: var(--amber-soft); color: var(--amber); }
  .side-foot { padding: 12px 10px 0; border-top: 1px solid var(--line); color: #94A3B8; font-size: 10px; }
  .main-shell { flex: 1; min-width: 0; }
  .topbar {
    position: sticky; top: 0; z-index: 18; min-height: 58px; display: flex; flex-wrap: wrap;
    align-items: center; justify-content: space-between; gap: 10px 18px;
    padding: 10px 26px; background: rgba(255, 255, 255, .92);
    border-bottom: 1px solid var(--line); backdrop-filter: blur(8px);
  }
  .context { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0; }
  .context-label { color: var(--muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
  .account-select {
    max-width: 320px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--paper); color: var(--ink); font-size: 13px; font-weight: 600;
  }
  .account-select:focus { outline: none; border-color: var(--green); box-shadow: 0 0 0 3px rgba(15, 110, 82, .12); }
  .context-hint { padding: 3px 9px; border-radius: 999px; background: var(--slate-soft); color: var(--muted); font-size: 11px; }
  .context-hint:empty { display: none; }
  .topbar-actions { display: flex; align-items: center; gap: 8px; }
  #view { width: 100%; max-width: 1480px; margin: 0 auto; padding: 24px 26px 56px; outline: none; }

  /* ---------- buttons ---------- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 14px; border: 1px solid transparent; border-radius: 9px;
    background: #fff; color: var(--ink); font-size: 13px; font-weight: 700; white-space: nowrap;
  }
  .btn:hover { filter: brightness(.98); }
  .btn:disabled { opacity: .58; cursor: progress; }
  .btn-primary { background: var(--green); color: #fff; }
  .btn-primary:hover { background: var(--green-dark); }
  .btn-secondary { border-color: var(--line); background: #fff; color: var(--green-dark); }
  .btn-secondary:hover { background: var(--green-soft); }
  .btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
  .btn-ghost:hover { background: var(--slate-soft); color: var(--ink); }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-danger-outline { border-color: #FCA5A5; background: #fff; color: var(--red); }
  .btn-danger-outline:hover { background: var(--red-soft); }
  .btn-primary-outline { border-color: #A7D7C8; background: #fff; color: var(--green-dark); }
  .btn-primary-outline:hover { background: var(--green-soft); }
  .btn-small { padding: 5px 9px; border-radius: 7px; font-size: 11px; }
  .btn-block { width: 100%; }
  .row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .back-link {
    display: inline-flex; align-items: center; gap: 4px; padding: 0; margin-bottom: 12px;
    border: 0; background: transparent; color: var(--green-dark); font-size: 13px; font-weight: 700;
  }
  .back-link:hover { text-decoration: underline; }

  /* ---------- page head / cards ---------- */
  .page-head {
    display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
    gap: 10px 16px; margin: 2px 0 18px;
  }
  .page-head h1 { margin: 0 0 3px; font-size: 24px; line-height: 1.3; letter-spacing: -.01em; }
  .page-head p { margin: 0; color: var(--muted); font-size: 13px; }
  .page-head .page-tag { margin-top: 4px; }
  .card {
    min-width: 0; margin-bottom: 16px; padding: 18px 20px; background: var(--paper);
    border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
  }
  .card-head {
    display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
    gap: 8px 14px; margin-bottom: 14px;
  }
  .card-head h2 { margin: 0; font-size: 17px; line-height: 1.35; }
  .card-head h3 { margin: 0; font-size: 14px; }
  .card-head p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
  .card-head .card-head-side { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
  .section-kicker { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; }
  .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .dashboard-grid > .card { margin-bottom: 0; display: flex; flex-direction: column; }
  .dashboard-grid + .card { margin-top: 16px; }

  /* ---------- badges / pills ---------- */
  .badge {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 700; line-height: 1.6; white-space: nowrap;
  }
  .badge.ok { background: var(--green-soft); color: var(--green-dark); }
  .badge.warn { background: var(--amber-soft); color: var(--amber); }
  .badge.bad { background: var(--red-soft); color: var(--red); }
  .badge.info { background: #EEF2F6; color: #334155; }
  .badge.neutral { background: var(--slate-soft); color: var(--muted); }
  .stage-pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 800; white-space: nowrap;
  }
  .stage-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .stage-pill.info { background: var(--slate-soft); color: #334155; }
  .stage-pill.warn { background: var(--amber-soft); color: var(--amber); }
  .stage-pill.ok { background: var(--green-soft); color: var(--green-dark); }

  /* ---------- metrics ---------- */
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .metric {
    min-width: 0; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; background: #FBFCFD;
  }
  .metric-label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 600; }
  .metric-value { font-size: 19px; font-weight: 800; line-height: 1.35; word-break: break-word; }
  .metric-note { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; line-height: 1.45; }
  .metric .badge { font-size: 13px; padding: 3px 10px; }
  .pulse-progress { margin-top: 16px; padding-top: 0; }
  .pulse-progress-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; color: var(--muted); font-size: 11px; }
  .pulse-progress-head b { color: var(--ink); font-size: 12px; }
  .pulse-track { height: 7px; overflow: hidden; border-radius: 999px; background: var(--slate-soft); }
  .pulse-track span { display: block; height: 100%; border-radius: inherit; background: var(--green); transition: width .3s ease; }
  .pulse-progress .metric-note { margin-top: 7px; }

  /* ---------- todo cards ---------- */
  .todo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
  .todo-card {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 15px;
    border: 1px solid var(--line); border-radius: 12px; background: #fff; text-align: left;
  }
  .todo-card:hover { border-color: #A7D7C8; background: #FBFEFC; }
  .todo-card.needs { border-color: #FCD34D; background: #FFFDF5; }
  .todo-card.done { opacity: .72; }
  .todo-num {
    flex: 0 0 auto; width: 46px; height: 46px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 12px; background: var(--slate-soft); color: var(--muted); font-size: 20px; font-weight: 800;
  }
  .todo-card.needs .todo-num { background: var(--amber-soft); color: var(--amber); }
  .todo-copy { flex: 1; min-width: 0; }
  .todo-copy b { display: block; font-size: 13px; }
  .todo-copy span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; line-height: 1.5; }
  .todo-action { flex: 0 0 auto; color: var(--green-dark); font-size: 12px; font-weight: 700; white-space: nowrap; }

  /* ---------- status lights ---------- */
  .light-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
  .light {
    display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px;
    border: 1px solid var(--line); border-radius: 9px; background: #FBFCFD; min-width: 0;
  }
  .light-dot { flex: 0 0 auto; width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; background: #94A3B8; }
  .light.on .light-dot { background: #16A34A; box-shadow: 0 0 0 3px rgba(22, 163, 74, .14); }
  .light.off .light-dot { background: #94A3B8; }
  .light.bad .light-dot { background: var(--red); box-shadow: 0 0 0 3px rgba(185, 28, 28, .12); }
  .light b { display: block; font-size: 12px; }
  .light span { display: block; color: var(--muted); font-size: 10px; line-height: 1.45; word-break: break-word; }
  .help-dot {
    display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px;
    margin-left: 4px; border-radius: 50%; background: var(--slate-soft); color: var(--muted);
    font-size: 10px; font-weight: 800; cursor: help; vertical-align: 1px;
  }

  /* ---------- tables ---------- */
  .table-wrap { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 9px 8px; border-bottom: 1px solid #EDF1F5; text-align: left; vertical-align: top; }
  th { color: var(--muted); background: #F8FAFC; font-weight: 700; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: #FBFCFD; }
  tr.row-current { background: #F6FDF9; }
  .cell-main { font-weight: 700; }
  .table-empty { padding: 22px 10px; color: var(--muted); text-align: center; }

  /* ---------- trips ---------- */
  .trip-row {
    display: grid; grid-template-columns: minmax(120px, 1.1fr) minmax(110px, .9fr) minmax(80px, .6fr)
      minmax(120px, 1fr) minmax(90px, .7fr) auto; gap: 10px; align-items: center;
    width: 100%; padding: 12px 13px; margin: 5px 0; border: 1px solid var(--line);
    border-radius: 11px; background: #fff; color: var(--ink); text-align: left;
  }
  .trip-row:hover { border-color: #A7D7C8; background: #FBFEFC; }
  .trip-row.current { border-color: #A7D7C8; background: var(--green-soft); }
  .trip-date b { display: block; font-size: 13px; }
  .trip-date span { display: block; color: var(--muted); font-size: 11px; }
  .trip-metric { color: var(--muted); font-size: 11px; }
  .trip-metric b { color: var(--ink); font-size: 13px; }
  .trip-go { justify-self: end; color: var(--green-dark); font-size: 12px; font-weight: 700; white-space: nowrap; }
  .trip-hero .metric-grid { margin-top: 4px; }
  .seg-tabs {
    display: flex; gap: 6px; padding: 5px; margin-bottom: 14px; border: 1px solid var(--line);
    border-radius: 12px; background: #F8FAFC;
  }
  .seg-tab {
    flex: 1; min-width: 0; padding: 10px 12px; border: 0; border-radius: 9px; background: transparent;
    color: var(--muted); font-size: 13px; font-weight: 700; text-align: center;
  }
  .seg-tab span { display: inline-block; margin-left: 5px; color: inherit; font-size: 11px; opacity: .8; }
  .seg-tab:hover { background: #EEF2F6; color: var(--ink); }
  .seg-tab.active { background: #fff; color: var(--green-dark); box-shadow: 0 1px 3px rgba(15, 23, 42, .08); }
  .customer-card { margin-bottom: 14px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
  .customer-card:last-child { margin-bottom: 0; }
  .customer-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .customer-head h3 { margin: 0; font-size: 15px; }
  .customer-money { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-bottom: 9px; color: var(--muted); font-size: 12px; }
  .customer-money b { color: var(--ink); }
  .line-tag { display: inline-flex; gap: 4px; flex-wrap: wrap; }

  /* ---------- cold storage picking ---------- */
  .picking-summary { margin-bottom: 12px; color: var(--muted); font-size: 12px; }
  .picking-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
  .picking-item {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: #fff;
  }
  .picking-name { min-width: 0; }
  .picking-name b { display: block; font-size: 15px; line-height: 1.35; word-break: break-word; }
  .picking-name span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; word-break: break-word; }
  .picking-qty {
    flex: 0 0 auto; min-width: 78px; padding: 8px 12px; border-radius: 12px;
    text-align: center; background: var(--slate-soft); color: #334155;
  }
  .picking-qty b { display: block; font-size: 26px; line-height: 1.1; }
  .picking-qty span { display: block; margin-top: 2px; font-size: 11px; font-weight: 700; }
  .picking-qty.is-box { background: var(--green-soft); color: var(--green-dark); }

  /* ---------- chat ---------- */
  .chat-note {
    margin-bottom: 12px; padding: 8px 11px; border: 1px dashed var(--line); border-radius: 9px;
    color: var(--muted); font-size: 12px;
  }
  .chat-panel { padding: 4px 2px; }
  .chat-day { margin: 14px 0 10px; color: #94A3B8; font-size: 10px; text-align: center; }
  .chat-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; }
  .chat-row.user { flex-direction: row-reverse; }
  .chat-avatar {
    flex: 0 0 auto; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9px; background: var(--slate-soft); color: #475569; font-size: 11px; font-weight: 800;
  }
  .chat-row.user .chat-avatar { background: var(--green); color: #fff; }
  .chat-row.assistant .chat-avatar { background: #EEF2F6; color: #334155; }
  .chat-bubble {
    position: relative; min-width: 0; max-width: min(680px, 78%); padding: 10px 12px 8px;
    border: 1px solid var(--line); border-radius: 4px 12px 12px 12px; background: #fff;
  }
  .chat-row.user .chat-bubble { border-color: #BBE5D6; border-radius: 12px 4px 12px 12px; background: var(--green-soft); }
  .chat-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.7; }
  .chat-thumbs { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
  .chat-thumb {
    width: 116px; height: 88px; display: flex; align-items: center; justify-content: center;
    overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #F4F6F8;
    color: var(--muted); font-size: 10px; text-align: center;
  }
  .chat-thumb img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
  .chat-jump {
    display: block; margin: 7px 0 0 auto; padding: 2px 0; border: 0; background: transparent;
    color: var(--green-dark); font-size: 11px; font-weight: 700;
  }
  .chat-jump:hover { text-decoration: underline; }

  /* ---------- empty / loading / placeholder ---------- */
  .loading-card, .empty-card, .error-card, .placeholder-card {
    padding: 48px 24px; border: 1px solid var(--line); border-radius: 14px;
    background: var(--paper); text-align: center; box-shadow: var(--shadow);
  }
  .loading-card { color: var(--muted); font-size: 13px; }
  .spinner {
    display: inline-block; width: 14px; height: 14px; margin-right: 8px; vertical-align: -2px;
    border: 2px solid #D7E3DE; border-top-color: var(--green); border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty-card h2, .error-card h2, .placeholder-card h2 { margin: 8px 0; font-size: 18px; }
  .empty-card p, .error-card p, .placeholder-card p { max-width: 520px; margin: 0 auto 16px; color: var(--muted); font-size: 13px; }
  .placeholder-mark {
    display: inline-block; padding: 5px 11px; border-radius: 999px; background: var(--amber-soft);
    color: var(--amber); font-size: 12px; font-weight: 800;
  }
  .placeholder-context {
    display: inline-block; margin: 0 0 14px; padding: 7px 11px; border-radius: 8px;
    background: var(--slate-soft); color: #475569; font-size: 12px;
  }
  .notice {
    padding: 10px 12px; margin-bottom: 12px; border: 1px dashed var(--line); border-radius: 9px;
    color: var(--muted); font-size: 12px;
  }
  .notice.warn { border-color: #FCD34D; background: #FFFDF5; color: #92400E; }

  /* ---------- forms / filters ---------- */
  .filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  .filter-bar label { color: var(--muted); font-size: 12px; }
  .select, .text-input {
    padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink);
  }
  .select:focus, .text-input:focus { outline: none; border-color: var(--green); box-shadow: 0 0 0 3px rgba(15, 110, 82, .12); }
  .inline-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
  .field { min-width: 0; }
  .field.grow { flex: 1 1 260px; }
  .field .text-input { width: 100%; margin-top: 5px; }
  .field-hint { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }

  /* ---------- account / code ---------- */
  .code-display {
    margin: 14px 0; padding: 16px; border: 1px dashed #A7D7C8; border-radius: 12px;
    background: var(--green-soft); color: var(--green-dark);
    font: 800 26px/1.3 var(--mono); letter-spacing: .08em; text-align: center; word-break: break-all;
  }
  .code-actions { display: flex; justify-content: center; margin-top: 10px; }
  .modal-note { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
  .modal-warn { margin: 10px 0 0; padding: 9px 11px; border-radius: 8px; background: var(--amber-soft); color: #92400E; font-size: 12px; }
  .modal-error { min-height: 18px; margin-top: 8px; color: var(--red); font-size: 12px; }
  .soft-details { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
  .soft-details > summary { color: var(--muted); font-size: 12px; font-weight: 700; cursor: pointer; }
  .soft-details > summary:hover { color: var(--green-dark); }
  .rule-card { margin-top: 12px; padding: 13px; border: 1px solid var(--line); border-radius: 11px; background: #fff; }
  .prompt-block { margin-top: 9px; }
  .prompt-block label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 700; }
  .prompt-text {
    margin: 3px 0 0; padding: 10px; border-radius: 8px; background: #F8FAFC; color: #1E293B;
    border: 1px solid var(--line); font: 11px/1.6 var(--mono); white-space: pre-wrap;
    word-break: break-word; max-height: 320px; overflow: auto;
  }
  .loading-inline { padding: 16px; color: var(--muted); font-size: 12px; text-align: center; }

  /* ---------- modal ---------- */
  .modal-root { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal-backdrop { position: absolute; inset: 0; background: rgba(15, 23, 42, .5); backdrop-filter: blur(2px); }
  .modal-card {
    position: relative; z-index: 1; width: min(540px, 100%); max-height: min(84vh, 760px);
    display: flex; flex-direction: column; background: #fff; border-radius: 16px; box-shadow: var(--shadow-lg);
    animation: modal-in .16s ease-out;
  }
  @keyframes modal-in { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
  .modal-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 18px 20px 8px;
  }
  .modal-head h2 { margin: 0; font-size: 17px; line-height: 1.4; }
  .modal-x { padding: 0 4px; border: 0; background: transparent; color: var(--muted); font-size: 22px; line-height: 1; }
  .modal-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 20px 6px; color: #1E293B; font-size: 13px; }
  .modal-body p { margin: 6px 0; }
  .modal-actions {
    display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px;
    border-top: 1px solid #F1F5F9;
  }

  /* ---------- lightbox ---------- */
  .lightbox {
    position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: rgba(2, 6, 23, .86);
  }
  .lightbox-inner { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .lightbox img { max-width: 92vw; max-height: 86vh; border-radius: 10px; box-shadow: 0 24px 70px rgba(0, 0, 0, .45); }
  .lightbox-caption { color: #E2E8F0; font-size: 12px; }
  .lightbox-close {
    position: fixed; top: 18px; right: 22px; width: 38px; height: 38px; border: 0; border-radius: 50%;
    background: rgba(255, 255, 255, .16); color: #fff; font-size: 24px; line-height: 1;
  }

  /* ---------- toast ---------- */
  .toast-stack {
    position: fixed; right: 20px; bottom: 20px; z-index: 60; display: flex; flex-direction: column;
    gap: 8px; width: min(380px, calc(100vw - 40px)); pointer-events: none;
  }
  .toast {
    display: flex; align-items: flex-start; gap: 8px; padding: 11px 12px;
    border: 1px solid var(--line); border-left: 4px solid #94A3B8; border-radius: 10px;
    background: #fff; color: var(--ink); box-shadow: 0 14px 34px rgba(15, 23, 42, .16);
    font-size: 12px; line-height: 1.5; pointer-events: auto; animation: toast-in .18s ease-out;
  }
  .toast.success { border-left-color: var(--green); }
  .toast.error { border-color: #FECACA; border-left-color: var(--red); background: #FFF7F7; }
  .toast.info { border-left-color: #64748B; }
  .toast-text { flex: 1; min-width: 0; word-break: break-word; }
  .toast-close { flex: 0 0 auto; padding: 0 2px; border: 0; background: transparent; color: var(--muted); font-size: 16px; line-height: 1; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  /* ---------- responsive ---------- */
  @media (max-width: 1080px) {
    .dashboard-grid { grid-template-columns: minmax(0, 1fr); }
    .trip-row { grid-template-columns: minmax(110px, 1fr) minmax(100px, .8fr) minmax(120px, 1fr) auto; }
    .trip-row .trip-metric:nth-of-type(3), .trip-row .trip-metric:nth-of-type(4) { display: none; }
  }
  @media (max-width: 840px) {
    .app { display: block; }
    .sidebar {
      position: static; width: auto; height: auto; flex-direction: row; flex-wrap: wrap;
      align-items: center; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--line);
    }
    .side-brand { padding: 0 12px 0 4px; }
    .side-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; flex: 1; overflow: visible; padding: 0; }
    .nav-group { display: contents; }
    .nav-group-label { display: none; }
    .nav-item { width: auto; padding: 6px 9px; }
    .nav-item.active::before { display: none; }
    .nav-icon { display: none; }
    .side-foot { display: none; }
    .topbar { padding: 10px 16px; }
    #view { padding: 18px 16px 44px; }
    .card { padding: 15px 14px; }
    .chat-bubble { max-width: 86%; }
  }
  @media (max-width: 620px) {
    .page-head h1 { font-size: 21px; }
    .trip-row { grid-template-columns: 1fr auto; }
    .trip-row .trip-status, .trip-row .trip-metric { display: none; }
    .seg-tab { padding: 8px 6px; font-size: 12px; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .account-select { max-width: 190px; }
    .context-label { display: none; }
  }
`;
