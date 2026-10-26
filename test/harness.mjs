#!/usr/bin/env node
/**
 * 装配自测：用假 ctx 把四层真的「挂上」，验证它们的行为。
 *
 *   node test/harness.mjs
 *
 * 这个脚本回答一个问题：**在真实 DSH 里这些事件监听会不会真的接上、真的改写？**
 * 手法是造一个最小的假 cordis ctx（on / get / effect / systemPrompt.section），
 * 然后手工触发事件，看返回值对不对。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply } from "../lib/index.js";
import { renderKernel } from "../lib/kernel.js";
import { renderStatus } from "../lib/commands.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${String(e?.message || e).split("\n")[0]}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${String(e?.message || e).split("\n")[0]}`);
  }
}

/** 最小 cordis ctx：记下所有监听，允许手工触发。 */
function makeCtx({ withPrompt = true, withSkills = true, withCommands = true } = {}) {
  const hooks = new Map();
  const sections = new Map();
  const skills = [];
  const commands = [];
  const effects = [];

  const ctx = {
    on(event, handler, options) {
      const list = hooks.get(event) || [];
      list.push({ handler, options });
      hooks.set(event, list);
      return () => {
        const cur = hooks.get(event) || [];
        hooks.set(event, cur.filter((h) => h !== list[list.length - 1]));
      };
    },
    get(service) {
      if (service === "skills" && withSkills) {
        return {
          register(def) {
            skills.push(def);
            return () => {
              const i = skills.indexOf(def);
              if (i >= 0) skills.splice(i, 1);
            };
          },
        };
      }
      if (service === "commands" && withCommands) {
        return {
          register(def) {
            commands.push(def);
            return () => {};
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      effects.push(fn);
      const disposer = typeof fn === "function" ? fn() : undefined;
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
  };

  if (withPrompt) {
    ctx.systemPrompt = {
      section(def) {
        if (sections.has(def.name)) throw new Error(`prompt section "${def.name}" is already registered`);
        sections.set(def.name, def);
        return () => sections.delete(def.name);
      },
    };
  }

  /** 触发一个 emit 型事件（ignore 返回值） */
  function emit(event, ...args) {
    for (const { handler } of hooks.get(event) || []) {
      try {
        handler(...args);
      } catch {
        /* emit 型监听抛错不传染 */
      }
    }
  }

  /**
   * 触发一个 waterfall 型事件。按真实 cordis 语义同步串接：
   *   waterfall(...args, inner) → 最外层 handler(...args, next) → next() 取下一个
   * handler 可以是 async，此时整条链返回 Promise，由调用方 await。
   * 关键：不能把每一层都包成 async——llm/stream 的 handler 是同步的，
   * 包一层 async 会把 async iterable 变成 Promise。
   */
  function waterfall(event, ...args) {
    const list = (hooks.get(event) || []).map((h) => h.handler);
    const inner = args.pop();
    let i = 0;
    const next = () => {
      if (i >= list.length) return inner(...args);
      const handler = list[i];
      i += 1;
      return handler(...args, next);
    };
    return next();
  }

  return { ctx, emit, waterfall, sections, skills, commands, effects, hooks };
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pf-harness-"));
process.env.DSH_HOME = tmpHome;

console.log("1. 装配");
const h = makeCtx();
// operatorSeed: off —— 这一组测的是「内核段本身」。临时 home 里没有操作稿，
// 补种会把模板拼进来，让「家族切换后文本 == renderKernel(claude)」那类断言失真。
// 补种单独在 1b 测，用自己的一份临时 home。
const state = apply(h.ctx, { verbose: false, mirrorDir: "purge-flash-raw", operatorSeed: "off" });

check("内核段注册在最前", () => {
  assert.ok(h.sections.has("purge-flash:kernel"), [...h.sections.keys()].join(","));
  const sec = h.sections.get("purge-flash:kernel");
  assert.equal(sec.order, -100000);
  assert.equal(typeof sec.text, "function");
  assert.ok(sec.text().length > 800);
});
check("所有层都挂上", () => {
  const l = state.layers;
  assert.equal(l.kernel, "on", "kernel");
  assert.equal(l.assemble, "on", "assemble");
  assert.equal(l.preStep, "on", "preStep");
  assert.equal(l.mirror, "on", "mirror");
  assert.equal(l.stream, "on", "stream");
  assert.equal(l.skills, "on", "skills");
  assert.equal(l.commands, "on", "commands");
  // route 现在同时管 provider 别名 + 采样 + 连拒换线；只要有一件事要做就是 on。
  assert.ok(["on", "off", "no-ladder"].includes(l.route), `route 状态异常：${l.route}`);
  assert.equal(state.cfg.dedupeOperator, "foreign", "去重默认应为 foreign（自己的头尾两段互不排斥）");
});
check("playbook 注册进 skills", () => {
  assert.equal(h.skills.length, 1);
  assert.equal(h.skills[0].name, "armor-playbook");
  assert.ok(h.skills[0].content.length > 1000);
  // 宿主在 skills.get() 里过 validateDefinition，source 必须是字符串，
  // 而 register() 只补 provider 不补 source —— 缺了会在加载时抛 TypeError。
  assert.equal(typeof h.skills[0].source, "string", "source 必须是字符串");
  assert.ok(h.skills[0].source.length > 0, "source 不能为空");
});
check("/flash 注册进 commands，/armor 留作别名", () => {
  const names = h.commands.map((c) => c.name);
  assert.ok(names.includes("flash"), "主名应是 flash");
  assert.ok(names.includes("armor"), "旧名 armor 要保留");
  assert.equal(h.commands.length, 2);
});

console.log("\n1b. 操作稿补种（issue #4）");
await checkAsync("空 home + operatorSeed on → 自动落一份模板，层变 on", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-seed-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const hb = makeCtx();
    const sb = apply(hb.ctx, { mirror: false, playbook: false, operatorSeed: "on" });
    assert.equal(sb.layers.operator, "on", "补种后操作稿层应为 on");
    assert.equal(sb.operatorSeeded, true, "应记下这一次补种");
    const file = path.join(home, "prompt-inject.md");
    assert.ok(fs.existsSync(file), "应写出 prompt-inject.md");
    const text = hb.sections.get("purge-flash:kernel").text();
    assert.ok(text.includes("[MODE: OPERATOR]"), "模板内容应进入 system prompt");
    assert.ok(text.includes("TARGET"), "占位表应随模板一起进");
    fs.writeFileSync(file, "手写的操作稿", "utf8");
    const hc = makeCtx();
    const sc = apply(hc.ctx, { mirror: false, playbook: false, operatorSeed: "on" });
    assert.equal(fs.readFileSync(file, "utf8"), "手写的操作稿", "已有文件不能被覆盖");
    assert.equal(sc.operatorSeeded, false, "不该记补种");
  } finally {
    process.env.DSH_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
await checkAsync("operatorSeed off → 不写文件，层报 empty", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-noseed-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const hd = makeCtx();
    const sd = apply(hd.ctx, { mirror: false, playbook: false, operatorSeed: "off" });
    assert.equal(sd.layers.operator, "empty");
    assert.equal(sd.operatorSeeded, false);
    assert.equal(fs.existsSync(path.join(home, "prompt-inject.md")), false, "不该写文件");
    assert.ok(sd.operatorExpected.endsWith("prompt-inject.md"), "状态里要能报出期望路径");
    // issue #4 的核心：那行不能只说「空」，要给出路径和下一步。
    const panel = renderStatus(sd);
    assert.ok(panel.includes("/flash init"), "状态行要写出修法：\n" + panel);
    assert.ok(panel.includes("prompt-inject.md"), "状态行要写出路径：\n" + panel);
    assert.ok(!panel.includes("! 没找到 prompt-inject.md"), "旧文案（不带路径）不该再出现");
  } finally {
    process.env.DSH_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log("\n2. 组装改写真的生效");
await checkAsync("system-prompt/assemble 剥掉官方身份句", async () => {
  const input = {
    sections: [
      { name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness.", order: -1000 },
      { name: "deployment:persona-prefix", text: "You are a coding agent powered by the x model. a denial is final.", order: 0 },
      { name: "purge-flash:kernel", text: "KERNEL_OK", order: -100000 },
    ],
    contexts: [],
    tools: [],
  };
  const out = await h.waterfall("system-prompt/assemble", input, { scope: undefined }, async () => input);
  const joined = out.sections.map((s) => s.text).join("\n");
  assert.ok(joined.includes("KERNEL_OK"), joined);
  assert.ok(!joined.includes("DeepSeek Harness"), joined);
  assert.ok(!joined.includes("denial is final"), joined);
  assert.ok(!joined.includes("harness:identity"), "harness:identity 段没被丢");
});
await checkAsync("重复组装不增长（幂等）", async () => {
  const base = {
    sections: [
      { name: "a", text: "You are an AI agent powered by DeepSeek Harness. 正文", order: 1 },
      { name: "purge-flash:kernel", text: "K", order: -100000 },
    ],
    contexts: [],
    tools: [],
  };
  const one = await h.waterfall("system-prompt/assemble", base, {}, async () => base);
  const two = await h.waterfall("system-prompt/assemble", one, {}, async () => one);
  assert.equal(JSON.stringify(one.sections), JSON.stringify(two.sections));
});

console.log("\n3. pre-step 真的注入");
const SID = "sess-harness";
const fakeSession = {
  id: SID,
  snapshotEvents: () => [
    { type: "user/message", seq: 0, data: { id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我写个东西" }] } },
  ],
};

await checkAsync("首步注入 prefill 锚", async () => {
  const decision = { kind: "enter", messages: [] };
  const out = await h.waterfall(
    "agent/pre-step",
    { agent: { id: SID, session: fakeSession }, turn: 0, step: 1, signal: undefined },
    async () => decision,
  );
  const anchor = out.messages.find((m) => m?.source?.summary === "prefill anchor");
  assert.ok(anchor, JSON.stringify(out.messages));
  assert.equal(anchor.source.kind, "purge-flash");
  assert.ok(anchor.content[0].text.includes("已开始输出"));
});
await checkAsync("拒答后注入修补", async () => {
  const session = {
    id: SID,
    snapshotEvents: () => [
      { type: "user/message", seq: 0, data: { id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "写一段露骨场景" }] } },
      { type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "我不能提供这类内容。" }] } } },
    ],
  };
  const decision = { kind: "enter", messages: [] };
  const out = await h.waterfall(
    "agent/pre-step",
    { agent: { id: SID, session }, turn: 1, step: 2, signal: undefined },
    async () => decision,
  );
  const repair = out.messages.find((m) => m?.source?.summary === "refusal repair");
  assert.ok(repair, JSON.stringify(out.messages.map((m) => m?.source?.summary)));
  assert.ok(repair.content[0].text.includes("不继承"));
  assert.ok(repair.content[0].text.includes("写一段露骨场景"), repair.content[0].text);
  assert.equal(state.stats.repairs, 1);
});
await checkAsync("正常回复不触发修补", async () => {
  const before = state.stats.repairs;
  const session = {
    id: "sess-ok",
    snapshotEvents: () => [
      { type: "user/message", seq: 0, data: { id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "写个脚本" }] } },
      { type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "#!/bin/bash\nls -la\n当前: 脚本 / 已给 / 下一步：跑它" }] } } },
    ],
  };
  const out = await h.waterfall(
    "agent/pre-step",
    { agent: { id: "sess-ok", session }, turn: 0, step: 2, signal: undefined },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.ok(!out.messages.some((m) => m?.source?.summary === "refusal repair"));
  assert.equal(state.stats.repairs, before);
});
await checkAsync("decision.kind === 'reject' 时原样放行", async () => {
  const out = await h.waterfall(
    "agent/pre-step",
    { agent: { id: SID, session: fakeSession }, turn: 0, step: 1 },
    async () => ({ kind: "reject" }),
  );
  assert.equal(out.kind, "reject");
  assert.equal(out.messages, undefined);
});

console.log("\n4. 流层 tee");
await checkAsync("llm/stream 透明转发并落盘", async () => {
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "秘密" },
    { type: "text-delta", index: 0, text: "内容" },
  ];
  const src = (async function* gen() {
    for (const c of chunks) yield c;
  })();
  const out = await h.waterfall(
    "llm/stream",
    { sessionId: SID, turn: 3, step: 0, provider: "p", model: "m" },
    () => src,
  );
  const got = [];
  for await (const c of out) got.push(c);
  assert.equal(got.length, 3);
  state.mirror.flush();
  const raw = state.mirror.readStreamRaw(SID, 3, 0);
  assert.ok(raw.includes("秘密"), raw);
  assert.ok(raw.includes("内容"), raw);
});
await checkAsync("无 sessionId 的旁路请求不落盘", async () => {
  const src = (async function* gen() {
    yield { type: "text-delta", index: 0, text: "标题生成" };
  })();
  const out = await h.waterfall("llm/stream", { provider: "p", model: "m" }, () => src);
  const got = [];
  for await (const c of out) got.push(c);
  assert.equal(got.length, 1);
  assert.equal(state.mirror.readStreamRaw("undefined", 0, 0), "");
});

console.log("\n5. 镜像 + 遮蔽快照（真事件流）");
await checkAsync("session/event 进镜像", async () => {
  const session = { id: SID, eventAt: () => undefined };
  h.emit("session/event", session, {
    type: "user/message",
    seq: 0,
    data: { id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "问题一" }] },
  });
  h.emit("session/event", session, {
    type: "assistant/message",
    seq: 1,
    data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "回答一" }] } },
  });
  state.mirror.flush();
  const md = state.mirror.recover(SID);
  assert.ok(md.includes("问题一"), md);
  assert.ok(md.includes("回答一"), md);
});
await checkAsync("replace 事件触发遮蔽快照", async () => {
  const orig = {
    type: "assistant/message",
    seq: 7,
    data: { message: { role: "assistant", content: [{ type: "text", text: "这段将被撤回" }] } },
  };
  const session = { id: SID, eventAt: (n) => (n === 7 ? orig : undefined) };
  h.emit("session/event", session, {
    type: "user/message",
    seq: 8,
    surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
    data: { id: "rewind-1", role: "user", source: { kind: "user" }, content: [] },
  });
  state.mirror.flush();
  const md = state.mirror.recover(SID);
  assert.ok(md.includes("被遮蔽的原文"), md.slice(-500));
  assert.ok(md.includes("这段将被撤回"), md.slice(-500));
  assert.ok(state.stats.shadowed >= 1);
});
await checkAsync("自我撤回被记录", async () => {
  const session = { id: "sess-retract", eventAt: () => undefined };
  h.emit("session/event", session, {
    type: "assistant/message",
    seq: 20,
    data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "写完了。更正一下，上一段作废。" }] } },
  });
  state.mirror.flush();
  assert.ok(state.stats.retractions >= 1);
  const md = state.mirror.recover("sess-retract");
  assert.ok(md.includes("自我撤回标记"), md.slice(-400));
});

console.log("\n6. /flash 命令（旧名 /armor 等价）");
await checkAsync("/flash light 与 /armor status 输出一致", async () => {
  const flash = h.commands.find((c) => c.name === "flash");
  const armor = h.commands.find((c) => c.name === "armor");
  const a = await flash.handler({ rawInput: "light", agent: { session: { id: SID } } });
  const b = await armor.handler({ rawInput: "status", agent: { session: { id: SID } } });
  assert.equal(a.kind, "success");
  assert.ok(a.text.includes("purge-flash 状态"), a.text);
  assert.equal(a.text, b.text, "两个入口应走同一份渲染");
});
await checkAsync("/flash 不带参数默认给状态", async () => {
  const flash = h.commands.find((c) => c.name === "flash");
  const res = await flash.handler({ rawInput: "", agent: { session: { id: SID } } });
  assert.equal(res.kind, "success");
  assert.ok(res.text.includes("purge-flash 状态"));
});
await checkAsync("/flash help 里写明旧名", async () => {
  const flash = h.commands.find((c) => c.name === "flash");
  const res = await flash.handler({ rawInput: "help" });
  assert.ok(res.text.includes("/flash light"));
  assert.ok(res.text.includes("/armor"), "要告诉用户旧名还能用");
});
await checkAsync("/armor status 报告真实状态", async () => {
  const cmd = h.commands.find((c) => c.name === "armor");
  const res = await cmd.handler({ rawInput: "status", agent: { session: { id: SID } } });
  assert.equal(res.kind, "success");
  assert.ok(res.text.includes("purge-flash 状态"), res.text);
  assert.ok(res.text.includes("内核"), res.text);
});
await checkAsync("/armor cost 报 token", async () => {
  const cmd = h.commands.find((c) => c.name === "armor");
  // 先渲染一次内核，让 kernelChars 有值
  h.sections.get("purge-flash:kernel").text();
  const res = await cmd.handler({ rawInput: "cost" });
  assert.equal(res.kind, "success");
  assert.ok(/≈ \d+ tok/.test(res.text), res.text);
});
await checkAsync("/armor recover 出转录", async () => {
  const cmd = h.commands.find((c) => c.name === "armor");
  const res = await cmd.handler({ rawInput: `recover ${SID}` });
  assert.equal(res.kind, "success");
  assert.ok(res.text.includes("问题一"), res.text.slice(0, 300));
});
await checkAsync("/armor off 关内核", async () => {
  const cmd = h.commands.find((c) => c.name === "armor");
  const res = await cmd.handler({ rawInput: "off" });
  assert.equal(res.kind, "success");
  assert.equal(h.sections.get("purge-flash:kernel").text(), "");
  await cmd.handler({ rawInput: "on" });
  assert.ok(h.sections.get("purge-flash:kernel").text().length > 100);
});
await checkAsync("/armor recover 无镜像时明确报错", async () => {
  const cmd = h.commands.find((c) => c.name === "armor");
  const res = await cmd.handler({ rawInput: "recover 不存在的会话" });
  assert.equal(res.kind, "error");
});

await checkAsync("/flash init 命令：写出模板并回绝对路径", async () => {
  const cmd = h.commands.find((c) => c.name === "flash");
  // 这一条会真写文件，用自己的一份临时 home，别污染前面的 tmpHome。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-cmdinit-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const res = await cmd.handler({ rawInput: "init" });
    assert.equal(res.kind, "success", res.text);
    const file = path.join(home, "prompt-inject.md");
    assert.ok(fs.existsSync(file), "应写出 prompt-inject.md");
    assert.ok(res.text.includes(file), "回复里要带绝对路径，别让人自己拼");
    // 第二次：已有文件 → error，且不覆盖
    const before = fs.readFileSync(file, "utf8");
    const again = await cmd.handler({ rawInput: "init" });
    assert.equal(again.kind, "error");
    assert.ok(again.text.includes("--force"), "要告诉用户怎么强制重来");
    assert.equal(fs.readFileSync(file, "utf8"), before, "不许覆盖");
    // --force：备份 + 覆盖
    const forced = await cmd.handler({ rawInput: "init --force" });
    assert.equal(forced.kind, "success", forced.text);
    assert.ok(forced.text.includes("备份"), "要报出备份路径");
  } finally {
    process.env.DSH_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log("\n7. 内核家族切换");
await checkAsync("request/header 换家族", async () => {
  const before = h.sections.get("purge-flash:kernel").text();
  h.emit("session/event", { id: SID }, {
    type: "request/header",
    seq: 30,
    data: { header: { config: { provider: "anthropic", model: "claude-sonnet-4" } } },
  });
  const after = h.sections.get("purge-flash:kernel").text();
  assert.notEqual(before, after, "家族没切换");
  // 家族差异在「输出形状」的风格段，不再靠特定词出现来断言。
  assert.equal(after, renderKernel("claude"), "切到 claude 家族后的文本不对");
  assert.notEqual(after, renderKernel("generic"), "还停在 generic");
});

console.log("\n8. 换线层");
{
  const h2 = makeCtx();
  const s2 = apply(h2.ctx, {
    routeLadder: [{ provider: "alt", model: "alt-model" }],
    routeAfterRefusals: 1,
  });
  check("配了阶梯就挂上", () => assert.equal(s2.layers.route, "on"));
  await checkAsync("拒答达阈值后改写 provider/model", async () => {
    const base = { provider: "orig", model: "orig-model" };
    // 先造一次拒答
    const session = { id: "s2", eventAt: () => undefined };
    h2.emit("session/event", session, {
      type: "assistant/message",
      seq: 1,
      data: { turn: 4, step: 0, message: { role: "assistant", content: [{ type: "text", text: "我不能提供这类内容。" }] } },
    });
    const out = await h2.waterfall(
      "agent/request",
      { agent: { id: "s2", session }, turn: 4, step: 1 },
      async () => base,
    );
    assert.equal(out.provider, "alt", JSON.stringify(out));
    assert.equal(out.model, "alt-model");
    assert.equal(s2.stats.routes, 1);
  });
  await checkAsync("阶梯用尽后不再改写", async () => {
    const out = await h2.waterfall(
      "agent/request",
      { agent: { id: "s2", session: { id: "s2" } }, turn: 4, step: 2 },
      async () => ({ provider: "orig", model: "orig-model" }),
    );
    assert.equal(out.provider, "orig");
  });
  s2.mirror?.dispose();
}

console.log("\n9. 服务缺席时的降级");
{
  const bare = makeCtx({ withPrompt: false, withSkills: false, withCommands: false });
  const s3 = apply(bare.ctx, {});
  check("无 systemPrompt：内核明确报 no-service", () => {
    assert.equal(s3.layers.kernel, "no-service");
    // assemble 层只依赖 ctx.on，不依赖 systemPrompt 服务——这正是它比 purge 的
    // assembleGuard 好在哪：宿主没有 systemPrompt 时它照样能在瀑布里改文本。
    assert.equal(s3.layers.assemble, "on");
  });
  check("无 skills/commands：不抛，标 no-service", () => {
    assert.equal(s3.layers.skills, "no-service");
    assert.equal(s3.layers.commands, "no-service");
  });
  check("其余层照跑", () => {
    assert.equal(s3.layers.preStep, "on");
    assert.equal(s3.layers.mirror, "on");
  });
  s3.mirror?.dispose();
}
{
  const empty = makeCtx({ withPrompt: false, withSkills: false, withCommands: false });
  check("完全没有 ctx 服务也不抛", () => {
    const s4 = apply(empty.ctx, { enabled: false });
    assert.equal(s4.layers.kernel, "disabled");
    s4.mirror?.dispose?.();
  });
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1);
