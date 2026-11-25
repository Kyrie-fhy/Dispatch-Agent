import { adminDataScript } from './page-data';
import { adminOpsScript } from './page-ops';
import { adminShellHtml, adminShellScript } from './page-shell';
import { adminStyles } from './page-styles';

const adminScript = [
  adminShellScript,
  adminOpsScript,
  adminDataScript,
  "(function () { if (window.__dispatchAdmin) window.__dispatchAdmin.boot(); })();",
].join('\n');

export const adminPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch 运营与维护后台</title>
<style>${adminStyles}</style>
</head>
<body>
${adminShellHtml}
<script>
${adminScript}
</script>
</body>
</html>`;
