import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
app.disable("x-powered-by");
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use(cors({origin(origin, cb){ if(!origin || allowedOrigins.length===0 || allowedOrigins.includes(origin)) return cb(null,true); return cb(new Error("Origin not allowed")); }}));
app.use(express.json({limit:"12mb"}));
app.use("/api/", rateLimit({windowMs:60_000,limit:12,standardHeaders:true,legacyHeaders:false}));
const client = process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
app.get("/api/health", (_req,res)=>res.json({ok:true,visionConfigured:Boolean(client),model:MODEL,now:new Date().toISOString()}));
app.post("/api/analyze", async(req,res)=>{
 try {
  if(!client) return res.status(503).json({error:"Vision AI is not configured. Add OPENAI_API_KEY to the backend environment, never to the HTML file."});
  const {imageDataUrl,context}=req.body||{};
  if(typeof imageDataUrl!=="string" || !/^data:image\/(png|jpeg|webp);base64,/.test(imageDataUrl)) return res.status(400).json({error:"A PNG, JPEG or WebP data URL is required."});
  if(imageDataUrl.length>11_200_000) return res.status(413).json({error:"Image too large. Use an image under 8 MB."});
  const safeContext = JSON.stringify(context||{}).slice(0,24000);
  const prompt = `You are INKABI.21, a cautious XAU/USD chart and macro evidence assistant. Analyze the attached chart screenshot AND the supplied market context. Distinguish observations visible in the image from supplied live-feed values and from inference. Never invent price levels, timestamps, event actuals/forecasts, sources, or indicator values. If text is unreadable, say so. If the screenshot timeframe or symbol is not visible, mark unknown. Do not claim prices are live unless the context includes recent timestamped quotes; mention stale/missing data. Explain: (1) screenshot identification/readability; (2) trend/market structure and candlestick evidence; (3) visible support/demand and resistance/supply zones with approximate price only if legible; (4) liquidity sweep/breakout/rejection evidence only if actually visible; (5) macro alignment using XAUUSD, DXY, EURUSD, GBPUSD, USDJPY, silver, oil and US nominal/real yields when supplied; (6) latest relevant news/calendar catalysts and source limitations; (7) bullish and bearish scenarios, confirmation conditions, invalidation conditions; (8) risk gate. Do not provide a guaranteed prediction or instruct an automatic trade. Use WAIT if evidence conflicts or key data is missing. Use NO-GO if screenshot is unreadable, essential live quote data is missing/stale, or critical risk checks are unavailable. No execution or broker connection exists. Return plain text with concise headings and confidence expressed as low/moderate/high plus why. Context JSON: ${safeContext}`;
  const response = await client.responses.create({model:MODEL,input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:imageDataUrl,detail:"high"}]}],max_output_tokens:1600});
  const analysis = (response.output_text||"").trim();
  if(!analysis) return res.status(502).json({error:"The AI provider returned an empty analysis."});
  res.json({ok:true,analysis,model:MODEL,analyzedAt:new Date().toISOString()});
 } catch(e) {
  console.error("/api/analyze failed:",e?.status||"",e?.message||"unknown");
  res.status(502).json({error:"AI analysis request failed. Check backend logs, provider billing/access, model availability and image format."});
 }
});

const FC_BASE = "https://www.financecalendar.com/wp-json/fc/v1";
const safeText = value => value === null || value === undefined || value === "" ? null : String(value);
const parseFirstNumber = value => {
 if (value === null || value === undefined) return null;
 const m = String(value).replace(/,/g, "").match(/[-+]?\d*\.?\d+/);
 return m ? Number(m[0]) : null;
};
const ymd = date => date.toISOString().slice(0,10);

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "INKABI.21 NFP Intelligence/1.0"
      }
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `Upstream HTTP ${response.status}: ${body.slice(0, 500)}`
      );
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Upstream returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/nfp/outlook", async (_req,res) => {
 try {
  const now = new Date();
  const today = ymd(now);
  
const from = ymd(new Date(now.getTime()-45*86400000));
const to = ymd(new Date(now.getTime()+45*86400000));

  const url = `${FC_BASE}/calendar?from=${from}&to=${to}&country=US&limit=500&tz=America%2FNew_York`;
  const data = await fetchJsonWithTimeout(url);
  const all = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : null;
  
console.log("NFP calendar sample:", JSON.stringify(
  (all || [])
    .filter(e =>
      String(e.country || "").toUpperCase() === "US" &&
      /non.?farm payroll|employment situation|ADP.*employment|JOLTS/i.test(
        `${e.name || ""} ${e.title || ""} ${e.series_name || ""}`
      )
    )
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 3)
));
  if (!all) throw new Error("Calendar source returned an unexpected format");
  const nfpRx = /non.?farm payroll|employment situation|nonfarm employment/i;
  const nfpEvents = all.filter(e=>nfpRx.test(`${e.name||""} ${e.title||""} ${e.series_name||""}`)).sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));
  const nextNfp = nfpEvents.find(e=>String(e.date||"")>=today && !/cancelled/i.test(e.status||"")) || null;
  const previousNfp = [...nfpEvents].reverse().find(e=>String(e.date||"")<today && (e.actual!==null && e.actual!==undefined || /released/i.test(e.status||""))) || null;
  const relevantRx = /ADP.*employment|employment change|jobless claims|unemployment claims|continuing claims|JOLTS|job openings|ISM.*employment|employment.*ISM|average hourly earnings|hourly earnings|unemployment rate|labor force participation|labour force participation|non.?farm payroll|employment situation|challenger.*job cuts/i;
  let timeline = all.filter(e=>relevantRx.test(`${e.name||""} ${e.title||""} ${e.series_name||""}`));
  if (nextNfp) timeline = timeline.filter(e=>String(e.date||"") >= String(previousNfp?.date || from) && String(e.date||"") <= String(nextNfp.date));
  else timeline = timeline.filter(e=>String(e.date||"") >= from && String(e.date||"") <= to);
  timeline.sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));
  let score=0, scored=0, positive=0, negative=0;
  const mapped = timeline.map(e=>{
   const name=`${e.name||e.title||e.series_name||"Economic release"}`;
   const actual=safeText(e.actual), forecast=safeText(e.consensus), previous=safeText(e.prior);
   const a=parseFirstNumber(actual), f=parseFirstNumber(forecast);
   let interpretation="No directional comparison possible; actual or consensus is unavailable.";
   let points=0;
   const lowerIsWorse=/jobless claims|unemployment claims|continuing claims|unemployment rate|job cuts/i.test(name);
   if(a!==null && f!==null && Number.isFinite(a) && Number.isFinite(f) && a!==f){
    const delta=a-f; const sign=delta>0?1:-1; points=sign*(lowerIsWorse?-1:1);
    if(/hourly earnings|wage/i.test(name)) interpretation=delta>0?"Wages beat consensus; potentially inflationary/hawkish for USD, but not a direct NFP count signal.":"Wages missed consensus; potentially less inflationary, but not a direct NFP count signal.";
    else interpretation=points>0?"Stronger than consensus on this labour indicator; one input only.":"Weaker than consensus on this labour indicator; one input only.";
    if(!/hourly earnings|wage/i.test(name)){score+=points;scored++;if(points>0)positive++;else negative++;}
   } else if(a!==null && f===null){ interpretation="Actual is published but market consensus is unavailable; no surprise score assigned."; }
   return {date:e.date||null,name,status:e.status||"unknown",actual,forecast,previous,interpretation,sourceUrl:e.source_url||e.url||null,sourceName:e.source_name||"Finance Calendar",_score:points};
  });
  let label="WAIT / MIXED", confidence="Low — insufficient comparable releases", briefing="Automatic data has been retrieved, but there is not enough comparable published evidence to estimate whether the next NFP print is more likely to beat or miss consensus.";
  let goldImpact="WAIT. NFP can move USD, Treasury yields and gold in either direction; the immediate reaction also depends on wages, unemployment, revisions and market positioning.";
  if(scored>=3 && score>=2){label="LABOUR SIGNAL LEANS STRONGER";confidence=`Low-to-moderate · ${scored} comparable surprise(s); ${positive} stronger and ${negative} weaker signals`;briefing="Available comparable releases lean toward stronger labour conditions versus consensus. This is a conditional signal, not a statistically calibrated NFP forecast; proxy indicators can diverge from official payrolls.";goldImpact="If official NFP and wages also beat expectations and yields/USD rise, gold may face downside pressure. Confirm with the actual release and price reaction.";}
  else if(scored>=3 && score<=-2){label="LABOUR SIGNAL LEANS WEAKER";confidence=`Low-to-moderate · ${scored} comparable surprise(s); ${positive} stronger and ${negative} weaker signals`;briefing="Available comparable releases lean toward weaker labour conditions versus consensus. This is a conditional signal, not a statistically calibrated NFP forecast; proxy indicators can diverge from official payrolls.";goldImpact="If official NFP misses and yields/USD fall, gold may gain support. Confirm with wages, unemployment, revisions and the actual price reaction.";}
  else if(scored>=3){label="MIXED / NO CLEAR EDGE";confidence=`Low · ${scored} comparable surprises conflict`;briefing="The comparable labour indicators are mixed. There is no clear pre-NFP directional edge from these inputs.";}
  const quality=[];
  quality.push(`Finance Calendar returned ${all.length} US calendar events for the requested date window.`);
  quality.push(`${mapped.length} labour-related releases matched the timeline filters; ${scored} had numeric actual-versus-consensus comparisons suitable for the simple directional tally.`);
  if(!nextNfp) quality.push("Upcoming official NFP event was not identified in the calendar response; verify the BLS schedule before relying on a date.");
  if(!previousNfp) quality.push("Previous NFP release was not confidently identified; the timeline uses the available lookback boundary.");
  quality.push("This simple tally is an uncalibrated heuristic, not a probability model. Wage surprises are shown separately and excluded from the labour-count tally.");
  const sources=[
   {name:"Finance Calendar API (calendar, consensus, prior and actual where supplied)",url:"https://www.financecalendar.com/api/",status:"Automatic aggregator; attribution required"},
   {name:"U.S. Bureau of Labor Statistics — Employment Situation and data API",url:"https://www.bls.gov/",status:"Official payroll, unemployment and wage source; verify final values"},
   {name:"U.S. Department of Labor — weekly unemployment claims",url:"https://oui.doleta.gov/unemploy/claims.asp",status:"Official claims source"},
   {name:"U.S. Bureau of Labor Statistics — JOLTS",url:"https://www.bls.gov/jlt/",status:"Official job openings and labour turnover source"}
  ];
  res.json({ok:true,generatedAt:new Date().toISOString(),nextNfp:nextNfp?{date:nextNfp.date,title:nextNfp.title||nextNfp.name||nextNfp.series_name||"U.S. Employment Situation",status:nextNfp.status||"unknown",sourceUrl:nextNfp.source_url||"https://www.bls.gov/schedule/news_release/empsit.htm"}:null,previousNfp:previousNfp?{date:previousNfp.date,actual:safeText(previousNfp.actual),title:previousNfp.title||previousNfp.name}:null,window:{from:previousNfp?.date||from,to:nextNfp?.date||to},outlook:{label,confidence,briefing,goldImpact,scoredReleases:scored,score},timeline:mapped.map(({_score,...e})=>e),quality,sources,attribution:data.attribution||{source:"financecalendar.com",url:"https://www.financecalendar.com/api/"}});
 } catch(e) {
  console.error("/api/nfp/outlook failed:",e?.message||"unknown");
  res.status(502).json({error:"Automatic NFP data request failed. Check upstream calendar availability and backend logs."});
 }
});

app.get("/",(_req,res)=>res.type("text").send("INKABI.21 AI backend is running. Use /api/health."));
app.listen(PORT,()=>console.log(`INKABI.21 backend listening on ${PORT}`));
