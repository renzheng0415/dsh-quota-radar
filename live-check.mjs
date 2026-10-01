// live-check.mjs — 用真实凭据跑真实适配器
//
// 为什么需要这个：单元测试用的是人造响应，证明的是「解析逻辑对」；
// 这个脚本用**你本机的真密钥**打**真实接口**，证明的是「整条链路能跑通」。
//
// 它做的事：
//   1. 从 ~/.dsh/.credentials.yaml 读真实密钥（只读，不打印、不外传）
//   2. 调 dsh/adapters-public.js 里的真实适配器代码
//   3. 打印结果（密钥永远不出现在输出里）
//
// 用法：node live-check.mjs

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS, CATALOG } from "./dsh/adapters-public.js";

// ── 极简 YAML 解析：只取 refs 段下的 KEY: VALUE ──────────────
function loadCredentialRefs() {
  const path = join(homedir(), ".dsh", ".credentials.yaml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const refs = {};
  let inRefs = false;
  for (const raw of text.split("\n")) {
    if (/^refs:\s*$/.test(raw)) {
      inRefs = true;
      continue;
    }
    // 顶格的另一个键 → 离开 refs 段
    if (/^[A-Za-z_]/.test(raw)) {
      inRefs = false;
      continue;
    }
    if (!inRefs) continue;
    const m = raw.match(/^\s+([A-Z0-9_]+):\s*(.+?)\s*$/);
    if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return refs;
}

// ── 适配器原语（与 host 注入的一致）────────────────────────
const CREDENTIALS_UNAVAILABLE = Symbol("credentials-unavailable");

function makeDeps(refs) {
  return {
    CREDENTIALS_UNAVAILABLE,
    signal: AbortSignal.timeout(20_000),
    async resolveKey(_ctx, refs_wanted) {
      for (const r of refs_wanted) if (refs[r]) return refs[r];
      return null;
    },
    async getJson(url, headers, signal) {
      const res = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", ...(headers ?? {}) },
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 错误信息可能回显 key，这里统一截断，绝不外传
        const safe = text.slice(0, 200).replace(/[A-Za-z0-9._-]{20,}/g, "[已隐藏]");
        throw new Error(`HTTP ${res.status}: ${safe}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("响应不是 JSON");
      }
    },
    stateOk: (provider, label, extra) => ({
      provider, label, status: "ok",
      windows: extra.windows ?? [], balance: extra.balance ?? null,
      detail: extra.detail ?? null, stale: false, message: null,
    }),
    stateBad: (provider, label, status, message) => ({
      provider, label, status, windows: [], balance: null, detail: null, message,
    }),
  };
}

// ── 跑 ────────────────────────────────────────────────────
const refs = loadCredentialRefs();
const refNames = Object.keys(refs);
console.log(`读到 ${refNames.length} 个凭据引用：${refNames.join(", ")}\n`);

const deps = makeDeps(refs);
let ok = 0;
let fail = 0;
let skip = 0;

for (const adapter of PUBLIC_ADAPTERS) {
  const entry = CATALOG.find((c) => c.id === adapter.id);
  const hasKey = entry.keyRefs.some((r) => refs[r]);

  if (!hasKey) {
    console.log(`○ ${entry.label.padEnd(14)} 跳过（没有 ${entry.keyRefs[0]}）`);
    skip += 1;
    continue;
  }

  process.stdout.write(`● ${entry.label.padEnd(14)} 查询中… `);
  try {
    const st = await adapter.fetch({}, deps);
    if (st.status === "ok") {
      const bits = [];
      if (st.balance) bits.push(st.balance.display);
      for (const w of st.windows) bits.push(`${w.label} 剩余 ${100 - w.usedPercent}%`);
      console.log(`✅ ${bits.join(" · ") || "(无数值)"}`);
      if (st.detail && st.detail.source) console.log(`  └ 来源 ${st.detail.source}`);
      ok += 1;
    } else {
      console.log(`⚠️  ${st.status} — ${st.message}`);
      fail += 1;
    }
  } catch (e) {
    console.log(`❌ 抛出异常 — ${(e && e.message) || e}`);
    fail += 1;
  }
}

console.log(`\n成功 ${ok} · 失败 ${fail} · 跳过 ${skip}`);
process.exit(fail > 0 ? 1 : 0);
