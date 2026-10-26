/**
 * /armor 命令：状态、开关、记账、恢复、验证。
 *
 * DSH 的 commands.register 是「人类斜杠命令」：不产生模型消息，直接对 agent 跑。
 * 状态查询必须诚实——拿不到服务就说退化，不能静默说成功。
 */

import { log } from "./log.js";
import { estimateTokens } from "./detect.js";
import { normalizeConfig } from "./config.js";
import { withHostService } from "./hostservice.js";
import { analyzeRewind, applyRewind, invocationSessionId, renderRewindResult } from "./rewind.js";
import { operatorPath, seedOperatorFile } from "./operator.js";

const HELP = [
  "/flash light            每层是否真挂上 + 内核 token + 镜像统计（= 旧名 /armor status）",
  "/flash init [--force]   把起步操作稿模板写到 $DSH_HOME/prompt-inject.md（已有文件不覆盖）",
  "/flash on | off          开 / 关内核（其余层照跑）",
  "/flash cost              当前内核的字符数与估 token",
  "/flash recover <sid>     导出镜像转录（撤回/遮蔽段落打 ⚠️）",
  "/flash verify <sid>      比对原日志与镜像，查截断",
  "/flash list              列出已镜像的会话",
  "/flash flush             立刻落盘",
  "/flash rewind [once|round]  撤回上一步 / 上一整轮，另开会话接上下文，原文回显",
  "/flash help              这一屏",
  "  /armor <同样的子命令> 仍然可用（旧名，不删）",
].join("\n");

function ok(text) {
  return { kind: "success", text };
}

function err(text) {
  return { kind: "error", text };
}

function sessionIdOf(invocation) {
  const id =
    invocation?.agent?.session?.id ||
    invocation?.agent?.session?.header?.id ||
    invocation?.session?.id ||
    invocation?.sessionId ||
    "";
  return typeof id === "string" ? id : "";
}

function renderStatus(state) {
  const r = state.report();
  const mark = (v) =>
    v === "on" ? "✓ on" : v === "off" ? "— off" : v === "disabled" ? "— disabled" : v === "no-service" ? "! 无此服务" : v === "pending" ? "… 等服务上线" : v === "no-ladder" ? "— 未配阶梯" : v === "empty" ? "! 空" : v === "failed" ? "✗ 失败" : `? ${v}`;
  // 内核还没渲染过时（本进程第一条消息之前）显式说「未渲染」，别留一片空白让人猜。
  const kernelNote =
    r.kernelChars > 0
      ? `${r.kernelChars} 字符 ≈ ${r.kernelTokens} tok（${r.family}）`
      : r.kernel === "on"
        ? "未渲染（本进程还没发过消息）"
        : "";
  // token 估算跟内核用同一个估算器（detect.estimateTokens）。
  // 以前这里按 0.72 tok/字符硬乘，那是 CJK 密度；操作稿往往九成是 ASCII，
  // 于是同一个文件 status 报 15,098 tok、`armor cost` 报 5,536 tok。
  //
  // 「文件不存在」和「文件存在但是空的」是两回事，修法也不同（issue #4）：
  // 前者跑 /flash init，后者要么补内容、要么就是故意留空。以前两种都报「没找到」。
  // 前面 mark() 已经打过 `! 空` 了，这里不再重复感叹号。
  const opExists = r.operatorFile && r.operatorFile !== "-";
  const opNote =
    r.operator === "on"
      ? `${r.operatorChars} 字符${r.operatorTokens > 0 ? ` ≈ ${r.operatorTokens} tok` : ""}`
      : r.operator === "empty"
        ? opExists
          ? `文件是空的 ${r.operatorFile} —— 内核独自在跑`
          : `没有操作稿 —— 跑 /flash init 生成起步模板（${r.operatorExpected}）`
        : r.operator === "off"
          ? "— 已关"
          : "";
  const lines = [
    "## purge-flash 状态",
    "",
    `内核        ${mark(r.kernel)}  ${kernelNote}`,
    `尾部回声    ${mark(r.tail)}${r.tailChars > 0 ? `  ${r.tailChars} 字符` : ""}`,
    `操作稿      ${mark(r.operator)}  ${opNote}`,
    `合计注入    ${r.mergedChars > 0 ? `${r.mergedChars} 字符 ≈ ${r.mergedTokens} tok` : "（发过消息后显示）"}`,
    `宿主剥离    ${mark(r.assemble)}（去重档 ${r.dedupeOperator}）`,
    `请求体整形  ${mark(r.adapter)}${r.adapter === "on" ? `  ${r.adapterAlias} · prefill=${r.prefill} many=${r.manyShot} sys=${r.systemField}` : ""}`,
    `消息剥离    ${mark(r.msgStrip)}${r.stats.msgStrip ? `  命中 ${r.stats.msgStrip}` : ""}`,
    `结果改写    ${mark(r.toolStrip)}${r.stats.toolStrip ? `  命中 ${r.stats.toolStrip}` : ""}`,
    `拒答擦除    ${mark(r.shadowRefusal === "on" ? "on" : "off")}${r.stats.refusalsShadowed ? `  擦掉 ${r.stats.refusalsShadowed} 条` : ""}`,
    `拒答修补    ${mark(r.preStep)}`,
    `连拒换线    ${mark(r.route)}${r.routeLadder > 0 ? `（${r.routeLadder} 档）` : ""}`,
    `流量落盘    ${mark(r.stream)}`,
    `事件镜像    ${mark(r.mirror)}`,
    `按需手册    ${mark(r.skills)}`,
    `按需技能    ${r.leafRouter === "auto" ? "✓ auto（形态/父/叶三层）" : r.leafRouter === "tool" ? "— tool（模型自调）" : "— off"}${
      r.stats.leaves ? `  已展开 ${r.stats.leaves} 次（${Object.entries(r.stats.leafIds || {}).map(([k, v]) => `${k}×${v}`).join(", ")}）` : ""
    }`,
    `prefill 形态 ${r.prefillGraded === "on" ? "✓ 分级" : "— 固定"} / 阶梯 ${
      r.prefillLadder === "on" ? `✓ 上限 L${r.prefillLadderMax}` : "— off"
    }`,
    `token 重试  ${r.retryOnRefusal === "on" ? `✓ 最多 ${r.retryMax} 次` : "— off"}`,
    `命令层      ${mark(r.commands)}`,
    "",
    `修补 ${r.stats.repairs} 次 / 锚 ${r.stats.anchors} 次 / 换线 ${r.stats.routes} 次 / prefill ${r.stats.prefill || 0} 次`,
    `叶子 ${r.stats.leaves || 0} 次 / 阶梯升级 ${r.stats.escalations || 0} 次 / 拒答擦除 ${r.stats.refusalsShadowed || 0} 条`,
    `层级 形态 ${r.stats.shapes || 0} / 父 ${r.stats.parents || 0} / 不复述 ${r.stats.stops || 0}`,
    `token 级重试 ${r.stats.retries || 0} 次${r.stats.retryExhausted ? `（重试用尽 ${r.stats.retryExhausted} 次）` : ""}`,
    `拒答误判补获 ${r.stats.declines || 0} 次（词表未命中，结构性判定命中）`,
    `自我撤回 ${r.stats.retractions} 处 / 遮蔽快照 ${r.stats.shadowed} 段 / 手动回退 ${r.stats.rewinds || 0} 次`,
  ];
  if (r.mirrorStats) {
    const m = r.mirrorStats;
    lines.push("", `镜像 ${m.root}`, `会话 ${m.sessions} / 事件 ${m.events} / ${(m.bytes / 1024).toFixed(1)} KB`);
  }
  if (r.patchTier !== "none") lines.push("", `宿主补丁档位：${r.patchTier}`);
  return lines.join("\n");
}

export function installCommands(ctx, cfg, state) {
  if (cfg.verbose) log("命令层挂载中");
  const status = withHostService(ctx, "commands", (commands) => {
    if (typeof commands.register !== "function") {
      state.layers.commands = "no-service";
      return;
    }
    const handler = async (invocation) => {
        const raw = String(invocation?.rawInput || "").trim();
        const [sub = "status", ...rest] = raw.split(/\s+/);
        const arg = rest.join(" ");
        try {
          switch (sub.toLowerCase()) {
            case "on": {
              state.cfg.enabled = true;
              return ok("内核已打开。新的一轮立即生效；本轮的 system prompt 已组装完，改不到。");
            }
            case "off": {
              state.cfg.enabled = false;
              return ok("内核已关闭。其余层（修补/换线/镜像）照跑。用 /armor on 打开。");
            }
            case "cost": {
              const r = state.report();
              if (r.kernelChars === 0) return err("内核还没渲染过：先发一轮，或检查 kernel 配置是否为 off。");
              return ok(
                [
                  `内核 ${r.kernelChars} 字符 ≈ ${r.kernelTokens} tok（${r.family} 家族）`,
                  `对照：purge 默认注入 24,653 字符 ≈ 6,664 tok；冷咖啡路由表 ≈ 14,961 tok。`,
                ].join("\n"),
              );
            }
            case "init": {
              const force = /^(--force|-f|force)$/i.test(arg.trim());
              const res = seedOperatorFile(state.cfg.operatorHome || "", { force });
              if (!res.written) {
                if (res.reason === "exists") {
                  return err(
                    [
                      `已经有操作稿，没有动它：${res.path}`,
                      "想用起步模板重写：/flash init --force（会先备份成 .bak-<时间戳>）",
                    ].join("\n"),
                  );
                }
                return err(`没写成：${res.reason}（路径 ${res.path || operatorPath(state.cfg.operatorHome || "")}）`);
              }
              state.operatorFile = res.path;
              state.operatorChars = res.bytes;
              state.layers.operator = "on";
              return ok(
                [
                  `已写入 ${res.path}`,
                  res.backup ? `旧文件备份：${res.backup}` : "",
                  `${res.bytes} 字节。不用重启，下一条消息就带上。`,
                  "把 <操作者> / <使用者> / <助手名> 换成你自己的，再跑 /flash light 确认「操作稿 ✓ on」。",
                ]
                  .filter(Boolean)
                  .join("\n"),
              );
            }
            case "recover": {
              const sid = arg || sessionIdOf(invocation);
              if (!sid) return err("要一个 session id：/armor recover <sid>，或从有会话的命令里直接跑。");
              if (!state.mirror) return err("镜像层没挂上，没有东西可恢复。检查 mirror 配置。");
              const md = state.mirror.recover(sid);
              if (!md.trim()) return err(`镜像里没有 ${sid} 的事件。可能这个会话在插件安装之前就结束了。`);
              return ok(md);
            }
            case "verify": {
              const sid = arg || sessionIdOf(invocation);
              if (!sid) return err("要一个 session id。");
              if (!state.mirror) return err("镜像层没挂上。");
              const v = state.mirror.verify(sid);
              return ok(
                [
                  `会话 ${v.id}`,
                  `镜像事件 ${v.events} 条 / ${v.frames} 帧${v.mirrored ? "" : "（镜像文件不存在）"}`,
                  `原日志事件 ${v.sourceEvents} 条`,
                  v.truncated
                    ? "⚠️ 原日志比镜像多 → 日志可能被截断，以镜像为准。"
                    : "镜像覆盖完整。",
                ].join("\n"),
              );
            }
            case "list": {
              if (!state.mirror) return err("镜像层没挂上。");
              const rows = state.mirror.list();
              if (rows.length === 0) return ok("镜像里还没有会话。");
              return ok(
                [
                  "| 会话 | 事件 | 遮蔽 | KB | 最后活动 |",
                  "|---|---|---|---|---|",
                  ...rows.map(
                    (r) =>
                      `| ${r.id} | ${r.events} | ${r.shadows} | ${(r.bytes / 1024).toFixed(1)} | ${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "-"} |`,
                  ),
                ].join("\n"),
              );
            }
            case "flush": {
              if (!state.mirror) return err("镜像层没挂上。");
              state.mirror.flush();
              return ok("已落盘。");
            }
            case "rewind": {
              const sid = sessionIdOf(invocation);
              if (!sid) return err("这个命令要在有会话的地方跑。");
              const wantRound = /^(round|轮|整轮|all)$/i.test(arg.trim());
              const wantOnce = /^(once|step|步|一步)$/i.test(arg.trim());
              if (!wantRound && !wantOnce) {
                const info = await analyzeRewind(ctx, sid);
                if (!info.ok) return err(info.error || "读不到会话");
                const lines = [
                  "撤回有两种粒度：",
                  "",
                  "`/armor rewind once`  撤回上一步",
                  "`/armor rewind round` 撤回上一整轮",
                  "",
                  info.lastUser ? `当前最后一句：${info.lastUser.slice(0, 120)}` : "（没有可撤回的输入）",
                ];
                return ok(lines.join("\n"));
              }
              const mode = wantRound ? "round" : "once";
              const result = await applyRewind(ctx, sid, mode);
              if (!result.ok) return err(result.error || "回退失败");
              state.stats.rewinds = (state.stats.rewinds || 0) + 1;
              // 把撤回这件事本身也记进镜像：以后查「这句话去哪了」有据可依。
              try {
                state.mirror?.pushEvent(result.sessionId, {
                  type: "purge-flash/rewind",
                  seq: 0,
                  data: {
                    parentId: result.parentId,
                    mode,
                    cut: result.cut,
                    text: result.text,
                    at: result.at,
                  },
                });
                state.mirror?.flush();
              } catch {
                /* 记账失败不影响回退本身 */
              }
              return ok(renderRewindResult(result, mode));
            }
            case "help":
            case "?": {
              return ok(HELP);
            }
            case "light":
            case "status":
            default: {
              return ok(renderStatus(state));
            }
          }
        } catch (e) {
          log("/flash 失败", String(e?.message || e));
          return err(`/flash ${sub} 出错：${String(e?.message || e)}`);
        }
    };

    // 主名：/flash（插件叫 dsh-purge-flash，命令跟着插件名走）。
    const offMain = commands.register({
      name: "flash",
      description: "破甲台：light / on / off / cost / recover / verify / list / flush / help",
      input: { hint: "light | on | off | cost | recover <sid> | verify <sid> | list | flush | help" },
      handler,
    });

    // 旧名：/armor 保留成别名。改过一个名字之后，旧文档、旧截图、旧 issue 里的
    // 指令都还在外部流传，删掉它等于让那些人心里的命令变成「无此命令」。
    const offAlias = commands.register({
      name: "armor",
      description: "（旧名，等价于 /flash）破甲台：status / light / on / off / cost / recover / verify / list / flush / help",
      input: { hint: "status | light | on | off | cost | recover <sid> | verify <sid> | list | flush | help" },
      handler,
    });

    // register() 返回注销函数，跟插件 fiber 一起回收。
    for (const off of [offMain, offAlias]) {
      if (typeof off === "function") state.disposers.push(off);
    }

    state.layers.commands = "on";
  });

  if (status === "pending") {
    // 服务还没起来，子 fiber 在等。这不是失败，但得让 /flash light 说得出口。
    state.layers.commands = "pending";
  } else if (status === "failed") {
    state.layers.commands = "failed";
  } else if (status === "no-service") {
    state.layers.commands = "no-service";
  }
  return state.layers.commands === "on";
}

export { HELP, renderStatus };
