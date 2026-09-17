#!/usr/bin/env node
/**
 * 面部特征提取：用 Doubao-Seed-2.1-turbo 多模态读图，提取人物的「身份锚点」。
 *
 * 对应 PRD：docs/raw/AIGC_PRD.md §6.2（辅助模型用途）、§7.3（prompt 模板的【身份锚点】段）。
 * 输出的 anchor 文本会作为 seedream_era_scene.js 的 --anchor-file 输入。
 *
 * 用法：
 *   ARK_API_KEY=xxx node .scratch/extract_face_features.js \
 *     --photo docs/老照片/a.jpg --photo docs/老照片/b.jpg --out .scratch/anchor.json
 *
 * 参数：
 *   --photo   参考照片路径，可重复（同一人物的多张照片）
 *   --out     将结果 JSON 写入文件（同时打印到 stdout）
 *   --api-key API Key（优先于环境变量 ARK_API_KEY）
 */

const fs = require("fs");
const path = require("path");

const MODEL = "doubao-seed-2-1-turbo-260628";
const API_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

const SYSTEM_PROMPT = `你是专业的人像特征提取助手，服务于「老照片人物重现」图像生成流程。
请仔细观察参考照片中的人物，提取可用于图像生成模型的身份锚点描述。

要求：
1. 只描述客观可见的外貌特征，不做性格、身份或职业推测；
2. 必须覆盖：性别与年龄段、发型与发色、脸型、额头、眉毛、眼睛（形状/单双眼皮/眼袋）、鼻子、嘴唇与牙齿、面部皱纹与老年斑、痣或疤痕等显著特征、体型；
3. 年龄给出估计区间（如 70-80 岁）；
4. 语言简练、具体、可视化，供生图模型直接使用，避免"慈祥""有气质"这类不可视化的词；
5. 若提供了多张同一人物的照片，请综合描述同一个人。

只输出严格的 JSON，不要输出任何解释文字或 Markdown 代码块：
{"anchor":"一句话身份锚点，60-120字，可直接放进生图 prompt","features":{"gender":"","age_range":"","hair":"","face_shape":"","forehead":"","eyebrows":"","eyes":"","nose":"","mouth":"","skin":"","distinctive":"","build":""}}`;

function parseArgs(argv) {
  const out = { photos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "photo") out.photos.push(argv[++i]);
    else out[key] = argv[++i];
  }
  return out;
}

function toDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = fs.readFileSync(file).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.photos.length) {
    throw new Error("请用 --photo <路径> 指定至少一张参考照片");
  }

  const apiKey = args["api-key"] || process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 API Key。请设置环境变量 ARK_API_KEY，或使用 --api-key <key>。");
  }

  for (const p of args.photos) {
    if (!fs.existsSync(p)) throw new Error(`照片不存在：${p}`);
  }

  const content = [{ type: "text", text: "请提取照片中人物的身份锚点特征。" }];
  for (const p of args.photos) {
    content.push({ type: "image_url", image_url: { url: toDataUri(p) } });
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      max_tokens: 1200,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`请求失败 HTTP ${res.status}`);
    console.error(text.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const data = JSON.parse(text);
  const msg = data.choices?.[0]?.message || {};
  const raw = (msg.content || "").trim();

  if (!raw) {
    console.error("模型未返回内容：", JSON.stringify(msg).slice(0, 600));
    process.exitCode = 1;
    return;
  }

  // 容错：剥掉可能存在的 ```json 包裹
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("模型返回的不是合法 JSON，原文如下：");
    console.error(raw);
    process.exitCode = 1;
    return;
  }

  parsed.source_photos = args.photos;
  parsed.model = MODEL;

  const out = JSON.stringify(parsed, null, 2);
  console.log(out);

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, out);
    console.error(`\n已写入 ${args.out}`);
  }

  console.error("\nusage:", JSON.stringify(data.usage || {}));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
