/**
 * AuthManager — manages Cognito token lifecycle for the MCP server.
 *
 * Token acquisition priority:
 *   1. Use the ID token from env if it's still valid
 *   2. Refresh silently using the refresh token (valid 7 days)
 *   3. Open the browser to the Cognito hosted UI for interactive login
 *
 * After a browser login, the refresh token is persisted to a local file
 * so subsequent MCP restarts can refresh silently without re-prompting.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

interface TokenSet {
  idToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
}

const TOKEN_CACHE_DIR = join(
  process.env.HOME ?? "/tmp",
  ".kiro-flock-feed"
);
const TOKEN_CACHE_FILE = join(TOKEN_CACHE_DIR, "token-cache.json");

export class AuthManager {
  private cognitoDomain: string;
  private clientId: string;
  private userPoolId: string;
  private region: string;
  private awsProfile: string | undefined;

  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0; // epoch ms

  constructor(opts: {
    cognitoDomain: string;
    clientId: string;
    userPoolId: string;
    region: string;
    awsProfile?: string;
    initialIdToken?: string;
    initialRefreshToken?: string;
  }) {
    this.cognitoDomain = opts.cognitoDomain;
    this.clientId = opts.clientId;
    this.userPoolId = opts.userPoolId;
    this.region = opts.region;
    this.awsProfile = opts.awsProfile;

    if (opts.initialIdToken) {
      const exp = decodeTokenExpiry(opts.initialIdToken);
      if (exp > Date.now()) {
        this.idToken = opts.initialIdToken;
        this.expiresAt = exp;
      }
    }
    if (opts.initialRefreshToken) {
      this.refreshToken = opts.initialRefreshToken;
    }
  }

  /**
   * Returns a valid ID token, refreshing or re-authenticating as needed.
   */
  async getToken(): Promise<string> {
    // 1. Current token still valid (with 60s buffer)
    if (this.idToken && this.expiresAt > Date.now() + 60_000) {
      return this.idToken;
    }

    // 2. Try loading cached refresh token from disk
    if (!this.refreshToken) {
      this.refreshToken = await this.loadCachedRefreshToken();
    }

    // 3. Try silent refresh
    if (this.refreshToken) {
      const refreshed = await this.tryRefresh(this.refreshToken);
      if (refreshed) {
        this.idToken = refreshed.idToken;
        this.expiresAt = refreshed.expiresAt;
        if (refreshed.refreshToken) {
          this.refreshToken = refreshed.refreshToken;
        }
        await this.persistRefreshToken();
        return this.idToken;
      }
      // Refresh failed (token expired or revoked), clear it
      this.refreshToken = null;
    }

    // 4. Interactive browser login
    logAlways("Token expired. Opening browser for login...");
    const result = await this.browserLogin();
    this.idToken = result.idToken;
    this.expiresAt = result.expiresAt;
    if (result.refreshToken) {
      this.refreshToken = result.refreshToken;
    }
    await this.persistRefreshToken();
    return this.idToken;
  }

  // ── Silent refresh via AWS CLI ────────────────────────────────────────────

  private async tryRefresh(refreshToken: string): Promise<TokenSet | null> {
    // Pass the refresh token via a 0600 temp file (--cli-input-json) instead of
    // an inline --auth-parameters flag, and invoke the CLI with an argument
    // array (execFileSync, no shell). This keeps the secret out of the process
    // argv (visible to `ps`) and removes any shell-interpolation surface.
    let inputDir: string | null = null;
    try {
      log("Attempting silent token refresh...");
      inputDir = mkdtempSync(join(tmpdir(), "kff-auth-"));
      const inputPath = join(inputDir, "auth.json");
      writeFileSync(
        inputPath,
        JSON.stringify({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
        { mode: 0o600 },
      );

      const args = [
        "cognito-idp", "admin-initiate-auth",
        "--region", this.region,
        "--cli-input-json", `file://${inputPath}`,
        "--output", "json",
      ];
      if (this.awsProfile) args.push("--profile", this.awsProfile);

      const output = execFileSync("aws", args, { encoding: "utf-8", timeout: 15_000 });
      const parsed = JSON.parse(output);
      const authResult = parsed.AuthenticationResult;
      const newIdToken = authResult.IdToken as string;
      const exp = decodeTokenExpiry(newIdToken);

      log("Token refreshed successfully.");
      return {
        idToken: newIdToken,
        refreshToken: authResult.RefreshToken ?? refreshToken,
        expiresAt: exp,
      };
    } catch (err) {
      log(`Silent refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (inputDir) {
        try { rmSync(inputDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }

  // ── Browser-based login (Cognito hosted UI implicit flow) ─────────────────

  private browserLogin(): Promise<TokenSet> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost`);

        // Serve the callback page that extracts the fragment
        if (url.pathname === "/callback" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(CALLBACK_HTML);
          return;
        }

        // Receive the token from the callback page's POST
        if (url.pathname === "/token" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              const idToken = data.id_token as string;
              if (!idToken) throw new Error("No id_token in callback");

              const exp = decodeTokenExpiry(idToken);
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(SUCCESS_HTML);

              // Give the browser a moment to render, then shut down
              setTimeout(() => {
                srv.close();
                resolve({ idToken, refreshToken: null, expiresAt: exp });
              }, 500);
            } catch (err) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Bad request");
              srv.close();
              reject(err);
            }
          });
          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });

      // Listen on fixed port 19836 (registered in Cognito callback URLs)
      srv.listen(19836, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Could not determine server address"));
          return;
        }
        const port = addr.port;
        const redirectUri = `http://localhost:${port}/callback`;
        const loginUrl =
          `https://${this.cognitoDomain}/login` +
          `?client_id=${this.clientId}` +
          `&response_type=token` +
          `&scope=openid` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}`;

        log(`Login URL: ${loginUrl}`);
        log(`Waiting for browser login on http://localhost:${port} ...`);
        openBrowser(loginUrl);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        srv.close();
        reject(new Error("Browser login timed out after 5 minutes. Restart the MCP server to try again."));
      }, 5 * 60 * 1000);
    });
  }

  // ── Token cache persistence ───────────────────────────────────────────────

  private async persistRefreshToken(): Promise<void> {
    if (!this.refreshToken) return;
    try {
      await mkdir(dirname(TOKEN_CACHE_FILE), { recursive: true });
      const data = JSON.stringify({
        refreshToken: this.refreshToken,
        clientId: this.clientId,
        region: this.region,
        savedAt: new Date().toISOString(),
      });
      await writeFile(TOKEN_CACHE_FILE, data, { mode: 0o600 });
    } catch {
      // Non-fatal, just means next restart will need browser login
    }
  }

  private async loadCachedRefreshToken(): Promise<string | null> {
    try {
      const raw = await readFile(TOKEN_CACHE_FILE, "utf-8");
      const data = JSON.parse(raw);
      // Only use if it's for the same client
      if (data.clientId === this.clientId && data.refreshToken) {
        return data.refreshToken as string;
      }
    } catch {
      // No cache file or invalid
    }
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function decodeTokenExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString()
    );
    return (payload.exp as number) * 1000;
  } catch {
    return 0;
  }
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    // Pass the URL as a discrete argument (no shell), so it cannot be
    // interpreted as a shell command regardless of its contents.
    if (platform === "darwin") {
      execFileSync("open", [url]);
    } else if (platform === "win32") {
      // `start` is a cmd builtin; the empty "" is its title argument.
      execFileSync("cmd", ["/c", "start", "", url]);
    } else {
      execFileSync("xdg-open", [url]);
    }
  } catch {
    logAlways(`Could not open browser automatically. Open this URL manually:\n${url}`);
  }
}

function log(msg: string): void {
  if (process.env.FLOCK_DEBUG) {
    process.stderr.write(`[auth] ${msg}\n`);
  }
}

function logAlways(msg: string): void {
  process.stderr.write(`[auth] ${msg}\n`);
}

// ── Inline HTML for the callback flow ────────────────────────────────────────

const CALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>kiro-flock login</title></head>
<body>
<p>Completing login...</p>
<script>
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const idToken = params.get("id_token");
  if (idToken) {
    fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken })
    }).then(() => {
      document.body.innerHTML = "<h2>Login successful. You can close this tab.</h2>";
    });
  } else {
    document.body.innerHTML = "<h2>Login failed: no token received.</h2><pre>" +
      window.location.hash + "</pre>";
  }
</script>
</body></html>`;

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>kiro-flock</title></head>
<body><h2>&#10003; Login successful. You can close this tab.</h2></body></html>`;
