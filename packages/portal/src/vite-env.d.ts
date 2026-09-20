// portal 的浏览器侧类型声明（**不引 vite/client**：它会把 vite 的类型图带进来，
// 而 vite 的 peer 依赖里有 @types/node ⇒ Node 全局又会对浏览器代码可见）。
// 需要新的资源类型（图片/字体等）时在这里补一条 `declare module "*.xxx";`。
declare module "*.css";
