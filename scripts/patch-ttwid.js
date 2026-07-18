import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetFile = path.join(__dirname, '..', 'node_modules', 'piratetok-live-js', 'dist', 'auth', 'ttwid.js');

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  if (!content.includes('Fallback 1: Try /explore')) {
    const searchStr = `        const resp = await fetch("https://www.tiktok.com/", fetchOpts);
        const setCookie = resp.headers.getSetCookie?.() ?? [];
        for (const cookie of setCookie) {
            const match = cookie.match(/^ttwid=([^;]+)/);
            if (match && match[1]) {
                return match[1];
            }
        }
        // Fallback: try raw set-cookie header
        const raw = resp.headers.get("set-cookie") ?? "";
        const fallback = raw.match(/ttwid=([^;]+)/);
        if (fallback && fallback[1]) {
            return fallback[1];
        }
        throw new Error(\`ttwid: no ttwid cookie in response (status \${resp.status})\`);`;

    const replacement = `        let resp = await fetch("https://www.tiktok.com/", fetchOpts);
        let setCookie = resp.headers.getSetCookie?.() ?? [];
        let ttwid = null;
        for (const cookie of setCookie) {
            const match = cookie.match(/^ttwid=([^;]+)/);
            if (match && match[1]) {
                ttwid = match[1];
                break;
            }
        }
        if (!ttwid) {
            const raw = resp.headers.get("set-cookie") ?? "";
            const fallback = raw.match(/ttwid=([^;]+)/);
            if (fallback && fallback[1]) {
                ttwid = fallback[1];
            }
        }

        // Fallback 1: Try /explore with redirects enabled (much higher success rate)
        if (!ttwid) {
            const fallbackOpts = {
                headers: { "User-Agent": ua },
                signal: controller.signal,
            };
            if (dispatcher) {
                fallbackOpts.dispatcher = dispatcher;
            }
            resp = await fetch("https://www.tiktok.com/explore", fallbackOpts);
            setCookie = resp.headers.getSetCookie?.() ?? [];
            for (const cookie of setCookie) {
                const match = cookie.match(/^ttwid=([^;]+)/);
                if (match && match[1]) {
                    ttwid = match[1];
                    break;
                }
            }
            if (!ttwid) {
                const raw = resp.headers.get("set-cookie") ?? "";
                const fallback = raw.match(/ttwid=([^;]+)/);
                if (fallback && fallback[1]) {
                    ttwid = fallback[1];
                }
            }
        }

        if (ttwid) {
            return ttwid;
        }
        throw new Error(\`ttwid: no ttwid cookie in response (status \${resp.status})\`);`;

    if (content.includes(searchStr)) {
      content = content.replace(searchStr, replacement);
      fs.writeFileSync(targetFile, content, 'utf8');
      console.log('✅ Patched piratetok-live-js ttwid cookie fetcher successfully.');
    }
  }
}
