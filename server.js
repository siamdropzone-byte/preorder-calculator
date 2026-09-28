// NK Pre-Order — รัน: node server.js  (Node 18+ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
const http = require("http");

// ===== ตั้งค่าร้าน =====
const CONFIG = {
  shopName: "NK Pre-Order",
  rate: { GBP: 45, USD: 35 }, // เรทคงที่
  fee: 600,                   // บวกเพิ่มทุกชิ้น (บาท)
  // ประเภทที่บวกเพิ่ม: ตรวจจากรายชื่อสินค้าในหน้า collection (ถ้าไม่เจอจะเดาจากชื่อ)
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
};
const UA = { "user-agent": "Mozilla/5.0 (nk-preorder)", accept: "application/json,text/html" };

// ปัดให้ลงท้าย 90: 1750-1849 -> 1790, 1850-1949 -> 1890
const roundUp = (x) => Math.floor((x - 50) / 100) * 100 + 90;

// ===== อ่านข้อมูลสินค้า =====
async function getProduct(link) {
  const u = new URL(link);
  if (!/gymshark\.com$/.test(u.hostname)) throw new Error("ไม่ใช่ลิงก์ Gymshark");
  const handle = u.pathname.split("/products/")[1]?.split("/")[0];
  if (!handle) throw new Error("ไม่พบชื่อสินค้าในลิงก์");
  const zone = u.hostname.startsWith("us.") ? "us" : "uk"; // บังคับ UK/US
  const cur = zone === "us" ? "USD" : "GBP";
  const base = `https://${zone}.gymshark.com/products/${handle}`;

  let name = handle.replace(/-/g, " "), price = null, full = null, meta = handle, image = null;
  try {
    const r = await fetch(base + ".js", { headers: UA });
    if (r.ok) {
      const p = await r.json();
      name = p.title || name;
      meta = [handle, p.title, p.type, (p.tags || []).join(" ")].join(" ");
      const vs = (p.variants || []).filter((v) => v.available !== false);
      const use = vs.length ? vs : p.variants || [];
      price = Math.min(...use.map((v) => v.price)) / 100;
      const cmp = Math.max(...use.map((v) => v.compare_at_price || 0)) / 100;
      if (cmp > price) full = cmp;
      image = p.featured_image || (p.images && p.images[0]) || null;
    }
  } catch (e) {}
  if (price == null || !image) { // สำรอง: อ่านจาก HTML
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
    } catch (e) {}
  }
  if (price == null) throw new Error("อ่านราคาจากหน้าเว็บไม่ได้");
  if (image && image.startsWith("//")) image = "https:" + image;
  if (image) image = image.replace(/^http:/, "https:");
  return { name, price, full, cur, zone, meta, handle, image };
}

// ===== ตรวจว่าสินค้าอยู่ในหมวดที่บวกเพิ่มไหม =====
const cache = new Map(); // url -> {t,set}
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
    if ((await handlesOf(ex.collection)).has(p.handle)) return ex; // อยู่ในหน้า collection จริง
  }
  for (const ex of CONFIG.extras) {
    if (!ex.keywords.some((k) => s.includes(k))) continue;
    if (/women|whitney|legging|bra\b/.test(s)) continue;
    if (ex.womenCollection && (await handlesOf(ex.womenCollection)).has(p.handle)) continue;
    return ex;
  }
  return null;
}

async function quote(link, x) {
  const p = await getProduct(link);
  const rate = CONFIG.rate[p.cur];
  const ex = x === "none" ? null : x ? CONFIG.extras.find((e) => e.id === x) || null : await detectExtra(p);
  const raw = p.price * rate + CONFIG.fee + (ex ? ex.extra : 0);
  return {
    name: p.name, image: p.image, thb: roundUp(raw),
    internal: { zone: p.zone.toUpperCase(), cur: p.cur, price: p.price, full: p.full, rate, fee: CONFIG.fee,
                extra: ex ? { label: ex.label, amount: ex.extra } : null, raw },
  };
}

// ===== หน้าเว็บ =====
const HTML = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CONFIG.shopName}</title>
<style>body{font-family:system-ui,"Sarabun",sans-serif;background:#f6f6f4;margin:0;color:#1a1a1a}main{max-width:520px;margin:0 auto;padding:20px 16px}
.card{background:#fff;border:1px solid #e2e2de;border-radius:14px;padding:16px;margin-bottom:14px}input,select,button{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid #ddd;box-sizing:border-box}
button{background:#111;color:#fff;border:0;font-weight:600;margin-top:10px;cursor:pointer}.big{font-size:2.2rem;font-weight:700;margin:6px 0}.mu{color:#777}
#im{width:100%;max-height:340px;object-fit:contain;background:#f0f0ee;border-radius:10px;margin-bottom:10px}</style></head><body><main>
<h1 style="font-size:1.4rem;margin:0 0 12px">🛍️ ${CONFIG.shopName}</h1>
<div class="card"><input id="u" placeholder="วางลิงก์สินค้า Gymshark"><button id="go">คำนวณราคา</button></div>
<div class="card" id="r" hidden><img id="im" alt="" referrerpolicy="no-referrer" hidden><div id="n" style="font-weight:600"></div>
<div class="mu" style="margin-top:8px">ราคาพรีออเดอร์</div><div class="big" id="t"></div>
<button id="cp">คัดลอกข้อความ</button>
<details id="dt" hidden style="margin-top:12px"><summary class="mu">รายละเอียดสำหรับร้าน (ไม่แสดงให้ลูกค้า)</summary><div id="d" class="mu" style="font-size:.85rem;margin:6px 0"></div>
<select id="x"><option value="">ประเภทบวกเพิ่ม: ตรวจอัตโนมัติ</option><option value="none">ไม่บวกเพิ่ม</option>${CONFIG.extras.map((e) => `<option value="${e.id}">${e.label} +${e.extra}</option>`).join("")}</select></details></div>
<div id="e" style="color:#b91c1c"></div></main><script>
const $=i=>document.getElementById(i);let msg="";
async function run(){$("e").textContent="";$("go").textContent="กำลังคำนวณ...";
try{const q=new URLSearchParams({link:$("u").value.trim(),k:new URLSearchParams(location.search).get("k")||"",x:$("x").value});
const j=await (await fetch("/api/quote?"+q)).json();if(j.error)throw new Error(j.error);
$("n").textContent=j.name;$("t").textContent=j.thb.toLocaleString("th-TH")+" บาท";
if(j.image){$("im").src=j.image;$("im").hidden=false}else{$("im").hidden=true}
msg="📦 "+j.name+"\\nราคาพรีออเดอร์: "+j.thb.toLocaleString("th-TH")+" บาท\\n"+$("u").value.trim();
const i=j.internal;$("dt").hidden=!i;
if(i)$("d").innerHTML="โซน "+i.zone+" · ราคาหน้าร้าน "+i.price+" "+i.cur+(i.full?" (เต็ม "+i.full+")":"")+"<br>"+i.price+" × "+i.rate+" + "+i.fee+(i.extra?" + "+i.extra.amount+" ("+i.extra.label+")":"")+" = "+i.raw.toFixed(1);
$("r").hidden=false}catch(x){$("e").textContent=x.message}$("go").textContent="คำนวณราคา"}
$("go").onclick=run;$("x").onchange=()=>{if(!$("r").hidden)run()};
$("cp").onclick=async()=>{try{await navigator.clipboard.writeText(msg);$("cp").textContent="คัดลอกแล้ว ✓"}catch(e){prompt("คัดลอกข้อความนี้",msg)}setTimeout(()=>$("cp").textContent="คัดลอกข้อความ",1500)};
</script></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/quote") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const admin = process.env.ADMIN_KEY && u.searchParams.get("k") === process.env.ADMIN_KEY;
      const q = await quote(u.searchParams.get("link") || "", admin ? u.searchParams.get("x") || "" : "");
      if (!admin) delete q.internal;
      res.end(JSON.stringify(q));
    } catch (e) { res.end(JSON.stringify({ error: e.message })); }
  } else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(HTML); }
}).listen(process.env.PORT || 3000, () => console.log("พร้อมใช้งานที่ http://localhost:3000"));
