// รัน: node server.js  (ต้องใช้ Node 18+ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม) แล้วเปิด http://localhost:3000
const http = require("http");

// ===== ตั้งค่าเรตร้าน =====
const CONFIG = {
  rate: { GBP: 45, USD: 35 }, // เรทคงที่ (แก้ได้)
  fee: 600,                   // บวกเพิ่มต่อชิ้น (บาท)
};
const UA = { "user-agent": "Mozilla/5.0 (preorder-calculator)", accept: "application/json,text/html" };

// ===== อัตราแลกเปลี่ยน (mid-market เหมือนที่ Wise ใช้) =====
const fxCache = {};
async function getRate(cur) {
  const c = fxCache[cur];
  if (c && Date.now() - c.t < CONFIG.fxTtlMs) return c.v;
  const r = await fetch(`https://open.er-api.com/v6/latest/${cur}`);
  const j = await r.json();
  const v = j?.rates?.THB;
  if (!v) throw new Error("ดึงเรทแลกเปลี่ยนไม่ได้");
  fxCache[cur] = { v, t: Date.now() };
  return v;
}

// ===== ปัดขึ้นให้ลงท้าย ...90 =====
const roundUp = (x) => Math.floor((x - 50) / 100) * 100 + 90; // 1750-1849 -> 1790, 1850-1949 -> 1890

// ===== ดึงข้อมูลสินค้า Gymshark =====
async function getProduct(link) {
  const u = new URL(link);
  if (!/gymshark\.com$/.test(u.hostname)) throw new Error("ไม่ใช่ลิงก์ Gymshark");
  const handle = u.pathname.split("/products/")[1]?.split("/")[0];
  if (!handle) throw new Error("ไม่พบชื่อสินค้าในลิงก์");
  // บังคับโซนเป็น UK หรือ US เสมอ (ถ้าเป็นโซนอื่นให้ใช้ UK)
  const zone = u.hostname.startsWith("us.") ? "us" : "uk";
  const cur = zone === "us" ? "USD" : "GBP";
  const base = `https://${zone}.gymshark.com/products/${handle}`;

  let name = handle.replace(/-/g, " "), price = null, full = null, meta = handle;
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
    }
  } catch (e) {}
  if (price == null) { // สำรอง: อ่านจาก HTML
    const html = await (await fetch(base, { headers: UA })).text();
    const m = html.match(/"price"\s*:\s*"?([\d.]+)"?/) || html.match(/property="product:price:amount"\s+content="([\d.]+)"/);
    if (!m) throw new Error("อ่านราคาจากหน้าเว็บไม่ได้");
    price = parseFloat(m[1]);
  }
  return { name, price, full, cur, zone, meta };
}

function detectCategory(meta) {
  const s = meta.toLowerCase();
  const womenHint = /women|legging|bra\b|crop|seamless/.test(s);
  const menBottom = /shorts|joggers|sweatpants|trunks|pants/.test(s);
  return menBottom && !womenHint ? "men" : "women";
}

async function quote(link) {
  const p = await getProduct(link);
  const rate = CONFIG.rate[p.cur];
  const raw = p.price * rate + CONFIG.fee;
  return { name: p.name, category: "all", thb: roundUp(raw), internal: { zone: p.zone.toUpperCase(), cur: p.cur, price: p.price, full: p.full, rate, raw } };
}

// ===== หน้าเว็บ =====
const HTML = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>คำนวณราคาพรีออเดอร์</title>
<style>body{font-family:system-ui,"Sarabun",sans-serif;background:#f6f6f4;margin:0;color:#1a1a1a}main{max-width:520px;margin:0 auto;padding:20px 16px}
.card{background:#fff;border:1px solid #e2e2de;border-radius:14px;padding:16px;margin-bottom:14px}input,select,button{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid #ddd}
button{background:#111;color:#fff;border:0;font-weight:600;margin-top:10px;cursor:pointer}.big{font-size:2.2rem;font-weight:700;margin:6px 0}small,.mu{color:#777}</style></head><body><main>
<h1 style="font-size:1.3rem">🛍️ ราคาพรีออเดอร์ Gymshark</h1>
<div class="card"><input id="u" placeholder="วางลิงก์สินค้า Gymshark"><button id="go">คำนวณ</button></div>
<div class="card" id="r" hidden><div class="mu">ราคาพรีออเดอร์</div><div class="big" id="t"></div><div id="n"></div>
<details id="dt" hidden style="margin-top:10px"><summary class="mu">รายละเอียดสำหรับร้าน (ไม่แสดงให้ลูกค้า)</summary><div id="d" class="mu" style="font-size:.85rem;margin-top:6px"></div>
</details></div>
<div id="e" style="color:#b91c1c"></div></main><script>
const $=i=>document.getElementById(i);
async function run(){$("e").textContent="";$("go").textContent="กำลังคำนวณ...";
try{const q=new URLSearchParams({link:$("u").value.trim(),k:new URLSearchParams(location.search).get("k")||""});
const j=await (await fetch("/api/quote?"+q)).json();if(j.error)throw new Error(j.error);
$("t").textContent=j.thb.toLocaleString("th-TH")+" บาท";$("n").textContent=j.name;const i=j.internal;$("dt").hidden=!i;if(i)
$("d").innerHTML="โซน "+i.zone+" · ราคาหน้าร้าน "+i.price+" "+i.cur+(i.full?" (เต็ม "+i.full+")":"")+"<br>เรท "+i.rate+" · ×เรท+600 = "+i.raw.toFixed(1);
$("r").hidden=false}catch(x){$("e").textContent=x.message}$("go").textContent="คำนวณ"}
$("go").onclick=run;</script></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/quote") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try { const q = await quote(u.searchParams.get("link") || ""); const admin = process.env.ADMIN_KEY && u.searchParams.get("k") === process.env.ADMIN_KEY; if (!admin) delete q.internal; res.end(JSON.stringify(q)); }
    catch (e) { res.end(JSON.stringify({ error: e.message })); }
  } else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(HTML); }
}).listen(process.env.PORT || 3000, () => console.log("พร้อมใช้งานที่ http://localhost:3000"));
