// NK Pre-Order — รัน: node server.js  (Node 18+ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
// ฟีเจอร์แคปรูปต้องตั้งค่า ANTHROPIC_API_KEY ใน environment variable ก่อน (ดูคำอธิบายท้ายไฟล์)
const http = require("http");

// ===== ตั้งค่าร้าน =====
const CONFIG = {
  shopName: "NK Pre-Order",
  leadNote: "สินค้ารอของ 7-15 วันนับจากวันอาทิตย์นะครับ",
  lineUrl: "https://lin.ee/vXwKeJt",
  rate: { GBP: 45, USD: 35 }, // เรทคงที่
  fee: 600,                   // บวกเพิ่มทุกชิ้น (บาท)
  extras: [
    { id: "hoodie", label: "ฮู้ดดี้/สเวตเชิร์ตผู้ชาย", extra: 500,
      collection: "https://uk.gymshark.com/collections/hoodies/mens",
      womenCollection: "https://uk.gymshark.com/collections/hoodies/womens",
      keywords: ["hoodie", "sweatshirt", "pullover"] },
    { id: "jogger", label: "จ็อกเกอร์ผู้ชาย", extra: 200,
      collection: "https://uk.gymshark.com/collections/joggers/mens",
      womenCollection: "https://uk.gymshark.com/collections/joggers/womens",
      keywords: ["jogger", "pumper pant", "sweatpant", "straight leg pant", "wide leg pant", "woven pant", "cuffed pant", "oversized pant"] },
  ],
  anthropicModel: "claude-sonnet-5",
};
const UA = { "user-agent": "Mozilla/5.0 (nk-preorder)", accept: "application/json,text/html" };

const roundUp = (x) => Math.floor((x - 50) / 100) * 100 + 90;

// ===== อ่านข้อมูลสินค้าจากลิงก์ (รวมไซซ์ที่ยังมีของ) =====
async function getProduct(link) {
  const u = new URL(link);
  if (!/gymshark\.com$/.test(u.hostname)) throw new Error("ไม่ใช่ลิงก์ Gymshark");
  const handle = u.pathname.split("/products/")[1]?.split("/")[0];
  if (!handle) throw new Error("ไม่พบชื่อสินค้าในลิงก์");
  const isUS = u.hostname === "www.gymshark.com" || u.hostname === "gymshark.com" || u.hostname.startsWith("us.");
  const zone = isUS ? "us" : "uk";
  const cur = zone === "us" ? "USD" : "GBP";
  const base = isUS ? `https://www.gymshark.com/products/${handle}` : `https://uk.gymshark.com/products/${handle}`;

  let name = handle.replace(/-/g, " "), price = null, full = null, meta = handle, image = null, sizes = null, sizeSource = "none";

  // วิธีที่ 1: Shopify AJAX endpoint แบบมาตรฐาน (ใช้ได้กับร้าน Shopify ทั่วไป ไม่ใช่ Gymshark แต่เผื่อไว้)
  try {
    const r = await fetch(base + ".js", { headers: UA });
    if (r.ok) {
      const p = await r.json();
      if (p && Array.isArray(p.variants) && p.variants.length) {
        name = p.title || name;
        meta = [handle, p.title, p.type, (p.tags || []).join(" ")].join(" ");
        const vs = p.variants;
        const inStock = vs.filter((v) => v.available !== false);
        const use = inStock.length ? inStock : vs;
        price = Math.min(...use.map((v) => v.price)) / 100;
        const cmp = Math.max(...use.map((v) => v.compare_at_price || 0)) / 100;
        if (cmp > price) full = cmp;
        image = p.featured_image || (p.images && p.images[0]) || null;
        if (vs.length > 1) {
          const seen = new Map();
          for (const v of vs) {
            const label = v.option3 || v.option2 || v.option1 || v.title;
            if (!label) continue;
            const avail = v.available !== false;
            if (!seen.has(label) || avail) seen.set(label, avail);
          }
          sizes = [...seen.entries()].map(([label, available]) => ({ label, available }));
          sizeSource = "shopifyjs";
        }
      }
    }
  } catch (e) {}

  // วิธีที่ 2: อ่าน HTML จริงของหน้าเว็บ (Gymshark ใช้วิธีนี้) ดึงราคา/รูป/ไซซ์จาก JSON-LD ที่ฝังไว้สำหรับ SEO
  if (price == null || !image || !sizes) {
    try {
      const html = await (await fetch(base, { headers: UA })).text();
      if (price == null) {
        const m = html.match(/name="twitter:data1"\s+content="[£$]?([\d.]+)"/) ||
                  html.match(/property="product:price:amount"\s+content="([\d.]+)"/) ||
                  html.match(/"price"\s*:\s*"?([\d.]+)"?/);
        if (m) price = parseFloat(m[1]);
      }
      if (!image) {
        const im = html.match(/property="og:image(?::secure_url)?"\s+content="([^"]+)"/) ||
                   html.match(/content="([^"]+)"\s+property="og:image/);
        if (im) image = im[1];
      }
      if (!sizes) {
        const got = extractSizesFromLdJson(html);
        if (got && got.length) { sizes = got; sizeSource = "ldjson"; }
      }
    } catch (e) {}
  }
  if (price == null) throw new Error("อ่านราคาจากหน้าเว็บไม่ได้");
  if (image && image.startsWith("//")) image = "https:" + image;
  if (image) image = image.replace(/^http:/, "https:");
  return { name, price, full, cur, zone, meta, handle, image, sizes, sizeSource };
}

// ===== ดึงรายชื่อไซซ์ + สถานะมีของ/หมด จาก JSON-LD (schema.org Product) ที่ฝังในหน้าเว็บ =====
function extractSizesFromLdJson(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b[1]); } catch (e) { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
      if (!types.includes("Product")) continue;
      let offers = item.offers;
      if (offers && offers["@type"] === "AggregateOffer" && Array.isArray(offers.offers)) offers = offers.offers;
      if (!Array.isArray(offers) || offers.length < 2) continue;
      const out = [];
      for (const o of offers) {
        let label = o.name || o.sku || "";
        label = String(label).split("/").pop().trim(); // ตัดเอาส่วนท้ายสุด (มักเป็นไซซ์) ถ้าชื่อเต็มเป็น "สี / ไซซ์"
        if (!label) continue;
        const avail = /instock/i.test(o.availability || "");
        out.push({ label, available: avail });
      }
      if (out.length > 1) return out;
    }
  }
  return null;
}

// ===== ตรวจว่าสินค้าอยู่ในหมวดที่บวกเพิ่มไหม (สำหรับลิงก์) =====
const cache = new Map();
async function handlesOf(url) {
  const c = cache.get(url);
  if (c && Date.now() - c.t < 60 * 60 * 1000) return c.set;
  const set = new Set();
  for (const page of [1, 2, 3]) {
    try {
      const html = await (await fetch(url + (page > 1 ? `?page=${page}` : ""), { headers: UA })).text();
      for (const m of html.matchAll(/\/products\/([a-z0-9-]+)/g)) set.add(m[1]);
    } catch (e) {}
  }
  if (set.size) cache.set(url, { t: Date.now(), set });
  return set;
}
async function detectExtra(p) {
  const s = p.meta.toLowerCase().replace(/-/g, " ");
  for (const ex of CONFIG.extras) {
    if ((await handlesOf(ex.collection)).has(p.handle)) return ex;
  }
  for (const ex of CONFIG.extras) {
    if (!ex.keywords.some((k) => s.includes(k))) continue;
    if (/women|whitney|legging|bra\b/.test(s)) continue;
    if (ex.womenCollection && (await handlesOf(ex.womenCollection)).has(p.handle)) continue;
    return ex;
  }
  return null;
}

function buildQuote({ name, image, price, cur, full, extraId, sizes }) {
  const rate = CONFIG.rate[cur] || CONFIG.rate.GBP;
  const ex = extraId === "none" ? null : extraId ? CONFIG.extras.find((e) => e.id === extraId) || null : null;
  const raw = price * rate + CONFIG.fee + (ex ? ex.extra : 0);
  return {
    name, image, thb: roundUp(raw), sizes: sizes || null,
    internal: { cur, price, full: full || null, rate, fee: CONFIG.fee,
                extra: ex ? { label: ex.label, amount: ex.extra } : null, raw },
  };
}

async function quote(link, x) {
  const p = await getProduct(link);
  const ex = x ? x : (await detectExtra(p))?.id || "none";
  const q = buildQuote({ name: p.name, image: p.image, price: p.price, cur: p.cur, full: p.full, extraId: ex, sizes: p.sizes });
  q.internal.zone = p.zone.toUpperCase();
  q.internal.sizeSource = p.sizeSource;
  return q;
}

// ===== อ่านชื่อ/ราคา/ประเภทจากรูปที่ลูกค้าแคปมา (ใช้ Claude vision) =====
async function readFromImage(base64, mediaType) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ร้านยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY สำหรับฟีเจอร์อ่านรูป");
  const extraList = CONFIG.extras.map((e) => e.id).join(" / ");
  const sys = `คุณคือระบบอ่านภาพหน้าจอสินค้า Gymshark ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ห้ามใส่ \`\`\`
รูปแบบ: {"name": string, "price": number, "currency": "GBP"|"USD", "onSale": boolean, "category": "${extraList}"|"other"}
กติกา:
- "price" ใช้ราคาที่ลดแล้วเท่านั้นถ้ามีป้ายลดราคา (ตัวเลขเล็กกว่า) ไม่เอาราคาเต็มที่มีขีดฆ่า
- "currency" ดูจากสัญลักษณ์เงินในภาพ (£ = GBP, $ = USD) ถ้าไม่เห็นสัญลักษณ์เลยให้ตอบ GBP
- "category" ให้ตอบ "jogger" ถ้าสินค้าคือกางเกงจ็อกเกอร์/วอร์มผู้ชาย, "hoodie" ถ้าเป็นฮู้ดดี้/สเวตเชิร์ตผู้ชาย, ไม่งั้นตอบ "other"
- ถ้าอ่านราคาจากภาพไม่ได้เลย ให้ตอบ "price": null`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.anthropicModel,
      max_tokens: 300,
      system: sys,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "อ่านชื่อสินค้า ราคา สกุลเงิน และประเภทจากภาพนี้ ตอบเป็น JSON ตามรูปแบบที่กำหนด" },
        ],
      }],
    }),
  });
  const data = await r.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error("อ่านข้อมูลจากรูปไม่สำเร็จ ลองรูปที่เห็นชื่อและราคาชัดเจนกว่านี้"); }
  if (parsed.price == null) throw new Error("อ่านราคาจากรูปนี้ไม่ได้ ลองแคปให้เห็นราคาชัด ๆ หรือใช้ลิงก์แทน");
  return parsed;
}

async function quoteFromImage(base64, mediaType, xOverride) {
  const r = await readFromImage(base64, mediaType);
  const extraId = xOverride || (r.category && r.category !== "other" ? r.category : "none");
  const q = buildQuote({ name: r.name || "สินค้า", image: null, price: r.price, cur: r.currency === "USD" ? "USD" : "GBP", full: null, extraId, sizes: null });
  q.internal.zone = r.currency === "USD" ? "US" : "UK";
  q.internal.fromImage = true;
  q.internal.onSale = !!r.onSale;
  return q;
}

// ===== หน้าเว็บ =====
const HTML = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CONFIG.shopName}</title>
<style>body{font-family:system-ui,"Sarabun",sans-serif;background:#f6f6f4;margin:0;color:#1a1a1a}main{max-width:520px;margin:0 auto;padding:20px 16px 90px}
.card{background:#fff;border:1px solid #e2e2de;border-radius:14px;padding:16px;margin-bottom:14px}input,select,button{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid #ddd;box-sizing:border-box}
button{background:#111;color:#fff;border:0;font-weight:600;margin-top:10px;cursor:pointer}
button.alt{background:#fff;color:#111;border:1px solid #ddd}
.big{font-size:2.2rem;font-weight:700;margin:6px 0}.mu{color:#777}
.line{display:block;text-align:center;text-decoration:none;background:#06c755;color:#fff;font-weight:600;padding:10px 12px;border-radius:10px;margin-top:10px}
.note{font-size:.9rem;color:#555;margin-bottom:4px}
#im{width:100%;max-height:340px;object-fit:contain;background:#f0f0ee;border-radius:10px;margin-bottom:10px}
.tabs{display:flex;gap:8px;margin-bottom:12px}.tab{flex:1;text-align:center;padding:9px;border-radius:10px;border:1px solid #ddd;cursor:pointer;background:#fff;font-weight:600}.tab.on{background:#111;color:#fff}
#filepreview{max-height:180px;width:100%;object-fit:contain;border-radius:10px;margin-top:8px;background:#f0f0ee}
.sizes{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.sz{padding:7px 14px;border-radius:999px;border:1px solid #ccc;cursor:pointer;font-size:.9rem;background:#fff}
.sz.on{background:#111;color:#fff;border-color:#111}
.sz.out{color:#bbb;text-decoration:line-through;cursor:not-allowed;border-color:#eee}
.qty{display:flex;align-items:center;gap:10px;margin:10px 0}
.qty button{width:40px;margin:0;padding:8px 0}
.qty span{min-width:24px;text-align:center;font-weight:600}
.cart{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #e2e2de;box-shadow:0 -4px 12px rgba(0,0,0,.05)}
.cartbar{max-width:520px;margin:0 auto;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.cartbody{max-width:520px;margin:0 auto;padding:0 16px 16px;max-height:50vh;overflow-y:auto}
.citem{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #eee;font-size:.9rem}
.citem img{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#f0f0ee;flex-shrink:0}
.citem .ctag{font-size:.7rem;text-transform:uppercase;color:#999;letter-spacing:.03em}
.citem .cname{font-weight:600;line-height:1.3}
.citem .cattrs{color:#888;font-size:.8rem;margin-top:1px}
.citem .cright{margin-left:auto;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.citem .cqty{display:flex;align-items:center;gap:8px}
.citem .cqty button{width:26px;height:26px;padding:0;margin:0;border-radius:7px;font-size:.95rem;line-height:1}
.citem .cqty span{min-width:16px;text-align:center;font-weight:600;font-size:.85rem}
.citem .cx{color:#b91c1c;cursor:pointer;background:none;border:none;width:auto;padding:0;font-size:.95rem;margin-top:2px}
.badge{background:#111;color:#fff;border-radius:999px;padding:1px 8px;font-size:.75rem}
</style></head><body><main>
<h1 style="font-size:1.4rem;margin:0 0 12px">🛍️ ${CONFIG.shopName}</h1>
<div class="card">
  <div class="tabs"><div class="tab on" id="tabLink">วางลิงก์</div><div class="tab" id="tabImg">แคปรูปสินค้า</div></div>
  <div id="panelLink"><input id="u" placeholder="วางลิงก์สินค้า Gymshark"><button id="go">คำนวณราคา</button></div>
  <div id="panelImg" hidden>
    <input type="file" id="f" accept="image/*">
    <img id="filepreview" hidden>
    <button id="goImg">คำนวณราคาจากรูป</button>
  </div>
</div>
<div class="card" id="r" hidden><img id="im" alt="" referrerpolicy="no-referrer" hidden><div id="n" style="font-weight:600"></div>
<div class="mu" style="margin-top:8px">ราคาพรีออเดอร์</div><div class="big" id="t"></div>
<div id="szwrap" hidden><div class="mu" style="font-size:.85rem">เลือกไซซ์ (ตัดสีเทา = ของหมด)</div><div class="sizes" id="sizes"></div></div>
<div class="qty"><span class="mu" style="font-size:.85rem">จำนวน</span><button class="alt" id="qm">−</button><span id="qn">1</span><button class="alt" id="qp">+</button></div>
<button id="add">➕ เพิ่มลงตะกร้า</button>
<div class="note" style="margin-top:10px">${CONFIG.leadNote}</div>
<details id="dt" hidden style="margin-top:8px"><summary class="mu">รายละเอียดสำหรับร้าน (ไม่แสดงให้ลูกค้า)</summary><div id="d" class="mu" style="font-size:.85rem;margin:6px 0"></div>
<select id="x"><option value="">ประเภทบวกเพิ่ม: ตรวจอัตโนมัติ</option><option value="none">ไม่บวกเพิ่ม</option>${CONFIG.extras.map((e) => `<option value="${e.id}">${e.label} +${e.extra}</option>`).join("")}</select></details></div>
<div id="e" style="color:#b91c1c"></div>
</main>
<div class="cart">
  <div class="cartbar" id="cartbar"><span>🛒 ตะกร้า <span class="badge" id="cn">0</span></span><span id="ct" style="font-weight:700">0 บาท</span></div>
  <div class="cartbody" id="cartbody" hidden>
    <div id="citems"></div>
    <a class="line" href="${CONFIG.lineUrl}" target="_blank" rel="noopener">💬 ทักไลน์เพื่อยืนยันออเดอร์</a>
    <button id="cpall">คัดลอกรายการสั่งซื้อทั้งหมด</button>
  </div>
</div>
<script>
const $=i=>document.getElementById(i);
let current=null, selSize=null, qty=1;

// ===== แท็บ =====
$("tabLink").onclick=()=>{$("tabLink").classList.add("on");$("tabImg").classList.remove("on");$("panelLink").hidden=false;$("panelImg").hidden=true};
$("tabImg").onclick=()=>{$("tabImg").classList.add("on");$("tabLink").classList.remove("on");$("panelImg").hidden=false;$("panelLink").hidden=true};
$("f").onchange=()=>{const file=$("f").files[0];if(!file)return;$("filepreview").src=URL.createObjectURL(file);$("filepreview").hidden=false};

// ===== แสดงผลคำนวณ =====
function showResult(j, linkForMsg){
  current={name:j.name,image:j.image||"",thb:j.thb,link:linkForMsg||""};
  selSize=null;qty=1;$("qn").textContent=qty;
  $("n").textContent=j.name;$("t").textContent=j.thb.toLocaleString("th-TH")+" บาท";
  if(j.image){$("im").src=j.image;$("im").hidden=false}else{$("im").hidden=true}
  if(j.sizes&&j.sizes.length){
    $("szwrap").hidden=false;
    $("sizes").innerHTML=j.sizes.map(s=>'<div class="sz'+(s.available?"":" out")+'" data-l="'+s.label+'">'+s.label+(s.available?"":" (หมด)")+'</div>').join("");
    [...$("sizes").children].forEach(el=>{if(el.classList.contains("out"))return;el.onclick=()=>{[...$("sizes").children].forEach(x=>x.classList.remove("on"));el.classList.add("on");selSize=el.dataset.l}});
  } else { $("szwrap").hidden=true; }
  const i=j.internal;$("dt").hidden=!i;
  if(i)$("d").innerHTML=(i.fromImage?"(อ่านจากรูป) ":"")+"โซน "+i.zone+" · ราคาหน้าร้าน "+i.price+" "+i.cur+(i.full?" (เต็ม "+i.full+")":"")+"<br>"+i.price+" × "+i.rate+" + "+i.fee+(i.extra?" + "+i.extra.amount+" ("+i.extra.label+")":"")+" = "+i.raw.toFixed(1)+(i.sizeSource?"<br>ไซซ์: "+(i.sizeSource==="none"?"อ่านไม่ได้":i.sizeSource):"");
  $("r").hidden=false;
}

$("qm").onclick=()=>{if(qty>1)qty--;$("qn").textContent=qty};
$("qp").onclick=()=>{qty++;$("qn").textContent=qty};

async function run(){$("e").textContent="";$("go").textContent="กำลังคำนวณ...";
try{const link=$("u").value.trim();
const q=new URLSearchParams({link,k:new URLSearchParams(location.search).get("k")||"",x:$("x").value});
const j=await (await fetch("/api/quote?"+q)).json();if(j.error)throw new Error(j.error);
showResult(j,link);
}catch(x){$("e").textContent=x.message}$("go").textContent="คำนวณราคา"}

async function runImage(){
  const file=$("f").files[0];if(!file){$("e").textContent="เลือกรูปก่อนนะครับ";return}
  $("e").textContent="";$("goImg").textContent="กำลังอ่านรูป...";
  try{
    const dataUrl=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)});
    const [, mediaType, base64]=dataUrl.match(/^data:(.+);base64,(.*)$/);
    const resp=await fetch("/api/quote-image",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({image:base64,mediaType,k:new URLSearchParams(location.search).get("k")||"",x:$("x").value})});
    const j=await resp.json();if(j.error)throw new Error(j.error);
    showResult(j,"");
  }catch(x){$("e").textContent=x.message}$("goImg").textContent="คำนวณราคาจากรูป"
}
$("go").onclick=run;$("goImg").onclick=runImage;
$("x").onchange=()=>{if(!$("r").hidden){if(!$("panelImg").hidden)runImage();else run()}};

// ===== ตะกร้า (เก็บในเบราว์เซอร์นี้) =====
function getCart(){try{return JSON.parse(localStorage.getItem("nk_cart")||"[]")}catch(e){return []}}
function setCart(c){try{localStorage.setItem("nk_cart",JSON.stringify(c))}catch(e){}}
function renderCart(){
  const c=getCart();$("cn").textContent=c.reduce((a,i)=>a+i.qty,0);
  $("ct").textContent=c.reduce((a,i)=>a+i.qty*i.thb,0).toLocaleString("th-TH")+" บาท";
  $("citems").innerHTML=c.map((it,idx)=>
    '<div class="citem">'+
      (it.image?'<img src="'+it.image+'" alt="">':'<div style="width:56px;height:56px;border-radius:8px;background:#f0f0ee;flex-shrink:0"></div>')+
      '<div><div class="ctag">พรีออเดอร์</div><div class="cname">'+it.name+'</div>'+
      (it.size?'<div class="cattrs">ไซซ์ '+it.size+'</div>':'')+
      '<button class="cx" data-i="'+idx+'">✕ นำออก</button></div>'+
      '<div class="cright"><b>'+(it.qty*it.thb).toLocaleString("th-TH")+' บาท</b>'+
      '<div class="cqty"><button class="alt cm" data-i="'+idx+'">−</button><span>'+it.qty+'</span><button class="alt cp" data-i="'+idx+'">+</button></div></div>'+
    '</div>'
  ).join("")||'<div class="mu" style="padding:10px 0">ยังไม่มีสินค้าในตะกร้า</div>';
  [...$("citems").querySelectorAll(".cx")].forEach(b=>b.onclick=()=>{const c2=getCart();c2.splice(+b.dataset.i,1);setCart(c2);renderCart()});
  [...$("citems").querySelectorAll(".cm")].forEach(b=>b.onclick=()=>{const c2=getCart();const it=c2[+b.dataset.i];if(it.qty>1)it.qty--;else c2.splice(+b.dataset.i,1);setCart(c2);renderCart()});
  [...$("citems").querySelectorAll(".cp")].forEach(b=>b.onclick=()=>{const c2=getCart();c2[+b.dataset.i].qty++;setCart(c2);renderCart()});
}
$("cartbar").onclick=()=>{$("cartbody").hidden=!$("cartbody").hidden};
$("add").onclick=()=>{
  if(!current){$("e").textContent="กดคำนวณราคาก่อนนะครับ";return}
  if($("sizes").children.length && !selSize){$("e").textContent="เลือกไซซ์ก่อนนะครับ";return}
  $("e").textContent="";
  const c=getCart();
  const match=c.find(i=>i.name===current.name&&i.size===selSize&&i.link===current.link);
  if(match)match.qty+=qty;else c.push({name:current.name,size:selSize,qty,thb:current.thb,link:current.link,image:current.image});
  setCart(c);renderCart();$("cartbody").hidden=false;
  $("add").textContent="เพิ่มแล้ว ✓";setTimeout(()=>$("add").textContent="➕ เพิ่มลงตะกร้า",1200);
};
$("cpall").onclick=async()=>{
  const c=getCart();if(!c.length)return;
  let msg="📦 สนใจพรีออเดอร์รายการนี้ครับ/ค่ะ\\n━━━━━━━━━━\\n";
  for(const it of c){
    msg+=it.name+"\\n";
    if(it.size)msg+="ไซซ์ "+it.size+"\\n";
    msg+="จำนวน "+it.qty+" x "+it.thb.toLocaleString("th-TH")+" = "+(it.qty*it.thb).toLocaleString("th-TH")+" บาท\\n";
    if(it.link)msg+=it.link+"\\n";
    msg+="━━━━━━━━━━\\n";
  }
  msg+="รวมทั้งหมด: "+c.reduce((a,i)=>a+i.qty*i.thb,0).toLocaleString("th-TH")+" บาท\\n${CONFIG.leadNote}";
  try{await navigator.clipboard.writeText(msg);$("cpall").textContent="คัดลอกแล้ว ✓"}catch(e){prompt("คัดลอกข้อความนี้",msg)}
  setTimeout(()=>$("cpall").textContent="คัดลอกรายการสั่งซื้อทั้งหมด",1500);
};
renderCart();
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");

  // เครื่องมือตรวจสอบ (เฉพาะร้าน): เปิดด้วย /api/debug?link=...&k=ADMIN_KEY
  // ไว้ดูว่า HTML ที่เซิร์ฟเวอร์ได้รับจริงจาก Gymshark หน้าตาเป็นอย่างไร
  if (req.method === "GET" && u.pathname === "/api/debug") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      if (!process.env.ADMIN_KEY || u.searchParams.get("k") !== process.env.ADMIN_KEY) throw new Error("ต้องใส่ ?k=ADMIN_KEY ให้ถูกต้อง");
      const link = u.searchParams.get("link") || "";
      const lu = new URL(link);
      const handle = lu.pathname.split("/products/")[1]?.split("/")[0];
      const isUS = lu.hostname === "www.gymshark.com" || lu.hostname === "gymshark.com" || lu.hostname.startsWith("us.");
      const base = isUS ? `https://www.gymshark.com/products/${handle}` : `https://uk.gymshark.com/products/${handle}`;

      const jsRes = await fetch(base + ".js", { headers: UA }).catch((e) => ({ ok: false, status: "fetch error: " + e.message }));
      const jsInfo = { status: jsRes.status, ok: jsRes.ok, bodyPreview: jsRes.ok ? (await jsRes.text()).slice(0, 500) : null };

      const htmlRes = await fetch(base, { headers: UA });
      const html = await htmlRes.text();
      const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
      const ldJsonBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      const nextDataPresent = /__NEXT_DATA__/.test(html);
      const hasSelectSize = /select a size/i.test(html);
      const htmlSnippetAroundSize = (() => {
        const i = html.search(/select a size/i);
        return i >= 0 ? html.slice(Math.max(0, i - 200), i + 1500) : null;
      })();

      res.end(JSON.stringify({
        link, base,
        shopifyJsEndpoint: jsInfo,
        htmlStatus: htmlRes.status,
        htmlLength: html.length,
        pageTitle: titleMatch ? titleMatch[1] : null,
        ldJsonBlockCount: ldJsonBlocks.length,
        ldJsonFirst2000: ldJsonBlocks[0] ? ldJsonBlocks[0][1].slice(0, 2000) : null,
        hasNextData: nextDataPresent,
        hasSelectSizeText: hasSelectSize,
        htmlAroundSelectSize: htmlSnippetAroundSize,
      }, null, 2));
    } catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/quote") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const admin = process.env.ADMIN_KEY && u.searchParams.get("k") === process.env.ADMIN_KEY;
      const q = await quote(u.searchParams.get("link") || "", admin ? u.searchParams.get("x") || "" : "");
      if (!admin) delete q.internal;
      res.end(JSON.stringify(q));
    } catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/quote-image") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const body = JSON.parse(await readBody(req));
      const admin = process.env.ADMIN_KEY && body.k === process.env.ADMIN_KEY;
      if (!body.image || !body.mediaType) throw new Error("ไม่พบรูปที่ส่งมา");
      const q = await quoteFromImage(body.image, body.mediaType, admin ? body.x || "" : "");
      if (!admin) delete q.internal;
      res.end(JSON.stringify(q));
    } catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(HTML);
}).listen(process.env.PORT || 3000, () => console.log("พร้อมใช้งานที่ http://localhost:3000"));

/* ===== วิธีเปิดใช้ฟีเจอร์ "แคปรูปสินค้า" =====
1. ไปที่ Render > โปรเจกต์นี้ > Environment
2. เพิ่มตัวแปร ANTHROPIC_API_KEY ด้วยคีย์จาก console.anthropic.com (ต้องผูกบัตร/มีเครดิตการใช้งาน API)
3. Deploy ใหม่ จากนั้นแท็บ "แคปรูปสินค้า" จะใช้งานได้ทันที (แท็บ "วางลิงก์" ใช้ได้เสมอไม่ต้องรอ)

===== เรื่องไซซ์และตะกร้า =====
- ไซซ์ที่ยังมีของ (ไม่ตัดเส้น) อ่านจากข้อมูลจริงของ Gymshark เฉพาะตอนลูกค้าวางลิงก์เท่านั้น โหมดแคปรูปไม่มีไซซ์ให้เลือก
- ตะกร้าเก็บไว้ในเบราว์เซอร์ของลูกค้าแต่ละคน (localStorage) ไม่ได้ส่งเข้าระบบร้าน ลูกค้าต้องกด "คัดลอกรายการสั่งซื้อทั้งหมด" แล้วส่งให้ร้านเองทางไลน์
*/
