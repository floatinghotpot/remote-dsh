/**
 * pair-page.ts — 配对页（内联纯 HTML/CSS/JS，零外部资源）。
 * 文案引导用户在开发机终端查看配对码（物理信任锚点）。
 */
export function pairPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rdsh 配对</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0f172a; color: #e2e8f0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  main { width: 100%; max-width: 360px; text-align: center; }
  .logo { font-size: 40px; font-weight: 800; color: #38bdf8; letter-spacing: 1px; }
  .hint { margin: 16px 0 24px; color: #94a3b8; font-size: 14px; line-height: 1.6; }
  code { background: #1e293b; padding: 2px 6px; border-radius: 4px; color: #7dd3fc; }
  input {
    width: 100%; padding: 14px; font-size: 24px; text-align: center; letter-spacing: 8px;
    background: #1e293b; color: #f1f5f9; border: 1px solid #334155; border-radius: 10px;
    outline: none;
  }
  input:focus { border-color: #38bdf8; }
  button {
    width: 100%; margin-top: 12px; padding: 14px; font-size: 16px; font-weight: 600;
    background: #0284c7; color: #fff; border: 0; border-radius: 10px; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: wait; }
  .error { margin-top: 14px; color: #f87171; font-size: 14px; }
</style>
</head>
<body>
<main>
  <div class="logo">rdsh</div>
  <p class="hint">在<strong>开发机终端</strong>查看配对码（运行 <code>rdsh serve</code> 的窗口），输入后即可访问 DeepSeek Harness。</p>
  <form id="pair-form">
    <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
           placeholder="6 位配对码" autofocus aria-label="配对码">
    <button type="submit" id="submit">配对</button>
  </form>
  <p class="error" id="error" hidden></p>
</main>
<script>
  const form = document.getElementById("pair-form");
  const codeInput = document.getElementById("code");
  const submit = document.getElementById("submit");
  const error = document.getElementById("error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      const res = await fetch("/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeInput.value.trim() }),
      });
      if (res.ok) { location.href = "/"; return; }
      if (res.status === 429) {
        const secs = Number(res.headers.get("Retry-After") || 600);
        error.textContent = "尝试次数过多，请 " + Math.ceil(secs / 60) + " 分钟后再试";
      } else {
        error.textContent = "配对码错误，请重试";
      }
      error.hidden = false;
    } catch {
      error.textContent = "网络错误，请重试";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      codeInput.select();
    }
  });
</script>
</body>
</html>`;
}
