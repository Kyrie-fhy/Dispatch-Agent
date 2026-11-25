export const adminStyles = `
  :root {
    color-scheme: light dark;
    --bg: #F5F6F8;
    --paper: #FFFFFF;
    --paper-2: #F8FAFC;
    --paper-elevated: #FFFFFF;
    --sidebar-bg: #FBFCFD;
    --topbar-bg: rgba(255, 255, 255, .86);
    --line: #E2E8F0;
    --line-soft: #EDF1F5;
    --ink: #0F172A;
    --ink-2: #334155;
    --muted: #64748B;
    --muted-2: #94A3B8;
    --green: #0F6E52;
    --green-dark: #0A5640;
    --green-soft: #ECFDF5;
    --green-border: #A7D7C8;
    --green-tint: #F6FDF9;
    --amber: #B45309;
    --amber-soft: #FEF3C7;
    --amber-border: #FCD34D;
    --amber-bg: #FFFDF5;
    --amber-ink: #92400E;
    --red: #B91C1C;
    --red-soft: #FEE2E2;
    --red-border: #FCA5A5;
    --red-bg: #FFF7F7;
    --slate-soft: #F1F5F9;
    --slate-hover: #E2E8F0;
    --backdrop: rgba(15, 23, 42, .48);
    --lightbox-bg: rgba(2, 6, 23, .88);
    --focus-ring: rgba(15, 110, 82, .16);
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 8px 24px rgba(15, 23, 42, .045);
    --shadow-hover: 0 4px 12px rgba(15, 23, 42, .07), 0 12px 30px rgba(15, 23, 42, .06);
    --shadow-lg: 0 24px 60px rgba(15, 23, 42, .18);
    --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
    --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    --dur-press: 110ms;
    --dur-fast: 160ms;
    --dur-base: 240ms;
    --dur-slow: 320ms;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0B0F14;
      --paper: #131A22;
      --paper-2: #18212C;
      --paper-elevated: #1A2430;
      --sidebar-bg: #0F151C;
      --topbar-bg: rgba(15, 21, 28, .84);
      --line: rgba(148, 163, 184, .16);
      --line-soft: rgba(148, 163, 184, .1);
      --ink: #F1F5F9;
      --ink-2: #CBD5E1;
      --muted: #94A3B8;
      --muted-2: #64748B;
      --green: #1FA87B;
      --green-dark: #4CE0AE;
      --green-soft: rgba(31, 168, 123, .16);
      --green-border: rgba(52, 211, 153, .36);
      --green-tint: rgba(31, 168, 123, .1);
      --amber: #F59E0B;
      --amber-soft: rgba(245, 158, 11, .16);
      --amber-border: rgba(251, 191, 36, .35);
      --amber-bg: rgba(245, 158, 11, .09);
      --amber-ink: #FCD34D;
      --red: #F87171;
      --red-soft: rgba(239, 68, 68, .18);
      --red-border: rgba(248, 113, 113, .38);
      --red-bg: rgba(239, 68, 68, .1);
      --slate-soft: rgba(148, 163, 184, .12);
      --slate-hover: rgba(148, 163, 184, .2);
      --backdrop: rgba(2, 6, 23, .68);
      --lightbox-bg: rgba(2, 6, 23, .94);
      --focus-ring: rgba(31, 168, 123, .28);
      --shadow: 0 1px 2px rgba(0, 0, 0, .28), 0 10px 28px rgba(0, 0, 0, .24);
      --shadow-hover: 0 4px 14px rgba(0, 0, 0, .38), 0 16px 36px rgba(0, 0, 0, .32);
      --shadow-lg: 0 28px 72px rgba(0, 0, 0, .56);
    }
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0B0F14;
    --paper: #131A22;
    --paper-2: #18212C;
    --paper-elevated: #1A2430;
    --sidebar-bg: #0F151C;
    --topbar-bg: rgba(15, 21, 28, .84);
    --line: rgba(148, 163, 184, .16);
    --line-soft: rgba(148, 163, 184, .1);
    --ink: #F1F5F9;
    --ink-2: #CBD5E1;
    --muted: #94A3B8;
    --muted-2: #64748B;
    --green: #1FA87B;
    --green-dark: #4CE0AE;
    --green-soft: rgba(31, 168, 123, .16);
    --green-border: rgba(52, 211, 153, .36);
    --green-tint: rgba(31, 168, 123, .1);
    --amber: #F59E0B;
    --amber-soft: rgba(245, 158, 11, .16);
    --amber-border: rgba(251, 191, 36, .35);
    --amber-bg: rgba(245, 158, 11, .09);
    --amber-ink: #FCD34D;
    --red: #F87171;
    --red-soft: rgba(239, 68, 68, .18);
    --red-border: rgba(248, 113, 113, .38);
    --red-bg: rgba(239, 68, 68, .1);
    --slate-soft: rgba(148, 163, 184, .12);
    --slate-hover: rgba(148, 163, 184, .2);
    --backdrop: rgba(2, 6, 23, .68);
    --lightbox-bg: rgba(2, 6, 23, .94);
    --focus-ring: rgba(31, 168, 123, .28);
    --shadow: 0 1px 2px rgba(0, 0, 0, .28), 0 10px 28px rgba(0, 0, 0, .24);
    --shadow-hover: 0 4px 14px rgba(0, 0, 0, .38), 0 16px 36px rgba(0, 0, 0, .32);
    --shadow-lg: 0 28px 72px rgba(0, 0, 0, .56);
  }

  :root[data-theme="light"] {
    color-scheme: light;
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
    -webkit-font-smoothing: antialiased;
    transition: background-color var(--dur-base) var(--ease-in-out), color var(--dur-base) var(--ease-in-out);
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

  /* ---------- keyframes (GPU-composited only) ---------- */
  @keyframes admin-view-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes admin-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes admin-fade-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes admin-pop {
    from { opacity: .65; transform: scale(.9); }
    to { opacity: 1; transform: scale(1); }
  }
  @keyframes admin-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    55% { transform: translateX(4px); }
    80% { transform: translateX(-2px); }
  }
  @keyframes admin-shimmer {
    0%, 100% { opacity: .45; }
    50% { opacity: .9; }
  }
  @keyframes admin-row-flash {
    0% { background-color: var(--green-soft); }
    100% { background-color: transparent; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .is-shake { animation: admin-shake 280ms var(--ease-in-out); }
  .is-updated td { animation: admin-row-flash 700ms var(--ease-out); }
  .is-removing {
    opacity: 0; transform: translateY(-6px) scale(.985);
    transition: opacity var(--dur-fast) var(--ease-in-out), transform var(--dur-fast) var(--ease-in-out);
    pointer-events: none;
  }

  /* ---------- login ---------- */
  .login-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 28px 18px; background:
      radial-gradient(900px 420px at 50% -10%, rgba(15, 110, 82, .14), transparent 65%),
      var(--bg);
    animation: admin-fade-in var(--dur-base) var(--ease-out);
  }
  .login-card {
    width: min(440px, 100%); padding: 30px 30px 26px; background: var(--paper);
    border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow-lg);
    animation: admin-view-in var(--dur-slow) var(--ease-out);
  }
  .login-badge {
    display: inline-block; margin-bottom: 14px; padding: 4px 10px; border-radius: 999px;
    background: var(--green-soft); color: var(--green-dark); font-size: 12px; font-weight: 800; letter-spacing: .06em;
  }
  .login-card h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.3; letter-spacing: -.01em; }
  .login-card p { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  .login-card input {
    width: 100%; margin-top: 6px; padding: 12px 13px; border: 1px solid var(--line);
    border-radius: 10px; background: var(--paper-2); color: var(--ink); outline: none;
    transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  .login-card input:focus { border-color: var(--green); background: var(--paper); box-shadow: 0 0 0 3px var(--focus-ring); }
  .login-card .btn { width: 100%; margin-top: 14px; }
  .login-error { min-height: 20px; margin-top: 10px; color: var(--red); font-size: 12px; }
  .login-foot { margin: 14px 0 0 !important; color: var(--muted); font-size: 11px !important; line-height: 1.6; }
  .field-label { display: block; color: var(--ink); font-size: 12px; font-weight: 700; }

  /* ---------- app shell ---------- */
  .app { display: flex; min-height: 100vh; }
  .sidebar {
    position: sticky; top: 0; z-index: 20; flex: 0 0 228px; width: 228px; height: 100vh;
    display: flex; flex-direction: column; padding: 18px 12px 14px;
    background: var(--sidebar-bg); border-right: 1px solid var(--line);
    transition: background-color var(--dur-base) var(--ease-in-out), border-color var(--dur-base) var(--ease-in-out);
  }
  .side-brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 18px; }
  .brand-mark {
    flex: 0 0 auto; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 10px; background: var(--green); color: #fff; font-size: 17px; font-weight: 800;
    box-shadow: 0 4px 12px rgba(15, 110, 82, .22);
  }
  .side-brand b { display: block; font-size: 15px; letter-spacing: .01em; }
  .side-brand span { display: block; color: var(--muted); font-size: 11px; }
  .side-nav { flex: 1; min-height: 0; overflow: auto; padding: 2px 2px 10px; }
  .nav-group { margin-top: 16px; }
  .nav-group-label {
    display: block; padding: 0 12px 6px; color: var(--muted-2); font-size: 10px; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
  }
  .nav-item {
    position: relative; width: 100%; display: flex; align-items: center; gap: 9px;
    padding: 9px 10px; margin: 2px 0; border: 0; border-radius: 9px; background: transparent;
    color: var(--ink-2); font-size: 13px; font-weight: 600; text-align: left;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
  }
  .nav-item:hover { background: var(--slate-soft); color: var(--ink); }
  .nav-item:active { transform: scale(.98); }
  .nav-item.active { background: var(--green-soft); color: var(--green-dark); }
  .nav-item::before {
    content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px;
    border-radius: 0 3px 3px 0; background: var(--green);
    transform: scaleY(0); opacity: 0;
    transition: transform var(--dur-base) var(--ease-spring), opacity var(--dur-fast) var(--ease-out);
  }
  .nav-item.active::before { transform: scaleY(1); opacity: 1; }
  .nav-icon {
    flex: 0 0 auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; background: var(--slate-soft); color: var(--muted);
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .nav-icon svg { width: 14px; height: 14px; display: block; }
  .nav-item:hover .nav-icon { color: var(--ink); }
  .nav-item.active .nav-icon { background: var(--green); color: #fff; }
  .nav-text { flex: 1; min-width: 0; white-space: nowrap; }
  .nav-badge {
    flex: 0 0 auto; min-width: 19px; height: 19px; padding: 0 6px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums;
    animation: admin-pop var(--dur-fast) var(--ease-spring);
  }
  .nav-badge.danger { background: var(--red-soft); color: var(--red); }
  .nav-badge.warn { background: var(--amber-soft); color: var(--amber); }
  .side-foot { padding: 12px 10px 0; border-top: 1px solid var(--line); color: var(--muted-2); font-size: 10px; }
  .main-shell { flex: 1; min-width: 0; }
  .topbar {
    position: sticky; top: 0; z-index: 18; min-height: 58px; display: flex; flex-wrap: wrap;
    align-items: center; justify-content: space-between; gap: 10px 18px;
    padding: 10px 26px; background: var(--topbar-bg);
    border-bottom: 1px solid var(--line); backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    transition: background-color var(--dur-base) var(--ease-in-out), border-color var(--dur-base) var(--ease-in-out);
  }
  .context {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  .context.is-global .context-label,
  .context.is-global .account-select { opacity: .48; }
  .context.is-global .account-select:hover,
  .context.is-global .account-select:focus { opacity: 1; }
  .context-label { color: var(--muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
  .account-select {
    max-width: 320px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--paper); color: var(--ink); font-size: 13px; font-weight: 600;
    transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
  }
  .account-select:focus { outline: none; border-color: var(--green); box-shadow: 0 0 0 3px var(--focus-ring); }
  .context-hint {
    padding: 4px 10px; border-radius: 999px; background: var(--green-soft); color: var(--green-dark);
    font-size: 11px; font-weight: 700; animation: admin-fade-in var(--dur-fast) var(--ease-out);
  }
  .context-hint:empty { display: none; }
  .topbar-actions { display: flex; align-items: center; gap: 6px; }
  .icon-inline { width: 15px; height: 15px; flex: 0 0 auto; display: inline-block; }
  .is-spinning .icon-inline { animation: spin .65s linear infinite; }
  #view { width: 100%; max-width: 1480px; margin: 0 auto; padding: 24px 26px 56px; outline: none; }
  .view-stage { animation: admin-view-in var(--dur-base) var(--ease-out); }

  /* ---------- buttons ---------- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 14px; border: 1px solid transparent; border-radius: 9px;
    background: var(--paper); color: var(--ink); font-size: 13px; font-weight: 700; white-space: nowrap;
    transition: transform var(--dur-press) var(--ease-out), background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
  }
  .btn:hover:not(:disabled) { background: var(--paper-2); }
  .btn:active:not(:disabled) { transform: scale(.97); }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus-ring); }
  .btn:disabled { opacity: .55; cursor: not-allowed; }
  .btn-primary { background: var(--green); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--green-dark); color: #fff; }
  :root[data-theme="dark"] .btn-primary:hover:not(:disabled) { background: #178F67; color: #fff; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .btn-primary:hover:not(:disabled) { background: #178F67; color: #fff; }
  }
  .btn-secondary { border-color: var(--line); background: var(--paper); color: var(--green-dark); }
  .btn-secondary:hover:not(:disabled) { background: var(--green-soft); border-color: var(--green-border); }
  .btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
  .btn-ghost:hover:not(:disabled) { background: var(--slate-soft); color: var(--ink); }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-danger:hover:not(:disabled) { filter: brightness(.92); background: var(--red); }
  .btn-danger-outline { border-color: var(--red-border); background: var(--paper); color: var(--red); }
  .btn-danger-outline:hover:not(:disabled) { background: var(--red-soft); }
  .btn-primary-outline { border-color: var(--green-border); background: var(--paper); color: var(--green-dark); }
  .btn-primary-outline:hover:not(:disabled) { background: var(--green-soft); }
  .btn.is-copied {
    border-color: var(--green-border); background: var(--green-soft); color: var(--green-dark);
    animation: admin-pop var(--dur-fast) var(--ease-spring);
  }
  .btn-small { padding: 5px 10px; border-radius: 7px; font-size: 11px; }
  .btn-block { width: 100%; }
  .row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .back-link {
    display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px 4px 2px; margin: 0 0 10px -2px;
    border: 0; border-radius: 8px; background: transparent; color: var(--green-dark); font-size: 13px; font-weight: 700;
    transition: transform var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  .back-link:hover { background: var(--green-soft); transform: translateX(-2px); }
  .back-link:active { transform: translateX(-4px) scale(.98); }

  /* ---------- page head / cards ---------- */
  .page-head {
    display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
    gap: 10px 16px; margin: 2px 0 18px;
  }
  .page-head h1 { margin: 0 0 3px; font-size: 24px; line-height: 1.3; letter-spacing: -.015em; }
  .page-head p { margin: 0; color: var(--muted); font-size: 13px; }
  .page-head .page-tag { margin-top: 4px; }
  .card {
    min-width: 0; margin-bottom: 16px; padding: 18px 20px; background: var(--paper);
    border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
    transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-base) var(--ease-in-out);
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
  .badge.info { background: var(--slate-soft); color: var(--ink-2); }
  .badge.neutral { background: var(--slate-soft); color: var(--muted); }
  .stage-pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 800; white-space: nowrap;
  }
  .stage-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .stage-pill.info { background: var(--slate-soft); color: var(--ink-2); }
  .stage-pill.warn { background: var(--amber-soft); color: var(--amber); }
  .stage-pill.ok { background: var(--green-soft); color: var(--green-dark); }

  /* ---------- metrics ---------- */
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .metric {
    min-width: 0; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2);
  }
  .metric-label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 600; }
  .metric-value { font-size: 19px; font-weight: 800; line-height: 1.35; word-break: break-word; }
  .metric-note { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; line-height: 1.45; }
  .metric .badge { font-size: 13px; padding: 3px 10px; }
  .pulse-progress { margin-top: 16px; padding-top: 0; }
  .pulse-progress-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; color: var(--muted); font-size: 11px; }
  .pulse-progress-head b { color: var(--ink); font-size: 12px; }
  .pulse-track { height: 7px; overflow: hidden; border-radius: 999px; background: var(--slate-soft); }
  .pulse-track span { display: block; height: 100%; border-radius: inherit; background: var(--green); transition: width 420ms var(--ease-out); }
  .pulse-progress .metric-note { margin-top: 7px; }

  /* ---------- todo cards ---------- */
  .todo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
  .todo-card {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 15px;
    border: 1px solid var(--line); border-radius: 12px; background: var(--paper); color: var(--ink); text-align: left;
    transition: transform var(--dur-press) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
  }
  .todo-card:hover { border-color: var(--green-border); background: var(--green-tint); box-shadow: var(--shadow-hover); }
  .todo-card:active { transform: scale(.985); }
  .todo-card.needs { border-color: var(--amber-border); background: var(--amber-bg); }
  .todo-card.needs:hover { border-color: var(--amber); background: var(--amber-bg); }
  .todo-card.done { opacity: .72; }
  .todo-num {
    flex: 0 0 auto; width: 46px; height: 46px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 12px; background: var(--slate-soft); color: var(--muted); font-size: 20px; font-weight: 800;
  }
  .todo-card.needs .todo-num { background: var(--amber-soft); color: var(--amber); }
  .todo-copy { flex: 1; min-width: 0; }
  .todo-copy b { display: block; font-size: 13px; color: var(--ink); }
  .todo-copy span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; line-height: 1.5; }
  .todo-action {
    flex: 0 0 auto; color: var(--green-dark); font-size: 12px; font-weight: 700; white-space: nowrap;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .todo-card:hover .todo-action { transform: translateX(3px); }

  /* ---------- status lights ---------- */
  .light-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
  .light {
    display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px;
    border: 1px solid var(--line); border-radius: 9px; background: var(--paper-2); min-width: 0;
  }
  .light-dot { flex: 0 0 auto; width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; background: var(--muted-2); }
  .light.on .light-dot { background: #16A34A; box-shadow: 0 0 0 3px rgba(22, 163, 74, .18); }
  .light.off .light-dot { background: var(--muted-2); }
  .light.bad .light-dot { background: var(--red); box-shadow: 0 0 0 3px rgba(185, 28, 28, .18); }
  .light b { display: block; font-size: 12px; }
  .light span { display: block; color: var(--muted); font-size: 10px; line-height: 1.45; word-break: break-word; }
  .help-dot {
    display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px;
    margin-left: 4px; border-radius: 50%; background: var(--slate-soft); color: var(--muted);
    font-size: 10px; font-weight: 800; cursor: help; vertical-align: 1px;
  }

  /* ---------- tables ---------- */
  .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 9px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; }
  th { color: var(--muted); background: var(--paper-2); font-weight: 700; white-space: nowrap; }
  tbody tr { transition: background-color var(--dur-fast) var(--ease-out); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: var(--paper-2); }
  tr.row-current { background: var(--green-tint); }
  .cell-main { font-weight: 700; }
  .table-empty { padding: 26px 10px; color: var(--muted); text-align: center; }

  /* ---------- trips ---------- */
  .trip-row {
    display: grid; grid-template-columns: minmax(120px, 1.1fr) minmax(110px, .9fr) minmax(80px, .6fr)
      minmax(120px, 1fr) minmax(90px, .7fr) auto; gap: 10px; align-items: center;
    width: 100%; padding: 12px 13px; margin: 5px 0; border: 1px solid var(--line);
    border-radius: 11px; background: var(--paper); color: var(--ink); text-align: left;
    transition: transform var(--dur-press) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
  }
  .trip-row:hover { border-color: var(--green-border); background: var(--green-tint); box-shadow: var(--shadow); }
  .trip-row:active { transform: scale(.992); }
  .trip-row.current { border-color: var(--green-border); background: var(--green-soft); }
  .trip-date b { display: block; font-size: 13px; }
  .trip-date span { display: block; color: var(--muted); font-size: 11px; }
  .trip-metric { color: var(--muted); font-size: 11px; }
  .trip-metric b { color: var(--ink); font-size: 13px; }
  .trip-go {
    justify-self: end; color: var(--green-dark); font-size: 12px; font-weight: 700; white-space: nowrap;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .trip-row:hover .trip-go { transform: translateX(3px); }
  .trip-hero .metric-grid { margin-top: 4px; }
  .seg-tabs {
    display: flex; gap: 6px; padding: 5px; margin-bottom: 14px; border: 1px solid var(--line);
    border-radius: 12px; background: var(--paper-2);
  }
  .seg-tab {
    flex: 1; min-width: 0; padding: 10px 12px; border: 0; border-radius: 9px; background: transparent;
    color: var(--muted); font-size: 13px; font-weight: 700; text-align: center;
    transition: background-color var(--dur-fast) var(--ease-in-out), color var(--dur-fast) var(--ease-in-out),
      box-shadow var(--dur-fast) var(--ease-in-out), transform var(--dur-press) var(--ease-out);
  }
  .seg-tab span { display: inline-block; margin-left: 5px; color: inherit; font-size: 11px; opacity: .8; }
  .seg-tab:hover { background: var(--slate-soft); color: var(--ink); }
  .seg-tab:active { transform: scale(.98); }
  .seg-tab.active { background: var(--paper-elevated); color: var(--green-dark); box-shadow: 0 1px 3px rgba(15, 23, 42, .12); }
  .customer-card {
    margin-bottom: 14px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper);
    transition: border-color var(--dur-fast) var(--ease-out);
  }
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
    padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper);
  }
  .picking-name { min-width: 0; }
  .picking-name b { display: block; font-size: 15px; line-height: 1.35; word-break: break-word; }
  .picking-name span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; word-break: break-word; }
  .picking-qty {
    flex: 0 0 auto; min-width: 78px; padding: 8px 12px; border-radius: 12px;
    text-align: center; background: var(--slate-soft); color: var(--ink-2);
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
  .chat-day { margin: 14px 0 10px; color: var(--muted-2); font-size: 10px; text-align: center; }
  .chat-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; }
  .chat-row.user { flex-direction: row-reverse; }
  .chat-avatar {
    flex: 0 0 auto; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9px; background: var(--slate-soft); color: var(--ink-2); font-size: 11px; font-weight: 800;
  }
  .chat-row.user .chat-avatar { background: var(--green); color: #fff; }
  .chat-row.assistant .chat-avatar { background: var(--slate-soft); color: var(--ink-2); }
  .chat-bubble {
    position: relative; min-width: 0; max-width: min(680px, 78%); padding: 10px 12px 8px;
    border: 1px solid var(--line); border-radius: 4px 12px 12px 12px; background: var(--paper);
  }
  .chat-row.user .chat-bubble { border-color: var(--green-border); border-radius: 12px 4px 12px 12px; background: var(--green-soft); }
  .chat-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.7; }
  .chat-thumbs { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
  .chat-thumb {
    width: 116px; height: 88px; display: flex; align-items: center; justify-content: center;
    overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2);
    color: var(--muted); font-size: 10px; text-align: center;
  }
  .chat-thumb img {
    width: 100%; height: 100%; object-fit: cover; cursor: zoom-in;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .chat-thumb img:hover { transform: scale(1.04); }
  .chat-jump {
    display: block; margin: 7px 0 0 auto; padding: 2px 4px; border: 0; border-radius: 6px; background: transparent;
    color: var(--green-dark); font-size: 11px; font-weight: 700;
    transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
  }
  .chat-jump:hover { background: var(--green-soft); transform: translateX(2px); }

  /* ---------- empty / loading / skeleton ---------- */
  .loading-card, .empty-card, .error-card, .placeholder-card {
    padding: 36px 24px; border: 1px solid var(--line); border-radius: 14px;
    background: var(--paper); text-align: center; box-shadow: var(--shadow);
    animation: admin-view-in var(--dur-base) var(--ease-out);
  }
  .loading-card { color: var(--muted); font-size: 13px; text-align: left; padding: 22px 24px; }
  .loading-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .skeleton-bars { display: flex; flex-direction: column; gap: 10px; }
  .skeleton-bar {
    height: 14px; border-radius: 7px; background: var(--slate-soft);
    animation: admin-shimmer 1.3s var(--ease-in-out) infinite;
  }
  .skeleton-bar.w40 { width: 40%; height: 18px; }
  .skeleton-bar.w75 { width: 75%; }
  .skeleton-bar.w60 { width: 60%; }
  .spinner {
    display: inline-block; width: 14px; height: 14px; flex: 0 0 auto;
    border: 2px solid var(--line); border-top-color: var(--green); border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  .empty-card h2, .error-card h2, .placeholder-card h2 { margin: 8px 0; font-size: 18px; }
  .empty-card p, .error-card p, .placeholder-card p { max-width: 520px; margin: 0 auto 16px; color: var(--muted); font-size: 13px; }
  .notice {
    padding: 10px 12px; margin-bottom: 12px; border: 1px dashed var(--line); border-radius: 9px;
    color: var(--muted); font-size: 12px;
  }
  .notice.warn { border-color: var(--amber-border); background: var(--amber-bg); color: var(--amber-ink); }

  /* ---------- forms / filters ---------- */
  .filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  .filter-bar label { color: var(--muted); font-size: 12px; }
  .search-wrap { position: relative; display: flex; align-items: center; flex: 1 1 240px; min-width: 180px; }
  .search-wrap .text-input { width: 100%; padding-right: 32px; }
  .search-clear {
    position: absolute; right: 6px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--slate-soft); color: var(--muted); font-size: 14px; line-height: 1;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
  }
  .search-clear:hover { background: var(--slate-hover); color: var(--ink); }
  .search-clear:active { transform: scale(.9); }
  .select, .text-input {
    padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink);
    transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  .select:focus, .text-input:focus { outline: none; border-color: var(--green); box-shadow: 0 0 0 3px var(--focus-ring); }
  .inline-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
  .field { min-width: 0; }
  .field.grow { flex: 1 1 260px; }
  .field .text-input { width: 100%; margin-top: 5px; }
  .field-hint { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }

  /* ---------- account / code ---------- */
  .code-display {
    margin: 14px 0; padding: 16px; border: 1px dashed var(--green-border); border-radius: 12px;
    background: var(--green-soft); color: var(--green-dark);
    font: 800 26px/1.3 var(--mono); letter-spacing: .08em; text-align: center; word-break: break-all;
  }
  .code-actions { display: flex; justify-content: center; margin-top: 10px; }
  .modal-note { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
  .modal-warn { margin: 10px 0 0; padding: 9px 11px; border-radius: 8px; background: var(--amber-soft); color: var(--amber-ink); font-size: 12px; }
  .modal-error { min-height: 18px; margin-top: 8px; color: var(--red); font-size: 12px; }
  .soft-details { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
  .soft-details > summary {
    display: inline-flex; align-items: center; gap: 6px; list-style: none;
    color: var(--muted); font-size: 12px; font-weight: 700; cursor: pointer;
    transition: color var(--dur-fast) var(--ease-out);
  }
  .soft-details > summary::-webkit-details-marker { display: none; }
  .soft-details > summary::before {
    content: ""; display: inline-block; width: 6px; height: 6px;
    border-right: 1.8px solid currentColor; border-bottom: 1.8px solid currentColor;
    transform: rotate(-45deg); transition: transform var(--dur-fast) var(--ease-out);
  }
  .soft-details[open] > summary::before { transform: rotate(45deg); }
  .soft-details > summary:hover { color: var(--green-dark); }
  .soft-details[open] > *:not(summary) { animation: admin-view-in var(--dur-fast) var(--ease-out); }
  .rule-card { margin-top: 12px; padding: 13px; border: 1px solid var(--line); border-radius: 11px; background: var(--paper-2); }
  .prompt-block { margin-top: 9px; }
  .prompt-block label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 700; }
  .prompt-text {
    margin: 3px 0 0; padding: 10px; border-radius: 8px; background: var(--paper); color: var(--ink-2);
    border: 1px solid var(--line); font: 11px/1.6 var(--mono); white-space: pre-wrap;
    word-break: break-word; max-height: 320px; overflow: auto;
  }
  .loading-inline { padding: 16px; color: var(--muted); font-size: 12px; text-align: center; }

  /* ---------- modal (enter + exit, interruptible) ---------- */
  .modal-root { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal-backdrop {
    position: absolute; inset: 0; background: var(--backdrop); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    animation: admin-fade-in var(--dur-fast) var(--ease-out) forwards;
  }
  .modal-card {
    position: relative; z-index: 1; width: min(540px, 100%); max-height: min(84vh, 760px);
    display: flex; flex-direction: column; background: var(--paper-elevated); border: 1px solid var(--line);
    border-radius: 16px; box-shadow: var(--shadow-lg);
    animation: modal-in var(--dur-base) var(--ease-out) forwards;
  }
  .modal-root.is-closing { pointer-events: none; }
  .modal-root.is-closing .modal-backdrop { animation: admin-fade-out 150ms var(--ease-in-out) forwards; }
  .modal-root.is-closing .modal-card { animation: modal-out 150ms var(--ease-in-out) forwards; }
  @keyframes modal-in { from { opacity: 0; transform: translateY(10px) scale(.975); } to { opacity: 1; transform: none; } }
  @keyframes modal-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(6px) scale(.98); } }
  .modal-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 18px 20px 8px;
  }
  .modal-head h2 { margin: 0; font-size: 17px; line-height: 1.4; }
  .modal-x {
    width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; color: var(--muted); font-size: 20px; line-height: 1;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
  }
  .modal-x:hover { background: var(--slate-soft); color: var(--ink); }
  .modal-x:active { transform: scale(.9); }
  .modal-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 20px 6px; color: var(--ink-2); font-size: 13px; }
  .modal-body p { margin: 6px 0; }
  .modal-actions {
    display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px;
    border-top: 1px solid var(--line-soft);
  }

  /* ---------- lightbox (enter + exit) ---------- */
  .lightbox {
    position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: var(--lightbox-bg); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    animation: admin-fade-in var(--dur-fast) var(--ease-out) forwards;
  }
  .lightbox.is-closing { pointer-events: none; animation: admin-fade-out 150ms var(--ease-in-out) forwards; }
  .lightbox-inner { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .lightbox img {
    max-width: 92vw; max-height: 86vh; border-radius: 10px; box-shadow: 0 24px 70px rgba(0, 0, 0, .45);
    animation: lightbox-zoom var(--dur-base) var(--ease-out) forwards;
  }
  .lightbox.is-closing img { animation: lightbox-zoom-out 150ms var(--ease-in-out) forwards; }
  @keyframes lightbox-zoom { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
  @keyframes lightbox-zoom-out { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(.96); } }
  .lightbox-caption { color: #E2E8F0; font-size: 12px; }
  .lightbox-close {
    position: fixed; top: 18px; right: 22px; width: 38px; height: 38px; border: 0; border-radius: 50%;
    background: rgba(255, 255, 255, .16); color: #fff; font-size: 24px; line-height: 1;
    transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
  }
  .lightbox-close:hover { background: rgba(255, 255, 255, .28); }
  .lightbox-close:active { transform: scale(.92); }

  /* ---------- toast (enter + exit) ---------- */
  .toast-stack {
    position: fixed; right: 20px; bottom: 20px; z-index: 60; display: flex; flex-direction: column;
    gap: 8px; width: min(380px, calc(100vw - 40px)); pointer-events: none;
  }
  .toast {
    display: flex; align-items: flex-start; gap: 8px; padding: 11px 12px;
    border: 1px solid var(--line); border-left: 4px solid var(--muted-2); border-radius: 10px;
    background: var(--paper-elevated); color: var(--ink); box-shadow: var(--shadow-lg);
    font-size: 12px; line-height: 1.5; pointer-events: auto; animation: toast-in 220ms var(--ease-out) forwards;
  }
  .toast.is-leaving { pointer-events: none; animation: toast-out 160ms var(--ease-in-out) forwards; }
  .toast.success { border-left-color: var(--green); }
  .toast.error { border-color: var(--red-border); border-left-color: var(--red); background: var(--red-bg); }
  .toast.info { border-left-color: var(--muted); }
  .toast-text { flex: 1; min-width: 0; word-break: break-word; }
  .toast-close {
    flex: 0 0 auto; padding: 0 4px; border: 0; border-radius: 6px; background: transparent;
    color: var(--muted); font-size: 16px; line-height: 1;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .toast-close:hover { background: var(--slate-soft); color: var(--ink); }
  @keyframes toast-in { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: none; } }
  @keyframes toast-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(6px) scale(.98); } }

  /* ---------- catalog / customers / quality ---------- */
  .filter-bar .grow, .query-row .grow { flex: 1 1 240px; }
  .query-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; margin-bottom: 10px; }
  .filter-pills { display: flex; flex-wrap: wrap; gap: 5px; }
  .pill-filter {
    padding: 6px 11px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper);
    color: var(--ink-2); font-size: 12px; font-weight: 700;
    transition: transform var(--dur-press) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .pill-filter:hover { border-color: var(--green-border); background: var(--green-tint); }
  .pill-filter:active { transform: scale(.96); }
  .pill-filter.active { border-color: var(--green); background: var(--green-soft); color: var(--green-dark); }
  .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .field-grid.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .field-grid textarea { width: 100%; resize: vertical; }
  .field-grid .text-input, .modal-body .text-input { width: 100%; margin-top: 4px; }
  .modal-body textarea.text-input { margin-top: 4px; font-family: inherit; line-height: 1.6; }
  .checkbox-row {
    display: flex; align-items: flex-start; gap: 7px; margin-top: 10px;
    color: var(--ink-2); font-size: 12px; line-height: 1.55;
  }
  .checkbox-row input { margin-top: 3px; }
  .radio-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 12px; }
  .radio-pill {
    display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px;
    border: 1px solid var(--line); border-radius: 999px; background: var(--paper);
    color: var(--ink-2); font-size: 12px; font-weight: 600; cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .radio-pill:has(input:checked) { border-color: var(--green); background: var(--green-soft); color: var(--green-dark); }
  .unit-chip {
    display: inline-block; padding: 1px 7px; border-radius: 6px; background: var(--slate-soft);
    color: var(--ink-2); font-size: 12px; font-weight: 700;
  }
  .catalog-table-wrap { max-height: 68vh; overflow: auto; }
  .catalog-table th { position: sticky; top: 0; z-index: 1; }
  .catalog-row.missing-unit td { background: var(--amber-bg); }
  .catalog-row.missing-unit:hover td { background: var(--amber-soft); }
  .catalog-overview .metric-grid { margin-top: 4px; }
  .catalog-alert-bar {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;
    margin-top: 12px; padding: 10px 12px; border: 1px solid var(--amber-border); border-radius: 10px;
    background: var(--amber-bg); color: var(--amber-ink); font-size: 12px;
  }
  .sandbox-card { background: var(--paper); }
  .result-panel {
    margin-top: 12px; padding: 14px; border: 1px solid var(--green-border); border-radius: 12px; background: var(--green-tint);
    animation: admin-view-in var(--dur-base) var(--ease-out);
  }
  .result-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  .result-price { font-size: 22px; font-weight: 800; color: var(--green-dark); }
  .result-reason { margin: 9px 0; color: var(--ink-2); font-size: 13px; line-height: 1.65; }
  .result-hit { padding: 9px 11px; border-radius: 9px; background: var(--paper); border: 1px solid var(--line); font-size: 13px; }
  .compact-table { font-size: 12px; }
  .compact-table td, .compact-table th { padding: 7px 8px; }
  .csv-summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  .error-list {
    margin-top: 8px; padding: 10px 12px; border: 1px solid var(--red-border); border-radius: 9px;
    background: var(--red-bg); color: var(--red); font-size: 12px;
  }
  .error-list ul { margin: 5px 0 0; padding-left: 18px; }
  .error-card.inline { padding: 16px; text-align: left; box-shadow: none; }
  .alias-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
  .alias-chip {
    display: inline-flex; align-items: center; gap: 3px; padding: 3px 4px 3px 9px;
    border-radius: 999px; background: var(--green-soft); color: var(--green-dark); font-size: 12px; font-weight: 700;
  }
  .alias-remove {
    width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 50%; background: rgba(15, 110, 82, .14);
    color: var(--green-dark); font-size: 13px; line-height: 1;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
  }
  .alias-remove:hover { background: var(--red-soft); color: var(--red); }
  .alias-remove:active { transform: scale(.88); }
  .price-chevron {
    display: inline-block; transition: transform var(--dur-fast) var(--ease-out);
  }
  .is-open .price-chevron { transform: rotate(180deg); }
  .customer-prices {
    margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line);
    animation: admin-view-in var(--dur-fast) var(--ease-out);
  }
  .quality-card {
    margin-bottom: 16px; padding: 18px 20px; background: var(--paper);
    border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
    transition: border-color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out);
  }
  .quality-card.highlight { border-color: var(--amber-border); box-shadow: 0 0 0 3px rgba(245, 158, 11, .18), var(--shadow); }
  .quality-head {
    display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
    gap: 8px 14px; margin-bottom: 12px;
  }
  .quality-meta { min-width: 0; }
  .quality-badges { display: flex; flex-wrap: wrap; gap: 5px; }
  .quality-chat { padding: 4px 0 10px; border-bottom: 1px dashed var(--line); }
  .timeline-bar { margin-top: 12px; }
  .timeline-step {
    position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 0 0 13px 0;
  }
  .timeline-step:not(:last-child)::before {
    content: ""; position: absolute; left: 13px; top: 27px; bottom: 0; width: 2px; background: var(--line);
  }
  .timeline-dot {
    position: relative; z-index: 1; flex: 0 0 auto; width: 27px; height: 27px;
    display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
    background: var(--green-soft); color: var(--green-dark); font-size: 12px; font-weight: 800;
  }
  .timeline-body { flex: 1; min-width: 0; padding-top: 3px; }
  .timeline-body b { display: block; margin-bottom: 3px; font-size: 13px; }
  .timeline-body p { margin: 0 0 4px; color: var(--ink-2); font-size: 12px; line-height: 1.65; }
  .timeline-list { margin: 3px 0 0; padding-left: 18px; color: var(--ink-2); font-size: 12px; line-height: 1.7; }
  .voice-compare {
    display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 8px;
    align-items: stretch; padding: 9px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2);
  }
  .voice-side { min-width: 0; padding: 7px 9px; border-radius: 8px; background: var(--paper); border: 1px solid var(--line); }
  .voice-side p { margin: 2px 0 0; font-size: 12px; line-height: 1.6; word-break: break-word; }
  .voice-arrow { display: flex; align-items: center; color: var(--green); font-weight: 800; }
  .voice-words { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 5px; }
  .tech-list { margin: 9px 0; }
  .tech-row { padding: 7px 9px; margin-bottom: 5px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2); }
  .mistake-card {
    margin-bottom: 14px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 14px;
    background: var(--paper); box-shadow: var(--shadow);
  }
  .quote-box, .expected-box, .note-box {
    margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: var(--paper-2); border: 1px solid var(--line);
  }
  .expected-box { border-color: var(--green-border); background: var(--green-tint); }
  .quote-box p, .expected-box p, .note-box p { margin: 3px 0 0; font-size: 13px; line-height: 1.7; word-break: break-word; }
  .expected-box p { font-weight: 700; color: var(--green-dark); }

  /* ---------- responsive (wide / narrow / mobile) ---------- */
  @media (max-width: 1080px) {
    .dashboard-grid { grid-template-columns: minmax(0, 1fr); }
    .trip-row { grid-template-columns: minmax(110px, 1fr) minmax(100px, .8fr) minmax(120px, 1fr) auto; }
    .trip-row .trip-metric:nth-of-type(3), .trip-row .trip-metric:nth-of-type(4) { display: none; }
    .field-grid.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 840px) {
    .app { display: block; }
    .sidebar {
      position: static; width: auto; height: auto; flex-direction: column; gap: 8px;
      padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--line);
    }
    .side-brand { padding: 0 2px; }
    .side-nav {
      display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; overflow-x: auto;
      padding: 2px 0; -webkit-overflow-scrolling: touch; scrollbar-width: none;
    }
    .side-nav::-webkit-scrollbar { display: none; }
    .nav-group { display: contents; }
    .nav-group-label { display: none; }
    .nav-item { flex: 0 0 auto; width: auto; padding: 7px 11px; border-radius: 999px; }
    .nav-item::before { display: none; }
    .nav-icon { width: 18px; height: 18px; border-radius: 5px; }
    .nav-icon svg { width: 12px; height: 12px; }
    .side-foot { display: none; }
    .topbar { padding: 10px 14px; gap: 8px; }
    #view { padding: 16px 14px 44px; }
    .card { padding: 15px 14px; }
    .chat-bubble { max-width: 88%; }
    .field-grid, .field-grid.four { grid-template-columns: minmax(0, 1fr); }
    .voice-compare { grid-template-columns: minmax(0, 1fr); }
    .voice-arrow { justify-content: center; }
    .catalog-table-wrap { max-height: none; }
  }
  @media (max-width: 620px) {
    .page-head h1 { font-size: 20px; }
    .trip-row { grid-template-columns: 1fr auto; }
    .trip-row .trip-status, .trip-row .trip-metric { display: none; }
    .seg-tab { padding: 8px 6px; font-size: 12px; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .account-select { max-width: 170px; }
    .context-label { display: none; }
    .topbar-actions .btn-label-sm { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
      scroll-behavior: auto !important;
    }
    .spinner, .is-spinning .icon-inline {
      animation-duration: 1.6s !important;
      animation-iteration-count: infinite !important;
    }
  }
`;
