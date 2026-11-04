// NAS 파일 내려받기 — 사람의 브라우저(세션 쿠키)와 그 사람의 AI 세션(Bearer, lively_local_nas_pull) 둘 다 받는다.
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
import { decodeRawPath, isSafeRawPath, displayPath } from "../ftp/ftp-list.js";
import { NasConfigError, openNasSession, NAS_DOWNLOAD_PATH } from "./nas-access.js";
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

export function registerNasDownloadRoute(app: express.Express, verifier: BearerVerifier): void {
  app.get(NAS_DOWNLOAD_PATH, sessionOrBearer(verifier), (req, res) => {
    void (async () => {
      const user = (req.auth?.extra ?? null) as LivelyUser | null;
      const via = req.auth?.token ? "agent" : "browser";
      if (!user?.userId) {
        res.status(401).json({ error: "라이블리 인증이 필요합니다" });
        return;
      }
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
}
