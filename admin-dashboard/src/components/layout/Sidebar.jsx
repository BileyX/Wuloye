import {
  Activity,
  BarChart3,
  Bell,
  Brain,
  CalendarDays,
  CalendarRange,
  Flame,
  FlaskConical,
  MapPin,
  MessageSquareText,
  Settings,
  Shield,
  Sparkles,
  Star,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/utils/cn";

const navGroups = [
  {
    label: "Overview",
    items: [
      { to: "/dashboard",  label: "System Health", icon: Activity },
      { to: "/analytics",  label: "Analytics",     icon: BarChart3 },
    ],
  },
  {
    label: "Users & Data",
    items: [
      { to: "/users",           label: "Users",           icon: Users },
      { to: "/interactions",    label: "Interactions",    icon: MessageSquareText },
      { to: "/recommendations", label: "Recommendations", icon: Sparkles },
    ],
  },
  {
    label: "AI & ML",
    items: [
      { to: "/ai-model",               label: "AI Monitor",       icon: Brain },
      { to: "/experiments",            label: "Experiments",      icon: FlaskConical },
      { to: "/recommendation-control", label: "AI Rec. Control",  icon: Star },
      { to: "/trending-management",    label: "Trending Control",  icon: Flame },
    ],
  },
  {
    label: "Content",
    items: [
      { to: "/places",     label: "Places",     icon: MapPin },
      { to: "/events",     label: "Events",     icon: CalendarRange },
      { to: "/routines",   label: "Routines",   icon: CalendarDays },
      { to: "/moderation", label: "Moderation", icon: Shield },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/notifications", label: "Notifications", icon: Bell },
      { to: "/system",        label: "System",        icon: Settings },
      { to: "/dev-tools",     label: "Dev Tools",     icon: Wrench },
    ],
  },
];

function NavItem({ item, onClick }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium",
          "transition-colors duration-100",
          isActive
            ? "bg-canvas-active text-white"
            : "text-canvas-text hover:bg-canvas-active/60 hover:text-canvas-textHover"
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r bg-white/60"
              aria-hidden="true"
            />
          )}
          <Icon
            className={cn(
              "h-[15px] w-[15px] shrink-0 transition-colors duration-100",
              isActive ? "text-white/90" : "text-canvas-text group-hover:text-canvas-textHover"
            )}
          />
          <span className="truncate leading-none">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Sidebar({ onNavigate, showClose = false }) {
  return (
    <aside
      className="flex h-full w-[232px] shrink-0 flex-col select-none"
      style={{ background: "var(--color-canvas)" }}
    >
      {/* Logo / header */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md text-white text-xs font-bold"
            style={{ background: "#292524", border: "1px solid rgba(255,255,255,0.12)" }}
          >
            W
          </div>
          <div>
            <p className="text-[13px] font-semibold text-white leading-none">Wuloye</p>
            <p className="text-[10px] text-canvas-text mt-0.5 leading-none">Admin Console</p>
          </div>
        </div>
        {showClose && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Close sidebar"
            className="flex h-6 w-6 items-center justify-center rounded text-canvas-text hover:text-white hover:bg-canvas-active transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="mx-4 mb-3 h-px" style={{ background: "var(--color-canvas-border)" }} />

      {/* Navigation */}
      <nav className="sidebar-scroll flex flex-1 flex-col overflow-y-auto px-2.5 pb-5">
        <div className="space-y-5">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-canvas-text/60 select-none">
                {group.label}
              </p>
              <div className="space-y-px">
                {group.items.map((item) => (
                  <NavItem key={item.to} item={item} onClick={onNavigate} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="shrink-0 px-4 py-3" style={{ borderTop: "1px solid var(--color-canvas-border)" }}>
        <div className="flex items-center gap-2">
          <span className="dot-live" />
          <span className="text-[11px] text-canvas-text/60">Live monitoring</span>
        </div>
      </div>
    </aside>
  );
}
