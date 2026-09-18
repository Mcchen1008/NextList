import { createSignal } from "solid-js"

/**
 * 安装向导状态（供 App 路由守卫与 /install 页面共享）：
 *   null  = 未知（后端状态尚未返回）
 *   true  = 全新实例，需要进入 /install
 *   false = 已完成安装，/install 自动跳回主页
 */
const [installRequired, setInstallRequired] = createSignal<boolean | null>(null)

export { installRequired, setInstallRequired }
