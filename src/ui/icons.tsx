/**
 * The one icon set (Lucide outline icons), at one size and stroke width, so
 * every icon in the app looks the same. Import icons from here, not from
 * lucide-react directly.
 */
import {
  ArrowLeft, ArrowRight, BookOpen, Box, Brain, ChevronDown, CircleAlert, CircleCheck, ChevronRight, ChevronsLeft, ChevronsRight, CircleHelp, Clock, Code,
  Copy, Cpu, Database, FileText, FlaskConical, Folder, FolderOpen, GitBranch, Globe, HardDrive, House, Layers, LayoutGrid, Link, Lock, Mail, Mic, MicOff,
  Monitor, Package, Plus, Puzzle, Search, Settings, Shield, ShieldCheck, Sparkles, Terminal, Timer, Trash2, TriangleAlert, Undo2, Wrench, X, Zap, type LucideIcon, type LucideProps,
} from "lucide-react";

export const ICON = { size: 20, strokeWidth: 1.75 } as const;

export function I({ icon: Icon, size = ICON.size, ...rest }: { icon: LucideIcon } & LucideProps) {
  return <Icon size={size} strokeWidth={ICON.strokeWidth} aria-hidden="true" focusable="false" {...rest} />;
}

export {
  ArrowLeft, ArrowRight, BookOpen, Box, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, CircleHelp, Clock, Code, Copy, Database,
  FileText, FlaskConical, Folder, GitBranch, Globe, HardDrive, House, Layers, LayoutGrid, Link, Package, Plus, Search, Settings, Shield,
  Terminal, Timer, Wrench, Sparkles, ShieldCheck, TriangleAlert, CircleCheck, CircleAlert, FolderOpen, Puzzle, Mic, MicOff, Trash2, Undo2, X,
};

/** Categories have no icon field: the icon follows the name, with a plain folder when nothing fits. */
const BY_NAME: [RegExp, LucideIcon][] = [
  [/web|site|seo|crawl|scrap/i, Globe],
  [/\bai\b|model|llm|agent|prompt/i, Brain],
  [/data|database|storage|sql|import/i, Database],
  [/interface|\bui\b|front|design|display/i, Monitor],
  [/integrat|connect|api|webhook/i, Link],
  [/util|helper|tool/i, Settings],
  [/extract|parse|document|file|text|pdf/i, FileText],
  [/workflow|automat|pipeline|job|queue/i, Zap],
  [/auth|security|login|permission/i, Lock],
  [/email|mail|message|notif/i, Mail],
  [/test|quality|check/i, FlaskConical],
  [/network|http|fetch|request/i, Cpu],
  [/code|dev|build/i, Code],
  [/plugin|extension|module/i, Puzzle],
  [/template|starter|project/i, Folder],
];

export function categoryIcon(name: string): LucideIcon {
  return BY_NAME.find(([re]) => re.test(name))?.[1] ?? Folder;
}
