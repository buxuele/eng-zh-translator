const DEV_CONFIG_PATH = "src/dev_config.json";

// 同一页面内只执行一次，避免并发读取后各自回写造成设置丢失。
let seedPromise = null;

export function seedDevKey() {
  if (!seedPromise) {
    seedPromise = doSeed().catch(() => false);
  }
  return seedPromise;
}

async function doSeed() {
  const stored = await chrome.storage.local.get("settings");
  const current = stored.settings || {};
  if (current.apiKey) return false;
  let apiKey = "";
  try {
    const res = await fetch(chrome.runtime.getURL(DEV_CONFIG_PATH));
    if (res.ok) {
      const config = await res.json();
      apiKey = (config.apiKey || "").trim();
    }
  } catch {
    return false;
  }
  if (!apiKey) return false;
  // 写回前再读一次，保留设置页或其他页面刚写入的字段，避免用旧快照覆盖。
  const latestStored = await chrome.storage.local.get("settings");
  const latest = latestStored.settings || {};
  if (latest.apiKey) return false;
  await chrome.storage.local.set({ settings: { ...latest, apiKey } });
  return true;
}
