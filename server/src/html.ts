export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function layout(title: string, body: string, here = ""): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="icon" href="/favicon.png?v=3" type="image/png">
  <link rel="apple-touch-icon" href="/favicon.png?v=3">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #f3efe6;
      color: #1d1a16;
      font: 16px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee4d4; vertical-align: top; }
    th { color: #6f675c; font-weight: 600; }
    h1 { font-size: 28px; font-weight: 650; letter-spacing: -0.03em; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 28px 0 8px; }
    p, li { color: #3f3a33; }
    .card {
      background: #fffdf8;
      border: 1px solid #e5dece;
      border-radius: 16px;
      padding: 22px;
      margin-top: 18px;
    }
    label { display: block; font-size: 14px; margin-bottom: 6px; }
    input {
      width: 100%;
      border: 1px solid #d9d0c0;
      background: #fff;
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
    }
    button, .button {
      display: inline-block;
      border: 0;
      border-radius: 999px;
      padding: 10px 16px;
      background: #23483d;
      color: #f7f3ea;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    button.secondary, .button.secondary { background: transparent; color: #23483d; border: 1px solid #23483d; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .id, pre.command {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 14px;
      word-break: break-all;
      white-space: pre-wrap;
      background: #f6f1e6;
      border-radius: 10px;
      padding: 10px 12px;
    }
    .code {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 32px;
      letter-spacing: 0.18em;
      margin: 8px 0 0;
    }
    .muted { color: #6f675c; font-size: 14px; }
    .warn { color: #8a4b12; }
    form { display: grid; gap: 12px; }
    ol { padding-left: 18px; }
    .topnav { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 22px; }
    .topnav a {
      color: #23483d;
      text-decoration: none;
      border: 1px solid #d9d0c0;
      background: #fffdf8;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 14px;
    }
    .topnav a.is-here { background: #23483d; color: #f7f3ea; border-color: #23483d; }
    a.inline { color: #23483d; }
  </style>
</head>
<body>
  <main>
    ${topNav(here)}
    <h1>${esc(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function topNav(here: string): string {
  const item = (href: string, id: string, label: string) =>
    `<a href="${href}"${here === id ? ' class="is-here"' : ""}>${label}</a>`;
  return `<nav class="topnav">${item("/", "home", "首页")}${item("/install", "install", "安装插件")}${item("/login", "login", "登录")}${item("/account", "account", "同步情况")}<a href="https://obsidian.md/" target="_blank" rel="noopener">Obsidian 官网</a></nav>`;
}

export function loginPage(options: {
  oidc: boolean;
  devLogin: boolean;
  device: string;
  returnTo?: string;
  state?: string;
  vault?: string;
  error?: string;
}): string {
  const back = options.returnTo === "obsidian";
  const device = esc(options.device);
  const state = esc(options.state ?? "");
  const vault = esc(options.vault ?? "");
  const error = options.error ? `<p class="warn">${esc(options.error)}</p>` : "";
  const query = callbackQuery(options);
  const sso = options.oidc
    ? `<a class="button" href="/auth/oidc/start${query}">使用 SSO 登录</a>`
    : "";
  const hidden = back
    ? `<input type="hidden" name="return" value="obsidian"><input type="hidden" name="state" value="${state}"><input type="hidden" name="vault" value="${vault}">`
    : `<input type="hidden" name="device" value="${device}">`;
  const dev = options.devLogin
    ? `<form method="post" action="/auth/dev/login">
        ${hidden}
        <div>
          <label for="username">显示名</label>
          <input id="username" name="username" autocomplete="username" minlength="2" maxlength="64" required>
        </div>
        <button type="submit">进入</button>
        <p class="muted">这是未配置 SSO 时的本地登录，同一个显示名会得到同一个账户 ID。</p>
      </form>`
    : "";
  const empty = !options.oidc && !options.devLogin
    ? `<p>请配置 OIDC 环境变量，或把 ALLOW_DEV_LOGIN 设为 true。</p>`
    : "";
  const lead = back
    ? "登录完成后会跳回 Obsidian，插件会自动填入账户。"
    : "登录后可以在账户页查看同步情况。";
  return layout("登录", `
    <p>${lead}</p>
    ${error}
    <div class="card">${sso}${sso && dev ? "<div style='height:16px'></div>" : ""}${dev}${empty}</div>
    <div class="row" style="margin-top:18px">
      <a class="button secondary" href="/">回首页</a>
      <a class="button secondary" href="/install">先装插件</a>
      <a class="button secondary" href="/account">同步情况</a>
    </div>
  `, "login");
}

export function obsidianReturnPage(code: string, state: string, vault: string): string {
  const params = new URLSearchParams({ code, state });
  if (vault) params.set("vault", vault);
  const url = `obsidian://e2ee-sync?${params.toString()}`;
  return layout("回到 Obsidian", `
    <p>登录完成，正在回到 Obsidian。</p>
    <div class="card">
      <p>如果浏览器没有自动跳转，点下面的按钮。</p>
      <p><a class="button" href="${esc(url)}">返回 Obsidian</a></p>
      <p class="muted">回到插件后，把当前库绑定到一个远端仓库，同步才会开始。</p>
    </div>
    <div class="row" style="margin-top:18px">
      <a class="button secondary" href="/account">查看同步情况</a>
      <a class="button secondary" href="/">回首页</a>
    </div>
    <script>location.replace(${JSON.stringify(url)});</script>
  `, "login");
}

function callbackQuery(options: { returnTo?: string; state?: string; vault?: string; device?: string }): string {
  const query = new URLSearchParams();
  if (options.returnTo === "obsidian" && options.state) {
    query.set("return", "obsidian");
    query.set("state", options.state);
    if (options.vault) query.set("vault", options.vault);
  } else if (options.device) {
    query.set("device", options.device);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function accessPage(error?: string): string {
  const message = error ? `<p class="warn">${esc(error)}</p>` : "";
  return layout("访问口令", `
    <p>这台服务器设置了访问口令。它只用于打开页面和下发账户 ID，不能代替笔记密钥。</p>
    ${message}
    <form class="card" method="post" action="/access">
      <div>
        <label for="token">访问口令</label>
        <input id="token" name="token" type="password" required>
      </div>
      <button type="submit">进入</button>
    </form>
    <div class="row" style="margin-top:18px">
      <a class="button secondary" href="/">回首页</a>
      <a class="button secondary" href="/login">去登录</a>
    </div>
  `, "login");
}

export function accountPage(options: {
  displayName: string;
  accountId: string;
  vaults: Array<{ name: string; files: number; bytes: number; lastSyncAt: number; encrypted?: boolean }>;
  recent: Array<{ vaultName: string; size: number; updatedAt: number; encoding: "e2ee" | "plain" }>;
  notice?: string;
  mode: "central" | "single";
}): string {
  const notices: Record<string, string> = {
    "device-ok": "登录已完成。回到插件绑定远端仓库，就可以上传和下载。",
    "device-missing": "这次没能把账户送回插件。请在插件里再点一次「登录并获取」。",
  };
  const notice = options.notice && notices[options.notice] ? `<p class="warn">${esc(notices[options.notice])}</p>` : "";
  const lead = options.mode === "single"
    ? "这是单账户服务器，不用注册。在插件里登录并绑定仓库后即可同步。"
    : `${esc(options.displayName)}，登录只用来认出账户。密钥留在 Obsidian 里，用来加密和解密。`;
  const logout = options.mode === "central"
    ? `<form method="post" action="/auth/logout" id="logout-form"><button class="secondary" type="submit" id="logout-btn">退出</button></form>
      <script>
        document.getElementById("logout-form").addEventListener("submit", function () {
          var btn = document.getElementById("logout-btn");
          btn.disabled = true;
          btn.textContent = "正在退出…";
        });
      </script>`
    : "";
  const totalFiles = options.vaults.reduce((sum, vault) => sum + vault.files, 0);
  const totalBytes = options.vaults.reduce((sum, vault) => sum + vault.bytes, 0);
  const vaultRows = options.vaults.length === 0
    ? `<tr><td colspan="5">还没有上传。先到<a class="inline" href="/install">安装插件</a>，登录后绑定仓库，才会开始同步。</td></tr>`
    : options.vaults.map((vault) => `
      <tr>
        <td>${esc(vault.name || "未命名")}</td>
        <td>${vault.files}</td>
        <td>${esc(formatBytes(vault.bytes))}</td>
        <td>${vault.encrypted ? "已加密" : "明文"}</td>
        <td>${esc(formatTime(vault.lastSyncAt))}</td>
      </tr>
    `).join("");
  const recentRows = options.recent.length === 0
    ? `<tr><td colspan="4">还没有上传记录。</td></tr>`
    : options.recent.map((item) => `
      <tr>
        <td>${esc(item.vaultName || "未命名")}</td>
        <td>${esc(formatBytes(item.size))}</td>
        <td>${item.encoding === "plain" ? "明文" : "加密"}</td>
        <td>${esc(formatTime(item.updatedAt))}</td>
      </tr>
    `).join("");
  return layout("你的账户", `
    <p>${lead}</p>
    ${notice}
    <div class="card">
      <div class="muted">账户 ID</div>
      <div class="id" id="account-id">${esc(options.accountId)}</div>
      <div class="row" style="margin-top:12px">
        <button type="button" id="copy-id">复制</button>
        ${logout}
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">上传情况</h2>
      <p>${options.vaults.length} 个库，${totalFiles} 篇笔记，共 ${esc(formatBytes(totalBytes))}。</p>
      <p class="muted">服务器只记录这个库是否加密，不保存密钥。未加密的库按明文存放。一旦某个库开启加密，就不能再改回明文。</p>
      <table>
        <thead><tr><th>库</th><th>篇数</th><th>大小</th><th>加密</th><th>最近上传</th></tr></thead>
        <tbody>${vaultRows}</tbody>
      </table>
      <h2>最近上传</h2>
      <table>
        <thead><tr><th>库</th><th>大小</th><th>形式</th><th>时间</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>
    <div class="card">
      <h2 style="margin-top:0">插件里怎么填</h2>
      <ol>
        <li>Host：自建服务器地址。留空则使用插件里的公共服务器。</li>
        <li>在插件里点「登录」。浏览器登录后会跳回 Obsidian。</li>
        <li>把当前库绑定到一个远端仓库。没绑定时加密是关的。</li>
        <li>密钥：只有打开加密后才需要。在插件里随机生成并离线备份。丢了就解不开这些笔记。</li>
      </ol>
      <div class="row">
        <a class="button secondary" href="/">回首页</a>
        <a class="button secondary" href="/install">安装插件</a>
        <a class="button secondary" href="/login">登录页</a>
      </div>
    </div>
    <script>
      document.getElementById("copy-id").onclick = async () => {
        const value = document.getElementById("account-id").textContent.trim();
        try {
          await navigator.clipboard.writeText(value);
          document.getElementById("copy-id").textContent = "已复制";
        } catch (e) {
          document.getElementById("copy-id").textContent = "请手动复制";
        }
      };
    </script>
  `, "account");
}

export function homePage(options: { loggedIn: boolean }): string {
  const next = options.loggedIn
    ? `<a class="button" href="/account">查看同步情况</a>`
    : `<a class="button" href="/login">登录</a>`;
  return layout("端到端加密同步", `
    <p>笔记留在你的 Obsidian 里。这台服务器只保存同步结果，不保存密钥。</p>
    <div class="card">
      <h2 style="margin-top:0">三步开始</h2>
      <ol>
        <li>还没有 Obsidian 的话，先去<a class="inline" href="https://obsidian.md/" target="_blank" rel="noopener">Obsidian 官网</a>下载，并打开一个库。</li>
        <li>到<a class="inline" href="/install">安装插件</a>，复制命令运行，然后重启 Obsidian。</li>
        <li><a class="inline" href="/login">登录</a>，在插件里绑定远端仓库，再回来<a class="inline" href="/account">看同步情况</a>。</li>
      </ol>
      <div class="row">
        <a class="button" href="/install">安装插件</a>
        ${next}
        <a class="button secondary" href="https://obsidian.md/" target="_blank" rel="noopener">Obsidian 官网</a>
      </div>
    </div>
  `, "home");
}

export function installPage(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return layout("安装插件", `
    <p>先用 Obsidian 打开一个库，再复制下面这一行去终端运行。装好后重启 Obsidian。</p>
    <div class="card">
      <p class="muted">Windows</p>
      <pre class="command">irm ${esc(base)}/install.ps1 | iex</pre>
      <p class="muted">macOS / Linux</p>
      <pre class="command">curl -fsSL ${esc(base)}/install.sh | bash</pre>
      <p class="muted">命令会把插件放进这台电脑上已经打开过的库。新库如果还在限制模式，关掉一次限制模式就会出现。安装包按版本下载，并核对 SHA256。校验失败时不会写入任何库。</p>
      <p class="muted">macOS 上如果以前用 python.org 的 Python 安装失败，并提示 CERTIFICATE_VERIFY_FAILED，现在的命令优先使用系统自带的 curl，不再用 Python 下载。没有 curl 时才会退回 Python；那时请先运行 “/Applications/Python 3.x/Install Certificates.command”，或安装 curl。也可以加 <code>--vault 库路径</code>，只装进指定的库。</p>
      <div class="row" style="margin-top:12px">
        <a class="button secondary" href="/">回首页</a>
        <a class="button" href="/login">装好了，去登录</a>
        <a class="button secondary" href="/account">查看同步情况</a>
      </div>
    </div>
  `, "install");
}

export function installPs1(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `$ErrorActionPreference = "Stop"
$origin = "${base}"
function Save-Bytes([string]$url, [string]$dest) {
  $last = $null
  for ($try = 1; $try -le 3; $try++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
      return
    } catch {
      $last = $_
      Start-Sleep -Seconds ([Math]::Min(8, [Math]::Pow(2, $try)))
    }
  }
  throw $last
}
$version = if ($env:E2EE_VERSION) { $env:E2EE_VERSION.Trim() } else { (Invoke-WebRequest -Uri "$origin/plugin/e2ee-sync/latest" -UseBasicParsing -TimeoutSec 30).Content.Trim() }
if (-not $version) { throw "Could not read the plugin version" }
$base = "$origin/plugin/e2ee-sync/$version"
$tmp = Join-Path $env:TEMP ("e2ee-sync-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $names = @("manifest.json", "main.js", "styles.css")
  foreach ($name in $names) { Save-Bytes "$base/$name" (Join-Path $tmp $name) }
  $sumsPath = Join-Path $tmp "SHA256SUMS"
  Save-Bytes "$base/SHA256SUMS" $sumsPath
  $expected = @{}
  foreach ($line in ((Get-Content -LiteralPath $sumsPath -Raw) -split "\`n")) {
    if (-not $line.Trim()) { continue }
    $parts = $line.Trim() -split '\\s+', 2
    $expected[$parts[1].Trim().TrimStart('*')] = $parts[0].ToLower()
  }
  foreach ($name in $names) {
    $actual = (Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected[$name]) { throw "Checksum failed: $name" }
  }
  $cfgPath = Join-Path $env:APPDATA "obsidian\\obsidian.json"
  if (-not (Test-Path -LiteralPath $cfgPath)) { throw "Open Obsidian once, then run this command again." }
  $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $cfg.vaults) { throw "No Obsidian vaults found." }
  $n = 0
  foreach ($vault in $cfg.vaults.PSObject.Properties) {
    $root = [string]$vault.Value.path
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    $dest = Join-Path $root ".obsidian\\plugins\\e2ee-sync"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($name in $names) { Copy-Item -LiteralPath (Join-Path $tmp $name) -Destination (Join-Path $dest $name) -Force }
    $listPath = Join-Path $root ".obsidian\\community-plugins.json"
    $list = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $listPath) {
      $parsed = Get-Content -LiteralPath $listPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($item in @($parsed)) { if ($item) { [void]$list.Add([string]$item) } }
    }
    if (-not $list.Contains("e2ee-sync")) { [void]$list.Add("e2ee-sync") }
    $json = '[' + (($list | ForEach-Object { '"' + ($_ -replace '\\\\','\\\\' -replace '"','\\"') + '"' }) -join ',') + ']'
    [System.IO.File]::WriteAllText($listPath, $json, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Installed to $root"
    $n++
  }
  if ($n -eq 0) { throw "No usable vault directory found." }
  Write-Output "Done. Restart Obsidian. If a new vault is in restricted mode, turn restricted mode off once."
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
`;
}

export function installSh(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `#!/bin/sh
set -eu
origin='${base}'
plugin_id='e2ee-sync'
vault_arg=''
while [ \$# -gt 0 ]; do
  case "\$1" in
    --vault)
      vault_arg="\$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: \$1" >&2
      exit 1
      ;;
  esac
done
die() { echo "\$1" >&2; exit 1; }
fetch() {
  url="\$1"
  dest="\$2"
  if command -v curl >/dev/null 2>&1; then
    curl --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 -fsSL "\$url" -o "\$dest"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "\$dest" --timeout=120 --tries=3 "\$url"
    return
  fi
  py=''
  if command -v python3 >/dev/null 2>&1; then py=python3
  elif command -v python >/dev/null 2>&1; then py=python
  else
    die "curl is required. Python cannot download files without curl either."
  fi
  "\$py" - "\$url" "\$dest" <<'PY'
import ssl, sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
try:
    import certifi
    ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    ctx = ssl.create_default_context()
try:
    with urllib.request.urlopen(url, context=ctx, timeout=30) as resp:
        data = resp.read()
except ssl.SSLCertVerificationError:
    sys.exit('Certificate verification failed. For python.org Python on macOS, run "/Applications/Python 3.x/Install Certificates.command", or install curl.')
open(dest, "wb").write(data)
PY
}
version="\${E2EE_VERSION:-}"
if [ -z "\$version" ]; then
  version_file=\$(mktemp)
  fetch "\$origin/plugin/\$plugin_id/latest" "\$version_file" || die "Could not read the plugin version"
  version=\$(tr -d '[:space:]' < "\$version_file")
  rm -f "\$version_file"
fi
[ -n "\$version" ] || die "Could not read the plugin version"
tmp=\$(mktemp -d)
trap 'rm -rf "\$tmp"' EXIT
base="\$origin/plugin/\$plugin_id/\$version"
for name in manifest.json main.js styles.css SHA256SUMS; do
  fetch "\$base/\$name" "\$tmp/\$name" || die "Could not download \$name"
done
( cd "\$tmp" && { command -v sha256sum >/dev/null 2>&1 && sha256sum -c SHA256SUMS || shasum -a 256 -c SHA256SUMS; } ) || die "Checksum failed"
py=''
if command -v python3 >/dev/null 2>&1; then py=python3
elif command -v python >/dev/null 2>&1; then py=python
elif [ -n "\$vault_arg" ]; then
  dest="\$vault_arg/.obsidian/plugins/\$plugin_id"
  mkdir -p "\$dest"
  cp "\$tmp/manifest.json" "\$tmp/main.js" "\$tmp/styles.css" "\$dest/"
  list="\$vault_arg/.obsidian/community-plugins.json"
  if [ ! -f "\$list" ]; then
    printf '%s\\n' '["e2ee-sync"]' > "\$list"
  elif ! grep -q '"e2ee-sync"' "\$list"; then
    die "Copied the plugin, but python3 is missing, so community-plugins.json was not updated. Add e2ee-sync manually."
  fi
  echo "Installed to \$vault_arg"
  echo "Done. Restart Obsidian. If a new vault is in restricted mode, turn restricted mode off once."
  exit 0
else
  die "python3 is required to read Obsidian's vault list. Or run: bash install.sh --vault /path/to/vault"
fi
E2EE_VAULT="\$vault_arg" E2EE_SRC="\$tmp" exec "\$py" - <<'PY'
import json, os, sys
from pathlib import Path

src = Path(os.environ["E2EE_SRC"])
only = os.environ.get("E2EE_VAULT") or ""
home = Path.home()
names = ("manifest.json", "main.js", "styles.css")

def config_path():
    if sys.platform == "darwin":
        candidates = [home / "Library" / "Application Support" / "obsidian" / "obsidian.json"]
    elif os.name == "nt":
        candidates = [Path(os.environ.get("APPDATA", "")) / "obsidian" / "obsidian.json"]
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME")
        candidates = [
            (Path(xdg) if xdg else home / ".config") / "obsidian" / "obsidian.json",
            home / ".var" / "app" / "md.obsidian.Obsidian" / "config" / "obsidian" / "obsidian.json",
            home / "snap" / "obsidian" / "current" / ".config" / "obsidian" / "obsidian.json",
        ]
    for path in candidates:
        if path.is_file():
            return path
    return None

def install(root: Path) -> bool:
    if not root.is_dir():
        return False
    dest = root / ".obsidian" / "plugins" / "e2ee-sync"
    dest.mkdir(parents=True, exist_ok=True)
    for name in names:
        (dest / name).write_bytes((src / name).read_bytes())
    list_path = root / ".obsidian" / "community-plugins.json"
    plugins = []
    if list_path.exists():
        parsed = json.loads(list_path.read_text(encoding="utf-8"))
        if isinstance(parsed, list):
            plugins = [item for item in parsed if isinstance(item, str)]
    if "e2ee-sync" not in plugins:
        plugins.append("e2ee-sync")
    list_path.write_text(json.dumps(plugins, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
    print(f"Installed to {root}")
    return True

count = 0
if only:
    if install(Path(only)):
        count = 1
else:
    config = config_path()
    if config is None:
        raise SystemExit("Open Obsidian once, then run this command again. Or pass --vault /path/to/vault.")
    vaults = json.loads(config.read_text(encoding="utf-8")).get("vaults") or {}
    for vault in vaults.values():
        if install(Path(str(vault.get("path") or ""))):
            count += 1
if count == 0:
    raise SystemExit("No usable vault directory found.")
print("Done. Restart Obsidian. If a new vault is in restricted mode, turn restricted mode off once.")
PY
`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  if (!value) return "—";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function messagePage(title: string, message: string): string {
  return layout(title, `
    <div class="card">
      <p>${esc(message)}</p>
      <div class="row">
        <a class="button secondary" href="/">回首页</a>
        <a class="button secondary" href="/login">去登录</a>
        <a class="button secondary" href="/account">同步情况</a>
      </div>
    </div>
  `);
}
