const DEV_CONFIG_PATH = "src/dev_config.json";

let cache = null;

// 只作为运行时兜底，不写入 chrome.storage：
// 早期实现会回写 settings，与设置页或测试的写入并发时会把接口地址与模型覆盖掉。
export function getDevConfigKey() {
  if (!cache) {
    cache = fetch(chrome.runtime.getURL(DEV_CONFIG_PATH))
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => (config && typeof config.apiKey === "string" ? config.apiKey.trim() : ""))
      .catch(() => "");
  }
  return cache;
}
