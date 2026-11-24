/* 對局費自動發布給官網（雲端排程，2026-11-24）
   由 .github/workflows/fee-publish.yml 每天跑兩次（台灣時間 07:07、19:07），沒人開對局費網頁也會更新官網。

   做法跟對局費網頁的「自動發布」一模一樣，而且算法不另外寫一份：
     直接讀網站上的 fee/index.html，擷取 @@ENGINE / @@RELEASE 標記之間的程式來算，網頁改了規則這裡自動跟著變。
   流程：讀成績系統 results/y今年 → 讀對局費 fees/y今年 → 算 → 組成官網要的格式 →
         跟官網網址上現在那份比（不看發布時間）→ 不一樣才寫入 fee_release/{網址亂碼}-y今年。

   權限：用 Firebase 服務帳號（GitHub Secrets 裡的 FIREBASE_SA，整份 JSON 金鑰）換存取權杖，直接打 Firestore REST。
   ⚠ 這個 repo 是公開的，Actions 紀錄任何人都看得到：紀錄裡只能印「有沒有更新」，不能印名字、金額、網址亂碼。

   本機測試：node .github/fee-publish.mjs --dry 測試資料.json
     測試資料.json = {"fee":{players,rules,inputs}, "year":2026}（成績照樣讀正式成績系統，公開可讀）；只印結果、不寫入。 */
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'test-5cfc9';
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/`;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---- 從對局費網頁擷取計算程式 ---- */
function extract(html, name){
  const a = html.indexOf(`/*@@${name}_BEGIN@@*/`), b = html.indexOf(`/*@@${name}_END@@*/`);
  if(a < 0 || b < a) throw new Error(`fee/index.html 裡找不到 @@${name} 標記`);
  return html.slice(a, b);
}
function loadEngine(){
  const html = fs.readFileSync(path.join(HERE, '..', 'fee', 'index.html'), 'utf8');
  const ctx = vm.createContext({ console });
  vm.runInContext(extract(html, 'ENGINE') + '\n' + extract(html, 'RELEASE'), ctx, { filename: 'fee-engine.js' });
  return ctx;
}
function compute(ctx, year, fee, rows){
  ctx.__in = { year, fee, rows };
  vm.runInContext(`
    YEAR = __in.year;
    FEE = __in.fee;
    GAMES = prepareGames(__in.rows, YEAR);
    AUTO = deriveAuto(GAMES);
    recompute();
    __out = { rel: buildFeeRelease(), issues: CALC.issues };
    __out.body = releaseBody(__out.rel);
  `, ctx);
  return ctx.__out;
}

/* ---- Firestore REST ---- */
function decode(v){
  if(v == null) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('doubleValue' in v) return Number(v.doubleValue);
  if('booleanValue' in v) return v.booleanValue;
  if('nullValue' in v) return null;
  if('timestampValue' in v) return v.timestampValue;
  if('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x])=>[k, decode(x)]));
  if('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function encode(x){
  if(typeof x === 'string') return { stringValue: x };
  if(typeof x === 'boolean') return { booleanValue: x };
  if(typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  throw new Error('不支援的欄位型別');
}
async function getToken(){
  const raw = process.env.FIREBASE_SA;
  if(!raw) throw new Error('沒有設定 GitHub Secret「FIREBASE_SA」（Firebase 服務帳號金鑰）');
  let sa;
  try{ sa = JSON.parse(raw); }catch(e){ throw new Error('FIREBASE_SA 不是正確的 JSON，請把整份金鑰檔內容貼進去'); }
  const now = Math.floor(Date.now()/1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({alg:'RS256', typ:'JWT'}) + '.' + b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }) });
  if(!r.ok) throw new Error('服務帳號換權杖失敗（HTTP ' + r.status + '），金鑰可能被刪除或貼錯');
  return (await r.json()).access_token;
}
async function getDoc(token, p){
  const r = await fetch(DOCS + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if(r.status === 404) return null;
  if(!r.ok) throw new Error('讀取 ' + p.split('/')[0] + ' 失敗（HTTP ' + r.status + '）');
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v])=>[k, decode(v)]));
}
async function setDoc(token, p, obj){
  const fields = Object.fromEntries(Object.entries(obj).map(([k, v])=>[k, encode(v)]));
  const r = await fetch(DOCS + p, { method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if(!r.ok) throw new Error('寫入官網發布版失敗（HTTP ' + r.status + '）');
}
const taipeiYear = () => new Date(Date.now() + 8*3600000).getUTCFullYear();
const parseFee = d => ({ players: JSON.parse(d.players || '[]'), rules: JSON.parse(d.rules || '{}'), inputs: d.inputs || {} });

async function main(){
  const ctx = loadEngine();
  const dry = process.argv.indexOf('--dry');
  if(dry >= 0){
    const t = JSON.parse(fs.readFileSync(process.argv[dry + 1], 'utf8'));
    const year = t.year || taipeiYear();
    const res = await getDoc(null, 'results/y' + year);
    const out = compute(ctx, year, t.fee, res ? JSON.parse(res.rows || '[]') : []);
    console.log(JSON.stringify({ issues: out.issues, release: out.rel }, null, 1));
    return;
  }
  const year = taipeiYear();
  const token = await getToken();
  const feeDoc = await getDoc(token, 'fees/y' + year);
  if(!feeDoc){ console.log(year + ' 年還沒有對局費資料，略過。'); return; }
  const keyDoc = await getDoc(token, 'fees/release_key');
  if(!keyDoc || !keyDoc.key){ console.log('還沒有官網網址（對局費網頁從來沒發布過），略過。'); return; }
  const res = await getDoc(token, 'results/y' + year);
  const out = compute(ctx, year, parseFee(feeDoc), res ? JSON.parse(res.rows || '[]') : []);
  const id = 'fee_release/' + keyDoc.key + '-y' + year;
  const cur = await getDoc(token, id);
  const curBody = cur && cur.json ? vm.runInContext('releaseBody', ctx)(JSON.parse(cur.json)) : '';
  if(out.body === curBody){ console.log('官網上的對局費已經是最新，不用更新。'); return; }
  const rel = out.rel;
  await setDoc(token, id, { year, published_at: rel.published_at, count: rel.players.length,
    total: rel.players.reduce((a, p)=>a + p.total, 0), json: JSON.stringify(rel), auto: true, via: 'github-actions' });
  console.log('已更新官網上的對局費（' + rel.published_at.replace('T', ' ').slice(0, 16) + '）。');
}
main().catch(e=>{ console.error('❌ ' + (e.message || e)); process.exit(1); });
