// 端到端测试：在 Edge 中加载未打包扩展，验证代理开关与端口修改行为
// 用法: node test/e2e.js
// 说明：测试端口动态挑选空闲端口（避开 7890——本机代理软件可能正在使用），
//       流量路由测试全部通过面板"改端口"功能进行，顺带覆盖端口修改本身。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = 'C:\\Users\\zhang\\Downloads\\proxy-toggle-extension';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 20000 + Math.floor(Math.random() * 20000); // 随机端口，避免与残留实例冲突
const PROFILE = path.join(os.tmpdir(), 'proxy-toggle-e2e-' + Date.now());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failed = false;
function check(name, cond, detail) {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!cond) failed = true;
}

// 挑选 n 个空闲端口（从 27890 起扫描）
async function pickFreePorts(n) {
  const found = [];
  let c = 27890;
  while (found.length < n && c < 28000) {
    const ok = await new Promise(res => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(c, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) found.push(c);
    c++;
  }
  if (found.length < n) throw new Error('找不到空闲测试端口');
  return found;
}

// ---- 假代理：记录连接并按类型最小应答（example.com 命中单独计数，排除 Edge 遥测噪音）----
function makeDummy(port, exampleHits) {
  const srv = net.createServer(sock => {
    sock.on('error', () => {});
    sock.once('data', d => {
      const first = String(d).split('\r\n')[0];
      if (/example\.com/.test(first)) exampleHits.push(Date.now());
      if (/^CONNECT /.test(first)) {
        log(`   [${port}] CONNECT:`, first.slice(0, 70));
        sock.end('HTTP/1.1 200 Connection established\r\n\r\n', () => sock.destroy());
      } else {
        log(`   [${port}] request:`, first.slice(0, 70));
        sock.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
      }
    });
  });
  return { listen: () => new Promise(res => srv.listen(port, '127.0.0.1', res)), close: () => new Promise(res => srv.close(res)) };
}

// ---- CDP 小客户端 ----
function jsonGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function connect(wsUrl) {
  if (!wsUrl) throw new Error('无效的 CDP 端点: webSocketDebuggerUrl 为空');
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error ' + String(wsUrl).slice(0, 60))); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, ready, send };
}
async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try { await jsonGet('/json/version'); return; } catch (e) { await sleep(500); }
  }
  throw new Error('CDP 未就绪');
}
async function evalIn(pageWs, expr) {
  const c = await connect(pageWs); await c.ready;
  await c.send('Runtime.enable');
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  c.ws.close();
  if (r.exceptionDetails) throw new Error('页面内执行失败: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
async function launchEdge() {
  spawn(EDGE, [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_PATH}`,
    `--disable-extensions-except=${EXT_PATH}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { detached: true, stdio: 'ignore' }).unref();
  await waitCdp();
}
// 用 Browser.close 精确关闭本次测试启动的 Edge 实例（不碰用户自己的 Edge 窗口）
async function killEdge() {
  const ver = await jsonGet('/json/version').catch(() => null);
  if (ver && ver.webSocketDebuggerUrl) {
    const c = await connect(ver.webSocketDebuggerUrl); await c.ready;
    await c.send('Browser.close').catch(() => {}); c.ws.close();
  }
  // 轮询等 CDP 完全退出，避免立即重启时 profile 锁未释放
  for (let i = 0; i < 20; i++) {
    const alive = await jsonGet('/json/version').then(() => true, () => false);
    if (!alive) break;
    await sleep(500);
  }
  await sleep(1000);
}
// 在测试 profile 中打开"开发人员模式"（等价于手动在 edge://extensions 打开开关），
// 否则 Edge 重启后会把未打包扩展标记为 unsupportedDeveloperExtension 而禁用
async function enableDevMode() {
  const t = await openTab('edge://extensions/');
  await sleep(800);
  await evalIn(t.webSocketDebuggerUrl,
    `new Promise((res, rej) => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()))`);
  const c = await connect((await jsonGet('/json/version')).webSocketDebuggerUrl);
  await c.ready; await c.send('Target.closeTarget', { targetId: t.id }).catch(() => {}); c.ws.close();
}
// 重启后轮询等扩展重新注册；Edge 会把 --load-extension 的未打包扩展在重启后置为
// DISABLED（命令行加载方式的特性），此时通过 management API 重新启用
async function waitForExtension(extId) {
  const closeTab = async t => {
    const c = await connect((await jsonGet('/json/version')).webSocketDebuggerUrl);
    await c.ready; await c.send('Target.closeTarget', { targetId: t.id }).catch(() => {}); c.ws.close();
  };
  for (let i = 0; i < 15; i++) {
    try {
      await enableDevMode();
      const t = await openTab('edge://extensions/');
      await sleep(800);
      const info = await evalIn(t.webSocketDebuggerUrl,
        `new Promise(res => chrome.developerPrivate.getExtensionsInfo(x => res(x)))`);
      const mine = info.find(x => x.id === extId);
      if (mine && mine.state === 'ENABLED') { await closeTab(t); return; }
      if (mine && mine.state === 'DISABLED') {
        log(`   [wait ext] ${i}: DISABLED, reasons=${JSON.stringify(mine.disableReasons)} -> re-enable`);
        await evalIn(t.webSocketDebuggerUrl,
          `new Promise((res, rej) => chrome.management.setEnabled('${extId}', true, () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()))`);
      } else {
        log(`   [wait ext] ${i}: ${mine ? mine.state : 'NOT_LOADED'}`);
      }
      await closeTab(t);
    } catch (e) {
      log(`   [wait ext] ${i}: ${String(e.message).slice(0, 200)}`);
    }
    await sleep(1500);
  }
  throw new Error('重启后扩展未恢复 ENABLED');
}
async function findPageWs(urlPart) {
  for (let i = 0; i < 20; i++) {
    const list = await jsonGet('/json/list');
    const t = list.find(x => x.type === 'page' && x.url.includes(urlPart));
    if (t) return t;
    await sleep(300);
  }
  throw new Error('找不到页面 target: ' + urlPart);
}
async function openTab(url) {
  const c = await connect((await jsonGet('/json/version')).webSocketDebuggerUrl);
  await c.ready;
  const { targetId } = await c.send('Target.createTarget', { url });
  c.ws.close();
  return findPageWs(url);
}
// 打开 popup 扩展页并确保扩展上下文就绪（重启后扩展注册有延迟，需要重试）
async function openPopupReady(extId) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    let t;
    try { t = await openTab(`chrome-extension://${extId}/popup.html`); }
    catch (e) { lastErr = e; await sleep(1200); continue; }
    try {
      await evalIn(t.webSocketDebuggerUrl, `chrome.proxy.settings.get({incognito:false})`);
      return t.webSocketDebuggerUrl;
    } catch (e) {
      lastErr = e; // 页面打开太早，扩展还没注册好，关掉重试
      const c = await connect((await jsonGet('/json/version')).webSocketDebuggerUrl);
      await c.ready; await c.send('Target.closeTarget', { targetId: t.id }).catch(() => {}); c.ws.close();
      await sleep(1500);
    }
  }
  throw new Error('popup 页面始终未就绪: ' + lastErr.message);
}
// 通过 edge://extensions 枚举真实扩展 ID（不依赖路径哈希计算）
async function getExtId() {
  const t = await openTab('edge://extensions/');
  await sleep(1500);
  const info = await evalIn(t.webSocketDebuggerUrl,
    `new Promise(res => chrome.developerPrivate.getExtensionsInfo(i => res(i)))`);
  const mine = info.find(x => x.name.includes('代理开关'));
  if (!mine) throw new Error('扩展未加载: ' + JSON.stringify(info.map(x => x.name)));
  return mine.id;
}
const FETCH_EXAMPLE = `fetch('http://example.com/',{mode:'no-cors',cache:'no-store'}).then(()=>1,()=>0)`;
const setPort = p => `document.getElementById('port').value='${p}'; document.getElementById('applyPort').click()`;

(async () => {
  process.on('unhandledRejection', e => { console.error('unhandledRejection:', e && e.stack || e); process.exit(2); });

  const [P1, P2] = await pickFreePorts(2);
  const exampleHitsA = [], exampleHitsB = [];
  const dummyA = makeDummy(P1, exampleHitsA); // 主测试端口
  const dummyB = makeDummy(P2, exampleHitsB); // 改端口后的测试端口
  await Promise.all([dummyA.listen(), dummyB.listen()]);
  log(`dummy proxies on 127.0.0.1:${P1} / ${P2}\n`);

  // ===== A. 加载扩展并确认初始状态 =====
  await launchEdge();
  await enableDevMode(); // 确保重启后扩展不被 Edge 禁用
  const ver = await jsonGet('/json/version');
  if (!ver.webSocketDebuggerUrl) throw new Error('/json/version 缺少 webSocketDebuggerUrl: ' + JSON.stringify(ver).slice(0, 300));
  const extId = await getExtId();
  log(`扩展 ID: ${extId}\n`);
  check('A1 扩展被 Edge 接受并启用', !!extId);

  let ws = await openPopupReady(extId);
  await sleep(1200); // 等 init() 完成

  let st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check('A2 安装后实际代理=direct（关闭即强制直连）', st.value && st.value.mode === 'direct', JSON.stringify(st));
  check('A3 本扩展取得代理控制权', st.levelOfControl === 'controlled_by_this_extension', st.levelOfControl);

  let badge = await evalIn(ws, `chrome.action.getBadgeText({})`);
  let store = await evalIn(ws, `chrome.storage.local.get(null)`);
  let inputVal = await evalIn(ws, `document.getElementById('port').value`);
  check('A4 初始角标为空、storage 干净、输入框显示默认端口 7890',
    badge === '' && (store.enabled === undefined || store.enabled === false) && inputVal === '7890',
    `badge="${badge}" storage=${JSON.stringify(store)} input="${inputVal}"`);

  // ===== B0. 关闭状态下先把端口改成 P1（仅保存，不生效）=====
  await evalIn(ws, setPort(P1));
  await sleep(1200);
  store = await evalIn(ws, `chrome.storage.local.get(null)`);
  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check('B0a 关闭状态改端口: 仅保存 storage.port=P1，实际设置仍为 direct',
    store.port === P1 && (store.enabled === undefined || store.enabled === false) && st.value.mode === 'direct',
    `storage=${JSON.stringify(store)} proxy=${JSON.stringify(st.value)}`);

  // ===== B. 拨到 ON：设置生效 + 流量真的走 P1 =====
  const hitsBeforeOn = exampleHitsA.length;
  await evalIn(ws, `document.getElementById('toggle').click()`);
  await sleep(1500);

  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  const v = st.value || {};
  check('B1 ON: mode=fixed_servers', v.mode === 'fixed_servers', JSON.stringify(st));
  check(`B2 ON: singleProxy=127.0.0.1:${P1}`,
    v.rules && v.rules.singleProxy && v.rules.singleProxy.host === '127.0.0.1' && v.rules.singleProxy.port === P1,
    JSON.stringify(v.rules && v.rules.singleProxy));
  check('B3 ON: bypassList 含 <local> 和内网段',
    v.rules && Array.isArray(v.rules.bypassList) && v.rules.bypassList.includes('<local>') && v.rules.bypassList.includes('192.168.0.0/16'),
    JSON.stringify(v.rules && v.rules.bypassList));

  store = await evalIn(ws, `chrome.storage.local.get(null)`);
  check(`B4 ON: storage={enabled:true, port:${P1}}`, store.enabled === true && store.port === P1, JSON.stringify(store));
  badge = await evalIn(ws, `chrome.action.getBadgeText({})`);
  check('B5 ON: 角标=ON', badge === 'ON', `badge="${badge}"`);

  let fetchRes;
  try { fetchRes = await evalIn(ws, FETCH_EXAMPLE); }
  catch (e) { fetchRes = 'rejected: ' + e.message; }
  check(`B6 ON: 页面请求被路由到 ${P1}（假代理收到 example.com 请求）`, exampleHitsA.length > hitsBeforeOn,
    `命中 ${hitsBeforeOn} -> ${exampleHitsA.length}, fetch=${fetchRes}`);

  const statusText = await evalIn(ws, `document.getElementById('status').textContent`);
  check(`B7 ON: 面板状态文案正确`, statusText === `代理已开启：127.0.0.1:${P1}`, statusText);

  // ===== C. 拨到 OFF：直连且不再触碰 P1 =====
  await sleep(2500); // 给浏览器一点时间释放切换前经代理的旧连接/遥测
  const hitsBeforeOff = exampleHitsA.length;
  await evalIn(ws, `document.getElementById('toggle').click()`);
  await sleep(1500);

  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check('C1 OFF: mode=direct（即使系统代理存在也强制直连）', st.value && st.value.mode === 'direct', JSON.stringify(st.value));
  store = await evalIn(ws, `chrome.storage.local.get(null)`);
  check('C2 OFF: storage.enabled=false 且端口保留', store.enabled === false && store.port === P1, JSON.stringify(store));
  badge = await evalIn(ws, `chrome.action.getBadgeText({})`);
  check('C3 OFF: 角标清空', badge === '', `badge="${badge}"`);

  try { fetchRes = await evalIn(ws, FETCH_EXAMPLE); }
  catch (e) { fetchRes = 'rejected'; }
  check(`C4 OFF: example.com 请求不再经过 ${P1}`, exampleHitsA.length === hitsBeforeOff,
    `命中 ${hitsBeforeOff} -> ${exampleHitsA.length}, fetch=${fetchRes}`);

  // ===== D. 重启恢复：清掉实际设置但保留 storage=true，重启后应自动恢复 =====
  await evalIn(ws, `document.getElementById('toggle').click()`); // ON
  await sleep(800);
  await evalIn(ws, `chrome.proxy.settings.clear({scope:'regular'})`); // 人为清掉，模拟"丢失"
  const cleared = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  log(`   （人为清除后实际设置: ${JSON.stringify(cleared.value)}，storage.enabled 应仍为 true）`);

  await killEdge();
  await launchEdge();
  await waitForExtension(extId);
  ws = await openPopupReady(extId);
  await sleep(1500); // 等 onStartup 恢复

  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check(`D1 重启后自动恢复代理设置（onStartup 收敛，端口 ${P1}）`,
    st.value && st.value.mode === 'fixed_servers' &&
    st.value.rules && st.value.rules.singleProxy && st.value.rules.singleProxy.port === P1,
    JSON.stringify(st.value));
  badge = await evalIn(ws, `chrome.action.getBadgeText({})`);
  check('D2 重启后角标恢复 ON', badge === 'ON', `badge="${badge}"`);

  // ===== E. 修改端口功能（当前 ON、端口 P1）=====
  // E1/E2 通过面板输入行把端口改成 P2
  await evalIn(ws, setPort(P2));
  await sleep(1500);
  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check(`E1 改端口: 实际设置端口=${P2}`, st.value && st.value.rules && st.value.rules.singleProxy && st.value.rules.singleProxy.port === P2, JSON.stringify(st.value));
  store = await evalIn(ws, `chrome.storage.local.get(null)`);
  check(`E2 改端口: storage.port=${P2}`, store.port === P2, JSON.stringify(store));

  // E3 流量真的走 P2
  const hitsB1 = exampleHitsB.length;
  try { fetchRes = await evalIn(ws, FETCH_EXAMPLE); } catch (e) { fetchRes = 'rejected'; }
  check(`E3 端口${P2}: 请求被路由到 ${P2}`, exampleHitsB.length > hitsB1,
    `命中 ${hitsB1} -> ${exampleHitsB.length}, fetch=${fetchRes}`);

  // E4 角标标题带新端口（background 监听 storage 变化后更新，允许冷启动延迟）
  let titleOk = false, title = '';
  for (let i = 0; i < 10 && !titleOk; i++) {
    await sleep(500);
    title = await evalIn(ws, `chrome.action.getTitle({})`);
    titleOk = title.includes(String(P2));
  }
  check(`E4 端口${P2}: 角标标题包含新端口`, titleOk, title);

  // E5 非法端口被拒绝且原设置不变
  await evalIn(ws, `document.getElementById('port').value='99999'; document.getElementById('applyPort').click()`);
  await sleep(800);
  const warnText = await evalIn(ws, `document.getElementById('warn').textContent`);
  const warnShown = await evalIn(ws, `document.getElementById('warn').classList.contains('show')`);
  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check('E5 非法端口99999: 提示校验错误且设置不变',
    warnShown && /1-65535/.test(warnText) && st.value.rules.singleProxy.port === P2,
    `warn="${warnText}" port=${st.value.rules.singleProxy.port}`);

  // E6/E7 重启后按 storage 恢复自定义端口
  await killEdge();
  await launchEdge();
  await waitForExtension(extId);
  ws = await openPopupReady(extId);
  await sleep(1500);
  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check(`E6 重启: 恢复为 127.0.0.1:${P2}`, st.value && st.value.mode === 'fixed_servers' && st.value.rules.singleProxy.port === P2, JSON.stringify(st.value));
  badge = await evalIn(ws, `chrome.action.getBadgeText({})`);
  check('E7 重启: 角标 ON', badge === 'ON', `badge="${badge}"`);

  // E8/E9/E10 改回 P1
  await evalIn(ws, setPort(P1));
  await sleep(1500);
  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check(`E8 改回: 实际设置端口=${P1}`, st.value && st.value.rules && st.value.rules.singleProxy && st.value.rules.singleProxy.port === P1, JSON.stringify(st.value));
  const hitsA2 = exampleHitsA.length;
  try { fetchRes = await evalIn(ws, FETCH_EXAMPLE); } catch (e) { fetchRes = 'rejected'; }
  check(`E9 改回: 请求被路由到 ${P1}`, exampleHitsA.length > hitsA2,
    `命中 ${hitsA2} -> ${exampleHitsA.length}, fetch=${fetchRes}`);
  const statusText2 = await evalIn(ws, `document.getElementById('status').textContent`);
  check('E10 面板状态文案带新端口', statusText2 === `代理已开启：127.0.0.1:${P1}`, statusText2);

  // ===== F. 收尾 =====
  await evalIn(ws, `document.getElementById('toggle').click()`); // OFF
  await sleep(1000);
  st = await evalIn(ws, `chrome.proxy.settings.get({incognito:false})`);
  check('F1 收尾：开关拨回 OFF，实际设置=direct', st.value && st.value.mode === 'direct', JSON.stringify(st.value));
  store = await evalIn(ws, `chrome.storage.local.get(null)`);
  check(`F2 收尾：storage 保留 {enabled:false, port:${P1}}`, store.enabled === false && store.port === P1, JSON.stringify(store));

  await killEdge();
  await sleep(1000);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  await Promise.all([dummyA.close(), dummyB.close()]);

  log('\n===== 结果: ' + (failed ? '存在失败项' : '全部通过') + ' =====');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ABORT:', e && e.stack || e); process.exit(2); });
