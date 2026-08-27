/**
 * legal.tsx — 《用户协议》《隐私政策》《产品介绍》文档页。
 *
 * 内容来自 doc/saas/*.md，由 scripts/build-legal.mjs 在构建期转成静态 HTML
 * （生成 src/legal/generated.ts），此处只注入静态 HTML（dangerouslySetInnerHTML），
 * 生产环境不做运行时 markdown 渲染。
 */
import type React from "react";
import { LEGAL } from "./legal/generated.ts";

function StaticDoc({ html }: { html: string }): React.JSX.Element {
  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <a href="#" onClick={(e) => { e.preventDefault(); window.history.back(); }} style={{ color: "#2563eb", fontSize: 13 }}>← 返回</a>
      <div
        className="rdsh-legal"
        style={{ fontSize: 14, lineHeight: 1.7, color: "#333" }}
        // 内容为构建期生成、来源可信，非用户输入
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <style>{`.rdsh-legal h1{font-size:20px;margin:12px 0}.rdsh-legal h2{font-size:15px;margin:16px 0 6px}.rdsh-legal h3{font-size:14px;margin:12px 0 4px}.rdsh-legal p{margin:8px 0}.rdsh-legal ul{margin:8px 0;padding-left:20px}.rdsh-legal li{margin:4px 0}.rdsh-legal code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px}.rdsh-legal a{color:#2563eb}.rdsh-legal blockquote{color:#999;border-left:3px solid #e5e7eb;padding-left:12px;margin:12px 0}`}</style>
    </div>
  );
}

export function TermsPage(): React.JSX.Element {
  return <StaticDoc html={LEGAL.terms} />;
}

export function PrivacyPage(): React.JSX.Element {
  return <StaticDoc html={LEGAL.privacy} />;
}

export function ProductPage(): React.JSX.Element {
  return <StaticDoc html={LEGAL.product} />;
}
