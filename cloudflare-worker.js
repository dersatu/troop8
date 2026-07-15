// Cloudflare Worker: shared newsletter draft (KV) + scheduled publish/reset + manual publish.
// Deploy this in the Cloudflare dashboard (Workers & Pages -> your worker -> Edit Code).
//
// Required secrets (Settings -> Variables -> add as "Secret", not plain text):
//   GITHUB_TOKEN          - a GitHub fine-grained personal access token scoped to
//                            ONLY the troop8 repo, with "Contents: Read and write" permission
//   EDITOR_PASSWORD_HASH  - the SHA-256 hex hash of the editor password
//                            (same value used in newsletter/editor.html and newsletter/index.html)
//
// Required binding (Settings -> Variables -> KV Namespace Bindings):
//   DRAFT_KV              - bind to a KV namespace (e.g. "NEWSLETTER_DRAFT")
//
// Required Cron Triggers (Settings -> Trigger events -> Add -> Cron Trigger):
//   0 0 * * 1   - Sunday 8:00 PM Eastern (EDT) -> publishes the current draft live
//   0 12 * * 2  - Tuesday 8:00 AM Eastern (EDT) -> resets the draft for the next week
//   NOTE: Cloudflare Cron Triggers run on fixed UTC time with no DST awareness.
//   These two times are based on EDT (daylight saving, roughly mid-March to early
//   November, which covers most of the school year). During EST (standard time,
//   November-March) both triggers will actually fire one hour earlier local time
//   (7:00 PM / 7:00 AM ET) since the UTC time doesn't shift with the clock change.

const OWNER = "dersatu";
const REPO = "troop8";
const FILE_PATH = "newsletter/data.json";
const BRANCH = "main";
const ALLOWED_ORIGIN = "https://troop8-chatham.org";
const DRAFT_KEY = "draft";

const EMPTY_DRAFT = {
  displayDate: "",
  splName: "",
  splMessage: "",
  topOfMind: [],
  serviceProjects: [],
  spotlights: [],
  announcements: [],
};

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Editor-Password",
  };
}

function jsonResponse(body, status){
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

async function sha256Hex(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text || ""));
  return Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2, "0"); }).join("");
}

async function checkPassword(password, env){
  const hash = await sha256Hex(password);
  return hash === env.EDITOR_PASSWORD_HASH;
}

function toBase64(str){
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for(let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function githubHeaders(env){
  return {
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "troop8-newsletter-worker",
  };
}

function apiBase(){
  return "https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH;
}

// atob() decodes base64 into a "binary string" (one byte per char code), which is
// wrong for UTF-8 content with multi-byte characters (curly quotes, em dashes, etc.)
// — treating it as text directly produces mojibake. Re-decode the raw bytes as UTF-8.
function base64ToUtf8(base64){
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// Reads the live published newsletter/data.json from GitHub. Used to seed the
// draft the first time KV is empty, so there's no manual seeding step.
async function fetchLivePublishedData(env){
  const res = await fetch(apiBase() + "?ref=" + BRANCH, { headers: githubHeaders(env) });
  if(!res.ok) return null;
  const file = await res.json();
  const content = base64ToUtf8(file.content.replace(/\n/g, ""));
  try {
    return JSON.parse(content);
  } catch(err){
    return null;
  }
}

async function getDraft(env){
  const stored = await env.DRAFT_KV.get(DRAFT_KEY, "json");
  if(stored) return stored;
  const seed = (await fetchLivePublishedData(env)) || EMPTY_DRAFT;
  await env.DRAFT_KV.put(DRAFT_KEY, JSON.stringify(seed));
  return seed;
}

async function saveDraft(env, draft){
  await env.DRAFT_KV.put(DRAFT_KEY, JSON.stringify(draft));
}

const VALID_SECTIONS = ["displayDate", "splName", "splMessage", "topOfMind", "serviceProjects", "spotlights", "announcements"];

async function publishDraftToGitHub(env, draft){
  const getRes = await fetch(apiBase() + "?ref=" + BRANCH, { headers: githubHeaders(env) });
  if(!getRes.ok){
    return { ok: false, error: "Failed to read current file", detail: await getRes.text() };
  }
  const currentFile = await getRes.json();
  const newContent = JSON.stringify(draft, null, 2) + "\n";

  const putRes = await fetch(apiBase(), {
    method: "PUT",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Publish newsletter — " + (draft.displayDate || new Date().toISOString()),
      content: toBase64(newContent),
      sha: currentFile.sha,
      branch: BRANCH,
    }),
  });

  if(!putRes.ok){
    return { ok: false, error: "Failed to publish to GitHub", detail: await putRes.text() };
  }
  return { ok: true };
}

function buildResetDraft(draft){
  return {
    displayDate: "",
    splName: "",
    splMessage: "",
    topOfMind: draft.topOfMind || [],
    serviceProjects: draft.serviceProjects || [],
    spotlights: [],
    announcements: draft.announcements || [],
  };
}

async function handleGetDraft(request, env){
  const password = request.headers.get("X-Editor-Password");
  if(!(await checkPassword(password, env))){
    return jsonResponse({ error: "Incorrect password" }, 401);
  }
  const draft = await getDraft(env);
  return jsonResponse({ draft: draft });
}

async function handleSaveSection(request, env){
  let body;
  try {
    body = await request.json();
  } catch(err){
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if(!(await checkPassword(body.password, env))){
    return jsonResponse({ error: "Incorrect password" }, 401);
  }
  if(!VALID_SECTIONS.includes(body.section)){
    return jsonResponse({ error: "Unknown section: " + body.section }, 400);
  }

  const draft = await getDraft(env);
  draft[body.section] = body.value;
  await saveDraft(env, draft);
  return jsonResponse({ success: true, draft: draft });
}

async function handlePublishNow(request, env){
  let body;
  try {
    body = await request.json();
  } catch(err){
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if(!(await checkPassword(body.password, env))){
    return jsonResponse({ error: "Incorrect password" }, 401);
  }

  const draft = await getDraft(env);
  const result = await publishDraftToGitHub(env, draft);
  if(!result.ok){
    return jsonResponse({ error: result.error, detail: result.detail }, 502);
  }
  return jsonResponse({ success: true });
}

// Cron entry point. `cronExpr` is passed in explicitly (rather than reading
// event.cron directly) so this logic can be unit-tested outside of a real
// scheduled event.
async function runScheduled(cronExpr, env){
  const draft = await getDraft(env);

  if(cronExpr === "0 0 * * 1"){
    // Sunday 8:00 PM ET (EDT) -> publish whatever's been collected.
    return publishDraftToGitHub(env, draft);
  }

  if(cronExpr === "0 12 * * 2"){
    // Tuesday 8:00 AM ET (EDT) -> reset for the next week.
    const reset = buildResetDraft(draft);
    await saveDraft(env, reset);
    return { ok: true };
  }

  return { ok: false, error: "Unrecognized cron expression: " + cronExpr };
}

export default {
  async fetch(request, env){
    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if(request.method === "GET" && url.pathname === "/draft"){
      return handleGetDraft(request, env);
    }
    if(request.method === "POST" && url.pathname === "/section"){
      return handleSaveSection(request, env);
    }
    if(request.method === "POST" && (url.pathname === "/publish-now" || url.pathname === "/")){
      // "/" kept for backwards compatibility with the original single-shot publish endpoint.
      return handlePublishNow(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx){
    ctx.waitUntil(runScheduled(event.cron, env));
  },
};
