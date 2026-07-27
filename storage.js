// Claude.ai の artifact 環境が提供する `window.storage`（get/set/delete/list）を、
// このアプリの外（Vercel等にデプロイした単体アプリ）でも同じ形で使えるようにするための
// ブラウザ内蔵 IndexedDB を使ったポリフィルです。
//
// localStorage ではなく IndexedDB を選んでいる理由：
// このアプリは写真を含む記録を多数保存するため、localStorage の容量上限（多くのブラウザで
// 合計5〜10MB程度）だとすぐに保存できなくなります。IndexedDB は数百MB〜数GB単位まで扱えるため、
// 実用に耐えるサイズになります。
//
// 注意：これはブラウザ内（端末内）だけの保存です。別の端末やブラウザとはデータが同期されません。
// 複数端末で同じ記録を見たい場合は、将来的にサーバー側のデータベースへの移行が必要です
// （プロジェクトの基本設計書 Phase3 の想定通りです）。

const DB_NAME = "experience-os-db";
const STORE_NAME = "kv";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbSet(key, value) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbDelete(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbKeys() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

async function get(key, shared) {
  const value = await idbGet(key);
  if (value === undefined) throw new Error("not found");
  return { key, value, shared };
}

async function set(key, value, shared) {
  await idbSet(key, value);
  return { key, value, shared };
}

async function del(key, shared) {
  const existing = await idbGet(key);
  if (existing === undefined) throw new Error("not found");
  await idbDelete(key);
  return { key, deleted: true, shared };
}

async function list(prefix = "", shared) {
  const allKeys = await idbKeys();
  const keys = allKeys.map(String).filter((k) => !prefix || k.startsWith(prefix));
  return { keys, prefix, shared };
}

export function installStoragePolyfill() {
  if (typeof window !== "undefined" && !window.storage) {
    window.storage = { get, set, delete: del, list };
  }
}
