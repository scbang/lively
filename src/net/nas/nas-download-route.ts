// NAS 파일 내려받기·올리기 — 사람의 브라우저(세션 쿠키)와 그 사람의 AI 세션(Bearer, lively_local_nas_pull·push) 둘 다 받는다.
//
//  AI 가 본문까지 읽는 것은 의도다 — 구성원이 자기 FTP 계정으로 열 수 있는 파일은 그 구성원의 AI 세션도 연다.
//   볼 수 있는 범위는 그 구성원 본인 FTP 계정의 폴더 권한이 정한다(nas-access.ts — 공용·남의 계정 폴백 없음).
//  ⚠ 받은 본문은 AI 세션과 그 모델 제공자에게 넘어간다. 본문 반출을 막아야 하는 조직이면 이 경로의 Bearer 허용이 검토 대상이다.
import type express from "express";
import { createHash } from "node:crypto";
import { sessionOrBearer } from "../../auth/http-auth.js";
import type { BearerVerifier } from "../../auth/bearer.js";
import type { LivelyUser } from "../../context.js";
import { logger } from "../../log.js";
import { randomBytes } from "node:crypto";
import { decodeRawPath, isSafeRawPath, displayPath, childRawPath, encodeRawPath } from "../ftp/ftp-list.js";
import { NasConfigError, openNasSession, NAS_DOWNLOAD_PATH, NAS_UPLOAD_PATH, nasIndexCache, nasIndexKey } from "./nas-access.js";
import { FtpError } from "../ftp/ftp-client.js";

// 파일명에 고객 이름이 흔해 경로 원문은 로그에 남기지 않는다. 같은 파일인지는 해시로 대조한다.
const hashPath = (raw: string): string => createHash("sha256").update(raw, "latin1").digest("hex").slice(0, 16);

export function contentDisposition(display: string): string {
  const base = display.slice(display.lastIndexOf("/") + 1) || "download";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // RFC 5987 attr-char 밖인 ! ' ( ) * 도 퍼센트 인코딩한다(encodeURIComponent 가 남기는 문자들)
  const ext = encodeURIComponent(base).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

// nas_find·nas_list 와 같은 권한(context) — 목록은 못 보는 토큰이 본문을 받거나 올리는 일이 없게. 실패면 응답을 보내고 null.
function nasCaller(req: express.Request, res: express.Response): { user: LivelyUser; via: "agent" | "browser" } | null {
  const user = (req.auth?.extra ?? null) as LivelyUser | null;
  if (!user?.userId) { res.status(401).json({ error: "라이블리 인증이 필요합니다" }); return null; }
  if (!Array.isArray(user.scopes) || !user.scopes.includes("context")) {
    res.status(403).json({ error: "이 토큰으로는 NAS 파일을 다룰 수 없습니다(context 권한 필요)" });
    return null;
  }
  return { user, via: req.auth?.token ? "agent" : "browser" };
}

export function registerNasDownloadRoute(app: express.Express, verifier: BearerVerifier): void {
  app.get(NAS_DOWNLOAD_PATH, sessionOrBearer(verifier), (req, res) => {
    void (async () => {
      const who = nasCaller(req, res);
      if (!who) return;
      const { user, via } = who;
      const raw = decodeRawPath(String(req.query.p ?? ""));
      if (!raw || !isSafeRawPath(raw)) { res.status(400).json({ error: "파일 경로가 올바르지 않습니다" }); return; }
      const shown = displayPath(raw);

      let opened: Awaited<ReturnType<typeof openNasSession>>;
      try {
        opened = await openNasSession(user.userId);
      } catch (e) {
        const status = e instanceof NasConfigError ? e.status : 502;
        if (!(e instanceof NasConfigError)) logger.warn({ err: e, member: user.userId }, "[nas] 내려받기 접속 실패");
        res.status(status).json({ error: e instanceof NasConfigError ? e.message : "NAS 에 접속하지 못했습니다" });
        return;
      }
      const { session, username } = opened;
      let clientGone = false;
      let current: { destroy(err?: Error): void } | null = null;
      // retr 가 끝나기 전에 끊겨도 스트림을 닫을 수 있게 먼저 듣는다
      res.on("close", () => {
        if (res.writableFinished) return;
        clientGone = true;
        current?.destroy(new Error("내려받는 쪽이 연결을 끊었습니다"));
      });
      try {
        const { stream, done } = await session.retr(raw);
        current = stream;
        if (clientGone) stream.destroy(new Error("내려받는 쪽이 연결을 끊었습니다"));
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", contentDisposition(shown));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        // 접근 기록이다 — NAS 가 파일을 연(RETR 150) 시점에 늘 남긴다. 사람이 중간에 취소했는지는 끝에 따로 남긴다.
        logger.info({ member: user.userId, ftpUser: username, via, pathHash: hashPath(raw) }, "[nas] 파일 내려받기");
        stream.pipe(res);
        await done;
        if (clientGone) logger.info({ member: user.userId, pathHash: hashPath(raw) }, "[nas] 내려받기 취소");
      } catch (e) {
        // 사람이 받다가 취소한 것은 경고가 아니다. 오류 원문은 서버 응답 문구를 담을 수 있어 이름·코드만 남긴다.
        const brief = { name: e instanceof Error ? e.name : "unknown", code: e instanceof FtpError ? e.code : null, fatal: e instanceof FtpError ? e.fatal : null };
        if (clientGone) logger.info({ member: user.userId, pathHash: hashPath(raw) }, "[nas] 내려받기 취소");
        else if (!(e instanceof FtpError && e.code === 550)) logger.warn({ ...brief, member: user.userId, pathHash: hashPath(raw) }, "[nas] 내려받기 실패");
        if (!res.headersSent) res.status(404).json({ error: "파일을 열지 못했습니다(없거나 내 계정으로 열 수 없습니다)" });
        else res.destroy();
      } finally {
        await session.close();
      }
    })().catch((e) => {
      logger.warn({ err: e }, "[nas] 내려받기 처리 실패");
      if (!res.headersSent) res.status(500).json({ error: "내려받기 처리 실패" });
    });
  });

  // 올리기 — 먼저 같은 폴더의 임시 이름으로 받고 다 받은 뒤 제 이름으로 옮긴다. 전송이 끊겨도 반쪽 파일이 제 이름으로 남지 않게.
  //  덮기(overwrite=1)가 아니면 같은 이름이 있을 때 409 와 그 크기를 돌려준다(받는 쪽이 «이미 올림»을 가를 수 있게).
  app.put(NAS_UPLOAD_PATH, sessionOrBearer(verifier), (req, res) => {
    void (async () => {
      const who = nasCaller(req, res);
      if (!who) { req.resume(); return; }
      const { user, via } = who;
      const dir = decodeRawPath(String(req.query.dir ?? ""));
      const target = dir ? childRawPath(dir, String(req.query.name ?? "")) : null;
      if (!target) { req.resume(); res.status(400).json({ error: "올릴 폴더(dir)나 이름(name)이 올바르지 않습니다" }); return; }
      const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
      const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);

      let opened: Awaited<ReturnType<typeof openNasSession>>;
      try {
        opened = await openNasSession(user.userId);
      } catch (e) {
        req.resume();
        const status = e instanceof NasConfigError ? e.status : 502;
        if (!(e instanceof NasConfigError)) logger.warn({ err: e, member: user.userId }, "[nas] 올리기 접속 실패");
        res.status(status).json({ error: e instanceof NasConfigError ? e.message : "NAS 에 접속하지 못했습니다" });
        return;
      }
      const { session, username } = opened;
      const temp = childRawPath(dir!, `.${randomBytes(6).toString("hex")}.lively-upload`)!;
      let stored = false;
      try {
        const existing = await session.size(target);
        if (existing !== null && !overwrite) {
          req.resume();
          res.status(409).json({ error: "같은 이름의 파일이 있습니다", exists: true, size: existing, path: displayPath(target), p: encodeRawPath(target) });
          return;
        }
        const bytes = await session.stor(temp, req);
        stored = true;
        if (declared !== null && Number.isFinite(declared) && bytes !== declared) throw new Error(`받은 바이트(${bytes})가 선언(${declared})과 다릅니다`);
        await session.rename(temp, target);
        stored = false;
        nasIndexCache.markStale(nasIndexKey(user.userId, username));
        logger.info({ member: user.userId, ftpUser: username, via, pathHash: hashPath(target), bytes, overwritten: existing !== null }, "[nas] 파일 올리기");
        res.json({ path: displayPath(target), p: encodeRawPath(target), size: bytes, overwritten: existing !== null });
      } catch (e) {
        req.resume();
        const brief = { name: e instanceof Error ? e.name : "unknown", code: e instanceof FtpError ? e.code : null, fatal: e instanceof FtpError ? e.fatal : null };
        logger.warn({ ...brief, member: user.userId, via, pathHash: hashPath(target) }, "[nas] 올리기 실패");
        if (!res.headersSent) {
          const denied = e instanceof FtpError && (e.code === 550 || e.code === 553);
          res.status(denied ? 403 : 502).json({ error: denied ? "그 폴더에 올릴 수 없습니다(없거나 내 계정에 쓰기 권한이 없습니다)" : "올리지 못했습니다" });
        }
      } finally {
        await session.close();
        // 임시 파일을 남겼으면 새 세션으로 치운다(실패한 세션은 이미 닫혔을 수 있다)
        if (stored) {
          openNasSession(user.userId).then(async ({ session: s2 }) => { try { await s2.dele(temp); } finally { await s2.close(); } })
            .catch((e) => logger.warn({ err: e instanceof Error ? e.name : "unknown", member: user.userId }, "[nas] 올리기 임시 파일 정리 실패"));
        }
      }
    })().catch((e) => {
      logger.warn({ err: e }, "[nas] 올리기 처리 실패");
      if (!res.headersSent) res.status(500).json({ error: "올리기 처리 실패" });
    });
  });
}
