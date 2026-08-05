/**
 * 特性注册表 — 插件式侧边栏系统
 *
 * 新增功能只需:
 *   1. 在 features/<name>/ 下写组件（或复用现有 components/ 文件）
 *   2. 在此文件中 registerFeature()
 *   3. ActivityBar 自动出现图标，SidePanel 自动渲染
 */

import type { LucideIcon } from "lucide-react";
import type { FC } from "react";
import { Search, Server, Folder, Network, Settings, FileText, Sparkles, Terminal } from "lucide-react";
import { KeyRound } from "lucide-react";

// ── 类型定义 ──────────────────────────────────────────────────

export interface FeatureDefinition {
  /** 唯一标识（匹配 activeView） */
  id: string;
  /** 侧边栏图标 */
  icon: LucideIcon;
  /** 悬浮提示标签 */
  label: string;
  /** 侧边栏面板组件 */
  panel: FC;
  /** 是否固定在最底部（如「设置」） */
  pinned?: boolean;
}

// ── 注册表 ─────────────────────────────────────────────────────

const _features = new Map<string, FeatureDefinition>();
const _pinned: FeatureDefinition[] = [];

/** 注册一个特性 */
export function registerFeature(feature: FeatureDefinition): void {
  _features.set(feature.id, feature);
  if (feature.pinned) {
    _pinned.push(feature);
  }
}

/** 获取所有非固定特性（顶部区域） */
export function getFeatures(): FeatureDefinition[] {
  return Array.from(_features.values()).filter((f) => !f.pinned);
}

/** 获取固定特性（底部区域） */
export function getPinnedFeatures(): FeatureDefinition[] {
  return _pinned;
}

/** 按 id 获取特性定义 */
export function getFeature(id: string): FeatureDefinition | undefined {
  return _features.get(id);
}

/** 检查 id 是否已注册 */
export function isValidFeatureId(id: string): boolean {
  return _features.has(id);
}

// ── 注册内建特性 ───────────────────────────────────────────────
// 从现有 components/ 位置导入，后续可逐步迁移到 features/ 下

import { SessionList } from "../components/sessions/SessionList";
import { FilesView } from "../components/files/FilesView";
import { TunnelsView } from "../components/tunnels/TunnelsView";
import { KeysView } from "../components/keys/KeysView";
import { SearchView } from "../components/search/SearchView";
import { BatchView } from "../components/batch/BatchView";
import { SshConfigView } from "../components/sshconfig/SshConfigView";
import { AiChat } from "../components/ai/AiChat";
import { SettingsView } from "../components/settings/SettingsView";

registerFeature({
  id: "sessions",
  icon: Server,
  label: "连接",
  panel: SessionList,
});

registerFeature({
  id: "files",
  icon: Folder,
  label: "文件",
  panel: FilesView,
});

registerFeature({
  id: "tunnels",
  icon: Network,
  label: "隧道",
  panel: TunnelsView,
});

registerFeature({
  id: "keys",
  icon: KeyRound,
  label: "密钥",
  panel: KeysView,
});

registerFeature({
  id: "search",
  icon: Search,
  label: "搜索",
  panel: SearchView,
});

registerFeature({
  id: "batch",
  icon: Terminal,
  label: "集群",
  panel: BatchView,
});

registerFeature({
  id: "ai",
  icon: Sparkles,
  label: "AI",
  panel: AiChat,
});

registerFeature({
  id: "sshconfig",
  icon: FileText,
  label: "SSH 配置",
  panel: SshConfigView,
});

registerFeature({
  id: "settings",
  icon: Settings,
  label: "设置",
  panel: SettingsView,
  pinned: true,
});
