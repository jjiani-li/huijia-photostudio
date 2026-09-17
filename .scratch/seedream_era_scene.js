#!/usr/bin/env node
/**
 * 最小验证：年代 × 场景 匹配矩阵，能否让 Doubao-Seedream-5.0-lite 的出图
 * 更像「那个年代真实拍出来的照片」。
 *
 * 对应 PRD：docs/raw/AIGC_PRD.md §5（年代 × 场景 匹配矩阵）、§7.1（写实锚定词）。
 * 本脚本实现「文案层」：把年代质感包 + 场景空间包 + 写实锚定词拼装成 prompt。
 * 可选传入参考图（--image），由 Seedream 承担身份一致性；身份锚点文字可由
 * extract_face_features.js 生成后经 --anchor-file 注入。
 *
 * 用法：
 *   ARK_API_KEY=xxx node .scratch/seedream_era_scene.js --era E4 --scene S3 \
 *     --image "docs/老照片/a.jpg" --anchor-file .scratch/anchor.json
 *
 * 参数：
 *   --era     E1 | E2 | E3 | E4            年代（默认 E2）
 *   --scene   S1 | S2 | S3 | S4 | S5       场景（默认 S1）
 *   --subject "人物描述"                    身份锚点（无 --anchor-file 时使用）
 *   --anchor-file 路径                     读取 {"anchor":"..."} 或纯文本，作为身份锚点
 *   --image   参考图路径                    可重复；作为 Seedream 的参考图（承载身份一致性）
 *   --count n                              生成张数，默认 1
 *   --out     路径                         输出文件，默认 docs/output/era-scene-<era>-<scene>-<slug>.png
 *   --api-key xxx                          API Key（优先于环境变量 ARK_API_KEY）
 *   --dry-run                              只打印拼装好的 prompt，不调用接口
 */

const fs = require("fs");
const path = require("path");

const MODEL = "doubao-seedream-5-0-lite-260128";
const API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_SUBJECT =
  "中年男子，寸头，国字脸，鼻梁较宽，嘴唇偏厚，年龄约 40 岁";

// ── 年代质感层（PRD §5.2）──────────────────────────────────────────────
const ERAS = {
  E1: {
    label: "50-70年代",
    slug: "1950s-1970s",
    mono: true,
    size: "2048x2048",
    pack:
      "1950 至 1970 年代的黑白胶片照片，黑白影调，仅极轻微泛黄，全画面无彩色，" +
      "明显胶片颗粒与细小划痕、灰点，四角轻微暗角，" +
      "高光容易过曝、暗部压得很深、反差大，" +
      "中画幅或双反相机拍摄，固定焦段，人物居中端正",
  },
  E2: {
    label: "80-90年代",
    slug: "1980s-1990s",
    mono: false,
    size: "2048x2048",
    pack:
      "1980 至 1990 年代的彩色胶卷照片，135 胶片质感，" +
      "色彩偏青或偏暖红、浓郁但不艳丽，明显彩色颗粒与轻微色染，边缘轻微色散，" +
      "闪光灯直打时高光轻微溢出，傻瓜相机直出",
  },
  E3: {
    label: "00年代",
    slug: "2000s",
    mono: false,
    size: "2048x2048",
    pack:
      "2000 年代早期数码相机或早期手机拍摄的照片，" +
      "色调略灰、白平衡偏冷或偏绿，数码噪点明显，动态范围偏低，" +
      "闪光灯压脸、高光明显溢出，直出 JPEG 略带锐化过度",
  },
  E4: {
    label: "2010-2020年代",
    slug: "2010s-2020s",
    mono: false,
    size: "2048x2048",
    pack:
      "2010 至 2020 年代智能手机拍摄的日常照片，手机随手拍，" +
      "白平衡基本准确但不完美，色彩自然略显平淡，不做浓艳调色，" +
      "画面通透、细节清晰，天空高光有轻微溢出，暗部保留细节，" +
      "带有手机算法轻微的降噪与锐化痕迹，构图随意、有生活感",
  },
};

// ── 场景空间层（PRD §5.3）─────────────────────────────────────────────
const SCENES = {
  S1: {
    label: "老式照相馆",
    slug: "old-studio",
    pack:
      "老式照相馆室内，深色布景幕布与木质背景板，铁艺椅，旁边摆放假花与木质相框，" +
      "影棚顶灯加相机直闪、硬光，人物正面受光、背景略暗，" +
      "正面半身、居中、略显拘谨的摆拍构图",
  },
  S2: {
    label: "农村院子",
    slug: "rural-yard",
    pack:
      "农村院子，土墙、木门、柴垛、水缸，自然日光或阴天散射光，" +
      "平视视角，人物略偏画面一侧，石磨、竹筐、晾衣绳等物件",
  },
  S3: {
    label: "城市公园",
    slug: "city-park",
    pack:
      "城市公园，草坪与河道或湖面、成排树木、长椅、步道与铁栏杆，" +
      "自然日光或阴天散射光，远中近景层次清晰，人物与环境自然融合，" +
      "平视或略仰视的日常拍摄视角",
  },
  S4: {
    label: "家庭客厅",
    slug: "living-room",
    pack:
      "家庭客厅，沙发、五斗柜、电视柜、墙上挂历，室内钨丝灯或窗光，" +
      "生活抓拍视角，搪瓷杯、暖水瓶、老式电视等物件",
  },
  S5: {
    label: "工作单位门口",
    slug: "workplace-gate",
    pack:
      "工作单位门口，单位大门、标语墙、传达室，日光或逆光，" +
      "站姿合影构图，自行车、公文包、军绿挎包等物件",
  },
};

// ── 写实锚定词（PRD §7.1）──────────────────────────────────────────────
const REALISM_ANCHOR =
  "真实照片，随手拍的生活照，" +
  "自然皮肤纹理，可见毛孔与细纹，真实肤色不均，" +
  "柔和的对比度，构图自然不刻意";

function buildPrompt(era, scene, anchor) {
  const monoHint = era.mono ? "黑白照片，全画面无彩色，仅极轻微泛黄；" : "";
  return [
    `【身份锚点】严格保持参考图中人物的面部特征与身份一致，不同场景之间必须是同一个人：${anchor}`,
    `【年代】${era.pack}`,
    `【场景】${scene.pack}`,
    `【质感】${REALISM_ANCHOR}`,
    `【年代一致】画面中的服饰、发型、建筑、陈设与道具必须属于 ${era.label} 或更早；${monoHint}不出现该年代之后才有的物件`,
  ].join("\n");
}

function parseArgs(argv) {
  const out = { images: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "dry-run") out.dryRun = true;
    else if (key === "image") out.images.push(argv[++i]);
    else out[key] = argv[++i];
  }
  return out;
}

function resolveAnchor(args) {
  if (!args["anchor-file"]) return args.subject || DEFAULT_SUBJECT;
  const raw = fs.readFileSync(args["anchor-file"], "utf8").trim();
  try {
    const j = JSON.parse(raw);
    return j.anchor || args.subject || DEFAULT_SUBJECT;
  } catch {
    return raw || args.subject || DEFAULT_SUBJECT;
  }
}

function toDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const eraCode = (args.era || "E2").toUpperCase();
  const sceneCode = (args.scene || "S1").toUpperCase();
  const era = ERAS[eraCode];
  const scene = SCENES[sceneCode];
  if (!era) throw new Error(`未知年代 ${eraCode}，可选：${Object.keys(ERAS).join(" / ")}`);
  if (!scene) throw new Error(`未知场景 ${sceneCode}，可选：${Object.keys(SCENES).join(" / ")}`);

  const anchor = resolveAnchor(args);
  const count = Number(args.count || 1);
  const prompt = buildPrompt(era, scene, anchor);

  const outPath =
    args.out ||
    path.join(
      ROOT,
      "docs",
      "output",
      `era-scene-${eraCode}-${sceneCode}-${scene.slug}.png`,
    );

  console.log(`模型   : ${MODEL}`);
  console.log(`组合   : ${eraCode}(${era.label}) × ${sceneCode}(${scene.label})`);
  console.log(`参考图 : ${args.images.length ? args.images.join(", ") : "（无，纯文生图）"}`);
  console.log(`输出   : ${outPath}`);
  console.log(`张数   : ${count}`);
  console.log("─".repeat(60));
  console.log(prompt);
  console.log("─".repeat(60));

  if (args.dryRun) {
    console.log("[dry-run] 未调用接口。");
    return;
  }

  const apiKey = args["api-key"] || process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "缺少 API Key。请设置环境变量 ARK_API_KEY，或使用 --api-key <key>。",
    );
  }

  for (const p of args.images) {
    if (!fs.existsSync(p)) throw new Error(`参考图不存在：${p}`);
  }

  const body = {
    model: MODEL,
    prompt,
    size: era.size,
    output_format: "png",
    response_format: "url",
    watermark: false,
    optimize_prompt_options: { mode: "standard" },
  };
  if (args.images.length) {
    body.image = args.images.map(toDataUri);
  }
  if (count > 1) {
    body.sequential_image_generation = "auto";
    body.sequential_image_generation_options = { max_images: count };
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`请求失败 HTTP ${res.status}`);
    console.error(text.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const data = JSON.parse(text);
  const items = data.data || [];
  if (!items.length) {
    console.error("接口未返回图片：", JSON.stringify(data).slice(0, 500));
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const target =
      items.length === 1 ? outPath : outPath.replace(/\.png$/, `-${i + 1}.png`);

    let buf;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      const img = await fetch(item.url);
      if (!img.ok) {
        console.error(`下载失败 HTTP ${img.status}`);
        continue;
      }
      buf = Buffer.from(await img.arrayBuffer());
    } else {
      console.error(`第 ${i + 1} 张无 url / b64_json`);
      continue;
    }

    fs.writeFileSync(target, buf);
    console.log(`✓ 已保存 ${target}  (${buf.length} bytes)`);
  }

  console.log("usage:", JSON.stringify(data.usage || {}));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
