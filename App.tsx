import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Leaf,
  Search,
  Plus,
  X,
  Camera,
  Trash2,
  ChevronLeft,
  Check,
  Settings,
  Image as ImageIcon,
  Sparkles,
  Loader2,
  ExternalLink,
  HelpCircle,
  Home,
  Stethoscope,
  ClipboardList,
} from "lucide-react";

/* ---------------------------------------------------------
   Experience OS — Phase1 prototype
   「経験を未来へ託す」ための個人用観察記録アプリ
--------------------------------------------------------- */

// 保存方式：記録(entries)は写真を含み大きくなりやすいため、
// 「全部を1つのキーにまとめて保存」ではなく「記録1件ごとに個別キーで保存」する。
// こうすることで、1キーあたりのサイズ上限に達して保存が丸ごと失敗する事態を防ぐ。
const META_KEY = "eo-meta-v3"; // { plants }
const ENTRY_PREFIX = "eo-entry-v3:"; // 1件ごとの記録

function extractMeta(d) {
  return { plants: d.plants };
}

async function saveMetaToStorage(meta) {
  await window.storage.set(META_KEY, JSON.stringify(meta), false);
}

async function saveEntryToStorage(entry) {
  await window.storage.set(ENTRY_PREFIX + entry.id, JSON.stringify(entry), false);
}

async function deleteEntryFromStorage(id) {
  try {
    await window.storage.delete(ENTRY_PREFIX + id, false);
  } catch (e) {
    // 既に無い場合は無視してよい
  }
}

async function clearAllFromStorage(ids) {
  await Promise.all(ids.map((id) => deleteEntryFromStorage(id)));
  await window.storage.set(META_KEY, JSON.stringify(extractMeta(emptyData())), false);
}

async function loadAllFromStorage() {
  let meta;
  try {
    const res = await window.storage.get(META_KEY, false);
    meta = res ? JSON.parse(res.value) : null;
  } catch (e) {
    meta = null;
  }
  if (!meta) meta = extractMeta(emptyData());

  let entries = [];
  try {
    const listRes = await window.storage.list(ENTRY_PREFIX, false);
    const keys = listRes?.keys || [];
    const fetched = await Promise.all(
      keys.map(async (k) => {
        try {
          const r = await window.storage.get(k, false);
          return r ? JSON.parse(r.value) : null;
        } catch (e) {
          return null;
        }
      })
    );
    entries = fetched.filter(Boolean);
  } catch (e) {
    entries = [];
  }

  return { ...meta, entries };
}

const emptyData = () => ({
  plants: [], // { id, name }
  entries: [], // { id, number, plantId, date, symptomText, causes:[], actionText, resultText, memo, photo, createdAt, updatedAt }
});

// AI診断（写真＋API）のために渡す「過去の記録」の要約（軽量化のため件数と文字数を絞る）
function buildPastContext(data, excludeId) {
  return data.entries
    .filter((e) => e.id !== excludeId)
    .slice(-40)
    .map((e) => ({
      number: e.number,
      plant: data.plants.find((p) => p.id === e.plantId)?.name || "",
      date: e.date,
      symptomText: (e.symptomText || "").slice(0, 100),
      causes: e.causes || [],
      actionText: (e.actionText || "").slice(0, 100),
      resultText: (e.resultText || "").slice(0, 100),
      memo: (e.memo || "").slice(0, 100),
    }));
}

// タグを使わず、自由記載から関連記録・原因候補を見つけるための軽量キーワード抽出
// 英数字は単語単位、日本語などの連続文字はbigram（2文字ずつ）で拾い、共有度合いで関連を判定する
const STOPWORDS = new Set([
  "した", "して", "する", "です", "ます", "こと", "もの", "ない", "あり", "いる",
  "なる", "ため", "よう", "これ", "それ", "あの", "この", "など", "とき", "から",
]);

function extractKeywords(text) {
  if (!text) return [];
  const cleaned = String(text).replace(/[\n\r]/g, " ");
  const tokens = cleaned
    .split(/[\s、。,.!?！？・:：;；「」『』()（）\[\]"'"'\/]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const words = new Set();
  tokens.forEach((tok) => {
    if (/^[a-zA-Z0-9]+$/.test(tok)) {
      if (tok.length >= 2) words.add(tok.toLowerCase());
      return;
    }
    if (tok.length <= 4 && !STOPWORDS.has(tok)) words.add(tok);
    for (let i = 0; i < tok.length - 1; i++) {
      const gram = tok.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) words.add(gram);
    }
  });
  return Array.from(words);
}

function entryFreeText(e) {
  return [e.symptomText, e.actionText, e.resultText, e.memo].filter(Boolean).join(" ");
}

// 現在入力中の自由記載と、既存の記録との関連度を「共有キーワード数」で採点する
function scoreAgainst(currentWords, otherText) {
  const otherWords = extractKeywords(otherText);
  let score = 0;
  otherWords.forEach((w) => {
    if (currentWords.has(w) && w.length >= 2) score += w.length >= 3 ? 2 : 1;
  });
  return score;
}

function findRelatedEntries(freeText, entries, excludeId, limit = 5) {
  const currentWords = new Set(extractKeywords(freeText));
  if (currentWords.size === 0) return [];
  return entries
    .filter((e) => e.id !== excludeId)
    .map((e) => ({ entry: e, score: scoreAgainst(currentWords, entryFreeText(e)) }))
    .filter((r) => r.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// 自由記載の近さから「原因」の候補を自動で最大3つ提案する（APIなし・常に動く）
function suggestCauses(freeText, entries, excludeId, limit = 3) {
  const currentWords = new Set(extractKeywords(freeText));
  if (currentWords.size === 0) return [];
  const scoreMap = new Map();
  entries.forEach((e) => {
    if (e.id === excludeId) return;
    if (!e.causes || e.causes.length === 0) return;
    const s = scoreAgainst(currentWords, entryFreeText(e));
    if (s <= 0) return;
    e.causes.forEach((c) => {
      scoreMap.set(c, (scoreMap.get(c) || 0) + s);
    });
  });
  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label]) => label);
}

// ---- 画像の見た目の近さを比べる（APIなし・常に動く） ----
// difference hash (dHash): 画像を9x8に縮小し、隣り合う画素の明暗を64bitの指紋にする。
// 同じような構図・色味の写真ほど一致率が高くなる、軽量な視覚的類似度の目安。
function computeImageHash(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = 9;
        const h = 8;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const gray = [];
        for (let i = 0; i < data.length; i += 4) {
          gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }
        let hash = "";
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w - 1; x++) {
            const left = gray[y * w + x];
            const right = gray[y * w + x + 1];
            hash += left > right ? "1" : "0";
          }
        }
        resolve(hash);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    img.src = dataUrl;
  });
}

function hammingSimilarity(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return 0;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) if (hashA[i] !== hashB[i]) diff++;
  return Math.round(((hashA.length - diff) / hashA.length) * 100);
}

// ---- 結果の文章から「うまくいったか」を簡易判定する（APIなし） ----
const POSITIVE_WORDS = ["回復", "改善", "治った", "良くなった", "元気になった", "効果があった", "うまくいった", "再生した", "戻った"];
const NEGATIVE_WORDS = ["悪化", "枯れた", "失敗", "効果がなかった", "変わらなかった", "死んだ", "だめだった", "ダメだった", "逆効果", "広がった"];

function classifySentiment(text) {
  if (!text) return "neutral";
  const hasPositive = POSITIVE_WORDS.some((w) => text.includes(w));
  const hasNegative = NEGATIVE_WORDS.some((w) => text.includes(w));
  if (hasPositive && !hasNegative) return "positive";
  if (hasNegative && !hasPositive) return "negative";
  return "neutral";
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function formatDateJP(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

function compressImage(file, maxW = 640, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------
   小さな部品
--------------------------------------------------------- */

function ChipPicker({ label, hint, options, selected, onToggle, onAddOption, placeholder }) {
  const [draft, setDraft] = useState("");

  const submitDraft = () => {
    const v = draft.trim();
    if (!v) return;
    onAddOption(v);
    setDraft("");
  };

  return (
    <div>
      {label && <div className="eo-field-label">{label}</div>}
      {hint && <div className="eo-related-hint">{hint}</div>}
      <div className="eo-chip-row">
        {options.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              type="button"
              key={opt}
              onClick={() => onToggle(opt)}
              className={`eo-chip ${active ? "eo-chip-active" : ""}`}
            >
              {active && <Check size={12} style={{ marginRight: 4 }} />}
              {opt}
            </button>
          );
        })}
        <div className="eo-chip-add">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitDraft();
              }
            }}
            placeholder={placeholder || "自由入力"}
          />
          <button type="button" onClick={submitDraft} aria-label="追加">
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function PlantPicker({ plants, value, onChange }) {
  const [focused, setFocused] = useState(false);
  const matches =
    value.trim().length === 0
      ? plants
      : plants.filter((p) => p.name.toLowerCase().includes(value.trim().toLowerCase()));
  const exactMatch = plants.some((p) => p.name.toLowerCase() === value.trim().toLowerCase());

  return (
    <div style={{ position: "relative" }}>
      <div className="eo-field-label">植物名</div>
      <input
        className="eo-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder="選ぶ、または新しく入力"
      />
      {focused && (matches.length > 0 || value.trim().length > 0) && (
        <div className="eo-suggest">
          {matches.map((p) => (
            <div key={p.id} className="eo-suggest-item" onMouseDown={() => onChange(p.name)}>
              <Leaf size={13} style={{ marginRight: 6, opacity: 0.6 }} />
              {p.name}
            </div>
          ))}
          {value.trim().length > 0 && !exactMatch && (
            <div className="eo-suggest-item eo-suggest-new" onMouseDown={() => onChange(value.trim())}>
              <Plus size={13} style={{ marginRight: 6 }} />
              「{value.trim()}」を新しく登録
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------
   標本カード（1件の記録）
--------------------------------------------------------- */

function SpecimenCard({ entry, plantName, onOpen }) {
  const rotate = (parseInt(entry.id.slice(-2), 36) % 5) - 2; // -2〜2度の微妙な傾き
  return (
    <button type="button" onClick={() => onOpen(entry.id)} className="eo-card" style={{ transform: `rotate(${rotate}deg)` }}>
      <div className="eo-card-tape" />
      <div className="eo-card-number">No.{String(entry.number).padStart(3, "0")}</div>
      <div className="eo-card-photo">
        {entry.photo ? <img src={entry.photo} alt="" /> : (
          <div className="eo-card-photo-empty">
            <ImageIcon size={22} strokeWidth={1.4} />
          </div>
        )}
      </div>
      <div className="eo-card-body">
        <div className="eo-card-date">{formatDateJP(entry.date)}</div>
        <div className="eo-card-plant">{plantName}</div>
        {entry.causes?.length > 0 && (
          <div className="eo-card-tags">
            {entry.causes.slice(0, 2).map((c) => (
              <span key={"c-" + c} className="eo-tag-mini eo-tag-mini-cause">
                {c}
              </span>
            ))}
          </div>
        )}
        {entry.symptomText && <div className="eo-card-memo">{entry.symptomText}</div>}
      </div>
    </button>
  );
}

/* ---------------------------------------------------------
   記録フォーム（新規・編集共通）
--------------------------------------------------------- */

function EntryForm({ data, entry, defaultPlantName, onSave, onCancel, onDelete }) {
  const isEdit = !!entry;
  const [date] = useState(entry?.date || todayISO());
  const [plantName, setPlantName] = useState(
    entry ? data.plants.find((p) => p.id === entry.plantId)?.name || "" : defaultPlantName || ""
  );
  const [symptomText, setSymptomText] = useState(entry?.symptomText || "");
  const [causes, setCauses] = useState(entry?.causes || []);
  const [actionText, setActionText] = useState(entry?.actionText || "");
  const [resultText, setResultText] = useState(entry?.resultText || "");
  const [memo, setMemo] = useState(entry?.memo || "");
  const [photo, setPhoto] = useState(entry?.photo || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState("");
  const [diagResult, setDiagResult] = useState(null);

  const currentFreeText = [symptomText, actionText, resultText, memo].filter(Boolean).join(" ");

  const suggestedCauses = useMemo(
    () => suggestCauses(currentFreeText, data.entries, entry?.id),
    [currentFreeText, data.entries, entry]
  );
  const causeChipOptions = useMemo(
    () => Array.from(new Set([...suggestedCauses, ...causes])),
    [suggestedCauses, causes]
  );

  const relatedEntries = useMemo(
    () => findRelatedEntries(currentFreeText, data.entries, entry?.id),
    [currentFreeText, data.entries, entry]
  );

  const runDiagnosis = async () => {
    if (!photo) return;
    setDiagLoading(true);
    setDiagError("");
    setDiagResult(null);
    try {
      const base64 = photo.split(",")[1];
      const pastContext = buildPastContext(data, entry?.id);
      const promptText = `あなたは家庭園芸・植物ケアの経験豊富なアドバイザーです。添付した写真を見て、考えられる原因を診断してください。

【今回の情報】
植物名: ${plantName || "未入力"}
症状（自由記載）: ${symptomText || "なし"}

【この人の過去の記録（参考データ・JSON、numberは記録の通し番号）】
${JSON.stringify(pastContext)}

【指示】
- まず過去の記録に似た事例がないか確認してください。似た事例があれば積極的に参考にしてください。
- 加えて、一般的な病害虫・生育不良の知識や、必要に応じてWeb検索も使って判断してください。
- 原因は断定せず、可能性がある候補を最大3つ挙げ、それぞれに信頼度（0〜100の整数%）をつけてください。信頼度の合計が100になる必要はありません。
- 写真や情報だけでは判断が難しい場合は diagnosable を false にし、causes は空配列にしてください。無理に断定しないでください。
- reasoningやnoteは出典の文章をそのまま使わず、必ず自分の言葉で1文（40文字程度まで）に要約してください。
- checkpoints・recommendedActions・sourcesは、それぞれ最大3件までにしてください。
- 出力が長くなりすぎないよう、簡潔さを優先してください。
- 次のJSON形式のみを出力してください。説明文やコードブロック記法（\`\`\`）は一切不要です。

{
  "diagnosable": true,
  "causes": [{"label": "原因名", "confidence": 70, "reasoning": "短い根拠"}],
  "checkpoints": ["次に確認すべきこと"],
  "similarEntryNumbers": [12, 5],
  "recommendedActions": ["おすすめの対策"],
  "sources": [{"title": "情報源名", "url": "https://example.com", "note": "短い説明"}]
}`;

      const response = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
                { type: "text", text: promptText },
              ],
            },
          ],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      });

      const json = await response.json();

      if (!response.ok) {
        const apiMsg = json?.error?.message;
        throw new Error(apiMsg ? `API エラー: ${apiMsg}` : `API エラー（status ${response.status}）`);
      }

      const text = (json.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!text) {
        throw new Error("AIから応答が得られませんでした（応答が空でした）。");
      }

      let clean = text.replace(/```json|```/g, "").trim();
      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start === -1 || end === -1 || end <= start) {
          throw new Error("AIの応答を解析できませんでした（形式が想定と異なります）。");
        }
        parsed = JSON.parse(clean.slice(start, end + 1));
      }

      if (typeof parsed !== "object" || parsed === null || !("causes" in parsed) || !("diagnosable" in parsed)) {
        throw new Error("AIの応答の形式が想定と異なりました。");
      }

      setDiagResult(parsed);
    } catch (err) {
      setDiagError(err?.message ? `診断に失敗しました：${err.message}` : "診断に失敗しました。通信状況を確認してもう一度お試しください。");
    } finally {
      setDiagLoading(false);
    }
  };

  const addCauseFromDiag = (label) => {
    setCauses((c) => (c.includes(label) ? c : [...c, label]));
  };

  const similarEntries = (diagResult?.similarEntryNumbers || [])
    .map((n) => data.entries.find((e) => e.number === n))
    .filter(Boolean);

  const toggle = (arr, setArr, val) => setArr(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setBusy(true);
      const dataUrl = await compressImage(file);
      setPhoto(dataUrl);
    } catch (err) {
      setError("写真の処理に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  const canSave = plantName.trim().length > 0;

  const handleSave = () => {
    if (!canSave) {
      setError("植物名は必須です。");
      return;
    }
    onSave({
      date,
      plantName: plantName.trim(),
      symptomText,
      causes,
      actionText,
      resultText,
      memo,
      photo,
    });
  };

  return (
    <div className="eo-form">
      <div className="eo-field">
        <div className="eo-field-label">写真</div>
        {photo ? (
          <div className="eo-photo-preview">
            <img src={photo} alt="" />
            <button
              type="button"
              className="eo-photo-remove"
              onClick={() => {
                setPhoto(null);
                setDiagResult(null);
                setDiagError("");
              }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button type="button" className="eo-photo-add" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Camera size={20} strokeWidth={1.5} />
            <span>{busy ? "処理中…" : "写真を選ぶ・撮る"}</span>
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handlePhoto} />

        {photo && (
          <button type="button" className="eo-diag-btn" onClick={runDiagnosis} disabled={diagLoading}>
            {diagLoading ? <Loader2 size={15} className="eo-spin" /> : <Sparkles size={15} />}
            {diagLoading ? "診断中…" : "AIで診断する（写真＋ネット検索）"}
          </button>
        )}

        {diagError && <div className="eo-error">{diagError}</div>}

        {diagResult && (
          <div className="eo-diag-panel">
            <div className="eo-diag-section-label">① 考えられる原因</div>
            {diagResult.diagnosable === false || (diagResult.causes || []).length === 0 ? (
              <div className="eo-diag-unknown">
                <HelpCircle size={15} style={{ marginRight: 6, flexShrink: 0 }} />
                写真と記録だけでは、はっきりした原因は分かりませんでした。分かり次第、下の「原因」欄に自分で追加してください。
              </div>
            ) : (
              <div className="eo-diag-causes">
                {diagResult.causes.map((c, i) => (
                  <div className="eo-diag-cause" key={i}>
                    <div className="eo-diag-cause-top">
                      <span className="eo-diag-cause-label">{c.label}</span>
                      <span className="eo-diag-confidence">{c.confidence}%の可能性</span>
                    </div>
                    <div className="eo-diag-bar">
                      <div className="eo-diag-bar-fill" style={{ width: `${Math.max(4, Math.min(100, c.confidence))}%` }} />
                    </div>
                    {c.reasoning && <div className="eo-diag-reasoning">{c.reasoning}</div>}
                    <button type="button" className="eo-diag-add-btn" onClick={() => addCauseFromDiag(c.label)}>
                      {causes.includes(c.label) ? <Check size={12} /> : <Plus size={12} />}
                      原因として追加
                    </button>
                  </div>
                ))}
              </div>
            )}

            {(diagResult.checkpoints || []).length > 0 && (
              <>
                <div className="eo-diag-section-label">次に確認すべきポイント</div>
                <ul className="eo-diag-list">
                  {diagResult.checkpoints.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}

            {similarEntries.length > 0 && (
              <>
                <div className="eo-diag-section-label">過去の類似事例</div>
                <div className="eo-diag-similar-list">
                  {similarEntries.map((e) => (
                    <div className="eo-diag-similar-item" key={e.id}>
                      <span className="eo-diag-similar-num">No.{String(e.number).padStart(3, "0")}</span>
                      <span className="eo-diag-similar-plant">{data.plants.find((p) => p.id === e.plantId)?.name}</span>
                      <span className="eo-diag-similar-date">{formatDateJP(e.date)}</span>
                      {e.resultText && <span className="eo-diag-similar-result">結果: {e.resultText}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {(diagResult.sources || []).length > 0 && (
              <>
                <div className="eo-diag-section-label">参考にした情報源</div>
                <ul className="eo-diag-sources">
                  {diagResult.sources.map((s, i) => (
                    <li key={i}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title} <ExternalLink size={11} />
                      </a>
                      {s.note && <div className="eo-diag-source-note">{s.note}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {(diagResult.recommendedActions || []).length > 0 && (
              <>
                <div className="eo-diag-section-label">おすすめの対策</div>
                <div className="eo-diag-actions-list">
                  {diagResult.recommendedActions.map((a, i) => (
                    <span className="eo-tag-mini" key={i}>
                      {a}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="eo-field">
        <PlantPicker plants={data.plants} value={plantName} onChange={setPlantName} />
      </div>

      <div className="eo-field">
        <div className="eo-field-label">症状</div>
        <textarea
          className="eo-textarea"
          rows={3}
          value={symptomText}
          onChange={(e) => setSymptomText(e.target.value)}
          placeholder="症状を自由に書いてください（例：下の葉から黄色くなってきた）"
        />
      </div>

      <div className="eo-field">
        <ChipPicker
          label="原因（自動候補）"
          hint={suggestedCauses.length === 0 ? "似た記録がまだ見つからないため、自動候補はありません。自分で入力できます。" : "書いた内容が近い過去の記録から自動で提案しています。"}
          options={causeChipOptions}
          selected={causes}
          onToggle={(v) => toggle(causes, setCauses, v)}
          onAddOption={(v) => setCauses((c) => (c.includes(v) ? c : [...c, v]))}
          placeholder="他の原因を自由入力"
        />
      </div>

      <div className="eo-field">
        <div className="eo-field-label">試したこと</div>
        <textarea
          className="eo-textarea"
          rows={3}
          value={actionText}
          onChange={(e) => setActionText(e.target.value)}
          placeholder="試した対策を自由に書いてください（例：水やりを減らした）"
        />
      </div>

      <div className="eo-field">
        <div className="eo-field-label">結果</div>
        <textarea
          className="eo-textarea"
          rows={3}
          value={resultText}
          onChange={(e) => setResultText(e.target.value)}
          placeholder="結果を自由に書いてください（例：3日ほどで葉に元気が戻った）"
        />
      </div>

      <div className="eo-field">
        <div className="eo-field-label">メモ</div>
        <textarea className="eo-textarea" rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="自由に記録しておきたいこと" />
      </div>

      {relatedEntries.length > 0 && (
        <div className="eo-field">
          <div className="eo-field-label">関連する記録</div>
          <div className="eo-related-hint">書いた内容と近い言葉を含む、過去の記録です。</div>
          <div className="eo-diag-similar-list">
            {relatedEntries.map(({ entry: e }) => (
              <div className="eo-diag-similar-item" key={e.id}>
                <span className="eo-diag-similar-num">No.{String(e.number).padStart(3, "0")}</span>
                <span className="eo-diag-similar-plant">{data.plants.find((p) => p.id === e.plantId)?.name}</span>
                <span className="eo-diag-similar-date">{formatDateJP(e.date)}</span>
                {e.resultText && <span className="eo-diag-similar-result">結果: {e.resultText}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div className="eo-error">{error}</div>}

      <div className="eo-form-actions">
        <button type="button" className="eo-btn eo-btn-ghost" onClick={onCancel}>
          キャンセル
        </button>
        {isEdit && (
          <button type="button" className="eo-btn eo-btn-danger" onClick={() => onDelete(entry.id)}>
            <Trash2 size={14} style={{ marginRight: 4 }} />
            削除
          </button>
        )}
        <button type="button" className="eo-btn eo-btn-primary" onClick={handleSave} disabled={!canSave}>
          {isEdit ? "更新する" : "記録する"}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   診断タブ（画像の見た目の近さだけで探す・APIなし）
--------------------------------------------------------- */

function DiagnoseScreen({ data }) {
  const [photo, setPhoto] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [matches, setMatches] = useState(null); // null = 未実行
  const fileRef = useRef(null);
  const MAX_RESULTS = 3;

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setMatches(null);
    setLoading(true);
    try {
      const dataUrl = await compressImage(file);
      setPhoto(dataUrl);
      const targetHash = await computeImageHash(dataUrl);
      const withPhotos = data.entries.filter((en) => en.photo);
      const scored = [];
      for (const en of withPhotos) {
        try {
          const h = await computeImageHash(en.photo);
          const score = hammingSimilarity(targetHash, h);
          scored.push({ entry: en, score });
        } catch (err) {
          // 個別の画像解析に失敗しても全体は続行する
        }
      }
      scored.sort((a, b) => b.score - a.score);
      setMatches(scored.slice(0, MAX_RESULTS));
    } catch (err) {
      setError("画像の解析に失敗しました。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  };

  const aggregate = useMemo(() => {
    if (!matches || matches.length === 0) return null;
    // 原因ごとに「この原因が記録されていた過去の記録の中で、最も一致度が高かったもの」を信頼度として使う
    const causeBest = new Map(); // label -> { score, entry }
    const actionsAll = new Set();
    const goodActions = new Set();
    const badActions = new Set();
    matches.forEach(({ entry: e, score }) => {
      (e.causes || []).forEach((c) => {
        const current = causeBest.get(c);
        if (!current || score > current.score) causeBest.set(c, { score, entry: e });
      });
      // 対策のおすすめは、一致度80%以上の記録だけを根拠にする（低い一致度の記録から
      // 「これからやればいいこと／してはいけないこと」を断定するのは誤解を招くため）
      if (score >= 80 && e.actionText) {
        actionsAll.add(e.actionText);
        const sentiment = classifySentiment(e.resultText);
        if (sentiment === "positive") goodActions.add(e.actionText);
        if (sentiment === "negative") badActions.add(e.actionText);
      }
    });
    const causes = Array.from(causeBest.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3)
      .map(([label, { score, entry: e }]) => ({
        label,
        confidence: score,
        reasoning: `No.${String(e.number).padStart(3, "0")}の記録（一致度${score}%）で記録されていた原因です。`,
      }));
    return {
      causes,
      actions: Array.from(actionsAll),
      goodActions: Array.from(goodActions),
      badActions: Array.from(badActions),
    };
  }, [matches]);

  return (
    <div className="eo-diagnose">
      <div className="eo-diagnose-intro">
        写真を1枚選ぶと、これまでの記録の中から見た目が近い写真を、一致度が高い順に最大{MAX_RESULTS}件表示します。
        一致度が低い場合もそのまま表示されるので、参考程度にご覧ください。APIやネット接続は使いません。
      </div>

      {photo ? (
        <div className="eo-photo-preview" style={{ width: "100%" }}>
          <img src={photo} alt="" style={{ width: "100%", borderRadius: 12 }} />
          <button
            type="button"
            className="eo-photo-remove"
            onClick={() => {
              setPhoto(null);
              setMatches(null);
              setError("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button type="button" className="eo-photo-add" onClick={() => fileRef.current?.click()} disabled={loading}>
          <Camera size={20} strokeWidth={1.5} />
          <span>写真を選ぶ</span>
        </button>
      )}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handlePhoto} />

      {loading && (
        <div className="eo-diagnose-loading">
          <Loader2 size={16} className="eo-spin" />
          写真を比較しています…
        </div>
      )}

      {error && <div className="eo-error">{error}</div>}

      {!loading && matches !== null && (
        matches.length === 0 ? (
          <div className="eo-diag-unknown">
            <HelpCircle size={15} style={{ marginRight: 6, flexShrink: 0 }} />
            情報がありません
          </div>
        ) : (
          <div className="eo-diag-panel">
            <div className="eo-diag-section-label">一致した過去の記録</div>
            <div className="eo-diag-similar-list">
              {matches.map(({ entry: e, score }) => (
                <div className="eo-diag-similar-item" key={e.id}>
                  <span className="eo-diag-match-badge">{score}%一致</span>
                  <span className="eo-diag-similar-num">No.{String(e.number).padStart(3, "0")}</span>
                  <span className="eo-diag-similar-plant">{data.plants.find((p) => p.id === e.plantId)?.name}</span>
                  <span className="eo-diag-similar-date">{formatDateJP(e.date)}</span>
                </div>
              ))}
            </div>

            <div className="eo-diag-section-label">① 考えられる原因</div>
            {aggregate.causes.length > 0 ? (
              <div className="eo-diag-causes">
                {aggregate.causes.map((c) => (
                  <div className="eo-diag-cause" key={c.label}>
                    <div className="eo-diag-cause-top">
                      <span className="eo-diag-cause-label">{c.label}</span>
                      <span className="eo-diag-confidence">{c.confidence}%の可能性</span>
                    </div>
                    <div className="eo-diag-bar">
                      <div className="eo-diag-bar-fill" style={{ width: `${Math.max(4, Math.min(100, c.confidence))}%` }} />
                    </div>
                    <div className="eo-diag-reasoning">{c.reasoning}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="eo-diag-unknown">
                <HelpCircle size={15} style={{ marginRight: 6, flexShrink: 0 }} />
                原因が記録されている過去の記録がないため、分かりません。
              </div>
            )}

            {aggregate.actions.length > 0 ? (
              <>
                <div className="eo-diag-section-label">これまで試した対策</div>
                <ul className="eo-diag-list">
                  {aggregate.actions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <div className="eo-diag-section-label">これまで試した対策</div>
                <div className="eo-diag-unknown">
                  <HelpCircle size={15} style={{ marginRight: 6, flexShrink: 0 }} />
                  一致度80%以上の記録がないため、分かりません。
                </div>
              </>
            )}

            {aggregate.goodActions.length > 0 && (
              <>
                <div className="eo-diag-section-label">これからやればいいこと</div>
                <ul className="eo-diag-list">
                  {aggregate.goodActions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            )}

            {aggregate.badActions.length > 0 && (
              <>
                <div className="eo-diag-section-label">してはいけないこと</div>
                <ul className="eo-diag-list">
                  {aggregate.badActions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}

/* ---------------------------------------------------------
   メインアプリ
--------------------------------------------------------- */

const TABS = [
  { key: "home", label: "ホーム", icon: Home },
  { key: "diagnose", label: "診断", icon: Stethoscope },
  { key: "new", label: "追加", icon: Plus },
  { key: "records", label: "記録", icon: ClipboardList },
];

export default function ExperienceOS() {
  const [data, setData] = useState(null);
  const [view, setView] = useState({ name: "home" }); // home | plant | new | edit | diagnose | records | settings
  const [query, setQuery] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setData(await loadAllFromStorage());
      } catch (e) {
        setData(emptyData());
      }
    })();
  }, []);

  const showSaveError = () => {
    setSaveNotice("保存に失敗しました。もう一度お試しください。");
    setTimeout(() => setSaveNotice(""), 3000);
  };

  if (!data) {
    return (
      <div className="eo-root eo-loading">
        <StyleSheet />
        <Leaf className="eo-spin" size={28} />
        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.6 }}>読み込み中…</div>
      </div>
    );
  }

  const findOrCreatePlant = (draft, name) => {
    const existing = draft.plants.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) return { plants: draft.plants, id: existing.id };
    const newPlant = { id: uid(), name };
    return { plants: [...draft.plants, newPlant], id: newPlant.id };
  };

  const handleSaveEntry = (payload, editingId) => {
    const { plants, id: plantId } = findOrCreatePlant(data, payload.plantName);
    const plantsChanged = plants !== data.plants;
    const now = new Date().toISOString();
    let entries;
    let savedEntry;
    if (editingId) {
      entries = data.entries.map((e) => {
        if (e.id !== editingId) return e;
        savedEntry = { ...e, ...payload, plantId, updatedAt: now };
        return savedEntry;
      });
    } else {
      const nextNumber = data.entries.reduce((m, e) => Math.max(m, e.number || 0), 0) + 1;
      savedEntry = {
        id: uid(),
        number: nextNumber,
        plantId,
        date: payload.date,
        symptomText: payload.symptomText,
        causes: payload.causes,
        actionText: payload.actionText,
        resultText: payload.resultText,
        memo: payload.memo,
        photo: payload.photo,
        createdAt: now,
        updatedAt: now,
      };
      entries = [...data.entries, savedEntry];
    }
    const nextData = { ...data, plants, entries };
    setData(nextData);
    setView({ name: "plant", plantId });

    saveEntryToStorage(savedEntry).catch(() => showSaveError());
    if (plantsChanged) {
      saveMetaToStorage(extractMeta(nextData)).catch(() => showSaveError());
    }
  };

  const handleDeleteEntry = (entryId) => {
    if (!window.confirm("この記録を削除します。よろしいですか？")) return;
    const entry = data.entries.find((e) => e.id === entryId);
    const entries = data.entries.filter((e) => e.id !== entryId);
    setData({ ...data, entries });
    setView({ name: "plant", plantId: entry?.plantId });
    deleteEntryFromStorage(entryId).catch(() => showSaveError());
  };

  const resetAll = () => {
    if (!window.confirm("すべての記録を削除します。この操作は取り消せません。よろしいですか？")) return;
    const idsToDelete = data.entries.map((e) => e.id);
    setData(emptyData());
    setView({ name: "home" });
    clearAllFromStorage(idsToDelete).catch(() => showSaveError());
  };

  /* ---- 検索結果 ---- */
  const searching = query.trim().length > 0;
  const searchResults = searching
    ? data.entries
        .filter((e) => {
          const plant = data.plants.find((p) => p.id === e.plantId);
          const haystack = [plant?.name, e.symptomText, ...(e.causes || []), e.actionText, e.resultText, e.memo]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(query.trim().toLowerCase());
        })
        .sort((a, b) => (a.date < b.date ? 1 : -1))
    : [];

  /* ---- 植物ごとのグループ ---- */
  const plantGroups = data.plants
    .map((p) => {
      const entries = data.entries.filter((e) => e.plantId === p.id).sort((a, b) => (a.date < b.date ? 1 : -1));
      return { plant: p, entries, latest: entries[0] };
    })
    .filter((g) => g.entries.length > 0)
    .sort((a, b) => (a.latest?.date < b.latest?.date ? 1 : -1));

  const allEntriesByDate = [...data.entries].sort((a, b) => (a.date < b.date ? 1 : -1));

  const currentPlant =
    view.name === "plant" || view.name === "new" || view.name === "edit" ? data.plants.find((p) => p.id === view.plantId) : null;

  const activeTab =
    view.name === "diagnose" ? "diagnose" : view.name === "new" ? "new" : view.name === "records" ? "records" : "home";

  const showHeader = view.name !== "home" && view.name !== "diagnose" && view.name !== "records";
  const headerTitle =
    view.name === "plant"
      ? currentPlant?.name
      : view.name === "new"
      ? "新しい記録"
      : view.name === "edit"
      ? "記録を編集"
      : view.name === "settings"
      ? "設定"
      : "";

  return (
    <div className="eo-root">
      <StyleSheet />

      <header className="eo-header">
        {!showHeader ? (
          <>
            <div className="eo-brand">
              <Leaf size={20} strokeWidth={1.6} />
              <div>
                <div className="eo-brand-title">
                  {view.name === "diagnose" ? "画像診断" : view.name === "records" ? "記録一覧" : "観察記録"}
                </div>
                <div className="eo-brand-sub">Experience OS · Phase1</div>
              </div>
            </div>
            <button className="eo-icon-btn" onClick={() => setView({ name: "settings" })} aria-label="設定">
              <Settings size={18} />
            </button>
          </>
        ) : (
          <>
            <button
              className="eo-icon-btn"
              onClick={() =>
                view.name === "settings"
                  ? setView({ name: "home" })
                  : setView(currentPlant && view.name !== "plant" ? { name: "plant", plantId: currentPlant.id } : { name: "home" })
              }
              aria-label="戻る"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="eo-header-title">{headerTitle}</div>
            <div style={{ width: 34 }} />
          </>
        )}
      </header>

      <main className="eo-main">
        {saveNotice && <div className="eo-notice">{saveNotice}</div>}

        {/* ---------- ホーム ---------- */}
        {view.name === "home" && (
          <>
            <div className="eo-search">
              <Search size={16} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="植物名・症状・原因・メモで検索" />
              {query && (
                <button onClick={() => setQuery("")} aria-label="検索をクリア">
                  <X size={14} />
                </button>
              )}
            </div>

            {searching ? (
              searchResults.length === 0 ? (
                <EmptyState text={`「${query}」に一致する記録は見つかりませんでした。`} />
              ) : (
                <div className="eo-card-grid">
                  {searchResults.map((e) => (
                    <SpecimenCard
                      key={e.id}
                      entry={e}
                      plantName={data.plants.find((p) => p.id === e.plantId)?.name || ""}
                      onOpen={(id) => setView({ name: "edit", entryId: id, plantId: e.plantId })}
                    />
                  ))}
                </div>
              )
            ) : plantGroups.length === 0 ? (
              <EmptyState text="まだ記録がありません。下の「追加」から最初の観察を記録してみましょう。" />
            ) : (
              <div className="eo-plant-list">
                {plantGroups.map(({ plant, entries }) => (
                  <button key={plant.id} className="eo-plant-row" onClick={() => setView({ name: "plant", plantId: plant.id })}>
                    <div className="eo-plant-thumb">
                      {entries[0]?.photo ? <img src={entries[0].photo} alt="" /> : <Leaf size={18} strokeWidth={1.5} />}
                    </div>
                    <div className="eo-plant-info">
                      <div className="eo-plant-name">{plant.name}</div>
                      <div className="eo-plant-meta">
                        {entries.length}件の記録 · 最終 {formatDateJP(entries[0]?.date)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ---------- 植物詳細 ---------- */}
        {view.name === "plant" && currentPlant && (
          <>
            <div className="eo-card-grid">
              {data.entries
                .filter((e) => e.plantId === currentPlant.id)
                .sort((a, b) => (a.date < b.date ? 1 : -1))
                .map((e) => (
                  <SpecimenCard
                    key={e.id}
                    entry={e}
                    plantName={currentPlant.name}
                    onOpen={(id) => setView({ name: "edit", entryId: id, plantId: currentPlant.id })}
                  />
                ))}
            </div>
            <button className="eo-fab" onClick={() => setView({ name: "new", plantId: currentPlant.id })} aria-label="この植物の記録を追加">
              <Plus size={24} />
            </button>
          </>
        )}

        {/* ---------- 診断（画像の近さ・APIなし） ---------- */}
        {view.name === "diagnose" && <DiagnoseScreen data={data} />}

        {/* ---------- 記録一覧（全記録を日付順） ---------- */}
        {view.name === "records" && (
          allEntriesByDate.length === 0 ? (
            <EmptyState text="まだ記録がありません。下の「追加」から最初の観察を記録してみましょう。" />
          ) : (
            <div className="eo-card-grid">
              {allEntriesByDate.map((e) => (
                <SpecimenCard
                  key={e.id}
                  entry={e}
                  plantName={data.plants.find((p) => p.id === e.plantId)?.name || ""}
                  onOpen={(id) => setView({ name: "edit", entryId: id, plantId: e.plantId })}
                />
              ))}
            </div>
          )
        )}

        {/* ---------- 新規記録 ---------- */}
        {view.name === "new" && (
          <EntryForm
            data={data}
            entry={null}
            defaultPlantName={currentPlant?.name || ""}
            onCancel={() => setView(currentPlant ? { name: "plant", plantId: currentPlant.id } : { name: "home" })}
            onSave={(payload) => handleSaveEntry(payload, null)}
          />
        )}

        {/* ---------- 編集 ---------- */}
        {view.name === "edit" &&
          (() => {
            const entry = data.entries.find((e) => e.id === view.entryId);
            if (!entry) return <EmptyState text="この記録は見つかりませんでした。" />;
            return (
              <EntryForm
                data={data}
                entry={entry}
                onCancel={() => setView({ name: "plant", plantId: entry.plantId })}
                onSave={(payload) => handleSaveEntry(payload, entry.id)}
                onDelete={handleDeleteEntry}
              />
            );
          })()}

        {/* ---------- 設定 ---------- */}
        {view.name === "settings" && (
          <div className="eo-settings">
            <div className="eo-settings-block">
              <div className="eo-settings-label">保存件数</div>
              <div className="eo-settings-value">
                植物 {data.plants.length}種 ・ 記録 {data.entries.length}件
              </div>
            </div>
            <div className="eo-settings-block">
              <div className="eo-settings-label">データについて</div>
              <p className="eo-settings-text">
                記録はこのブラウザのアカウントに保存されます。将来、サーバーやクラウドに移行する際も
                そのまま書き出せるよう、シンプルな形式で保持しています。
              </p>
            </div>
            <button className="eo-btn eo-btn-danger" onClick={resetAll}>
              <Trash2 size={14} style={{ marginRight: 4 }} />
              すべての記録を削除する
            </button>
          </div>
        )}
      </main>

      {/* ---------- 下部タブバー ---------- */}
      <nav className="eo-tabbar">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.key;
          return (
            <button
              type="button"
              key={t.key}
              className={`eo-tab ${isActive ? "eo-tab-active" : ""}`}
              onClick={() => setView({ name: t.key })}
            >
              <Icon size={20} strokeWidth={isActive ? 2.2 : 1.7} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div className="eo-empty">
      <Leaf size={26} strokeWidth={1.3} />
      <p>{text}</p>
    </div>
  );
}

/* ---------------------------------------------------------
   スタイル（植物図鑑・観察日記のトーン）
--------------------------------------------------------- */

function StyleSheet() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Work+Sans:wght@400;500;600&display=swap');

      .eo-root {
        --paper: #F5F1E6;
        --paper-card: #FFFDF7;
        --ink: #2E3324;
        --ink-soft: #5B6152;
        --moss: #55704C;
        --moss-dark: #3E5637;
        --moss-pale: #DCE4CE;
        --soil: #8A6B45;
        --rust: #9A4E2E;
        --line: #DCD5C2;

        font-family: 'Work Sans', sans-serif;
        background: var(--paper);
        background-image:
          radial-gradient(circle at 20% 10%, rgba(85,112,76,0.05), transparent 40%),
          radial-gradient(circle at 90% 80%, rgba(138,107,69,0.06), transparent 45%);
        color: var(--ink);
        max-width: 480px;
        margin: 0 auto;
        min-height: 100vh;
        position: relative;
        display: flex;
        flex-direction: column;
      }

      .eo-loading { align-items: center; justify-content: center; }
      .eo-spin { animation: eo-spin-anim 1.6s linear infinite; color: var(--moss); }
      @keyframes eo-spin-anim { to { transform: rotate(360deg); } }

      .eo-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 18px 14px; border-bottom: 1px solid var(--line);
        position: sticky; top: 0; background: var(--paper); z-index: 5;
      }
      .eo-brand { display: flex; align-items: center; gap: 10px; color: var(--moss-dark); }
      .eo-brand-title { font-family: 'Fraunces', serif; font-size: 19px; font-weight: 600; letter-spacing: 0.02em; line-height: 1.1; }
      .eo-brand-sub { font-size: 11px; color: var(--ink-soft); letter-spacing: 0.04em; margin-top: 1px; }
      .eo-header-title { font-family: 'Fraunces', serif; font-size: 17px; font-weight: 600; color: var(--moss-dark); }
      .eo-icon-btn {
        width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--line);
        background: var(--paper-card); display: flex; align-items: center; justify-content: center;
        color: var(--ink); cursor: pointer;
      }
      .eo-icon-btn:hover { border-color: var(--moss); color: var(--moss-dark); }

      .eo-main { flex: 1; padding: 16px 16px 110px; position: relative; }

      .eo-notice { background: #F6E4DC; color: var(--rust); border: 1px solid #E3B9A6; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; margin-bottom: 12px; }

      .eo-search {
        display: flex; align-items: center; gap: 8px;
        background: var(--paper-card); border: 1px solid var(--line); border-radius: 999px;
        padding: 10px 14px; margin-bottom: 18px; color: var(--ink-soft);
      }
      .eo-search input { border: none; outline: none; background: transparent; flex: 1; font-size: 14px; color: var(--ink); font-family: 'Work Sans', sans-serif; }
      .eo-search button { border: none; background: none; color: var(--ink-soft); cursor: pointer; display: flex; }

      .eo-plant-list { display: flex; flex-direction: column; gap: 10px; }
      .eo-plant-row {
        display: flex; align-items: center; gap: 12px; text-align: left;
        background: var(--paper-card); border: 1px solid var(--line); border-radius: 14px;
        padding: 12px 14px; cursor: pointer; width: 100%;
      }
      .eo-plant-row:hover { border-color: var(--moss); }
      .eo-plant-thumb {
        width: 46px; height: 46px; border-radius: 10px; background: var(--moss-pale);
        display: flex; align-items: center; justify-content: center; color: var(--moss-dark);
        overflow: hidden; flex-shrink: 0;
      }
      .eo-plant-thumb img { width: 100%; height: 100%; object-fit: cover; }
      .eo-plant-name { font-family: 'Fraunces', serif; font-size: 15.5px; font-weight: 600; color: var(--ink); }
      .eo-plant-meta { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }

      .eo-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; color: var(--ink-soft); padding: 60px 20px; opacity: 0.85; }
      .eo-empty p { font-size: 13.5px; line-height: 1.6; max-width: 260px; }

      .eo-fab {
        position: fixed; bottom: 96px; right: max(20px, calc(50vw - 216px));
        width: 54px; height: 54px; border-radius: 50%; border: none;
        background: var(--moss); color: #fff; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 16px rgba(62,86,55,0.35); cursor: pointer; z-index: 6;
      }
      .eo-fab:hover { background: var(--moss-dark); }

      .eo-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 14px; }
      .eo-card {
        background: var(--paper-card); border: 1px solid var(--line); border-radius: 4px;
        padding: 10px 10px 12px; text-align: left; cursor: pointer;
        box-shadow: 0 3px 8px rgba(46,51,36,0.08); position: relative; transition: transform 0.15s ease;
      }
      .eo-card:hover { box-shadow: 0 5px 14px rgba(46,51,36,0.14); }
      .eo-card-tape {
        position: absolute; top: -7px; left: 50%; transform: translateX(-50%) rotate(-2deg);
        width: 46px; height: 14px; background: rgba(220,228,206,0.85); border: 1px solid rgba(85,112,76,0.2);
      }
      .eo-card-number { font-family: 'Fraunces', serif; font-size: 10.5px; letter-spacing: 0.08em; color: var(--soil); margin-bottom: 6px; }
      .eo-card-photo {
        width: 100%; aspect-ratio: 1; border-radius: 3px; overflow: hidden;
        background: var(--moss-pale); display: flex; align-items: center; justify-content: center; margin-bottom: 8px;
      }
      .eo-card-photo img { width: 100%; height: 100%; object-fit: cover; }
      .eo-card-photo-empty { color: var(--moss-dark); opacity: 0.5; }
      .eo-card-date { font-size: 11px; color: var(--ink-soft); }
      .eo-card-plant { font-family: 'Fraunces', serif; font-size: 14px; font-weight: 600; margin-top: 1px; }
      .eo-card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
      .eo-tag-mini { font-size: 10px; background: var(--moss-pale); color: var(--moss-dark); padding: 2px 7px; border-radius: 999px; }
      .eo-card-memo {
        font-size: 11.5px; color: var(--ink-soft); margin-top: 6px; line-height: 1.4;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }

      .eo-form { display: flex; flex-direction: column; gap: 18px; padding-bottom: 20px; }
      .eo-field { display: flex; flex-direction: column; gap: 8px; }
      .eo-field-label { font-size: 12px; font-weight: 600; color: var(--soil); letter-spacing: 0.03em; }

      .eo-input, .eo-textarea {
        background: var(--paper-card); border: 1px solid var(--line); border-radius: 10px;
        padding: 10px 12px; font-size: 14px; color: var(--ink); font-family: 'Work Sans', sans-serif;
        outline: none; width: 100%; box-sizing: border-box;
      }
      .eo-input:focus, .eo-textarea:focus { border-color: var(--moss); }
      .eo-textarea { resize: vertical; }

      .eo-chip-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .eo-chip {
        border: 1px solid var(--line); background: var(--paper-card); color: var(--ink-soft);
        padding: 6px 12px; border-radius: 999px; font-size: 12.5px; cursor: pointer; display: flex; align-items: center;
      }
      .eo-chip-active { background: var(--moss); border-color: var(--moss); color: #fff; }
      .eo-chip-add { display: flex; align-items: center; background: transparent; border: 1px dashed var(--line); border-radius: 999px; padding: 4px 4px 4px 10px; }
      .eo-chip-add input { border: none; outline: none; background: transparent; font-size: 12.5px; width: 108px; font-family: 'Work Sans', sans-serif; }
      .eo-chip-add button { border: none; background: var(--moss-pale); color: var(--moss-dark); width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; }

      .eo-photo-add {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
        border: 1.5px dashed var(--line); border-radius: 12px; padding: 26px; background: var(--paper-card);
        color: var(--ink-soft); cursor: pointer; font-size: 12.5px; width: 100%;
      }
      .eo-photo-add:hover { border-color: var(--moss); color: var(--moss-dark); }
      .eo-photo-preview { position: relative; width: 140px; }
      .eo-photo-preview img { width: 100%; border-radius: 10px; display: block; }
      .eo-photo-remove {
        position: absolute; top: -8px; right: -8px; width: 24px; height: 24px; border-radius: 50%;
        background: var(--rust); color: #fff; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer;
      }

      .eo-tag-mini-cause { background: #F1E3D6; color: var(--soil); }
      .eo-related-hint { font-size: 11.5px; color: var(--ink-soft); margin-bottom: 2px; }

      .eo-diag-btn {
        display: flex; align-items: center; gap: 6px; justify-content: center;
        width: 100%; margin-top: 10px; padding: 10px; border-radius: 10px;
        border: 1px solid var(--moss); background: var(--moss-pale); color: var(--moss-dark);
        font-size: 13px; font-weight: 500; cursor: pointer; font-family: 'Work Sans', sans-serif;
      }
      .eo-diag-btn:hover { background: #cfdac0; }
      .eo-diag-btn:disabled { opacity: 0.7; cursor: default; }

      .eo-diag-panel {
        margin-top: 14px; background: var(--paper-card); border: 1px solid var(--line);
        border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
      }
      .eo-diag-section-label { font-family: 'Fraunces', serif; font-size: 12.5px; font-weight: 600; color: var(--moss-dark); margin-top: 6px; letter-spacing: 0.02em; }
      .eo-diag-section-label:first-child { margin-top: 0; }
      .eo-diag-unknown {
        display: flex; align-items: flex-start; font-size: 12.5px; color: var(--ink-soft);
        background: #F1ECE0; border-radius: 8px; padding: 10px; line-height: 1.6;
      }
      .eo-diag-causes { display: flex; flex-direction: column; gap: 10px; }
      .eo-diag-cause { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
      .eo-diag-cause-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .eo-diag-cause-label { font-family: 'Fraunces', serif; font-weight: 600; font-size: 14px; }
      .eo-diag-confidence { font-size: 11.5px; color: var(--soil); white-space: nowrap; }
      .eo-diag-bar { height: 5px; background: var(--moss-pale); border-radius: 999px; margin-top: 6px; overflow: hidden; }
      .eo-diag-bar-fill { height: 100%; background: var(--moss); border-radius: 999px; }
      .eo-diag-reasoning { font-size: 12px; color: var(--ink-soft); margin-top: 6px; line-height: 1.5; }
      .eo-diag-add-btn {
        display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;
        border: 1px solid var(--line); background: transparent; color: var(--moss-dark);
        border-radius: 999px; padding: 5px 11px; font-size: 11.5px; cursor: pointer; font-family: 'Work Sans', sans-serif;
      }
      .eo-diag-add-btn:hover { border-color: var(--moss); }
      .eo-diag-list { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--ink-soft); line-height: 1.7; }
      .eo-diag-similar-list { display: flex; flex-direction: column; gap: 6px; }
      .eo-diag-similar-item {
        display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 12px;
        border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; color: var(--ink-soft);
      }
      .eo-diag-similar-num { color: var(--soil); font-weight: 600; }
      .eo-diag-similar-plant { font-weight: 600; color: var(--ink); }
      .eo-diag-match-badge { background: var(--moss); color: #fff; font-weight: 600; padding: 2px 8px; border-radius: 999px; font-size: 11px; }
      .eo-diag-sources { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .eo-diag-sources a { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--moss-dark); text-decoration: underline; }
      .eo-diag-source-note { font-size: 11.5px; color: var(--ink-soft); margin-top: 2px; }
      .eo-diag-actions-list { display: flex; flex-wrap: wrap; gap: 6px; }

      .eo-diagnose { display: flex; flex-direction: column; gap: 14px; }
      .eo-diagnose-intro { font-size: 12.5px; color: var(--ink-soft); line-height: 1.7; background: var(--paper-card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
      .eo-diagnose-loading { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-soft); }

      .eo-suggest {
        position: absolute; top: 100%; left: 0; right: 0; background: var(--paper-card);
        border: 1px solid var(--line); border-radius: 10px; margin-top: 4px; max-height: 180px; overflow-y: auto;
        z-index: 8; box-shadow: 0 6px 16px rgba(46,51,36,0.12);
      }
      .eo-suggest-item { display: flex; align-items: center; padding: 9px 12px; font-size: 13.5px; cursor: pointer; }
      .eo-suggest-item:hover { background: var(--moss-pale); }
      .eo-suggest-new { color: var(--moss-dark); font-weight: 500; }

      .eo-error { color: var(--rust); font-size: 12.5px; }

      .eo-form-actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
      .eo-btn {
        border-radius: 999px; padding: 11px 18px; font-size: 13.5px; font-weight: 500; cursor: pointer;
        border: 1px solid transparent; font-family: 'Work Sans', sans-serif; display: flex; align-items: center;
      }
      .eo-btn-primary { background: var(--moss); color: #fff; flex: 1; justify-content: center; }
      .eo-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .eo-btn-primary:not(:disabled):hover { background: var(--moss-dark); }
      .eo-btn-ghost { background: transparent; border-color: var(--line); color: var(--ink-soft); }
      .eo-btn-ghost:hover { border-color: var(--ink-soft); }
      .eo-btn-danger { background: #F6E4DC; color: var(--rust); border-color: #E3B9A6; }
      .eo-btn-danger:hover { background: #F0D5C8; }

      .eo-settings { display: flex; flex-direction: column; gap: 20px; }
      .eo-settings-block { background: var(--paper-card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
      .eo-settings-label { font-size: 11.5px; font-weight: 600; color: var(--soil); letter-spacing: 0.04em; margin-bottom: 6px; }
      .eo-settings-value { font-family: 'Fraunces', serif; font-size: 15px; color: var(--ink); }
      .eo-settings-text { font-size: 12.5px; color: var(--ink-soft); line-height: 1.7; margin: 0; }

      .eo-tabbar {
        position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
        width: 100%; max-width: 480px; display: flex; justify-content: space-around;
        background: var(--paper-card); border-top: 1px solid var(--line);
        padding: 10px 4px calc(10px + env(safe-area-inset-bottom, 0px));
        z-index: 10;
      }
      .eo-tab {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
        background: none; border: none; color: var(--ink-soft); font-size: 10.5px;
        font-family: 'Work Sans', sans-serif; cursor: pointer; padding: 4px 2px;
      }
      .eo-tab-active { color: var(--moss-dark); font-weight: 600; }

    `}</style>
  );
}
