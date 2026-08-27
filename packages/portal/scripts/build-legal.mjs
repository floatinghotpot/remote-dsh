/**
 * build-legal.mjs — 构建期把 doc/saas/*.md 转成静态 HTML，生成 src/legal/generated.ts。
 *
 * 目的：生产环境不做运行时 markdown 渲染（性能），构建时一次性转 HTML，portal 只注入静态 HTML。
 * 支持：#/##/### 标题、- 列表、段落、> 引用、`code`、[text](url) 链接。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const mdDir = join(repoRoot, "doc", "saas");
const outFile = join(__dirname, "..", "src", "legal", "generated.ts");

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

function mdToHtml(md) {
  const lines = md.split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("### ")) { html += `<h3>${inline(line.slice(4))}</h3>\n`; i++; continue; }
    if (line.startsWith("## ")) { html += `<h2>${inline(line.slice(3))}</h2>\n`; i++; continue; }
    if (line.startsWith("# ")) { html += `<h1>${inline(line.slice(2))}</h1>\n`; i++; continue; }
    if (line.startsWith("> ")) { html += `<blockquote>${inline(line.slice(2))}</blockquote>\n`; i++; continue; }
    if (line.startsWith("- ")) {
      html += "<ul>\n";
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        html += `  <li>${inline(lines[i].trim().slice(2))}</li>\n`;
        i++;
      }
      html += "</ul>\n";
      continue;
    }
    html += `<p>${inline(line)}</p>\n`;
    i++;
  }
  return html;
}

const out = {};
for (const key of ["terms", "privacy", "product"]) {
  out[key] = mdToHtml(readFileSync(join(mdDir, `${key}.md`), "utf8"));
}

mkdirSync(dirname(outFile), { recursive: true });
const content = `// 由 scripts/build-legal.mjs 生成，勿手改。\nexport const LEGAL: Record<string, string> = ${JSON.stringify(out, null, 2)};\n`;
writeFileSync(outFile, content);
console.log(`build-legal: generated ${outFile} (terms/privacy/product)`);
