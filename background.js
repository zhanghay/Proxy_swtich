const DEFAULT_PORT = 7890;

// 关闭时显式设为直连，而不是 clear() 回退系统代理：
// 否则系统代理（如 Clash 的系统代理模式）也是 7890 时，开关拨到关仍然走代理
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

function updateBadge(enabled, port) {
  chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? "#16a34a" : "#9ca3af" });
  chrome.action.setTitle({
    title: enabled ? `代理开关：已开启（127.0.0.1:${port}）` : "代理开关：已关闭（直连）"
  });
}

// 让实际代理设置向存储中的开关状态收敛：开启走 127.0.0.1:端口，关闭强制直连
async function syncProxy() {
  const { enabled, port } = await chrome.storage.local.get({ enabled: false, port: DEFAULT_PORT });
  try {
    await chrome.proxy.settings.set({
      value: enabled ? buildProxyConfig(port) : DIRECT_CONFIG,
      scope: "regular"
    });
  } catch (e) {
    // 被企业策略 / 其他扩展锁定时设置会失败，保持角标不变
    console.warn("代理设置未生效：", e && e.message);
    return;
  }
  updateBadge(enabled, port);
}

// 浏览器启动 / 扩展安装更新后恢复状态
chrome.runtime.onStartup.addListener(syncProxy);
chrome.runtime.onInstalled.addListener(syncProxy);

// 弹窗里切换开关或修改端口后（写入 storage），由这里统一落地设置并更新角标
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("enabled" in changes || "port" in changes)) syncProxy();
});
