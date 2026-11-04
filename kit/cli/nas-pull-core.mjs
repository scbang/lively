// NAS 파일·폴더를 세션이 도는 기계의 폴더로 내려받는다 — lively-mcp-local.mjs 의 lively_local_nas_pull 본체.
//  게이트웨이의 nas_list(폴더 목록)·/api/ui/me/nas/file(내려받기)을 그 구성원 토큰으로 부른다. 볼 수 있는 범위는 게이트웨이가
//  그 구성원 본인 FTP 계정으로 정한다 — 여기선 권한을 판단하지 않는다.
//
//  · 받는 자리는 홈 아래만이다. 상대 경로는 ~/NAS사본 기준이다. 웹 세션의 작업 폴더(프로젝트 공유폴더)는 같은 프로젝트의
//    다른 구성원도 보는 자리라, 거기에 받으면 그 사람의 NAS 권한 밖 파일이 넘어간다.
//  · MCP 호출은 하네스를 붙잡는 동기 호출이라(lively-mcp-local.mjs 머리말) 한 번에 budgetMs 만 받고 멈춘다.
//    이미 같은 크기로 받은 파일은 건너뛰므로 같은 호출을 다시 부르면 이어서 받는다.
import { mkdirSync, statSync, renameSync, unlinkSync, createWriteStream, realpathSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename, isAbsolute, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_BUDGET_MS = 50_000;
export const MAX_FILES = 3000;
export const MAX_DIRS = 2000;
export const DEFAULT_DEST_DIR = "NAS사본";

/** 서버가 준 이름 한 마디를 이 기계의 파일 이름으로. 경로 구분자·윈도우 금지 문자·제어문자는 _ 로, . 과 .. 은 거부(null). */
export function safeSegment(name) {
  const s = String(name ?? "").normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "");
  if (!s || s === "." || s === "..") return null;
  return s;
}

/** 사람이 읽는 NAS 경로를 마디로. 빈 마디는 버린다. */
const segmentsOf = (displayPath) => String(displayPath ?? "").split("/").filter(Boolean);

/** 사람이 읽는 경로(UTF-8)를 게이트웨이의 p 로 — 서버 encodeRawPath(base64url of 원본 바이트)와 같은 꼴. */
export const pOfPath = (path) => Buffer.from(String(path).startsWith("/") ? String(path) : `/${path}`, "utf8").toString("base64url");

/**
 * 받을 자리를 정한다. 상대 경로는 home/NAS사본 기준, 절대 경로는 그대로. 결과가 home 밖이면 거부한다.
 *  home 이 심볼릭 링크일 수 있어(맥 /Users → /private/...) 실제 경로로 비교한다.
 */
export function resolveDest(dest, home) {
  const homeReal = realpathSync(home);
  const base = join(homeReal, DEFAULT_DEST_DIR);
  const raw = dest ? (isAbsolute(dest) ? resolve(dest) : resolve(base, dest)) : base;
  // 아직 없는 경로는 가장 가까운 존재 조상을 realpath 로 풀어 비교한다(심볼릭 링크로 홈 밖을 가리키는 경우를 잡는다)
  let probe = raw, tail = "";
  while (!existsSync(probe)) { const up = dirname(probe); if (up === probe) break; tail = tail ? join(basename(probe), tail) : basename(probe); probe = up; }
  const real = tail ? join(realpathSync(probe), tail) : realpathSync(probe);
  if (real !== homeReal && !real.startsWith(homeReal + sep)) {
    throw new Error(`받을 폴더는 홈(${homeReal}) 아래만 됩니다: ${raw}`);
  }
  if (real === homeReal) throw new Error("홈 폴더 자체에는 받지 않습니다 — 하위 폴더를 지정하세요");
  return real;
}

/**
 * targets 를 펼쳐 받을 파일 목록을 만든다. 폴더는 그 폴더 이름부터 아래 구조를 그대로 둔다.
 *  listDir(p) → { items: [{ path, type, size, p }] } (게이트웨이 nas_list 응답). 폴더 하나를 못 읽어도 나머지는 계속한다.
 */
export async function planFiles(targets, listDir, { maxFiles = MAX_FILES, maxDirs = MAX_DIRS } = {}) {
  const files = [], failed = [];
  let truncated = null, dirs = 0;
  for (const t of targets) {
    const rootSegs = segmentsOf(t.path);
    const keep = rootSegs.length ? rootSegs.length - 1 : 0; // 대상 자신의 이름부터 남긴다
    const rel = (path) => segmentsOf(path).slice(keep);
    if (t.type === "file") { files.push({ p: t.p, path: t.path, size: t.size ?? null, rel: rel(t.path) }); continue; }
    const queue = [{ p: t.p, path: t.path }];
    while (queue.length) {
      if (dirs >= maxDirs) { truncated = `폴더 ${maxDirs}개 상한`; break; }
      const d = queue.shift();
      dirs++;
      let listing;
      try { listing = await listDir(d.p); }
      catch (e) { failed.push({ path: d.path, error: String(e?.message ?? e) }); continue; }
      for (const it of listing.items ?? []) {
        if (it.type === "dir") queue.push({ p: it.p, path: it.path });
        else if (it.type === "file") {
          if (files.length >= maxFiles) { truncated = `파일 ${maxFiles}개 상한`; break; }
          files.push({ p: it.p, path: it.path, size: it.size ?? null, rel: rel(it.path) });
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { files, failed, truncated, dirs };
}

/**
 * 계획대로 받는다. download(p) → Response(본문 스트림). 같은 크기 파일이 있으면 건너뛰고, 받는 중엔 .part 에 쓰고 끝나면 옮긴다.
 *  now 는 시계(테스트 주입용). budgetMs 를 넘기면 남은 파일을 remaining 으로 돌려준다.
 */
export async function pullFiles(files, destRoot, download, { budgetMs = DEFAULT_BUDGET_MS, now = Date.now } = {}) {
  const started = now();
  const out = { downloaded: [], skipped: 0, failed: [], remaining: 0, bytes: 0 };
  for (let i = 0; i < files.length; i++) {
    if (now() - started > budgetMs) { out.remaining = files.length - i; break; }
    const f = files[i];
    const segs = f.rel.map(safeSegment);
    if (!segs.length || segs.some((s) => s === null)) { out.failed.push({ path: f.path, error: "이 기계에 쓸 수 없는 이름" }); continue; }
    const target = join(destRoot, ...segs);
    try {
      const st = statSync(target, { throwIfNoEntry: false });
      if (st?.isFile() && f.size !== null && st.size === f.size) { out.skipped++; continue; }
      const res = await download(f.p);
      if (!res.ok) { out.failed.push({ path: f.path, error: `게이트웨이 ${res.status}` }); continue; }
      mkdirSync(dirname(target), { recursive: true });
      const part = `${target}.part`;
      try {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
        renameSync(part, target);
      } catch (e) {
        try { unlinkSync(part); } catch { /* 이미 없음 */ }
        throw e;
      }
      const size = statSync(target).size;
      out.bytes += size;
      out.downloaded.push(target);
    } catch (e) {
      out.failed.push({ path: f.path, error: String(e?.message ?? e) });
    }
  }
  return out;
}

/**
 * MCP 도구 본체. ctx 는 lively-mcp-local.mjs makeCtx 의 것(api·gateway·token), fetchImpl 은 그 파일의 fetch.
 *  args: { targets?: [{p, type?, path?, size?}], path?: string, dest?: string }
 */
export async function nasPull(ctx, args, { home, fetchImpl, budgetMs = DEFAULT_BUDGET_MS, now = Date.now } = {}) {
  const destRoot = resolveDest(args.dest, home);
  const listDir = (p) => ctx.api(`/api/ui/me/nas/list?p=${encodeURIComponent(p)}`, { timeoutMs: 60_000 });
  let targets = Array.isArray(args.targets) ? args.targets.filter((t) => t && typeof t.p === "string" && t.p) : [];
  if (!targets.length && args.path) targets = [{ p: pOfPath(args.path), path: String(args.path) }];
  if (!targets.length) throw new Error("받을 대상이 없습니다 — nas_find·nas_list 결과의 p 를 targets 로, 또는 path 를 주세요");
  // type 을 모르면 폴더로 열어 보고, 열리지 않으면 파일로 본다(nas_list 는 파일 경로에 404 를 준다)
  const typed = [];
  for (const t of targets) {
    if (t.type === "file" || t.type === "dir") { typed.push({ ...t, path: t.path ?? null }); continue; }
    try { const l = await listDir(t.p); typed.push({ ...t, type: "dir", path: t.path ?? l.path }); }
    catch { typed.push({ ...t, type: "file" }); }
  }
  // 경로를 모르는 대상은 이름을 정할 수 없어 받지 않는다(nas_find·nas_list 의 항목을 그대로 넘기면 path 가 있다)
  const named = typed.filter((t) => t.path);
  const unnamed = typed.length - named.length;
  const plan = await planFiles(named, listDir);
  const download = (p) => fetchImpl(`${ctx.gateway}/api/ui/me/nas/file?p=${encodeURIComponent(p)}`, { headers: { authorization: `Bearer ${ctx.token}` } });
  const r = await pullFiles(plan.files, destRoot, download, { budgetMs, now });
  return {
    dest: destRoot,
    done: r.remaining === 0 && !plan.truncated,
    planned: plan.files.length,
    downloaded: r.downloaded.length,
    skipped: r.skipped,
    remaining: r.remaining,
    bytes: r.bytes,
    truncated: plan.truncated,
    failed: [...plan.failed, ...r.failed, ...(unnamed ? [{ path: null, error: `경로(path)를 모르는 대상 ${unnamed}개는 건너뜀` }] : [])].slice(0, 50),
    files: r.downloaded.slice(0, 100),
    note: r.remaining
      ? `시간 한도로 ${r.remaining}개가 남았습니다. 같은 호출을 다시 하면 받은 파일은 건너뛰고 이어서 받습니다.`
      : "받은 파일은 dest 아래에 NAS 폴더 구조 그대로 있습니다. 내용은 그 파일을 직접 열어 보세요.",
  };
}
