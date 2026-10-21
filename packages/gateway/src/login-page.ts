/**
 * login-page.ts — 用户名/密码登录页（内联纯 HTML/CSS/JS，零外部资源）。
 */
export function loginPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rdsh 登录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0f172a; color: #e2e8f0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  main { width: 100%; max-width: 340px; text-align: center; }
  .logo { font-size: 40px; font-weight: 800; color: #38bdf8; letter-spacing: 1px; }
  .hint { margin: 16px 0 24px; color: #94a3b8; font-size: 14px; line-height: 1.6; }
  label { display: block; text-align: left; color: #94a3b8; font-size: 13px; margin: 12px 0 6px; }
  input {
    width: 100%; padding: 12px; font-size: 16px;
    background: #1e293b; color: #f1f5f9; border: 1px solid #334155; border-radius: 10px;
    outline: none;
  }
  input:focus { border-color: #38bdf8; }
  button {
    width: 100%; margin-top: 18px; padding: 13px; font-size: 16px; font-weight: 600;
    background: #0284c7; color: #fff; border: 0; border-radius: 10px; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: wait; }
  .error { margin-top: 14px; color: #f87171; font-size: 14px; min-height: 20px; }
</style>
</head>
<body>
<main>
  <div class="logo">rdsh</div>
  <p class="hint">登录以访问 DeepSeek Harness 智能体。</p>
  <form id="login-form">
    <label for="name">用户名</label>
    <input id="name" name="name" autocomplete="username" autofocus required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit" id="submit">登录</button>
  </form>
  <p class="error" id="error" hidden></p>
</main>
<script>
  const form = document.getElementById("login-form");
  const nameInput = document.getElementById("name");
  const passInput = document.getElementById("password");
  const submit = document.getElementById("submit");
  const error = document.getElementById("error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameInput.value.trim(), password: passInput.value }),
      });
      if (res.ok) { location.href = "/"; return; }
      if (res.status === 429) {
        const secs = Number(res.headers.get("Retry-After") || 600);
        error.textContent = "尝试次数过多，请 " + Math.ceil(secs / 60) + " 分钟后再试";
      } else {
        error.textContent = "用户名或密码错误";
      }
      error.hidden = false;
    } catch {
      error.textContent = "网络错误，请重试";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      passInput.select();
    }
  });
</script>
</body>
</html>`;
}
