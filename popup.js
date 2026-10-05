const DEFAULT_PORT = 7890;

// 与 background.js 保持一致：关闭 = 强制直连，而不是回退系统代理
const DIRECT_CONFIG = { mode: "direct" };

function buildProxyConfig(port) {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { host: "127.0.0.1", port },
      bypassList: [
        "localhost", "127.0.0.1", "<local>",
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"
      ]
    }
  };
}

const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const warnEl = document.getElementById("warn");
const portInput = document.getElementById("port");
const applyPortBtn = document.getElementById("applyPort");

let currentEnabled = false;
let currentPort = DEFAULT_PORT;

function render() {
  toggle.checked = currentEnabled;
  statusEl.className = "status " + (currentEnabled ? "on" : "off");
  statusEl.textContent = currentEnabled
    ? `代理已开启：127.0.0.1:${currentPort}`
    : "已关闭（直连，不走代理）";
}

function showWarn(text) {
  warnEl.textContent = text;
  warnEl.classList.add("show");
}

// 实际生效的代理是否是本扩展设置的 127.0.0.1:port
function isOurProxyOn(value, port) {
  const p = value && value.rules && value.rules.singleProxy;
  return !!value && value.mode === "fixed_servers" &&
    p && p.host === "127.0.0.1" && p.port === port;
}

async function applyProxy(enabled, port) {
  await chrome.proxy.settings.set({
    value: enabled ? buildProxyConfig(port) : DIRECT_CONFIG,
    scope: "regular"
  });
  await chrome.storage.local.set({ enabled });
}

async function init() {
  const [{ enabled, port }, { value, levelOfControl }] = await Promise.all([
    chrome.storage.local.get({ enabled: false, port: DEFAULT_PORT }),
    chrome.proxy.settings.get({ incognito: false })
  ]);

  currentEnabled = enabled;
  currentPort = port;
  portInput.value = port;

  // 实际设置和记录不一致时自愈（例如上次设置到一半失败）
  if (enabled !== isOurProxyOn(value, port) &&
      (levelOfControl === "controlled_by_this_extension" ||
       levelOfControl === "controllable_by_this_extension")) {
    try {
      await applyProxy(enabled, port);
    } catch (e) {
      console.warn("自动修复失败：", e && e.message);
    }
  }

  if (levelOfControl === "not_controllable") {
    showWarn("⚠️ 代理被浏览器命令行参数或企业策略固定，此开关无法生效。");
  } else if (levelOfControl === "controlled_by_other_extensions") {
    showWarn("⚠️ 代理当前被其他扩展控制，此开关可能不生效。");
  }

  render();
}

toggle.addEventListener("change", async () => {
  currentEnabled = toggle.checked;
  render();
  warnEl.classList.remove("show");
  try {
    await applyProxy(currentEnabled, currentPort);
    // 设置成功，角标由 background 监听 storage 变化统一更新
  } catch (e) {
    currentEnabled = !currentEnabled;
    render();
    showWarn("❌ 设置失败：" + e.message);
  }
});

// 修改端口：开启时立即用新端口重新落地；关闭时仅保存，下次开启生效
async function savePort() {
  const v = Number(portInput.value);
  if (!Number.isInteger(v) || v < 1 || v > 65535) {
    showWarn("❌ 端口需为 1-65535 的整数");
    portInput.value = currentPort;
    return;
  }
  if (v === currentPort) return;
  warnEl.classList.remove("show");
  try {
    if (currentEnabled) await applyProxy(true, v);
    await chrome.storage.local.set({ port: v });
    currentPort = v;
    render();
  } catch (e) {
    portInput.value = currentPort;
    showWarn("❌ 端口修改失败：" + e.message);
  }
}

applyPortBtn.addEventListener("click", savePort);
portInput.addEventListener("keydown", e => { if (e.key === "Enter") savePort(); });

init();
