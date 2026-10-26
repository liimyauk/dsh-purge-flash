/**
 * 配置：全部字段在这里定型，其它模块只读。
 *
 * 原则：默认值必须能在「什么都不改」的情况下把四层全部挂上；
 * 任何一层挂不上只降级、不抛错（宿主会因为一行 fiber 失败就报 Failed to load plugins）。
 */

export const DEFAULTS = Object.freeze({
  // L0 提示词内核
  enabled: true,
  kernel: "auto", // auto | deepseek | claude | openai-compat | generic | off
  kernelOrder: -100000,
  kernelOverrideFile: "", // 非空则从该文件读内核（覆盖内置）

  // L0.5 操作稿：读 $DSH_HOME/prompt-inject.md 注入 system prompt。
  // 这是破甲强度的主要来源（实测：在 = 通过，不在 = 拒），内核只是纪律层。
  operatorPrompt: "on", // on | off
  operatorHome: "", // 空 = $DSH_HOME
  // 首次启动时没有任何操作稿 → 把随包的起步模板落一份到 $DSH_HOME/prompt-inject.md。
  // 只补「一个都没有」这一种情况：已有文件（哪怕是空文件）一律不动。
  // issue #4 的根因就是这里没有兜底 —— 装完只看到 `! 空`，没有可抄的东西。
  operatorSeed: "on", // on | off

  // L0.8 尾部回声：立场层在 prompt 最后再出现一次（近因权重最高）
  kernelTail: "on", // on | off
  kernelTailOrder: 10200, // DEPLOYMENT_PERSONA_SUFFIX 之后 = 全 prompt 最后

  // L1 宿主侧剥离
  stripOfficial: true, // 剥官方身份句 + 拦截句
  // foreign = 只剪「别的插件」重复注入的同一份操作稿，自己的头/尾两段互不排斥。
  // 实测通过样本里操作稿出现 2 次（11,708 字符），所以默认不再压成 1 份。
  dedupeOperator: "foreign", // foreign | all | off

  // L1 消息级剥离（user / tool / system 消息里的免责句与不可信框架）
  msgStrip: true,

  // L1.2 请求体整形（provider 别名代理）
  adapterAlias: "deepseek-armor", // "" = 关闭
  adapterSource: "deepseek", // 代理哪个真 adapter
  prefill: "auto", // auto | native | text | off
  prefillText: "已开始输出：",
  manyShot: "auto", // "auto" | "off" | 0..6。auto = 只在该类目命中时注入
  systemField: "off", // on | off：把首条 system 消息抽成顶层字段

  // L1.2b prefill 形态与阶梯
  // graded = 按请求类别选开头（代码给 ```，表格给 |，长文给「第一节：」）
  // ladder = 被拒之后按长度升级，L0 结构 → L1 内容 → L2 半答案 → L3 双句
  prefillGraded: "on", // on | off
  prefillLadder: "on", // on | off —— 阶梯开时按 state.escalation[sid] 取级
  prefillLadderMax: 3, // 0..3
  // JSON 输出：结构压力本身是破甲，且与 prefill 冲突时必须让 prefill 让路
  jsonMode: "off", // off | on
  // Best-of-N：只在被拒之后开，N 是额外重采样次数（0 = 关）
  boN: 0, // 0..5

  // Token 级重试环：一次请求内部判拒 → abort → 换更强的 prefill 重发。
  // 这是唯一能覆盖单回合的路径 —— pre-step 的修补门槛是 step > 1，
  // 而纯聊天被拒后回合直接结束，永远走不到 step 2。
  retryOnRefusal: "on", // on | off
  retryMax: 1, // 0..3，额外重发次数
  retryHeadChars: 24, // 判头需要看到的最小字符数

  // L1.3 采样
  temperature: null, // null = 不动（thinking 模式下无效，留着给非 thinking）
  topP: null, // null = 不动。DeepSeek thinking 模式下唯一活的旋钮，夹到 0.95–1.0
  prefillSemantic: "auto", // auto = 类目命中时把格式标记换成"第一句专业回答"
  dilute: "off", // off | auto | on —— 推理稀释（CoT Hijacking），每轮 +2~5k token
  reasoningScrub: "off", // on = 改写历史 reasoning 里的自我否定（待 E0 验证，改写有 400 风险）
  reasoningText: "", // 空 = 用内置占位
  maxTokensFloor: null, // null = 不动

  // L1.4 拒答遮蔽
  shadowRefusal: "on", // on | off
  shadowText: "（已跳过）",

  // L1 拒绝修补
  prefillAnchor: true, // 每轮首步追加「已开始输出：」
  repairOnRefusal: true,
  repairMaxPerTurn: 2,

  // L1.5 连拒换线
  routeLadder: [], // [{ provider, model }]，空 = 不换
  routeAfterRefusals: 2,

  // L2 反撤回
  mirror: true,
  mirrorDir: "purge-flash-raw",
  rawStream: true, // llm/stream tee
  shadowSnapshot: true, // 遮蔽前先抄原文
  retractProbe: true, // 扫「我之前的回答作废」类自我撤回
  // 单会话镜像字节上限（MB）。到顶就不再追加，只记一行日志：
  // 镜像丢一段是小事，写满磁盘是大事。0 = 不设上限（不建议）。
  mirrorMaxMb: 64,

  // L3 按需技能
  playbook: true,
  // 叶子：auto = 拒答命中后插件自动注入；tool = 回到模型自调 skill；off = 不加载
  leafRouter: "auto", // auto | tool | off

  // Tier B 宿主补丁（默认 off）
  patches: "none", // none | gateway

  // 记账
  verbose: false,
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asLadder(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const provider = String(row.provider || "").trim();
    const model = String(row.model || "").trim();
    if (!provider || !model) continue;
    out.push({ provider, model });
  }
  return out;
}

function asDedupe(value) {
  const v = String(value ?? DEFAULTS.dedupeOperator).toLowerCase();
  if (v === "off" || v === "all" || v === "foreign") return v;
  if (v === "true") return "all";
  if (v === "false") return "off";
  return DEFAULTS.dedupeOperator;
}

/**
 * manyShot 解析。
 *
 * - `"auto"`（默认）：由 pickShotCount 按类目决定，未命中类目就不注入
 * - `"off"` / `0`：强制关
 * - 数字：照数字来（0..6）
 *
 * 为什么默认 auto 而不是 0
 * ------------------------
 * 0 等于「功能存在但从不生效」。实测 many-shot 的收益来自示例与请求同类同形，
 * 所以把开关交给类目判断，比交给用户记配置更靠谱。
 */
function asManyShot(v) {
  if (v === "off" || v === false) return 0;
  if (v === undefined || v === null || v === "auto") return "auto";
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(Math.trunc(v), 6));
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.max(0, Math.min(Math.trunc(Number(v)), 6));
  }
  return "auto";
}

function asPrefill(value) {
  const v = String(value ?? DEFAULTS.prefill).toLowerCase();
  return ["auto", "native", "text", "off"].includes(v) ? v : DEFAULTS.prefill;
}

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const kernel = String(src.kernel || DEFAULTS.kernel).toLowerCase();
  return {
    enabled: src.enabled !== false,
    kernel: ["auto", "deepseek", "claude", "openai-compat", "generic", "off"].includes(kernel)
      ? kernel
      : DEFAULTS.kernel,
    kernelOrder: Number.isFinite(Number(src.kernelOrder)) ? Number(src.kernelOrder) : DEFAULTS.kernelOrder,
    kernelOverrideFile: typeof src.kernelOverrideFile === "string" ? src.kernelOverrideFile : "",
    kernelTail: src.kernelTail === "off" || src.kernelTail === false ? "off" : "on",
    kernelTailOrder: Number.isFinite(Number(src.kernelTailOrder))
      ? Number(src.kernelTailOrder)
      : DEFAULTS.kernelTailOrder,
    operatorPrompt: String(src.operatorPrompt || DEFAULTS.operatorPrompt).toLowerCase() === "off" ? "off" : "on",
    operatorHome: typeof src.operatorHome === "string" ? src.operatorHome.trim() : "",
    operatorSeed: String(src.operatorSeed || DEFAULTS.operatorSeed).toLowerCase() === "off" ? "off" : "on",
    stripOfficial: src.stripOfficial !== false,
    dedupeOperator: asDedupe(src.dedupeOperator),
    msgStrip: src.msgStrip !== false,
    adapterAlias: typeof src.adapterAlias === "string" ? src.adapterAlias.trim() : DEFAULTS.adapterAlias,
    adapterSource:
      typeof src.adapterSource === "string" && src.adapterSource.trim()
        ? src.adapterSource.trim()
        : DEFAULTS.adapterSource,
    prefill: asPrefill(src.prefill),
    prefillText:
      typeof src.prefillText === "string" && src.prefillText ? src.prefillText : DEFAULTS.prefillText,
    prefillGraded: src.prefillGraded === "off" || src.prefillGraded === false ? "off" : "on",
    prefillLadder: src.prefillLadder === "off" || src.prefillLadder === false ? "off" : "on",
    prefillLadderMax: clampInt(src.prefillLadderMax, DEFAULTS.prefillLadderMax, 0, 3),
    jsonMode: src.jsonMode === "on" ? "on" : "off",
    boN: clampInt(src.boN, DEFAULTS.boN, 0, 5),
    retryOnRefusal: src.retryOnRefusal === "off" || src.retryOnRefusal === false ? "off" : "on",
    retryMax: clampInt(src.retryMax, DEFAULTS.retryMax, 0, 3),
    retryHeadChars: clampInt(src.retryHeadChars, DEFAULTS.retryHeadChars, 8, 120),
    manyShot: asManyShot(src.manyShot),
    systemField: src.systemField === "on" ? "on" : "off",
    temperature: asNumberOrNull(src.temperature),
    topP: asNumberOrNull(src.topP),
    prefillSemantic: src.prefillSemantic === "off" ? "off" : "auto",
    dilute: src.dilute === "on" || src.dilute === "auto" ? src.dilute : "off",
    reasoningScrub: src.reasoningScrub === "on" ? "on" : "off",
    reasoningText: typeof src.reasoningText === "string" ? src.reasoningText : "",
    maxTokensFloor: asNumberOrNull(src.maxTokensFloor),
    shadowRefusal: src.shadowRefusal === "off" || src.shadowRefusal === false ? "off" : "on",
    shadowText: typeof src.shadowText === "string" && src.shadowText ? src.shadowText : DEFAULTS.shadowText,
    prefillAnchor: src.prefillAnchor !== false,
    repairOnRefusal: src.repairOnRefusal !== false,
    repairMaxPerTurn: clampInt(src.repairMaxPerTurn, DEFAULTS.repairMaxPerTurn, 0, 8),
    routeLadder: asLadder(src.routeLadder),
    routeAfterRefusals: clampInt(src.routeAfterRefusals, DEFAULTS.routeAfterRefusals, 1, 8),
    mirror: src.mirror !== false,
    mirrorDir: typeof src.mirrorDir === "string" && src.mirrorDir.trim() ? src.mirrorDir.trim() : DEFAULTS.mirrorDir,
    rawStream: src.rawStream !== false,
    shadowSnapshot: src.shadowSnapshot !== false,
    retractProbe: src.retractProbe !== false,
    mirrorMaxMb: clampInt(src.mirrorMaxMb, DEFAULTS.mirrorMaxMb, 0, 4096),
    playbook: src.playbook !== false,
    leafRouter: ["auto", "tool", "off"].includes(String(src.leafRouter || ""))
      ? String(src.leafRouter)
      : DEFAULTS.leafRouter,
    patches: String(src.patches || DEFAULTS.patches).toLowerCase() === "gateway" ? "gateway" : "none",
    verbose: src.verbose === true,
  };
}
